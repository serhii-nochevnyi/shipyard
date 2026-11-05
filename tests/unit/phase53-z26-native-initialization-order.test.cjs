'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const preamble = require('../fixtures/phase53/codex-preamble-helpers.cjs');
const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
const runtime = preamble.runtime;
const source = path.dirname(h.SCRIPTS);
const shipped = path.join(h.ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline');
const cases = [];
const test = (title, run) => cases.push({ title, run });
const keyOf = payload => payload.assignment?.id || 'final';
const serialize = preamble.serialize;
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function environment(cwd, protectedPaths, sandbox = 'read-only', evidence = null) {
  const timezone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { cwd, workspace_roots: [cwd], shell: path.basename(process.env.SHELL || os.userInfo().shell),
    current_date: new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), timezone,
    sandbox_mode: sandbox, approval_policy: 'never', permission_profile: 'shipyard-runtime',
    protected_paths: protectedPaths, evidence_write_path: evidence };
}

function managed(e) {
  const deny = value => '<entry access="deny" escalatable="false"><path>' + escape(value) + '</path></entry>';
  const write = value => '<entry access="write"><path>' + escape(value) + '</path></entry>';
  const writes = e.sandbox_mode === 'workspace-write'
    ? '<entry access="write"><special>:slash_tmp</special></entry>'
      + '<entry access="write"><special>:tmpdir</special></entry>' + write(e.cwd) : '';
  return '<environment_context>\n  <cwd>' + escape(e.cwd) + '</cwd>\n  <shell>' + escape(e.shell)
    + '</shell>\n  <current_date>' + escape(e.current_date) + '</current_date>\n  <timezone>' + escape(e.timezone)
    + '</timezone>\n  <filesystem><workspace_roots>' + e.workspace_roots.map(root => '<root>' + escape(root) + '</root>').join('')
    + '</workspace_roots><permission_profile type="managed"><file_system type="restricted">'
    + e.protected_paths.map(deny).join('') + '<entry access="read"><special>:root</special></entry>'
    + writes + (e.evidence_write_path ? write(e.evidence_write_path) : '')
    + '</file_system></permission_profile></filesystem>\n</environment_context>';
}

function permissionArgs(paths, sandbox, evidence = null) {
  const rules = paths.map(value => JSON.stringify(value) + '="deny"');
  if (evidence) rules.push(JSON.stringify(evidence) + '="write"');
  return ['--config', 'default_permissions="shipyard-runtime"', '--config',
    'permissions.shipyard-runtime.extends=' + JSON.stringify(sandbox === 'read-only' ? ':read-only' : ':workspace'),
    '--config', 'permissions.shipyard-runtime.filesystem={' + rules.join(',') + '}'];
}

function assertArgs(args, paths, sandbox, evidence = null) {
  const expected = permissionArgs(paths, sandbox, evidence);
  const start = args.indexOf('default_permissions="shipyard-runtime"') - 1;
  assert.ok(start >= 0);
  assert.deepEqual(args.slice(start, start + expected.length), expected);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args.includes('--sandbox'), false);
}

function dataFixture(paths = ['/fixture/A', '/fixture/parent', '/fixture/parent/child', '/fixture/z']) {
  const { rows, options } = preamble.orderedFixture();
  const { sha256, ...pin } = options.initialContext;
  pin.environment.protected_paths = [...paths];
  options.initialContext = { ...pin, sha256: h.hash(h.stable(pin)) };
  rows[3].payload.content[1].text = managed(pin.environment);
  return { rows, options };
}

function extract(api, rows, options) {
  const ordered = api.extractSemanticInitialInput(rows, options);
  assert.deepEqual(api.verifySemanticReads(serialize(rows), options).incomplete, []);
  return ordered;
}

test('public permission producer independently orders physical aliases missing targets and UTF8 names', () => {
  const root = fs.realpathSync(process.env.HOME);
  const parent = h.physical(root, path.join(root, 'parent'));
  fs.mkdirSync(parent); fs.mkdirSync(h.physical(root, path.join(parent, 'child')));
  const alias = h.physical(root, path.join(root, 'alias')); fs.symlinkSync(parent, alias);
  const names = ['"&<>', 'A', 'a', 'e\u0301', 'missing', 'parent', 'parent/child', 'z', '\u00e9', '\ue000', '\u{10000}'];
  const expected = names.map(name => path.join(root, name));
  assert.notDeepEqual([...expected].sort(), expected, 'non-BMP UTF16 ordering disagrees with the UTF8 oracle');
  assert.notEqual(expected[3], expected[8], 'Unicode spellings remain distinct');
  const entries = [...expected].reverse().concat(alias, path.join(alias, 'child'), expected[0], '', null);
  for (const sandbox of ['read-only', 'workspace-write']) {
    const evidence = path.join(root, 'evidence');
    const oracle = permissionArgs(expected, sandbox, evidence);
    for (const input of [entries, [...entries].reverse(), [...entries.slice(4), ...entries.slice(0, 4)]])
      assert.deepEqual(runtime.signerPermissionProfileArgs(input, sandbox, evidence), oracle);
    assert.deepEqual(runtime.signerPermissionProfileArgs([path.join(alias, 'absent')], sandbox),
      permissionArgs([path.join(alias, 'absent')], sandbox), 'missing target retains lexical fallback');
  }
  const fixture = dataFixture(expected);
  extract(runtime, fixture.rows, fixture.options);
  assert.ok(fixture.rows[3].payload.content[1].text.includes('&quot;&amp;&lt;&gt;'));
});

