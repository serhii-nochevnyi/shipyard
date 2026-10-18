---
status: accepted
---
# ADR-033 — Review input routing

- **Status:** accepted; authenticated INV-019 Gate 1, accepted by the repository operator on 2026-10-18
- **Date:** 2026-10-18
- **Decision owner:** repository operator; every decision below was selected in the INV-019 dialogue on 2026-10-18
- **Scope:** how the integrator and architecture-review roles receive the change under review on the Claude and Codex hosts, so that a review can run whatever the size of the diff, and what the host proves about coverage
- **Supersedes:** none
- **Related:** ADR-014 (the model ladder, amended by a note on the routing signal), ADR-030
- **UI design:** none

## Context

[INV-019](../investigations/INV-019-review-diff-size-independence/PROBLEM.md) was opened after phase 50 (epic into main, 2026-10-18) merged without either review. Evidence is in `EVIDENCE.md` and the four sealed research lines under `research/`.

- The integrator's whole combined diff is inline in the Claude prompt (`claude-role-host.cjs:459-469,625`); phase 50 produced a 2.65 MB prompt of about 640k estimated tokens and the Claude child refused it (`prompt_too_long`). The diff was 2.04 MB, of which 33% were changed lines (the rest `--unified=50` context) and 31% was the generated mirror `plugins/shipyard/`.
- Four paths, three mechanisms: Claude integrator always inline; Claude arch-review inline, switching to a host file relay above 1 MiB; Codex both inline up to 1 MiB, else host files read through `exec_command`. The host limits are fixed byte and token constants that know nothing about a model window; the repository records no window number for any model.
- A single session that must consume everything is bounded by the model window on both runtimes (Codex rejects compacted sessions; Claude has no compaction detection). Only splitting the review across sessions makes the total input independent of the diff size.
- Completeness proof differs per cell: Codex proves native reads; the Claude integrator proves delivery and echoes a declared coverage inventory; the focused architecture review is declarative.
- Integration-review v2 reads every JS/TS blob of both endpoint trees (repository-sized) against a 16 MiB bound; inherited trust works only for a Codex original.
- Phase arch-review on the Claude host fails before launch because roster records carry `receipt` and `rejectAuthorityKeys` forbids that key in a packet; the Claude role host CLI has no graph-directory option, rewrites a tracked graph file and the next run refuses the dirty tree; the child's stderr is not surfaced.

## Decision

- **R-1 Shape:** a size-routed hybrid with three routes: inline, pull, partitioned. The host chooses the route from the measured size of the work and records it in the contract and the evidence. A route that cannot close its proof escalates to the next route and never accepts a partial review.
- **R-2 Inline route:** small epics keep embedding the diff with a smaller context (fewer than 50 surrounding lines) and the review-specific pathspec of R-6. Everything is embedded, so coverage is proven by construction.
- **R-3 Pull route:** the packet carries a host-built manifest of changed paths (status, blob ids, size, per-file diff hash, recipe) bound into the context digest; the reviewer pulls each file's diff. Its coverage proof is declarative: the host checks that the reviewer's declared coverage inventory equals the manifest and that `complete` implies empty limitations; it does not prove the reading. The upper threshold of this route is configurable so an operator can send more epics to the partitioned route.
- **R-4 Partitioned route:** the host splits the changed paths into disjoint, directory-cohesive review units sized to a per-session token budget; each unit is an ordinary receipt-verified dispatch on the inline path; an aggregator judges the phase from the plans, ADRs, the complete change inventory, per-unit verdict summaries and a seam inventory. The host proves coverage as a set-cover over git data (every changed row belongs to exactly one unit whose packet embeds it and whose result is receipt-verified) plus a ledger authority outside the worktree; a phase verdict is `passed` only when the ledger is complete and every unit is complete and passing. Very large unit counts use a tree reduction.
- **R-5 Contract:** the hybrid is a new contract version v3 that records the route and the ledger digest; v1 and v2 keep working, unknown versions remain a hard refusal. Integration-review v2 stays; its impact reading becomes lazy and must not read repository-sized material to run a full-mode review.
- **R-6 Review diff pathspec:** the generated mirror `plugins/shipyard/` is excluded from every review diff of both roles on both runtimes by a review-specific pathspec applied at every diff site, never by editing `development-artifacts.cjs`; arch-review diffs also exclude `.planning/` except `.planning/architecture/**` and DECISIONS files. The packet carries mirror metadata (changed `plugins/shipyard/` paths with blob ids, no content) and CI keeps proving mirror parity. A test pins that no review diff contains a mirror path.
- **R-7 Routing signal:** the `inputTokens > 250000` signal counts the size of the work (diff plus required material), not the launch prompt, so a route that keeps the prompt small does not lower the model rung; the rule is recorded as a note on ADR-014 and the grid is unchanged.
- **R-8 Defects fixed in this phase:** the `receipt` authority-key refusal (the host-owned key scan stays intact and no key is renamed to pass it); a selectable graph directory for the role host that keeps the clean-tree guard; the child's stderr surfaced bounded and sanitized.
- **R-9 Thresholds:** route thresholds and the unit budget are configurable and default to conservative values until measured; the first delivery tickets calibrate them.
- **R-10 Verification obligations carried into delivery:** measure the real input window of `claude-sonnet-5-5`, `claude-opus-5-5` and `gpt-6.1-sol` at the host launch flags and whether `ceil(bytes/4)` under-counts escaped diff text; whether `claude --print` auto-compacts and whether complete tool_result bodies survive in the stream and transcript; whether the restricted Claude child can read host files outside the worktree and run `git diff` in a linked worktree; whether a Codex review of a 2.6 MB packet through the batch reader completes; seam-aware partition sizes for the phase 50 diff; which model and effort ran the failed phase 50 integrator child; the sandbox a live Codex integrator launch uses; and whether editing a pinned producer file refuses a sealed focused arch-review at consumption, with the operator procedure for PRs in flight.

## Consequences

- A review runs for any epic size, at the cost of three routes on two runtimes, a ledger and aggregator for the partitioned route, and a new contract version that every consumer (`role-artifact.cjs`, `gate-trailer.cjs`, both hosts, installed bundles) must understand.
- Editing the review host files invalidates retained focused verdicts bound to the old producer digests; rollout needs a procedure for in-flight PRs.
- The partitioned route multiplies launches (N units plus an aggregator), receipts and bookkeeping; the graph-directory fix is a hard dependency.
- The guarantee that a review which did not cover everything cannot pass holds mechanically on the inline and partitioned routes and by the reviewer's declaration on the pull route; lowering the pull threshold trades cost for stronger proof.
- Existing tests that pin the inline behaviour change: the 2 MiB diff bound, the 3,000,000-byte prompt bound, the token refusal and the focused relay (`claude-role-host.test.cjs`, `development-artifacts.test.cjs`, about twelve files that reference the review contracts).
- Rollback: each route is additive and selectable; selecting v1 or raising a threshold restores the previous behaviour; no sealed artifact becomes invalid.

## Out of scope

- A larger-window model, a new Fable rung for the Claude integrator and any change to the ADR-014 grid.
- Weakening any verdict, receipt, host-owned authority rule or provider fallback.
- Changing what integrator and arch-review judge (their rubrics).
- Making the pull route host-verified through the Claude transcript (a later change that needs the transcript spike first).
- Moving `plugins/shipyard/` classification in `development-artifacts.cjs` or changing the CI freshness-check rules for `epic/*` and `ticket/*` bases.
- Ownership of overlapping files with phases 51 and 52 (merge order is not agreed here).
