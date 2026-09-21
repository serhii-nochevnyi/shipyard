# Phase 33 integration review

- **Phase:** 33 — Reduce orchestration context and transfer sessions safely
- **Compared:** `origin/epic/33-reduce-orchestration-context-and-transfer-sessions-safely` against `origin/main`
- **Integration PR:** #163
- **Review date:** 2026-09-17
- **Review mode:** inline Codex repository review; no separate reviewer result is claimed
- **Ticket coverage:** T-33-01 through T-33-09, delivered by PRs #154 through #162
- **Implementation diff at the integrated ticket head:** 48 paths, 13,469 insertions, 270 deletions

## Verdict

**passed (repository-verifiable acceptance)**

The nine ticket slices form one enforceable path: semantic wait and review transitions, bounded durable evidence, bounded repair and planning handbacks, targeted launch context, independent overhead accounting, fenced manual handoff, and evidence-based rotation recommendation. The combined implementation preserves a single runtime/model dispatch boundary and does not introduce an automatic transfer side effect.

## Cross-ticket coherence

1. `wait-events.cjs` owns durable semantic observations, pending actions, dispatch identity, acknowledgment, and wait measurements. `ci-wait.cjs` and the stop gate consume those events instead of inferring completion from model output (`plugins/delivery-pipeline/scripts/wait-events.cjs:392-765`).
2. `role-artifact.cjs` seals bounded envelopes while retaining complete command-backed evidence in contained files. It binds artifact identity, repository/base/head trees, digests, and the authenticated dispatch before a consumer can accept the result (`plugins/delivery-pipeline/scripts/role-artifact.cjs:373-441, 521-716`).
3. Repair, drift, judgment, research, and decomposition paths use the same validated artifact references. Attempt history resolves only authenticated historical artifacts and preserves their complete evidence references (`plugins/delivery-pipeline/scripts/attempt-history.cjs:163-235`; `plugins/delivery-pipeline/workflows/drift-gate.mjs:160-223`; `plugins/delivery-pipeline/workflows/investigation-research.mjs:61-180`).
4. `context-packet.cjs` carries only the requested role sections, immutable scope, policy digest, current backlog, and measured size. It rejects escaped paths, stale digests, stale backlog entries, and stale accounting before launch (`plugins/delivery-pipeline/scripts/context-packet.cjs:376-430, 518-601`).
5. `orchestration-overhead.cjs` records model turns, waits, tools, checkpoint collection, successor startup, and cache warmup as separate pass and lifecycle dimensions (`plugins/delivery-pipeline/scripts/orchestration-overhead.cjs:24-28, 317-400`).
6. `session-handoff.cjs` is the owner fence. Checkpoint, resume, acknowledgment, successor startup, and cache lifecycle facts stay bound to the same session capability and dispatch identity (`plugins/delivery-pipeline/scripts/session-handoff.cjs:148-159, 668-874`).
7. Rotation is advisory and evidence-based. `requestAutomaticTransfer()` and `reportTransferCapability()` refuse an automatic side effect unless the host can prove the reviewed runtime-specific boundary; the current implementation reports that capability as unsupported and unproven (`plugins/delivery-pipeline/scripts/session-handoff.cjs:747-761`; `plugins/delivery-pipeline/scripts/runtime-context.cjs:280-344`).

No duplicate resolver, shortcut launch path, contradictory artifact contract, or disconnected handoff seam was found in the combined implementation diff. The source-contract suite and the full fast gate exercise the cross-ticket seams together.

## Architecture conformance

- Durable state and evidence remain data owned by the delivery pipeline; live CI/review gates and the dispatch boundary remain authoritative.
- Artifact and context packets are identity-bound by runtime, role, ticket, policy, repository, base, head, and content digest. Invalid, stale, escaped, oversized, or replayed data is refused before it can authorize work.
- Codex and Claude remain separate runtime surfaces. Codex uses its OpenAI model identifiers and generated agent contract; Claude uses native Anthropic workflow aliases and explicit effort. Phase 33 does not translate or mix the two runtime palettes (`plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs:111-126, 198-264`; `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs:380-420, 463-518`).
- Waiting and handoff lifecycle measurements are recorded independently from model usage, so later cost and effectiveness analysis can distinguish model work from waiting, context transfer, and cache overhead.
- The manual handoff sequence remains the only supported transfer path. Automatic transfer is deliberately refused until all runtime, host, receipt, capability, boundary, and proving-ground evidence categories are present.

