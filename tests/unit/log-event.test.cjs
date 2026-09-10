'use strict';

// The journal is only readable beside its graph — pipeline-stats requires
// tickets.json next to it. So WHERE an event lands is not cosmetic: an event
// filed elsewhere is uncounted, and the directory it creates pollutes whatever
// repository the agent happened to be standing in. That is not hypothetical —
// a ci-fix on a cross-repo ticket left a one-event journal inside a borrowed
// checkout, invisible to every metric that mattered.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'log-event.cjs'
);

function run(cwd, args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-logevent-'));
  const project = path.join(dir, 'project');
  const borrowed = path.join(dir, 'borrowed');
  fs.mkdirSync(path.join(project, '.planning', 'graph'), { recursive: true });
  fs.mkdirSync(borrowed, { recursive: true });
  fs.writeFileSync(path.join(project, '.planning', 'graph', 'tickets.json'), '{"tickets":{}}');
  return { dir, project, borrowed, graph: path.join(project, '.planning', 'graph') };
}

const lines = (g) => {
  const f = path.join(g, 'delivery-log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

// One sha format, used by every fixture below: a head is the full forty
// characters, because that is what `gate_status` records and a reader holding
// only the journal cannot lengthen an abbreviation.
const FULL = 'a'.repeat(39) + '1';

suite('log-event — the journal lands beside its graph');

test('logging from a checkout with no graph refuses, and creates nothing', () => {
  const { borrowed } = scratch();
  const r = run(borrowed, ['attempt', 'ticket=T-12-03', 'role=ci-fix']);
  assert.notStrictEqual(r.status, 0, 'it must fail rather than start a second journal');
  assert.ok(/no ticket graph/.test(r.stderr), r.stderr);
  assert.ok(/--graph/.test(r.stderr), 'the error must name the way out');
  assert.strictEqual(fs.existsSync(path.join(borrowed, '.planning')), false,
    'refusing must not leave a .planning/ behind in a borrowed repository');
});

test('logging from the project writes next to the graph', () => {
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-01-01', 'role=ci-fix']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(lines(graph).length, 1);
});

test('--graph files the event with the project, from anywhere, in any position', () => {
  const { borrowed, graph } = scratch();
  // Deliberately FIRST: positional parsing that only tolerates a trailing flag
  // would swallow it as the event name.
  const r = run(borrowed, ['--graph', graph, 'attempt', 'ticket=T-12-03', 'role=ci-fix']);
  assert.strictEqual(r.status, 0, r.stderr);
  const rec = JSON.parse(lines(graph)[0]);
  assert.strictEqual(rec.event, 'attempt');
  assert.strictEqual(rec.ticket, 'T-12-03');
  assert.strictEqual('--graph' in rec, false, 'the flag is ours, not telemetry');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, graph), false);
});

test('SHIPYARD_GRAPH_DIR does the same without touching the command line', () => {
  const { borrowed, graph } = scratch();
  const r = run(borrowed, ['attempt', 'ticket=T-12-04'], { SHIPYARD_GRAPH_DIR: graph });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).ticket, 'T-12-04');
});

test('events the scripts own are refused, not duplicated', () => {
  const { project, graph } = scratch();
  // `sentinel.cjs merge` and `state-sync.cjs` append these themselves, so a
  // hand-written one is always a duplicate — and a duplicate is not harmless:
  // two merges logged twice in one morning inflated "sentinel landed N" and put
  // an empty base in the summary, because the hand-written copy carries neither
  // `by` nor `base`. deliver.md had forbidden it in prose the whole time.
  for (const ev of ['merge', 'status_change']) {
    const r = run(project, [ev, 'ticket=T-01-01', 'pr=1']);
    assert.notStrictEqual(r.status, 0, `${ev} must be refused`);
    assert.ok(/refusing to add a duplicate/.test(r.stderr), r.stderr);
    assert.ok(/sentinel\.cjs|state-sync\.cjs/.test(r.stderr), 'the error must name the real writer');
  }
  // `escalation` is refused for a DIFFERENT defect — it would record the fact
  // without parking the ticket, leaving the next session a metric and no verdict.
  // So it must not borrow the duplicate wording: that would send the reader
  // looking for a second record that was never written.
  const esc = run(project, ['escalation', 'ticket=T-01-01', 'pr=1']);
  assert.notStrictEqual(esc.status, 0, 'escalation must be refused');
  assert.ok(/half-recorded/.test(esc.stderr), esc.stderr);
  assert.ok(!/duplicate/.test(esc.stderr), 'and must NOT call it a duplicate');
  assert.ok(/escalation-record\.cjs mark/.test(esc.stderr), 'it must name the command that does both');
  assert.strictEqual(lines(graph).length, 0, 'nothing may reach the journal');
});

