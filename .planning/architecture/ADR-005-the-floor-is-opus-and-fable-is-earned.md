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
- **D2 — Depth is EFFORT, keyed on the role and its signals.** The dependency
  inverts: today the effort tier is derived from the model, which collapses to a
  single value the moment the model is constant. Proven, not argued: with the
  floor set through configuration, every role except `drift-check` resolved to
  `xhigh` and `--signature-state repeat` stopped deepening anything, leaving
  `strategy: rethink` as the only surviving signal.
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
- **D6 — Codex is the same decision through a different axis, because Astra's
  effort has a ceiling.** *(Revised the same day, 2026-09-07, before any code was
  built: the first draft of this decision said D1, D2 and D4 had no Codex
  counterpart at all. That rested on assuming effort could carry the whole depth
  range there. It cannot — the operator's palette is `gpt-6-astra` with effort
  capped at `high`, `gpt-5.6-terra` up to `max`, `gpt-5.6-sol` up to `ultra` —
  so on Codex the MODEL differentiates again, chosen by the depth the role
  needs.)* The selection rule mirrors the Claude side exactly: a judgment role
  takes the DEEPEST entry in the palette, and every other role takes the
  SHALLOWEST entry whose ceiling covers the effort the table already assigned
  it. Never the reverse — a role whose effort exceeds a model's ceiling moves UP
  a model rather than down an effort, because silently losing depth is the
  defect D7 is about.

  | role | effort (D2's table) | Codex model |
  |---|---|---|
  | drift-check | low | astra |
  | research | high | astra |
  | ci-fix, review-fix, pr-sentinel | high | astra |
  | executor | xhigh | terra |
  | arch-review, integrator | max | sol |

  Astra therefore takes the roles that need breadth rather than depth, and gives
  them a 1M window for free; terra carries the single `xhigh` rung; sol is
  reserved for the two judgment roles, which is also GSD's own posture (it gives
  sol to exactly two of its thirty-four agents, both planners).
- **D7 — The palette and its ceilings are CONFIGURATION, not code.**
  `pipeline.codex_models` declares each usable model with its `max_effort`, in
  preference order, with the default above shipped in `capability.json`. The
  operator changes it without a release when OpenAI opens Astra's higher levels
  or adds a model — which is the whole reason the ceiling is not a constant. The
  `max` → `xhigh` clamp for `runtime: codex` goes: both halves of its comment
  are false (verified against GSD's `codexModelEffort._baseline`, which
  advertises `max` for every model, and `advertisedCodexEffort`, which falls back
  to that baseline for a model the table does not name — which is what
  `gpt-6-astra` is). `ultra` joins the effort vocabulary for Codex only, since
  Workflow's enum has no such value and no Claude alias advertises it. `minimal`
  keeps its clamp to `low` for that same still-true reason.
- **D8 — On Codex the escalation needs its own agent, because an agent there is
  a FILE.** A `~/.codex/agents/<name>.toml` carries exactly one model and one
  effort, written at install time, and nothing is passed per dispatch. So risk,
  `repeat`, exhausted depth and a contested verdict — every signal D2 and D4
  rest on — are unreachable through a single static agent per role. The
  generator therefore writes a second file for the four roles that escalate:
  `shipyard-ci-fix-deep`, `shipyard-review-fix-deep`, `shipyard-pr-sentinel-deep`
  and `shipyard-arch-review-deep`, all at the deepest palette entry and its top
  effort (sol/ultra), and the generated skill prose names when to invoke them —
  `repeat_exhausted` for a repair, a journalled prior `violation` for the judge.
  Eleven agents rather than seven. The integrator gets no variant: it runs once
  per phase and is already at the deepest entry.
- **D9 — Astra has a version floor too.** First-class `gpt-6-astra`
  configuration arrived in Codex CLI 0.153.1; this host runs 0.147.0 and the
  current release is 0.153.4. That is the Codex mirror of the Fable 5.1 floor,
  so it belongs in the same `gsd-tune` check rather than in a second mechanism.
  It is also the most plausible reason the operator's ceiling for Astra is
  `high` while the Codex release notes advertise `low…max`: a CLI that predates
  first-class support cannot select the higher levels. Recording both, and
  taking the operator's ceiling as the rule, is why the ceiling is a setting.
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
