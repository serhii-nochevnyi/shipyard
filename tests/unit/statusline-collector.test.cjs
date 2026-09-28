'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const collector = require('../../plugins/delivery-pipeline/scripts/statusline-collector.cjs');
const sub = require('../../plugins/delivery-pipeline/scripts/subscription-observation.cjs');
const store = require('../../plugins/delivery-pipeline/scripts/subscription-store.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins/delivery-pipeline/scripts/statusline-collector.cjs');
const FIXTURE = 'tests/fixtures/captured/claude-statusline.jsonl';
const FIELDS = new Set(['schema', 'provider', 'runtime', 'source', 'account_label', 'attribution', 'bucket_id',
  'window_minutes', 'resets_at', 'used_percent', 'observed_at', 'freshness', 'concurrency']);

const lines = fs.readFileSync(path.join(ROOT, FIXTURE), 'utf8').split('\n').filter(Boolean);
const provenance = JSON.parse(lines[0]).shipyard_fixture;
const render = JSON.parse(lines[1]);
const renderBytes = Buffer.from(`${lines[1]}\n`, 'utf8');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-statusline-'));
process.on('exit', () => fs.rmSync(temporary, { recursive: true, force: true }));
let counter = 0;
function fresh(name) {
  counter += 1;
  return fs.mkdtempSync(path.join(temporary, `${name}-${counter}-`));
}

function renderer(body) {
  const dir = fresh('renderer');
  const file = path.join(dir, 'render.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, command: `sh ${JSON.stringify(file)}` };
}

function runWrap(command, input, extra = {}) {
  const home = extra.home || fresh('home');
  const stateRoot = extra.stateRoot || fresh('state');
  const args = [SCRIPT, 'wrap', '--home', home, '--previous-b64', Buffer.from(command).toString('base64'),
    '--state-root', stateRoot];
  return { result: spawnSync(process.execPath, args, { input }), home, stateRoot };
}

function runDirect(command, input) {
  return spawnSync('/bin/sh', ['-c', command], { input });
}

function sampleFiles(stateRoot) {
  const dir = path.join(stateRoot, 'subscription');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('samples-'));
}

suite('statusline-collector — captured fixture');

test('the fixture carries scrubbed provenance and no e-mail address', () => {
  assert.equal(provenance.boundary, 'claude-statusline');
  assert.equal(provenance.scrubbed, true);
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(lines.join('\n')));
});

test('parseStatusline yields five_hour and seven_day in percent with allow-listed fields', () => {
  const envelopes = collector.parseStatusline(render, { observedAt: '2026-09-28T00:00:00.000Z' });
  const byBucket = Object.fromEntries(envelopes.map((e) => [e.bucket_id, e]));
  assert.equal(byBucket.five_hour.used_percent, render.rate_limits.five_hour.used_percentage);
  assert.equal(byBucket.seven_day.used_percent, render.rate_limits.seven_day.used_percentage);
  assert.equal(byBucket.five_hour.window_minutes, 300);
  assert.equal(byBucket.seven_day.window_minutes, 10080);
  assert.equal(byBucket.five_hour.resets_at, render.rate_limits.five_hour.resets_at);
  for (const envelope of envelopes) {
    assert.equal(envelope.source, 'claude-statusline');
    assert.equal(envelope.freshness, 'observed');
    assert.equal(envelope.concurrency, 'unknown');
    assert.equal(envelope.attribution, 'unattributed');
    for (const key of Object.keys(envelope)) assert.ok(FIELDS.has(key), key);
    sub.validateEnvelope(envelope);
  }
  assert.equal(sub.summarize(envelopes).verdict, 'inconclusive');
});

suite('statusline-collector — wrap transparency');

for (const [name, bytes] of [['utf8 fixture', renderBytes], ['binary', Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x0a, 0x00])]]) {
  test(`wrap forwards ${name} stdin byte-identical`, () => {
    const r = renderer('cat > "$(dirname "$0")/stdin.bin"; printf ok');
    const { result } = runWrap(r.command, bytes);
    assert.equal(result.status, 0);
    assert.ok(fs.readFileSync(path.join(r.dir, 'stdin.bin')).equals(bytes));
  });
}

for (const code of [0, 3]) {
  test(`wrap stdout, stderr and exit ${code} equal the renderer's`, () => {
    const r = renderer(`cat >/dev/null; printf 'line out'; printf 'line err' >&2; exit ${code}`);
    const { result } = runWrap(r.command, renderBytes);
    const direct = runDirect(r.command, renderBytes);
    assert.equal(result.status, code);
    assert.ok(result.stdout.equals(direct.stdout));
    assert.ok(result.stderr.equals(direct.stderr));
  });
}

test('a renderer killed by SIGTERM makes wrap end by SIGTERM', () => {
  const command = 'cat >/dev/null; kill -TERM $$';
  const { result } = runWrap(command, renderBytes);
  const direct = runDirect(command, renderBytes);
  assert.equal(direct.signal, 'SIGTERM');
  assert.equal(result.signal, direct.signal);
  assert.equal(result.status, direct.status);
});

const failureCases = [
  ['an unwritable stateRoot', renderBytes, () => {
    const dir = fresh('ro');
    fs.chmodSync(dir, 0o500);
    return dir;
  }],
  ['malformed JSON', Buffer.from('{not json'), null],
  ['an oversize input', Buffer.concat([renderBytes, Buffer.alloc(collector.MAX_INPUT_BYTES, 0x20)]), null],
];
for (const [name, input, makeRoot] of failureCases) {
  test(`with ${name} wrap output equals the renderer and no store file appears`, () => {
    const r = renderer('cat >/dev/null; printf render; printf warn >&2; exit 0');
    const stateRoot = makeRoot ? makeRoot() : fresh('state');
    const { result } = runWrap(r.command, input, { stateRoot });
    const direct = runDirect(r.command, input);
    assert.equal(result.status, direct.status);
    assert.ok(result.stdout.equals(direct.stdout));
    assert.ok(result.stderr.equals(direct.stderr));
    assert.deepEqual(sampleFiles(stateRoot), []);
  });
}

suite('statusline-collector — store');

test('repeated identical renders store one sample per series', () => {
  const r = renderer('cat >/dev/null');
  const home = fresh('home');
  const stateRoot = fresh('state');
  runWrap(r.command, renderBytes, { home, stateRoot });
  runWrap(r.command, renderBytes, { home, stateRoot });
  const { envelopes } = store.list({ runtime: 'claude', stateRoot });
  assert.equal(envelopes.length, 2);
  assert.deepEqual(envelopes.map((e) => e.bucket_id).sort(), ['five_hour', 'seven_day']);
  assert.ok(envelopes.every((e) => e.attribution === 'unattributed' && e.account_label === null));
});

test('a declared label is recorded as declared', () => {
  const home = fresh('home');
  const stateRoot = fresh('state');
  store.declareLabel({ runtime: 'claude', home, label: 'claude-max-1', stateRoot });
  collector.collect(renderBytes, home, { stateRoot });
  const { envelopes } = store.list({ runtime: 'claude', stateRoot });
  assert.ok(envelopes.length === 2 && envelopes.every((e) => e.account_label === 'claude-max-1' && e.attribution === 'declared'));
});

done();
