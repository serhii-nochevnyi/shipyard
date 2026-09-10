'use strict';

// jira-project.cjs — the WATERMARK store (T-29-03) and the PLANNER (T-29-04).
//
// ADR-008 D3 makes the planner a pure function of three LOCAL files, and that is
// the whole reason it is as large as it is: it is the half a test can prove with
// no tracker, no credential and no stub. So these tests are the design document
// executed — every rule in the plan's Scope has a case here, and the four that
// the ticket calls out as WITNESSED MUTATIONS have a positive case whose failure
// is what the mutation produces.
//
// The three that matter most, and why:
//
//  * THE WINDOW. `stop-gate.cjs`'s `JOURNAL_TAIL_BYTES = 64 * 1024` exists for a
//    HOOK's ~75ms budget. This repository's own journal is already 139 KB / 806
//    events, so the same bound here would silently drop transitions older than
//    the window — which quietly falsifies ADR-008 D6's justification ("catch-up
//    is free"). A projection that loses transitions without saying so is worse
//    than one that never ran, so there is a case with the pending event beyond
//    64 KB from the end, asserting the fixture's byte geometry so it cannot pass
//    by accident.
//  * THE SEEK'S FIRST LINE. stop-gate's other lesson is TAKEN: drop the first
//    line only when the read actually SEEKED. Dropping it unconditionally ate
//    the only event in a short journal — every project not running for weeks.
//  * UNREACHABLE SUPPRESSION. `plan` + `record --unreachable` is a retry loop
//    wearing a report's hat unless the item is withheld until the world moves:
//    one tracker call per stuck ticket per round, forever, which is exactly the
//    "never retry hard" of ADR-008 D4.
//
// Every fixture line is a REAL record copied out of `.planning/graph/delivery-log.jsonl`
// (the ticket ids and timestamps are this project's own), embedded as a literal
// rather than read at test time — a test that reads the live journal changes its
// meaning every time the conveyor runs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'jira-project.cjs'
);
const mod = require(SCRIPT);

// ── real records, verbatim ──────────────────────────────────────────────────
//
// Copied out of this project's journal. `from: null` on a first sighting, a
// whole round of transitions sharing one `ts` (state-sync writes them with a
// single `nowIso`), and a reopen-shaped pair are all real shapes, not invented
// ones.
const REAL = {
  firstSighting: '{"ts":"2026-08-25T07:07:39.707Z","event":"status_change","ticket":"T-20-01","from":null,"to":"pending","pr":null}',
  branched: '{"ts":"2026-08-26T14:29:20.564Z","event":"status_change","ticket":"T-21-02","from":"pending","to":"pr-open","pr":17}',
  merged: '{"ts":"2026-09-07T19:35:52.586Z","event":"status_change","ticket":"T-24-05","from":"pr-open","to":"merged","pr":44}',
  attempt: '{"ts":"2026-08-25T08:13:27.317Z","event":"attempt","ticket":"T-20-01","pr":1,"n":1,"role":"review-fix","model":"opus","outcome":"pushed"}',
};

// A `status_change` in the exact shape state-sync.cjs:787 writes, with the real
// records above as the template.
const sc = (ticket, from, to, ts, pr = null) =>
  JSON.stringify({ ts, event: 'status_change', ticket, from, to, pr });

// ── a project on disk ───────────────────────────────────────────────────────

/**
 * `tickets` is `id → jira key | null`. `journal` is an array of raw LINES, so a
 * test can write a deliberately torn one. `store` is the raw
 * `jira-projection.json` object, absent by default (nothing projected yet, which
 * is the normal first state).
 */
function project({ tickets = {}, journal = [], store = null, config = undefined, configRaw = undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-jira-'));
  const g = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(g, { recursive: true });
  const t = {};
  for (const [id, jira] of Object.entries(tickets)) t[id] = { jira: jira || null };
  fs.writeFileSync(path.join(g, 'tickets.json'), JSON.stringify({ tickets: t }));
  if (journal !== null) fs.writeFileSync(path.join(g, 'delivery-log.jsonl'), journal.map((l) => `${l}\n`).join(''));
  if (store) fs.writeFileSync(path.join(g, 'jira-projection.json'), JSON.stringify(store, null, 2));
  if (configRaw !== undefined) {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), configRaw);
  } else {
    // The projection ON is the deliberate default for these fixtures: `enabled`
    // defaults to true, and `jira_transitions` defaults to EMPTY, which is the
    // feature switched off. A test about anything but the off-switches has to
    // opt in, exactly as an operator does.
    const pipeline = config === undefined
      ? { jira_transitions: { 'pr-open': 'In Progress', merged: 'Done' } }
      : config;
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline }));
  }
  return { dir, graph: g };
}

