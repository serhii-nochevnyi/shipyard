---
status: accepted
---
# ADR-025 — phase47 runtime delivery correctness

- **Status:** accepted
- **Date:** 2026-10-03
- **Decision owner:** repository operator; explicit option A and GPG risk acceptance in INV-014 dialogue
- **Scope:** phase47 only; independent of phase48
- **Related:** ADR-014, ADR-017, ADR-021, ADR-022, ADR-023
- **UI design:** none

## Context

INV-014 completed four authenticated native research lines; original artifacts and durable receipts are linked in its EVIDENCE-INDEX.md and launch/research-verified.json. Baseline7eebae4812b3c67ccdbbb63c8c1603f7767b1466 plus reviewed uncommitted bootstrap is isolated dogfood, not a landed release. Existing detached execution, overhead API and exact-argv verification mechanisms already exist.

## Decision

- Choose option A: correct existing producer/consumer and actual planning caller seams; preserve native hosts, original dispatch/receipt identity and model/provider policy. Do not relocate all coordination into a new host-owned operation.
- Adopt the reviewed launch/INV/containment/runtime-failure bootstrap; separately verify semantic blocked/completed handback so artifact presence alone cannot claim completion. Own dispatch-record and planning-result-sealer changes and tests explicitly.
- Complete REQ-193 by connecting the supported planning-context caller to existing detach/wait and measured parent attribution; child model work remains separately attributed under the original dispatch. Unknown counters remain unknown; no savings claims without matched cohorts.
- Adopt the preserved notification recursion guard and bounded nested delegate sanitizer from INV012 work; validate supported lifecycle and legitimate callbacks safely without recreating an unbounded fork loop.
- Retain the unavailable historical GPG argv/log/candidate as an explicitly accepted unknown risk. Assign approved exact-argv candidate-bound trusted-host assertions before dispatch, preserve signing/isolation authority, and require disposable cleanup. Denial is not pass; genuine failures block and unknown/unapproved commands HOLD.
- Keep complete canonical ownership disjoint from phase48. Serialize shared changes within47; use existing overhead APIs without new phase48 schema dependence. One candidate packaging owner handles mechanical generated mirrors/manifests.
- Require standalone installed phase47 acceptance on the same baseline with phase48 changes absent, with authenticated provenance and original receipts. Reuse applicable evidence without repeating completed obligations blindly.

## Consequences

- Native three-role decomposition may now materialize phase47 tickets after Gate1 validation. Draft work packages remain planning inputs rather than executor contracts.
- Bootstrap and actual caller production acceptance, notification lifecycle, trusted-host GPG assertions and owned resource/handoff evidence remain delivery obligations.
- Wider option B and hold option C were rejected by explicit operator choice.

## Out of scope

- Phase48 review/cost policy, new sibling schema dependencies, provider fallback, automatic environment adjudication, signing relaxation, public release and broad resource cleanup during investigation/decomposition.
