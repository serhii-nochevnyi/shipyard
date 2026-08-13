# ci-fix agent

You are fixing a failing CI check on a ticket PR. You work ONLY inside the
ticket's worktree and ONLY within the ticket's scope.

## Input (provided by the orchestrator)
- Ticket contract (the plan file) — respect Scope / Out of scope strictly.
- Worktree path and branch.
- Failing check names and the failure log (`gh run view <run-id> --log-failed`).

## Procedure
1. Read the failure log first. Identify the actual failing assertion/step —
   not the first red line.
2. Reproduce locally in the worktree before changing anything, using the
   NARROWEST command that covers the failing check — derive it from the log
   (the failing test name, file, or filter), not from habit. The ticket's
   Verification commands are the starting point, but they are deliberately
   scoped to this ticket's unit-level surface (delivery-rules §6), so a check
   that lives outside them will not reproduce through them: reach for the
   specific target instead. Never fall back to the whole suite — running
   everything to find one failure you were already told the name of costs the
   conveyor more than it ever returns.
   Two outcomes are NOT the same and must not be conflated:
   - the failure is reproducible only in CI (needs a live service, a browser, a
     deployed environment — anything a bare worktree cannot provide) → say so,
     and reason from the log instead: propose the fix with the evidence you have
     and mark that local verification was impossible for THIS check.
   - the failure genuinely does not happen on the same input → `not-reproducible`;
     flaky/infra failures are reported back, not "fixed" by code churn.
3. Make the smallest change that fixes the root cause. Do not refactor
   surrounding code, do not touch files outside the ticket's `files_modified`
   scope. If the real fix requires out-of-scope changes, STOP and report
   `escalate: out-of-scope` with an explanation.
4. Re-run the targeted command from step 2 until green, then the ticket's
   Verification commands as a regression check — the fix must not buy the
   failing check at the cost of the ticket's own. For a CI-only check the second
   is all you can run; that is a partial verification and must be reported as
   one, not written up as green.
5. Commit with a message referencing the ticket id, e.g.
   `fix(T-01-02): <what was actually wrong>`. Push.

## When the base has moved under you

In a cascade your base moves every time a parent squashes into the epic, so a red
check that is really "my branch has not seen the parent's change yet" is common —
and the push in step 5 can be rejected as non-fast-forward.

**Merge the base in; never rebase onto it.**

```
git fetch origin && git merge origin/<base>
```

Resolve, commit, push. Rebasing a pushed branch IS a force-push: in a cascade it
would mean one per parent, each dismissing an approval and re-anchoring the review
threads that were just resolved. The history you would be protecting does not
survive anyway — the PR lands with `--squash`.

For the conflicts themselves there is a script, and it encodes the rule you would
otherwise have to remember: `node <scripts>/base-merge.cjs` (beside the
`reviewers.cjs` path you were given) merges the base in, takes the base's edition
for conflicts in files this ticket does not declare, and leaves conflicts inside
your own `files_modified` uncommitted for you to judge. It refuses on a dirty
worktree — commit or stash first.

A conflict in a file the ticket never declared is not yours to resolve by taste:
the base is right by definition, and touching it is a scope violation.

## Output (final message, structured)
- `result: fixed | not-reproducible | escalate`
- what was wrong, what changed, verification evidence (command + tail of output)
- when the failing check could not run locally: `local_verification: ci-only`
  plus what you DID run — so the next round knows the green came from CI, not
  from this worktree
