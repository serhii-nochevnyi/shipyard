'use strict';

// THE VOCABULARY TABLE. Three scripts each carried their own list of `state`
// strings and the lists disagreed — and every state none of them named counted
// as PASSED, because the green test everywhere is `failing === 0 && pending === 0`.
// These cases ARE the table: gh classifies, we count, and one file decides how.
// If a bucket ever has to move, exactly one file changes and this test says so.

const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const { classify, stateBucket, isGreen, unavailableNote, CHECK_FIELDS } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'check-state.cjs'
));

suite('check-state — gh\'s own buckets, counted once');

test('the five buckets gh reports each land in exactly one tally', () => {
  const got = classify([
    { bucket: 'fail' }, { bucket: 'cancel' }, { bucket: 'pending' },
    { bucket: 'pass' }, { bucket: 'skipping' },
  ]);
  assert.deepStrictEqual(got, {
    total: 5, failing: 2, pending: 1, passing: 1, skipped: 1, none_reported: false, unavailable: false,
  });
});

test('the tallies partition the rows — nothing is counted twice or dropped', () => {
  // The defect this module replaces was a row falling through BOTH filters. A
  // partition cannot have that shape, so assert it as arithmetic rather than
  // trusting the case list above to stay exhaustive.
  const rows = ['pass', 'fail', 'pending', 'skipping', 'cancel', 'weird', undefined]
    .map((bucket) => ({ bucket }));
  const c = classify(rows);
  assert.strictEqual(c.failing + c.pending + c.passing + c.skipped, c.total);
});

test('cancel is failing — a cancelled check is not a check that passed', () => {
  const c = classify([{ bucket: 'cancel', state: 'CANCELLED' }]);
  assert.strictEqual(c.failing, 1);
  assert.strictEqual(c.passing, 0);
});

test('skipping counts towards total and towards nothing else', () => {
  // A skipped check is neither owed work nor a reason to wait, so it must not
  // land in `failing` or `pending` — but `total` is what tells a caller that
  // checks exist at all, and a skip is a check that existed.
  const c = classify([{ bucket: 'skipping' }, { bucket: 'pass' }]);
  assert.strictEqual(c.total, 2);
  assert.strictEqual(c.failing, 0);
  assert.strictEqual(c.pending, 0);
  assert.strictEqual(c.skipped, 1);
});

suite('check-state — fail closed: an unreadable check is never green');

test('an unknown bucket is PENDING, not passing', () => {
  const c = classify([{ bucket: 'weird' }]);
  assert.strictEqual(c.pending, 1, 'a bucket name we do not know keeps the ticket waiting');
  assert.strictEqual(c.failing, 0, 'and does not dispatch a fixer at a check nobody has read');
  assert.strictEqual(c.passing, 0);
  assert.ok(!(c.failing === 0 && c.pending === 0), 'the green test must not hold here');
});

test('a row with no bucket at all is PENDING — an older gh must not read as green', () => {
  const c = classify([{ state: 'STARTUP_FAILURE' }]);
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.failing, 0);
  assert.ok(!(c.failing === 0 && c.pending === 0), 'the green test must not hold here either');
});

test('a row that is not an object does not crash the count', () => {
  const c = classify([null, 'FAILURE', 7]);
  assert.strictEqual(c.total, 3);
  assert.strictEqual(c.pending, 3, 'unreadable, therefore pending');
});

test('an empty bucket string is unreadable, not a pass', () => {
  assert.strictEqual(stateBucket({ bucket: '' }), 'pending');
  assert.strictEqual(stateBucket({ bucket: '   ' }), 'pending');
});

suite('check-state — the row-level classifier and the field list');

