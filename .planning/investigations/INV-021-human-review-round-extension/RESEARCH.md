# Research

Sources: four sealed research lines under `research/` (`system-state.md`, `alternatives.md`, `constraints.md`, `risks.md`), all `claude-sonnet-5-5` / `xhigh` with verified `adr-014.application` receipts, source revision `749604b9` (`epic/harness-simplification`, 1.0.0-rc.2). Citations below are `path:line` in that worktree; the line files hold the full evidence indexes. Nothing was executed against production code except read-only cap tests (94/94 pass).

## Current system state

1. **The cap is derived, not stored.** `rounds_used` is the number of countable sealed verdicts (complete, ancestors of the current head, full or chained delta) that survive replay under the running plugin's contract digest. `nextRound` returns `limit` when it reaches `ROUND_CAP = 3` (`code-review-core.cjs:338-340`). Nothing records "this PR used 3".
2. **Four code enforcers of 3, not one:** `nextRound` (`code-review-core.cjs:340`), `normalizeResult` (`:196`, also at replay), `codeReviewResultData` (`role-artifact.cjs:3146`, seal and replay), and the replay-depth bound `lineage.active.size >= ROUND_CAP` (`role-artifact.cjs:3190`). Raising only `nextRound` yields a launch that cannot be sealed. Three further call sites each compute the round: `phase-code-review.cjs:145,154`, `claude-role-host.cjs:596,612-613`, `codex-code-review-context.cjs:141,148-149`.
3. **The reviewer reference is part of the counter.** `contract_digest` includes `references/code-review.md`, which says "Integer 1 through 3" and "No fourth review is owed". A sealed verdict with another digest is skipped (`role-artifact.cjs:3216`; `tests/unit/code-review-foreign-contract.test.cjs`). Any edit to that file resets every in-flight PR's count; the epic already changed it relative to `main` (`0c96442c…` vs `5d121a46…`).
4. **Existing resets without any human record:** rebase or force-push (verdicts not ancestors of the head stop counting, `code-review-core.cjs:304`), a release that changes the reference, verdicts in a worktree git does not list.
5. **Readers of the code-review state:** only `deliver-dispatch.cjs build arch-review --phase` (`:1210-1215`) and `gate-trailer.cjs verify` (`:384-386`) consume the hold. `sentinel.cjs`, `state-sync.cjs`, `front.cjs` read only the architecture verdict. The phase PR is merged by a human; the code-review status is non-required (ADR-032: "visible, not enforced").
6. **The gate trailer carries no code-review field.** The `merge-gate` status description is capped at 140 characters (`gate-trailer.cjs:166,192-201`) with 8-12 characters free; `round 4 of 3, extended by <op> at <time>: <reason>` cannot fit. Real visible surfaces: the `code-review` commit status (fixed text) and the `<!-- code-review -->` comment.
7. **No "human-only" primitive exists.** `planning-untrack.cjs --confirm` compares argv to a public constant (`:10,73`). `isTTY` appears once, in an unrelated repo picker (`repo-resolve.cjs:1736`). The existing exit, `delivery_pipeline.code_review: report`, is an unsigned key in `.planning/config.json` (`pipeline-config.cjs:536,1100`), **project-wide, not per PR**, with no writer command: the operator (or the model's Edit tool) edits JSON.
8. **Key custody is a same-user 0600 file** (`role-artifact.cjs:921-1042`, no owner check). Sandboxing (`claude-runtime-host.cjs:750-792`, `codex-runtime-host.cjs:1079-1110`) applies to launched role children only. The orchestrating session that runs every `phase-code-review.cjs` verb is a model running as the same user and is not isolated by Shipyard code; whether it is confined is user configuration (unknown).
9. **Incident evidence, read by the orchestrator (the research workers were sandboxed out):** in `pdffiller-mcp` the untracked `.shipyard-code-review-evidence.md` records "round 3, delta scope" whose entire delta (`2e6b34a…a64a34b`) is a **one-line documentation change** (`docs/adr/0032-…md`, +1/-1); the project's `.planning/config.json` already has `"code_review": "report"`. So the third round was spent on a one-line doc delta, and the operator has presumably already used the `report` exit. The branch `research/mcp-tools-ai-pdf-12908` itself is not present in that repository's local branch list, and the verdict records under `~/.local/state/shipyard/` were not read; which build sealed the verdicts is unknown.

## Constraints

### Technical
- A fourth or fifth round needs an absolute ceiling at seal and replay (`role-artifact.cjs:3146,3190`) separate from the per-PR limit, or round 4 is admitted but never "current" (failure swallowed into `answer_authenticated: false`, `role-artifact.cjs:3244-3250,3398`). By reading, bound `>= 3` admits round 4 and fails round 5 (not executed; spike S1).
- Round arithmetic is history-derived, so a grant cannot be "consumed" by a flag. With "limit = 3 + valid records" and "a moved head voids the record", the sequence round 4 under E1 → push → E2 on the new head grants nothing (used 4, limit 4). Consumption has to be recorded, or the formula changed (risks F6).
- Editing `references/code-review.md` is itself a retroactive reset of all in-flight PRs.
- Both runtimes need one shared lookup; the Codex package under `plugins/shipyard/host/` is regenerated, never edited (`make package-shipyard-codex`).
- Nine unit files pin the cap and message text (`code-review-core`, `phase-code-review`, `role-artifact`, `claude-role-host`, `codex-code-review-context`, `code-review-foreign-contract` among them).

### Product
- Hold is advisory (ADR-032): "human-only" constrains the conveyor model's behaviour, not the human, who can still merge.
- A finding in an extended round goes to the human; `repairAllowed` stays 1-2 only (operator scope).
- Rollback is not clean: a sealed round-4 verdict read by older code may make `status` throw instead of reporting `limit` (`priorCodeReviewVerdicts` has no guard, `phase-code-review.cjs:145`; spike S4).

### Delivery
- ADR-032 must be amended if an extension or an approval fallback is chosen: "no waiver store" and the withdrawn "human APPROVED fallback" are both on its Out of scope list.
- Simplification direction: B and D add code and delete none; C and A add the least.
- The tag `v1.0.0-rc.2` already exists at the base; whether the design must also reach `main` is undecided.

## Unknowns
Each has a mirror checkbox in OPEN-QUESTIONS.md.
- Whether the orchestrating session can read the key or write the config on the operator's machine (U-04).
- Whether a pseudo-terminal defeats a TTY challenge (spike S3, not run).
- Replay behaviour at round 4/5 and under old code (spikes S1, S4).
- Who authors the epic PR and whether a second human account exists (U-14).
- Which build sealed the incident verdicts, and whether rc.2 already shows `rounds_used: 0` for them (U-03).