## Acceptance sweep

| Ticket | Integrated result | Evidence |
| --- | --- | --- |
| T-33-01 | Durable CI and review transition events, pending actions, and acknowledgments are persisted and consumed by the wait/stop paths. | `plugins/delivery-pipeline/scripts/wait-events.cjs`; `tests/unit/wait-events.test.cjs`; `tests/unit/ci-wait.test.cjs` |
| T-33-02 | Executor results use a bounded authenticated envelope with complete evidence references and a committed revision requirement. | `plugins/delivery-pipeline/scripts/role-artifact.cjs`; `tests/unit/role-artifact.test.cjs` |
| T-33-03 | Repair and drift results are bound to live identity and prior evidence, with explicit bounded outcomes and durable findings. | `plugins/delivery-pipeline/scripts/role-artifact.cjs`; `plugins/delivery-pipeline/scripts/attempt-history.cjs`; `tests/unit/repair-artifacts.test.cjs` |
| T-33-04 | Architecture and integration judgment retains complete evidence while exposing a bounded decision envelope. | `plugins/delivery-pipeline/scripts/role-artifact.cjs`; `tests/unit/judgment-artifacts.test.cjs` |
| T-33-05 | Research and decomposition handbacks require the planning artifact contract and validated references. | `plugins/delivery-pipeline/workflows/investigation-research.mjs`; `plugins/delivery-pipeline/commands/decompose.md`; `tests/unit/planning-artifacts.test.cjs` |
| T-33-06 | Launch packets carry the role-specific policy, scope, acceptance, verification, and backlog context required for the selected work. | `plugins/delivery-pipeline/scripts/context-packet.cjs`; `tests/unit/context-packet.test.cjs` |
| T-33-07 | Model, wait, tool, and handoff lifecycle observations are separated and measured for later effectiveness analysis. | `plugins/delivery-pipeline/scripts/orchestration-overhead.cjs`; `tests/unit/orchestration-overhead.test.cjs` |
| T-33-08 | Manual checkpoint/resume uses a fenced owner capability, one acknowledgment, and one dispatch identity. | `plugins/delivery-pipeline/scripts/session-handoff.cjs`; `tests/unit/session-handoff.test.cjs` |
| T-33-09 | Rotation recommendations are evidence-based and automatic transfer is refused without proven host capability. | `plugins/delivery-pipeline/scripts/session-handoff.cjs`; `plugins/delivery-pipeline/scripts/runtime-context.cjs`; `tests/unit/rotation-recommendation.test.cjs`; `tests/unit/runtime-context.test.cjs` |

## Verification evidence

- `git diff --check origin/main...HEAD` — exit 0; the integrated ticket tree has no whitespace errors.
- `make test-fast` in the clean integration worktree `/tmp/shipyard-phase33-integration` — exit 0; all unit suites, graph/worktree/worktree-gates, docs, SSH sync, and installed-runtime model smoke targets passed.
- The focused Phase 33 commands all returned exit 0: `wait-events`, `role-artifact`, `repair-artifacts`, `judgment-artifacts`, `planning-artifacts`, `context-packet`, `orchestration-overhead`, `session-handoff`, `rotation-recommendation`, `runtime-context`, `gen-codex-shipyard`, and `source-contract`.
- The installed runtime smoke reported `OK (37 installed runtime rungs; fingerprints, installer validation, native Claude bytes, refusal cases)`.
- State synchronization observes all nine Phase 33 delivery records as merged and will be rerun after this report is added so the generated UAT and verification projections contain the final verdict.

## Boundary evidence

The repository acceptance evidence is complete. A real host proving-ground run of the manual handoff, including an actual predecessor/successor session, host application receipt, and live review/CI boundary, is outside the checked-in fixture. The code therefore keeps automatic transfer `unsupported`/`unproven` and exposes only the explicit manual recovery sequence. No live economic savings claim is made from the repository tests; the new lifecycle fields are the measurement surface for a later observed pilot.

## Findings

No cross-ticket coherence, emergent architecture, acceptance, or repository-local verification finding remains. The remaining boundary is explicitly represented in the capability refusal and the manual handoff documentation.

**Final verdict: passed.**
