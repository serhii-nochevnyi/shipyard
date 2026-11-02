# Risks

Condensed from the 22 risks (R-01..R-22) in `research/risks.md`. Anything with an open answer is also in OPEN-QUESTIONS.md.

## The model forges or reads the extension consent (R-01, R-02, R-03)
severity: high
mitigation: do not claim "only a human" in the ADR beyond what the chosen layer enforces; state the claim precisely (a role-hosted child cannot grant itself an extension; the same-user orchestrator is trusted) or add a layer the model cannot reach (GitHub identity of another human, out-of-band factor). A role-host refusal alone protects only the reviewer child, which is already sandboxed.

## The existing `report` exit stays model-writable (F7, R-17)
severity: high
mitigation: decide whether "only a human" must be stronger than `report` or only no weaker (U-15); hardening `report` is a separate change if required. `report` is project-wide, not per PR; the "for this PR" wording is wrong and should be corrected whichever option is chosen.

## Replay-depth bound rejects round 4 or 5 (R-12, F3)
severity: high
mitigation: use an absolute ceiling at seal and replay (`role-artifact.cjs:3146,3190`) separate from the per-PR limit; confirm with spike S1 before decomposing.

## Consumed-versus-voided hole in the limit arithmetic (R-06, F6)
severity: high
mitigation: record consumption (a manifest field in the sealed verdict) or define the limit as `used < ROUND_CAP + consumed + valid unconsumed`; test the sequence round 4 under E1, push, E2.

## Head moves after consent (R-04, R-09)
severity: medium
mitigation: bind the record to the head to be reviewed and tell the operator to write it after their own fix push; bot and `review-fix` pushes void it and cost re-consent; a rebase already resets the count today.

## Editing the reviewer reference resets every in-flight PR (R-13, F4)
severity: medium
mitigation: leave `references/code-review.md` byte-identical, or accept a one-time reset and say so in the release notes; move the round wording out of the hashed file only by explicit decision.

## Trailer cannot carry the visibility line (R-14)
severity: medium
mitigation: carry "round N of 3, extended by …" in the PR comment and the `code-review` status text, not the `merge-gate` trailer (8-12 characters free); an addition to `gate-trailer.cjs` vocabulary affects every reader.

## Free-text reason and operator identity in a public comment (R-15)
severity: medium
mitigation: bound and sanitize the reason; take the operator identity from a source the caller cannot choose (git or GitHub identity), not a flag; the comment policy stays blocking.

## Extension consumed by an incomplete review (R-07) and extended-round finding with no auto-fix (R-08)
severity: medium
mitigation: consume only on a counted complete verdict; bound retries of an incomplete extended round; a finding in an extended round goes to the human by design (operator scope).

## Rollback leaves sealed round-4 verdicts that older code cannot read (H3)
severity: medium
mitigation: guard `priorCodeReviewVerdicts` so old code reports `limit` instead of throwing; verify by spike S4.

## ADR-032 reversal and the simplification direction (R-10, R-11)
severity: medium
mitigation: amend ADR-032 explicitly for whichever option is chosen; name an offsetting deletion (for example the three copies of the refusal sentence) or have the operator grant an exception.

## No second human account in single-operator repositories (R-21)
severity: medium
mitigation: ask which target repositories have one (U-14) before choosing Option C.

## Cost of rounds 4 and 5 and crash consistency (R-18, R-22)
severity: low
mitigation: a `delta` extended round only; define the order seal → consume → publish so a crash cannot lose or double-spend a grant.

## Net-code rule for the delivery PRs is not yet defined (U: "removes more than it adds")
severity: medium
mitigation: each delivery PR reports net lines including tests; name an offsetting deletion in the same epic (for example collapse the three copies of the refusal sentence and the duplicated round computation at the three call sites into one shared lookup); if the epic cannot be net-negative the operator grants the exception explicitly in the PR.

## Incident build and verdict records were not read (pdffiller-mcp)
severity: low
mitigation: the design does not depend on them; before release, compare the incident verdicts' `contract_digest` with the rc.3 reference digest to learn whether the edit unblocks that PR.

## Rebase or force-push already resets the countable history
severity: low
mitigation: unchanged existing behaviour; records bound to a head that is no longer an ancestor are void and do not count toward the ceiling.
