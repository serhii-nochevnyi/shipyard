# ADR-012 — task-level model ladder for Claude and Codex

- **Status:** accepted
- **Date:** 2026-09-10
- **Decision owner:** repository operator
- **Scope:** Shipyard delivery roles on Claude Code and Codex

## Decision

Shipyard uses one shared task classifier and two runtime-specific model
surfaces. The classifier exposes five ordered levels:

| Level | Meaning | Automatic trigger |
|---|---|---|
| `mechanical` | an external deterministic gate is authoritative | `drift-check`, `pr-sentinel` |
| `routine` | bounded work with a small failure surface | `executor`/`research`, low risk, 1–4 files |
| `complex` | the normal quality floor | default for implementation, repair and judgement |
| `critical` | quality is more valuable than the floor cost | high risk or checkpoint |
| `recovery` | the ordinary hypothesis already failed | `repeat_exhausted` or contested judgement |

The project enables `delivery_pipeline.model_ladder: adaptive`. A missing
signal cannot qualify for the cheaper routine lane; the classifier keeps it in
`complex` and reports the missing evidence. Explicit lower requests are guarded
by the inferred minimum. Mechanical roles remain mechanical even when a caller
passes a higher task-level flag.

No built-in route selects Haiku. Existing manual tier overrides remain governed
by ADR-005; this experiment does not add a Haiku arm or lower the stated minimum
for any automatic lane.

On Claude Code:

- `mechanical` stays on `sonnet`;
- `routine` uses `sonnet` with the role's normal effort;
- `complex` uses the existing role floor, normally `opus`;
- `critical` uses `opus` at `xhigh` effort;
- `recovery` keeps the existing strategy and `max`/ceiling behavior.

On Codex:

- the first `delivery_pipeline.codex_models` entry is the ordinary floor;
- `routine` and `complex` use the ordinary generated agent file for static
  roles; the main-loop executor resolves the ordinary palette entry at runtime
  because it has no static file;
- `critical` selects a generated `-critical` file backed by the last palette
  entry for static roles, or the last palette entry at executor dispatch time;
- `recovery` selects the existing `-deep` file backed by the last palette entry;
- the integrator remains on the last palette entry in both modes and has no
  task-level variant; it is the final integration judgement and is intentionally
  outside the routine treatment;
- a one-entry or version-filtered palette falls back to the ordinary file and
  the selector reports that fallback;
- the current palette remains Terra → Astra. Sol/Luna are not introduced by
  this decision without measurements that show a quality or cost advantage.

The Codex selector is `scripts/codex-agent.cjs`. It reads the project policy,
forces the Codex runtime branch, classifies the same signals as
`pipeline-config.cjs`, and returns the concrete agent file/model, shared
`model_tier`, requested effort, task level and route. For `executor`, it returns
the concrete palette model and `agent_file: null`; callers pass the model and
effort to a supported `spawn_agent`/`codex exec` surface. Dispatch records carry requested `model`, `effort`, `route` and
`task_level`; `observed_model`, `observed_effort`, runtime and backend are
optional facts and remain absent when the runtime cannot provide them.

## Rationale

The Sept 10 usage audit showed that Shipyard's Claude main loop spent most of
its ordinary context on Opus while small and low-risk work was mixed with
large, cross-cutting work. A role-only ladder could not distinguish those
cases. The audit also showed that Codex's live inline path bypassed the static
agent palette, so a model choice that exists only in generated files is not
enough. Task level is the smallest shared fact that addresses both gaps while
leaving the model ids owned by each runtime.

The routine lane is intentionally narrow: four changed files is a bounded
starting threshold, and it applies only to executor and research. Repair roles
remain on their ordinary file until a repeated signature reaches recovery.
Critical work changes model and effort on the first attempt; recovery changes
model after the ordinary hypothesis and rethink strategy have failed, including
a contested judgement that needs a second reading. The
integrator stays on its ceiling because it is a once-per-phase integration
judgement, not a candidate for the routine downgrade. Fable remains an earned,
consented context ceiling and is not made a routine lane.

## Consequences and controls

The route grammar now exposes level rules, and `pipeline-stats.cjs` reports
coverage by task level, requested model, runtime, backend and observed model.
Missing model, route, task level, runtime or observed model is visible in the
report. A known runtime dispatch without the resolver's model or route is
refused by `dispatch-record.cjs`.

The treatment can be rolled back by setting
`delivery_pipeline.model_ladder` to `conservative` and regenerating the Codex
bundle. That restores the previous role-floor behavior while retaining all
telemetry and history. Changes remain versioned in this ADR; no script rewrites
the policy from a usage sample.