test('actual launcher captures both unchanged baselines and excludes protected evidence writes before hashing', async () => {
  const root = fs.realpathSync(process.env.HOME), cwd = h.physical(root, path.join(root, 'worktree'));
  fs.mkdirSync(cwd); fs.mkdirSync(h.physical(root, path.join(root, '.codex')));
  const archive = path.join(root, '.local/state/shipyard/role-artifact-authority');
  const evidence = path.join(cwd, '.shipyard-drift-evidence.md');
  const content = "developer_instructions = '''\nRead complete original material.\n'''\n";
  const cli = registered('codex-agent-stream', 'codex-agent-stream-exec.jsonl');
  for (const sandbox of ['read-only', 'workspace-write']) for (const protection of ['none', 'exact', 'parent']) {
    const extra = protection === 'exact' ? [evidence] : protection === 'parent' ? [cwd] : [];
    const expectedPaths = [path.join(root, '.gnupg'), archive, path.join(root, '.ssh'), ...extra];
    const evidenceWrite = sandbox === 'read-only' && protection === 'none' ? evidence : null;
    let captured, actualArgs, actualEnv, input;
    const launch = runtime.createCodexCliLauncher({ scope: { run_id: 'z26-policy', ticket: 'T-53-26', phase: 53,
      worktree: cwd }, capabilities: { supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['high'] },
    env: { CODEX_HOME: path.join(root, '.codex') }, additionalProtectedPaths: [...extra, ...extra],
    spawn(_file, args, options) {
      actualArgs = args; actualEnv = options.env;
      const child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { write(text) { input = text; }, end() { process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(serialize([template(cli, row => row.type === 'thread.started')])));
        child.emit('close', 1, null);
      }); } };
      return child;
    } });
    await assert.rejects(launch('<AUTHENTICATED_SEMANTIC_REVIEW>policy capture only</AUTHENTICATED_SEMANTIC_REVIEW>', {
      model: 'gpt-6.1-sol', effort: 'high', sandbox_mode: sandbox, dispatch_id: 'z26-' + sandbox + '-' + protection,
      agent_file: 'shipyard-drift-check.toml', agent_file_content: content, agent_file_digest: h.hash(content),
      onSessionStarted(value) { captured = value.runtime_launch; },
    }), error => error.code === 'RUNTIME_UNAVAILABLE');
    assert.ok(captured, 'registered session start exposes the actual private launch before deliberate exit1');
    assertArgs(actualArgs, expectedPaths, sandbox, evidenceWrite);
    const e = environment(cwd, expectedPaths, sandbox, evidenceWrite);
    assert.deepEqual(captured.initial_context.environment, e);
    assert.equal(captured.initial_context.binding.input_sha256, h.hash(input));
    assert.equal(captured.command_digest, h.hash(JSON.stringify(actualArgs)));
    assert.equal(captured.initial_context.binding.command_digest, captured.command_digest);
    const { sha256, ...pin } = captured.initial_context;
    assert.equal(sha256, h.hash(h.stable(pin)));
    assert.deepEqual(captured.sandbox_evidence, { profile: 'shipyard-runtime',
      base_profile: sandbox === 'read-only' ? ':read-only' : ':workspace', protected_paths: expectedPaths,
      ...(evidenceWrite ? { evidence_write_path: evidenceWrite } : {}) });
    const fixture = dataFixture(expectedPaths);
    const { sha256: ignored, ...body } = fixture.options.initialContext;
    body.environment = e; body.binding.worktree = cwd;
    fixture.options.initialContext = { ...body, sha256: h.hash(h.stable(body)) };
    fixture.rows[0].payload.cwd = cwd; fixture.rows[0].payload.runtime_workspace_roots = [cwd];
    fixture.rows[1].payload.cwd = cwd; fixture.rows[1].payload.sandbox_policy.type = sandbox;
    fixture.rows[3].payload.content[1].text = managed(e);
    extract(runtime, fixture.rows, fixture.options);
    assert.equal(actualEnv.GNUPGHOME, undefined); assert.equal(actualEnv.SSH_AUTH_SOCK, undefined);
  }
});

