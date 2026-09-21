# Phase 31 integration review

- **Phase:** 31 — Not every ticket is available work
- **Implementation head reviewed:** `origin/main` at `100f0c47da59f7542fb2a14527084a1db4dd3f1a`
- **Implementation tree:** `6cb7cacb80b4a508aae2c0158438cef940e779a4`
- **Integration PR:** #136, merge commit `931f87fee808881361b7cc6fc1879dbb56978ae5`
- **Tickets:** T-31-01 / PR #128, T-31-02 / PR #129, T-31-03 / PR #131,
  T-31-04 / PR #132, T-31-05 / PR #133, T-31-06 / PR #134,
  T-31-07 / PR #135
- **Review mode:** inline Codex repository review; no separate reviewer result is claimed

## Verdict

**passed (repository-verifiable acceptance)**

The phase forms one fail-closed tracker path. The policy parser defines the
optional status vocabulary, the pure evaluator reads only current status and
assignee, `tracker-record.cjs` stores generation-bound observations, and all
front writers consume the same cache. Only a new execute transition is gated;
already branched or open-PR work remains resumable.

## Cross-ticket coherence

1. `pipeline-config.cjs` owns the opt-in `jira_todo_statuses` vocabulary and
   `tracker-eligibility.cjs` consumes that normalized list. Empty policy stays
   disabled, while malformed configuration is warning-oriented and cannot turn
   the gate on (`plugins/delivery-pipeline/scripts/pipeline-config.cjs:460-480, 1055-1072`; `plugins/delivery-pipeline/scripts/tracker-eligibility.cjs:109-125`).
2. The evaluator has no filesystem, network, history, or clock dependency. It
   returns `eligible`, `ineligible`, or `unknown`; only an exact configured
   status with an explicitly known unassigned assignee is eligible
   (`plugins/delivery-pipeline/scripts/tracker-eligibility.cjs:138-200`).
3. `tracker-record.cjs` binds observations and overrides to the published
   delivery generation, ticket Jira key, policy, and metadata identity. Atomic
   locking and recovery preserve the cache and journal on partial writes
   (`plugins/delivery-pipeline/scripts/tracker-record.cjs:392-527, 600-815`).
4. The front applies the tracker predicate only in the pending/execute path;
   branched and PR-open paths continue through their delivery and guard logic.
   The CLI, state-sync, and dispatch refresh use one coherent snapshot, while
   tracker reads stay outside the GitHub state lock (`plugins/delivery-pipeline/scripts/front.cjs:720-890, 1684-1775`; `plugins/delivery-pipeline/scripts/state-sync.cjs:982-1070`; `plugins/delivery-pipeline/scripts/dispatch-record.cjs:1260-1310`).
5. Direct overrides are exact-ticket operations owned by `tracker-record.cjs`;
   the event writer rejects hand-written `tracker_override` records, and the
   delivery instructions keep overrides separate from phase/set scopes
   (`plugins/delivery-pipeline/scripts/log-event.cjs:150-205`; `plugins/delivery-pipeline/commands/deliver.md:966-1000`).

## Acceptance sweep

| Ticket | Integrated result | Evidence |
|---|---|---|
| T-31-01 | External tickets enter through investigation/decomposition; the import and tracker-prose derivation shortcut is absent. | `plugins/delivery-pipeline/commands/deliver.md`; `tests/unit/delivery-cold-start-contract.test.cjs` |
| T-31-02 | Status names are opt-in, normalized, declared in the capability, and empty by default. | `pipeline-config.cjs:460-480, 1055-1072`; `tests/unit/pipeline-config.test.cjs` |
| T-31-03 | Eligibility uses exact status NAME plus explicit assignee state and ignores changelog/history and `statusCategory`. | `tracker-eligibility.cjs:27-107, 138-200`; `tests/unit/tracker-eligibility.test.cjs` |
| T-31-04 | Eligible, ineligible, and unknown records are durable, generation-bound, atomic, and fail closed without mutating the outbound Jira projection. | `tracker-record.cjs:392-527, 600-815`; `tests/unit/tracker-record.test.cjs`; `tests/unit/record-stores.test.cjs` |
| T-31-05 | Only pending work enters `actionable.execute`; missing, ineligible, and unknown records are blocked, while branched/PR-open work remains available to delivery/guard paths. | `front.cjs:720-890`; `tests/unit/front.test.cjs` |
| T-31-06 | A named current-generation override preserves observed facts, journals one atomic event, cannot be hand-written or set-scoped, and expires with the generation. | `tracker-record.cjs`; `log-event.cjs:150-205`; `tests/unit/tracker-record.test.cjs`; `tests/unit/log-event.test.cjs`; `tests/unit/judgment-contract.test.cjs` |
| T-31-07 | Cold start reads each pending issue once, parks unknown results, and passes the same active cache to state-sync, front, and dispatch without tracker I/O in state-sync. | `plugins/delivery-pipeline/commands/deliver.md:1414-1438`; `tests/unit/tracker-wiring-contract.test.cjs`; `tests/smoke/sentinel-smoke.sh` |

## Verification evidence

The following commands were run from the clean integration worktree at the
implementation head named above:

- `node --test tests/unit/tracker-eligibility.test.cjs` — 13 passed; exit 0.
- `node --test tests/unit/tracker-record.test.cjs` — 56 passed; exit 0.
- `node --test tests/unit/tracker-wiring-contract.test.cjs tests/unit/delivery-cold-start-contract.test.cjs` — exit 0.
- `node --test tests/unit/front.test.cjs tests/unit/log-event.test.cjs tests/unit/judgment-contract.test.cjs` — exit 0.
- `bash tests/smoke/sentinel-smoke.sh` — 168 assertions passed.
- `node --check plugins/delivery-pipeline/scripts/tracker-eligibility.cjs` — exit 0.
- `node --check plugins/delivery-pipeline/scripts/tracker-record.cjs` — exit 0.
- `node plugins/delivery-pipeline/scripts/validate-graph.cjs` — exit 0; 130 ticket records validated.

The integration PR and every ticket PR listed above are recorded as merged in
`.planning/graph/delivery-state.json`. No cross-ticket coherence, acceptance,
or repository-local verification finding remains for this phase.

## Machine result

```json
{
  "outcome": "passed",
  "phase": "31-not-every-ticket-is-available-work",
  "head": "100f0c47da59f7542fb2a14527084a1db4dd3f1a",
  "head_tree": "6cb7cacb80b4a508aae2c0158438cef940e779a4",
  "base": "origin/main",
  "base_tree": "6cb7cacb80b4a508aae2c0158438cef940e779a4",
  "ticket_set": ["T-31-01", "T-31-02", "T-31-03", "T-31-04", "T-31-05", "T-31-06", "T-31-07"],
  "ticket_set_digest": "686b5e73d6984f4950f893b8448cde8e6c0253229c360bf02a70ff65d312e8c8",
  "blocking_count": 0,
  "findings": []
}
```

**Final verdict: passed.**
