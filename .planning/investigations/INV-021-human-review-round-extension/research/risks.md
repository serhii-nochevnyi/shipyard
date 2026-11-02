# INV-021 — Line 4: risks and unknowns

Investigation: INV-021-human-review-round-extension
Line: `risks` (risks and unknowns) — drafts for `RISKS.md` and `OPEN-QUESTIONS.md`
Source revision: `749604b9307ce21d7790f0a5b8f97920dca9aa7f` (`git rev-parse HEAD`, branch `epic/harness-simplification`) [V1]
Policy hash: `fc1706bc9272bd0f539fbd71fa966b736df15c2cadfc2a76a8b84924b33584b8` (ADR-014, `adr-014.v8`)
Runtime selection (caller-resolved): `claude-sonnet-5-5` / `xhigh`; exact policy signals preserved as DATA: `{}`
Date: 2026-11-02
Inputs read: `PROBLEM.md` (sha256 `3fbf5bf6…19a`), `RESEARCH-CONTRACT.md`, `DECISIONS.md`, `OPEN-QUESTIONS.md` (empty template), ADR-032 from git history (`94d05497`) [V3], `docs/audits/phase52/README.md`.

This file is a risk and unknown register. It does not choose a design, does not close Gate 1 and does not write an accepted ADR. Severity is the impact if the scenario occurs and is a **judgement**. Likelihood is **unknown** wherever no measurement exists.

