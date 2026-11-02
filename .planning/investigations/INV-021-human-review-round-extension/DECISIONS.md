# Decisions

## The proposal is treated as an amendment of ADR-032, not as a conflict to be avoided
**Why:** ADR-032 fixes `report` as the single exit after the round cap and adds no waiver store; the operator (2026-11-02) chose to reconsider that decision explicitly.
**What was rejected:** investigating only, without a commitment to amend ADR-032.
**Scope fence:** amends only ADR-032's exit after the cap, its "no waiver store" sentence and its 3-round wording; nothing else in ADR-032.

## The harness simplification direction is a design constraint
**Why:** operator direction of 2026-10-27: fewer lines, no new contract ids, each change removes more than it adds.
**What was rejected:** judging the design on correctness and safety alone.
**Scope fence:** the comment policy (`comment-policy.cjs`) is not weakened.

## The design is evaluated against `epic/harness-simplification` (1.0.0-rc.2), not `main`
**Why:** the operator stated the base branch (2026-11-02); that epic already deleted much of the verdict-replay and host code.
**What was rejected:** researching `main` at `0878fb86`.
**Scope fence:** ADR-032 text is read from git history (`94d05497`).

## Option B in its light form: the operator grants one more round with a head-bound record, with no signature and no claim of cryptographic human-only authority
**Why:** operator choice 2026-11-02. In practice "let's do one more round" is said in chat and executed by the model, so a signed store would not separate the operator from the model; it would add code and a security claim the same-user orchestrator can defeat (INV-021 research, system-state 6.3, 6.6). The claim that is made: a role-hosted child cannot grant itself an extension (existing sandbox, plus a refusal under host-child markers); the same-user orchestrating session acting on the operator's word is trusted, exactly as for the existing `report` exit.
**What was rejected:** Option A (text only), Option C (human GitHub approval instead of a round), Option D (config entry), and the signed-record layers L1-L5.
**Scope fence:** does not harden the existing `report` exit; does not authenticate who typed the command.

## One record grants exactly one round; the total is capped at 5; limit = 3 + valid records, clamped
**Why:** operator selection 2026-11-02 ("5 rounds"). Consumption is derived, not flagged: a record bound to head H counts while H is the current head (unconsumed) or while H is an ancestor of the current head and a countable verdict for H sealed after the record exists (consumed). A record for another PR, base or an unrelated head is void and does not count toward the ceiling. This removes the consumed-versus-voided hole (risks F6) without a mutable flag.
**What was rejected:** a `--rounds N` argument; a stored consumption flag.
**Scope fence:** seal and replay checks use the absolute ceiling (5), not the per-PR limit, and the replay-depth bound rises with it; spike S1 confirms before decomposition.

## The extended round is always a delta from the last counted verdict; `repairAllowed` stays for rounds 1-2
**Why:** operator scope (2026-11-02). A finding in an extended round goes to the human, not to auto-fix. If the coverage chain is broken (no delta possible) the extension refuses; it never falls back to a full review.
**What was rejected:** a full extended round; auto-repair after round 4 or 5.
**Scope fence:** `ROUND_CAP` stays 3.

## The record lives outside the worktree, unsigned, private, under the user's state directory, bound to PR, head and base
**Why:** same location and discipline as the existing publication record (`~/.local/state/shipyard/code-review-publications/…`: 0700/0600, lock, bounded, uid-checked) and no new key plumbing. The operator identity is taken from the caller's git identity (fallback OS user), the time from the host clock; both are self-asserted and displayed as such.
**What was rejected:** the authority namespace with its per-worktree HMAC key (a per-worktree key has no per-PR home and the model can read it).
**Scope fence:** a new schema id is avoided if the existing publication record format can be reused; otherwise the ticket names it.

## Visibility is the PR comment and the `code-review` status text, not the gate trailer
**Why:** the `merge-gate` trailer is capped at 140 characters with 8-12 free and is read by three other scripts; `round 4 of 3, extended by <operator> at <time>: <reason>` cannot fit. The comment `<!-- code-review -->` and the `code-review` commit status carry the line; the reason is bounded and sanitized. The refusal text names the extend command and still names `report`.
**What was rejected:** adding a code-review field to the trailer.
**Scope fence:** a deviation from the operator's item 4 (trailer), recorded because it does not fit; the human merging into `main` still sees it on the PR.

