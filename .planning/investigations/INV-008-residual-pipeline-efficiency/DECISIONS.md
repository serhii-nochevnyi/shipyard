# Decisions

## Phase 45 is delivered correctness-first, then as measured treatments (strategy B)
**Why:** The replays N42–N58 cost whole model launches today, and correctness fixes are judged by fixture and refusal tests with no cohort needed. The efficiency treatments need the phase-44 observation data and matched cohorts. Packages whose core files lie outside unmerged phase-43 `files_modified` ship now. Packages on phase-43 files take a cross-phase `depends_on` on the owning T-43 ticket, or wait for the phase-43 epic.
**What was rejected:** S1 only (the waste persists); a host-owned conveyor bundle (one regression disables several gates, and treatments cannot be measured separately); buy-first (it addresses only CI churn).
**Scope fence:** ADR-021 (C1–C4) and ADR-022 are not reopened. No global model downgrade.

## The recommended per-package contracts are adopted
**Why:** Each is the smallest safe option that keeps every gate, and several can ship before phase 43 lands.
- **S1-a.** The Stop-gate marker binds the realpath of the delivery board. The hook reads only that board, and `disarm` removes the session's own marker. The design is upgradeable to run binding.
- **R14-a.** Plans declare `preconditions:` with explicit artifact paths. Gate 2 validates them and dispatch refuses before any model turn.
- **R16-a.** Dogfood installs use a dedicated runtime home, the doctor classifies a foreign cache as foreign, and the pre-push hook checks the pushed worktree.
- **R17-a.** The executor result, PR body and evidence persist in private host state keyed by dispatch id before finalization, and are recovered without replay.
- **D1-a.** A host-side duty diff wakes a model only when the actionable set changes, after S1 is installed.
- **D5.** An advisory aggregate ledger on `capacity-lease.cjs` comes first; enforcement follows.
- **D6.** Outer-session identity and the inherited model are measured first. A bounded handoff with a Luna/max candidate comes only after an approved experiment.
- **P1-a** a planning-tree writer lease; **P2-a** recovery from the durable reservation and authenticated transcript; **P3-c** deterministic pre-validation before the checker; **P4-a** blocking `dispatch wait` for decomposition; **P5-a** exact-revision INV reuse after C3.
- **I-c.** The shared C1/D4/P5 input identity uses the context-packet identity core (`source_revision`, `policy_hash`, packet digest) with per-consumer extensions.

**What was rejected:** the alternatives listed in [OPTIONS.md](OPTIONS.md) for each package.
**Scope fence:** file ownership and order are fixed by Gate 2 at decomposition.

## Environment-only findings are classified first; only a human-signed record resolves them (R10)
**Why:** A deterministic override risks a false green. The typed `environment_failure` record is cheap and safe now. The resolution is a separate, human-signed, audited gate record: it applies only on an unchanged head, base and instruction set, with exact same-command evidence, and it keeps the original violation. A deterministic policy may follow once that record has proven itself.
**What was rejected:** deterministic policy adjudication from the start; widening the reviewer sandbox, which is pending a spike on ADR-020 admissibility.
**Scope fence:** no model `conform` is ever forged.

## R18 starts with a merge-queue spike, falling back to host attestation, with base-merge kept
**Why:** A GitHub merge queue tests the exact merge result without changing the ticket head, if the repository's plan and `epic/*` branch rules allow it. If not, a host merge-result attestation is built. `base-merge.cjs` stays the fallback for conflicts, unsupported repositories and unknowns.
**What was rejected:** building the host attestation first; keeping base-merge only.
**Scope fence:** R18 never declares a changed-base review conform. ADR-022 precedence applies.
