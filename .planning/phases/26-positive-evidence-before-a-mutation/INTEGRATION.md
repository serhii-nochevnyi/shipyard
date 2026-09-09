# INTEGRATION — phase 26, `positive evidence before a mutation`

## Subject — head `695efeb419a420dbe7e81c8346a3f89f08bf1fca`

- **Epic**: `epic/26-positive-evidence-before-a-mutation` → `main`, PR #41, repo `serhii-nochevnyi/shipyard`
- **Head verified myself**: `gh pr view 41 --json headRefOid` agrees with `695efeb`
- **Fifteen tickets, all merged.** T-26-07, T-26-09, T-26-08, T-26-01, T-26-06,
  T-26-04, T-26-14, T-26-13, T-26-15, T-26-03, T-26-05, T-26-10, T-26-11,
  T-26-02, T-26-12
- **Combined diff**: 36 files, +7133/−367 against merge base `9614c09`

## Verdict — `passed`

Nothing I found blocks this merge. The five seams hold, `test-fast` is green on
both the epic head and the merged tree, `test-codex-shipyard` is green, and the
one broken invariant I found (seam 4) is **byte-identical on `main` at the merge
base** — this epic neither introduced nor worsened it, so it cannot be a reason
to hold the epic back.

Two things I want on the record as better than the backlog says, and one as
worse:

- **Better**: T-26-12 partially closed the D2 gap T-26-02 could not reach
  (`front.cjs`'s standalone CLI). The corrupt-config answer is no longer
  byte-identical to a valid `auto_merge: epic` — it now names the unreadable
  file and forbids every dispatch in the same output. Measured below.
- **Better**: `capacity` really is a truncation, not a filter. Measured on a
  fixture, not read.
- **Worse**: on a capacity-full board the three mechanisms give three
  **mutually incompatible orders**. That is not in the backlog and it belongs in
  phase 27's first ticket alongside the counting unit. Measured below.

---

## What I verified by running

Throwaway detached worktrees, so the epic's own tracked `.planning/config.json`
answered rather than this project's. Both removed afterwards.

### `make test-fast` on the epic head — exit 0

```
31 × "N passed, 0 failed"; unit tests passed; graph validator smoke passed;
worktree/epic smoke passed; worktree gates smoke passed; 145 passed, 0 failed
(sentinel smoke); docs smoke passed; ssh sync smoke passed
EPIC_EXIT=0
```

### `make test-fast` on the MERGED tree — exit 0

`main` had moved, so I merged it in and measured that tree too. The merge is
**one Markdown file**: `.planning/backlog/phase-26-followups.md`, +139. Every
other commit of main was already absorbed at `dfce3f0 Merge main into epic/26`.
So the merged tree cannot differ behaviourally from the epic head, and it does
not: 1325 `✓`, 31 clean blocks, `MERGED_EXIT=0`.

### `make test-codex-shipyard` on the epic head — exit 0

```
→ installing gsd-core@1.13.0 --codex (throwaway HOME)…
codex-shipyard smoke: OK
CODEX_EXIT=0
```

`tests/smoke/codex-shipyard-smoke.sh:24-26` does `WORK="$(mktemp -d)"; export
HOME="$WORK"`, so it never touches the host's real `~/.codex/config.toml`. Safe
to run, and run.

### The model ladder is untouched by behaviour

```
$ node pipeline-config.cjs model drift-check --json        {"model":"sonnet","effort":"high"}
$ node pipeline-config.cjs model executor --risk low --json {"model":"opus","effort":"high"}
$ node pipeline-config.cjs model integrator --json          {"model":"opus","effort":"xhigh"}
```

(the integrator run also prints the honest warning that the `fable` window route
cannot fire without `--input-tokens`, which is ADR-005 D4 as amended).

---

## Seam 1 — `state-sync.cjs`, five tickets in one file

**One vocabulary for each fact; no second home.**

- The tri-state is `true | false | null` at `state-sync.cjs:485-502`, `null`
  meaning the `gh api compare` did not answer. Readiness branches on `null`
  (`:594`) and on `false` (`:597`) **separately** and never maps `null` to
  landed. ADR-004 D3 satisfied.
- The fourth check state is `classify`'s alone (`check-state.cjs:80-107`).
  `state-sync.cjs` only carries it (`:437-444`) and says so at `:205` — "NOTHING
  else about it".
- The green test is `isGreen` at every consumer that walks a PR towards landing:
  `state-sync.cjs:688`, `front.cjs:526`. `sentinel.cjs:789` asks
  `checks.unavailable` first and then tallies, which `check-state.cjs:44-45`
  explicitly licenses as the alternative. I grepped for surviving inline
  `failing === 0 && pending === 0` arithmetic across `scripts/*.cjs` and
  `workflows/*.mjs`: the only hits are comments and `ci-wait.cjs:514`'s
  `total > 0 && pending === 0`, which is the deliberately different **settled**
  test (returns on green OR red).
- `failure-signature.cjs:306`'s `isGreen` is a name collision over a different
  subject (journal events), not a second home for check state.
- **The fixer-facing contract is measured, not assumed.** `references/` is
  untouched by this epic (`git diff --stat 9614c09 HEAD -- references/` empty),
  and I checked it against D1 rather than taking that as proof: `ci-fix.md:99-111`
  and `review-fix.md:92-94` promise exactly what `base-merge.cjs` still does —
  the base's edition for conflicts in files the ticket does not declare,
  conflicts inside its own `files_modified` left uncommitted for the agent — and
  `base-merge.cjs:81` now refuses BEFORE the merge starts when ownership cannot
  be answered with certainty ("No certainty, no mutation"), which is stricter
  than the references promise, never looser. No fixer is told to do something
  D1 forbids.

**Four encodings of "unobserved", and they do not collide** — each is private to
its own subject and none is read by another's consumer:

| fact | encoding | owner |
| --- | --- | --- |
| the epic compare did not answer | `landed: null` | `state-sync.cjs:496` |
| `gh pr checks` did not answer | `checks.unavailable: true` | `check-state.cjs:93` |
| a newer sync published first | `observed_at` compare | `state-sync.cjs:746-756` |
| no policy could be read | `valid: false` | `pipeline-config.cjs` → `:234` |

The publish compare-and-swap and the config gate are about genuinely different
questions — whose OBSERVATION is newer, versus whether a POLICY may be applied
— and neither is expressed in the other's terms. Nothing to fix here.

## Seam 2 — `front.cjs`, four tickets

- **`epicKey` has exactly ONE definition**: `front.cjs:107`, exported at
  `:1212`, imported by `state-sync.cjs`. The PR #56 SyntaxError shape (a second
  definition) is absent.
