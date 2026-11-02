# INV-021 — Line 3: constraints

- Investigation: INV-021-human-review-round-extension
- Line: `constraints` (feeds RESEARCH.md "Constraints" and CONSTRAINTS seeds)
- Source revision: `749604b9307ce21d7790f0a5b8f97920dca9aa7f` (branch `epic/harness-simplification`) — checked with `git rev-parse HEAD` [C1]
- Policy hash: `fc1706bc9272bd0f539fbd71fa966b736df15c2cadfc2a76a8b84924b33584b8`; exact policy signals (DATA, preserved): `{}`
- Selection given by the caller: claude-sonnet-5-5 / xhigh (not changed here)
- Date: 2026-11-02
- Status: completed, with two evidence sources unreachable (section 1). Nothing outside this file was written; no product code, `.planning/graph/`, authority directory or `~/.local/state/shipyard/` was modified. No design is chosen here.

Notation: `S` = `plugins/delivery-pipeline/scripts`, `T` = `tests/unit`. `[C#]` points to the command ledger in section 11. Where a claim rests on reading code rather than on running it, it says "by reading" and names the check that would run it.

---

## 1. Evidence access and gaps (read first)

Two evidence sources named in the research contract could not be read in this session. The session blocks reads outside the working directories (`permissions.blockReadsOutsideWorkingDirectories`) and has no approval surface, so both calls were denied by the harness and **not executed** [C47]:

| Source | Command attempted | Result | Consequence |
| --- | --- | --- | --- |
| Incident repo `/Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp` (branch `research/mcp-tools-ai-pdf-12908`, its `.planning/graph/`, `.shipyard-code-review-evidence.md`) | `ls -ld /Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp` | denied, not run | The incident (three-round cap hit) is taken from PROBLEM.md only; no incident record, status or verdict was examined. |
| `~/.local/state/shipyard/` incl. `role-artifact-authority/` | `ls -la ~/.local/state/shipyard/ ; ls -la ~/.local/state/shipyard/role-artifact-authority` | denied, not run | Live owner, mode and content of `hmac.key` and of the catalogue are NOT verified. Key properties below come from the code that creates and accepts the files (`S/role-artifact.cjs:921-1042`), which says what is required, not what is on this machine's disk. |

Observation (session-provided, not command-verified): the sandbox description given to this session lists `/Users/serhii/.local/state/shipyard/role-artifact-authority` under filesystem read `denyOnly`. Its origin is unknown (it is not set by any Shipyard script — see A4). It shows that at least this outer session is configured to keep its own Bash away from the authority directory. Next check: the operator inspects `~/.claude/settings.json` `sandbox.filesystem.denyRead` (owner: operator).

---

## 2. Findings that decide the most (short list)

1. **The cap is enforced at no fewer than eight independent places, not one.** Three launch/admission gates, one seal-time check, one result-normalisation check, one replay-depth bound, one status/trailer surface, and text in the reviewer reference (section 4). Changing only `nextRound` leaves a fourth round that is admitted but cannot be sealed or replayed.
2. **The replay-depth bound is tied to `ROUND_CAP` by value** (`S/role-artifact.cjs:3190`). By reading, a round-4 verdict whose carried-findings lineage is four deep fails replay, is recorded `answer_authenticated: false`, and is then never "current" for its head (`:3244-3250`, `:3398`). Replay and seal checks must therefore use an absolute ceiling, not the per-PR limit (T5, T6). Not executed; spike S1.
3. **Editing `references/code-review.md` resets every in-flight PR's round count.** Its digest is part of the contract digest; a verdict with another contract digest is skipped, so the review is "owed" with `rounds_used: 0` (`S/role-artifact.cjs:2875-2878`, `:3215-3216`, `:3403`; test `T/code-review-foreign-contract.test.cjs:34-35,88`). The reference currently says "Integer 1 through 3" (`:25`) and "No fourth review is owed" (`:51`). An edit to that file is a retroactive unblocking of every exhausted PR, which PROBLEM.md puts out of scope unless done by a human-written record (T9).
4. **"Only a human" has no enforcement primitive in the repository today.** No TTY or identity check guards any operator command (`isTTY` appears only in `S/repo-resolve.cjs:1736`, for an interactive prompt); `--confirm untrack-planning` is a public constant; the existing `report` exit is a plain edit of `.planning/config.json`; the runtime env markers are cleared by the project's own test runner. The only key isolation is a sandbox/permission profile applied to **launched role subagents** (A4, A5); it does not by itself cover the orchestrating session.
5. **The hold is advisory by ADR-032** ("visible, not enforced", a human can still merge), and no sentinel/merge code reads the code-review verdict (T13). "Human-only" therefore constrains the conveyor model's own behaviour, not the human.
6. **The gate trailer carries nothing about code review today** (T12). The only visibility surfaces that exist for code review are the `code-review` commit status (fixed text, 140-character GitHub cap) and the `<!-- code-review -->` PR comment (hygiene-filtered).
7. **Round arithmetic is history-derived.** `rounds_used` is recomputed from authenticated verdicts, not stored (`S/code-review-core.cjs:299-310`). A grant cannot be "consumed" by a flag, and a grant voided by a head move must not erase the round it already paid for (T7).
8. **Process constraints are light on docs, heavy on mirrors.** `docs-smoke.sh` does not mention code review; the runtime digest pin covers two unrelated adapter files; the generated Codex mirror under `plugins/shipyard/host/` is a straight copy that must be regenerated, not edited (D2-D4).

---

## 3. Constraint register

Each row: constraint, source, evidence, confidence. IDs are stable so OPTIONS.md/RISKS.md can cite them. Confidence: H = verified by reading/running as stated; M = inferred from code, not executed; L = assumption.

### 3.1 Hard technical constraints

