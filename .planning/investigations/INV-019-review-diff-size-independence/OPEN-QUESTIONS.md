# Open questions

## Closed by research
- [x] How does each of the four review paths (Claude/Codex x integrator/arch-review, v1/v2) get the diff into the model, and what bounds each? → RESEARCH.md "Current system state" 2–3; `research/system-state.md` §3–§5
- [x] What does the host verify about review completeness today? → RESEARCH.md 4; three strengths per runtime x role cell (`research/constraints.md` §2.3)
- [x] Why does v2 reach ~25.7 MB, and does inherited trust help Claude? → RESEARCH.md 6; repository-sized impact reads, Claude forced to `full`; the 25.7 MB figure itself is not reproduced
- [x] Why can the mirror not simply be added to the development-artifact list? → RESEARCH.md 7 (shared classifier drives CI scope and gates); a review-specific pathspec is required
- [x] Why does phase arch-review on the Claude host fail? → RESEARCH.md 8 (`receipt` in roster records vs `rejectAuthorityKeys`), reproduced

## Decisions for the user
- [ ] Which direction: A stop-gap now (mirror pathspec, smaller context, `receipt` fix) and C/D later, or go straight to B, C or D? — owner: user
- [ ] Must a size-independent mechanism add host-verified read coverage, or is the current per-cell strength (declarative for Claude arch-review, delivery proof for the Claude integrator, native read proof for Codex) the floor? — owner: user
- [ ] If C or D: which unit definition (per ticket, byte budget, wave/workstream) and which seam rule? — owner: user
- [ ] Is v2 (inherited trust, impact sources) kept, made lazy for `full`, replaced or retired, and does any option need contract v3? — owner: user
- [ ] If review prompts shrink, what does the `inputTokens > 250000` routing signal mean (prompt size vs work size), and does ADR-014 need a note? — owner: user / ADR-014 owner
- [ ] Should arch-review diffs also exclude `.planning/` outside `.planning/architecture/**` and `DECISIONS.md`, or must "the complete PR diff" stay complete? Excluding `plugins/shipyard/` alone is settled. — owner: user
- [ ] Where is mirror parity proven when the mirror is excluded from review: CI only (skipped for `epic/*` and `ticket/*` bases), a host-side rebuild-and-compare, or a recorded exclusion with count and digest, optionally with a metadata-only mirror inventory in the packet? — owner: user
- [ ] Are the three unrelated defects (`receipt` key, child stderr, graph directory) fixed inside this work or separately? Research: the `receipt` fix is needed by every option; the graph directory is a hard dependency only for C/D; stderr is advisable for B–D. — owner: user

## Needs a measurement (spikes, not run: research is read-only)
- [ ] S1: real input window of `claude-sonnet-5-5`, `claude-opus-5-5` and `gpt-6.1-sol` at the host launch flags, and whether `ceil(bytes/4)` under-counts escaped diff text. — owner: operator with live accounts
- [ ] S2: does `claude --print` auto-compact, and do complete tool_result bodies survive in the stream and the session transcript? Decides whether B's strong proof is possible on Claude. — owner: research
- [ ] S3: can the restricted Claude child read host files outside the worktree and run `git diff` in a linked worktree under `blockReadsOutsideWorkingDirectories`? — owner: research
- [ ] S4: does a Codex review of the 2.6 MB packet through the batch reader complete (base64 inflation, no compaction allowed)? — owner: research
- [ ] S5: sizes of a seam-aware partition of the phase-50 diff by ticket ownership and by byte budget (pure computation over git and `tickets.json`). — owner: research
- [ ] Which model and effort ran the failed phase-50 integrator child (the dispatch record is not in the repository)? — owner: operator
- [ ] What sandbox does a live Codex integrator launch run under (generated variant says `workspace-write`, host reader paths use `read-only`)? — owner: operator
- [ ] Does editing a pinned producer file refuse an already sealed focused arch-review at consumption, and what is the operator procedure for PRs in flight? — owner: implementer
