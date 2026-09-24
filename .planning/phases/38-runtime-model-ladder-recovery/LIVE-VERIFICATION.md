# Phase 38 live verification

Date: 2026-09-24

`make test-fast` passed (exit 0) with `CLAUDE_CODE_ENTRYPOINT` deliberately set,
confirming unit tests no longer infer Claude runtime from the parent session.

Live runtime checks passed:

- Claude Code 2.1.281 executor: `claude-opus-5-5/low` was observed in the
  matching assistant transcript; scoped edit and Bash succeeded and a durable
  application receipt was written.
- Claude Code typed GSD planner: `gsd-planner` ran as
  `claude-opus-5-5/medium`; scoped edit and Bash succeeded, while attempts to
  edit or run Bash outside the worktree were blocked.
- Codex CLI 0.155.1: typed `gsd-plan-checker` ran as `gpt-6-sol/high`; delivery
  used `gpt-6-luna/max`. The scoped artifact was committed and the signature
  verified with signer isolation.
- Capability probes passed for Claude, Codex, both role hosts, and runtime
  control-plane smoke.

The live Claude arch-review role smoke was not run: the smoke requires an open
canonical ticket PR, and there were no open PRs at verification time. Its
capability probe passed. No live review result is claimed for that role.
