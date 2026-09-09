# ADR-007 — A mechanism nobody connected is not a mechanism

- **Status**: accepted
- **Date**: 2026-09-09
- **Extends**: ADR-006, one layer inward. ADR-006 was about facts the conveyor
  ASSERTS without measuring. This is about mechanisms it BUILDS and never wires,
  and about the same "count instead of a set" shape recurring inside the fix.

## Context

Phase 27 shipped nine tickets against ADR-006 and its own integrator returned
`needs-fix` on one finding no arch-review could have seen: **D2 was complete and
inert.** `gate-trailer.cjs carry` was correct and seven times mutation-checked,
and neither documented `write` invocation passed `--base-tree`, so every trailer
recorded no proof and every carry refused at its own "absent proof is not proof"
rule. The ~150k-token saving that justified the ticket was unreachable for the
whole phase. T-27-09 wired it.

That is not an isolated slip. Re-reading the backlog after the phase, plus an
external revision dated 2026-09-09 whose seven findings were reproduced here
against this repository's own scripts, shows three families — and the first is
ADR-006's own closing sentence coming back.

### Family A — a count where a set was needed

ADR-006's Context ends: "A branch name instead of a ticket status. A sha instead
of a tree. An intent instead of an application. **A count instead of a set.** A
list of homes instead of a sweep." Two more instances, one pre-existing and one
introduced BY phase 27's fix:

- **The `repeat` verdict is unreachable when signatures alternate.**
  `failure-signature.cjs` keeps `seen` as a COUNT of a signature's occurrences
  after the last green, while the adjacency test looks only at the last pair.
  Reproduced with four real forty-character heads and `--k 3`:
  `A → B → A → A` gives `first → progress → progress → repeat_exhausted`.
  `repeat` never appears — and `repeat` is the only verdict whose `strategy` is
  `rethink`, the one step that means "a different hypothesis at the same tier".
  So the ladder skips thinking again and lands directly on the state that opens
  the `fable` ceiling route and then hands the ticket to a person. Two distinct
  signatures also keep `K=3` from firing, so `plan_defect` cannot intervene
  either. Cost: the most expensive attempt spent on an unreconsidered
  hypothesis, and autonomous repair ending one round early.
- **Two live guards count as one agent, and the error direction is now the
  unsafe one.** `front.cjs`'s `agentsInFlight` collapses with
  `perRound.add(role)` — a Set keyed on the ROLE STRING — and
  `activeDispatches` returns `{ticket: {role, at}}` with no identity, which
  `front.cjs:321`'s own comment states. `deliver.md` sanctions two concurrent
  guards ("Re-post a guard for PRs opened after it started"). Reported
  reproduction: four agents genuinely out, `max=4, in_flight=3, free=1`.
  `phase-26-followups.md` justified the OLD record-counting error by its
  direction — over-count, under-dispatch, a stall, annoying and harmless.
  Under-count OVER-dispatches past the cap, which is not a cap. T-27-01 fixed
  the safe error and introduced an unsafe one in the same mechanism.

### Family B — a reader with no writer, a flag with no caller

Each of these is correct code that nothing reaches:

- **The background judgment path has no producer for the fact its own
  escalation reads.** `references/pr-sentinel.md` contains ZERO occurrences of
  `log-event.cjs arch_review` and zero of `model arch-review`; `deliver.md`'s
  inline path has two of each. So a background-only run neither resolves the
  judge's model/effort from the resolver nor records the `arch_review` event —
  while the same file's contested-escalation rule reads a prior
  `verdict=violation`. It held this session only because the orchestrator
  patched both steps into every guard brief by hand.
- **`needsBaseMerge` occurs zero times in `deliver.md`**, so the argument
  `fix-round.mjs` documents in its own args contract is passed by nothing the
  docs describe. The `base_merge` journal event has a writer contract and a
  docs-smoke exemption claiming the script "journals itself", with no caller
  either.
- **`behind_by` is read by `front.cjs` and written by nobody.** T-26-15 shipped
  `merge_state` (one scalar on a call already being made) and not this. The pair
  exists because neither alone suffices: `mergeStateStatus: BEHIND` appears ONLY
  where branch protection requires up-to-date branches, while `behindBy()` works
  everywhere.
- **`drift-needed.cjs` is implemented and tested and called from no production
  command or reference.**
- **`--parked` on `front.cjs` renders and persists nothing.** The same flag on
  `state-sync.cjs` writes the durable board the stop gate enforces on. Both
  print the same answer; one is a no-op for everything that enforces. Measured
  when the stop gate correctly refused a stop whose board still listed an item
  the orchestrator believed it had parked.
- **`base-merge.cjs` and `ticket-worktree.sh gc` both refuse on the two
  untracked scratch files the conveyor itself writes into every executor
  worktree.** Both ask `git status --porcelain`, which counts untracked. So
  base-merge — named as THE remedy for a moved base in four files, three of them
  read by dispatched agents — refuses in the exact state the conveyor produces;
  and gc, the mechanism that exists to stop the E2BIG worktree blocker,
  classified all five phase-27 worktrees `dirty` including two whose PRs were
  merged, and reported `0 removable`. At this run's cold start there were 32
  worktrees, gc's own verdict was `0 removable`, and the count came down only
  because the reaper works from `reapable` instead.
