#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
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
    else if (arg === '--claude-home' || arg === '--codex-home') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail(arg + ' needs a directory');
      out[arg.slice(2)] = path.resolve(value);
    } else if (arg === '--help') {
      console.log('usage: node scripts/shipyard-doctor.cjs [--json] [--strict] [--claude-home DIR] [--codex-home DIR]');
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
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(path.basename(file) + ' is not valid JavaScript: ' + String(result.stderr || '').trim());
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-doctor-'));
  try {
    const result = spawnSync(process.execPath, [entry], {
      cwd,
      input: '{}\n',
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.error) throw new Error('stop-gate self-check failed: ' + result.error.message);
    if (result.status !== 0) throw new Error('stop-gate self-check failed: ' + String(result.stderr || '').trim());
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return files.length;
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
  const oldHook = path.join(claudeHome, 'hooks', 'shipyard-stop-gate.cjs');
  if (!fs.existsSync(settingsFile) && !fs.existsSync(bundle)) {
    check(results, 'claude', 'skip', claudeHome + ' has no Shipyard hook installation');
  } else {
    const settings = readJson(settingsFile);
    const commands = settings && settings.hooks && Array.isArray(settings.hooks.Stop)
      ? settings.hooks.Stop.flatMap((group) => (group.hooks || []).map((hook) => hook.command))
      : [];
    const expected = 'node "' + stopHook + '"';
    if (!commands.includes(expected)) check(results, 'claude-settings', 'error', 'Stop does not point to ' + stopHook);
    else if (commands.includes('node "' + oldHook + '"')) check(results, 'claude-settings', 'error', 'legacy single-file stop hook is still registered');
    else check(results, 'claude-settings', 'ok', 'Stop points to the stable Shipyard bundle');

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
  }

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
