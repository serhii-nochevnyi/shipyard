# INTEGRATION — phase 24, "the conveyor stops interrupting itself"

- **Verdict: `needs-fix`.**
- Judged: `git diff origin/main...origin/epic/24-the-conveyor-stops-interrupting-itself`
  (main `f2853fc` → epic `35de683`), 42 files, +6560/−455.
- Every `file:line` below is at **`35de683`**.
- Housekeeping: both manifests read `0.46.0`
  (`plugins/delivery-pipeline/.claude-plugin/plugin.json:4`,
  `capabilities/delivery-pipeline/capability.json:4`), bumped from `0.45.0`.
  `make test-fast` is **green** on a clean `git archive` of the epic head:
  exit 0 across unit + graph + worktree + worktree-gates + sentinel
  (59 assertions) + docs + ssh-sync.
- PR #30 was **not** readied.

---

## Verdict summary

The phase delivers what each ticket promised in isolation. Two of the four
predicates it shares between the board (`front.cjs`) and the guard
(`sentinel.cjs`) are **structurally unreachable on the board**, because the
board's only input — `delivery-state.json` as `state-sync.cjs` writes it — never
carries the facts they read. The result is the exact rule this phase exists to
enforce, inverted: **the board offers work the guard refuses, and holds a PR out
of a bucket the guard has already put it in.** The tests pass because they hand
`computeFront` a state object with fields no producer writes.

Three further findings are dead seams between tickets that landed in an order
that made the reference impossible to honour.

| # | Severity | What |
|---|---|---|
| F1 | **major** | `front.cjs`'s `baseMoved` branch never fires — `delivery-state` has no `merge_state`/`behind_by` |
| F2 | **major** | `front.cjs`'s `reviewStandsAlone` branch never fires — `delivery-state` has no `unresolved_count` |
| F3 | medium | Two shipped comments assign the stop gate's `waiting.parent` half to T-24-09, which had already landed; the gate still reads `waiting.ci` alone |
| F4 | medium | `deliver.md`'s fix-round Workflow dispatch never passes `needsBaseMerge`/`base`, so T-24-06's step 0 is unreachable on the Workflow path |
| F5 | low | The `base_merge` journal event has a writer contract, a test-suite exemption and no caller; `stop-gate.movedSince` does not count it |

---

## The six seams

### Seam 1 — the four shared predicates, in both directions · **VERIFIED, FAILS**

Both files import from one home, and that half is clean:

- `sentinel.cjs:51-54` imports `needsHuman`, `checkpointParentOf`, `noCiHold`,
  `NO_CI_WHY`, `reviewStandsAlone`, `REVIEW_STANDS_WHY`, `baseMoved`,
  `baseMergeWhy` from `front.cjs`.
- `sentinel.cjs:60` imports `parentIsMoving` from `parent-moving.cjs`;
  `front.cjs:80` imports `movingParentOf`/`movingParentWhy` from the same module.
- No copied bodies: `grep -a` for each name finds exactly one definition.

I then walked `computeFront`'s `pr-open` chain (`front.cjs:420-557`) against
`dutyItems`'s chain (`sentinel.cjs:355-505`) bucket by bucket. Nine of the
eleven branch pairs agree. **Two do not, and both fail the same way**: the
predicate is evaluated on the board against a field that does not exist.

#### F1 — the board's `fix`-for-a-moved-base is dead code (major)

`front.cjs:448` calls `baseMoved(s)` on the delivery-state entry.
`baseMoved` (`front.cjs:221-230`) reads `f.merge_state` and `f.behind_by`.
**`state-sync.cjs` writes neither.** The complete field set for an open PR is
`state-sync.cjs:271-311` plus `:405-484`: `branch, pr, status, repo, matched_by,
pr_branch, draft, review_decision, url, pr_base, pr_created_at, head_sha, gate,
checks{total,failing,pending,none_reported,note}, base, epic, merge_scope,
ready, blocked_by, blocked_reasons, needs_pr, reapable, since, mergeable_since`.

So `baseMoved(s)` returns `null` for every real board, and a stale-base PR that
is otherwise green + conform + stacked falls through to `actionable.merge`
(`front.cjs:528`) — the one action `sentinel.cjs mergeOne` refuses at
`sentinel.cjs:749-760` ("the base moved: … commit(s) ahead of this branch").
The board offers exactly what the guard refuses, every round.

Reproduced with a state entry carrying **only** the keys `state-sync.cjs` writes:

