# Phase 36 integration review

- **Phase:** 36 — Enforce the runtime model ladder
- **Compared:** the phase-36 integration tree descended from `58ff16eaf5b62be66d0216b93535c2bf9e15a9ab` against `origin/main` at `931f87fee808881361b7cc6fc1879dbb56978ae5`
- **Integration PR:** #152
- **Review date:** 2026-09-16
- **Scope:** T-36-01 through T-36-12, including the post-review follow-ups in PR #148 and clean PR #151

## Verdict

**passed**

The phase is coherent against the amended ADR-014. The canonical policy owns
both runtime-specific grids, every production launch path crosses the boundary,
adapter receipts prove application, and the generated Codex bundle plus the
native Claude workflow are covered by the same refusal and provenance rules.

## Cross-ticket coherence

The tickets form one enforceable chain rather than parallel policy copies:

1. `model-policy-internal.cjs` defines the independent Codex and Claude grids
   and signal rules (`:68-209`).
2. `dispatch-boundary.cjs` rejects non-canonical policy injection
   (`:1665-1673`), resolves and validates the immutable selection, and verifies
   the application receipt (`:1305-1428`).
3. The Codex and Claude adapters translate that immutable resolution into their
   native launch mechanisms and return concrete application evidence:
   `codex-dispatch-adapter.cjs:145-307` and
   `claude-dispatch-adapter.cjs:110-197`.
4. GSD research/decomposition and the delivery workflows use the boundary host;
   they do not reconstruct a model or fall back to a session/default selection.
   The decomposition contract is explicit at
   `commands/decompose.md:45-96`.
5. PR #151 keeps `test-model-ladder-runtime` as a standalone target while
   removing nested invocations from the other smoke wrappers. This makes the
   fast gate exercise the smoke once, not once per wrapper.

No duplicate resolver, contradictory adapter contract, or dead handoff seam was
found in the combined diff.

## Architecture conformance

- ADR-014 is accepted and amended on 2026-09-15. Its runtime tables are the
  source of truth at `architecture/ADR-014-mandatory-runtime-model-ladder.md:42-101`.
- Codex keeps its own Luna/Astra IDs and Claude keeps native Sonnet/Opus/Fable
  aliases at `runtime-adapters.cjs:8-35`; no cross-runtime alias translation is
  used by the canonical resolver.
- The boundary validates runtime, role, policy hash, requested/applied model and
  effort, generated-file identity, and compliance proof before recording a
  launch (`dispatch-boundary.cjs:1313-1409`).
- Durable repair escalation consumes only a prior boundary-owned receipt, binds
  it to the same ticket, checks the preceding applied rung, and rejects replay
  (`dispatch-boundary.cjs:1779-1848`).
- The measured input is 413,086 tokens, above the 250,000-token policy window.
  For the current Codex runtime the canonical resolver therefore selects
  `gpt-6-astra/medium` for integrator (`model-policy-internal.cjs:84-87,
  :168-170`); this is the configured window escalation, not Astra/high.

## Acceptance sweep

