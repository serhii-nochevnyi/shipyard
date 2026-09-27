# INV-008 authenticated-workflow preflight — 2026-09-26

Status: blocked before research dispatch. This is a source and installed-host preflight, not an authenticated research line, accepted decision, ADR, or Gate 1 result. No model launch or receipt was created.

## Recheck after Shipyard 0.67.0 release

- Release 0.67.0 (2026-09-27) merged phase 40, including T-40-12 (Codex planning-artifact consumer) and T-40-11. The host blocker below is expected to be resolved; rerun this preflight on the installed 0.67.0 hosts before dispatching the research lines.

## Recheck after Shipyard 0.66.0 installation

- The installed Codex plugin cache now contains `0.66.0+codex.b723c97e75aa8cb7`; `origin/main` is `c69d8b89` (release 0.66.0). The installed `codex-delivery-host.cjs` and `codex-decompose-host.cjs`, `origin/main`, and the remote phase-40 epic still lack the required planning artifact fields and consumer. No T-40-11 or T-40-12 PR exists; the local graph still records both as pending. The host blocker below remains current.
- `origin/main` now owns **phase 43 for ADR-020 target-project delivery at scale**, with nineteen PLAN files. The local optimization proposals were drafted as phases 43 and 44. On 2026-09-27 they were renumbered to phase 44 (subscription efficiency) and phase 45 (residual gaps) and added to the `main` roadmap; the references in this investigation use the new numbers.

## Runtime and launch status

- `pipeline-config.cjs resolve --json` selected `config.gsd.runtime: codex` from the installed bundle path. The investigation must stay on Codex; a Claude fallback would change the selected provider.
- `run-rollout.cjs status --json` reported Codex autonomous launches disabled and live capability unobserved. The skill says this controller switch does not itself disable command-issued research.
- The phase-45 scope and intake answers are present in the user's earlier requests and phase-45 context; no new preference was inferred for changing policy.
- `.planning/codebase/` is absent. The investigation can use the source paths below, but the missing map is a context limitation.

## Research host blocker

- Installed `scripts/codex-delivery-host.cjs` `requestValue` admits only `role`, `signals`, `context`, `dispatch_id`, and `gsd_role`; it has no planning-artifact contract or `shipyard.research-result.v1` consumer for the four lines.
- The current source and `origin/main` have no `artifactContract`, `artifactPaths`, `artifact_index`, or `planning.v1` handling in that Codex host. Existing phase-40 plan `40-12-PLAN.md` assigns that exact consumer to T-40-12, which the local graph still marks pending.
- The installed investigation skill requires a contained artifact path, host-sealed envelope/index, and verified durable receipt for each line. Dispatching now would spend subscription allowance without a valid way to accept its finding. Therefore no line was launched.

## Decomposition host blocker

- Installed `scripts/codex-decompose-host.cjs` accepts only `gsd_role`, `prompt`, `signals`, and `dispatch_id`, then returns the typed launch result. It does not accept or seal the required phase/repository/ADR-bound `CONTEXT.md` and PLAN index.
- The same missing contract is present in `origin/main`; phase-40 `40-11-PLAN.md` assigns the Codex planning sealer to T-40-11, which the local graph still marks pending.
- Shipyard decompose requires one verified researcher, planner, and checker receipt with bound artifacts, followed by actual PLAN files and `validate-graph.cjs` Gate 2. A manual ticket list would not satisfy this.

## Resume condition

After T-40-12 and T-40-11 are integrated and installed, rerun the installed-host preflight, then dispatch the four canonical INV-008 research lines. Reconcile phase-44 source ownership and phase-42 recovery evidence before drafting decisions. Close Gate 1 with a reviewed ADR; only then start typed phase-45 decomposition. Keep concurrent `.planning/graph` and phase-42 edits untouched until the supported planner owns the projection.
