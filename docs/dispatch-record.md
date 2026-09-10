# Dispatch recording

`dispatch-record.cjs mark` records one ticket. When a launch hands out several
tickets, record them as one validated mutation:

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

The input is a JSON array of objects with `ticket`, `role` and the same fields as
`mark`: `model`, `effort`, `effort_applied`, `route`, `task_level`, `runtime`,
`backend`, `observed_model`, `observed_effort`, `agent_file` and `agent_id`.
Values are strings; omit an unmeasured field. `route` is the resolver's returned
route, not a hand-written reason. The current state supplies each ticket's PR
and fingerprint.

All items are validated before the store or journal is changed. The batch takes
one lock, appends one dispatch event per item and refreshes the front once. A
duplicate or unknown ticket rejects the whole batch; an empty array is an
explicit no-op. Add `--graph <project>/.planning/graph` when running outside
the project checkout.

This command only records attribution. It does not select a model, launch an
agent, infer applied effort or make quota/savings claims.
