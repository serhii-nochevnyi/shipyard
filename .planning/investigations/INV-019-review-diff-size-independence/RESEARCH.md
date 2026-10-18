# Research synthesis (2026-10-18)

Four sealed research lines (`research/system-state.md`, `alternatives.md`, `constraints.md`, `risks.md`), each launched through `claude-investigation-host.cjs` with an `adr-014.application` receipt verified (`claude-sonnet-5-5` / `xhigh`, policy hash `3978b087…4570`, source revision `1c34583b`). The lines are read-only; no recommendation is made by them. Evidence IDs and exact commands are in each artifact's ledger.

## Current system state

1. **The code is deployed, not absent.** The v2 integration contract, the focused architecture contract and the inline diff embedding landed in `c7633d9e` (#456), contained in `v0.72.0`…`v0.73.0`; the mirror copies are byte-identical (`system-state.md` §2).
2. **Four paths, three mechanisms.**
   - Claude integrator: the whole combined diff is inline in the stdin prompt, always; no file mode exists (`claude-role-host.cjs:459-469,625,864-906`).
   - Claude arch-review: diff inline, switching to a host-owned file relay when the prompt exceeds 1 MiB (`claude-role-host.cjs:1446-1461`).
   - Codex integrator and Codex arch-review: inline up to 1 MiB, else immutable host files read by the model through `exec_command` batch frames (`codex-arch-review-context.cjs:1594-1606`, `codex-delivery-host.cjs:1053-1087`).
3. **The host limits know nothing about the model window.** No context-window number for any model in either grid exists in the repository; the only window-like value is `WINDOW_THRESHOLD_TOKENS = 250000`, a routing signal that selects a rung (`model-policy-internal.cjs:40`). The host admits 750k tokens (`INTEGRATOR_MAX_PACKET_TOKENS`) while the child refused ~640k (`prompt_too_long`). The estimator is `ceil(bytes/4)` of the JSON and may under-count escaped diff text.
4. **Completeness proof differs per cell.** Codex's full-reader transport has a host-verified read proof (native session consumption) and rejects compaction. The Claude integrator proves the complete packet was in the model input and echoes a declared coverage inventory. The focused architecture review (both runtimes) is declarative (`review_completeness`; the reference says it "does not prove reading"). Claude has no compaction detection and no turn/time limit.
5. **Claude roles are not read-only tool-restricted.** They launch with `Bash,Read,Edit,Write,Glob,Grep` in a sandbox that allows writes to the worktree and `blockReadsOutsideWorkingDirectories: true`; read-only is enforced afterwards by `assertEvidenceOnlyChanges`. The host-file relay lives outside the worktree and its reachability by a real Claude child has never been tested (the unit test is mocked).
6. **v2 impact material is repository-sized, not diff-sized.** `buildReviewImpactPacket` reads every `.cjs/.mjs/.js/.ts/.tsx/.jsx` blob at both endpoint trees (449 files / 14.8 MB at HEAD, 325 files / 10.6 MB without the mirror) against `FILE_LIMITS.material` = 16 MiB. Inherited trust works only for a prior Codex original; on Claude it is forced to `full`. The intake figure of 25.7 MB is not reproduced (29.06 MB non-dedup, 14.32 MB distinct); it most likely came from a run with a raised bound.
7. **The mirror enters every review diff.** `productPathspec()` excludes only development artifacts; Claude arch-review and Codex focused arch-review use no pathspec at all, so they also carry `.planning/**`. Reproduced on the epic: 643 KB of 2.04 MB is `plugins/shipyard`. It cannot be excluded by adding it to `PREFIXES` in `development-artifacts.cjs`: that classifier also drives CI product-change scope, scope-gate, PR hygiene, comment-policy parity and the unresolved-review-thread gate, so a mirror-only PR would look "development only" and skip CI product jobs. A separate review-diff pathspec is required.
8. **Phase arch-review on the Claude host fails before launch**, reproduced: `registerPhaseArchiveRoster` stores `receipt` in each roster record (`role-artifact.cjs:2451`), the Claude host copies it into `role_context.phase_archive_selection` (`claude-role-host.cjs:549`), and `rejectAuthorityKeys` forbids that key anywhere in a packet (`context-packet.cjs:34-39,196-205`). The Codex path never runs that scan.
9. **One dispatch = one launch = one receipt = one sealed judgment** (`claude-role-host.cjs:1146-1152,1418-1429,1437-1438`). Any partitioned review is a new sealed contract, not a parameter.

## Constraints that narrow the option space

- A single session that must consume everything is bounded by the window on both runtimes, not by byte constants (Codex rejects compacted sessions; Claude does not detect them).
- Host-owned authority keys cannot appear in a packet; per-chunk coverage records that carry receipts must live host-side.
- The Claude child reads only inside the worktree; the worktree must stay clean (only the evidence file and host scratch change), so the host cannot drop chunk files into it.
- Launch caps hit before any window on tool-heavy Claude reviews: stream ≤ 10,000 records, transcript ≤ 50 MiB; downstream verification ≤ 128 MiB / 20,000 rows; result ≤ 128 KiB; judgment envelope ≤ 8,192 B.
- Editing any of the 11 pinned producer files invalidates retained focused verdicts bound to the old installed digests; rollout needs a plan for in-flight PRs. The runtime-file digest pin covers only `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`.
- Existing tests pin the inline behaviour (2 MiB bound, 3,000,000-byte prompt bound, token refusal, focused relay): `claude-role-host.test.cjs:1004-1100,1406-1470`, `development-artifacts.test.cjs:11-30` and about 12 files that reference the review contracts.

## Corrections to the intake evidence

- The CLI of `claude-role-host` has no graph-dir flag, but the library API takes `options.graphDir` (`deliver.md` calls the library).
- Claude arch-review uses no pathspec; only the integrator uses `productPathspec()`.
- The Codex integrator generated variant is `workspace-write`, while host reader paths hard-code `read-only` (open).
- The 25.7 MB figure is not reproduced (see above).

## What the research did not establish (needs measurement)

The real window of each role/model pair; whether `claude --print` auto-compacts; whether the Claude child can read the relay files and run `git diff` in a linked worktree under the sandbox; whether tool results survive untruncated in the Claude transcript; whether Codex completes on the 2.6 MB packet through the batch reader; the effect of a smaller `--unified` on review quality. Five spikes are specified in `research/alternatives.md` §8 and `research/constraints.md` §8.
