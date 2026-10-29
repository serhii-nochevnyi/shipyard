#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const MAX_BYTES = 4 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (root, ...argv) => execFileSync('git', ['-C', root, ...argv], {
  timeout: 30000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const gitText = (root, ...argv) => git(root, ...argv).toString().trim();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function physical(file, directory = false) {
  assert(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file,
    'original path must be absolute and physical');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assert(!fs.lstatSync(current).isSymbolicLink(), 'symlinked original evidence');
  }
  const stat = fs.lstatSync(file);
  assert(directory ? stat.isDirectory() : stat.isFile(), 'original evidence has wrong type');
  return stat;
}

function stableRead(file, limit = MAX_BYTES) {
  const before = physical(file);
  assert(before.size <= limit, 'original evidence is not bounded');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = physical(file);
    for (const field of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[field], before[field], 'original evidence replaced before open');
      assert.equal(fs.fstatSync(fd)[field], before[field], 'original descriptor changed');
      assert.equal(after[field], before[field], 'original evidence replaced during read');
    }
    assert.equal(bytes.length, before.size, 'original evidence truncated');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function readOriginal(reference, limit) {
  assert(object(reference) && /^[a-f0-9]{64}$/.test(reference.sha256 || ''), 'original digest required');
  const bytes = stableRead(reference.path, limit);
  assert.equal(sha(bytes), reference.sha256, 'original evidence digest mismatch');
  return bytes;
}
const jsonOriginal = reference => JSON.parse(readOriginal(reference));


function inventory(root, excludeEditor = false, prefix = '') {
  physical(root, true);
  const entries = [];
  for (const name of fs.readdirSync(root).sort((a, b) => a.localeCompare(b))) {
    if (excludeEditor && /\.(bak|orig|rej|swp)$|^\.DS_Store$|~$/.test(name)) continue;
    const file = path.join(root, name), relative = prefix + name;
    assert(!fs.lstatSync(file).isSymbolicLink(), 'symlinked inventory member');
    if (fs.lstatSync(file).isDirectory()) entries.push(...inventory(file, excludeEditor, relative + '/'));
    else entries.push({ path: relative, sha256: sha(stableRead(file)), bytes: fs.statSync(file).size,
      mode: fs.statSync(file).mode & 0o777 });
  }
  return entries;
}


