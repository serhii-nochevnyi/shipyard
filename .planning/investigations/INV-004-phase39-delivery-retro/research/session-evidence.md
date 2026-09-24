# Session evidence — phase 39 delivery (input to INV-004 research)

Source transcript: `~/.claude/projects/-Volumes-KINGSTON-claude-shipyard/7bcbbf57-9cd4-4d9b-b17a-6064eae1b7c1.jsonl`
(continuation of `0cd4c016`). `[N]` is the jsonl line number. Times are UTC, 2026-09-24.
Installed host: `~/.claude/plugins/cache/shipyard/shipyard/0.61.0/`.

## Timeline

| UTC | Event |
|---|---|
| 11:35 | `/shipyard:investigate` INV-003 |
| 11:39–11:54 | research fan-out: 4 lines, 97 KB artifacts, host rejected all → artifacts taken from disk, gate bypassed with user consent [388], [433] |
| 13:06–13:52 | decompose: researcher, planner, checker (2 cycles) → 11 tickets, Gate 2 |
| 13:52–14:01 | planning PR #202; publish-gate blocked twice; CI flake then rerun |
| 14:02–14:43 | wave 1, round 1: 4 executors do the work, return `blocked` (no `--json-schema`) |
| 14:17–14:43 | T-39-12 added; fix; installed cache patched [1005] |
| 14:43–14:55 | round 2: `blocked` (adapter passes wrapper) → second T-39-12 fix, cache patched again [1218] |
| 14:55–15:04 | round 3: 4× `committed sealed` → PRs #205–#208 |
| 15:06–15:19 | sentinel fails three times (base ref, PR identity, run scope) → third T-39-12 fix |

## Systemic: invented boundary fixtures

1. `scripts/claude-runtime-host.cjs` launched without `--json-schema` although
   workflows declare `agentOptions.schema`; `structured_output` absent [869]–[891].
2. `scripts/claude-dispatch-adapter.cjs` capture passed `{status, summary, output}`
   to the workflow instead of `output`; `executors.mjs` could not read
   `status: "committed"` [1145]–[1157].
3. `normalizeScope` in `claude-runtime-host.cjs` rejected the `shipyard.run.v1`
   object from `run-scope.cjs createRunScope` (`ticket` is an object):
   `ticket must be non-empty text` [1420], [1474].
All three were green in `make test-fast`. Same class as the known
`observedSelection()` stdout-effort defect (fixtures invent the field).
A real structured launch is cheap: `claude --print --input-format stream-json
--output-format stream-json --verbose --model haiku --json-schema '<schema>'`
returned `structured_output` [886]–[891].

## N1 — stop gate fires while dispatches are in flight
Stop-hook demands at 13:54, 14:03, 15:x while 4 executors ran. The dispatch mark
is recorded only after the receipt, which arrives at the end of the work [840].

## N2 — no deterministic front → dispatch entry
The orchestrator read host source and hand-wrote `mkexec.cjs` [800], [804]:
request `shipyard.claude-delivery-request.v1` with `scope{run_id,ticket,phase,worktree}`
and `args.tickets[{id,title,planPath,branch,worktreePath,prBase,model,effort,signals,risk,checkpoint}]`.
Bugs: `signals.type` refused [801]; `planPath` pointed at the project checkout
instead of the ticket worktree [1011]. Launch/monitoring by `nohup … &`,
`pgrep -f`, `kill -0` [810], [815], [841].

## N3 — resolveDispatch rejects a graph signal
`DispatchPolicyError: signals.type "implementation" is not facts or alternatives`
(`model-policy-internal.cjs:355`) for role executor [801].

## N4 — sentinel implicit preconditions
- `claude-role-host: base branch epic/39-… is missing or differs from its live GitHub revision`:
  local epic ref not advanced after merging #203 [1323], [1342]; fixed by
  `git branch -f` [1328].
- `T-39-12 live PR identity differs from delivery state` after push + base merge;
  required `state-sync` and a committed state before the sentinel [1401], [1405].
- run-scope defect (systemic item 3) [1420].

## N5 — source-contract digest pin has no repair path
`tests/unit/source-contract.test.cjs` `RUNTIME_OWNED_FILE_DIGESTS` failed on a
legitimate `claude-dispatch-adapter.cjs` fix [1161]; the model replaced the
digest with `sed` [1183].

## N6 — branch-name truncation mismatch
`gh pr create --head ticket/T-39-12-…-to-eve` failed ("No commits between",
"Head ref must be a branch"); the pushed ref was `…-to-ev` [991], [994].

## N7 — research refusal names the wrong remedy
All four lines completed with receipts; rejection was over-long summaries only.
Message: "planning research has invalid scope or result. Install an
ADR-014-capable Claude host with explicit workflow model and effort support…"
[388]. Cause found by reading `~/.local/state/shipyard/claude/*/receipts` and
transcripts [407]–[428]. The whole fan-out was discarded.

## N8 — foreground polling
Loops of `sleep 15–30` up to 570 s [841], [1247], [1322], [1400], [1412];
harness blocks `sleep 45` [745]; macOS has no `timeout` [883].

## N9 — patched installed plugin
`cp` of unmerged worktree files over the 0.61.0 cache
`scripts/claude-runtime-host.cjs` and `scripts/claude-dispatch-adapter.cjs`,
leaving `*.pre-T-39-12.bak` [1005], [1218]. The rest of phase 39 is delivered on
a host that matches no release; receipts do not record the host source.

## N10 — generated state YAML push ritual (backlog entry exists)
`git checkout -- .planning/graph/delivery-state.yaml` before pushes ~8 times
[711], [931], [937], [1035], [1040], [1202], [1316], [1405]; stale GSD
projections failed CI on #203 (`make: *** [Makefile:66: test-gsd-sync]`) [1026], [1036].

## N11 — pre-push hook worktree detection
`publish-gate: not a git worktree: /Volumes/KINGSTON/.wt-claude-shipyard/inv-003` [677]
and `…/claude-shipyard/$W` [1374]; `git -C <path> push` worked.

## Already covered (do not re-plan)
T-39-01 refusal hints; T-39-03 session-scoped stop gate; T-39-04 auto-route
hook; T-39-07 gsd-tune message; T-39-08 research summary cap; T-39-12 schema,
output unwrap, run-scope. Backlog: `decompose-host-returns-no-artifact-index.md`,
`codex-plan-checker-lease-test-flakes-on-ci.md`,
`generated-state-yaml-header-blocks-push-from-the-project.md`.
