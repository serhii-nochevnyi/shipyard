'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const { resolveHostEnvironment } = require('../../plugins/delivery-pipeline/scripts/runtime-context.cjs');
const { codexCapabilities } = require('../smoke/installed-launch/lib.cjs');

const roots = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-launch-layouts-')));
  roots.push(root);
  return root;
};

function layoutAt(home, overrides = {}) {
  const bundle = path.join(home, 'shipyard');
  const scripts = path.join(bundle, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  const evidence = Buffer.from(overrides.evidence || JSON.stringify(codexCapabilities()));
  fs.writeFileSync(path.join(bundle, 'codex-capabilities.json'), evidence);
  const manifestFile = path.join(home, 'agents', '.shipyard-manifest.json');
  if (overrides.manifest !== null) {
    fs.writeFileSync(manifestFile, JSON.stringify({
      phase: 2, codexHome: home, scriptsRoot: bundle,
      capabilities_file: 'codex-capabilities.json', capabilities_digest: digest(evidence), ...overrides.manifest,
    }));
  }
  return { home, bundle, scripts, manifestFile, evidenceFile: path.join(bundle, 'codex-capabilities.json') };
}

const resolve = (scripts, env = {}) => resolveHostEnvironment({ scriptDir: scripts, runtime: 'codex', env });

after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe('the resolver on every installed layout, with no variable set', () => {
  const layouts = {
    'global home': (root) => path.join(root, '.codex'),
    'custom home': (root) => path.join(root, 'custom', 'codex-elsewhere'),
    'dogfood-style home under a state directory': (root) => path.join(root, 'state', 'shipyard-dogfood', 'codex-home'),
  };
  for (const [name, homeFor] of Object.entries(layouts)) {
    it(`resolves its own home and capability evidence for a ${name}`, () => {
      const layout = layoutAt(homeFor(scratch()));
      const resolved = resolve(layout.scripts, {});
      assert.equal(resolved.mode, 'installed');
      assert.equal(resolved.home, layout.home);
      assert.equal(resolved.bundleRoot, layout.bundle);
      assert.equal(resolved.manifestFile, layout.manifestFile);
      assert.equal(resolved.capabilitiesFile, layout.evidenceFile);
      assert.deepEqual(resolved.capabilities, codexCapabilities());
    });
  }

  it('accepts a home reached through a symlink that points at the bundle home', () => {
    const root = scratch();
    const layout = layoutAt(path.join(root, 'real-home'));
    const link = path.join(root, 'linked-home');
    fs.symlinkSync(layout.home, link);
    const viaLink = resolve(path.join(link, 'shipyard', 'scripts'), {});
    assert.equal(viaLink.mode, 'installed');
    assert.equal(fs.realpathSync(viaLink.home), layout.home);
    assert.equal(resolve(layout.scripts, { CODEX_HOME: link }).mode, 'installed');
  });
});

describe('the resolver refuses a broken layout by named code', () => {
  const refuses = (scripts, code, needle, env = {}) => assert.throws(() => resolve(scripts, env), (error) => {
    assert.equal(error.code, code);
    assert.ok(error.message.includes(needle), error.message);
    return true;
  });

  it('refuses a missing manifest', () => {
    const layout = layoutAt(path.join(scratch(), 'home'), { manifest: null });
    refuses(layout.scripts, 'BUNDLE_MANIFEST_INVALID', layout.manifestFile);
  });

  it('refuses a manifest naming a foreign scriptsRoot or codexHome', () => {
    for (const field of ['scriptsRoot', 'codexHome']) {
      const layout = layoutAt(path.join(scratch(), 'home'), { manifest: { [field]: '/nonexistent/elsewhere' } });
      refuses(layout.scripts, 'BUNDLE_MANIFEST_INVALID', field);
    }
  });

  it('refuses a digest mismatch naming both digests', () => {
    const layout = layoutAt(path.join(scratch(), 'home'));
    const original = fs.readFileSync(layout.evidenceFile);
    fs.writeFileSync(layout.evidenceFile, Buffer.concat([original, Buffer.from('\n')]));
    refuses(layout.scripts, 'CAPABILITY_EVIDENCE_STALE', digest(original));
  });

  it('refuses digest-valid evidence that fails the capability grid', () => {
    const layout = layoutAt(path.join(scratch(), 'home'),
      { evidence: JSON.stringify({ supportedModels: [], supportedEfforts: [] }) });
    refuses(layout.scripts, 'CAPABILITY_EVIDENCE_STALE', 'ADR-014 grid');
  });

  it('refuses a disagreeing CODEX_HOME naming both homes', () => {
    const root = scratch();
    const layout = layoutAt(path.join(root, 'home'));
    const other = path.join(root, 'other-home');
    fs.mkdirSync(other);
    refuses(layout.scripts, 'ENV_CONFLICT', other, { CODEX_HOME: other });
    refuses(layout.scripts, 'ENV_CONFLICT', layout.home, { CODEX_HOME: other });
  });
});