const graphOf = (p) => p.graph;

// The CLI, as a real child process — the surface `deliver.md` actually calls.
function run(graph, args, opts = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--graph', graph], {
    encoding: 'utf8', cwd: opts.cwd || os.tmpdir(), timeout: 20000,
  });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { /* left null */ } }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// The library face, which is what T-29-05's `record` will call for its
// not-pending refusal.
const plan = (p) => mod.planItems(graphOf(p));
const ids = (out) => out.items.map((i) => i.ticket);

// ── the off-switches ────────────────────────────────────────────────────────

suite('the off-switches: empty list, exit 0, no warning');

test('pipeline.jira.enabled: false yields nothing, and says so as a REASON not a warning', () => {
  const p = project({
    tickets: { 'T-20-01': 'SHIP-1' },
    journal: [sc('T-20-01', 'pending', 'merged', '2026-09-07T19:35:52.586Z', 44)],
    config: { jira: { enabled: false }, jira_transitions: { merged: 'Done' } },
  });
  const out = plan(p);
  assert.deepEqual(out.items, [], 'disabled must project nothing');
  assert.equal(out.enabled, false);
  assert.deepEqual(out.warnings, [], 'a switched-off feature is not a warning');
  const cli = run(graphOf(p), ['plan', '--json']);
  assert.equal(cli.status, 0, `exit 0: ${cli.stderr}`);
  assert.equal(cli.stderr, '', 'nothing on stderr');
  assert.deepEqual(cli.json.items, []);
});

test('the EMPTY MAP is the default, and the default is off', () => {
  const p = project({
    tickets: { 'T-20-01': 'SHIP-1' },
    journal: [sc('T-20-01', 'pending', 'merged', '2026-09-07T19:35:52.586Z', 44)],
    config: {},   // no jira_transitions at all
  });
  const out = plan(p);
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.warnings, [], 'an unconfigured project must not be warned at, once a round, forever');
  const cli = run(graphOf(p), ['plan', '--json']);
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
});

test('an INVALID config projects nothing and DOES say why (ADR-004 D2)', () => {
  // The one loud case, and it is loud on purpose: a corrupt configuration
  // permits no mutation, and transitioning somebody's board is a mutation. This
  // is a broken file, not the quiet common case.
  const p = project({
    tickets: { 'T-20-01': 'SHIP-1' },
    journal: [sc('T-20-01', 'pending', 'merged', '2026-09-07T19:35:52.586Z', 44)],
    configRaw: '{ this is not json',
  });
  const out = plan(p);
  assert.deepEqual(out.items, []);
  assert.equal(out.warnings.length, 1, 'exactly one line, naming the file');
  assert.match(out.warnings[0], /invalid/i);
  const cli = run(graphOf(p), ['plan']);
  assert.equal(cli.status, 0, 'still exit 0 — this never blocks a round (ADR-008 D6)');
  assert.match(cli.stderr, /invalid/i);
});

// ── who is a subject ────────────────────────────────────────────────────────

suite('subjects: a jira key, a mapped status, and nothing else');

test('a ticket with no delivery.jira key is not a subject and not a warning', () => {
  const p = project({
    tickets: { 'T-20-01': null, 'T-21-02': 'SHIP-2' },
    journal: [
      sc('T-20-01', 'pending', 'merged', '2026-09-07T19:35:52.586Z', 44),
      sc('T-21-02', 'pending', 'merged', '2026-09-07T19:35:53.000Z', 17),
    ],
  });
  const out = plan(p);
  assert.deepEqual(ids(out), ['T-21-02'], 'only the keyed ticket');
  assert.deepEqual(out.warnings, []);
});

test('an unmapped `to` is skipped silently — mapping only `merged` asks for only `merged`', () => {
  const p = project({
    tickets: { 'T-21-02': 'SHIP-2', 'T-24-05': 'SHIP-5' },
    journal: [
      sc('T-21-02', 'pending', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
      sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
    ],
    config: { jira_transitions: { merged: 'Done' } },
  });
  const out = plan(p);
  assert.deepEqual(ids(out), ['T-24-05']);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.items[0].target_status, 'Done');
  assert.equal(out.items[0].key, 'SHIP-5');
});

test('the emitted item carries exactly what the acting half needs', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
  });
  const [item] = plan(p).items;
  assert.deepEqual(Object.keys(item).sort(), ['from', 'key', 'target_status', 'ticket', 'to', 'ts']);
  assert.deepEqual(
    { ticket: item.ticket, key: item.key, from: item.from, to: item.to, target_status: item.target_status },
    { ticket: 'T-24-05', key: 'SHIP-5', from: 'pr-open', to: 'merged', target_status: 'Done' }
  );
  // `ts` is the DRIVING EVENT's, not the moment plan ran: T-29-05 anchors its
  // unreachable report on it, and a filing time is only an upper bound on the
  // event it is about.
  assert.equal(item.ts, '2026-09-07T19:35:52.586Z');
});