| ID | Constraint | Source | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| T1 | `ROUND_CAP = 3` is one exported constant; `nextRound` returns `{round:null, state:'limit', rounds_used}` when `used >= ROUND_CAP`. It has no input for an extension. | `S/code-review-core.cjs:6`, `:338-340`, `:530` | [C2][C3] | H |
| T2 | Three callers compute the same decision independently and pass only `{priorVerdicts, head, isAncestor, mergeBase}`: status (`S/phase-code-review.cjs:154`), Claude host (`S/claude-role-host.cjs:612-613`), Codex context (`S/codex-code-review-context.cjs:148-149`). A grant must reach all three through one shared function or status will say `owed` where a host says `CODE_REVIEW_ROUND_LIMIT` (or the reverse). | same | [C9][C10] | H |
| T3 | `normalizeResult` refuses `round > ROUND_CAP` (`INVALID_RESULT`). It is reached through `normalizeFinal` at Claude seal (`S/claude-role-host.cjs:1202`), Codex seal (`S/codex-code-review-context.cjs:427`) and historical replay (`S/role-artifact.cjs:3049`). | `S/code-review-core.cjs:196` | [C3][C10] | H |
| T4 | Seal-time validation refuses `review_round > ROUND_CAP`. | `S/role-artifact.cjs:3146` | [C5] | H |
| T5 | Replay depth bound: `authenticatedCodeReviewRecord` fails with `REVIEW_NATIVE_INVALID` when `lineage.active.size >= ROUND_CAP`, checked **before** the memo lookup. Recursion: `replayCodeReviewRecord` → `authenticateCodeReviewAnswer` (`:3245`) → `authenticateCarriedCodeReviewFindings` (`:3045`, calling `:2938`), which requires the predecessor's `review_round === context.review_round - 1` (`:2937`). Chain for round N is N, N-1, …, 1; at entry to round 1 the active set holds N-1 entries, so the check fails exactly when N ≥ 4. The failure is swallowed at `:3244-3248` → `answer_authenticated:false`, `coverage_range:null` (`:3250`); `currentCodeReviewVerdict` then skips it (`:3398`) and `nextRound` will not inherit from it (`code-review-core.cjs:341`). Nuance: recursion only happens when carried prior findings exist at each level (`:2909` returns early on empty `prior`), so a round 4 after clean rounds may authenticate; a round 4 after three `needs-fix` rounds (the incident shape) would not. | `S/role-artifact.cjs:2908-2945`, `:3188-3199`, `:3244-3250`, `:3398` | [C5][C6] by reading; **not executed** → spike S1 | M |
| T6 | Because replay and seal are re-run on every `status` against history, they cannot depend on a per-PR grant that may later be consumed or voided. Both checks (T3, T4, T5) must compare against an absolute ceiling constant, while grant-dependence belongs only in launch admission (T2). | derived from T3-T5 and `S/phase-code-review.cjs:145-147,157-158` (status replays history each call) | [C4][C5] | M (design consequence of H facts) |
| T7 | Round arithmetic is history-derived: `countableVerdicts` counts complete verdicts whose head equals or is an ancestor of the current head and that are full-scope or delta with a known `prior_head`; `rounds_used = countable.length`. Consequences: (a) a grant cannot be consumed by a mutable flag — consumption is "a countable verdict beyond the 3rd exists"; (b) an **incomplete** review never counts (`:304`, reference `code-review.md:49-50`), so a grant must survive an incomplete launch; (c) if a grant is voided by a head move *and* limit is re-derived as `3 + valid grants`, the earlier paid round-4 verdict (still in history, `used = 4`) would require two valid grants for round 5, which the first (voided) grant can no longer supply — the limit formula must count consumed grants as permanent and void only unconsumed ones, with the ceiling applied to consumed + open. | `S/code-review-core.cjs:299-310`, `:338-346` | [C3] | H (a,b), M (c, arithmetic by reading) |
| T8 | Scope of an extended round is not guaranteed to be `delta`: `nextRound` returns `scope:'full'` whenever `coverageComplete` fails (`options.mergeBase !== undefined` and coverage unproven), and every complete full-scope verdict counts as a new lineage root. The proposal's "always a delta from the last counted verdict" must be enforced explicitly, not assumed. | `S/code-review-core.cjs:319-346`, `:299-310` | [C3] | H |
| T9 | **Contract digest.** `contractDigest = sha256(CONTRACT_ID + "\n" + sha256(references/code-review.md))`. `replayCodeReviewRecord` returns null for a verdict of another contract (`:3215-3216`); `currentCodeReviewVerdict` skips mismatches (`:3403`). Any byte change to the reference (including the round wording at `:25` and `:51`) or a new `CONTRACT_ID` makes every sealed verdict foreign, so every PR reads `rounds_used: 0`. Test: `T/code-review-foreign-contract.test.cjs:34-35` (appends a line to the reference), `:88` (`state:'owed'`, `rounds_used:0`). `T/judgment-contract.test.cjs:613-617` also pins reference field names. | `S/code-review-core.cjs:5,25,526`; `S/role-artifact.cjs:2875-2878,3009,3028,3215-3216,3403` | [C12][C13][C14] | H |
| T10 | Sealed manifest fields are compared exactly (`stable(codeReviewManifestFields(manifest)) !== stable(codeReviewManifestFields(data))`, `:3235-3240`; field list `:2831-2835`). Putting grant data **into** the sealed verdict changes the manifest/envelope shape that old verdicts must still satisfy → contract-adjacent change. Keeping the grant outside the sealed artifact avoids it. | `S/role-artifact.cjs:2831-2835,3235-3240` | [C5] | M |
| T11 | Repeated status text and one JSON schema depend on the cap: `round_cap: core.ROUND_CAP` in `shipyard.phase-code-review-status.v1` (`S/phase-code-review.cjs:130-132`), pinned `status.round_cap === 3` (`T/role-artifact.test.cjs:2287`); `statusDescription` throws for any state other than limit / owed-retry / current-pass / current-needs-fix (`:209-224`). No consumer of `round_cap`/`rounds_used` exists outside this script and tests [C10b]. Additive fields do not need a new schema id; a new record schema string would be a new contract id (D9). | `S/phase-code-review.cjs:130-132,209-224` | [C4][C10b] | H |
| T12 | **Gate trailer.** `gate_status` carries `arch-review`, `drift-check`, `degenerate-green`, `checks`, `head`, `base_tree` only (`S/gate-trailer.cjs:69-75`; closed/shaped vocabularies `:279-291`); a grep for `code-review|code_review` in that file finds only the `verifyCodeReview` call at `:384`. `readGate` reads the `merge-gate` status context (`:165,188`, `STATUS_MAX = 140`) and ignores `code-review` statuses (test `T/phase-code-review-publish.test.cjs:458-464`). The proposal's "gate trailer carries `round 4 of 3, extended by …`" would mean extending the trailer vocabulary and every reader, or it can only mean the `code-review` status description (≤140 characters on GitHub) and the PR comment. | `S/gate-trailer.cjs:69-75,165-166,279-291,384-386` | [C15] | H (what exists), M (what extending needs) |
| T13 | **Merge-time readers.** `sentinel.cjs` only exports `currentReviewAdmission` → `gate-trailer.verifyCurrentReviews` (architecture only, `S/sentinel.cjs:69-71`, `S/gate-trailer.cjs:203-239`); `front.cjs:1297` only maps role → ticket kind. The code-review hold is enforced by conveyor steps only: builder refusal for `arch-review` via `evaluateGate` (`S/deliver-dispatch.cjs:1211-1214`), `phase-code-review.cjs gate` before the integrator (`commands/deliver.md:1464-1472`), `gate-trailer.cjs verify` exit code (`S/gate-trailer.cjs:384-386`), and readiness/hand-off instructions (`commands/deliver.md:1664-1669`: "It is non-required: a human can still merge"). Nothing reads a grant today. | files cited | [C16][C17][C50] | H |
| T14 | **Replay/verdict history is per worktree key.** The authority directory is `~/.local/state/shipyard/role-artifact-authority/<sha256(realpath(worktree))>/` (`S/role-artifact.cjs:944-946`); history is aggregated from the worktree, `git worktree list` entries and the graph project root (`:3255-3259`, `:1377-1380`); a verdict only counts for the same `repositoryIdentity` = realpath of the git common dir (`S/architecture-target.cjs:80-90`). There is no per-PR, cross-worktree signed home: the HMAC key is per worktree. A grant needs a deliberate home: (a) the publication namespace (`~/.local/state/shipyard/code-review-publications/<sha256(repository,selector)>/<pr>.json`, 0600, uid-checked, **unsigned**, bounded 8192 bytes, `S/phase-code-review.cjs:306-368`), (b) a new signed file under the authority namespace, or (c) the planning config. | files cited | [C7][C4][C52] | H |
| T15 | **Key properties (by code).** `hmac.key` = 32 random bytes written 0600 via exclusive create + hard link (`:989-997`); namespace and per-worktree directories must have no group/other bits (`:938-940`, `:1012-1014`); `authorityFile` checks `mode & 0o077` and not-symlink/size but **not the owner uid** (`:948-951`; compare the publication state, which checks `stat.uid !== process.getuid()`, `S/phase-code-review.cjs:321,329,342`). The key is never re-created when protected records exist (`:999-1007`). Anything running as the same OS user, without a sandbox/permission profile denying the path, can read the key and compute valid MACs. Live disk state not verified (section 1). | `S/role-artifact.cjs:921-1042` | [C7][C8] | H (code), unverified (disk) |
| T16 | **No verdict-forgery path through requests.** The Claude role host rejects any request field outside its allowlist (`S/claude-role-host.cjs:96`, `reject('request field … is not permitted')`) and refuses host-derived signals (`:119`); the Codex launcher likewise refuses archive-authority paths in launch options (`S/codex-runtime-host.cjs:1115-1117`). A grant therefore cannot be smuggled in through a model-visible request field; it must be read by the trusted host itself during `prepare`. | `S/claude-role-host.cjs:88-120` | [C27] | M (read via grep context, not whole function) |
| T17 | **PR-text hygiene.** The `<!-- code-review -->` comment passes through `hygiene.internalLeakViolations('comment', body)` whenever `pr-hygiene.applies` (all repos except Shipyard itself); a hit **refuses the comment** (the status still posts). Rules: ticket id `T-NN-NN`, `Ticket:`, `Phase <n>`, `ADR-<n>`, `PLAN.md`, `ticket/`, `epic/`, `.planning/`, `.shipyard/`, `gate_status:`, and the words shipyard / gsd / conveyor. An operator-typed `--reason` and operator name rendered into the comment can trip these (for example a reason that says "Phase 9" or "ADR-032"). The status description is posted without hygiene (`:436-437`) and with no length check, and the pipeline doc says "The status uses fixed text and integer counts only" (`docs/gsd_multilevel_delivery_pipeline.md:640-642`). | `S/phase-code-review.cjs:447-455`; `S/pr-hygiene.cjs:210-222`, `:22-34` | [C4][C40][C48] | H |
| T18 | **Cap strings and pins.** Message `three rounds are spent…` is matched by `T/claude-role-host.test.cjs:2465` (`/three rounds/`), `T/phase-code-review.test.cjs:222` (`/three rounds.*delivery_pipeline.code_review.*report/`); status description `code review limit reached: no further review will run for this head` is pinned by `T/phase-code-review-publish.test.cjs:212`; error code `CODE_REVIEW_ROUND_LIMIT` by `T/codex-code-review-context.test.cjs:252,1090-1091`. Any rewording is a test change. | files cited | [C38] | H |
| T19 | **Pre-existing cap resets (not created by an extension).** (a) `countableVerdicts` counts only verdicts whose head is an ancestor of (or equal to) the current head, so a rebase/force-push of the PR branch gives `rounds_used` back to 0 (pinned by `T/code-review-core.test.cjs:179`: `isAncestor: () => false` → `round 1`). (b) A fresh clone has a different `repositoryIdentity` and its own authority directory; whether it sees any history depends on `git worktree list` and the graph project root (`S/role-artifact.cjs:3255-3259`). (a) is verified by code and test; (b) is inferred. | `S/code-review-core.cjs:299-310`; `T/code-review-core.test.cjs:179` | [C3][C38][C52] | H (a), M (b) → spike S3 |

