# INV-021 — line `system-state`: how the phase code-review round limit works today

- Investigation: `INV-021-human-review-round-extension`
- Line: `system-state` (feeds RESEARCH.md "Current system state")
- Source revision: `749604b9307ce21d7790f0a5b8f97920dca9aa7f` (branch `epic/harness-simplification`, tag `v1.0.0-rc.2`)
- Policy hash: `fc1706bc9272bd0f539fbd71fa966b736df15c2cadfc2a76a8b84924b33584b8` (ADR-014 `adr-014.v8`)
- Runtime selection preserved from the caller: `claude-sonnet-5-5` / `xhigh`; exact policy signals: `{}`
- Required references verified against the packet with `shasum -a 256` and `wc -c` [C19]: `PROBLEM.md` `3fbf5bf6efc6c068cae817e15d865cef6951a280e066b8596259d88248f4fa19` (4939 bytes), `RESEARCH-CONTRACT.md` `756e3255294acebc9319da7ebbb239ca7e5ae7b7e629b0faa239ccda4ca38ab3` (5023 bytes), `DECISIONS.md` `0063e072389a81ee943b5a2cac77e281a62cab2c07f234b4e0f58e7f8bd65e26` (1741 bytes) — all match. `OPEN-QUESTIONS.md`, `OPTIONS.md`, `RESEARCH.md`, `RISKS.md` are still the empty templates (read, no content).
- Worker: read-only; the only file written is this artifact (plus the empty `research/` directory that holds it)
- Evidence notation: `[C<n>]` points to the command log in section 14. `Grep`/`Read` are the ripgrep and file-read tools of this worker; every `path:line` was read in this worktree at the revision above. Claims that no command could check are labelled **ASSUMPTION** or **UNKNOWN** and carry the next check.

---

## 0. Summary (the ten facts that matter for the decision)

1. **The cap is not a counter, it is a derived number.** `rounds_used` = number of *countable* sealed verdicts (complete, ancestors of the current head, full-or-chained-delta) that survive replay under the *running* plugin's contract digest. `limit` is returned the moment that number reaches `ROUND_CAP = 3` (`code-review-core.cjs:6,299-310,338-346`). Nothing stores "this PR used 3".
2. **There are four independent code enforcers of 3, not one**: `nextRound` (admission, `code-review-core.cjs:340`), `normalizeResult` (host normalization **and** replay, `code-review-core.cjs:196`, `role-artifact.cjs:3046-3049`), `codeReviewResultData` (seal **and** replay, `role-artifact.cjs:3146`), and the replay recursion bound `lineage.active.size >= ROUND_CAP` (`role-artifact.cjs:3190`). Raising only `nextRound` yields a launch that cannot be sealed.
3. **Replay-depth bound (derived, not executed):** a cold replay chain for round N enters predecessors with `active.size` 0..N-2; the bound `>= 3` therefore admits round 4 and fails round 5. Failure inside a status replay is swallowed into `answer_authenticated: false` (`role-artifact.cjs:3244-3248`), which makes the verdict never "current" (`role-artifact.cjs:3398`); at seal time it is a hard refusal. Needs a spike to confirm (section 13).
4. **The reviewer reference doc is part of the round counter.** `contract_digest = sha256(CONTRACT_ID + "\n" + sha256(references/code-review.md))`; a sealed verdict whose digest differs from the running plugin's is *skipped* (`role-artifact.cjs:3216`; proven by `tests/unit/code-review-foreign-contract.test.cjs`, 6/6 pass [C12]). The doc says "Integer 1 through 3" (line 25) and "No fourth review is owed" (lines 50-52). **Any edit to that file in a release resets every in-flight PR's counter to 0 and re-owes every current verdict.** The epic already changed it relative to `main` (sha256 `0c96442c…` vs `5d121a46…`, [C10]), so installing the epic build should already make verdicts sealed under `main`'s reference non-countable (derived from the digest difference and the foreign-contract test, which uses a different reference file; not run against a real pre-epic verdict — see U1/spike S3).
5. **At the merge gate only two programmatic readers consume the code-review hold, besides the `phase-code-review.cjs` verbs themselves.** `sentinel.cjs`, `state-sync.cjs`, `front.cjs` read only the architecture verdict (`gate-trailer.cjs:203-241`). The code-review gate is read by `deliver-dispatch.cjs build arch-review --phase` (`:1210-1214`) and `gate-trailer.cjs verify` (`:384-386`). The phase PR into the integration branch is merged by a human and the code-review status is non-required (`deliver.md:1667-1668`).
6. **The gate trailer carries no code-review field.** The `merge-gate` status description is `arch-review=…, drift-check=…, degenerate-green=…, checks=green[, base_tree=<40 hex>]`, capped at 140 characters (`gate-trailer.cjs:166,192-201,474-476`); the longest ordinary value is 128-132 characters, leaving 8-12. A `round 4 of 3, extended by …: <reason>` string (78 characters before the reason) cannot fit [C11]. The visible surfaces that exist are the `code-review` commit status (fixed text and integer counts only, `docs/gsd_multilevel_delivery_pipeline.md:641`) and the `<!-- code-review -->` PR comment.
7. **"Human-only" has no existing mechanism.** `planning-untrack.cjs --confirm` compares an argv token to a constant (`:10,73`); no TTY, uid, secret or environment test exists anywhere in the plugin except an unrelated repo-picker (`repo-resolve.cjs:1736`) and a runtime sniff for wait windows (`ci-wait.cjs:144-145`) [C2b]. The existing exit (`delivery_pipeline.code_review: report`) is an unsigned JSON key in `.planning/config.json`, **project-wide, not per-PR** (`pipeline-config.cjs:536,1100`), writable by anything that can write the file.
8. **Key custody is "same-user file + sandboxed children", not uid separation.** Four HMAC facilities use 32-random-byte `hmac.key` files, mode 0600, with no owner check (`role-artifact.cjs:921-1042`, `host-verification.cjs:233-244`, `dispatch-boundary.cjs:211-231`, `codex-delivery-host.cjs:339`). Isolation is applied to **spawned role children only**: Claude child gets an OS sandbox with `denyRead`/`denyWrite` on the authority namespace and `allowWrite` limited to its worktree (`claude-runtime-host.cjs:750-792`); Codex child gets a permission profile with the same path set to `deny` (`codex-runtime-host.cjs:1079-1110,1170`). The **orchestrating session** that runs every `phase-code-review.cjs` verb (`deliver.md:1404-1468`) is a model running as the same user and is not isolated by Shipyard code.
9. **Nothing the repository ships stops a same-user model orchestrator from doing what the proposal wants to forbid** (write the config exit, call any new verb, read the key). A role-host refusal protects only the spawned reviewer, which already cannot write the state directory. Whether the orchestrator is denied the authority directory or the config file is **UNKNOWN** (user-specific Claude Code/Codex configuration, not shipped by this repo; `scripts/install-shipyard-claude-hook.sh` adds none, [C18]).
10. **The incident repository and `~/.local/state/shipyard/` were not reachable from this worker's sandbox** ([C13], [C14]); no incident evidence was examined. Which Shipyard build sealed the `pdffiller-mcp` verdicts is unknown, and per fact 4 that decides whether the PR is still exhausted after an upgrade.

---

## 1. Deployment and presence state (checked first, per the line brief)

The brief's "X does not happen in env" rule does not literally apply (this is a design question, not a defect report), but the cap and its single exit must be proven to exist where the operator says they do.

