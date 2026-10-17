'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { prepareResolvedRequestFile } = require('../../plugins/delivery-pipeline/scripts/claude-investigation-host.cjs');

const SCRIPT_PATH = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/claude-investigation-host.cjs');

test('CLI request preparation resolves every research line on the host and keeps the source request unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-investigation-request-'));
  const source = path.join(root, 'request.json');
  const lines = [
    ['system-state', 'system state'],
    ['alternatives', 'alternatives'],
    ['constraints', 'constraints'],
    ['risks', 'risks and unknowns'],
  ].map(([id, label]) => ({ id, label, signals: {} }));
  const request = { schema: 'shipyard.claude-delivery-request.v1', scope: {}, args: { worktreePath: root, lines } };
  fs.writeFileSync(source, JSON.stringify(request));
  const prepared = prepareResolvedRequestFile(source);
  try {
    const resolved = JSON.parse(fs.readFileSync(prepared.file, 'utf8'));
    assert.equal(resolved.args.lines.length, 4);
    assert.ok(resolved.args.lines.every((line) => typeof line.model === 'string' && typeof line.effort === 'string'));
    assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), request);
    assert.equal(fs.statSync(prepared.file).mode & 0o777, 0o600);
  } finally {
    prepared.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI request preparation refuses a symlink request before selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-investigation-link-'));
  const source = path.join(root, 'source.json');
  const linked = path.join(root, 'request.json');
  fs.writeFileSync(source, '{}');
  fs.symlinkSync(source, linked);
  try {
    assert.throws(() => prepareResolvedRequestFile(linked), /request must be a bounded regular file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawning with bad argv exits 1, keeps the first stderr line, and appends a hint line', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.split('\n');
  assert.equal(lines[0], 'claude-investigation-host: --request-file <json> is required');
  assert.match(lines[1], /^hint\[INVALID_HOST\]: /);
});

test('spawning with a caller-supplied host module still refuses with the pinned message and a hint line', () => {
  const result = spawnSync(process.execPath,
    [SCRIPT_PATH, '--args-file', '/tmp/args.json', '--host-module', '/tmp/host.cjs'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--request-file <json> is required/);
  const lines = result.stderr.split('\n');
  assert.match(lines[1], /^hint\[INVALID_HOST\]: /);
});

test('investigation --preflight returns the same result as the delivery host and starts nothing', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-investigation-preflight-')));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(project, '.planning', 'graph', 'provenance'), { recursive: true });
  spawnSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(project, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: {} }));
  fs.writeFileSync(path.join(project, '.planning', 'graph', 'provenance', 'one.json'), '{}');
  fs.symlinkSync('one.json', path.join(project, '.planning', 'graph', 'provenance', 'link.json'));
  const help = ['--model', '--effort', '--output-format', 'stream-json', '--session-id', '--permission-mode',
    '--permission-prompts', '--allowedTools', '--tools', '--restricted', '--strict-mcp-config', '--settings',
    '--setting-sources', '--agent', '--agents'].join(' ');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
case "$1" in
  --version) echo "9.9.9";;
  --help) echo "${help}";;
  auth) echo '{"loggedIn":true}';;
esac
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, SHIPYARD_GRAPH_DIR: path.join(project, '.planning', 'graph'), PATH: `${bin}:${process.env.PATH}` };
  const delivery = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/claude-delivery-host.cjs');
  try {
    const viaInvestigation = spawnSync(process.execPath, [SCRIPT_PATH, '--preflight'], { encoding: 'utf8', cwd: project, env, timeout: 30000 });
    const viaDelivery = spawnSync(process.execPath, [delivery, '--preflight'], { encoding: 'utf8', cwd: project, env, timeout: 30000 });
    assert.equal(viaInvestigation.status, 1, viaInvestigation.stderr);
    assert.equal(viaInvestigation.status, viaDelivery.status);
    assert.equal(viaInvestigation.stdout, viaDelivery.stdout);
    assert.match(viaInvestigation.stderr, /hint\[LEGACY_HISTORY_UNSAFE\]/);
    assert.equal(fs.existsSync(path.join(home, '.local')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
