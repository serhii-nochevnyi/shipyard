# INV-021 — line "alternatives": designs for a human-permitted review round beyond `ROUND_CAP`

- Investigation: INV-021-human-review-round-extension
- Research line: `alternatives` (feeds the OPTIONS.md draft)
- Source revision: `749604b9307ce21d7790f0a5b8f97920dca9aa7f` (branch `epic/harness-simplification`, 1.0.0-rc.2)
- Policy hash: `fc1706bc9272bd0f539fbd71fa966b736df15c2cadfc2a76a8b84924b33584b8` (ADR-014 `adr-014.v8`)
- Policy signals: `{}` (none supplied; preserved as given)
- Worker selection: claude-sonnet-5-5 / xhigh (explicit, resolved by the caller)
- Status: completed, with the evidence gaps listed in section 9
- This file does not recommend an option. Choosing is the operator's decision (RESEARCH-CONTRACT.md: "Do not choose for the user").

## 0. How to read the evidence

Every checkable claim carries an evidence id `E<n>`. Section 10 lists, per id, the exact command that checks it and the result observed in this worktree at the revision above. File:line citations were produced with the Read/Grep tools and then re-verified in one read-only shell pass (command `V1`, section 10). Claims that no command could check are labelled **assumption**, **inference** or **unknown** and carry a next check. Nothing in this file was executed against production code; no throwaway code was written.

Where the contract says the generated Codex package is not edited directly: it is not. `plugins/shipyard/host/plugins/delivery-pipeline/scripts/*` is a tracked generated mirror (E18).

## 1. What the hold actually gates (framing the problem)

These facts bound what any "extension" is worth, so they come before the options.

- F1. The hold is a gate on the conveyor's own next steps, not on GitHub's merge. ADR-032 states "A human can still merge without it. No required status check or branch protection is assumed." and "The phase guarantee is visible, not enforced" (E2). `deliver.md` says the integrator and phase architecture review "are not launched until the verdict is current or the mode is `report`" (`plugins/delivery-pipeline/commands/deliver.md:1461-1463`, E16), and `gate-trailer.cjs verify` exits non-zero when `code_review.ok` is false (`gate-trailer.cjs:383-386`, E15).
- F2. After three countable verdicts `nextRound` returns `{ round: null, state: 'limit' }` (`code-review-core.cjs:338-340`, E3). The only defined exit is `delivery_pipeline.code_review: report` in `.planning/config.json` (`phase-code-review.cjs:87-90`, `pipeline-config.cjs:536,1100-1102`, E6, E19).
- F3. The existing exit is scoped to the whole project config, not to "this PR". The mode is read by `resolveCodeReviewMode` from one scalar in the project root's `.planning/config.json` (`phase-code-review.cjs:58-71`); no PR or head input exists in that read. The prose "for this PR" appears at `deliver.md:41`, `deliver.md:1385`, `deliver.md:1457`, `phase-code-review.cjs:89`, `phase-code-review.cjs:275`, `deliver-dispatch.cjs:1209` but nothing in code scopes it (E6, E7, E19). PROBLEM.md says the exit "lifts the hold for the whole PR"; the code evidence is that it lifts it for every PR the config governs until it is edited back.
- F4. The existing exit has no human-only enforcement. It is a plain JSON edit; the unit test flips it with `fs.writeFileSync` (`tests/unit/phase-code-review.test.cjs:205-216`, E7). Anything with write access to the project root's `.planning/config.json` can set it. So the status quo is "human by convention", and any option below must be compared against that baseline, not against an imagined hard boundary.
- F5. `repairAllowed(round)` is `round === 1 || round === 2` (`code-review-core.cjs:347`, E5). The out-of-scope rule "no auto-repair in extended rounds" is already satisfied by existing code: round 4 and above yield `repair: 'human'` (`phase-code-review.cjs:169`). No option needs to touch it.
- F6. What does not read code-review state today: the `gate_status:` trailer has no code-review key (`gate-trailer.cjs:69-71`: `--arch-review`, `--drift-check`, `--degenerate-green`, `--checks`, `--base-tree`), and `sentinel.cjs`/`front.cjs` contain no `code-review`/`phase-code-review` reads except `front.cjs:1297` (a role-to-kind label) (E15). The only machine readers of code-review state are `phase-code-review.cjs` itself, `gate-trailer.cjs verify` (via `verifyCodeReview`), `deliver-dispatch.cjs:1205-1215` (builder refusal and arch-review gate) and the prose in `deliver.md` (E15, E16). The proposal's "gate trailer carries round 4 of 3" therefore means a new trailer vocabulary entry, or a field in `verify`'s JSON; those have very different costs (see option B).

## 2. Authority surface: who can do what today (the "only a human" question)

This table is the common ground for options B, C and D. It is built from code evidence; cells that depend on the operator's own session configuration are **unknown**.

