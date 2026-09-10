# ADR-011 backlog coverage register

- **Snapshot**: 2026-09-10, source HEAD `7559ef0d673bee3bd9bd8e9c8403edf9d486c375`.
- **Inventory**: 39 source notes. This is a complete file inventory, not a claim that every historical finding remains open.
- **Plan**: [execution waves](ADR-011-ROLLOUT.md).
- Selected entries feed the design. At OPT-02, split notes into individual items and attach current-source verification and landed closure evidence.
- Items outside this optimization program remain discoverable; no note is deleted, archived or silently marked closed.

| Source note | Planned destination | Evidence / disposition |
|---|---|---|
| [A child's PR base is its MERGE TARGET, not just its review diff](../backlog/a-childs-pr-base-is-its-merge-target-not-just-its-review-diff.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [A clean merge can duplicate a block two branches added alike](../backlog/a-clean-merge-can-duplicate-a-block-two-branches-added-alike.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [A conform verdict does not survive a base-merge that changes nothing](../backlog/a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing.md) | OPT-11 | Historical precursor; existing carry is already implemented. Scope only the remaining manual-merge path. |
| [A count where a set was needed, twice more — verified in-repo](../backlog/a-count-where-a-set-was-needed-twice-more.md) | OPT-12 | Related historical lead; extend current distinct-agent accounting, do not assume count bug persists. |
| [A cross-phase dependency is satisfied on main and never reaches the child's tree](../backlog/a-cross-phase-dependency-never-reaches-the-childs-tree.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [A disabled reviewer has no way to say so](../backlog/a-disabled-reviewer-has-no-way-to-say-so.md) | OPT-04 | Selected; reviewer constants found in current source. Preserve enabled Copilot independently. |
| [A missing routing signal silently resolves to the more expensive tier](../backlog/a-missing-signal-resolves-to-the-dearer-tier.md) | OPT-03, OPT-10 | Historical policy lead; do not recreate already-fixed absent-signal routing. |
| [The epic-key NUL separator makes `state-sync.cjs` binary to every grep](../backlog/a-nul-key-separator-makes-a-script-binary-to-grep.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [A wiring line no test asserts — delete it and every suite stays green](../backlog/a-wiring-line-no-test-asserts.md) | All packages: caller verification | Historical lead; validate actual caller and installed path, do not assume the original line is still broken. |
| [An acceptance criterion that cannot fail](../backlog/an-acceptance-criterion-that-cannot-fail.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [An Agent spawn with no `model` takes the session default, silently](../backlog/an-agent-spawn-with-no-model-takes-the-session-default-silently.md) | OPT-03 | Selected; observed-model reconciliation, not a second resolver. |
| [base-merge refuses on the two scratch files the conveyor itself writes](../backlog/base-merge-refuses-on-the-scratch-files-the-conveyor-itself-writes.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [Config warnings should name the namespace the value actually came from](../backlog/config-warnings-name-the-namespace-the-value-came-from.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [A diamond child's worktree is missing its non-primary parents' code](../backlog/diamond-child-base-is-materially-incomplete.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [drift-gate takes ONE baseRef while a cascade gives every ticket its own](../backlog/drift-gate-judges-one-base-for-a-whole-cascade.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [epic-branch.sh ensure: warn when the local base is ahead of origin](../backlog/epic-cut-silently-behind-origin.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [The front cannot see "dispatched to an executor"](../backlog/front-has-no-in-flight-state.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [GSD normalises `claude-fable-5` into the `fable` alias, which now means 5.1](../backlog/gsd-collapses-claude-fable-5-into-the-alias.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [`log-event` does not refresh the front; `dispatch-record` does — and the loop must know which](../backlog/log-event-does-not-refresh-the-front-but-dispatch-record-does.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [The conveyor's own repo has no CI, so it cannot dogfood drive-to-green](../backlog/no-ci-in-the-conveyors-own-repo.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [Nothing forbids `--no-verify` in a fixer prompt](../backlog/nothing-forbids-no-verify-in-a-fixer-prompt.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [Nothing wakes a run whose only remaining state is "waiting"](../backlog/nothing-wakes-a-run-that-is-only-waiting.md) | OPT-06, OPT-08 | Related historical lead; recheck current wait/stop owners before creating a fix. |
| [On Codex the `-deep` variants became unreachable by their own evidence rule](../backlog/on-codex-the-deep-variants-became-unreachable-by-their-own-evidence-rule.md) | OPT-03, OPT-10 | Partial closure in note: T-28-09 fixed attempt wiring; remaining capability policy is selected. Recheck backend schemas. |
| [A fixer is told a fact by the orchestrator, and no gate ever checks it](../backlog/orchestrator-facts-reach-fixers-unverified.md) | OPT-07; existing REQ-84 | Coordinate with phase 30 verification-first work; do not duplicate its prompt sweep. |
| [Phase 20 follow-ups (surfaced during delivery, out of scope for its tickets)](../backlog/phase-20-followups.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [Phase 22 follow-ups](../backlog/phase-22-followups.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [Phase 24 follow-ups](../backlog/phase-24-followups.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [Phase 26 follow-ups](../backlog/phase-26-followups.md) | OPT-02 | Multi-item historical collection; current-source triage required. |
| [Phase 27 follow-ups](../backlog/phase-27-followups.md) | OPT-02; cross-cutting verification | Multi-item historical collection with explicit closures. Split items; no file-level closed/open assumption. |
| [pipeline-stats says a person merged what the guard merged](../backlog/pipeline-stats-says-a-person-merged-what-the-guard-merged.md) | OPT-01, OPT-13 | Related attribution lead; verify current actor writer before planning a fix. |
| [The attempt backstop cannot tell five real fixes from five retries](../backlog/the-attempt-backstop-cannot-tell-five-real-fixes-from-five-retries.md) | OPT-09 | Selected; verify current review-signature path before decomposition. |
| [The backlog is thirty-six files no tool can find](../backlog/the-backlog-is-thirty-six-files-no-tool-can-find.md) | OPT-02, OPT-13 | Selected; current inventory has 39 notes, not the historical 36. |
| [The carry window closes on exactly the merge that needs judgement](../backlog/the-carry-window-closes-on-exactly-the-merge-that-needs-it.md) | OPT-11 | Selected; retain both head-tree and base-tree proof plus live-head race checks. |
| [Four things around the dispatch record, one of them a claim I wrote and got wrong](../backlog/the-dispatch-records-periphery.md) | OPT-03 | Historical multi-item note; route grammar/writer/agent-file fixes already appeared in prior audit. Split and revalidate before promotion. |
| [The orchestrator's own context is the conveyor's largest line item](../backlog/the-orchestrators-own-context-is-the-largest-line-item.md) | OPT-01, OPT-06, OPT-07, OPT-08 | Selected; replace historical cost multipliers with deduplicated baseline. |
| [The gsd-core pin has eleven sites; the new guard knows five — and two of them should not exist](../backlog/the-pin-has-eleven-sites-and-the-guard-knows-five.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [The project checkout itself can become the stale `.planning/` copy](../backlog/the-project-checkout-itself-can-become-the-stale-planning-copy.md) | OPT-02, OPT-08 | Related recovery lead; checkpoint pins source revision and successor revalidates. |
| [The stop gate enforcing this session predates the fix for this exact case](../backlog/the-stop-gate-enforcing-this-session-predates-the-fix-for-this-exact-case.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |
| [Two claims in our own tree that source-checking disproved](../backlog/two-claims-in-our-own-tree-that-source-checking-disproved.md) | OPT-02 inventory; no behavior change assigned | Untriaged for current source; retain as a candidate, not an approved new defect. |

## Promotion rules

1. Verify each item against the landed source and name the command/test and revision.
2. If closed, attach the landed commit and verification; if partially closed, split the remaining item.
3. Link existing ADR/phase ownership before creating a new work package. REQ-84 stays owned by phase 30.
4. Promote only a verified gap; generate the PLAN and graph through normal decomposition.
5. At experiment review, update the item with measured outcome and retain its original source.

## Deliberately not bundled

Historical configuration, installer, graph, worktree and scope-gate findings are
not automatically token-optimization tickets. OPT-02 first identifies which are
still open and whether an existing phase owns them. A severe current defect
can be prioritized through a separate justified plan; inventory coverage does
not authorize unrelated implementation.