| Claim | Command | Result |
|---|---|---|
| The cap was introduced by the phase-code-review work | `git log --oneline -S"const ROUND_CAP = 3" -- plugins/delivery-pipeline/scripts/code-review-core.cjs` [C5] | `0878fb86 Phase 52: native fallback code review and bounded integration (#526)` |
| The cap exists on `main` | `git show main:plugins/delivery-pipeline/scripts/code-review-core.cjs \| grep -n ROUND_CAP` and same for `role-artifact.cjs` [C9] | `code-review-core.cjs:6,92,237`; `role-artifact.cjs:7233,7277` — same logic, older line numbers |
| Epic tip is not on `main` | `git rev-list --left-right --count main...HEAD` [C6] | `0 46` (epic 46 commits ahead, 0 behind); merge-base is `0878fb861039f828c4565b87f7cb2cd713dbb63d` = `main` |
| Epic tip is released as rc.2 locally | `git tag --contains HEAD` [C6] | `v1.0.0-rc.2` (annotated, signed; tagger Nochevnyi Serhii) |
| Epic tip is on the remote | `git branch -a --contains 749604b9` [C6] | `epic/harness-simplification`, `remotes/origin/epic/harness-simplification` |
| Remote tag / deployed build | `git ls-remote --tags origin 'v1.0.0*'` [C16] | **denied by sandbox proxy** (`github.com:22`); remote state **UNKNOWN** |
| Which build the incident session ran | none reachable | **UNKNOWN** (next check: `~/.claude/plugins` cache version and the `contract_digest` in the pdffiller verdict manifests, by the operator) |
| `phase-code-review.cjs` differs between `main` and epic | `git diff --stat main HEAD -- <9 cap-related files>` [C9] | file **absent** from the stat: identical; line refs `:87-90` in PROBLEM.md hold on both |
| Files that did change | same | changed lines (insertions + deletions, from `--stat`): `role-artifact.cjs` 4551, `deliver.md` 3446, `claude-role-host.cjs` 1341, `codex-code-review-context.cjs` 239, `code-review-core.cjs` 141, `deliver-dispatch.cjs` 125, `references/code-review.md` 28, `gate-trailer.cjs` 11; totals 1801 insertions, 8081 deletions |
| Codex mirror matches source | `diff -rq plugins/delivery-pipeline plugins/shipyard/host/plugins/delivery-pipeline` [C3] | exit 0, no output: identical |
| Working tree | `git status --short` [C1] | only `?? .planning/investigations/INV-021-human-review-round-extension/` |

Conclusion: the limit and the single `report` exit are present and identical in source on the epic tip, on `main`, and in the committed Codex mirror. There is no "absent code" explanation for the operator's observation. What cannot be established here is the *installed* build in the incident project.

---

## 2. How the review round works today (entry points and data flow)

```
operator / orchestrator model (Bash)                     role children (sandboxed)
   │                                                        ▲
   ├─ phase-code-review.cjs status|gate|fix-tickets|publish │
   │     └─ status(): priorCodeReviewVerdicts ─┐            │
   ├─ deliver-dispatch.cjs build code-review ──┼─ request ──┤  claude-role-host.cjs  prepareCodeReview (:574)
   │                                           │            │  codex-delivery-host → codex-code-review-context.cjs (:100-207)
   │                                           ▼            │      core.countableVerdicts / core.nextRound  (limit → CODE_REVIEW_ROUND_LIMIT)
   │                                  role-artifact.cjs     │      core.normalizeFinal(round) → role-artifact.sealJudgment
   │                                  authority namespace   │
   │                                  ~/.local/state/shipyard/role-artifact-authority/<sha256(worktree)>/{hmac.key,catalogue.json,…}
   └─ gate-trailer.cjs verify <pr>  ── verifyCodeReview ──► phase-code-review.cjs status/evaluateGate
```

Stages, with the code that owns each:

1. **History read** — `role-artifact.cjs:3255-3278 priorCodeReviewVerdicts`: enumerates `root` + every `git worktree list` entry + the graph's project root (`:3257-3258`, `registeredPhaseWorktrees` `:1377-1380`), reads each worktree's HMAC-authenticated `catalogue.json`, replays every `code-review` record whose phase and repository match (`:3261-3272`), and sorts by `sealed_at`. A record sealed under another contract digest returns `null` and is dropped (`:3216`, comment on `:3215`: "so the review is owed").
2. **Counting** — `code-review-core.cjs:299-310 countableVerdicts`: a verdict counts iff `(verdict.head === head || isAncestor(verdict.head, head))` and `review_completeness === 'complete'` and (`review_scope === 'full'` or (`delta` and its `prior_head` is already a counted head)). Incomplete reviews never consume a round (`references/code-review.md:50-51`).
3. **Admission** — `code-review-core.cjs:338-346 nextRound`: `used >= ROUND_CAP → { round: null, state: 'limit', rounds_used }`; otherwise `round = used + 1`, scope `delta` when `coverageComplete` proves the chain (`:319-337`), else `full`. Called with an identically shaped `history` object by three callers: `phase-code-review.cjs:147-154`, `claude-role-host.cjs:596-613`, `codex-code-review-context.cjs:141-149`.
4. **Launch** — the hosts refuse with `CODE_REVIEW_ROUND_LIMIT` (`claude-role-host.cjs:613`, `codex-code-review-context.cjs:149`); otherwise they assemble the packet with `review_round = round.round` (`code-review-core.cjs:521-527`).
5. **Normalization and seal** — `core.normalizeFinal(... { round })` → `normalizeResult` rejects `round > ROUND_CAP` (`code-review-core.cjs:196`); the host passes `prepared.round.round` (`claude-role-host.cjs:1202`, `codex-code-review-context.cjs:427`). `sealJudgment` (`role-artifact.cjs:4066`) → `codeReviewResultData` rejects `review_round > ROUND_CAP` (`:3146`), re-authenticates the answer (`:4098`) and, for a pass, proves coverage (`assertCodeReviewLineage`, `:3113-3126`, called at `:4079`). `validateJudgmentManifest` (`:4158`) repeats both checks (`:4243`, `:4279`), so a sealed round-4 record is re-checked against the same bounds every time it is validated or replayed.
6. **Status for humans/conveyor** — `phase-code-review.cjs:126-186 status` returns `state ∈ unmatched|current|owed|limit`, `round`, `rounds_used`, `round_cap: core.ROUND_CAP` (`:132`), `repair` (`:169`). `limit` is *not head-specific*: any descendant of the three reviewed heads is `limit` (`countableVerdicts` accepts ancestors); proven by `tests/unit/phase-code-review.test.cjs:218-220` (`advance(4)` still `limit`, `rounds_used` 3).
7. **Publication** — `phase-code-review.cjs:393-488 publish`: posts the `code-review` commit status (`statusDescription`, `:209-224`) then, unless `limit` (`:443-446`: "limit publishes status only"), one marker comment `<!-- code-review -->` edited in place (`findingsComment`, `:269-298`; header `Code review — round ${sealed.round}, scope ${sealed.scope}` at `:271`). The comment passes PR hygiene (`pr-hygiene.cjs:210-222`) and is refused whole if it contains `Phase \d+`, `ADR-\d+`, `epic/`, `.planning/`, `gate_status:` or the words `shipyard|gsd|conveyor`.
8. **Repair routing** — `core.repairAllowed(round)` is `round === 1 || round === 2` (`code-review-core.cjs:347`). `status()` maps a `needs-fix` verdict to `repair: 'tickets'` or `'human'` (`phase-code-review.cjs:169`); `fixTickets` returns `[]` and prints the exit text for `'human'` (`:199-207`). **A round 4 or 5 already routes to `human` with no code change.**

---

## 3. Every dependency on `ROUND_CAP` / the countable-verdict number

