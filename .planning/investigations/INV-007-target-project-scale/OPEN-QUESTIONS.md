# Open questions

<!-- Format: "- [ ] <question> — owner: <who can answer>" -->
<!-- Gate 1 will not pass while even a single "- [ ]" remains. -->
<!-- Closing: "- [x] <question> → <answer or link to DECISIONS>" -->

## Closed by research and orchestrator checks (2026-09-25)

- [x] Is the code on this branch the code pdffiller ran? → yes, runtime files equal v0.63.0 (research/system-state.md §0).
- [x] Does T-41-08 change `publish-gate.cjs` base resolution? → no; PR #236 touches `state-sync.cjs`, the pre-push hook and their tests only.
- [x] Does the phase-40 amendment touch phase-43 files? → yes: `claude-role-host.cjs` (T-40-16 per-repo preflight), `pipeline-config.cjs` (T-40-17 `pr_title_format`), both delivery hosts and the three workflows (T-40-28). Phase 43 orders after those tickets (RESEARCH Delivery).
- [x] Do the target repositories require reviews on the epic branch (F9)? → no: `gh api repos/pdffiller/<repo>/rules/branches/epic%2F02-power-experiment-cleanup` returns `[]` for all six repositories; front-user-management, front-signature-flow and docs-platform require one approval on `main`, without stale dismissal.
- [x] How did T-02-02/04/05 merge after being checkpoints? → `delivery.preauthorized: true` was written into their plans at 19:15:27 after the user's request; `sentinel merge` then merged T-02-02 (19:17:57).
- [x] Why does the role host require a clean tree (F5)? → introduced in `57b97a79` with no stated rationale; the judge binds to `HEAD^{tree}` (`claude-role-host.cjs:140`), so untracked content is outside what it certifies.
- [x] What is the Claude tool cap for one foreground wait (F12)? → 600 000 ms per Bash call (harness tool contract); the Codex cap is unknown (RESEARCH Unknowns).
- [x] Is `pipeline.gsd_sync` dropped silently (F16)? → it is dropped with a warning (`pipeline-config.cjs:927-933`) that the state-sync output buries; the operator did not see it.
- [x] Does T-41-07 edit `claude-role-host.cjs`? → no; its files are the integrator preflight, `deliver.md` and a contract test.
- [x] Where do per-repository settings live when `.planning/` is untracked? → in the project's `.planning/config.json` keyed by `owner/repo`, as D-45 does for `pr_title_format` (read through `loadConfig`, `delivery_pipeline.*` wins).

## Decisions for the user

- [x] F7: which verification model, and is the receipt-gated merge required? → host-side verification; receipt-gated merge (DECISIONS)
- [x] F7: how are PRs opened before the receipt gate treated? → today's rule, marked legacy in the journal (DECISIONS)
- [x] F6: which carry rule? → own-diff identity (DECISIONS)
- [x] F17: what does `human_checkpoint` gate under `auto_merge: epic`? → split `review` / `merge` (DECISIONS)
- [x] F13: how are repository-required annotations and ADR-required comment edits handled? → repository-declared markers; edits of existing comments are not additions (DECISIONS)
- [x] F15: how are pre-existing Jira issues bound? → by key, proposed by decompose, approved at Gate 2 (DECISIONS)
- [x] F18: may the conveyor dispatch declared repository remedy workflows? → only operator-declared ones (DECISIONS)
- [x] F5: exempt the conveyor's scratch set, or ignore untracked files? → one shared scratch set (DECISIONS)
- [x] F9 / F12 / F16 point-fix shapes → ignore a declared bot's stale approval where not required; rerun cancelled checks and cap one ci-wait call at 540 s on Claude; honour `pipeline.gsd_sync` as a deprecated alias (DECISIONS)
- [x] Phase shape and rerun → one wave after phase 40 is released; the rerun is outside the phase, run by the operator (DECISIONS)
