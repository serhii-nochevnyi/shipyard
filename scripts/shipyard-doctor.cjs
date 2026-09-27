#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { diagnostic, runBounded } = require(path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'command-runner.cjs'));
const { codexBlock } = require(path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'auto-route.cjs'));
const { readRecord, isDogfood } = require(path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'host-provenance.cjs'));
const sourcePlugin = path.join(ROOT, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json');
const sourceCapability = path.join(ROOT, 'capabilities', 'delivery-pipeline', 'capability.json');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const out = { json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--claude-home' || arg === '--codex-home' || arg === '--release-repo') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail(arg + ' needs a directory');
      out[arg.slice(2)] = path.resolve(value);
    } else if (arg === '--help') {
      console.log('usage: node scripts/shipyard-doctor.cjs [--json] [--strict] [--claude-home DIR] [--codex-home DIR] [--release-repo DIR]');
      process.exit(0);
    } else {
      fail('unknown option: ' + arg);
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function check(results, name, level, detail) {
  results.push({ name, level, detail });
}

function relativeDependencies(entry) {
  const resolvedEntry = fs.realpathSync(entry);
  const root = path.dirname(resolvedEntry);
  const seen = new Set();
  const files = [];
  const pattern = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

  function resolve(from, request) {
    const base = path.resolve(path.dirname(from), request);
    const relative = path.relative(root, base);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      fail(request + ' escapes ' + root);
    }
    const candidates = [
      base,
      base + '.cjs',
      base + '.js',
      path.join(base, 'index.cjs'),
      path.join(base, 'index.js'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) throw new Error(request + ' required by ' + from + ' is missing');
    return fs.realpathSync(found);
  }

  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) visit(resolve(file, match[1]));
  }

  visit(resolvedEntry);
  return files;
}

