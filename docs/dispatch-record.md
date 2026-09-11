# Dispatch recording

`dispatch-record.cjs mark` records one ticket. When a launch hands out several
tickets, record them as one validated mutation. The same batching rule applies
when a wave completes: `clear-many --stdin` removes all returned
`{ticket, dispatch_id}` identities in one lock and one front refresh, and
`clear <ticket> <dispatch_id>` is the one-ticket equivalent. The dispatch id
is required because a ticket can be re-dispatched before an older completion
arrives.

```bash
cat <<'JSON' | node plugins/delivery-pipeline/scripts/dispatch-record.cjs mark-many --stdin
[
  {
    "ticket": "T-01-01",
    "role": "executor",
    "model": "opus",
    "effort": "high",
    "route": "tier=floor(opus) effort=row(high)",
    "task_level": "routine",
    "runtime": "claude",
    "backend": "workflow",
    "effort_applied": "high",
    "agent_id": "<launch id>"
  }
]
JSON
```

```bash
printf '%s\n' '[{"ticket":"T-01-01","dispatch_id":"<id-1>"},{"ticket":"T-01-02","dispatch_id":"<id-2>"}]' \
  | node plugins/delivery-pipeline/scripts/dispatch-record.cjs clear-many --stdin --graph .planning/graph
```

The input is a JSON array of objects with `ticket`, `role` and the same fields as
`mark`: `model`, `effort`, `effort_applied`, `route`, `task_level`, `runtime`,
`backend`, `observed_model`, `observed_effort`, `agent_file`, `agent_id` and
optional `dispatch_id`. When omitted, `mark` generates a unique `dispatch_id`
for each ticket and prints it. The id is copied into the dispatch journal and is
the join key for `usage-attribution.cjs`.
Values are strings; omit an unmeasured field. `route` is the resolver's returned
route, not a hand-written reason. The current state supplies each ticket's PR
and fingerprint.

All mark items are validated before the store or journal is changed. The mark
batch takes one lock, appends one dispatch event per item and refreshes the
front once. A duplicate or unknown ticket rejects the whole mark batch; an
empty array is an explicit no-op. Clear batches validate both ticket and
dispatch id and are idempotent: an id whose record already lifted, or whose
ticket now carries a newer dispatch, is reported as absent rather than deleting
the newer record. Add `--graph <project>/.planning/graph` when running outside
the project checkout; the selected directory must contain `tickets.json`.

This command only records routing and launch identity. It does not select a
model, launch an agent, infer applied effort or make quota/savings claims. After
the runtime supplies a transcript session/request/message id, connect it with
`usage-attribution.cjs record`; the dispatch record alone cannot prove which
concrete model or effort the host applied.

For one completion, the dispatch id is mandatory for the same reason:

```bash
node plugins/delivery-pipeline/scripts/dispatch-record.cjs clear T-01-01 \
  <dispatch_id> --graph .planning/graph
```

The command compares the id while holding the store lock. A delayed completion
therefore leaves a newer dispatch in place instead of deleting it.
