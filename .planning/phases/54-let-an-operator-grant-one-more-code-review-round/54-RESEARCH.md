# Phase 54: Let an operator grant one more code-review round - Research

**Researched:** 2026-11-02
**Domain:** Shipyard phase code review: round limit, authenticated verdict replay, a private operator record, PR visibility, refusal hints, release bump. Plain Node CJS, no external packages.
**Confidence:** HIGH for source locations, test patterns and the S1/S4 probe; MEDIUM for the R-2 child marker and the R-7 sealed field (no existing primitive); LOW for any claim about host sandboxes beyond what this repo configures.
**Baseline:** `epic/harness-simplification` at `749604b9` (1.0.0-rc.2); `git status` shows no modified file under `plugins/`, `tests/`, `scripts/`, `docs/`, `capabilities/`, `Makefile` or `CLAUDE.md`, so every `path:line` below is against that commit. Packet digests re-checked in revision cycle 1 (`shasum -a 256`): ADR-035 `892f114a…`, REQUIREMENTS `efee1de1…` and ROADMAP `e2583775…` match the packet. **`.planning/graph/tickets.json` no longer matches** (packet `15ca3b1e…`, now `b963ff9d…`): the working tree now carries the `T-54-01`…`T-54-15` rows written by the decomposition run (Grep on the file), so no claim in this document rests on that file's content.
**Revision cycle 1:** the planner edited this file once (the Open Questions block); the researcher took ownership back, re-verified every `path:line` against the source and corrected the entries marked "(corrected in cycle 1)" below.
**Revision cycle 2 (verification only):** the four Open Question resolutions were re-checked against the source and the fifteen plans at the same baseline (`git rev-parse` prints `749604b9`; ADR-035, REQUIREMENTS and ROADMAP still match their packet digests by `shasum -a 256`; `tickets.json` still reads `b963ff9d…`, the value noted in cycle 1, so it still differs from the packet's `15ca3b1e…`). Q1 and Q3 stand as written. Q2 stands and gains a caveat the plans do not cover (the marker reaches every test run inside a role child: Pitfall 14, A8). Q4's wording "operator-confirmed default at Gate 2" overstated what exists and is corrected (marked "corrected in cycle 2" below). No `path:line` above changed.

<user_constraints>
## User Constraints (from CONTEXT.md)

CONTEXT.md has no `## Decisions`, `## Claude's Discretion` or `## Deferred Ideas` headings. Its sections are copied below verbatim; the deferred list is ADR-035's own `## Out of scope`, which CONTEXT.md names as the source of truth.

### Locked Decisions

Status: operator-approved scope from accepted ADR-035 (INV-021 Gate 1, 2026-11-02); base is `epic/harness-simplification` at `749604b9` (1.0.0-rc.2); release is `1.0.0-rc.3`.

**Goal.** The phase code review can run a round beyond the third only when the operator has written a head-bound record. One record grants one round, the total is capped at 5, the extended round is always a delta that never auto-repairs, and the merging human sees on the PR that the limit was extended.

**Locked scope (from ADR-035).** An unsigned private record outside the worktree next to the publication record, bound to repository, PR, head and base commit; effective limit = `ROUND_CAP` + valid records, clamped to a total of 5; consumption derived from the countable verdict history (a record counts while its head is current, or while its head is an ancestor of the current head and a countable verdict for that head sealed after the record); void records cost nothing; absolute ceiling 5 in seal validation, normalization and the replay-depth bound; extended round is a delta or refuses; `repairAllowed` stays 1-2; visibility in the sealed verdict, the `<!-- code-review -->` comment and the `code-review` commit status, not the gate trailer; named refusal hints and project-wide `report` wording; `references/code-review.md` edited to rounds 1-5 with an accepted one-time reset; release `1.0.0-rc.3` by the six-file pattern of `749604b9`.

**Planning mode.** `--tdd`, granularity `fine`. UI design: none, so `--skip-ui`.

**Constraints to carry into every ticket.**

- Net-negative or justified: each ticket reports net lines including tests and names an offsetting deletion (for example collapsing the three copies of the refusal sentence and the three round computations into one shared lookup); no new contract ids unless the ticket names the unavoidable one; the comment policy stays blocking.
- Do not regenerate `plugins/shipyard` in ticket PRs; it is regenerated once before the epic goes to `main`; never edit the generated `host/` copy by hand.
- Edits to `runtime-adapters` or `claude-dispatch-adapter` need `make refresh-runtime-digests` and the printed trailer; the dispatch boundary resolve → validate → launch → receipt stays.
- The record and its tests never read or write the real `~/.local/state/shipyard`: authority-touching tests override `os.homedir`.
- The first ticket is the S1/S4 spikes and changes no production behaviour; no limit change lands before its findings are recorded.
- The last ticket is the `1.0.0-rc.3` version bump and changes only the six version files; it needs `make test-releases`.
- No plan modifies more than 10 files.
- Verification commands are scoped to the touched test files; the whole unit suite is CI's job.

### Claude's Discretion

None declared in CONTEXT.md. This research marks each open design choice as **Planner decision** so the planner can settle it or send it to the operator.

### Deferred Ideas (OUT OF SCOPE)

Copied from ADR-035 `## Out of scope` (ADR-035:50-59):

- Changing the default `ROUND_CAP` (stays 3).
- Auto-repair in extended rounds.
- Other roles' limits (arch-review, integrator, sentinel, ci-fix, review-fix).
- Signing the record, a TTY or out-of-band human check, or hardening the `report` exit.
- A human GitHub approval fallback and a config-entry extension (Options C and D).
- A code-review field in the gate trailer.
- A `main` release and any tag.
- Retroactive unblocking of exhausted PRs other than by a new record.
</user_constraints>

<phase_requirements>
## Phase Requirements

Descriptions are verbatim from `.planning/REQUIREMENTS.md:205-213`.

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-204 | An operator command `phase-code-review.cjs extend --phase N --pr P --reason "…" --confirm extend-review-round` writes one private record outside the worktree, bound to repository, PR, live head and base commit, with operator identity, time and a bounded reason; one record grants exactly one extra round (ADR-035 R-1, R-3). | §Record store: reuse the publication namespace and its hardened reader (`phase-code-review.cjs:306-391`); the CLI parser has no positional-free verb yet (`:508-541`); no existing git-identity helper. |
| REQ-205 | The extension claim is exactly that a role-hosted child cannot grant itself an extension (existing sandbox plus a refusal under host-child markers) while the same-user orchestrating session acting on the operator's word is trusted; no signature and no cryptographic human-only claim is made (ADR-035 R-2). | §R-2 child marker: the only Shipyard-set child marker is `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` on the Claude path; Codex children carry none. The real barrier is the sandbox write allow-list (`claude-runtime-host.cjs:756`). |
| REQ-206 | The effective review limit is `ROUND_CAP` plus the valid records, clamped to a total of 5, with consumption derived from the authenticated verdict history and never from a stored flag; a record for another PR, base or unrelated head is void and does not count (ADR-035 R-4). | §Limit arithmetic: one pure function in `code-review-core.cjs` next to `nextRound` (`:338-346`); worked sequences table. |
| REQ-207 | Seal validation, result normalization and the replay-depth bound use the absolute ceiling of 5 instead of the per-PR limit, and the S1 and S4 spikes establish the replay and rollback behaviour of a round-4 verdict before the limit changes (ADR-035 R-5, R-10). | §S1/S4 probe: raising only normalize+seal admits round 4 and refuses round 5; raising the replay bound too admits rounds 1-5; rc.2 code throws on a sealed round-4 verdict. |
| REQ-208 | An extended round is always a delta from the last counted verdict and refuses rather than falling back to a full review when no delta is possible; `repairAllowed` stays true only for rounds 1 and 2 (ADR-035 R-6). | §R-6: `nextRound` already computes `inherit`; `repairAllowed` needs no code change, only test extension (`code-review-core.test.cjs:180`). |
| REQ-209 | An extended round is visible in the sealed verdict, the `<!-- code-review -->` comment and the `code-review` commit status as `round N of 3, extended by <operator> at <time>: <reason>`; the gate trailer is unchanged; the `limit` refusal carries named hints for the extend command and `report`, and every text offering `report` says it applies to the whole project until switched back (ADR-035 R-7, R-13, R-14). | §Visibility, §Refusal hints, §Report wording: site lists, the 140-character status cap, the hygiene scan of the comment body, hint-map invariants. |
| REQ-210 | `references/code-review.md` states rounds 1-5 with a fourth round only on a human record, and the one-time reset of verdicts sealed before the edit is accepted and stated in the release notes (ADR-035 R-8). | §Pattern 10: two places to edit (`code-review.md:25`, `:48-52`); no test pins the digest literal; no in-tree release-notes file for rc tags. |
| REQ-211 | Fixes pushed between two reviews cost one round, a record voided by a head move costs nothing, the ceiling of 5 is final, and each delivery PR reports net lines including tests and names an offsetting deletion (ADR-035 R-11, R-12, R-15). | §Limit arithmetic (void/consumed rows), §Net-code offsets. |
| REQ-212 | The change ships as `1.0.0-rc.3` on `epic/harness-simplification` with the version bumped by the six-file pattern of commit `749604b9` as the last PR of the epic after the Codex package is regenerated, and no tag or release without the operator (ADR-035 R-9). | §R-9: the exact six files with current values; mirror regeneration order; `make test-releases` needs network and `gh`. |

Section key for the Research Support column (the descriptions above are verbatim from `.planning/REQUIREMENTS.md:205-213`, re-read in cycle 1): §Record store = Pattern 3; §Limit arithmetic = Pattern 4; §R-6 = Pattern 5; §Visibility = Patterns 6 and 7; §Refusal hints = Pattern 8; §Report wording = Pattern 9; §R-8 = Pattern 10; §R-2 child marker = Open Question 2 with Pitfalls 11 and 12; §R-9 = "Release bump (R-9)"; §S1/S4 probe and §Net-code offsets are headings of their own.
</phase_requirements>

## Project Constraints (from CLAUDE.md)

`[VERIFIED: CLAUDE.md]` (read in full this session). These carry the same authority as the locked decisions.

- Claude plugin is canonical; Codex output is generated. "The marketplace package under `plugins/shipyard` is generated; never edit its `host/` copy directly. CI skips the staleness check for ticket PRs into an `epic/*` branch, but the package tests compare the build with the committed mirror, so a ticket that changes the packaged file set regenerates it" (CLAUDE.md:79-84).
- "When adding a rule, add a focused unit or fixture test with it." (CLAUDE.md:88-89)
- "Change the runtime-file digest pin only with `make refresh-runtime-digests` and the printed trailer." (CLAUDE.md:137-138)
- "Run `make test-fast` after each edit" (CLAUDE.md:59). Phase CONTEXT narrows this to "verification commands are scoped to the touched test files"; CONTEXT governs.
- "Update `README.md` when the supported command or installation flow changes." (CLAUDE.md:136). `README.md` and `tests/smoke/docs-smoke.sh` contain no match for `phase-code-review`, `code review` or `code_review` (Grep this session), so the README needs no edit for `extend`.
- Active dispatch boundary rule: "every routed launch must resolve → validate → launch → receipt" (CLAUDE.md:97). Adding an env marker to a child launch does not alter it.
- Packaged mirror (corrected in cycle 1). `package-shipyard-codex.cjs:20-23` copies the **whole** `plugins/delivery-pipeline` and `capabilities/delivery-pipeline` trees into `plugins/shipyard/host/`, so *any content edit* under those two trees (not only a new file) makes the committed mirror differ from a fresh build. The staleness assertion is skipped for epic and ticket bases: `packageFreshnessRequired` returns `!ref.startsWith('epic/') && !ref.startsWith('ticket/')` (`package-shipyard-codex.cjs:71-74`) and `marketplace-install.test.cjs:93-97` calls it with `COMMENT_POLICY_BASE` or the branch. So no ticket PR into `epic/harness-simplification` regenerates the mirror (CONTEXT agrees), and the mirror is regenerated once before the epic goes to `main`. CLAUDE.md:81-84 says "a ticket that changes the packaged file set regenerates it"; that sentence and CONTEXT diverge only if a ticket adds or removes a packaged file, which is why this document recommends no new file under the two trees. CONTEXT governs.

## Summary

The cap is derived, not stored: `nextRound` returns `limit` when the count of countable sealed verdicts reaches `ROUND_CAP = 3` (`code-review-core.cjs:6`, `:338-340`). Nothing records "this PR used 3". Raising it is not one edit. Four code places enforce 3 (`code-review-core.cjs:196`, `:340`; `role-artifact.cjs:3146`, `:3190`), three call sites each recompute the round (`phase-code-review.cjs:145-154`, `claude-role-host.cjs:596-613`, `codex-code-review-context.cjs:141-149`), and four sentences or strings say "three" or offer `report` "for this PR". Raising only `nextRound` yields a launch that cannot be sealed.

A scratch probe this session (not the S1/S4 record; see §S1/S4 probe) confirmed the INV's static reading with real seals: raising the normalize and seal checks but leaving the replay bound at `ROUND_CAP` seals rounds 1-4 and refuses round 5; raising the replay bound to a ceiling of 5 seals and authenticates rounds 1-5; and rc.2 code reading a sealed round-4 verdict throws `INVALID_RESULT` out of `priorCodeReviewVerdicts`, which has no guard at any of its three callers.

The record can live next to the publication record and reuse its hardened reader, lock and atomic writer (`phase-code-review.cjs:306-391`). Its schema cannot reuse the publication record's, whose key set is fixed (`:362`), so the ticket must name one new schema id. Two findings the ADR text does not anticipate: (1) no Shipyard-set "I am a role child" marker exists on the Codex path, and the only Claude one is a Claude Code setting; (2) the `limit` message, the status text and the comment are hygiene-scanned or length-capped, so the operator's reason must be checked at write time.

**Primary recommendation:** Put one pure function in `code-review-core.cjs` that takes the countable history plus the validated extension records and returns `{round, state, scope, limit, extension}` (replacing the `countableVerdicts` + `nextRound` pair at all three call sites); put the record reader, writer and `extend` verb in `phase-code-review.cjs` beside `publicationNamespace`; carry the extension into the sealed verdict through the same path as `review_round` and `review_scope`; add no new file under `plugins/delivery-pipeline/` or `capabilities/delivery-pipeline/` (new tests live in `tests/unit/`, which is not packaged), so the CLAUDE.md "packaged file set" rule and CONTEXT's "no regeneration in ticket PRs" agree; the mirror is stale by content in every ticket PR and that is tolerated for epic bases (§Project Constraints).

## Architectural Responsibility Map

This is a CLI/host-script system, not a web tier stack. Tiers here are the repository's own layers (CLAUDE.md:67-85).

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Effective limit and delta-or-refuse arithmetic | Deterministic core (`code-review-core.cjs`) | — | Pure functions over verdict history; `nextRound` already lives here (`:338-346`) |
| Seal ceiling, replay-depth bound, sealed extension field | Authority/seal layer (`role-artifact.cjs`) | Core (packet and normalize options) | The seal and the replay both validate the sealed shape (`:3128-3186`, `:3046-3063`) |
| Extension record store, `extend` verb, operator identity | Operator CLI (`phase-code-review.cjs`) | Private state dir under `~/.local/state/shipyard` | Owns `publicationNamespace`, the hardened reader and the CLI verb table (`:306-391`, `:508-541`) |
| Round computation at launch | Host scripts (`claude-role-host.cjs`, `codex-code-review-context.cjs`) | Core | Each host refuses at the limit before launch; both must call the shared lookup |
| PR visibility (status text, comment) | Publication (`phase-code-review.cjs publish`) | GitHub API via `gh` | `statusDescription` and `findingsComment` build the two public texts (`:209-224`, `:269-298`) |
| Refusal hints | `refusal-hints.cjs` | The four hosts and `phase-code-review.cjs` CLI catch | One code-keyed map with a `details.hint_code` override (`:277-282`) |
| Reviewer instructions | `references/code-review.md` | Both hosts load it; digest is part of the contract | `contractDigest(referenceDigest)` (`code-review-core.cjs:25`) |
| Release bump | Version files (six) | `make package-shipyard-codex` | Generated mirror and build digest follow the source version |

## Standard Stack

### Core

No external packages. Everything is Node built-ins and in-repo modules.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js (`node:fs`, `node:path`, `node:crypto`, `node:os`, `node:child_process`) | v24.21.0 `[VERIFIED: node --version this session]`; CI uses 24.15.0 `[VERIFIED: .github/workflows/test.yml `node-version: '24.15.0'`]` | All record I/O, hashing, git calls | The repo "requires only the host shell and Node" (CLAUDE.md:59-61); no `package.json` (`.github/workflows/test.yml:4`) |
| `lock.cjs` (`withLock`, `writeAtomic`) | in-repo | Cross-process lock and atomic replace for the record | Already required by `phase-code-review.cjs:301`; `writeAtomic` creates the directory mode 0700 (`lock.cjs:422-433`) |
| `pr-hygiene.cjs` (`applies`, `internalLeakViolations`) | in-repo | Write-time check of the operator reason | `publish` scans the comment body with it (`phase-code-review.cjs:449-455`) |
| `refusal-hints.cjs` | in-repo | Named hints | Single shared map |
| `node:test` or `assert-harness.cjs` | node built-in / in-repo | Unit tests | The target test files use `node:test` (`phase-code-review.test.cjs:3`) or the harness (`role-artifact.test.cjs:35`) |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tests/fixtures/code-review/artifact-fixture.cjs` | in-repo | Seals real multi-round verdicts in a temp git repo | Every test that needs a countable history, including round 4 and 5 once the ceiling is raised |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New record schema | Reuse `shipyard.code-review-publication.v1` | Not possible: the reader accepts exactly the keys `body_hash,comment_id,pr,repository,schema,selector` (`phase-code-review.cjs:362`) |
| New script file for the store | Put it in `phase-code-review.cjs` | A new file under `plugins/delivery-pipeline/` changes the packaged file set, which CLAUDE.md:81-84 says a ticket regenerates, while CONTEXT forbids regenerating in ticket PRs; no new file keeps both true. A new module would also fall outside the Codex installed-launch pin list (`codex-code-review-context.cjs:21-24`, §Pitfall 12) |
| Authority namespace with HMAC key | Publication-style private directory | ADR-035 R-3 rejects the HMAC authority (per-worktree key has no per-PR home) |

**Installation:** none. **Version verification:** not applicable, no registry packages are added.

## Package Legitimacy Audit

No external packages are installed by this phase. `gsd_run query package-legitimacy check` was not run because there is nothing to check.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none) | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
operator (same-user shell, or the orchestrating model on the operator's word)
   │  node phase-code-review.cjs extend --phase N --pr P --reason "…" --confirm extend-review-round
   ▼
extend verb ──refuse if──► role-child marker set │ --confirm wrong │ not at limit │ ceiling reached │ no delta possible │ reason trips hygiene
   │ ok
   ▼
context(): live PR (head, base), repository identity, mode
   ▼
private store: ~/.local/state/shipyard/code-review-publications/<sha256([repository,selector])>/<pr>.* (0700 dir, 0600 file, lock, bound)
   ▲                                                                   │ read-only (never mkdir on read)
   │                                                                   ▼
   │       ┌──────────── shared lookup (code-review-core) ◄── countable verdict history (role-artifact priorCodeReviewVerdicts, replay ceiling 5)
   │       │   limit = min(5, 3 + valid records); delta-or-refuse beyond 3
   │       ▼
   │   three call sites: phase-code-review status ─► gate/publish/fix-tickets
   │                     claude-role-host prepareCodeReview ─► launch or CODE_REVIEW_ROUND_LIMIT
   │                     codex-code-review-context prepare ─► launch or CODE_REVIEW_ROUND_LIMIT
   │       │ launch with role_context.review_extension (host-authored)
   │       ▼
   │   reviewer child (sandboxed, cannot write the store) ─► host normalizes (ceiling 5) ─► sealJudgment (ceiling 5, sealed review_extension)
   │       ▼
   └── publish: code-review status text (≤140) + <!-- code-review --> comment carry "round N of 3, extended by …"
```

### Recommended Project Structure

No new production files. Changes stay in existing files so the packaged file set is unchanged.

```
plugins/delivery-pipeline/
├── scripts/code-review-core.cjs        # ceiling constant, shared lookup, packet/normalize carry the extension
├── scripts/role-artifact.cjs           # seal ceiling, replay bound, manifest field, replay options, current verdict shape
├── scripts/phase-code-review.cjs       # record store, extend verb, texts, shared refusal(); exports a reader for the hosts
├── scripts/claude-role-host.cjs        # one call to the shared lookup in prepareCodeReview
├── scripts/codex-code-review-context.cjs # same
├── scripts/deliver-dispatch.cjs        # reuse the exported refusal text; hint_code on the build refusal
├── scripts/refusal-hints.cjs           # new entries
├── scripts/claude-runtime-host.cjs     # child marker (claudeEnvironment)
├── scripts/codex-runtime-host.cjs      # child marker (after launchEnvironment)
├── references/code-review.md           # rounds 1-5 wording
└── commands/deliver.md                 # report wording
tests/unit/                              # extended in place; new test files are not packaged
```

### Pattern 1: Cap locations (every site that must change)

`[VERIFIED: file:line, values quoted verbatim]`

| Site | Where | Current text | Needed |
|------|-------|-------------|--------|
| constant | `code-review-core.cjs:6` | `const ROUND_CAP = 3;` | keep; add a ceiling constant of 5 and export it (export list `:530-533`) |
| normalization (also at replay via `normalizeFinal` → `normalizeResult`, `:187`) | `code-review-core.cjs:196` | `if (!positive(round) \|\| round > ROUND_CAP \|\| !['full', 'delta'].includes(scope)) fail('INVALID_RESULT', 'invalid review round or scope');` | `round > ceiling` |
| next round | `code-review-core.cjs:338-346` | `if (used >= ROUND_CAP) return { round: null, state: 'limit', rounds_used: used };` | effective limit; delta-or-refuse beyond 3 |
| repair | `code-review-core.cjs:347` | `function repairAllowed(round) { return round === 1 \|\| round === 2; }` | no change |
| seal validation (also replay: `judgmentResultData` → `codeReviewResultData`, `role-artifact.cjs:3827`) | `role-artifact.cjs:3146` | `result.review_round > core.ROUND_CAP` | ceiling |
| replay-depth bound | `role-artifact.cjs:3190` | `lineage.active.size >= require('./code-review-core.cjs').ROUND_CAP` | ceiling |
| round at the CLI status | `phase-code-review.cjs:154` (`const countable = core.countableVerdicts(history), next = core.nextRound(history);`), `:147` (history object) | two calls | one shared lookup |
| round in the Claude host | `claude-role-host.cjs:611-613` | `const countable = core.countableVerdicts(history);` / `const round = core.nextRound(history);` / `if (round.state === 'limit') reject('three rounds are spent; no code-review launch is allowed', 'CODE_REVIEW_ROUND_LIMIT');` | one shared lookup; state-dependent message |
| round in the Codex context | `codex-code-review-context.cjs:147-149` | `const roundOptions = { priorVerdicts, head, isAncestor, mergeBase };` / `const verdicts = core.countableVerdicts(roundOptions), round = core.nextRound(roundOptions);` / `if (round.state === 'limit') fail('three countable reviews have already run', 'CODE_REVIEW_ROUND_LIMIT');` | one shared lookup |
| status field | `phase-code-review.cjs:132` | `round_cap: core.ROUND_CAP,` | keep 3 as the base; add the effective limit |

All three call sites build the same `history` shape `{ priorVerdicts, mergeBase, head, isAncestor }` (`phase-code-review.cjs:147`, `claude-role-host.cjs:599`, `codex-code-review-context.cjs:147`). The only real differences are the git runner and how `isAncestor` treats a failed probe, so the shared function must accept `isAncestor` from the caller and keep each caller's git wrapper.

### Pattern 2: Replay-depth bound arithmetic

`[VERIFIED: role-artifact.cjs:2938, :3188-3199, :3243-3250]`

- The only recursion is `authenticateCarriedCodeReviewFindings` → `authenticatedCodeReviewRecord(worktree, record, …, state)` (`:2938`), and it returns early when there are no carried findings (`:2909`).
- The guard runs before the memo lookup (`:3190` precedes `:3192`), so memo hits do not skip it.
- Entering a nested record is refused when `active.size` is already at the bound, and `active` holds the records currently being replayed (`:3190`, `:3193`, `:3198`).
- **History read** (`priorCodeReviewVerdicts`, replay of round N with its own record in `active`): the chain is N, N-1, …, 1, so round 1 is entered with `active.size = N-1`. For N = 5 that is 4, so the bound must exceed 4: `>= 5` is the smallest bound equal to the ceiling that admits it; `>= 3` refuses it whenever the memo is cold. Records are replayed oldest first within a call and a memo hit still passes the guard (the guard at `:3190` precedes the memo lookup at `:3192`), which is why the in-order history read of rounds 1-4 can succeed under `>= 3` while sealing round 5 fails.
- **Seal time** (the record being sealed is not yet in `active`): sealing round N walks N-1 … 1, entering round 1 with `active.size = N-2`. Read in cycle 1: the seal path calls `authenticateCodeReviewAnswer({ trusted, result, evidence: sourceEvidence, identity })` with no `lineage` argument (`role-artifact.cjs:4097-4098`), so the default `lineage = codeReviewReplayState()` (`:2947`) is a fresh `{ active: new Set(), memo: new Map(), … }` (`:2880-2882`). With the bound left at 3, round 4 enters round 1 with `active.size = 2` (seals) and round 5 with 3 (refused at `:3190`); the probe below observed exactly that.
- **History read** shares one `lineage` across every record of the call (`role-artifact.cjs:3260`, passed at `:3267`), which is why the oldest-first loop keeps nested depth at one predecessor through the memo.
- A failure inside a nested replay is swallowed into `answer_authenticated: false` (`:3243-3250`) and surfaces to the caller only as "original carried findings lack authenticated sealed source lineage" (`:2943-2944`).

### Pattern 3: Record store (R-1, R-3)

**What:** a private file next to the publication record, same discipline.
**Precedent, verbatim:** `publicationNamespace(ctx)` builds `path.join(home, '.local/state/shipyard/code-review-publications', publicationHash(JSON.stringify([identity.repository, selector])))` and the file `` `${ctx.pr}.json` `` (`phase-code-review.cjs:309-312`, `:335`); it refuses a directory inside the worktree or planning checkout (`:313-317`); directories are 0700 and uid-checked (`:318-333`); the reader requires a regular file, same uid, mode `0o600`, size within `PUBLICATION_BOUND = 8192` and re-stats around the read (`:304`, `:338-368`); the writer creates a `0o600` temp file, `writeAtomic`, fsyncs file and directory, re-validates and re-reads (`:370-391`); `publish` serializes under `withLock(state.directory, \`pr-${ctx.pr}\`, …, { label: 'code review publication', waitMs: 10000 })` (`:458`, `:482`).

**Pitfalls specific to reuse:**
- `publicationNamespace` **creates directories** (`fs.mkdirSync(current, { mode: 0o700 })`, `:325`). A lookup called from `status`, `gate`, and both hosts must not. The existing publish test asserts the directory does not exist after a refused publication: `assert.equal(fs.existsSync(publicationState(f).directory), false);` (`phase-code-review-publish.test.cjs:208`, inside the limit test `:187-215`). Build the read path to return "no records" when the directory is absent.
- `publicationNamespace` calls `assertPublicationConfig(ctx.mode)` on every path segment (`:324`), which throws `CONFIG_INVALID` for an invalid project config. A host-side read should not depend on a project config being valid; keep that assertion on the write path only.
- The hardened read in `readPublication` is generic except the identity and key-set check (`:362-366`). Extract the open/stat/read loop into one helper used by both records; that is the reuse that avoids copying ~30 lines.

**New schema id:** the ticket must name one (suggested form `shipyard.code-review-extension.v1`), per DECISIONS ("a new schema id is avoided if the existing publication record format can be reused; otherwise the ticket names it"). Reuse is not possible (`:362`).

**Selector:** the namespace hash uses `ctx.repo === null ? null : ctx.repo.trim().toLowerCase()` (`:308`). The hosts must pass the same normalized selector: Claude host `request.repo`, Codex `options.phaseRepo ?? null` (`codex-code-review-context.cjs:104`, `:121`).

**CLI shape (Planner decision):** every existing verb is `<verb> <phase-directory> --phase N --pr P …` and the parser rejects a missing positional (`phase-code-review.cjs:512-513`). R-1 specifies `extend --phase N --pr P --reason "…" --confirm extend-review-round` with no positional. Follow R-1 literally; the parser's `names` table (`:515`) and pair loop (`:516-528`) need `--reason` and `--confirm`, and `--confirm` must be compared against the literal constant (precedent: `planning-untrack.cjs` compares argv to a public constant, INV `research.md` item 7).

**Operator identity:** there is no helper. `git config --get user.name` is unused elsewhere (only `user.signingkey` is read, at `claude-delivery-host.cjs:211`, `codex-delivery-host.cjs:256`, `delivery-commit-finalizer.cjs:223` and `codex-runtime-host.cjs:1057`; Grep this session); the local `git(worktree, args)` wrapper (`phase-code-review.cjs:80-85`) throws on exit 1, so wrap it and fall back to `os.userInfo().username` (precedent for `os.userInfo()`: `planning-writer-lease.cjs:120`). **Planner decision:** name only, not email, because the value lands in a public comment.

**Reason sanitization:** strip `[\u0000-\u001f\u007f]`, collapse whitespace, trim, bound in bytes (core's `bounded` is private; write one). Also run the same hygiene check `publish` runs, because a reason matching `INTERNAL_LEAK_RULES` makes `publish` refuse the whole comment (`phase-code-review.cjs:449-455`): rules are `ticket-id`, `ticket-marker`, `phase-number` (`/\bPhase\s+\d+/i`), `adr-number` (`/ADR-\d+/i`), `plan-file`, `ticket-branch-prefix`, `epic-branch-prefix`, `planning-path` (`/\.planning\//i`), `shipyard-path`, `gate-status-trailer`, `internal-tool-word` (`/\b(?:shipyard|gsd|conveyor)\b/i`) (`pr-hygiene.cjs:210-222`). Mirror the guard: `hygiene.applies({ root: worktree }) ? hygiene.internalLeakViolations('comment', reason) : []`; refuse at write time and name the rules.

### Pattern 4: Limit arithmetic (R-4, R-15)

Pure function, in `code-review-core.cjs` beside `nextRound`. Inputs: countable verdicts (each has `head`, `sealed_at`; `countableVerdicts` sorts by `String(sealed_at).localeCompare`, `:301-302`), records `{ head, base_commit, created_at }`, current `head`, current `baseCommit`, `isAncestor`.

```js
// Source: derived from ADR-035 R-4; shapes from code-review-core.cjs:299-310, 338-346
function extensionState({ records, countable, head, baseCommit, isAncestor }) {
  return records.filter(record => record.base_commit === baseCommit
    && (record.head === head
      || (isAncestor(record.head, head)
        && countable.some(verdict => verdict.head === record.head && verdict.sealed_at > record.created_at))));
}
// limit = Math.min(CEILING, ROUND_CAP + valid.length); used = countable.length
```

**Timestamp comparison is valid only on one format** (verified in cycle 1): a sealed verdict's `sealed_at` is `new Date(Math.max(Date.now(), last + 1)).toISOString()` or the earlier record's own value (`role-artifact.cjs:2366`), and the reader refuses a verdict whose `sealed_at` is not a parseable string (`:3241-3242`). The record's `created_at` must therefore be written with `new Date().toISOString()` so the lexical `>` above equals the chronological one; any other format (offset, no milliseconds) breaks it silently.

Worked sequences (ceiling 5, `used` = countable verdicts):

| Step | Records on disk | valid | limit | used | Result |
|------|-----------------|-------|-------|------|--------|
| 3 rounds sealed, head H3', no record | — | 0 | 3 | 3 | `limit` |
| `extend` at H4 | E1(H4) | 1 (head current) | 4 | 3 | round 4 owed, delta |
| Round 4 sealed on H4 | E1(H4) | 1 | 4 | 4 | `current`; at H4 the verdict is reused |
| Push → H5, no new record | E1(H4) | 1 (ancestor + verdict sealed after) | 4 | 4 | `limit` |
| `extend` at H5 | E1, E2(H5) | 2 | 5 | 4 | round 5 owed |
| Round 5 sealed, push → H6 | E1, E2, (E3 if written) | 2 or 3 | 5 (clamped) | 5 | `limit`; the ceiling is final |
| Record written at H4, then push before any review | E1(H4) | 0 (head moved, no verdict for H4) | 3 | 3 | void, costs nothing |
| Base branch advances after `extend` | E1(H4, old base) | 0 | 3 | 3 | void: base differs |
| Two records for the same head | E1(H4), E1'(H4) | 2 | 5 | 3 | grants two rounds; **Planner decision:** make `extend` idempotent per (PR, head, base) so a retried command cannot double-grant |

**Planner decision:** `extend` should refuse unless the live status is `limit` (rounds_used ≥ effective limit) and the ceiling is not yet reached. Under the formula a record written early is consumed by a regular round and still adds +1 forever (`record.head` ancestor + verdict sealed after), which is a free grant that never expires and contradicts R-15's "write the record after the fixes settle".

### Pattern 5: Delta-or-refuse (R-6)

`nextRound` already computes the delta condition: `inherit = used && verdicts.at(-1).answer_authenticated !== false && (options.mergeBase === undefined || coverageComplete({ … mergeBase: options.mergeBase, … }))` and returns `scope: inherit ? 'delta' : 'full'` (`code-review-core.cjs:341-345`). For `used >= ROUND_CAP` the shared function must return a limit-state with a reason instead of `scope: 'full'` when `inherit` is false, so `status`, both hosts and `extend` agree. All three call sites pass `mergeBase` (`phase-code-review.cjs:147`, `claude-role-host.cjs:599`, `codex-code-review-context.cjs:147`); the only caller without it is a test helper (`code-review-foreign-contract.test.cjs:52`), where coverage is skipped by design. `extend` must run the same function so it never writes a record that cannot be used.

### Pattern 6: Sealed visibility chain (R-7, first of three surfaces)

"The sealed verdict carries …" has no existing field. The `review_round` and `review_scope` path is the template; the extension rides the same path:

1. host builds `role_context.review_extension` from the valid unconsumed record bound to the head (`core.assemblePacket`, `code-review-core.cjs:509-528`; call sites `claude-role-host.cjs:641`, `codex-code-review-context.cjs:172`);
2. normalization echoes it (`normalizeResult` returns `review_round`, `review_scope` at `:295-297`; add the field to its options like `round` and `scope`);
3. hosts pass it in their `normalizeFinal` options (`claude-role-host.cjs:1202`, `codex-code-review-context.cjs:427`);
4. seal validates and stores it (`codeReviewManifestFields`, `role-artifact.cjs:2831-2835`; `codeReviewResultData`, `:3128-3186`);
5. replay recomputes it from the original packet: options at `:3046` become `{ round: context.review_round, scope: context.review_scope, … }` plus the extension, and the byte-equality check `stable(expected) !== stable(sealed)` (`:3062-3063`) then holds;
6. `currentCodeReviewVerdict` exposes it on `current` (`:3464-3469`) so `status`, `statusDescription` and `findingsComment` read it from the sealed verdict, not from a record that may have since gone void.

No new contract id is needed (`CONTRACT_ID` stays); it is an added sealed field. **Planner decision:** whether to implement the field (the literal R-7) or derive the line from the record at publish time. The derived form is cheaper but can change or disappear after a base move; the ADR lists the sealed verdict first, so default to the field. This is the heaviest part of the phase by file count (core, role-artifact, both hosts, plus six test files), so it needs its own split.

### Pattern 7: Status text and comment (R-7, other two surfaces)

- `statusDescription` (`phase-code-review.cjs:209-224`) returns fixed strings with integer counts only; its own test pins "fixed text and integer counts only" and `description.length <= 140` at `MAX_SAFE_INTEGER` counts and passes `hygiene.internalLeakViolations('status', …)` (`phase-code-review-publish.test.cjs:382-394`). The GitHub cap is 140: `const STATUS_MAX = 140;` (`gate-trailer.cjs:166`). At maximum counts the base text is 69 characters (`code review: 9007199254740991 blocking issues, 9007199254740991 notes`), leaving 71 for `; round 4 of 3, extended by <operator> at <time>: <reason>`. With a 17-character time (`2026-11-02T10:45Z`) the fixed words take 51, so 20 remain for operator plus reason at maximum counts. **Planner decision:** build the extension fragment last and truncate reason, then operator, to `140 - base.length`, keeping `round N of 3, extended by`; the full line goes in the comment and the sealed verdict. Add an extended case to the maximum-count test.
- `findingsComment` (`:269-298`) builds `header = \`<!-- code-review -->\nCode review — round ${sealed.round}, scope ${sealed.scope}\nVerdict: ${sealed.verdict}\n\n\`` (`:271`) and a footer with the operator exit only when `current.mode === 'hold'` (`:272`, `:275`). Put the extended line in the header so the 60000-character loop (`:293`) already counts it. The body is scanned by `hygiene.internalLeakViolations('comment', body)` when `hygiene.applies` (`:449-451`), so any new wording must avoid the rules above (no `.planning/`, `ADR-`, `Phase N`, `shipyard`). The existing refusal text contains `.planning/config.json` but goes to stderr, not the comment.
- `publish` posts status only for `limit` (`:443-446`, "limit publishes status only"). The limit status text `'code review limit reached: no further review will run for this head'` (`:214-215`) is pinned by `phase-code-review-publish.test.cjs:212`.
- The gate trailer is unchanged. `STATUS_MAX = 140` is also its cap (`gate-trailer.cjs:166`); `gate-trailer.cjs:384-385` only spreads the `verifyCodeReview` result into JSON, so new status fields appear there harmlessly. No test pins the status result key set or the `shipyard.phase-code-review-status.v1` id outside `phase-code-review.cjs:130` (Grep this session).

### Pattern 8: Refusal hints (R-13)

`hintForError(error, host)` resolution (`refusal-hints.cjs:292-306`): the printed label is `error.code` or `UNKNOWN`; the entry is `HINTS[error.details.hint_code]` when it names an existing entry (`refinedCode`, `:277-282`), else `HINTS[error.code]`, else the default entry (`DEFAULT_ENTRY`, `:11-14`).

Current output, run this session:

```
$ node plugins/delivery-pipeline/scripts/phase-code-review.cjs status 52-x --pr 1
--phase and --pr are required
hint[UNKNOWN]: The host refused the request for a reason this map does not name. — remedy: Re-run the command and check the surrounding stderr for the underlying cause.   (exit 2)
hint[BUILD_REFUSED] / hint[CODE_REVIEW_ROUND_LIMIT] / hint[USAGE] → the same default text
```

| Refusal | Error code | Where | Mechanism |
|---------|-----------|-------|-----------|
| `status` without `--phase` | none (`usage()` sets only `exitCode: 2`, `phase-code-review.cjs:511`) | `:529`, catch `:536-540` | give `usage()` a code and add an entry; `deliver-dispatch` already throws code `USAGE` (`fail('USAGE', …)`, `deliver-dispatch.cjs:536`) so one `USAGE` entry would serve both |
| arch-review build at `limit` | `BUILD_REFUSED` (`deliver-dispatch.cjs:543-549`; message from `gate.message` at `:1213`) | `buildFail(field, message)` has no details parameter | pass `details: { hint_code }` (extend `buildFail` or throw inline); `error.field` stays |
| Claude launch at `limit` | `CODE_REVIEW_ROUND_LIMIT` (`claude-role-host.cjs:613`) | `reject(message, code)` (`:55-59`) | add `HINTS.CODE_REVIEW_ROUND_LIMIT`; printed at `claude-role-host.cjs:1893` |
| Codex launch at `limit` | `CODE_REVIEW_ROUND_LIMIT` (`codex-code-review-context.cjs:149`) | `fail(message, code)` (`:26-28`) | same entry |
| `phase-code-review.cjs gate` at `limit` | not thrown | CLI writes `gate.message` and sets the exit code (`:530-531`); the hint printer is only in the catch (`:538`) | the named exit must be in the message itself; no hint is printed on this path today |

Invariants a new entry must satisfy (`tests/unit/refusal-hints.test.cjs`): entries and the map are frozen (`:37-40`); `hint` and `remedy` non-empty; no word matching `BYPASS_TOKENS = /\b(bypass|skip|directly|other runtime|switch runtime)\b|SHIPYARD_STOP_GATE/i` (`:24`, applied `:75-81`); a remedy may not contain `make `, `plugins/delivery-pipeline/`, `install-shipyard-`, `ensure-gsd-core`, and `scripts/` must be preceded by `{bundle}/` (`:128-134`); a remedy that mentions `provenance|history|sidecar|catalogue|authority` may not contain `delete|remove|archive|move|rename|purge|clean` (`:137-147`); rendering with `{}` leaves no `{token}` (`:281-284`, the last test in the file). `LAUNCH_CODES` need not include the new codes: `host-entry-contract.test.cjs:200-210` only requires the resolver, preflight, legacy and identity codes. The remedy should name the command as `node {bundle}/scripts/phase-code-review.cjs extend …`.

### Pattern 9: `report` wording (R-14) — every site that offers it

`[VERIFIED: grep + reads this session]`

| Site | Lines | Text role |
|------|-------|-----------|
| `phase-code-review.cjs` `refusal()` | `:87-90` | `The operator can set delivery_pipeline.code_review to "report" in … for this PR (nothing is held in report mode); there is no override flag and no waiver record.` Used by `status` (`:181`), `rejectTicket` (`:92-95`), `evaluateGate` (`:196`), `fixTickets` (`:202`) |
| `deliver-dispatch.cjs` | `:1207-1209` | identical sentence, duplicated |
| comment footer | `phase-code-review.cjs:275` | `Operator exit: set delivery_pipeline.code_review to "report" for this PR.` (hold only, `:272`) |
| `deliver.md` | `:41-42`, `:1385`, `:1453-1458` | prose |
| `docs/gsd_multilevel_delivery_pipeline.md` | `:641` ("fixed text and integer counts only"), `:650-654` | prose; `:651` says "the three-round cap permits no further review after limit" |
| `capabilities/delivery-pipeline/capability.json` | `:54` | config description string |
| `pipeline-config.cjs` | `:536` (`code_review: 'hold',                // @contract: report | hold`) | no change needed |

R-14 also requires the PR comment printed **while `report` is on** to say it is project-wide. Today the footer is built only for hold (`stop = current.mode === 'hold' && …`, `:272`), so report mode prints nothing; a new branch is required.

**Every assertion that pins the current wording** (corrected in cycle 1: the first draft listed eight; Grep of `tests/` for `code_review.*report|three rounds|code review is` finds these):

| File | Lines | What it pins |
|------|-------|--------------|
| `phase-code-review.test.cjs` | `:121`, `:124`, `:133`, `:137`, `:141` | `/owed.*delivery_pipeline.code_review.*report/`, `/unmatched.*delivery_pipeline.code_review.*report/`, `/delivery_pipeline.code_review.*report/` on refusal text |
| `phase-code-review.test.cjs` | `:165-166` | the words `owed`, `incomplete`, `delivery_pipeline.code_review`, `report` and the config path are all substrings of the gate message |
| `phase-code-review.test.cjs` | `:167` | `/phase code review is owed/` on the arch-review build refusal |
| `phase-code-review.test.cjs` | `:204` | `/no longer re-check.*BLOCKERs stay visible.*delivery_pipeline.code_review.*report/` on the `fixTickets` diagnostic |
| `phase-code-review.test.cjs` | `:222` | `/three rounds.*delivery_pipeline.code_review.*report/` on the limit message |
| `phase-code-review.test.cjs` | `:375` | `/build code-review.*delivery_pipeline.code_review.*report/` on the CLI gate stderr (hold) |
| `phase-code-review-publish.test.cjs` | `:182`, `:360` | `/delivery_pipeline.code_review.*report/` on the **comment body**, i.e. the footer at `phase-code-review.cjs:275` |
| `deliver-dispatch.test.cjs` | `:1128`, `:1165`, `:1191` (owed), `:1185` (unmatched) | `/phase code review is (owed|unmatched).*delivery_pipeline.code_review.*report/` |
| `deliver-builders-contract.test.cjs` | `:195` | `/phase code review is owed.*delivery_pipeline.code_review.*report/` |
| `deliver-builders-contract.test.cjs` | `:71` | `/delivery_pipeline.code_review[\s\S]*report/` on the front of `deliver.md` (before `## Principle`) |
| `claude-role-host.test.cjs` | `:2465` | `/three rounds/` on the `CODE_REVIEW_ROUND_LIMIT` message |

Every regex is order-sensitive (`delivery_pipeline.code_review` before `report`; state word before both; `three rounds` in the limit reason). R-14's "applies to the whole project until switched back" can be appended or inserted after `report` without touching any of them. The limit reason is the only message whose `three rounds` token is wrong at an effective limit of 4 or 5 (`:181`, `:222`, `claude-role-host.test.cjs:2465`); a state-dependent text must keep `three rounds` for the base case or the three assertions change in the same ticket. No test pins the sentence `no waiver record` or `for this PR` (Grep of `tests/` for both: no match).

### Pattern 10: The reference edit (R-8, REQ-210)

`[VERIFIED: reads this session, quoted]`

- **Two edits.** `references/code-review.md:25` is `| \`review_round\` | Integer 1 through 3 |` and `:48-52` read: "1. Review the entire supplied scope and needed source files. The first countable review is full. A later complete delta counts only when its `prior_head` chain reaches a complete full review. Incomplete reviews never consume a round. No fourth review is owed. Repairs are allowed after rounds 1 and 2, so another review can check them." The sentence "No fourth review is owed." and the integer range are the only places that state the cap.
- **Why it resets.** `currentCodeReviewContract()` hashes the file's bytes (`role-artifact.cjs:2875-2878`, `readImmutableFile(…, '../references/code-review.md', …, 1024 * 1024)`), `contractDigest(referenceDigest)` is `hash(CONTRACT_ID + '\n' + referenceDigest)` (`code-review-core.cjs:25`), and a sealed verdict whose `manifest.contract_digest` differs is skipped (`role-artifact.cjs:3216`). Any byte change to the file, however small, resets every in-flight PR once; there is no way to edit it digest-neutrally.
- **Size budget.** The file is 13579 bytes (`wc -c`); `claude-reference-content.test.cjs:53` asserts at most 40 KiB and `claude-reference-content.cjs:8` caps loading at `MAX_REFERENCE_BYTES = 64 * 1024`. A one-paragraph edit has room.
- **Tests that read the file and must stay green:** `judgment-contract.test.cjs:612-617` (every field name in the list at `:614` must still occur, `partitions_total` too, and `still-present` must not); `claude-reference-content.test.cjs:45-54` (starts with `# code-review agent`, contains `line_text`, `prior_findings`, ``/`rule` is\s+an optional free label/``, `.shipyard-code-review-evidence.md` and `## Verification contract`); `source-contract.test.cjs:455-483` (every role reference keeps `## Verification contract` and the two exact verification sentences). No test pins the digest literal (`0c96442c…`; Grep of `tests/` found none), and `artifact-fixture.cjs:42` and `:77-78` compute the digest from the live file.
- **Contract id.** `CONTRACT_ID` stays `shipyard.phase-code-review.v1` (`code-review-core.cjs:5`); the reference edit changes `contract_digest` only, so the reset needs no new id.

### Anti-Patterns to Avoid

- **Raising only `nextRound`:** the launch then cannot seal (`role-artifact.cjs:3146`).
- **A stored "consumed" flag:** R-4 derives consumption from sealed history; a flag reintroduces the F6 hole.
- **Reading the record with `publicationNamespace`:** it creates directories and asserts project config.
- **Testing against the real state dir:** every test file that touches the namespace overrides `os.homedir` (`phase-code-review.test.cjs:9-12`, `phase-code-review-publish.test.cjs:9-12`).
- **Comments with history words:** `HISTORY_PATTERN` (`comment-policy.cjs:15-16`, quoted verbatim) is `/(?:\b(?:todo|fixme|hack|workaround|temporary|ticket|issue|pull request|commit|history|legacy|previously|because)\b|#\d+\b|\b(?:adr|myd|pdf)-?\d+\b)/i` (corrected in cycle 1: the first draft omitted `fixme`, `hack`, `history` and `#\d+`). Use only `@invariant:`, `@security:`, `@contract:` markers of at most 120 characters (`comment-policy.cjs:11-13`), CI-enforced by `make test-comment-policy` (`Makefile:109-110`; the target runs `publish-gate.cjs --base "$(or $(COMMENT_POLICY_BASE),origin/main)" --working-tree --json`).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Private hardened file read | A second open/stat loop | Extract the loop in `readPublication` (`phase-code-review.cjs:338-368`) | TOCTOU, symlink and uid checks are already right and tested (`phase-code-review-publish.test.cjs:886-916`) |
| Cross-process lock | `fs.existsSync` + write | `withLock` (`lock.cjs:401-419`) | Ownership-proven locking with stale takeover |
| Atomic write | `writeFileSync` in place | `writeAtomic` (`lock.cjs:422-433`) plus the fsync tail of `persistPublication` (`:383-391`) | Readers never see a torn record |
| Public-text leak check | Own regexes | `pr-hygiene.cjs` `internalLeakViolations` (`:224-232`) | The comment gate uses it; a divergent check would pass at write and fail at publish |
| Reference loading | Direct file reads | `claude-reference-content.cjs` / `references/code-review.md` through both hosts | The digest is the contract (`code-review-core.cjs:25`) |
| Multi-round sealed fixtures | Hand-built manifests | `artifact-fixture.cjs` `fixture()`, `advance`, `input`, `retainPlanningInput` | It computes the live reference digest (`artifact-fixture.cjs:42`, `:77`), so no test pins a digest literal |
| Signing the record | HMAC or keys | nothing | Explicitly out of scope (ADR-035 R-2, Out of scope) |

**Key insight:** the repository already has the state-dir discipline, the lock, the hygiene scan and the multi-round fixture. The risk in this phase is wiring (four enforcers, three call sites, two public texts), not new mechanisms.

## Runtime State Inventory

Not a rename phase, but R-8 invalidates stored state and R-3 adds new state, so the five categories are answered explicitly.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Sealed verdict archives per worktree and the authority catalogue under `~/.local/state/shipyard/role-artifact-authority` carry `contract_digest`; a verdict whose digest differs from `currentCodeReviewContract()` is skipped (`role-artifact.cjs:3216`, quoted in §Pitfall 4). Current reference digest `0c96442cf5e03e12b33054c8e08a75250e9c93008461499160d462e44ce1f268` `[VERIFIED: shasum this session]` | Data effect only: the reference edit resets every in-flight PR's count once. No migration; state it in the release notes |
| Live service config | GitHub `code-review` commit status and the `<!-- code-review -->` comment on open PRs | None; they are rewritten by the next `publish` |
| OS-registered state | None found (grep for task/launchd/systemd registrations in the touched scripts: none) | None |
| Secrets / env vars | None. The record is unsigned (R-2). A new child-marker env var is introduced (§R-2) | None beyond the marker |
| Build artifacts | `plugins/shipyard/**` mirror and `package-build.json` digest; installed bundles on operator machines | Mirror regenerates once, before the bump (§R-9); installed bundles update through the marketplace |

## Common Pitfalls

### Pitfall 1: Round 4 seals but round 5 does not
**What goes wrong:** normalize and seal admit 4 and 5, the replay bound refuses 5; the failure is swallowed (`:3243-3250`) and shows only as `answer_authenticated: false` or "lack authenticated sealed source lineage".
**Why:** `lineage.active.size >= ROUND_CAP` at `:3190`.
**How to avoid:** raise all three in one ticket; test a five-deep carried lineage (the existing tests stop at three: `role-artifact.test.cjs:1933-1976`, `:1982-2036`).
**Warning signs:** `history=[r1…r4]` authenticated but `current=null` after sealing round 5.

### Pitfall 2: A reader that creates directories
**What goes wrong:** `status` on a never-published PR creates `~/.local/state/shipyard/code-review-publications/<hash>/`, breaking `assert.equal(fs.existsSync(publicationState(f).directory), false)` (`phase-code-review-publish.test.cjs:208`) and surprising the operator.
**How to avoid:** a read path with no `mkdirSync`.

### Pitfall 3: The reason breaks the whole comment
**What goes wrong:** a reason containing `Phase 2`, `ADR-035` or `shipyard` makes `publish` refuse the entire `<!-- code-review -->` comment (`phase-code-review.cjs:452-455`), leaving only the status.
**How to avoid:** check at `extend` time with the same function and rules (§Pattern 3).

### Pitfall 4: Editing the reference resets every in-flight PR
`[VERIFIED: role-artifact.cjs:3215-3216]` quoted verbatim: `// @contract: a verdict of another contract or without current review authority is skipped, so the review is owed.` / `if (manifest.contract_digest !== currentCodeReviewContract() || !manifest.current_review || !record.review_current) return null;`. The reset is accepted (R-8), but the ticket that edits `code-review.md` must land before any ticket whose tests seal verdicts and compare digests across the edit, or run its tests after it. No test pins the digest literal (Grep for `0c96442c` found it in no test), and the fixture reads the file (`artifact-fixture.cjs:42`).

### Pitfall 5: `status` message regexes break on new wording
Assertions in five test files pin the report wording, the comment footer or the `three rounds` token (the full table is in §Pattern 9; corrected in cycle 1, the first draft counted eight in three files). The limit reason `three rounds are spent; no further review can launch` (`phase-code-review.cjs:181`) is wrong at an effective limit of 4 or 5; make it state-dependent and keep `three rounds` for the base case or update `phase-code-review.test.cjs:222` and `claude-role-host.test.cjs:2465` in the same ticket.

### Pitfall 6: Rollback throws instead of reporting `limit`
`priorCodeReviewVerdicts` has no guard at `phase-code-review.cjs:145`, `claude-role-host.cjs:596`, `codex-code-review-context.cjs:141`. rc.2 code reading a sealed round-4 verdict throws `INVALID_RESULT` (probe below), and the printed hint for that code is the misleading "The dispatch result does not match the shape the boundary requires" (`refusal-hints.cjs:57-60`). A guard in rc.3 cannot help rc.2; the finding belongs in the release notes.

### Pitfall 7: The status line exceeds 140 characters
At maximum counts only 71 characters remain (§Pattern 7). Truncate the reason, then the operator; never the counts or `round N of 3, extended by`.

### Pitfall 8: Operator-supplied text pings or renders
A reason with `@name` notifies that user; with HTML or markdown it renders in the PR. **Planner decision:** restrict the reason to plain text and strip `@`, `<`, `>` and backticks at write time `[ASSUMED]` (no repository policy found).

### Pitfall 9: Tests that call a real `gh` or the real state dir
Tests spawn the CLI with `HOME: home` and a fake `gh` on `PATH` that prints the PR JSON from `REVIEW_PR` (`phase-code-review.test.cjs:102-118`, spawn at `:114-117`); in-process tests set `os.homedir = () => home` (`:9-12`). Never inherit the operator's `HOME`. The record location a test asserts is computed by the test itself: `publicationState(f)` rebuilds `home/.local/state/shipyard/code-review-publications/<sha256(JSON.stringify([repositoryIdentity, null]))>/<pr>.json` (`phase-code-review-publish.test.cjs:655-660`) and `publicationSnapshot` walks that whole directory (`:662-670`), so a second file in the same directory shows up in every snapshot comparison.

### Pitfall 10: A stale mirror copy of `phase-code-review.cjs` runs inside a ticket-PR test
`phase-code-review-publish.test.cjs:1047-1072` spawns **two** publishers in parallel, the source script and `plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs` (`:1061-1063`), and requires one `created` and one `edited` result on the same comment id and the same publication record (`:1065-1070`). The mirror is not regenerated in ticket PRs, so at every ticket the old mirror script and the new source script must read and write the publication record, its lock (`pr-${pr}`, `:458`) and its directory identically. Changing the publication record's key set (`:362`), file name, directory hash (`:311-312`) or lock name breaks this test in every ticket until the pre-`main` regeneration. Extracting the hardened read (§Don't Hand-Roll) is safe only if the bytes accepted and written stay the same.

### Pitfall 11: `claudeEnvironment` has two callers, only one is a role child
`claudeEnvironment` is called at `claude-runtime-host.cjs:187` (the `claude --version` probe, `spawnSync(executable, ['--version'], { …, env })` at `:190`) and at `:701` (`childEnvironment` of the role launch). A marker added inside `claudeEnvironment` therefore also lands on the version probe's environment; adding it only to `childEnvironment` at `:701` is the narrower form. The existing assertions read single keys (`claude-runtime-host.test.cjs:272-279`; `codex-runtime-host.test.cjs:304-307`), so either placement passes them.

### Pitfall 12: A new `require` from a host into `phase-code-review.cjs` is outside the Codex installed-launch pins
`codex-code-review-context.cjs:21-24` freezes `sourceFiles` (15 names) and `admitInstalledLaunch` pins each by sha256 (`:313-315`); `recheckInstalledLaunch` refuses launch and seal when any pinned byte changed (`:330-336`), and `codex-code-review-context.test.cjs:622-637` appends one byte to every pin and expects `STALE_CONTEXT`. `phase-code-review.cjs` is not in the list and neither host requires it today (Grep: only `role-artifact.cjs:3306`, `deliver-dispatch.cjs:1205` and `gate-trailer.cjs:384` do). The test's own `pinNames` (`:32-35`) is a subset check (`:629`), so adding a name to `sourceFiles` keeps it green; leaving the module out means a record reader loaded from it is unpinned between prepare and launch. **Planner decision:** place the reader in a pinned module, or add the module name to `sourceFiles` and `pinNames`.

### Pitfall 13: `--code-review-d37-only` skips a new case silently
`role-artifact.test.cjs:42-46` lists three exact test names and one name prefix (`existing-format foreign native input retains original planning pins: `), `:49` counts every match into `d37Selected`, `:51` returns early for any other name under the flag, and `:2315` asserts `d37Selected === 6` always (`:2316` asserts `reuseSelected === 1`). A new case under that flag runs only if its name is added to `d37Case`, and then `:2315` must move in the same change; only one selection flag is accepted (`:39-40`). Corrected in cycle 1: the first draft said the flag "selects the three code-review cases".

### Pitfall 14: The child marker reaches the tests that must succeed at `extend` (added in cycle 2)
**What goes wrong:** `SHIPYARD_ROLE_CHILD=1` is set on every Claude and Codex role launch (Open Question 2). A ticket executor runs its verification commands as subprocesses of that child. `tests/unit/phase-code-review.test.cjs` spawns the CLI with `env: { ...process.env, HOME: home, … }` at `:116`, `:365`, `:570` and `:639` and calls the module in process, and 54-07's verify commands run test files with `node --test` directly, not through `tests/unit/run.sh`, whose `unset` list is exactly `CLAUDE_PLUGIN_ROOT CLAUDE_CODE_ENTRYPOINT CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED` (`run.sh:10`). Inside an executor child the happy-path `extend` cases of 54-07 and the sequence of 54-14 would fail with `EXTENSION_REFUSED`, while passing in CI and in the operator's shell.
**Why it happens:** the marker is the production refusal signal, and no plan removes it from a test's environment: Grep of the fifteen plans and `54-VALIDATION.md` for `SHIPYARD_ROLE_CHILD` finds it only in 54-07 (sets it, never clears it) and 54-14 (sets it for the child-refusal case, `54-14-PLAN.md:57`).
**How to avoid:** in `phase-code-review.test.cjs`, run `delete process.env.SHIPYARD_ROLE_CHILD` once beside the home override (`:9-12`), before any fixture, so in-process calls and every spawned env built from `process.env` start clean; set it explicitly, and restore it, only in the child-refusal cases. Adding the name to the `unset` line of `run.sh:10` keeps `make test-unit` clean too, but that file is outside 54-07's `files_modified`, so the in-test delete is the required form and `run.sh` is optional (Planner decision).
**Warning signs:** `extend` cases green in CI and red when an executor runs the same command; a `hint[EXTENSION_REFUSED]` line in a test that expected a created record.
**Confidence:** the in-repo facts above are verified; that a Bash subprocess of a role child keeps a non-credential variable is A8 `[ASSUMED]`. If Claude Code strips it, the hazard disappears together with the refusal's effect on the Claude path (A2).

## Code Examples

### The `extend` verb skeleton

```js
// Source: shapes from phase-code-review.cjs:80-85 (git), :306-391 (store), :508-541 (CLI); control flow is a recommendation.
// SHIPYARD_ROLE_CHILD and EXTENSION_REFUSED are suggested names, not existing values; lookup, cleanReason, refusal are to be written.
function extend(input, options = {}) {
  if (process.env.SHIPYARD_ROLE_CHILD === '1') {           // recommended marker name, Planner decision
    throw Object.assign(new Error('a role-hosted child cannot grant a review extension'), { code: 'EXTENSION_REFUSED' });
  }
  if (input.confirm !== 'extend-review-round') usage('--confirm extend-review-round is required');
  const ctx = context(input, options);                       // live head and base, repository, mode
  const next = lookup(ctx);                                  // shared lookup; same call the hosts make
  if (next.state !== 'limit' || next.limit >= core.ROUND_CEILING) throw refusal(/* named reason */);
  if (next.delta === false) throw refusal(/* no delta possible: never a full review */);
  const reason = cleanReason(input.reason);                  // control chars, length, hygiene rules
  // under withLock(directory, `extend-${pr}`): re-read, refuse a duplicate (PR, head, base), writeAtomic
}
```

### S1 probe (scratch only; outside the repository)

```js
// Seals N rounds of a carried needs-fix lineage with the repository's own fixture; run with a clean env
const { fixture, retainPlanningInput, setOriginalReview } = require('./tests/fixtures/code-review/artifact-fixture.cjs');
// round 1: retainPlanningInput(f, f.input(binding, 1, null, { ...raw, findings: [raw.findings[0]] }))
// round n>1: prior = art.priorCodeReviewVerdicts({ worktreePath, repository, phaseDir }).at(-1)
//   priorFindings = core.carryPriorFindings({ priorFindings: prior, deltaDiff, readSource })
//   blank = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [],
//             dispositions: priorFindings.map(x => ({ ref: x.ref, disposition: 'unresolved', justification: 'still fails' })) }
//   result = core.normalizeResult(blank, { round, scope: 'delta', priorFindings, readSource })
//   input = f.input(binding, round, previous, { ...blank, dispositions: [] }); input.result = { ...input.result, ...result }
//   setOriginalReview(input, blank, priorFindings); retainPlanningInput(f, input); art.sealJudgment(input)
```

Template for the real tests: `role-artifact.test.cjs:1982-2036` (the carried-findings loop) and `phase-code-review.test.cjs:180-231` (rounds with `f.advance(n)` and `artifactInput`).

## S1/S4 probe (research evidence, not the spike record)

`[VERIFIED: scratch run this session, outputs quoted]`. Scratch copies of `plugins/delivery-pipeline` and `tests/fixtures/code-review` were patched with `sed` in a temp directory outside the repository; no repository file was modified (`git status` shows only the operator's pre-existing planning changes). Environment copied from `tests/unit/run.sh` (clean `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`, `GIT_CONFIG_GLOBAL`). Limits: Claude-runtime fixture only; one carried BLOCKER; the Codex path (`retainPlanningInput(..., { runtime: 'codex' })`) was not probed; the probe scripts are not retained. **The first ticket must produce its own committed record.**

| Variant | Patch | Result |
|---------|-------|--------|
| A: rc.2 unpatched | none | rounds 1-3 seal, each `auth=true`; round 4 → `PROBE ERROR INVALID_RESULT invalid review round or scope` (from `normalizeResult`, `:196`) |
| B: ceiling at normalize and seal only | `:196` and `role-artifact.cjs:3146` use a ceiling of 5; `:3190` unchanged | rounds 1-4 seal and authenticate (`current=round=4 verdict=needs-fix`); round 5 → `SEAL-REFUSED REVIEW_NATIVE_INVALID original carried findings lack authenticated sealed source lineage`; `current=null` |
| C: ceiling at all three | plus `:3190` uses the ceiling | rounds 1-5 seal; `history=[r1…r5]` all `auth=true`; `current=round=5 verdict=needs-fix`; round 6 refused by `normalizeResult` |
| S4: seal 4 rounds with C, then read with rc.2 code | same worktree and state home | new code: `READ OK: r1:auth=true … r4:auth=true`, `nextRound: {"round":null,"state":"limit","rounds_used":4}`; rc.2 code: `READ THROWS: INVALID_RESULT invalid code-review round, scope or prior_head` (the check at `role-artifact.cjs:3146`-`3150`, reached through `judgmentResultData` at `:3233`, outside the try at `:3243-3248`) |

Consequences for the plan: the ceiling must land as one change across `code-review-core.cjs:196`, `role-artifact.cjs:3146` and `:3190`; with `>= ceiling` the full five-chain authenticates; the rollback hazard is real and cannot be fixed retroactively, only documented.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `report` as the only exit, edited into `.planning/config.json` | A per-PR head-bound record, `report` kept | ADR-035 accepted 2026-11-02 | Narrower, visible exit; hold stays |
| "no waiver store" (ADR-032, from git history `94d05497`, not in this branch) | One unsigned private record per extra round | ADR-035 R-1..R-4 | ADR-032's single-exit sentence is amended |
| Round cap enforced at four places with the value 3 | Per-PR limit from history; absolute ceiling 5 in seal and replay | this phase | See §Pattern 1 |

**Deprecated/outdated:** the phrases "for this PR" and "no waiver record" in every text that offers `report` (it is project-wide, `pipeline-config.cjs:536`).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A Codex role child run under the `:workspace` profile cannot write `~/.local/state/shipyard/code-review-publications` (profile built at `codex-runtime-host.cjs:1079-1098`; the allow scope of `:workspace` is Codex's, not this repo's) | R-2 marker | If it can, the marker is the only guard on the Codex path |
| A2 | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not set in an operator's own shell, so refusing on it would be safe; not verified against Claude Code | R-2 marker | A legitimate operator extension would be refused; this is why a Shipyard-owned marker is recommended instead |
| A3 | Stripping `@`, `<`, `>` and backticks from the reason is the right public-text policy; no repository policy exists | Pitfall 8 | Over- or under-sanitized public text |
| A4 | `extend` should refuse unless the live state is `limit`, and be idempotent per (PR, head, base) | Pattern 4 | Without it, a premature or retried command grants extra rounds under the ADR formula |
| A5 | Operator name only, not email, in public text | Pattern 3 | Email would be published on the PR |
| A6 | `make package-shipyard-codex` needs no network. `scripts/package-shipyard-codex.cjs` is pure `node:fs`/`node:crypto` (read in full in cycle 1, `:1-77`) and writes to `process.argv[2]` or `plugins/shipyard` (`:12`, `:77`); the Makefile prefix `source scripts/ensure-gsd-core.sh --library && validate_isolated_node_options` (`Makefile:7`) was not run here | R-9 | The regeneration step may need network or a helper the script itself does not |
| A7 | The committed `plugins/shipyard` mirror equals a fresh build at `749604b9`. Evidence: `git show --stat 749604b9` lists only the six version files (two of them under `host/`), which is only possible if no other `host/` file differed; a direct `diff -r` of a scratch build against the mirror was blocked in this session (reads outside the working directory) | R-9, §Release bump | If the mirror is already stale, the bump PR also rewrites the stale `host/` files and exceeds six files |
| A8 | A Bash subprocess of a role-hosted child keeps `SHIPYARD_ROLE_CHILD=1` in its environment (it is a plain variable, not a credential; the Claude sandbox denies only the names in `SENSITIVE_SUBPROCESS_ENV`, `claude-runtime-host.cjs:757`, and Codex prunes only named keys, `codex-runtime-host.cjs:1172-1182`); not run against either runtime | Pitfall 14, Open Question 2 | If kept (the intended case), the `extend` tests of 54-07 and 54-14 must clear it; if stripped, the marker refuses nothing on that path (A2) |

## Open Questions (RESOLVED)

All four were settled when the phase was planned. Each answer names the plan that builds it.

1. **Does the sealed verdict carry the line as a field, or is the line derived at publish time?** (RESOLVED)
   - Known: the sealed path for `review_round`/`review_scope` is clear (§Pattern 6); a field needs core, role-artifact, both hosts and six test files.
   - Unclear: whether the operator accepts that cost over a derived line.
   - Recommendation: implement the field (literal R-7) in its own split; record the decision in the plan.
   - **Answer:** the sealed verdict carries the line as a field, `review_extension {operator, at, reason}` (ADR-035 R-7), not a line derived at publish time. **Built by 54-08** (core validator, packet, normalization, seal validation, replay, current verdict); the hosts pass the value in 54-09 and the PR texts read it in 54-10.

2. **Which marker refuses a host-child call?** (RESOLVED)
   - Known: `claudeEnvironment` always sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'` (`claude-runtime-host.cjs:84-88`); `launchEnvironment` sets only `CODEX_HOME`, `SHIPYARD_CODEX_CAPABILITIES_FILE`, `SHIPYARD_RUNTIME` and is also used by non-child hosts (`runtime-context.cjs:394-404`); `CODEX_SANDBOX` marks any Codex session including the operator's (`runtime-context.cjs:90-93`).
   - Unclear: none of those separates a role child from the operator on Codex.
   - Recommendation: add one Shipyard-owned variable in `claudeEnvironment` and after `launchEnvironment` at `codex-runtime-host.cjs:1167`. Neither file is in the digest pin: `tests/unit/runtime-file-digests.json:4-5` lists exactly two files, `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs` and `plugins/delivery-pipeline/scripts/runtime-adapters.cjs`, so no file this phase touches needs `make refresh-runtime-digests`. Existing tests assert single env keys, not whole-object equality (`claude-runtime-host.test.cjs:272-279`, `codex-runtime-host.test.cjs:304-307`).
   - Cycle-1 nuance: `claudeEnvironment` has two callers, the `--version` probe (`claude-runtime-host.cjs:187`) and the role launch (`:701`); see §Pitfall 11. Setting the marker at `:701` only is the narrower placement; both pass the existing assertions.
   - **Answer:** one Shipyard-owned variable, `SHIPYARD_ROLE_CHILD=1`, set in the Claude child environment (`claudeEnvironment`) and on the Codex child environment right after `launchEnvironment`; `extend` refuses under it. **Chosen and added by 54-07.** It is defence in depth, not a cryptographic claim (A1, A2 stay LOW confidence).
   - **Cycle-2 check (source and plan agree):** 54-07 puts the marker inside `claudeEnvironment` itself (54-07-PLAN.md:61), so the `claude --version` probe at `claude-runtime-host.cjs:187` also carries it; harmless, and Pitfall 11 already names the narrower placement. On Codex the `env` returned by `launchEnvironment` (`codex-runtime-host.cjs:1167`) is pruned only by named-key deletions (`:1172-1182`: `CODEX_MODEL…`, `OPENAI_API_KEY`, `ANTHROPIC_*`, `GNUPGHOME`, `SSH_AUTH_SOCK` and similar; no allow-list), so a marker set right after `:1167` reaches the child. Every Claude role launch is built by one function, `createClaudeCliLauncher` (`claude-runtime-host.cjs:693`; consumers `claude-decompose-host.cjs:364`, `claude-delivery-host.cjs:798`, `claude-role-host.cjs:1293`), so executors carry the marker, not only reviewers. The digest claim holds: `tests/unit/runtime-file-digests.json` pins only `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`. **Caveat the plans do not cover:** the marker is inherited by whatever a role child runs, including the `extend` unit tests of 54-07 and 54-14; see Pitfall 14 and A8.

3. **Where do the release-note words about the one-time reset live?** (RESOLVED)
   - Known: `docs/releases/` holds only `v0.70.0.md` and `v0.71.0.md` (ls this session); `release-notes-smoke.sh:4`, `:32` and `:43` expect a GitHub release per `v*` tag, created by `gh release create` (the check lists releases with `gh release list`); the bump ticket may change only the six files.
   - Recommendation: draft the text in the reference-edit ticket's PR body and hand it to the operator for the GitHub release; do not add a file in the bump ticket.
   - **Answer:** the release-note paragraph (one-time reset of in-flight verdicts, rounds above 3 need an operator record, no downgrade of a project holding a sealed round-4 or round-5 verdict) lives in the PR body of **54-13**. The bump ticket 54-15 adds no file.

4. **Is the `extend` precondition (state is `limit`) acceptable?** (RESOLVED) See A4; ADR R-1 is silent.
   - What the ADR says: R-4's "consumed" branch keeps a record valid while its head is an ancestor of the current head and a countable verdict for that head sealed after the record exists. A record written while rounds are still free, at a head that then gets an ordinary round, is therefore "consumed" by that ordinary round and still adds one to the limit (§Pattern 4). R-1 (ADR-035:26) and R-15 (ADR-035:40, "the record is written after the fixes settle") do not state a write-time precondition.
   - **Answer:** the `extend` precondition is that the live status is `limit` (rounds used have reached the effective limit) and the ceiling of 5 is not yet reached. It is a consequence of R-4: without it a record written early would be consumed by an ordinary round and still add one round that nobody confirmed against the findings. Reading the store only once the countable verdicts reach `ROUND_CAP` (54-04-PLAN.md:33) is a separate cost saving and does not close that hole; the write-time precondition does. **Embodied by 54-07** (54-07-PLAN.md:30) and exercised end to end by 54-14 (Scope items 1 and 3 of that plan: `extend` after a push at `limit`, and a record voided by a head move). ADR-035 R-1 (ADR-035:26) is silent on it and so is R-15 (ADR-035:40); the INV-021 evidence only asks that the record be written after the last push and be idempotent per (PR, head) (`research/risks.md:180-191`; `DECISIONS.md:24`).
   - **Corrected in cycle 2:** the first wording called this "an operator-confirmed default at Gate 2". Nothing is confirmed: Gate 2 in this repository is the mechanical `validate-graph.cjs` check, after which the user approves the ticket set (`plugins/delivery-pipeline/commands/decompose.md:568-600`), and 54-15 itself says the plan set "does not treat the exception as already granted" for R-12 (54-15-PLAN.md:110). The precondition is a **planner default**, not a locked decision; it becomes the operator's decision only when the operator approves the set, and the plan-checker must not treat it as locked.
   - **Cycle-2 source fact that bounds the precondition:** `status` returns `state: 'current'` as soon as the head has a counted complete verdict (`phase-code-review.cjs:165-175`) and derives `limit` only afterwards (`:178`, `state: next.state === 'limit' ? 'limit' : 'owed'`). So `limit` is reachable only at a head with no counted verdict. An operator whose head was just reviewed in round 3 is refused until the fixes are pushed, which matches R-15 ("the record is written after the fixes settle"); the refusal text 54-07 writes should say "push first" for state `current`, not only "not at the limit".

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | all tests | ✓ | v24.21.0 | — |
| git | fixtures, `is-ancestor` | ✓ | present (fixtures ran) | — |
| `gh` + network | `make test-releases`, live `publish` | ✗ in this sandbox: `git ls-remote --tags origin` → `github.com:22: 403 user denied` | — | Executor runs it on a networked machine; unit tests use a fake `gh` |
| `timeout` command | none required | ✗ on this host | — | not needed |
| Real `~/.local/state/shipyard` | must not be used | read-denied here | — | tests override `os.homedir` |

**Missing dependencies with no fallback:** `make test-releases` cannot run in this sandbox; it only checks that every `v*` tag on origin has a GitHub release (`release-notes-smoke.sh:14-52`), not version consistency. Version consistency is checked by `tests/unit/files-contract.test.cjs:507-508` ("plugin.json is … but capability.json is … — bump both together").

**Baselines (all green at `749604b9`; each file run alone in the isolated per-file environment of §Validation Architecture; several ran in parallel, so durations are inflated):**

| Test file | Result | Duration | Measured |
|-----------|--------|----------|----------|
| `refusal-hints.test.cjs` | 23/23 | under 1 s | original session and cycle 1 |
| `code-review-core.test.cjs` | 26/26 | under 1 s | original session and cycle 1 (`duration_ms 377`) |
| `code-review-foreign-contract.test.cjs` | 6/6 | about 10 s | original session |
| `phase-code-review-publish.test.cjs` | 102/102 | about 274 s | original session |
| `phase-code-review.test.cjs` | 68/68 | about 329 s | original session |
| `codex-code-review-context.test.cjs` | 153/153 | about 496 s | original session |
| `role-artifact.test.cjs --code-review-d37-only` | 6 passed, 0 failed (`d37Selected` 6) | 28 s | cycle 1 |
| `claude-role-host.test.cjs` | 235/235 | 400 s | cycle 1 |
| `deliver-dispatch.test.cjs` | 41 passed, 0 failed (harness output, not TAP) | 17 s | cycle 1 |

Nothing is unmeasured any more; the "Baselines for the three unmeasured test files" gap of the first draft is closed. The three slow files (`phase-code-review`, `phase-code-review-publish`, `codex-code-review-context`, 4-8 minutes each) are the reason a verify command should scope with `--test-name-pattern` where the file is `node:test`-based (§Validation Architecture). Not re-measured in cycle 1: `code-review-foreign-contract`, `phase-code-review-publish`, `phase-code-review`, `codex-code-review-context` (the original-session figures stand; the working tree has no source change since).

## Validation Architecture

`workflow.nyquist_validation` is `true` in `.planning/config.json` (read this session), so this section is included.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` (TAP output: `code-review-core`, `refusal-hints`, `claude-role-host`, `phase-code-review`, `phase-code-review-publish`, `codex-code-review-context`) or the in-repo `assert-harness.cjs` (`role-artifact`, `deliver-dispatch`: "N passed, 0 failed"); each file is a standalone script |
| Config file | none; `tests/unit/run.sh` gives each file a private environment (`:10`, `:103-125`); a new `tests/unit/*.test.cjs` is picked up by `unit_files=(tests/unit/*.test.cjs)` (`run.sh:21`) and by `shard-files.cjs:22`, default shard weight 5 (`shard-files.cjs:10`), with no registration |
| Quick run command | `node tests/unit/<file>.test.cjs` in the `run.sh` environment below; inside a `node:test` file scope with `node --test-name-pattern '<regex>' tests/unit/<file>.test.cjs` `[VERIFIED: cycle 1, 'rounds count' selects 1 test of code-review-core, 1 pass]` |
| Full suite command | `make test-unit` (CI's job per CONTEXT; CI runs `UNIT_SHARD=<i>/<n>` at `.github/workflows/test.yml:73`) |

Run one file in `run.sh`'s environment. This block mirrors `run.sh:10` (unset the four host markers) and `:103-125` (per-worker `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`/`TMP`/`TEMP`, `XDG_*`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, git identity, `init.defaultBranch main`); `[VERIFIED: cycle 1, code-review-core 26/26 and refusal-hints 23/23 ran green with it]`:

```bash
W="$(mktemp -d)"; mkdir -p "$W"/{home,tmp,codex,config,cache,state,data,runtime,claude}; chmod 700 "$W/runtime"
git config --file "$W/gitconfig" user.name t; git config --file "$W/gitconfig" user.email t@t.invalid
git config --file "$W/gitconfig" commit.gpgsign false; git config --file "$W/gitconfig" tag.gpgsign false
git config --file "$W/gitconfig" init.defaultBranch main
env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_CODE_ENTRYPOINT -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED \
  HOME="$W/home" CODEX_HOME="$W/codex" CLAUDE_CONFIG_DIR="$W/claude" TMPDIR="$W/tmp" TMP="$W/tmp" TEMP="$W/tmp" \
  XDG_CONFIG_HOME="$W/config" XDG_CACHE_HOME="$W/cache" XDG_STATE_HOME="$W/state" XDG_DATA_HOME="$W/data" \
  XDG_RUNTIME_DIR="$W/runtime" GIT_CONFIG_GLOBAL="$W/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
  node tests/unit/code-review-core.test.cjs
```

(The first draft used `env -i PATH=… HOME=…`, which drops every other variable and omitted `init.defaultBranch main`, `tag.gpgsign`, `TMP`, `TEMP` and four `XDG_*` names; corrected in cycle 1 to match `run.sh`.)

`role-artifact.test.cjs` is very large. `--code-review-d37-only` selects **four name groups, six cases**: three exact names and one prefix (`role-artifact.test.cjs:42-46`); `d37Selected` is counted at `:49` and asserted equal to 6 at `:2315`; `--code-review-reuse-only` selects one case (`:50`, `:2316`); only one selection flag is accepted (`:39-40`). Corrected in cycle 1: the first draft said "the three code-review cases".

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-204 | `extend` writes a 0600 record in a 0700 directory under the overridden home; a wrong or missing `--confirm` refuses; the record mutation matrix (json, oversize, directory, symlink, mode, namespace-mode, ancestor-symlink, schema, repository, selector, pr, base, unreadable, wrong owner); the read path creates no directory | unit | `node tests/unit/phase-code-review.test.cjs` (fixture `:46-74`, CLI spawn pattern `:102-118`) and one new `tests/unit/*.test.cjs` for the store (matrix pattern `phase-code-review-publish.test.cjs:885-921`, path helper `:655-660`) | ✅ fixtures; ❌ new cases, Wave 0 |
| REQ-205 | `extend` refuses under the child marker (direct call and CLI) and creates nothing; the record path is outside the worktree and the planning checkout; both runtime hosts put the marker in the child environment | unit | `node tests/unit/phase-code-review.test.cjs`; marker asserted like `claude-runtime-host.test.cjs:272-279` and `codex-runtime-host.test.cjs:304-307` (run both files) | ❌ Wave 0 |
| REQ-206 | no record → `limit`; a record for another head, base or PR does not apply; several records clamp at 5; sequence round 4 → push → new record; the three call sites agree | unit | `node tests/unit/code-review-core.test.cjs` (table `:167-180`, `:352-372`, stubbed `isAncestor`); `node --test-name-pattern 'D37 fix tickets' tests/unit/phase-code-review.test.cjs` (`:180-229`); `claude-role-host.test.cjs:2435-2468`; `codex-code-review-context.test.cjs:243-254`, `:1060-1093`; history shape `role-artifact.test.cjs:1933-1980` | ✅ pattern; ❌ cases |
| REQ-207 | normalize, seal and replay-depth at 5; a five-deep carried lineage authenticates; rc.2 reader throws on a sealed round-4 verdict | unit | `node tests/unit/role-artifact.test.cjs --code-review-d37-only` (a new case must be registered in `d37Case` and `d37Selected` raised at `:2315`, §Pitfall 13); `node tests/unit/code-review-core.test.cjs` for the `normalizeResult` ceiling | ❌ Wave 0 (no test of `role-artifact.cjs:3190` exists) |
| REQ-208 | an extended round is delta or refuses; `repairAllowed` is true for 1-2 only; `repair: 'human'` for rounds 4 and 5 | unit | `code-review-core.test.cjs:180` extended from `[1,2,3]` to `[1,2,3,4,5]`; `phase-code-review.test.cjs:193` (`round < 3 ? 'tickets' : 'human'`) and the `:180-229` loop extended | ✅ pattern |
| REQ-209 | status text ≤140 with an extension at maximum counts; comment header carries the line; named hints for the extend command and `report`; hygiene on the comment; every text offering `report` says project-wide | unit | `node tests/unit/phase-code-review-publish.test.cjs` (`:382-396`, comment footer `:182`, `:360`, limit text `:212`); `node tests/unit/refusal-hints.test.cjs`; the order-sensitive wording regexes of §Pattern 9 in `phase-code-review.test.cjs`, `deliver-dispatch.test.cjs`, `deliver-builders-contract.test.cjs`, `claude-role-host.test.cjs:2465` | ✅ pattern |
| REQ-210 | the reference states rounds 1-5 with a fourth round only on a record; the reference tests still pass | unit | `node tests/unit/judgment-contract.test.cjs`, `node tests/unit/claude-reference-content.test.cjs`, `node tests/unit/source-contract.test.cjs` (§Pattern 10 lists what each reads) | ✅ |
| REQ-211 | one delta per batch of fixes; a record voided by a head move costs nothing; the ceiling is final; net-lines report | unit + PR text | the core and `phase-code-review` tests above; `git diff --shortstat <base>...HEAD -- . ':!plugins/shipyard'` in each PR | ✅ |
| REQ-212 | the six files carry `1.0.0-rc.3`; plugin and capability versions agree; the mirror matches the source | unit + smoke | `node tests/unit/files-contract.test.cjs` (`:504-508`), `node tests/unit/marketplace-install.test.cjs` (`:60-104`), `make test-releases` (needs network and `gh`, unavailable in this sandbox) | ✅ |

### Test files that pin the cap or the wording (reproduces ADR-035's "nine")

`[VERIFIED: Grep and reads, re-checked in cycle 1]` Seven files pin the cap, the limit state or its text: `code-review-core.test.cjs` (`:167-180`, `:352-372`; `repairAllowed` at `:180`: `assert.deepEqual([1,2,3].map(core.repairAllowed),[true,true,false]);`), `code-review-foreign-contract.test.cjs` (`:52`: `const roundsUsed = (prior, head) => core.nextRound({ priorVerdicts: prior, head, isAncestor: () => true }).rounds_used;`, a caller with no `mergeBase`), `phase-code-review.test.cjs` (`:180-229`, `:418-419`, `:449`, `:465`, `:718`), `phase-code-review-publish.test.cjs` (`:187-215`, `:382-396`), `role-artifact.test.cjs` (`:1933-1980`, `:2287`: `assert.equal(status.rounds_used, 1); assert.equal(status.round_cap, 3);`, which stays true because `round_cap` stays 3), `claude-role-host.test.cjs` (`:2435-2468`; `:2464-2465`: `error.code === 'CODE_REVIEW_ROUND_LIMIT' && /three rounds/.test(error.message)`) and `codex-code-review-context.test.cjs` (`:243-254`, `:1060-1093`). Two more pin only the `report` wording: `deliver-dispatch.test.cjs` (`:1128`, `:1165`, `:1185`, `:1191`) and `deliver-builders-contract.test.cjs` (`:71`, `:195`). That is nine files, which reproduces ADR-035's "nine unit files that pin the cap" (ADR-035:46). `judgment-artifacts.test.cjs:996` only mutates `review_round` to 2 and is not a pin. `role-artifact.test.cjs` loads fixtures out of `codex-code-review-context.test.cjs` and `claude-role-host.test.cjs` by exports (`:2209-2227`, calls at `:2225-2226`), so a change to those fixtures' exported names also affects it.

Existing tests whose *structure* constrains the work, not their wording (all verified in cycle 1):

| Test | Lines | Constraint it puts on a ticket |
|------|-------|--------------------------------|
| `phase-code-review-publish.test.cjs` | `:1047-1072` | runs the **mirror copy** of `phase-code-review.cjs` beside the source copy on one publication record and lock (§Pitfall 10) |
| `codex-code-review-context.test.cjs` | `:622-637` | appends a byte to each of the 15 pinned host sources and expects `STALE_CONTEXT` (§Pitfall 12) |
| `role-artifact.test.cjs` | `:42-51`, `:2315-2316` | `--code-review-d37-only` registration count (§Pitfall 13) |
| `phase-code-review-publish.test.cjs` | `:208` | the namespace directory must not exist after a refused publication, so a read path may not create it |
| `refusal-hints.test.cjs` | `:37-40`, `:78-79`, `:131-133`, `:143` | frozen entries, no bypass words, remedy path rules, no destructive verbs next to history words (§Pattern 8) |
| `host-entry-contract.test.cjs` | `:202-211` | only resolver, preflight, legacy and identity codes must be in `LAUNCH_CODES`; the new hint codes need not be |

### Sampling Rate

- **Per task commit:** the single touched test file(s) in the clean environment above, scoped with `--test-name-pattern` where the file is `node:test`-based (the three slowest files take 4-8 minutes whole, §Environment Availability), plus `node --check` on each touched script (`run.sh:34-36` does the same for every script).
- **Per wave merge:** all touched test files whole; `make test-comment-policy COMMENT_POLICY_BASE=origin/epic/harness-simplification` (`Makefile:109-110`).
- **Phase gate:** CI's full suite (`UNIT_SHARD` at `.github/workflows/test.yml:73`, `make test-fast-rest` at `:121`); the executor does not run it locally.

### Wave 0 Gaps

- [ ] A committed S1/S4 record and test (round-4/5 seal, five-deep carried lineage, rc.2 reader throws), because no test covers `role-artifact.cjs:3190`.
- [ ] Extension-record tests (a new `tests/unit/*.test.cjs` is auto-picked by `run.sh:21` and `shard-files.cjs:22` and is not packaged).
- [ ] An extended-round case in the status-grammar maximum test (`phase-code-review-publish.test.cjs:382-396`).
- [ ] A child-marker assertion in the two runtime-host tests (`claude-runtime-host.test.cjs:272-279`, `codex-runtime-host.test.cjs:304-307`).
- [ ] Every new `role-artifact.test.cjs` case that must run under `--code-review-d37-only` registered in `d37Case` with `d37Selected` raised at `:2315` in the same change.
- [ ] `SHIPYARD_ROLE_CHILD` cleared from `process.env` at the top of `phase-code-review.test.cjs` (beside `:9-12`) before any case that expects `extend` to succeed; set and restored only in the child-refusal cases (Pitfall 14, added in cycle 2).
- [x] Baselines for the three unmeasured test files: closed in cycle 1 (§Environment Availability).

## Security Domain

`security_enforcement` is enabled in `.planning/config.json` (`true`, `security_asvs_level: 1`).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | The record is unsigned by decision; the operator is whoever runs the command (ADR-035 R-2). Do not claim authentication |
| V3 Session Management | no | — |
| V4 Access Control | yes | Child sandbox write allow-list (`claude-runtime-host.cjs:756`, `allowWrite: [path.resolve(scope.worktree)]`), the child marker, and a state dir outside the worktree (`phase-code-review.cjs:313-317`) |
| V5 Input Validation | yes | Strict CLI pairs (`:516-528`), `--confirm` literal, reason sanitization and bound, hygiene rules, head/base as 40-hex (`:110`) |
| V6 Cryptography | no | None; do not add signing (out of scope) |
| V12 Files and Resources | yes | 0700/0600, uid check, `O_NOFOLLOW`, size bound, lock, atomic write (reuse `:306-391`) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Model forges consent in the orchestrating session | Spoofing / Elevation | Accepted and stated (R-2); not a cryptographic claim |
| Role child writes the record | Tampering | Sandbox allow-list, plus the marker refusal |
| Symlink or TOCTOU on the state directory | Tampering | Reuse `readPublication` hardening and `publicationNamespace` containment check |
| Public-text injection (mention, HTML, internal identifiers) | Information disclosure | Sanitize at write; hygiene rules; truncate in status |
| Double-grant by retry | Repudiation | Idempotent `extend` per (PR, head, base) |
| Stale record after head or base move | Tampering | Derived validity (void costs nothing) |

## Net-code offsets (R-12)

Deletions available in the same epic, with sizes measured from the files read:

- the two identical copies of the refusal sentence: `phase-code-review.cjs:87-90` and `deliver-dispatch.cjs:1207-1209`, plus the footer variant `:275` → one exported text;
- the three `countableVerdicts` + `nextRound` pairs and their limit messages: `phase-code-review.cjs:154`, `claude-role-host.cjs:611-613`, `codex-code-review-context.cjs:148-149` → one shared call (about 20-30 lines);
- the duplicated hardened read inside `readPublication` if extracted rather than copied (`:338-368`).

Measure with `git diff --shortstat <base>...HEAD -- . ':!plugins/shipyard'`; no CI check enforces net lines (Grep of `.github` found none), so the PR text carries it.

## Release bump (R-9)

Exactly six files contain `1.0.0-rc` outside planning and audit docs (Grep this session). Current values, quoted:

| File | Line | Current |
|------|------|---------|
| `capabilities/delivery-pipeline/capability.json` | 4 | `"version": "1.0.0-rc.2",` |
| `plugins/delivery-pipeline/.claude-plugin/plugin.json` | 4 | `"version": "1.0.0-rc.2",` |
| `plugins/shipyard/.codex-plugin/plugin.json` | 3 | `"version": "1.0.0-rc.2+codex.994abcd6a5390e26",` |
| `plugins/shipyard/package-build.json` | 2-3 | `"version": "1.0.0-rc.2+codex.994abcd6a5390e26",` / `"digest": "ee1a05c0928de82cdd352f679e9aeb02921e5b6937d5ac9066182648f5322c3a",` |
| `plugins/shipyard/host/capabilities/delivery-pipeline/capability.json` | generated copy | same as row 1 |
| `plugins/shipyard/host/plugins/delivery-pipeline/.claude-plugin/plugin.json` | generated copy | same as row 2 |

`749604b9` changed exactly these (`git show --stat`). The `+codex.<16 hex>` suffix and the `digest` are computed by `scripts/package-shipyard-codex.cjs` from every packaged file except `package-build.json` and `.codex-plugin/plugin.json` (the `walk` function, exclusion at `package-shipyard-codex.cjs:55`), so they cannot be hand-edited; run `make package-shipyard-codex` (`Makefile:6-7`).

**Ordering fact:** the bump touches only six files only if the mirror already matches the feature's source. `build()` copies the **whole** `plugins/delivery-pipeline` and `capabilities/delivery-pipeline` trees (`package-shipyard-codex.cjs:20-23`), so after Phase 54's source edits the committed `host/` copy of every touched script, of `references/code-review.md`, of `commands/deliver.md` and of `capability.json` is stale, and a regeneration at bump time would rewrite all of them. So a mirror regeneration for the feature must precede the bump (ADR-035 R-9: "after the feature merges and the Codex package is regenerated"; CONTEXT: regenerated once before the epic goes to `main`). **Planner decision:** where that regeneration lives given CONTEXT's "do not regenerate in ticket PRs" and "no plan modifies more than 10 files"; the stale-by-content mirror is tolerated during the epic because the freshness assertion is skipped for `epic/` and `ticket/` bases (`marketplace-install.test.cjs:70-73`, `:93-97`; `package-shipyard-codex.cjs:71-74`).
**Read-only freshness check (method, not run):** `build(destination)` writes only to its argument and `if (require.main === module) console.log(build(process.argv[2]))` (`:12`, `:77`), so `node scripts/package-shipyard-codex.cjs <empty-temp-dir>` followed by `diff -r plugins/shipyard <empty-temp-dir>` proves the mirror matches without touching the repository. The combined build-and-diff command was denied in this session (it read outside the working directory), so neither half was run here and "the mirror matches at `749604b9`" stays A7 `[ASSUMED]`; plan 54-15's precondition (54-15-PLAN.md:119) performs this same check before the bump.

## Sources

### Primary (HIGH confidence)
- `code-review-core.cjs` (read in full), `phase-code-review.cjs` (read in full), `refusal-hints.cjs` (read in full), `role-artifact.cjs:2820-3470`, `claude-role-host.cjs:540-690`, `codex-code-review-context.cjs:95-205`, `deliver-dispatch.cjs:541-549`, `:1203-1214`, `claude-runtime-host.cjs:84-88`, `:752-759`, `codex-runtime-host.cjs:1165-1175`, `runtime-context.cjs:90-98`, `:394-404`, `pr-hygiene.cjs:208-239`, `gate-trailer.cjs:164-167`, `lock.cjs` (header and `:395-435`), `comment-policy.cjs:9-14`, `references/code-review.md:22-27`, `:47-52`, `tests/fixtures/code-review/artifact-fixture.cjs` (read in full), `scripts/package-shipyard-codex.cjs`, `tests/unit/runtime-file-digests.json`, `Makefile:105-118`, `CLAUDE.md`.
- `.planning/architecture/ADR-035-human-granted-review-round.md`, `.planning/phases/54-…/CONTEXT.md`, `.planning/REQUIREMENTS.md:205-213`, `.planning/ROADMAP.md` phase 54, `.planning/investigations/INV-021-human-review-round-extension/{RESEARCH,RISKS,DECISIONS}.md`.
- Scratch probe run in the original session (S1/S4 table above); its seal-time and history-read arithmetic was re-derived from the source in cycle 1 (§Pattern 2).
- Read in full or in the cited ranges during cycle 1: `code-review-core.cjs:1-30`, `:180-210`, `:285-350`, `:500-533`; `phase-code-review.cjs:1-541` (all); `role-artifact.cjs:2829-2836`, `:2868-2882`, `:2905-2946`, `:3044-3064`, `:3144-3151`, `:3186-3252`, `:3256-3277`, `:3462-3470`, `:4094-4100`; `claude-role-host.cjs:55-59`, `:594-614`, `:639-642`, `:1200-1203`, `:1891-1894`; `codex-code-review-context.cjs:1-29`, `:102-150`, `:170-173`, `:296-336`, `:425-428`; `claude-runtime-host.cjs:82-90`, `:183-192`, `:697-704`, `:750-760`; `codex-runtime-host.cjs:1077-1099`, `:1163-1176`; `scripts/package-shipyard-codex.cjs` (all); `tests/unit/run.sh:1-56`, `:98-127`.

### Secondary (MEDIUM confidence)
- Test files read in part (cycle 1 adds the ranges named in §Validation Architecture and §Pattern 9): `phase-code-review.test.cjs:1-16`, `:44-79`, `:96-124`, `:160-229`; `phase-code-review-publish.test.cjs:1-16`, `:170-219`, `:352-397`, `:655-670`, `:872-921`, `:1035-1072`; `code-review-core.test.cjs` (names and `:167-180`); `role-artifact.test.cjs:1-60`, `:1925-2040`, `:2205-2231`, `:2278-2318`; `claude-role-host.test.cjs:2432-2469`; `codex-code-review-context.test.cjs:240-255`, `:296-304`, `:600-642`, `:1058-1093`; `refusal-hints.test.cjs` (Grep); `deliver-dispatch.test.cjs` and `deliver-builders-contract.test.cjs` (Grep and `:66-73`); `marketplace-install.test.cjs:55-104`; `host-entry-contract.test.cjs:196-213`; `judgment-contract.test.cjs:606-620`; `claude-reference-content.test.cjs:40-64`; `source-contract.test.cjs:440-500`; `claude-runtime-host.test.cjs:262-282`; `codex-runtime-host.test.cjs:296-311`.
- `tests/smoke/release-notes-smoke.sh` (Grep of `:4-52`), `.github/workflows/test.yml` (Grep of node version, `UNIT_SHARD`, `COMMENT_POLICY_BASE`).
- The fifteen `54-NN-PLAN.md` files, read only as far as needed to confirm which plan embodies Open Questions 1-4 (frontmatter of all fifteen; `54-04` lines 30-34 and 65; `54-07` lines 29-30, 61; `54-08` lines 27-28, 60; `54-13` lines 26, 47; `54-15` lines 29, 58-62, 119-128). The plans are downstream of this document and are not edited by it.

### Tertiary (LOW confidence)
- Anything about Claude Code's handling of `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` and Codex's `:workspace` write scope (A1, A2): not verifiable from this repository.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no external packages.
- Architecture: HIGH for cap locations, replay bound and store precedent (read and probed); MEDIUM for the shared-lookup shape and the sealed field (a recommendation over existing paths).
- Pitfalls: HIGH for the probe-backed and test-backed ones (Pitfalls 1-7, 9-13); MEDIUM for A3-A5 (Pitfall 8).
- Validation commands: HIGH for the clean-environment block and the `--test-name-pattern` scoping (both executed in cycle 1); MEDIUM for the per-REQ rows that name tests which do not exist yet.

**Research date:** 2026-11-02 (revised in cycle 1, same date)
**Valid until:** until `epic/harness-simplification` moves past `749604b9` in any of the files cited; re-check line numbers before editing.

## Revision log

- **Cycle 1.** Open Questions 1-4 are marked RESOLVED with the plan that embodies each (Q1 sealed field, 54-08; Q2 `SHIPYARD_ROLE_CHILD`, 54-07; Q3 release-note words in 54-13's PR body; Q4 `extend` precondition, 54-07, a planner default; "operator-confirmed" in that first wording was corrected in cycle 2). The researcher then re-verified every `path:line` and corrected: the packet-digest note (tickets.json drifted); the packaged-mirror rule (whole trees are copied; CI skips by base); the `report` wording pins (19 assertions in five files, not eight in three, including the comment footer pinned by `phase-code-review-publish.test.cjs:182`, `:360`); the `HISTORY_PATTERN` word list; the `run.sh` environment block; the `--code-review-d37-only` description and its count assertion; the seal-time lineage claim (now read, not inferred); and added Pitfalls 10-13 (mirror-copy test, `claudeEnvironment` callers, Codex pin list, d37 registration), Pattern 10 (reference edit), the measured baselines, the `sealed_at` timestamp-format constraint and A7.
- **Cycle 2 (verification only).** Re-read the four resolutions against the source and plans 54-04, 54-07, 54-08, 54-09, 54-10, 54-13, 54-14 and 54-15, plus `decompose.md` (Gate 2) and the INV-021 risk and decision files. **Q1 stands:** the sealed field chain matches the source (`normalizeResult` spread and return `code-review-core.cjs:295-297`; `codeReviewManifestFields` `role-artifact.cjs:2831-2835`, which also feeds the projection comparisons at `:3236` and `:4252` and the manifest write at `:4047`, so one edit covers all four; replay options `:3046` and byte comparison `:3062-3063`; the `current` object `:3456-3469`); `role_context` has no key allow-list (`context-packet.cjs:571-583`) and `AUTHORITY_KEYS` (`:34-39`) does not name `review_extension`; 54-09 and 54-10 hand the value on as stated. **Q3 stands:** `docs/releases/` holds only `v0.70.0.md` and `v0.71.0.md`, no test or script requires a file there (Grep outside `.planning`: no match), `release-notes-smoke.sh` checks only that pushed `v*` tags have a GitHub release (`:14-32`), and 54-13 (Scope 3, Delivery notes) and 54-15 (Out of scope) say what Q3 says. **Q2 stands with one added caveat:** the marker also reaches tests run inside a role child (Pitfall 14, A8, one Wave 0 gap). **Q4 corrected in wording only:** a planner default, not "operator-confirmed", plus the fact that `status` reports `current` before `limit`. No other section changed.
