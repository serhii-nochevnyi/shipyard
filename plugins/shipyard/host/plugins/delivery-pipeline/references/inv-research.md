# investigation research agents (fan-out)

Four parallel research lines launched by /shipyard:investigate at INV start.
Each agent gets the problem statement + this brief and writes one complete,
line-scoped artifact. The callback returns only a bounded summary and the
trusted reference to that file; the full finding never travels through the
orchestrator transcript.

## Bounded handback contract

The investigation command passes `artifactContract: planning.v1` together with
the authenticated source revision, repository identity, policy hash, and one
contained path per canonical line under `artifactPaths`:

```json
{
  "id": "system-state",
  "status": "completed",
  "summary": "short bounded account",
  "artifact": {
    "path": "<the exact artifactPaths.system-state file>",
    "bytes": 1234,
    "content_bytes": 1234,
    "sha256": "<64 hex characters>",
    "digest": "<the same 64 hex characters>"
  }
}
```

`summary` is plain text of at most 500 characters; put everything else in the
artifact file; return the JSON object only, with no prose after it.

`artifact` is input to the host-owned trusted consumer. After the boundary
receipt is verified, the consumer checks that the file is inside the
investigation worktree, is immutable for the dispatch, and matches its digest.
The consumer seals a `shipyard.role-artifact.v1` envelope with schema
`shipyard.research-result.v1`, subject `<INV-ID>:<line-id>`, the exact
`source_revision`, `repository`, `policy_hash`, and an `artifact_index`
reference. The shared Claude adapter validates those identity fields and
returns only `artifact_ref`, `artifact_digest`, `artifact_index`, `status`, and
the capped `summary`.

Every completed or blocked line must have its own complete file. Missing or
duplicated canonical lines, a stale source revision, a foreign repository or
policy hash, an altered artifact, and a forged application receipt are hard
errors. A blocked line is an explicit bounded result with its full reason in
the file; it is never synthesized from a missing artifact.

## Verification contract

Every checkable claim about the codebase, a test, delivery state, or a completed
action must name the exact command that checked it and the relevant path,
output, or exit status. If a claim cannot be checked by a command, label it as
an assumption or unknown and state the next check. A claim without
command-backed evidence is not verification.

## Line 1 — system state (→ RESEARCH.md "Current system state")
Map how the affected part of the system works TODAY: entry points, data flow,
key modules, existing tests, known warts. Cite file paths. Use
`.planning/codebase/` maps if present (`/gsd-map-codebase` output) instead of
re-discovering.

**When the problem statement is "X does not happen in <env>", deployment state
is hypothesis #1, not the fallback.** Before any code-level root-cause work,
prove the code you are investigating is actually THERE: find the commit that
implements X, check it is on the integration branch (`git branch --contains`,
`gh pr view` on the PR that shipped it), and check it is in <env>'s deployed
build — then say so, with the deploy timestamp if reachable. Field record: at
least three investigations chased behaviour that lived only in an unmerged PR
or an undeployed build; each burned a full hypothesis-and-disprove cycle on a
"defect" that was absence. Absence of the code explains absence of the
behaviour completely — no defect analysis survives skipping this check.

## Line 2 — alternatives & prior art (→ OPTIONS.md draft)
Enumerate 2–4 genuinely different approaches (including "do nothing" /
"buy not build" where sane). For each: sketch, cost/complexity, risks,
what it forecloses. Comparative table mandatory. No recommendation yet —
options belong to the human.

## Line 3 — constraints (→ RESEARCH.md "Constraints" + seeds for CONSTRAINTS)
Hard technical constraints (compat promises, schema/migration limits, perf
budgets, security boundaries), product constraints (flows that must not
change, flags policy), delivery constraints (review/PR conventions, CI gates).
Each constraint: source (file/doc/person) + confidence.

## Line 4 — risks & unknowns (→ RISKS.md + OPEN-QUESTIONS.md drafts)
What can bite: integration risks, data risks, rollout risks, org risks.
Every unknown becomes an OPEN-QUESTIONS.md checkbox item
(`- [ ] <question> — owner: <who can answer>`); do not silently absorb
unknowns into prose.

## Shared rules
- Read-only with respect to product code: write only the assigned complete
  research artifact and the investigation files requested by the command; do
  not change source code or create planning scaffolding.
- If a hypothesis needs empirical validation by throwaway code, do not do it —
  recommend a `/gsd-spike "<idea>"` instead and list it in the draft.
- Every claim about the codebase carries a file path; every external claim
  carries a source.
