# ADR-014 — mandatory runtime model ladder

- **Status:** accepted
- **Date:** 2026-09-12; amended 2026-09-14
- **Decision owner:** repository operator
- **Scope:** Shipyard roles dispatched through Claude Code and Codex
- **Supersedes:** ADR-005 and ADR-012 where they define model/effort selection

## Context

The delivery pipeline currently has a shared classifier, a Claude tier resolver,
generated Codex agent files, and several runtime-specific launch callers. Those
surfaces are not one executable contract. Codex currently exposes a two-entry
Terra/Astra palette, decomposition is outside the delivery role list, and
inline or child-thread paths can inherit the parent session model. Claude
callers can also substitute literal defaults after a route was resolved.

The result is that `delivery_pipeline.model_ladder: adaptive` can be present in
configuration while the real launch uses another model. A post-launch journal
record cannot prove that the runtime applied the requested model or effort.

The operator requires a role-specific Codex ladder and mandatory application in
both runtimes. Claude Code already has a runtime-native palette; changing its
model IDs or provider configuration is explicitly out of scope.

## Decision

### 1. One canonical policy, two runtime adapters

Shipyard defines one role/escalation policy. The Claude adapter resolves its
logical rungs through the existing Claude palette without changing that palette.
The Codex adapter resolves concrete model IDs from the Codex palette below.
Generated Codex `.toml` files are adapter output and never an independent policy
source.

Codex model IDs are:

| Logical model | Concrete Codex model |
|---|---|
| Terra | `gpt-5.6-terra` |
| Sol | `gpt-5.6-sol` |
| Luna | `gpt-5.6-luna` |
| Astra | `gpt-6-astra` |

### 2. Approved role ladder

| Role | Base selection | Escalation 1 | Escalation 2 | Escalation signals |
|---|---|---|---|---|
| research | Terra/high | Sol/medium | Astra/medium | `alternatives`; explicit `very-complex` |
| decomposition | Sol/medium | — | Astra/medium | explicit `critical` or `checkpoint` |
| executor | Luna/max | Astra/medium | — | explicit `critical` or `checkpoint` |
| pr-sentinel | Luna/medium | — | — | gate strategy only |
| integrator | Sol/medium | — | Astra/medium | `contested`, explicit `critical`/`checkpoint`, measured window |
| drift-check | Luna/max | — | — | evidence/gate strategy only |
| arch-review | Sol/medium | — | Astra/medium | `contested`, explicit `critical`/`checkpoint`, measured window |
| ci-fix | Luna/max | Sol/medium | Astra/medium | verified `repeat`; `repeat_exhausted` |
| review-fix | Luna/max | Sol/medium | Astra/medium | verified `repeat`; `repeat_exhausted` |

For research, `alternatives` selects the middle rung; it does not by itself
mean `very-complex`. A very-complex classification is explicit and durable in
the dispatch input. Executor keeps Luna/max for its ordinary lane and selects
Astra/medium only from explicit `critical` or `checkpoint` evidence; global
risk, context-window pressure, and normal complexity do not promote it. For
repair roles, `repeat` is valid only when the previous Luna launch has an
applied receipt; `repeat_exhausted` is valid only when the previous Sol launch
has an applied receipt. A terminal `flake` or `plan_defect` is a gate/strategy
outcome, not an automatic model promotion.

Signals are role-scoped. Global context-window pressure cannot promote fixed
Luna roles (`pr-sentinel` and `drift-check`), and it does not promote executor
without the executor's explicit critical/checkpoint evidence. When multiple
signals fire, the resolver retains all reasons and selects the highest rung
allowed for that role. A missing signal never silently promotes a role.

### 3. Mandatory dispatch boundary

Every routed launch, on either runtime, must pass through:

```text
resolve(runtime, role, signals)
  → validate concrete model/effort and policy fingerprint
  → launch with explicit runtime selection
  → verify application receipt
  → record requested + applied + observed evidence
```

The boundary hard-fails on an unknown/ambiguous runtime, unsupported model or
effort, missing escalation variant, stale generated agent, conflicting GSD or
per-role override, inline/session-inherited fallback, or missing launch receipt.
`dispatch-record.cjs` is upgraded from a post-launch journal validator into a
consumer of this boundary contract; a successful process exit alone is not
evidence of compliance.

Codex static roles must use the resolver-selected generated agent file. Dynamic
roles such as executor and decomposition must receive explicit `model` and
`reasoning_effort` launch arguments. Claude launches must receive the selected
existing palette alias and supported effort/application evidence. If the host
cannot carry the required override, the dispatch is refused.

### 4. Configuration and override precedence

The canonical role ladder has authority over generic GSD tier defaults and
per-role Shipyard model/effort overrides for routed delivery roles. A conflicting
override is a configuration error, not a promotion or downgrade. Runtime
availability is checked at install and dispatch time. No project config may
select a runtime implicitly when both runtimes are installed.

### 5. Telemetry contract

Each dispatch records runtime, role, logical rung, concrete requested model and
effort, all fired signals, policy version/fingerprint, backend, selected agent
file or explicit launch arguments, dispatch ID, application receipt, and
observed model/effort when the runtime exposes them. Missing or contradictory
fields are enforcement failures and remain visible in reports.

## Consequences

### Positive

- Codex can use Terra, Sol, Luna, and Astra for the roles that need them.
- Research, judgement, repair, and fixed mechanical lanes are distinguishable.
- Claude retains its working model palette while both runtimes share the same
  role and escalation semantics.
- A parent session model cannot silently decide a child dispatch.
- Historical runs remain truthful; the new policy applies only after rollout.

### Negative

- The resolver, GSD decomposition path, Codex generator/installer, Claude
  workflow callers, dispatch recorder, and tests must change together.
- Some hosts cannot expose applied effort/model evidence; those launches will
  fail closed rather than be counted as compliant.
- Existing ADR-005/012 documentation and tests must be amended so stale
  Terra/Astra-only and `opus`-floor assertions do not recreate the old policy.

## Scope fences

- Claude's existing model palette, aliases, provider, and credentials are not
  changed by this ADR.
- No historical dispatch is relabeled as having used the new ladder.
- Product code and non-Shipyard model selection are unaffected.
- This ADR does not authorize automatic online tuning of thresholds or signals.

## Rollout and rollback

Roll out in ordered slices: canonical policy and resolver, runtime adapters and
generators, hard dispatch gate, telemetry/application receipts, then exhaustive
matrix and negative tests. Gate each slice on both runtime fixtures. During
development, a missing adapter or receipt blocks only routed delivery and names
the repair command; it never falls back to a parent session.

Rollback disables the new policy only through an explicit versioned compatibility
mode for already-started work. It must not restore silent inheritance. Historical
records remain unchanged.
