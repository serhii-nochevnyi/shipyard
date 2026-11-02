---
status: closed
closed: 2026-11-02
adr: .planning/architecture/ADR-035-human-granted-review-round.md
---

# Problem

## What we are solving
Decide whether and how the phase code review (`phase-code-review.cjs`, `code-review-core.cjs`) may run a round beyond the fixed cap of three (`ROUND_CAP`), but only when a human explicitly allows it. Target release: 1.0.0-rc.2. Source base: branch `epic/harness-simplification` (tip `749604b9`, `RC2-final`), not `main`; line references below are against that base.

The proposal under investigation (operator, 2026-11-02):
1. Explicit extension in the core: the effective limit becomes `ROUND_CAP` plus the sum of permitted extensions for this PR. An extension is a separate record written by an operator command, for example `phase-code-review.cjs extend --phase 9 --pr 180 --rounds 1 --reason "..." --confirm extend-review-round`, modelled on `planning-untrack.cjs --confirm untrack-planning`.
2. Only a human may permit: written by the operator in a terminal, refused when the model calls it through a role host. The record lives outside the worktree (`~/.local/state/shipyard/`) and is signed the way verdicts are, so the model cannot write its own consent.
3. Bounds: one round per record, an overall ceiling (for example 5), the record bound to head and base at permission time (a moved head voids it), the extra round always a delta from the last counted verdict, `repairAllowed` stays for rounds 1-2 only so an extended-round finding goes to the human.
4. Visibility: the verdict, the `<!-- code-review -->` comment and the gate trailer carry `round 4 of 3, extended by <operator> at <time>: <reason>`; the refusal text names the extend command instead of "no override flag and no waiver record".
5. Tests: no record means the limit still refuses; a record does not apply to another head, base or PR; a call through a role host is rejected; the ceiling cannot be bypassed with several records.

The investigation must return evidence, two to four alternatives (including a minimal-change option and the existing exit, `code_review: report`), their costs and risks, and a user-selected design.

## For whom
Shipyard operators who merge the phase epic PR into the integration branch (`main`), and the conveyor's code-review, integrator and sentinel stages that read the review state. Shipyard maintainers.

## Current pain
Origin (stated by the operator, 2026-11-02): a current Claude session in `/Volumes/KINGSTON/PhpstormProjects/pdffiller-mcp`, branch `research/mcp-tools-ai-pdf-12908`, hit the three-round cap of the phase code review. The only exit that ADR-032 defines is the operator switching `delivery_pipeline.code_review` to `report` for that PR (`phase-code-review.cjs:87-90`), which lifts the hold for the whole PR rather than granting one more review of one head. `nextRound` returns `limit` as soon as the countable verdicts reach `ROUND_CAP` (`code-review-core.cjs:338-340`).

Known tensions the investigation must resolve, not assume away:
- ADR-032 (accepted) states that the hold's one defined exit is the operator setting the mode to `report`, that "no waiver store is added", and lists "a waiver store" under Out of scope. The operator chose to treat this proposal as an amendment of ADR-032.
- The operator's simplification direction of 2026-10-27 (smaller harness, no new contract ids, each change removes more than it adds) is a design constraint, not a nice-to-have.
- "Only a human" has to be enforceable. A confirmation token typed after a flag (`planning-untrack.cjs`) is not evidence of a human, and the verdict-signing key is a same-user file under `~/.local/state/shipyard/role-artifact-authority/`; the investigation must establish what a model running as the same OS user can and cannot do.

## What success will be
A decision, backed by cited evidence, on one of: keep the single `report` exit; add a human-gated, bounded, visible extension; or a smaller mechanism. If an extension is chosen, its authority model (what makes it human-only), its binding to head/base/PR, its ceiling, where its state lives, how it is shown to the merging human, and the tests that pin it are specified well enough to decompose. Definition of done: the accepted design holds on both runtimes (Claude and Codex hosts) and does not weaken exact-head verdict binding, receipts or the ADR-014 boundary.

## What is definitely out of scope
- Changing the default `ROUND_CAP` (stays 3).
- Auto-repair in extended rounds: `repairAllowed` stays for rounds 1-2 only.
- Other roles' limits (arch-review, integrator, sentinel, ci-fix, review-fix).
- Retroactively unblocking already exhausted PRs by any means other than a new, human-written record.
- No production changes, tickets, PRs, commits or edits to target projects during the investigation (including the `pdffiller-mcp` repository, which is read-only evidence).
- No bypass of provenance, receipts or host admission; no switching runtime or provider; no model-policy changes (ADR-014 stays as is).