test('data-only exact managed frames and legacy insertion order retain strict one-fact refusals without authority', () => {
  const apis = [runtime, require(path.join(shipped, 'scripts/codex-runtime-host.cjs'))];
  const valid = dataFixture();
  for (const api of apis) extract(api, valid.rows, valid.options);
  const deny = '<entry access="deny" escalatable="false"><path>/fixture/A</path></entry>';
  const extra = '<entry access="deny" escalatable="false"><path>/foreign</path></entry>';
  const mutations = {
    ...preamble.mutations,
    'missing deny': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace(deny, ''); },
    'extra deny': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace(deny, deny + extra); },
    'duplicate deny': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace(deny, deny + deny); },
    'deny read': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace('access="deny"', 'access="read"'); },
    'deny write': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace('access="deny"', 'access="write"'); },
    'wider write': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace('</file_system>', '<entry access="write"><path>/</path></entry></file_system>'); },
    'malformed XML': rows => { rows[3].payload.content[1].text += '</environment_context>'; },
    'wrong kinds': rows => { rows[3].payload.internal_chat_message_metadata_passthrough.content_item_kinds.reverse(); },
    'wrong block type': rows => { rows[3].payload.content[0].type = 'output_text'; },
    'missing header': rows => { rows[3].payload.content[0].text = rows[3].payload.content[0].text.replace('# AGENTS.md instructions\n\n', ''); },
    'same-set arbitrary reorder': rows => { rows[3].payload.content[1].text = managed({ ...valid.options.initialContext.environment,
      protected_paths: [...valid.options.initialContext.environment.protected_paths].reverse() }); },
  };
  for (const [label, change] of Object.entries(mutations)) {
    const { rows, options } = h.clone(valid); change(rows);
    for (const api of apis) {
      assert.throws(() => api.extractSemanticInitialInput(rows, options), undefined, label);
      assert.throws(() => api.verifySemanticReads(serialize(rows), options), undefined, label);
    }
  }
  for (const change of [options => { delete options.initialContext; },
    options => { options.initialContext.instructions += 'changed'; },
    options => { options.initialContext.sources[0].text += 'changed'; },
    options => { options.initialContext.sources.reverse(); },
    options => { options.initialContext.sha256 = '0'.repeat(64); },
    options => { options.sessionId = 'foreign'; }, options => { options.input += 'changed'; }]) {
    const { rows, options } = h.clone(valid); change(options);
    for (const api of apis) assert.throws(() => extract(api, rows, options));
  }
  const legacy = dataFixture(['/fixture/z', '/fixture/A', '/fixture/parent/child', '/fixture/parent']);
  const before = serialize(legacy.rows), pinBefore = JSON.stringify(legacy.options);
  for (const api of apis) extract(api, legacy.rows, legacy.options);
  assert.equal(serialize(legacy.rows), before); assert.equal(JSON.stringify(legacy.options), pinBefore);
  const reordered = h.clone(legacy.rows);
  reordered[3].payload.content[1].text = managed(valid.options.initialContext.environment);
  for (const api of apis) assert.throws(() => extract(api, reordered, legacy.options));
  assert.equal(serialize(legacy.rows), before); assert.equal(JSON.stringify(legacy.options), pinBefore);
});