- **Gate 2 passes a declared path that cannot exist.** `validate-graph.cjs`
  checks that a path parses, does not escape the repo root, and is not
  contested; it never asks whether the file exists, and the scope gate compares
  what a branch CHANGED, so a declared path nobody edited is invisible to it.
  T-27-08 was dispatched against `plugins/delivery-pipeline/scripts/gen-codex-shipyard.cjs`,
  which is not where that script lives.
- **`pipeline-stats.cjs` reports that a person merged what the guard merged.**
  Its `checkpoint_merge` predicate never asks WHO merged, and the comment
  justifying that says `sentinel.cjs merge` "refuses those outright... so a
  guarded one is impossible by construction". `delivery.preauthorized` then
  shipped and the journal records three phase-27 merges as
  `{"by":"sentinel","preauthorized":true}`.
- **A clean merge exit answering a question it does not answer.** Two branches
  of one cascade independently added a byte-identical `cleanup()`/`trap` block
  to `epic-branch.sh`; because squash merges share no SHAs, a 3-way merge kept
  BOTH with no conflict. `bash -n` passes and in shell the second definition
  silently wins. It recurred on the next base-merge of the same round.
  `base-merge`'s ownership rule could not help: there was no conflict.

### Family C — the installed conveyor is not the repository conveyor

The sharpest operational fact, and the reason the other two families understate
the exposure. Measured on this host:

- All four checked scripts in `~/.codex/shipyard/scripts` differ from `main`
  (35k, 28k, 16k and 15k byte diffs), and `AGENT_CARDINALITY` occurs **zero**
  times in the installed `front.cjs` — the installed conveyor has no capacity
  logic at all.
- `~/.codex/agents/shipyard-integrator.toml` and `shipyard-arch-review.toml`
  are both `gpt-5.6-terra`, and **zero** `-deep` files are installed. Phase 25's
  palette, ADR-005 D8's variants and phases 26–27 entirely are absent from what
  the Codex skill executes.