test('a bad event name still reports usage, not the graph error', () => {
  const { project } = scratch();
  const r = run(project, ['NotAnEvent']);
  assert.strictEqual(r.status, 2);
  assert.ok(/usage:/.test(r.stderr), r.stderr);
});

test('the plan_defect verdict is refused for the escalation reason, not the duplicate one', () => {
  // Journalling it by hand records the CONCLUSION without parking the ticket —
  // and without the plan hash that lets the park lift when the plan is
  // re-decomposed. The next session inherits a metric and no verdict.
  const { project, graph } = scratch();
  const r = run(project, ['plan_defect', 'ticket=T-20-03', 'pr=1']);
  assert.notStrictEqual(r.status, 0, 'must be refused');
  assert.ok(/half-recorded/.test(r.stderr), r.stderr);
  assert.ok(!/duplicate/.test(r.stderr), 'an incomplete act, not a duplicate');
  assert.ok(/escalation-record\.cjs mark-plan-defect/.test(r.stderr),
    'it must name the command that parks AND journals');
  assert.strictEqual(lines(graph).length, 0, 'nothing may reach the journal');
});

test('the flake trio is refused — those events ARE the quarantine store', () => {
  // failure-signature.cjs has no store of its own: `verdict` reads these lines
  // back. A hand-written one is therefore neither a duplicate nor half an act —
  // it is invented state, outside the lock and outside the (ticket, signature,
  // head) bookkeeping the rules match on, and the loop would believe it.
  const { project, graph } = scratch();
  for (const ev of ['flake', 'flake_rerun', 'flake_lift']) {
    const r = run(project, [ev, 'ticket=T-20-01', 'signature=9f2a', `head=${FULL}`]);
    assert.notStrictEqual(r.status, 0, `${ev} must be refused`);
    assert.ok(/failure-signature\.cjs/.test(r.stderr), `${ev}: the error must name the owning script`);
    assert.ok(!/duplicate/.test(r.stderr), `${ev}: there is no second record to duplicate`);
  }
  assert.strictEqual(lines(graph).length, 0, 'nothing may reach the journal');
});

test('the dispatch event is refused — marking and journalling are ONE act', () => {
  // The claim this repository got WRONG once, which is why the test is the
  // record: T-25-05's plan asserted that `log-event.cjs` already refused
  // `dispatch`; a reviewer reproduced the opposite by running it. A hand-written
  // line lands with no `by`, no durable record for the front to read, and none of
  // `dispatch-record.cjs mark`'s validation — so the audit trail that store exists
  // to make trustworthy can be written around, and the front hands the ticket
  // straight back to a run that has already dispatched it.
  const { project, graph } = scratch();
  const r = run(project, ['dispatch', 'ticket=T-25-05', 'role=executor', 'model=opus']);
  assert.notStrictEqual(r.status, 0, 'dispatch must be refused');
  assert.ok(/half-recorded/.test(r.stderr), r.stderr);
  assert.ok(!/duplicate/.test(r.stderr), 'an incomplete act, not a duplicate');
  assert.ok(/dispatch-record\.cjs mark/.test(r.stderr), 'it must name the command that does both');
  assert.strictEqual(lines(graph).length, 0, 'nothing may reach the journal');
});

test('the jira_transition event is refused — the watermark and the line are ONE act', () => {
  // A hand-written line records that somebody's issue was moved and leaves
  // `jira-projection.json` untouched, so the planner offers the identical item
  // next round and the agent transitions the issue a SECOND time — on a board
  // outside this repository, where nothing here can undo it. It is also the one
  // line that would carry a `transition_id` nobody checked, which is the evidence
  // ADR-008 D5 exists to demand.
  const { project, graph } = scratch();
  const r = run(project, ['jira_transition', 'ticket=T-29-05', 'key=SHIP-5', 'to=merged', 'transition_id=31']);
  assert.notStrictEqual(r.status, 0, 'jira_transition must be refused');
  assert.ok(/half-recorded/.test(r.stderr), r.stderr);
  assert.ok(!/duplicate/.test(r.stderr), 'an incomplete act, not a duplicate');
  assert.ok(/jira-project\.cjs record/.test(r.stderr), 'it must name the command that does both');
  assert.ok(/--transition-id/.test(r.stderr), 'and the flag that carries the evidence');
  assert.ok(/--to <item-to>/.test(r.stderr), 'and the status of the item actually performed');
  assert.ok(/watermark/i.test(r.stderr), 'and the half a hand-written line skips');
  assert.strictEqual(lines(graph).length, 0, 'nothing may reach the journal');
});