### 3.2 Authority constraints ("what makes it human-only")

| ID | Finding | Source | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| A1 | No operator-vs-model discrimination exists in any script. `isTTY` appears once, in `S/repo-resolve.cjs:1736`, to choose an interactive prompt (`!options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY`). The runtime markers `CLAUDE_PLUGIN_ROOT` / `CLAUDE_CODE_ENTRYPOINT` / `CODEX_SANDBOX*` identify the **runtime** (`S/runtime-context.cjs:95,215`; `S/ci-wait.cjs:144-145`), not who is typing, and are set for model-spawned commands too. They are trivially cleared: the project's own unit runner does `unset CLAUDE_PLUGIN_ROOT CLAUDE_CODE_ENTRYPOINT CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED` (`tests/unit/run.sh:10`, found with `grep -n "^unset " tests/unit/run.sh`) and the baseline test commands in this artifact used `env -u …` [C39]. A TTY test is likewise not proof of a human: a same-user process can allocate a pseudo-terminal (OS-level fact, **assumption** in this repo; spike S2). | files cited | [C21][C22][C39] | H (repo facts), L (pty bypass) |
| A2 | `planning-untrack.cjs --apply --confirm untrack-planning` is the cited model. Its guard is `confirm === CONFIRM_TOKEN` where the token is a source constant (`:10`, used at `:73`) printed in `README.md:538`; other checks are repository applicability, clean worktree, non-default branch, tracked `.planning` (`:72-82`). No secret, no TTY, no identity. It proves intent to the model that reads the README, not a human. | `S/planning-untrack.cjs:10,72-82`; `README.md:537-538` | [C20][C36] | H |
| A3 | **The existing `report` exit is not human-gated.** It is `delivery_pipeline.code_review: report` in the project root's `.planning/config.json`, a plain JSON file read by `loadConfig` with no integrity check (`S/phase-code-review.cjs:58-71`, `S/pipeline-config.cjs:536,1100-1103`). In this repo the file is git-tracked (`git ls-files .planning/config.json` lists it; `git check-ignore -v` exit 1 = not ignored) [C28]; in target projects it is usually untracked. Any process with write access, including the model's Edit/Write tools, can set it. So a signed extension is stronger than the status quo in one respect (forging needs the key) but the stronger exit coexists with an unguarded one: unless `report` is also hardened, "only a human may permit" is a property of the new path, not of the system. | files cited | [C28][C29] | H (facts), interpretation is the investigator's |
| A4 | **The only key isolation in the repo applies to launched role subagents.** Claude role launch passes `--settings` with `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands:false`, `filesystem.denyRead/denyWrite:[archiveAuthority]`, `allowWrite:[worktree]`, `permissions.blockReadsOutsideWorkingDirectories:true`, and deny rules for Read/Edit/Write/Glob/Grep on the authority glob, plus `--restricted --permission-mode dontAsk --permission-prompts none --setting-sources ''` (`S/claude-runtime-host.cjs:748-790`). Codex role launch adds `archiveAuthorityNamespace(true)` to `hostProtectedPaths` (`S/codex-runtime-host.cjs:1109-1110`) and denies those paths in the permission profile (`signerPermissionProfileArgs`, `:1079-1094`; it also protects `~/.gnupg`, `~/.ssh`, `SSH_AUTH_SOCK`, the git signing key, `:1051-1064`; `SIGNER_ISOLATION_UNAVAILABLE` when no paths resolve, `:1084`). A repo-wide search finds `denyRead`/`archiveAuthorityNamespace` only in these two hosts and in `role-artifact.cjs` [C25]: **no installer, hook or doc configures the orchestrating session's own sandbox** to deny the authority directory. | files cited | [C23][C24][C25] | H |
| A5 | **The party a "model cannot consent for itself" rule must stop is the orchestrating session**, which runs `phase-code-review.cjs`, `deliver-dispatch.cjs`, `gate-trailer.cjs` through Bash as the user (`commands/deliver.md:1404-1405,1441-1442,1468`). Whether that session can read `hmac.key` or write a record depends on the user's own Claude Code / Codex sandbox and permissions, not on Shipyard (A4). Separately, a reviewer subagent inside a role launch has `Bash,Read,Edit,Write,Glob,Grep` (`S/claude-runtime-host.cjs:34`), so it can run `node …/phase-code-review.cjs extend …`; what stops it from forging is only its sandbox (key unreadable, writes limited to the worktree), **and only if the grant is signed with the key or stored outside the worktree**. A grant kept in the worktree or in config is writable by it. There is no env marker or flag that says "called from inside a role launch" other than the sandbox denial itself; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and a credential-env deny list are set (`S/claude-runtime-host.cjs:85,37-42,757`). "Refused when the model calls it through a role host" has no existing mechanism to extend: no role-host path invokes `phase-code-review.cjs`, and the module exports no operator verb [C46]. | files cited | [C17][C23][C46] | M-H (not tested on a live session) |
| A6 | **GitHub-side human authority has one precedent and one limit.** `reviewers.cjs` defines a verified human head approval: review state `APPROVED`, `commit_id === headSha`, `user.type === 'User'`, login ≠ PR author, not a bot (`S/reviewers.cjs:138-144`). The conveyor runs `gh` as the operator's own account, so a `gh`-mediated action is indistinguishable from the model's; the approval predicate is only meaningful when a second account approves. ADR-032 lists "the human `APPROVED` fallback" as withdrawn on 2026-10-15 (Out of scope) with a re-open condition ("if measured late-found defects justify them"). | `S/reviewers.cjs:138-144`; ADR-032 | [C42][C18] | H |
| A7 | **Visibility of the decision to the merging human is available only where code review already writes**: the `code-review` status (`description`, ≤140 characters, fixed text by doc) and the PR comment (header `Code review — round N, scope S`, footer `Operator exit: …`, `S/phase-code-review.cjs:271-275`). The operator merges a PR in GitHub; nothing in the merge path (T13) reads an extension. | `S/phase-code-review.cjs:209-224,269-298` | [C4] | H |

