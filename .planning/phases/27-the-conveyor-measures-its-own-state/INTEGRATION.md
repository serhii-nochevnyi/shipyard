# Phase 27 — INTEGRATION: needs-fix

**Verdict: `needs-fix`.**

Three decisions are short on the phase's own terms, and one of them — D2 — shipped
as a complete mechanism with nothing wired to its input, so the measured saving
that justified the ticket is unreachable through any documented path. None of the
three is a correctness fault: every failure direction is closed (a carry that
cannot fire simply re-owes the verdict, exactly as before the verb existed), and
`make test-fast` is green at the epic head (`868e9c7`). What is wrong is delivery
of the decision, not the behaviour of the code that shipped.

Subject: `git diff main...origin/epic/27-the-conveyor-measures-its-own-state`
(42 files, +5587/−250), read in dependency order — gate-trailer → base-merge →
parent-moving → sentinel → front → state-sync → stop-gate → ci-wait →
pipeline-config → dispatch-record → log-event → epic-branch.sh →
ticket-worktree.sh → drift-gate.mjs → gsd-tune → gen-codex, then the prose, then
the tests. Baseline established in a throwaway worktree at the epic head before
anything was judged.

---

## 1. Is each decision actually delivered?

| | decision | mechanism in the diff | delivered |
|---|---|---|---|
| D1 | the cap counts agents, three readers agree | `AGENT_CARDINALITY` + `agentsInFlight()` (`front.cjs:1135-1166`), `capBinds` (`ci-wait.cjs:220`), `capMax === 0 → allow()` and `capacityFull` (`stop-gate.cjs:536, :620`), `workflows-args.test.cjs` | **yes** |
| D2 | a verdict survives a head move it provably covers | `gate-trailer.cjs carry` (`:403-556`), `--base-tree` on `write` (`:329-333, :371`), `base-merge.cjs carryVerdict()` (`:156-199`) | **mechanism yes, phase no** — see §2.1 |
| D3 | a base is chosen for where the merge lands; the epic is asserted to have received it | `state-sync.cjs:603-651` (`base` + `base_reason`), `limbBaseOf`/`limbRemedy` (`parent-moving.cjs:87-144`) shared by `front.cjs:452-454, :669-697` and `sentinel.cjs:487-489, :662, :894`, `epicReceived()` (`sentinel.cjs:200-274`, called at `:1096`) | **yes** |
| D4 | an epic learns what landed under it; a worktree is cut from what the board named | `epic-branch.sh refresh` (`:235-329`) with `worktree_holding`/`collect_ref_move` (`:132-198`), `ticket-worktree.sh resolve_base` origin-first (`:121-146`) + `reuse_distance` (`:148-166`) | **yes** |
| D5 | a journal records what was applied and refuses to be written around | `dispatch` in `OWNED_BY_SCRIPTS` (`log-event.cjs:162-167`), `SHA_FIELDS` (`log-event.cjs:227-228`), `routeOf`/`parseRoute` (`pipeline-config.cjs:1070-1086`), `REFUSED_FLAGS` + `--route` + `agentFilesFor` (`dispatch-record.cjs:177-183, :326-372, :397-411`) | **yes, with one substitution** — see §1.5 |
| D6 | the front says when it is behind; one dispatch carries one base | `movedSince`/`stateDerivedAt`/`behindWarning` (`front.cjs:1217-1302`), per-ticket `baseRef` (`drift-gate.mjs:115-121`) | **yes, with one blind spot** — see §3.6 |
| D7 | a guard asserts a sweep, not a list | the `git ls-files` sweep in `tests/smoke/docs-smoke.sh` (+130), `tests/unit/source-contract.test.cjs` (new, 153 lines), both `1.7.0` hints removed from `install-shipyard-capability.sh:28-29` | **yes** |
| D8 | the remaining ADR-004 D2 gaps, and the records that contradict themselves | `configRefusal` (`front.cjs:1537-1592`), `CONFIG_REFUSAL` (`gsd-tune.cjs:171-176, :539-547`), `!loaded.valid` return (`gen-codex-shipyard.cjs:232-243`), the shared numeric rule (`pipeline-config.cjs:710-730`), ADR-005 `Supersedes`, ADR-003 Context, the escalation table in the spec doc | **partly** — see §2.2 and §2.3 |