suite('log-event — one sha format: the full forty characters');

// `gate_status` records a head as the full forty and a reader that only has the
// journal cannot lengthen an abbreviation, so the two formats can never be
// compared. Measured in this project's own journal before the rule existed:
// `head` appeared at 40, 7 AND 6 characters across `attempt`, `base_merge` and
// `arch_review` — and ADR-002 D5 binds an architecture verdict to the head it
// judged, so the first reader to compare one of those against a `headRefOid`
// gets a false mismatch, which is the failure that gate exists to prevent.


test('a full sha is accepted and stored as the forty characters it was given', () => {
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-27-05', 'pr=1', `head=${FULL}`]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).head, FULL);
});

test('an abbreviated sha is REFUSED — never padded, never accepted', () => {
  const { project, graph } = scratch();
  for (const short of ['deadbee', '9f2ab1c', 'deadbe', FULL.slice(0, 39)]) {
    const r = run(project, ['attempt', 'ticket=T-27-05', `head=${short}`]);
    assert.notStrictEqual(r.status, 0, `"${short}" must be refused`);
    assert.ok(/head/.test(r.stderr), `the refusal names the key: ${r.stderr}`);
    assert.ok(/40/.test(r.stderr), `and the format it wants: ${r.stderr}`);
    assert.ok(/rev-parse/.test(r.stderr), `and the command that produces one: ${r.stderr}`);
  }
  assert.strictEqual(lines(graph).length, 0, 'and nothing reaches the journal');
});

test('a sha is normalised to lower case, because two spellings do not compare', () => {
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-27-05', `head=${FULL.toUpperCase()}`]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).head, FULL, 'stored lower-cased');
});

test('a 40-digit sha stays a STRING — the number coercion would destroy it', () => {
  // `coerce` turns a decimal run into a Number, and a forty-digit one JSON-encodes
  // as 1.1111111111111111e+39: the field survives as a value nothing can match a
  // head against. Validating the raw text and writing it verbatim is what keeps
  // the sha rule from creating the loss it exists to prevent.
  const { project, graph } = scratch();
  const digits = '1'.repeat(40);
  const r = run(project, ['attempt', 'ticket=T-27-05', `head=${digits}`]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).head, digits);
});

test('a short hash that is NOT a sha is untouched — the rule is keyed, not guessed', () => {
  // `signature` is failure-signature.cjs's four hex characters and appears on
  // nineteen journal lines. A rule that matched hex-looking VALUES, or key names
  // by pattern, would refuse every one of them.
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-27-05', 'signature=9f2a', 'base=epic/27-x', 'n=2']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).signature, '9f2a');
});

test('an empty head is absence, not a bad sha — the declared-field warning owns it', () => {
  const { project, graph } = scratch();
  const r = run(project, ['base_merge', 'ticket=T-27-05', 'pr=1', 'base=epic/27-x', 'head=']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/WARNING/.test(r.stderr), r.stderr);
  assert.strictEqual(lines(graph).length, 1);
});

suite('log-event — base_merge is a declared event, and never an attempt');

// The guard's base-merge push had no journal event of its own: logging it as
// `attempt` would have charged a mechanical merge to the ticket's REPAIR record,
// so it went out under an ad-hoc slug instead. Declaring it costs nothing and
// buys one name every reader already knows.

const BASE_MERGE = ['base_merge', 'ticket=T-24-06', 'pr=42', 'base=epic/24-x', `head=${FULL}`];

test('base_merge is accepted and written with the four fields that make it readable', () => {
  const { project, graph } = scratch();
  const r = run(project, BASE_MERGE);
  assert.strictEqual(r.status, 0, r.stderr);
  const rec = JSON.parse(lines(graph)[0]);
  assert.strictEqual(rec.event, 'base_merge');
  assert.strictEqual(rec.ticket, 'T-24-06');
  assert.strictEqual(rec.pr, 42);
  assert.strictEqual(rec.base, 'epic/24-x');
  assert.strictEqual(rec.head, FULL);
});

