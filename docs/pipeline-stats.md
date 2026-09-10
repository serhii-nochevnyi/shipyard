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

`missing_attribution` counts each missing field, and `by_attribution_status`
groups rows as `incomplete`, `requested_complete`, `applied_complete` or
`observed_complete`. These counts describe evidence coverage only. They are not
subscription usage, API billing, quality scores or proof that an adaptive lane
saves tokens. A treatment must first have prospective dispatch attribution and
the evaluation gates in
`.planning/architecture/ADR-011-ROLLOUT.md` before its outcomes are compared.

Use `--since 14d` (the default), `--since all`, or an ISO timestamp to limit the
windowed ladder warnings and coverage counts. Ticket and phase outcome rows
remain lifetime facts.