// ── collapse ────────────────────────────────────────────────────────────────

suite('collapse: several changes since the watermark are ONE item, at the latest');

test('pending -> branched -> pr-open is one item at pr-open, never three transitions', () => {
  const p = project({
    tickets: { 'T-21-02': 'SHIP-2' },
    journal: [
      sc('T-21-02', null, 'pending', '2026-08-25T07:07:39.707Z'),
      sc('T-21-02', 'pending', 'branched', '2026-08-26T09:00:00.000Z'),
      sc('T-21-02', 'branched', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
    ],
    config: { jira_transitions: { pending: 'To Do', branched: 'In Progress', 'pr-open': 'In Review', merged: 'Done' } },
  });
  const out = plan(p);
  assert.equal(out.items.length, 1, `one item, got ${JSON.stringify(out.items)}`);
  assert.equal(out.items[0].to, 'pr-open');
  assert.equal(out.items[0].target_status, 'In Review');
  // WITNESSED COLLAPSE MUTATION, standing: remove the collapse (emit per event)
  // and this fixture yields three items — pending, branched, pr-open — walking
  // somebody's issue through three transitions for one round of the board.
});

test('with no watermark the item reports where the collapsed run STARTED', () => {
  const p = project({
    tickets: { 'T-21-02': 'SHIP-2' },
    journal: [
      sc('T-21-02', null, 'pending', '2026-08-25T07:07:39.707Z'),
      sc('T-21-02', 'pending', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
    ],
  });
  assert.equal(plan(p).items[0].from, null, 'the earliest event\'s `from`, which here is a first sighting');
});

test('with a watermark the item reports what the tracker was last TOLD', () => {
  const p = project({
    tickets: { 'T-21-02': 'SHIP-2' },
    journal: [
      sc('T-21-02', 'pending', 'branched', '2026-08-26T09:00:00.000Z'),
      sc('T-21-02', 'branched', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
    ],
    store: { tickets: { 'T-21-02': { projected_to: 'pending', ts: '2026-08-26T08:00:00.000Z' } } },
  });
  assert.equal(plan(p).items[0].from, 'pending');
});

// ── the watermark ───────────────────────────────────────────────────────────

suite('exactly once, forward only, in OUR order');

test('a ticket already at its watermark yields nothing', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
    store: { tickets: { 'T-24-05': { projected_to: 'merged', ts: '2026-09-07T19:36:00.000Z' } } },
  });
  assert.deepEqual(plan(p).items, []);
});

test('a reopened PR does not drag the board backwards', () => {
  // A genuine `merged` -> `pr-open` change. The conveyor does not treat it as a
  // regression, and neither may the projection.
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'merged', 'pr-open', '2026-09-08T10:00:00.000Z', 44)],
    store: { tickets: { 'T-24-05': { projected_to: 'merged', ts: '2026-09-07T19:36:00.000Z' } } },
  });
  assert.deepEqual(plan(p).items, []);
});

test('a reopen that is then re-merged collapses to the LATEST and IS emitted', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [
      sc('T-24-05', 'merged', 'pr-open', '2026-09-08T10:00:00.000Z', 44),
      sc('T-24-05', 'pr-open', 'merged', '2026-09-08T12:00:00.000Z', 44),
    ],
    store: { tickets: { 'T-24-05': { projected_to: 'pr-open', ts: '2026-09-08T11:00:00.000Z' } } },
  });
  const out = plan(p);
  assert.deepEqual(ids(out), ['T-24-05']);
  assert.equal(out.items[0].to, 'merged');
});

// ── THE WINDOW: never a fixed-size tail ─────────────────────────────────────

suite('the window: the read is anchored on the watermark, never on a byte count');

const TAIL_64K = 64 * 1024;

// Padding: real `attempt` and `status_change` records for tickets that are not
// subjects — the shapes the journal actually carries between two syncs, so the
// bytes the scan steps over are the bytes it steps over in production.
let padSeq = 0;
function pad(targetBytes) {
  const lines = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    const id = `T-99-${String((padSeq % 90) + 10)}`;
    const a = REAL.attempt.replace('T-20-01', id);
    const b = sc(id, 'pending', 'pr-open', `2026-09-0${(padSeq % 8) + 1}T10:00:00.000Z`, 900 + padSeq);
    lines.push(a, b);
    bytes += a.length + b.length + 2;
    padSeq++;
  }
  return lines;
}

