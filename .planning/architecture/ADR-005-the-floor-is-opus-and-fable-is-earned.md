# ADR-005 — The floor is opus, the depth is effort, and fable is earned

- **Status**: accepted
- **Date**: 2026-09-07
- **Supersedes**: nothing. Replaces the tier reasoning inside ADR-001's model
  ladder and refines ADR-003 D3.

## Context

ADR-003 recorded that the models under the conveyor had moved. What it did not
do is re-examine the ladder's own ARGUMENT, and that argument is now stale in
three places.

1. **The judges take `fable` because of the window.** `ladderTier`'s comment
   says the 1M context "is what actually distinguishes their work". Measured on
   this repository, 2026-09-07: the ADR corpus arch-review reads every time is
   30 KB (~8k tokens), the largest ticket diff of phase 24 was 63 KB (~16k), and
   the phase-24 epic diff — the integrator's input and the largest in the whole
   system — is 210 KB (~52k). Opus 5's ordinary window holds all of it with room
   to spare. The window was a plausible argument and is not an observed need.
2. **`fable` was Fable 5 and is now Fable 5.1**, and Anthropic positions 5.1 as
   the model to reach for "when your evals on Claude Opus 5 at higher effort
   still fall short". That is an escalation ORDER: opus at depth first, fable
   after. The ladder had it as the starting point for two roles.
3. **The workhorse tier moved a generation.** `sonnet` is Sonnet 5 with a native
   1M window, where the policy was written against Sonnet 4.x. So the tier
   spread that the ladder used to express strength now expresses much less, and
   two of its rungs (`haiku`, unused by every role; `max` effort, unused by
   every role) were never used at all.

Two constraints the ladder does not model, both observed today:

- **The spend limit is per session, the policy is per dispatch.** Nine
  `opus`/`xhigh` executors and a `fable` guard in flight ended the run mid-wave;
  six agents died, five tickets lost their commits and were re-dispatched. No
  choice of tier fixes that, because the axis missing is concurrency.
- **The Agent tool has no `effort` parameter.** Only Workflow's `agent()` carries
  it (verified against the live schema, CLI 2.1.263). So a policy resting on
  effort is enforced for executors, drift judges and fix rounds, and is a
  sentence in the prompt for the background guard — the longest-lived agent in
  the system.

Measured share of this session's ~3.4M subagent tokens, for context on where the
cost actually was: drift-check about 30% (fifteen judges at ~70k each, on a role
the prose calls mechanical and which `deliver.md` Step 2 did not require for
plans written the same day), executors about 45%, guards about 22%.

## Decision

- **D1 — The floor is `opus`.** No built-in path resolves a role below it.
  `sonnet` and `haiku` remain valid values a user may configure; nothing in the
  ladder chooses them. The reason is not that the cheaper tiers are bad, it is
  that the conveyor's failure mode is a wrong green reaching an epic, and every
  mechanical gate above the executor costs more to run than the difference
  between tiers.
- **D2 — Depth is the MODEL. Effort has two useful values.** *(Revised
  2026-09-07, same day, before any code was built. The first draft said depth
  is effort, keyed on role and signals, and shipped a five-rung table. The
  operator's measurement retires it: `max` and `xhigh` cost more without
  producing a better result, on either runtime. So the effort axis is `low` for
  the one mechanical role and `high` for everything else, and `xhigh`, `max` and
  `ultra` are used by no built-in path — they stay legal values a person may set
  through `pipeline.effort.<role>`.)* The consequence is the one the operator
  wanted from the start: since effort can no longer express depth, the ONLY way
  the conveyor can escalate is to change the model, which is what D4 makes
  mechanical. A `repeat` verdict therefore returns `strategy: rethink` at an
  unchanged model and effort — a different hypothesis, not a deeper burn — and
  the rung above it is the ceiling model itself.
- **D3 — A configured effort override must not silently disable the escalation
  it outranks.** `cfg.effort[role]` is read before the signature rule, so
  shipping the effort table as configuration would have disabled the repair
  ladder. The table therefore belongs in code, and the override keeps its
  precedence but gains a warning when it shadows a repair role.
- **D4 — `fable` is a ceiling reached mechanically, by three routes.** Window
  pressure measured by the caller against a configured threshold; exhausted
  repair depth, read from the journal as a third occurrence of one signature
  after a `rethink` at `max`; and contested judgment, meaning the journal
  already holds a `violation` for this ticket. Each is computable; none is a
  prompt rule. The integrator is the single standing exception and takes `fable`
  unconditionally: largest input in the system, one call per phase, last
  mechanical judgment before a person merges.
- **D5 — Fable 5.1 or nothing.** `pipeline.fable` defaults to `off`; `auto` is a
  person's signature that consent was given, because an unconsented Fable
  request in a background session waits out `dialogExpiry` and then ends the
  turn without sending. Under `auto`, a runtime below CLI 2.1.255 resolves the
  alias to Fable 5, so `gsd-tune` reports that as REQUIRED drift at Step 0 of
  every delivery, naming the floor and `ANTHROPIC_DEFAULT_FABLE_MODEL` as the
  two ways to miss it.
