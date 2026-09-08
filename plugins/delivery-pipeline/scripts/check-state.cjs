'use strict';

// ONE VOCABULARY FOR CHECK STATE — gh classifies, we count.
//
// `gh pr checks --json name,state,bucket` already sorts every CI state it knows
// about into five buckets:
//
//   pass | fail | pending | skipping | cancel
//
// That field exists precisely so callers do not maintain a list of `state`
// strings. Three callers here maintained one anyway, and the three copies
// disagreed: `state-sync.cjs` and `sentinel.cjs` called `FAILURE, ERROR,
// CANCELLED, TIMED_OUT` failing and `PENDING, QUEUED, IN_PROGRESS, EXPECTED`
// pending; `ci-wait.cjs` added `ACTION_REQUIRED` to the failing list and the
// other two did not. Everything neither list named — `WAITING`, `REQUESTED`,
// `STALE`, `STARTUP_FAILURE`, and `ACTION_REQUIRED` in two of the three — fell
// through BOTH filters, and therefore counted as passed: the green test in
// `state-sync.cjs` and `front.cjs` alike is `failing === 0 && pending === 0`.
// A startup failure read as green and the merge gate landed on it.
//
// FAIL CLOSED. Anything gh's answer does not let us classify — an unknown bucket
// name, a missing `bucket` from an older gh, a row that is not an object at all —
// is PENDING, never passing. Pending is the one verdict that costs only time: it
// keeps the ticket in `waiting.ci`, where the waiter and the next sync look
// again. Calling such a row passing is the defect above; calling it failing
// would dispatch a fixer at a check nobody has read.
//
// AND A FOURTH STATE, which is not about a row at all: `unavailable` — the call
// did not answer, so there is no list to classify. An unreadable `gh pr checks`
// (a 503, a rate limit, an expired token, an old `gh` rejecting `bucket`) used
// to be folded into the three states above: first as an empty list, which reads
// `none_reported: true, failing: 0, pending: 0` — the exact tally the merge gate
// treats as unblocked — and then, once that was fixed, as a synthetic
// unknown-bucket row, which waits for the right reason while telling the board
// "1 check is still running" about a check nobody ever saw, and asks a person to
// confirm a reading that never happened. Neither is the fact. A reading that did
// not happen is its OWN state: no work is owed, nobody is asked to confirm
// anything, and the next sync simply looks again.
//
// It travels as a FLAG, not as a tally, so `total`/`failing`/`pending` stay
// honest — zero checks were read, because none were. The price of that honesty
// is that `failing === 0 && pending === 0` — the green test everywhere — HOLDS
// on an unavailable answer. So the arithmetic is not the green test any more:
// `isGreen` below is, and it asks the flag FIRST. Every consumer that walks a PR
// towards landing goes through it or names `unavailable` itself.

// gh's own five. Anything else is not a bucket we can act on.
const BUCKETS = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);

// The `--json` window every consumer asks for. `bucket` is what this module
// reads; `name` and `state` stay in it because they are what the human-readable
// refusals and the board print — a tally alone cannot say WHICH check is red.
const CHECK_FIELDS = 'name,state,bucket';

// One row → one of gh's five buckets. Unreadable rows come back as `pending`,
// which is the fail-closed rule above, applied in the single place that knows it.
function stateBucket(row) {
  if (!row || typeof row !== 'object') return 'pending';
  const b = typeof row.bucket === 'string' ? row.bucket.trim().toLowerCase() : '';
  return BUCKETS.has(b) ? b : 'pending';
}