## `references/code-review.md` is edited (rounds 1-5, a fourth round only with a human record) and the one-time reset of in-flight verdicts is accepted
**Why:** operator choice 2026-11-02. The file says "Integer 1 through 3" and "No fourth review is owed", which would contradict round 4; its digest is part of the round counter, so the edit resets verdicts sealed before it (rc.2 and earlier). It lands before any rc.3 tag.
**What was rejected:** leaving the file byte-identical.
**Scope fence:** the release notes state the reset.

## The release is `1.0.0-rc.3` on `epic/harness-simplification`, and the version is controlled by the assistant
**Why:** operator instruction 2026-11-02 ("version control yourself, the next one for shipyard with this branch"). `v1.0.0-rc.2` already exists at the base (`749604b9`). The bump follows the six-file pattern of `749604b9` (`capabilities/…/capability.json`, `plugins/delivery-pipeline/.claude-plugin/plugin.json`, `plugins/shipyard/.codex-plugin/plugin.json`, the two generated `host/` copies, `plugins/shipyard/package-build.json`) as the last PR of the epic, after the feature merges and the Codex package is regenerated; net zero lines. No tag or release is created without the operator.
**What was rejected:** bumping before the feature lands; landing the design on `main`.
**Scope fence:** does not cover a `main` release; the operator did not request one.

## Out of scope for this INV
**Why:** operator selection 2026-11-02.
**What was rejected:** changing the default `ROUND_CAP`; auto-repair in extended rounds.
**Scope fence:** `repairAllowed` stays for rounds 1-2 only; `ROUND_CAP` stays 3; other roles' limits and retroactive unblocking of old PRs other than by a new record are not covered.

## Refusal hints, project-wide `report` wording and the many-fixes rule are part of the design
**Why:** the incident session (pdffiller-knowledge `649f53a0`, 2026-11-02) showed `hint[BUILD_REFUSED]` with no remedy on `limit`, `report` set project-wide while described as "for #180" and still on, and three fix PRs (#184, #185, #186) after the last `pass`, each moving the head. The operator asked what happens when bots keep finding fixes.
**What was rejected:** a higher or configurable ceiling; re-reviewing after every fix PR.
**Scope fence:** ADR-035 R-13..R-15; the ceiling stays 5.

## Phase 54 ticket set approved (15 tickets, 11 waves) with the `extend` precondition
**Why:** operator approval at Gate 2, 2026-11-02, after three checker cycles and one extra planner cycle (0 blockers). The `extend` precondition is confirmed: the command works only when the live status is `limit` (a head with no counted verdict) and the ceiling of 5 is not reached; after a round-3 verdict on the same head the operator first changes the head by a push. The R-12 net-lines exception is granted for this phase (about +1,281 against about -205 named deletions; each PR still states its net lines and names its offsetting deletion).
**What was rejected:** allowing `extend` while rounds are still free (a record would be consumed by an ordinary round); splitting 54-07 (size warning accepted); a phase epic branch `epic/54-...` cut from `main`.
**Scope fence:** ticket PRs go straight into `epic/harness-simplification`, delivered in the epic's HS style (ticket branch from the epic tip, PR into the epic, separate reviewer, merge after green CI before the next dependent ticket starts); `/shipyard:deliver` is not used because the conveyor derives `epic/<phaseDir>` from `main`. The Codex package regeneration (one `make package-shipyard-codex` commit on the epic) is an operator or assistant step after T-54-14 and before T-54-15. Jira export is skipped (`pipeline.jira.enabled: false`). No ticket is pre-authorized (no `merge` checkpoints; T-54-05 and T-54-07 carry `review`). `54-VALIDATION.md` is a draft planning document that no typed role can seal, like phase 50's.

## Release version of the phase is `1.0.0-rc.4` (amends the `1.0.0-rc.3` decision above)
**Why:** the operator released `1.0.0-rc.3` first (2026-11-02, tag `v1.0.0-rc.3` at `9ba94e7c`) with HS-45, HS-46 and HS-47 and without this phase. The version bump ticket T-54-15 therefore takes `1.0.0-rc.3` to `1.0.0-rc.4`.
**What was rejected:** re-tagging or re-releasing rc.3.
**Scope fence:** ADR-035 R-9, ROADMAP, REQ-212, CONTEXT, 54-VALIDATION and 54-15 are amended; the historical research and earlier decisions keep their original wording.