| Capability | Role-hosted model (review role launched by Claude/Codex host) | Orchestrator model (the operator's interactive session that runs `/shipyard:deliver` and shells out to `phase-code-review.cjs`) | Human in own terminal |
|---|---|---|---|
| Read `~/.local/state/shipyard/role-artifact-authority/<sha256(worktree)>/hmac.key` (mode 0600, same OS user) | Denied. Claude: sandbox `denyRead`/`denyWrite` of the archive authority plus tool-permission deny globs (`claude-runtime-host.cjs:748-762`). Codex: permission profile `"deny"` on host-protected paths including the archive authority (`codex-runtime-host.cjs:1079-1094,1109-1110,1190`) (E10) | **Unknown.** Shipyard ships no sandbox or permission config for this session: the plugin's `hooks.json` has only `SessionStart` (0 `PreToolUse` entries, E12) and `scripts/` has no Claude `sandbox`/`denyRead` setting (E12). It is the same OS user as the key owner (E9). Depends on the operator's own Claude Code / Codex settings. | Yes |
| Write under `~/.local/state/shipyard/` | Denied for review roles: `allowWrite = []`, `denyWrite` worktree and common dir, tools restricted to `Bash,Read,Glob,Grep` (`claude-role-host.cjs:1277-1290`); archive authority also in `denyWrite` (`claude-runtime-host.cjs:756`) (E10) | Unknown (same reason) | Yes |
| Edit `.planning/config.json` (the `report` exit) | Denied for review roles (same `allowWrite = []`) | Possible unless the operator's permission mode prompts for edits. Unknown. | Yes |
| Run a CLI verb that takes a constant `--confirm <token>` | Can run Bash, but cannot complete a write (rows above) | Yes. `planning-untrack.cjs` is the template and its token is a public constant: `CONFIRM_TOKEN = 'untrack-planning'` (`planning-untrack.cjs:10,73`), repeated in `README.md:538`, `Makefile:146`, `decompose.md:108-109`, i.e. in text the model reads (E8). It has no TTY, environment or caller check (E8: `isTTY` absent from the file). | Yes |
| Pass a TTY check | n/a | A TTY check is defeatable by allocating a pty (`script`, Python `pty`, `expect`). **Inference** (standard POSIX behaviour, not executed here); next check is spike S3. The only TTY use in the repo is `repo-resolve.cjs:1736` for an interactive choice, not an authority (E13). | Yes |
| Environment markers | n/a | `ci-wait.cjs:144-145` and `runtime-context.cjs:91-95` detect the runtime from `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`; these identify the runtime, not the human, and are inherited or removable by a child command (E13) | Absent in a plain terminal |
| Submit a GitHub review/comment/label as the operator | Credentials: unknown | Yes, with the operator's `gh` auth (the conveyor already drives `gh`: `phase-code-review.cjs:101-105,396-402`) | Yes |

Consequences that hold for all options:

- C1. The host sandboxes already stop a role-hosted model from writing any record outside the worktree, on both runtimes. A new "role host refusal" for `extend` (proposal item 2) is therefore defence in depth against a path that the sandbox already closes; it does not address the orchestrator-model path (E10, E12).
- C2. Nothing in the codebase today separates the orchestrator model from the human. The proposal's template (`planning-untrack.cjs --confirm`) does not provide that separation (E8). A genuinely human-only property needs an extra factor outside the model's reach. The candidate layers are in section 6.
- C3. The HMAC key is per worktree (`archiveAuthorityDirectory(worktree)` = namespace + `sha256(realpath(worktree))`, `role-artifact.cjs:944-946`), created with mode 0600 by `publishAuthorityKey` (`role-artifact.cjs:989-997`) and verified in `authorityState` (`role-artifact.cjs:1009-1042`) (E9). `priorCodeReviewVerdicts` scans several worktrees, each with its own key (`role-artifact.cjs:3255-3278`, E4). A signed extension has to pick one key; see unknown U7.

## 3. Alternatives

Four designs. A and B are the two the operator named. C and D are the two further candidates found; D separates the proposal's two independent decisions (the mechanism that grants a round, and the authority that decides who may grant it). Variants that were considered and not carried are in section 7.

### Option A — keep the single `report` exit; improve text and visibility only (minimal-change option)

**Sketch.** `ROUND_CAP` stays 3 and the hold's only exit stays `code_review: report`. Change strings and docs so the operator is not misled and the state is visible:
1. Correct the scope wording: say the key is project-wide, not "for this PR" (F3).
2. Make the refusal and the `limit` status say what happens next, and what the exit costs (hold lifted for the whole project until switched back).
3. Optionally show on the PR comment/status that the limit was reached and that the hold was lifted by configuration (the status and findings comment are already published: `statusDescription` `phase-code-review.cjs:209-224`, `findingsComment` `:269-298`).

**Touch points (production).** `phase-code-review.cjs:87-90` (`refusal`), `:181` (limit reason), `:215` (status description), `:275` (comment footer); `deliver-dispatch.cjs:1209`; `deliver.md:41-42`, `:1384-1385`, `:1455-1458`; regenerate the Codex mirror (E18). No change to `code-review-core.cjs`, `role-artifact.cjs`, `claude-role-host.cjs`, `codex-code-review-context.cjs` (E3, E4).

**Cost.** Estimate, based on touch-point count: about 5 source files plus the generated mirror, tens of changed lines, no new logic. Tests: the phrase pin `/three rounds.*delivery_pipeline.code_review.*report/` at `tests/unit/phase-code-review.test.cjs:222` and any message pins would need to follow the new text (E17). The three copies of the refusal sentence ("there is no override flag and no waiver record", E6) could be collapsed into one source, which would reduce lines.

**What makes it human-only.** Nothing; same as today (F4). It does not claim to.

**Same-user model defeat.** The model can set `report` by editing the config, exactly as today. Visibility improves detection after the fact; it does not prevent it.

**Runtimes.** Identical on Claude and Codex: text lives in shared scripts and docs (E4, E16). The Codex mirror is regenerated, not hand-edited (E18).

**Rollback.** Revert the commit; no state, no record, no migration.

**Forecloses.** Nothing. It also adds no capability: the conveyor still cannot run a fourth review, and the operator's choice stays "lift the hold" or stop. A human can still read the BLOCKERs on the PR and merge (F1).

**ADR-032.** No amendment; it clarifies the exit already decided. Docs that currently say "for this PR" would be corrected.

**Simplification direction.** Net deletion is possible; no new contract id, store or command.

### Option B — the operator's proposal as written (signed extension record + `extend` command)

**Sketch (from PROBLEM.md items 1-5).** `phase-code-review.cjs extend --phase N --pr P --rounds 1 --reason "..." --confirm extend-review-round` writes a one-round record outside the worktree under `~/.local/state/shipyard/`, signed like verdicts. Effective limit = `ROUND_CAP` + permitted extensions, capped by an overall ceiling (example 5). The record is bound to head and base at permission time; the extra round is a delta from the last counted verdict; `repairAllowed` unchanged (F5). The verdict, the `<!-- code-review -->` comment and the trailer carry `round 4 of 3, extended by <operator> at <time>: <reason>`. Refusal text names the extend command.

**Touch points (production), each verified in the current tree.**
1. `code-review-core.cjs`: `nextRound` limit (`:338-340`) and `normalizeResult`'s `round > ROUND_CAP` (`:196`) must take an effective limit; export a ceiling (E3).
2. `role-artifact.cjs`: the seal-time bound `review_round > core.ROUND_CAP` (`:3146`); the replay-depth bound `lineage.active.size >= ROUND_CAP` (`:3190`); a new signed-record reader/writer using the authority key (`:921-1042`); and `protectedRecordsWithoutKey` (`:1001-1007`) enumerates protected file-name prefixes (`architecture-sources-`, `planning-containment-`, `review-`, `integration-`) so that records without their key are never re-keyed; a new record file needs a prefix registered there (E3, E9).
3. Three independent `nextRound` call sites, each with its own `priorCodeReviewVerdicts` call: `phase-code-review.cjs:145,154`, `claude-role-host.cjs:596,612-613`, `codex-code-review-context.cjs:141,148-149` (E4). The extension lookup must be shared code or the runtimes diverge.
4. `phase-code-review.cjs`: new `extend` verb; the CLI parser accepts only `status|gate|fix-tickets|publish` and five value flags (`:512-528`), so `--rounds`, `--reason`, `--confirm` need new parsing; `status` schema `shipyard.phase-code-review-status.v1` exposes `round_cap` (`:130-132`) and needs additive fields; `refusal`, `statusDescription`, `findingsComment` change (E6).
5. `deliver-dispatch.cjs:1209`, `deliver.md` (4 sites), host error strings `claude-role-host.cjs:613`, `codex-code-review-context.cjs:149` (E6, E16).
6. Visibility in the trailer: either a new vocabulary entry in `gate-trailer.cjs` (`USAGE` `:69-71`; the reader/parser is shared by `state-sync.cjs`, `sentinel.cjs`, `front.cjs`, per the header comment `:43-47`), or an added field in the `verify` JSON (`:383-386`) which has no other readers (E15).
7. Regenerate the Codex mirror (E18). ADR-032 amendment (E2).

**Cost.** Estimate, not measured: the nearest existing private, atomically written, unsigned record store in this area is `publicationNamespace`/`readPublication`/`persistPublication` at `phase-code-review.cjs:306-391` (about 86 lines). A signed store tied to the per-worktree key, ceiling arithmetic, a new CLI verb with argument parsing, three call-site changes and visibility strings is plausibly several hundred production lines and a comparable amount of test code. The honest range is unknown until a spike (S5 below). Tests that pin the cap and would change: `tests/unit/code-review-core.test.cjs:167-180,368`, `phase-code-review.test.cjs:210,220-222,418,465,718`, `phase-code-review-publish.test.cjs:199`, `claude-role-host.test.cjs:2465`, `codex-code-review-context.test.cjs:252,1089-1091`, `role-artifact.test.cjs:1953,2287`, `code-review-foreign-contract.test.cjs:52` (E17), plus new tests for the five items in PROBLEM.md ("no record refuses", "record bound to head/base/PR", "role-host call rejected", "ceiling not bypassable", and tamper/forgery).

**What makes it human-only.** As written, two things: (a) a role-hosted model cannot write the record, but that is already enforced by the host sandboxes (C1, E10); (b) the `--confirm extend-review-round` token, which is a constant printed in docs and therefore gives no discrimination against the orchestrator model (E8, C2). Against the orchestrator model the proposal as written is not human-only. The signature also does not help if the signing process can read the key, and the orchestrator's key access is unknown (section 2).

**Same-user model defeat (orchestrator path).** Run `extend` with the documented token; or read `hmac.key` (if not denied) and write a valid record directly; pass a TTY check through a pty (inference, S3); invent the `<operator>` string, because the "extended by" identity is self-asserted by the caller (no identity source in the proposal). Role-hosted path: blocked by sandbox already.

**Design hazards inside B (all from code reading; none executed).**
- H1. The head-binding conflicts with the usual flow. Consent is bound to a head, and bots or `review-fix` pushes or a base merge move the head, voiding the record; each re-consent spends ceiling headroom. The human's own fix push must come before `extend`, since the record binds to the head that exists at consent time.
- H2. Replay depth. `authenticatedCodeReviewRecord` refuses when `lineage.active.size >= ROUND_CAP` (`role-artifact.cjs:3190`) and the chain recurses through `authenticateCarriedCodeReviewFindings` (`:2938`) from `replayCodeReviewRecord` (`:3245-3246`). **Inference:** with a cold memo, round 4 reaches depth 2 at its oldest ancestor and passes; round 5 reaches depth 3 and fails. So a ceiling of 5 needs this bound raised in step with the ceiling, and a ceiling of 4 passes only incidentally. Next check: spike S4.
- H3. Rollback is not clean. **Inference:** `codeReviewResultData` rejects `review_round > ROUND_CAP` (`:3146`) and `priorCodeReviewVerdicts` has no try/catch around replay (`role-artifact.cjs:3267`; called unguarded at `phase-code-review.cjs:145`), whereas `currentCodeReviewVerdict` does catch (`role-artifact.cjs:3357-3358`). A sealed round-4 verdict read by pre-extension code may make `status` throw rather than report `limit`. Next check: spike S4.
- H4. A new `shipyard.*` schema id is almost certainly needed for the record (the code mints one per artifact: `shipyard.code-review-publication.v1` at `phase-code-review.cjs:309`, `shipyard.code-review-disagreements.v1`, `shipyard.phase-code-review-status.v1`, E4). That collides with the operator's "no new contract ids" direction (DECISIONS.md).
- H5. An extension is a waiver store by another name: ADR-032 says "no waiver store is added" and lists "a waiver store" under Out of scope (E2). Adopting B means amending that ADR, as DECISIONS.md already records.

**Runtimes.** Works on both only if the extension lookup is shared (E4); the Codex side is a generated mirror (E18). The sandbox half of the "human-only" story is symmetric (Claude sandbox deny, Codex permission-profile deny, E10); the orchestrator half is unknown on both (section 2).

**Rollback.** Remove the verb and the reads; records on disk become inert. But see H3: round-4 verdicts already sealed may break reads under older code.

**Forecloses.** A simple "no state outside the worktree for review gating" story; the no-waiver-store invariant of ADR-032; and, in practice, the ceiling arithmetic and key placement are hard to change after records exist.

**Simplification direction.** Adds a store, a verb, a schema id, a key-prefix registration and three call-site changes; the proposal identifies nothing to delete. As stated it does not satisfy "each change removes more than it adds". Either an exception is granted or an offsetting deletion is named (open question U9).

### Option C — a human GitHub review on the exact head replaces the conveyor's round at `limit` (existing authority, no new store)

**Sketch.** Keep `ROUND_CAP = 3` and add no round. At `limit`, `evaluateGate` treats the hold as satisfied when a fresh, positively human, head-bound APPROVED review exists. The repo already has the predicate: `isHumanHeadApproval(row, headSha, prAuthor, bots)` requires `state === 'APPROVED'`, `commit_id === headSha`, `user.type === 'User'`, login different from the PR author, not a bot (`reviewers.cjs:138-144`), used for the ticket-PR `checkpoint: review` and "awaiting human review" blocks (`sentinel.cjs:165-192,968,1202`, `front.cjs:148-152`) (E14). The status/comment would say "limit reached; human approval on this head" with the reviewer login from GitHub rather than a self-asserted name.

**Touch points (production).** `phase-code-review.cjs` `evaluateGate` (`:188-197`) and `verifyCodeReview` (`:490-504`), which already feed `deliver-dispatch.cjs:1213-1215` and `gate-trailer.cjs:384`; one `gh api .../pulls/<n>/reviews` read, reusing `reviewFreshness`/`isHumanHeadApproval`; `statusDescription`/`refusal` strings. No change to `code-review-core.cjs`, seal validation, replay depth, host `limit` rejections or `repairAllowed` (E3, E4). One choke point (`evaluateGate`) serves both runtimes.

**Cost.** Estimate: tens of production lines (one gate branch, one lookup) and a handful of tests: no approval refuses; an approval by the PR author does not count; a bot approval does not count; an approval on another head does not count; a dismissed approval does not count. Nothing in the cap-pinning tests changes (E17), which is a measurable difference from B.

**What makes it human-only.** GitHub account identity, not a local secret: the approver must be a `User`, not a bot, not the PR author. The model cannot satisfy this with local file or TTY tricks.

**Same-user model defeat.** Depends on identity topology, which is unknown (U1). If the PR author is the account whose `gh` token the orchestrator uses, GitHub's rule that an author cannot approve their own PR (external claim, **not verified in this session**; next check: GitHub documentation or an API attempt by the operator) blocks it, but it also means a single-operator repository has nobody who can approve. If the PR is authored by a different account than the one the model's `gh` auth belongs to, the model can submit an APPROVED review as that other human and C is not human-only. Unlike B, it needs no key access.

**Runtimes.** Identical; one shared gate function. Requires network `gh` access at gate time, which `status`, `publish` and `verifyCodeReview` already use (`phase-code-review.cjs:101-105,396-402`).

**Rollback.** Remove the gate branch; there is no persisted state. A human approval stays on the PR as ordinary GitHub history.

**Forecloses.** A fourth conveyor review of the fix: the human attests, the conveyor does not re-check the finding. It also does not work for single-account operators. It re-opens a second withdrawn ADR-032 item: "the human `APPROVED` fallback" is in the Out-of-scope list, withdrawn on 2026-10-15, with the stated re-open condition "if measured late-found defects justify them" (E2); whether the incident counts as such evidence is for the operator (U8). It does not add a waiver store.

**Simplification direction.** Adds one gate branch reusing existing helpers; no new contract id, no new store, no new command. Deletes nothing.

### Option D — the proposal's mechanism with config-level authority (head-bound extra round, no signed store)

**Sketch.** Provide the extra round, its binding, ceiling and visibility from B, but express the permission in `.planning/config.json`, the surface the existing `report` exit already uses, instead of a signed store in `~/.local/state/shipyard/`. For example an entry naming `pr`, `head`, `base`, `rounds`, `reason` and the editing operator, validated by `loadConfig` (`pipeline-config.cjs`, which already warns and falls back on invalid values, `:1100-1102`). The code clamps the effective limit to `min(ROUND_CAP + sum(valid entries), CEILING)` in the same three call sites as B, and publishes "round 4 of 3, extended by …" in the status and comment.

**Touch points (production).** All the cap sites of B (`code-review-core.cjs:196,338-340`, `role-artifact.cjs:3146,3190`, the three call sites, host messages), plus a config key with validation in `pipeline-config.cjs`; no new CLI verb is needed (the operator edits JSON, or a trivial setter is added); no key use, no `protectedRecordsWithoutKey` change, no new store. The trailer question is identical to B (E15).

**Cost.** Estimate: B minus the signed store, the CLI parsing and the key plumbing; roughly the same cap-site and test churn as B (E17) with simpler new tests (valid/invalid config entry, head/base/PR mismatch, ceiling, several entries).

**What makes it human-only.** Nothing beyond what `report` provides today (F4). Its honest claim is "no weaker than the existing exit, and narrower": it is scoped to one PR and head and grants one round instead of lifting the hold.

**Same-user model defeat.** Edit the config, as with `report`. It is no easier for the model than the existing exit; it is easier than B only in that no key is needed.

**Runtimes.** Both, via the same shared lookup (E4). Config lives in the project root, so Claude and Codex orchestrators read the same file.

**Rollback.** Remove the key; unknown config keys are handled by `loadConfig` warnings. H3 (a sealed round-4 verdict under older code) applies as in B; H2 applies as in B.

**Forecloses.** Any claim that the extension is human-authenticated; if that claim is wanted later, D's record format can move into a signed store (section 6) without changing the mechanism. It also reintroduces a per-PR waiver-like record (in config), so ADR-032 needs the same amendment as B (E2).

**Simplification direction.** Adds a config key and a limit parameter; avoids the store, verb, key prefix and likely a new schema id (config values are already marked `@contract:`, `pipeline-config.cjs:536`, so a new key is still a contract in the code's own convention). Deletes nothing.

## 4. Comparative table

| | A: text/visibility only | B: signed record + `extend` (as proposed) | C: human GitHub approval at `limit` | D: head-bound extra round in config |
|---|---|---|---|---|
| Grants a fourth conveyor review | No | Yes (up to ceiling) | No (human attests instead) | Yes (up to ceiling) |
| Production touch points | ~5 files (strings, docs) | ~9 files incl. core, seal, replay bound, 3 call sites, new verb, new store | `evaluateGate`/`verifyCodeReview` + one `gh` read | Cap sites of B + config key; no verb/store/key |
| Estimated size | tens of lines, net ≤ 0 | several hundred prod lines + tests (estimate; spike S5) | tens of lines + ~5 tests | between C and B (estimate) |
| Existing cap-pinning tests change | Message pins only | Yes: 9 test files (E17) | No | Yes: same files as B |
| New state | None | Signed record under `~/.local/state/shipyard/` | None (GitHub review) | Entry in `.planning/config.json` |
| New contract id | None | Likely ≥ 1 (H4) | None | Config key (still a contract per `@contract:`) |
| Human-only against role-hosted model | n/a (already sandboxed) | Yes, by existing sandbox (C1) | Yes (GitHub identity) | Yes, by existing sandbox |
| Human-only against orchestrator model | No | No as written (constant token, C2); only with an added factor (section 6) | Yes if author ≠ approver and the model cannot act as the approver (unknown, U1) | No (same as `report`) |
| Defeat by same-user model | Edit config to `report` | Run `extend` with documented token; read key if not denied; pty; self-asserted operator name | Needs a second human account's credentials | Edit config |
| Both runtimes | Yes | Yes if lookup is shared | Yes | Yes if lookup is shared |
| Binding to head/base/PR | n/a | Explicit in record | Head via `commit_id`; PR inherent; base not bound | Explicit in entry |
| Visibility of who/when/why | Improves text only | Verdict, comment, status; trailer costs extra | Reviewer login from GitHub | Status/comment from config fields; identity self-asserted |
| Rollback | Revert commit | Remove verb; H3 hazard for sealed round-4 verdicts | Remove branch; no state | Remove key; H3 hazard |
| Forecloses | Nothing; adds nothing | No-waiver-store invariant; hard-to-change ceiling/key choices | Re-checking the fix; single-account operators | A human-authenticated claim, unless later moved to a signed store |
| ADR-032 effect | None | Amend: waiver store, single exit | Amend: withdrawn human `APPROVED` fallback | Amend: waiver store, single exit |
| Fits "removes more than it adds" | Yes | No deletion identified (U9) | Adds one branch, deletes nothing | Adds a key and a parameter, deletes nothing |
| Largest unknown | Is lifting the whole-project hold acceptable? | Orchestrator key access; replay depth; rollback (U3, U5, U6) | Who authors the epic PR (U1) | Same as B for H2/H3 |

## 5. What the incident evidence would add (not obtained)

The origin is a Claude session in `/Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp`, branch `research/mcp-tools-ai-pdf-12908`. This worker could not read that repository or `~/.local/state/shipyard/`: both probes were denied by the permission layer (commands `P1`, `P2`, section 10). The facts that would settle C and the value of B/D are therefore unknown here: who authored the epic PR (U1), how many rounds produced `needs-fix` versus `incomplete`, and whether the operator wanted a fourth review or just to continue (U2). There is no measured frequency of cap exhaustion in `docs/audits/phase52/` (E20: grep of `catch-rate.md` and `README.md` finds nothing on round exhaustion); one operator-reported incident is the only data point.

## 6. Authority layers: the second axis (applies to B or D; independent of the mechanism)

The proposal bundles two decisions: what the extension does, and who may grant it. The layers below are candidates for the second decision; they are listed with what each defeats, from code evidence and standard POSIX/GitHub behaviour (inference unless stated).

| Layer | Stops a role-hosted model | Stops the orchestrator model | Defeat by a same-user model | Cost/availability |
|---|---|---|---|---|
| L0 constant `--confirm` token (the template) | Redundant with sandbox | No | Read the token from docs, run the command | Free; E8 |
| L1 signature with the existing authority key | Yes (key path denied, E10) | Only if the orchestrator cannot read the key (unknown) | Read key if not denied | Reuses `authorityState`; per-worktree key (C3) |
| L2 `/dev/tty` challenge (nonce typed by the human) | n/a | Speed bump only | Allocate a pty and answer its own challenge (inference, S3) | Small code; no new state |
| L3 orchestrator runs sandboxed with the authority path denied (same pattern as host-launched roles, `claude-runtime-host.cjs:756`) | n/a | Yes, for key access; the command must then be run in a different, unsandboxed process | Escape the sandbox | Not shippable by the plugin: no `PreToolUse` hook or settings shipped (E12); depends on the operator's own settings, per runtime |
| L4 out-of-band factor (OS password prompt, hardware key, separate account) | n/a | Yes if the factor is not available to the model | Cached credentials (for example a warm `sudo` timestamp; inference) | Platform-specific; unverified here; heavy for the simplification direction |
| L5 GitHub identity of a different human (option C) | n/a | Yes if the model lacks that account's credentials (unknown, U1) | Credentials of that account | Existing code (E14) |

Because the repo's own precedent (`planning-untrack`) is L0 and the existing exit is not authenticated at all (F4), choosing any layer above L0 is a new security promise, not a restatement of one.

## 7. Variants considered and not carried as separate options

- Raise `ROUND_CAP` or the ceiling for everyone: excluded by PROBLEM.md (cap stays 3).
- Environment-variable override read by the review scripts (for example an `…_EXTRA_ROUNDS` variable): a command run by the model can set it inline; no human-only property; no head binding; not carried.
- GitHub label or comment as the consent signal: the same `gh` credentials the conveyor uses could create either; not human-only unless the account differs from the model's (reduces to option C's identity question, with weaker semantics); not carried.
- GitHub branch protection or a required `code-review` status check with admin bypass: the conveyor already publishes a `code-review` commit status (`phase-code-review.cjs:436-438`), but ADR-032 deliberately assumes no required check (E2) and F1 shows the hold gates conveyor steps, not merge. It is "do nothing" plus a repository setting, outside this codebase. Mentioned for completeness; not carried.
- Git-signed object (signed tag or commit) verified against an allowed-signers list, with a hardware-backed or passphrase-protected key: could be human-only through key custody, but needs per-operator key setup and a verification path; no existing code; heavy for the simplification direction; not carried, listed under L4.
- Doing nothing: this is option A without the text changes; the operator's actual exits remain `report` or a human merge.

## 8. Open questions (OPEN-QUESTIONS.md draft items)

- [ ] U1: Who authors the phase epic PR on GitHub, and can the operator's `gh` identity ever be a different account from the author (decides whether option C is feasible and human-only)? — owner: operator
- [ ] U2: Does the operator want a fourth *conveyor review* (B, D) or only the ability to *continue the conveyor* past `limit` (which `report` already does, A)? — owner: operator
- [ ] U3: What sandbox and permission mode does the orchestrator session run under on Claude and on Codex in the operator's real setup, and can it read `~/.local/state/shipyard/role-artifact-authority/*/hmac.key`? — owner: operator (evidence via spike S1)
- [ ] U4: Does a command run from the Claude Code Bash tool or the Codex shell obtain a usable controlling terminal when it allocates a pty (decides whether L2 is a speed bump or nothing)? — owner: maintainers (spike S3)
- [ ] U5: Does a cold-memo replay of a four-deep and a five-deep code-review lineage pass the `lineage.active.size >= ROUND_CAP` bound at `role-artifact.cjs:3190`? — owner: maintainers (spike S4)
- [ ] U6: Does a sealed round-4 verdict make `phase-code-review.cjs status` throw under code with `ROUND_CAP = 3` (rollback hazard H3)? — owner: maintainers (spike S4)
- [ ] U7: With one HMAC key per worktree and `priorCodeReviewVerdicts` scanning several worktrees, which worktree's key signs and verifies an extension record? — owner: maintainers
- [ ] U8: Is the incident enough "measured late-found defects" to re-open the withdrawn items in ADR-032 (human `APPROVED` fallback, waiver store)? — owner: operator
- [ ] U9: Which deletion offsets option B's additions under the 2026-10-27 simplification direction, or is an exception granted? — owner: operator
- [ ] U10: Does a user-initiated command (for example a `!`-prefixed command in the Claude Code prompt or the Codex equivalent) carry any marker that distinguishes it from a model tool call, and is that stable enough to build on? — owner: maintainers (spike S2; no evidence in this repo)
- [ ] U11: Does GitHub block an author from approving their own PR in the operator's repositories (external claim, not checked here)? — owner: operator
- [ ] U12: How many PRs have exhausted the cap across the operator's projects? The only known case is the reported pdffiller-mcp incident, which this worker could not read. — owner: operator

## 9. Evidence gaps and blocked reads

- G1. `~/.local/state/shipyard/` could not be listed: command `P1` was denied by the permission layer ("Permission to use Bash … has been denied"). Not retried, per the denial notice. The key mode, owner and the existing record names were therefore established from code (`role-artifact.cjs:921-946,989-997`), not from the filesystem.
- G2. `/Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp` could not be read: command `P2` was denied. The incident's `.planning/graph/`, `.shipyard-code-review-evidence.md` and records are unexamined (section 5).
- G3. No throwaway code was run, by contract. The five hypotheses that need execution are listed as spikes below.
- G4. The sandbox description supplied with this task lists the authority directory and a `shipyard-claude-session-start-*` directory as read-denied; this matches the host-launched pattern at `claude-runtime-host.cjs:740,748-756`. It is context from the task description, not a command result, and it is not used as evidence for any claim above.

Recommended spikes (not executed; run with the project's spike command if the operator wants them):

- S1. `/gsd-spike "can the operator's interactive Claude Code and Codex orchestrator sessions read role-artifact-authority/*/hmac.key"`
- S2. `/gsd-spike "does a user-initiated prompt command (for example `!`-prefixed in Claude Code, or the Codex equivalent) differ observably from a model tool call: environment, controlling terminal, hook firing"`
- S3. `/gsd-spike "pty allocation from the Claude Code Bash tool and the Codex shell: is /dev/tty openable and drivable"`
- S4. `/gsd-spike "seal and replay a 4-deep and 5-deep code-review lineage with a cold memo, then read it with ROUND_CAP=3 code"`
- S5. `/gsd-spike "size a signed extension record store on the role-artifact authority: lines, files, test count"`

## 10. Evidence index: commands and results

Working directory for every command: `/Volumes/KINGSTON/.wt-claude-shipyard/harness-simplification`. `S=plugins/delivery-pipeline/scripts`. The evidence was collected with the Read and Grep tools; each row names a shell command that reproduces it.

| Id | Claim | Command | Result observed |
|---|---|---|---|
| E1 | Revision and PROBLEM.md digest as given | `git rev-parse HEAD`; `shasum -a 256 .planning/investigations/INV-021-human-review-round-extension/PROBLEM.md`; `git status --porcelain` | `749604b9307ce21d7790f0a5b8f97920dca9aa7f`; `3fbf5bf6efc6c068cae817e15d865cef6951a280e066b8596259d88248f4fa19` (matches); only `?? .planning/investigations/INV-021-human-review-round-extension/` |
| E2 | ADR-032 text: 3-round cap, single `report` exit, "no waiver store", human can still merge, withdrawn human `APPROVED` fallback with re-open condition, "waiver store" out of scope | `git show 94d05497:.planning/architecture/ADR-032-code-review-fallback.md` | File printed; quoted passages are in its Decision and Out-of-scope sections |
| E3 | Cap sites in core and seal | `grep -n -E "^const ROUND_CAP\|round > ROUND_CAP\|used >= ROUND_CAP\|^function (nextRound\|repairAllowed\|countableVerdicts)" $S/code-review-core.cjs`; `grep -n -E "review_round > core.ROUND_CAP\|lineage.active.size >= " $S/role-artifact.cjs` | core `:6`, `:196`, `:299`, `:338`, `:340`, `:347`; role-artifact `:3146`, `:3190` |
| E4 | Three production `nextRound` call sites each with own prior-verdict read; schema ids minted | `grep -n 'nextRound(' $S/*.cjs`; `grep -n 'priorCodeReviewVerdicts(' $S/*.cjs`; `grep -n -o "shipyard\.[a-z-]*code-review[a-z.0-9-]*" $S/*.cjs` | `phase-code-review.cjs:154`, `claude-role-host.cjs:612`, `codex-code-review-context.cjs:148`; prior reads at `:145`, `:596`, `:141` and `role-artifact.cjs:3116,3255,3357`; ids `shipyard.phase-code-review-status.v1`, `…-publish.v1`, `shipyard.code-review-publication.v1`, `shipyard.code-review-disagreements.v1`, `shipyard.phase-code-review.v1`, `shipyard.codex-code-review-context.v1` |
| E5 | `repairAllowed` is rounds 1-2 only; sole caller | `grep -n repairAllowed $S/*.cjs` | `code-review-core.cjs:347`; `phase-code-review.cjs:169` |
| E6 | Refusal/limit/status/footer text sites; CLI verbs and flags | `grep -n -E "three rounds are spent\|no override flag and no waiver record\|Operator exit\|code review limit reached\|round_cap: core.ROUND_CAP" $S/phase-code-review.cjs`; `sed -n 1205,1210p $S/deliver-dispatch.cjs`; `sed -n 508,530p $S/phase-code-review.cjs` | `:89`, `:181`, `:215`, `:275`, `:132`; `deliver-dispatch.cjs:1209`; verbs `status\|gate\|fix-tickets\|publish` at `:512`, flag table at `:515` |
| E7 | Mode is one project-wide config scalar; test flips it by writing the file | `sed -n 58,71p $S/phase-code-review.cjs`; `sed -n 205,216p tests/unit/phase-code-review.test.cjs` | `resolveCodeReviewMode` reads `loaded.config.code_review`; test uses `f.mode(...)` and `fs.writeFileSync(configPath, originalConfig)` |
| E8 | Confirm-token template has no human check | `grep -n -E "CONFIRM_TOKEN\|isTTY" $S/planning-untrack.cjs`; `grep -n planning-untrack Makefile README.md plugins/delivery-pipeline/commands/decompose.md` | token constant at `:10,73,143`; no `isTTY` match; token appears in `Makefile:146`, `README.md:538`, `decompose.md:108-109` |
| E9 | Authority namespace, per-worktree key dir, key creation and verification, protected prefixes | `sed -n 921,1042p $S/role-artifact.cjs` | `:921-942` namespace (mode check `0o077`), `:944-946` per-worktree dir, `:989-997` key written `0o600`, `:1001-1007` prefixes, `:1009-1042` HMAC verify |
| E10 | Host sandboxes deny the authority path on both runtimes; review roles are read-only | `sed -n 748,762p $S/claude-runtime-host.cjs`; `sed -n 1277,1290p $S/claude-role-host.cjs`; `sed -n 1079,1094p $S/codex-runtime-host.cjs`; `sed -n 1109,1110p $S/codex-runtime-host.cjs` | Claude `denyRead: [archiveAuthority]`, `denyWrite: [archiveAuthority]`, permission deny globs; review roles `allowWrite = []`, `denyWrite.push(worktree, commonPath)`, tools `Bash,Read,Glob,Grep`; Codex `…="deny"` filesystem rules, `hostProtectedPaths` includes the archive authority |
| E12 | Plugin ships no `PreToolUse` hook; no orchestrator sandbox setting in `scripts/` | `grep -c PreToolUse plugins/shipyard/hooks/hooks.json`; `grep -rn -E "sandbox\|denyRead\|permissions" scripts` | `0`; three hits, none a Claude orchestrator sandbox setting: Codex `sandbox_mode` strings at `gen-codex-shipyard.cjs:327` and `capture-boundary-fixtures.cjs:180`, and a comment about unlink permissions at `install-shipyard-codex.sh:580` |
| E13 | Env and TTY checks identify runtime or serve a prompt, not authority | `sed -n 144,145p $S/ci-wait.cjs`; `sed -n 91,95p $S/runtime-context.cjs`; `sed -n 1736p $S/repo-resolve.cjs` | `CLAUDE_PLUGIN_ROOT`/`CLAUDE_CODE_ENTRYPOINT`/`CODEX_SANDBOX` runtime detection; `isTTY` only for an interactive repository choice |
| E14 | Human head-approval predicate and its users | `grep -n -E "isHumanHeadApproval\|reviewCheckpointApproval" $S/*.cjs` | defined `reviewers.cjs:138`, `sentinel.cjs:165`; used `sentinel.cjs:191,968,1202`, `front.cjs:148-152`, `reviewers.cjs:228` |
| E15 | Trailer vocabulary has no code-review key; `verify` embeds `code_review`; sentinel/front do not read it | `sed -n 69,71p $S/gate-trailer.cjs`; `sed -n 383,386p $S/gate-trailer.cjs`; `grep -n -E "code[-_]review\|phase-code-review" $S/sentinel.cjs $S/front.cjs $S/gate-trailer.cjs $S/deliver-dispatch.cjs` | `USAGE` keys `arch-review/drift-check/degenerate-green/checks/base-tree`; `:384-386`; only `front.cjs:1297` plus `deliver-dispatch.cjs:554-616,1205-1215` and `gate-trailer.cjs:384-386` |
| E16 | `deliver.md` operator-facing text and gating order | `sed -n 38,42p plugins/delivery-pipeline/commands/deliver.md`; `sed -n 1384,1385p …`; `sed -n 1450,1472p …` | sites `:41-42`, `:1384-1385`, `:1450-1463` (repair rounds 1-2, `limit`/`incomplete` stop with the named exit), `:1464-1472` prelaunch gate |
| E17 | Tests that pin the cap | `grep -rn -E "nextRound\|repairAllowed\|ROUND_CAP\|CODE_REVIEW_ROUND_LIMIT\|round_cap\|state, 'limit'" tests` | `code-review-core.test.cjs:167-180,368`; `phase-code-review.test.cjs:210,220-222,418,465,718`; `phase-code-review-publish.test.cjs:199`; `claude-role-host.test.cjs:2465`; `codex-code-review-context.test.cjs:252,1089-1091`; `role-artifact.test.cjs:1834,1951-1953,2287`; `code-review-foreign-contract.test.cjs:52` |
| E18 | Generated Codex mirror is tracked and byte-identical; digest pin lists only two files; docs-smoke does not reference these scripts | `git ls-files plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs`; `shasum -a 256` of source vs mirror for 7 scripts; `node -e "console.log(Object.keys(require('./tests/unit/runtime-file-digests.json').files).join('\n'))"`; `grep -n -E 'code-review\|phase-code-review\|planning-untrack\|digest' tests/smoke/docs-smoke.sh` | mirror tracked; first 16 hex digits identical for `phase-code-review`, `code-review-core`, `role-artifact`, `claude-role-host`, `codex-code-review-context`, `planning-untrack`, `gate-trailer`; pin lists `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` only; no docs-smoke match |
| E19 | `code_review` config key: single scalar, default `hold`, validated to `report\|hold` | `grep -n -E "code_review: 'hold'\|\['report', 'hold'\]" $S/pipeline-config.cjs` | `:536`, `:1100` |
| E20 | No measured cap-exhaustion frequency in phase52 audits | `grep -n -i -E 'round\|cap\|exhaust\|limit' docs/audits/phase52/catch-rate.md`; `grep -n -i -E 'rounds?\b' docs/audits/phase52/README.md` | catch-rate matches concern unrelated "round"/"cap" text; README: no match |
| V1 | Consolidated re-verification of every line number above | one read-only shell pass of the greps in E3-E6, E9-E10, E14-E15, E19 plus `git rev-parse HEAD` | all citations confirmed at revision `749604b9…`; worktree clean except the untracked INV directory |
| P1 | Read of `~/.local/state/shipyard/` | `ls -ld "$HOME/.local/state/shipyard" "$HOME/.local/state/shipyard/role-artifact-authority"` | **Denied** by the permission layer; not retried |
| P2 | Read of the incident repository | `ls -ld /Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp` | **Denied** by the permission layer; not retried |

Inferences (no command can check them without executing code): H2 and H3 (replay depth and rollback, derived from `role-artifact.cjs:2938,3188-3199,3245-3246,3267,3357-3358` and `phase-code-review.cjs:145`), the pty defeat (L2), the warm-credential defeat (L4), the GitHub self-approval rule (C), and all size estimates for B, C and D.

## 11. Statement of neutrality

No option is recommended. The two decisions the operator has to make are separable: the mechanism (none, a fourth conveyor review, or a human attestation at `limit`) and the authority (L0 to L5 in section 6). Option D is the proposal's mechanism at the existing exit's trust level; option C is a different mechanism whose authority is GitHub identity; option A changes no mechanism. Gate 1 is not closed by this file and no ADR text is written.