test('a base_merge missing a declared field is logged, and warned about', () => {
  // Same rule as an unknown `role` right below it in the script: telemetry must
  // not lose a real event over its label, but it stops being silent. A
  // base_merge with no `base` cannot be read back as "which base moved in".
  const { project, graph } = scratch();
  const r = run(project, ['base_merge', 'ticket=T-24-06', 'pr=42', `head=${FULL}`]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/WARNING/.test(r.stderr), r.stderr);
  assert.ok(/base/.test(r.stderr), 'the warning must name the missing field');
  assert.strictEqual(lines(graph).length, 1, 'and the event is still recorded');
});

test('attempt-history does not charge a mechanical merge to the repair record', () => {
  const { project } = scratch();
  assert.strictEqual(run(project, BASE_MERGE).status, 0);
  const AH = path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'attempt-history.cjs'
  );
  const h = spawnSync('node', [AH, 'T-24-06', '--json'], { cwd: project, encoding: 'utf8' });
  assert.strictEqual(h.status, 0, h.stderr);
  const out = JSON.parse(h.stdout);
  assert.strictEqual(out.attempts, 0, 'a base merge is not a repair attempt');
  assert.strictEqual(out.next_n, 1);
  assert.deepStrictEqual(out.events, [], 'and it is not rendered to the next fixer as one');
});

suite('log-event — `effort_applied` is the depth an escalation rests on');

// ADR-007 D2. `repeat_exhausted` claims the deeper effort has already been spent
// on one failure signature, and the only thing that can prove it is the attempt
// row for the round that spent it. So the field is part of THIS writer's
// vocabulary, checked against the same `EFFORTS` list `dispatch-record.cjs`
// checks `--effort-applied` against — one vocabulary, two writers, or the rows
// cannot be read together.

test('an effort level is recorded verbatim, and quietly', () => {
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-28-02', 'n=2', 'role=ci-fix',
    'signature=9f2a', 'effort_applied=max']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).effort_applied, 'max');
  assert.ok(!/WARNING/.test(r.stderr), `a valid level must not be warned about: ${r.stderr}`);
});

test('`unknown` is a legitimate value — the honest record of a spawn that carried no effort', () => {
  // The Agent tool has no `effort` parameter, so an Agent-dispatched fixer runs at
  // the session's own depth whatever the ladder chose. `unknown` says exactly
  // that, and the verdict reads it as no evidence — which is why it must be
  // accepted here rather than warned into looking like a mistake.
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-28-02', 'n=2', 'effort_applied=unknown']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).effort_applied, 'unknown');
  assert.ok(!/WARNING/.test(r.stderr), r.stderr);
});

test('a value outside the vocabulary is warned about — and the attempt is still charged', () => {
  // Warned, never refused. A refusal loses the whole `attempt` row, and that row
  // is what charges the attempt: `attempt-history.cjs` derives `next_n` from it,
  // so a lost row freezes the counter the oscillation backstop reads and the loop
  // gains rounds it never spends. The value is kept as written — the reader's own
  // rule then treats a level it does not recognise as no evidence, which errs
  // toward rethinking again rather than escalating early.
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-28-02', 'n=2', 'effort_applied=maximum']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/WARNING/.test(r.stderr), r.stderr);
  assert.ok(/effort_applied/.test(r.stderr), 'the warning must name the field');
  assert.ok(/repeat_exhausted/.test(r.stderr), 'and what reads it, so the cost is legible');
  const rec = JSON.parse(lines(graph)[0]);
  assert.strictEqual(lines(graph).length, 1, 'the round still happened, so the row is still written');
  assert.strictEqual(rec.effort_applied, 'maximum', 'kept as written — this writer does not correct claims');
});

test('omitting it writes no key and says nothing', () => {
  // Absence means UNMEASURED and is the normal state on the Agent path, so it is
  // not a declared field: warning about it would fire on every honest row.
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-28-02', 'n=1', 'role=ci-fix']);
  assert.strictEqual(r.status, 0, r.stderr);
  const rec = JSON.parse(lines(graph)[0]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, 'effort_applied'), false);
  assert.ok(!/WARNING/.test(r.stderr), r.stderr);
});

test('an empty value is absence too, not a bad level', () => {
  // Presence, not merely silence, is what a reader checks: `"effort_applied" in
  // e` (deliver.md's ladder query) must not read a `""` key as CONFIRMED. So
  // "empty" and "omitted" have to produce the identical record.
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-28-02', 'n=1', 'effort_applied=']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/WARNING/.test(r.stderr), r.stderr);
  assert.strictEqual(lines(graph).length, 1);
  const rec = JSON.parse(lines(graph)[0]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, 'effort_applied'), false,
    'an empty value must be omitted, not stored as ""');
});

done();