- **D6 — Codex is the same shape as Claude, with two models instead of two
  aliases.** *(Rewritten twice on 2026-09-07 as the operator corrected the
  facts; the superseded readings are recorded at the end of this decision,
  because the mistake behind both is worth keeping.)* The operator's palette is
  `gpt-6-astra`, the senior and most expensive model, whose best results are at
  `high` effort; `gpt-5.6-terra`, the workhorse; and `gpt-5.6-sol`. With `max`
  and `xhigh` retired by D2, **`sol` has no distinct job** — its only
  distinguishing property in GSD's catalog was advertising `ultra` — so no
  built-in path selects it, and it stays in the palette as a value a person may
  configure. The mapping is then the exact mirror of the Claude side:

  | | Claude | Codex |
  |---|---|---|
  | mechanical: drift-check | opus / low | terra / low |
  | every other role | opus / high | terra / high |
  | integrator, unconditionally | fable / high | astra / high |
  | the earned ceiling (D4's routes) | fable / high | astra / high |

  One sentence in the documentation now describes both runtimes, which is the
  point: a reader should not have to hold two policies in mind.

  **The mistake behind both superseded readings, stated once because it was
  made three times in different clothes:** I ranked the Codex models by GSD's
  `codexModelEffort` table. That table records which effort levels each model
  SUPPORTS. I read it as an ordering by capability and by cost, and every wrong
  answer followed from that: first the newest, most expensive model went to the
  cheapest, highest-volume role (drift-check, sixteen calls this session);
  then `ultra` on an older model was mistaken for depth above a model that is
  both better and deeper; then the effort ladder itself turned out to be paying
  for nothing above `high`. A support matrix is not a quality ranking, and
  nothing in the catalog claims to be one.
- **D7 — The palette and its efforts are CONFIGURATION.**
  `pipeline.codex_models` declares each usable model with the effort its best
  results are at, in preference order, and the default ships in
  `capability.json`: `[{gpt-5.6-terra, high}, {gpt-6-astra, high}]`, with
  `gpt-5.6-sol` present and unselected. The field is named for what it is — the
  effort to USE, not the deepest the model will accept — so a reader cannot
  mistake it for a limitation again. The `max` → `xhigh` clamp for
  `runtime: codex` still goes: both halves of its comment are false, verified
  against GSD's `codexModelEffort._baseline` (which advertises `max` for every
  model) and `advertisedCodexEffort` (which returns that baseline for a model
  it does not name, such as `gpt-6-astra`). `ultra` is NOT added to the effort
  vocabulary, since no path selects a model that advertises it. `minimal` keeps
  its clamp to `low`: Workflow's enum has no such value.
- **D8 — On Codex the escalation needs its own agent, because an agent there is
  a FILE.** A `~/.codex/agents/<name>.toml` carries one model and one effort,
  written at install time, and nothing is passed per dispatch — so risk,
  `repeat`, exhausted depth and a contested verdict are all unreachable through
  a single static agent per role. The generator writes a second file for the
  four roles that escalate: `shipyard-ci-fix-deep`, `shipyard-review-fix-deep`,
  `shipyard-pr-sentinel-deep` and `shipyard-arch-review-deep`, each carrying the
  CEILING model at its own best effort (astra / high), and the generated skill
  prose names when to invoke them: `repeat_exhausted` for a repair role, a
  journalled prior `violation` for the judge. Eleven agents rather than seven.
  The integrator gets no variant: it is already at the ceiling.
- **D9 — Astra's effort is set by its results, and its availability by the CLI.**
  Two separate facts that an earlier draft of this ADR conflated. `high` is
  where Astra performs best, per the operator's measurement, so raising it buys
  cost and nothing else — that is why D7 names the field for the effort to use.
  Separately, first-class `gpt-6-astra` configuration arrived in Codex CLI
  0.153.1, this host runs 0.147.0 and the current release is 0.153.4, so
  selecting Astra at all has a version floor. `gsd-tune` reports that floor
  beside the Fable 5.1 one, in the same check and for the same reason.
- **Deferred — the concurrency axis.** A per-session budget cannot be expressed
  as a tier, and the run that proved it also proved the recovery works: the
  interrupted executors' uncommitted RED tests were handed to their successors
  and every ticket landed. Revisit with a measured ceiling rather than a guessed
  one; `dispatch.maxConcurrency` in GSD 1.13 is the shape to borrow.

## Consequences

One ticket, T-25-04, last in phase 25's chain, and high risk with a checkpoint
because it changes the model of every dispatch in the conveyor. The floor and
the two judgment efforts are in `.planning/config.json` from today so the
policy is in force before the code enforces it; T-25-04 moves them into the
resolver and the project config then drops them. `drift-check` at `opus`/`low`
is the one role whose cost rises without a quality argument behind it, and the
honest fix for it is not a tier but Step 2's own condition, which did not ask
for fifteen of this session's judges.
