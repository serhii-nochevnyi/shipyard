export const meta = {
  name: 'pipeline-drift-gate',
  description: 'Contour 3 Step 2: judge in parallel whether each selected ticket still matches the codebase before an executor implements it',
  phases: [{ title: 'Drift', detail: 'one read-only judge per stale ticket' }],
}

// ── args contract (built by /shipyard:deliver before invocation) ────────────
//   args = {
//     tickets: [ { id, planPath, model, effort } ],  // both optional
//                                                    // (default sonnet / low)
//     driftRefPath: "<abs path to references/drift-check.md>",
//   }
// returns: [ { id, verdict: 'fresh'|'drifted', moved: [string] } ]
//
// Read-only: agents JUDGE, they do not touch the tree. Worktrees are NOT used
// here — the judge runs against the up-to-date default branch checkout.
//
// NOTE ON SYNTAX: `node --check` on this file fails with "Illegal return
// statement" — that is expected and NOT a bug. The Workflow runtime wraps the
// body in an async function (the documented DSL: top-level `await` and a
// top-level `return` value). To syntax-check, wrap the body in an async fn
// first (see tests/smoke/overlay-image-smoke.sh canary).

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'verdict', 'moved'],
  properties: {
    id: { type: 'string' },
    verdict: { enum: ['fresh', 'drifted'] },
    moved: {
      type: 'array',
      items: { type: 'string' },
      description: 'For drifted: itemized list of what moved (missing file, changed signature, pre-implemented scope). Empty for fresh.',
    },
  },
}

// The Workflow runtime may hand `args` over as a JSON STRING rather than an
// object (observed 2026-07-28). Reading `args.x` then silently yields undefined
// and the script no-ops with zero agents. Normalize once, tolerate both.
const argv = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args || {})

const tickets = (argv && argv.tickets) || []
const refPath = argv && argv.driftRefPath

if (!refPath) throw new Error('drift-gate: args.driftRefPath is required')
if (!tickets.length) return []

phase('Drift')

// fail-safe: a dead (null) OR throwing agent is treated as `drifted` so the
// orchestrator never runs an unchecked ticket on a silent judge failure.
const driftFallback = (id, why) => ({ id, verdict: 'drifted', moved: [why] })

return await parallel(
  tickets.map((t) => () =>
    agent(
      [
        `You are a drift-check judge. First read your full instructions and output contract from this file: ${refPath}.`,
        `Then read the ticket contract (plan file): ${t.planPath} — including every path it lists under Context reads and files_modified.`,
        `You are on an up-to-date default branch. Judge ONLY ticket ${t.id}. Do NOT modify anything.`,
        `Return the verdict for ticket id "${t.id}".`,
      ].join('\n'),
      {
        label: `drift:${t.id}`,
        phase: 'Drift',
        model: t.model || 'sonnet',
        // drift-check is mechanical reconciliation — cheap effort on purpose
        effort: t.effort || 'low',
        agentType: 'general-purpose',
        schema: VERDICT,
      }
    )
      .then((v) => (v ? { ...v, id: t.id } : driftFallback(t.id, 'judge returned no verdict — treat as drifted')))
      .catch((e) => driftFallback(t.id, `judge errored (${e && e.message ? e.message : e}) — treat as drifted`))
  )
)
