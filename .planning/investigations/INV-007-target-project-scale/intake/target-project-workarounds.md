---
name: shipyard-deliver-multirepo-workarounds
description: "What breaks when shipyard 0.63 /deliver runs a multi-repo phase from pdffiller with an untracked .planning, and the workarounds that worked (2026-09-25, phase 02 / MYD-17835)."
metadata:
  node_type: memory
  type: reference
  originSessionId: b11246f1-9854-4094-aa8f-997e2b873ca6
  modified: 2026-09-25T18:07:14.270Z
---

Observed running shipyard 0.63.0 `/shipyard:deliver` for phase 02 (ADR-002) across pdffiller + 5 frontend repos:

- **Executor sandbox reads only its worktree** (`claude --restricted`, cwd = worktree). With `.planning/` untracked, the plan is unreachable → every executor returns `no-contract`. The host also requires `planPath` to realpath-equal `<graph>/../../<plan>`. Fix: mirror `.planning/{graph/tickets.json,delivery-state.json,phases/<phase>,architecture,config.json}` into each worktree, add `.planning/` and `.shipyard-*` to each repo's `.git/info/exclude`, and run the host with `SHIPYARD_GRAPH_DIR=<worktree>/.planning/graph`.
- **No docker/php/network inside the executor sandbox**: PHP tickets always come back `blocked` after doing the edit; the orchestrator must run `php -l` / codecept via plain `docker run` (see [[run-unit-suite-without-compose]]) and commit/publish itself. FE worktrees need deps inside the worktree: `cp -cR <main>/node_modules` (APFS clone) works; `yarn install` can 401 on artifactory for some packages.
- **`run-reachability.cjs` spawnSync default 1 MB buffer → ENOBUFS** on pdffiller (27k files) in `epic-branch.sh ensure`; patched locally with `maxBuffer: 64MB` in the plugin cache (lost on plugin update). `sentinel.cjs merge` hits the same on the gh tree read but still merges.
- **Pre-push hook publish-gate** only tries `origin/main|main` as base → refuses in pdffiller (master) / jsfiller (develop). Run `publish-gate.cjs --base origin/<epic>` explicitly, then push (wrapper script).
- **Claude `pr-sentinel` role host can't guard a multi-repo phase** (resolves every PR base in the pdffiller worktree) → use the `sentinel.cjs duty` fallback + per-PR `claude-role-host` arch-review (needs non-draft PR and a clean worktree).
- Host finalizer commits as `(<T>): finalize scoped changes`; FE PR-title commit-lint needs conventional titles — see [[shipyard-decompose-existing-jira-keys]].