### 1.5 D5's one substitution, and it is the right one

The plan's acceptance criterion reads "`mark` without it records the resolver's
route verbatim". The shipped recorder does not call the resolver: `--route` is a
flag the caller passes, holding the resolver's `route` field unchanged, validated
against `parseRoute` — the resolver's own exported grammar — and cross-checked
against `--model`/`--effort` (`dispatch-record.cjs:326-372`). A recorder that
re-derived the route would record the ladder's opinion of a dispatch rather than
the dispatch, which is the exact defect D5 exists to remove, so the substitution
is faithful to the decision and contradicts only the criterion's wording. It is
noted here rather than filed as a fault.

---

## 2. Emergent violations — what only the sum shows

### 2.1 D2 shipped complete and inert: nothing anywhere passes `--base-tree`

This is the phase's one real hole, and no single arch-review could have seen it,
because every ticket that could have closed it conformed on its own contract.

- `gate-trailer.cjs write` accepts `--base-tree` and writes `base_tree=` only when
  given one (`gate-trailer.cjs:329-333, :371`).
- `carry` refuses outright when the trailer carries no `base_tree`
  (`gate-trailer.cjs:484-489`) — "absent proof is not proof", correctly.
- The only two documented `write` invocations in the whole repository —
  `plugins/delivery-pipeline/commands/deliver.md:1404` and
  `plugins/delivery-pipeline/references/pr-sentinel.md:195` — **do not pass it.**
  `grep -rn "base.tree" plugins scripts docs capabilities tests/smoke` returns
  hits only in `gate-trailer.cjs` and in `references/arch-review.md`.
- `references/arch-review.md:28-49` instructs the *judge* to REPORT `base_tree`,
  and even names the flag — but the judge does not write the trailer. The
  orchestrator and the guard do, from two literal command lines that were not
  changed.

Consequence: every trailer the conveyor writes carries no `base_tree`, so every
`carry` refuses, so `base-merge.cjs` prints "No verdict carried" on every cascade
step and arch-review is re-bought exactly as before. The ~150k-token, 42%-of-a-
ticket saving that is D2's entire justification is not in force anywhere.

T-27-02's PR body (#64) states the gap explicitly — *"nothing in the conveyor
passes `--base-tree` yet … `deliver.md` / `pr-sentinel.md` — where that wiring
lives — belong to later tickets of this phase … turning it on is one flag in one
prompt."* Five later tickets touched `deliver.md` (T-27-03, T-27-04, T-27-05,
T-27-06, T-27-08) and one touched `pr-sentinel.md` (T-27-05). None did it. A
deferral addressed to "later tickets of this phase" was never anybody's
`files_modified` line, so it fell through the cascade.

It also escaped the one guard built for this class. `tests/unit/trailer.test.cjs:473-528`
pins both docs against the script's own `USAGE` — its comment says, verbatim,
*"`deliver.md` and the script's USAGE carried it and `pr-sentinel.md` did not —
the three texts disagreeing about the one flag that decides WHICH repository is
written to"* — and `--base-tree` was added to `USAGE` (`gate-trailer.cjs:76-78`)
without being added to `REQUIRED_FLAGS`/`OPTIONAL_FLAGS`. The guard is the right
guard, one row short.

Failure direction is safe (fail-closed: no carry, verdict re-owed), which is why
this is `needs-fix` and not `human-review-required`.

### 2.2 ADR-003 D2 still asserts what ADR-005's new `Supersedes` — written in this diff — says is retired

The arch-review judge referred this one up. My answer: **it is a D8 shortfall for
this phase, not a follow-up**, and the discriminator is T-27-08's own goal
sentence — *"no record in this repository asserts what a later amendment
retired."*

