# Phase 33 handoff and rotation evidence

Status: the offline handoff and recommendation paths are implemented and
measured. Automatic context transfer remains explicitly
`unsupported`/`unproven` for both runtimes. This report does not promote a
treatment, claim provider quota savings or authorize an automatic successor.

## Evidence matrix

| Area | Source and collector | Runtime/backend | Verdict | Evidence or limitation |
|---|---|---|---|---|
| Durable owner fencing | `session-handoff.cjs`, `session-handoff.test.cjs` | offline fixtures / controller | `verified-offline` | Checkpoint, competing resume, CAS acknowledgement, stale references, ambiguous launch, and predecessor fencing pass. |
| Rotation recommendation | `session-handoff.cjs`, `rotation-recommendation.test.cjs` | controller observations | `verified-offline` | Completed boundary and five comparable ordinary passes are reproducible; advisor-only, missing, and mixed dimensions remain `unknown`. |
| Handoff cost accounting | `orchestration-overhead.cjs` | metadata-only controller stream | `verified-offline` | `checkpoint_collection`, `successor_startup` and `cache_warmup` are separate stages. Missing provider evidence remains unknown. |
| Generated Codex consumer | `gen-codex-shipyard.test.cjs` and staged installer fixtures | Codex bundle / offline converter | `verified-offline` | Canonical checkpoint, context, recommendation and refusal scripts are copied and digest-bound. |
| Official generated-runtime smoke | disposable installation with the real host converter and CLI | Codex host | `unexecuted` | A real host proving-ground run was not performed in this offline ticket; installation presence is not capability evidence. |
| Clean-boundary manual handoff | explicit checkpoint, resume and acknowledgement sequence | real host | `unexecuted` | Requires a clean live boundary, live child enumeration and live PR/check revalidation. |
| Economic pilot | frozen prospective cohorts and provider/account windows | per runtime and backend | `unexecuted` | No observed account/window measurement is attached; no subscription or quota saving claim is allowed. |
| Automatic transfer | strict runtime context plus six proof categories | both runtimes | `unsupported`/`unproven` | No reviewed host adapter contract or real proving-ground evidence establishes safe fresh-context launch, application continuity or crash recovery. |

## Frozen identity and observations

Every overhead row must retain `run_id`, `dispatch_id`, role, runtime, backend,
policy identity and the two treatment dimensions. The collector is
`shipyard.orchestration-overhead.v1`, schema version `1`, with the
`utf8-bytes-div4-v1` estimate. Record the source revision, effective policy
hash, host/runtime versions, collector revision, provider/account window and
collection dates beside each real experiment report. A missing or mixed value
is a coverage finding, never zero evidence.

The recommendation is identified by a digest of its basis and evidence, so
replaying the same observation set does not create a second logical request.
Its comparison records sample IDs, metric and unit, prospective startup
median, twice-median threshold and each sample's result. The recommendation
only exposes manual recovery. It cannot call a timer, process control,
successor launch, acknowledgement or dispatch boundary.

## Runtime capability contract

The capability report is valid only with a strict active runtime context whose
policy version and hash match ADR-014, plus host-version-bound evidence for all
of these categories:

1. fresh bounded context;
2. supported launch API;
3. active child enumeration;
4. durable owner acknowledgement;
5. dispatch application-evidence continuity;
6. crash recovery.

The current report deliberately keeps `automatic_transfer.allowed` false. CLI
resume/fork help, an installed binary, a stale backend version, a forged or
synthetic capability, and a caller boolean cannot promote it. The refusal has
no external side effect and preserves the predecessor owner and manual
checkpoint path.

## Reproduction commands

Run from the repository root:

```bash
node tests/unit/rotation-recommendation.test.cjs
node tests/unit/runtime-context.test.cjs
node tests/unit/gen-codex-shipyard.test.cjs
node tests/unit/session-handoff.test.cjs
node tests/unit/orchestration-overhead.test.cjs
```

For a real manual proving-ground check, first inspect the durable owner and
write a complete checkpoint at a clean boundary. Start the successor
explicitly, revalidate the live head/base, reviews, checks, worktrees and
children, then acknowledge with the successor token. Preserve the JSON
validation result and the owner history. Do not turn this procedure into a
background or implicit launcher.

## Rollback and follow-up

Rollback disables the recommendation and context treatments for the affected
cohort while preserving acknowledged owner fencing, pending waits/actions,
dispatch reservations, receipts and the ADR-014 model policy. It never revives
a superseded predecessor, clears a live gate or creates a model receipt.

If a quality or recovery regression appears, record a linked backlog candidate
with the ticket, exact failure signature, source/runtime/backend/policy and
collector revisions, reproduction command, affected treatment, observed
quality signal and the rollback evidence. An incomplete economic result stays
`inconclusive`; it is not converted into a savings claim or an automatic repair.