### 3.3 Product constraints (flows that must not change)

| ID | Constraint | Source | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| P1 | `report` stays "runs and seals, holds nothing"; `hold` is the shipped default; the mode enum is exactly `report | hold` and unknown values fall back to `hold` with a warning. An extension must not add a mode or change what `report` means. | `S/pipeline-config.cjs:536,1100-1103`; `capabilities/delivery-pipeline/capability.json:51-54`; `docs/gsd_multilevel_delivery_pipeline.md:648-656` | [C29][C30][C48] | H |
| P2 | A human can always merge; the guarantee is "visible, not enforced"; no required status check or branch protection is assumed. | ADR-032 Decision; `commands/deliver.md:1664-1669` | [C18][C17] | H |
| P3 | Exact-head binding: a verdict is never carried across a moved head; any push re-owes code review; `currentCodeReviewVerdict` requires the exact head/base, a clean product tree and the planning association (`S/role-artifact.cjs:3316-3343,3398-3411`). A round-4 verdict must follow the same rules; `status` already reports `current` for the exact head even when `rounds_used` exceeds the cap (the `current` branch precedes the `limit` branch, `S/phase-code-review.cjs:165-175`). | files cited | [C4][C5] | H |
| P4 | Only the trusted host writes to GitHub: "The model never writes either to GitHub" (`commands/deliver.md:1448-1449`); at `limit`, `publish` posts status only and skips the comment (`S/phase-code-review.cjs:443-446`); the status is posted before comment hygiene so a refused comment cannot remove the verdict status (docs `:640-642`). | files cited | [C17][C4][C48] | H |
| P5 | The builder and both hosts refuse a launch at `limit` before any side effect (`S/claude-role-host.cjs:613`, `S/codex-code-review-context.cjs:149`); `commands/deliver.md:1411-1412` says "never launch after `limit`". An extended round must be admitted by the same `prepare` step on both runtimes, or one runtime would be stuck. | files cited | [C9][C17] | H |
| P6 | Fixed by PROBLEM.md: `ROUND_CAP` stays 3; `repairAllowed` stays rounds 1-2 only (`S/code-review-core.cjs:347`; status maps a needs-fix at round ≥ 3 to `repair:'human'`, `S/phase-code-review.cjs:169`; `fixTickets` prints the refusal text for `human`, `:201-202`); other roles' limits untouched; already-exhausted PRs are unblocked only by a new human-written record. **No code change is needed for "extended-round findings go to the human"**: `repairAllowed(4)` is already false. | PROBLEM.md; files cited | [C3][C4] | H |
| P7 | Operator-facing wording of the single exit exists in six places that a design would have to keep consistent: `S/phase-code-review.cjs:88-89` (refusal), `:275` (footer), `:181`/`:215` (limit reason/status), `S/deliver-dispatch.cjs:1209`, `commands/deliver.md:41-42,1385,1456-1458`, `capabilities/delivery-pipeline/capability.json:54`, `docs/gsd_multilevel_delivery_pipeline.md:648-656`. "no override flag/waiver record" appears in five of them. | grep | [C30][C31] | H |

### 3.4 Delivery constraints

| ID | Constraint | Source | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| D1 | Source base is `epic/harness-simplification` at `749604b9`; ADR-032 is **not** in the epic's `.planning/architecture/` (only `ADR-030-…` matches `ADR-03*`) but is readable from history (`git cat-file -t 94d05497` → `commit`). ADR amendments are appended as dated, operator-selected bullets inside the same ADR (ADR-032 itself carries "Release repair amendment (2026-10-22, operator selected)"). Writing an accepted ADR is outside this investigation. | ADR-032 at `94d05497`; `.planning/architecture/` listing | [C18][C19] | H |
| D2 | **Generated Codex package.** `plugins/shipyard/host/plugins/delivery-pipeline/**` is a recursive copy of `plugins/delivery-pipeline` made by `scripts/package-shipyard-codex.cjs:19-22`; it is tracked in git and currently byte-identical for `phase-code-review.cjs` (`git diff --stat --no-index …` exit 0). It must never be edited directly (CLAUDE.md "Editing rules"); source changes need `make package-shipyard-codex`, which rewrites `plugins/shipyard/package-build.json` (digest + version). CI skips the staleness check for ticket PRs into `epic/*`; it is enforced on the epic → `main` PR; CLAUDE.md says the package tests compare the build with the committed mirror (the named `T/package-compare.test.cjs` exercises `comparePackage` on fixtures; which test compares the real mirror was not identified here). Shared scripts (`phase-code-review.cjs`, `code-review-core.cjs`, `role-artifact.cjs`, both hosts) run unchanged on both runtimes, so one source edit covers Claude and Codex; the Codex-only surface is `S/codex-code-review-context.cjs` and `S/codex-runtime-host.cjs`. | CLAUDE.md; `scripts/package-shipyard-codex.cjs` | [C32] | H |
| D3 | **Runtime-file digest pin.** `T/runtime-file-digests.json` pins exactly two files: `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs` and `…/runtime-adapters.cjs`. The pin changes only through `make refresh-runtime-digests` and its printed `Runtime-Digest-Refresh:` trailer (`scripts/refresh-runtime-digests.cjs`; `scripts/check-runtime-digest-trailer.cjs`). A design confined to `phase-code-review.cjs`, `code-review-core.cjs`, `role-artifact.cjs`, the two review hosts/contexts, `deliver.md` and the references does **not** touch the pin; one that edits either adapter does. | files cited | [C33] | H |
| D4 | **Docs contract (`tests/smoke/docs-smoke.sh`).** It checks: README names `/shipyard:<cmd>` and `$shipyard:shipyard-<cmd>` for each command in `plugin.json` (five: route, investigate, decompose, deliver, bench); README names the host entries (`claude-*-host.cjs`, `codex-*-host.cjs`) and each exists; every `make <target>` in README exists; the Launch-and-upgrade wording; CI wording. A search for `phase-code-review|planning-untrack|code-review|digest` in it returns nothing. A new **sub-verb** of `phase-code-review.cjs` does not touch it; a new plugin command, a new `*-host.cjs` (must be classified in `T/host-entry-contract.test.cjs:43`), or a new make target would. README documents one operator CLI (`planning-untrack.cjs`, `README.md:537-538`); CLAUDE.md requires README updates when the supported command flow changes. `T/command-script-references.test.cjs:19` requires every script named in a command file to exist. | files cited | [C34][C35][C36][C37] | H |
| D5 | Tests: "When adding a rule, add a focused unit or fixture test with it" (CLAUDE.md). CI (`.github/workflows/test.yml`): sharded unit job, a gates-and-smoke job running `make test-fast-rest`, an aggregate `test-fast` job; Node 24.15.0 pinned; `make test-comment-policy` runs `publish-gate.cjs` against `origin/main` (Makefile:109-110), so new source comments must satisfy `comment-policy.cjs` (history-style words such as todo/fixme/workaround/legacy/previously/because, ticket-style tokens, `#123`, `ADR-123` match its `HISTORY_PATTERN`; markers are `@invariant:`, `@security:`, `@contract:`, ≤120 characters; how a match is enforced was not read in full). Runtime cost: `T/phase-code-review.test.cjs` took 439 s here (68 tests); `T/code-review-core.test.cjs` 0.4 s [C39] — new fixtures belong where they are cheap. | CLAUDE.md; Makefile; workflow; `S/comment-policy.cjs:11-16` | [C41][C45][C39] | H (policy header read; enforcement mechanics not read in full → M for exact rule set) |
| D6 | Commit/PR shape on this epic: subjects are `HS-NN: <Ukrainian summary> (#PR)`; the latest is `RC2-final: версія 1.0.0-rc.2 (нетто 0) (#651)`. The "нетто 0" suffix suggests net-line-count accounting for the simplification direction; its exact rule is not written anywhere in the repo (D7). | `git log` | [C44] | H (subjects), L (meaning of "нетто 0") |
| D7 | The simplification direction (2026-10-27: smaller harness, no new contract ids, each change removes more than it adds) is stated only in this investigation's PROBLEM.md, DECISIONS.md and RESEARCH-CONTRACT.md; `grep -rIl "2026-10-27"` outside INV-021 finds nothing [C53]. Treated as a binding operator constraint (DECISIONS.md), but its measurement ("net lines"? per PR? per release?) is undefined. | investigation files | [C53] | M |
| D8 | ADR-014 boundary: this work changes no model policy. An extended round is still a routed `code-review` launch that must pass resolve → validate → launch → receipt on its runtime; the policy has no round-based signal (`code-review` signals: only explicit `critical`/`checkpoint`), so round 4 runs at the base rung (Claude Sonnet/xhigh, Codex Sol/high) unless explicitly critical. The extension command itself launches nothing. | policy packet; CLAUDE.md | context packet (`signal_rules.code-review`) | H |
| D9 | "No new contract ids" (D7) bites in three places: a new `CONTRACT_ID` (T9) would void every verdict; a new record schema string for a grant (precedents: `shipyard.code-review-publication.v1`, `shipyard.role-archive-catalogue.v1`) is a new id; extending `shipyard.phase-code-review-status.v1` additively is not. | files cited | [C14][C4] | M |
| D10 | Investigation-process fences: no tickets, PRs, commits or edits to target repos; do not close Gate 1; do not write an accepted ADR; leave design questions open; pdffiller-mcp is read-only evidence only. | PROBLEM.md; RESEARCH-CONTRACT.md | context packet | H |