`ADR-003-the-conveyor-follows-the-models-it-runs-on.md:74-80` (D2) still reads "The generator **stops writing** `model =`
from the catalog" and "**No model id is hardcoded anywhere in shipyard**".
`ADR-005-the-floor-is-opus-and-fable-is-earned.md`'s `Supersedes`, rewritten by T-27-08 in this very diff, now names
that clause as retired by D6/D7/D8. The code agrees with ADR-005: the generator
writes `model` again from `pipeline.codex_models`, and `capability.json` ships a
palette of literal model ids as its default — which `CLAUDE.md` itself calls "the
only place a model id may appear as a value". So ADR-003 D2 contradicts the
shipped code *and* the ADR that supersedes it. `ADR-003-the-conveyor-follows-the-models-it-runs-on.md:81-99` (D3) already
carries a strikethrough of exactly the required shape, written for exactly this
reason ("an amendment that lands beside a stale assertion and leaves it
standing") — so the precedent, the template and the motive are all in the same
file, three lines apart.

T-27-08 wrote the forward pointer and not the backward strike. One edit closes it.

### 2.3 `CLAUDE.md` now states a rule the phase falsified — and it is the file every agent reads first

D8's subject is "the records that contradict themselves". The phase corrected two
ADRs and a spec document and left the repository's own architecture record
carrying a claim this phase made false:

- `CLAUDE.md:96` — *"`ci-wait.cjs` REFUSES (exit 3, `waited: false` under `--json`)
  **whenever anything is actionable** or a ticket is with an agent"*. T-27-01
  deleted that: `ci-wait.cjs:215` now suppresses the actionable refusal when
  `capBinds` (`max` readable, `free <= 0`). The sentence is now simply untrue, and
  it is written in the emphatic "the distinction is MECHANICAL, not remembered"
  register that makes a reader trust it.
- `CLAUDE.md:97` enumerates stop-gate's escape hatches — "no front, nothing
  actionable AND nothing in CI, all-left-behind with an empty CI bucket, a ticket
  with an agent, a session that has spent its refusals, an ancient front, and
  `SHIPYARD_STOP_GATE=off`". T-27-01 added **two more**: `capMax === 0 → allow()`
  (`stop-gate.cjs:536`) and `capacityFull && agentsOut().plausible.length →
  allow()` (`stop-gate.cjs:620`). The list is load-bearing by CLAUDE.md's own
  words and is now incomplete.
- `CLAUDE.md:105` describes `epic-branch.sh` without the `refresh` verb, and the
  `gate-trailer` mechanism is nowhere described with its `carry` half. Additive
  rather than contradictory, so lower priority than the two above.

### 2.4 `epic_unreachable` — a new script-owned event that D5 closed the door behind

T-27-03 introduced a journal event nothing else writes
(`sentinel.cjs:1098-1102`), and T-27-05 — the later ticket in the same chain,
whose whole subject is "the journal refuses to be written around" — added
`dispatch` to `OWNED_BY_SCRIPTS` and did not add this one. So
`log-event.cjs epic_unreachable ticket=… paths=…` is hand-writable today, and the
alarm the operator is meant to trust ("recorded as `epic_unreachable` in the
journal", `sentinel.cjs:1149`) can be forged. It is also absent from
`DECLARED_FIELDS`, so a line missing `paths` or `epic` warns about nothing.

Same seam, two more prose consequences:

- `deliver.md:663` still says "**Four** more events are refused there" and its
  code block lists `plan_defect`, `flake`, `flake_rerun`, `flake_lift`.
  `OWNED_BY_SCRIPTS` now holds eight entries including `dispatch`. The count and
  the list are both one short of the constant.
- `deliver.md`'s journal vocabulary never mentions `epic_unreachable` at all, so
  the one event that reports the PR #52 class is undocumented in the file the
  orchestrator reads.

### 2.5 A fourth ADR-004 D2 reader, made durable by the same phase that enumerated three

D8 named three readers that "take defaults from a config that does not parse":
`front.cjs`'s CLI, `gsd-tune --global`, `gen-codex-shipyard.cjs`. `pipeline-config.cjs
model <role> --json` is a fourth, and it still answers off the defaults —
verified live in a temp cwd with a deliberately unparseable `.planning/config.json`:

```
$ node pipeline-config.cjs model executor --json
pipeline-config: warning: .planning/config.json is not valid JSON … INVALID: no policy is in effect …
{"model":"opus","effort":"high","route":"tier=floor(opus) effort=row(high)"}   # exit 0
```

Before this phase that answer was ephemeral. T-27-05 made it **durable**:
`dispatch-record.cjs mark --route` writes that exact string into the journal as
`reason`, i.e. as the ladder's own answer, with nothing on the record saying the
policy could not be read. The warning is on stderr and the journal keeps none of
it. In the conveyor's own loop this is unreachable (a corrupt config drives
`capacity.max` to 0 and nothing dispatches), so this is a follow-up rather than a
blocker — but it is the phase's own subject arriving one file past its own
enumeration.

### 2.6 `deliver.md:1131` overclaims the guard it describes

*"The recorder checks the route against the pair, so a route copied from the
previous round is refused rather than filed."* The check
(`dispatch-record.cjs:340-361`) compares the route's parenthesised tier and
effort against `--model`/`--effort`. Under the opus floor most roles resolve to
the same pair, so a route copied from another role or another round with the same
`(opus, xhigh)` passes silently. The mechanism is real; the sentence claims more
than it does, in a file whose whole discipline is that a claim about a mechanism
must be checked against the mechanism.

---

## 3. Compositions I checked that could have broken and did not

Stated because a verdict with no exposure is not a verdict.

**3.1 `front.cjs` under four tickets at once.** T-27-01's capacity, T-27-03's limb
branch, T-27-06's behind-line and T-27-08's config refusal all land in one file
and one render path. Run against a built fixture (a merged parent, a child whose
`pr_base` still names the parent's branch, a journalled `merge` newer than
`generated_at`):

- valid config → `waiting: merge (human): T-09-02`, and `sentinel.cjs duty` on the
  same board → `human-merge T-09-02 … base "ticket/T-09-01-a" is T-09-01, whose
  ticket is already MERGED`. **The board and the guard give the same verdict with
  the same remedy text**, which is the property the first amendment to T-27-03's
  plan was written to restore. Both read `pr_base || base`
  (`front.cjs:452-454`, `sentinel.cjs:501`) — one predicate, one base rule.
- corrupt config → the refusal line prints FIRST, the behind-line second, and
  `fixpoint: NO — and not a round to retry either`, i.e. the config refusal wins
  the fixpoint chain ahead of the `YES` branch (`front.cjs:1375-1396`). The two
  new leading lines do not fight for the same slot.

**3.2 The `max === 0` invariant survived two tickets pulling opposite ways.**
`front.cjs:420-426` reserves `capacity.max === 0` for exactly one fact — no policy
could be read — and `stop-gate.cjs:536` and `formatFront` both word themselves off
it. T-27-08's plan asked for `max_concurrent_agents: 0.5` to "floor to 0 and the
capacity fixpoint branch fires", which would have destroyed that reservation. The
implementation runs the floor *before* the positivity check
(`pipeline-config.cjs:710-730`), so `0.5 → 0 → fall back to the default`, and the
code carries the reason in full, and so does the test that pins it —
`tests/unit/pipeline-config.test.cjs:159-170` states the divergence and asserts
`0.5 → DEFAULTS[knob]` for every knob. **A ticket knowingly contradicted its own
acceptance criterion to keep a cross-file invariant, and said so.** That is the
right call and the right record.

**3.3 The duplicated tail readers.** `front.cjs:1217-1262` and
`stop-gate.cjs:296-344` are twins by copy, on purpose (the hook is installed as a
single file). They differ in exactly the two ways `front.cjs`'s own comment
declares — the hook additionally counts `escalation`, and the hook bounds
candidates by `RESYNC_MS` — and in nothing else: identical 64KB tail, identical
`merge`/`attempt … pushed`/`fix_round … pushed` set, identical `status_change`
and `dispatch` exclusion, identical `if (seeked) lines.shift()`.

**3.4 The squash-merge duplication class did not survive into the epic.**
`.planning/backlog/a-clean-merge-can-duplicate-a-block-two-branches-added-alike.md`
records `epic-branch.sh` acquiring two byte-identical `cleanup()`/`trap` blocks
through a conflict-free merge, twice. At the epic head: `cleanup()` = 1,
`trap cleanup` = 1, `lock_mtime()` = 1. A sweep for duplicated top-level
`function`/`const` definitions across every changed `.cjs`/`.mjs` returns nothing.

**3.5 No `--reason` caller survives its own refusal.** T-27-05 makes
`dispatch-record.cjs mark --reason` fail. `grep -rn -- "--reason" plugins scripts
docs capabilities` returns two hits, both prose explaining the removal. The
workflows do not call `mark` at all, so the Workflow path cannot trip it. The
`pr-sentinel.md` half — the trap the plan's amendment was written for — is fixed
(`references/pr-sentinel.md:318`).

**3.6 `epic-branch.sh refresh` does not corrupt a checked-out branch.**
`collect_ref_move` (`epic-branch.sh:159-197`) refuses to `update-ref` a branch some
worktree holds, and does `git -C <wt> merge --ff-only` instead, reporting rather
than failing when that is declined. It is also strictly a fast-forward: a local
ref that is not an ancestor of the target is left alone with a named reason. And
the base it merges is `default_branch()`, which reads `git.base_branch` first
(`epic-branch.sh`'s `default_branch()`) — so a project integrating into `develop` does not get
`main` merged into its epics. *The blind spot:* a `refresh` push writes no journal
event, so `front.cjs`'s behind-line cannot see it. `deliver.md`'s Step 2a covers it
with prose ("If ANY refresh printed `"pushed":true`, run `state-sync.cjs` once
more") — which is a prose rule holding a mechanical obligation, the class this
phase is named after. Low cost (the condition is a JSON field, not a judgement),
so: later, not now.

**3.7 The mutation-check requirement holds.** Every one of the eight PR bodies
carries the applied-mutation transcripts its plan demanded, with the failing test
named and the revert re-run to green: #63 two, #64 seven (five killed, one
expected survivor, and **M4 a genuine blind spot the criterion predicted and the
ticket then closed**), #65 four, #66 two, #68 six, #69 seven, #70 three, #71
twelve. One substitution is declared rather than hidden: PR #66 states that
T-27-03's "invert the open/merged test and `sentinel.test.cjs` fails" criterion
"is only buildable at the merge gate", and builds it there — state-sync's
missing-fact arms are not red on base because they are new arms rather than
inverted ones. That is an honest reading of an unbuildable criterion, not a
skipped mutation. I re-ran three independently in a clean worktree:

| mutation | expected victim | observed |
|---|---|---|
| `dispatch` removed from `OWNED_BY_SCRIPTS` | `log-event.test.cjs` | 17 passed, **1 failed** — *"the dispatch event is refused — marking and journalling are ONE act"*; revert → 18/0 |
| `status_change` added to the counted events | `front.test.cjs` | 156 passed, **1 failed** — *"a tail of ONLY status_change and dispatch newer than the state prints NOTHING"*; revert → 157/0 |
| a duplicate `ARG GSD_CORE_VERSION=` in `Dockerfile` | `docs-smoke.sh` | red, naming both values and refusing to guess which is effective; revert → passes |

**3.8 Other things checked, clean.** No trailer reader consumes the `checks` key,
so `carry` dropping it breaks nothing (`grep` for `gate.checks` → zero readers).
`plugin.json` and `capability.json` are both at `0.48.0`. Nothing in the diff
touches anything ADR-006 parked — no `diamond`, no config-warning-namespace, no
orchestrator-facts. `delivery.branch` in T-27-08's frontmatter is a pre-existing
validated field (`validate-graph.cjs:173-186`), not something the phase invented.
`make test-fast` green at `868e9c7`. **And nothing in the diff risks the Codex
generator's "Claude" substitution**: `git diff main...origin/epic/27-… --
plugins/delivery-pipeline/commands plugins/delivery-pipeline/references | grep
'^+.*Claude'` is empty, so none of the eight tickets' new prose contains a
sentence whose meaning depends on naming Claude as a runtime distinct from the
reader's.

---

## 4. Did the phase widen?

No. Every item ADR-006's "What this ADR does NOT cover" parks is absent from the
diff. Two things grew *inside* scope and are worth naming as judgement calls
rather than breaches:

- **The shared numeric rule now floors every knob**, `stale_merge_hours` and
  `stale_draft_hours` included (`pipeline-config.cjs:710-730`). ADR-006 D8 asked
  for "one `Math.floor` … in `loadConfig`'s shared numeric rule", so sharing is
  sanctioned — but the consequence is that a legitimate `stale_draft_hours: 0.5`
  (30 minutes) now floors to 0 and falls back to the default with a warning,
  where it used to be honoured. The defect being fixed was about agent counts.
  Worth a ticket, not a blocker.
- **`epic-branch.sh refresh` fast-forwards the operator's own checkout** when it
  holds the base branch. That is D4's explicit instruction ("whatever performs it
  also fast-forwards the local base and epic refs"), it is `--ff-only`, and it is
  reported — so it is in scope. Recorded here only so the behaviour is not a
  surprise the first time Step 0 runs on a machine with `main` checked out.

---

## 5. Do the backlog findings mean the phase's code is WRONG?

Not re-derived; one sentence each on the only question an integrator owes.

| finding | wrong, or merely incomplete? |
|---|---|
| `base-merge` refuses on the conveyor's own untracked scratch files (and `gc` never prunes) | **Incomplete, but it is the amplifier for §2.1.** T-27-02 made `base-merge` the sole trigger of `carry`; in this repository `base-merge` cannot run at all on an executor worktree, so even once `--base-tree` is wired, D2 stays unreachable *here*. Neither ticket is wrong; the pair is worth sequencing. |
| `scope-gate` answers from a worktree's frozen `tickets.json` | Incomplete. Untouched by this phase, and `graph-dir.cjs`'s resolution order already bounds it. |
| a plan amended on a ticket branch is inert for every gate | Incomplete, and the phase already handled it correctly in practice — T-27-05's amendment says so in its own body and was mirrored onto the planning branch. |
| Gate 2 passes a declared path that does not exist | Incomplete. T-27-08's executor refused to guess and named the gap, which is the behaviour the guarantee depends on. |
| a squash-merge cascade duplicates a byte-identical block with no conflict | **Was** wrong; verified fixed at the epic head (§3.4). Nothing left to do in this phase. |
| the attempt backstop cannot tell real fixes from retries | Incomplete. Not a defect in shipped code — it is a missing distinction in `attempt-history`. |

---

## 6. Follow-ups

### Must fix before this lands

Only item 1 is a conveyor change and therefore the only one shaped as a
fix-ticket for `validate-graph`. Items 2-4 are **landing edits**: two planning-
branch record corrections and one config value. They do not go through the
delivery loop and should be committed with the integration merge.

#### Fix-ticket (ready for validate-graph)

1. **Title: "The judge's base tree reaches the trailer, so a carry can fire"**

   *Scope.* `deliver.md:1404` and `references/pr-sentinel.md:195` pass
   `--base-tree <the judge's reported base_tree>` on the `gate-trailer.cjs write`
   invocation, and each names where the value comes from — arch-review's
   `base_tree:` output field (`references/arch-review.md:28-49`), so the
   orchestrator is not left to guess. `--base-tree` joins
   `tests/unit/trailer.test.cjs`'s `OPTIONAL_FLAGS` (`:494`) so both docs are
   pinned against `USAGE` the way `--repo` already is — the guard exists for this
   exact class and is one row short. Nothing in `gate-trailer.cjs` or
   `base-merge.cjs` changes; the mechanism is already correct.

   *Out of scope.* Any tolerance in the two identities. Teaching `carry` to
   compute a base tree the judge did not measure — "a base_tree nobody measured"
   is what the writer refuses on purpose.

   *files_modified:*
   - `plugins/delivery-pipeline/commands/deliver.md`
   - `plugins/delivery-pipeline/references/pr-sentinel.md`
   - `tests/unit/trailer.test.cjs`

   *depends_on:* `[]` — no other ticket touches these three together.
   *risk:* low. *human_checkpoint:* false.

   *Acceptance.* A `write` invocation in either doc without `--base-tree` fails
   `trailer.test.cjs`; on base the suite is green with the flag absent from both,
   so the test fails before the fix.
   *Mutation check.* Remove `--base-tree` from either doc, watch the pin fail,
   revert, re-run green.

#### Landing edits (not tickets)

2. **Strike ADR-003 D2's retired clause.**
   `ADR-003-the-conveyor-follows-the-models-it-runs-on.md:74-80` — strike "The generator stops writing `model =` from the
   catalog" and "No model id is hardcoded anywhere in shipyard", in D3's existing
   format (`:81-99`), pointing at ADR-005 D6/D7/D8 and naming what survives (the
   effort is still written per role; a user's GSD remap still outranks ours).
   This is REQ-53's own goal sentence, not a matter of taste.
   *Files:* `.planning/architecture/ADR-003-the-conveyor-follows-the-models-it-runs-on.md`.

3. **Correct `CLAUDE.md` where this phase falsified it.**
   `:96` — `ci-wait.cjs` no longer refuses on an actionable board the cap has
   spent. `:97` — add the two new stop-gate hatches (`capacity.max === 0`, a full
   board with a plausible agent out). `:105` — name `epic-branch.sh refresh`, and
   name `gate-trailer.cjs carry` where the trailer is described.
   *Files:* `CLAUDE.md`.

4. **`delivery_pipeline.max_concurrent_agents` back to `4`.**
   `.planning/config.json:112` still reads `8` — the temporary value raised on
   2026-09-08 because the cap counted records. Per
   `.planning/backlog/phase-27-followups.md`, the agent-shaped count is only in
   force for a session once the epic's integration PR lands on `main`, so this is
   the lander's action and it is due now.
   *Files:* `.planning/config.json`.

### Worth a ticket later

5. **`epic_unreachable` joins `OWNED_BY_SCRIPTS` and the docs.** Add it to
   `log-event.cjs`'s owned set with the `duplicate` message (its owner is
   `sentinel.cjs merge`), give it a `DECLARED_FIELDS` row, and document it in
   `deliver.md`'s journal vocabulary. While there: `deliver.md:663` says "Four
   more events are refused" over a constant that now holds eight, and its list
   omits `dispatch`.

6. **`pipeline-config.cjs model` is the fourth ADR-004 D2 reader.** Either carry
   `config_invalid` on the `--json` answer (so `dispatch-record mark --route`
   can refuse to file a route derived from an unreadable policy), or state
   explicitly in the resolver why it is exempt.

7. **`deliver.md:1131` should describe the cross-check it has**, not a stronger
   one: the route is checked against the pair, which catches a route from a
   dispatch that resolved differently and not one that happens to share
   `(opus, xhigh)`.

8. **A `refresh` push should be visible to the behind-line.** Today only `merge`
   and pushed `attempt`/`fix_round` count, and `deliver.md`'s Step 2a holds the
   resync obligation in prose. Journalling the push (or teaching `movedSince`
   about it) turns the phase's own rule on itself.

9. **Do not floor the hour knobs.** Exempt `stale_merge_hours` /
   `stale_draft_hours` from `Math.floor`, or document that they are integers —
   `0.5` silently becomes the default today.

10. **A board whose only content is a limb child reads as finished.** In the §3.1
    fixture, `waiting.merge_human: T-09-02` and nothing else gives
    `fixpoint: YES — … only human actions and blockers remain → Step 5`. Before
    T-27-03 that child sat in `actionable.merge` forever, which was wrong the
    other way; now the phase is handed to the integrator with work stranded on a
    limb, which is PR #52 one level up. Retargeting is deliberately out of
    T-27-03's scope, so the question is only where the operator is told: either
    the fixpoint line names the outstanding retarget, or Step 5's own preconditions
    do.

11. **`tests/smoke/sentinel-smoke.sh:1647`** opens an **unquoted** heredoc whose
    body contains `` `pending` `` in a comment, so bash runs command substitution
    on it: every `make test-fast` prints
    `./tests/smoke/sentinel-smoke.sh: line 1647: pending: command not found`.
    Harmless as written and a live command-substitution site in a test file.
    Quote the delimiter (`<<'STUB'`) or drop the backticks — note the stub
    interpolates `$ROOT_OID`/`$CHILD_OID`, so quoting the delimiter needs those
    passed by environment instead.

---

## 7. What this verdict rests on

`needs-fix` is driven by item 1 alone: REQ-47's mechanism is in the tree, tested
in seven mutation-checked ways, and connected to nothing. Items 2 and 3 are the
phase's own REQ-53 arriving incomplete, and they are cheap. Item 4 is a value the
phase deliberately borrowed and owes back.

Everything else in the phase composes. The four tickets that shared `front.cjs`
produce one coherent render order; the board and the guard agree on the limb rule
against a live fixture; the `max === 0` reservation survived two tickets pulling
at it, because one of them noticed and wrote the reason down; the twin tail
readers differ only where they declare they do; and the mutation discipline
ADR-006 made this phase's acceptance rule was actually kept, including the one
case (#64's M4) where it caught a guard that passed for the wrong reason. That
last one is the strongest evidence the phase did what it set out to do — the rule
found a defect in the ticket that wrote it.