| # | Site (path:line) | What it does | Would break for round 4 / 5 | Kind |
|---|---|---|---|---|
| 1 | `code-review-core.cjs:6` | `const ROUND_CAP = 3` | source of truth | constant |
| 2 | `code-review-core.cjs:196` | `normalizeResult`: `round > ROUND_CAP → INVALID_RESULT` | **yes**, at host normalization (`claude-role-host.cjs:1202`, `codex-code-review-context.cjs:427`) and at replay (`role-artifact.cjs:3046-3049`) | logic |
| 3 | `code-review-core.cjs:299-310` | `countableVerdicts` | no (count unbounded) | logic |
| 4 | `code-review-core.cjs:338-340` | `nextRound`: `used >= ROUND_CAP → limit` | **the intended gate**; takes no extension input today | logic |
| 5 | `code-review-core.cjs:341-345` | `inherit`/`coverageComplete` → delta base | no; yields `delta` from `verdicts.at(-1).head` for any N | logic |
| 6 | `code-review-core.cjs:319-337` | `coverageComplete.prove` recursion | no (depth = chain length, not `ROUND_CAP`) | logic |
| 7 | `code-review-core.cjs:347` | `repairAllowed` = rounds 1-2 | no; round ≥3 → `human` (as the operator wants) | logic |
| 8 | `code-review-core.cjs:521-527` | packet `review_round` | no | logic |
| 9 | `code-review-core.cjs:530` | exports `ROUND_CAP` | consumers: `phase-code-review.cjs:132`, `role-artifact.cjs:3146,3190` | export |
| 10 | `role-artifact.cjs:3146` | `codeReviewResultData`: `review_round > core.ROUND_CAP → INVALID_RESULT` | **yes** at **seal** and at **every replay** (`replayCodeReviewRecord` → `judgmentResultData` → `:3233`, `:3827`). Replay has no access to any extension record and runs on historical records | logic |
| 11 | `role-artifact.cjs:3190` | `authenticatedCodeReviewRecord`: `lineage.active.has(id) \|\| lineage.active.size >= ROUND_CAP → REVIEW_NATIVE_INVALID` | derived: cold chain passes round 4, **fails round 5**; see §0.3 and §13 S1 | logic (depth bound) |
| 12 | `role-artifact.cjs:2912,2937` | carried findings need `review_round >= 2` and predecessor `review_round === N-1` | no | logic |
| 13 | `role-artifact.cjs:3100` | seal packet round must equal result round | no | logic |
| 14 | `role-artifact.cjs:3465` | `current.round = verdict.review_round` | no | data |
| 15 | `role-artifact.cjs:2832` | `review_round` is a manifest field | no (schema is an integer) | data |
| 16 | `role-artifact.cjs:2875-2878` | `currentCodeReviewContract()` hashes `references/code-review.md` | **coupling**: changing the reference changes the contract digest | contract |
| 17 | `role-artifact.cjs:3216` | contract mismatch → verdict skipped (not counted, not current) | see §0.4 | contract |
| 18 | `phase-code-review.cjs:132` | `round_cap: core.ROUND_CAP` in status JSON | cosmetic ("round 4 of 3" would read from here) | output |
| 19 | `phase-code-review.cjs:154,162` | `countable`, `rounds_used = countable.length` | no | logic |
| 20 | `phase-code-review.cjs:169` | `repair` from `repairAllowed` | no | logic |
| 21 | `phase-code-review.cjs:178-183` | `state: next.state === 'limit' ? 'limit' : 'owed'`, text `three rounds are spent; no further review can launch` | text wrong once an extension exists | string |
| 22 | `phase-code-review.cjs:214-215` | `statusDescription` limit: `code review limit reached: no further review will run for this head` | text wrong once an extension exists; pinned by `phase-code-review-publish.test.cjs:212` | string |
| 23 | `phase-code-review.cjs:87-90` | `refusal()`: names only the `report` exit, "no override flag and no waiver record"; shared by four sites (`:94,181,196,202`) | the proposed new text would also appear for ticket/owed/needs-fix states unless it is made state-specific | string |
| 24 | `phase-code-review.cjs:272-275` | comment footer `Operator exit: set delivery_pipeline.code_review to "report" for this PR.` when `hold` and not a pass | text | string |
| 25 | `claude-role-host.cjs:613` | `three rounds are spent; no code-review launch is allowed` (`CODE_REVIEW_ROUND_LIMIT`); no exit named; no hint registered in `refusal-hints.cjs` | text; pinned by `claude-role-host.test.cjs:2465` (`/three rounds/`) | string |
| 26 | `codex-code-review-context.cjs:149` | `three countable reviews have already run` (`CODE_REVIEW_ROUND_LIMIT`) | text; pinned by `codex-code-review-context.test.cjs:252,1090-1091` (code only) | string |
| 27 | `claude-role-host.cjs:1004`, `codex-code-review-context.cjs:253` | prompt line `Review round N; scope …` (no "of 3") | no | prompt |
| 28 | `deliver-dispatch.cjs:1207-1209` | own copy of the exit sentence for ticket PRs | text duplicate | string |
| 29 | `deliver-dispatch.cjs:1210-1214` | `build arch-review --phase` calls `flow.evaluateGate`; refuses unless `ok` | no (reads `ok`) | gate |
| 30 | `references/code-review.md:25,50-52` | "Integer 1 through 3"; "No fourth review is owed. Repairs are allowed after rounds 1 and 2" | doc contradicts an extension and cannot be edited without resetting every counter (§0.4) | contract doc |
| 31 | `commands/deliver.md:38-42,1384-1385,1450-1463,1655-1668` | "single exit", "`repair: human` (round 3)", "no override flag or waiver record" | docs | doc |
| 32 | `docs/gsd_multilevel_delivery_pipeline.md:647-657` | "Round 3 requires an operator… the three-round cap permits no further review after limit… single exit … no override flag or waiver record" | docs | doc |
| 33 | `docs/audits/phase52/packet-limits.md:178,196`, `arch-review-cost.md:152` | structural cost bound "at most three code-review rounds per phase; worst case 3 × per-launch ceiling" | the ADR-032 cost criterion changes (up to 5 ×) | cost doc |

Not dependent on the round number (checked): `front.cjs` (only `AGENT_CARDINALITY['code-review']='ticket'`, `:1297`), `sentinel.cjs`, `state-sync.cjs`, `ci-wait.cjs`, `runtime-context.cjs`, `codex-delivery-host.cjs`, `claude-runtime-host.cjs` [C2, C2b]. `lineageComplete` (`code-review-core.cjs:311-318`) and `coverageComplete` are unbounded in N.

Design-relevant facts from this table (not recommendations):
- Admission (`nextRound`) runs on **current** state and three callers; seal and replay run on **historical** records and cannot see a record that may since have been voided (head moved) or deleted. A round-4 verdict sealed under an extension must stay replayable after the extension record is gone, otherwise the sealed verdict flips to invalid when its permission disappears. That argues for a hard absolute ceiling in seal/replay (rows 2, 10, 11) separate from the admission limit (row 4).
- Rows 25, 26 are the messages an operator sees when the *builder/host* refuses (the path `deliver.md:1405` takes first); only `status`/`gate` print any exit.
- `nextRound` has three callers that each build the same `history` object (`phase-code-review.cjs:147-154`, `claude-role-host.cjs:596-613`, `codex-code-review-context.cjs:141-149`); an extension input would have to be loaded identically in all three, so its loader cannot be duplicated per caller without drifting.
- A new `phase-code-review.cjs` verb needs the CLI table edits at `:512-529` (verb list, `names` map allowing only `--phase --pr --repo --graph --worktree`, usage text); every flag takes exactly one value (`i += 2`), and `--phase`/`--pr` are mandatory (`:529`).

---

## 4. What the verdict history and "limit" actually depend on (existing reset paths)

These are **existing** behaviours that already change `rounds_used` without any human record. They matter because the problem statement lists "no retroactive unblock except a new human-written record" as out of scope.

| Path | Mechanism | Evidence |
|---|---|---|
| Release with a different `references/code-review.md` | old verdicts skipped → `rounds_used` 0, review re-owed, gate closed | `role-artifact.cjs:3216`; `tests/unit/code-review-foreign-contract.test.cjs:54-69` "a release with another contract skips a sealed verdict: no round counts and the review is owed" (6/6 pass [C12]) |
| **The epic itself** | reference changed vs `main` (4 hunks: `exact_diff` row plus a new `part`/`parts` row, `evidence_markdown` row, the partition paragraph, the Evidence section) | [C10]: `main` sha256 `5d121a46…`, epic `0c96442c…`; commits `8e4cf110` (HS-17), `44fefbc4` (HS-17b), `27c122c4` (HS-22) |
| History rewrite / rebase | verdicts whose head is not an ancestor of the current head are not countable → `nextRound` returns round 1 | `code-review-core.cjs:304`; `tests/unit/code-review-core.test.cjs:179` (`isAncestor: () => false` → round 1) |
| Verdicts in a worktree git does not list | only `root`, `git worktree list`, and the graph project root are scanned | `role-artifact.cjs:3257-3258`, `:1377-1380`; records live under `…/role-artifact-authority/<sha256(realpath(worktree))>/` (`:944-946`) |
| Verdict without current review authority | skipped | `role-artifact.cjs:3216`; `code-review-foreign-contract.test.cjs:71-91` |
| Config flip changes "current" but not the count | the sealed planning pin includes `.planning/config.json` bytes; flipping `code_review` makes the verdict non-current until the bytes are restored | `context-packet.cjs:181-194` (`config` pin; `authenticatedPlanningRoot` compares whole reference), `role-artifact.cjs:3377-3381,3456`; `tests/unit/phase-code-review.test.cjs:206-216` (flip → `state` `owed`/`limit`; restore → `current`) |