function validateHookBundle(entry) {
  const files = relativeDependencies(entry);
  for (const file of files) {
    const result = runBounded(process.execPath, ['--check', file], { timeoutMs: 5000 });
    if (result.status !== 0) throw new Error(path.basename(file) + ' is not valid JavaScript: ' + diagnostic(result));
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-doctor-'));
  try {
    const result = runBounded(process.execPath, [entry], {
      cwd,
      input: '{}\n',
      timeoutMs: 5000,
    });
    if (result.error) throw new Error('stop-gate self-check failed: ' + diagnostic(result));
    if (result.status !== 0) throw new Error('stop-gate self-check failed: ' + diagnostic(result));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return files.length;
}

function git(repo, args) {
  const result = runBounded('git', ['-C', repo, ...args], { timeoutMs: 30000 });
  return result.status === 0 ? result.stdout : null;
}

function releaseTag(repo, version) {
  return git(repo, ['rev-parse', '-q', '--verify', 'refs/tags/v' + version + '^{commit}']) ? 'v' + version : null;
}

function cacheDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function provenanceCheck(results, name, dir) {
  const record = readRecord(dir);
  if (!record) return null;
  const detail = record.install_kind + ' ' + (record.version || '?') + ' (' + dir + ')';
  if (isDogfood(record)) {
    check(results, name, 'warn', 'dogfood ' + (record.version || '?') + ' sha ' + (record.source_sha || 'unknown') +
      (record.dirty ? ' dirty' : ' clean') + ' (' + dir + ')');
  } else check(results, name, 'ok', detail);
  return record;
}

function claudeCacheChecks(results, claudeHome, repo) {
  const cache = path.join(claudeHome, 'plugins', 'cache', 'shipyard', 'shipyard');
  for (const version of cacheDirs(cache)) {
    const dir = path.join(cache, version);
    const name = 'claude-cache ' + version;
    const record = provenanceCheck(results, 'claude-cache-provenance ' + version, dir);
    const tag = repo && releaseTag(repo, version);
    if (!tag) {
      check(results, name, 'skip', 'no v' + version + ' tag to compare ' + dir);
      continue;
    }
    const listing = git(repo, ['ls-tree', '-r', tag, '--', 'plugins/delivery-pipeline/']) || '';
    const prefix = 'plugins/delivery-pipeline/';
    const differ = [];
    for (const line of listing.split('\n').filter(Boolean)) {
      const [meta, file] = line.split('\t');
      const blob = meta.split(' ')[2];
      const rel = file.slice(prefix.length);
      const local = path.join(dir, rel);
      const hashed = fs.existsSync(local) ? git(repo, ['hash-object', '--no-filters', '--', local]) : null;
      if (!hashed || hashed.trim() !== blob) differ.push(rel);
    }
    if (differ.length) {
      check(results, name, 'error', 'cache matches no release (' + differ.length + ' files differ: ' + differ.join(', ') + ')');
    } else check(results, name, 'ok', 'cache matches ' + tag + (isDogfood(record) ? ' (recorded as dogfood)' : ''));
  }
}

function codexCacheChecks(results, codexHome, repo) {
  const cache = path.join(codexHome, 'plugins', 'cache', 'shipyard', 'shipyard');
  const agentsRecord = readRecord(path.join(codexHome, 'agents'));
  for (const entry of cacheDirs(cache)) {
    const match = entry.match(/^(.+)\+codex\.[0-9a-f]{16}$/);
    if (!match) continue;
    const dir = path.join(cache, entry);
    const name = 'codex-cache ' + entry;
    const record = readRecord(dir) || (agentsRecord && agentsRecord.version === entry ? agentsRecord : null);
    if (isDogfood(record)) {
      check(results, name + ' provenance', 'warn', 'dogfood sha ' + (record.source_sha || 'unknown') +
        (record.dirty ? ' dirty' : ' clean') + ' (' + dir + ')');
    }
    const tag = repo && releaseTag(repo, match[1]);
    if (!tag) {
      check(results, name, 'skip', 'no v' + match[1] + ' tag to compare ' + dir);
      continue;
    }
    const installed = readJson(path.join(dir, 'package-build.json'));
    let released = null;
    try {
      released = JSON.parse(git(repo, ['show', tag + ':plugins/shipyard/package-build.json']) || 'null');
    } catch {
      released = null;
    }
    if (!installed || !released || installed.digest !== released.digest) {
      check(results, name, 'error', 'codex cache matches no release (digest ' + (installed && installed.digest) +
        ', ' + tag + ' ' + (released && released.digest) + ')');
    } else check(results, name, 'ok', 'codex cache matches ' + tag);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const claudeHome = args['claude-home'] || path.join(os.homedir(), '.claude');
  const codexHome = args['codex-home'] || path.join(os.homedir(), '.codex');
  const results = [];
  const plugin = readJson(sourcePlugin);
  const capability = readJson(sourceCapability);
  const sourceVersion = plugin && plugin.version;
  const capabilityVersion = capability && capability.version;

  if (!sourceVersion) check(results, 'source-version', 'error', 'cannot read ' + sourcePlugin);
  else if (sourceVersion !== capabilityVersion) {
    check(results, 'source-version', 'error', 'plugin ' + sourceVersion + ' differs from capability ' + capabilityVersion);
  } else {
    check(results, 'source-version', 'ok', 'Shipyard ' + sourceVersion);
  }

  const settingsFile = path.join(claudeHome, 'settings.json');
  const bundle = path.join(claudeHome, 'hooks', 'shipyard-stop-gate');
  const stopHook = path.join(bundle, 'stop-gate.cjs');
  const publishHook = path.join(bundle, 'publish-gate.cjs');
  const sessionHook = path.join(bundle, 'session-observer.cjs');
  const prePushHook = path.join(claudeHome, 'hooks', 'shipyard-pre-push-gate.sh');
  const oldHook = path.join(claudeHome, 'hooks', 'shipyard-stop-gate.cjs');
  const routeHook = path.join(claudeHome, 'hooks', 'shipyard-auto-route.sh');
  const routeModule = path.join(claudeHome, 'hooks', 'shipyard-auto-route.cjs');
  const routeSource = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'auto-route.cjs');
  if (!fs.existsSync(settingsFile) && !fs.existsSync(bundle)) {
    check(results, 'claude', 'skip', claudeHome + ' has no Shipyard hook installation');
  } else {
    const settings = readJson(settingsFile);
    const commands = settings && settings.hooks && Array.isArray(settings.hooks.Stop)
      ? settings.hooks.Stop.flatMap((group) => (group.hooks || []).map((hook) => hook.command))
      : [];
    const prePushCommands = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse)
      ? settings.hooks.PreToolUse.flatMap((group) => (group.hooks || []).map((hook) => hook.command))
      : [];
    const expected = 'node "' + stopHook + '"';
    if (!commands.includes(expected)) check(results, 'claude-settings', 'error', 'Stop does not point to ' + stopHook);
    else if (commands.includes('node "' + oldHook + '"')) check(results, 'claude-settings', 'error', 'legacy single-file stop hook is still registered');
    else check(results, 'claude-settings', 'ok', 'Stop points to the stable Shipyard bundle');
    const expectedObserver = 'node "' + sessionHook + '" hook';
    if (!commands.includes(expectedObserver)) check(results, 'claude-session-observer', 'error', 'Stop does not record transcript usage');
    else check(results, 'claude-session-observer', 'ok', 'Stop records transcript usage');
    const expectedPrePush = 'bash "' + prePushHook + '"';
    if (!prePushCommands.includes(expectedPrePush)) {
      check(results, 'claude-publish-hook', 'error', 'PreToolUse does not point to ' + prePushHook);
    } else check(results, 'claude-publish-hook', 'ok', 'PreToolUse guards git push');

    const routeCommands = settings && settings.hooks && Array.isArray(settings.hooks.UserPromptSubmit)
      ? settings.hooks.UserPromptSubmit.flatMap((group) => (group.hooks || []).map((hook) => hook.command))
      : [];
    const expectedRoute = 'bash "' + routeHook + '"';
    let routeInstalledMatches = false;
    try {
      routeInstalledMatches = fs.readFileSync(routeModule).equals(fs.readFileSync(routeSource));
    } catch {
      routeInstalledMatches = false;
    }
    if (!routeCommands.includes(expectedRoute) || !routeInstalledMatches) {
      check(results, 'claude-route-hook', 'warn', 'route hook is stale or missing; run make install-shipyard-claude-hook');
    } else check(results, 'claude-route-hook', 'ok', 'route hook matches the source and is registered');

    if (!fs.existsSync(stopHook)) {
      check(results, 'claude-bundle', 'error', 'missing ' + stopHook);
    } else {
      try {
        const count = validateHookBundle(stopHook);
        const versionFile = path.join(bundle, 'version.json');
        const installedVersion = readJson(versionFile) && readJson(versionFile).shipyard_version;
        if (sourceVersion && installedVersion && installedVersion !== sourceVersion) {
          check(results, 'claude-version', 'warn', 'bundle ' + installedVersion + ', source ' + sourceVersion);
        } else if (!installedVersion) {
          check(results, 'claude-version', 'warn', 'bundle has no version marker; reinstall to enable version checks');
        } else {
          check(results, 'claude-version', 'ok', 'bundle ' + installedVersion);
        }
        check(results, 'claude-bundle', 'ok', count + ' module(s) resolve and pass the self-check');
      } catch (error) {
        check(results, 'claude-bundle', 'error', error.message);
      }
    }
    if (!fs.existsSync(prePushHook)) {
      check(results, 'claude-publish-hook', 'error', 'missing ' + prePushHook);
    }
    if (!fs.existsSync(publishHook)) {
      check(results, 'claude-publish-bundle', 'error', 'missing ' + publishHook);
    } else {
      try {
        const count = relativeDependencies(publishHook);
        for (const file of count) {
          const result = runBounded(process.execPath, ['--check', file], { timeoutMs: 5000 });
          if (result.status !== 0) throw new Error(path.basename(file) + ' is not valid JavaScript: ' + diagnostic(result));
        }
        check(results, 'claude-publish-bundle', 'ok', count.length + ' module(s) resolve and pass syntax checks');
      } catch (error) {
        check(results, 'claude-publish-bundle', 'error', error.message);
      }
    }
    if (!fs.existsSync(sessionHook)) check(results, 'claude-session-observer', 'error', 'missing ' + sessionHook);
  }

  const codexBundle = path.join(codexHome, 'shipyard');
  const manifestFile = path.join(codexBundle, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    check(results, 'codex', 'skip', codexHome + ' has no Shipyard bundle manifest');
  } else {
    const manifest = readJson(manifestFile);
    const installedVersion = manifest && manifest.shipyard_version;
    if (!manifest || !fs.existsSync(path.join(codexBundle, 'scripts'))) {
      check(results, 'codex-bundle', 'error', 'manifest or scripts directory is invalid');
    } else if (!installedVersion) {
      check(results, 'codex-version', 'warn', 'bundle has no version marker; reinstall to enable version checks');
      check(results, 'codex-bundle', 'ok', 'bundle manifest and scripts directory are present');
    } else if (sourceVersion && installedVersion !== sourceVersion) {
      check(results, 'codex-version', 'warn', 'bundle ' + installedVersion + ', source ' + sourceVersion);
      check(results, 'codex-bundle', 'ok', 'bundle manifest and scripts directory are present');
    } else {
      check(results, 'codex-version', 'ok', 'bundle ' + installedVersion);
      check(results, 'codex-bundle', 'ok', 'bundle manifest and scripts directory are present');
    }
    const agentsMdPath = path.join(codexHome, 'AGENTS.md');
    let agentsMdText = '';
    try {
      agentsMdText = fs.readFileSync(agentsMdPath, 'utf8');
    } catch {
      agentsMdText = '';
    }
    if ([1, 2].some(phase => [false, true].some(marketplace =>
      agentsMdText.includes(codexBlock(phase, marketplace))))) {
      check(results, 'codex-route-block', 'ok', 'AGENTS.md route block matches the source');
    } else {
      check(results, 'codex-route-block', 'warn', 'AGENTS.md route block is stale or missing; run make install-shipyard-codex');
    }
    const codexNotify = path.join(codexBundle, 'scripts', 'codex-notify.cjs');
    const notifyDelegate = path.join(codexHome, 'shipyard-notify-delegate.json');
    const codexConfig = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(codexNotify)) {
      check(results, 'codex-session-observer', 'error', 'missing ' + codexNotify);
    } else {
      try {
        const files = relativeDependencies(codexNotify);
        for (const file of files) {
          const result = runBounded(process.execPath, ['--check', file], { timeoutMs: 5000 });
          if (result.status !== 0) throw new Error(path.basename(file) + ' is not valid JavaScript: ' + diagnostic(result));
        }
        check(results, 'codex-session-observer', 'ok', files.length + ' module(s) resolve and pass syntax checks');
      } catch (error) {
        check(results, 'codex-session-observer', 'error', error.message);
      }
    }
    if (!fs.existsSync(notifyDelegate)) {
      check(results, 'codex-notify-delegate', 'error', 'missing ' + notifyDelegate);
    } else if (!fs.existsSync(codexConfig) || !fs.readFileSync(codexConfig, 'utf8').includes(codexNotify)) {
      check(results, 'codex-notify-delegate', 'error', 'config.toml notify does not point to ' + codexNotify);
    } else {
      check(results, 'codex-notify-delegate', 'ok', 'turn-ended notify records Codex model and effort facts');
    }
  }

  const agentsDir = path.join(codexHome, 'agents');
  const agentManifestFile = path.join(agentsDir, '.shipyard-manifest.json');
  if (!fs.existsSync(agentManifestFile)) {
    check(results, 'codex-agents', 'skip', codexHome + ' has no agents manifest');
  } else {
    const agentManifest = readJson(agentManifestFile);
    if (!agentManifest || !Array.isArray(agentManifest.agent_files)) {
      check(results, 'codex-agents', 'error', agentManifestFile + ' is corrupt or missing agent_files');
    } else {
      const missing = agentManifest.agent_files.filter(
        (name) => typeof name !== 'string' || !fs.existsSync(path.join(agentsDir, name)));
      if (missing.length) {
        check(results, 'codex-agents', 'error', 'manifest names missing agent file(s): ' + missing.join(', '));
      } else {
        check(results, 'codex-agents', 'ok', agentManifest.agent_files.length + ' agent(s) registered');
      }
    }
  }

  const releaseRepo = args['release-repo'] || ROOT;
  provenanceCheck(results, 'claude-provenance', bundle);
  provenanceCheck(results, 'codex-provenance', agentsDir);
  claudeCacheChecks(results, claudeHome, releaseRepo);
  codexCacheChecks(results, codexHome, releaseRepo);

  const errors = results.filter((result) => result.level === 'error');
  const warnings = results.filter((result) => result.level === 'warn');
  const report = {
    source_version: sourceVersion || null,
    claude_home: claudeHome,
    codex_home: codexHome,
    status: errors.length ? 'error' : warnings.length ? 'attention' : 'ok',
    checks: results,
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Shipyard doctor — ' + report.status);
    for (const result of results) console.log('[' + result.level + '] ' + result.name + ': ' + result.detail);
  }
  if (errors.length || (args.strict && warnings.length)) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error('shipyard-doctor: ' + error.message);
  process.exitCode = 2;
}