- **The model floor is not re-checked after a remap.**
  `gen-codex-shipyard.cjs`'s `forRole` does `if (remapped) return { model:
  remapped, effort };` — returning before any `min_cli` comparison. The comment
  explains why the palette's floor/ceiling does not apply to a remapped tier and
  says nothing about the CLI floor. A CLI of 0.147.0 correctly drops Astra from
  the palette and a `model_profile_overrides.codex.sonnet.model` puts it back.
- **The preflight's floor check is attached to the wrong file.**
  `gsd-tune.cjs` DOES measure every palette `min_cli` against the host — gated
  on `codexToml.includes(entry.model)`. The standard registration keeps
  `config_file = "agents/shipyard-integrator.toml"` and the model lives in that
  separate file, so the gate never fires on a normally-installed host.
- **An installer that does not own what it wrote.** The bundle payload is safe
  (`rm -rf "${BUNDLE_ROOT:?}"` precedes the copy), but agents are
  `cp "$OUT"/agents/*.toml` with no removal, so a shrunk palette or a dropped
  `-deep` variant leaves orphans that "the file exists" no longer certifies.
- **An explicit pin the preflight names and never reads.**
  `ANTHROPIC_DEFAULT_FABLE_MODEL` appears twice in `gsd-tune.cjs`, both times as
  comment or remedy prose; the `fable-floor` blocker measures only the CLI
  version. With `pipeline.fable: auto`, CLI 2.1.263 and
  `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5`, preflight returns exit 0 and
  no blockers while the environment pins the model ADR-005 ruled out.

## Decision

Eight decisions, each measured above, each sized as one ticket. Ordered so the
ones the NEXT phase's own delivery depends on come first.

- **D1 — The cap counts DISTINCT agents.** A dispatch record carries the
  identity of the agent that holds it (an `agent_id` or dispatch group), and
  `agentsInFlight` counts unique live agents rather than unique roles. Time of
  dispatch is not a substitute: new PRs are legitimately handed to an
  already-running guard, so `at` moves without a second agent existing. The
  acceptance criterion must distinguish one guard over many PRs from two guards
  over one PR each. FIRST because the error direction is over-dispatch and this
  phase runs under it.
- **D2 — A signature's history is a set with adjacency, not a count.**
  `repeat` must be reachable whenever the same signature recurs at a moved head,
  regardless of what appeared between. `repeat_exhausted` must mean the depth
  was actually spent, which requires the attempt record to carry what was
  APPLIED and not only what was decided — `effort_applied: unknown` is not
  evidence. Keep the `plan_defect` K rule and the oscillation backstop intact.
- **D3 — One procedure for judgment, on both paths.** measure → resolve →
  dispatch → record, stated once and referenced by `deliver.md` and
  `references/pr-sentinel.md`, so the background path resolves the judge from
  the resolver (with `--input-tokens` and `--contested`) and writes the
  `arch_review` event its own escalation rule reads. Ship a contract test that
  asserts both entry points produce the same four steps.
- **D4 — A floor is measured against what is EFFECTIVE.** The CLI floor is
  re-checked after the last remap, using the `min_cli` the original palette
  entry declared; the preflight reads the agent files actually registered (or a
  trustworthy install manifest) rather than `config.toml` alone; and the
  `fable-floor` blocker reads the explicit model pin, not only the CLI version.
  None of this forbids a user's remap or rewrites their environment — it reports.
- **D5 — An installer owns what it wrote.** Reconcile an old manifest against
  the new one and remove only files the installer itself owns, and prove it with
  a two-stage install smoke: generate at one palette, generate at a smaller one,
  assert no orphan survives.
- **D6 — Every reader has a writer, or a recorded decision.** Sweep the
  conveyor's own seams and close each: `behind_by`, `needsBaseMerge`, the
  `base_merge` event, `drift-needed.cjs`'s caller. `unresolved_count` is the
  template for the other outcome — still written by nobody, and `front.cjs`
  :612-622 now says WHY, which makes it a decision rather than drift. And add
  the guard: a mechanism shipped without a caller is a finding, asserted the way
  `trailer.test.cjs` pins its docs against `USAGE` — the guard that would have
  caught D2 and was one row short.
- **D7 — The dirtiness question is about TRACKED content.** `base-merge.cjs`
  and `gc` ask `--untracked-files=no`, and not by exempting two known filenames —
  a list of names is the same shape as the pin's list of homes. An untracked path
  the incoming base ADDS must still refuse, with git's own message naming it.
  In the same ticket: Gate 2 warns (a warning plus a flag, as
  `unreachable_paths` is handled — a plan may declare a file it is about to
  create) when a wildcard-free declared path does not exist.
- **D8 — A clean exit is not evidence of a coherent result.** A post-merge sweep
  for duplicate definitions in the shell scripts a merge touched — `bash -n`
  cannot see them and the smoke suite stayed green — homed in
  `tests/unit/source-contract.test.cjs`, which phase 27 created for exactly this
  kind of assertion. And `pipeline-stats.cjs` splits its checkpoint count into
  merged-by-a-person and merged-by-the-guard-under-pre-authorization, with a
  WARNING for the third case that is invisible today: a checkpoint merged by the
  guard with no pre-authorization.

## What this ADR does NOT cover, and why

- **Regenerating and reinstalling the Codex bundle.** It is the point of D4 and
  D5, not a step beside them: reinstalling before they land bakes in the orphan
  problem and leaves the remap able to bypass the floor. It is also a host-side
  act on the operator's machine and theirs to run.
- **Quota-aware admission** — reserving subscription headroom, reading reset
  times, re-choosing a runtime by remaining quota. It is a real gap (capacity
  bounds concurrency and measures no consumption) and it needs reliable quota
  telemetry first: an unavailable reading must not be read as zero or as a full
  tank. Its own investigation.
- **CodeRabbit's non-engagement** — eight phases, PRs #1–#72, zero reviews and
  zero comments. An app installation and authorization fact that no amount of
  reading this repository can settle.
- **`delivery-rules`' missing rule** that routing around a defect outside a
  ticket's scope means recording it. Real, and a prompt contract rather than a
  mechanism.
- **Three prose-drift items** — `computeFront` still called "pure ... reads no
  file" while `loadConfig` is reachable from it, and the two comments naming
  T-24-09 that are load-bearing as a pair. ADR-006 D8's family; a cheap sweep,
  and not this ADR's subject.
- **The smoke heredoc's `pending: command not found`** at
  `sentinel-smoke.sh:1645`. Non-blocking, exit 0, already phase 27's
  integration-report item 11.

## Consequences

Eight tickets, one phase, and two orderings are load-bearing rather than
preferences. **D1 first**: its error direction is over-dispatch, and every later
ticket in the phase is dispatched under it. **D2 second**: it governs how this
phase's own repair rounds escalate, and a phase that spends its most expensive
attempt on an unreconsidered hypothesis will be diagnosed as the new code. D4
and D5 are one family and gate the bundle regeneration that follows the phase.
D3, D6, D7 and D8 may run in whatever order the contested-path rule allows.

Two habits to carry, both earned this phase rather than argued:

**A deferral addressed to a phase is nobody's `files_modified` line.** T-27-02's
PR body named the `--base-tree` gap and deferred it to "later tickets of this
phase". Five later tickets touched `deliver.md` and one touched
`pr-sentinel.md`; none did it. A gap gets an owner or it gets a ticket.

**A change is in force where the conveyor RUNS from, not where its ticket
merged.** Measured three times in one phase — a worktree cut from a stale local
epic ref while origin was six commits ahead, a guard unable to run a
`--base-tree` call the docs had just prescribed, and the whole installed Codex
bundle predating three phases. Family C is that same sentence at its largest
scale.