// A journal comfortably over 64 KB whose PENDING transition sits at the very
// front — the shape the acceptance criterion names.
const bigJournal = (head) => [...head, ...pad(TAIL_64K * 2)];

test('the pending change is emitted even when it is far older than the last 64 KB', () => {
  const head = [
    REAL.firstSighting,
    sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
  ];
  const p = project({ tickets: { 'T-24-05': 'SHIP-5' }, journal: bigJournal(head) });

  // The fixture's GEOMETRY is asserted, so this case cannot pass by accident on
  // a journal that happens to be small.
  const file = path.join(graphOf(p), 'delivery-log.jsonl');
  const size = fs.statSync(file).size;
  const text = fs.readFileSync(file, 'utf8');
  const offset = Buffer.byteLength(text.slice(0, text.indexOf('"T-24-05"')), 'utf8');
  assert.ok(size > TAIL_64K, `fixture must exceed 64 KB, is ${size}`);
  assert.ok(offset < size - TAIL_64K,
    `the pending event must sit OUTSIDE the last 64 KB: offset ${offset}, size ${size}, boundary ${size - TAIL_64K}`);

  const out = plan(p);
  assert.deepEqual(ids(out), ['T-24-05'],
    'a 64 KB tail here would drop this transition SILENTLY — the defect this case exists for');
  assert.equal(out.journal.seeked, false, 'no watermark anywhere means the whole file, not a tail');
  assert.equal(out.journal.bytes_read, size);
});

test('with every subject watermarked the read SEEKS, and still reaches the watermarked event', () => {
  // The anchor is the projected EVENT, not the record's `ts`. It sits ~80 KB
  // from the end of a ~280 KB journal, so the first 64 KB window misses it and
  // the scan STEPS BACK — a real seek, mid-file, and the case that proves the
  // step size is a step and not a bound.
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [
      ...pad(TAIL_64K * 3),
      sc('T-24-05', 'pending', 'pr-open', '2026-09-07T18:00:00.000Z', 44),
      sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
      ...pad(TAIL_64K + 16 * 1024),
    ],
    store: { tickets: { 'T-24-05': { projected_to: 'pr-open', ts: '2026-09-07T18:00:05.000Z' } } },
  });
  const out = plan(p);
  assert.deepEqual(ids(out), ['T-24-05']);
  assert.equal(out.items[0].to, 'merged');
  assert.equal(out.journal.seeked, true, 'a watermarked board seeks rather than reading everything');
  assert.ok(out.journal.bytes_read < out.journal.size,
    `a seek reads LESS than the file: ${out.journal.bytes_read} of ${out.journal.size}`);
});

test('the anchor is the projected EVENT, not the watermark\'s RECORD time', () => {
  // The pin for this script's central claim, and the one alternative design that
  // looks right and is not. `markProjected` stamps RECORD time, which is only an
  // UPPER BOUND on the event it is about: a sync landing between the plan and
  // the record writes an event older than the record that was never projected.
  // Here the record's `ts` is a year past every event in the journal, so a scan
  // that stopped at it would start after the whole file and emit nothing —
  // silently, with `hasProjected` unable to rescue a line that was never read.
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [
      sc('T-24-05', 'pending', 'pr-open', '2026-09-07T18:00:00.000Z', 44),
      sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
      ...pad(TAIL_64K * 3),
    ],
    store: { tickets: { 'T-24-05': { projected_to: 'pr-open', ts: '2027-06-01T00:00:00.000Z' } } },
  });
  const out = plan(p);
  assert.deepEqual(ids(out), ['T-24-05'],
    'a record-time anchor starts past every event here and emits nothing');
  assert.equal(out.items[0].to, 'merged');
});

test('a watermark whose event is not in the journal degrades to reading it all, and does not spin', () => {
  const head = [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)];
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: bigJournal(head),
    // `branched` never appears for this ticket — a hand-seeded store, or a
    // rotated journal.
    store: { tickets: { 'T-24-05': { projected_to: 'branched', ts: '2026-09-07T18:00:05.000Z' } } },
  });
  const out = plan(p);
  assert.deepEqual(ids(out), ['T-24-05']);
  assert.equal(out.journal.seeked, false, 'the walk ends at byte 0, whatever the window holds');
});

test('one unwatermarked subject means the whole file, even beside watermarked ones', () => {
  const head = [
    sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
    sc('T-21-02', 'pending', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
  ];
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5', 'T-21-02': 'SHIP-2' },
    journal: bigJournal(head),
    store: { tickets: { 'T-24-05': { projected_to: 'pr-open', ts: '2026-09-07T18:00:05.000Z' } } },
  });
  const out = plan(p);
  assert.deepEqual(ids(out).sort(), ['T-21-02', 'T-24-05']);
  assert.equal(out.journal.seeked, false);
});