function coldCustodyRefusal(f, plugin, original) {
  const child = spawnSync(process.execPath, ['-e', `
    require('node:os').homedir = () => process.argv[2];
    const api = require(process.argv[1]);
    let refused = false;
    try { api.readSemanticOriginal(JSON.parse(process.argv[3])); }
    catch (error) { if (!error.code) throw error; refused = true; }
    require('node:assert/strict').equal(refused, true);
    require('node:assert/strict').equal(api.currentCodeReviewVerdict(JSON.parse(process.argv[4])), null);
  `, path.join(plugin, 'scripts/role-artifact.cjs'), os.homedir(), JSON.stringify({ worktreePath: f.worktree,
    snapshot_sha256: original.result.snapshot_sha256, assignment_id: original.reference.assignment_id }),
  JSON.stringify(h.inputFor(f))],
  { env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, child.stderr);
}

function snapshotRegression() {
  const home = fs.realpathSync(process.env.HOME);
  const directory = h.physical(home, path.join(home, 'snapshot-regression')); fs.mkdirSync(directory);
  const root = h.physical(directory, path.join(directory, 'source')); fs.mkdirSync(root);
  const filename = path.join(root, 'tests/unit/phase53-z24-historical-producer-reference.test.cjs');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const prefix = fs.readFileSync(path.join(h.ROOT, 'tests/unit', path.basename(filename)), 'utf8');
  const boundary = prefix.indexOf('\nif (isMainThread) {'); assert.ok(boundary > 0);
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalLoad = Module._load;
  try {
    Module._load = function(request, ...args) {
      if (request === 'node:test') return new Proxy({}, { get() { return () => assert.fail('old registration or hook'); } });
      return originalLoad.call(this, request, ...args);
    };
    loaded._compile(prefix.slice(0, boundary)
      + '\nmodule.exports = { cleanEnv, absentHistory, fixtureIdentity, squashCandidate };', filename);
  } finally { Module._load = originalLoad; }
  const setup = loaded.exports;
  const setupHome = h.physical(directory, path.join(directory, 'home'));
  const temporary = h.physical(directory, path.join(directory, 'tmp'));
  fs.mkdirSync(setupHome); fs.mkdirSync(temporary);
  const env = setup.cleanEnv(setupHome, temporary);
  const git = (cwd, ...args) => {
    const child = spawnSync('git', args, { cwd, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr.toString());
    return child.stdout;
  };
  const write = (relative, bytes, mode = 0o644) => {
    const file = h.physical(root, path.join(root, relative));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); fs.chmodSync(file, mode);
  };
  const expected = new Map();
  const keep = (relative, bytes, mode = 0o644) => {
    const value = Buffer.from(bytes); write(relative, value, mode);
    expected.set(relative, { bytes: value, mode });
  };
  const fixtures = 'tests/fixtures/phase53/historical-semantic-producer';
  for (const name of ['manifest.json', 'role-artifact.cjs.gz.b64', 'codex-delivery-host.cjs.gz.b64',
    'claude-role-host.cjs.gz.b64']) keep(fixtures + '/' + name, fs.readFileSync(path.join(h.ROOT, fixtures, name)));
  keep('.gitignore', '/ignored/\n');
  keep('tracked/edit', 'seed edit\n'); keep('tracked/delete', 'seed deletion\n');
  keep('tracked/rename-old', 'rename bytes\0\xff\n'); keep('tracked/executable', 'seed executable\n');
  const rawTracked = 'tracked/  leading\nembedded\ttab trailing  ';
  const rawNew = '  new\nembedded\ttab trailing  ';
  const renamed = 'tracked/  renamed\nembedded\ttab trailing  ';
  keep(rawTracked, 'seed raw path\n'); keep('shape-file', 'seed file\n'); keep('shape-dir/child', 'seed child\n');
  const links = new Map([['unchanged-link', 'tracked/edit'], ['unchanged-dangling-link', 'absent-target']]);
  for (const [relative, text] of links) fs.symlinkSync(text, h.physical(root, path.join(root, relative)));
  git(root, 'init', '--initial-branch=main', '--template='); git(root, 'add', '--all');
  const commit = message => git(root, '-c', 'user.name=Snapshot fixture', '-c', 'user.email=snapshot@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--no-gpg-sign', '-m', message);
  commit('Seed isolated source'); keep('second-seed', 'second seed\n'); git(root, 'add', '--all');
  commit('Second isolated seed');
  keep('tracked/edit', Buffer.from([0, 255, 13, 10, 65]));
  fs.unlinkSync(path.join(root, 'tracked/delete')); expected.delete('tracked/delete');
  git(root, 'mv', '--', 'tracked/rename-old', renamed);
  expected.set(renamed, expected.get('tracked/rename-old')); expected.delete('tracked/rename-old');
  keep('tracked/executable', '#!/bin/sh\nprintf executable\n', 0o755);
  keep(rawTracked, 'changed raw path\0\n'); keep(rawNew, Buffer.from([255, 0, 10, 9, 32]), 0o755);
  fs.unlinkSync(path.join(root, 'shape-file')); expected.delete('shape-file');
  keep('shape-file/child', 'file became directory\n');
  fs.unlinkSync(path.join(root, 'shape-dir/child')); fs.rmdirSync(path.join(root, 'shape-dir'));
  expected.delete('shape-dir/child'); keep('shape-dir', 'directory became file\n');
  write('ignored/role-artifact-authority/synthetic-marker', 'synthetic private bytes only\n', 0o600);
  const inventory = (directory, prefix = '', omitGit = false) => fs.readdirSync(path.join(directory, prefix))
    .sort().flatMap(name => {
      if (omitGit && !prefix && name === '.git') return [];
      const relative = prefix + name, file = path.join(directory, relative), stat = fs.lstatSync(file);
      const row = { path: relative, mode: stat.mode & 0o777 };
      if (stat.isSymbolicLink()) return [{ ...row, link: fs.readlinkSync(file) }];
      if (stat.isDirectory()) return [{ ...row, directory: true }, ...inventory(directory, relative + '/', omitGit)];
      assert.equal(stat.isFile(), true); return [{ ...row, bytes: fs.readFileSync(file) }];
    });
  const before = inventory(root), indexBefore = fs.readFileSync(path.join(root, '.git/index'));
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const output = h.physical(directory, path.join(directory, 'output')); fs.mkdirSync(output);
  try {
    const checkout = setup.squashCandidate(output, env);
    setup.absentHistory(checkout, env); setup.fixtureIdentity(checkout);
    assert.equal(git(checkout, 'rev-list', '--all', '--count').toString().trim(), '1');
    assert.match(git(checkout, 'rev-list', '--parents', 'HEAD').toString().trim(), /^[a-f0-9]{40}$/);
    assert.equal(git(checkout, 'branch', '--show-current').toString().trim(), 'main');
    assert.equal(git(checkout, 'remote').length, 0); assert.equal(git(checkout, 'tag').length, 0);
    assert.equal(git(checkout, 'for-each-ref', '--format=%(refname)').toString(), 'refs/heads/main\n');
    assert.equal(fs.lstatSync(path.join(checkout, '.git')).isDirectory(), true);
    for (const relative of ['.git/commondir', '.git/objects/info/alternates', '.git/objects/info/http-alternates',
      '.git/shallow', 'tracked/delete', 'tracked/rename-old', 'shape-dir/child', 'ignored'])
      assert.throws(() => fs.lstatSync(path.join(checkout, relative)), error => ['ENOENT', 'ENOTDIR'].includes(error.code));
    const missing = spawnSync('git', ['cat-file', '-e', headBefore.toString().trim() + '^{commit}'],
      { cwd: checkout, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(missing.error, undefined); assert.notEqual(missing.status, 0);
    const tree = git(checkout, 'ls-tree', '-rz', '--full-tree', 'HEAD').toString().split('\0');
    assert.equal(tree.pop(), '');
    const entries = new Map(tree.map(entry => {
      const tab = entry.indexOf('\t'); return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')];
    }));
    assert.deepEqual([...entries.keys()].sort(), [...expected.keys(), ...links.keys()].sort());
    for (const [relative, { bytes, mode }] of expected) {
      const file = path.join(checkout, relative), stat = fs.lstatSync(file);
      assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
      assert.deepEqual(fs.readFileSync(file), bytes, relative); assert.equal(stat.mode & 0o777, mode, relative);
      assert.deepEqual(entries.get(relative).slice(0, 2), [mode === 0o755 ? '100755' : '100644', 'blob']);
      assert.deepEqual(git(checkout, 'show', 'HEAD:' + relative), bytes, relative);
    }
    for (const [relative, text] of links) {
      const file = path.join(checkout, relative);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), true); assert.equal(fs.readlinkSync(file), text);
      assert.deepEqual(entries.get(relative).slice(0, 2), ['120000', 'blob']);
      assert.deepEqual(git(checkout, 'show', 'HEAD:' + relative), Buffer.from(text));
    }
    const actual = inventory(checkout, '', true);
    assert.deepEqual(actual.filter(row => !row.directory).map(row => row.path).sort(), [...entries.keys()].sort());
    const expectedDirectories = new Set();
    for (const relative of entries.keys()) for (let parent = path.dirname(relative); parent !== '.'; parent = path.dirname(parent))
      expectedDirectories.add(parent);
    assert.deepEqual(actual.filter(row => row.directory).map(row => row.path).sort(), [...expectedDirectories].sort());
  } finally {
    assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), indexBefore);
    assert.deepEqual(git(root, 'rev-parse', 'HEAD'), headBefore);
    assert.deepEqual(inventory(root), before, 'snapshot must preserve every source byte, mode, link and Git entry');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('one recorded public code-review flow binds canonical originals final package and cold custody refusals', async () => {
  snapshotRegression();
  let f, expectedPaths, expectedEnvironment;
  const rawRows = new Map(), workers = new Set();
  await h.publicRole('code-review', 'codex', {
    configureFixture(value) {
      f = value;
      process.env.GNUPGHOME = h.physical(f.root, path.join(f.root, 'z-signer'));
      process.env.SSH_AUTH_SOCK = h.physical(f.root, path.join(f.root, 'a-socket'));
      const authority = path.join(f.root, '.local/state/shipyard/role-artifact-authority');
      expectedPaths = [path.join(f.root, '.gnupg'), authority, path.join(authority, h.hash(f.worktree)),
        path.join(f.root, '.ssh'), process.env.SSH_AUTH_SOCK,
        path.join(f.root, 'public-codex-v3-' + (f.count + 1), 'finalization', h.hash(f.worktree)),
        path.join(f.worktree, '.shipyard-code-review-evidence.md'), process.env.GNUPGHOME];
      expectedEnvironment = environment(f.worktree, expectedPaths);
    },
    onLaunch(launch) {
      assertArgs(launch.runtime_args, expectedPaths, 'read-only');
      if (launch.payload.stage === 'worker') workers.add(launch.payload.assignment.id);
      if (launch.payload.stage === 'final') assert.equal(launch.payload.originals.length, 2);
    },
    native(rows, payload) {
      assert.equal(workers.size, 2, 'both real worker launches precede either native completion');
      const initial = rows.find(row => row.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds
        ?.includes('agents_md.instructions'));
      assert.ok(initial);
      assert.equal(initial.payload.content[0].text, '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n'
        + 'Fixture global guidance.\n\nFixture project guidance.\n</INSTRUCTIONS>');
      initial.payload.content[1].text = managed(expectedEnvironment);
      const parent = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
      const world = template(parent, row => row.type === 'world_state');
      const context = h.clone(rows.find(row => row.type === 'turn_context'));
      const settings = template(parent, row => row.type === 'event_msg');
      settings.payload = { type: 'thread_settings_applied' };
      rows.splice(rows.indexOf(initial) + 1, 0, world, context, settings);
      rawRows.set(keyOf(payload), h.clone(rows));
    },
    inspect({ api, plugin, prepared, originals, snapshots, completed, nativeViews }) {
      assert.equal(prepared.launches.length, 3); assert.equal(originals.length, 2); assert.equal(nativeViews.size, 3);
      assert.equal(prepared.launches.at(-1).payload.stage, 'final');
      assert.equal(new Set(prepared.launches.map(launch => launch.session)).size, 3);
      assert.equal(completed.result.role, 'code-review');
      assert.deepEqual(originals.map(original => original.native.resource_failure), [null, null]);
      const records = fs.readdirSync(prepared.recorder.storeDir).filter(name => /^record-.*\.json$/.test(name))
        .map(name => { const file = h.physical(f.root, path.join(prepared.recorder.storeDir, name));
          return { file, envelope: JSON.parse(fs.readFileSync(file)), bytes: fs.readFileSync(file) }; });
      for (const launch of prepared.launches) {
        const record = records.find(item => item.envelope.payload.receipt?.runtime_evidence?.session_id === launch.session);
        assert.ok(record);
        const trusted = prepared.recorder.getVerifiedRecord(record.envelope.payload.dispatch_id);
        const evidence = trusted.receipt.runtime_evidence, pin = evidence.initial_context.launch;
        assert.deepEqual(pin.environment, expectedEnvironment);
        assert.deepEqual(evidence.sandbox_evidence.protected_paths, expectedPaths);
        assert.deepEqual(evidence.command.args, launch.runtime_args);
        assert.equal(evidence.command_digest, h.hash(JSON.stringify(launch.runtime_args)));
        assert.equal(pin.binding.command_digest, evidence.command_digest);
        assert.equal(pin.binding.input_sha256, h.hash(launch.input));
        assert.equal(pin.binding.dispatch_id, trusted.dispatch_id);
        assert.equal(pin.binding.run_id, evidence.run_id);
        assert.equal(pin.binding.ticket, launch.payload.subject);
        assert.equal(pin.binding.worktree, f.worktree); assert.equal(pin.binding.phase, 49);
        const { sha256, ...body } = pin;
        assert.equal(sha256, h.hash(h.stable(body)));
        assert.deepEqual(pin.sources, [
          { path: path.join(process.env.CODEX_HOME, 'AGENTS.md'), text: 'Fixture global guidance.\n' },
          { path: path.join(f.worktree, 'AGENTS.md'), text: 'Fixture project guidance.\n' },
        ].map(item => ({ ...item, bytes: Buffer.byteLength(item.text), sha256: h.hash(item.text) })));
        assert.deepEqual(pin.selection, { model: snapshots.get(launch.payload.snapshot_sha256).model,
          effort: snapshots.get(launch.payload.snapshot_sha256).effort });
        const raw = fs.readFileSync(h.physical(f.root, launch.nativePath), 'utf8');
        const rows = raw.trim().split('\n').map(JSON.parse);
        assert.deepEqual(rows, rawRows.get(keyOf(launch.payload)));
        const options = { input: launch.input, initialContext: pin, sessionId: launch.session };
        const ordered = extract(runtime, rows, options);
        assert.equal(rows[ordered.initial_index].payload.content[1].text, managed(expectedEnvironment));
        assert.equal(evidence.initial_context.native_sha256, h.hash(raw));
        assert.equal(evidence.initial_context.turn_id, ordered.turn_id);
        assert.equal(evidence.initial_context.preamble_sha256, h.hash(h.stable(rows[ordered.initial_index].payload.content)));
      }
      const shippedBefore = h.inventory(path.join(h.ROOT, 'plugins/shipyard'));
      const candidate = require('../../scripts/package-shipyard-codex.cjs').build(h.physical(f.root, path.join(f.root, 'staged')));
      const identity = h.packageParity(candidate);
      for (const row of h.inventory(candidate).filter(row => !row.directory))
        assert.deepEqual(fs.readFileSync(path.join(candidate, row.path)),
          fs.readFileSync(path.join(h.ROOT, 'plugins/shipyard', row.path)), row.path);
      assert.deepEqual(h.inventory(path.join(h.ROOT, 'plugins/shipyard')), shippedBefore);
      const staged = path.join(candidate, 'host/plugins/delivery-pipeline');
      const canonicalRuntime = path.join(source, 'scripts/codex-runtime-host.cjs');
      for (const owner of [shipped, staged]) {
        const file = path.join(owner, 'scripts/codex-runtime-host.cjs');
        assert.equal(fs.lstatSync(file).isFile(), true); assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
        assert.deepEqual(fs.readFileSync(file), fs.readFileSync(canonicalRuntime));
        assert.equal(fs.statSync(file).mode & 0o777, fs.statSync(canonicalRuntime).mode & 0o777);
      }
      const stagedRuntime = require(path.join(staged, 'scripts/codex-runtime-host.cjs'));
      assert.notEqual(stagedRuntime, runtime);
      assert.deepEqual(stagedRuntime.signerPermissionProfileArgs([...expectedPaths].reverse(), 'read-only'),
        permissionArgs(expectedPaths, 'read-only'));
      const valid = dataFixture();
      assert.deepEqual(extract(stagedRuntime, valid.rows, valid.options), extract(runtime, valid.rows, valid.options));
      const stagedCold = spawnSync(process.execPath, ['-e', `
        const api = require(process.argv[1]), fixture = JSON.parse(process.argv[2]), paths = JSON.parse(process.argv[3]);
        process.stdout.write(JSON.stringify({ args: api.signerPermissionProfileArgs([...paths].reverse(), 'read-only'),
          ordered: api.extractSemanticInitialInput(fixture.rows, fixture.options),
          reads: api.verifySemanticReads(fixture.rows.map(row => JSON.stringify(row)).join('\\n') + '\\n', fixture.options) }));
      `, path.join(staged, 'scripts/codex-runtime-host.cjs'), JSON.stringify(valid), JSON.stringify(expectedPaths)],
      { env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(stagedCold.error, undefined, stagedCold.error?.message); assert.equal(stagedCold.status, 0, stagedCold.stderr);
      assert.deepEqual(JSON.parse(stagedCold.stdout), { args: permissionArgs(expectedPaths, 'read-only'),
        ordered: runtime.extractSemanticInitialInput(valid.rows, valid.options),
        reads: runtime.verifySemanticReads(serialize(valid.rows), valid.options) });
      valid.rows[3].payload.content[1].text += 'changed';
      assert.throws(() => extract(stagedRuntime, valid.rows, valid.options));
      const consumers = [source, shipped, staged];
      const current = api.currentCodeReviewVerdict(h.inputFor(f));
      for (const owner of consumers) {
        assert.deepEqual(h.cold(f, 'code-review', owner), current);
        assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
      }
      const archive = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
      const authority = h.inventory(api.archiveAuthorityDirectory(f.worktree));
      const worker = originals[0];
      const workerRecord = records.find(item => item.envelope.payload.dispatch_id === worker.reference.dispatch_id);
      assert.ok(workerRecord);
      const originalEnvelope = fs.readdirSync(api.archiveAuthorityDirectory(f.worktree))
        .filter(name => /^integration-semantic-original-.*\.json$/.test(name))
        .map(name => h.physical(f.root, path.join(api.archiveAuthorityDirectory(f.worktree), name)))
        .find(file => JSON.parse(fs.readFileSync(file)).payload.reference.dispatch_id === worker.reference.dispatch_id);
      assert.ok(originalEnvelope);
      const originalBytes = fs.readFileSync(originalEnvelope), originalMode = fs.statSync(originalEnvelope).mode & 0o777;
      const nativeFile = h.physical(f.root, worker.native.native_pin.path), nativeBytes = fs.readFileSync(nativeFile);
      const nativeMode = fs.statSync(nativeFile).mode & 0o777;
      const finalFile = h.physical(f.root, prepared.launches.at(-1).nativePath), finalBytes = fs.readFileSync(finalFile);
      const changes = [
        { label: 'worker native bytes', file: nativeFile, bytes: nativeBytes,
          value: Buffer.concat([nativeBytes, Buffer.from('\n')]), cold: true },
        { label: 'missing worker native', file: nativeFile, bytes: nativeBytes, value: null, mode: nativeMode },
        { label: 'missing private original pin', file: originalEnvelope, bytes: originalBytes,
          value: null, mode: originalMode, cold: true },
        { label: 'changed private original pin', file: originalEnvelope, bytes: originalBytes,
          value: Buffer.concat([originalBytes, Buffer.from('changed')]), mode: originalMode, cold: true },
        { label: 'original record seal', file: workerRecord.file, bytes: workerRecord.bytes,
          value: Buffer.from(JSON.stringify({ ...workerRecord.envelope,
            integrity: { ...workerRecord.envelope.integrity, mac: '0'.repeat(64) } })), cold: true },
      ];
      for (const kind of ['missing', 'order', 'command', 'source', 'session', 'turn']) {
        const envelope = h.clone(workerRecord.envelope), evidence = envelope.payload.receipt.runtime_evidence;
        if (kind === 'missing') delete evidence.initial_context;
        if (kind === 'order') evidence.initial_context.launch.environment.protected_paths.reverse();
        if (kind === 'command') evidence.initial_context.launch.binding.command_digest = '0'.repeat(64);
        if (kind === 'source') evidence.initial_context.launch.sources[0].text += 'changed';
        if (kind === 'session') evidence.initial_context.session_id = 'foreign';
        if (kind === 'turn') evidence.initial_context.turn_id = 'foreign';
        changes.push({ label: 'original private ' + kind, file: workerRecord.file, bytes: workerRecord.bytes,
          value: Buffer.from(JSON.stringify(envelope)), cold: ['missing', 'order'].includes(kind) });
      }
      for (const change of changes) {
        try {
          if (change.value === null) fs.unlinkSync(change.file); else fs.writeFileSync(change.file, change.value);
          assert.throws(() => api.readSemanticOriginal({ worktreePath: f.worktree,
            snapshot_sha256: worker.result.snapshot_sha256, assignment_id: worker.reference.assignment_id }), undefined, change.label);
          assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null, change.label);
          if (change.cold) for (const owner of consumers) coldCustodyRefusal(f, owner, worker);
        } finally { fs.writeFileSync(change.file, change.bytes, { mode: change.mode ?? 0o644 }); }
        assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current);
      }
      const finalRows = finalBytes.toString().trim().split('\n').map(JSON.parse);
      finalRows.find(row => row.type === 'turn_context').payload.model = 'foreign';
      try {
        fs.writeFileSync(finalFile, serialize(finalRows));
        for (const owner of consumers) assert.equal(h.cold(f, 'code-review', owner), null);
      } finally { fs.writeFileSync(finalFile, finalBytes); }
      for (const owner of consumers) {
        assert.deepEqual(h.cold(f, 'code-review', owner), current);
        assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
      }
      assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), archive);
      assert.deepEqual(h.inventory(api.archiveAuthorityDirectory(f.worktree)), authority);
      for (const record of records) assert.deepEqual(fs.readFileSync(record.file), record.bytes);
      assert.deepEqual(fs.readFileSync(nativeFile), nativeBytes); assert.deepEqual(fs.readFileSync(finalFile), finalBytes);
      assert.deepEqual(h.inventory(path.join(h.ROOT, 'plugins/shipyard')), shippedBefore);
      process.stdout.write(JSON.stringify({ package: identity, recorded_workers: 2, independent_final: 1,
        installed_native_acceptance: false, arbitrary_unicode_native_formatter: 'unobserved',
        R8: 'INCOMPLETE', semantic_credit: 0 }) + '\n');
    },
  });
});

