export const meta = {
  name: 'pipeline-drift-gate',
  description: 'Contour 3 Step 2: judge in parallel whether each selected ticket still matches the codebase before an executor implements it',
  phases: [{ title: 'Drift', detail: 'one read-only judge per stale ticket' }],
}

// ── args contract (built by /shipyard:deliver before invocation) ────────────
//   args = {
//     tickets: [ { id, planPath, model, effort } ],  // both optional; the
//                                                   // defaults below are the
//                                                   // ladder's drift-check row
//                                                    // (default sonnet / high)
//     driftRefPath: "<abs path to references/drift-check.md>",
//     baseRef: "origin/<git.base_branch>",   // optional but strongly advised —
//                        // the ref that defines "has landed". Omit it and the
//                        // judge falls back to reasoning about the working tree,
//                        // which may predate the work entirely.
//     recordCmd: "node <plugin-root>/scripts/drift-record.cjs",  // optional;
//                        // when given, a `drifted` judge persists its own verdict
//                        // instead of leaving it in a reply that dies with the run
//     graphDir: "<project>/.planning/graph",  // where that record belongs
//   }
// returns: [ { id, verdict: 'fresh'|'drifted', moved: [string], reuse_candidates: [string] } ]
//
// `reuse_candidates` is ADVISORY and orthogonal to the verdict: a `fresh`
// ticket carries it into the executor prompt so the implementation builds on
// what exists instead of reinventing it. It never excludes a ticket from the
// run — work that is already DONE is `drifted`, which is a different finding.
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
  required: ['id', 'verdict', 'moved', 'reuse_candidates'],
  properties: {
    id: { type: 'string' },
    verdict: { enum: ['fresh', 'drifted'] },
    moved: {
      type: 'array',
      items: { type: 'string' },
      description: 'For drifted: itemized list of what moved (missing file, changed signature, pre-implemented scope). Empty for fresh.',
    },
    reuse_candidates: {
      type: 'array',
      items: { type: 'string' },
      description: 'Existing implementations this ticket should build on rather than reinvent, each as "file:line — what it already does, which part of the ticket it covers". Advisory, independent of the verdict; empty when there is none.',
    },
  },
}

// The Workflow runtime may hand `args` over as a JSON STRING rather than an
// object (observed 2026-07-28). Reading `args.x` then silently yields undefined
// and the script no-ops with zero agents. Normalize once, tolerate both — but a
// parse FAILURE is not an empty wave. The previous shape swallowed it
// (`catch { return {} }`) and `argv.tickets || []` then turned
// `args = '{invalid'` into `return []`: no agent dispatched, no error raised,
// a board that reads as finished. Malformed input throws WITH the parse error,
// and `[]` is returned only for an EXPLICITLY empty list.
let argv
if (typeof args === 'string') {
  try {
    argv = JSON.parse(args)
  } catch (e) {
    throw new Error(`drift-gate: args is not valid JSON — ${e && e.message ? e.message : e}`)
  }
} else {
  argv = args
}
if (argv === null || typeof argv !== 'object' || Array.isArray(argv)) {
  throw new Error(`drift-gate: args must be an object — got ${argv === null ? 'null' : Array.isArray(argv) ? 'array' : typeof argv}`)
}
if (!Array.isArray(argv.tickets)) {
  throw new Error(`drift-gate: args.tickets must be an array (pass [] for a deliberately empty wave) — got ${argv.tickets === null ? 'null' : typeof argv.tickets}`)
}

const tickets = argv.tickets
const refPath = argv && argv.driftRefPath

if (!refPath) throw new Error('drift-gate: args.driftRefPath is required')
if (!tickets.length) return []

phase('Drift')

// fail-safe: a dead (null) OR throwing agent is treated as `drifted` so the
// orchestrator never runs an unchecked ticket on a silent judge failure.
const driftFallback = (id, why) => ({ id, verdict: 'drifted', moved: [why], reuse_candidates: [] })

