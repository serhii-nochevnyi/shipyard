# ADR-004 — Positive evidence before a mutation

- **Status**: accepted
- **Date**: 2026-09-07
- **Supersedes**: nothing. Extends ADR-002's rule (one fact, one owner) to the
  mutations the conveyor performs: merge, resolve, remove, mark ready.

## Context

An external autonomy-and-quality audit (2026-09-07, snapshot `501864f`)
reported 28 findings against the v0.45.0 conveyor, 11 of them P1. Eleven map
onto phase 24's tickets and were folded in (F06 → T-24-05, F25's fix-round half
→ T-24-06, F28 → T-24-11). The rest share one shape: **a mutation proceeds on
the ABSENCE of a signal where it needs the PRESENCE of one.** Each was re-read
against the code before being planned; the line anchors below are ours.

- **F01** `validate-graph.cjs globPrefix` (~line 313) cuts a pattern at its
  first wildcard and treats the stump as a directory prefix; `scope-gate.cjs`
  (~83) and `base-merge.cjs` (~73) do the same. `src/foo*.ts` owns `src/foo`
  and not `src/fooBar.ts`; `src/*.ts` owns everything under `src/`. Gate 2
  accepts two unordered tickets that collide, the scope gate rejects a
  legitimate edit, and base-merge REPLACES a ticket's own change with the
  base's edition, commits, and exits 0 — the one mechanical conflict resolver
  the conveyor has, deciding from a wrong owner.
- **F03** `pipeline-config.cjs loadConfig` (~154) turns an unparseable config
  into DEFAULTS with a warning; `sentinel.cjs` drops the warning and merges
  under `auto_merge: epic` even when the corrupt file said `off`.
- **F07** `state-sync.cjs` (~311–319): a failed epic comparison becomes
  `ahead = 0` → `landed: true` → cross-phase children become `ready` on a base
  that lacks their parent.
- **F27** the availability and `unreachable_paths` blockers live only in the
  epic-stacked branch of readiness (~368); direct-to-main tickets skip them.
- **F08** `ticket-worktree.sh gc` (~244–252) classifies "in the graph, clean,
  `origin/<branch>` gone" as `landed` — which is also exactly the state of a
  ticket an executor has committed and not yet pushed; `--prune` removes it.
- **F12** `lock.cjs` (~98–120): takeover is by age alone and `release()` breaks
  the directory unconditionally, so a stale holder can remove its successor's
  lock and a third writer enters. **F13** `state-sync.cjs` reads the previous
  snapshot before it takes the write lock, so a slower sync can overwrite a
  newer one with valid, coherent, stale JSON.
- **F21** `scripts/merge-codex-config.cjs` recognises only a bare `[agents]`
  line; `[agents] # comment` gets a second `[agents]` table appended and the
  file is no longer valid TOML — Codex stops starting.
- **F22** `gsd-tune.cjs --apply` (~217, ~315) SETS `agent_skills.gsd-*` to a
  one-element array, deleting whatever a project had there; a fresh machine
  with no `~/.gsd/` directory crashes on the write (~321).
- **F24** `decompose.md` (~346) keys Jira idempotency on
  `shipyard-<ticket-id>` + project; ticket ids restart per repository, so two
  repos exporting `T-01-01` to one project update each other's issue.
- **F25** `workflows/executors.mjs` (~65) and `drift-gate.mjs` turn an
  unparseable `args` string into `{}` and return `[]` as success.
- **F26** `front.cjs` (~357) calls a ticket `left_behind` because its phase
  NUMBER is lower than the newest merged phase — this repository delivered 22
  before 21 on purpose; the stop gate and the waiter read the same flag.
- **F02 (remainder)** after T-24-02: `state-sync.cjs ghChecks` (~109–122) maps
  a failed `gh` call, malformed JSON and a genuinely empty list all to
  `none_reported`; T-24-05 routes `none_reported` to a human, but an OUTAGE is
  not "this PR has no CI" — it is "we could not look".

Seven design observations in the audit (control flow spread over prompts;
several authorization boundaries without a run contract; no bounded plan
amendment path; verification speed vs. displaced coverage; installer
isolation; cross-runtime parity in CI; "tried" ≠ "disproven") are recorded
here as the next programme's candidates and are NOT tickets in this phase.

## Decision

- **D1 — One ownership matcher, exact by construction.** A single module
  answers "does this declaration own this path" for Gate 2 overlap, the scope
  gate and base-merge. Accepted forms: an exact path, a directory (`dir/` or
  `dir/**`), and `*` within one segment. Anything else is rejected at Gate 2.
  Two unordered tickets whose patterns can intersect are an error, not a
  warning. base-merge resolves a conflict mechanically ONLY when the matcher
  answers with certainty; otherwise the conflict is left for an agent.
- **D2 — A corrupt configuration permits no mutation.** `loadConfig` reports
  validity; every mutating caller (merge, duty, escalate, retarget, the
  waiter's escalation) refuses on `valid: false` and says which file. Defaults
  are for an ABSENT file only.
- **D3 — Readiness needs positive evidence.** Integration state is
  `landed | not-landed | unknown`; `unknown` parks the dependents with the
  reason and is retried next sync, never mapped to `landed`. Availability and
  path-reachability are checked before the mode split, in both modes.
- **D4 — gc removes only what is PROVEN landed.** `landed` requires the
  ticket's delivery state to say `merged` (or the PR to be merged live), not
  the absence of a remote branch; a clean local-only branch is `review`,
  reported and kept; the cleanliness check is repeated under the git lock
  right before `--force`.
- **D5 — Locks prove ownership; snapshots carry a generation.** `release()`
  removes the lock only if the owner file still names this holder; takeover is
  atomic (rename), and a broken lock is re-acquired, never assumed.
  `state-sync` re-reads the previous snapshot INSIDE the lock and refuses to
  publish a snapshot whose observations are older than the one on disk.
- **D6 — Installers write files the runtime can parse.** The Codex config
  merge detects headers by TOML grammar (comments, quotes, sub-tables), writes
  atomically, and re-parses before replacing.
- **D7 — Tuning merges, never replaces, another owner's list.** `agent_skills`
  gains the delivery-rules entry and loses only a stale shipyard alias; every
  other entry survives. A missing `~/.gsd/` is created, not crashed on.
- **D8 — External identity is namespaced.** Jira labels carry the repository:
  `shipyard-<owner>-<repo>-T-<phase>-<plan>` and `shipyard-epic-<owner>-<repo>-<phase>`;
  the old label is searched as a fallback and migrated with a note.
- **D9 — Workflow input is validated before any dispatch.** Malformed `args`
  throws with the parse error; an explicitly empty list returns `[]`; every
  dispatched ticket has exactly one result or the run fails.
- **D10 — "Left behind" is evidence, not arithmetic.** A ticket is left behind
  when its OWN phase has landed (epic merged into the base) without it, never
  because a higher-numbered phase landed first.
- **D11 — Unavailable ≠ empty.** `checks.unavailable: true` (with the gh error)
  is a fourth state beside failing/pending/none_reported; the front keeps such
  a ticket in `waiting.ci`, the merge refuses, the waiter retries.

## Consequences

Eleven tickets. Six touch nothing phase 24 or 25 owns and run at once
(matcher, gc, TOML merge, gsd-tune, Jira labels, workflow input). Five touch
`state-sync.cjs`, `front.cjs`, `sentinel.cjs`, `pipeline-config.cjs` or
`lock.cjs`'s callers and wait for phase 24's epic on `main` as one chain.
Every ticket ships the regression the audit asked for, as a unit or smoke
test that fails on the current code.
