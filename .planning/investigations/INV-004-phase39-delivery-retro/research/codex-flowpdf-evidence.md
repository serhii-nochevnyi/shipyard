# Session evidence — Codex CLI, FlowPDF (input to INV-004 research)

Source: `~/.codex/sessions/2026/09/14/rollout-2026-09-14T16-23-36-01a0a016-6288-7ac3-83c4-5a3d30ddc1c8.jsonl`
(cwd `/Volumes/KINGSTON/FlowPDF`, codex-cli 0.154→0.156.1); Shipyard part from line 58854
(2026-09-24). Researcher sub-sessions: `~/.codex/sessions/2026/09/24/rollout-2026-09-24T15-0*`.
Installed `~/.codex/shipyard/scripts` is byte-identical to source 0.61.0 (`befc970c`), so
line numbers below apply to `plugins/delivery-pipeline/scripts/`.

Outcome: Phase 9 of FlowPDF never got plans. Research ran through an improvised
inline host, failed, was redone inline by the model; decompose host was never run;
the goal was marked blocked; the session stopped asking to patch the global install.

| Line | UTC | Event |
|---|---|---|
| 58928 | 11:48 | `codex-agent.cjs select research` refused (C1) |
| 58948 | 11:49 | `gsd-tune.cjs --apply --runtime codex` also wrote Claude-only keys (C2), reverted by hand at 59104 |
| 59202 | 12:01 | inline `node` heredoc drives `launchAgent`/`createCodexRuntimeHost` directly, `sandbox_mode:'read-only'`, receipts inside repo; packets 66k–132k tokens vs 12k ceiling (C3) |
| 59366 | 12:07 | 3 researcher children blocked: read-only sandbox rejected artifact writes; parents "shortened the authenticated context packet" (C4, C5) |
| 59377 | 12:08 | run killed (exit 130); research done inline; Gate 1 passed on hand-written research (59539) |
| 59599–59747 | 12:16–12:21 | agent reads `codex-decompose-host.cjs`, finds read-only researcher and no artifact consumer; host never run (C4, C6) |
| 60240–60847 | 12:48–13:07 | goal marked blocked (C6, C7) |
| 60851–60989 | 15:20–15:31 | agent asks permission to patch global install and write `~/.local/state/shipyard`; stopped |

## C1 — inherited GSD profile refused with a reinstall remedy
`codex-agent: config.model_profile selects "inherit", but pipeline.model_policy requires "balanced". Install an ADR-014-capable Codex host and regenerate agents with install-shipyard-codex.sh --phase 2; …`
Check: `pipeline-config.cjs:1641-1655` (`CONFLICTING_OVERRIDE`). Generic reinstall hint appended to every error: `codex-agent.cjs:21`, `:187`, `codex-model-remap.cjs:12`. Real remedy: `gsd-tune.cjs --apply` / `model_profile: balanced`. Partially overlaps T-39-01 (generic hint map).

## C2 — `gsd-tune --apply --runtime codex` writes Claude-only keys
Adds `models.{planning,execution:"opus",research,verification:"sonnet"}`, flips `workflow.use_worktrees`. `gsd-tune.cjs:606-609`; only `model_overrides` rows gated on `runtime === 'claude'` (`:592`). After manual revert `--check` reports drift forever (59114).

## C3 — no Codex investigation-research consumer
`commands/investigate.md:116-152` routes Codex research through `codex-delivery-host.cjs --args-file` with `role: research` and a host-owned sealer of `shipyard.research-result.v1`. The sealer `sealPlanningResearch` exists only in `claude-delivery-host.cjs:506-572`; `role-artifact.cjs` is required only by `claude-*` hosts; `codex-delivery-host.cjs` has no research branch; generated `shipyard-inv-research.toml` is `sandbox_mode = "read-only"` (`gsd-tune.cjs:117`) but must write its artifact. T-39-08 plan (`39-08-PLAN.md:44`) assumes a Codex research consumer via `role-artifact.cjs:384 capSummary` that does not exist.

## C4 — GSD researcher forced read-only but must write its file
`codex-decompose-host.cjs:18` (`'gsd-phase-researcher': { sandbox: 'read-only' }`), `codex-dispatch-adapter.cjs:98-99`; installed `~/.codex/agents/gsd-phase-researcher.toml:3` is `workspace-write`, host overrides downward. `tests/unit/codex-decompose-host.test.cjs:35`, `:103` pin the defect with a forged read-only fixture. `decompose.md:210-221` requires the line artifact on disk.

## C5 — parent relays a shortened task undetected
Parent `codex exec` prompts 274k–534k chars; `spawn_agent` messages 13.8k–44.8k chars. `codex-runtime-host.cjs:876-880` asks the parent to pass "this exact task"; `:638-643` checks only `agent_type/model/effort/fork_turns/task_name`, not the message. `context-packet.cjs` ceiling 12k with overflow allowed. A verified receipt can attest a truncated task.

## C6 — no trusted consumer for decomposition results (shared)
`codex-decompose-host.cjs:124-196` returns raw `launchAgent` result; no `decomposition-result.v1`/`artifact_index` sealing required by `decompose.md:210-229`. Same gap in `claude-decompose-host.cjs` (backlog `decompose-host-returns-no-artifact-index.md`, Claude-only wording).

## C7 — out-of-repo host state not explained
`codex-decompose-host.cjs:72-86` requires state dir outside the worktree (`INVALID_STATE_DIR`), default `~/.local/state/shipyard/codex-decompose/`. By design; skills never say it is Shipyard's evidence store, so the agent read a user "work only here" rule as forbidding it.

## C8 — `make doctor` never checks the Codex install
`[skip] codex: /Users/serhii/.codex has no Shipyard bundle manifest`. `shipyard-doctor.cjs:193-195` expects `~/.codex/shipyard/manifest.json`; installer writes `~/.codex/agents/.shipyard-manifest.json` (`install-shipyard-codex.sh:280`, `:301`; `gen-codex-shipyard.cjs:384`). `tests/smoke/claude-hook-smoke.sh:61` only runs doctor against an empty Codex home.

## FlowPDF state
HEAD `40adc5d` pushed; untracked `.planning/graph/receipts/codex/` and `.planning/graph/transcripts/codex/` left by the improvised run; `.planning/config.json` has `model_profile: balanced` (was `inherit`), no `pipeline:` block.
