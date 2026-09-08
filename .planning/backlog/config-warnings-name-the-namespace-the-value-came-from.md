# Config warnings should name the namespace the value actually came from

Found by Copilot on PR #44 (T-24-05), declined there as out of scope.

`pipeline-config.cjs` merges `pipeline.*` and `delivery_pipeline.*` into one
object (line ~170, `delivery_pipeline` wins) and then validates the merged
result. Every warning it emits afterwards hard-codes the `pipeline.` prefix —
`auto_merge`, `sentinel`, `integration_mode`, `model_policy`, `models.*`,
`repos.*`, `effort.*`, the numeric knobs, `merge_without_ci`, and the
"unknown pipeline config key" line.

That is consistent, and consistency is why the reviewer's narrow request (change
only `merge_without_ci`) was declined. But a project that set the value under
`delivery_pipeline.` is still pointed at a key it did not write, and for the
GSD-settable keys `delivery_pipeline.` is the PREFERRED spelling — so the
message names the less correct half of the pair exactly where the user is most
likely to have used the other one.

The fix is one change, not thirteen: keep provenance at the merge (which
namespace each key was read from) and have the warning builder spell the key
back with that prefix. Keys present in neither namespace keep `pipeline.`.

Value: a warning that names a key the user can find. Cost: small, but it touches
the whole diagnostics surface of the config reader, so it wants its own ticket
and its own test (one key set under each namespace, the warning naming each).