// ── the seek's first line ───────────────────────────────────────────────────

suite('the seek\'s first line: dropped only when the read actually SEEKED');

test('a journal holding ONE event yields that event', () => {
  // stop-gate's recorded defect, reproduced as a guard: dropping the first line
  // unconditionally ate the only event in a short journal — which is every
  // project that has not been running for weeks.
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
  });
  assert.deepEqual(ids(plan(p)), ['T-24-05'],
    'an unconditional lines.shift() empties this fixture — the WITNESSED TAIL MUTATION');
});

test('statusChangesIn drops the leading fragment when it seeked, and keeps it when it did not', () => {
  const whole = `${REAL.branched}\n${REAL.merged}\n`;
  assert.equal(mod.statusChangesIn(whole, false).length, 2);
  assert.equal(mod.statusChangesIn(whole, true).length, 1, 'a seeked read starts mid-line');
  // And a genuinely torn line is skipped rather than fatal, because the tail of
  // a journal being appended to right now is legitimately half-written.
  assert.equal(mod.statusChangesIn(`{"ts":"2026-09-0\n${REAL.merged}\n`, false).length, 1);
});

test('a non-status_change record is never mistaken for one', () => {
  const p = project({
    tickets: { 'T-20-01': 'SHIP-1' },
    journal: [REAL.attempt],
    config: { jira_transitions: { pending: 'To Do', 'pr-open': 'In Progress', merged: 'Done' } },
  });
  assert.deepEqual(plan(p).items, []);
});

// ── unreachable suppression ─────────────────────────────────────────────────

suite('an unreachable report withholds the item until the world moves');

const unreachableStore = (ticket, to, ts, key = 'SHIP-5') => ({
  tickets: {},
  unreachable: { [ticket]: { to, ts, key, offered: 'Start Progress, Close' } },
});

test('an item recorded unreachable at this `to` is NOT re-emitted', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
    store: unreachableStore('T-24-05', 'merged', '2026-09-07T19:35:52.586Z'),
  });
  assert.deepEqual(plan(p).items, [],
    'without this the pair is one tracker call per stuck ticket per round, forever');
});

test('a NEWER status_change for that ticket lifts the block by itself', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [
      sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
      // The board moved: reopened, then merged again.
      sc('T-24-05', 'merged', 'pr-open', '2026-09-08T10:00:00.000Z', 44),
      sc('T-24-05', 'pr-open', 'merged', '2026-09-08T12:00:00.000Z', 44),
    ],
    store: unreachableStore('T-24-05', 'merged', '2026-09-07T19:35:52.586Z'),
  });
  const out = plan(p);
  assert.deepEqual(ids(out), ['T-24-05']);
  assert.equal(out.items[0].ts, '2026-09-08T12:00:00.000Z');
});

test('an unreachable at a DIFFERENT `to` suppresses nothing', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
    store: unreachableStore('T-24-05', 'pr-open', '2026-09-07T19:00:00.000Z'),
  });
  assert.deepEqual(ids(plan(p)), ['T-24-05']);
});

test('an undatable report still lifts when the board reaches a different status', () => {
  const stuck = { to: 'merged', ts: null, key: 'SHIP-5', offered: null };
  assert.equal(mod.unreachableSuppressed(
    { ticket: 'T-24-05', to: 'merged', ts: '2026-09-08T12:00:00.000Z' },
    { unreachable: { 'T-24-05': stuck } }
  ), true, 'a report we cannot date holds only its own `to`');
  assert.equal(mod.unreachableSuppressed(
    { ticket: 'T-24-05', to: 'pr-open', ts: '2026-09-08T12:00:00.000Z' },
    { unreachable: { 'T-24-05': stuck } }
  ), false, 'and lifts the moment the board moves elsewhere');
});

test('the record shape is built HERE, so the writer and the reader cannot disagree', () => {
  const rec = mod.unreachableRecord({ to: 'merged', ts: '2026-09-07T19:35:52.586Z', key: 'SHIP-5', offered: 'Close' });
  assert.deepEqual(rec, { to: 'merged', ts: '2026-09-07T19:35:52.586Z', key: 'SHIP-5', offered: 'Close' });
  assert.equal(mod.UNREACHABLE_KEY, 'unreachable');
  const store = { tickets: {}, [mod.UNREACHABLE_KEY]: { 'T-24-05': rec } };
  assert.deepEqual(mod.unreachableFor('T-24-05', store), rec);
  assert.equal(mod.unreachableFor('T-21-02', store), null);
});