- **`leftBehind` is evidence-only** (`front.cjs:819-830`): a ticket is left
  behind only when its OWN phase's epic has `landed === true` **and** that
  epic's PR state is `MERGED`. `landed: null` returns 0 ("an answer nobody
  received"), a missing epic record returns 0. There is no phase-number
  comparison anywhere in the file. ADR-004 D10 satisfied.
- **`capacity` truncates, it does not filter.** Measured. Fixture: seven
  tickets, four with open PRs carrying real `pr-sentinel` dispatch records
  written by `dispatch-record.cjs mark` (exactly what `deliver.md:1129` does),
  three execute-ready, `pipeline.max_concurrent_agents: 4`:

```
front: 3 actionable now — execute: T-99-05, T-99-06, T-99-07
waiting: dispatched: T-99-01, T-99-02, T-99-03, T-99-04
capacity: 4 agents, 4 in flight — 3 actionable item(s) wait for the next round
fixpoint: NO — 3 item(s) are actionable but capacity is full (4 agent(s) allowed,
4 in flight): this run is waiting on CAPACITY, not on work.
```

  `--json`: `actionable.execute` still holds all three, `actionable_count: 3`,
  `fixpoint: false`, `capacity {max: 4, in_flight: 4, free: 0}`. Nothing was
  moved out of `actionable` and the fixpoint formula is untouched, which is the
  property `front.cjs:728-735` claims for itself.

## Seam 3 — `check-state.cjs` / `sentinel.cjs`

The board and the guard share one vocabulary through `classify`, and
`check-state.cjs` is required by `state-sync.cjs:57`, `sentinel.cjs:34` and
`ci-wait.cjs:79`. The **one** place they can answer differently about the same
PR is the corrupt-config path, and they do. Same fixture, same board, one
`.planning/config.json` that does not parse:

```
$ node front.cjs
front: 1 actionable now — finalize: T-01-01
sentinel: 1 duty (T-01-01) — post/keep the guard, do NOT wait on it
capacity: 0 agents — no policy is in effect (the project config does not parse),
so nothing may be dispatched; 1 actionable item(s) wait. The fix is the file.
fixpoint: NO — 1 item(s) are actionable but NOTHING may be dispatched …

$ node sentinel.cjs duty
config-invalid: .planning/config.json — is not valid JSON (…). The guard is
standing down: no PR is driven and nothing is merged until the file parses.
```

