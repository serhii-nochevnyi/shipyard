'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const REPOSITORY = path.resolve(__dirname, '../..');
const HOST = '/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa';
const HANDOFF = path.join(HOST, 'phase47-current-generation-20261006/generation.json');
const HANDOFF_SHA = '64e111070452b70065e4f1a71041c7b0a3091105f3e40a7253a3e9b25132fb81';
const OPERATOR = '2F485C0A455BA33463F66332900FCE87BD1BFF0D';
const BASELINE = '7eebae4812b3c67ccdbbb63c8c1603f7767b1466';
const PHASE = '.planning/phases/47-complete-deferred-decomposition-wait-attribution';
const STAGE_DIRECTORY = 'shipyard-phase47-publication/INV-014-runtime-delivery-correctness';
const SCRIPTS = ['bootstrap-shipyard-plugin.cjs', 'ensure-gsd-plugin.cjs', 'ensure-gsd-core.sh',
  'install-shipyard-codex.sh', 'install-shipyard-capability.sh', 'gen-codex-shipyard.cjs',
  'merge-codex-config.cjs', 'configure-codex-notify.cjs'];
const mirror = name => 'host/plugins/delivery-pipeline/scripts/' + name + '.cjs';
const ALLOCATION = {
  'T-47-05': ['deliver-dispatch', 'run-contract', 'codex-delivery-host', 'dispatch-record',
    'planning-result-sealer'].map(mirror),
  'T-47-11': ['claude-role-host', 'codex-dispatch-adapter', 'codex-arch-review-context',
    'role-artifact', 'codex-decompose-host', 'codex-planning-context-host', 'codex-notify',
    'host-verification'].map(mirror).concat('host/scripts/configure-codex-notify.cjs'),
  'T-47-12': ['host/plugins/delivery-pipeline/commands/investigate.md',
    'host/plugins/delivery-pipeline/commands/decompose.md', '.codex-plugin/plugin.json',
    'package-build.json', mirror('codex-runtime-host'), mirror('claude-runtime-host')],
};
const UNION = Object.values(ALLOCATION).flat().sort();
const CALLER = ['codex-arch-review-context', 'role-artifact', 'codex-decompose-host',
  'codex-planning-context-host'].map(mirror);
const GROUPS = {
  candidate: [], launch: ALLOCATION['T-47-05'],
  caller: [...ALLOCATION['T-47-05'], ...CALLER],
  integration: [...ALLOCATION['T-47-05'], ...ALLOCATION['T-47-11']],
  relay: UNION.filter(p => !['.codex-plugin/plugin.json', 'package-build.json'].includes(p)),
  complete: UNION,
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canon = value => Array.isArray(value) ? '[' + value.map(canon).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}' : JSON.stringify(value);
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 32 * 1024 * 1024,
});
const gitText = (root, ...args) => git(root, ...args).toString().trim();

function physical(file, directory = false, sealed = false) {
  assert(path.isAbsolute(file) && path.normalize(file) === file, 'nonabsolute or moved physical path');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    assert(!fs.lstatSync(current).isSymbolicLink(), 'symlinked physical path: ' + current);
  }
  const stat = fs.lstatSync(file);
  assert(directory ? stat.isDirectory() : stat.isFile(), 'wrong physical type: ' + file);
  assert.equal(fs.realpathSync(file), file, 'moved physical path');
  if (sealed) {
    assert.equal(stat.mode & 0o222, 0, 'unsealed physical path: ' + file);
    assert.equal(stat.uid, process.getuid(), 'foreign sealed owner');
  }
  return stat;
}

function read(file, digest, sealed = false) {
  const before = physical(file, false, sealed);
  const bytes = fs.readFileSync(file);
  const after = physical(file, false, sealed);
  for (const field of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'])
    assert.equal(after[field], before[field], 'physical input replaced during read');
  if (digest !== undefined) assert.equal(sha(bytes), digest, 'digest mismatch: ' + file);
  return bytes;
}

function inventory(root, editorExclusions = false, sealed = false, prefix = '') {
  physical(root, true, sealed);
  const entries = [];
  // Keep the builder's localeCompare path/NUL/bytes ordering.
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name);
    if (editorExclusions && /\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(file)) continue;
    const relative = prefix + entry.name;
    assert(!entry.isSymbolicLink(), 'symlinked inventory member');
    if (entry.isDirectory()) entries.push(...inventory(file, editorExclusions, sealed, relative + '/'));
    else {
      const bytes = read(file, undefined, sealed);
      entries.push({ path: relative, sha256: sha(bytes), bytes: bytes.length,
        mode: physical(file).mode & 0o777 });
    }
  }
  return entries;
}