---

## 4. Where the cap is enforced — what breaks if a fourth or fifth round existed

Command for the inventory: `grep -rn "ROUND_CAP\|CODE_REVIEW_ROUND_LIMIT" . --exclude-dir=.planning` [C2], plus the caller search [C10]. The generated copy under `plugins/shipyard/host/` repeats every hit and is regenerated, not edited.

| # | Place | What happens at round 4 as written | Pin / test |
| --- | --- | --- | --- |
| 1 | `S/code-review-core.cjs:340` `nextRound` | `state:'limit'` once 3 countable verdicts exist | `T/code-review-core.test.cjs:170-171,357-371`; `T/role-artifact.test.cjs:1952-1953`; `T/phase-code-review.test.cjs:193,210,220` |
| 2 | `S/code-review-core.cjs:196` `normalizeResult` | `INVALID_RESULT` for `round > 3` at Claude seal (`S/claude-role-host.cjs:1202`), Codex seal (`S/codex-code-review-context.cjs:427`), replay (`S/role-artifact.cjs:3049`) | indirectly by every seal test |
| 3 | `S/role-artifact.cjs:3146` | seal-time `review_round > ROUND_CAP` → `INVALID_RESULT` | role-artifact seal tests |
| 4 | `S/role-artifact.cjs:3190` | replay depth: round-4 lineage fails at entry to round 1 (T5); verdict becomes unauthenticated, never current | none (no 4-round fixture exists) |
| 5 | `S/claude-role-host.cjs:612-613` | `reject('three rounds are spent; …', 'CODE_REVIEW_ROUND_LIMIT')` | `T/claude-role-host.test.cjs:2435-2465` ("refuse a fourth launch") |
| 6 | `S/codex-code-review-context.cjs:148-149` | `fail('three countable reviews have already run', 'CODE_REVIEW_ROUND_LIMIT')` | `T/codex-code-review-context.test.cjs:243-252,1089-1091` |
| 7 | `S/phase-code-review.cjs` | `round_cap` (`:132`), limit reason (`:181`), `statusDescription` limit text (`:214-215`), `repair:'human'` for round ≥ 3 (`:169`), refusal text (`:87-90`), comment footer (`:275`), `fixTickets` stderr (`:201-202`); `findingsComment` header has no "of N" today (`:271`) | `T/phase-code-review.test.cjs:222,375`; `T/phase-code-review-publish.test.cjs:212`; `T/role-artifact.test.cjs:2287` |
| 8 | `S/deliver-dispatch.cjs:1209` | duplicate refusal sentence for non-epic PRs (names `report`, "no override flag and no waiver record") | `T/phase-code-review.test.cjs:375` (regex on stderr) |
| 9 | `references/code-review.md:25,51` and `commands/deliver.md:41-42,1385,1412,1450-1458,1664-1669`, `docs/gsd_multilevel_delivery_pipeline.md:648-656`, `docs/audits/phase52/arch-review-cost.md:152`, `…/packet-limits.md:178,196` | prose says three rounds / no fourth / single exit. The reference is contract-bearing (T9); the others are prose (the audits are dated records) | `T/judgment-contract.test.cjs:613-617` (field names only) |

Not affected by a larger cap (checked): `countableVerdicts` (no cap use), `lineageComplete`, `coverageComplete` (recursive but bounded by history, `S/code-review-core.cjs:311-337`), `carryPriorFindings` and the partitioning/budget code (`PART_BUDGET`). The host-side `registeredPhaseWorktrees` bound (1000 worktrees/records, `S/role-artifact.cjs:2886,2900,3259,3269`) is independent of rounds.

What the trailer currently carries for code review: **nothing** (T12). The only code-review surfaces on the PR are the `code-review` commit status and the `<!-- code-review -->` comment (A7).

---

## 5. Tests that pin the cap, and baseline

Files named in the contract and what they pin (line numbers from [C38]):

| File | Pins |
| --- | --- |
| `T/code-review-core.test.cjs` | `nextRound` yields round n+1 and `null` at 3 (`:167-179`); round arithmetic across expanding and non-expanding bases (`:352-371`, `limit` at `:368`); rebase/ancestry reset (`:179`) |
| `T/phase-code-review.test.cjs` | `state:'limit'` with `rounds_used:3` and `round:null` (`:220`, `:418-419`, `:465`, `:718`); limit message regex (`:222`); `repair: round < 3 ? 'tickets' : 'human'` (`:193`); gate/builder refusal text including the `report` exit (`:222-226`, `:375`) |
| `T/phase-code-review-publish.test.cjs` | limit status description text (`:212`); reader enumeration (`:430`) and `readGate` ignoring a pending `code-review` status beside `merge-gate` (`:458-464`) |
| `T/role-artifact.test.cjs` | `next.round === (round===3 ? null : round+1)` and `state:'limit'` at 3 (`:1952-1953`); `status.round_cap === 3` (`:2287`) |
| `T/claude-role-host.test.cjs` | "code-review rounds 2 and 3 authenticate previous sealed archives and refuse a fourth launch" (`:2435`), `CODE_REVIEW_ROUND_LIMIT` + `/three rounds/` (`:2465`) |
| `T/codex-code-review-context.test.cjs` | "rounds two and three admit their exact sealed archives and fourth refuses before launch" (`:243`, `:252`); limit status and `gate().ok === false` (`:1089-1091`) |
| `T/code-review-foreign-contract.test.cjs` | an edited reference makes prior verdicts foreign: `rounds_used:0`, `owed` (`:34-35`, `:52`, `:88`) |

No fixture exists for a round 4 on any path; the replay-depth behaviour (T5) is therefore untested today.

Baseline run (this worktree, source revision above, HOME redirected to a temp directory, runtime env markers unset) [C39]:

| Command | Exit | Result |
| --- | --- | --- |
| `env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_CODE_ENTRYPOINT -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED HOME=<tmp> node tests/unit/code-review-core.test.cjs` | 0 | 26 tests, 26 pass, 0 fail, 417 ms |
| same, `tests/unit/phase-code-review.test.cjs` | 0 | 68 tests, 68 pass, 0 fail, 439,138 ms |

