# Phase 40: Build delivery seams and clean target-project PRs - Research

**Researched:** 2026-09-24
**Domain:** Shipyard host-side delivery conveyor (Node 24 CommonJS scripts, bash 3.2 installers, Claude/Codex runtime hosts, GitHub PR publication)
**Confidence:** HIGH for file and symbol mapping (read at HEAD `96d2087b`); MEDIUM for the phase-39 branch state (remote refs could not be refreshed, see Environment); LOW where marked `[ASSUMED]`
**Mode:** `--tdd`, granularity `standard`

<user_constraints>
## User Constraints

No `40-CONTEXT.md` exists (the phase directory was empty before this file). The binding constraints come from the accepted ADR-017 and the INV-004 decisions. They are copied verbatim from `.planning/architecture/ADR-017-delivery-seams-and-pr-hygiene.md` (identical to `.planning/.adr-ingest/ADR-017-delivery-seams-and-pr-hygiene.ingest.md`).

### Locked Decisions (ADR-017 "Decision", verbatim)

DATA_k3Vx9TqL_START
- Strategy: build the seams first and gate releases on a live round; point fixes land on top of the seams.
- Boundary fixtures for registered producer ↔ consumer boundaries are captured from real producers by a manual scrubbed `make` target that records the CLI version, and a contract test refuses inline shapes for those boundaries.
- One deterministic front → dispatch entry point for Claude and Codex builds host requests from the graph (branch from the graph, plan path from the ticket worktree, ticket `type` mapped and never forwarded as `signals.type`), launches detached, and offers `status` and `wait` through a `dispatch` wait kind.
- The host writes an in-flight record with pid and TTL at launch that the stop gate honours and that fails closed on process exit or expiry; the durable dispatch mark still follows the verified receipt.
- A sentinel preflight fetches and fast-forwards the base ref, runs and commits state-sync, or refuses naming the exact command; a failed fetch is a refusal, never swallowed.
- `make test-live` runs one real research → decompose → executor → sentinel round per runtime on an in-repo fixture project with the cheapest allowed model, and the release script refuses without a fresh passing live receipt.
- Target-project PRs carry no conveyor or GSD internals: branches `<type>/<slug>` or `<type>/<JIRA-KEY>-<slug>` stored in the graph, conventional-commit titles, bodies without ticket, phase, ADR or plan identifiers, `.planning/` untracked in target projects, and a publish-time PR hygiene gate over title, body, branch and diff paths; the Shipyard repository is exempt.
- Ticket ↔ PR matching uses the exact head branch plus the PR number recorded in delivery state at creation; the title and `ticket/<ID>-` fallback stays only for legacy PRs.
- A supported dogfood mode runs hosts from a worktree through a separate install root, stamps receipts with host source sha and dirty flag, is refused for merges into a target default branch, and doctor reports an installed cache that matches no release.
- The runtime-file digest pin is refreshed only by a make target and a commit trailer that CI verifies.
- Research keeps valid lines sealed, names the failed line and its real cause, and re-dispatches only that line; the fan-out stays failed until all four lines are sealed.
- One shared sealer produces `shipyard.research-result.v1` and `shipyard.decomposition-result.v1` with an artifact index for Claude and Codex research and decompose hosts.
- The Codex GSD researcher writes only its contained artifact path, and Codex child tasks are passed by file path plus digest that the host verifies.
- Point fixes: the state YAML is header-free and deterministic; the pre-push hook resolves the worktree through git instead of command text; the Codex config refusal names the config fix; `gsd-tune --runtime codex` writes no Claude-only keys; investigate and decompose prose explain the out-of-repo host state directory; doctor reads the Codex agents manifest.
- Unit fixtures that create git repositories are hermetic against global commit signing and fixed `/tmp` paths.
DATA_k3Vx9TqL_END

Scope fences from INV-004 `DECISIONS.md` that bind the planner (verbatim excerpts):

DATA_p7Rm2WbZ_START
**Scope fence:** No change to the ADR-014 grid, resolver input, receipt shape or fail-closed verification; the entry point calls the existing hosts and boundary, it is not a second boundary.
**Scope fence:** The in-flight record is host-issued at launch with pid and TTL and fails closed on expiry; the durable dispatch mark still follows the verified receipt; ticket `type` is mapped, never forwarded as `signals.type`; branch and plan path come from the graph and the ticket worktree.
**Scope fence:** Branches `<type>/<slug>` or `<type>/<JIRA-KEY>-<slug>`, stored in the graph; conventional-commit titles; bodies without ticket, phase, ADR, plan or conveyor terms; matching by exact head branch plus the PR number recorded in delivery state, with the title/prefix fallback kept only for legacy PRs; `.planning/` untracked in target projects; a publish-time PR hygiene gate checks title, body, branch and diff paths. The Shipyard repository's own PRs are exempt.
DATA_p7Rm2WbZ_END

### Claude's Discretion

Not declared (no CONTEXT.md). Areas this research treats as planner discretion, with a recommendation each: script and file names for the new seams, the exemption predicate for the Shipyard repository, the live-receipt storage path, the release script shape, the ticket slicing and ordering.

### Deferred Ideas (OUT OF SCOPE) — ADR-017 "Out of scope", verbatim

DATA_d4Ns8HcY_START
- The ADR-014 model/effort grid, the resolver input schema, the receipt shape and fail-closed receipt verification.
- Work already planned as T-39-01..T-39-12.
- The Codex plan-checker lease flake backlog entry.
- Exporting this phase's tickets to Jira.
- Applying PR hygiene to the Shipyard repository's own PRs.
DATA_d4Ns8HcY_END
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md) | Research support in this document |
|----|-------------------------------|-----------------------------------|
| REQ-136 | Seams (captured fixtures, dispatch entry point, sentinel preflight) before point fixes; every release gated on a live round | "Recommended slicing and waves"; REQ-141 release gate; no dedicated file set |
| REQ-137 | Captured boundary fixtures by a manual scrubbed make target recording the CLI version; contract test refuses inline shapes | Requirement map §REQ-137; slices S9/S10 |
| REQ-138 | One deterministic front-to-dispatch entry point (Claude and Codex); branch from graph; plan path from ticket worktree; ticket type never forwarded as `signals.type`; detached launch; `status`/`wait` via a `dispatch` wait kind | §REQ-138; slices S14/S15; Pitfalls 1, 2 |
| REQ-139 | Host-issued in-flight record (pid, TTL) at launch honoured by the stop gate, fail-closed on exit/expiry; durable mark after receipt | §REQ-139; slice S14; Code example 2 |
| REQ-140 | Sentinel preflight: fetch + fast-forward base ref, run + commit state-sync, or refuse naming the exact command; failed fetch refuses | §REQ-140; slice S16; Pitfall 5 |
| REQ-141 | `make test-live` real round per runtime on an in-repo fixture project, cheapest model; release script refuses without a fresh passing live receipt | §REQ-141; slice S20; Open question 5 |
| REQ-142 | Target-project PRs without conveyor/GSD internals; neutral branches in graph; conventional titles; clean bodies; untracked `.planning/`; publish-time hygiene gate; Shipyard exempt | §REQ-142; slices S18a/S18b/S18c; Pitfalls 6-9 |
| REQ-143 | Matching by exact head branch plus PR number recorded at creation; title/prefix fallback only for legacy PRs | §REQ-143; slice S17 |
| REQ-144 | Dogfood mode: separate install root, receipts stamped with source sha + dirty flag, refused for merges into a target default branch, doctor flags a cache matching no release | §REQ-144; slice S19; Pitfall 10 |
| REQ-145 | Digest pin refreshed only by a make target plus a CI-verified commit trailer | §REQ-145; slice S8 |
| REQ-146 | Research keeps valid lines sealed, names the failed line and cause, re-dispatches only that line; fan-out failed until all four sealed | §REQ-146; slice S13 |
| REQ-147 | One shared sealer for research-result and decomposition-result envelopes with artifact index, Claude and Codex | §REQ-147; slice S11 |
| REQ-148 | Codex GSD researcher writes only its contained artifact path; Codex child tasks passed by file path + digest verified by the host | §REQ-148; slices S12a/S12b/S12c |
| REQ-149 | Six point fixes (state YAML, pre-push, Codex refusal, gsd-tune Codex keys, host-state prose, doctor manifest) | §REQ-149; slices S2-S7 |
| REQ-150 | Git-creating unit fixtures hermetic against global commit signing and fixed `/tmp` paths | §REQ-150; slice S1; Code example 3 |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- The Claude plugin under `plugins/delivery-pipeline/` is canonical; Codex output is generated by `scripts/gen-codex-shipyard.cjs`. Edit the Claude command or shared script first, then run `make install-shipyard-codex` and inspect the result. [VERIFIED: CLAUDE.md:69-70]
- Run `make test-fast` after each edit; `make test` adds the network-bound Codex smoke and release checks. [VERIFIED: CLAUDE.md:49-50, Makefile:47-51]
- When adding a rule, add a focused unit or fixture test with it. [VERIFIED: CLAUDE.md:72-75]
- ADR-014 boundary is mandatory: resolve → validate → launch → receipt; hard refusals for unknown runtimes, stale variants, conflicting overrides, missing receipts. Do not alias the Codex and Claude grids. [VERIFIED: CLAUDE.md:77-83]
- Shell scripts keep `set -euo pipefail` and validate preconditions early. [VERIFIED: CLAUDE.md:114]
- Keep generated state and measurements in the existing `.planning` locations. [VERIFIED: CLAUDE.md:115]
- Preserve unrelated worktree changes; the repository is often edited during an active delivery session. [VERIFIED: CLAUDE.md:116-117]
- Update `README.md` when the supported command or installation flow changes; `tests/smoke/docs-smoke.sh` fails if the README names a make target that does not exist. [VERIFIED: CLAUDE.md:52-55,118; tests/smoke/docs-smoke.sh:62]
- `make doctor` is read-only. [VERIFIED: CLAUDE.md:107-108]
- Comment policy (enforced by CI publish gate, `make test-comment-policy`, and the pre-push hook): only directives, licence/generated markers, and one-line `@invariant:`/`@security:`/`@contract:` markers up to 120 characters; history words such as `ticket`, `because`, `legacy`, `#123`, `ADR-nn` are rejected. New code in this phase must be written essentially comment-free. [VERIFIED: plugins/delivery-pipeline/scripts/comment-policy.cjs:8-11, quoted in Verbatim anchors A15]
- Project skill `.shipyard/generated/gsd-delivery-rules/SKILL.md`: full plan frontmatter; `files_modified` is a contract and dependency-unordered plans with overlapping paths fail Gate 2; verification commands scoped to the ticket; ids `T-<2-digit>-<2-digit>`; executors stay inside `files_modified` and stop at the commit. [VERIFIED: .shipyard/generated/gsd-delivery-rules/SKILL.md:38-165]

## Summary

Phase 40 is almost entirely a change to the deterministic layer in `plugins/delivery-pipeline/scripts/`, three host-side scripts in `scripts/`, the unit/smoke suites, and three command prose files. No external package is installed: every new seam is plain Node 24 CommonJS or bash 3.2, consistent with the repository having no `package.json` (`.github/workflows/test.yml` header: "this repo has no package.json — the tests run on bare node"). The Codex parity work is mostly regeneration: `gen-codex-shipyard.cjs` copies the whole `scripts/ references/ templates/ workflows/` payload and converts `commands/*.md` into skills, so new scripts need no generator change; only the Codex static-agent sandbox table (`gsd-tune.cjs codexStaticVariants`) and the doctor manifest path change Codex-visible output. Parity is proven by `make test-codex-shipyard` (network).

The dominant planning constraint is file overlap with phase 39. At HEAD this branch contains T-39-01, T-39-02 and T-39-04 (merged into `epic/39` and carried into `inv/004`); the last-fetched `origin/epic/39-remove-conveyor-session-friction` additionally has T-39-05, T-39-06, T-39-07; T-39-03, T-39-08, T-39-09, T-39-10, T-39-11, T-39-12 exist only as unmerged ticket branches; nothing of phase 39 is on `main`. Of the 15 requirements, only REQ-143, REQ-149a (state YAML), REQ-149b (pre-push), REQ-148 part C5 (task-by-file), the core of REQ-142 (a new hygiene module, `role-artifact.cjs`, `executors.mjs`, `delivery-commit-finalizer.cjs`, `epic-branch.sh`) and the `run.sh` half of REQ-150 can start from `main` without a cross-phase dependency. Everything else touches a file in a phase-39 `files_modified` list.

Four hot files force serialization inside phase 40: `claude-delivery-host.cjs` (REQ-138/139/144/146/147), `codex-delivery-host.cjs` (REQ-138/139/144/148), `deliver.md` (REQ-138/140/142), and `Makefile`+`README.md` (REQ-137/141/144/145). The recommended slicing below isolates those into chains and into two prose/command-surface integration tickets, so the remaining tickets have disjoint `files_modified`.

**Primary recommendation:** Slice into ~22 tickets on the S1-S21 plan below. Start the main-only slices (S1-run.sh, S2, S3, S12b, S17, S18a) first. Put every slice that touches a phase-39 file behind a cross-phase `depends_on` on the exact T-39 id(s) listed in the overlap table, and run the REQ-141 live acceptance only after phase 39 is on `main` and released.

## Architectural Responsibility Map

The tiers here are Shipyard's own layers, not a web stack.

