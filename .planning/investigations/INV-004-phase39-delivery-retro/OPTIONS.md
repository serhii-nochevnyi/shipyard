# Options

Full option analysis and per-item forks: `research/alternatives.md`. This file
keeps the overall strategies and the item-level forks that need a human choice.

## Option A — Point fixes, one ticket per finding

About 16–20 small tickets, each a local fix plus a unit test of the defect as
seen; boundary fixtures captured by hand once. Most parallel, cheapest per
ticket. Item 0 recurs (no guard forces re-capture), the next wave may again
hand-build requests, and the success criterion "phase 40 wave dispatched
through the new entry point" is not met.

## Option B — Seams first, then point fixes

1. Captured-boundary harness: a manual `make capture-fixtures` records the
   real producers (`claude --print … --json-schema` on haiku, `createRunScope`,
   dispatch-adapter capture, Codex parent/child), scrubs home paths and ids,
   writes `tests/fixtures/captured/<producer>@<cli-version>.jsonl`; a
   source-contract check fails when a registered boundary's consumer test
   uses an inline object instead of a captured fixture.
2. One deterministic front → dispatch entry point (Claude and Codex): builds
   the host request from the graph (branch, worktree `planPath`, mapped
   signals), writes a host-issued in-flight record before launch, launches
   detached, and exposes `status` / `wait` for a `dispatch` wait kind.
3. Sentinel preflight: fetch and fast-forward the base ref, state-sync and
   commit, or refuse naming the exact command.
4. Remaining point fixes as in A.
About 12–16 tickets, 3 medium-large, more cross-phase dependencies.

## Option C — Live release gate

`make test-live` drives one real executor round per runtime (cheapest model)
through the installed-layout hosts on an in-repo fixture project with a
two-ticket graph: research → decompose → executor → sentinel. The release
script refuses without a fresh passing live receipt. Catches integration
defects at release, needs local credentials, can flake.

## Option D — Do nothing beyond phase 39

Ship T-39-01..12, raise backlog severity, document workarounds. Fails every
success criterion; baseline only.

## Comparison

| | A — point fixes | B — seams + captured harness | C — live release gate | D — nothing |
|---|---|---|---|---|
| Item 0 (invented fixtures) | once, by hand, no guard | structural (registry + contract check) | detected at release | no |
| Items 1/2/3/6/8 | five separate fixes | one entry-point cluster | as A | no |
| Item 4 sentinel | refuse with remedy | preflight establishes preconditions | caught live | workaround |
| Codex C1–C8 | point fixes | point fixes + captured Codex fixtures | proven live on fixture project | no |
| Meets "phase 40 via entry point" | no | yes | only with B.2 | no |
| Meets "Codex run completes research + decompose" | unproven | against captured fixtures | yes, live | no |
| Complexity | ~16–20 small | ~12–16, 3 medium-large | A or B + 3 | 0–1 |
| Risks | item 0 and item 2 recur | second-boundary creep, fixture staleness | late detection, credentials, flakes | measured losses repeat |
| What it forecloses | nothing | hand-built dispatch requests | releasing without an end-to-end round | nothing |

Realistic choices: A, B, B+C, A+C.

## Item 13 — PR hygiene forks

| Fork | Alternative 1 | Alternative 2 |
|---|---|---|
| Ticket ↔ PR matching key | Exact head branch (already primary, `ticket-pr-match.cjs:52-56`) plus the PR number recorded in delivery state; drop title/body markers | Hidden HTML comment marker `<!-- shipyard:ticket T-NN-NN -->` in the body |
| Branch names | Neutral `<type>/<slug>` (Jira key when present) stored in the graph | Keep `ticket/T-…` |
| `.planning/` in epic → main | Target projects keep `.planning/` untracked (ignored), state lives only in the project checkout | Epic integration PR is built from a filtered branch without `.planning/` commits (like `gsd-pr-branch`) |
| Enforcement | A publish-time PR hygiene gate (title, body, branch, diff paths) with a test, active for target projects | Prose rule only |

## Other item-level forks

| Item | Alternative 1 | Alternative 2 |
|---|---|---|
| 1 in-flight | host-issued in-flight record with TTL written at launch; durable mark stays after receipt | stop gate reads live host pid/receipt dir |
| 5 digest pin | `make refresh-runtime-digests` + required commit trailer checked by CI | keep pin, message names the refresh command only |
| 7 research refusal | keep valid lines sealed, name the failed line and cause, re-dispatch only that line; fan-out stays failed until all four exist | all-or-nothing with precise message |
| 9 dogfood | separate install root from a worktree, receipts stamped with host source sha + dirty flag, doctor flags a cache matching no release | forbid cache patching only (doctor detection) |
| 10 state YAML | header-free deterministic YAML (or comment-policy exemption for generated graph files) | stop committing the YAML |
| 11 pre-push | resolve the worktree with `git rev-parse --show-toplevel` in the hook's execution cwd / real `git pre-push` hook | more robust command-text parsing |
| C3/C6 consumers | one shared sealer module used by Claude and Codex research and decompose hosts | Codex-specific consumers |
| C5 relay | host writes the task to a file and passes path + digest; child session evidence must echo the digest | digest in message only |
