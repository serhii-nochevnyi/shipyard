# ADR-013 — deterministic synchronization between Shipyard delivery and GSD

Date: 2026-09-10
Status: Accepted

## Context

Shipyard uses GSD PLAN files as the decomposition contract and a generated
ticket graph plus delivery state as the execution contract. The delivery loop
intentionally replaces GSD's native execute/ship orchestration for PR-per-ticket
work, but it currently does not publish the resulting state back into GSD's
native artifacts. In this repository the graph has 79 delivered tickets while
GSD reports no plan progress because `STATE.md`, `REQUIREMENTS.md`, summaries,
and phase verification artifacts are missing.

The repository must remain safe to resume after a session boundary. It must
also support Claude and Codex from one canonical implementation, without
network credentials or a second manually maintained source of truth.

## Decision

### 1. Shipyard is the execution authority; GSD artifacts are a read model

`plugins/delivery-pipeline/scripts/gsd-sync.cjs` will derive the native GSD
projection from:

1. PLAN frontmatter and bodies under `.planning/phases/`;
2. `.planning/graph/tickets.json`;
3. `.planning/graph/delivery-state.json` and `delivery-front.json`;
4. phase `INTEGRATION.md` evidence and repository-local verification facts; and
5. `ROADMAP.md` phase/requirement declarations.

No workflow may independently edit the generated execution fields. The
projection is the compatibility/read layer consumed by GSD queries and resume
flows.

### 2. The synchronizer owns a closed, local-only projection contract

The command supports:

- default write mode: compute and atomically publish the projection;
- `--check`: compute only and fail when generated output is missing or stale;
- `--json`: expose the same result for gates/tests; and
- `--phase <N>`: limit phase evidence generation while keeping global state
  calculations coherent.

It uses the existing project lock and atomic file writes. It never calls
GitHub/Jira, creates commits, changes PRs, or removes worktrees.

### 3. Native artifact mapping is explicit and evidence-based

- `REQUIREMENTS.md` is generated from the roadmap's requirement declarations and
  traceability; statuses are derived from the phase evidence.
- `STATE.md` is generated as a short digest of current phase, plan counts,
  delivery counts, verification blockers, and session continuity.
- Each plan with a delivery record receives a `*-SUMMARY.md`. Its status is
  `complete` only when the plan's ticket is observed `merged`; otherwise it is
  `halted` with the blocking state.
- Each phase receives a `*-UAT.md` and `*-VERIFICATION.md` projection. A phase
  is `passed` only when all its plans are merged, its integration evidence says
  passed, and its verification commands/evidence are present. Missing evidence
  is `pending`; an explicit integration `needs-fix` or failed check is
  `gaps_found`/`failed`.
- `ROADMAP.md` keeps human prose and receives only a marked synchronization
  block containing computed counts and the current phase.

The generated files include an ownership marker and a source fingerprint. A
conflicting non-generated file is a hard error instead of an overwrite.

### 4. Lifecycle gates close the loop

The capability adds an applicability-scoped synchronization gate at:

- `plan:post` — graph and native GSD projection agree after planning;
- `execute:post` — delivery results are projected after execution;
- `verify:post` — verification results are projected before shipping; and
- `ship:pre` — a final `--check` prevents shipping with stale GSD state.

The gate is inert for projects without a Shipyard `delivery:` plan. Gate
failures name the stale/missing artifact and the command that repairs it.

### 5. Generated artifacts remain runtime-neutral

The canonical script lives in the plugin script set. Existing Claude and Codex
installers already copy that set into their capability/bundle locations; tests
must assert the script is included and callable from both generated surfaces.

## Consequences

### Positive

- GSD progress, resume, health, and UAT queries see the same work Shipyard
  delivered.
- Re-running synchronization is safe and produces byte-stable output for the
  same source snapshot.
- Missing historical evidence remains visible instead of being silently
  converted into a green phase.
- A single check gate catches drift before a release/ship decision.

### Negative

- The repository gains generated planning artifacts and a projection script that
  must stay compatible with the supported GSD engine range.
- Historical phases with incomplete integration evidence will remain blocked
  until their existing findings are resolved or explicitly verified.
- The generated files must be regenerated after plan or delivery state changes;
  lifecycle gates make that requirement visible rather than optional.

## Scope fences

- This ADR does not change the ticket graph validator, GitHub state-sync
  semantics, Jira projection semantics, or model ladder.
- This ADR does not auto-fix historical phase findings.
- This ADR does not claim that a native GSD summary is a substitute for an
  integration review; it is a projection of that review's evidence.

## Supersession

None.