function canonicalInputs(root) {
  const files = ['scripts/package-shipyard-codex.cjs', ...SCRIPTS.map(name => 'scripts/' + name)];
  for (const directory of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
    for (const entry of inventory(path.join(root, directory), true)) files.push(directory + '/' + entry.path);
  return [...new Set(files)].sort().map(relative => ({ path: relative, sha256: sha(read(path.join(root, relative))) }));
}

function validateAllocation(allocation) {
  assert.deepEqual(Object.keys(allocation).sort(), Object.keys(ALLOCATION).sort(), 'publication owner drift');
  for (const ticket of Object.keys(ALLOCATION))
    assert.deepEqual([...allocation[ticket]].sort(), [...ALLOCATION[ticket]].sort(), 'publication allocation drift: ' + ticket);
  assert.equal(new Set(Object.values(allocation).flat()).size, 20, 'publication union must contain twenty outputs');
}

function validateHandback(handback, selection, binding, selectionPath) {
  assert.equal(handback.schema, 'shipyard.phase47-coordinator-generation.v1');
  assert.equal(handback.actor, 'trusted-coordinator');
  assert.equal(handback.operation, 'generate');
  assert.equal(handback.status, 'completed', 'missing completed preparation');
  assert.equal(handback.native_receipt, false, 'host preparation is not a native receipt');
  assert.match(handback.command_sha256, /^[a-f0-9]{64}$/);
  assert.equal(handback.selection_path, selectionPath);
  assert.equal(handback.selection_sha256, sha(read(selectionPath)));
  for (const key of ['generation_id', 'candidate_path', 'binding_path', 'binding_sha256', 'candidate_sha256'])
    assert.equal(handback[key], selection[key], 'handback/selection mismatch: ' + key);
  assert.equal(handback.source_head, binding.source.head);
  assert.equal(handback.source_identity_sha256, sha(canon(binding.source)), 'original source identity drift');
  assert.equal(handback.original_index_sha256, binding.source.plan_index_sha256);
  assert.equal(handback.historical_manifest_sha256, binding.source.plan_manifest_sha256);
  assert.deepEqual(handback.current_plan_amendments, binding.source.current_plan_amendments);
  validateAllocation(handback.publication_allocation);
  assert.deepEqual([...handback.changed_outputs].sort(), UNION, 'unexpected generation scope');
}

function selectedArtifact(common, handback) {
  const root = path.join(common, STAGE_DIRECTORY);
  assert.equal(physical(root, true).uid, process.getuid(), 'foreign publication root');
  assert.equal(physical(root, true).mode & 0o077, 0, 'public publication root');
  const selectionPath = path.join(root, 'selection.json');
  const selection = JSON.parse(read(selectionPath, handback.selection_sha256, true));
  assert.match(selection.generation_id, /^[a-f0-9]{64}$/);
  const generation = path.join(root, selection.generation_id);
  assert.equal(selection.candidate_path, path.join(generation, 'candidate'), 'moved candidate selection');
  assert.equal(selection.binding_path, path.join(generation, 'binding.json'), 'moved binding selection');
  assert.deepEqual(fs.readdirSync(root).sort(), [selection.generation_id, 'selection.json'].sort(), 'unselected generation');
  physical(generation, true, true);
  assert.deepEqual(fs.readdirSync(generation).sort(), ['binding.json', 'candidate']);
  const binding = JSON.parse(read(selection.binding_path, selection.binding_sha256, true));
  assert.equal(binding.generation_id, selection.generation_id);
  assert.equal(binding.canonical_input_digest, selection.generation_id);
  assert.equal(binding.source.canonical_input_digest, binding.canonical_input_digest);
  assert.equal(sha(canon(binding.source.identities)), binding.canonical_input_digest);
  assert.equal(sha(canon(binding.outputs)), selection.candidate_sha256);
  assert.equal(binding.source.common, common, 'foreign git common identity');
  validateAllocation(binding.source.publication_allocation);
  validateHandback(handback, selection, binding, selectionPath);
  const actual = inventory(selection.candidate_path, false, true).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(actual.length, binding.outputs.length, 'candidate inventory membership drift');
  for (let index = 0; index < actual.length; index++) {
    const observed = actual[index], expected = binding.outputs[index];
    for (const key of ['path', 'sha256', 'bytes']) assert.equal(observed[key], expected[key], 'sealed output mismatch: ' + key);
    assert([0o644, 0o755].includes(expected.publication_mode), 'invalid publication mode');
    assert.equal(expected.git_mode, expected.publication_mode === 0o755 ? '100755' : '100644');
    assert.equal(expected.sealed_mode, expected.publication_mode & ~0o222);
    assert.equal(observed.mode, expected.sealed_mode, 'sealed execute bit/mode mismatch');
  }
  const hash = crypto.createHash('sha256');
  for (const entry of actual) {
    if (['package-build.json', '.codex-plugin/plugin.json'].includes(entry.path)) continue;
    hash.update(entry.path + '\0'); hash.update(read(path.join(selection.candidate_path, entry.path)));
  }
  const content = hash.digest('hex');
  assert.equal(content, binding.source_content_sha256);
  const manifestBytes = read(path.join(selection.candidate_path, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  const build = JSON.parse(read(path.join(selection.candidate_path, 'package-build.json')));
  const packageDigest = sha(Buffer.concat([Buffer.from(content + '\0'), manifestBytes]));
  assert.equal(packageDigest, binding.package_sha256);
  assert.equal(build.digest, packageDigest);
  assert.equal(manifest.version, binding.version);
  assert.equal(build.version, binding.version);
  assert.equal(binding.version, JSON.parse(read(path.join(selection.candidate_path,
    'host/plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version + '+codex.' + content.slice(0, 16));
  for (const input of binding.source.identities) {
    if (input.path === 'scripts/package-shipyard-codex.cjs') continue;
    const output = 'host/' + input.path;
    assert.equal(sha(read(path.join(selection.candidate_path, output))), input.sha256, 'mixed canonical package bytes');
  }
  return { root, selectionPath, selection, binding };
}

function authenticateHandback() {
  const bytes = read(HANDOFF, HANDOFF_SHA, true);
  read(HANDOFF + '.asc', undefined, true);
  const publicKey = path.join(path.dirname(HANDOFF), 'operator-public-key.asc');
  read(publicKey);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-p47-signature-')));
  fs.chmodSync(home, 0o700);
  try {
    const keyring = path.join(home, 'operator.gpg');
    execFileSync('gpg', ['--batch', '--no-options', '--homedir', home, '--dearmor', '--output', keyring, publicKey], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    const result = execFileSync('gpgv', ['--homedir', home, '--keyring', keyring,
      '--status-fd', '1', HANDOFF + '.asc', HANDOFF], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    const valid = result.split('\n').filter(line => line.startsWith('[GNUPG:] VALIDSIG '));
    assert.equal(valid.length, 1, 'missing unique operator signature');
    assert(valid[0].split(' ').slice(2).includes(OPERATOR), 'wrong operator signature');
    read(HANDOFF, sha(bytes), true);
    return JSON.parse(bytes);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function validateParents(source, state, getPullRequest, ancestor) {
  const parents = ['T-47-13', 'T-47-03', 'T-47-04', 'T-47-09', 'T-47-15', 'T-47-14'];
  assert.deepEqual(Object.keys(source.parent_commits).sort(), [...parents].sort());
  assert.deepEqual(Object.keys(source.provenance).sort(), [...parents].sort());
  for (const id of parents) {
    const row = state[id], commit = source.parent_commits[id], provenance = source.provenance[id];
    assert(row && row.status === 'merged', 'parent is not a direct merged row: ' + id);
    assert(Number.isSafeInteger(row.pr) && row.pr > 0, 'missing real parent PR');
    assert.equal(row.pr, provenance.pr);
    assert.equal(row.merge_sha, commit.merge);
    assert.equal(row.base, provenance.base);
    assert.equal(row.url, provenance.url);
    assert.equal(sha(canon(row)), provenance.state_sha256, 'parent state/provenance mismatch');
    assert.equal(provenance.url, 'https://github.com/serhii-nochevnyi/shipyard/pull/' + row.pr);
    if (getPullRequest) {
      const pr = getPullRequest(row.pr);
      assert.equal(pr.number, row.pr);
      assert.equal(pr.state, 'MERGED');
      assert.equal(pr.headRefOid, commit.head, 'live parent head association mismatch');
      assert.equal(pr.mergeCommit.oid, commit.merge, 'live parent merge association mismatch');
      assert.equal(pr.baseRefName, provenance.base);
    }
    assert.match(commit.head, /^[a-f0-9]{40}$/);
    assert(Array.isArray(commit.base_merge_commits));
    for (const merged of [commit.merge, ...commit.base_merge_commits]) {
      assert.match(merged, /^[a-f0-9]{40}$/); ancestor(merged, source.head);
    }
  }
}

function planOwners(bytes) {
  const text = bytes.toString();
  const owners = text.match(/^files_modified:\s*\n((?:[ \t]+- [^\n]+\n)+)/m);
  assert(owners, 'missing current PLAN ownership');
  return owners[1].split('\n').filter(Boolean).map(line => line.replace(/^\s*-\s*/, '').trim()).sort();
}

function validatePlanning(handback, source) {
  const manifest = JSON.parse(read(handback.historical_manifest_path, source.plan_manifest_sha256, true));
  assert.equal(manifest.schema, 'shipyard.phase47-plan-snapshot.v1');
  assert.equal(manifest.phase, 47);
  assert.equal(manifest.original_index_sha256, source.plan_index_sha256);
  assert.equal(manifest.policy_hash, source.policy_sha256);
  const index = JSON.parse(read(manifest.original_index_path, source.plan_index_sha256));
  read(manifest.original_index_copy, source.plan_index_sha256, true);
  const originalResult = JSON.parse(read(manifest.original_result_path, manifest.original_result_sha256));
  assert.equal(originalResult.schema, 'shipyard.decomposition-result.v1');
  assert.equal(originalResult.status, 'completed', 'missing original completed planning result');
  assert.equal(originalResult.repository, manifest.repository);
  assert.equal(originalResult.source_revision, manifest.source_revision);
  assert.equal(originalResult.policy_hash, manifest.policy_hash);
  assert.equal(originalResult.receipt.dispatch_id, manifest.planner_dispatch);
  assert.equal(originalResult.receipt.runtime, 'codex');
  assert.equal(originalResult.receipt.role, 'decomposition');
  assert.equal(originalResult.artifact_index.path, manifest.original_index_path);
  assert.equal(originalResult.artifact_index.sha256, source.plan_index_sha256);
  assert.equal(originalResult.plan_count, 16);
  const names = Array.from({ length: 15 }, (_, n) => '47-' + String(n + 1).padStart(2, '0') + '-PLAN.md').concat('CONTEXT.md').sort();
  assert.equal(manifest.entries.length, 16);
  assert.equal(index.entries.length, 16);
  assert.deepEqual(manifest.entries.map(entry => path.basename(entry.path)).sort(), names);
  for (const entry of manifest.entries) {
    assert.equal(entry.physical_path, path.join(manifest.root, path.basename(entry.path)));
    assert.equal(read(entry.physical_path, entry.sha256, true).length, entry.bytes);
    const original = index.entries.find(row => row.path === entry.original_path);
    assert(original, 'snapshot is missing original index membership');
    assert.equal(original.sha256, entry.sha256);
    assert.equal(original.bytes, entry.bytes);
  }
  const capturedPath = path.join(path.dirname(HANDOFF), 'captured-coordinator-47-05-PLAN.md');
  const captured = read(capturedPath, source.current_plan_amendments[0].sha256, true);
  const current = read(source.current_plan_amendments[0].path);
  assert.deepEqual(planOwners(current), planOwners(captured), 'later handback reference changed owners');
  assert.equal(sha(current), '70e5ce04dd05e5bba28ebdec7d0dc833fc158a7b844b1f7d58b26f782b2849cf', 'unreviewed current coordinator amendment');
  assert.deepEqual(planOwners(captured), ['tests/unit/phase47-package-publication.test.cjs',
    ...ALLOCATION['T-47-05'].map(relative => 'plugins/shipyard/' + relative)].sort());
  const successor = read(source.current_plan_amendments[1].path, source.current_plan_amendments[1].sha256);
  assert.deepEqual(planOwners(successor), ALLOCATION['T-47-11'].map(relative => 'plugins/shipyard/' + relative).sort());
  return { manifest_sha256: source.plan_manifest_sha256, index_sha256: source.plan_index_sha256,
    captured_plan_sha256: sha(captured), current_plan_sha256: sha(current),
    original_result_path: manifest.original_result_path, original_result_sha256: manifest.original_result_sha256,
    original_dispatch_id: originalResult.receipt.dispatch_id };
}

function validateSource(root, binding) {
  const source = binding.source;
  const ancestor = (before, after) => git(root, 'merge-base', '--is-ancestor', before, after);
  ancestor(BASELINE, source.head); ancestor(source.head, 'HEAD');
  assert.equal(gitText(root, 'rev-parse', source.head + '^{tree}'), source.tree);
  assert.equal(gitText(source.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'), source.common);
  const inputs = canonicalInputs(root);
  assert.deepEqual(inputs, source.identities, 'canonical source drift');
  assert.equal(sha(canon(inputs)), binding.canonical_input_digest);
  assert.deepEqual(inputs.map(entry => ({ path: entry.path, mode: physical(path.join(root, entry.path)).mode & 0o777 })), source.input_modes);
  for (const entry of inputs) {
    assert.equal(sha(git(root, 'show', source.head + ':' + entry.path)), entry.sha256, 'unreviewed canonical input');
    const mode = gitText(root, 'ls-files', '--stage', '--', entry.path).split(' ')[0];
    assert.equal(mode, source.input_modes.find(row => row.path === entry.path).mode === 0o755 ? '100755' : '100644');
  }
  assert.deepEqual(source.dirty, []);
  assert.equal(source.status_sha256, sha(''));
  assert.equal(source.diff_sha256, sha(''));
  assert.equal(source.index_sha256, sha(git(root, 'ls-tree', '-r', source.head).toString().split('\n').filter(Boolean)
    .map(line => line.replace(/^(\d+) blob ([a-f0-9]+)\t/, '$1 $2 0\t') + '\0').join('')));
  read(path.join(source.repository, '.planning/config.json'), source.config_sha256);
  read(path.join(root, '.planning/config.json'), source.config_sha256);
  assert.equal(require(path.join(root, 'plugins/delivery-pipeline/scripts/model-policy.cjs'))
    .resolveDispatch({ runtime: 'codex', role: 'research' }).policy_hash, source.policy_sha256, 'policy drift');
  const graph = JSON.parse(read(path.join(source.repository, '.planning/graph/tickets.json'), source.graph_sha256));
  const state = JSON.parse(read(path.join(source.repository, '.planning/graph/delivery-state.json')));
  for (const [id, row] of Object.entries(graph.tickets)) {
    if (!id.startsWith('T-47-')) continue;
    for (const dep of [...(row.depends_on || []), ...(row.cross_phase_deps || [])])
      assert(!/^T-48-/.test(dep), 'phase48 dependency in bound canonical graph');
  }
  const commits = gitText(root, 'log', '--format=%s', BASELINE + '..' + source.head);
  assert(!/^T-48-/m.test(commits), 'phase48 changes in selected source ancestry');
  validateParents(source, state, null, ancestor);
  return { head: gitText(root, 'rev-parse', 'HEAD'), tree: gitText(root, 'rev-parse', 'HEAD^{tree}'),
    canonical_input_digest: binding.canonical_input_digest, source_ancestor: true };
}

function validatePublication(root, selected, group) {
  const { binding, selection } = selected;
  const published = path.join(root, 'plugins/shipyard');
  const observed = inventory(published);
  const outputs = new Map(binding.outputs.map(entry => [entry.path, entry]));
  for (const entry of observed) {
    const expected = outputs.get(entry.path);
    assert(expected, 'unexpected checked-in package path: ' + entry.path);
    if (entry.sha256 !== expected.sha256 || entry.mode !== expected.publication_mode)
      assert(UNION.includes(entry.path), 'unexpected publication delta: ' + entry.path);
    const indexMode = gitText(root, 'ls-files', '--stage', '--', 'plugins/shipyard/' + entry.path).split(' ')[0];
    if (!indexMode) assert.equal(entry.path, mirror('codex-arch-review-context'), 'unreviewed new package path');
    else assert.equal(indexMode, expected.git_mode, 'package git index mode drift');
  }
  for (const output of binding.outputs)
    if (!observed.some(entry => entry.path === output.path))
      assert.equal(output.path, mirror('codex-arch-review-context'), 'unexpected missing package path');
  for (const relative of GROUPS[group]) {
    const expected = outputs.get(relative);
    assert(expected, 'missing publication ledger member');
    const file = path.join(published, relative);
    read(file, expected.sha256);
    assert.equal(physical(file).mode & 0o777, expected.publication_mode, 'publication mode mismatch');
    const indexMode = gitText(root, 'ls-files', '--stage', '--', 'plugins/shipyard/' + relative).split(' ')[0];
    if (!indexMode) {
      assert.equal(relative, mirror('codex-arch-review-context'), 'missing publication git index mode');
      assert.equal(gitText(root, 'ls-files', '--stage', '--', relative.slice(5)).split(' ')[0], expected.git_mode,
        'new collector lacks reviewed canonical git mode');
    } else assert.equal(indexMode, expected.git_mode, 'git index mode mismatch');
    if (relative.startsWith('host/')) read(path.join(root, relative.slice(5)), expected.sha256);
    read(path.join(selection.candidate_path, relative), expected.sha256, true);
  }
  return GROUPS[group].length;
}

function stageContracts(selected) {
  const stage = selected.selection.candidate_path;
  const packageRoot = path.join(stage, 'host/plugins/delivery-pipeline');
  const fixtureHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-p47-contracts-')));
  const preload = path.join(fixtureHome, 'stage-preload.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),path=require('node:path');
    require('node:os').homedir=()=>${JSON.stringify(fixtureHome)};
    const original=Module._resolveFilename,canonical=${JSON.stringify(path.join(REPOSITORY, 'plugins/delivery-pipeline'))},stage=${JSON.stringify(packageRoot)};
    Module._resolveFilename=function(request,parent,...rest){const resolved=original.call(this,request,parent,...rest);
      return resolved.startsWith(canonical+path.sep)?stage+resolved.slice(canonical.length):resolved;};
    const fs=require('node:fs'),copy=fs.cpSync;
    fs.cpSync=function(source,destination,...rest){const result=copy.call(this,source,destination,...rest);
      if(String(source)===stage){const target=fs.realpathSync(destination);
        require('node:assert/strict').ok(target.startsWith(fs.realpathSync(require('node:os').tmpdir())+path.sep));
        const restore=file=>{const stat=fs.lstatSync(file);fs.chmodSync(file,(stat.mode&0o777)|0o200);
          if(stat.isDirectory())for(const name of fs.readdirSync(file))restore(path.join(file,name));};restore(target);}
      return result;};`);
  const env = { ...process.env, SHIPYARD_TEST_PACKAGE_ROOT: packageRoot, NODE_OPTIONS: '--require=' + preload };
  delete env.SHIPYARD_GRAPH_DIR;
  try {
    const launch = spawnSync(process.execPath, [path.join(__dirname, 'phase47-launch-contract.test.cjs')], {
      encoding: 'utf8', env, timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(launch.status, 0, 'stage-bound launch contract failed:\n' + launch.stdout + launch.stderr);
    const script = `const fs=require('node:fs'),Module=require('node:module');
      const filename=${JSON.stringify(path.join(__dirname, 'codex-arch-review-context.test.cjs'))};
      const source=fs.readFileSync(filename,'utf8').replaceAll('../../plugins/delivery-pipeline',${JSON.stringify(packageRoot)});
      const main=new Module(filename);main.filename=filename;main.paths=Module._nodeModulePaths(${JSON.stringify(__dirname)});
      main._compile(source,filename);main.exports.registerTests(require('node:test'));`;
    const architecture = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env, timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(architecture.status, 0, 'staged collector/shared consumer contract failed:\n' + architecture.stdout + architecture.stderr);
    for (const names of [['deliver-dispatch', 'codex-decompose-host'], ['codex-decompose-host', 'deliver-dispatch']]) {
      const result = spawnSync(process.execPath, ['-e', `const root=${JSON.stringify(packageRoot)};
        for(const name of ${JSON.stringify(names)})require(root+'/scripts/'+name+'.cjs');
        const delivery=require(root+'/scripts/deliver-dispatch.cjs');
        require('node:assert/strict').equal(typeof delivery.dispatchStateDir,'function');`], {
        encoding: 'utf8', env, timeout: 10000,
      });
      assert.equal(result.status, 0, 'staged public load order failed: ' + result.stderr);
    }
    const detachedScript = `const fs=require('node:fs'),Module=require('node:module');
      const filename=${JSON.stringify(path.join(__dirname, 'codex-decompose-host.test.cjs'))};
      const source=fs.readFileSync(filename,'utf8').replaceAll('../../plugins/delivery-pipeline',${JSON.stringify(packageRoot)});
      const main=new Module(filename);main.filename=filename;main.paths=Module._nodeModulePaths(${JSON.stringify(__dirname)});
      process.mainModule=main;main._compile(source,filename);`;
    const detached = spawnSync(process.execPath, ['--test-name-pattern', '^fresh public .* detached CLI', '-e', detachedScript], {
      encoding: 'utf8', env, timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(detached.status, 0, 'staged public detached CLI contract failed:\n' + detached.stdout + detached.stderr);
    assert.match(detached.stdout, /tests 2\b/, 'both public detached contracts must execute');
    const evidence = result => ({ stdout_sha256: sha(result.stdout), stderr_sha256: sha(result.stderr),
      exit_code: result.status, tests: Number(result.stdout.match(/(?:# |ℹ )tests (\d+)/)?.[1]),
      passed: Number(result.stdout.match(/(?:# |ℹ )pass (\d+)/)?.[1]) });
    return { launch: evidence(launch), architecture: evidence(architecture),
      detached: evidence(detached), public_load_orders: 2 };
  } finally { fs.rmSync(fixtureHome, { recursive: true, force: true }); }
}

function check(group) {
  assert(Object.hasOwn(GROUPS, group), 'unknown publication group');
  const common = gitText(REPOSITORY, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const handback = authenticateHandback();
  const selected = selectedArtifact(common, handback);
  const current = validateSource(REPOSITORY, selected.binding);
  const planning = validatePlanning(handback, selected.binding.source);
  const count = validatePublication(REPOSITORY, selected, group);
  const contracts = stageContracts(selected);
  selectedArtifact(common, handback);
  assert.deepEqual(canonicalInputs(REPOSITORY), selected.binding.source.identities, 'canonical drift during verification');
  return { status: 'completed', ticket: 'T-47-05', group, generation_id: handback.generation_id,
    source_head: selected.binding.source.head, source_identity_sha256: handback.source_identity_sha256,
    current_admission: current, handback_path: HANDOFF, handback_sha256: HANDOFF_SHA,
    selection_path: selected.selectionPath, selection_sha256: handback.selection_sha256,
    binding_path: selected.selection.binding_path, binding_sha256: selected.selection.binding_sha256,
    candidate_path: selected.selection.candidate_path, candidate_sha256: selected.selection.candidate_sha256,
    package_sha256: selected.binding.package_sha256, version: selected.binding.version,
    output_count: selected.binding.outputs.length, publication_count: count, build_calls: 0, planning,
    contracts, remaining_obligations: ['current-head human review', 'T-47-11 publication',
      'T-47-12 complete publication', 'T-47-08 installed/native acceptance'] };
}

function privateFixtures() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-p47-publication-')));
  const root = path.join(temporary, 'repo');
  const write = (relative, bytes, mode = 0o644) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes); fs.chmodSync(file, mode); return file;
  };
  let cases = 0;
  const rejects = (name, action) => { assert.throws(action, undefined, name); cases++; };
  try {
    fs.mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Publication Fixture');
    git(root, 'config', 'user.email', 'publication@example.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
    write('scripts/package-shipyard-codex.cjs', read(path.join(REPOSITORY, 'scripts/package-shipyard-codex.cjs')));
    for (const script of SCRIPTS) write('scripts/' + script, '// private fixture\n');
    write('plugins/delivery-pipeline/.claude-plugin/plugin.json', JSON.stringify({
      name: 'shipyard', version: '0.71.0', description: 'Private publication fixture', author: { name: 'Fixture' },
    }));
    for (const name of ['route', 'investigate', 'decompose', 'deliver', 'bench'])
      write('plugins/delivery-pipeline/commands/' + name + '.md', '---\ndescription: private fixture\n---\n');
    write('plugins/delivery-pipeline/skills/delivery-rules/SKILL.md', 'description: private fixture\n');
    write('capabilities/delivery-pipeline/capability.json', '{}\n');
    for (const relative of UNION.filter(relative => relative.startsWith('host/plugins/')))
      if (!fs.existsSync(path.join(root, relative.slice(5))))
        write(relative.slice(5), '// private fixture\n', relative === mirror('codex-decompose-host') ? 0o755 : 0o644);
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'private reviewed inputs');
    const common = gitText(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const inputs = canonicalInputs(root), generation = sha(canon(inputs));
    const durable = path.join(common, STAGE_DIRECTORY), generationRoot = path.join(durable, generation);
    const candidate = path.join(generationRoot, 'candidate');
    const bindingPath = path.join(generationRoot, 'binding.json'), selectionPath = path.join(durable, 'selection.json');
    fs.mkdirSync(generationRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(durable, 0o700);
    let buildCalls = 0;
    const builder = require(path.join(root, 'scripts/package-shipyard-codex.cjs'));
    buildCalls++; builder.build(candidate);
    const source = { head: gitText(root, 'rev-parse', 'HEAD'), common,
      identities: inputs, canonical_input_digest: generation, publication_allocation: ALLOCATION,
      plan_index_sha256: sha('private index'), plan_manifest_sha256: sha('private manifest'),
      current_plan_amendments: [] };
    const outputs = inventory(candidate).map(entry => {
      const publication = entry.mode === 0o755 ? 0o755 : 0o644;
      return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes,
        git_mode: publication === 0o755 ? '100755' : '100644', publication_mode: publication,
        sealed_mode: publication & ~0o222 };
    });
    const contentHash = crypto.createHash('sha256');
    for (const entry of outputs) {
      if (['.codex-plugin/plugin.json', 'package-build.json'].includes(entry.path)) continue;
      contentHash.update(entry.path + '\0'); contentHash.update(read(path.join(candidate, entry.path)));
    }
    const build = JSON.parse(read(path.join(candidate, 'package-build.json')));
    const binding = { generation_id: generation, canonical_input_digest: generation, source, outputs,
      source_content_sha256: contentHash.digest('hex'), package_sha256: build.digest, version: build.version };
    fs.writeFileSync(bindingPath, JSON.stringify(binding), { flag: 'wx', mode: 0o400 });
    const selection = { generation_id: generation, candidate_path: candidate, binding_path: bindingPath,
      binding_sha256: sha(read(bindingPath)), candidate_sha256: sha(canon(outputs)) };
    fs.writeFileSync(selectionPath, JSON.stringify(selection), { flag: 'wx', mode: 0o400 });
    const sealDirectories = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) sealDirectories(path.join(directory, entry.name));
      fs.chmodSync(directory, 0o500);
    };
    for (const output of outputs) fs.chmodSync(path.join(candidate, output.path), output.sealed_mode);
    sealDirectories(candidate); fs.chmodSync(generationRoot, 0o500);
    const handback = { schema: 'shipyard.phase47-coordinator-generation.v1', actor: 'trusted-coordinator',
      operation: 'generate', status: 'completed', native_receipt: false, command_sha256: sha('private build'),
      ...selection, selection_path: selectionPath, selection_sha256: sha(read(selectionPath)),
      source_head: source.head, source_identity_sha256: sha(canon(source)),
      original_index_sha256: source.plan_index_sha256, historical_manifest_sha256: source.plan_manifest_sha256,
      current_plan_amendments: [], publication_allocation: ALLOCATION, changed_outputs: UNION };
    const consume = () => selectedArtifact(common, handback);
    consume(); cases++;
    const buildsBefore = buildCalls;
    git(root, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'private mechanical descendant');
    git(root, 'merge-base', '--is-ancestor', source.head, 'HEAD');
    const reused = consume();
    assert.equal(buildCalls - buildsBefore, 0);
    assert.equal(reused.binding.source.head, source.head);
    assert.notEqual(source.head, gitText(root, 'rev-parse', 'HEAD'));
    assert.equal(sha(canon(reused.binding.source)), handback.source_identity_sha256); cases++;
    rejects('missing preparation', () => selectedArtifact(path.join(temporary, 'missing-common'), handback));
    for (const changed of [{ status: 'pending' }, { native_receipt: true }, { source_head: 'f'.repeat(40) },
      { source_identity_sha256: sha('foreign') }, { candidate_sha256: sha('foreign') },
      { selection_path: path.join(temporary, 'moved-selection.json') }])
      rejects('handback mismatch', () => selectedArtifact(common, { ...handback, ...changed }));
    rejects('unexpected owner path', () => validateAllocation({ ...ALLOCATION,
      'T-47-11': [...ALLOCATION['T-47-11'], 'host/alternate-module.cjs'] }));
    const originalSelection = read(selectionPath);
    const hiddenSelection = path.join(temporary, 'original-selection.json');
    fs.renameSync(selectionPath, hiddenSelection);
    rejects('missing selection', consume);
    fs.symlinkSync(hiddenSelection, selectionPath); rejects('symlinked selection', consume);
    fs.unlinkSync(selectionPath); fs.renameSync(hiddenSelection, selectionPath);
    const unselected = path.join(durable, 'f'.repeat(64)); fs.mkdirSync(unselected);
    rejects('unselected existing generation', consume); fs.rmdirSync(unselected);
    fs.chmodSync(selectionPath, 0o600);
    fs.writeFileSync(selectionPath, JSON.stringify({ ...selection, candidate_path: './candidate' }));
    fs.chmodSync(selectionPath, 0o400);
    rejects('relative selection', () => consume());
    fs.chmodSync(selectionPath, 0o600); fs.writeFileSync(selectionPath, originalSelection); fs.chmodSync(selectionPath, 0o400);
    const originalBinding = read(bindingPath);
    fs.chmodSync(bindingPath, 0o600); fs.appendFileSync(bindingPath, ' '); fs.chmodSync(bindingPath, 0o400);
    rejects('tampered binding', consume);
    fs.chmodSync(bindingPath, 0o600); fs.writeFileSync(bindingPath, originalBinding); fs.chmodSync(bindingPath, 0o400);
    fs.chmodSync(generationRoot, 0o700);
    const hiddenBinding = path.join(temporary, 'original-binding.json');
    fs.renameSync(bindingPath, hiddenBinding); rejects('missing binding', consume);
    fs.symlinkSync(hiddenBinding, bindingPath); rejects('symlinked binding', consume);
    fs.unlinkSync(bindingPath); fs.renameSync(hiddenBinding, bindingPath); fs.chmodSync(generationRoot, 0o500);
    const executable = path.join(candidate, mirror('codex-decompose-host'));
    assert.equal(physical(executable).mode & 0o777, 0o555);
    fs.chmodSync(executable, 0o444); rejects('lost sealed execute bit', consume); fs.chmodSync(executable, 0o555);
    fs.chmodSync(executable, 0o755); rejects('unsealed executable', consume); fs.chmodSync(executable, 0o555);
    for (const relative of [mirror('claude-runtime-host'), mirror('claude-role-host'), mirror('codex-arch-review-context'), mirror('role-artifact')]) {
      const file = path.join(candidate, relative), original = read(file), directory = path.dirname(file);
      fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'stale private module\n'); fs.chmodSync(file, 0o444);
      rejects('stale installed consumer ' + relative, consume);
      fs.chmodSync(file, 0o644); fs.writeFileSync(file, original); fs.chmodSync(file, 0o444);
      fs.chmodSync(directory, 0o700); fs.unlinkSync(file);
      rejects('missing installed consumer ' + relative, consume);
      fs.symlinkSync(bindingPath, file); rejects('symlink installed consumer', consume); fs.unlinkSync(file);
      fs.writeFileSync(file, original, { mode: 0o444 }); fs.chmodSync(directory, 0o500);
    }
    const canonical = path.join(root, 'plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const originalCanonical = read(canonical); fs.appendFileSync(canonical, 'drift\n');
    rejects('source drift', () => assert.deepEqual(canonicalInputs(root), source.identities));
    fs.writeFileSync(canonical, originalCanonical);
    fs.cpSync(candidate, path.join(root, 'plugins/shipyard'), { recursive: true });
    for (const output of outputs) fs.chmodSync(path.join(root, 'plugins/shipyard', output.path), output.publication_mode);
    const unsealPublication = directory => {
      fs.chmodSync(directory, 0o755);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) unsealPublication(path.join(directory, entry.name));
    };
    unsealPublication(path.join(root, 'plugins/shipyard'));
    git(root, 'add', 'plugins/shipyard');
    for (const group of Object.keys(GROUPS)) validatePublication(root, consume(), group);
    cases++;
    const newCollector = 'plugins/shipyard/' + mirror('codex-arch-review-context');
    git(root, 'update-index', '--force-remove', newCollector);
    validatePublication(root, consume(), 'caller'); cases++;
    git(root, 'update-index', '--chmod=+x', 'plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
    rejects('unreviewed new collector mode', () => validatePublication(root, consume(), 'caller'));
    git(root, 'update-index', '--chmod=-x', 'plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
    git(root, 'add', newCollector);
    fs.chmodSync(path.join(root, 'plugins/shipyard', mirror('codex-decompose-host')), 0o644);
    rejects('lost publication execute bit', () => validatePublication(root, consume(), 'caller'));
    fs.chmodSync(path.join(root, 'plugins/shipyard', mirror('codex-decompose-host')), 0o755);
    git(root, 'update-index', '--chmod=-x', 'plugins/shipyard/' + mirror('codex-decompose-host'));
    rejects('wrong git index mode', () => validatePublication(root, consume(), 'caller'));
    git(root, 'update-index', '--chmod=+x', 'plugins/shipyard/' + mirror('codex-decompose-host'));
    const claude = path.join(root, 'plugins/shipyard', mirror('claude-runtime-host'));
    fs.writeFileSync(claude, 'tampered published Claude\n');
    for (const group of ['relay', 'complete']) rejects('Claude publication mismatch', () => validatePublication(root, consume(), group));
    fs.writeFileSync(claude, read(path.join(candidate, mirror('claude-runtime-host'))));
    fs.unlinkSync(claude);
    for (const group of ['relay', 'complete']) rejects('missing Claude publication', () => validatePublication(root, consume(), group));
    fs.writeFileSync(claude, read(path.join(candidate, mirror('claude-runtime-host'))));
    const unchanged = path.join(root, 'plugins/shipyard/hooks/hooks.json'); fs.appendFileSync(unchanged, 'unexpected\n');
    rejects('unexpected package delta', () => validatePublication(root, consume(), 'candidate'));
    const parents = ['T-47-13', 'T-47-03', 'T-47-04', 'T-47-09', 'T-47-15', 'T-47-14'];
    const state = {}, parentSource = { head: source.head, parent_commits: {}, provenance: {} };
    const live = {};
    for (const [index, id] of parents.entries()) {
      const pr = index + 1, base = 'epic/47', merge = source.head, head = sha(id).slice(0, 40);
      state[id] = { status: 'merged', pr, merge_sha: merge, base, url: 'https://github.com/serhii-nochevnyi/shipyard/pull/' + pr };
      parentSource.parent_commits[id] = { head, merge, base_merge_commits: [merge] };
      parentSource.provenance[id] = { pr, base, url: state[id].url, state_sha256: sha(canon(state[id])) };
      live[pr] = { number: pr, state: 'MERGED', headRefOid: head, mergeCommit: { oid: merge }, baseRefName: base };
    }
    const ancestry = (before, after) => git(root, 'merge-base', '--is-ancestor', before, after);
    validateParents(parentSource, state, number => live[number], ancestry); cases++;
    rejects('nested state rows', () => validateParents(parentSource, { tickets: state }, number => live[number], ancestry));
    for (const edit of [{ number: 999 }, { state: 'OPEN' }, { headRefOid: 'f'.repeat(40) },
      { mergeCommit: { oid: 'f'.repeat(40) } }, { baseRefName: 'main' }])
      rejects('foreign live parent association', () => validateParents(parentSource, state,
        number => ({ ...live[number], ...(number === 1 ? edit : {}) }), ancestry));
    const originalMerge = parentSource.parent_commits['T-47-13'].base_merge_commits;
    parentSource.parent_commits['T-47-13'].base_merge_commits = ['f'.repeat(40)];
    rejects('unmerged base_merge', () => validateParents(parentSource, state, number => live[number], ancestry));
    parentSource.parent_commits['T-47-13'].base_merge_commits = originalMerge;
    assert.equal(buildCalls, 1); consume();
    return { passed: cases, private_build_calls: buildCalls, selected_reuse_build_calls: 0 };
  } finally {
    const writable = directory => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(directory, entry.name));
    };
    writable(temporary); fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { check };

if (require.main === module) {
  try {
    if (process.argv.length === 2) {
      console.log(JSON.stringify({ status: 'passed', fixture_only: true, fixtures: privateFixtures() }));
    } else {
      assert.equal(process.argv.length, 4, 'usage: node phase47-package-publication.test.cjs --group <group>');
      assert.equal(process.argv[2], '--group');
      assert(Object.hasOwn(GROUPS, process.argv[3]), 'unknown publication group');
      const fixtures = privateFixtures();
      console.log(JSON.stringify({ ...check(process.argv[3]), fixtures }));
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', ticket: 'T-47-05', reason: error.message }));
    process.exitCode = 1;
  }
}
