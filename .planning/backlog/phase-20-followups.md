# Phase 20 follow-ups (surfaced during delivery, out of scope for its tickets)

**Found:** 2026-08-25, during `/shipyard:deliver 20` on this repo — by the PR
sentinel's review rounds, by T-20-03's executor, and by verification afterwards.
**Status of each:** VERIFIED = re-checked against the merged epic; REPORTED =
named by an agent, not independently re-checked.

## 1. A `plan_defect` park is described to the human as its own opposite — VERIFIED

`escalation-record.cjs` and the two files that RENDER its parks contradict each
other, and both shipped in the same epic:

    escalation-record.cjs:318   "… Moving the PR does NOT lift it."
    front.cjs:121               "It lifts by itself once the PR moves (a push,
                                 a review answer, undrafting)"
    sentinel.cjs:186            "(lifts when the PR moves; `… clear <id>`)"

`front.cjs` and `sentinel.cjs` contain **zero** occurrences of `plan_defect`, so
T-20-03's new park kind falls through to the generic escalation string. A person
reading the board at 3am is told the exact opposite of the rule: a plan defect
lifts only when the PLAN changes (re-decompose) or on an explicit `clear`.

This is the repo's recurring defect shape — prose asserting behaviour the code
does not have — and it arrived WITH the change that created the divergence,
which is the case the review pass is least likely to catch, because each file
is individually consistent.

The sentinel found it on PR #5 and correctly declined to fix it: `front.cjs` is
out of T-20-03's `files_modified` (owned by T-20-04 in this phase). It has no
owner now that both are merged, hence this note.

**Fix:** teach both renderers the park KIND. `activeEscalations` already carries
it; the message should come from the store, not be hardcoded twice at the render
site — that is what let them drift in the first place.

## 2. `escalation-record.cjs mark` checks the reason's argument COUNT, not its content — VERIFIED

    line 229 (mark)              if (!reason.length)
    line 272 (mark-plan-defect)  if (!reason.join(' ').trim().length)

So `escalation-record.cjs mark T-01-01 ""` passes: a non-empty positional array
holding nothing a human can read. Copilot found this on `mark-plan-defect` and
the sentinel fixed it there; `mark` — the older, more-used path — still has it.
The comment at 272 already explains why the joined-and-trimmed form is the right
one. Apply the same guard, and pin the empty-string case in a test.

## 3. `drift-record.cjs` and `log-event.cjs` lack the `--graph`-flag-as-value guard — VERIFIED

Occurrences of a `startsWith('--')` check on a flag's value, measured on the
merged epic:

    escalation-record.cjs   2      failure-signature.cjs   3
    attempt-history.cjs     1      drift-record.cjs        0
                                   log-event.cjs           0

Three scripts got this guard this session because Copilot found the bug
independently in each. The two that were not touched still swallow a following
flag as `--graph`'s value — the same class that once wrote a drift verdict into
a worktree and returned exit 0. These two are exactly the pair CLAUDE.md names
as sharing one spelling of the flag with `escalation-record.cjs`, so they should
share its parsing too.

## 4. `lock.cjs` `acquire()` has a race window in the `owner.json` takeover — REPORTED

Found and documented by T-20-03's executor; named in PR #5's body. Not
re-verified here. The takeover path (stale lock with no/expired `owner.json`) is
the one that runs when a previous session was killed, i.e. exactly when two
processes are most likely to be contending.

## 5. The async concurrency tests in `tests/unit/record-stores.test.cjs` are vacuous — REPORTED

Also from T-20-03's executor, also in PR #5's body. If true, the lost-update
regression those tests were written for (six concurrent marks producing five
records) is currently unguarded. Worth checking before trusting that suite —
a test that cannot fail is worse than a missing one, because it reports safety.

## 6. CodeRabbit did not engage on any of the six PRs — OPERATIONAL

`reviewers.cjs reinit` was run on every PR and reported
`requested CodeRabbit full review` each time; CodeRabbit never posted. Copilot
was the only bot reviewer in force for the whole phase. Not a code defect, but
it halves the bot-review leg of the evidence base — which matters more here than
usual, because this repo has no CI (see `no-ci-in-the-conveyors-own-repo.md`).
Check whether the app is still installed and authorized on this repository.
