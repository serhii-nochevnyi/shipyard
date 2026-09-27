# Codex usage tests still write session_meta records inline

Two unit tests author Codex `session_meta` records in source instead of replaying a captured boundary fixture:

- `tests/unit/usage-attribution.test.cjs` (about lines 344 and 370)
- `tests/unit/usage-report.test.cjs` (about lines 42, 63, 64, 116 and 225)

They stay in the `migrating` list of `tests/fixtures/captured/boundaries/codex-agent-stream.json` after T-40-09.
Migrating them needs a captured Codex shape for usage rows, which the `codex-agent-stream` boundary does not capture yet.

Next step: add a usage-row capture to `scripts/capture-boundary-fixtures.cjs`, replay it in both tests, and remove them from `migrating`.
