'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const MEMBER = 'scripts/ticket-worktree.sh';
const PLUGIN = path.join(ROOT, 'plugins/delivery-pipeline');
const ORIGINAL_DIGEST = 'b64296a5d0189db6f9f1065a05bb7aef3eb4bc4b80dfa11c241a0c9c21a9bad9';
const mode = file => fs.statSync(file).mode & 0o777;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, ...options });
  assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  return result.stdout;
}
function inventory(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = prefix + entry.name;
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? inventory(file, relative + '/') : [[relative, digest(file), mode(file)]];
    });
}
function equalMember(expected, actual) {
  assert.equal(digest(actual), digest(expected), 'exact shell bytes');
  assert.equal(mode(actual), mode(expected), 'exact shell mode');
}

test('fixture-only canonical/package/generated/installed executable contract and original mismatch refusal', () => {
  const source = path.join(PLUGIN, MEMBER);
  assert.equal(digest(source), ORIGINAL_DIGEST, 'canonical source bytes remain original');
  assert.equal(mode(source), 0o755, 'canonical worktree entrypoint must be executable');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-mode-fixture-only-')));
  try {
    const before = inventory(PLUGIN);
    const pkg = path.join(dir, 'package');
    require(path.join(ROOT, 'scripts/package-shipyard-codex.cjs')).build(pkg);
    const host = path.join(pkg, 'host');
    const plugin = path.join(host, 'plugins/delivery-pipeline');
    const packaged = path.join(plugin, MEMBER);
    equalMember(source, packaged);
    assert.deepEqual(inventory(plugin), before, 'complete canonical plugin copy retains bytes and modes');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    run('git', ['init', '--quiet', repo]);
    const direct = run(packaged, ['root'], { cwd: repo });
    assert.equal(direct, run('/bin/bash', [packaged, 'root'], { cwd: repo }));
    assert.equal(direct.trim(), path.join(dir, '.wt-repo'));

    const home = path.join(dir, 'home');
    const codexHome = path.join(home, '.codex');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    for (const cli of ['codex', 'npx']) {
      write(path.join(bin, cli), '#!/bin/sh\necho unexpected-fixture-CLI-probe >&2\nexit 99\n');
      fs.chmodSync(path.join(bin, cli), 0o755);
    }
    write(path.join(codexHome, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs'),
      'module.exports = { convertClaudeCommandToCodexSkill: x => x, convertClaudeToCodexMarkdown: x => x };\n');
    write(path.join(codexHome, 'gsd-core/bin/gsd-tools.cjs'),
      "const fs = require('node:fs'); const path = require('node:path'); const a = process.argv.slice(2);\n" +
      "if (a[0] !== 'capability' || a[1] !== 'install') process.exit(99);\n" +
      "fs.cpSync(a[2], path.join(process.env.GSD_CAPABILITIES_DIR, 'delivery-pipeline'), { recursive: true });\n");
    const policy = require(path.join(plugin, 'scripts/model-policy.cjs'));
    const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat()
      .map(rung => ({ model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort }));
    const capabilities = path.join(dir, 'fixture-only-capabilities.json');
    write(capabilities, JSON.stringify({ supportedModels: [...new Set(selections.map(s => s.model))],
      supportedEfforts: [...new Set(selections.map(s => s.effort))], supportedSelections: selections }));
    const defaults = path.join(home, '.gsd/defaults.json');
    const foreign = path.join(codexHome, 'agents/operators-own.toml');
    write(defaults, '{"runtime":"claude","operator_owned":"fixture-only"}\n');
    write(foreign, 'name = "operator"\n');
    const preserved = [defaults, foreign].map(file => [file, fs.readFileSync(file)]);
    const env = {
      HOME: home, GSD_HOME: home, CODEX_HOME: codexHome,
      PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      TMPDIR: dir, LANG: 'C', SHIPYARD_GSD_AUTO_INSTALL: '0',
      AGENTS_SKILLS_DIR: path.join(home, '.agents/skills'),
      GSD_CAPABILITIES_DIR: path.join(home, '.gsd/capabilities'),
      GSD_DEFAULTS_PATH: path.join(home, '.local/state/shipyard/dogfood/codex/defaults.json'),
      CODEX_AGENTS_MD: path.join(codexHome, 'AGENTS.md'),
      SHIPYARD_CODEX_CAPABILITIES_FILE: capabilities,
    };
    const generated = path.join(dir, 'generated');
    run(process.execPath, [path.join(host, 'scripts/gen-codex-shipyard.cjs'), '--plugin', plugin,
      '--out', generated, '--codex-home', codexHome, '--phase', '2', '--project-dir', repo,
      '--capabilities', capabilities], { cwd: dir, env });
    const bundle = path.join(generated, 'bundle');
    equalMember(packaged, path.join(bundle, MEMBER));
    run('/bin/bash', [path.join(host, 'scripts/install-shipyard-codex.sh'),
      '--phase', '2', '--project-dir', repo], { cwd: dir, env });
    const installed = path.join(codexHome, 'shipyard');
    const shells = inventory(plugin).filter(([relative]) => relative.endsWith('.sh'));
    assert.ok(shells.length > 1, 'every bundled shell member is checked');
    for (const [relative] of shells) {
      equalMember(path.join(plugin, relative), path.join(bundle, relative));
      equalMember(path.join(bundle, relative), path.join(installed, relative));
    }
    for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(file), bytes);
    const negative = path.join(dir, 'original-0644-fixture-only.sh');
    fs.copyFileSync(packaged, negative);
    fs.chmodSync(negative, 0o644);
    fs.chmodSync(packaged, 0o644);
    run('/bin/bash', [path.join(host, 'scripts/install-shipyard-codex.sh'),
      '--phase', '2', '--project-dir', repo], { cwd: dir, env });
    assert.equal(mode(path.join(installed, MEMBER)), 0o755);
    assert.equal(digest(path.join(installed, MEMBER)), digest(negative));
    assert.throws(() => equalMember(negative, path.join(installed, MEMBER)),
      { code: 'ERR_ASSERTION', message: /exact shell mode/ });
    assert.deepEqual(inventory(PLUGIN), before, 'fixture operations leave canonical plugin unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
