'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, done, assert } = require('./assert-harness.cjs');
const { execFileSync } = require('node:child_process');
const { comparePackage, inspectInstalled } = require('../smoke/phase47-runtime-acceptance.cjs');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text, { mode: 0o644 }); };
const CLAUDE = 'host/plugins/delivery-pipeline/.claude-plugin/plugin.json';

function fixture(extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-pkg-')));
  write(root, 'a.txt', 'alpha'); write(root, CLAUDE, '{"version":"1.0.0"}');
  for (const [rel, text] of Object.entries(extra)) write(root, rel, text);
  const content = crypto.createHash('sha256');
  for (const rel of [CLAUDE, 'a.txt', ...Object.keys(extra)].sort((x, y) => x.localeCompare(y))) content.update(rel + '\0').update(fs.readFileSync(path.join(root, rel)));
  const digest = content.digest('hex'), version = '1.0.0+codex.' + digest.slice(0, 16);
  const manifest = JSON.stringify({ version });
  const packageSha = sha(Buffer.concat([Buffer.from(digest + '\0'), Buffer.from(manifest)]));
  write(root, '.codex-plugin/plugin.json', manifest); write(root, 'package-build.json', JSON.stringify({ digest: packageSha, version }));
  const outputs = ['.codex-plugin/plugin.json', 'a.txt', CLAUDE, 'package-build.json', ...Object.keys(extra)].sort((x, y) => x.localeCompare(y)).map((rel) => {
    const bytes = fs.readFileSync(path.join(root, rel));
    return { path: rel, sha256: sha(bytes), bytes: bytes.length, publication_mode: 0o644 };
  });
  return { root, binding: { outputs, source_content_sha256: digest, package_sha256: packageSha, version } };
}

test('comparePackage accepts the exact package and refuses a same-size byte change, mode drift, an extra file and a wrong digest', () => {
  const { root, binding } = fixture();
  try {
    assert.equal(comparePackage(root, binding).package_sha256, binding.package_sha256);
    write(root, 'a.txt', 'omega');
    assert.throws(() => comparePackage(root, binding), /bytes mismatch: sha256/);
    write(root, 'a.txt', 'alpha');
    fs.chmodSync(path.join(root, 'a.txt'), 0o755);
    assert.throws(() => comparePackage(root, binding), /mode mismatch/);
    fs.chmodSync(path.join(root, 'a.txt'), 0o644);
    write(root, 'extra', 'x');
    assert.throws(() => comparePackage(root, binding), /membership/);
    fs.unlinkSync(path.join(root, 'extra'));
    assert.throws(() => comparePackage(root, { ...binding, package_sha256: '0'.repeat(64) }));
    assert.throws(() => comparePackage(root, { ...binding, source_content_sha256: '0'.repeat(64) }), /content digest/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const ROOT = path.resolve(__dirname, '../..');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();

function installation() {
  const script = 'host/plugins/delivery-pipeline/scripts/x.cjs', capability = 'host/capabilities/delivery-pipeline/c.json';
  const { root: pkg, binding } = fixture({ [script]: 'x', [capability]: 'c' });
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inst-rt-')));
  const rt = (rel) => path.join(runtime, rel);
  fs.renameSync(pkg, rt('package'));
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const ref = (rel, text) => { write(runtime, rel, text); return { path: rt(rel), sha256: sha(Buffer.from(text)) }; };
  write(runtime, 'shipyard/scripts/x.cjs', 'x');
  write(runtime, 'capability/c.json', 'c');
  const policy = 'f'.repeat(64);
  const agent = ref('agents/a.toml', 'agent');
  const identity = { runtime: 'codex', candidate_sha256: 'c'.repeat(64), runtime_root: runtime, package_root: rt('package'),
    package_sha256: binding.package_sha256, manifest_sha256: sha(fs.readFileSync(rt('package/.codex-plugin/plugin.json'))),
    provenance: ref('prov.json', JSON.stringify({ schema: 'shipyard.host-provenance.v1', install_kind: 'dogfood', dirty: false, source_sha: head })),
    source_head: head, source_tree: tree, source_dirty: false, capability: ref('capability/capability.json', '{}'),
    agent_manifest: ref('agents/manifest.json', JSON.stringify({ policy_hash: policy, agent_digests: { 'a.toml': agent.sha256 } })),
    native_capabilities: ref('native.json', JSON.stringify({ supportedModels: ['m'], supportedEfforts: ['high'] })),
    codex_executable: ref('codex', 'bin'), host_root: rt('shipyard'), policy_sha256: policy, run_id: 'r', repository_id: '/common',
    worktree: ROOT, controller: 'c', worktree_head: head, worktree_tree: tree, worktree_dirty_sha256: 'd'.repeat(64) };
  const selected = { binding: { ...binding, source: { head, identities: [], policy_sha256: policy, common: '/common' } },
    selection: { candidate_sha256: identity.candidate_sha256 }, identity: { head, tree, dirty_sha256: identity.worktree_dirty_sha256 } };
  return { runtime, rt, identity, selected };
}

test('inspectInstalled accepts the exact installation and refuses executable, mode, capability, digest, policy, runtime and dirty drift', () => {
  const { runtime, rt, identity, selected } = installation();
  try {
    assert.equal(inspectInstalled(identity, selected).package_sha256, identity.package_sha256);
    const refuses = (name, mutate, restore) => { mutate(); assert.throws(() => inspectInstalled(identity, selected), undefined, name); restore(); };
    refuses('executable bytes', () => write(runtime, 'shipyard/scripts/x.cjs', 'y'), () => write(runtime, 'shipyard/scripts/x.cjs', 'x'));
    refuses('executable mode', () => fs.chmodSync(rt('shipyard/scripts/x.cjs'), 0o755), () => fs.chmodSync(rt('shipyard/scripts/x.cjs'), 0o644));
    refuses('capability bytes', () => write(runtime, 'capability/c.json', 'd'), () => write(runtime, 'capability/c.json', 'c'));
    refuses('runtime', () => { identity.runtime = 'claude'; }, () => { identity.runtime = 'codex'; });
    refuses('package digest', () => { identity.package_sha256 = '0'.repeat(64); }, () => { identity.package_sha256 = selected.binding.package_sha256; });
    refuses('policy', () => { identity.policy_sha256 = 'e'.repeat(64); }, () => { identity.policy_sha256 = 'f'.repeat(64); });
    refuses('dirty', () => { identity.source_dirty = true; }, () => { identity.source_dirty = false; });
    assert.equal(inspectInstalled(identity, selected).package_sha256, identity.package_sha256);
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
});

done();