| Ticket | Integrated result | Evidence |
| --- | --- | --- |
| T-36-01 | Runtime-specific nine-role grids, signal reasons, fingerprints, and fail-closed resolution are implemented. | `model-policy-internal.cjs:68-209`; `tests/unit/model-policy.test.cjs`; `tests/unit/dispatch-boundary.test.cjs` |
| T-36-02 | Configuration/runtime context exposes policy identity and dispatch identity; conflicting or ambiguous inputs are refused before launch. | `scripts/pipeline-config.cjs`; `scripts/runtime-context.cjs`; `tests/unit/pipeline-config.test.cjs`; `tests/unit/runtime-context.test.cjs` |
| T-36-03 | Codex selections are explicit; static roles use validated generated files and dynamic roles use explicit launch arguments. | `codex-dispatch-adapter.cjs:145-327`; `tests/unit/codex-dispatch-adapter.test.cjs` |
| T-36-04 | Generation, manifest/capability validation, installation refusal, and Codex smoke are wired to the final Luna/Astra contract. | `scripts/gen-codex-shipyard.cjs`; `scripts/install-shipyard-codex.sh`; `tests/unit/gen-codex-shipyard.test.cjs`; `tests/smoke/codex-shipyard-smoke.sh` |
| T-36-05 | Claude uses native aliases with explicit workflow model/effort and application receipts; no inherited or literal fallback remains. | `claude-dispatch-adapter.cjs:110-224`; `workflows/investigation-research.mjs:89-192`; `tests/unit/claude-workflow-host.test.cjs` |
| T-36-06 | Research and decomposition callbacks use typed GSD roles and the mandatory boundary on both runtimes. | `commands/decompose.md:45-139`; `workflows/investigation-research.mjs:150-213`; `tests/unit/investigation-research.test.cjs` |
| T-36-07 | Delivery launch surfaces use resolve → validate → launch → receipt; fixed, dynamic, judgement, and repair roles retain their intended mechanisms. | `scripts/dispatch-boundary.cjs:1665-1965`; `commands/deliver.md`; `tests/unit/source-contract.test.cjs` |
| T-36-08 | Applied values are receipt-owned; stale, missing, contradictory, unbound, and replayed evidence fails closed. | `scripts/dispatch-boundary.cjs:1305-1428,1779-1848`; `tests/unit/dispatch-record.test.cjs` |
| T-36-09 | Telemetry separates resolved, applied, observed, and usage-joined dimensions for both runtimes. | `scripts/pipeline-stats.cjs`; `scripts/usage-attribution.cjs`; `tests/unit/pipeline-stats.test.cjs`; `tests/unit/usage-attribution.test.cjs` |
| T-36-10 | Positive/negative matrix coverage and pre-launch refusal coverage exercise both runtime grids and omitted/illegal signals. | `tests/unit/model-policy.test.cjs`; `tests/unit/dispatch-boundary.test.cjs`; `tests/unit/workflows-args.test.cjs` |
| T-36-11 | A clean fixture validates both adapters, hashes, native Claude bytes, stale bundles, missing receipts, and inherited-selection refusals. | `tests/smoke/model-ladder-runtime-smoke.sh`; `tests/smoke/codex-shipyard-smoke.sh`; PR #151 CI run `35124865935` |
| T-36-12 | Active instructions and docs point to ADR-014 and the canonical role/signal vocabulary without fallback authorization. | `CLAUDE.md:65-73`; `README.md:189-225`; `tests/unit/claude-instructions.test.cjs`; `tests/unit/files-contract.test.cjs` |

The integration review found and resolved two stale planning contracts before
this verdict: `36-01-PLAN.md:214-224` now uses Codex Astra/low and Claude
Opus/low, and `36-03-PLAN.md:38-43` now names only the canonical Luna/Astra
Codex palette. Both now agree with the amended ADR-014 and
`model-policy-internal.cjs:68-150`.

## Verification evidence

- `git diff --check origin/main...HEAD` — exit 0, no whitespace errors.
- `bash tests/smoke/model-ladder-runtime-smoke.sh` — exit 0; `OK (37 installed runtime rungs; fingerprints, installer validation, native Claude bytes, refusal cases)`.
- `node plugins/delivery-pipeline/scripts/validate-graph.cjs` — exit 0; `116 ticket(s), 20 wave(s)`. Existing frontmatter-depth and cross-phase dependency messages are warnings; the validator explicitly reports `the graph wins`, and no phase-36 graph error is present.
- `make test-fast` on the post-fix integration tree — exit 0; all unit suites,
  graph/worktree/worktree-gates, docs, SSH sync, and the installed-runtime
  ladder smoke passed (`unit tests passed`; runtime smoke `OK`).
- `make test-codex-shipyard` — exit 0; `codex-shipyard smoke: OK`. The fixture
  emitted the expected signal-gap warning for an arch-review without measured
  input tokens; it did not change the verdict or exit status.
- `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json` — exit 0;
  `ok:true`, phase 36 `passed`, 12/12 plans merged, and `blockers:[]`.
- PR #152 check `test-fast`, run `35125235635`, on the pre-report code head — success.
- PR #151 check `test-fast`, run `35124865935` — success after the runtime-smoke deduplication fix.
- `gsd-tools phase uat-passed 36 --raw` was not available on the host PATH; no
  claim is made for that command. The repository-local equivalent projection is
  the generated phase UAT/VERIFICATION pair, which reports `status: passed` and
  `12/12 delivery records are merged` after the successful `gsd-sync` check.

## Findings

No cross-ticket coherence, emergent architecture, implementation acceptance, or
delivery-evidence finding remains. The two stale planning contracts were
reconciled, and state-sync now observes all twelve phase tickets as merged.

**Final verdict: passed.**