test('a projection that DID land clears the block, because the watermark answers first', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
    store: {
      tickets: { 'T-24-05': { projected_to: 'merged', ts: '2026-09-08T09:00:00.000Z' } },
      unreachable: { 'T-24-05': { to: 'merged', ts: '2026-09-07T19:35:52.586Z', key: 'SHIP-5', offered: null } },
    },
  });
  assert.deepEqual(plan(p).items, [], 'skipped as already projected, which is the same empty answer');
});

// ── the recorder ────────────────────────────────────────────────────────────

suite('the recorder refuses a bare done, and the journal owns the event');

const STORE = 'jira-projection.json';
const JOURNAL = 'delivery-log.jsonl';

// The BYTES, so "unchanged" is a comparison of content and not of existence. A
// refusal that rewrites the store with the same fields would pass an `exists`
// check and still be a write nobody asked for.
const raw = (g, name) => {
  const f = path.join(g, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
const storeOf = (g) => { const s = raw(g, STORE); return s ? JSON.parse(s) : null; };
const events = (g, name) => (raw(g, JOURNAL) || '').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((e) => !name || e.event === name);

// One pending item — `T-24-05 SHIP-5: pr-open -> merged` — which is what every
// case below is about.
const pending = (extra = {}) => project({
  tickets: { 'T-24-05': 'SHIP-5' },
  journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
  ...extra,
});

test('a record with no --transition-id is refused, and the store AND the journal are unchanged', () => {
  // WITNESSED MUTATION (a): delete the `--transition-id` check in
  // `recordProjection` and this record succeeds — the watermark advances on an
  // agent's word, which is the whole thing ADR-008 D5 forbids.
  const p = pending();
  const g = graphOf(p);
  const before = { store: raw(g, STORE), journal: raw(g, JOURNAL) };
  assert.equal(before.store, null, 'nothing projected yet is the normal first state');
  const r = run(g, ['record', 'T-24-05', 'SHIP-5', '--status', 'Done']);
  assert.notEqual(r.status, 0, `must be refused, got ${r.status}: ${r.stdout}`);
  assert.match(r.stderr, /--transition-id/, 'the refusal names the missing flag');
  assert.equal(raw(g, STORE), before.store, 'the watermark store must be untouched');
  assert.equal(raw(g, JOURNAL), before.journal, 'and the journal too — BOTH, not one');
});

test('an EMPTY --transition-id is the same refusal — "" is not evidence either', () => {
  const p = pending();
  const g = graphOf(p);
  const before = raw(g, JOURNAL);
  const r = run(g, ['record', 'T-24-05', 'SHIP-5', '--transition-id', '']);
  assert.notEqual(r.status, 0, 'an empty id must be refused');
  assert.match(r.stderr, /--transition-id/);
  assert.equal(raw(g, STORE), null, 'no watermark');
  assert.equal(raw(g, JOURNAL), before, 'no journal line');
});

test('a record for a ticket with no pending item is refused', () => {
  // Recording a projection nobody asked for is state invented outside the
  // planner, which the next round reads back as a projection that happened.
  const p = project({ tickets: { 'T-24-05': 'SHIP-5' }, journal: [] });
  const g = graphOf(p);
  const before = raw(g, JOURNAL);
  const r = run(g, ['record', 'T-24-05', 'SHIP-5', '--transition-id', '31']);
  assert.notEqual(r.status, 0, 'must be refused');
  assert.match(r.stderr, /no pending projection/);
  assert.equal(raw(g, STORE), null, 'the store stays absent');
  assert.equal(raw(g, JOURNAL), before);
});

test('a record naming a DIFFERENT issue than the pending item is refused', () => {
  const p = pending();
  const g = graphOf(p);
  const r = run(g, ['record', 'T-24-05', 'SHIP-9', '--transition-id', '31']);
  assert.notEqual(r.status, 0, 'must be refused');
  assert.match(r.stderr, /SHIP-5/, 'and it names the issue the item is actually about');
  assert.equal(raw(g, STORE), null);
});

test('a successful record advances the watermark and appends exactly one jira_transition', () => {
  const p = pending();
  const g = graphOf(p);
  const r = run(g, ['record', 'T-24-05', 'SHIP-5', '--transition-id', '31', '--status', 'Done']);
  assert.equal(r.status, 0, r.stderr);

  const rec = storeOf(g).tickets['T-24-05'];
  assert.equal(rec.projected_to, 'merged', 'the watermark is the ITEM\'s `to`');
  assert.equal(rec.transition_id, '31', 'and it records the evidence it demanded');
  assert.equal(rec.key, 'SHIP-5');
  assert.equal(rec.status, 'Done');

  const ev = events(g, 'jira_transition');
  assert.equal(ev.length, 1, `exactly one journal line, got ${ev.length}`);
  assert.deepEqual(
    { ticket: ev[0].ticket, key: ev[0].key, to: ev[0].to, transition_id: ev[0].transition_id, by: ev[0].by },
    { ticket: 'T-24-05', key: 'SHIP-5', to: 'merged', transition_id: '31', by: 'jira-project' }
  );

  // Exactly once: the same record again has nothing pending to be about.
  const again = run(g, ['record', 'T-24-05', 'SHIP-5', '--transition-id', '31', '--status', 'Done']);
  assert.notEqual(again.status, 0, 'the second identical record must be refused');
  assert.match(again.stderr, /no pending projection/);
  assert.equal(events(g, 'jira_transition').length, 1, 'and it appends nothing');
});

test('--status defaults to the item\'s target_status, so the two cannot drift apart', () => {
  const p = pending();
  const g = graphOf(p);
  const r = run(g, ['record', 'T-24-05', 'SHIP-5', '--transition-id', '41']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(storeOf(g).tickets['T-24-05'].status, 'Done');
});

test('record --unreachable leaves the watermark UNMOVED and still writes the failed `to`', () => {
  // BOTH halves in one case, deliberately: storing neither and storing both look
  // identical from the outside until the next round, when one of them is a retry
  // loop making a tracker call per stuck ticket forever.
  const p = pending();
  const g = graphOf(p);
  const r = run(g, ['record', '--unreachable', 'T-24-05', 'SHIP-5',
    '--to', 'merged', '--offered', 'Start Progress, Close']);
  assert.equal(r.status, 0, r.stderr);

  const store = storeOf(g);
  assert.equal(store.tickets['T-24-05'], undefined, 'the transition did not happen: no watermark');
  assert.deepEqual(store.unreachable['T-24-05'], {
    to: 'merged',
    // THE ITEM's timestamp, never the filing time — a filing time is only an
    // upper bound on the event it is about, so a newer sync would be suppressed.
    ts: '2026-09-07T19:35:52.586Z',
    key: 'SHIP-5',
    offered: 'Start Progress, Close',
  });
  assert.equal(events(g, 'jira_transition').length, 0, 'nothing was transitioned, so nothing is journalled');

  // And the report actually suppresses: this is the retry loop closing.
  assert.deepEqual(plan(p).items, [], 'the item is withheld until the board moves');
});

test('record --unreachable with no --to is refused — a report naming no target suppresses nothing', () => {
  const p = pending();
  const g = graphOf(p);
  const r = run(g, ['record', '--unreachable', 'T-24-05', 'SHIP-5', '--offered', 'Close']);
  assert.notEqual(r.status, 0, 'must be refused');
  assert.match(r.stderr, /--to/);
  assert.equal(raw(g, STORE), null, 'and it writes nothing');
});

test('an unknown flag is refused rather than read as the ticket id', () => {
  const p = pending();
  const r = run(graphOf(p), ['record', 'T-24-05', 'SHIP-5', '--transition_id', '31']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag/);
});

test('the pair does not half-commit: a failed journal append rolls the watermark back', () => {
  // WITNESSED ATOMICITY MUTATION: remove the rollback branch in `mutate` and the
  // store below keeps T-24-05 while the journal has no line for it — the next
  // round then believes the issue was moved when nothing recorded that it was.
  //
  // The append is failed for real (the writer throws), not simulated with a flag
  // in the production path: `ci-wait.cjs` has the same invariant about itself,
  // and the case it was written for was a store some accident had left as a
  // directory.
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5', 'T-21-02': 'SHIP-2' },
    journal: [
      sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
      sc('T-21-02', 'pending', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
    ],
    // A store with someone else's watermark already in it, so the rollback has to
    // RESTORE bytes rather than merely delete a file it created.
    store: { tickets: { 'T-21-02': { projected_to: 'pr-open', ts: '2026-08-26T14:30:00.000Z', key: 'SHIP-2' } } },
  });
  const g = graphOf(p);
  const before = { store: raw(g, STORE), journal: raw(g, JOURNAL) };
  assert.ok(before.store.includes('T-21-02'), 'the fixture must start with a real store');

  const realAppend = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error('EACCES: permission denied, open \'delivery-log.jsonl\''); };
  let thrown = null;
  try {
    mod.recordProjection({ ticket: 'T-24-05', key: 'SHIP-5', transition_id: '31' }, g);
  } catch (e) {
    thrown = e;
  } finally {
    fs.appendFileSync = realAppend;
  }

  assert.ok(thrown, 'the act must fail rather than report a success it only half performed');
  assert.match(thrown.message, /rolled back/, 'and say so');
  assert.equal(raw(g, STORE), before.store,
    'the watermark must be exactly as it was — a watermark with no journal line is the half-commit');
  assert.equal(raw(g, JOURNAL), before.journal, 'and the journal is untouched');
  // The proof that the rollback restored rather than emptied: the unrelated
  // watermark still stands, and the ticket is still pending work.
  assert.equal(storeOf(g).tickets['T-21-02'].projected_to, 'pr-open');
  assert.deepEqual(ids(plan(p)), ['T-24-05'], 'the item is still offered, which is the honest state');
});

// ── degenerate inputs ───────────────────────────────────────────────────────

suite('nothing to do is the common case, and it is quiet');

test('no journal at all is no work, not an error', () => {
  const p = project({ tickets: { 'T-24-05': 'SHIP-5' }, journal: null });
  const out = plan(p);
  assert.deepEqual(out.items, []);
  const cli = run(graphOf(p), ['plan', '--json']);
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
});

test('a graph with no tickets.json projects nothing and says which directory it looked in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-jira-bare-'));
  const g = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(g, { recursive: true });
  // The projection is ON, so the empty answer is about the missing graph and
  // not about an off-switch answering first.
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ pipeline: { jira_transitions: { merged: 'Done' } } }));
  const out = mod.planItems(g);
  assert.deepEqual(out.items, []);
  assert.match(out.reason, /tickets\.json/);
  assert.match(out.reason, new RegExp(g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ── the CLI ─────────────────────────────────────────────────────────────────

suite('the CLI surface deliver.md calls');

test('plan --json prints the work list, plan prints it for a person', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5', 'T-21-02': 'SHIP-2' },
    journal: [
      sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44),
      sc('T-21-02', 'pending', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
    ],
  });
  const j = run(graphOf(p), ['plan', '--json']);
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(j.json.items.map((i) => i.ticket).sort(), ['T-21-02', 'T-24-05']);
  const h = run(graphOf(p), ['plan']);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /2 pending projections/);
  assert.match(h.stdout, /T-24-05 SHIP-5: pr-open -> merged/);
  assert.match(h.stdout, /"Done"/);
});