test('stateBucket answers for one row, with the same vocabulary', () => {
  assert.strictEqual(stateBucket({ bucket: 'pass' }), 'pass');
  assert.strictEqual(stateBucket({ bucket: 'fail' }), 'fail');
  assert.strictEqual(stateBucket({ bucket: 'cancel' }), 'cancel');
  assert.strictEqual(stateBucket({ bucket: 'pending' }), 'pending');
  assert.strictEqual(stateBucket({ bucket: 'skipping' }), 'skipping');
  assert.strictEqual(stateBucket({ bucket: 'nonsense' }), 'pending', 'fail closed');
  assert.strictEqual(stateBucket(undefined), 'pending', 'fail closed');
});

test('gh spells its buckets lowercase, but a case difference must not read as unknown', () => {
  assert.strictEqual(stateBucket({ bucket: 'PASS' }), 'pass');
  assert.strictEqual(stateBucket({ bucket: 'Fail' }), 'fail');
});

test('CHECK_FIELDS asks gh for the bucket — that is the whole point', () => {
  assert.ok(CHECK_FIELDS.split(',').includes('bucket'),
    'without `bucket` every row is unreadable and the board would never go green');
  assert.strictEqual(CHECK_FIELDS, 'name,state,bucket',
    '`name` and `state` stay in the window: they are what the human-readable output prints');
});

test('no rows is none_reported, and every tally is zero', () => {
  // What "nothing ran" MEANS is not this module's call (T-24-05 owns that) — it
  // only reports the fact.
  assert.deepStrictEqual(classify([]), {
    total: 0, failing: 0, pending: 0, passing: 0, skipped: 0, none_reported: true, unavailable: false,
  });
});

suite('check-state — the fourth state: a reading that did not happen');

// An unreadable `gh pr checks` (a 503, a rate limit, an expired token, an old
// `gh` rejecting `--json bucket`) is not an empty list. It arrived here AS one
// until the merge gate started landing on the resulting all-zero tally; the
// replacement was a synthetic unknown-bucket row, which waits for the right
// reason and reports "1 check is still running" about a check nobody ever saw —
// and then asks a person to confirm a reading that never happened. `unavailable`
// is that fact as itself.

test('a non-array is unavailable, NOT none_reported — the whole point of the state', () => {
  assert.deepStrictEqual(classify(null), {
    total: 0, failing: 0, pending: 0, passing: 0, skipped: 0, none_reported: false, unavailable: true,
  });
});

test('every other unreadable answer lands there too, not in a tally', () => {
  // A caller hands over whatever `gh` did NOT give it. None of these is a list
  // of rows, and none of them may become a phantom pending check: the tallies
  // stay at zero because zero checks were read.
  for (const bad of [undefined, 'HTTP 503', 42, {}, { rows: [] }]) {
    const c = classify(bad);
    assert.strictEqual(c.unavailable, true, `${JSON.stringify(bad) || String(bad)} is not a row list`);
    assert.strictEqual(c.none_reported, false, 'and it is not "this PR has no checks" either');
    assert.strictEqual(c.total, 0);
    assert.strictEqual(c.pending, 0, 'no phantom check: nothing was read, so nothing is running');
  }
});

test('the two flags are mutually exclusive on every input', () => {
  // `[]` is an observed empty list; a non-array is an answer that never arrived.
  // Both true would mean the board could not tell them apart after all.
  for (const input of [[], [{ bucket: 'pass' }], null, undefined, 'x']) {
    const c = classify(input);
    assert.ok(!(c.none_reported && c.unavailable), `both flags set for ${JSON.stringify(input) || String(input)}`);
  }
});

suite('check-state — isGreen asks the flag before the arithmetic');

test('an unavailable tally is NOT green, though every counter is zero', () => {
  // This is why the green test had to become a function: `failing === 0 &&
  // pending === 0` — written out at four consumers — HOLDS here.
  const c = classify(null);
  assert.strictEqual(c.failing, 0);
  assert.strictEqual(c.pending, 0);
  assert.strictEqual(isGreen(c), false, 'the arithmetic alone would have said green');
});