Evidence labels:
- **[V#]** = checked by a command listed in section 9 (command, path, output or exit status recorded there).
- **[R]** = read directly with Read/Grep; `path:line` cited. A read is not an execution: no [R] claim says the code was run.
- **[A]** = assumption or inference; the next check is named.

---

## 1. Scope, limits and what this line did not do

- Production code, `.planning/graph/`, authority directories and `~/.local/state/shipyard/` were **not** modified. The only file written by this line is this artifact (plus the empty `research/` directory that holds it).
- **Blocked, not retried, not worked around:**
  1. A compound shell command that listed `~/.local/state/shipyard` and `~/.local/state/shipyard/role-artifact-authority` was **denied by the permission layer** [V8]. No file under `~/.local/state/shipyard/` was read, so the key's owner and mode, and any existing code-review publication or extension records, are **not observed**. Key mode and directory mode below come from code (`role-artifact.cjs:923-942`, `:990-1007`), which is [R], not an observation. See U-02.
  2. The incident repository `/Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp` is **unreachable from this session's sandbox**: `ls …/pdffiller-mcp/.planning` → `Operation not permitted`, exit 1 [V7]. Its branch `research/mcp-tools-ai-pdf-12908`, graph, `.shipyard-code-review-evidence.md` and local state were **not examined**. Nothing in section 3 is evidence about what actually happened in that session. See U-01.
  3. `git ls-remote --tags origin` was refused by the network proxy (`github.com:22: 403 user denied`) [V19]. Remote tag and release state is **not verified**.
- Throwaway-code validation was **not** done. Where a claim needs it, section 8 lists a `/gsd-spike`. The two ad-hoc probes that were run use stock utilities and write nothing: a PTY probe [V6] and a string-length calculation [V11].
- Existing test run: one pinned unit test was executed for command-backed evidence [V17]; the full suite was not run.

## 2. Deployment-state check (contract: prove the code is there before defect analysis)

The problem is a feature proposal, not "X does not happen in <env>", but the base-branch question matters for delivery.

| Question | Command | Result |
|---|---|---|
| Is the cap code present at the base? | Grep `ROUND_CAP` → `code-review-core.cjs:6,196,340`, `role-artifact.cjs:3146,3190`, `phase-code-review.cjs:132` [V2] | present |
| Is the base on `main`? | `git merge-base --is-ancestor 749604b9 main` | exit 1 (not an ancestor); `git rev-list --count main..749604b9` → 46 commits ahead [V5] |
| Which branches contain the base? | `git branch --contains 749604b9 --list 'epic/*' 'main'` | only `epic/harness-simplification` [V5] |
| When did `phase-code-review.cjs` last change? | `git log --oneline -8 -- plugins/delivery-pipeline/scripts/phase-code-review.cjs` | only `0878fb86` (Phase 52, #526) [V5] |
| Is the target release already cut? | `git tag --points-at 749604b9`; `git for-each-ref refs/tags/v1.0.0-rc.2` | local tag `v1.0.0-rc.2` points at the base commit, created 2026-11-01 [V18] |

Consequences:
- The cap, the single exit and the human-written disagreements file exist exactly as the problem statement describes at the base. No defect analysis is needed to explain "limit".
- **The base is 46 commits ahead of `main` and `v1.0.0-rc.2` is already tagged locally on it.** "Target release 1.0.0-rc.2" cannot mean "included in the tagged commit" unless the tag is moved. See R-19 and U-12.
- Which Shipyard build the incident session ran (`main`, an installed release, or the epic) is unknown. See U-03.

## 3. Findings that ground the risks

### F1. Every place that depends on the cap or on the countable-verdict count

| Site | What it does | Cap-dependent? |
|---|---|---|
| `code-review-core.cjs:6` | `ROUND_CAP = 3` | the constant |
| `code-review-core.cjs:196` | `normalizeResult` fails with `INVALID_RESULT` when `round > ROUND_CAP` | **yes: a round-4 review fails normalisation** |
| `code-review-core.cjs:338-346` | `nextRound`: `used >= ROUND_CAP` → `{round:null, state:'limit'}`; otherwise `round = used+1`, scope `delta` only when `coverageComplete` holds | **yes** |
| `code-review-core.cjs:347` | `repairAllowed(round)` = rounds 1 and 2 | pinned by test; out-of-scope to change |
| `phase-code-review.cjs:132,162` | status result carries `round_cap` and `rounds_used` | display only (`round_cap` has no other reader in `plugins/`) [V2b] |
| `phase-code-review.cjs:154,178-181` | `limit` state and its reason text `three rounds are spent …` | text |
| `phase-code-review.cjs:87-90` | `refusal()`: names the `report` exit, `no override flag and no waiver record` | text, used by status, gate, `fixTickets` stderr |
| `phase-code-review.cjs:169` | `repair: 'human'` when `!repairAllowed(round)` | reads round number, not the cap |
| `phase-code-review.cjs:209-215` | `statusDescription`: limit → `pending`, text `no further review will run for this head` | text becomes untrue if an extension can follow |
| `phase-code-review.cjs:269-298` | `findingsComment`: header `round N, scope S`; footer `Operator exit: set … report` when mode is hold and not a current pass | text; no `of 3` today |
| `phase-code-review.cjs:443-446` | `publish` on `limit` posts the status only and skips the comment | the round-3 comment (with its footer) stays on the PR |
| `claude-role-host.cjs:611-613` | prelaunch `nextRound`; `limit` → `CODE_REVIEW_ROUND_LIMIT`, text `three rounds are spent` | **yes (admission point on Claude)** |
| `codex-code-review-context.cjs:148-149` | same, text `three countable reviews have already run` | **yes (admission point on Codex)** |
| `role-artifact.cjs:3146` | seal-time validation rejects `review_round > ROUND_CAP` | **yes (defence in depth at sealing)** |
| `role-artifact.cjs:3188-3199` | replay-depth bound `lineage.active.size >= ROUND_CAP` → `REVIEW_NATIVE_INVALID` | **yes, and non-obvious (F3)** |
| `role-artifact.cjs:3216` | verdict with another `contract_digest` is skipped | indirect (F4) |
| `references/code-review.md:25,51` | tells the reviewer `review_round` is `Integer 1 through 3` and `No fourth review is owed` | contract text, feeds the digest (F4) |
| `deliver.md:41-42,1384-1389,1453-1458,1666` and `docs/gsd_multilevel_delivery_pipeline.md:650-656`, `capabilities/delivery-pipeline/capability.json:54` | operator-facing wording of the single exit and `rounds 1 and 2` | text [V12, V13] |

Readers of code-review state at the merge side:
- `gate-trailer.cjs:384` (`verify` CLI) calls `phase-code-review.cjs verifyCodeReview`; exit is `checked.ready && (!codeReview || codeReview.ok)` [R].
- `sentinel.cjs:69-70,1231-1234` and `state-sync.cjs:76-77` call `gate-trailer.cjs verifyCurrentReviews`, which reads **only the architecture verdict** (`gate-trailer.cjs:203-241`) [R]. A grep of `sentinel.cjs`, `state-sync.cjs`, `front.cjs` for `code.review|codeReview|verifyCodeReview` finds only `front.cjs:1297` (agent cardinality map) [V14].
- Code review is therefore enforced by: the arch-review builder (`deliver-dispatch.cjs:1210-1213` runs `evaluateGate`), the `gate` prelaunch command in `deliver.md:1464-1470`, and the orchestrator's textual readiness rule (`deliver.md:1666-1668`). The sentinel's merge block does not check it.
- **The `gate_status:` trailer carries no code-review field today.** It is `arch-review=…, drift-check=…, degenerate-green=…, checks=…[, base_tree=…]` (`gate-trailer.cjs:474-476`) [R]. The PROBLEM.md item "the gate trailer carries `round 4 of 3 …`" names a carrier that does not exist for code review (F8).

### F2. What would break if a fourth or fifth round existed (static reading; not executed)

1. `normalizeResult` (`code-review-core.cjs:196`) throws for `round` 4. The host passes the review round into it at launch and again on replay (`role-artifact.cjs:3046,3049`).
2. Seal-time validation (`role-artifact.cjs:3146`) throws for `review_round` 4.
3. `nextRound` returns `limit` at `used >= 3` regardless of any record.
4. The reviewer instructions say rounds are 1..3 and no fourth review is owed (`references/code-review.md:25,51`).
5. The replay-depth bound can make a round-4 chain unauthenticated (F3).
6. Wording that claims finality: `statusDescription` limit text, `refusal('limit', …)`, host messages, tests with `/three rounds/` (`phase-code-review.test.cjs:222`, `claude-role-host.test.cjs:2465`).
7. Not affected by a larger round number, as far as read: `countableVerdicts` (no cap), `coverageComplete` (recursive, no cap), `lineageComplete`, `repairAllowed` (returns false for any round other than 1 and 2, so a round-4 finding already maps to `repair: 'human'` at `phase-code-review.cjs:169`).

### F3. Replay-depth bound equals `ROUND_CAP` exactly

- `authenticatedCodeReviewRecord` (`role-artifact.cjs:3188-3199`) refuses when `lineage.active.size >= ROUND_CAP` **before** it consults the memo (`:3190` then `:3192`), adds the dispatch to `active`, replays, then removes it.
- Replay of a delta verdict calls `authenticateCarriedCodeReviewFindings` (`:2908-2945`), which calls `authenticatedCodeReviewRecord` for its predecessor (`:2938`) with the same state. The nesting depth is therefore the length of the lineage chain.
- A chain R4 → R3 → R2 → R1 needs the fourth nested call to see `active.size == 3` and fail. A chain of three needs size 2 at its deepest check and passes.
- Failure inside `replayCodeReviewRecord`'s `authenticateCodeReviewAnswer` is swallowed (`:3243-3248`) and becomes `answer_authenticated: false`, with `coverage_range: null` (`:3250`). `nextRound` then yields scope `full` (`code-review-core.cjs:341`) and `assertCodeReviewLineage` refuses to seal a `pass` without authenticated complete coverage (`role-artifact.cjs:3113-3126`).
- Whether the bound is actually reached depends on replay order and memoisation (a chronological catalogue could keep nested calls memo-hot). That dependence is the risk: **[A] a round-4 delta chain may seal only `needs-fix`, or may behave differently per catalogue order.** The existing test only runs three rounds (`role-artifact.test.cjs:1949`) [R]. Next check: spike S-1.

### F4. Contract-digest coupling: editing `references/code-review.md` silently re-owes every earlier verdict

- `currentCodeReviewContract()` hashes `references/code-review.md` (`role-artifact.cjs:2875-2878`).
- `replayCodeReviewRecord` returns `null` (skips the verdict) when `manifest.contract_digest !== currentCodeReviewContract()` (`:3215-3216`, annotated `@contract: a verdict of another contract … is skipped, so the review is owed`).
- `priorCodeReviewVerdicts` drops null records (`:3268`), so `countableVerdicts` sees fewer verdicts and `rounds_used` falls.
- Any extension design must change the reviewer text that currently says "1 through 3" and "No fourth review is owed" (`code-review.md:25,51`). Doing so changes the digest and makes every pre-upgrade verdict invisible, including those of a PR that already exhausted its cap. That is an accidental, unrecorded "extension" for those PRs, or a surprising `full` round 1.
- The same reference changed three times in six days (`27c122c4` 2026-10-31, `44fefbc4` 2026-10-30, `8e4cf110` 2026-10-29) [V15], so a PR sealed a few days earlier may already have been reset. Whether the incident PR was reset is unknown (U-03).

### F5. The count is "verdicts on the ancestry of the current head", not "rounds per PR"

- `countableVerdicts` keeps a verdict only if `verdict.head === head || isAncestor(verdict.head, head)` and it is complete and full (or a delta whose `prior_head` is already counted) (`code-review-core.cjs:299-310`).
- A test pins the consequence: `core.nextRound({priorVerdicts, head:'current', isAncestor:()=>false}).round` is `1` (`code-review-core.test.cjs:179`) [R]. The test passes [V17].
- So after a rebase or force-push of the epic branch the earlier verdicts are not ancestors, `rounds_used` becomes 0 and a fresh full round 1 is owed. **The cap is already resettable without any human record**, by a history rewrite. Whether rebasing the epic branch is a realistic operator or conveyor action is unknown (U-08).
- Consequence for any "ceiling per PR": a ceiling that is derived from `countableVerdicts` has the same reset; a ceiling stored per PR number does not, and then `limit = ROUND_CAP + Σ records` is no longer comparable with a `used` that was reset.

### F6. The limit arithmetic of the proposal has a consumed-versus-voided hole

PROBLEM.md item 1 sets the limit to `ROUND_CAP` plus the sum of permitted extensions; item 3 binds a record to head and base and says a moved head voids it.
- After round 4 is sealed at head H4 under record E1 (bound to H4), `used = 4`, limit `3 + 1 = 4` → `limit`.
- The operator fixes the next finding and pushes H5. E1 is bound to H4, so it is void at H5 and drops out of the sum: limit `3`. `used` is still `4` (H4 is an ancestor of H5, `countableVerdicts`).
- The operator writes E2 bound to H5. Limit `3 + 1 = 4`, `used = 4` → still `limit`. **E2 grants nothing.**
- Either void-by-head must not remove an already-consumed record from the sum (so consumption has to be recorded: a field in the sealed verdict, or a mutable flag in the store), or the formula must be `used < ROUND_CAP + (number of consumed) + (valid unconsumed)`. Both add state or a manifest field. This is the main hidden coupling between items 1 and 3. (Arithmetic from `core.nextRound` at `code-review-core.cjs:338-340`; the record side is a design hypothesis, not code.)

### F7. What distinguishes an operator action from a model action today

Command-backed or read facts:
1. **`planning-untrack.cjs --confirm` proves nothing about a human.** `CONFIRM_TOKEN = 'untrack-planning'` is a literal compared with a flag value (`planning-untrack.cjs:10,73`); any caller that can pass argv can pass it. The Makefile target `make untrack-planning CONFIRM=untrack-planning` (`Makefile:144-148`) is the same. There is no TTY, env or identity check in that script [R].
2. **The existing exit is also writable by the model.** `delivery_pipeline.code_review` is a key in `.planning/config.json`; `resolveCodeReviewMode` reads it (`phase-code-review.cjs:58-71`). In this worktree the file is tracked and mode `-rw-r--r--` owned by the user [V9]. There is no per-PR dimension: `mode.mode = loaded.config.code_review` for the whole project (`phase-code-review.cjs:69`), although every text says "for this PR" (`phase-code-review.cjs:88-89`, `deliver.md:41,1457`, `capability.json:54`) [R]. Baseline for any comparison: the current "human-only" exit is not enforced against a model with write access to the project root, and it lifts the hold for every phase PR in that project until someone reverts it.
3. **"Signed the way verdicts are" means HMAC-SHA256 with a symmetric key.** `crypto.createHmac('sha256', key)` with `crypto.timingSafeEqual` (`role-artifact.cjs:286-287,1033-1035,1165-1166`). Anyone who can verify can forge. The key is 32 random bytes in `hmac.key`, created with mode 0600 inside a 0700 per-user directory (`role-artifact.cjs:990-1007`, `:923-942`), one directory **per worktree** (`archiveAuthorityDirectory` = namespace + `digest(realpath(worktree))`, `:944-946`) [R]. Not observed on disk (denied, U-02).
4. **The orchestrating process reads the key by design.** `phase-code-review.cjs status` → `authority.priorCodeReviewVerdicts` (`phase-code-review.cjs:145`) → `authorityState` → `stableAuthorityFile(keyFile, 32)` (`role-artifact.cjs:3263,1015,1020`). `deliver.md:1431,1495-1504` tells the orchestrating session to run `createClaudeRoleHost(options).run(request)` and `codex-delivery-host.cjs --args-file …` through its shell, so verdict sealing also runs in the user's process tree [R]. Any `node -e` the orchestrating model runs in that shell has the same file access as the command that signs, unless the user's own session sandbox says otherwise.
5. **Shipyard confines the child role models, not the orchestrator.** Claude children get `sandbox.filesystem.denyRead/denyWrite: [archiveAuthority]` (`claude-runtime-host.cjs:756`) and for review roles `allowWrite: []` plus a write deny on the worktree (`claude-role-host.cjs:1283-1284`); Codex children get a deny rule on the same namespace (`codex-runtime-host.cjs:1079-1092,1109-1110,1170,1190`) [R]. This session's own sandbox configuration (given with the task) carries the same deny, which is consistent with a role child launched by that host [A: the launcher was not inspected]; it is not evidence about the orchestrating session. The protected path is **exactly** `~/.local/state/shipyard/role-artifact-authority`. The sibling `~/.local/state/shipyard/code-review-publications/` (`phase-code-review.cjs:311`) is not in that deny list, and a new `…/review-extensions/` store would not be either unless both hosts are changed.
6. **No TTY or interactivity gate exists in the delivery scripts.** `grep isTTY plugins/delivery-pipeline/scripts plugins/shipyard` finds only `repo-resolve.cjs:1736` (an interactive repo choice) [V16]. `ci-wait.cjs:144-145` sniffs `CODEX_SANDBOX*`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_ENTRYPOINT`, but the orchestrating Claude session also has `CLAUDE_PLUGIN_ROOT` (`deliver.md` uses `${CLAUDE_PLUGIN_ROOT}` in every command), and environment variables are caller-controlled [R]. A plain `node` in this tool shell reports `stdin.isTTY`/`stdout.isTTY` `undefined` [V6]; PTY allocation by `script -q /dev/null` is refused in this sandbox (`openpty: Operation not permitted`) [V6]. That is a property of this sandbox, **not** evidence about an unsandboxed same-user session (U-04).
7. **The existing operator-written precedent is unsigned.** `.planning/phases/<phase>/code-review-disagreements.json` with `recorded_by` (`code-review-core.cjs:488-489`; `docs/gsd_multilevel_delivery_pipeline.md:659-664`) is a project file with no signature and no proof of human authorship. Only its digest enters the sealed verdict (`dispositions_digest`).

### F8. Visibility carriers and their limits

- **Trailer / `merge-gate` status:** description is capped at 140 characters (`gate-trailer.cjs:166,193-194`). A realistic current description is 127 characters, leaving 13 [V11]; the proposed `round 4 of 3, extended by <operator> at <time>: <reason>` is already 64 characters with a 3-character reason and a placeholder operator [V11]. `parseGate` splits on `,` and `=` (`gate-trailer.cjs:91-102`), so a comma-bearing free-text value corrupts parsing. The writer's vocabulary is closed per key (`gate-trailer.cjs:279-292`), the status is written by the arch-review path only, and it carries no code-review data today.
- **`code-review` commit status:** fixed text and integer counts only (`statusDescription`, `phase-code-review.cjs:209-224`; docs `gsd_multilevel_delivery_pipeline.md:641-646`). An operator or reason string does not belong there.
- **`<!-- code-review -->` comment:** 60,000-character cap (`phase-code-review.cjs:293`), one marker-based comment edited in place. It passes `pr-hygiene.internalLeakViolations('comment', body)` when hygiene applies (`:449-455`); a violation sets `PR hygiene refused comment` and **leaves the verdict status without the comment** (`:452-455`). The hygiene rules reject internal path and identifier patterns (`pr-hygiene.cjs:224-232,250-258`). An operator-supplied `reason` placed in the comment is untrusted text in a public PR comment: it can trip hygiene (the extension note then disappears while the status stays) and it can carry markup or the `<!-- code-review -->` marker.
- **`publish` on `limit` skips the comment** (`phase-code-review.cjs:443-446`). A human who looks at the PR after a limit sees the old round-3 comment and a `pending` status whose text says `no further review will run for this head`.
- The identity written as `<operator>` would be asserted by the process that writes it (git config, `gh api user`, `$USER`); none of these is proof (F7).

### F9. Text sprawl of the exit and the cap

The "single exit / no waiver record / three rounds" wording is duplicated in at least these non-test places [V12, V13]: `phase-code-review.cjs:89,181`, `deliver-dispatch.cjs:1209`, `claude-role-host.cjs:613`, `codex-code-review-context.cjs:149`, `deliver.md:41-42,1453-1458,1666-1668`, `capability.json:54`, `docs/gsd_multilevel_delivery_pipeline.md:650-656`, `references/code-review.md:25,51`. Tests assert parts of it: `phase-code-review.test.cjs:222` (`/three rounds.*delivery_pipeline.code_review.*report/`), `claude-role-host.test.cjs:2465` (`/three rounds/`), `phase-code-review-publish.test.cjs:359` (`/round 3/`), `codex-code-review-context.test.cjs:252,1090-1091` (error code).

### F10. Delivery mechanics

- `plugins/shipyard/host/` is a **tracked generated copy** of `plugins/delivery-pipeline` (150 tracked files under it; not ignored; byte-identical to the source at this revision: `diff -rq` exit 0) [V4]. Generated by `make package-shipyard-codex` → `scripts/package-shipyard-codex.cjs` (`Makefile:5-7`). Every script or doc change must be mirrored, so every changed line appears twice in the diff and in review.
- `tests/unit/runtime-file-digests.json` currently pins **two** files, `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` [V10]. None of the code-review files is pinned, so `make refresh-runtime-digests` is needed only if a change touches those two.
- `tests/smoke/docs-smoke.sh` has no pin on `phase-code-review` or the exit wording (grep returned nothing for those terms) [V14b]; it checks Makefile/README structure (`docs-smoke.sh:69-104`).
- CI: `.github/workflows/test.yml` runs `./tests/unit/run.sh` as shards plus `make test-fast-rest` and a publish gate [R]. `make test-fast` = `test-unit` + `TEST_FAST_REST` (`Makefile:62-67`).
- ADR-032 is not in `.planning/architecture/` of this epic (`ls .planning/architecture | grep ADR-03` → only ADR-030) but is readable from history (`git cat-file -t 94d05497` → commit) [V3, V4b]. ADR-032 text: three-round cap and "a human switches the hold off for that PR through the mode setting" (line 30); "The hold has one defined exit … no waiver store is added" (line 37); "a waiver store" under Out of scope (line 61) [V3].

### F11. Tests that pin the cap today

`tests/unit/code-review-core.test.cjs:166-181` (limit at 3, non-ancestor → round 1, `repairAllowed` `[true,true,false]`; passes [V17]); `tests/unit/phase-code-review.test.cjs:189-222,418-419,449,465,718` (`limit`, `rounds_used === 3`, gate message); `tests/unit/role-artifact.test.cjs:1935-1955` (three sealed rounds, `next.state === 'limit'` at 3); `tests/unit/claude-role-host.test.cjs:2455-2467` (`CODE_REVIEW_ROUND_LIMIT` + `/three rounds/`); `tests/unit/codex-code-review-context.test.cjs:252,1090-1091`; `tests/unit/phase-code-review-publish.test.cjs:359` (`/round 3/`). No existing test seals or replays a fourth round.

---

## 4. Risk register (draft for `RISKS.md`)

Format as in the template: `## risk`, `severity`, `mitigation`. Every item also names its evidence and the next check. Mitigations are **candidates, not decisions**.

## R-01 — The model forges or reads the extension consent record
severity: high (the property the whole proposal rests on)
likelihood: unknown. Depends on whether the actor can read the key or write the store: yes for any same-user process outside the confined role children (F7.3-F7.5); no for role children while the OS sandbox holds.
evidence: HMAC is symmetric (`role-artifact.cjs:286-287`); the orchestrating shell runs the code that reads the key (F7.4); the child deny covers only `role-artifact-authority` (F7.5).
mitigation (candidates): keep consent state under the existing denied namespace; keep verification in a host process that an unsandboxed session cannot impersonate (none exists today); or accept same-user trust and state it plainly in the ADR (the property becomes "a model cannot do it by accident or through a role child", not "cannot at all").
next check: U-04, U-05; spike S-2.

## R-02 — The model gets a terminal and "types" the confirmation
severity: high
likelihood: unknown. A literal `--confirm` token is satisfied by any caller (F7.1). A TTY check is the usual upgrade; in this sandbox a PTY cannot be opened [V6], but an unsandboxed same-user session may create one with stock tools (`script`, a Python `pty`, an `expect`-style tool) [A].
mitigation (candidates): a challenge the model cannot read or answer from its shell (a prompt on `/dev/tty` with a random phrase shown only there, an out-of-band approval); each still depends on U-04.
next check: spike S-2 on an unsandboxed profile of each runtime.

## R-03 — The role-host refusal protects against the wrong actor
severity: high
likelihood: high that the gap exists (it follows from the architecture); impact unknown.
evidence: the actor that runs `phase-code-review.cjs` today is the orchestrating session (`deliver.md:1404-1405,1441-1442,1468`), which is not a role host; a role-host refusal can only stop a child model that already has no write path to `~/.local/state/shipyard` (F7.5). No env marker distinguishes the two (F7.6).
mitigation (candidates): scope the claim in the ADR to what is enforced; do not describe a refusal check as the authority mechanism.
next check: U-04.

## R-04 — The head moves after consent, so the record is void when it is needed
severity: high for usability, low for safety
likelihood: high in the main use case. After a round-3 `needs-fix` the human fixes the finding and pushes; the extra round must review that new head, but a record written "at the limit" is bound to the old head. Any later push (a bot suggestion, a base merge, a formatter) voids it again. The proposal does not say whether the operator writes the record before or after the fix push.
evidence: PROBLEM.md items 3 and 5; `countableVerdicts`/`nextRound` operate on the current head (`code-review-core.cjs:299-346`).
mitigation (candidates): record binds to the head to be reviewed and is written after the last push; or binds to the last counted verdict head and its descendants (changes the safety argument). Operator guidance must say which.
next check: U-06.

## R-05 — Two operators, two records, retries or concurrent writes
severity: medium
likelihood: unknown. A repeated command on a flaky terminal or two operators could grant two rounds for the same head. Whether each record is idempotent per (PR, head) is undefined.
evidence: none in code; there is no record store yet. `lock.cjs` provides `withLock`/`writeAtomic` and the publication store uses them (`phase-code-review.cjs:301,458`).
mitigation (candidates): at most one unconsumed record per (PR, head); use `withLock` as the publication store does; the ceiling counts records, not rounds.
next check: U-07.

## R-06 — Ceiling arithmetic: voided and consumed records
severity: high (silent grant failure, or silent bypass)
likelihood: certain if the formula is implemented as written; see F6.
evidence: F6; `nextRound` at `code-review-core.cjs:338-340`.
mitigation (candidates): define "consumed" explicitly; store it in the sealed verdict or in the record; make the ceiling count consumed plus outstanding grants per PR, not per head. Test: grant, run, push, grant again, run (expect round 5), grant a third time (expect refusal).
next check: decide in the design; spike S-1 can include the arithmetic.

## R-07 — An extension is consumed by an incomplete review
severity: medium
likelihood: unknown. Incomplete reviews do not count today (`countableVerdicts` requires `review_completeness === 'complete'`; `references/code-review.md:50-51` says "Incomplete reviews never consume a round"), and retry has no bound in the code read (`phase-code-review.cjs:176-183`). If the record is consumed at launch, an incomplete round burns human consent; if it is consumed only by a counted verdict, a stuck reviewer can retry without bound at the cost of tokens.
evidence: `code-review-core.cjs:299-310`; `phase-code-review.cjs:176-183`.
mitigation (candidates): consume on counted verdict (matches today's semantics for rounds 1 to 3) and keep retry unbounded as today, or add a retry bound (new state).
next check: U-09.

## R-08 — A round-4 finding has no automatic path
severity: medium (by design, but the operator experience matters)
likelihood: certain for `needs-fix` at round 4.
evidence: `repairAllowed(4)` is false (`code-review-core.cjs:347`), so status shows `repair: 'human'` (`phase-code-review.cjs:169`) and `fixTickets` prints the refusal (which currently says to switch to `report`) and returns `[]` (`:199-207`). After a round-4 `needs-fix`, the only exits are another extension or `report`. The `refusal()` text printed by `fixTickets` for `state: current` also names the `report` exit, because it is the same function.
mitigation (candidates): refusal text names both exits; the operator guide says what to do with a round-4 BLOCKER (manual fix + another record, record a disagreement, or `report`).
next check: none beyond wording; it is an acceptance item.

## R-09 — Rebase or force-push resets the count and strands records
severity: medium
likelihood: unknown (U-08)
evidence: F5. After a history rewrite, `rounds_used` is 0 with no human record (`code-review-core.test.cjs:179` passes [V17]); a record bound to the old head is void; a PR-level ceiling no longer matches `used`.
mitigation (candidates): count by PR identity rather than ancestry (a larger change with its own failure modes); or document that a rewritten history is a new lineage and cap the number of lineages; or leave as is and say so.
next check: U-08.

## R-10 — Reversing ADR-032's "no waiver store"
severity: medium (governance, not safety)
likelihood: certain if any extension record is adopted.
evidence: ADR-032 lines 30, 37, 61 [V3]; `DECISIONS.md` fixes that adoption means amending ADR-032. Operator-facing copies of the wording exist in eight files (F9); `deliver.md` states "no override flag or waiver record" twice (lines 42 and 1458) and "the single exit for this PR" once (line 1385).
mitigation (candidates): amendment text that names the exact carve-out (what a record is, what it is not), a grep-based test that no file still says "no waiver record" once the amendment is accepted.
next check: acceptance item (docs contract).

## R-11 — Conflict with the simplification direction
severity: medium
likelihood: high for option B as written.
evidence: PROBLEM.md item list adds a signed store, a command, a host refusal, a trailer field, a manifest field (F6), a reviewer-text change (F4), a replay-depth change (F3), a seal validator change, two hosts' message changes and eight files carrying operator-facing wording (F1, F9), each mirrored in the generated copy (F10). That is a net addition in a branch whose recent commits are net deletions (`git log` subjects such as `нетто −426 LOC`, `нетто −8150`) [V15]. `DECISIONS.md` states the direction as a constraint.
mitigation (candidates): measure the net line count of the smallest design before choosing; prefer designs that reuse the existing exit (`report`) or an existing authority.
next check: the alternatives line should price each option in lines; none has been priced here.

## R-12 — Replay-depth bound silently invalidates an extended chain
severity: high if it triggers (a round-4 `pass` could become unsealable)
likelihood: unknown (order-dependent), see F3.
evidence: `role-artifact.cjs:3190`, `:2938`, `:3243-3250`, `:3113-3126`.
mitigation (candidates): derive the bound from the effective limit rather than the constant; or replace it with a cycle check only. Either needs the same value at seal and replay time, so the extension data must be readable there (F6 coupling).
next check: spike S-1 (seal four sealed rounds, replay in both catalogue orders, then seal a `pass`).

## R-13 — Editing the reviewer contract resets in-flight PRs
severity: high for the first upgrade
likelihood: certain if `references/code-review.md` is edited (F4).
evidence: `role-artifact.cjs:2875-2878,3215-3216`; `code-review.md:25,51` [V15].
mitigation (candidates): keep round wording out of the hashed reference (pass the cap through `role_context`, which is not hashed by this function), or accept and announce the reset, or version the digest input so only substantive contract changes re-owe a review.
next check: U-10.

## R-14 — The trailer cannot carry the visibility line
severity: medium
likelihood: certain as written (F8).
evidence: 140-character cap, 13 characters headroom [V11], comma/`=` parsing, closed vocabulary, no code-review data in the trailer.
mitigation (candidates): carry the extension note in the `<!-- code-review -->` comment and in a short fixed-text status variant; do not put free text into the trailer.
next check: U-11.

## R-15 — Free-text `reason` and operator identity in a public comment
severity: medium
likelihood: unknown
evidence: F8. PR hygiene can refuse the comment (`phase-code-review.cjs:449-455`), leaving a status with no note; markup and marker injection are possible in a comment body; identity is asserted by the writing process.
mitigation (candidates): bound and sanitise the reason, render it inside a code span, strip the marker, store but do not publish it, publish only a fixed phrase plus identity-as-recorded-with-the-caveat.
next check: acceptance tests in section 6.

## R-16 — Store location and key scope do not line up
severity: medium
likelihood: certain that a decision is needed
evidence: verdict authority is per worktree (`role-artifact.cjs:944-946`) and `priorCodeReviewVerdicts` aggregates across registered phase worktrees (`:3255-3278`); the publication store is per repository+PR under `~/.local/state/shipyard/code-review-publications/` with no signature (`phase-code-review.cjs:306-336`). A PR-scoped consent record "signed the way verdicts are" must pick one worktree's key or add a new one; a new directory is outside the existing child deny (F7.5).
mitigation (candidates): place the record inside the per-worktree authority directory and add its catalogue entry; or add the new path to both hosts' deny lists.
next check: U-05.

## R-17 — The existing `report` exit is project-wide, not per PR
severity: medium (pre-existing; shapes option A)
likelihood: certain
evidence: F7.2. Any phase PR in the project is un-held while the key says `report`; the config file is tracked and user-writable [V9]; nothing records who set it or when.
mitigation (candidates): for the minimal-change option, make the refusal say that the switch is project-wide and must be reverted; log the mode in the verdict comment (`mode: report` is already printed in the status).
next check: none.

## R-18 — Cost of rounds 4 and 5
severity: medium
likelihood: unknown
evidence: ADR-032 sets the structural cost bound "no more than one `arch-review` per phase" (ADR text, Decision, read in [V3]) and the cap is what bounds it; the per-launch figures (Claude median 303,730.5; Codex median 2,580,329 processed tokens) are taken from the index in `docs/audits/phase52/README.md` that summarises `arch-review-cost.md` (that file itself was not opened), and that index says the Claude data is the old Opus grid. A fourth round on a head whose merge-base or coverage chain broke is `full`, not `delta` (`nextRound`, `code-review-core.cjs:341-345`). **[A, inference from reading]** the proposal's "always a delta" cannot be forced without also refusing the `pass` that needs authenticated coverage (`role-artifact.cjs:3113-3126`).
mitigation (candidates): state the cost ceiling per extended round; refuse an extension that would be `full`, or accept and warn.
next check: U-13.

## R-19 — Release target and base branch
severity: medium
likelihood: certain that the question exists
evidence: [V5, V18]. The base is 46 commits ahead of `main`; `v1.0.0-rc.2` is tagged locally at the base (remote not verified [V19]); `phase-code-review.cjs` is unchanged since #526 on both lines, but `code-review-core.cjs`, `role-artifact.cjs` and the hosts have diverged (`main` still carries the older replay code that the epic deleted, per `DECISIONS.md`).
mitigation (candidates): decide the carrier release (rc.3 or later) and whether the design must also land on `main`.
next check: U-12.

## R-20 — Runtime parity (Claude and Codex)
severity: medium
likelihood: unknown
evidence: admission is implemented twice (`claude-role-host.cjs:611-613`, `codex-code-review-context.cjs:148-149`); the sandbox deny is implemented twice (`claude-runtime-host.cjs:756`, `codex-runtime-host.cjs:1079-1092`); messages and tests are duplicated (F9, F11). The definition of done requires both runtimes.
mitigation (candidates): put the effective-limit computation in `code-review-core.cjs` (both hosts already call `nextRound`) and keep the hosts free of cap logic.
next check: acceptance tests per runtime (section 6).

## R-21 — Out-of-band human authority may not exist in single-operator repositories
severity: medium for any option that relies on a GitHub-side human action
likelihood: unknown
evidence: none in the repository. GitHub does not let the PR author approve their own PR; the model's `gh` uses the same user's token as the operator [A]. Whether the target repositories have a second human account is unknown.
mitigation (candidates): decide per repository, or do not rely on a second account.
next check: U-14.

## R-22 — Crash consistency between seal, consume and publish
severity: low to medium
likelihood: unknown
evidence: sealing and catalogue writes are separate steps from record consumption if consumption is stored; `publish` is a separate command after the launch (`deliver.md:1441-1442`). A crash between them leaves a sealed round-4 verdict with an unconsumed record, or the reverse.
mitigation (candidates): derive consumption from the sealed verdict rather than a flag (single source of truth).
next check: part of F6 design.

---

## 5. Open questions (draft for `OPEN-QUESTIONS.md`)

- [ ] U-01 Can the incident evidence in `pdffiller-mcp` (branch `research/mcp-tools-ai-pdf-12908`, `.planning/graph/`, `.shipyard-code-review-evidence.md`, local verdict records) be made readable to a research session, or can the operator paste the three verdict summaries and the Shipyard version it ran? — owner: operator
- [ ] U-02 What are the owner, mode and contents (names only) of `~/.local/state/shipyard/role-artifact-authority/*` and `~/.local/state/shipyard/code-review-publications/*` on the operator's machine, and is the key readable by processes other than the host? (Denied to this session [V8].) — owner: operator
- [ ] U-03 Which Shipyard build did the incident session run, and had `references/code-review.md` changed since its three verdicts were sealed (F4)? Did its status show `limit` or `owed` round 1? — owner: operator
- [ ] U-04 What confines the orchestrating Claude Code and Codex sessions on the operator's machine (OS sandbox profile, `denyRead`/`denyWrite` on `~/.local/state/shipyard`, permission mode), and is that confinement something Shipyard may rely on, document or enforce? — owner: operator and maintainer
- [ ] U-05 Where should an extension record live relative to the per-worktree authority directory and the child deny list (R-16), and which key, if any, signs it? — owner: maintainer (design decision)
- [ ] U-06 Is the record written before or after the fix push, and does it bind to the head to be reviewed or to the last counted verdict's lineage (R-04)? — owner: operator
- [ ] U-07 May there be more than one unconsumed record per (PR, head), and what makes the command idempotent (R-05)? — owner: maintainer
- [ ] U-08 Is rebasing or force-pushing the epic branch a normal operator or conveyor action in practice (F5, R-09), and is "rebase resets the cap" acceptable, to be closed, or to be left alone? — owner: operator
- [ ] U-09 Is an extension consumed by a launch or by a counted (complete) verdict, and is retry of an incomplete extended round bounded (R-07)? — owner: maintainer (design decision)
- [ ] U-10 May the round wording leave the hashed `references/code-review.md`, and is a one-time reset of in-flight verdicts on upgrade acceptable (R-13)? — owner: maintainer
- [ ] U-11 Where must the extension be visible to the merging human: comment, `code-review` status text, or both; and is "trailer" meant as the `merge-gate` status (cannot fit, R-14) or something else? — owner: operator
- [ ] U-12 Which release carries this (the tag `v1.0.0-rc.2` already exists locally at the base, [V18]); must the design also land on `main` (R-19)? — owner: operator
- [ ] U-13 What cost ceiling per extended round is acceptable, and is a `full` extended round (broken coverage chain) allowed (R-18)? — owner: operator
- [ ] U-14 Do the target repositories have a second human account able to act on GitHub, so that a GitHub-side approval is possible (R-21)? — owner: operator
- [ ] U-15 Is a model-writable `.planning/config.json` exit (F7.2) an accepted baseline, i.e. is "only a human" required to be **stronger** than the current `report` exit, or only no weaker? — owner: operator
- [ ] U-16 Does the operator accept a scoped claim ("a role-host child cannot grant itself an extension; the same-user orchestrating session is trusted") instead of "only a human" in the ADR text? — owner: operator

## 6. Native acceptance needs (for whichever design is chosen)

Commands that exist today and would be the native gates (all verified to exist in section 9 or by file listing):
- Unit: `./tests/unit/run.sh` (`make test-unit`); the six files in F11 must change in the same ticket as the code they pin. A single file can be run as `node --test tests/unit/code-review-core.test.cjs` [V17].
- Whole fast gate: `make test-fast` (= `test-unit` + `test-graph test-worktree test-worktree-gates test-sentinel test-docs test-hooks test-comment-policy test-model-ladder-runtime test-statusline test-installed-launch`) and CI `.github/workflows/test.yml`.
- Generated copy: after any script or doc change run `make package-shipyard-codex` and confirm `diff -rq plugins/delivery-pipeline plugins/shipyard/host/plugins/delivery-pipeline` exits 0 (it does at this revision [V4]).
- Digest pin: `node scripts/refresh-runtime-digests.cjs --check` exits non-zero only if a pinned file changed; today the pinned files are the two in [V10].
- Docs: `./tests/smoke/docs-smoke.sh` (`make test-docs`).
- Comment policy: `make test-comment-policy` (`publish-gate.cjs`), relevant to any new comment text.

Behaviours an acceptance suite would need to pin (derived from PROBLEM.md item 5 and this register; none exists today):
1. No record: `nextRound` still returns `limit` at 3 and every host message and status is unchanged except for the named extend instruction. (Existing tests F11 keep passing.)
2. A record for another head, base, PR, repository or phase does not apply. (R-04, R-16)
3. A record whose signature or path does not verify, or that is written by a role-child profile, is ignored/refused on **both** runtimes. (R-01, R-03, R-20)
4. The ceiling holds across grant → run → push → grant → run → grant (F6, R-06) and across concurrent grants (R-05).
5. Round 4 seals a `needs-fix` **and** a `pass` and replays from a cold catalogue and a warm one (F3, R-12).
6. After a round-4 `needs-fix`: `repair` is `human`, `fixTickets` returns `[]`, and the printed text names the available exits (R-08).
7. An incomplete extended review does not consume the record (or does, per U-09) and does not count (R-07).
8. Rebase/force-push: behaviour stated and pinned either way (R-09).
9. Contract digest: an upgrade that adds extension support does not change `currentCodeReviewContract()` unless the reset is intended (R-13).
10. Comment: header carries the extension note; hygiene refusal does not drop the status; a hostile `reason` cannot inject the marker or markup (R-15). Trailer unchanged (R-14).
11. Both runtimes: Claude (`claude-role-host.test.cjs`) and Codex (`codex-code-review-context.test.cjs`) admit round 4 only with a valid record and refuse otherwise.
12. Text: no remaining "no waiver record" claim in the operator-facing files in F9 if the amendment is accepted (R-10).

Not testable by command, so an assumption to be settled by the operator (U-04, U-16): that the orchestrating session cannot run the extend command or read the key.

## 7. Spikes recommended (not run; the contract forbids throwaway validation here)

- **S-1** `/gsd-spike "seal and replay a four-round code-review chain with ROUND_CAP raised in a scratch worktree: does role-artifact.cjs:3190 reject the fourth nested replay, in chronological and shuffled catalogue order, and can a round-4 pass seal?"` — settles F3/R-12, and exercises the F6 arithmetic.
- **S-2** `/gsd-spike "from an unsandboxed same-user shell on each runtime, can a model-run command open a PTY or /dev/tty, read ~/.local/state/shipyard/role-artifact-authority/*/hmac.key, and write a new ~/.local/state/shipyard/<store>/ file; and does the same command fail inside a Shipyard role child?"` — settles R-01 to R-03, U-04.
- **S-3** `/gsd-spike "edit one word of references/code-review.md in a scratch copy and run phase-code-review.cjs status on a PR with three sealed verdicts"` — settles F4/R-13 (expected: `rounds_used` 0).
- **S-4** `/gsd-spike "rebase an epic branch that has three sealed verdicts and run phase-code-review.cjs status"` — settles F5/R-09 (expected: `owed`, round 1, `full`).

## 8. Things that look like risks but are not (checked)

- `repairAllowed` already returns false for round 4 and above (`code-review-core.cjs:347`), so "auto-repair stays for rounds 1-2 only" needs no new code, only a test.
- `countableVerdicts` and `coverageComplete` contain no cap, so a larger count does not change their logic (F2 item 7).
- `runtime-file-digests.json` pins only two unrelated files; the "runtime-file digest pin" is not a likely blocker for this change [V10].
- The sentinel merge block does not read code-review state, so no sentinel change is forced by a round-4 verdict (F1). The visible consequence is in `deliver.md` guidance and the arch-review builder gate.

## 9. Command log

IDs are referenced above. "Tool" is Bash unless marked Grep/Read. Working directory is `/Volumes/KINGSTON/.wt-claude-shipyard/harness-simplification` unless stated.

- **V1** `git rev-parse HEAD && git status --short | head && ls .planning/investigations/INV-021-human-review-round-extension/ && ls …/research 2>/dev/null` → `749604b9307ce21d7790f0a5b8f97920dca9aa7f`; status `?? .planning/investigations/INV-021-human-review-round-extension/`; listing showed `DECISIONS.md OPEN-QUESTIONS.md OPTIONS.md PROBLEM.md RESEARCH-CONTRACT.md RESEARCH.md RISKS.md`; the final `ls` exited 1 (no `research/` yet; created later with `mkdir -p`).
- **V2** Grep `ROUND_CAP|CODE_REVIEW_ROUND_LIMIT` (tool) over the repository, excluding `.planning/graph` and `docs/audits` → source hits at `code-review-core.cjs:6,196,340,530`, `role-artifact.cjs:3146,3190`, `phase-code-review.cjs:132`, `codex-code-review-context.cjs:149`, `claude-role-host.cjs:613`, tests at `codex-code-review-context.test.cjs:252,1090,1091`, `claude-role-host.test.cjs:2465`, plus the same lines under `plugins/shipyard/host/...`.
  - **V2b** `grep -rn "round_cap|rounds_used" plugins/delivery-pipeline` was attempted with a shell glob that failed (`no matches found: --include=*.cjs`); the same conclusion rests on V2 (only `phase-code-review.cjs:132` names `round_cap`) and on the earlier Read of `phase-code-review.cjs`.
- **V3** `git show 94d05497:.planning/architecture/ADR-032-code-review-fallback.md` (read in full) and `… | grep -n "At most 3 rounds|one defined exit|waiver store|visible, not enforced|ships first report-only"` → lines 30, 35, 37, 61 as quoted in F10.
- **V4** `git ls-files | grep -c '^plugins/shipyard/host/'` → `150`; `git check-ignore -v plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs` → exit 1 (not ignored); `diff -rq plugins/delivery-pipeline plugins/shipyard/host/plugins/delivery-pipeline` → no output, exit 0.
  - **V4b** `ls .planning/architecture | grep -i "ADR-03"` → `ADR-030-launch-and-upgrade-reliability.md` only; `git cat-file -t 94d05497` → `commit`.
- **V5** `git merge-base --is-ancestor 749604b9 main` → exit 1; `git rev-list --count main..749604b9` → `46`; `git branch --contains 749604b9 --list 'epic/*' 'main'` → `* epic/harness-simplification`; `git log --oneline -8 -- plugins/delivery-pipeline/scripts/phase-code-review.cjs` → `0878fb86 Phase 52: native fallback code review and bounded integration (#526)`.
- **V6** `which script; node -v; script -q /dev/null node -e '…isTTY…' < /dev/null` → `/usr/bin/script`, `v24.21.0`, `script: openpty: Operation not permitted` (exit 1); `node -e '…isTTY…' < /dev/null | cat` → `plain stdin.isTTY=undefined stdout.isTTY=undefined`. A sandbox property; no claim about other sessions.
- **V7** `ls /Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp/.planning | head -5` → `ls: …/.planning: Operation not permitted`, exit 1. Not retried; no other tool was used to reach that path.
- **V8** One compound command (`ls -la /Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp | head -5; … ls -la /Users/serhii/.local/state/shipyard | head -5; … ls -ld …/role-artifact-authority; ls …/code-review-publications`) → `Permission to use Bash with command … has been denied.` Not retried verbatim; nothing under `~/.local/state/shipyard/` was read. Context: this session's own sandbox configuration (given with the task) lists `~/.local/state/shipyard/role-artifact-authority` under `denyOnly` read, which matches `claude-runtime-host.cjs:756`.
- **V9** `ls -l .planning/config.json; git ls-files .planning/config.json` → `-rw-r--r--@ 1 serhii staff 26747 Nov 1 15:51 .planning/config.json`; `.planning/config.json` (tracked).
- **V10** `python3 -c "…json.load(open('tests/unit/runtime-file-digests.json'))…"` → files: `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs`, `plugins/delivery-pipeline/scripts/runtime-adapters.cjs`; count 2.
- **V11** `node -e` string-length calculation: sample description `arch-review=conform, drift-check=skipped, degenerate-green=no, checks=green, base_tree=<40 chars>` → `127`, limit 140, headroom 13; minimal proposed field `round 4 of 3, extended by serhii at 2026-11-02T10:00:00Z: reason` → `64`. (Calculation only; the sample description is built from the vocabulary in `gate-trailer.cjs:279-292`.)
- **V12** `grep -rIn "no override flag|waiver record|waiver" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.planning .` (excluding the generated host copy) → `capability.json:54`, `phase-code-review.cjs:89`, `deliver-dispatch.cjs:1209`, `deliver.md:42,1458`, `docs/gsd_multilevel_delivery_pipeline.md:654`, plus two unrelated test titles (`state-sync-listing.test.cjs:382`, `reviewers.test.cjs:279`).
- **V13** `grep -rIn "three rounds|three countable|at most 3 rounds|rounds 1 and 2|round 3|No fourth|1 through 3" … plugins tests docs README.md` (excluding the generated copy) → `code-review.md:25,51`, `codex-code-review-context.cjs:149`, `claude-role-host.cjs:613`, `phase-code-review.cjs:181`, `deliver.md:1453,1455`, `gsd_multilevel_delivery_pipeline.md:650`, tests as in F9.
- **V14** `grep -n -i "phase-code-review|verifyCodeReview|code_review|code-review|three rounds|ROUND_CAP" plugins/delivery-pipeline/scripts/{sentinel,front,deliver-dispatch,pipeline-config,comment-policy,state-sync,refusal-hints,doctor}.cjs plugins/delivery-pipeline/commands/deliver.md` → `front.cjs:1297`; `deliver-dispatch.cjs:554-616,1205-1209,1247`; `pipeline-config.cjs:536,626,633,1100-1102,1317`; `deliver.md` lines listed in F1. No hit in `sentinel.cjs`, `state-sync.cjs`, `comment-policy.cjs`, `refusal-hints.cjs`. A narrower `grep -n "code.review|codeReview" sentinel.cjs state-sync.cjs front.cjs` → only `front.cjs:1297`.
  - **V14b** `grep -n "code-review|phase-code-review|ROUND|three|waiver" tests/smoke/docs-smoke.sh` → no output.
- **V15** `git log --format='%h %ad %s' --date=short -3 -- plugins/delivery-pipeline/references/code-review.md` → `27c122c4 2026-10-31 HS-22 …`, `44fefbc4 2026-10-30 HS-17b … (нетто −426 LOC)`, `8e4cf110 2026-10-29 HS-17 …`; `git log --format=… -3 -- code-review-core.cjs` → `63556866 2026-11-01 HS-39`, `44fefbc4`, `b61d2bb3 2026-10-29 HS-18 … нетто −1042`; `git log … -- .planning/config.json` shows HS-43 (2026-11-01) and earlier.
- **V16** `grep -rn "isTTY" plugins/delivery-pipeline/scripts plugins/shipyard` → `repo-resolve.cjs:1736` (and its generated copy). Environment sniffing: `grep -rn "SHIPYARD_.*HOST|CLAUDECODE|CLAUDE_CODE|CODEX_" plugins/delivery-pipeline/scripts/*.cjs` → `ci-wait.cjs:144-145` and the host environment scrub lists (`claude-runtime-host.cjs:37-85`, `codex-runtime-host.cjs:1173-1181`).
- **V17** `node --test --test-name-pattern='rounds count only complete' tests/unit/code-review-core.test.cjs` → `✔ rounds count only complete full-scope lineage, independently of ticket set and contract`; `pass 1 fail 0`; exit 0.
- **V18** `git tag --points-at 749604b9` → `v1.0.0-rc.2`; `git rev-parse 'v1.0.0-rc.2^{commit}'` → `749604b9307ce21d7790f0a5b8f97920dca9aa7f`; `git for-each-ref … refs/tags/v1.0.0-rc.1 refs/tags/v1.0.0-rc.2` → both `2026-11-01`; `git describe --tags --always 749604b9` → `v1.0.0-rc.2`.
- **V19** `git ls-remote --tags origin 'v1.0.0-rc.2'` → `sandbox proxy: github.com:22: 403 user denied`. Remote state unverified.
- Read tool (no command): `code-review-core.cjs:170-346`, `phase-code-review.cjs:1-541`, `role-artifact.cjs:2820-3350 and 915-1040`, `planning-untrack.cjs:1-154`, `claude-role-host.cjs:595-630,1262-1300`, `codex-code-review-context.cjs:130-165`, `claude-runtime-host.cjs:70-110,725-790`, `codex-runtime-host.cjs:1066-1110,1166-1192`, `gate-trailer.cjs:84-135,165-246,262-300,330-500`, `deliver.md:30-50,1380-1475,1655-1672`, `references/code-review.md:1-60`, `pr-hygiene.cjs:18-40,224-262`, `Makefile:1-150`, `scripts/package-shipyard-codex.cjs:1-40`, `scripts/refresh-runtime-digests.cjs:1-60`, `docs/gsd_multilevel_delivery_pipeline.md:636-690`, `docs/audits/phase52/README.md`.

## 10. Sources

Repository (revision `749604b9`): the files named in section 9. Planning: `PROBLEM.md`, `RESEARCH-CONTRACT.md`, `DECISIONS.md`. History: ADR-032 at `94d05497`. Precedent for the format of this register: `.planning/investigations/INV-017-launch-and-upgrade-reliability/research/risks.md`. No external web sources were used.
