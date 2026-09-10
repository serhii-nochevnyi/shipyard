# Read-only usage report

Run `node plugins/delivery-pipeline/scripts/usage-report.cjs <file.jsonl> [more.jsonl ...]`.
Pass explicit transcript files; the tool does not search home directories, send
network requests or modify sessions. JSON is written to stdout. `--help` is the
supported command reference. Exit 0 means recognized data without parse/identity
errors, 1 means a report with coverage warnings, and 2 means invalid arguments or
an unreadable file. Zero warnings is not proof of complete billing data.

Claude streaming rows are deduplicated by request/message identity, with UUID
fallback; counters retain their component maxima across partial updates.
Iterations replace the aggregate rather than being added to it. Advisor passes
remain separate. Without iterations the observation is a response aggregate,
not an assumed single context pass. Missing counters remain null; `missing`
counts show the affected observations. `finalized` records Claude stop markers.

Codex token_count totals are cumulative per session, so snapshots and resumed
files are not summed. A decrease is an explicit discontinuity and makes totals
unknown. Cache input is a subset of input; reasoning is a subset of output and
is never added a second time. Model attribution for cumulative Codex usage is
unknown. Different provider and observation units stay in different groups.

This initial slice rescans complete files to incorporate late updates. It has
no cursor, automatic collection, ticket/role join, quota conversion or subscription
attribution. Historical usage on other devices is outside its coverage. Prompt
text and tool payloads are never included in the report. Files from live sessions
can end in a partial JSON line; it is reported and a later rescan can recover it.
The later ADR-011 reconciliation package owns the dispatch join and reporting
integration; this CLI alone does not complete REQ-85 or the prospective baseline.