| Capability | Primary tier | Secondary tier | Rationale |
|------------|-------------|----------------|-----------|
| Build dispatch request from graph (REQ-138) | Deterministic script (new entry point) | Runtime hosts (validate) | The host must stay the validator (R6); the entry point derives, the host checks |
| In-flight record (REQ-139) | Runtime host process (writes at launch) | `dispatch-record.cjs` store, `front.cjs`/`stop-gate.cjs` readers | "Host-issued" means the launching host writes it; readers already consume `activeDispatches` |
| Detached launch, status, wait (REQ-138) | Entry point + `run-waker.cjs` | Harness background execution | Waits live in Node, never foreground `sleep` (C-T14) |
| Sentinel preconditions (REQ-140) | Deterministic preflight script | `claude-role-host.cjs` (fail-closed checks stay) | Establish preconditions; do not relax identity checks (C-T5) |
| Captured fixtures (REQ-137) | Manual capture script + committed fixtures | Unit contract test | CI is offline; capture never runs in CI |
| Live release gate (REQ-141) | Local make target + release script | In-repo fixture project | Needs credentials; cannot run in CI |
| PR hygiene (REQ-142) | Publish-time gate script | Graph (branch), commit finalizer, PR body contract | Enforced where the conveyor publishes, not by prose |
| Ticket ↔ PR matching (REQ-143) | `ticket-pr-match.cjs` | `state-sync.cjs`, `pipeline-stats.cjs`, durable PR-creation record | One matcher, two callers |
| Dogfood provenance (REQ-144) | Installer + provenance helper | Hosts, `sentinel.cjs` merge, doctor | Receipt shape is frozen (ADR-017 out of scope) — see Pitfall 10 |
| Digest pin (REQ-145) | Refresh script + CI step | `source-contract.test.cjs` | Human-visible trailer checked mechanically |
| Research/decompose sealing (REQ-146/147) | Shared sealer module | Claude/Codex research and decompose hosts | One envelope producer for both runtimes |
| Codex researcher write scope and task relay (REQ-148) | `codex-decompose-host.cjs`, `codex-dispatch-adapter.cjs`, `codex-runtime-host.cjs` | Generated agent TOML via `gsd-tune.cjs` | Canonical sources, then regenerate |

## Standard Stack

### Core

