# Phase 38 plan check

## Verdict

Phase 38 keeps its original scope and has six implementation tickets after the
merged model-ID pin. The revised plans now account for the live Claude agent
failure, Codex's label-only typed callback, missing signed-commit support, and
plugin-reference paths that the child sandbox cannot read. The phase is not
implemented or ready to close; those behaviors require code, runtime evidence,
review, and green checks.

PR #191 and PR #192 are open. `gh pr view 191 --json reviewDecision,statusCheckRollup`
and `gh pr view 192 --json reviewDecision,statusCheckRollup` report successful
`test-fast` checks and no review decision. T-38-04 now depends on T-38-03 to
reuse the shared signed-commit finalizer, so PR #192 must be stacked on that
parent before delivery. `node plugins/delivery-pipeline/scripts/validate-graph.cjs`
passed in the epic worktree after plan consolidation: 144 tickets, 20 computed waves, no blocking
errors. The only Phase 38 graph warning is the expected T-38-05 join of
T-38-04 and T-38-06; the new file-path warnings identify files those tickets
will create.

## Goal-backward coverage

| Requirement | Covered by | Result |
|---|---|---|
| REQ-113 provider-pure host paths | T-38-03, T-38-04, T-38-05 | Planned |
| REQ-114 Claude selection and delivery evidence | T-38-02, T-38-03, T-38-05 | Planned |
| REQ-115 Codex selection and delivery evidence | T-38-04, T-38-05 | Planned |
| REQ-116 durable application receipts | T-38-01 through T-38-06 | Planned |
| REQ-120 independent provider rollout | T-38-01, T-38-02, T-38-04, T-38-05 | Planned |
| REQ-121 GPT-6 Codex IDs and Luna/max base | T-38-01, T-38-04 | Planned |
| REQ-122 Claude Opus 5.5 and exact-session evidence | T-38-01, T-38-02 | Planned |
| REQ-123 native subscription authentication | T-38-05 | Planned |
| REQ-124 exact typed GSD agent application | T-38-03, T-38-04, T-38-06 | Planned |

## Structural checks

- T-38-02 uses the exact `transcript_path` returned by the launched Claude
  session's `SessionStart` hook. Ordinary launches retain `--restricted`; typed
  GSD launches pass `--agent <role>` without that flag while keeping strict MCP,
  explicit tools, and the worktree sandbox. The hook writes to a private
  host-side temporary file that is excluded from model writable paths and
  denied to Claude filesystem tools. The launched hook and transcript must
  independently agree on the agent role.
- T-38-03 connects Claude delivery and investigation. It resolves only
  allowlisted Markdown references and supplies their contents to the child; it
  owns script execution, Git publication, and the shared host-side signed
  commit finalizer.
- T-38-04 depends on T-38-03. Codex enables native `multi_agent` and must launch
  a child with the requested GSD role, explicitly supplying the resolver's
  model and reasoning effort to the native spawn call. A caller's `gsd_role`
  field or the parent's model is not application evidence. Native child
  metadata must bind role, actual model, effort, and exact parent thread. The
  host verifies the installed agent file and digest before launch; when native
  `agent_path` is present, it must match that file. Codex delivery also uses
  the shared signed finalizer.
- T-38-06 supplies the Claude typed-GSD decomposition entrypoint. T-38-05
  connects both decomposition hosts to `/shipyard:decompose` after they exist.
- T-38-05 routes `/shipyard:deliver`, `/shipyard:investigate`, and
  `/shipyard:decompose` only to provider paths that implement the entire
  resolve → validate → launch → receipt flow.
- Claude and Codex remain provider-pure. Capability smokes do not call a model;
  each provider has one opt-in real smoke in a disposable worktree.
- Ticket plans specify negative tests for missing or contradictory evidence,
  role mismatch, sandbox denial, out-of-scope changes, stale branch state, and
  unsigned commits. Live evidence cannot be synthesized from fixtures.
- Jira remains disabled and no Jira tickets are part of this phase.

## Dependency order

T-38-01 is merged. T-38-02 is the prerequisite for T-38-03, T-38-04, and
T-38-06. T-38-03 provides the shared commit finalizer, so T-38-04 follows it.
T-38-06 can proceed in parallel with T-38-03/T-38-04. T-38-05 waits for
T-38-04 and T-38-06, which transitively includes T-38-03 and T-38-02. Because
the graph cascades from only one same-phase parent, T-38-05 must start from an
epic head that contains both landed parent commits.

## Remaining proof

1. Pass each ticket's scoped unit tests and `make test-fast` in CI.
2. Run one opt-in live Claude smoke and one opt-in live Codex smoke. Each must
   record real model/effort; typed decomposition must also prove its native
   agent identity; delivery must prove host-created signed commits and denial of
   child access to Git metadata and the GPG agent.
3. Complete architecture review and all GitHub review/CI gates before merge.
4. Complete T-38-05 integration and phase verification before release.
