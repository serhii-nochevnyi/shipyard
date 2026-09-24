# Open questions

<!-- Format: "- [ ] <question> — owner: <who can answer>" -->
<!-- Gate 1 will not pass while even a single "- [ ]" remains. -->
<!-- Closing: "- [x] <question> → <answer or link to DECISIONS>" -->
<!-- Or move it into RISKS.md with a mitigation if there will be no answer. -->

## Decisions for the user

- [x] Overall strategy → hybrid by failure class (DECISIONS.md)
- [x] Item 2 bridge placement → decompose Step 0 (DECISIONS.md)
- [x] Item 3 → deliver-armed per-session marker (DECISIONS.md)
- [x] Item 6 → deterministic plan executed through MCP (DECISIONS.md)
- [x] Item 7 → prose rule plus validator hint (DECISIONS.md)
- [x] Item 9 → explicit ADR marker drives --skip-ui (DECISIONS.md)

## Closed by research

- [x] Does the Codex auto-route block route to investigate? → No; `largeRoute` names only decompose/deliver (`scripts/install-shipyard-codex.sh:592-594`). Parity is part of item 4.
- [x] Does `make doctor` compare the installed route hook? → No (`scripts/shipyard-doctor.cjs`, grep `route` → none); see RISKS R2.
- [x] Would a stricter Gate 1 retro-fail existing ADRs? → No; every `ADR-0NN-*.md` decision record passes `adr-ingest.cjs`; only companion documents fail (RESEARCH §5).
- [x] Does GSD support skipping the UI gate per phase? → Yes, `/gsd-plan-phase <N> --skip-ui` (`~/.claude/gsd-core/workflows/plan-phase.md:119,519`).
- [x] Do external consumers parse host stderr? → No; only command prose, `run-rollout.cjs` path references and tests reference the hosts (grep over `plugins scripts tests`).
- [x] Is untracked `.planning/` supported? → Yes, the proving ground uses it (`P/scripts/drift-needed.cjs:299`); item 8 is warn-only.

## Closed by documentation

- [x] Hook payload and session_id → docs (code.claude.com/docs/en/hooks.md, sessions.md): session_id preserved by --resume/--continue, new on --fork-session, compaction undocumented; docs claim UserPromptSubmit skips task-notification turns and names the field `prompt_text`, but this session observed the hook firing on a task-notification turn. Moved to RISKS R14.
