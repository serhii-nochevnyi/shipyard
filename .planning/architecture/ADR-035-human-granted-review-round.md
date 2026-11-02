---
status: accepted
---
# ADR-035 — A human-granted extra code-review round

- **Status:** accepted; INV-021 Gate 1, accepted by the repository operator on 2026-11-02
- **Date:** 2026-11-02
- **Decision owner:** repository operator
- **Scope:** how the phase code review may run a round beyond the third, which record grants it, how the limit is computed, where the extension is shown, and which release carries it
- **Supersedes:** none (amends ADR-032: its single exit after the round cap, its "no waiver store" sentence and its 3-round wording)
- **Related:** ADR-032, ADR-014
- **UI design:** none

## Context

[INV-021](../investigations/INV-021-human-review-round-extension/PROBLEM.md) asked for an explicit, human-permitted continuation of the phase code review beyond `ROUND_CAP = 3`. Evidence is in `RESEARCH.md` and the four sealed lines under `research/`, taken against `epic/harness-simplification` at `749604b9` (1.0.0-rc.2).

- After three countable verdicts `nextRound` returns `limit` (`code-review-core.cjs:338-340`). The only exit ADR-032 defines is setting `delivery_pipeline.code_review` to `report`, which is a plain edit of `.planning/config.json`, project-wide rather than per PR (`pipeline-config.cjs:536`, `phase-code-review.cjs:87-90`).
- The cap is derived from authenticated verdict history and enforced in four code places: `code-review-core.cjs:196,340`, `role-artifact.cjs:3146` and the replay-depth bound `role-artifact.cjs:3190`. The reviewer reference digest is part of the counter, so editing `references/code-review.md` resets verdicts sealed before it.
- No primitive in the repository separates the orchestrating model from the operator. A role-hosted child is already sandboxed from the authority and state directories.
- The `merge-gate` trailer has 8-12 free characters of 140; the visible code-review surfaces are the `code-review` commit status and the `<!-- code-review -->` comment.
- Incident: a phase epic PR in `pdffiller-mcp` spent round 3 on a one-line documentation delta, and its project already uses `report`.

## Decision

- **R-1 Mechanism:** an operator command `phase-code-review.cjs extend --phase N --pr P --reason "…" --confirm extend-review-round` writes one record. One record grants exactly one extra round. There is no `--rounds` argument.
- **R-2 Authority claim:** the record is unsigned and is a decision of the person who runs the command, recorded as such. A role-hosted child cannot grant itself an extension (existing sandbox, plus a refusal under host-child markers). The same-user orchestrating session acting on the operator's word is trusted, exactly as for the existing `report` exit. The ADR does not claim cryptographic human-only authority.
- **R-3 Record:** private (0700/0600, lock, bounded) and outside the worktree under the user's state directory next to the publication record, bound to repository, PR, the live head at writing time and the base commit, with operator identity (the caller's git identity, fallback OS user), time and reason. The reason is bounded and sanitized.
- **R-4 Limit:** effective limit = `ROUND_CAP` + the number of valid records, clamped to a total of 5 rounds. A record counts while its head is the current head (unconsumed), or while its head is an ancestor of the current head and a countable verdict for that head sealed after the record exists (consumed). A record for another PR, base or unrelated head is void and does not count.
- **R-5 Ceilings in seal and replay:** seal validation, normalization and the replay-depth bound use the absolute ceiling of 5, not the per-PR limit.
- **R-6 Extended round:** always a `delta` from the last counted verdict. If the coverage chain does not allow a delta the extension refuses and never falls back to a full review. `repairAllowed` stays true only for rounds 1 and 2; a finding in an extended round goes to the human.
- **R-7 Visibility:** the sealed verdict, the `<!-- code-review -->` comment and the `code-review` commit status carry `round N of 3, extended by <operator> at <time>: <reason>` for an extended round. The gate trailer is unchanged. The refusal text names the extend command and still names `report`.
- **R-8 Reference:** `references/code-review.md` is edited to rounds 1-5 with a fourth round only on a human record. The one-time reset of verdicts sealed before the edit is accepted and stated in the release notes.
- **R-9 Release and version:** the change ships in `1.0.0-rc.4` on `epic/harness-simplification` (amended 2026-11-02: `1.0.0-rc.3` was released first, from the epic tip `9ba94e7c`, without this phase; HS-45, HS-46 and HS-47 are already in it). The version is bumped by the assistant as the last PR of the epic, after the feature merges and the Codex package is regenerated, following the six-file pattern of `749604b9`; no tag or release without the operator.
- **R-10 First ticket:** spikes S1 (a four-deep needs-fix lineage under the raised bound), and S4 (older code reading a sealed round-4 verdict) are the acceptance of the first ticket, before the limit changes.
- **R-11 Tests:** without a record the limit still refuses; a record does not apply to another head, base or PR; a call from a host-child context is refused; several records cannot exceed the ceiling; consumption follows the derived rule, including the sequence round 4 → new push → new record.
- **R-12 Net code:** each delivery PR reports net lines including tests and names an offsetting deletion (the three copies of the refusal sentence, one shared round lookup at the three call sites); if the epic cannot be net-negative the operator grants the exception explicitly in the PR.
- **R-13 Refusal hints:** the `limit` refusal of `phase-code-review.cjs`, `deliver-dispatch.cjs build arch-review` and the host messages gets a named hint (and `status` without `--phase` a usage hint) so `refusal-hints.cjs` no longer prints `hint[BUILD_REFUSED]: … a reason this map does not name`; the hint names the extend command and `report`.
- **R-14 `report` is project-wide:** every text that offers `report` says it applies to the whole project until switched back, and the PR comment printed while it is on says so. The operator is told to restore `hold` when the PR merges.
- **R-15 Many fixes, one round:** fixes pushed between two reviews are one delta and cost one round. The record is written after the fixes settle; a record voided by a head move costs nothing, because a round is consumed only when a verdict is sealed. The ceiling of 5 is final: bot findings do not converge, so "until the bots are silent" is not a stop rule. After the ceiling the human decides from the findings on the PR, or switches to `report`.

## Consequences

- The operator gets a narrow, visible alternative to switching the whole project to `report`; the hold stays.
- ADR-032's single-exit and "no waiver store" statements are amended: the extension record is a second, per-PR exit.
- Code touches both `code-review-core.cjs`, `role-artifact.cjs`, three round-computation call sites (`phase-code-review.cjs`, `claude-role-host.cjs`, `codex-code-review-context.cjs`), the status and comment text, the reference and the generated Codex package; nine unit files that pin the cap change.
- Verdicts sealed before the reference edit stop counting once, on upgrade.
- The "only a human" guarantee is a convention, not enforcement; hardening `report` and authenticating the operator are separate decisions.

## Out of scope

- Changing the default `ROUND_CAP` (stays 3).
- Auto-repair in extended rounds.
- Other roles' limits (arch-review, integrator, sentinel, ci-fix, review-fix).
- Signing the record, a TTY or out-of-band human check, or hardening the `report` exit.
- A human GitHub approval fallback and a config-entry extension (Options C and D).
- A code-review field in the gate trailer.
- A `main` release and any tag.
- Retroactive unblocking of exhausted PRs other than by a new record.