function comparePackage(directory, binding, sealed = false) {
  const actual = inventory(directory).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(actual.length, binding.outputs.length, 'package inventory membership mismatch');
  const content = crypto.createHash('sha256');
  for (let i = 0; i < actual.length; i++) {
    const entry = actual[i], expected = binding.outputs[i];
    for (const field of ['path', 'sha256', 'bytes']) assert.equal(entry[field], expected[field],
      'installed/package bytes mismatch: ' + field);
    assert.equal(entry.mode, sealed ? expected.sealed_mode : expected.publication_mode, 'package mode mismatch');
    if (sealed) assert.equal(entry.mode & 0o222, 0, 'candidate must stay sealed');
    if (!['package-build.json', '.codex-plugin/plugin.json'].includes(entry.path)) {
      content.update(entry.path + '\0'); content.update(stableRead(path.join(directory, entry.path)));
    }
  }
  const contentDigest = content.digest('hex');
  assert.equal(contentDigest, binding.source_content_sha256, 'content digest mismatch');
  const manifestBytes = stableRead(path.join(directory, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  const build = JSON.parse(stableRead(path.join(directory, 'package-build.json')));
  assert.equal(sha(Buffer.concat([Buffer.from(contentDigest + '\0'), manifestBytes])), binding.package_sha256);
  assert.equal(build.digest, binding.package_sha256);
  assert.equal(build.version, binding.version);
  assert.equal(manifest.version, binding.version);
  assert.equal(binding.version, JSON.parse(stableRead(path.join(directory,
    'host/plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version + '+codex.' + contentDigest.slice(0, 16));
  return { package_sha256: build.digest, manifest_sha256: sha(manifestBytes), output_count: actual.length };
}


function installedContract(selected) {
  return {
    inputs: selected.binding.source.identities,
    policy: selected.binding.source.policy_sha256,
    candidate: selected.selection.candidate_sha256, binding: selected.binding
  };
}

function inspectInstalled(identity, selected) {
  const contract = installedContract(selected);
  assert.equal(identity.runtime, 'codex', 'explicit runtime=codex required');
  assert.equal(identity.candidate_sha256, contract.candidate);
  physical(identity.runtime_root, true);
  assert.equal(physical(identity.runtime_root, true).uid, process.getuid(), 'foreign isolated runtime owner');
  assert.notEqual(identity.runtime_root, path.join(os.homedir(), '.codex'), 'shared runtime is not isolated acceptance');
  physical(identity.package_root, true);
  assert(identity.package_root.startsWith(identity.runtime_root + path.sep), 'installed package outside owned runtime');
  const observed = comparePackage(identity.package_root, contract.binding);
  assert.equal(identity.package_sha256, observed.package_sha256);
  assert.equal(identity.manifest_sha256, observed.manifest_sha256);
  const provenance = jsonOriginal(identity.provenance);
  assert(identity.provenance.path.startsWith(identity.runtime_root + path.sep), 'foreign install provenance');
  assert.equal(provenance.schema, 'shipyard.host-provenance.v1');
  assert.equal(provenance.install_kind, 'dogfood', 'isolated candidate must preserve dogfood identity');
  assert.equal(provenance.dirty, identity.source_dirty);
  assert.equal(provenance.source_sha, identity.source_head);
  git(ROOT, 'merge-base', '--is-ancestor', selected.binding.source.head, identity.source_head);
  for (const entry of contract.inputs)
    assert.equal(sha(git(ROOT, 'show', identity.source_head + ':' + entry.path)), entry.sha256, 'installed provenance source drift');
  readOriginal(identity.capability);
  for (const output of selected.binding.outputs) {
    const prefix = 'host/capabilities/delivery-pipeline/';
    if (!output.path.startsWith(prefix)) continue;
    assert.equal(sha(stableRead(path.join(path.dirname(identity.capability.path), output.path.slice(prefix.length)))),
      output.sha256, 'installed registered capability drift');
  }
  const agents = jsonOriginal(identity.agent_manifest);
  assert.equal(agents.policy_hash, contract.policy, 'installed generated agent policy drift');
  assert(object(agents.agent_digests) && Object.keys(agents.agent_digests).length > 0,
    'installed generated agent digests required');
  for (const [name, digest] of Object.entries(agents.agent_digests)) {
    assert.equal(path.basename(name), name, 'generated agent path escape');
    readOriginal({ path: path.join(path.dirname(identity.agent_manifest.path), name), sha256: digest });
  }
  const nativeCapability = jsonOriginal(identity.native_capabilities);
  readOriginal(identity.codex_executable, 256 * 1024 * 1024);
  assert(Array.isArray(nativeCapability.supportedModels) && nativeCapability.supportedModels.length
    && Array.isArray(nativeCapability.supportedEfforts) && nativeCapability.supportedEfforts.length,
  'explicit native runtime capabilities required');
  for (const ref of [identity.capability, identity.agent_manifest])
    assert(ref.path.startsWith(identity.runtime_root + path.sep), 'foreign installed capability/agent manifest');
  assert.equal(identity.host_root, path.join(identity.runtime_root, 'shipyard'), 'unsupported installed bundle root');
  for (const output of selected.binding.outputs) {
    const prefix = 'host/plugins/delivery-pipeline/scripts/';
    if (!output.path.startsWith(prefix)) continue;
    const executable = path.join(identity.host_root, 'scripts', output.path.slice(prefix.length));
    assert.equal(sha(stableRead(executable)), output.sha256, 'actual installed executable drift');
    assert.equal(physical(executable).mode & 0o777, output.publication_mode, 'actual installed executable mode drift');
  }
  assert.equal(identity.policy_sha256, contract.policy);
  for (const field of ['run_id', 'repository_id', 'worktree', 'controller', 'source_tree', 'source_dirty'])
    assert(identity[field] !== undefined && identity[field] !== null, 'installed ' + field + ' identity required');
  assert.equal(identity.worktree, ROOT); assert.equal(identity.repository_id, selected.binding.source.common);
  assert.equal(identity.worktree_head, selected.identity.head, 'current worktree head mismatch');
  assert.equal(identity.worktree_tree, selected.identity.tree, 'current worktree tree mismatch');
  assert.equal(identity.worktree_dirty_sha256, selected.identity.dirty_sha256, 'current worktree dirty inventory mismatch');
  assert.equal(gitText(ROOT, 'rev-parse', identity.source_head + '^{tree}'), identity.source_tree);
  return observed;
}


module.exports = { comparePackage, inspectInstalled };