**Not run**: `role-artifact.test.cjs`, `claude-role-host.test.cjs`, `codex-code-review-context.test.cjs`, `phase-code-review-publish.test.cjs`, `docs-smoke.sh`, `make test-fast`, and the package-compare tests — time. Their current status at this revision is unverified here.

---

## 6. What a new command / state would touch (delivery checklist, not a design)

Derived only from D2-D5, T2, T6, T14, T17. A design that adds an `extend` verb to `phase-code-review.cjs` and a record would, at minimum, touch:

1. Source (shared by both runtimes): `S/code-review-core.cjs` (limit input, ceiling constant), `S/phase-code-review.cjs` (CLI table at `:508-535`: today only `status|gate|fix-tickets|publish`, with a fixed flag table and `--phase`/`--pr` mandatory; refusal text; status; comment/status description), `S/role-artifact.cjs` (`:3146`, `:3190`, and the grant reader if signed), `S/claude-role-host.cjs:612-613` and `S/codex-code-review-context.cjs:148-149`, `S/deliver-dispatch.cjs:1209` (text).
2. Prose/contract: `commands/deliver.md` (five spots), `capabilities/delivery-pipeline/capability.json:54`, `docs/gsd_multilevel_delivery_pipeline.md`, README (operator CLI, by analogy with `planning-untrack`), and — only if the reviewer must be told about round 4 — `references/code-review.md`, which carries the T9 reset consequence.
3. Generated: `make package-shipyard-codex` (mirror + `package-build.json`).
4. Not touched unless the design says so: the runtime-digest pin (D3), `docs-smoke.sh` (D4), `host-entry-contract` (needs a `*-host.cjs`), model policy (D8).
5. Tests: update the pins in section 5 that assert text/limits; add a round-4 fixture (no-grant → still limit; grant for another head/base/PR → ignored; ceiling not bypassable by several records; unauthenticated caller refused) in the cheap file (`code-review-core`) where the logic allows, and one end-to-end fixture in the slow file.

---

## 7. Compatibility with both runtimes

- Shared scripts are loaded by both hosts, so cap logic added to `code-review-core.cjs` / `role-artifact.cjs` is automatically common; the only per-runtime enforcement points are T2 rows 5 and 6 (`claude-role-host.cjs`, `codex-code-review-context.cjs`), which must read the same grant source.
- Isolation of the authority directory is configured per runtime in two different places (A4): Claude `--settings` JSON, Codex permission-profile config. A grant stored under the authority namespace inherits both protections for role launches; a grant stored elsewhere (publication namespace, config, worktree) inherits neither and needs its own protection on each runtime.
- Both hosts already treat the authority namespace as host-owned and refuse request fields naming it (`S/codex-runtime-host.cjs:1115-1117`; Claude allowlist, T16).
- Claude Code's Bash tool and the Codex sandbox differ in how they sandbox the *orchestrating* session; Shipyard configures neither (A4/A5). The Definition-of-done clause "holds on both runtimes" therefore depends on a per-runtime fact the repository does not control.

---

## 8. Unknowns (each mirrored as an open question in section 9)

| ID | Unknown | Why it matters | Next check |
| --- | --- | --- | --- |
| U1 | Live owner/mode/contents layout of `~/.local/state/shipyard/role-artifact-authority/` and whether the orchestrating session's sandbox denies it by default | Decides whether a signed record is out of the model's reach in practice | operator runs `ls -la` on it from a plain terminal; spike S2 |
| U2 | Whether a 4-deep carried-findings lineage really fails replay and what `status` then shows | Decides how much of `role-artifact.cjs` must change (T5) | spike S1 |
| U3 | Whether a fresh clone/second worktree resets the countable history | A pre-existing bypass of the cap that no extension record would govern (T19b) | spike S3 |
| U4 | Whether a role-launched reviewer's Bash can write a record kept in the worktree or run an operator verb | Decides if "refused through a role host" needs more than the sandbox (A5) | spike S2 |
| U5 | Whether a model needs the reference text changed to review "round 4" (the host supplies `review_round`; the reference says 1 through 3 and "No fourth review is owed") | If yes, the edit voids all verdicts (T9) and must be sequenced | spike S4 |
| U6 | Exact accepted form of "net 0 / removes more than it adds" (D6, D7) | Decides what "smaller" means for acceptance | operator |
| U7 | Whether the operator accepts that `report` stays unguarded (A3) while the extension is guarded | Defines what "only a human" claims | operator |
| U8 | Whether the incident counts as "measured late-found defects" that ADR-032 sets as the condition to re-open withdrawn items (waiver store, human `APPROVED` fallback) | ADR amendment wording | operator |
| U9 | Incident facts (what the three rounds found, whether the PR head moved afterwards) | Sizes the real need; not reachable here (section 1) | operator or a session with access |
| U10 | Whether the `code-review` status can carry any operator/reason text given the "fixed text and integer counts only" rule and the 140-character cap | Visibility design (T12, T17) | owner of the status contract |

Recommended spikes (not run; this line does not execute throwaway code):

- `/gsd-spike "INV-021 S1: build a four-round needs-fix lineage fixture and observe authenticatedCodeReviewRecord / status at round 4"`
- `/gsd-spike "INV-021 S2: from a default Claude Code and a default Codex orchestrating session, can Bash read hmac.key, write a signed record, or open a pty to satisfy a TTY check"`
- `/gsd-spike "INV-021 S3: does a fresh clone or an unregistered worktree of the same PR branch see zero countable verdicts"`
- `/gsd-spike "INV-021 S4: does a round-4 reviewer packet need the reference text changed, or does the host-supplied review_round suffice"`

---

## 9. Seeds for OPEN-QUESTIONS.md

- [ ] Do we accept that the existing `report` exit (a plain `.planning/config.json` edit) stays model-writable while only the new extension is guarded, or must `report` be hardened in the same change? — owner: operator
- [ ] Is a same-user, convention-level "human-only" (CLI refuses unless the caller proves something the orchestrating model cannot cheaply produce) acceptable for the extension, given the hold is already advisory and a human can merge anyway (ADR-032)? — owner: operator
- [ ] Where may a grant live: under the authority namespace (per-worktree key), the publication namespace (unsigned, per repository+PR), or elsewhere, given T14 (key is per worktree, no per-PR signed home)? — owner: maintainer
- [ ] Which surface carries "round N of 3, extended by …": the `code-review` status (≤140 characters, documented as fixed text), the PR comment (hygiene-filtered), or a trailer change (new vocabulary in every reader)? — owner: maintainer
- [ ] May the reviewer reference (`references/code-review.md`) be edited for this change given that any edit voids every in-flight verdict (T9), or must the change leave it byte-identical? — owner: maintainer
- [ ] What measurable rule defines "removes more than it adds" for this change (net lines per PR, per release, including tests and prose)? — owner: operator
- [ ] Does the incident (three rounds exhausted on `research/mcp-tools-ai-pdf-12908`) meet ADR-032's re-open condition for the withdrawn waiver store / human `APPROVED` fallback? — owner: operator
- [ ] Does a fresh clone or unregistered worktree reset the countable round history today (pre-existing cap bypass)? — owner: maintainer (spike S3)
- [ ] Does a four-deep needs-fix lineage fail replay at `role-artifact.cjs:3190` and leave the round-4 verdict never current? — owner: maintainer (spike S1)
- [ ] What are the incident facts (findings per round, head movement, who held the PR) that the pdffiller-mcp evidence would show? — owner: operator (not reachable from this session)

---

## 10. Seed lines for CONSTRAINTS.md (one line each, source + confidence)

