# Delivery statistics and routing coverage

Run `node plugins/delivery-pipeline/scripts/pipeline-stats.cjs --json` from the
project root. The command reads the ticket graph, the append-only delivery
journal and live pull-request metadata. It is read-only; it does not dispatch,
change configuration or claim quota savings.

The `ladder` section has three deliberately separate coverage levels:

- `requested_comparable` means the resolver's model, effort and route are
  recorded together with task level, runtime and backend. Static Codex roles
  also need the generated `agent_file`; the dynamic executor has no static file.
- `applied_comparable` adds `effort_applied`. A value of `unsupported` or
  `unknown` is retained as an explicit runtime fact, but it is not silently
  replaced with the requested effort.
- `observed_comparable` adds the concrete `observed_model` and
  `observed_effort`. Missing observations stay unknown and are excluded from a
  runtime comparison.
- `usage_join_comparable` adds the generated `dispatch_id`, which is the
  correlation key needed to join a dispatch to its transcript usage.

`missing_attribution.dispatch_id` and `by_dispatch_id` show whether that join
will be possible for each dispatch.

`missing_attribution` counts each missing field, and `by_attribution_status`
groups rows as `incomplete`, `requested_complete`, `applied_complete` or
`observed_complete`. These counts describe evidence coverage only. They are not
subscription usage, API billing, quality scores or proof that an adaptive lane
saves tokens. A treatment must first have prospective dispatch attribution and
the evaluation gates in
`.planning/architecture/ADR-011-ROLLOUT.md` before its outcomes are compared.

For token-level model efficiency, join transcripts with the dispatch
correlation ledger:
`node plugins/delivery-pipeline/scripts/usage-report.cjs <transcript.jsonl> --attribution .planning/graph/usage-attribution.jsonl`.
That report carries the concrete provider model, observed effort and ticket
usage rows. `pipeline-stats` remains the source for delivery outcomes and
verified merge state; a transcript stop marker does not by itself count as a
verified completion. The report marks each efficiency row `eligible` only when
the dispatch is attributed unambiguously, has a concrete observed model and
effort, and has complete input counters.

Use `--since 14d` (the default), `--since all`, or an ISO timestamp to limit the
windowed ladder warnings and coverage counts. Ticket and phase outcome rows
remain lifetime facts.
