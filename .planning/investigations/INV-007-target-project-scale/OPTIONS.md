# Options

Decision findings only; point fixes (F2, F5, F8, F9, F10, F11, F12, F14, F16) have one cheapest correct
shape each, recorded in `research/alternatives.md` Part 2 and summarised in DECISIONS once confirmed.
Full trade-off tables with evidence: `research/alternatives.md` Part 1. No option is preferred here.

## F7 — executor verification and unreceipted merges

Common to every option: `sentinel.cjs mergeOne` (and the Codex merge path) refuses a head not covered
by a verified executor/fixer receipt plus trusted finalization, or by a journalled mechanical link
(base-merge) descending from one, and names the command that brings the commit under the conveyor.

## Option A — host-side verification

The agent edits; the trusted host, outside the sandbox, runs the plan's declared verification commands
(via `command-runner.cjs`), records the result as finalization evidence and finalizes only on pass.

## Option B — declared verification environment inside the sandbox

Per-project sandbox config (network allow-list, `excludedCommands` such as docker, dependency caches,
a prepare hook); the agent verifies itself.

## Option C — verification deferred to repository CI

The executor may return "deferred to CI"; the host finalizes and publishes a draft; the ticket stays
unmergeable until CI is green.

## Comparison

| | Option A (host verify) | Option B (sandbox env) | Option C (CI-deferred) |
|---|---|---|---|
| Complexity | Medium: host command path, allow-listed commands, timeouts, evidence | Medium–high: per-runtime sandbox config, doctor checks | Low: policy + evidence text |
| Risks | Plan-declared commands run with operator authority → needs an approved allow-list | Widens agent authority (docker ≈ host root) → ADR-014 amendment | Slow feedback, more ci-fix launches, no local RED evidence; thin-CI repos get weak verification |
| What it forecloses | Nothing structural; reusable by fixer roles | Tightening the sandbox later becomes breaking | Local TDD evidence for infra-bound repositories |

## F6 — verdict carry across sibling base-merges

| | A. Own-diff identity carry | B. Composition carry | C. Cheap delta re-review |
|---|---|---|---|
| Sketch | Carry when the ticket's own patch is identical before/after (`git patch-id --stable` or per-path blobs) and nothing else differs from the new base | Carry when every incoming commit is a squash of a sibling with its own `conform` | Keep judging; the judge sees only a range-diff and the prior verdict |
| Complexity | Low–medium, after T-40-19 | Medium–high (commit→ticket→verdict map across repos) | Medium (new judgement mode) |
| Risks | Semantic conflicts with an identical patch pass to the epic; CI and the epic review remain | Same hole, larger; fail-open on lookup errors | Saves tokens, not launches |
| Forecloses | Nothing | Commits design to "verdicts compose" | The launches-per-ticket target |

## F17 — `human_checkpoint` under `auto_merge: epic`

| | A. Checkpoint gates epic→default only | B. Keep semantics, clearer Gate-2 prompt | C. Split flag `review` / `merge` |
|---|---|---|---|
| Complexity | Low–medium (`needsHuman`, epic PR listing, stats) | Very low (prose) | Medium (schema, validate-graph, sentinel, front, stats) |
| Risks | Work a human wanted to see lands in the epic; external-dependency checkpoints (T-02-13) need another hold | Operators keep misreading it; the epic stalls as observed | More vocabulary |
| Forecloses | "Do not even land in the epic" unless C's `merge` exists | Nothing | Nothing |

## F13 — comment policy vs repository-required annotations

| | A. Repository-declared allowed markers (+ edits of existing comments) | B. Repository wins (policy only forbids internals) | C. Keep strict, record the decision once |
|---|---|---|---|
| Complexity | Low | Low | Very low |
| Risks | Over-broad patterns re-admit narrative comments | Policy's purpose lost on target repos | Violates target-repo rules; repeated friction |
| Forecloses | Nothing | Strict mode needs migration | "No user decision needed" goal |

## F15 — binding pre-existing Jira issues

| | A. Recorded key is authoritative | B. Decompose proposes the mapping at Gate 2 | C. `on_no_match: skip/refuse` config |
|---|---|---|---|
| Complexity | Low (`plan` reads recorded key; bind-by-key; never create) | Medium (prompt + schema + Gate-2 check; needs Jira access) | Low |
| Risks | A wrong key updates another issue → only transition/comment on issues without the shipyard label | Model-authored mapping can be wrong (human checks at Gate 2) | Solves duplicates, not binding |
| Forecloses | Nothing | Couples decompose to Jira availability | Nothing; composes with A |

## F18 — automatable remedy before human escalation

| | A. Declared repository remedies (config) | B. Remedy search before escalation (propose only) | C. No change |
|---|---|---|---|
| Complexity | Medium (config, matcher, `gh workflow run`, wait) | Low (reference prose) | None |
| Risks | New outward action; the workflow may push commits → must be a known link in the receipt chain (F7) | Soft; agent may ignore it | Hours of wall time |
| Forecloses | Nothing | Nothing | The goal |
