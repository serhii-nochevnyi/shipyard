# Codex session: phase 41 decomposition — observed pipeline behavior

Date: 2026-09-25. Source: Codex rollout `01a0d7d3-864b-7ed0-8038-2e00a1da1d92`
(orchestrator, cwd main checkout, work in worktree
`.wt-claude-shipyard/plan41-subscription-overhead`) and its role sessions of the
same day. This complements
[pipeline-subscription-efficiency](2026-09-25-pipeline-subscription-efficiency.md)
and [claude-session-efficiency](2026-09-25-claude-session-efficiency.md); findings
already stated there (backlog in every packet, 97.46% cache reads, false stop-hook
wakeups) are not repeated.

## Totals

| Item | Value |
|---|---|
| Wall time (active) | 10:21–11:55 and 15:18–17:21 UTC; decomposition still not sealed |
| Weekly Codex limit (prolite) | 40% → 57% during the session; 0 lines of product code delivered |
| Orchestrator input | ≥46.5M (4 compactions; gpt-6-astra/medium, then gpt-6-luna/max) |
| Role children input | 23.6M (Sol/high) |
| Role parents (`codex exec` wrappers) input | 14.1M (Sol/high) |
| INV-006 research lines (4, local host) | 10.5M |

Typed role launches by `agent_role`:

| Role | Launches | Input tokens (child) |
|---|---:|---:|
| gsd-phase-researcher | 2 | 10.53M + 2.02M |
| gsd-planner | 1 | 3.58M |
| gsd-plan-checker | 6 | 1.20 / 1.06 / 1.34 / 1.13 / 1.58 / 1.16M |

`decompose.md:385-393` requires exactly three typed callbacks and three receipts
and forbids a second `gsd-plan-checker`. Nine were launched.

## Findings

### F1. Codex decomposition runs on a private, untracked host

The installed host keeps the researcher read-only and has no decomposition
sealer (T-40-10/11/12). The session built a private runtime at
`~/.local/state/shipyard/phase41-local-host` (outside Git, no unit tests, per
`PLANNING-BLOCKERS.md`) and every phase-41 receipt comes from it.
`PLANNING-GATES.json` records no digest of that host. Owner: T-40-10/11/12/14.
Not closed before phase 41 — the 41-before-40 order is already broken in both
directions (41 needs 40's sealer; T-40-03 now depends on T-41-08).

### F2. A completed researcher was rejected on `wait_agent` timeout

All parent `wait_agent` calls timed out; the child finished; the host refused
with `RUNTIME_EVIDENCE_MISMATCH: native parent wait did not complete`. No path
turns an authenticated completed native transcript into a receipt, so the
research was re-launched only to obtain one (19:33 parent 0.62M + child 2.02M).
Owner: timeout acceptance → T-41-04 (added in this session). Receipt recovery
for judgment roles (researcher/planner/checker), as opposed to executor
finalization, is not in T-41-04 or phase 40.

### F3. The checker is re-run on every change; the three-receipt rule has no gate

Causes of the six checker runs: orchestrator fixes after findings (the rule
leaves only BLOCK), a concurrent Claude session committing T-41-08 and editing
`CONTEXT.md` into the same worktree mid-run (hash mismatch → stale receipt), and
the orchestrator removing then restoring T-41-07. Every re-check re-reads all
plans. Uncovered by phases 40/41: no bounded revision loop, no delta-scoped
re-check, no deterministic count gate.

### F4. No single-writer lease on a planning worktree

Two sessions (Codex orchestrator and Claude `session_01AgowK9…`) wrote the same
branch `plan/41-subscription-overhead`. Codex first attributed the edit to the
host, then to the user. Uncovered: the worktree-condition tickets (T-40-28/32/33)
check dirtiness and scope, not ownership.

### F5. The `codex exec` parent is a full Sol/high model that only waits

Each role launch is a parent that spawns one native child and loops on
`wait_agent` (e.g. 1 spawn + 8 waits); every wait resends the parent context.
Parents took 14.1M input, 37% of role input. T-40-15 removes foreground polling
from the orchestrator for delivery; nothing removes or downgrades the model
parent layer, and decomposition dispatch is not covered by T-40-15.

### F6. The researcher rewrites its report in small patches

The first phase researcher made about 15 `apply_patch` edits to `41-RESEARCH.md`
with repeated `wc -c`/section checks while its context grew 98k → 217k — 10.5M
input for one report, after four INV-006 research lines had already covered the
topic. Uncovered: no write-once/byte-budget contract for research reports and no
reuse of investigation lines in the phase researcher (the prior audit's
"Reuse investigation evidence in decomposition" is not in any plan).

### F7. The orchestrator stops instead of continuing

Repeated user prompts ("то що тут?") received status replies; the agent twice
acknowledged stopping short. 73 sleep/wait/status invocations. Codex has no
equivalent of the Claude stop gate. Partly covered: T-41-02 (bounded
continuation) and T-40-15 (blocking `wait`) for delivery only.

## Coverage summary

| Finding | Owner | State |
|---|---|---|
| F1 private host | T-40-10/11/12/14 | covered in 40; ordering conflict |
| F2 timeout acceptance | T-41-04 | covered |
| F2 judgment-role receipt recovery | — | gap |
| F3 checker re-runs / count gate | — | gap |
| F4 planning-worktree writer lease | — | gap |
| F5 model parent layer | — (T-41-06 only measures) | gap |
| F6 research write-once / reuse | T-40-13 partial (line re-dispatch) | gap |
| F7 Codex stop-short | T-41-02, T-40-15 partial | partial |

## Proposals

1. Decide the ordering (F1): either pull T-40-10/11/12/14 into a prerequisite
   phase before 41, or accept that phase 41 is planned with the private host and
   record its digest in `PLANNING-GATES.json` and the planning PR.
2. Add to phase 41 (T-41-04 or a new ticket): receipt recovery for judgment
   roles from an authenticated native child transcript bound to the dispatch
   reservation — no re-launch when the artifact and transcript verify.
3. Replace "exactly one checker" with a bounded revision loop (≤2 re-checks,
   each scoped to the changed plans plus graph) and enforce the count
   deterministically in the decompose host.
4. Add an owner lease for planning worktrees: hosts refuse to launch and a
   receipt is marked stale with the changed path and writer when another
   session commits during a run.
5. Remove the model parent for Codex roles or run it on the cheapest selection
   with a single long `wait_agent` timeout; measure via T-41-06.
6. Research reports: state the byte budget up front, write once, let the host
   validate sections; pass INV research lines to the phase researcher as inputs
   and skip it when they cover the plan contracts.
7. Extend T-40-15's `dispatch wait` to decomposition roles so the orchestrator
   issues one blocking call per role.
