# ADR-015 — autonomous dual-runtime control plane

- **Status:** accepted for implementation preparation
- **Date:** 2026-09-19
- **Decision owner:** repository operator
- **Scope:** Shipyard delivery runs executed through Claude Code or Codex
- **Supersedes:** none
- **Related:** ADR-011, ADR-013, ADR-014

## Context

The current delivery loop has a policy boundary and durable delivery state, but
it does not yet provide one autonomous controller for a complete run. The stop
hook can choose the newest state across worktrees, technical runtime failures
can be presented as human decisions, and session handoff is only proven as a
manual operation. The native Claude `Workflow` host is not connected to a real
Claude Code launch path. Codex has a stricter generated-agent path, but its
live launcher, application evidence, and recovery loop are not proven by the
current synthetic smokes.

The two runtimes must remain provider-pure. Claude work uses Anthropic models
and Claude Code; Codex work uses OpenAI models and Codex. They need one control
contract for run identity, state, leases, wake-up, evidence, and accounting,
but they must keep separate model ladders and separate adapters.

The pipeline must continue unattended through technical failures and waiting
states. A person is required only for an actual authorization or policy
decision: credentials, a business or security decision, production rollout,
or a protected integration merge when repository policy requires it.

## Decision

1. Build one runtime-neutral `shipyard.run.v1` control contract. Every run has
   an immutable `run_id`, repository identity, phase, ticket, worktree, parent
   run, active runtime, dispatch id, policy fingerprint, lease owner, state
   revision, and bounded resume data. All state reads and stop decisions are
   scoped to that identity; no caller may select a global newest board.

2. Make the controller the owner of continuation. It persists leases,
   transitions, wake conditions, retry budget, runtime availability, and
   idempotency keys. It can wait for CI/review, retry a transient host failure,
   relaunch a successor session, and resume from a verified checkpoint. A
   `runtime_unavailable` state is technical and retryable; it is not converted
   into a human checkpoint or a request to switch runtimes.

3. Keep Claude and Codex behind separate adapters. The Claude adapter must
   connect a supported native Workflow host or an explicitly supported Claude
   Code CLI bridge and prove the selected native model and effort from launch
   and runtime evidence. The Codex adapter must launch the resolver-selected
   generated agent or dynamic model/effort pair and prove the applied values.
   Neither adapter may inherit a parent session model, pass policy through an
   untyped serializable argument, or fall back to the other provider.

4. Treat a dispatch as successful only after the boundary verifies a receipt
   containing requested, applied, and observed runtime/model/effort evidence,
   launch identity, policy fingerprint, and usage-join status. Missing host
   evidence is an explicit refusal or `runtime_unavailable` transition, never
   an inferred success.

5. Resolve graph reachability before dispatch. The controller refreshes the
   live integration base and parent epic, verifies origin and branch ancestry,
   and only then cuts or reuses a ticket worktree. A child whose parent landed
   is refreshed from the live base before it becomes actionable. A failed
   reachability proof remains pending and is retried by the controller.

6. Separate deterministic waiting from model work. CI, review, quota, lease,
   and host readiness waits are event-driven and bounded in scripts. The model
   receives only the scoped action packet and referenced evidence. The stop
   gate blocks only the owning run and emits a wake condition for the same
   run.

7. Record provider/account/run/role/model/effort/token/quality facts in one
   joinable telemetry schema. Reports must distinguish requested, applied,
   observed, unsupported, and unknown values. Model-ladder changes remain
   versioned treatments evaluated after attribution and quality/recovery gates;
   this ADR does not authorize online policy rewriting.

8. Roll out in this order: shared contract and scoped state; controller
   leases/wake/resume; Claude adapter and real smoke; Codex adapter and real
   smoke; graph/reachability integration; observability and measured ladder
   evaluation. Each slice has a fail-closed capability probe, a negative test,
   and a rollback flag that preserves historical records.

## Consequences

### Positive

- A run can continue through waits, transient host failures, and session
  boundaries without asking a person to make a technical choice.
- Claude and Codex share recovery and accounting semantics while preserving
  provider-specific model policies.
- A green process exit cannot masquerade as applied model or runtime evidence.
- Stop decisions, worktree state, and telemetry are tied to the correct run.
- Model-cost optimization can use measured outcomes instead of synthetic
  smoke results or inherited session assumptions.

### Negative

- The repository gains a durable run store and a controller lifecycle in
  addition to the existing delivery graph.
- Real proving-ground tests require installed Claude Code and Codex runtimes;
  environments without them must report unavailable capability rather than
  silently use a fake success.
- Several existing callers and projections must carry run scope and receipt
  identity together, so rollout is a dependency-ordered multi-phase change.

## Scope fences

- Claude's existing Anthropic palette, provider, and credentials are not
  changed by this ADR.
- Codex's OpenAI model palette is not replaced with Claude aliases, and Claude
  never consumes Codex model ids.
- Product repositories are not modified by the control-plane implementation.
- Protected default-branch merge and production rollout remain human policy
  gates when repository policy requires them.
- No model ladder threshold is tuned automatically before the new telemetry
  has complete attribution and quality/recovery evidence.

## Rollback

Disable the controller integration through an explicit versioned compatibility
flag for new runs only. Existing run records, receipts, and usage evidence are
immutable. Rollback must preserve scoped state and must not restore global-newest
selection or silent parent-session inheritance.
