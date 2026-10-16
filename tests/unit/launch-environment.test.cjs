'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const { resolveHostEnvironment, launchEnvironment, resolveCodexHome, resolveClaudeHome, RESOLVER_CODES } = require('../../plugins/delivery-pipeline/scripts/runtime-context.cjs');
const { classifyLaunch, codexCapabilities } = require('../smoke/installed-launch/lib.cjs');

const roots = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function installedLayout(overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-launch-environment-')));
  roots.push(root);
  const home = path.join(root, 'codex-home');
  const bundle = path.join(home, 'shipyard');
  const scripts = path.join(bundle, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'));
  const evidence = Buffer.from(overrides.evidence || JSON.stringify(codexCapabilities()));
  fs.writeFileSync(path.join(bundle, 'codex-capabilities.json'), evidence);
  const manifest = {
    phase: 2, codexHome: home, scriptsRoot: bundle,
    capabilities_file: 'codex-capabilities.json', capabilities_digest: digest(evidence), ...overrides.manifest,
  };
  const manifestFile = path.join(home, 'agents', '.shipyard-manifest.json');
  if (overrides.manifest !== null) fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { root, home, bundle, scripts, manifestFile, evidenceFile: path.join(bundle, 'codex-capabilities.json') };
}

const resolve = (layout, env = {}, runtime = 'codex') => resolveHostEnvironment({ scriptDir: layout.scripts, runtime, env });

after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe('resolveHostEnvironment on an installed Codex layout', () => {
  it('resolves the home, manifest and evidence from the bundle alone', () => {
    const layout = installedLayout();
    const resolved = resolve(layout, {});
    assert.equal(resolved.mode, 'installed');
    assert.equal(resolved.runtime, 'codex');
    assert.equal(resolved.home, layout.home);
    assert.equal(resolved.bundleRoot, layout.bundle);
    assert.equal(resolved.agentsDir, path.join(layout.home, 'agents'));
    assert.equal(resolved.manifestFile, layout.manifestFile);
    assert.equal(resolved.capabilitiesFile, layout.evidenceFile);
    assert.deepEqual(resolved.capabilities, codexCapabilities());
  });

  it('accepts an exported CODEX_HOME that names the same directory, even through an alias', () => {
    const layout = installedLayout();
    const alias = path.join(layout.root, 'alias');
    fs.symlinkSync(layout.home, alias);
    assert.equal(resolve(layout, { CODEX_HOME: layout.home }).mode, 'installed');
    assert.equal(resolve(layout, { CODEX_HOME: alias }).home, layout.home);
    assert.equal(resolve(layout, { CODEX_HOME: '' }).mode, 'installed');
  });

  it('refuses a disagreeing CODEX_HOME as ENV_CONFLICT naming both values', () => {
    const layout = installedLayout();
    const other = path.join(layout.root, 'other-home');
    fs.mkdirSync(other);
    for (const exported of [other, path.join(layout.root, 'does-not-exist')]) {
      assert.throws(() => resolve(layout, { CODEX_HOME: exported }), (error) => {
        assert.equal(error.code, 'ENV_CONFLICT');
        assert.ok(error.message.includes(exported) && error.message.includes(layout.home), error.message);
        return true;
      });
    }
  });

  it('refuses a missing or foreign installer manifest as BUNDLE_MANIFEST_INVALID', () => {
    const missing = installedLayout({ manifest: null });
    assert.throws(() => resolve(missing), (error) => {
      assert.equal(error.code, 'BUNDLE_MANIFEST_INVALID');
      assert.ok(error.message.includes(missing.manifestFile), error.message);
      return true;
    });
    for (const field of ['scriptsRoot', 'codexHome']) {
      const foreign = installedLayout({ manifest: { [field]: '/nonexistent/elsewhere' } });
      assert.throws(() => resolve(foreign), (error) => {
        assert.equal(error.code, 'BUNDLE_MANIFEST_INVALID');
        assert.ok(error.message.includes(field), error.message);
        return true;
      });
    }
    const renamed = installedLayout({ manifest: { capabilities_file: 'other.json' } });
    assert.throws(() => resolve(renamed), (error) => error.code === 'BUNDLE_MANIFEST_INVALID');
  });

  it('refuses evidence whose digest differs from the manifest, even when it is still grid-valid', () => {
    const layout = installedLayout();
    const original = fs.readFileSync(layout.evidenceFile);
    fs.writeFileSync(layout.evidenceFile, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => resolve(layout), (error) => {
      assert.equal(error.code, 'CAPABILITY_EVIDENCE_STALE');
      assert.ok(error.message.includes(digest(original)) && error.message.includes(digest(fs.readFileSync(layout.evidenceFile))), error.message);
      return true;
    });
  });

  it('refuses evidence that matches its digest but fails the ADR-014 grid', () => {
    const layout = installedLayout({ evidence: JSON.stringify({ supportedModels: [], supportedEfforts: [] }) });
    assert.throws(() => resolve(layout), (error) => {
      assert.equal(error.code, 'CAPABILITY_EVIDENCE_STALE');
      assert.ok(/ADR-014 grid/.test(error.message), error.message);
      return true;
    });
    const unreadable = installedLayout({ evidence: '{' });
    assert.throws(() => resolve(unreadable), (error) => error.code === 'CAPABILITY_EVIDENCE_STALE');
  });
});

describe('resolveHostEnvironment outside an installed Codex layout', () => {
  it('returns source mode for a checkout without bundle evidence and ignores the environment', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-launch-source-')));
    roots.push(root);
    const scripts = path.join(root, 'plugin/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    const resolved = resolveHostEnvironment({ scriptDir: scripts, runtime: 'codex', env: { CODEX_HOME: '/elsewhere' } });
    assert.deepEqual({ ...resolved }, { mode: 'source', runtime: 'codex' });
  });

  it('returns source mode for another runtime or a missing script directory', () => {
    const layout = installedLayout();
    assert.equal(resolve(layout, {}, 'claude').mode, 'claude');
    assert.equal(resolveHostEnvironment({ runtime: 'codex', env: {} }).mode, 'source');
  });
});

describe('launchEnvironment', () => {
  it('hands the validated home to the child without mutating its input', () => {
    const layout = installedLayout();
    const base = { PATH: '/bin', HOME: '/home/fixture', CODEX_HOME: '/stale' };
    const env = launchEnvironment(resolve(layout, {}), base);
    assert.deepEqual(env, {
      PATH: '/bin', HOME: '/home/fixture', CODEX_HOME: layout.home,
      SHIPYARD_CODEX_CAPABILITIES_FILE: layout.evidenceFile, SHIPYARD_RUNTIME: 'codex',
    });
    assert.equal(base.CODEX_HOME, '/stale');
    assert.deepEqual(launchEnvironment({ mode: 'source' }, { PATH: '/bin' }), { PATH: '/bin' });
  });
});

describe('explicit home and capability file against an installed bundle', () => {
  const conflict = (fn, ...needles) => assert.throws(fn, (error) => {
    assert.equal(error.code, 'ENV_CONFLICT');
    for (const needle of needles) assert.ok(error.message.includes(needle), error.message);
    return true;
  });

  it('accepts flags and env that agree, through a symlink or identical bytes elsewhere', () => {
    const layout = installedLayout();
    const alias = path.join(layout.root, 'alias');
    fs.symlinkSync(layout.home, alias);
    const copy = path.join(layout.root, 'copy.json');
    fs.copyFileSync(layout.evidenceFile, copy);
    const flags = { codexHome: alias, capabilitiesFile: copy };
    const env = { CODEX_HOME: layout.home, SHIPYARD_CODEX_CAPABILITIES_FILE: layout.evidenceFile };
    const resolved = resolveHostEnvironment({ scriptDir: layout.scripts, runtime: 'codex', env, flags });
    assert.equal(resolved.home, layout.home);
    assert.equal(resolveHostEnvironment({ scriptDir: layout.scripts, runtime: 'codex', env: { SHIPYARD_CODEX_CAPABILITIES_FILE: copy } }).mode, 'installed');
  });

  it('refuses a disagreeing home flag, capability file and a flag that disagrees with env', () => {
    const layout = installedLayout();
    const other = path.join(layout.root, 'other-home');
    fs.mkdirSync(other);
    const foreign = path.join(layout.root, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify(codexCapabilities()) + '\n');
    const run = (env, flags) => () => resolveHostEnvironment({ scriptDir: layout.scripts, runtime: 'codex', env, flags });
    conflict(run({}, { codexHome: other }), other, layout.home);
    conflict(run({ SHIPYARD_CODEX_CAPABILITIES_FILE: foreign }, {}), foreign, layout.evidenceFile);
    conflict(run({}, { capabilitiesFile: foreign }), foreign, layout.evidenceFile);
    conflict(run({ CODEX_HOME: layout.home }, { codexHome: other }), other, layout.home);
  });

  it('exposes the codes the module can throw', () => {
    for (const code of ['ENV_CONFLICT', 'BUNDLE_MANIFEST_INVALID', 'CAPABILITY_EVIDENCE_STALE']) assert.ok(RESOLVER_CODES.includes(code), code);
    assert.ok(Object.isFrozen(RESOLVER_CODES));
  });
});

describe('home accessors and the Claude branch', () => {
  it('answers the Codex home from the bundle, an explicit value, or ~/.codex in a source checkout', () => {
    const layout = installedLayout();
    assert.equal(resolveCodexHome({ scriptDir: layout.scripts, env: {} }), layout.home);
    const source = path.join(layout.root, 'plugin/scripts');
    fs.mkdirSync(source, { recursive: true });
    assert.equal(resolveCodexHome({ scriptDir: source, env: { CODEX_HOME: '/explicit' } }), '/explicit');
    assert.equal(resolveCodexHome({ scriptDir: source, env: { CODEX_HOME: '/env' }, flags: { codexHome: '/flag' } }), '/flag');
    assert.equal(resolveCodexHome({ scriptDir: source, env: { HOME: '/home/u' } }), path.join('/home/u', '.codex'));
  });

  it('answers the Claude home from CLAUDE_CONFIG_DIR or HOME', () => {
    assert.equal(resolveClaudeHome({ env: { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' } }), '/cfg');
    assert.equal(resolveClaudeHome({ env: { HOME: '/h' } }), path.join('/h', '.claude'));
  });

  it('does not refuse a Claude run on conflicting Codex variables and carries no Codex keys', () => {
    const layout = installedLayout();
    const resolved = resolveHostEnvironment({
      scriptDir: layout.scripts, runtime: 'claude',
      env: { CODEX_HOME: '/conflict', SHIPYARD_CODEX_CAPABILITIES_FILE: '/conflict.json', HOME: '/h' },
    });
    assert.equal(resolved.runtime, 'claude');
    assert.equal(resolved.claudeHome, path.join('/h', '.claude'));
    assert.deepEqual(launchEnvironment(resolved, { PATH: '/bin' }), { PATH: '/bin', SHIPYARD_RUNTIME: 'claude' });
  });

  it('leaves every other variable untouched in the child environment', () => {
    const layout = installedLayout();
    const base = { SHIPYARD_GRAPH_DIR: '/g', SHIPYARD_CODEX_AGENT_DIR: '/a', SHIPYARD_CODEX_LOG_DB: '/l', GSD_X: '1', ZED: 'z' };
    const env = launchEnvironment(resolve(layout, {}), base);
    for (const key of Object.keys(base)) assert.equal(env[key], base[key]);
  });
});

describe('classifyLaunch', () => {
  const line = { argv: ['exec'], codexHome: '/home' };
  const evidenceMissing = 'codex-delivery-host: no records\nhint[RUNTIME_EVIDENCE_MISSING]: x';

  it('classifies an admitted launch as reached, whether it exits 0 or ends in missing native evidence', () => {
    const clean = classifyLaunch({ status: 0, signal: null, stderr: '' }, [line]);
    assert.deepEqual([clean.kind, clean.execs, clean.status, clean.labels, clean.terminal],
      ['reached', 1, 0, [], 'exit-0']);
    const missing = classifyLaunch({ status: 1, signal: null, stderr: evidenceMissing }, [line]);
    assert.equal(missing.kind, 'reached');
    assert.equal(missing.terminal, 'runtime-evidence');
    assert.deepEqual(missing.labels, ['RUNTIME_EVIDENCE_MISSING']);
    const both = classifyLaunch({ status: 1, stderr: 'hint[RUNTIME_EVIDENCE_MISSING] hint[RUNTIME_EVIDENCE_INVALID] hint[RUNTIME_EVIDENCE_INVALID]' }, [line]);
    assert.equal(both.kind, 'reached');
    assert.deepEqual(both.labels, ['RUNTIME_EVIDENCE_MISSING', 'RUNTIME_EVIDENCE_INVALID']);
  });

  it('classifies a named refusal with no native call as refused', () => {
    for (const label of ['BUSY', 'CAPABILITY_EVIDENCE_STALE', 'ENV_CONFLICT']) {
      const outcome = classifyLaunch({ status: 1, signal: null, stderr: `hint[${label}]: x` }, []);
      assert.equal(outcome.kind, 'refused', label);
      assert.deepEqual(outcome.labels, [label]);
      assert.equal(outcome.execs, 0);
    }
    assert.equal(classifyLaunch({ status: 2, stderr: 'hint[BUSY]' }, undefined).kind, 'refused');
  });

  it('maps the archive authority wording to ARCHIVE_AUTHORITY_INVALID', () => {
    for (const stderr of ['archive authority key is malformed', 'archive authority changed while reading']) {
      const outcome = classifyLaunch({ status: 1, stderr }, []);
      assert.equal(outcome.kind, 'refused', stderr);
      assert.deepEqual(outcome.labels, ['ARCHIVE_AUTHORITY_INVALID']);
    }
    const once = classifyLaunch({ status: 1, stderr: 'hint[ARCHIVE_AUTHORITY_INVALID] key is malformed' }, []);
    assert.deepEqual(once.labels, ['ARCHIVE_AUTHORITY_INVALID']);
  });

  it('leaves every other outcome unclassified with a reason', () => {
    const cases = [
      [{ status: 1, stderr: evidenceMissing }, [line, line]],
      [{ status: 1, stderr: 'hint[RUNTIME_UNAVAILABLE]' }, [line]],
      [{ status: 1, stderr: 'hint[RUNTIME_EVIDENCE_MISSING] hint[RUNTIME_UNAVAILABLE]' }, [line]],
      [{ status: 1, stderr: 'no label at all' }, [line]],
      [{ status: 0, stderr: 'hint[RUNTIME_EVIDENCE_MISSING]' }, [line]],
      [{ status: 0, stderr: '' }, []],
      [{ status: 1, stderr: 'no label at all' }, []],
      [{ status: null, signal: 'SIGTERM', stderr: 'hint[ENV_CONFLICT]' }, []],
      [{ signal: null, stderr: 'hint[ENV_CONFLICT]' }, []],
      [undefined, []],
    ];
    for (const [run, lines] of cases) {
      const outcome = classifyLaunch(run, lines);
      assert.equal(outcome.kind, 'unclassified', JSON.stringify([run, lines]));
      assert.ok(outcome.reason && outcome.terminal === null);
    }
  });
});