| Library | Version | Purpose | Why standard |
|---------|---------|---------|--------------|
| Node.js built-ins (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:os`) | Node 24 (host `v24.10.0`; CI pins `24.15.0`) | All new scripts and tests | Repository rule: no npm deps, bare node [VERIFIED: .github/workflows/test.yml:3-4,46; `node --version`] |
| `tests/unit/assert-harness.cjs` + `node <file>.test.cjs` | in-repo | Unit tests; `tests/unit/run.sh` runs every `*.test.cjs` | Existing harness [VERIFIED: tests/unit/run.sh:22-26] |
| bash 3.2 | macOS `/bin/bash` 3.2.57 | Installers, hooks, smoke tests | `Makefile:1` `SHELL := /bin/bash`; no `mapfile`, `declare -A`, `timeout` [VERIFIED: `bash --version`; INV-004 constraints C-T14] |
| `git`, `gh` CLIs | git 2.54.0; gh present | Preflight fetch, PR publication, matching | Already used by `state-sync.cjs`, `sentinel.cjs`, `epic-branch.sh` |

### Supporting (in-repo modules to reuse, not reimplement)

| Module | Use in phase 40 |
|--------|-----------------|
| `lock.cjs` (`withLock`, `writeAtomic`) | Any new durable store (in-flight record, PR-creation ledger, live receipt) [VERIFIED: run-waker.cjs:9 imports them] |
| `dispatch-record.cjs` (`activeDispatches`, `reserveRound`, `DISPATCH_TTL_MS`) | Model the in-flight record on `reservations`; reuse the TTL constant |
| `refusal-hints.cjs` (`formatHint`, `HINTS`) | REQ-149c config-refusal remedy; REQ-146 line-specific refusal |
| `graph-dir.cjs` (`resolveGraphDir`, `resolveBaseRef`) | Entry point and preflight graph/base resolution |
| `front.cjs` (`computeFront`) | Entry point reads actionable tickets |
| `ticket-pr-match.cjs` (`matchTicketPr`) | REQ-143 |
| `role-artifact.cjs` (`fileReference`, `capSummary`, `assertTicketMarker`) | REQ-142/147 |
| `run-waker.cjs` (`WAIT_KINDS`, `waitForWake`) | REQ-138 `dispatch` wait kind |
| `comment-policy.cjs` `protectedComment` | Accepts `@generated`, `do not edit`, `generated file`, `shipyard[-: ]` bodies at comment start — relevant to REQ-149a [VERIFIED: comment-policy.cjs:53-57] |

### Alternatives considered

| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| New `deliver-dispatch.cjs` | Extend `front.cjs` | `front.cjs` is a read model imported by `stop-gate.cjs`; adding launch side effects there couples the gate to process spawning. Keep a separate script. |
| In-flight record in `dispatch-record.cjs` | Reuse `run-controller.cjs` leases (`DEFAULT_LEASE_TTL_MS`) | The stop gate and front already read `activeDispatches`; a lease store would need a new reader in both. Also the lease flake backlog entry is out of scope. Use `dispatch-record.cjs`. |
| Hidden HTML ticket marker in PR body | — | Rejected in DECISIONS ("What was rejected: a hidden HTML ticket marker"). Do not propose. |

**Installation:** none. This phase installs no external package.

## Package Legitimacy Audit

Not applicable: this phase installs no external package (npm, PyPI or crates). All new code uses Node built-ins and existing in-repo modules. The `ctx7`/Context7 lookup and the legitimacy seam were therefore not needed.

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Current state that the plan builds on

| Fact | Evidence |
|------|----------|
| HEAD `96d2087b` (`inv/004-phase39-delivery-retro`) = `main` (0.61.0, `befc970c`) + merged T-39-01, T-39-02, T-39-04 + planning commits | `git log --oneline origin/main..HEAD` shows `513a2106 (T-39-04)`, `926c1ca2 (T-39-01)`, `4691a797 (T-39-02)`; `git diff --stat origin/main HEAD -- plugins scripts tests Makefile` lists 20 files, all T-39-01/02/04 [VERIFIED: git] |
| Last-fetched `origin/epic/39-…` also has T-39-05 (#210), T-39-06 (#211), T-39-07 (#209) | `git log --oneline -8 origin/epic/39-remove-conveyor-session-friction` [VERIFIED: git, refs possibly stale] |
| Unmerged T-39 branches: T-39-03, 08, 09, 10, 11, 12 | `git branch -r` lists only those six ticket branches [VERIFIED: git] |
| `git fetch origin` failed (`ssh_dispatch_run_fatal … Broken pipe`); `gh` config unreadable in the sandbox | command output this session — PR states and newer merges are **no observation** |
| `stop-gate-arm.cjs` does not exist at HEAD (it arrives with T-39-03) | `ls` → "No such file or directory" [VERIFIED] |
| No release script exists; releases are `release/version-X` branches merged by PR plus the `release-notes-smoke.sh` check | Grep for `release/version|cut a release` found only README/Makefile/CLAUDE.md mentions of `make test-releases` [VERIFIED: grep] |

## Requirement → files map

Legend: **NEW** = file to create. `P39: T-39-NN` = the file is in that phase-39 plan's `files_modified` (see the cross-phase table). Line numbers are at HEAD `96d2087b` and are re-resolved by symbol.

### REQ-136 — seams first, releases gated on a live round
- No dedicated file set. It is satisfied by (a) wave ordering (seam slices S9/S10, S14/S15, S16 precede the point-fix slices that build on them — S12a, S13, S19), and (b) the REQ-141 release script. The planner should cite REQ-136 on S15, S16, S10 and S20.

### REQ-137 — captured boundary fixtures + contract test
- **NEW** `scripts/capture-boundary-fixtures.cjs` [ASSUMED name] — runs real producers (Claude `claude --print … --output-format stream-json --json-schema …` on the cheapest model; `run-scope.cjs createRunScope`; the Codex parent/child `codex exec`/`spawn_agent`), scrubs home paths, tokens and session ids, records `claude --version` / `codex --version`, writes `tests/fixtures/captured/<producer>@<cli-version>.jsonl` with a provenance header line.
- **NEW** `tests/fixtures/captured/registry.json` [ASSUMED name] — the registered boundaries: producer id, fixture path, CLI version, list of consumer test files.
- **NEW** `tests/unit/boundary-fixtures.test.cjs` [ASSUMED name] — (1) every registered fixture exists and passes the scrub check (no `/Users/`, `/home/`, token shapes, real UUID session ids unless replaced by a scrub placeholder); (2) for every registered consumer test, fails on inline producer shapes (for example a `spawn:` closure fabricating stdout, or a literal `structured_output` object) — the test reads the consumer test source and requires it to load the registered fixture; (3) reports a version mismatch when the installed CLI is available and differs (warning, not failure, in CI where the CLI is absent).
- Consumer tests to migrate: `tests/unit/claude-runtime-host.test.cjs` (P39: T-39-12; inline `spawn:` stubs), `tests/unit/claude-workflow-host.test.cjs` (P39: T-39-12), `tests/unit/codex-runtime-host.test.cjs` (no P39; already loads `codex-agent-{child,parent}-0.155.1.jsonl`), `tests/unit/codex-decompose-host.test.cjs` (P39: T-39-01; forged read-only agent at :36,:54,:103-106).
- Fixtures: replace `tests/fixtures/claude-assistant-session.jsonl` (synthetic ids per INV-004); move/re-capture `tests/fixtures/codex-agent-*-0.155.1.jsonl` under `captured/`.
- `Makefile` (`capture-fixtures` target), `README.md` (document it) — assign to the command-surface ticket S21.
- The actual capture is a human action with local credentials: the executor builds the harness and scrubber with a synthetic input test; a `checkpoint:human-action` ticket step runs `make capture-fixtures` and commits the output.

### REQ-138 — deterministic front → dispatch entry point
- **NEW** `plugins/delivery-pipeline/scripts/deliver-dispatch.cjs` [ASSUMED name] with subcommands `launch`, `status`, `wait`:
  - reads actionable tickets from `front.cjs computeFront` and rows from `.planning/graph/tickets.json`;
  - `branch` = `row.branch` (never recomputed; `validate-graph.cjs:174` is the one producer);
  - `planPath` = `path.resolve(graphDir, '..', '..', row.plan)` — exactly what `canonicalPlan` expects (`claude-delivery-host.cjs:214-221`, anchor A3), with `graphDir` passed to the host explicitly (`SHIPYARD_GRAPH_DIR` or `graphDir` option, `claude-delivery-host.cjs:145-147`) — see Pitfall 2;
  - `signals` built only from keys `normalizeSignals` accepts (`type` limited to `facts|alternatives`, `complexity`, `critical`, `checkpoint`, `contested`, `risk`, `inputTokens`, `signatureState`, `priorApplied`; anchor A4); the ticket `type` (GSD plan kind, `validate-graph.cjs:160` default `implementation`) is never copied into `signals`;
  - Claude: writes a mode-0600 `shipyard.claude-delivery-request.v1` file (`{schema, scope, args}` only, anchor A2) and launches `claude-delivery-host.cjs --workflow executors --request-file <f>` detached, one process per ticket (`cliDispatch` requires exactly one ticket, `claude-delivery-host.cjs:888-901`);
  - Codex: writes the `codex-delivery-host.cjs --args-file` request (`requestValue` allowed keys `role, signals, context, dispatch_id, gsd_role`, `codex-delivery-host.cjs:39-55`);
  - validates each request through the host's own exported validator before launch (R6);
  - records a wake event of kind `dispatch` for `wait`.
- `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs` (P39: T-39-08) — export the request validator (`readRequest`, `parseCli`, `assertScopedWork` are not exported today; `module.exports` at :960 exports only `WORKFLOWS, REQUEST_SCHEMA, createClaudeDeliveryHost, runClaudeDeliveryCli`).
- `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` (P39: T-39-01) — export `readRequestFile`/`requestValue` for the entry point.
- `plugins/delivery-pipeline/scripts/run-waker.cjs` — add `'dispatch'` to `WAIT_KINDS` (:15, anchor A5); `tests/unit/run-waker.test.cjs`.
- **NEW** `tests/unit/deliver-dispatch.test.cjs` — round-trips each built request through the real host parse path (no fixture shapes).
- `plugins/delivery-pipeline/commands/deliver.md` (P39: T-39-03) — replace the hand-assembly prose (`deliver.md:1710-1741` per INV-004) and remove ticket `type` from every "pass as signals" instruction (`:1711-1713`, `:2152`, `:2208`, `:2251` per INV-004; re-resolve) — assign to the deliver prose ticket S18c/S22.
- Tests that pin `"type": "implementation"` in signals must be read and adjusted if they assert acceptance: `tests/unit/pipeline-config.test.cjs`, `tests/unit/claude-role-host.test.cjs`, `tests/unit/model-policy.test.cjs` (counts from INV-004 system-state; not re-read).

### REQ-139 — host-issued in-flight record
- `plugins/delivery-pipeline/scripts/dispatch-record.cjs` — add an `inflight` section modeled on `reserveRound` (`:1463-1513`): `{ticket, role, dispatch_id, pid, host, started_at, ttl_ms}`; `activeDispatches` (`:1390-1461`) projects it while `now - started_at < DISPATCH_TTL_MS` (anchor A12) **and** `process.kill(pid, 0)` succeeds; a dead pid or expiry drops it (fail closed = the ticket is offered again and the gate enforces). Export `recordInflight`/`clearInflight` [ASSUMED names].
- `claude-delivery-host.cjs` (P39: T-39-08) `runClaudeDeliveryCli` (:903-958): write the record after `controller.begin(scope)` and before `createClaudeDeliveryHost(...).run(...)`; clear it in `finally`. `pid` = `process.pid` of the host process.
- `codex-delivery-host.cjs` (P39: T-39-01) `runCli` (:367-): same.
- `stop-gate.cjs` (P39: T-39-03) — probably no code change: it treats a ticket as live through `front.waiting.dispatched` (:552, :582), which `front.cjs` fills from `activeDispatches` (`front.cjs:80, 597-599`). Prove it with a test instead.
- Tests: `tests/unit/dispatch-record.test.cjs` (P39: T-39-03), `tests/unit/stop-gate.test.cjs` (P39: T-39-03) — in-flight record silences the armed gate; dead pid and expired TTL do not.
- The durable `dispatch-record.cjs mark` after the verified receipt stays unchanged (`deliver.md` "Record the dispatch — AFTER the boundary returned a verified receipt", per INV-004 C-T3).

### REQ-140 — sentinel preflight
- **NEW** `plugins/delivery-pipeline/scripts/sentinel-preflight.cjs` [ASSUMED name]: for the phase worktree, (1) `git fetch --no-tags origin +refs/heads/<base>:refs/remotes/origin/<base>` — any failure refuses naming the exact command; (2) fast-forward the local base branch to `origin/<base>` only when it is an ancestor (else refuse naming `git -C <wt> branch -f <base> origin/<base>` or the rebase to run); (3) run `state-sync.cjs`; (4) if `.planning/graph` is tracked and changed, commit it (else nothing to commit — see Pitfall 5); (5) otherwise refuse with the exact command.
- `plugins/delivery-pipeline/scripts/claude-role-host.cjs` (P39: T-39-12) — `branchOid` (:169-188) swallows a fetch failure when `expectedOid` is given (`catch { if (expectedOid === undefined) reject(...) }`, anchor A6). Make any fetch failure a refusal; call the preflight at the start of the sentinel path (`prepareSentinel`, :485) or require its receipt.
- Tests: `tests/unit/claude-role-host.test.cjs` (P39: T-39-12), **NEW** `tests/unit/sentinel-preflight.test.cjs` (hermetic bare-origin git fixture).
- `deliver.md` Step 4 (P39: T-39-03; `deliver.md:2020-2066`) — name the preflight — deliver prose ticket.
- Codex sentinel (`codex-delivery-host.cjs` role `pr-sentinel`) should run the same preflight from the entry point.

### REQ-141 — live round and release gate
- **NEW** `tests/fixtures/live-project/` [ASSUMED path] — minimal target project: accepted ADR with `UI design: none`, one source file, a two-ticket plan set; used as a template copied into `$TMPDIR` and pushed to a throwaway remote.
- **NEW** `tests/live/live-round.sh` (or `scripts/live-round.cjs`) [ASSUMED] — per runtime: research → decompose → executor → sentinel through the installed-layout hosts with the cheapest allowed model; writes a live receipt (version, HEAD sha, tree sha, runtime, per-stage results, UTC time).
- **NEW** `scripts/release.sh` [ASSUMED] — refuses unless a passing receipt exists for the current plugin version and HEAD tree for both runtimes and is younger than a threshold; then performs the version/tag steps the maintainer does today.
- **NEW** `tests/unit/release-gate.test.cjs` — offline test of the freshness predicate.
- `Makefile` (`test-live`, `release`), `README.md` — S21.
- The ADR-014 "cheapest allowed model" constraint conflicts with the fixed grids (Claude executor floor Sonnet/max; Codex executor Luna/max) — see Open question 5.

### REQ-142 — target-project PR hygiene
- **NEW** `plugins/delivery-pipeline/scripts/pr-hygiene.cjs` [ASSUMED name]: `applies(projectRoot)` (false only for the Shipyard repository; recommendation: true unless `plugins/delivery-pipeline/.claude-plugin/plugin.json` exists with `"name": "shipyard"`, anchor A20) and `check({title, body, head, paths, commits})` rejecting `T-\d{2}-\d{2}`, `Ticket:`, `Phase \d+`, `ADR-\d+`, `PLAN.md`, `ticket/`, `epic/`, `.planning/`, `.shipyard/`, `shipyard`/`gsd` terms; title must match a conventional-commit header; CLI for publication. **NEW** `tests/unit/pr-hygiene.test.cjs` (including a Shipyard-exempt case).
- `plugins/delivery-pipeline/scripts/role-artifact.cjs` — `assertTicketMarker` (:402-410, anchor A9), called at :545 and :693. When hygiene applies, the executor PR body must **not** start with `Ticket:`; when exempt, keep the check. The check must receive the applicability decision from a trusted caller (not from the agent). Tests: `tests/unit/role-artifact.test.cjs`.
- `plugins/delivery-pipeline/workflows/executors.mjs` — `prBodyGuide` default (:189) demands the `Ticket:` first line; make the guide conditional on applicability. Tests: `tests/unit/workflows-args.test.cjs` if it covers args [ASSUMED coverage].
- `plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs` — the host-finalized commit subject is `(${ticket}): finalize scoped changes` (:185, anchor A10); every ticket PR therefore carries the ticket id in its commit list. Use a conventional subject for target projects. Tests: `tests/unit/delivery-commit-finalizer.test.cjs`. (Also consumed by `codex-delivery-host.cjs finalizer`, :129.)
- `plugins/delivery-pipeline/scripts/epic-branch.sh` `pr` (:338-351) — title `epic: ${epic#epic/} integration` and a body naming the epic (anchor A11). Neutral title/body for target projects.
- `plugins/delivery-pipeline/scripts/validate-graph.cjs` (P39: T-39-06) — `branchFor` (:83-86, anchor A8) → `<type>/<slug>` or `<type>/<JIRA-KEY>-<slug>` for target projects, `ticket/<ID>-<slug>` kept for the exempt repo; add a duplicate-branch error (two tickets can share a slug once the id is gone); epic branch `epic/${t.phaseDir}` (:508) — see Open question 2. `tests/smoke/graph-validator-smoke.sh` (P39: T-39-06).
- `plugins/delivery-pipeline/skills/delivery-rules/SKILL.md` and `.shipyard/generated/gsd-delivery-rules/SKILL.md` (both P39: T-39-06) — rule 3 (branch naming, SKILL.md:68-72) and executor rule 3 (`feat(T-01-02): …` commit prefix, SKILL.md:147).
- `deliver.md` (P39: T-39-03) — publication prose `--title "<T>: <title>"` and the `Ticket: <T>` marker instruction (`deliver.md:1974-2013`) — deliver prose ticket.
- `.planning/` untracked in target projects: the writer is undecided. Candidates: `gsd-tune.cjs --apply` project mode (P39: T-39-07) or decompose/bootstrap (P39: T-39-09, T-39-10). REQ-133 (T-39-10) currently makes decompose **warn when `.planning/` is not tracked**, which is the opposite direction — see Pitfall 7 and Open question 1.
- `gate-trailer.cjs` writes a `gate_status:` trailer into PR bodies that `sentinel.cjs merge` reads — conveyor internals in the body; see Open question 3.
- `gsd-sync.cjs:870` `- Ticket: ${plan.ticket}` (anchor A13) is a `.planning/` projection line, not PR text; no change (it never reaches a target PR once `.planning/` is untracked).

### REQ-143 — matching by head branch plus recorded PR number
- `plugins/delivery-pipeline/scripts/ticket-pr-match.cjs` — `matchTicketPr(id, ticket, prs)` (:52-69): exact `headRefName === ticket.branch` first, then `hasIdMarker` (title marker or `ticket/<ID>-` prefix, :44-48, anchor A14) with title similarity. New order: (1) recorded PR number for the ticket (if present and its head equals the recorded head or the canonical branch), (2) exact head branch, (3) marker fallback only for legacy PRs (head starts with `ticket/` or created before the recorded-number cutover). New code must not add comments (the file's existing comments are grandfathered).
- Durable creation record: `delivery-state.json` is rebuilt from GitHub by `state-sync.cjs`, so the number must be recorded in a durable input that state-sync reads. Recommendation: a small ledger written at PR creation by the publish step (the entry point or a `pr-record` subcommand) under `.planning/graph/` and read by `state-sync.cjs` (`matchTicketPr` call sites :549, :552) and `pipeline-stats.cjs` (:167).
- Tests: `tests/unit/ticket-pr-match.test.cjs` (re-decompose rename case, legacy `ticket/T-…` PR, colliding ids across workspaces); `tests/smoke/sentinel-smoke.sh` covers state-sync end to end.
- Keeps working: `role-artifact.cjs` marker check (exempt repo), `gsd-sync.cjs` projections (read `plan.delivery.pr`).

### REQ-144 — dogfood mode with provenance
- **NEW** `scripts/install-shipyard-dogfood.sh` [ASSUMED] — installs hooks/plugin payload from a worktree into a separate root (for example `$SHIPYARD_DOGFOOD_ROOT`), never into `~/.claude/plugins/cache/shipyard/…`.
- **NEW** `plugins/delivery-pipeline/scripts/host-provenance.cjs` [ASSUMED] — `{source_sha, dirty, install_kind: release|dogfood, version}` computed from the plugin root; tests.
- Stamp sites: `claude-delivery-host.cjs` (P39: T-39-08), `codex-delivery-host.cjs` (P39: T-39-01), `claude-role-host.cjs` (P39: T-39-12) — attach provenance to the host result/journal and the in-flight record, **not** to the ADR-014 application receipt (receipt shape is out of scope; Pitfall 10).
- Merge refusal: `plugins/delivery-pipeline/scripts/sentinel.cjs` `mergeOne` (:891; `gh pr merge … --squash` at :1125) — refuse when provenance is `dogfood` and the PR base is the target default branch (`defaultBranchCache`, :334-344).
- Doctor: `scripts/shipyard-doctor.cjs` (P39: T-39-04) — report an installed Claude cache (`~/.claude/plugins/cache/shipyard/shipyard/<version>/scripts/`) whose file digests match no release (compare with `git show v<version>:plugins/delivery-pipeline/scripts/<f>` when run from a checkout; read-only). `tests/smoke/claude-hook-smoke.sh` (P39: T-39-04).
- `Makefile`, `README.md` — S21. `scripts/install-shipyard-claude-hook.sh` (P39: T-39-04) only if the dogfood root needs hook wiring.

### REQ-145 — digest pin refresh path
- `tests/unit/source-contract.test.cjs` (P39: T-39-12) — `RUNTIME_OWNED_FILE_DIGESTS` (:1986-1989, anchor A16). Move the digests to a data file the refresh script rewrites (for example **NEW** `tests/unit/runtime-file-digests.json` [ASSUMED]); the test keeps asserting equality and the native-grid assertions (:1996-1999).
- **NEW** `scripts/refresh-runtime-digests.cjs` [ASSUMED] — recomputes the digests and prints the required trailer (for example `Runtime-Digest-Refresh: <path>` [ASSUMED name]).
- **NEW** `scripts/check-runtime-digest-trailer.cjs` [ASSUMED] (or a `--check` mode) — for `git log <base>..HEAD`, any commit that changes the digest data file must carry the trailer naming each changed runtime file; **NEW** `tests/unit/runtime-digests.test.cjs` with a hermetic git fixture.
- `.github/workflows/test.yml` — add a step before `make test-fast` (checkout already uses `fetch-depth: 0`, :42-43).
- `Makefile` (`refresh-runtime-digests`), `README.md`/`CLAUDE.md` — S21.
- Note: `claude-dispatch-adapter.cjs` is pinned; REQ-146 must not edit it (Pitfall 4).

### REQ-146 — per-line research recovery
- `plugins/delivery-pipeline/workflows/investigation-research.mjs` (P39: T-39-08) — the per-line job rethrows any error (per INV-004 `:285-290`; re-resolved: `throw error` at :289 inside `parallel(lines.map(...))` at :231). Catch per line, return a `blocked` line result naming the failed line and cause, keep the other lines' sealed artifacts, and fail the fan-out as a whole until all four are sealed.
- `claude-delivery-host.cjs` (P39: T-39-08) — `sealPlanningResearch` (:506-572) folds 11 conditions into `planning research has invalid scope or result` (:515, anchor A7): split into specific messages (moves into the shared sealer, REQ-147). `cliDispatch` (:888-901) requires exactly four lines for `investigation-research`; re-dispatching one line needs a single-line mode that verifies the other three sealed manifests.
- `plugins/delivery-pipeline/scripts/claude-investigation-host.cjs` (P39: T-39-01) — only if the CLI surface changes.
- `plugins/delivery-pipeline/commands/investigate.md` (P39: T-39-11) — prose for re-dispatching one line — investigate/decompose prose ticket S6.
- Tests: `tests/unit/investigation-research.test.cjs`, `tests/unit/planning-artifacts.test.cjs` (both P39: T-39-08), `tests/unit/claude-delivery-host.test.cjs`.

### REQ-147 — one shared sealer
- **NEW** `plugins/delivery-pipeline/scripts/planning-result-sealer.cjs` [ASSUMED name] extracted from `sealPlanningResearch` (`claude-delivery-host.cjs:506-572`; envelope `schema: 'shipyard.research-result.v1'` at :561, anchor A7) plus a `sealDecomposition` producing `shipyard.decomposition-result.v1` with a bounded `artifact_index` (contract in `decompose.md:220-222`).
- Callers: `claude-delivery-host.cjs` (P39: T-39-08), `claude-decompose-host.cjs` `runDecomposition` (:135-200) (P39: T-39-01), `codex-decompose-host.cjs` `createCodexDecomposeHost` (:92-) which returns the raw `launchAgent` result (P39: T-39-01), `codex-delivery-host.cjs` research branch (P39: T-39-01; shared with REQ-148 C3).
- Tests: **NEW** `tests/unit/planning-result-sealer.test.cjs`; `tests/unit/claude-decompose-host.test.cjs`, `tests/unit/codex-decompose-host.test.cjs` (P39: T-39-01); `tests/unit/planning-artifacts.test.cjs` (P39: T-39-08).
- Backlog: mark `.planning/backlog/decompose-host-returns-no-artifact-index.md` resolved (DECISIONS: "absorbing the Claude-only backlog entry").

### REQ-148 — Codex researcher write scope and task-by-file
- C4 write scope: `codex-decompose-host.cjs` `ROLES['gsd-phase-researcher'].sandbox` (:19, anchor A17) (P39: T-39-01); `codex-dispatch-adapter.cjs` `expectedSandbox` default (:98-99, anchor A18); `gsd-tune.cjs codexStaticVariants` research sandbox `read-only` (:116, anchor A19) (P39: T-39-07) for the investigation researcher `shipyard-inv-research`. Containment: after the child returns, refuse unless the only worktree change is the contained artifact path (`git status --porcelain`), or have the host materialize the artifact from a bounded return (RISKS R10 fallback). Tests: `tests/unit/codex-decompose-host.test.cjs` (P39: T-39-01) — replace the forged read-only agent file with one generated by `gsd-tune.cjs`/the generator; `tests/unit/codex-dispatch-adapter.test.cjs`; `tests/unit/gsd-tune.test.cjs` (P39: T-39-07).
- C5 task relay: `codex-runtime-host.cjs` launch input (:876-881, anchor A21) embeds the full task and asks the parent to relay "this exact task"; spawn evidence checks only `agent_type/model/reasoning_effort/fork_turns/task_name` (:632-672). Write the task to a host-owned file outside the model-writable tree, pass path + sha256, and verify the digest in the child's native evidence (developer/user message scan near :700-730); refuse when unverifiable (RISKS R12). Tests: `tests/unit/codex-runtime-host.test.cjs`; fixtures must be re-captured (REQ-137).
- C3 Codex research consumer: `codex-delivery-host.cjs` research branch using the shared sealer (P39: T-39-01); `investigate.md` (P39: T-39-11) already routes Codex research through `codex-delivery-host.cjs --args-file` (investigate.md:35-38, :116-124).
- Regenerate Codex output: `make install-shipyard-codex`; verify with `make test-codex-shipyard` (network).

### REQ-149 — point fixes
| Sub | Files | P39 overlap |
|-----|-------|-------------|
| a. header-free deterministic state YAML | `plugins/delivery-pipeline/scripts/state-sync.cjs` — header at :961 and `# snapshot generation … — observed …` at :1124 (anchor A22); keep the generation in `delivery-state-meta.json` and the stdout line (:1313-1314, asserted by `tests/smoke/sentinel-smoke.sh:1242`). **NEW** unit test (for example `tests/unit/state-sync-yaml.test.cjs`) or extend `tests/smoke/sentinel-smoke.sh`; mark `.planning/backlog/generated-state-yaml-header-blocks-push-from-the-project.md` resolved | none |
| b. pre-push resolves worktree via git | `scripts/shipyard-pre-push-gate.sh` (:13-18 regex, anchor A23) — resolve `git -C "<payload cwd>" rev-parse --show-toplevel`; **NEW** `tests/unit/pre-push-gate.test.cjs` spawning the script with JSON payloads (`cd X; git push`, `git -C "$W" push`) | none (installer copies it; `install-shipyard-claude-hook.sh` is T-39-04 but needs no change) |
| c. Codex config refusal names the config fix | `codex-agent.cjs` (:21, :187), `codex-model-remap.cjs` (:12-15, anchor A24), `codex-dispatch-adapter.cjs` (`REPAIR` re-export :18, :25), `refusal-hints.cjs`; tests `codex-agent.test.cjs`, `refusal-hints.test.cjs` | `refusal-hints.cjs`, `refusal-hints.test.cjs` → T-39-01 |
| d. gsd-tune Codex writes no Claude-only keys | `gsd-tune.cjs` `TUNING_ALL` (:581-612) — `model_overrides.*` gated on `runtime === 'claude'` (:593) but `models.*` (:606-609) ungated; `tests/unit/gsd-tune.test.cjs` | T-39-07 (both files) |
| e. prose: out-of-repo host state dir | `commands/investigate.md`, `commands/decompose.md` — explain `~/.local/state/shipyard/codex-decompose/…` (`codex-decompose-host.cjs:73-90`) is Shipyard's evidence store outside the model worktree; contract test (new file or the existing friction-contract tests) | T-39-11 (`investigate.md`, `investigate-friction-contract.test.cjs`), T-39-10 (`decompose.md`, `decompose-friction-contract.test.cjs`) |
| f. doctor reads Codex agents manifest | `scripts/shipyard-doctor.cjs` (:210-213, anchor A25) → `$CODEX_HOME/agents/.shipyard-manifest.json` (installer name at `install-shipyard-codex.sh:280`, anchor A26); `tests/smoke/claude-hook-smoke.sh` (doctor against a populated Codex home) | T-39-04 (both files) |

### REQ-150 — hermetic git fixtures
- `tests/unit/run.sh` — export a hermetic environment before the loop: `GIT_CONFIG_GLOBAL` pointing to a temp file containing `user.name`, `user.email`, `commit.gpgsign=false`, `tag.gpgsign=false`, `init.defaultBranch=main`; `GIT_CONFIG_NOSYSTEM=1`. This single file fixes every unit test that inherits the developer's signing config (INV-004 C-T15 named `claude-role-host`, `comment-policy`, `publish gate` failures). No P39 overlap.
- Hard-coded `/tmp` temp dirs: `tests/unit/codex-delivery-host.test.cjs:30` `fs.mkdtempSync('/tmp/scds-')` (anchor A27; P39: T-39-01); `tests/unit/claude-delivery-host.test.cjs:464, 518, 864, 918` (`/tmp/crh-*-gpg-` GNUPGHOME dirs; no P39). Replace with `os.tmpdir()` but keep the path short enough for gpg-agent sockets (Pitfall 11).
- **NEW** `tests/unit/test-hermeticity.test.cjs` [ASSUMED name] — scans `tests/unit/*.test.cjs` and fails on `mkdtempSync('/tmp` and on `git init`/`commit` fixtures that neither run under `run.sh` hermetic env nor set their own `GIT_CONFIG_GLOBAL`/`commit.gpgsign=false` (so a direct `node tests/unit/x.test.cjs` stays hermetic too, or the rule is documented as "run through run.sh").
- Files that create repos and commit without their own isolation (candidates for the scan, not necessarily edits): `files-contract`, `claude-role-host`, `session-handoff`, `trailer`, `degenerate-green`, `rotation-recommendation`, `comment-policy`, `stop-gate`, `claude-decompose-host`, `claude-runtime-host` `*.test.cjs` [VERIFIED: grep for `init`/`commit`/`gpgsign` this session].

## File-overlap matrix

### Files touched by more than one requirement

| File | Requirements | P39 ticket(s) |
|------|--------------|---------------|
| `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs` | 138, 139, 144, 146, 147 | T-39-08 |
| `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` | 138, 139, 144, 147, 148 | T-39-01 |
| `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs` | 147, 148 | T-39-01 |
| `plugins/delivery-pipeline/scripts/claude-role-host.cjs` | 140, 144 | T-39-12 |
| `plugins/delivery-pipeline/scripts/gsd-tune.cjs` | 148, 149d, (142 if it writes `.gitignore`) | T-39-07 |
| `plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs` | 148, 149c | — |
| `plugins/delivery-pipeline/scripts/state-sync.cjs` | 143, 149a | — |
| `plugins/delivery-pipeline/commands/deliver.md` | 138, 139 (prose), 140, 142 | T-39-03 |
| `plugins/delivery-pipeline/commands/investigate.md` | 146, 148 (C3), 149e | T-39-11 |
| `plugins/delivery-pipeline/commands/decompose.md` | 147, 149e, (142 untracked prose) | T-39-10 |
| `scripts/shipyard-doctor.cjs` | 144, 149f | T-39-04 |
| `tests/smoke/claude-hook-smoke.sh` | 144, 149f | T-39-04 |
| `Makefile` | 137, 141, 144, 145 | — |
| `README.md` | 137, 141, 144, 145 | T-39-04 |
| `tests/unit/claude-delivery-host.test.cjs` | 138, 139, 146, 147, 150 | — |
| `tests/unit/codex-delivery-host.test.cjs` | 138, 139, 148, 150 | T-39-01 |
| `tests/unit/codex-decompose-host.test.cjs` | 137, 147, 148 | T-39-01 |
| `tests/unit/codex-runtime-host.test.cjs` | 137, 148 (C5) | — |
| `tests/unit/claude-role-host.test.cjs` | 138 (signals pin), 140, 144 | T-39-12 |
| `tests/unit/planning-artifacts.test.cjs` | 146, 147 | T-39-08 |
| `tests/unit/gsd-tune.test.cjs` | 148, 149d | T-39-07 |

Files touched by exactly one requirement need no ordering inside phase 40.

### Requirement × requirement overlap (shared files; blank = disjoint)

| | 137 | 138 | 139 | 140 | 141 | 142 | 143 | 144 | 145 | 146 | 147 | 148 | 149 | 150 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **137** | | | | | MK | | | MK | MK | | cdh-t | cdh-t, crh-t | | |
| **138** | | | host×2, tests | dm, crole-t | | dm | | host×2 | | cdel, cdel-t | cdel, xdel | xdel, xdel-t | | cdel-t, xdel-t |
| **139** | | | | | | | | host×2 | | cdel | cdel, xdel | xdel | | cdel-t, xdel-t |
| **140** | | | | | | dm | | crole | | | | | | |
| **141** | | | | | | | | MK | MK | | | | | |
| **142** | | | | | | | | | | | dec? | tune? | tune?, dec? | |
| **143** | | | | | | | | | | | | | ss | |
| **144** | | | | | | | | | MK | cdel | cdel, xdel | xdel | doc | |
| **145** | | | | | | | | | | | | | | |
| **146** | | | | | | | | | | | cdel, pa-t | inv | inv | cdel-t |
| **147** | | | | | | | | | | | | xdec, xdel | dec | cdel-t |
| **148** | | | | | | | | | | | | | adapter, tune, inv | xdel-t |
| **149** | | | | | | | | | | | | | | |

Key: MK = `Makefile`/`README.md`; host×2 = both delivery hosts; cdel/xdel = Claude/Codex delivery host; xdec = `codex-decompose-host.cjs`; crole = `claude-role-host.cjs`; dm = `deliver.md`; inv/dec = `investigate.md`/`decompose.md`; tune = `gsd-tune.cjs`; ss = `state-sync.cjs`; doc = `shipyard-doctor.cjs` + hook smoke; adapter = `codex-dispatch-adapter.cjs`; `-t` suffix = the matching unit test; pa-t = `planning-artifacts.test.cjs`; cdh-t = `codex-decompose-host.test.cjs`; crh-t = `codex-runtime-host.test.cjs`; `?` = only if the planner picks that home for `.planning/` untracking.

## Recommended slicing and waves (disjoint `files_modified`)

Each slice lists its full file set. Slices sharing a file are chained by `depends_on` (a same-phase dependency that shares files satisfies the REQ-131 validator rule). Cross-phase dependencies are the T-39 ids.

| Slice | Requirement(s) | files_modified | Same-phase depends_on | Cross-phase depends_on |
|-------|----------------|----------------|-----------------------|------------------------|
| S1 | 150 | `tests/unit/run.sh`, `tests/unit/claude-delivery-host.test.cjs`, `tests/unit/codex-delivery-host.test.cjs`, NEW `tests/unit/test-hermeticity.test.cjs` | — | T-39-01 (codex-delivery-host.test.cjs). Option: split S1a (`run.sh` + scan test + claude-delivery-host.test) from main, S1b (codex-delivery-host.test) after T-39-01 |
| S2 | 149a | `state-sync.cjs`, NEW `tests/unit/state-sync-yaml.test.cjs`, backlog file | — | none |
| S3 | 149b | `scripts/shipyard-pre-push-gate.sh`, NEW `tests/unit/pre-push-gate.test.cjs` | — | none |
| S4 | 149c | `codex-agent.cjs`, `codex-model-remap.cjs`, `codex-dispatch-adapter.cjs`, `refusal-hints.cjs`, `tests/unit/codex-agent.test.cjs`, `tests/unit/refusal-hints.test.cjs` | — | T-39-01 |
| S5 | 149d | `gsd-tune.cjs`, `tests/unit/gsd-tune.test.cjs` | — | T-39-07 |
| S6 | 149e + prose for 146, 148-C3, 142 (decompose untracked warning inversion) | `commands/investigate.md`, `commands/decompose.md`, NEW `tests/unit/host-state-prose-contract.test.cjs` (avoid editing T-39-10/11 contract tests) | S13, S12c, S18a (prose follows code) | T-39-10, T-39-11 |
| S7 | 149f | `scripts/shipyard-doctor.cjs`, `tests/smoke/claude-hook-smoke.sh` | — | T-39-04 |
| S8 | 145 | `tests/unit/source-contract.test.cjs`, NEW `tests/unit/runtime-file-digests.json`, NEW `scripts/refresh-runtime-digests.cjs`, NEW `scripts/check-runtime-digest-trailer.cjs`, NEW `tests/unit/runtime-digests.test.cjs`, `.github/workflows/test.yml` | S1 (hermetic git fixture) optional | T-39-12 |
| S9 | 137 harness | NEW `scripts/capture-boundary-fixtures.cjs`, NEW `tests/fixtures/captured/registry.json`, NEW `tests/unit/boundary-fixtures.test.cjs`, moved Codex fixtures under `tests/fixtures/captured/`, `tests/unit/codex-runtime-host.test.cjs` (fixture path only) | — | none |
| S10 | 137 capture + Claude/decompose consumers | `tests/fixtures/captured/*.jsonl` (new captures), `tests/fixtures/captured/registry.json`, `tests/fixtures/claude-assistant-session.jsonl` (remove), `tests/unit/claude-runtime-host.test.cjs`, `tests/unit/claude-workflow-host.test.cjs` | S9 | T-39-12; human-action checkpoint for the capture |
| S11 | 147 | NEW `planning-result-sealer.cjs`, NEW `tests/unit/planning-result-sealer.test.cjs`, `claude-delivery-host.cjs`, `claude-decompose-host.cjs`, `codex-decompose-host.cjs`, `tests/unit/claude-decompose-host.test.cjs`, `tests/unit/codex-decompose-host.test.cjs`, `tests/unit/planning-artifacts.test.cjs`, backlog file | S1 | T-39-01, T-39-08 |
| S12a | 148 C4 | `codex-decompose-host.cjs`, `codex-dispatch-adapter.cjs`, `gsd-tune.cjs`, `tests/unit/codex-decompose-host.test.cjs`, `tests/unit/codex-dispatch-adapter.test.cjs`, `tests/unit/gsd-tune.test.cjs` | S11, S4, S5, S10 (real generated fixture) | T-39-01, T-39-07 |
| S12b | 148 C5 | `codex-runtime-host.cjs`, `tests/unit/codex-runtime-host.test.cjs` (+ re-captured Codex fixture) | S9 | none |
| S12c | 148 C3 + 147 Codex research consumer | `codex-delivery-host.cjs`, `tests/unit/codex-delivery-host.test.cjs` | S11, S1 | T-39-01 |
| S13 | 146 | `workflows/investigation-research.mjs`, `claude-delivery-host.cjs`, `planning-result-sealer.cjs`, `tests/unit/investigation-research.test.cjs`, `tests/unit/claude-delivery-host.test.cjs` | S11, S1 | T-39-08 |
| S14 | 138 host exports + 139 | `claude-delivery-host.cjs`, `codex-delivery-host.cjs`, `dispatch-record.cjs`, `tests/unit/dispatch-record.test.cjs`, `tests/unit/stop-gate.test.cjs`, `tests/unit/claude-delivery-host.test.cjs`, `tests/unit/codex-delivery-host.test.cjs` | S13, S12c | T-39-03, T-39-08, T-39-01 |
| S15 | 138 entry point | NEW `deliver-dispatch.cjs`, NEW `tests/unit/deliver-dispatch.test.cjs`, `run-waker.cjs`, `tests/unit/run-waker.test.cjs` | S14 | (via S14) |
| S16 | 140 | NEW `sentinel-preflight.cjs`, NEW `tests/unit/sentinel-preflight.test.cjs`, `claude-role-host.cjs`, `tests/unit/claude-role-host.test.cjs` | S1 | T-39-12 |
| S17 | 143 | `ticket-pr-match.cjs`, `state-sync.cjs`, `pipeline-stats.cjs`, `tests/unit/ticket-pr-match.test.cjs`, NEW PR-creation ledger helper [ASSUMED] | S2 | none |
| S18a | 142 core | NEW `pr-hygiene.cjs`, NEW `tests/unit/pr-hygiene.test.cjs`, `role-artifact.cjs`, `tests/unit/role-artifact.test.cjs`, `workflows/executors.mjs`, `delivery-commit-finalizer.cjs`, `tests/unit/delivery-commit-finalizer.test.cjs`, `epic-branch.sh` | — | none |
| S18b | 142 branches | `validate-graph.cjs`, `tests/smoke/graph-validator-smoke.sh`, `skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md` | S18a | T-39-06 |
| S18c | deliver prose for 138/139/140/142 | `commands/deliver.md`, NEW `tests/unit/deliver-seams-contract.test.cjs` | S15, S16, S18a | T-39-03 |
| S19 | 144 | NEW `scripts/install-shipyard-dogfood.sh`, NEW `host-provenance.cjs` + test, `claude-delivery-host.cjs`, `codex-delivery-host.cjs`, `claude-role-host.cjs`, `sentinel.cjs`, `scripts/shipyard-doctor.cjs`, `tests/smoke/claude-hook-smoke.sh` | S14, S16, S7 | T-39-04, T-39-08, T-39-01, T-39-12 |
| S20 | 141 | NEW `tests/fixtures/live-project/**`, NEW `tests/live/live-round.sh`, NEW `scripts/release.sh`, NEW `tests/unit/release-gate.test.cjs` | S15, S16, S12a, S12b, S12c, S13, S18c | phase 39 released (all T-39) |
| S21 | command surface for 137/141/144/145 | `Makefile`, `README.md`, `CLAUDE.md` (test list) | S8, S9, S19, S20 | T-39-04 (README) |

Where S1 touches `claude-delivery-host.test.cjs` and `codex-delivery-host.test.cjs` only to replace `/tmp` paths, it must land before S11/S12c/S13/S14 (shared test files).

Suggested waves: W1 = S1a, S2, S3, S9, S12b, S18a (no P39 dependency); W2 = S17, S4, S5, S7, S8, S16, S10, S11, S18b (cross-phase gated); W3 = S12a, S12c, S13; W4 = S14; W5 = S15, S19; W6 = S6, S18c; W7 = S20, S21. The actual start of W2 and later is gated by phase 39 reaching `main` (ADR-017 Consequences).

## Cross-phase map: phase-40 files in phase-39 `files_modified`

Source: `files_modified` of `.planning/phases/39-remove-conveyor-session-friction/39-NN-PLAN.md` read this session; plan `39-NN` is ticket `T-39-NN` (each plan's `delivery.ticket`). Merge state is from last-fetched refs.

| File | T-39 ticket(s) | T-39 state (last fetch) | Phase-40 requirement(s) |
|------|----------------|-------------------------|-------------------------|
| `plugins/delivery-pipeline/scripts/refusal-hints.cjs` | T-39-01 | in epic and HEAD | 149c |
| `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs` | T-39-01 | in epic and HEAD | 147 |
| `plugins/delivery-pipeline/scripts/claude-investigation-host.cjs` | T-39-01 | in epic and HEAD | 146 (only if CLI changes) |
| `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs` | T-39-01 | in epic and HEAD | 147, 148 |
| `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` | T-39-01 | in epic and HEAD | 138, 139, 144, 147, 148 |
| `tests/unit/refusal-hints.test.cjs` | T-39-01 | in epic and HEAD | 149c |
| `tests/unit/claude-decompose-host.test.cjs` | T-39-01 | in epic and HEAD | 147 |
| `tests/unit/claude-investigation-host.test.cjs` | T-39-01 | in epic and HEAD | 146 (only if CLI changes) |
| `tests/unit/codex-decompose-host.test.cjs` | T-39-01 | in epic and HEAD | 137, 147, 148 |
| `tests/unit/codex-delivery-host.test.cjs` | T-39-01 | in epic and HEAD | 138, 139, 148, 150 |
| `plugins/delivery-pipeline/scripts/stop-gate.cjs` | T-39-03 | unmerged branch | 139 (test-only expected) |
| `plugins/delivery-pipeline/commands/deliver.md` | T-39-03 | unmerged branch | 138, 139, 140, 142 |
| `tests/unit/stop-gate.test.cjs` | T-39-03 | unmerged branch | 139 |
| `tests/unit/dispatch-record.test.cjs` | T-39-03 | unmerged branch | 139 |
| `scripts/install-shipyard-claude-hook.sh` | T-39-04 | in epic and HEAD | 144 (only if dogfood needs hook wiring) |
| `scripts/install-shipyard-codex.sh` | T-39-04 | in epic and HEAD | none expected (read only for the manifest name) |
| `scripts/shipyard-doctor.cjs` | T-39-04 | in epic and HEAD | 144, 149f |
| `tests/smoke/claude-hook-smoke.sh` | T-39-04 | in epic and HEAD | 144, 149f |
| `tests/smoke/codex-shipyard-smoke.sh` | T-39-04 | in epic and HEAD | 149f (optional doctor assertion) |
| `README.md` | T-39-04 | in epic and HEAD | 137, 141, 144, 145 |
| `plugins/delivery-pipeline/scripts/validate-graph.cjs` | T-39-06 | in epic, not HEAD | 142 |
| `tests/smoke/graph-validator-smoke.sh` | T-39-06 | in epic, not HEAD | 142 |
| `plugins/delivery-pipeline/skills/delivery-rules/SKILL.md` | T-39-06 | in epic, not HEAD | 142 |
| `.shipyard/generated/gsd-delivery-rules/SKILL.md` | T-39-06 | in epic, not HEAD | 142 |
| `plugins/delivery-pipeline/scripts/gsd-tune.cjs` | T-39-07 | in epic, not HEAD | 148, 149d, (142) |
| `tests/unit/gsd-tune.test.cjs` | T-39-07 | in epic, not HEAD | 148, 149d |
| `plugins/delivery-pipeline/workflows/investigation-research.mjs` | T-39-08 | unmerged branch | 146 |
| `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs` | T-39-08 | unmerged branch | 138, 139, 144, 146, 147 |
| `tests/unit/planning-artifacts.test.cjs` | T-39-08 | unmerged branch | 146, 147 |
| `tests/unit/investigation-research.test.cjs` | T-39-08 | unmerged branch | 146 |
| `plugins/delivery-pipeline/commands/decompose.md` | T-39-10 | unmerged branch | 147, 149e, (142) |
| `tests/unit/decompose-friction-contract.test.cjs` | T-39-10 | unmerged branch | avoid (use a new contract test) |
| `plugins/delivery-pipeline/commands/investigate.md` | T-39-11 | unmerged branch | 146, 148, 149e |
| `tests/unit/investigate-friction-contract.test.cjs` | T-39-11 | unmerged branch | avoid (use a new contract test) |
| `plugins/delivery-pipeline/scripts/claude-runtime-host.cjs` | T-39-12 | unmerged branch | none directly (consumer tests only) |
| `tests/unit/claude-runtime-host.test.cjs` | T-39-12 | unmerged branch | 137 |
| `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs` | T-39-12 | unmerged branch | avoid (digest-pinned) |
| `tests/unit/claude-workflow-host.test.cjs` | T-39-12 | unmerged branch | 137 |
| `tests/unit/source-contract.test.cjs` | T-39-12 | unmerged branch | 145 |
| `plugins/delivery-pipeline/scripts/claude-role-host.cjs` | T-39-12 | unmerged branch | 140, 144 |
| `tests/unit/claude-role-host.test.cjs` | T-39-12 | unmerged branch | 138 (signals pin), 140 |

Phase-39 files with no phase-40 use: T-39-02 (`adr-ingest.cjs`, ADR template), T-39-05 (`jira-export.cjs`), T-39-09 (`adr-bootstrap.cjs`), `auto-route.cjs` (T-39-04), `stop-gate-arm.cjs` (T-39-03), `.gitignore` (T-39-03; relevant only if the planner makes this repo's `.gitignore` part of REQ-142, which it should not — Shipyard is exempt).

### Requirements that cannot be implemented without a phase-39 change landing first

| Requirement | Blocking T-39 | Why |
|-------------|---------------|-----|
| REQ-137 (S10) | T-39-12 | Claude consumer tests are T-39-12 files, and a real `--json-schema` capture is only representative after T-39-12 forwards the schema (INV-004 F2) |
| REQ-138 | T-39-08, T-39-01, T-39-03 | Host validator exports live in T-39-08/T-39-01 files; deliver prose in T-39-03 |
| REQ-139 | T-39-03, T-39-08, T-39-01 | The gate enforces only in a deliver-armed session (T-39-03); tests and hosts are T-39 files |
| REQ-140 | T-39-12, T-39-03 | `claude-role-host.cjs` and its test are T-39-12; Step 4 prose is T-39-03 |
| REQ-141 | all of phase 39 released | A live Claude round fails without T-39-12; ADR-017 Consequences place live acceptance after the phase 39 release |
| REQ-144 | T-39-04, T-39-08, T-39-01, T-39-12 | Doctor/smoke and all three hosts |
| REQ-145 | T-39-12 | T-39-12 itself changes the pinned digest in `source-contract.test.cjs` |
| REQ-146 | T-39-08 (and T-39-11 for prose) | Builds on the 500-character bound and the same files |
| REQ-147 | T-39-01, T-39-08 | All four host files |
| REQ-148 C3/C4 | T-39-01, T-39-07, T-39-11 | Host files, generated sandbox table, investigate prose |
| REQ-149 c, d, e, f | T-39-01; T-39-07; T-39-10 + T-39-11; T-39-04 | Same files |
| REQ-142 (S18b, deliver prose, `.planning/` untracking) | T-39-06, T-39-03, T-39-10 (and T-39-07/09 depending on the home) | Branch producer, prose, the REQ-133 warning |

Can start from `main` now: REQ-143, REQ-149a, REQ-149b, REQ-148 C5 (S12b), REQ-137 harness (S9), REQ-142 core (S18a), REQ-150 `run.sh` part (S1a).

## Architecture Patterns

### System architecture (data flow after phase 40)

```
                    .planning/graph/tickets.json  (branch, plan, type, risk)
                               │
  /shipyard:deliver ──► front.cjs computeFront ──► deliver-dispatch.cjs launch
                                                   │  map signals (no ticket type)
                                                   │  planPath = graphDir/../../plan
                                                   │  validate via host export
                                                   ▼
                           detached host process (claude-delivery-host | codex-delivery-host)
                              │ writes in-flight {pid, TTL} ──► dispatch-record.cjs
                              │                                    │
                              │                        activeDispatches ──► front.waiting.dispatched ──► stop-gate
                              ▼
                     ADR-014 boundary (resolve→validate→launch→receipt)   [unchanged]
                              │
                              ▼
                  shared sealer (research/decomposition/executor artifacts)
                              │ clears in-flight; orchestrator marks durable dispatch after receipt
                              ▼
   publish: pr-hygiene check (target projects) ──► git push ──► gh pr create ──► PR-creation ledger
                              │
   deliver-dispatch.cjs wait ◄── run-waker 'dispatch' events
                              │
   sentinel-preflight (fetch/ff base, state-sync, commit-or-refuse) ──► claude-role-host / codex sentinel
                              │
   state-sync ──► ticket-pr-match (ledger number → exact head → legacy marker)
```

### Pattern 1: host exports its own validator; the entry point never re-describes the schema
`claude-delivery-host.cjs` already validates the request strictly (`readRequest`, anchor A2) and the scoped work (`assertScopedWork`, :80-101). Export a pure `validateRequest(workflow, request)` and have the entry point call it before spawning. Tests round-trip through the real parse path (RISKS R6).

### Pattern 2: model the in-flight record on the existing sentinel reservation
`reserveRound` (dispatch-record.cjs:1463-1513) already writes a pre-launch reservation under `mutate(...)` with an id check, an `activeDispatches` conflict check, and a front refresh; `activeDispatches` already expires rows by `DISPATCH_TTL_MS`. Add the pid liveness check as the only new condition.

### Pattern 3: prose tickets after code tickets
Phase 39 kept `decompose.md`/`investigate.md` edits in their own tickets (T-39-10, T-39-11). Do the same for `deliver.md` (S18c) and `investigate.md`/`decompose.md` (S6), each with a new contract test that asserts the prose names the new scripts, so prose and code never share a ticket's `files_modified`.

### Anti-patterns to avoid
- **A second dispatch boundary:** the entry point must not resolve models or verify receipts itself; it calls the existing hosts (DECISIONS scope fence).
- **Widening `signals.type`:** adding `implementation` to `normalizeSignals` changes the frozen ADR-014 resolver input.
- **Stop gate reading process tables directly:** rejected in DECISIONS; the host writes the record.
- **Hand-flipping pinned tests:** `codex-decompose-host.test.cjs:103-106` pins `read-only`; replace the fixture with a generated agent file, do not just flip the string (INV-004 C-T10).
- **Editing `claude-dispatch-adapter.cjs` or `runtime-adapters.cjs` casually:** both are digest-pinned.

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Atomic JSON store with locking | ad-hoc `writeFileSync` | `lock.cjs` `withLock` + `writeAtomic` | Concurrent sessions share `.planning/graph` |
| Dispatch TTL | a new constant | `DISPATCH_TTL_MS` (dispatch-record.cjs:107-110) | One backstop, env override `SHIPYARD_DISPATCH_TTL_MS` |
| Graph/base resolution | cwd guessing | `graph-dir.cjs resolveGraphDir`, `resolveBaseRef` | Untracked `.planning/` makes worktrees graphless |
| Refusal remedy text | per-script strings | `refusal-hints.cjs` code→hint map (T-39-01) | ADR-016 single hint map |
| Waiting loops | `sleep` polling | `run-waker.cjs waitForWake` with a `dispatch` kind | Harness blocks long foreground sleeps |
| Branch names | a second slug function | `validate-graph.cjs branchFor` + `tickets.json` | One producer (INV-004 C-T8) |
| Artifact digests/index | new digest code | `role-artifact.cjs fileReference` shape `{path, bytes, content_bytes, sha256, digest}` | Same index shape across envelopes |
| Commit trailer parsing | regex per script | follow `gate-trailer.cjs` "last line wins" reader as a model [ASSUMED reuse fit] | Consistent trailer semantics |

## Runtime State Inventory

REQ-142/143 change the shape of live state in target projects (branch names, PR text, tracked `.planning/`), so this phase is partly a migration.

| Category | Items found | Action required |
|----------|-------------|-----------------|
| Stored data | Target projects' `.planning/graph/tickets.json` rows carry `branch: ticket/T-…`; `delivery-state.json` has `matched_by` and PR numbers learned by matching, not at creation | Code: new graphs get neutral branches; re-running decompose/validate rewrites `branch` for **unstarted** tickets only. Data: tickets with an open PR on a `ticket/T-…` branch must keep that branch (legacy match) — do not rename in flight |
| Live service config | Open GitHub PRs on target repos (for example proving-ground #702, #706) titled `T-NN-NN:` with `Ticket:` bodies; epic PRs titled `epic: … integration` | No automatic edit; they merge under the legacy fallback. Optional manual retitle |
| OS-registered state | Installed Claude hook copy `~/.claude/hooks/shipyard-pre-push-gate.sh` and stop-gate bundle; installed Codex agents/manifest | Reinstall after merge: `make install-shipyard-claude-hook`, `make install-shipyard-codex`, `make doctor` (ADR-017 Consequences) |
| Secrets/env vars | `SHIPYARD_DISPATCH_TTL_MS`, `SHIPYARD_GRAPH_DIR`, `SHIPYARD_PUBLISH_GATE`, `CODEX_HOME`, `CLAUDE_HOME` read by name | None renamed; new env names (dogfood root) are additive |
| Build artifacts / installed packages | Claude plugin cache `~/.claude/plugins/cache/shipyard/shipyard/0.61.0/scripts/` reported patched with T-39-12 files (INV-004; not observable in this sandbox); FlowPDF leftovers `.planning/graph/{receipts,transcripts}/codex/` | Doctor (REQ-144) reports the mismatch; restore the cache by reinstalling the release; clean FlowPDF leftovers before any FlowPDF acceptance run |
| Tracked `.planning/` in target projects | Proving ground tracks `.planning/` (epic → main #693 carried `.planning/phases/22-…`) | Migration step per target project: add `.planning/` to ignore and `git rm -r --cached .planning`, in a normal PR; the conveyor must then resolve the graph from the project checkout (already supported by `graph-dir.cjs`) |

## Common Pitfalls

### Pitfall 1: ticket `type` vs `signals.type`
**What goes wrong:** the resolver refuses `signals.type: "implementation"` (anchor A4).
**Why:** two vocabularies share the name `type`: the GSD plan kind in the graph (`validate-graph.cjs:160`) and the ADR-014 research evidence kind.
**How to avoid:** the entry point never copies ticket `type` into `signals`; `deliver.md` stops listing it; a test asserts a graph row with `type: implementation` produces a request whose signals lack `type`.
**Warning signs:** `UNSUPPORTED_SIGNAL` from `pipeline-config.cjs`.

### Pitfall 2: "plan path from the ticket worktree" vs untracked `.planning/`
**What goes wrong:** in target projects with untracked `.planning/` the ticket worktree has no plan file, so a literal `<worktree>/.planning/phases/…` path does not exist.
**Why:** `canonicalPlan` compares against `graphDirectory(options)/../../row.plan` (anchor A3), and `graphDirectory` defaults to `<cwd>/.planning/graph`.
**How to avoid:** compute `planPath` from the graph directory the host will read, and pass that graph directory explicitly (`SHIPYARD_GRAPH_DIR`) to the detached host so cwd cannot change the answer.
**Warning signs:** `workflow plan differs from the canonical graph`.

### Pitfall 3: detached launch loses the in-flight record's pid meaning
**What goes wrong:** a wrapper shell's pid is recorded instead of the Node host's, so the gate thinks the dispatch is alive after the host died (or vice versa).
**How to avoid:** the host process writes `process.pid` itself; the launcher uses `spawn(process.execPath, [host, …], { detached: true, stdio: ['ignore', out, err] }).unref()` with no intermediate shell.
**Warning signs:** stop gate silent with no host process running.

### Pitfall 4: editing a digest-pinned file
`claude-dispatch-adapter.cjs` holds the generic `REPAIR` text appended to every boundary failure (INV-004 item 7), and its digest is pinned (anchor A16). Fix line-specific research messages in the sealer/workflow, not in the adapter, unless the ticket also depends on S8 and uses the refresh path.

### Pitfall 5: "commit state-sync" when `.planning/` is untracked
In target projects `.planning/` becomes untracked (REQ-142), so there is nothing to commit and the "clean phase worktree" requirement (`deliver.md:2033`) must ignore untracked `.planning/`. The preflight must detect tracking (`git ls-files --error-unmatch .planning/graph/delivery-state.json`) and only commit when tracked (the Shipyard repo tracks it: `git ls-files .planning/graph` lists `delivery-state.json` this session).

### Pitfall 6: the host-finalized commit leaks the ticket id
`delivery-commit-finalizer.cjs:185` writes `(${ticket}): finalize scoped changes` (anchor A10). A clean PR title and body still show `(T-40-03): …` in the commit list and possibly in the squash commit body. Include commit subjects in the hygiene check.

### Pitfall 7: REQ-133 (phase 39) points the other way
T-39-10 makes decompose warn "when `.planning/` is not tracked by git, naming the consequence for delivery worktrees" (REQUIREMENTS.md REQ-133). REQ-142 makes untracked the target-project norm. The decompose prose and any warning must be reconciled (target projects: untracked is expected; the graph resolves through `graph-dir.cjs`). This is a cross-phase behavioural conflict the planner must resolve explicitly (Open question 1).

### Pitfall 8: branch collisions once the id leaves the branch name
`<type>/<slug>` from a 40-character slug can collide between tickets and across workspaces delivering into one repo (`ticket-pr-match.cjs` header notes colliding ids across workspaces). Add a validator error for duplicate branches in one graph, and keep the recorded PR number as the primary match key.

### Pitfall 9: `gate_status:` trailer in PR bodies
`sentinel.cjs merge` requires the `gate_status:` trailer written into the PR body by `gate-trailer.cjs`. A hygiene rule "no conveyor terms in body" would reject it, and removing it breaks the merge gate. Decide whether the trailer is allowed text or moves to another carrier (Open question 3).

### Pitfall 10: provenance "in receipts" vs frozen receipt shape
REQ-144 says "stamps receipts with host source sha and dirty flag", while ADR-017 "Out of scope" freezes "the receipt shape". `finalizeApplicationReceipt` (dispatch-boundary.cjs:1480-) records policy/dispatch/launch identity only. Put provenance in a sidecar keyed by `dispatch_id` (host result, dispatch journal, in-flight record), not in the ADR-014 application receipt (Open question 4).

### Pitfall 11: gpg socket path length after moving off `/tmp`
`claude-delivery-host.test.cjs` creates `GNUPGHOME` under `/tmp/crh-*` and generates keys with `gpg --quick-generate-key`. gpg-agent sockets live in `GNUPGHOME` unless redirected, and Unix socket paths are limited (about 104 bytes on macOS) [ASSUMED limit]. `os.tmpdir()` on macOS is `/var/folders/…/T/` (longer). Keep the directory name short, and test on the host.

### Pitfall 12: pre-push payload `cwd` is the session cwd, not the push directory
For `cd /other; git push`, Claude's hook payload `cwd` is the session directory, so `git rev-parse --show-toplevel` on it gates the wrong repository. Resolving "through git" still needs a trustworthy directory. Options: keep `-C <literal absolute path>` parsing only when the path exists and is a git worktree, otherwise fail closed with a remedy; or install a real `pre-push` git hook (`core.hooksPath`) where git supplies the repository. Record the choice in the plan.

### Pitfall 13: gsd-tune `models.*` is "Claude-only" per evidence but "tier alias" per code
`gsd-tune.cjs:573-574` says `models.*` "stay because they are TIER aliases, meaningful on both runtimes", and `GLOBAL_SAFE` includes them (:575-579); the FlowPDF evidence (C2) calls them Claude-only keys, and ADR-017 requires Codex tune to write none. Gate the `models.*` rows (and `workflow.use_worktrees` if confirmed) on `runtime === 'claude'`, and update the comment block without adding new comment lines (Open question 6).

## Code Examples

These are skeletons for the planner. New identifiers are proposals and tagged `[ASSUMED]`; existing values are quoted in Verbatim anchors.

### 1. Map a graph row to a Claude executor request (entry point)
```javascript
const path = require('node:path');
const { REQUEST_SCHEMA } = require('./claude-delivery-host.cjs');

function executorRequest(graphDir, id, row, scope, selection) {
  const signals = { risk: row.risk };
  if (row.human_checkpoint === true) signals.checkpoint = true;
  return {
    schema: REQUEST_SCHEMA,
    scope,
    args: {
      tickets: [{
        id,
        branch: row.branch,
        planPath: path.resolve(graphDir, '..', '..', row.plan),
        worktreePath: scope.worktree,
        model: selection.model,
        effort: selection.effort,
        signals,
      }],
    },
  };
}
```
`REQUEST_SCHEMA` is `'shipyard.claude-delivery-request.v1'` (A2); allowed request keys are exactly `schema, scope, args` (A2); `risk` values and `checkpoint` are accepted signals (A4). The `args.tickets[]` field names beyond `id`, `worktreePath` (A1) and `planPath` (A3) are `[ASSUMED]` and must be checked against `workflows/executors.mjs` args before use.

### 2. In-flight record liveness (dispatch-record.cjs)
```javascript
function inflightLive(rec, now) {
  const at = Date.parse(rec.started_at || '');
  if (!Number.isFinite(at) || now - at >= DISPATCH_TTL_MS) return false;
  if (!Number.isSafeInteger(rec.pid) || rec.pid <= 0) return false;
  try { process.kill(rec.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
```
`DISPATCH_TTL_MS` is the existing constant (A12). Field names `started_at`, `pid` are `[ASSUMED]`. `EPERM` means the process exists but belongs to another user; treat as live only if the planner accepts that (otherwise return false to fail closed).

### 3. Hermetic git environment in `tests/unit/run.sh`
```bash
HERMETIC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shipyard-unit.XXXXXX")"
trap 'rm -rf "$HERMETIC_DIR"' EXIT
export GIT_CONFIG_GLOBAL="$HERMETIC_DIR/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.name 'Shipyard Unit'
git config --file "$GIT_CONFIG_GLOBAL" user.email unit@example.com
git config --file "$GIT_CONFIG_GLOBAL" commit.gpgsign false
git config --file "$GIT_CONFIG_GLOBAL" tag.gpgsign false
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
```
Pattern taken from `tests/smoke/worktree-smoke.sh:21-26` and `reachability-smoke.sh:9-14` (same `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` approach, verified by grep this session). Tests that deliberately sign must keep passing their own `-c` config and `GNUPGHOME`.

### 4. PR hygiene applicability (exempt only the Shipyard repository)
```javascript
const fs = require('node:fs');
const path = require('node:path');

function applies(projectRoot) {
  const manifest = path.join(projectRoot, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json');
  try { return JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== 'shipyard'; } catch { return true; }
}
```
`"name": "shipyard"` is quoted in A20. Fail-closed default: any unreadable manifest means hygiene applies.

## State of the Art

| Old approach | Current approach (this phase) | Impact |
|--------------|-------------------------------|--------|
| Model assembles `shipyard.claude-delivery-request.v1` from `deliver.md` prose | `deliver-dispatch.cjs` builds and validates requests | `deliver.md` shrinks; hand-built request class disappears |
| Dispatch visible to the stop gate only after the receipt | Host-issued in-flight record with pid + TTL | No stop-gate interruptions during in-flight work |
| Consumer-authored fixtures (`claude-assistant-session.jsonl`, inline `spawn:` stubs) | Captured, scrubbed, versioned fixtures + contract test | Boundary drift becomes visible |
| `Ticket: <T>` first body line and `<T>: ` title as matching anchors | Exact head branch + PR number recorded at creation; marker only for legacy | Clean target-project PRs |
| Hand-edited digest pin | `make refresh-runtime-digests` + CI-verified trailer | Deliberate, reviewable pin changes |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A-1 | New file/script names (`deliver-dispatch.cjs`, `sentinel-preflight.cjs`, `pr-hygiene.cjs`, `planning-result-sealer.cjs`, `capture-boundary-fixtures.cjs`, `host-provenance.cjs`, `refresh-runtime-digests.cjs`, `release.sh`, `tests/live/…`, `tests/fixtures/live-project/`, `tests/fixtures/captured/registry.json`) | Requirement map | Cosmetic; planner may rename |
| A-2 | `stop-gate.cjs` needs no code change for REQ-139 because it reads `front.waiting.dispatched` built from `activeDispatches` | REQ-139 | A code change in a T-39-03 file would be needed |
| A-3 | Shipyard exemption detected by the plugin manifest name | REQ-142 | A config key alternative lets target projects opt out |
| A-4 | macOS Unix socket path limit ~104 bytes affects gpg-agent in moved `GNUPGHOME` | Pitfall 11 | Tests fail only on some hosts |
| A-5 | Codex CLI records the child's first message in the child session file so a digest can be verified | REQ-148 C5 | If not, the launch must be refused (RISKS R12) |
| A-6 | Codex sandbox cannot scope writes to one path; post-run `git status` containment is needed | REQ-148 C4 | If path-scoped writes exist, a simpler config suffices |
| A-7 | `tests/unit/workflows-args.test.cjs` covers executor args | REQ-142 | Planner must pick another test home |
| A-8 | `args.tickets[]` fields other than `id`, `worktreePath`, `planPath` | Code example 1 | Request refused by the host |
| A-9 | Phase 39 merge state (only last-fetched refs; fetch failed) | Current state; cross-phase table | Some "unmerged" tickets may have merged since |
| A-10 | The cheapest allowed live model is whatever the ADR-014 grid floor is per role (no cheaper override) | REQ-141 | A cheaper model would require an ADR-014 change (out of scope) |

## Open Questions

1. **Who makes `.planning/` untracked in target projects, and how does REQ-133 (T-39-10) change?**
   - Known: REQ-133 warns when `.planning/` is untracked; REQ-142 wants it untracked; `graph-dir.cjs` already supports graphless worktrees.
   - Unclear: the writer (gsd-tune apply, decompose bootstrap, or a documented one-time migration) and whether the REQ-133 warning is inverted for target projects.
   - Recommendation: decompose prose (S6) states untracked is the target norm and the warning fires only for the Shipyard repo; a one-time migration command is documented; no automatic `.gitignore` writes by the conveyor. Needs user confirmation.
2. **Epic branch naming.** `validate-graph.cjs:508` derives `epic/${t.phaseDir}` (contains the phase directory, for example `epic/22-batched-text-replacement`), and epic PRs merge into the target default branch. Is the epic branch in scope of "branches `<type>/<slug>`"? Recommendation: yes for target projects (for example `release/<slug>` or `feat/<slug>`), neutral epic PR title/body; confirm.
3. **`gate_status:` trailer in PR bodies** (Pitfall 9). Recommendation: allow a neutral trailer key without conveyor words, or move the verdict to a commit status; confirm before S18a finalizes the forbidden-term list.
4. **Provenance location** (Pitfall 10). Recommendation: sidecar keyed by `dispatch_id`, not the ADR-014 receipt.
5. **"Cheapest allowed model" for the live round.** The grids fix executor Sonnet/max (Claude) and Luna/max (Codex); a cheaper model would be an ADR-014 change. Recommendation: use the grid floor per role; the live round's cost is accepted.
6. **Are `models.*` Claude-only?** Code comment says tier aliases valid on both runtimes; ADR says Codex tune writes no Claude-only keys. Recommendation: gate on `runtime === 'claude'` per the ADR and the FlowPDF evidence.
7. **Fresh live receipt: stored where, and how fresh?** Recommendation: `.planning/` at HEAD has only `architecture/ backlog/ graph/ investigations/ phases/` (`ls -d .planning/*/`), so there is no existing measurements location for a machine-local receipt; pick a path under the host state dir (`~/.local/state/shipyard/live/`) keyed by version + tree sha, max age 7 days; confirm.
8. **Commit subjects in hygiene scope.** ADR names title, body, branch, diff paths. Recommendation: include commit subjects (Pitfall 6).

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | all scripts/tests | ✓ | v24.10.0 (CI 24.15.0) | — |
| bash | installers, smoke | ✓ | 3.2.57 | — |
| git | fixtures, preflight | ✓ | 2.54.0 | — |
| gpg | signed-commit unit tests | ✓ | `/usr/local/bin/gpg` | — |
| gh | publication, state-sync, `make test-releases` | ✓ binary; ✗ config readable in this sandbox | — | Run outside the sandbox |
| jq | optional | ✓ | `/usr/bin/jq` | — |
| codex CLI | REQ-137 capture, REQ-141 live, `make test-codex-shipyard` | ✓ binary (`/opt/homebrew/bin/codex`; version probe blocked by sandbox PATH aliasing warning) | — | Human-run capture/live steps |
| claude CLI | REQ-137 capture, REQ-141 live | ✗ not on the sandbox PATH | — | Human-run capture/live steps outside the sandbox |
| Network to GitHub | fetch, `gh`, npm (`test-codex-shipyard`) | ✗ in this sandbox (`git fetch` broken pipe) | — | Operator runs network targets |

**Missing with no fallback inside the sandbox:** live CLI rounds and captures (REQ-137 capture step, REQ-141) — plan them as `checkpoint:human-action` steps.

## Validation Architecture

`workflow.nyquist_validation: true` and `tdd_mode: true` in `.planning/config.json`: every slice writes its failing test first.

### Test framework
| Property | Value |
|----------|-------|
| Framework | in-repo `tests/unit/assert-harness.cjs`, run as `node tests/unit/<name>.test.cjs`; bash smoke scripts |
| Config file | none; `tests/unit/run.sh` runs all unit tests after `node --check`/`bash -n` syntax checks |
| Quick run command | `node tests/unit/<touched>.test.cjs` per touched test file |
| Full suite command | `make test-fast` (CI parity); `make test` adds network targets |

### Phase requirements → test map
| Req | Behavior | Type | Automated command | File exists? |
|-----|----------|------|-------------------|--------------|
| REQ-137 | registry fixtures exist, scrubbed, consumers load them | unit/contract | `node tests/unit/boundary-fixtures.test.cjs` | ❌ Wave 0 |
| REQ-137 | Claude consumer replays captured stream | unit | `node tests/unit/claude-runtime-host.test.cjs && node tests/unit/claude-workflow-host.test.cjs` | ✅ (migrate) |
| REQ-138 | request built from graph, no ticket type in signals, host validator round-trip | unit | `node tests/unit/deliver-dispatch.test.cjs` | ❌ Wave 0 |
| REQ-138 | `dispatch` wait kind | unit | `node tests/unit/run-waker.test.cjs` | ✅ |
| REQ-139 | in-flight silences armed gate; dead pid/TTL fail closed | unit | `node tests/unit/dispatch-record.test.cjs && node tests/unit/stop-gate.test.cjs` | ✅ (extend) |
| REQ-140 | fetch failure refuses; ff + state-sync + commit or refusal naming command | unit | `node tests/unit/sentinel-preflight.test.cjs && node tests/unit/claude-role-host.test.cjs` | ❌ / ✅ |
| REQ-141 | release refuses without fresh passing receipt | unit | `node tests/unit/release-gate.test.cjs` | ❌ Wave 0 |
| REQ-141 | live round per runtime | manual (credentials) | `make test-live` | ❌ manual-only |
| REQ-142 | title/body/branch/paths/commits hygiene; Shipyard exempt | unit | `node tests/unit/pr-hygiene.test.cjs && node tests/unit/role-artifact.test.cjs && node tests/unit/delivery-commit-finalizer.test.cjs` | ❌ / ✅ |
| REQ-142 | neutral branch in graph, duplicate-branch error | smoke | `./tests/smoke/graph-validator-smoke.sh` | ✅ (extend) |
| REQ-143 | recorded number first, legacy marker fallback, rename case | unit | `node tests/unit/ticket-pr-match.test.cjs` | ✅ (extend) |
| REQ-144 | provenance stamp; dogfood merge refusal; doctor cache mismatch | unit/smoke | `node tests/unit/host-provenance.test.cjs && ./tests/smoke/claude-hook-smoke.sh` | ❌ / ✅ |
| REQ-145 | refresh rewrites digests; trailer checker rejects unannotated change | unit | `node tests/unit/runtime-digests.test.cjs && node tests/unit/source-contract.test.cjs` | ❌ / ✅ |
| REQ-146 | failed line named, valid lines kept, fan-out failed until four | unit | `node tests/unit/investigation-research.test.cjs && node tests/unit/claude-delivery-host.test.cjs` | ✅ (extend) |
| REQ-147 | research and decomposition envelopes with artifact index | unit | `node tests/unit/planning-result-sealer.test.cjs && node tests/unit/claude-decompose-host.test.cjs && node tests/unit/codex-decompose-host.test.cjs` | ❌ / ✅ |
| REQ-148 | researcher write contained; task file digest verified | unit | `node tests/unit/codex-decompose-host.test.cjs && node tests/unit/codex-dispatch-adapter.test.cjs && node tests/unit/codex-runtime-host.test.cjs` | ✅ (rewrite pins) |
| REQ-148 | generated Codex bundle parity | integration (network) | `make test-codex-shipyard` | ✅ |
| REQ-149a | YAML header-free and deterministic | unit/smoke | `node tests/unit/state-sync-yaml.test.cjs && ./tests/smoke/sentinel-smoke.sh` | ❌ / ✅ |
| REQ-149b | worktree resolved via git; fail closed | unit | `node tests/unit/pre-push-gate.test.cjs` | ❌ Wave 0 |
| REQ-149c | config refusal names `model_profile`/gsd-tune fix | unit | `node tests/unit/codex-agent.test.cjs && node tests/unit/refusal-hints.test.cjs` | ✅ |
| REQ-149d | Codex tune writes no Claude-only keys | unit | `node tests/unit/gsd-tune.test.cjs` | ✅ |
| REQ-149e | prose explains host state dir | contract | `node tests/unit/host-state-prose-contract.test.cjs` | ❌ Wave 0 |
| REQ-149f | doctor reads agents manifest | smoke | `./tests/smoke/claude-hook-smoke.sh` | ✅ |
| REQ-150 | no `/tmp` mkdtemp; hermetic git env | unit/contract | `node tests/unit/test-hermeticity.test.cjs && ./tests/unit/run.sh` | ❌ Wave 0 |
| all | comment policy on added lines | gate | `make test-comment-policy` | ✅ |

### Sampling rate
- **Per task commit:** the ticket's scoped `node tests/unit/<file>.test.cjs` commands plus `make test-comment-policy`.
- **Per wave merge:** `make test-fast`.
- **Phase gate:** `make test-fast` green; `make test` (network) run by the operator; `make install-shipyard-claude-hook && make install-shipyard-codex && make doctor`; then `make test-live` after phase 39 is released.

### Wave 0 gaps
- [ ] `tests/unit/boundary-fixtures.test.cjs` — REQ-137
- [ ] `tests/unit/deliver-dispatch.test.cjs` — REQ-138
- [ ] `tests/unit/sentinel-preflight.test.cjs` — REQ-140
- [ ] `tests/unit/release-gate.test.cjs` — REQ-141
- [ ] `tests/unit/pr-hygiene.test.cjs` — REQ-142
- [ ] `tests/unit/host-provenance.test.cjs` — REQ-144
- [ ] `tests/unit/runtime-digests.test.cjs` — REQ-145
- [ ] `tests/unit/planning-result-sealer.test.cjs` — REQ-147
- [ ] `tests/unit/state-sync-yaml.test.cjs`, `tests/unit/pre-push-gate.test.cjs`, `tests/unit/host-state-prose-contract.test.cjs` — REQ-149
- [ ] `tests/unit/test-hermeticity.test.cjs` — REQ-150
- New tests that create git repositories must use the hermetic pattern (Code example 3) and `os.tmpdir()`.

## Security Domain

`security_enforcement: true`, ASVS level 1, block on high.

### Applicable ASVS categories
| ASVS category | Applies | Standard control |
|---------------|---------|------------------|
| V2 Authentication | no (uses CLI subscriptions; no new auth) | — |
| V3 Session management | no | — |
| V4 Access control | yes | Researcher write scope limited to the artifact path (REQ-148); dogfood hosts refused for default-branch merges (REQ-144); digest pin changes require a CI-verified trailer (REQ-145) |
| V5 Input validation | yes | Strict request validation reused from hosts; safe branch/ref grammar (`safeBranch`, `parseOriginBase`); bounded file reads (lstat, size caps, no symlinks) as in `sealPlanningResearch` |
| V6 Cryptography | yes (hashing only) | `node:crypto` sha256 for task digests, fixture provenance, digest pins — never custom hashing |
| V8 Data protection | yes | Fixture scrubbing of home paths, tokens and session ids before commit (REQ-137, RISKS R2) |
| V12 Files and resources | yes | Request/task files mode 0600 outside the model-writable tree; host state stays out of the worktree (`INVALID_STATE_DIR`) |

### Known threat patterns
| Pattern | STRIDE | Mitigation |
|---------|--------|-----------|
| Agent silences the stop gate with a forged in-flight record | Spoofing | Record written by the host process; pid liveness + TTL; reader drops invalid rows |
| Agent rewrites the digest pin | Tampering | Refresh script + commit trailer checked in CI; test still fails on unannotated change |
| Truncated task relayed to a Codex child | Tampering | Task by file path + sha256 verified in child evidence; refuse when unverifiable |
| Researcher writes product code | Elevation | Post-run containment check or host materialization |
| Unreleased host code produces "verified" work merged to main | Repudiation | Provenance sidecar; dogfood merge refusal; doctor cache mismatch report |
| Secrets or private paths in committed fixtures | Information disclosure | Scrub step + scrub contract test |
| Command injection through branch names in `git`/`gh` calls | Tampering | `execFileSync` argument arrays (no shell), existing `safeBranch`/`BRANCH_RE` grammar |

## Verbatim anchors (source-of-truth quotes read with `Read` this session)

A1 `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs:86-95`
DATA_t9Gf1JqE_START
  const entries = name === 'executors' || name === 'drift-gate' ? args.tickets
    : name === 'fix-round' ? args.prs : null;
  if (Array.isArray(entries)) {
    if (entries.length > 1) reject('one scoped runtime host may launch only one ticket or PR');
    for (const entry of entries) {
      if (!object(entry) || entry.id !== scope.ticket
          || path.resolve(entry.worktreePath || '') !== path.resolve(scope.worktree || '')) {
DATA_t9Gf1JqE_END

A2 `claude-delivery-host.cjs:19` and `:881-882`
DATA_b2Lw6XuA_START
const REQUEST_SCHEMA = 'shipyard.claude-delivery-request.v1';
  if (!object(request) || request.schema !== REQUEST_SCHEMA || !object(request.scope)
      || !object(request.args) || Object.keys(request).some((key) => !['schema', 'scope', 'args'].includes(key))) {
DATA_b2Lw6XuA_END

A3 `claude-delivery-host.cjs:214-219`
DATA_m8Ck3PzR_START
function canonicalPlan(options, row, entry) {
  const expected = path.resolve(graphDirectory(options), '..', '..', row.plan || '');
  if (typeof row.plan !== 'string' || !row.plan.trim()
      || typeof entry.planPath !== 'string' || !fs.existsSync(entry.planPath)
      || fs.realpathSync(entry.planPath) !== expected) {
    reject('workflow plan differs from the canonical graph');
DATA_m8Ck3PzR_END

A4 `plugins/delivery-pipeline/scripts/model-policy-internal.cjs:421-423, 427-428, 437, 440-441`
DATA_h5Yv7QnD_START
  if (hasOwn(signals, 'type')) {
    if (!['facts', 'alternatives'].includes(signals.type)) {
      refuse('UNSUPPORTED_SIGNAL', `signals.type ${JSON.stringify(signals.type)} is not facts or alternatives`, { signal: 'type' });
  if (hasOwn(signals, 'complexity')) {
    if (!['normal', 'very-complex'].includes(signals.complexity)) {
  for (const name of ['critical', 'checkpoint', 'contested']) {
  if (hasOwn(signals, 'risk')) {
    if (!['low', 'medium', 'high'].includes(signals.risk)) {
DATA_h5Yv7QnD_END

A5 `plugins/delivery-pipeline/scripts/run-waker.cjs:15`
DATA_r1Ft4KsW_START
const WAIT_KINDS = new Set(['ci', 'review', 'quota', 'lease', 'host']);
DATA_r1Ft4KsW_END

A6 `plugins/delivery-pipeline/scripts/claude-role-host.cjs:173-178, 187`
DATA_w6Ja0MeB_START
    try {
      command(options, 'git', ['-C', worktree, 'fetch', '--no-tags', 'origin',
        `+refs/heads/${name}:refs/remotes/origin/${name}`], worktree, 65536);
    } catch {
      if (expectedOid === undefined) reject(`cannot refresh live base branch ${safe}`, 'BASE_REVISION_UNAVAILABLE');
    }
  reject(`base branch ${safe} is missing or differs from its live GitHub revision`, 'BASE_REVISION_UNAVAILABLE');
DATA_w6Ja0MeB_END

A7 `claude-delivery-host.cjs:515, 561`
DATA_c3Ux5RgT_START
    reject('planning research has invalid scope or result');
  const envelope = Object.freeze({ schema: 'shipyard.research-result.v1', version: 1,
DATA_c3Ux5RgT_END

A8 `plugins/delivery-pipeline/scripts/validate-graph.cjs:83-86, 160, 174`
DATA_n7Hp2VdL_START
function branchFor(id, title) {
  const slug = slugify(title);
  return slug ? `ticket/${id}-${slug}` : `ticket/${id}`;
}
    type: fm.type ?? 'implementation',
    branch: delivery.branch || branchFor(id, title),
DATA_n7Hp2VdL_END

A9 `plugins/delivery-pipeline/scripts/role-artifact.cjs:402-405`
DATA_e9Qb6ZkS_START
function assertTicketMarker(content, ticket) {
  const firstLine = content.toString('utf8').split(/\r?\n/, 1)[0];
  if (firstLine !== `Ticket: ${ticket}`) {
    fail('PR_BODY_MARKER', 'PR body must begin with the authenticated ticket marker', {
DATA_e9Qb6ZkS_END

A10 `plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:184-185`
DATA_g4Mr8YtC_START
    const commit = git(root, ['commit-tree', '-S', tree, '-p', head], privateEnv, {
      input: `(${ticket}): finalize scoped changes\n`,
DATA_g4Mr8YtC_END

A11 `plugins/delivery-pipeline/scripts/epic-branch.sh:347-349`
DATA_s2Dk7NwF_START
    gh pr create --base "$base" --head "$epic" --draft \
      --title "epic: ${epic#epic/} integration" \
      --body "$(printf 'Integration branch for the %s epic.\n\nAll ticket PRs in this phase stack into this branch; this PR merges the whole phase into %s once every ticket is green and integrated.\n\nEpic: %s' "${epic#epic/}" "$base" "$epic")" 1>&2
DATA_s2Dk7NwF_END

A12 `plugins/delivery-pipeline/scripts/dispatch-record.cjs:107, 110`
DATA_y5Tz1LhP_START
const TTL_RAW = Number(process.env.SHIPYARD_DISPATCH_TTL_MS || 90 * 60 * 1000);
const DISPATCH_TTL_MS = Number.isFinite(TTL_RAW) && TTL_RAW > 0 ? TTL_RAW : 90 * 60 * 1000;
DATA_y5Tz1LhP_END

A13 `plugins/delivery-pipeline/scripts/gsd-sync.cjs:870`
DATA_a8Xe3BqM_START
    `- Ticket: ${plan.ticket}`,
DATA_a8Xe3BqM_END

A14 `plugins/delivery-pipeline/scripts/ticket-pr-match.cjs:44-56`
DATA_u6Pn9CjV_START
function hasIdMarker(id, pr) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w-])${esc}([^\\w-]|$)`);
  return re.test(pr.title || '') || String(pr.headRefName || '').startsWith(`ticket/${id}-`);
}
function matchTicketPr(id, ticket, prs) {
  const exact = prs
    .filter((p) => p.headRefName === ticket.branch)
DATA_u6Pn9CjV_END

A15 `plugins/delivery-pipeline/scripts/comment-policy.cjs:8-11`
DATA_f1Kw4GsR_START
const MAX_MARKER_LENGTH = 120;
const MARKER_PATTERN = /^@(invariant|security|contract)\s*:/i;
const HISTORY_PATTERN =
  /(?:\b(?:todo|fixme|hack|workaround|temporary|ticket|issue|pull request|commit|history|legacy|previously|because)\b|#\d+\b|\b(?:adr|myd|pdf)-?\d+\b)/i;
DATA_f1Kw4GsR_END

A16 `tests/unit/source-contract.test.cjs:1986-1989`
DATA_j7Bd2TyN_START
const RUNTIME_OWNED_FILE_DIGESTS = Object.freeze({
  'plugins/delivery-pipeline/scripts/runtime-adapters.cjs': '949748da1bccd51704f9a7382cce5a93b1c58f7acfea21f2ffffe315831a05e5',
  'plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs': '95dde3dde56c8348274497901c2300f380a6ca0c9d2c3677a0c05224c02411f4',
});
DATA_j7Bd2TyN_END

A17 `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:18-22, 73`
DATA_v3Sm6HxQ_START
const ROLES = Object.freeze({
  'gsd-phase-researcher': Object.freeze({ role: 'research', sandbox: 'read-only' }),
  'gsd-planner': Object.freeze({ role: 'decomposition', sandbox: 'workspace-write' }),
  'gsd-plan-checker': Object.freeze({ role: 'decomposition', sandbox: 'read-only' }),
});
function defaultRunStoreDir(scope, stateRoot = path.join(os.homedir(), '.local', 'state', 'shipyard', 'codex-decompose')) {
DATA_v3Sm6HxQ_END

A18 `plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs:98-99`
DATA_z9Lc5FpK_START
  const expectedSandbox = selection.sandbox_mode
    || (gsdRole === 'gsd-phase-researcher' || gsdRole === 'gsd-plan-checker' ? 'read-only' : 'workspace-write');
DATA_z9Lc5FpK_END

A19 `plugins/delivery-pipeline/scripts/gsd-tune.cjs:116, 593, 606-609`
DATA_i4Rq8WdU_START
      sandbox: ['research', 'arch-review', 'drift-check'].includes(role) ? 'read-only' : 'workspace-write',
  ...(runtime === 'claude'
  ['models.planning', 'opus', 'planning is judgment; it is never cheapened'],
  ['models.execution', 'opus', 'the writer agent'],
  ['models.research', 'sonnet', 'fact gathering, not option design'],
  ['models.verification', 'sonnet', 'mechanical reconciliation against the plan'],
DATA_i4Rq8WdU_END

A20 `plugins/delivery-pipeline/.claude-plugin/plugin.json:2,4` (read with `head -8` this session)
DATA_o2Nv7JzE_START
  "name": "shipyard",
  "version": "0.61.0",
DATA_o2Nv7JzE_END

A21 `plugins/delivery-pipeline/scripts/codex-runtime-host.cjs:877-880`
DATA_Qx4m8RtL_START
        ? 'Call spawn_agent exactly once with agent_type ' + agent.role
          + ', model ' + model + ', reasoning_effort ' + effort
          + ', fork_turns none, and task_name gsd_task. Give that child this exact task:\n'
          + launchPrompt(prompt) + '\nWait for that child to finish. Do not perform the task yourself.'
DATA_Qx4m8RtL_END

A22 `plugins/delivery-pipeline/scripts/state-sync.cjs:961, 1122-1125`
DATA_Wd7k2NpZ_START
const yaml = ['# generated by state-sync.cjs from live GitHub state — do not edit'];
  writeAtomic(path.join(GRAPH_DIR, 'delivery-state.yaml'), [
    yaml[0],
    `# snapshot generation ${generation} — observed ${OBSERVED_AT}`,
    ...yaml.slice(1),
DATA_Wd7k2NpZ_END

A23 `scripts/shipyard-pre-push-gate.sh:12, 14-15, 18`
DATA_Hy3c9VbM_START
    const cwd = String(payload.cwd || process.cwd());
    const path = command.match(/(?:^|[;&|]\s*)git\s+-C\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|(\S+))/);
    const cd = command.match(/(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|(\S+))/);
      worktree: path?.[1] || path?.[2] || path?.[3] || cd?.[1] || cd?.[2] || cd?.[3] || cwd,
DATA_Hy3c9VbM_END

A24 `plugins/delivery-pipeline/scripts/codex-model-remap.cjs:12` and `codex-agent.cjs:20-21`
DATA_Lp6t1XsQ_START
const REPAIR = 'Install an ADR-014-capable Codex host and regenerate agents with install-shipyard-codex.sh --phase 2; provide current host capabilities and retry the exact selection.';
function fail(message, code = 'INVALID_INPUT') {
  throw policy.policyError(code, message + '. ' + REPAIR);
DATA_Lp6t1XsQ_END

A25 `scripts/shipyard-doctor.cjs:210-213`
DATA_Rb8n4KwE_START
  const codexBundle = path.join(codexHome, 'shipyard');
  const manifestFile = path.join(codexBundle, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    check(results, 'codex', 'skip', codexHome + ' has no Shipyard bundle manifest');
DATA_Rb8n4KwE_END

A26 `scripts/install-shipyard-codex.sh:280`
DATA_Zc5j7PmA_START
AGENT_MANIFEST_NAME=".shipyard-manifest.json"
DATA_Zc5j7PmA_END

A27 `tests/unit/codex-delivery-host.test.cjs:30`
DATA_Ne2v6GyT_START
const temporary = fs.mkdtempSync('/tmp/scds-');
DATA_Ne2v6GyT_END

## Sources

### Primary (HIGH confidence — read this session)
- `.planning/architecture/ADR-017-delivery-seams-and-pr-hygiene.md`, `.planning/.adr-ingest/ADR-017-…ingest.md`
- `.planning/investigations/INV-004-phase39-delivery-retro/{PROBLEM,RESEARCH,OPTIONS,DECISIONS,RISKS,OPEN-QUESTIONS}.md` and `research/{constraints,system-state,alternatives,risks,pr-hygiene-evidence,codex-flowpdf-evidence}.md`
- `.planning/REQUIREMENTS.md` (REQ-125..150), `.planning/ROADMAP.md` (phases 39-40), `.planning/config.json`
- `.planning/phases/39-remove-conveyor-session-friction/39-01..12-PLAN.md` frontmatter
- Source files cited in the Verbatim anchors, plus `graph-dir.cjs`, `refusal-hints.cjs`, `run-waker.cjs`, `dispatch-record.cjs` (activeDispatches, reserveRound), `deliver.md:1960-2069`, `tests/unit/front.test.cjs:2040-2069`, `tests/unit/claude-delivery-host.test.cjs:455-484`, `Makefile`, `tests/unit/run.sh`, `.github/workflows/test.yml`, `CLAUDE.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md`
- Git state: `git log`, `git diff --stat`, `git branch -r` against last-fetched refs

### Secondary (MEDIUM)
- INV-004 line numbers for `deliver.md` (`:1710-1741`, `:2152`, `:2208`, `:2251`) and test-pin counts — cited from the investigation, not re-read

### Tertiary (LOW)
- Codex CLI child-evidence and sandbox capabilities (A-5, A-6) — no documentation lookup; spike recommended in INV-004 RISKS R10/R12

## Metadata

**Confidence breakdown:**
- Requirement → file map: HIGH — symbols read at HEAD
- Overlap matrix and cross-phase map: HIGH for `files_modified` (read); MEDIUM for T-39 merge state (fetch failed)
- Architecture patterns: HIGH — modeled on existing in-repo mechanisms
- Pitfalls: HIGH for 1-6, 9, 13 (code read); MEDIUM for 7, 10, 12; LOW for 11 (assumed limit)

**Research date:** 2026-09-24
**Valid until:** re-verify phase-39 merge state before planning waves (fast-moving: 7 days); file anchors valid until phase 39 lands on `main`, then re-resolve by symbol (INV-004 R14)