1. Every round-limit check (admission ×3, seal, normalisation, replay depth) is wired to `ROUND_CAP`; replay and seal must use a ceiling, only admission may read a grant — `S/code-review-core.cjs:196,340`, `S/role-artifact.cjs:3146,3190`, hosts — M-H.
2. Round count is history-derived; consumption is "a countable verdict beyond 3 exists"; incomplete reviews never count; consumed grants stay, unconsumed ones may void — `S/code-review-core.cjs:299-346` — H/M.
3. The extended round's scope must be forced to `delta`; `nextRound` can return `full` — `S/code-review-core.cjs:319-346` — H.
4. `repairAllowed` already excludes round ≥ 3 → findings go to the human with no change — `S/code-review-core.cjs:347`, `S/phase-code-review.cjs:169` — H.
5. Editing `references/code-review.md` or `CONTRACT_ID` resets all round counts; no edit without an explicit transition — `S/role-artifact.cjs:2875-2878,3215-3216` — H.
6. The trailer carries no code-review data; the `code-review` status is fixed-text, ≤140 characters; the comment is hygiene-filtered (no ticket/phase/ADR ids, `.planning/`, `epic/`, shipyard/gsd/conveyor) — `S/gate-trailer.cjs:69-75`, `S/pr-hygiene.cjs:210-222` — H.
7. No existing check distinguishes a human from the model (no TTY/identity check; public confirm token; clearable env markers; unguarded `report` edit) — `S/planning-untrack.cjs:10`, `S/repo-resolve.cjs:1736`, `tests/unit/run.sh:10` — H.
8. Key isolation exists only for launched role subagents (Claude `--settings` denyRead, Codex permission profile); the orchestrating session's isolation is the user's configuration — `S/claude-runtime-host.cjs:748-790`, `S/codex-runtime-host.cjs:1109-1110,1079-1094` — H (code) / unverified (live).
9. The HMAC key is per worktree and same-user readable; there is no per-PR signed home — `S/role-artifact.cjs:944-946,948-951,989-997` — H.
10. The hold is advisory (human can merge); no merge-time reader looks at code review — ADR-032; `S/sentinel.cjs:69-71` — H.
11. Edit the shared source only; regenerate `plugins/shipyard/` with `make package-shipyard-codex`; the digest pin (two adapter files) and `docs-smoke.sh` are untouched by a change confined to the review scripts and `deliver.md` — CLAUDE.md; `scripts/package-shipyard-codex.cjs`; `T/runtime-file-digests.json` — H.
12. Simplification: no new contract id (no new `CONTRACT_ID` or record schema string if avoidable), each change removes more than it adds; the rule is stated only in INV-021 files — DECISIONS.md — M.
13. Amending ADR-032 is required if any extension is adopted; "waiver store" and "human `APPROVED` fallback" are in its Out-of-scope list — ADR-032 — H.

---

## 11. Command ledger

Method note: the investigation tools were Bash and the Read/Grep tools. Bash commands are exact; Read/Grep calls are listed with the shell command that returns the same lines. Equivalents were not re-run unless marked "ran". `S=plugins/delivery-pipeline/scripts`, `T=tests/unit`.

