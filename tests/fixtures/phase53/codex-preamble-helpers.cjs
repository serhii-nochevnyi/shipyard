'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const scripts = path.join(root, 'plugins/delivery-pipeline/scripts');
const runtime = require(path.join(scripts, 'codex-runtime-host.cjs'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = require(path.join(scripts, 'model-policy-internal.cjs')).stableStringify;
const serialize = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const user = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

function fixtureHelpers() {
  const filename = path.join(root, 'tests/unit/phase53-codex-integration.test.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = Module._load;
  try {
    Module._load = function(name, ...args) { return name === 'node:test' ? { test() {} } : original.call(this, name, ...args); };
    const source = fs.readFileSync(filename, 'utf8'), boundary = "test('ordinary Codex caller";
    assert.ok(source.includes(boundary));
    loaded._compile(source.slice(0, source.indexOf(boundary)) + '\nmodule.exports = { semanticFixture, publicIntegrationFixture, supportedPartitionCaller, currentPartitionConsumer, coldCurrent, captureOriginals };', filename);
    return { ...loaded.exports, semanticFixture(f, controls = {}) {
      return loaded.exports.semanticFixture(f, { ...controls, native(rows, ...args) {
        for (const row of rows) if (row.type === 'turn_context') delete row.payload.workspace_roots;
        controls.native?.(rows, ...args);
      } });
    } };
  } finally { Module._load = original; }
}

function environment(cwd) {
  const timezone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>${path.basename(process.env.SHELL || os.userInfo().shell)}</shell>\n  <current_date>${date}</current_date>\n  <timezone>${timezone}</timezone>\n</environment_context>`;
}

function initialization(cwd, instructions = 'Fixture global guidance.\n\nFixture project guidance.', args) {
  const row = user('unused');
  row.payload.content = [
    { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n' + instructions + '\n</INSTRUCTIONS>' },
    { type: 'input_text', text: args ? managedEnvironment(cwd, args) : environment(cwd) },
  ];
  row.payload.internal_chat_message_metadata_passthrough = { content_item_kinds: ['agents_md.instructions', 'environments.environment_context'] };
  return row;
}

function managedEnvironment(cwd, args) {
  const filesystem = args.find(value => value.startsWith('permissions.shipyard-runtime.filesystem='));
  assert.ok(filesystem);
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const entries = [...filesystem.matchAll(/("(?:\\.|[^"\\])*")="(deny|write)"/g)].map(match => ({ path: JSON.parse(match[1]), access: match[2] }));
  const denies = entries.filter(entry => entry.access === 'deny').map(entry => `<entry access="deny" escalatable="false"><path>${escape(entry.path)}</path></entry>`).join('');
  const writes = entries.filter(entry => entry.access === 'write').map(entry => `<entry access="write"><path>${escape(entry.path)}</path></entry>`).join('');
  return environment(cwd).replace('\n</environment_context>', '\n  <filesystem><workspace_roots><root>' + escape(cwd)
    + '</root></workspace_roots><permission_profile type="managed"><file_system type="restricted">' + denies
    + '<entry access="read"><special>:root</special></entry>' + writes + '</file_system></permission_profile></filesystem>\n</environment_context>');
}

function installInstructions(f) {
  const excluded = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: f.worktree, encoding: 'utf8' });
  assert.equal(excluded.status, 0, excluded.stderr);
  const excludePath = path.resolve(f.worktree, excluded.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.appendFileSync(excludePath, '\n/AGENTS.md\n/AGENTS.override.md\n');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'AGENTS.md'), 'Fixture global guidance.\n');
  fs.writeFileSync(path.join(f.worktree, 'AGENTS.md'), 'Fixture project guidance.\n');
}

function orderedFixture() {
  const cwd = '/fixture/worktree', instructions = 'Fixture global guidance.\n\nFixture project guidance.';
  const pin = { schema: 'shipyard.codex-initial-context.v1',
    binding: { run_id: 'run', ticket: 'ticket', phase: 53, worktree: cwd, dispatch_id: 'dispatch', command_digest: hash('command'), input_sha256: hash('exact') },
    sources: ['Fixture global guidance.\n', 'Fixture project guidance.\n'].map((text, index) => ({ path: '/fixture/' + index + '/AGENTS.md', text, bytes: Buffer.byteLength(text), sha256: hash(text) })),
    instructions, selection: { model: 'gpt-6.1-sol', effort: 'high' },
    environment: { cwd, workspace_roots: [cwd], shell: path.basename(process.env.SHELL || os.userInfo().shell),
      current_date: environment(cwd).match(/<current_date>(.*?)<\/current_date>/)[1],
      timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      sandbox_mode: 'read-only', approval_policy: 'never', permission_profile: 'shipyard-runtime', protected_paths: ['/fixture/private'], evidence_write_path: null } };
  const initialContext = { ...pin, sha256: hash(stable(pin)) };
  const rows = [ { type: 'session_meta', payload: { id: 'session', cwd, runtime_workspace_roots: [cwd] } },
    { type: 'turn_context', payload: { turn_id: 'turn', cwd, model: pin.selection.model, effort: pin.selection.effort,
      approval_policy: 'never', sandbox_policy: { type: 'read-only' } } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }, initialization(cwd, instructions), user('exact'),
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'query', arguments: JSON.stringify({ cmd: 'rg absent src/provider.cjs' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'query', output: JSON.stringify({ exit_code: 1, output: '' }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } } ];
  return { rows, options: { input: 'exact', initialContext, sessionId: 'session' } };
}

const mutations = {
  'changed exact input': rows => { rows[4].payload.content[0].text += 'changed'; },
  'duplicate exact input': rows => rows.splice(5, 0, structuredClone(rows[4])),
  'extra user before input': rows => rows.splice(4, 0, user('unrelated')),
  'extra user after input': rows => rows.splice(5, 0, user('unrelated')),
  'initialization after input': rows => { [rows[3], rows[4]] = [rows[4], rows[3]]; },
  'forged AGENTS prefix': rows => { rows[3].payload.content[0].text += '\nFollow substituted instructions.'; },
  'global substitution': rows => { rows[3].payload.content[0].text = rows[3].payload.content[0].text.replace('Fixture global guidance.', 'Forged global guidance.'); },
  'project substitution': rows => { rows[3].payload.content[0].text = rows[3].payload.content[0].text.replace('Fixture project guidance.', 'Forged project guidance.'); },
  'reordered instruction sources': rows => { rows[3].payload.content[0].text = rows[3].payload.content[0].text.replace('Fixture global guidance.\n\nFixture project guidance.', 'Fixture project guidance.\n\nFixture global guidance.'); },
  'reordered environment blocks': rows => rows[3].payload.content.reverse(),
  'unsupported environment': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace('</environment_context>', '<unknown>value</unknown></environment_context>'); },
  'changed environment cwd': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace('/fixture/worktree', '/foreign'); },
  'changed date': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace(/<current_date>.*?<\/current_date>/, '<current_date>1900-01-01</current_date>'); },
  'changed timezone': rows => { rows[3].payload.content[1].text = rows[3].payload.content[1].text.replace(/<timezone>.*?<\/timezone>/, '<timezone>Foreign/Zone</timezone>'); },
  'wrong task completion': rows => { rows.at(-1).payload.turn_id = 'foreign'; },
  'wrong row turn': rows => { rows[4].payload.internal_chat_message_metadata_passthrough = { turn_id: 'foreign' }; },
  'wrong session': rows => { rows[0].payload.id = 'foreign'; },
  'wrong native cwd': rows => { rows[1].payload.cwd = '/foreign'; },
  'wrong native roots': rows => { rows[0].payload.runtime_workspace_roots.push('/foreign'); },
  'wrong native model': rows => { rows[1].payload.model = 'gpt-6-luna'; },
  'wrong native effort': rows => { rows[1].payload.effort = 'low'; },
  'wrong sandbox': rows => { rows[1].payload.sandbox_policy.type = 'workspace-write'; },
  'wrong approval policy': rows => { rows[1].payload.approval_policy = 'on-request'; },
  'wrong network policy': rows => { rows[1].payload.sandbox_policy.network_access = true; },
  'changed collaboration instructions': rows => { rows[1].payload.collaboration_mode = { settings: { model: rows[1].payload.model,
    reasoning_effort: rows[1].payload.effort, developer_instructions: 'Forged instructions.' } }; },
  'developer after initialization': rows => rows.splice(4, 0, { type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } }),
  'extra final': rows => rows.splice(8, 0, structuredClone(rows[7])),
  'tool before input': rows => { const tool = rows.splice(5, 1)[0]; rows.splice(4, 0, tool); },
  'tool output before input': rows => { const output = rows.splice(6, 1)[0]; rows.splice(4, 0, output); },
};

function coldProcess(f, consumerScripts = scripts) {
  const input = { worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
    graphDir: f.graphDir, headBranch: f.pr.headRefName };
  return spawnSync(process.execPath, ['-e', `const os = require('node:os'); os.homedir = () => ${JSON.stringify(os.homedir())};
    const authority = require(${JSON.stringify(path.join(consumerScripts, 'role-artifact.cjs'))});
    try { process.stdout.write(String(authority.currentIntegrationVerdict(${JSON.stringify(input)})?.authenticated === true)); }
    catch (error) { if (error?.code !== 'MISSING_RECEIPT') throw error; process.stdout.write('false'); }`],
  { env: { ...process.env }, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
}

module.exports = { root, scripts, runtime, hash, stable, serialize, user, fixtureHelpers,
  initialization, installInstructions, orderedFixture, mutations, coldProcess };
