'use strict';

// A fresh subagent per attempt is correct for context hygiene, and it is exactly
// why attempt 3 can re-propose attempt 1's failed fix (ADR-001 D5). The remedy is
// this reader: the journal already HOLDS what was tried, so the record is not a
// new store but a rendering of it — per ticket, chronological, formatted to be
// pasted into the next fixer's prompt.
//
// What these tests pin, because each was a way the record could quietly lie:
//   - another ticket's attempt rendered into this ticket's history would hand the
//     fixer a "failed hypothesis" from work it never touched;
//   - an event type outside the seven (reuse_scan, status_change, merge) is not
//     an attempt at a fix and must not read as one;
//   - a partial event (no signature, no hypothesis — every event written before
//     T-20-01/T-20-06) is DATA, not an error: an empty or half-filled history is
//     the normal state of a young ticket;
//   - a hypothesis is a sentence with spaces in it, so it has to survive as one
//     field rather than shredding the line it lives on;
//   - and a missing graph refuses exactly as log-event does, because a history
//     read out of the wrong journal is worse than no history at all.
//
// ADR-002 D8 adds the COUNT to the record: the attempt number lived only in the
// session, so `attempts > max_attempts` restarted at 1 in every resumed run. The
// journal already held every attempt, so the number is a count away — and the one
// round it must not charge is a quarantined flake (ADR-001 D3, deliver.md:491:
// "`outcome=flake` is logged at an UNCHANGED `n`").

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'attempt-history.cjs'
);

