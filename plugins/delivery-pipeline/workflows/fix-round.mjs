export const meta = {
  name: 'pipeline-fix-round',
  description: 'Contour 3 Step 4: run ONE parallel fix pass across all open PRs that need work (CI fixes + review-thread replies), each in its ticket worktree',
  phases: [{ title: 'Fix', detail: 'one fixer per open PR needing work' }],
}

// ── args contract (built by /shipyard:deliver each babysit round) ───────────
//   args = {
//     prs: [ {
//       id,              // ticket id
//       pr,              // PR number
//       branch,
//       worktreePath,    // the ticket's EXISTING worktree (created at execute time)
//       planPath,        // ticket contract, for scope discipline
//       needsCiFix,      // bool — checks are failing
//       needsReviewFix,  // bool — unresolved review threads exist
//       model,           // optional; default opus[1m]
//     } ],
//     ciFixRefPath,      // abs path to references/ci-fix.md
//     reviewFixRefPath,  // abs path to references/review-fix.md
//     reinitScript,      // abs path to scripts/reviewers.cjs
//   }
// returns: [ { id, pr, pushed, status: 'fixed'|'no-op'|'escalate', notes } ]
//
// This is ONE round. The main loop keeps control of everything stateful:
// attempts counter, CI waits, arch-review, the conform gate, and human
// escalation. Fixing is what parallelizes across PRs; gating does not.
//
// ci-fix and review-fix are both opus[1m], so a single fixer agent per PR can
// own both roles coherently. arch-review (Opus 4.8 1M, judgment) stays in the main
// loop. Each agent pushes at most once and re-inits reviewers itself.
//
// NOTE ON SYNTAX: `node --check` on this file fails with "Illegal return
// statement" — expected, not a bug. The Workflow runtime wraps the body in an
// async function (top-level `await`/`return` is the documented DSL). Syntax-
// check by wrapping first (see the smoke-test canary).

const OUT = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'pr', 'pushed', 'status', 'notes'],
  properties: {
    id: { type: 'string' },
    pr: { type: 'integer' },
    pushed: { type: 'boolean' },
    status: { enum: ['fixed', 'no-op', 'escalate'] },
    notes: { type: 'string', description: 'what was wrong, what changed + verification evidence, or the escalation reason' },
  },
}

const prs = (args && args.prs) || []
const ciRef = args && args.ciFixRefPath
const reviewRef = args && args.reviewFixRefPath
const reinitScript = args && args.reinitScript

if (!ciRef || !reviewRef || !reinitScript) {
  throw new Error('fix-round: args.ciFixRefPath, args.reviewFixRefPath and args.reinitScript are required')
}
if (!prs.length) return []

phase('Fix')

return await parallel(
  prs.map((p) => () => {
    const steps = [
      `You are fixing PR #${p.pr} for ticket ${p.id}. Your working directory is the worktree: ${p.worktreePath} (branch "${p.branch}"). cd into it.`,
      `Ticket contract (respect Scope / Out of scope STRICTLY): ${p.planPath}.`,
      ``,
    ]
    if (p.needsCiFix) {
      steps.push(
        `A) CI is failing. Read your ci-fix instructions and output rules from: ${ciRef}.`,
        `   Get the failure log yourself: gh run view --log-failed (for this PR's latest failing run). Reproduce locally before changing anything.`,
        `   Make the SMALLEST in-scope fix. If the real fix needs out-of-scope changes → stop and return status "escalate".`
      )
    }
    if (p.needsReviewFix) {
      steps.push(
        `B) There are unresolved review threads. Read your review-fix instructions from: ${reviewRef}.`,
        `   Get the threads yourself: node ${reinitScript} unresolved ${p.pr}. Address valid ones with a code change; reply to invalid ones with reasoning (blind compliance is NOT allowed).`
      )
    }
    steps.push(
      ``,
      `If you changed code: run the ticket's Verification commands to green, commit atomically referencing ${p.id}, push once, then re-init reviewers: node ${reinitScript} reinit ${p.pr}. Set pushed=true.`,
      `If you only replied to threads without a code change: pushed=false, status "fixed".`,
      `If nothing needed doing: status "no-op".`,
      `Return the result for PR #${p.pr}.`
    )
    const fixFallback = (why) => ({ id: p.id, pr: p.pr, pushed: false, status: 'escalate', notes: why })
    return agent(steps.join('\n'), {
      label: `fix:${p.id}#${p.pr}`,
      phase: 'Fix',
      model: p.model || 'claude-opus-4-8[1m]',
      agentType: 'general-purpose',
      schema: OUT,
    })
      .then((r) => (r ? { ...r, id: p.id, pr: p.pr } : fixFallback('fixer agent died — re-dispatch')))
      .catch((e) => fixFallback(`fixer errored (${e && e.message ? e.message : e}) — re-dispatch`))
  })
)