So the front still ASSIGNS the buckets the guard refuses — `front.cjs:1242`
computes `autoMerge` off the populated defaults without asking `valid`, which is
backlog D2-gap #1 and is unchanged (`front.cjs:1242`). But the reviewer's sharpest claim no longer
holds: the corrupt answer is **not** byte-identical to a valid `auto_merge:
epic` any more. I measured all three:

| config | output |
| --- | --- |
| valid `epic` | `finalize: T-01-01`, `sentinel: 1 duty`, ordinary fixpoint line |
| valid `off` | `0 actionable`, `waiting: merge (human)`, `fixpoint: YES` |
| corrupt | `finalize: T-01-01`, `sentinel: 1 duty`, **plus** the capacity line naming the file and a fixpoint line refusing every dispatch |

T-26-12's cap gates the paid dispatch in the same output that misattributes the
bucket, and names the remedy ("The fix is the file"). That is a cross-ticket
improvement no ticket-level review could have seen: T-26-12 closed most of a gap
T-26-02 was forbidden by Gate 2 from touching. The residual — a misattributed
bucket on an unreadable file — stays a follow-up.

## Seam 4 — `ci-wait.cjs`: the stated invariant does NOT hold, and it is not this phase's doing

`ci-wait.cjs:494`:

```js
const sleep = (s) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${Math.round(s * 1000)})`], { timeout: (s + 5) * 1000 });
```

called at `:549` with `Math.min(INTERVAL_S, Math.max(1, (deadline - Date.now()) / 1000))`
— a fractional second count on the last poll of every window. `spawnSync`'s
`timeout` must be an unsigned **integer**, and `(s + 5) * 1000` is not one for a
large share of fractional `s`. Probed directly:

```
s=3.99    -> ok (8990)
s=3.994   -> ok
s=1.376   -> THREW ERR_OUT_OF_RANGE: timeout was 6375.999999999999
s=12.3456 -> THREW ERR_OUT_OF_RANGE: timeout was 17345.6
```

Reproduced end to end — `ci-wait.cjs --json --timeout 6 --interval 2` on a
CI-only board died with a `RangeError` stack trace and no exit code the loop can
read. This is the exact thing the script's own design note forbids: *"returns 0
on timeout too, because a waiter that dies noisily teaches the loop to stop
calling it and then the hole is back."*

**Consequence beyond the noise**: the crash happens on the last `sleep`, which
sits AFTER the deadline branch in the loop body — so on a crashing run the
timeout branch never executes, and with it neither `recordOutcome`'s empty-window
counting nor the three-strikes escalation. That is T-24-10's whole termination
mechanism, unreachable on every run that crashes. Frequency measured, not
guessed: two of the five fractional values I probed threw, so the honest
description is "data-dependent and frequent", not a fixed rate.

**The fix is one token**: `timeout: Math.round((s + 5) * 1000)` at `:494`.

**Not a blocker for this epic.** The line is byte-identical on `main` at the
merge base (`git show 9614c09:plugins/delivery-pipeline/scripts/ci-wait.cjs`
lines 451 and 505), and `git diff 9614c09 HEAD -- .../ci-wait.cjs` contains no
change to `sleep`, `spawnSync` or the deadline arithmetic. Merging this epic does
not make it worse, and refusing the epic does not make it better.

**What phase 26 DID do to this file is correct**, on both halves the operator
asked about:

- unparseable config, board with work → refuses as **data**, not a death:
  `{"waited": false, "refusal": "the board has 3 actionable item(s) …"}`, exit 3.
  `CONFIG_FIELDS`/`config_note` carry the reason on every result, and the park
  path marks `refused: true` rather than a failed write (`:429-430`).
- unreadable check answer (`gh` stub printing non-JSON on stdout and
  `HTTP 503` on stderr) → `outage: true`, `escalated: []`, nothing recorded.
  Which is right: an outage is not three pipelines stalling at once.

## Seam 5 — the whole phase against phase 25

- Ladder verified by running (above): `sonnet`/`high`, `opus`/`high`,
  `opus`/`xhigh`. T-26-02's `valid`/`error` and T-26-12's cap sit beside the
  ladder in `pipeline-config.cjs` without touching it.
- **No Codex behaviour moved.** `git diff 9614c09 HEAD --
  scripts/gen-codex-shipyard.cjs` is empty; so are the diffs for
  `plugins/delivery-pipeline/references/`, `CLAUDE.md`, `README.md` and `docs/`.
  `scripts/merge-codex-config.cjs` DID change (+402) and `test-codex-shipyard`
  is green on it.
- **No Codex prose inversion risk from this phase.** `decompose.md` changed 62
  lines and not one added line mentions Claude, Codex or "runtime", so the
  generator's substitution pass has nothing to invert.

---

## The three cross-ticket doc seams — the phase-25 shape, found again

**Why these are follow-ups where phase 25's were a `needs-fix`.** Phase 25's
three stale artifacts named VALUES a reader acts on — a model tier, a version
pin — so a reader who believed them made a wrong choice. All three below name
MECHANISMS nobody acts on: the delivery loop reads `capacity.free`, the number,
not the paragraph describing it; a session reading `CLAUDE.md` is oriented by it,
not instructed. And for the first one specifically, **which side moves is itself
the phase-27 decision** — if the counting unit becomes agents, the prose is
already right; fixing the prose now would be picking that answer without the
ticket.

1. **`deliver.md:996-1003` asserts a behaviour the code does not have, inside
   the ticket that wrote both.** The paragraph T-26-12 added says the wave is
   `capacity.free` = "`max_concurrent_agents` minus every **agent** already in
   flight (the guard and its fixers included, since each one costs the session
   the same as an executor)". The code counts dispatch **records**
   (`front.cjs:742`, `Object.keys(dispatched).length`), and `deliver.md:1129`
   files one per guarded ticket for a single guard agent. So the doc's unit and
   the code's unit differ, in the same ticket, in files 130 lines apart. Two
   lines to fix; it is this repository's own named recurring defect.
2. **`CLAUDE.md`'s deterministic-layer list never learned this phase.** It has
   no entry for `path-owner.cjs` — D1's single ownership matcher, which Gate 2,
   the scope gate and base-merge now all route through — none for
   `drift-needed.cjs` (+507), and no mention of `check-state.cjs` at all.
   `CLAUDE.md:104` still describes lock takeover as "a lock directory with no
   `owner.json`, or one older than the TTL, is taken over", with nothing of
   D5's ownership proof or atomic rename. Not load-bearing for a dispatched
   agent — `references/` is untouched and clean, which is the file a fixer reads
   — but it is the file every new session reads first.
3. **`tests/unit/front.test.cjs` comments name the wrong caller** (already in
   the backlog). Confirmed at the call site: `state-sync.cjs`'s `computeFront`
   invocation passes `parked, autoMerge, drifted, escalated, dispatched,
   ci_estimates, epics` — neither `mergeWithoutCi` nor `maxConcurrentAgents`.
   Both are served by `computeFront`'s own lazy resolver, which is correct;
   only the comment is wrong.

## The interlock — measured, not in the backlog, and the reason phase 27 needs a ticket

On a capacity-full board the conveyor's three mechanisms give three mutually
incompatible orders about the same board. All three run against the fixture in
seam 2:

```
front.cjs    → "capacity is full … Do NOT dispatch past the cap and do NOT call
                this an ending — collect the agents that are out, then recompute"
