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
// A non-array argument is counted as no rows. Callers must NOT rely on that to
// paper over a failed `gh` call: `null` from a tolerated `gh` means "unreachable
// this round, look again", which is not the same fact as an empty list meaning
// "this PR has no checks" — every caller keeps its own `Array.isArray` guard for
// exactly that reason.
function classify(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = {
    total: list.length,
    failing: 0,
    pending: 0,
    passing: 0,
    skipped: 0,
    none_reported: list.length === 0,
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

module.exports = { classify, stateBucket, CHECK_FIELDS, BUCKETS };
