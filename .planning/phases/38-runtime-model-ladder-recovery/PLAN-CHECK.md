# Phase 38 plan check

## Verdict

**Ready for implementation as Phase 38.** Phase 37 already landed in PR #186; these follow-ups use a new epic branch. The latest remote state
sync marks T-37-01 through T-37-08 merged. PRs #180, #182, and #186 report a
successful `test-fast` check; GitHub returns no review records for those PRs.
The merged status does not prove the live runtime behavior the phase requires.

Five follow-up tickets, T-38-01 through T-38-05, cover the remaining gaps. The
graph validator reports 143 tickets across 20 computed waves with no cycles.
Warnings for new delivery-host files are intended outputs. The T-38-05 join of
both provider host branches is intentional. No Jira projection was created.

## Goal-backward coverage

| Requirement | Covered by | Result |
|---|---|---|
| REQ-111 scoped run identity | T-37-01, T-37-02, T-37-05 | Merged |
| REQ-112 controller continuation | T-37-02, T-37-06, T-37-07, T-37-08, T-38-05 | Covered |
| REQ-113 provider-pure adapters | T-37-01, T-37-03, T-37-04, T-37-08, T-38-03, T-38-04 | Covered |
| REQ-114 Claude production host evidence | T-37-03, T-38-02, T-38-03, T-38-05 | Covered |
| REQ-115 Codex production host evidence | T-37-04, T-38-04, T-38-05 | Covered |
| REQ-116 receipt join contract | T-37-01, T-37-03, T-37-04, T-37-07, T-38-01, T-38-02, T-38-03, T-38-04 | Covered |
| REQ-117 graph reachability | T-37-05, T-37-08 | Merged |
| REQ-118 deterministic waits and human boundary | T-37-02, T-37-06, T-37-07, T-37-08, T-38-05 | Covered |
| REQ-119 usage/effectiveness attribution | T-37-07, T-37-08 | Merged |
| REQ-120 per-runtime rollout and negative evidence | T-38-01, T-38-02, T-38-04, T-38-05 | Covered |
| REQ-121 GPT-6 Codex IDs and Luna/max base | T-38-01, T-38-04 | Covered |
| REQ-122 Claude Opus 5.5 and exact-session evidence | T-38-01, T-38-02 | Covered |
| REQ-123 native subscription-auth detection | T-38-05 | Covered |

## Structural checks

- T-38-01 updates the native IDs before either new provider host consumes the
  policy. T-38-02 proves Claude selection evidence before T-38-03 wires its
  delivery caller. T-38-04 remains provider-pure and can run alongside those
  Claude tasks. T-38-05 joins both hosts before command routing and rollout.
- Claude evidence is read from assistant transcript entries whose `sessionId`
  matches the host-created ID; attachments, other sessions, and synthetic
  stdout fields cannot satisfy the receipt.
- Both runtimes keep capability-only checks free of model calls. The opt-in
  smokes prove scoped edit and Bash access and distinguish `passed`,
  `unavailable`, and `refused`.
- Subscription authentication is checked via `claude auth status --json` and
  `codex login status`; raw command output is excluded from logs and results.
- Runtime flags and readiness remain provider-specific. One unavailable peer
  cannot block or enable the healthy runtime.
- Child processes use scoped edit/Bash permissions or Codex workspace-write
  sandboxing without a blanket permission bypass.
- Merged PR state is not used as a substitute for receipts or live runtime
  evidence; the phase stays unverified until its integration and UAT gates pass.

## Residual risks

1. Earlier GSD research/planning callbacks timed out. This plan check is a local
   review and does not invent boundary-verified dispatch receipts.
2. The live smokes use subscription allowance. They are separate opt-in
   commands and must not run as part of the ordinary capability-only test suite.
3. Historical merged PRs #180, #182, and #186 have green `test-fast` checks but
   no GitHub review records. New PRs remain subject to the user's green-check
   and review conditions before merge.
