# Phase 29 integration — 2026-09-10

Verdict: passed (repository-verifiable acceptance)
Reviewed epic: 878c2d28a7a40d7e05605060b9c0f8b1ec79cc26
Epic tree: 46d09f1d6d17c4c3b34600d8e0ab6a3b939ddf46
Review mode: inline Codex; no separate agent dispatch is claimed.
Epic PR: https://github.com/serhii-nochevnyi/shipyard/pull/85

## Completion

T-29-01 through T-29-08 are merged into the epic. T-29-07's graph invocation
ambiguity was fixed in PR 90; the live scope/merge gate verified all three
paths. The integration race below was fixed in PR 91, and sentinel verified
all five amended declared paths in the epic. Both PRs had current-head green
CI, no unresolved review threads and conform trailers when merged.

## Integration finding and closure

P1: recordProjection recomputed pendingItemFor without binding it to the action
performed. Repro: plan pr-open/In Progress -> append merged/Done -> record an
In Progress transition -> watermark merged -> no remaining item.

T-29-08 now requires the performed --to, rejects stale identity under the lock,
and rejects a provided target status that disagrees. Missing/unknown to and the
race are covered through real temporary graphs and CLI/library paths. Three
regression cases failed before the fix and passed after it. Log-event recovery
instructions and acting-half usage carry the new required identity. ADR-008 D5
has a dated amendment; historical T-29-05/06 signatures are superseded by it.

## Cross-ticket acceptance and evidence

- Configuration: empty map/disabled Jira emits no action; one shared status
  vocabulary and loadConfig retain namespace precedence and warnings.
- Store/planner: pure local planning, forward-only watermark, replay and journal
  anchoring, unreachable suppression and append-failure rollback are exercised
  by jira-project and record-stores tests.
- Recorder/acting half: owned journal event, required transition ID, performed
  item identity, target-status lookup and no direct tracker client in scripts.
- Wiring: judgment-contract proves the planner call is in deliver.md; source
  contracts retain the forbidden-key sweep. The projection stays outside
  state-sync/front/stop-gate execution.
- Verification rerun on the final ticket tree:
  `node --test tests/unit/jira-project.test.cjs tests/unit/record-stores.test.cjs tests/unit/judgment-contract.test.cjs tests/unit/source-contract.test.cjs` — exit 0.
- `make test-fast` passed locally on the functional fix; current-head CI passed
  on PR 91 after the final guidance edits. Epic CI is checked separately before
  any integration-branch merge.
- `git rev-parse origin/epic/29-the-tracker-is-a-projection-and-a-projection-is-driven^{tree}`
  equals the verified T-29-08 HEAD tree above. Combined epic diff: 136,018 bytes,
  estimated 34,005 input tokens; policy resolved from the main project config.

## Remaining boundary

Live Jira witnessing is explicitly owed to a configured proving-ground project
under ADR-008 D7; this repository has Jira disabled. No live tracker transition
was performed or claimed. Epic-to-main remains the integration approval boundary.
The old Claude process was not resumed or terminated; its remaining delivery work
was taken over in Codex, with project runtime/skill names changed accordingly.
