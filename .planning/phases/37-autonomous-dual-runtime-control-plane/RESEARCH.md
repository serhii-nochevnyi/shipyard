# Phase 37 Research: autonomous dual-runtime control plane

## Research scope

This research covers the implementation seams named by ADR-015: shared scoped
run state and continuation, provider-pure Claude and Codex adapters, graph
reachability, deterministic waiting, and usage/effectiveness attribution. It
uses the release/0.58.0 source tree and the installed Shipyard scripts that the
active Claude Code integration executes.

## Current mechanisms and gaps

### 1. Dispatch policy and receipts already provide the right seam

- `plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:1672` owns the
  resolve, validate, reserve, launch, receipt, and durable-record sequence.
- `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs:464-571`
  requires explicit Claude model/effort launch arguments and rejects a
  contradictory application receipt.
- `plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs:128-369`
  validates generated-agent identity or explicit dynamic selection and emits
  applied model/effort evidence.
- `plugins/delivery-pipeline/scripts/session-handoff.cjs:751-760` exposes
  ownership and checkpoint primitives, but `requestAutomaticTransfer()` still
  returns `unsupported` and performs no successor launch.

The new controller should compose these mechanisms rather than create a second
model resolver. It must pass a scoped run context into the boundary and persist
the returned receipt under that run.

### 2. Claude has a host harness, but no proven native production bridge

- `plugins/delivery-pipeline/scripts/claude-workflow-host.cjs:14-20` defines
  the six Workflow bindings, including the host-owned typed dispatch factory.
- `plugins/delivery-pipeline/scripts/claude-workflow-host.cjs:68-109` registers
  the host and refuses missing capabilities, recorder, or typed callback.
- `plugins/delivery-pipeline/scripts/claude-workflow-host.cjs:171-185` exposes
  a command-line workflow runner, but the repository has no connected
  production caller that registers this host with Claude Code's native
  `Workflow` runtime.
- `plugins/delivery-pipeline/workflows/executors.mjs:214-224` hard-refuses when
  the typed dispatch binding is absent. This refusal is correct and must stay.
- `tests/unit/claude-workflow-host.test.cjs` constructs an AsyncFunction with
  fake `agent`/`parallel` callbacks. It proves binding and refusal behavior,
  not that Claude Code applied the requested native model/effort.

The Claude slice therefore needs a host capability probe, one supported launch
path, stream/transcript evidence for applied model and effort, and a live smoke
that is skipped as unavailable rather than replaced by a synthetic green.

### 3. Codex has enforcement, but the live launcher is not proven

The Codex adapter has the stronger static-agent contract: generated manifest,
agent-file digest, policy identity, explicit model/reasoning effort, and a
typed GSD launch method. The current smoke coverage uses fake launch hosts and
does not prove a real Codex process, applied selection, or restart/recovery.

The Codex slice should add a real capability probe and a proving-ground launch
that records the process/session identity and the observed model/effort. The
test must also demonstrate refusal when the generated file is stale or when a
parent-session/inherited selection is supplied.

### 4. The stop gate is scoped incorrectly

- `plugins/delivery-pipeline/scripts/stop-gate.cjs:483-498` scans all worktrees
  and selects the front with the newest `generated_at`.
- The same file documents the failure mode at `:83-91`: two sessions can let a
  busier board answer for a quieter one.
- `plugins/delivery-pipeline/scripts/stop-gate.cjs:641-677` tells a model to
  run foreground `ci-wait`; there is no external waker that owns the same run
  and resumes it.

The controller must make the run identity explicit to the stop hook and must
emit a durable wake condition. A missing or stale scope is a refusal/pending
state, never permission to use the newest unrelated board.

### 5. Durable handoff exists as a manual protocol

`session-handoff.cjs` already has owner capability, acknowledgement, checkpoint,
and successor-candidate state. The implementation gap is the runtime-specific
successor launcher and recovery state machine: crash before acknowledgement,
duplicate resume, failed successor launch, changed head, dirty owned work, and
active child work all need idempotent transitions. The first implementation
should ship manual checkpoint/resume plus a controller-owned retry path; any
unsupported runtime remains `runtime_unavailable`.

### 6. Graph and worktree code needs a controller-owned refresh boundary

`epic-branch.sh` and `ticket-worktree.sh` already encode branch/worktree
creation and cleanup rules, but the autonomous loop needs an explicit refresh
before cutting work. A landed parent must update the child epic/base refs and
prove `HEAD..origin/<base>` is empty before dispatch. A checkout whose origin
does not match the declared repository must remain a reachability failure.

This is a separate ticket boundary from runtime launch because it can be tested
with temporary git repositories and does not require Claude or Codex credentials.

### 7. Projection is already split from volatile delivery state

`plugins/delivery-pipeline/scripts/gsd-sync.cjs:158-182` has a stable semantic
projection path that excludes volatile delivery fields from the fingerprint.
This should remain the read model. The new controller must add run-scoped
runtime receipts and wake state without putting heartbeat/lease churn into the
semantic projection fingerprint.

## Proposed ticket boundaries

1. Shared run contract and scoped state schema.
2. Controller leases, wake conditions, retry/idempotency, and
   `runtime_unavailable` transitions.
3. Claude host capability bridge and live proving-ground smoke.
4. Codex live launcher and proving-ground smoke.
5. Graph/base refresh and reachability gate before worktree dispatch.
6. Stop-gate and deterministic wait integration for the controller-owned run.
7. Unified receipt/usage join and effectiveness report inputs.
8. Rollout flag, migration, negative matrix, and cross-runtime integration gate.

The first two tickets are roots. Claude and Codex adapters depend on the shared
contract and controller but are provider-disjoint and can be developed in
parallel after those roots. Graph/wait integration depends on the controller;
observability depends on receipt shape; rollout is last.

## Verification constraints

- Unit tests must use injected host capabilities and prove fail-closed behavior.
- Live Claude and Codex smokes must run the installed runtime and record the
  applied selection; they may report `unavailable` when the runtime or
  credentials are absent, but cannot turn that state into a green fake receipt.
- Recovery tests must use temporary stores/repositories and exercise duplicate
  acknowledgement, crash/restart, stale head, and ownership fencing.
- Verification commands should be scoped to each ticket's files. Full CI or
  external-service checks belong in CI-only test strategy, not every executor
  retry.
- Jira is deliberately out of scope for this preparation. PLAN files and the
  generated local graph are the only ticket projection.

## Implementation order

Implement shared scope and controller first, then connect Claude and Codex
adapters independently, then wire graph/wait integration, and finally enable
the attribution/reporting and rollout gates. Do not tune model thresholds
before the live receipts and quality/recovery measurements are complete.