test('a passing pipeline is green, and a red or pending one is not', () => {
  assert.strictEqual(isGreen(classify([{ bucket: 'pass' }])), true);
  assert.strictEqual(isGreen(classify([{ bucket: 'fail' }])), false);
  assert.strictEqual(isGreen(classify([{ bucket: 'pending' }])), false);
  assert.strictEqual(isGreen(classify([{ bucket: 'weird' }])), false, 'fail closed, via pending');
});

test('an observed empty list still reads green here — what that MEANS is the caller\'s', () => {
  // `none_reported` is a decision a person makes once per repository
  // (`merge_without_ci`), and `noCiHold` in front.cjs/sentinel.cjs owns it. This
  // module must not pre-empt it, or the setting would stop working.
  assert.strictEqual(isGreen(classify([])), true);
});

test('a MISSING checks object reads the empty tally, exactly as the inline test did', () => {
  assert.strictEqual(isGreen(undefined), true);
  assert.strictEqual(isGreen(null), true);
  assert.strictEqual(isGreen({}), true);
});

test('the flag is read for truth, and an ABSENT one is not a claim', () => {
  // `classify` writes a real boolean, so any other truthy value came off a board
  // some other process wrote — fail closed on it, by this module's own rule. But
  // a board with NO such key is every board written before this release, and its
  // unreadable answers were already held by the pending row they carried.
  assert.strictEqual(isGreen({ failing: 0, pending: 0, unavailable: 'yes' }), false);
  assert.strictEqual(isGreen({ failing: 0, pending: 0, unavailable: 1 }), false);
  assert.strictEqual(isGreen({ failing: 0, pending: 0, unavailable: false }), true);
  assert.strictEqual(isGreen({ failing: 0, pending: 0 }), true);
});

// ── the CAUSE, in the order the one function states it ──────────────────────
// Both `ghChecks` callers wrote this chain out, and a rule kept in two places is
// one the two can differ on. Each arm gets a case, because the arms are the rule.

test('gh\'s own message wins whenever there is one', () => {
  const note = unavailableNote({
    stdout: '', stderr: 'gh: HTTP 503: Service Unavailable (api.github.com)\nplus noise', status: 1,
  });
  assert.strictEqual(note, 'gh: HTTP 503: Service Unavailable (api.github.com)', 'the first line, not the noise after it');
});

test('a failed SPAWN is named by its error, not by its status', () => {
  // No `gh` on PATH: the status is `null` and "exited null" names nothing, which
  // is why this arm precedes the exit-code fallback.
  const note = unavailableNote({ stdout: '', stderr: '', status: null, error: new Error('spawnSync gh ENOENT') });
  assert.strictEqual(note, 'spawnSync gh ENOENT');
});

test('an ANSWER that is not a JSON array is quoted — exit 0 names nothing', () => {
  // THE CELL THIS TICKET'S FIRST PASS LEFT OPEN. gh exits 0 and answers an API
  // error object, so the status arm below would have said "exited 0" — true, and
  // useless to whoever reads the merge refusal at 3am.
  const note = unavailableNote({ stdout: '{"message":"Bad credentials"}', stderr: '', status: 0 });
  assert.match(note, /not with a JSON array/);
  assert.match(note, /Bad credentials/, 'what gh said is the only useful thing left here');
});

test('a quoted answer is one line and clipped, because every consumer prints it inline', () => {
  const note = unavailableNote({ stdout: `<html>\n  <body>${'x'.repeat(200)}</body>\n</html>`, stderr: '', status: 0 });
  assert.strictEqual(note.includes('\n'), false, 'a newline would break the board\'s one-line warning');
  assert.match(note, /…$/, 'clipped quotes say so rather than looking complete');
  assert.strictEqual(note.length < 140, true, `note is ${note.length} chars`);
});

test('the exit code is the LAST resort, and the note is never empty', () => {
  // Nothing on either stream: the status is all there is.
  assert.strictEqual(unavailableNote({ stdout: '', stderr: '', status: 8 }), 'gh pr checks exited 8');
  assert.strictEqual(unavailableNote({ stdout: '   ', stderr: '  \n ', status: 1 }), 'gh pr checks exited 1');
});

done();