test('the empty answer is a REPORT on stdout, not a warning on stderr', () => {
  const p = project({ tickets: { 'T-24-05': null }, journal: [] });
  const h = run(graphOf(p), ['plan']);
  assert.equal(h.status, 0);
  assert.equal(h.stderr, '');
  assert.match(h.stdout, /nothing to project/);
});

test('--graph is honoured in ANY position, the one spelling the sibling stores use', () => {
  const p = project({
    tickets: { 'T-24-05': 'SHIP-5' },
    journal: [sc('T-24-05', 'pr-open', 'merged', '2026-09-07T19:35:52.586Z', 44)],
  });
  const r = spawnSync(process.execPath, [SCRIPT, '--graph', graphOf(p), 'plan', '--json'],
    { encoding: 'utf8', cwd: os.tmpdir(), timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).items.map((i) => i.ticket), ['T-24-05']);
});

test('the usage line names plan, so an operator who ran the old build is told it exists', () => {
  const p = project({});
  const r = run(graphOf(p), ['transition']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /read\|plan/);
});

// ── the negative pin, on this file's own source ─────────────────────────────

suite('plan touches no network — asserted as a SOURCE TOKEN sweep');

test('no client, no socket, no subprocess anywhere in jira-project.cjs', () => {
  // METHOD: a source token assertion, not a sandboxed run. It is the stronger of
  // the two available here, because a run with no network reachable proves only
  // that THIS path made no call — a token sweep covers every path, including the
  // ones no fixture exercised. ADR-008 D4 puts the acting half in an agent, and
  // the day a "small helper" appears in this file is the day the projection
  // grows a credential.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const token of [/\bfetch\b/, /https?:/, /\bmcp\b/i, /\bgh\b/, /\bcurl\b/,
    /\bspawnSync\b/, /\bexecSync\b/, /\bchild_process\b/, /XMLHttpRequest/,
    /require\(['"](https?|net|tls|dgram)['"]\)/]) {
    assert.ok(!token.test(src), `jira-project.cjs must not contain ${token} — the planner is three local files in, a work list out`);
  }
});

test('the module exports the pieces T-29-05 has to reuse rather than re-spell', () => {
  for (const name of ['planItems', 'unreachableFor', 'unreachableRecord', 'unreachableSuppressed',
    'compareStatus', 'hasProjected', 'markProjected', 'UNREACHABLE_KEY']) {
    assert.ok(mod[name] !== undefined, `${name} must be exported`);
  }
});

done();