Consequence for the incident: a PR that exhausted 3 rounds under a `main`-built Shipyard and is then served by the rc.2 build shows `rounds_used: 0` (assuming the sealed manifests carry `main`'s digest). **UNKNOWN** whether that is the pdffiller-mcp case; the next check is to compare the incident verdict manifests' `contract_digest` with `contractDigest('0c96442c…')` of the epic and `5d121a46…` of `main`.

---

## 5. Readers of the code-review state at the merge gate

| Reader | Where | Reads code-review state? |
|---|---|---|
| Hold gate CLI | `phase-code-review.cjs:530-531` (`gate`; stderr message, exit 0/1) | yes, `evaluateGate` (`:188-197`) |
| Status CLI / fix tickets / publish | `:535`, `:199-207`, `:393-488` | yes |
| Architecture builder | `deliver-dispatch.cjs:1205-1214` | yes (`evaluateGate`; refuses unless `ok`) — the programmatic admission to arch-review |
| Trailer verifier | `gate-trailer.cjs:367-388` (`verify`) | yes: prints `{...architecture, code_review}` and exits 1 unless `checked.ready && (!codeReview \|\| codeReview.ok)` |
| Trailer writer | `gate-trailer.cjs:396-485` | **no**: requires an authenticated architecture verdict (`:449-456,478-481`), writes `merge-gate` status via `postGate` (`:192-201,482`) |
| Sentinel merge | `sentinel.cjs:69-73,1227-1235` | **no**: `currentReviewAdmission` → `verifyCurrentReviews` (architecture only); a PR into the integration branch is blocked as "a human's decision, never the sentinel's" |
| state-sync | `state-sync.cjs:77` | no (same `verifyCurrentReviews`) |
| front / board | `front.cjs:1297` | no |
| Operator doc flow | `deliver.md:1384-1472` (status → build → launch → publish → status; prelaunch gate before integrator), `:1655-1668` (verify; readiness/hand-off in `hold` require a current pass) | procedural |

The only rule that stops a phase PR from landing without a code-review pass is procedural plus the two programmatic checks above; the status is "non-required: a human can still merge" (`deliver.md:1668`; ADR-032 "The phase guarantee is visible, not enforced… No required status check or branch protection is assumed", [C7]).

### What the trailer / GitHub currently carries about code review

| Surface | Content | Limit | Evidence |
|---|---|---|---|
| `code-review` commit status | `success`/`pending` + fixed text (`code review: no blocking issues, N notes`; `code review: N blocking issues, M notes`; `code review incomplete: N partitions not reviewed`; `code review limit reached: no further review will run for this head`) | GitHub 140 chars; "fixed text and integer counts only" (`docs/gsd_multilevel_delivery_pipeline.md:641`); `count()` rejects non-integers (`phase-code-review.cjs:210-213`) | `phase-code-review.cjs:209-224` |
| `<!-- code-review -->` PR comment | header `round N, scope S`, `Verdict`, findings, `N findings not raised again…`, `citations_unresolved`, optional `Operator exit:` footer; body ≤ 60000; hygiene-checked; **not written at `limit`** | `findingsComment` stops at 60000 characters | `:269-298`, `:443-446` |
| `merge-gate` status (the "gate trailer") | `arch-review=conform, drift-check=<fresh\|skipped>, degenerate-green=<clean\|N\|skipped>, checks=green[, base_tree=<40 hex>]` — **no code-review key** | `STATUS_MAX = 140` (`gate-trailer.cjs:166,192-194`); measured length 128 (fresh/clean) to 132 (skipped/skipped) with `base_tree` [C11]; the proposed tail alone is 78 characters | `gate-trailer.cjs:474-476` |
| PR body `gate_status:` line | legacy fallback read only when no `merge-gate` status exists (`readGate`, `:178-190`) | no length limit but not written by the current writer | `gate-trailer.cjs:86-100,177-190` |

---

## 6. Operator versus model: what distinguishes them today

### 6.1 `planning-untrack.cjs --confirm`
`CONFIRM_TOKEN = 'untrack-planning'` (`:10`); `apply` fails with `CONFIRMATION_REQUIRED` unless `confirm === CONFIRM_TOKEN` (`:73`); the Makefile target requires `CONFIRM=untrack-planning` (`Makefile`, target `untrack-planning`). It additionally refuses on a dirty worktree, on the default branch and for the Shipyard repo itself (`:74-82`). **There is no TTY, uid, environment or secret check** [C2b]; the token is a typo guard that any caller able to read the source or the Makefile can supply. It is therefore not evidence of a human, as PROBLEM.md already suspects.

### 6.2 The existing exit: `delivery_pipeline.code_review: report`
- Default `'hold'` (`pipeline-config.cjs:536`, comment `@contract: report | hold`); unknown values fall back to `hold` with a warning (`:1100-1102`).
- Read by `resolveCodeReviewMode` from the **project root's** `.planning/config.json` (`phase-code-review.cjs:58-71`), via `loadConfig`. It is **one scalar for the whole project**: "for this PR" is a convention, not a scope (no per-PR, per-phase or per-head key exists; [C2]).
- No writer command exists: `Grep code_review` over `plugins/delivery-pipeline/scripts` (excluding `role-artifact`, `claude-role-host`, `codex-code-review-context`, where `code_review` is a runtime-evidence key, e.g. `role-artifact.cjs:3087,3414,3422`) finds only the default (`pipeline-config.cjs:536`), the validation (`:1100-1102`), the reader (`phase-code-review.cjs:60-69`), the exit sentence (`phase-code-review.cjs:88,275`, `deliver-dispatch.cjs:1209`) and the verify output key (`gate-trailer.cjs:385`). The operator edits JSON by hand. The file is unsigned; the reader I examined checks only that it is a regular, non-symlink file of at most 8 MiB and parses (`readJson`, `phase-code-review.cjs:16-26`) — no owner or mode check — and in target projects it is untracked after `planning-untrack`. I did not read `loadConfig` itself beyond its documented `code_review` handling.
- Invalid config (e.g. `[]`) makes `publish` refuse with `CONFIG_INVALID` (`phase-code-review.cjs:73-78,395,407,434`; test `phase-code-review-publish.test.cjs:200-209`).
- Writers able to change it: any process with write access to the project root — the operator, the orchestrator model's Edit/Write tool, and a role child **only if** the project root is inside its writable worktree (`allowWrite: [worktree]`, `claude-runtime-host.cjs:756`). Whether the project's `.planning/` sits inside the epic worktree or in a separate checkout is project-specific (**UNKNOWN**; `resolveGraphDir`/`resolvePlanningReference` support a relocated planning root, `context-packet.cjs:153-185`).

### 6.3 The authority namespace and `hmac.key`
- Path: `~/.local/state/shipyard/role-artifact-authority/<sha256(realpath(worktree))>/` (`role-artifact.cjs:921-946`), created `0700`; refused when group/other bits are set or any ancestor is a symlink (`:935-940`, `:1012-1014`).
- Key: 32 bytes of `crypto.randomBytes`, written `wx` mode `0600` and hard-linked into place (`:989-997`), read through `authorityFile` which rejects `(stat.mode & 0o077)` and symlinks (`:948-972`). **No `getuid`/owner comparison exists anywhere in `role-artifact.cjs`** (`Grep getuid|st_uid|\.uid` → no matches). Records are `{payload, mac: HMAC-SHA256(key, stable(payload))}` (`:1020-1041`).
- A key is **never re-created over existing protected records**: `protectedRecordsWithoutKey` → `PROTECTED_RECORDS_NEED_KEY` (`:999-1018`).
- The same custody model repeats in `host-verification.cjs:229-255` (`<stateRoot>/verification/hmac.key`), `dispatch-boundary.cjs:211-255` (`.shipyard-dispatch-authority-<digest>.key` beside the root), `codex-delivery-host.cjs:339-369` (`finalization-authority/hmac.key`).
- Same-user reachability: file mode 0600 owned by the operator's uid is readable by every process of that uid. The only barrier is OS sandboxing of *selected child processes* (below).
- The publication record that already lives in `~/.local/state/shipyard/code-review-publications/<sha256(repository, selector)>/<pr>.json` is **not signed** and is not a trust boundary (schema + identity + uid + 0600 + `withLock`, `phase-code-review.cjs:306-391`); it only binds a comment id to a body hash.

### 6.4 Host admission and child isolation (both runtimes)
| | Claude (`claude-runtime-host.cjs`) | Codex (`codex-runtime-host.cjs`) |
|---|---|---|
| Child launch | `claude --print … --restricted --strict-mcp-config --tools Bash,Read,Edit,Write,Glob,Grep --permission-mode dontAsk --permission-prompts none --setting-sources '' --settings <json>` (`:783-792`; `ALLOWED_TOOLS` `:34`) | `codex exec --json … --ignore-user-config --config default_permissions=… --config permissions.<profile>.filesystem={…}` (`:1183-1190`) |
| Authority isolation | `sandbox.enabled`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `filesystem: { allowWrite: [worktree], denyRead: [archiveAuthority], denyWrite: [archiveAuthority] }`; permission `deny` for Read/Edit/Write/Glob/Grep on the authority and evidence globs; `blockReadsOutsideWorkingDirectories: true` (`:750-763`) | permission profile extends `:read-only` or `:workspace` with `"<path>"="deny"` for `archiveAuthority` (`:1109-1110,1170`), `~/.gnupg`, `~/.ssh`, `SSH_AUTH_SOCK`, `user.signingkey` (`signerProtectionPaths`, `:1051-1064`); error `SIGNER_ISOLATION_UNAVAILABLE` when empty (`:1084`) |
| Credentials | env credentials denied in the sandbox: Anthropic, AWS, `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `NPM_TOKEN` (`:36-49,757`); `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (`:85`) | env scrub of `CODEX_*` session vars, `OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_*`, `GNUPGHOME`, `GPG_*`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID` (`:1172-1181`) |
| Request hygiene | `authorityFree` refuses `authority`, `owner_token`, `session_token`, `launch_token` keys crossing the host boundary (`:103-116`) | `archiveAuthorityPath`/`archiveCataloguePath` launch options refused (`:1115-1117`; also Claude `:707-709`) |
| What admission means | model/effort selection, policy fingerprint, receipt — it admits a **role launch**, it does not identify a human | same |

Observation made inside this very worker (not a repo fact): the sandbox configuration printed in this session lists `…/role-artifact-authority`, a `shipyard-claude-session-start-*` temp directory and `/Users/serhii` under read-deny, with write limited to the worktree and `$TMPDIR`. This matches the construction at `claude-runtime-host.cjs:740-756` (`mkdtempSync('shipyard-claude-session-start-')`, `denyRead: [archiveAuthority]`), i.e. this worker is a host-launched child. **ASSUMPTION** that the match is exact; next check: compare the launch settings recorded in this dispatch's receipt.

### 6.5 TTY and environment checks
`Grep isTTY|stdin\.isTTY|isatty|/dev/tty|ttyname` over `plugins/delivery-pipeline` (and the generated mirror) finds exactly one use: `repo-resolve.cjs:1736`, an interactive choice for picking a repository checkout (`!options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY`) — not authority. `ci-wait.cjs:144-145` sniffs `CODEX_SANDBOX*`/`CLAUDE_PLUGIN_ROOT`/`CLAUDE_CODE_ENTRYPOINT` to choose a window size (forgeable environment variables). `runtime-context.cjs` has no `process.env` access (`Grep` no matches). `codex-notify.cjs:21,34` (a notify re-entry guard and delegate file) and `stop-gate-arm.cjs:126` (`CLAUDE_CODE_SESSION_ID`) read environment values for notification/session handling; I did not read them beyond the matching lines and found no authority use [C2b]. **No existing code treats any TTY or environment signal as proof of a human.**

### 6.6 The orchestrator gap (what the model can and cannot do as the same user)
| Actor | Can (evidence) | Cannot (evidence) |
|---|---|---|
| Role child (reviewer) | read the worktree and its git history; run Bash inside the sandbox; edit files in its worktree | read/write the authority namespace (`claude-runtime-host.cjs:756`, `codex-runtime-host.cjs:1085,1110`); write outside the worktree; use `GITHUB_TOKEN`/`GH_TOKEN`; see `~/.ssh`/`~/.gnupg`/agent sockets (Codex) |
| Orchestrating session (the model running `/shipyard:deliver`) | run every `phase-code-review.cjs` verb (`deliver.md:1404,1441,1468`), `gh api` for status/comment writes (`publish`), write `~/.local/state/shipyard/code-review-publications/…` (it must, to publish), edit `.planning/config.json`, run a node snippet calling `createClaudeRoleHost(options).run(request)` (`deliver.md:1431-1433`) | nothing that Shipyard code enforces; any limit comes from the user's own Claude Code / Codex configuration (**UNKNOWN**) |
| Human at a terminal | all of the above plus interactive presence (pinentry, Touch ID, a GitHub web click) | — |

The repository ships no orchestrator-level protection: `scripts/install-shipyard-claude-hook.sh:55` edits `$CLAUDE_HOME/settings.json` (Stop hook bundle) but `Grep denyRead|permissions|sandbox|"deny"|settings.json` over the install, doctor and bootstrap scripts finds only the settings path, and `README.md` has no sandbox/permission guidance [C18]. The only hook in the shipped Claude plugin is the SessionStart bootstrap (`plugins/shipyard/hooks/hooks.json`); `PreToolUse` appears only in a doc sentence about `git push` (`skills/delivery-rules/SKILL.md:95`). Whatever protects the orchestrator comes from the user's own configuration.

So a "refused when the model calls it through a role host" rule would defend only the reviewer child, which already cannot write the state directory. The party that matters for consent forgery is the orchestrator, for which the repository ships no isolation and no human-presence primitive. **ASSUMPTION:** an orchestrator with a Bash tool can allocate a pseudo-terminal (so a bare TTY check would not separate it from a human); next check is a spike that tries `script`/`python -c 'import pty'` from the Bash tool of the supported hosts.

---

## 7. Existing tests that pin the cap and its exit text

| Test file | What it pins | Lines |
|---|---|---|
| `tests/unit/code-review-core.test.cjs` | `nextRound` for n = 0..3, `round` null at 3, `repairAllowed` → `[true,true,false]`, `isAncestor` false → round 1, delta/full scope, `limit` after chain | `:167-181`, `:357-371` |
| `tests/unit/phase-code-review.test.cjs` | 3-round cycle with fix-ticket membership change, `repair` `tickets`/`human`, `limit` after `advance(4)`, gate message `/three rounds.*delivery_pipeline.code_review.*report/`, `fixTickets` diagnostic `/no longer re-check.*BLOCKERs stay visible.*delivery_pipeline.code_review.*report/`, arch-review builder refuses with the held message, config flip → stale | `:180-229`, `:404-465`, `:718` |
| `tests/unit/phase-code-review-publish.test.cjs` | `limit` publishes `pending` with description `code review limit reached: no further review will run for this head`, comment `skipped`, invalid config refusal; runs the **generated mirror** copy too (`:1061-1063`) | `:187-221`, `:388`, `:1061-1063` |
| `tests/unit/role-artifact.test.cjs` | three sealed rounds, `rounds_used` / `next.round === null` / `limit` at 3, `round_cap === 3` in status | `:1933-1956`, `:2287` |
| `tests/unit/claude-role-host.test.cjs` | rounds 1-3 launch with exact archives, fourth launch refused `CODE_REVIEW_ROUND_LIMIT` with `/three rounds/` | `:2435-2468` |
| `tests/unit/codex-code-review-context.test.cjs` | fourth prepare refuses `CODE_REVIEW_ROUND_LIMIT` (`:252`, `:1087-1091`) | as listed |
| `tests/unit/code-review-foreign-contract.test.cjs` | foreign contract / missing authority → no round counts | `:54-91` |
| `tests/unit/planning-untrack.test.cjs`, `tests/unit/pipeline-config.test.cjs` | confirm token behaviour; `code_review` default/validation | not read in detail |

No test exercises a round 4, an extension, a TTY, or an operator-only caller. The replay-depth bound (`role-artifact.cjs:3190`) has no message-level pin: `Grep cyclic|source lineage|lineage.*bound|REVIEW_NATIVE_INVALID` over `tests/` finds only unrelated `cyclic` hits and `REVIEW_NATIVE_INVALID` assertions on `ambiguous` and `ancestry` messages (`claude-role-host.test.cjs:3333`, `codex-code-review-context.test.cjs:1464,1572`); I did not check whether a code-only `REVIEW_NATIVE_INVALID` assertion reaches it [C20]. No test pins the exit sentence in `deliver.md` (`Grep` for `no override flag|waiver record|single exit` in `tests/` finds nothing), but the sentence is duplicated in code at `phase-code-review.cjs:87-90` and `deliver-dispatch.cjs:1209`.

### Baseline run (read-only, isolated HOME/TMPDIR as `tests/unit/run.sh` does) [C12]

Command per file: `node tests/unit/<name>.test.cjs` with the private environment of `tests/unit/run.sh:119-125`, from the worktree root, no code changed.

| Suite | Exit | Result (node:test summary) |
|---|---|---|
| `code-review-core.test.cjs` | 0 | pass 26, fail 0, cancelled 0, skipped 0 |
| `code-review-parts.test.cjs` | 0 | pass 14, fail 0, cancelled 0, skipped 0 |
| `code-review-foreign-contract.test.cjs` | 0 | pass 6, fail 0, cancelled 0, skipped 0 (≈11.9 s) |
| `phase-code-review.test.cjs` | 0 | pass 68, fail 0, cancelled 0, skipped 0 |
| `phase-code-review-publish.test.cjs` | 0 | pass 102, fail 0, cancelled 0, skipped 0 |
| `claude-role-host.test.cjs` | 0 | pass 235, fail 0, cancelled 0, skipped 0 |
| `codex-code-review-context.test.cjs` | 0 | pass 153, fail 0, cancelled 0, skipped 0 |
| `planning-untrack.test.cjs` | 0 | exit 0; the file does not print the node:test `ℹ` summary, so no counts were captured |
| `pipeline-config.test.cjs` | 0 | exit 0; same, no counts captured |
| `role-artifact.test.cjs` | **1** | **nonzero exit in the parallel run; its log was not readable from this sandbox (reads under `/tmp` are blocked), so the cause is not established** |

The solo re-run of `role-artifact.test.cjs` (`… | tail -150`, so only the failing tail would have been printed) had **not finished when this artifact was sealed**; its result is therefore **not established** and no claim is made that the suite passes or fails, nor why the parallel run exited 1 (candidates, all unverified: a genuine failure on the epic tip, a timing or resource effect of running seven suites at once, or the sandbox that denies `nice(5)` — every parallel child printed `nice(5) failed: operation not permitted`). Next check: `node tests/unit/role-artifact.test.cjs 2>&1 | tail -150` from the worktree root with the private environment of `tests/unit/run.sh:119-125`, or `make test-unit`.

The first three suites cover the pure round logic (`nextRound`, `repairAllowed`, `countableVerdicts`, normalization) and the contract-skip behaviour. The host, publication and replay paths that §3 flags for rounds 4 and 5 are covered by the next four suites and by `role-artifact.test.cjs` (`:1933-1956`, `:2287`).

---

## 8. Generated package, digest pin, docs contract, CI (what a new command would touch)

- **Canonical vs generated.** `plugins/delivery-pipeline/` is canonical; `plugins/shipyard/host/plugins/delivery-pipeline/` is a verbatim `fs.cpSync` of it produced by `scripts/package-shipyard-codex.cjs:21`, then `plugins/shipyard/.codex-plugin/plugin.json` (version suffix `+codex.<digest>`) and `package-build.json` (digest) are regenerated (`:61-67`). Today the mirror is identical (`diff -rq` exit 0, [C3]). `CLAUDE.md:79-84`: never edit the `host/` copy; run `make package-shipyard-codex`; the staleness check is skipped for ticket PRs into `epic/*` and enforced on the epic → `main` PR (`package-shipyard-codex.cjs:71-74`, `packageFreshnessRequired`: not required when the base ref starts with `epic/` or `ticket/`).
- **Runtime-file digest pin.** `tests/unit/runtime-file-digests.json` pins **only two files**: `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` (`node -e` over the JSON, [C15]); `node scripts/refresh-runtime-digests.cjs --check` exits 0. A new verb in `phase-code-review.cjs`, edits to `code-review-core.cjs`, `role-artifact.cjs`, the hosts or the docs do **not** touch the pin. The only way to change the pin is `make refresh-runtime-digests` plus its printed trailer (`CLAUDE.md:137-138`).
- **Docs contract.** `tests/smoke/docs-smoke.sh` checks the README/plugin.json command surface, Make targets named by the README, host script names named by the README, Claude hook/install paths; it does not pin the phase-code-review wording (`Grep phase-code-review|code_review|waiver|override flag` in the script → no matches). The README must be updated "when the supported command or installation flow changes" (`CLAUDE.md:136`).
- **Comment policy.** `comment-policy.cjs` is the *source-code* comment policy (markers `@invariant|@security|@contract`, history words such as `ticket`, `adr-N`, `because`, `previously` rejected in changed code comments; `comment-policy.cjs:9-12`), enforced in CI with `COMMENT_POLICY_BASE` (`.github/workflows/test.yml`) and `make test-comment-policy`. It applies to any new implementation comments; it is distinct from PR-comment hygiene (`pr-hygiene.cjs:210-222`).
- **CI.** `.github/workflows/test.yml`: 12 unit shards with `SHIPYARD_REQUIRE_OS_SANDBOX=1` (bubblewrap installed), then `make test-fast-rest`; unit run is `./tests/unit/run.sh` (syntax-checks every `plugins/delivery-pipeline/scripts/*.cjs`, runs each `tests/unit/*.test.cjs` with a private `HOME`).
- **Version skew / rollback.** A record with `review_round` 4 read by a build whose `codeReviewResultData` still enforces 3 throws `INVALID_RESULT` out of `priorCodeReviewVerdicts` (`:3146`, no try/catch around `authenticatedCodeReviewRecord` in the loop, `:3267`), which `phase-code-review.cjs:145` does not guard — the whole status call fails for that phase. If the contract digest also differs the older build skips the record instead (`:3216`). Either way a rollback does not cleanly ignore a round-4 record. (Derived from code; **not executed**.)

---

## 9. Authority and identity facts a design must respect (existing invariants)

- Exact-head and exact-base binding of every verdict: `reuse_key = sha256('code-review', head, base_commit, contract_digest)` (`code-review-core.cjs:529`), `currentCodeReviewVerdict` requires `exactCurrentGitSubject`, clean product tree, planning-pin equality, coverage proof (`role-artifact.cjs:3316-3476`).
- Verdicts are sealed only by the trusted host against original native receipts (`replayCodeReviewRecord`, `:3201-3253`; `trustedRecord`, `:3205`); the model never writes a verdict, GitHub status or comment (`deliver.md:1448-1449`, "The model never writes either to GitHub").
- No new contract ids is an operator constraint; the ids already in the code-review path are `shipyard.phase-code-review.v1` (`code-review-core.cjs:5`), `shipyard.code-review-disagreements.v1` (`code-review-core.cjs:482`), `shipyard.role-archive-catalogue.v1` (`role-artifact.cjs:1023`), `shipyard.current-review-authority.v2` (`role-artifact.cjs:2372`), `shipyard.current-review-contract.v2` (`role-artifact.cjs:3066`), `shipyard.phase-code-review-status.v1` (`phase-code-review.cjs:130`), `shipyard.phase-code-review-publish.v1` (`phase-code-review.cjs:432`), `shipyard.code-review-publication.v1` (`phase-code-review.cjs:309`). Listed from the sites read; not an exhaustive repository grep.
- An operator already has a written, human-authored, repository-relative input of the same family: the recorded-disagreement carrier `.planning/phases/<phase>/code-review-disagreements.json` (`code-review-core.cjs:477-508`, bound into packets via `dispositions_digest`, `role-artifact.cjs:3361-3375`). It is a plain file, **not signed**, 64 KiB, with `recorded_by` free text.
- Config-pin sensitivity: anything an extension design stores under `.planning/` (config, graph, planning files named in the pin) perturbs `planning_reference` and can make sealed verdicts non-current (`context-packet.cjs:181-194`, `role-artifact.cjs:3377-3381`).

---

## 10. Known warts (observed, not fixed)

1. The cap lives in four code enforcers plus many strings and docs (§3 rows 21-33); raising it is a multi-file change even when it is "just one more round".
2. The refusal sentence is duplicated (`phase-code-review.cjs:87-90`, `deliver-dispatch.cjs:1209`, `deliver.md:42,1458`, docs `:651-654`) and the `refusal()` helper is shared by states where the exit does not apply (ticket PR, owed, needs-fix).
3. The host-level `CODE_REVIEW_ROUND_LIMIT` messages name no exit and have no `refusal-hints.cjs` entry (`Grep CODE_REVIEW_ROUND_LIMIT` → only the two `reject`/`fail` sites).
4. `limit` is reported for any descendant head; its status text "no further review will run for this head" is imprecise (it means "for any head of this lineage").
5. The `report` "exit for this PR" is project-wide; a second phase PR in the same project is un-held while the flag is flipped.
6. The exit is a manual JSON edit with no writer, no audit trail of who flipped it and when, and flipping it temporarily makes sealed verdicts non-current (test `phase-code-review.test.cjs:206-216`).
7. `limit` publishes status only (`phase-code-review.cjs:443-446`): the PR comment is not touched, so the comment written when the third verdict was published stays the last comment text and nothing in the PR comment says the cap was reached.
8. `status` JSON exposes `round_cap: 3` (a constant), so any "N of M" display has to be derived elsewhere.
9. Trailer status description budget is nearly exhausted (8-12 of 140 characters free).
10. The reference doc is simultaneously reviewer instructions and the contract digest; an editorial change is a behavioural change (§0.4).

---

## 11. Incident evidence (read-only, if reachable)

- `ls /Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp/.planning` → `Operation not permitted`, exit 1 [C13]. The sandbox permits reads only inside the harness-simplification worktree and the shared `.git`; I did not attempt another route.
- `ls -ld ~/.local/state/shipyard ~/.local/state/shipyard/role-artifact-authority` was **refused by the permission layer and not executed** [C14]; the authority directory is also on the sandbox read-deny list. No key material, catalogue or record was read.
- Consequently **no** claim in this file is based on the pdffiller-mcp branch `research/mcp-tools-ai-pdf-12908`, its `.planning/graph/`, its `.shipyard-code-review-evidence.md` or its host records. The operator's description in PROBLEM.md (three rounds spent, only exit `report`) is accepted as stated and is consistent with `code-review-core.cjs:338-340`.

---

## 12. Constraints already visible from system state (seeds; the constraints line owns the full list)

| Constraint | Source | Confidence |
|---|---|---|
| Admission and seal/replay are separate code paths; replay sees only historical records | `role-artifact.cjs:3146,3190,3233`; `code-review-core.cjs:196,338` | high |
| `references/code-review.md` is part of the contract digest; editing it resets counters | `role-artifact.cjs:2875-2878,3216`; `code-review-foreign-contract.test.cjs` | high (test-proven for a different reference file) |
| Commit-status description ≤ 140 chars; code-review status is "fixed text and integer counts only" | `gate-trailer.cjs:166,192-194`; `docs/gsd_multilevel_delivery_pipeline.md:641`; `phase-code-review.cjs:210-213` | high |
| PR comment bodies are refused whole on internal identifiers/tool words | `pr-hygiene.cjs:210-232`; `phase-code-review.cjs:449-455` | high |
| Codex package is generated from canonical scripts; mirror compared in tests (`phase-code-review-publish.test.cjs:1061-1063`) | `CLAUDE.md:79-84`; `package-shipyard-codex.cjs:21` | high |
| Spawned children are isolated from the authority namespace; the orchestrator is not | `claude-runtime-host.cjs:750-792`; `codex-runtime-host.cjs:1079-1110` | high for children, UNKNOWN for the orchestrator's own config |
| State outside the worktree is allowed and already used (`code-review-publications`, authority namespace) | `phase-code-review.cjs:306-336`; `role-artifact.cjs:921-946` | high |
| Planning pins make anything stored under `.planning/` perturb "current" | `context-packet.cjs:181-194`; `phase-code-review.test.cjs:206-216` | high |
| ADR-032 is accepted: single exit, "no waiver store", waiver store under Out of scope; epic's `.planning/architecture/` does not carry it | [C7], [C8] | high |

ADR-032 text relevant to the decision (from `git show 94d05497:.planning/architecture/ADR-032-code-review-fallback.md`, [C7]): "At most 3 rounds run… After that nothing new is raised; any remaining BLOCKER stays visible on the PR and a human switches the hold off for that PR through the mode setting"; "The hold has one defined exit: after the round cap, or at any time, the operator sets the mode to report for that PR; no waiver store is added"; "The phase guarantee is visible, not enforced… A human can still merge without it"; Out of scope: "Enforcing the phase guarantee against a human merge, a doctor check recommending a required status check, and a waiver store." The cost criterion is "no more than one `arch-review` per phase… structural bound" and the audits restate it as at most three rounds per phase (`docs/audits/phase52/arch-review-cost.md:152`, `packet-limits.md:178,196`).

---

## 13. Unknowns, assumptions and next checks

Each item is mirrored as an OPEN-QUESTIONS seed below.

- **U1 (build in the incident):** which Shipyard build and which `contract_digest` sealed the pdffiller-mcp verdicts; whether rc.2 already shows `rounds_used: 0` there. Next check: operator compares the manifests' `contract_digest` with the two reference digests in §4.
- **U2 (orchestrator isolation):** whether the user's Claude Code / Codex configuration denies the orchestrating session read access to `~/.local/state/shipyard/role-artifact-authority` and to `.planning/config.json` writes. Next check: operator runs `stat` (size only, never the contents) on a file under the namespace from a normal orchestrating session, and inspects `~/.claude/settings*.json` / the Codex config for deny rules.
- **U3 (pty):** whether the Bash tool of each supported host can allocate a pseudo-terminal. Next check: spike.
- **U4 (replay depth):** the derivation in §0.3 (round 4 passes, round 5 fails; status-path swallow vs seal-path throw; memoization order dependence in `priorCodeReviewVerdicts`). Next check: spike.
- **U5 (version skew):** behaviour of an older installed build reading a round-4 record (§8). Next check: spike with the previous tag.
- **U6 (project root vs worktree):** whether `.planning/config.json` is inside the epic worktree in typical target projects (decides whether a reviewer child could write the exit). Next check: inspect `resolveGraphDir` results in a relocated-planning fixture (`context-packet.cjs:153-185`).
- **U7 (remote/deployed state):** remote tag and marketplace build for rc.2; blocked here ([C16]).
- **U8 (branch protection):** whether any target repository makes the `code-review` status required (ADR-032 assumes none). Owner: operator; next check: `gh api repos/<r>/branches/<b>/protection`.
- **U9 (bot pushes):** whether CodeRabbit/Copilot or `base-merge.cjs` can move a phase-PR head after the third verdict (relevant to "record bound to head voids on move"). Owner: operator/maintainer; next check: review `base-merge.cjs` and `epic-branch.sh` call sites for the integration branch.
- **U10 (cost bound):** whether the Phase 52 cost audits (`arch-review-cost.md:152`, `packet-limits.md:178,196`) are normative or historical. Owner: maintainer.

### Recommended spikes (not done here; no throwaway code was written)
- **S1** `/gsd-spike "round-4 replay: raise ROUND_CAP admission and normalization only in a scratch worktree and observe seal, status replay and lineage bound for rounds 4 and 5, including a cold chain and a warm memo"` (U4, U5).
- **S2** `/gsd-spike "can the Bash tool of Claude Code and Codex allocate a pty, and read or write a scratch 0600 file placed under a scratch directory in the user's home (never the real authority key), from the orchestrating session"` (U2, U3).
- **S3** `/gsd-spike "reference-doc edit: confirm that one added sentence in references/code-review.md re-owes a sealed verdict on a fixture PR and resets rounds_used; and that a verdict sealed under main's reference is skipped by the rc.2 build"` (§0.4, U1; the existing test proves it for a different reference file).

---

## 14. Command log

All commands run in `/Volumes/KINGSTON/.wt-claude-shipyard/harness-simplification` unless noted. `Grep`/`Read` entries are the dedicated tools.

- **C1** `git rev-parse HEAD` → `749604b9307ce21d7790f0a5b8f97920dca9aa7f`; `git status --short` → `?? .planning/investigations/INV-021-human-review-round-extension/`.
- **C2** `Grep ROUND_CAP|CODE_REVIEW_ROUND_LIMIT` over the repo (excluding `docs/audits`, `.planning/investigations`) → `code-review-core.cjs:6,196,340,530`; `role-artifact.cjs:3146,3190`; `claude-role-host.cjs:613`; `codex-code-review-context.cjs:149`; `phase-code-review.cjs:132`; tests as in §7. `Grep nextRound|countableVerdicts|review_round|repairAllowed|CODE_REVIEW_ROUND|three round|rounds_used|round_cap|round\.(state|round|scope)` over `plugins/delivery-pipeline` (excluding the three core files) → `codex-code-review-context.cjs:148-149,253,427`; `claude-role-host.cjs:611-613,1004,1202-1203`; `references/code-review.md:25,161`. `Grep three rounds|three countable|…|waiver` → `deliver.md:42,1458`, `phase-code-review.cjs:89,181,215`, `claude-role-host.cjs:613`, `codex-code-review-context.cjs:149`, `deliver-dispatch.cjs:1209`.
- **C2b** `Grep isTTY|stdin\.isTTY|isatty|/dev/tty|ttyname` over `plugins` (excluding the mirror) → only `repo-resolve.cjs:1736`. `Grep code[-_ ]review|codeReview` over `sentinel|front|gate-trailer|pr-hygiene|comment-policy|pipeline-config|refusal-hints|ci-wait|runtime-context|delivery-state|status` `.cjs` → `pipeline-config.cjs:536,626,633,1100-1102,1317`; `gate-trailer.cjs:384-386`; `front.cjs:1297`; `runtime-context.cjs:557`. `Grep evaluateGate|fixTickets|phase-code-review` over `plugins/delivery-pipeline/scripts` → `deliver-dispatch.cjs:1205,1211`; `gate-trailer.cjs:384`; `role-artifact.cjs:3306`. `Grep getuid|st_uid|\.uid` in `role-artifact.cjs` → no matches. `Grep process\.env` in `runtime-context.cjs` → no matches.
- **C3** `git ls-files plugins/shipyard | head`, `git check-ignore -v plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs` (exit 1: tracked, not ignored); `diff -q plugins/delivery-pipeline/scripts/code-review-core.cjs plugins/shipyard/host/plugins/delivery-pipeline/scripts/code-review-core.cjs` exit 0; `diff -rq plugins/delivery-pipeline plugins/shipyard/host/plugins/delivery-pipeline` exit 0 (no output).
- **C5** `git log --oneline -S"const ROUND_CAP = 3" -- plugins/delivery-pipeline/scripts/code-review-core.cjs` → `0878fb86 Phase 52: native fallback code review and bounded integration (#526)`.
- **C6** `git branch -a --contains 749604b9` → `* epic/harness-simplification`, `remotes/origin/epic/harness-simplification`; `git merge-base main HEAD` and `git rev-parse main` → both `0878fb861039f828c4565b87f7cb2cd713dbb63d`; `git rev-list --left-right --count main...HEAD` → `0 46`; `git tag --contains HEAD` → `v1.0.0-rc.2`; `git show --stat v1.0.0-rc.2` → annotated, PGP-signed, tagger Nochevnyi Serhii.
- **C7** `git show 94d05497:.planning/architecture/ADR-032-code-review-fallback.md` → ADR-032 (status accepted, 2026-10-15) with the quoted decisions.
- **C8** `git cat-file -e HEAD:.planning/architecture/ADR-032-code-review-fallback.md` → `fatal: path '.planning/architecture/ADR-032-code-review-fallback.md' does not exist in 'HEAD'`; `ls .planning/architecture` lists ADR-001…ADR-014 and later files but not ADR-032 (`head -20` shown).
- **C9** `git diff --stat main HEAD -- <code-review-core, phase-code-review, role-artifact, claude-role-host, codex-code-review-context, gate-trailer, deliver-dispatch, references/code-review.md, commands/deliver.md>` → 8 files changed, 1801 insertions, 8081 deletions; `phase-code-review.cjs` not listed. `git show main:plugins/delivery-pipeline/scripts/code-review-core.cjs | grep -n ROUND_CAP` → lines 6, 92, 237, 425; same for `role-artifact.cjs` → 7233, 7277.
- **C10** `git diff main HEAD -- plugins/delivery-pipeline/references/code-review.md` (4 hunks as in §4); `git show main:…/code-review.md | shasum -a 256` → `5d121a46cd1ef3aace419fe1b22e7a18d6ac366c8211846341bcf4705709e1b4`; `git show HEAD:…` → `0c96442cf5e03e12b33054c8e08a75250e9c93008461499160d462e44ce1f268`; `git log --oneline main..HEAD -- …/code-review.md` → `27c122c4`, `44fefbc4`, `8e4cf110`.
- **C11** `node -e` building `'arch-review=conform, drift-check=fresh, degenerate-green=clean, checks=green, base_tree=' + 40 chars` → length 128; the `skipped/skipped` variant → 132; `'code-review=round 4 of 3, extended by operator at 2026-11-02T10:00:00Z: reason'` → 78; `STATUS_MAX` is 140 (`gate-trailer.cjs:166`).
- **C12** isolated test runs: environment as in `tests/unit/run.sh:119-125` (private `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`, `XDG_*`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`), command `node tests/unit/<name>.test.cjs`, output to a private temp directory; results in §7.
- **C13** `ls /Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp/.planning` → `Operation not permitted`, exit 1.
- **C14** `ls -ld "$HOME/.local/state/shipyard" "$HOME/.local/state/shipyard/role-artifact-authority"` → refused by the permission layer (no approval surface); not executed.
- **C15** `node -e "console.log(Object.keys(require('./tests/unit/runtime-file-digests.json').files))"` → `claude-dispatch-adapter.cjs`, `runtime-adapters.cjs`; `node scripts/refresh-runtime-digests.cjs --check` → exit 0.
- **C16** `git ls-remote --tags origin 'v1.0.0*'` → `sandbox proxy: github.com:22: 403 user denied`; not retried.
- **C18** `Grep denyRead|permissions|sandbox|"deny"|settings\.json` over `scripts/{install-shipyard-claude-hook.sh,install-shipyard-capability.sh,ensure-gsd-core.sh,bootstrap-shipyard-plugin.cjs,shipyard-doctor.cjs}` → `shipyard-doctor.cjs:232`, `install-shipyard-claude-hook.sh:55` only; `Grep sandbox|denyRead|permission` over `README.md` → no matches; `Grep PreToolUse|PostToolUse|UserPromptSubmit|permissionDecision|"Stop"|"hooks"` over `plugins/delivery-pipeline` → `skills/delivery-rules/SKILL.md:95` only; `Read plugins/shipyard/hooks/hooks.json` → one SessionStart hook (`ensure-gsd-core.sh --launch-bootstrap`).
- **C19** `shasum -a 256 PROBLEM.md RESEARCH-CONTRACT.md DECISIONS.md` and `wc -c` in the investigation directory → digests and sizes as in the header, equal to the packet's `logical_source_obligations`.
- **C20** `Grep cyclic|source lineage|lineage.*bound|REVIEW_NATIVE_INVALID` over `tests/` (first 20 hits) → matches as stated in §7.
- **C17** `node -e` over `.planning/graph/tickets.json` → 282 tickets, 14 mention code-review/role-artifact files, all from phases 33-50 (none is a harness-simplification ticket); no in-flight edit of the cap files was found in the graph (**UNKNOWN** for unmerged work outside it).

---

## 15. OPEN-QUESTIONS seeds (for the orchestrator to merge)

- [ ] Which Shipyard build and `contract_digest` sealed the three pdffiller-mcp verdicts, and does the rc.2 build already report `rounds_used: 0` there? — owner: operator
- [ ] Does the operator's normal Claude Code / Codex session deny reads of `~/.local/state/shipyard/role-artifact-authority` and writes to `.planning/config.json`, or can the orchestrating model do both? — owner: operator
- [ ] Can the Bash tool of each supported host allocate a pseudo-terminal, and read or write a same-user 0600 scratch file in the user's home from the orchestrating session? — owner: maintainer (spike)
- [ ] Does a round-4 replay pass and a round-5 replay fail at the lineage bound `role-artifact.cjs:3190`, and is the failure a swallowed `answer_authenticated:false` (status) or a hard refusal (seal)? — owner: maintainer (spike)
- [ ] How must an older installed build behave when it reads a round-4 record (throw out of `priorCodeReviewVerdicts` vs skip on contract mismatch)? — owner: maintainer
- [ ] May the release that adds an extension edit `references/code-review.md` (and thereby reset every in-flight counter and re-owe every current verdict), or must the reference stay byte-identical to rc.2? — owner: operator
- [ ] Is the epic's own reference change already an accepted "retroactive unblock" for PRs sealed under `main`, given PROBLEM.md lists retroactive unblocking as out of scope? — owner: operator
- [ ] Should the status/comment/trailer carry operator-supplied free text (name, time, reason) given "fixed text and integer counts only", the 140-character status budget and PR-hygiene refusal of the whole comment? — owner: operator
- [ ] Is `.planning/config.json` inside the epic worktree in the target projects (so a reviewer child could write the exit)? — owner: maintainer
- [ ] Why did `tests/unit/role-artifact.test.cjs` exit 1 in the parallel baseline run on the epic tip (the other nine cap-related suites exited 0), and does it pass when run alone? — owner: maintainer (baseline not established by this line)
- [ ] Is the `code-review` status a required check in any target repository? — owner: operator
- [ ] Can a bot review fix or `base-merge.cjs` move a phase-PR head after the third verdict, and how often? — owner: maintainer
- [ ] Are the Phase 52 cost audits (three-round structural bound) normative for a five-round ceiling? — owner: maintainer