test('physical inventory preserves all frozen prefixes appends row48 and selects future actual denominators', () => {
  const s = require('./shard-files.cjs'), manifest = s.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'],
    ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const first44 = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], ['phase53-z22-semantic-incomplete-projection.test.cjs']];
  const first46 = [...first44, ['phase53-z23-verification-owner-heartbeat.test.cjs'],
    ['phase53-z24-historical-producer-reference.test.cjs']];
  const first47 = [...first46, ['phase53-z25-historical-fixture-text-transport.test.cjs']];
  const files = s.unitFiles(), tasks = s.unitTasks(files), actual = s.appendShard(manifest, tasks);
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))),
    '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  for (const prefix of [first39, first40, first44, first46, first47])
    assert.deepEqual(actual.shards.slice(0, prefix.length), prefix);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 47))), '7192ef371bdfa032b5a1d1b270986d9ed6733a6ff95274d2b046778c9362c3d8');
  const missing = tasks.filter(task => !first47.flat().includes(task)).sort();
  assert.deepEqual(actual.shards, [...first47, ...missing.map(task => [task])]);
  assert.deepEqual(actual.shards[47], [path.basename(__filename)]);
  for (let index = 0; index < actual.shards.length; index++)
    assert.deepEqual(s.selectTaskShard(`${index + 1}/${actual.shards.length}`), actual.shards[index]);
  const workflow = fs.readFileSync(path.join(h.ROOT, '.github/workflows/test.yml'), 'utf8');
  for (const job of ['shards', 'rest', 'test-fast']) assert.match(workflow, new RegExp('^  ' + job + ':$', 'm'));
  assert.match(workflow, /name: unit \(shard \$\{\{ matrix.shard \}\}\)/);
  const checks = ['shards', ...actual.shards.map((_, index) => `unit (shard ${index + 1}/${actual.shards.length})`),
    'gates and smoke', 'test-fast'];
  assert.equal(new Set(checks).size, actual.shards.length + 3);
  const generation = s.appendShard(manifest, tasks.filter(task => first47.flat().includes(task) || task === path.basename(__filename)));
  assert.equal(generation.shards.length, 48); assert.equal(generation.shards.length + 3, 51);
  const directory = h.physical(process.env.HOME, path.join(process.env.HOME, 'inventory')); fs.mkdirSync(directory);
  for (const file of files) fs.writeFileSync(h.physical(directory, path.join(directory, file)), '');
  const future = 'zz-future-initialization.test.cjs'; fs.writeFileSync(h.physical(directory, path.join(directory, future)), '');
  const next = s.appendShard(actual, s.unitTasks(s.unitFiles(directory)));
  assert.deepEqual(next.shards.slice(0, actual.shards.length), actual.shards);
  assert.equal(next.shards.length, actual.shards.length + 1); assert.deepEqual(next.shards.at(-1), [future]);
  for (let index = 0; index < next.shards.length; index++)
    assert.deepEqual(s.selectTaskShard(`${index + 1}/${next.shards.length}`, directory, actual), next.shards[index]);
});

if (isMainThread) describe('phase 53 canonical native initialization order', { concurrency: 2 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, { timeout: 180000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-z26-')));
    const temporary = h.physical(home, path.join(home, 'tmp')); fs.mkdirSync(temporary);
    let worker;
    t.after(async () => { await worker?.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull,
      GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' });
    await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: index, env });
      let completed = false, failure;
      worker.once('message', message => { completed = message?.completed === true; });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => failure ? reject(failure) : code || !completed
        ? reject(Error(entry.title + ' exited without assertions: ' + code)) : resolve());
    });
  });
});
else {
  os.homedir = () => fs.realpathSync(process.env.HOME);
  Promise.resolve().then(() => cases[workerData].run()).then(() => parentPort.postMessage({ completed: true }))
    .catch(error => setImmediate(() => { throw error; }));
}
