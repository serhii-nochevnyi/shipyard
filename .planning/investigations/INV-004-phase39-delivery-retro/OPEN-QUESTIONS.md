# Open questions

<!-- Format: "- [ ] <question> — owner: <who can answer>" -->
<!-- Gate 1 will not pass while even a single "- [ ]" remains. -->
<!-- Closing: "- [x] <question> → <answer or link to DECISIONS>" -->
<!-- Or move it into RISKS.md with a mitigation if there will be no answer. -->

## Answered by research / orchestrator checks

- [x] What are the PR states of phase 39? → T-39-04 merged into the epic; T-39-05/06/07/09/10/11 open; epic → main #215 open; nothing on `main` (RESEARCH "Current system state").
- [x] Is the installed Claude cache still patched? → yes, three files (`claude-runtime-host.cjs`, `claude-dispatch-adapter.cjs`, `claude-role-host.cjs`) equal the T-39-12 tip (RESEARCH).
- [x] Where did `…-to-eve` come from? → model-typed `gh pr create --head`; no commit ever contained it; `tickets.json` and the ref agree on `…-to-ev` (RESEARCH item 6).
- [x] Does `$CODEX_HOME/shipyard/manifest.json` exist after install (C8)? → no; `~/.codex/shipyard` has no manifest, the installer writes `~/.codex/agents/.shipyard-manifest.json` (RESEARCH item 12).
- [x] Are the Codex fixtures captures? → they carry a CLI version and arrived with #192; treated as prior art, re-captured by the harness.
- [x] Does the Claude runtime expose a launch id before completion (item 1)? → not needed: the host knows it launched and writes the in-flight record itself (RISKS R5).
- [x] Who owns the `signals.type` mapping, and does it touch the ADR-014 grid? → the graph → dispatch boundary maps it; the enum and grid are unchanged (constraints C-T2, RISKS R7).
- [x] Does the Codex sandbox support path-scoped writes (C4)? → unverified; moved to RISKS R10 with the host-materialize fallback.
- [x] Can Codex show the actual `spawn_agent` message (C5)? → unverified; moved to RISKS R12 with the file-reference design.
- [x] Must unit fixtures be hermetic against global git signing and fixed `/tmp`? → yes, a constraint (RESEARCH Technical).
- [x] Does "first round" allow a CI infrastructure rerun? → yes, one rerun (RISKS R8).

## Decisions for the user

- [x] Overall strategy → B+C (DECISIONS "Build the seams first…")
- [x] Item 13 PR hygiene → full hygiene (DECISIONS "Target-project PRs…")
- [x] Item 9 dogfood → supported mode with provenance (DECISIONS)
- [x] Remaining forks → alternative 1 (DECISIONS "Point-fix forks…")
