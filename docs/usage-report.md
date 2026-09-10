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
  "model": "sonnet",
  "effort": "high",
  "effort_applied": "high",
  "observed_model": "gpt-5.6-luna",
  "observed_effort": "high"
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

The JSON contains:

- `groups`: token totals split by runtime/provider, ordinary/advisor kind,
  concrete model, observed effort, requested policy, role, task level, backend
  and observation unit;
- `observations`: redacted per-response or per-Codex-session rows with
  `dispatch_id`, ticket and completion status when known;
- `coverage`: model, effort, dispatch, ticket, finalized-output and attribution
  rates. `unknown`, `unsupported`, ambiguous and missing values remain visible;
- `efficiency.rows`: ticket/dispatch usage rows ready to join with verified
  delivery outcomes. `input_per_verified_completion` stays `null` until that
  outcome join is supplied;
- `subscription_usage: null`: local transcripts do not prove a subscription
  allowance or credit delta.

`exact` and `session` attribution can be used for a model comparison. An
`ambiguous`, `mismatch` or `unattributed` row is excluded from the ready counts.
Codex `token_count` totals are cumulative per session, so the collector merges
snapshots and resumed files rather than summing them as requests. Claude
streaming updates are deduplicated by stable message identity, and late updates
replace incomplete maxima.

The report remains read-only and rescans the supplied files. A malformed
transcript or attribution line produces a warning and a non-comparable report;
it never becomes zero usage. Historical transcripts without a dispatch ledger
are still useful for raw model counts, but they cannot establish ticket-level
efficiency.
