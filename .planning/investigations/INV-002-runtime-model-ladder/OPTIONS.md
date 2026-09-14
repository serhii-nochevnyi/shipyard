# Options


## Option A — Unified role resolver with runtime-specific palettes

Keep one canonical role/escalation policy, resolve it into the existing Claude
palette or the requested Codex concrete palette, and make every dispatch caller
consume the resolved record.

## Option B — Static per-runtime agent files only

Encode every rung in static Claude/Codex agent definitions and rely on callers
to choose the appropriate file without a shared runtime resolver.

## Comparison

| | Option A | Option B |
|---|---|---|
| Complexity | Moderate; one contract plus adapters | Lower initially; many duplicated files |
| Risks | Caller integration must be enforced | Easy to bypass; policy drifts between runtimes |
| What it forecloses | Silent inline/session inheritance | Dynamic evidence-driven escalation |

## Escalation signal choices

### Choice 1 — Explicit role-scoped escalation signals (recommended)

Use existing evidence but scope it by role: `--type alternatives` selects the
research middle rung; an explicit `--very-complex`/critical classification
selects research ceiling; `repeat` and `repeat_exhausted` advance repair roles;
`contested` advances judgment roles. Input-window pressure is admitted only
where the caller explicitly opts it in.

### Choice 2 — Global risk/window promotion

Let `risk: high`, `checkpoint`, and input-window pressure promote every role.
This is simpler but would violate the requested fixed Luna roles and can skip
the Sol repair rung.

### Choice 3 — No automatic model escalation

Keep model selection fixed and use the signals only for human checkpoints or
strategy changes. This is predictable but does not satisfy the requested
multi-rung research, judgment, and repair ladder.