| # | Command (exact or equivalent) | Mode | Outcome used above |
| --- | --- | --- | --- |
| C1 | `git rev-parse HEAD` | ran | `749604b9307ce21d7790f0a5b8f97920dca9aa7f` |
| C2 | `grep -rn "ROUND_CAP\|CODE_REVIEW_ROUND_LIMIT" . --exclude-dir=.planning` | Grep tool | hits in `S/code-review-core.cjs:6,196,340,530`, `S/role-artifact.cjs:3146,3190`, `S/claude-role-host.cjs:613`, `S/codex-code-review-context.cjs:149`, `S/phase-code-review.cjs:132`, mirrors, tests |
| C3 | `sed -n 180,350p $S/code-review-core.cjs` | Read tool | `normalizeResult`, `countableVerdicts`, `coverageComplete`, `nextRound`, `repairAllowed` |
| C4 | `cat -n $S/phase-code-review.cjs` (whole file, 541 lines) | Read tool | status, refusal, gate, publish, comment, CLI table |
| C5 | `sed -n 2825,2955p`, `sed -n 3090,3430p`, `sed -n 3455,3480p $S/role-artifact.cjs` | Read tool | seal check, replay, lineage, current verdict |
| C6 | `grep -n "codeReviewReplayState\|lineage\b\|lineage\.\|HISTORICAL_CODE_REVIEW_REPLAY\|authenticatedCodeReviewRecord\|priorCodeReviewVerdicts\|review_round\|countableVerdicts\|nextRound" $S/role-artifact.cjs` | ran | lines 2832, 2849, 2880, 2912, 2937-2947, 3146, 3188-3198, 3246, 3255-3277, 3357, 3465 |
| C7 | `sed -n 915,1050p $S/role-artifact.cjs` | Read tool | authority namespace, key, state |
| C8 | `grep -n "hmac.key\|role-artifact-authority\|0o600\|0o700\|function archiveAuthorityDirectory\|createHmac\|timingSafeEqual" $S/role-artifact.cjs` | ran | key/mode lines |
| C9 | `sed -n 595,640p $S/claude-role-host.cjs; sed -n 130,165p $S/codex-code-review-context.cjs` | ran | limit gates |
| C10 | `grep -rn "nextRound\|countableVerdicts\|normalizeResult\|normalizeFinal\|repairAllowed\|round_cap\|rounds_used" $S plugins/delivery-pipeline/commands plugins/delivery-pipeline/references plugins/delivery-pipeline/agents` | ran | callers: `S/phase-code-review.cjs:154,162,169`, `S/claude-role-host.cjs:611-612,1202`, `S/codex-code-review-context.cjs:148,427`, `S/role-artifact.cjs:3049` |
| C10b | Grep `phase-code-review-status\|round_cap\|rounds_used` excluding `plugins/shipyard/**` | Grep tool | only `S/phase-code-review.cjs:130-132,162` and tests consume them |
| C11 | `grep -rn -i "three rounds\|three countable\|3 rounds\|three reviews\|three-round\|round 3\|rounds 1\|round [0-9] of\|round cap\|ROUND_CAP\|at most three\|limit reached" plugins/delivery-pipeline docs README.md CLAUDE.md tests/smoke` | ran | prose hits in `commands/deliver.md:1453,1455`, `docs/gsd_multilevel_delivery_pipeline.md:650-651`, `docs/audits/phase52/*` |
| C12 | `sed -n 15,60p plugins/delivery-pipeline/references/code-review.md; grep -n -i "round\|limit\|operator" …` | ran | `:25` "Integer 1 through 3", `:49-51` "No fourth review is owed" |
| C13 | `grep -rn "code-review.md" $S/*.cjs $T/*.cjs tests/smoke/*.sh` | ran | `S/role-artifact.cjs:2877,3009`, `S/codex-code-review-context.cjs:169`, tests |
| C14 | `grep -n "contractDigest\|CONTRACT_ID\|function reuseKey" $S/*.cjs` | ran | `S/code-review-core.cjs:5,25,526,529`; `S/role-artifact.cjs:2876,2984-3028,3066,3152,3403` |
| C15 | `grep -n "trailer\|Shipyard-\|code_review\|codeReview" $S/gate-trailer.cjs`; `sed -n 62,80p`, `sed -n 203,239p`, `sed -n 370,420p $S/gate-trailer.cjs` | ran | trailer vocabulary; `verifyCodeReview` at `:384` |
| C16 | `grep -n -i "code.review\|code_review\|verifyCodeReview\|gate-trailer" $S/sentinel.cjs $S/front.cjs plugins/delivery-pipeline/references/pr-sentinel.md` | ran | `S/sentinel.cjs:70`; `S/front.cjs:1297`; none in `pr-sentinel.md` |
| C17 | `sed -n 30,50p`, `sed -n 1380,1480p`, `sed -n 1655,1675p plugins/delivery-pipeline/commands/deliver.md` | ran/Read | operator flow, exit text, hand-off |
| C18 | `git show 94d05497:.planning/architecture/ADR-032-code-review-fallback.md` | ran | cap, single exit, "no waiver store", visible-not-enforced, Out of scope |
| C19 | `ls .planning/architecture \| grep "ADR-03"; git cat-file -t 94d05497` | ran | one match (`ADR-030-…`); `commit` |
| C20 | `sed -n 1,120p $S/planning-untrack.cjs; grep -n "^function apply\|CONFIRM_TOKEN" $S/planning-untrack.cjs` | ran | token `untrack-planning` (`:10`), guard `:72-82` |
| C21 | `grep -rn "isTTY\|isatty\|/dev/tty\|SHIPYARD_OPERATOR\|process.stdin.isTTY\|CLAUDE_CODE\|CLAUDECODE" $S/*.cjs` | ran | `S/repo-resolve.cjs:1736`; env markers in `ci-wait.cjs:145`, `runtime-context.cjs:95,215`, `claude-runtime-host.cjs:37-42,85` |
| C22 | `sed -n 125,175p $S/ci-wait.cjs; sed -n 80,125p $S/runtime-context.cjs; sed -n 200,240p $S/runtime-context.cjs` | ran | runtime identification only |
| C23 | `sed -n 725,805p $S/claude-runtime-host.cjs; grep -n "READ_ONLY_TOOLS\s*=\|ALLOWED_TOOLS\s*=" -A3 $S/claude-runtime-host.cjs` | ran/Read | sandbox settings, tools `Bash,Read,Edit,Write,Glob,Grep` |
| C24 | `sed -n 1040,1140p $S/codex-runtime-host.cjs` | Read tool | protected paths, permission profile |
| C25 | Grep `denyRead\|role-artifact-authority\|archiveAuthorityNamespace` in `scripts plugins/delivery-pipeline capabilities README.md CLAUDE.md docs` | Grep tool | only `role-artifact.cjs`, `claude-runtime-host.cjs:703,756`, `codex-runtime-host.cjs:1109` |
| C26 | `grep -n "permission-mode\|--allowedTools\|--tools\|disallowedTools\|sandbox\|--settings\|bypassPermissions\|dontAsk\|--permission-prompts" $S/claude-runtime-host.cjs` | ran | `:751-790` |
| C27 | `grep -n "denied\|hasOwn(launchOptions\|trusted host\|reject(" $S/claude-role-host.cjs` | ran | `:88-120` request validation |
| C28 | `git check-ignore -v .planning/config.json; echo $?` → `1`; `git ls-files .planning/config.json` → listed | ran | tracked, not ignored in this repo |
| C29 | `grep -n "code_review" $S/pipeline-config.cjs` | ran | `:536`, `:1100-1102` |
| C30 | Grep `waiver\|no override flag\|override flag` excluding `plugins/shipyard/**` | Grep tool | `capability.json:54`, `deliver.md:42,1458`, `docs/…:654`, `S/deliver-dispatch.cjs:1209`, `S/phase-code-review.cjs:89` |
| C31 | Grep `Operator exit\|operator can set\|set delivery_pipeline.code_review` excluding `plugins/shipyard/**` | Grep tool | `S/phase-code-review.cjs:88,275`, `S/deliver-dispatch.cjs:1209` |
| C32 | `sed -n 1,60p scripts/package-shipyard-codex.cjs`; `git ls-files plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs`; `git diff --stat --no-index plugins/delivery-pipeline/scripts/phase-code-review.cjs plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs; echo $?` | ran | copy via `fs.cpSync`; tracked; diff exit 0 (identical) |
| C33 | `cat tests/unit/runtime-file-digests.json; sed -n 1,60p scripts/refresh-runtime-digests.cjs; sed -n 1,50p scripts/check-runtime-digest-trailer.cjs` | ran | two pinned files |
| C34 | `sed -n 1,136p tests/smoke/docs-smoke.sh` and `grep -n "phase-code-review\|planning-untrack\|code-review\|runtime digest\|runtime-digest\|digest" tests/smoke/docs-smoke.sh` | ran | no code-review references |
| C35 | `python3 -c "import json;d=json.load(open('plugins/delivery-pipeline/.claude-plugin/plugin.json'));print(d['version'],d.get('commands'))"` | ran | `1.0.0-rc.2`; five commands |
| C36 | `grep -n "phase-code-review\|code_review\|planning-untrack" README.md CLAUDE.md` | ran | `README.md:537-538` only |
| C37 | `grep -rn "readdirSync(.*scripts\|SCRIPT_INVENTORY\|scripts inventory\|every script" $T/*.cjs` | ran | `command-script-references.test.cjs:19`, `host-entry-contract.test.cjs:43`, `phase-code-review-publish.test.cjs:430` |
| C38 | per-file `grep -c`/`grep -n "ROUND_CAP\|round: 4\|review_round: 3\|'limit'\|three\|rounds_used\|CODE_REVIEW_ROUND_LIMIT\|repairAllowed\|repair: 'human'" $T/{code-review-core,phase-code-review,phase-code-review-publish,role-artifact,claude-role-host,codex-code-review-context,sentinel,deliver-dispatch}.test.cjs`; `grep -n "three rounds\|no override\|Operator exit\|limit reached\|nothing is held" $T/*.cjs`; `grep -n "nextRound\|countableVerdicts" $T/code-review-core.test.cjs` | ran | line numbers in section 5 |
| C39 | `env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_CODE_ENTRYPOINT -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED HOME=<mktemp -d> node tests/unit/code-review-core.test.cjs` and `… phase-code-review.test.cjs` | ran | exit 0, 26/26 and 68/68; 417 ms and 439,138 ms |
| C40 | `sed -n 190,232p $S/pr-hygiene.cjs; grep -n "^function applies" -A14 $S/pr-hygiene.cjs` | ran | `INTERNAL_LEAK_RULES`, `applies` |
| C41 | `sed -n 1,40p $S/comment-policy.cjs; grep -n "comment-policy" Makefile .github/workflows/test.yml; sed -n 105,112p Makefile` | ran | history pattern, markers, `test-comment-policy` |
| C42 | `sed -n 132,146p $S/reviewers.cjs` | ran | `isHumanHeadApproval` |
| C44 | `git log --oneline -8` | ran | subject shapes (D6) |
| C45 | `ls .github/workflows; grep -n "name:\|runs-on\|- name" .github/workflows/test.yml` | ran | jobs |
| C46 | `node -e "console.log(Object.keys(require('./plugins/delivery-pipeline/scripts/phase-code-review.cjs')).join(','))"` | ran, exit 0 | `publish,statusDescription,status,evaluateGate,fixTickets,matchEpicPullRequest,resolveCodeReviewMode,verifyCodeReview` |
| C47 | `ls -ld /Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp`; `ls -la ~/.local/state/shipyard/ ; ls -la ~/.local/state/shipyard/role-artifact-authority` | **denied by harness, not executed** | section 1 |
| C48 | `sed -n 640,660p docs/gsd_multilevel_delivery_pipeline.md` | ran | status "fixed text and integer counts only"; hold/report prose |
| C50 | `sed -n 1195,1246p $S/deliver-dispatch.cjs` | ran | builder refusal, `evaluateGate` use |
| C52 | `sed -n 1377,1380p $S/role-artifact.cjs; sed -n 80,95p $S/architecture-target.cjs` | ran | `registeredPhaseWorktrees`, `repositoryIdentity` |
| C53 | `grep -rIl "2026-10-27" . --exclude-dir=node_modules --exclude-dir=.git \| grep -v INV-021` | ran | no output |

Numbering note: C43, C49 and C51 were intentionally not used (reads folded into C5 and C50); there is no missing evidence behind the gaps.

## 12. What this artifact does not claim

- No design is chosen and no option is ranked.
- No claim is made about the live state of `~/.local/state/shipyard/` or the incident repository (section 1).
- Claims marked M or L (T5, T6, T7c, T10, T16, T19b, A1 pty, A5, D5 rule set, D6, D7) were derived by reading and are listed with the next check; none was executed.
- `docs-smoke.sh`, `make test-fast`, the package-compare tests and three of the five cap-pinning test files were not run.