ci-wait.cjs  → refuses, exit 3: "the board has 3 actionable item(s)
                (execute: T-99-05, T-99-06, T-99-07) … Take that work first."
stop-gate.cjs→ {"decision":"block", … "Ending the run here is a defect, not a
                choice … take the actionable items"}
```

The front forbids dispatch, the waiter forbids waiting, the gate forbids
stopping. `stop-gate.cjs:547` puts its only with-an-agent hatch behind
`count <= 0 || leftBehind >= count`, so with three executable tickets it never
opens. The loop's sole legal move is to recompute a board that will not change
until the guard reports.

It is bounded, in three independent ways, which is why it is a follow-up and not
a blocker: `deliver.md:1129` tells the loop to clear each `pr-sentinel` record
when the guard's report comes back for it; a record lifts by itself when the PR
merges or its base moves, and unconditionally at the 90-minute
`SHIPYARD_DISPATCH_TTL_MS`; and the stop gate's refusal ledger repeats only once
the board has advanced. It also fails in the safe direction — the wrong answer is
"dispatch nothing", never "dispatch past the cap".

---

## Ruling on the backlog — what blocks this merge

**Nothing.** Item by item:

| backlog item | ruling |
| --- | --- |
| §"Three more" 1 — capacity counts RECORDS, one guard fills the cap | **Does not block.** Reproduced exactly (`in_flight: 4` from one guard, `free: 0`, no executor launches). Phase 27 can run under it with one interim: raise `delivery_pipeline.max_concurrent_agents` — a declared, GSD-settable knob (`capability.json`, default 4) — above the expected guarded-PR count. The permanent fix is phase 27's first ticket, and its acceptance criterion should be the **interlock** above, not only the counting unit. |
| §"Three D2 gaps" 1 — `front.cjs` standalone CLI | **Does not block, and is materially smaller than recorded.** The corrupt answer is no longer byte-identical to valid `epic`; the cap forbids the dispatch and names the file. Residual: a misattributed bucket at `front.cjs:1242`. Fold into the same phase-27 ticket. |
| §"Three D2 gaps" 2 — `gsd-tune --global` misattribution | **Does not block.** Install-time, untouched by this epic, project mode already immune. |
| §"Three D2 gaps" 3 — `gen-codex-shipyard.cjs:206` | **Does not block.** Install-time, and the file is not in this epic's diff at all. |
| §"Three more" 2 — no stop-gate hatch for `capacity.max === 0` | **Does not block.** Same ticket as the interlock: the gate reads no `capacity` field at all, so `max: 0` and `free: 0` are the same hole seen from two angles. |
| §"Three more" 3 — wrong caller in two test comments | **Does not block.** Confirmed wrong; comment-only. |
| §"shared numeric rule" — `true` → 1, `4.5` → fractional `free` | **Does not block.** One `Math.floor` plus a type check in `loadConfig`. Worth folding into the same ticket: a fractional `free` interacts with the interlock — `0.5` reads as "dispatch nothing" while `free !== 0`, so the capacity fixpoint branch never fires and the run gets the generic "ending here is a defect" instead. |
| §"Five constraints" 1–5 | **All satisfied**, checked at the code: `sentinel.cjs` exposes module-level `CFG_VALID`/`CFG_ERROR` and T-26-12 does not re-read the config; `dutySummary`'s early literal and the `merge --all` selection are intact (the sentinel smoke asserts both — "duty says config-invalid … in exactly one line" and "merge --dry-run refuses and names the file"). |

## Release order

- **`make test-codex-shipyard` belongs BEFORE the merge**, per this repo's own
  five-step release rule, and T-26-06 changed the exact file it exercises. It is
  HOME-isolated and I have already run it: **green, exit 0**. Nothing owed.
- **The Docker targets are not a blocker for this epic, mechanically.** The diff
  touches no `Dockerfile`, `Dockerfile.base`, `docker-compose.yml`, `k8s/`,
  `Makefile` or `scripts/entrypoint.sh` (verified: `git diff --stat` over all of
  them is empty). `make test-base` runs `make build-base` itself, so a green
  there would describe the base pin — which this epic did not move. ADR-003's
  recorded decision stands unchallenged by anything in this phase.
- **The version needs a bump before the tag.** `plugin.json` and
  `capability.json` both say `0.47.0` and AGREE, so `make test-overlay`'s drift
  check is safe — but `0.47.0` is what phase 25 released (`75ae2de`), and this
  epic adds a declared config key plus fifteen tickets of behaviour underneath
  it. `0.48.0` belongs **on the epic, before the merge**, which is where phase 25 did
  it (`75ae2de`, on `epic/25` ahead of `9614c09`) and what the five-step rule's
  order requires — bump, `test-fast`, merge, tag. Not a blocker on the epic's
  content, the same ruling phase 25's integrator gave its own item D. Separately, the newest tag is
  `v0.45.0` while the code says `0.47.0`, so tags and `gh release create` for
  the intervening versions look owed — `make test-releases` is the check that
  says so.

## Follow-up I deliberately leave

`ci-wait.cjs:494`'s fractional `spawnSync` timeout is the most serious defect I
found and I am deliberately NOT making it a fix-ticket on this epic: it is on
`main` already, so blocking a green epic on it buys nothing and costs the phase.
It should be the phase-27 ticket that runs BEFORE the capacity one, because the
capacity interlock's stated escape ("collect what is out, then recompute") leans
on a waiter that survives its own timeout.

Two `Math.floor` shaped items (the shared numeric rule) and the three doc seams
above are all one-file, no-dependency tickets; none of them changes a mutation
decision, which is why none of them holds up a phase whose whole subject is
mutation decisions.
