# Model usage observability

The collector measures provider transcripts and keeps Claude and Codex on
separate accounting paths. It reports processing tokens, model/effort
attribution and coverage. It does not convert tokens to subscription credits or
API dollars.

## Record the launch correlation

`dispatch-record.cjs mark` now creates a `dispatch_id` and prints it. The id is
also present in the dispatch journal. After the runtime exposes the transcript
identity, record the link in the project graph:

```bash
cat <<'JSON' | node plugins/delivery-pipeline/scripts/usage-attribution.cjs record --stdin
{
  "dispatch_id": "<dispatch_id from dispatch-record>",
  "runtime": "codex",
  "provider": "openai",
  "session_id": "<Codex session id>",
  "source": "/path/to/codex-transcript.jsonl",
  "ticket": "T-01-01",
  "role": "executor",
  "task_level": "routine",
  "backend": "codex-agent",
  "model": "luna",
  "effort": "max",
  "effort_applied": "max",
  "observed_model": "gpt-6-luna",
  "observed_effort": "max"
}
JSON
```

Use `runtime=claude, provider=anthropic` for Claude. The ledger rejects a
provider/runtime mismatch, so an Anthropic model cannot be attributed to a Codex
launch or the reverse. `model` is the requested Shipyard tier alias;
`observed_model` is the concrete runtime id. Omit an unavailable observation;
do not copy the requested value into an observed field.

The correlation key can be a `session_id`, `request_id` or `message_id`. A
session-level record is enough for a single Codex launch. Claude should use a
message or request id when several launches share a session. Advisor passes use
`kind=advisor` and their own dispatch/parent metadata when the runtime exposes
it; they remain separate from ordinary work.

The ledger is append-only and revisioned. Replaying the same record is
idempotent. Adding a later session or model fact with the same
`observation_id` creates a new revision, and the latest revision is what the
report reads. It stores ids, routing facts and statuses only; prompts, tool
payloads and credentials are not accepted fields.

## Generate a report

Pass transcript paths explicitly. Add the attribution ledger to join usage to
dispatches and tickets:

```bash
node plugins/delivery-pipeline/scripts/usage-report.cjs \
  /path/to/claude.jsonl /path/to/codex.jsonl \
  --attribution .planning/graph/usage-attribution.jsonl
```

The reader never discovers a transcript on its own; the operator passes the
paths. The explicit roots this repository writes transcripts under are
`~/.local/state/shipyard/claude/<key>/transcripts/`,
`~/.local/state/shipyard/claude-decompose/<key>/transcripts/` and
`$CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl`. A Codex `exec` stdout copy carries
no `rate_limits`, so it still contributes token counts but never a quota
series.

The JSON contains:

- `groups`: token totals split by runtime/provider, ordinary/advisor kind,
  concrete model, observed effort, requested policy, role, task level, backend
  and observation unit;
- `observations`: redacted per-response or per-Codex-session rows with
  `dispatch_id`, ticket, concrete model/effort and completion status when known;
- `coverage`: model, effort, dispatch, ticket, finalized-output and attribution
  rates. `unknown`, `unsupported`, ambiguous and missing values remain visible;
- `efficiency.rows`: ticket/dispatch usage rows with an `eligible` flag. Only
  rows with unambiguous attribution, a concrete model and effort, and complete
  input counters are eligible for comparison. `exclusion_reasons` explains
  every excluded row. `input_per_verified_completion` stays `null` until a
  verified delivery outcome join is supplied;
- `subscription_usage`: the `shipyard.subscription-usage.v1` summary derived
  from any `rate_limit_event` (Claude) or `event_msg`/`token_count` with
  `rate_limits` (Codex) rows in the same sources. Each `series` entry is one
  provider/runtime/account-label/bucket/window; it is never summed across
  provider, account label or bucket, and its `delta` stays `null` unless the
  series is continuous end to end (`segment: 'measured'`). `discontinuities`
  names every break by reason (`reset`, `decrease`, `account_label_change`,
  `unattributed`, `unknown_concurrency`, `window_change`).
  `coverage.codex_parent` and `coverage.codex_idle_baseline` are always
  `unverified`, and `verdict` is always `inconclusive`: a saved transcript
  cannot confirm which process shares a Codex quota window or that the account
  was idle before the first sample. A malformed quota record only adds to
  `subscription_usage.warnings`; it never changes the top-level `warnings` or
  `comparable`. `subscription_usage` is never a price or a token-to-quota
  conversion.

Pass `--account-label <runtime>=<label>` (repeatable; `<runtime>` is `claude`
or `codex`) to set `account_label` on that runtime's series instead of leaving
it `null`. The label must match `/^[a-z0-9][a-z0-9._-]{0,63}$/`; an invalid
label or runtime exits 2. Without the option every quota observation is
unattributed — this script never reads a runtime's private state to guess
which account a transcript belongs to.

`exact` and `session` attribution can be used for a model comparison. An
`ambiguous`, `mismatch` or `unattributed` row is excluded from the ready counts.
Older Codex `token_count` and current `token_usage_record` totals are cumulative
per session. For the current format, the final deduplicated
`thread_token_usage` or `total_token_usage` snapshot is the source of the session
total. The collector uses per-response usage only when those responses reconcile exactly with that
snapshot, then splits the reconciled total by the model/effort from
`turn_context`; otherwise it retains the cumulative session row and warns. It
does not mix duplicate legacy snapshots into the total. Claude streaming updates
are deduplicated by stable message identity, and late updates replace incomplete
maxima.

The report remains read-only and rescans the supplied files. A malformed or
unreadable transcript or attribution input produces a warning and a
non-comparable report; it never becomes zero usage. Historical transcripts
without a dispatch ledger are still useful for raw model counts, but they
cannot establish ticket-level efficiency.