const results = await parallel(
  tickets.map((t) => () =>
    agent(
      [
        `You are a drift-check judge. First read your full instructions and output contract from this file: ${refPath}.`,
        `Then read the ticket contract (plan file): ${t.planPath} — including every path it lists under Context reads and files_modified.`,
        `Judge ONLY ticket ${t.id}. Do NOT modify anything.`,
        `"Has landed" means present on the integration base${argv.baseRef ? ` (${argv.baseRef})` : ''}, NOT present in the working tree. The checkout may sit on a branch cut before this work existed, where every path the ticket names is absent and that absence proves nothing — verify with \`git cat-file -e <base>:<path>\` / \`git ls-tree -r --name-only <base> -- <dir>\`.`,
        `Run the reuse scan (step 4) even when nothing has drifted — search by BEHAVIOR, not by the names the plan proposes. Existing code to build on is reported in reuse_candidates and leaves the verdict "fresh"; only work that is already done, or an implementation that invalidates the ticket's approach, is "drifted".`,
        ...(argv.recordCmd
          ? [`If and only if your verdict is "drifted", persist it BEFORE answering: \`${argv.recordCmd} mark ${t.id} ${t.planPath} "<what moved>"${argv.graphDir ? ` --graph ${argv.graphDir}` : ''}\`. A verdict left only in this reply dies with the run and the next state-sync offers the same stale plan again; the record is bound to the plan's hash, so it lifts by itself once the ticket is re-planned. Report whether it landed.`]
          : []),
        `Return the verdict for ticket id "${t.id}".`,
      ].join('\n'),
      {
        label: `drift:${t.id}`,
        phase: 'Drift',
        model: t.model || 'sonnet',
        // The ladder's own row for drift-check (`pipeline-config.cjs model
        // drift-check --json` → sonnet/high), and the caller's resolved value
        // still wins. It used to read `'low'` with "cheap effort on purpose":
        // that was true when the executor carried the plan-defect burden, and
        // this role now carries it — it is the one expected to notice a plan the
        // codebase has outgrown, and it runs BEFORE an executor is paid. Effort
        // is a QUALITY knob at roughly constant price (~12-19% of a line is
        // output, a tier step is ~2.5x), so the row is bought with depth rather
        // than with a tier. This is the ONLY path where `effort` is enforced —
        // the Agent tool has no such parameter — so a literal that disagrees
        // with the ladder is the effort actually used, and nothing else would
        // report it. tests/unit/workflows-args.test.cjs pins the two together.
        effort: t.effort || 'high',
        agentType: 'general-purpose',
        schema: VERDICT,
      }
    )
      .then((v) => (v ? { ...v, id: t.id } : driftFallback(t.id, 'judge returned no verdict — treat as drifted')))
      .catch((e) => driftFallback(t.id, `judge errored (${e && e.message ? e.message : e}) — treat as drifted`))
  )
)

// Every dispatch above resolves to exactly one object — a dead or throwing
// judge becomes a verdict of its own rather than a gap — so an id that is
// missing here, or present twice, can only come from the fan-out itself. A
// silently shorter list is indistinguishable from a shorter wave, which is the
// whole failure: a ticket that never reported is a FAILED run, not a smaller
// one. Counted by id, so the order the results come back in does not matter.
// The check runs BOTH directions: a dispatched id absent or duplicated in the
// results, AND a result id the fan-out never dispatched. Checking only the
// first direction would let a surplus/foreign id ride along silently — every
// requested ticket present exactly once, plus one more the caller never asked
// for — which is still a broken 1:1 contract and a verdict downstream code has
// no dispatch record for (Copilot review on PR #36).
const dispatchedIds = new Set(tickets.map((t) => t && t.id))
const accounted = new Map()
for (const r of Array.isArray(results) ? results : []) {
  if (r && typeof r.id === 'string') accounted.set(r.id, (accounted.get(r.id) || 0) + 1)
}
const unaccounted = tickets.map((t) => t && t.id).filter((id) => accounted.get(id) !== 1)
const surplus = [...accounted.keys()].filter((id) => !dispatchedIds.has(id))
if (unaccounted.length || surplus.length) {
  const parts = []
  if (unaccounted.length) parts.push(`no single result for: ${unaccounted.join(', ')}`)
  if (surplus.length) parts.push(`result(s) for id(s) never dispatched: ${surplus.join(', ')}`)
  throw new Error(`drift-gate: dispatched ${tickets.length} ticket(s); the fan-out returned ${parts.join('; ')}`)
}

return results
