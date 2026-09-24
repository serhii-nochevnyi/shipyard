# Dispatch recording

`dispatch-record.cjs mark` records one ticket. Use `mark-many --stdin` when a
validated dispatch owns several independent tickets; the batch writes all rows
under one lock and one front refresh. Clear ticket records by their exact
`{ticket, dispatch_id}` identities so a delayed result cannot remove newer
work.

Claude's phase-wide `pr-sentinel` uses one round identity instead of duplicated
ticket rows. The role host derives the complete set from the canonical graph and
live PRs. After ADR-014 resolves and validates the launch, it creates one
temporary reservation in `dispatches.json` before starting Claude. The front
projects that reservation to each unchanged member and counts its shared
`agent_id` once. A launch failure removes the reservation; a killed host leaves
it only until the normal dispatch TTL.

After the exact-session transcript, result, and boundary receipt validate, the
host atomically replaces the reservation with one `rounds` row and one journal
event. That row keeps requested, applied, and observed model and effort values
separate, along with the receipt, digest, and original PR/head/base identities.
Members whose PR merges, head changes, or base moves expire individually. New
PRs outside the authenticated set make the result stale and are refused.

Clear a completed guard by its returned round dispatch id:

```bash
node plugins/delivery-pipeline/scripts/dispatch-record.cjs clear-round \
  <round_dispatch_id> --graph .planning/graph
```

The operation removes only that round or its still-pending reservation. A stale
id cannot clear a newer round or a ticket dispatch. Do not call `mark` or
`mark-many` for Claude's shared sentinel receipt.

The general ticket form remains available for independent dispatches:

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
    "runtime": "codex",
    "backend": "codex-exec",
    "effort_applied": "high",
    "agent_id": "<launch id>"
  }
]
JSON
```

Ticket input is a JSON array of objects with `ticket`, `role` and the same fields
as `mark`: `model`, `effort`, `effort_applied`, `route`, `task_level`, `runtime`,
`backend`, `observed_model`, `observed_effort`, `agent_file`, `agent_id` and an
optional `dispatch_id`. The boundary receipt supplies those routing facts; this
command does not select a model, launch an agent, or infer applied effort.
After the runtime supplies a transcript session/request/message id, connect it
with `usage-attribution.cjs record`.

For a batch completion, clear all returned ticket identities in one mutation:

```bash
printf '%s\n' '[{"ticket":"T-01-01","dispatch_id":"<id-1>"},{"ticket":"T-01-02","dispatch_id":"<id-2>"}]' \
  | node plugins/delivery-pipeline/scripts/dispatch-record.cjs clear-many --stdin --graph .planning/graph
```

For one ticket completion, the dispatch id is mandatory:

```bash
node plugins/delivery-pipeline/scripts/dispatch-record.cjs clear T-01-01 \
  <dispatch_id> --graph .planning/graph
```
