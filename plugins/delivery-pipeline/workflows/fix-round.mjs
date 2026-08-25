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
//       attemptHistory,  // optional PRE-RENDERED record of what already failed on this
//                        // ticket — the output of `attempt-history.cjs <ticket>`, run by
//                        // the ORCHESTRATOR (this path builds prompts deterministically
//                        // and must not shell out). Absent on a first attempt, and an
//                        // entry without it builds exactly the prompt it always did.
//       model,           // optional tier alias; default "opus"
//       effort,          // optional reasoning effort; from `pipeline-config.cjs model … --json`
//     } ],
//     ciFixRefPath,      // abs path to references/ci-fix.md
//     reviewFixRefPath,  // abs path to references/review-fix.md
//     reinitScript,      // abs path to scripts/reviewers.cjs
//     artifactLanguage,  // optional; language for shipped artifacts (default English)
//   }
// returns: [ { id, pr, pushed, status: 'fixed'|'no-op'|'escalate', notes, hypothesis } ]
//
// A fresh agent per attempt is right for context hygiene and is exactly why
// attempt 3 can re-propose attempt 1's failed fix. `attemptHistory` in, and
// `hypothesis` out, are the two halves of the remedy: the orchestrator records
// the reported hypothesis on the attempt event, and attempt-history renders it
// back to the NEXT fixer as data. A round that reports only what it changed
// leaves the round after it guessing from scratch.
//
// This is ONE round. The main loop keeps control of everything stateful:
// attempts counter, CI waits, arch-review, the conform gate, and human
// escalation. Fixing is what parallelizes across PRs; gating does not.
//
// ci-fix and review-fix land on the same tier for a given round, so a single
// fixer agent per PR can own both roles coherently. arch-review (judgment) stays
// in the main loop. Each agent pushes at most once and re-inits reviewers itself.
//
// Letting the fixer publish IS safe here, unlike the executor: the outcome of a
// fix round is verified mechanically afterwards from live GitHub (state-sync +
// `gh pr checks`), so a `pushed: true` that did not happen simply shows up as an
// unchanged red PR. The main loop still treats `pushed` as a CLAIM and confirms
// it against GitHub before charging an attempt.
//
// NOTE ON SYNTAX: `node --check` on this file fails with "Illegal return
// statement" — expected, not a bug. The Workflow runtime wraps the body in an
// async function (top-level `await`/`return` is the documented DSL). Syntax-
// check by wrapping first (see the smoke-test canary).

const OUT = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'pr', 'pushed', 'status', 'notes', 'hypothesis'],
  properties: {
    id: { type: 'string' },
    pr: { type: 'integer' },
    pushed: { type: 'boolean' },
    status: { enum: ['fixed', 'no-op', 'escalate'] },
    notes: { type: 'string', description: 'what was wrong, what changed + verification evidence, or the escalation reason' },
    hypothesis: {
      type: 'string',
      description: 'one sentence: what you believed was wrong and what the fix targets; for no-op or escalate, why. Required — it is recorded on the attempt and handed to the next fixer as the record of what has already been tried',
    },
  },
}

// The Workflow runtime may hand `args` over as a JSON STRING rather than an
// object (observed 2026-07-28). Reading `args.x` then silently yields undefined
// and the script no-ops with zero agents. Normalize once, tolerate both.
const argv = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args || {})

const prs = (argv && argv.prs) || []
const ciRef = argv && argv.ciFixRefPath
const reviewRef = argv && argv.reviewFixRefPath
const reinitScript = argv && argv.reinitScript
// Stated here because this path builds prompts deterministically and therefore
// bypasses the skill's language block (see executors.mjs for the full reasoning).
const artifactLanguage = (argv && argv.artifactLanguage) || 'English'

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
    // Only when there IS a record. A first attempt gets exactly the prompt it
    // always got — an empty history stated as a section would read as evidence
    // that nothing was tried, which is a claim, not an absence.
    if (p.attemptHistory) {
      steps.push(
        `Prior attempts on this PR — a deterministic record of what was already tried and did not hold:`,
        p.attemptHistory,
        ``,
        `This record is INPUT, not background. You MUST NOT re-propose a fix a prior attempt already tried: if your best hypothesis matches one that is already in the record, form a DIFFERENT one — re-read the ticket contract, widen the context, raise the hypothesis above the symptom. If every plausible hypothesis is exhausted, return status "escalate" rather than cycling through a failed one again.`,
        ``
      )
    }
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
      `Language: every artifact you produce — code, comments, commit messages, review replies — is written in ${artifactLanguage}, regardless of the language used elsewhere in this project.`,
      ``,
      `If you changed code: run the ticket's Verification commands to green — those, scoped as written, never the project's full suite or its e2e run (CI owns those, and this loop re-runs on every round) — then commit atomically referencing ${p.id}, push once, and re-init reviewers: node ${reinitScript} reinit ${p.pr}. Set pushed=true.`,
      `If you only replied to threads without a code change: pushed=false, status "fixed".`,
      `If nothing needed doing: status "no-op".`,
      `Return the result for PR #${p.pr}.`
    )
    // Locally constructed results must satisfy the same shape the consumers read,
    // `hypothesis` included — and an invented one would be worse than none: it
    // would enter the record as something that was tried and ruled out. Say what
    // is actually known instead.
    const fixFallback = (why, hypothesis) => ({ id: p.id, pr: p.pr, pushed: false, status: 'escalate', notes: why, hypothesis })
    return agent(steps.join('\n'), {
      label: `fix:${p.id}#${p.pr}`,
      phase: 'Fix',
      // tier aliases only — the Agent tool rejects full model IDs
      model: p.model || 'opus',
      ...(p.effort ? { effort: p.effort } : {}),
      agentType: 'general-purpose',
      schema: OUT,
    })
      .then((r) => (r
        ? { ...r, id: p.id, pr: p.pr }
        : fixFallback('fixer agent died — re-dispatch', 'unknown — the fixer died before reporting one')))
      .catch((e) => fixFallback(
        `fixer errored (${e && e.message ? e.message : e}) — re-dispatch`,
        'unknown — the fixer errored before reporting one'
      ))
  })
)