```
base moved: state as written by state-sync (guard: base-merge)
  -> actionable.merge = ["T"]   why: "PR #9: green + conform — squash into epic/24-x (sentinel)"
same + merge_state:'BEHIND'  (a field state-sync never writes)
  -> actionable.fix   = ["T"]   why: "…the base moved: `epic/24-x` is some commits ahead…"
```

**The damage is not uniform, and on the default path it does not self-heal.**
On the *fallback* path the board lies but the run recovers: `duty` answers
`base-merge` and `pr-sentinel.md:108-118` tells the guard to run the script. On
the *Workflow* path — the default wherever the Workflow tool exists — the round
is derived from `needsCiFix`/`needsReviewFix` off state (`deliver.md:1192`) and
never from `duty`, and **F4** means `needsBaseMerge` is never passed. So nothing
merges the base, the board keeps offering the `merge` the gate keeps refusing,
and the PR sits. F1 and F4 together are a stall, which is why F1 is `major`.

`24-06-PLAN.md`'s acceptance criterion — *"`duty` on a PR with
`mergeStateStatus: BEHIND` → `base-merge`; **the front's `fix` entry for it
carries `why` containing `base-merge`**"* — is satisfied only by
`tests/unit/front.test.cjs:1446,1455,1461,1467,1473`, which inject
`merge_state`/`behind_by` by hand.

#### F2 — the board's `waiting.human`-for-a-standing-verdict is dead code (major)

`front.cjs:484` calls `reviewStandsAlone(s.review_decision, s.unresolved_count)`.
The predicate (`front.cjs:195-198`) requires `unresolvedCount === 0` exactly —
deliberately, so an unknown count fails towards the work. `s.unresolved_count`
is `undefined` on every real board: `grep -an unresolved plugins/delivery-pipeline/scripts/state-sync.cjs`
returns **nothing**. The comment two lines below the call
(`front.cjs:492-494`) states the opposite: *"The thread count is state's
(`unresolved_count`)"*.

So a `CHANGES_REQUESTED` PR with zero unresolved threads lands in
`actionable.finalize` via the fall-through at `front.cjs:551-555`, with the
owner-less reason `"green, review not settled (CHANGES_REQUESTED)"`, while
`sentinel.cjs:462` answers `wait-human` and dispatches nobody.

Reproduced against the real key set:

```
CHANGES_REQUESTED, no threads (guard: wait-human)
  -> actionable.finalize = ["T"]   why: "PR #9: green, review not settled (CHANGES_REQUESTED)"
same + unresolved_count:0    (a field state-sync never writes)
  -> waiting.human      = ["T"]   why: "CHANGES_REQUESTED stands with no unresolved thread — …"
```

**Consequence, stated honestly.** This is not a hang. `finalize` is the guard's
bucket, so the main loop takes nothing; the guard answers `wait-human` and does
nothing; the board never changes; `ci-wait.cjs:178-186` refuses (something is
actionable); `stop-gate.cjs:588` refuses the stop. T-24-09's ledger caps the
cost at `SHIPYARD_STOP_GATE_MAX_BLOCKS = 12` (`stop-gate.cjs:200`,
`blockAllowance` at `:293-311`), after which the stop is allowed with the cap
note. So the price is **up to twelve wasted rounds and a cap fired on a board
with no dispatchable work** — which is the "conveyor interrupts itself" symptom
the phase is named for, arriving through the board instead of the guard.
ADR-002 D7's promise is half-delivered: the guard routes to a person, the board
still calls it the run's work and names no owner.

