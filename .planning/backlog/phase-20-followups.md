# Phase 20 follow-ups (surfaced during delivery, out of scope for its tickets)

**Status: five of six RESOLVED in v0.40.0 by phase 22; §6 is still live.** Every
RESOLVED line below names the release and the ticket that closed it, and every
one was re-measured against the shipped code by T-23-02 on 2026-08-26 — a
backlog corrected from a phase summary would repeat the exact error it exists to
remove. Nothing is deleted: the reasoning is why each fix took the shape it did.

**Found:** 2026-08-25, during `/shipyard:deliver 20` on this repo — by the PR
sentinel's review rounds, by T-20-03's executor, and by verification afterwards.
**Status of each, as first recorded:** VERIFIED = re-checked against the merged
epic; REPORTED = named by an agent, not independently re-checked.

## 1. A `plan_defect` park is described to the human as its own opposite — VERIFIED

**RESOLVED — T-22-01 (PR #8), released in v0.40.0.** Re-measured 2026-08-26: the
wording now has one home. `escalation-record.cjs` holds the `LIFTS` table and
`escalationWhy` (lines 78-119), and both renderers assign what it returns
verbatim — `front.cjs:176` and `sentinel.cjs:203`. `plan_defect` occurs **zero**
times in either renderer, which is the fix rather than a residue of the bug: the
kind travels in the record, so neither site can describe one kind's park with
another kind's lifting rule. The three contradictory strings quoted below no
longer coexist — the "moving the PR does not lift it" sentence survives only in
`escalation-record.cjs`, at its own `mark-plan-defect` output.

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

**RESOLVED — T-22-02 (PR #11), released in v0.40.0.** Re-measured 2026-08-26: the
condition lives once, as `requireReason` at `escalation-record.cjs:238`
(`if (!words.join(' ').trim().length) fail(message)`), and both call sites use it
— `mark` at line 317 and `mark-plan-defect` at line 356. No bare
`if (!reason.length)` remains anywhere in the file, so
`escalation-record.cjs mark T-01-01 ""` no longer passes.

    line 229 (mark)              if (!reason.length)
    line 272 (mark-plan-defect)  if (!reason.join(' ').trim().length)

So `escalation-record.cjs mark T-01-01 ""` passes: a non-empty positional array
holding nothing a human can read. Copilot found this on `mark-plan-defect` and
the sentinel fixed it there; `mark` — the older, more-used path — still has it.
The comment at 272 already explains why the joined-and-trimmed form is the right
one. Apply the same guard, and pin the empty-string case in a test.

## 3. `drift-record.cjs` and `log-event.cjs` lack the `--graph`-flag-as-value guard — VERIFIED

**RESOLVED — T-22-03 (PR #9), released in v0.40.0.** Re-measured 2026-08-26 with
the same count as the table below: `drift-record.cjs` now has 1 (line 61) and
`log-event.cjs` 1 (line 46), against 0 and 0 when this was written. Both refuse
with a usage error naming the flag they were handed, instead of resolving a
directory literally called `--json` and then reading as an EXPLICIT graph.

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

**RESOLVED — T-22-04 (PR #10), released in v0.40.0.** The report was accurate; the
window was real. Re-measured 2026-08-26: `lock.cjs` defines
`OWNERLESS_GRACE_MS = 2_000` (line 46), applies it to the no-`owner.json` branch
(line 136 — inside the grace the lock counts as HELD and the caller queues, past
it the takeover behaves exactly as before, so a killed session still cannot wedge
the next run), and exports it (line 184) so a test can pin the window rather than
sleep against a literal.

Found and documented by T-20-03's executor; named in PR #5's body. Not
re-verified here. The takeover path (stale lock with no/expired `owner.json`) is
the one that runs when a previous session was killed, i.e. exactly when two
processes are most likely to be contending.

## 5. The async concurrency tests in `tests/unit/record-stores.test.cjs` are vacuous — REPORTED

**RESOLVED — T-22-05 (PR #12), released in v0.40.0.** It was true, and it was the
harness, not the suite. Re-measured 2026-08-26: `tests/unit/assert-harness.cjs`
no longer judges a body by the value `fn()` returned — it detects a thenable
(line 68), parks its settle-promise (line 75) and makes `done()` wait on all of
them (line 102). `tests/unit/harness.test.cjs` is the control that proves it can
fail: it runs scratch suites in a CHILD process, so it can assert that an async
body asserting a falsehood is now counted as a failure instead of a pass. The
concurrency test at `record-stores.test.cjs:106` is a genuinely awaited async
body today.

Also from T-20-03's executor, also in PR #5's body. If true, the lost-update
regression those tests were written for (six concurrent marks producing five
records) is currently unguarded. Worth checking before trusting that suite —
a test that cannot fail is worse than a missing one, because it reports safety.

## 6. CodeRabbit did not engage on any of the six PRs — OPERATIONAL, STILL LIVE

**STILL LIVE — now four phases, and the count is measured rather than
remembered.** Re-measured 2026-08-26 over every pull request this repository has
ever had (`gh pr list --state all`, #1-#19, covering phases 20, 21 and 22, plus
each PR's comment and review authors): the only bot among them is
`copilot-pull-request-reviewer`. CodeRabbit has posted zero reviews and zero
comments on any of them. Phase 23 is the fourth phase delivering under the same
arrangement. This is the one entry in this file that cannot be settled by reading
the code — it is an app installation and authorization fact — so it stays open
until someone checks the app's status on this repository.

One clause below has gone stale and is corrected here rather than removed: the
"this repo has no CI" premise no longer holds, because
`no-ci-in-the-conveyors-own-repo.md` was resolved in v0.40.0. Bot review is now
one leg of the evidence base beside a real check run, which narrows what this
costs without closing it.

`reviewers.cjs reinit` was run on every PR and reported
`requested CodeRabbit full review` each time; CodeRabbit never posted. Copilot
was the only bot reviewer in force for the whole phase. Not a code defect, but
it halves the bot-review leg of the evidence base — which matters more here than
usual, because this repo has no CI (see `no-ci-in-the-conveyors-own-repo.md`).
Check whether the app is still installed and authorized on this repository.
