# The conveyor's own repo has no CI, so it cannot dogfood drive-to-green

**RESOLVED — released in v0.40.0.** Closed by commit `6ae1414`
(`ci: run make test-fast on every PR and push to main`) rather than by a numbered
ticket: it was taken directly after phase 20 landed, which is exactly what
"Why it was NOT done during phase 20" below asks for. Re-verified against the
shipped tree by T-23-02 on 2026-08-26, not read off a summary:
`.github/workflows/test.yml` exists, runs `make test-fast` on `pull_request` and
on pushes to `main`, and pins `node-version: '24.15.0'` to `Dockerfile.base`'s
`NODE_VERSION` ARG as this entry asked. `git tag --contains 6ae1414` reports
v0.40.0 as the first release carrying it.

Nothing below is outstanding. The body is kept because it records WHY the
workflow has the scope it has — one fast job, with the Docker- and
network-dependent targets deliberately left out — and deleting the reasoning
would lose the record of that decision while keeping only its result.

**Found:** 2026-08-25, opening the first ticket PRs of phase 20 on this repo.
**Scope:** none of phase 20's tickets. Deliberately NOT done during the phase.

## What happened

`.github/workflows/` does not exist. Every PR opened here reports
`no checks reported`, and `state-sync` flags each one:

    ⚠ T-20-01 PR #1: no CI checks reported — "green" here means "nothing to run"

The warning is correct and it fired exactly as designed — the conveyor did not
pass off an absence of checks as a green. That part works.

## Why it matters more than a missing nicety

Phase 20 builds the autonomy of the drive-to-green loop. Three of its six
tickets exist to react to a red CI:

- T-20-01 — sign a CI failure so repetition is distinguishable from progress
- T-20-02 — route the repair ladder off that signature instead of an attempt count
- T-20-05 — hand the prior attempts to the fixer as input

In a repository with no CI there is no red to react to and no green to drive
toward. The code can be written and unit-tested — it was — but the loop it
implements cannot be exercised end to end here. The only proving ground for
that remains `pdffiller-ai-assistant`, where CI exists.

It also costs the conveyor its cheapest safety net on its own changes. The
substitute used during phase 20 was to instruct the sentinel to run
`make test-fast` in each ticket worktree as the evidence for a `conform`
verdict — a human-authored instruction standing in for a mechanical gate, which
is the arrangement this repo's own CLAUDE.md repeatedly names as the one that
fails ("prose rules get skipped, mechanical gates hold").

## Shape of the fix

A single workflow running the existing fast suite:

    .github/workflows/test.yml
      on: pull_request, push (main)
      steps: checkout → setup-node (pinned to the Dockerfile's NODE_VERSION)
             → make test-fast

`make test-fast` is the right target: seconds, no Docker, no network, and it
already covers the deterministic layer where this repo's sharp bugs live (unit,
graph, worktree, worktree-gates, docs, ssh-sync). The Docker-dependent targets
(`test-base`, `test-overlay`, `test-runtime`, `test-mcp-runtime`) and the
network-dependent one (`test-codex-shipyard`) do not belong in the same job and
should be a separate, optional workflow if they are ever added.

Pin the Node version to the `NODE_VERSION` ARG in `Dockerfile.base` rather than
`latest`, per this repo's convention that no version is unpinned.

## Why it was NOT done during phase 20

Adding it mid-phase would have moved `main` ahead of the epic while five ticket
PRs were being driven to green, giving every one of them a base move at exactly
the moment their evidence was being gathered — i.e. manufacturing the stale-base
scenario that T-20-01 is only just learning to detect. Do it after the phase
lands, as its own ticket, on a quiet tree.