`24-06-PLAN.md`'s acceptance criterion — *"`review_decision:
CHANGES_REQUESTED`, threads 0 → `duty` says `wait-human`, **`computeFront` puts
the ticket in `waiting.human`**"* — is likewise satisfied only against injected
state (`tests/unit/front.test.cjs:1412,1419,1432`).

#### Why the decomposition produced this

`24-06-PLAN.md`'s `files_modified` (lines 8-21) does **not** list
`plugins/delivery-pipeline/scripts/state-sync.cjs`. Gate 2 forbids file overlap,
and `state-sync.cjs` was already claimed by T-24-02, T-24-04, T-24-05 and
T-24-11. So the ticket that added two board-side predicates was structurally
unable to add the two facts the board needs to evaluate them. T-24-04 got this
right for its own predicate — it declared `state-sync.cjs` and added `head_sha`
(`state-sync.cjs:291`) in the same ticket. T-24-06 could not.

#### Where the test suite would have caught it, and did not

`tests/smoke/sentinel-smoke.sh:220-233` asserts board↔duty agreement for
`waiting.parent` **against the `delivery-front.json` that a real `state-sync`
run wrote** under the stubbed `gh` — that is the right shape, and it is why
T-24-03's seam holds. The equivalent assertion is absent for `base-merge`
(`:205-212` asserts the DUTY only) and absent entirely for `wait-human`.

#### Not a finding, but worth recording

With `auto_merge: off`, a green + conform + not-yet-approved PR is
`actionable.finalize` on the board and `human-merge` in the duty. I checked this
against `origin/main` with the same fixture: **identical on both sides**, so it
is pre-existing and out of this phase's scope.

### Seam 2 — one check vocabulary (`check-state.cjs`) · **VERIFIED, HOLDS**

```
grep -anE "SUCCESS|FAILURE|PENDING|COMPLETED|IN_PROGRESS|QUEUED|NEUTRAL|SKIPPED|\
CANCELLED|CANCELED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|REQUESTED|WAITING|STALE" \
  scripts/*.cjs workflows/*.mjs | grep -v check-state.cjs | grep -vi CHANGES_REQUESTED
```

Every surviving hit is prose in a comment (`sentinel.cjs:162-163`,
`ci-wait.cjs:307`, `graph-dir.cjs:93-95`) or a **review**-state filter
(`reviewers.cjs:178,445` — `PENDING` there is a review state, a different
vocabulary). All three `gh pr checks` call sites use `CHECK_FIELDS` + `classify`:
`state-sync.cjs:137,299`, `sentinel.cjs:180,192`, `ci-wait.cjs:282,310`. No
hand-written list survived in a file a later ticket edited.

**Methodological hazard for anyone re-running this sweep:** `state-sync.cjs`
contains a deliberate NUL byte at line 325 (`epicKey`'s separator — present on
`main` too, not a phase-24 change). `file(1)` calls the script binary and
**plain `grep` silently skips it**. Every sweep over `scripts/` must use
`grep -a`, or `state-sync.cjs` — the one file that decides what the board can
know — drops out of the result set without a word.

### Seam 3 — one trailer writer, one reader (`gate-trailer.cjs`) · **VERIFIED, HOLDS**

`parseGate` is defined once (`gate-trailer.cjs:65`). Importers:
`state-sync.cjs:60`, `sentinel.cjs:218`; `front.cjs:83` imports
`gateConform`/`gateWhy` and wraps them at `front.cjs:740-742`. No private
parser anywhere — including `stop-gate.cjs` and `fix-round.mjs`, which the
contract did not name and which reference the trailer only in prose. Every
`gate_status` hit outside `gate-trailer.cjs` is a comment, a message string, or
a documented invocation of `gate-trailer.cjs write` (`deliver.md:1117`,
`pr-sentinel.md:176`).

### Seam 4 — `escalation-record.fingerprint` unchanged · **VERIFIED, HOLDS**

Checked empirically rather than by reading: both versions required into one
node process, five fixture states (empty, red draft, merged, branched, approved
with `head_sha`) fed to each.

```
fingerprint identical: true
exports main: activeEscalations,activeParks,escalationWhy,fingerprint
exports epic: activeEscalations,activeParks,escalationWhy,fingerprint,parkFingerprint
```

`ci-wait.cjs:78` still requires that exact export name, and the park's new hash
is a **separate** function (`parkFingerprint`, `escalation-record.cjs:188-196`),
selected per record by the stored `fingerprint_kind` (`:279-282`) so records
written before the split keep the old rule. No CI-wait budget can reset.

### Seam 5 — `activeDispatches` inside the `state` lock · **VERIFIED, HOLDS**

`state-sync.cjs:525` opens `withLock(lockDirFor(ROOT), 'state', …)`;
`activeDispatches(ROOT, state)` is at `:562`, genuinely inside that callback,
alongside `computeFront` (`:537`) and all three `writeAtomic` calls
(`:569,570,578`). `activeParks(ROOT, state)` replaced the flat
`activeEscalations` at `:523` (outside the lock, correctly — it does not depend
on this run's journal append). `parked: RUN_PARKED` is untouched at `:538` and
remains a distinct argument from `escalated`.

Extra check the contract did not name: the **third** front writer,
`dispatch-record.cjs refreshFront` (`:317-355`), passes `parked`, `autoMerge`
(inherited from the file it is rewriting), `drifted`, `escalated`, `dispatched`
and `ci_estimates` — consistent with `state-sync`. It deliberately omits
`mergeWithoutCi` and lets `computeFront`'s lazy `graph-dir` resolver find the
project's config (`front.cjs:324-344`), which is the documented behaviour for a
writer that runs from a ticket worktree. No divergence.

### Seam 6 — did T-24-11 leave prose stale? · **VERIFIED; T-24-11 did not, T-24-07 did**

T-24-11 (`35de683`) touches two files: `state-sync.cjs` and
`sentinel-smoke.sh`. It renames no flag, no CLI, no user-visible field; it adds
one output key (`dispatches_applied_at`) that `stop-gate.cjs` deliberately does
not read for freshness. Grepping `deliver.md`/`pr-sentinel.md` for every term it
touched (`activeEscalations`, `dispatch-record`, `refreshFront`,
`dispatches_applied_at`, `state-sync`) surfaces nothing that became false.

The staleness came from the **other** direction: T-24-07's own sweep ADDED two
sentences that F1 and F2 make false, and it landed after T-24-06.

- `deliver.md:48-50` — *"fix — open PR with failing checks, **a base that MOVED
  under it (`base-merge`)**, or unresolved review threads"*. The board puts
  neither in `fix`: base-moved is F1, and unresolved threads have never been a
  `front.cjs` branch at all (they fall to `finalize`). Both are true of
  `sentinel.cjs duty` and of nothing else, but the block is introduced as the
  buckets of `delivery-front.json`.
- `deliver.md:66-71` — *"merge (human)/checkpoint … or `CHANGES_REQUESTED`
  **standing with ZERO unresolved threads** (`wait-human`)"*. F2: the board
  cannot reach that bucket.

The rest of T-24-07's sweep checks out: `grep -an "watch is legal"
scripts/front.cjs` is empty, `grep -an "checks.*--watch" references/pr-sentinel.md`
is empty, every action name in `deliver.md:159-160` exists in `dutyItems`
(`sentinel.cjs:372-499`), and `deliver.md` names `next_n` with no session
counter.

---

## Findings (fix tickets)

### F1 + F2 — the board cannot evaluate two of its four shared predicates

One ticket; they share a root cause, a file and a test gap.

- **Title:** The board reads the facts its own predicates need
- **Files:** `plugins/delivery-pipeline/scripts/state-sync.cjs`,
  `plugins/delivery-pipeline/scripts/front.cjs`,
  `plugins/delivery-pipeline/commands/deliver.md`,
  `tests/smoke/sentinel-smoke.sh`, `tests/unit/front.test.cjs`
- **depends_on:** nothing (the whole phase has landed)
- **This is a design fork, and the ticket must decide it explicitly**, because
  ADR-002's Consequences say *"no change adds a `gh` call to the bulk sync
  window except one scalar (`headRefOid`)"*:
  - **`merge_state` — option (a), feed the fact.** `state-sync.cjs:91` already
    makes a second, **open-only** bulk pass (`REVIEW_FIELDS =
    'number,reviewDecision,body'`, `:221-231`) precisely because
    `reviewDecision` is too expensive for the 1000-row window.
    `mergeStateStatus` is one more scalar on that existing open-only call, which
    is the same shape the ADR already sanctioned — but it forces GitHub to
    compute mergeability, so the ticket must **measure it with `SHIPYARD_TIME=1`
    before adopting it**, exactly as `reviewDecision` was measured (41s vs 7s),
    and must handle `UNKNOWN` as "not proven behind" rather than as clean.
    `behind_by` stays the guard's alone: it is a per-PR `gh api compare` and has
    no place in the sync window.
  - **`unresolved_count` — option (b), park it instead.** The count is a
    per-PR GraphQL call and cannot enter the sync window without contradicting
    the ADR. The phase's own three-store architecture already has the answer:
    the guard knows the fact live, so `sentinel.cjs duty` should record
    `wait-human` as a durable park bound to `parkFingerprint`
    (`escalation-record.cjs:188`) — so answering the review lifts it by itself —
    and the board reads it back through `activeParks`, at zero sync cost. Note
    the placement rule the phase already established: this must land the ticket
    in `waiting.human`, **not** `parked.blocked` — nobody owes work, a person
    holds the key.
  - Whichever branch is taken for each, the **dead code and the false prose must
    go with it**: a `baseMoved`/`reviewStandsAlone` call the board can never
    satisfy, plus `front.cjs:492-494`'s claim that state carries
    `unresolved_count`, plus `deliver.md:48-50` and `:66-71`.
- **Acceptance the ticket must carry (this is the part that was missing):** the
  assertion runs against a `delivery-front.json` written by a **real
  `state-sync.cjs`** under the stubbed `gh` in `tests/smoke/sentinel-smoke.sh`,
  the way `:220-233` already does for `waiting.parent` — never by handing
  `computeFront` a state object built in the test. Hand-built state is exactly
  how F1 and F2 passed eleven ticket reviews.

### F3 — the stop gate's `waiting.parent` half was assigned to a ticket that had already landed

- **Title:** A board holding only held children is a wait the gate can see
- **Files:** `plugins/delivery-pipeline/scripts/stop-gate.cjs`,
  `plugins/delivery-pipeline/scripts/ci-wait.cjs`,
  `plugins/delivery-pipeline/scripts/front.cjs` (comments)
- **depends_on:** nothing
- **Evidence.** `front.cjs:428-431`: *"NOTE for T-24-09: the stop gate's CI-only
  branch reads `waiting.ci` alone, so a board holding nothing but
  `waiting.parent` still permits a stop today. **That ticket extends the
  gate**"*. `ci-wait.cjs:235`: *"today the stop gate's CI-only branch reads
  `waiting.ci` alone, so such a board ends the run rather than spinning on it.
  **T-24-09 owns the gate's half.**"* T-24-09 (`b14f382`) is the **first**
  commit of the phase; T-24-03 (`4c71b46`) and T-24-10 (`c735856`) landed after
  it and wrote forward references to work that could not happen. T-24-07's prose
  sweep did not catch them because they are code comments.
  `stop-gate.cjs:548` still reads `front.waiting.ci` alone.
- **Warning the ticket must carry.** The gate's omission is currently
  **load-bearing in the other direction**. `ci-wait.cjs:222-231` documents that
  an already-green parent settles on the first poll and returns immediately, and
  justifies not filtering it precisely because *the stop gate lets such a board
  end the run*. Teach the gate to block on a `waiting.parent`-only board without
  also fixing that return, and you get a tight resync/ci-wait spin instead of a
  premature stop. **Fix both or neither, in one ticket.** The honest third
  option is to delete the two forward references and record that a
  `waiting.parent`-only board is a legitimate stop — in every reachable case the
  parent is human-owned or with an agent — which is a smaller change and may be
  the right one.

### F4 + F5 — the base-merge remedy exists on the fallback path only, and journals to nobody

- **Title:** The dispatch that carries a moved base, and the event that records it
- **Files:** `plugins/delivery-pipeline/commands/deliver.md`,
  `plugins/delivery-pipeline/references/pr-sentinel.md`,
  `plugins/delivery-pipeline/scripts/stop-gate.cjs`
- **depends_on:** nothing
- **F4.** `workflows/fix-round.mjs:17-22` declares `needsBaseMerge` and `base`,
  and `:154-160` makes the base merge step 0 of the prompt. **Nothing sets
  them.** `deliver.md:1192` still says *"for each open PR determine `needsCiFix`
  … and `needsReviewFix`"* and `:1200-1201` still lists exactly those two keys in
  the `args:` shape. T-24-07 landed after T-24-06 and updated the bucket table
  and the SENTINEL role list, but not the Workflow dispatch. The failure is
  silent and total: a PR whose only duty is `base-merge` has neither
  `needsCiFix` nor `needsReviewFix`, so it is not even in the round. The
  fallback path is fine (`deliver.md:183-186` names `base-merge.cjs` explicitly).
- **F5.** `log-event.cjs:13` documents `base_merge` and `:207` requires
  `ticket, pr, base, head`; `tests/smoke/docs-smoke.sh` exempts `base-merge`
  from the model-ladder check on the grounds that *"it journals itself as
  `base_merge`"*. It does not: `base-merge.cjs` contains no journal write, and
  `grep -arn base_merge commands/ references/` returns **nothing** — no prose
  tells anyone to emit it. `pr-sentinel.md:108-118` ends the duty at *"run the
  script … then push and go to 1"*.
- **Consequence worth fixing at the same time:** `stop-gate.cjs`'s `movedSince`
  (`:271-300`) counts `merge`, `escalation`, `attempt outcome=pushed` and
  `fix_round pushed=true`. A `base-merge` duty pushes and re-runs CI, so it
  moves the world; once `base_merge` is actually written, add it to that list —
  and not before, or the gate gains a branch nothing can trigger.

---

## What I could not verify

- Nothing in the six seams was left unchecked. Every claim above is either a
  `grep -a` over the epic head, a `node` evaluation of the shipped modules, or a
  `make test-fast` run — no seam was judged by reading alone.
- Not attempted, and out of scope for this verdict: `make test-codex-shipyard`
  (needs network) and the container test targets. The conveyor's command docs
  changed in this phase, so the Codex generator should be re-run and the
  generated `SKILL.md` re-read before release — `deliver.md`'s new paragraphs
  contrast the Workflow and Agent paths, which is the class of prose the
  generator rewrites.
