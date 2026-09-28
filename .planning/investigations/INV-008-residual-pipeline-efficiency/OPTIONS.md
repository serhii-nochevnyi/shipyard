# Options

Full analysis: [research/alternatives.md](research/alternatives.md). Constraints and blockers: [research/constraints.md](research/constraints.md) §4–§6.

## Phase-level strategy

| | A — S1 only | B — correctness-first, then measured treatments | C — host-owned conveyor bundle | D — buy hosted primitives |
|---|---|---|---|---|
| What ships first | S1 | S1 and the independent correctness fixes now; phase-43-dependent packages after the epic; treatments one at a time | one controller extension carrying D1, D5, P4 and R14 | GitHub merge queue and branch rules for R18; build the rest |
| Measured waste addressed | none | replays N42–N58 first, then cohort-measured treatments | parent/wait and sentinel turns in one step | CI/branch churn only (N59) |
| Main risk | the waste persists | serialization on hot files | one regression disables several gates; treatments cannot be measured separately | ephemeral epics need protection rules; plan availability unknown |

## Per-package options (recommended first)

| Package | Options |
|---|---|
| S1 | **S1-a** bind the marker to the realpath of the board and add `disarm` (upgradeable to run binding) · S1-b bind to a run-controller run · S1-c owner stamp in the front (waits for T-43-12) · S1-d none |
| R10 | **R10-a** typed `environment_failure` classification now, then R10-b (deterministic policy) or R10-c (human-signed) adjudication · R10-d a writable reviewer `TMPDIR` (ADR-020 admissibility unknown) |
| R14 | **R14-a** plan-declared `preconditions:` validated by Gate 2 and refused at dispatch · R14-b a dispatch-only check · R14-c none |
| R16 | **R16-a** a dedicated dogfood home by default, with foreign caches classified as foreign; the pre-push hook checks the pushed worktree · R16-b a per-session provenance stamp · R16-c none |
| R17 | **R17-a** persist result, body and evidence in private host state before finalization; recover without replay · R17-b refuse finalization without the payload · R17-c a supported `recut` |
| R18 | **R18-c** GitHub merge queue with `base-merge.cjs` as fallback · R18-b a host merge-result attestation · R18-d fewer pushes only · R18-a status quo |
| D1 | **D1-a** a host-side duty diff that wakes a model only on change (after S1) · D1-b move mechanical duties to the host · D1-c a smaller packet |
| D5 | **D5-a → D5-b** an advisory ledger first, then enforcing on `capacity-lease.cjs` · D5-c inside `dispatch-boundary.cjs` |
| D6 | **D6-d** measure outer-session identity and inherited model now, then D6-b (bounded handoff plus a Luna/max candidate) after an approved experiment · D6-a · D6-c |
| P1 | **P1-a** a planning-tree writer lease on `capacity-lease.cjs` with a fencing token · P1-b a run lease · P1-c detect only |
| P2 | **P2-a** recover from the durable reservation plus the authenticated transcript and artifact digest, with no relaunch · P2-b a longer timeout |
| P3 | **P3-c** deterministic pre-validation before the checker (after T-43-12) · P3-a bounded revision receipts · P3-b internal convergence |
| P4 | **P4-a** blocking `dispatch wait` for decomposition · P4-b no model parent · P4-c measure only |
| P5 | **P5-a** exact-revision INV reuse on `source_revision`, `policy_hash` and the C3 index (after C3) · P5-b a budget only |
| Shared identity (C1/D4/P5) | **I-c** the context-packet identity core plus per-consumer extensions · I-a one shared manifest hasher · I-b independent manifests |
