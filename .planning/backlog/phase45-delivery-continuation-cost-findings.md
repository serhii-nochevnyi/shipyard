# Phase 45 continuation: prevent repeated native delivery work

Status: follow-up planning input; not an implementation or release claim. Coordinate with the existing Phase 46 work and Phase 47 attribution scope. Full REQ-193 remains deferred.

## Observed mechanisms

1. A core typed-boundary change passed its five targeted suites, but full CI rejected nine legacy success cases in five other suites. The original T-45-16 ownership omitted those fixtures. A verified independent plan checker subsequently identified two real trusted-caller seams, `claude-workflow-host.cjs` and `codex-delivery-host.cjs`, that could not be fixed honestly through tests alone. Regression closure must cover callers of a changed contract before executor dispatch, with actual source evidence rather than a broad suite count.
2. The released `deliver-dispatch.cjs build ci-fix` refuses because its native host does not bind the canonical graph ticket, PR and failure-file SHA-256 at launch. Preserve the refusal until the host contract exists. Planning a repair path whose dispatcher cannot authenticate its inputs creates avoidable fallback and repeated planning work.
3. A native GSD checker read its mandatory `gates.md` before `TASK_FILE`. The Shipyard relay rejected the completed result because the first tool call did not read the bound task file. An isolated native GSD profile was clarified to read both files in the first call and print the task SHA. Native verification remained unchanged. Align GSD required-reading order with the host handshake during installation and verify that seam before a model launch.
4. A refreshed architecture review caught a writer fence checked before `record` but not before `finalize`. An earlier conform result was scoped to another head/base and cannot authorize the current tree. Keep source identity checks; improve the first executor's explicit mutation-window acceptance and deterministic record/finalize takeover test so the independent review is confirming a complete tracer.
5. Historical merged PR identities were missing after graph regeneration and needed authoritative ledger repair before Gate 2. Persist stable actual PR identities; do not rediscover them through broad repeated GitHub enumeration.
6. Early planning input left untracked in a planning worktree caused a native containment refusal; a no-op research adoption was also refused because declared artifact paths did not equal the actual delta. Admission must establish clean ownership and the intended read-only versus write contract before native research.

## Proposed planning criteria

- Add a command-backed caller inventory and minimal discriminating regression set to plans that change a shared boundary contract. A fixture-only repair must show the trusted injection seam actually exists.
- Preflight every repair role through its real request builder and fail before allocating a model when the host input-binding contract is unavailable.
- Test native task relay and GSD mandatory first reads together, preserving both requirements and the configured provider/model/effort. Do not weaken transcript verification to accept an unbound result.
- Keep intermediate durable writes provisional until the current owner passes every commit gate. Test takeover between writes and authenticated scoped cleanup; never delete unrelated receipt history.
- Keep integration/package roles proportionate: generated-only work does not need an extra high-risk human halt; actual final-tree native runtime and operator gates remain phase publication requirements.
- Reuse verified research/checker facts for bounded revisions while preserving actual new-head review binding. Archive refusals and negative judgments; do not project an earlier conform result onto changed code.

## Additional measured delivery failures

- Full CI run `36797232360` passed on `dcdccccca6a34c0b02f283af7be7eb72a1d72f34`, while the subsequent authenticated architecture review still found two production writer-session producers absent. Fixtures injected sessions, but real Claude registration and Codex CLI did not. Require a successful real entrypoint tracer without manually supplied authority before expensive full-corpus review; injected fixtures alone do not close a production contract.
- The PLAN verification parser ignored the `make test-fast` bullet with trailing explanatory text. Make required-command admission machine-checkable before dispatch, report every omitted command, and keep explanations outside command bullets. Passing the admitted subset does not prove the full listed verification contract.
- Refresh the actual remote integration base before model allocation and pin clean HEAD/TREE plus owned-product byte parity. A completed authenticated implementation had to be relaunched after verification/base failures when no resumable candidate existed. Preserve authenticated completed output before verification and provide a guarded, no-model retry of verification/finalization against valid ownership and source identity; never replay stale launch authority.
- Linux full CI previously failed because the final publish gate used `origin/main` while the earlier gate used the real PR base. PR #395 corrected the workflow base binding. Check consistency across duplicated gates before model repair.
- The pre-ticket macOS sandbox suite failed because BSD `mktemp` without arguments uses the Darwin user temporary directory before `TMPDIR`. Actual diagnosis confirmed an explicit template in the sandbox-approved directory succeeds without changing permissions. PR #396 merged as `0d38ae01bc893d2765dc08cc424f7cc212b31923`, with real macOS 10/10 tests and full Linux CI success on attempt 2. Attempt 1 exposed old intermittent reservation/recovery fixtures and remains archived; the rerun is not proof those fixtures are stable.
- A child `exit` event preceded drainage of JSON on stdout in a reservation regression fixture. Waiting for `close` fixed the observed CI race while preserving production behavior and assertions. Prefer lifecycle events matching the evidence being consumed.

- Source tracing rebutted a review assumption: Claude's shipped delivery wrapper permits four fixed workflows, and investigation research explicitly sets `requireGsdRole:false`. Named GSD goes through the decomposition host. Distinguish the real shipped route from trusted custom-script fixtures before planning a missing producer; a negative model review needs source-backed evidence too.
- A verified GSD checker found that exact equality between authenticated artifact declarations and `changedSince` rejects legitimate unchanged research/CONTEXT/PLAN files. Keep authorized materialized outputs separate from changed bytes, completion-time digests and undeclared-write detection. Add idempotent positive cases and omitted-change negatives before expensive architecture judgment.
- Another verified finding showed equal lease keys under separate delivery/decompose state roots do not provide mutual exclusion. Verify the physical lease record and real cross-entrypoint overlap, rather than merely a lease object's unit contract. Assess cross-runtime ownership against the original single-writer requirement before final release.

Planning destination: reconcile these criteria with Phase 46 efficiency work; retain full attribution and long-chain comparative measurements in Phase 47. Do not expand the current release to implement optional recovery/telemetry redesigns. No billed-limit savings have been measured.

## Evidence limits

The private continuation archive contains raw GitHub CI logs, verified native producer transcripts and receipts, and actual operator commands. These observations explain repeated work and missing contracts. They do not establish billed token savings, final-tree live success, release publication, or a human review approval.