// Rows → tallies. The four counters PARTITION the rows, so
// `failing + pending + passing + skipped === total` always holds; a row that
// fell through every counter is exactly the bug this module replaces.
//
// `skipping` counts towards `total` and towards nothing else: a skipped check is
// neither owed work nor a reason to wait, but it is a check that existed, and
// `total` is how a caller tells "nothing ran" from "something ran".
//
// A NON-ARRAY argument is the fourth state, and the whole reason it exists.
// `null` from a `gh` call that did not answer means "unreachable this round,
// look again"; `[]` means "this PR has no checks configured". Those are different
// facts with different remedies — the second is a decision a person makes once
// per repository (`merge_without_ci`), the first is nobody's decision at all —
// and they used to arrive here as the same argument. So the distinction is made
// ONCE, here: a non-array is `unavailable`, never `none_reported`, and callers no
// longer keep their own `Array.isArray` guard to compensate. Hand the unread
// answer straight over as `null`; the flag comes back on the tally.
function classify(rows) {
  const readable = Array.isArray(rows);
  const list = readable ? rows : [];
  const out = {
    total: list.length,
    failing: 0,
    pending: 0,
    passing: 0,
    skipped: 0,
    // Mutually exclusive by construction: an observed empty list is
    // `none_reported`, an answer that never arrived is `unavailable`. Both false
    // is the ordinary case; both true is unreachable.
    none_reported: readable && list.length === 0,
    unavailable: !readable,
  };
  for (const row of list) {
    switch (stateBucket(row)) {
      case 'pass': out.passing += 1; break;
      // A cancelled run produced no verdict and will not produce one on its own.
      // That is a red round to be re-driven, not a check that passed.
      case 'fail': case 'cancel': out.failing += 1; break;
      case 'skipping': out.skipped += 1; break;
      // 'pending', plus every unreadable row — see the fail-closed note above.
      default: out.pending += 1; break;
    }
  }
  return out;
}

// THE GREEN TEST, in the one place that owns the vocabulary it reads.
//
// `failing === 0 && pending === 0` was written out at every consumer, which was
// harmless while an unreadable answer arrived carrying a pending row — the
// arithmetic happened to be fail-closed. It is not any more: an `unavailable`
// tally is all zeros, so the arithmetic ALONE says green about a PR nobody read.
// Asking the flag first is a one-line rule and therefore exactly the kind of rule
// that gets forgotten at the fourth call site, so it is a function.
//
// A MISSING checks object is deliberately NOT decided here: a caller that has no
// checks at all knows whether that means "no PR yet" or "a board we cannot
// trust", and the two are its own business. `isGreen(undefined)` reads the empty
// tally, exactly as the inline expressions it replaces did.
// The flag is read for TRUTH, not for the literal `true`, and the polarity is
// this module's own fail-closed rule rather than a style choice. `classify`
// always writes a real boolean, so anything else arrived from a board some other
// process wrote — and between "withhold a merge on a value we do not recognise"
// and "call a PR green on one", the first costs a tick and the second is the
// defect this whole state exists to remove. An ABSENT key stays green-capable:
// that is every board written before this release, whose unreadable answers were
// already held by the synthetic pending row they carried instead.
function isGreen(checks) {
  const c = checks || {};
  if (c.unavailable) return false;
  return !((c.failing || 0) > 0) && !((c.pending || 0) > 0);
}

// THE CAUSE OF AN UNREADABLE ANSWER, in the module that owns what one means.
//
// The note reaches the board's warning, the front's why-message, the guard's duty
// and the merge refusal, so it has to name something a person can act on. It was
// written out at BOTH `ghChecks` callers, which is the same second-home problem
// `classify` exists to remove — and the callers had already drifted apart on the
// shape of the answer. One order, stated once:
//
//   stderr       what `gh` itself printed ("HTTP 503: Service Unavailable", "API
//                rate limit exceeded"). The best answer whenever there is one.
//   spawn error  no `gh` on PATH at all. Its exit status is `null` and "exited
//                null" names nothing, so this arm comes before the exit code.
//   stdout       `gh` ANSWERED — just not with a JSON array (an API error
//                object, a wrapper, a notice contaminating stdout). Its exit code
//                is routinely 0 on this cell, so the status is worthless here and
//                what it actually said is the only useful thing left. Collapsed
//                to one line and clipped, because every consumer prints the note
//                inside a one-line message.
//   exit code    nothing on either stream: the status is all there is. A template
//                literal, so the note is never empty while `unavailable` is true.
function unavailableNote(r) {
  const answered = (r.stdout || '').replace(/\s+/g, ' ').trim();
  return (r.stderr || '').trim().split('\n').filter(Boolean)[0]
    || (r.error ? r.error.message : '')
    || (answered ? `gh pr checks answered but not with a JSON array: ${answered.length > 80 ? `${answered.slice(0, 80)}…` : answered}` : '')
    || `gh pr checks exited ${r.status}`;
}

module.exports = { classify, stateBucket, isGreen, unavailableNote, CHECK_FIELDS, BUCKETS };
