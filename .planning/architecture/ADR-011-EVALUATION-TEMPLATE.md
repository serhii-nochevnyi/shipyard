# Optimization experiment report — <experiment-id>

Copy this template to `docs/audits/optimization/<date>-<experiment-id>.md`.
It is a template, not a completed experiment or a successful gate result.

- Status: planned | collecting | evaluating | complete
- Related ADR / work package / backlog item:
- Hypothesis and one behavior being changed:
- Baseline revision / runtime / policy / collector version:
- Treatment revision / runtime / policy / collector version:
- Provider and opaque account scope (no credentials):
- Collection dates / timezone / subscription window reset identifiers:
- Cohort assignment rule and task size/risk bands, fixed before collection:
- Sample target and minimum quality observation window:
- Rollback action and owner:

## Coverage and exclusions

| Measurement | Baseline | Treatment | Missingness / confounders |
|---|---|---|---|
| Started / completed / failed / parked / interrupted tickets | unknown | unknown | |
| Dispatch attribution coverage | unknown | unknown | |
| Finalized output coverage | unknown | unknown | |
| Projects / devices represented | unknown | unknown | |
| Subscription samples and reset boundaries | unknown | unknown | |
| Unattributed shared orchestration/planning overhead | unknown | unknown | |

Never exclude a failed treatment run to improve the savings figure. Document
collector failures, concurrent external activity, changed reviewers/models and
unmatched cohort differences. A missing observation is not zero usage.

## Usage and outcomes

Report by provider/model/role/backend and cohort; include sample sizes, medians,
p90 and uncertainty, with the underlying versioned aggregate artifact path.

| Metric | Baseline | Treatment | Change | Gate / interpretation |
|---|---|---|---|---|
| Ordinary input per verified completion, all attempts included | unknown | unknown | unknown | |
| Uncached input / cache creation / cache read separately | unknown | unknown | unknown | |
| Advisor input and output separately | unknown | unknown | unknown | |
| Reported output and completion coverage | unknown | unknown | unknown | |
| Orchestrator model turns per verified completion | unknown | unknown | unknown | |
| Subscription window delta, only when attributable | unknown | unknown | unknown | |
| Autonomous completion rate | unknown | unknown | unknown | |
| End-to-end median / p90 latency | unknown | unknown | unknown | |
| Escaped defects by severity / reopens | unknown | unknown | unknown | |
| False greens / invalid carries / skipped gates | unknown | unknown | unknown | |
| Duplicate dispatch / orphaned work / lost handoff constraints | unknown | unknown | unknown | |

## Verification and independent quality review

- Commands, fixtures and revisions exercised:
- Failure-injection results and artifact links:
- Independent reviewer and matched patch sample:
- Post-merge observation dates and any remaining uncertainty:
- Required gate evidence preserved:

## Decision

- Verdict: promote | continue_trial | rollback | inconclusive
- Evidence supporting the verdict:
- Metrics that failed or remain unavailable:
- Effective policy version after the decision:
- Rollback verification, if applicable (do not revive a superseded session owner):
- Next hypothesis; linked new/reopened backlog item:
- Required ADR amendment, if policy changes:

A completed report does not automatically change runtime policy, create Jira
issues or start another wave. Promotion follows the recorded rollout gates.
