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
- **D6 — Codex is not the same decision, because it is not the same surface.**
  On Claude shipyard emits a tier alias per dispatch and the tool resolves it.
  On Codex an agent is a STATIC `~/.codex/agents/<name>.toml` written at install
  time, and no dispatch carries a model at all. So D1 has no Codex counterpart:
  `capForRuntime` already flattens every role to the workhorse tier, so all
  seven agents carry one model (`gpt-5.6-terra` on this host) and there is no
  floor to raise. D2 is the WHOLE mechanism there rather than half of it, which
  is what T-25-02 already delivers by writing effort and no model, so the user's
  own `config.toml` default applies — `gpt-6-astra` here, with a 1M window. And
  D4 has no counterpart either: with Astra as the default, every Codex role
  already has the window that R1 exists to reach for.
- **D7 — The `max` clamp on Codex goes; both halves of its premise are false.**
  `resolveEffort` reads `if (level === 'max' && runtime === 'codex') return
  'xhigh'`, commented "`max` is Anthropic-only; GSD clamps it to xhigh on
  Codex". Verified against GSD 1.12/1.13's catalog: `codexModelEffort._baseline`
  advertises `low, medium, high, xhigh, max`, `advertisedCodexEffort` falls back
  to that baseline for any model the table does not name (which is what
  `gpt-6-astra` is), and the resolver's only downgrade is "the nearest
  advertised level below" for a level a model does not support. GSD accepts
  `max` on Codex; shipyard invented the clamp and attributed it to GSD. Under
  D2 that costs the judgment roles their top rung on the one axis Codex has.
  `minimal` keeps its clamp to `low`, for a different and still-true reason:
  Workflow's enum has no such value.
- **D8 — Astra has a version floor too.** First-class `gpt-6-astra`
  configuration arrived in Codex CLI 0.153.1; this host runs 0.147.0 and the
  current release is 0.153.4. That is the Codex mirror of the Fable 5.1 floor,
  so it belongs in the same `gsd-tune` check rather than in a second mechanism.
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