function run(cwd, args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

// Deliberately NOT in ts order in the file: the journal is append-only, but a
// cross-repo agent and the main loop both write to it, so a late-arriving line is
// possible and the record must still read chronologically.
const JOURNAL = [
  { ts: '2026-08-01T10:00:00Z', event: 'attempt', ticket: 'T-01-01', pr: 11, n: 1, role: 'ci-fix', model: 'sonnet', outcome: 'pushed' },
  { ts: '2026-08-01T10:05:00Z', event: 'attempt', ticket: 'T-99-99', pr: 42, n: 1, role: 'ci-fix', model: 'opus', outcome: 'pushed', hypothesis: 'someone else problem' },
  { ts: '2026-08-01T10:10:00Z', event: 'reuse_scan', ticket: 'T-01-01', hits: 2, verdict: 'fresh' },
  { ts: '2026-08-01T10:20:00Z', event: 'fix_round', ticket: 'T-01-01', pr: 11, outcome: 'no-op', pushed: false },
  { ts: '2026-08-01T10:40:00Z', event: 'escalation', ticket: 'T-01-01', pr: 11, reason: 'needs a schema migration outside scope', by: 'escalation-record' },
  { ts: '2026-08-01T10:30:00Z', event: 'attempt', ticket: 'T-01-01', pr: 11, n: 2, role: 'ci-fix', model: 'opus', signature: 'ab12cd34', outcome: 'pushed', hypothesis: 'off-by-one in the pagination cursor' },
];

function scratch({ journal = JOURNAL, malformed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-history-'));
  const project = path.join(dir, 'project');
  const borrowed = path.join(dir, 'borrowed');
  const graph = path.join(project, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.mkdirSync(borrowed, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), '{"tickets":{}}');
  if (journal) {
    const lines = journal.map((e) => JSON.stringify(e));
    // A truncated line from a killed writer must not take the whole record down.
    if (malformed) lines.splice(2, 0, '{"ts":"2026-08-01T10:0');
    fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'), lines.join('\n') + '\n');
  }
  return { dir, project, borrowed, graph };
}

const textLines = (out) => out.split('\n').filter(Boolean);
// The first line is the counter (`attempts=… next_n=…`); the event lines follow.
const eventLines = (out) => textLines(out).slice(1);

suite('attempt-history — prior attempts are an input, not a memory');

test('renders only this ticket\'s repair events, oldest first', () => {
  const { project } = scratch();
  const r = run(project, ['T-01-01']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = eventLines(r.stdout);
  assert.strictEqual(out.length, 4, `expected 4 event lines, got:\n${r.stdout}`);
  assert.ok(/^attempt /.test(out[0]), out[0]);
  assert.ok(/^fix_round /.test(out[1]), out[1]);
  assert.ok(/^attempt /.test(out[2]), out[2]);
  assert.ok(/^escalation /.test(out[3]), out[3]);
  // n=1 before n=2 — ts order, not file order.
  assert.ok(/n=1\b/.test(out[0]) && /n=2\b/.test(out[2]), r.stdout);
  assert.ok(!/T-99-99|someone else problem/.test(r.stdout), 'another ticket\'s attempt leaked in');
  assert.ok(!/reuse_scan/.test(r.stdout), 'reuse_scan is not an attempt at a fix');
});

test('fields render when present and are simply absent when they are not', () => {
  const { project } = scratch();
  const out = eventLines(run(project, ['T-01-01']).stdout);
  const first = out[0];
  const second = out[2];
  assert.ok(/role=ci-fix/.test(first) && /model=sonnet/.test(first) && /outcome=pushed/.test(first), first);
  assert.ok(!/signature=/.test(first), 'an event written before signatures existed must render without one');
  assert.ok(!/hypothesis=/.test(first), 'and without a hypothesis — partial history is data, not an error');
  assert.ok(/signature=ab12cd34/.test(second), second);
  assert.ok(/escalation .*reason=/.test(out[3]), out[3]);
});

test('a hypothesis is a sentence, and survives as one field', () => {
  const { project } = scratch();
  const line = eventLines(run(project, ['T-01-01']).stdout).find((l) => /hypothesis=/.test(l));
  assert.ok(line, 'the hypothesis line vanished');
  assert.ok(
    /hypothesis="off-by-one in the pagination cursor"/.test(line),
    `a multi-word value must be quoted so the line stays one record: ${line}`
  );
  assert.strictEqual(line.split('\n').length, 1, 'one event, one line');
});

test('--json hands back the raw events, filtered the same way', () => {
  const { project } = scratch();
  const r = run(project, ['T-01-01', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const events = JSON.parse(r.stdout).events;
  assert.strictEqual(events.length, 4);
  assert.deepStrictEqual(events.map((e) => e.event), ['attempt', 'fix_round', 'attempt', 'escalation']);
  assert.strictEqual(events[0].ts, '2026-08-01T10:00:00Z', 'raw means raw — ts included');
  assert.strictEqual(events[2].hypothesis, 'off-by-one in the pagination cursor');
  assert.ok(events.every((e) => e.ticket === 'T-01-01'));
});

test('--limit keeps the most RECENT n, still oldest-first', () => {
  const { project } = scratch();
  const out = eventLines(run(project, ['T-01-01', '--limit', '2']).stdout);
  assert.strictEqual(out.length, 2, out.join('\n'));
  assert.ok(/^attempt .*n=2/.test(out[0]), `the newest attempt, not the oldest: ${out[0]}`);
  assert.ok(/^escalation /.test(out[1]), out[1]);
});

test('a fresh ticket is the normal case: a line, and exit 0', () => {
  const { project } = scratch();
  const r = run(project, ['T-77-01']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/no prior attempts recorded for T-77-01/.test(r.stdout), r.stdout);
});

test('a fresh ticket in --json is an empty events array, never prose', () => {
  const { project } = scratch();
  const r = run(project, ['T-77-01', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepStrictEqual(got.events, [], 'a JSON consumer must not be handed a sentence');
  assert.strictEqual(got.attempts, 0);
  assert.strictEqual(got.next_n, 1, 'a ticket nobody has attempted starts at 1');
});

// ── the attempt NUMBER, derived from the journal ────────────────────────────
// The babysit loop used to keep `attempts` in the session, so a resumed run
// restarted the ladder and the `attempts > max_attempts` backstop at 1 — the
// ticket that had already burned four rounds got five more. `next_n` is the
// exact key deliver.md names, so it is pinned by name here.

test('--json reports how many attempts are on record, and the next number', () => {
  const { project } = scratch();
  const got = JSON.parse(run(project, ['T-01-01', '--json']).stdout);
  assert.strictEqual(got.attempts, 2, 'two `attempt` events for this ticket');
  assert.strictEqual(got.next_n, 3, 'so the next round is n=3, not n=1');
  assert.strictEqual(got.ticket, 'T-01-01');
});

test('a resumed session continues at N+1 — that is the whole point', () => {
  const { project, graph } = scratch({ journal: null });
  const rounds = [1, 2, 3, 4].map((n) => ({
    ts: `2026-08-01T1${n}:00:00Z`, event: 'attempt', ticket: 'T-01-01', pr: 11, n,
    role: 'ci-fix', model: 'sonnet', signature: 'aaaa', outcome: 'pushed',
  }));
  fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'),
    rounds.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const got = JSON.parse(run(project, ['T-01-01', '--json']).stdout);
  assert.strictEqual(got.attempts, 4);
  assert.strictEqual(got.next_n, 5, 'a fresh session must not hand the ticket five more rounds');
});

test('a quarantined flake is NOT charged — the number does not move', () => {
  // ADR-001 D3 and deliver.md:491: `outcome=flake` is logged at an UNCHANGED
  // `n`, because a failure nobody caused is not an attempt. A raw count of
  // `attempt` events would charge it and contradict the file that says so.
  const { project } = scratch({
    journal: [
      { ts: '2026-08-01T10:00:00Z', event: 'attempt', ticket: 'T-01-01', n: 1, outcome: 'pushed', signature: 'aaaa' },
      { ts: '2026-08-01T10:10:00Z', event: 'attempt', ticket: 'T-01-01', n: 2, outcome: 'flake', signature: 'aaaa' },
      { ts: '2026-08-01T10:20:00Z', event: 'attempt', ticket: 'T-01-01', n: 2, outcome: 'pushed', signature: 'bbbb' },
    ],
    malformed: false,
  });
  const got = JSON.parse(run(project, ['T-01-01', '--json']).stdout);
  assert.strictEqual(got.attempts, 2, 'two charged rounds, not three');
  assert.strictEqual(got.next_n, 3);
  assert.strictEqual(got.events.length, 3, 'the flake round is still RENDERED — it is evidence');
});

test('another ticket\'s attempts are not this ticket\'s number either', () => {
  const { project } = scratch();
  const got = JSON.parse(run(project, ['T-99-99', '--json']).stdout);
  assert.strictEqual(got.attempts, 1);
  assert.strictEqual(got.next_n, 2);
});

test('--limit trims what is SHOWN and never what is counted', () => {
  // The count is the backstop's input; a display flag must not lower it, or
  // `attempts > max_attempts` becomes a function of how much was printed.
  const { project } = scratch();
  const got = JSON.parse(run(project, ['T-01-01', '--json', '--limit', '1']).stdout);
  assert.strictEqual(got.events.length, 1);
  assert.strictEqual(got.attempts, 2, 'the record is the journal, not the window');
  assert.strictEqual(got.next_n, 3);
});

test('the human rendering prints the number once, at the top', () => {
  const { project } = scratch();
  const out = textLines(run(project, ['T-01-01']).stdout);
  assert.strictEqual(out[0], 'attempts=2 next_n=3', out.join('\n'));
  assert.strictEqual(out.filter((l) => /next_n=/.test(l)).length, 1, 'once — not per event');
});

test('a fresh ticket still says so, under an honest next_n=1', () => {
  const { project } = scratch();
  const out = textLines(run(project, ['T-77-01']).stdout);
  assert.strictEqual(out[0], 'attempts=0 next_n=1', out.join('\n'));
  assert.ok(/no prior attempts recorded for T-77-01/.test(out[1]), out.join('\n'));
});

test('no journal at all reads as no history, not as a failure', () => {
  const { project } = scratch({ journal: null });
  const r = run(project, ['T-01-01']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/no prior attempts recorded/.test(r.stdout), r.stdout);
});

test('no graph and no --graph refuses, naming the way out', () => {
  const { borrowed } = scratch();
  const r = run(borrowed, ['T-01-01']);
  assert.notStrictEqual(r.status, 0, 'reading a history out of the wrong journal is worse than none');
  assert.ok(/no ticket graph/.test(r.stderr), r.stderr);
  assert.ok(/--graph/.test(r.stderr), 'the error must name the way out');
  assert.strictEqual(fs.existsSync(path.join(borrowed, '.planning')), false,
    'a reader must not create anything anywhere');
});

test('--graph followed by another flag is a usage error, not a silent history from nowhere', () => {
  // Copilot's finding on this PR: the flag-stripping loop skips exactly one
  // token after `--graph` unconditionally, so `--graph --json` used to read
  // "--json" as the directory — disabling JSON mode AND resolving GRAPH_DIR to
  // a nonexistent path outside cwd/.planning, which reported an empty history
  // instead of refusing.
  const { borrowed } = scratch();
  const r = run(borrowed, ['--graph', '--json', 'T-01-01']);
  assert.notStrictEqual(r.status, 0, 'a flag is not a directory value');
  assert.ok(/--graph/.test(r.stderr), r.stderr);
  assert.strictEqual(fs.existsSync(path.join(borrowed, '.planning')), false);
});

test('--graph at the very end with no value is a usage error, not a silent cwd fallback', () => {
  const { borrowed } = scratch();
  const r = run(borrowed, ['T-01-01', '--graph']);
  assert.notStrictEqual(r.status, 0, 'a missing value must not be treated as an explicit graph');
  assert.ok(/--graph/.test(r.stderr), r.stderr);
});

test('--graph works from anywhere, in any position', () => {
  const { borrowed, graph } = scratch();
  // FIRST, deliberately: positional parsing that only tolerates a trailing flag
  // would read "--graph" as the ticket id.
  const r = run(borrowed, ['--graph', graph, 'T-01-01']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(eventLines(r.stdout).length, 4, r.stdout);
});

test('SHIPYARD_GRAPH_DIR does the same without touching the command line', () => {
  const { borrowed, graph } = scratch();
  const r = run(borrowed, ['T-01-01'], { SHIPYARD_GRAPH_DIR: graph });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/signature=ab12cd34/.test(r.stdout), r.stdout);
});

test('an explicit graph with nothing in it is empty history, not a refusal', () => {
  const { dir } = scratch();
  const empty = path.join(dir, 'elsewhere', 'graph');
  fs.mkdirSync(empty, { recursive: true });
  const r = run(dir, ['T-01-01', '--graph', empty]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/no prior attempts recorded/.test(r.stdout), r.stdout);
});

test('a missing ticket id reports usage', () => {
  const { project } = scratch();
  const r = run(project, []);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.ok(/usage:/.test(r.stderr), r.stderr);
});

test('a nonsense --limit reports usage rather than silently showing everything', () => {
  const { project } = scratch();
  const r = run(project, ['T-01-01', '--limit', 'lots']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.ok(/usage:|--limit/.test(r.stderr), r.stderr);
});

suite('attempt-history — the depth a round applied reads beside its model');

// ADR-007 D2. The next fixer's question is not only "what was tried" but "how
// hard was it tried" — `repeat_exhausted` rests on exactly that, and it is read
// off these rows. An unknown key already rendered, but at the TAIL, after the
// quoted hypothesis sentence, which is where a field goes to be missed. `effort`
// and `effort_applied` are one thought with `model`, so they render there.

const DEPTH_JOURNAL = [
  { ts: '2026-09-01T10:00:00Z', event: 'attempt', ticket: 'T-28-02', pr: 7, n: 1, role: 'ci-fix', model: 'opus', signature: 'aaaa', outcome: 'pushed' },
  { ts: '2026-09-01T11:00:00Z', event: 'attempt', ticket: 'T-28-02', pr: 7, n: 2, role: 'ci-fix', model: 'opus', effort: 'max', effort_applied: 'max', signature: 'aaaa', outcome: 'pushed', hypothesis: 'the fixture seeds the row it asks about' },
];

test('effort and effort_applied render right after the model, before the PR', () => {
  const { project } = scratch({ journal: DEPTH_JOURNAL, malformed: false });
  const r = run(project, ['T-28-02']);
  assert.strictEqual(r.status, 0, r.stderr);
  const line = eventLines(r.stdout).find((l) => /n=2\b/.test(l));
  assert.ok(line, `the second round vanished:\n${r.stdout}`);
  assert.ok(
    /model=opus effort=max effort_applied=max pr=7/.test(line),
    `the depth belongs beside the model, not past the hypothesis: ${line}`
  );
});

test('a round that recorded no depth renders none — absence is the honest row', () => {
  const { project } = scratch({ journal: DEPTH_JOURNAL, malformed: false });
  const line = eventLines(run(project, ['T-28-02']).stdout).find((l) => /n=1\b/.test(l));
  assert.ok(line, 'the first round vanished');
  assert.ok(!/effort/.test(line), `nothing measured means nothing rendered: ${line}`);
});

done();
