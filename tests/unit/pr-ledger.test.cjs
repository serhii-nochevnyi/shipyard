'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pr-ledger.cjs');
const { recordPr, readLedger, SCHEMA, STORE_NAME } = require(SCRIPT);

function graphDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-pr-ledger-'));
  const g = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(g, { recursive: true });
  return g;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
}

suite('recordPr / readLedger — round trip');

test('an empty ledger reads as the schema with no entries', () => {
  const ledger = readLedger(graphDir());
  assert.strictEqual(ledger.schema, SCHEMA);
  assert.deepEqual(ledger.entries, {});
});

test('record then read round-trips number, head and repo', () => {
  const g = graphDir();
  const entry = recordPr({
    graphDir: g, ticket: 'T-01-02', number: 42, head: 'ticket/T-01-02-add-undo-endpoint', repo: 'acme/widgets',
  });
  assert.strictEqual(entry.number, 42);
  assert.strictEqual(entry.head, 'ticket/T-01-02-add-undo-endpoint');
  assert.strictEqual(entry.repo, 'acme/widgets');
  assert.ok(typeof entry.created_at === 'string' && !Number.isNaN(Date.parse(entry.created_at)));
  assert.deepEqual(readLedger(g).entries['T-01-02'], entry);
  const onDisk = JSON.parse(fs.readFileSync(path.join(g, STORE_NAME), 'utf8'));
  assert.strictEqual(onDisk.schema, SCHEMA);
});

test('repo is optional and stored as null when omitted', () => {
  const entry = recordPr({ graphDir: graphDir(), ticket: 'T-01-03', number: 1, head: 'ticket/T-01-03-x' });
  assert.strictEqual(entry.repo, null);
});

suite('recordPr — conflicting overwrite');

test('recording a different number for the same ticket refuses without --replace', () => {
  const g = graphDir();
  recordPr({ graphDir: g, ticket: 'T-01-02', number: 5, head: 'ticket/T-01-02-a' });
  assert.throws(
    () => recordPr({ graphDir: g, ticket: 'T-01-02', number: 6, head: 'ticket/T-01-02-b' }),
    /already recorded against PR #5/
  );
  assert.strictEqual(readLedger(g).entries['T-01-02'].number, 5, 'the refused write must not touch the stored entry');
});

test('recording the same number again is not a conflict', () => {
  const g = graphDir();
  recordPr({ graphDir: g, ticket: 'T-01-02', number: 5, head: 'ticket/T-01-02-a' });
  const second = recordPr({
    graphDir: g, ticket: 'T-01-02', number: 5, head: 'ticket/T-01-02-a', repo: 'acme/widgets',
  });
  assert.strictEqual(second.repo, 'acme/widgets');
});

test('--replace allows recording a different number', () => {
  const g = graphDir();
  recordPr({ graphDir: g, ticket: 'T-01-02', number: 5, head: 'ticket/T-01-02-a' });
  const replaced = recordPr({
    graphDir: g, ticket: 'T-01-02', number: 6, head: 'ticket/T-01-02-b', replace: true,
  });
  assert.strictEqual(replaced.number, 6);
  assert.strictEqual(readLedger(g).entries['T-01-02'].number, 6);
});

suite('readLedger — a corrupt ledger refuses (never reads as empty)');

test('invalid JSON refuses rather than reading as empty', () => {
  const g = graphDir();
  fs.writeFileSync(path.join(g, STORE_NAME), '{ not json');
  assert.throws(() => readLedger(g), /not valid JSON/);
});

test('a schema mismatch refuses rather than reading as empty', () => {
  const g = graphDir();
  fs.writeFileSync(path.join(g, STORE_NAME), JSON.stringify({ schema: 'something.else.v1', entries: {} }));
  assert.throws(() => readLedger(g), /does not match schema/);
});

test('recordPr refuses against a corrupt ledger rather than overwriting it', () => {
  const g = graphDir();
  fs.writeFileSync(path.join(g, STORE_NAME), '{ not json');
  assert.throws(
    () => recordPr({ graphDir: g, ticket: 'T-01-02', number: 5, head: 'ticket/T-01-02-a' }),
    /not valid JSON/
  );
});

suite('recordPr — field validation');

test('rejects a malformed ticket id', () => {
  assert.throws(
    () => recordPr({ graphDir: graphDir(), ticket: 'not-a-ticket', number: 5, head: 'ticket/x' }),
    /not a valid ticket id/
  );
});

test('rejects a non-positive-integer PR number', () => {
  const g = graphDir();
  for (const bad of [0, -1, '1.5', 'abc', '', '007', ' 5']) {
    assert.throws(
      () => recordPr({ graphDir: g, ticket: 'T-01-02', number: bad, head: 'ticket/x' }),
      /positive integer PR number/,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test('rejects an unsafe branch name', () => {
  const g = graphDir();
  for (const bad of ['-leading-dash', '../escape', 'has..dots', '']) {
    assert.throws(
      () => recordPr({ graphDir: g, ticket: 'T-01-02', number: 5, head: bad }),
      /not a safe branch name/,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test('rejects a malformed repo', () => {
  assert.throws(
    () => recordPr({
      graphDir: graphDir(), ticket: 'T-01-02', number: 5, head: 'ticket/x', repo: 'not-owner-slash-name',
    }),
    /not a valid repo/
  );
});

suite('pr-ledger.cjs record — CLI');

test('records via the CLI and exits 0', () => {
  const g = graphDir();
  const r = run([
    'record', '--ticket', 'T-01-02', '--number', '7',
    '--head', 'ticket/T-01-02-add-undo-endpoint', '--repo', 'acme/widgets', '--graph-dir', g,
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  const stored = readLedger(g).entries['T-01-02'];
  assert.strictEqual(stored.number, 7);
  assert.strictEqual(stored.repo, 'acme/widgets');
});

test('the CLI refuses a malformed ticket id, naming the field, with a non-zero exit', () => {
  const r = run(['record', '--ticket', 'nope', '--number', '1', '--head', 'ticket/x', '--graph-dir', graphDir()]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /ticket id/);
});

test('the CLI refuses a malformed branch, naming the field, with a non-zero exit', () => {
  const r = run(['record', '--ticket', 'T-01-02', '--number', '1', '--head', '-bad', '--graph-dir', graphDir()]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /branch/);
});

test('the CLI refuses a malformed number, naming the field, with a non-zero exit', () => {
  const r = run(['record', '--ticket', 'T-01-02', '--number', 'abc', '--head', 'ticket/x', '--graph-dir', graphDir()]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /PR number/);
});

test('the CLI refuses a conflicting overwrite without --replace, naming the number', () => {
  const g = graphDir();
  recordPr({ graphDir: g, ticket: 'T-01-02', number: 5, head: 'ticket/T-01-02-a' });
  const r = run(['record', '--ticket', 'T-01-02', '--number', '6', '--head', 'ticket/T-01-02-b', '--graph-dir', g]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /already recorded against PR #5/);
});

done();
