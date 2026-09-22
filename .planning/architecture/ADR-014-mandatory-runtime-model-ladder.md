# ADR-014 — mandatory runtime model ladder

- **Status:** accepted
- **Date:** 2026-09-12; amended 2026-09-16 and 2026-09-22
- **Decision owner:** repository operator
- **Scope:** Shipyard roles dispatched through Claude Code and Codex
- **Supersedes:** ADR-005 and ADR-012 where they define model/effort selection

## Context

The delivery pipeline currently has a shared classifier, a Claude tier resolver,
generated Codex agent files, and several runtime-specific launch callers. Those
surfaces are not one executable contract. Codex currently exposes a two-entry
Luna/Sol routed ladder, while decomposition is outside the delivery role list, and
inline or child-thread paths can inherit the parent session model. Claude
callers can also substitute literal defaults after a route was resolved.

The result is that `delivery_pipeline.model_ladder: adaptive` can be present in
configuration while the real launch uses another model. A post-launch journal
record cannot prove that the runtime applied the requested model or effort.

The operator requires a role-specific ladder and mandatory application in both
runtimes. Runtime model identifiers are versioned policy data and must match
the identifiers exposed by each native host.

## Decision

### 1. One boundary contract, two independent runtime grids

Shipyard defines one versioned dispatch contract, but each runtime owns an
independent role/rung/model grid. Claude does not resolve Codex's Luna/Sol
logical names through aliases. Its grid names the existing Claude Code aliases
directly. Generated Codex `.toml` files are adapter output and never an
independent policy source.

Codex model IDs used by the current ladder are:

| Logical model | Concrete Codex model |
|---|---|
| Luna | `gpt-6-luna` |
| Sol | `gpt-6-sol` |

The adapter keeps `gpt-6-astra` registered for older explicit configurations,
but no current routed rung selects it.

Claude's active Opus target and remaining native aliases are:

| Claude model key | Claude Code alias |
|---|---|
| Sonnet | `sonnet` |
| Opus | `claude-opus-5-5` |
| Fable | `fable` |

### 2. Approved Codex role ladder

| Role | Base selection | Escalation 1 | Escalation 2 | Escalation signals |
|---|---|---|---|---|
| research | Sol/high | — | Sol/xhigh | explicit `very-complex` |
| decomposition | Sol/high | — | Sol/xhigh | explicit `critical` or `checkpoint` |
| executor | Luna/max | Sol/high | — | explicit `critical` or `checkpoint` |
| pr-sentinel | Luna/medium | — | — | gate strategy only |
| integrator | Sol/high | — | Sol/xhigh | `contested`, explicit `critical`/`checkpoint`, measured window |
| drift-check | Luna/max | — | — | evidence/gate strategy only |
| arch-review | Sol/high | — | Sol/xhigh | `contested`, explicit `critical`/`checkpoint`, measured window |
| ci-fix | Luna/max | Sol/high | Sol/xhigh | verified `repeat`; `repeat_exhausted` |
| review-fix | Luna/max | Sol/high | Sol/xhigh | verified `repeat`; `repeat_exhausted` |

Research promotes only on an explicit, durable `very-complex` classification.
Executor keeps Luna/max for its ordinary lane and selects Sol/high only from
explicit `critical` or `checkpoint` evidence; global risk, context-window
pressure, and normal complexity do not promote it. For repair roles, `repeat`
is valid only when the previous Luna launch has an applied receipt;
`repeat_exhausted` is valid only when the previous Sol/high launch has an
applied receipt. A terminal `flake` or `plan_defect` is a gate/strategy outcome,
not an automatic model promotion.

### 3. Approved Claude Code role ladder

The Claude grid is independent of the Codex table and uses Claude's
runtime-native model identifiers:

| Role | Base selection | Escalation 1 | Escalation 2 | Escalation signals |
|---|---|---|---|---|
| research | Opus/medium | Opus/max | — | explicit `very-complex` |
| decomposition | Opus/medium | Opus/max | — | explicit `critical` or `checkpoint` |
| executor | Sonnet/max | Opus/low | — | explicit `critical` or `checkpoint` |
| pr-sentinel | Sonnet/high | — | — | gate strategy only |
| integrator | Opus/medium | Opus/high | — | `contested`, explicit `critical`/`checkpoint`, measured window |
| drift-check | Opus/max | — | — | evidence/gate strategy only |
| arch-review | Opus/medium | Opus/max | Fable/medium | `critical`/`checkpoint`/`contested`; measured window |
| ci-fix | Opus/medium | Opus/max | — | verified `repeat`; `repeat_exhausted` |
| review-fix | Opus/medium | Opus/max | — | verified `repeat`; `repeat_exhausted` |

For Claude architecture review, explicit critical/checkpoint/contested evidence
selects Opus/max. Measured input above the policy window threshold selects the
Fable/medium ceiling; when both classes of evidence fire, the ceiling wins.
Research's `alternatives` classification is retained as evidence but does not
promote the base Opus/medium rung; only an explicit `very-complex` classification
selects Opus/max. Decomposition's explicit critical/checkpoint escalation also
stays within the Opus palette at max effort, and executor's critical/checkpoint
escalation uses Opus/low as its second rung.
Claude repair roles require a boundary-verified receipt from the immediately
preceding Claude rung. `repeat_exhausted` records a distinct receipt-chain
state but remains at the requested Opus/max ceiling; it does not add a Fable
promotion.

Signals are role-scoped. Global context-window pressure cannot promote fixed
mechanical roles (`pr-sentinel` and `drift-check`) and it does not promote
executor without the executor's explicit critical/checkpoint evidence. Each
runtime applies its own role grid when multiple signals fire; the resolver
retains all reasons and selects the highest rung allowed for that runtime and
role. A missing signal never silently promotes a role.

### 4. Mandatory dispatch boundary

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
runtime model ID and supported effort/application evidence. Opus launches use
`claude-opus-5-5`; Sonnet and Fable retain their current aliases. If the host
cannot carry the required selection, the dispatch is refused.

### 5. Configuration and override precedence

The canonical role ladder has authority over generic GSD tier defaults and
per-role Shipyard model/effort overrides for routed delivery roles. A conflicting
override is a configuration error, not a promotion or downgrade. Runtime
availability is checked at install and dispatch time. No project config may
select a runtime implicitly when both runtimes are installed.

### 6. Telemetry contract

Each dispatch records runtime, role, runtime-native model key, logical rung,
concrete requested model and effort, all fired signals, policy
version/fingerprint, backend, selected agent file or explicit launch
arguments, dispatch ID, application receipt, and observed model/effort when the
runtime exposes them. Missing or contradictory
fields are enforcement failures and remain visible in reports.

## Consequences

### Positive

- Codex uses Luna and Sol for the roles that need them.
- Research, judgement, repair, and fixed mechanical lanes are distinguishable.
- Claude retains its working model palette while its role/rung grid can evolve
  independently of Codex's model vocabulary.
- A parent session model cannot silently decide a child dispatch.
- Historical runs remain truthful; the new policy applies only after rollout.

### Negative

- The resolver, GSD decomposition path, Codex generator/installer, Claude
  workflow callers, dispatch recorder, and tests must change together.
- Some hosts cannot expose applied effort/model evidence; those launches will
  fail closed rather than be counted as compliant.
- Existing ADR-005/012 documentation and tests must be amended so stale
  Terra/Sol and `opus`-floor assertions do not recreate the old policy.

## Scope fences

- Claude's existing model palette, aliases, provider, and credentials are not
  changed by this ADR; only the canonical role grid's references to those
  aliases are made explicit.
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
