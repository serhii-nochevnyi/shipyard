# Risks

Full register with evidence: `research/risks.md`. The ones that shape the ADR:

## The merge path accepts unreceipted commits today (F7)
severity: high
mitigation: a receipt-chain gate in `sentinel.cjs mergeOne` and the Codex merge path; journalled mechanical links (base-merge, host finalizer, fixer receipts) are accepted, anything else refuses with the command that brings it under the conveyor; spike S-3 (receipt-chain walker) before building.

## The receipt gate strands legitimate commits (F7)
severity: high
mitigation: enumerate the link kinds and the journal event that proves each (executor, fixer, base-merge, finalizer, declared remedy workflow if F18-A); an explicit rule for PRs opened before rollout.

## Host-side verification becomes a command-execution path (F7-A)
severity: high
mitigation: only commands declared in the approved plan and matching a project allow-list run; argument arrays, timeouts, bounded output; evidence recorded, never trusted from agent output.

## Verdict carry hides a sibling interaction (F6)
severity: high
mitigation: carry only on an unchanged own diff proved by object identities; refuse when the merge result differs from judged diff ∪ sibling diffs (backlog `a-clean-merge-can-duplicate-a-block…`); CI and the epic PR stay the interaction checks; spike S-4.

## Phase-40 rewrites the verdict carrier (F6)
severity: high
mitigation: build F6 only after T-40-19 (commit status `merge-gate`).

## Relaxations turn into fail-open gates (F8, F9, F12, F14)
severity: high
mitigation: truncated tree listings still refuse; only a declared bot's stale approval is ignored and only when the target branch requires no review; CANCELLED is never green; an unknown finding type never upgrades a verdict and a violation stays blocking.

## Untracked content reaches the judge (F5)
severity: high
mitigation: exempt only the conveyor's own scratch set from one shared definition; any other untracked file still refuses.

## Skipping merged tickets hides a revert or reopen (F11)
severity: high
mitigation: skip only tickets whose merge is recorded immutably (ledger entry plus merge SHA into a landed epic); `--full` re-derives everything.

## Wrong or duplicate Jira issues (F15)
severity: high
mitigation: bind by explicit key only; never create when a key is recorded; do not overwrite summary/description of issues without the shipyard label.

## Shared-file contention with phases 40/41 (all)
severity: medium
mitigation: a two-wave phase; wave A only on files no open 40/41 ticket owns; wave B declares the phase-40/41 owners as dependencies and starts after the phase-40 epic reaches `main`.

## Success criteria need a live rerun (F6, F7, F11)
severity: medium
mitigation: a final evidence ticket that reruns a comparable multi-repository phase on the proving ground and records the before/after numbers.
