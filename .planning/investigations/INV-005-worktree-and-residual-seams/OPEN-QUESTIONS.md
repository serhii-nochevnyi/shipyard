# Open questions

<!-- Format: "- [ ] <question> — owner: <who can answer>" -->

- [x] Where do the fixes land (release circularity)? → phase 40; phase 39 merged by the parallel session (DECISIONS.md)
- [x] Carry across sibling merges? → mechanical tree-level proof (DECISIONS.md)
- [x] Worktree conditions shape? → one module plus prepared worktrees (DECISIONS.md)
- [x] STALE_ARTIFACT recovery? → historical executor mode at the recorded base (DECISIONS.md)
- [x] Integrator scope? → code diff plus .planning digest summary (DECISIONS.md)
- [x] Draft and arch-review order? → role host accepts drafts for arch-review (DECISIONS.md)
- [x] Sentinel round and new PRs? → excluded, next round (DECISIONS.md)
- [x] gsd-sync on planning PRs? → pending observation written by the planning flow (DECISIONS.md)
- [x] T-40-22 provenance sidecar vs mutation check (R4)? → host-owned set covers it; new ticket depends on T-40-22 (DECISIONS.md scope fences)
- [x] Does `--restricted` deny reads outside cwd? → measured in phase 39 (T-39-03 executor refused a plan outside its worktree); the conditions module checks plan and graph are inside the worktree (moved from RISKS)
- [x] Is tracked `.shipyard-role-artifacts/` intentional? → yes for phase-level evidence (commit 22397b76); the registry distinguishes tracked evidence from untracked scratch
