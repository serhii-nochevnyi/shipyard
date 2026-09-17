# Phase 34 research

## Existing seams

- `failure-signature.cjs` already owns CI signature normalization, green reset, flake quarantine, retry backstop, and applied effort evidence.
- `reviewers.cjs` already reads unresolved threads, review verdicts, and bot comments, but it exposes no stable finding identity or progress state.
- `dispatch-boundary.cjs` is the only routed launch boundary and already authenticates receipts, repair predecessors, generated Codex files, and Claude workflow evidence.
- `front.cjs` counts local in-flight agents; its count is the correct base for a shared account-scoped admission overlay.
- `gate-trailer.cjs` already proves equal head and base trees for carry, but the manual merge contract still needs explicit ancestry and current PR identity checks.
- `pipeline-stats.cjs` and `backlog-index.cjs` provide read-only telemetry and backlog inventory. Neither owns a versioned treatment report or a candidate manifest.

## Implementation shape

Use small standard-library modules with pure functions where possible. Keep the existing journal and receipt stores authoritative, add only versioned records, and wire each new helper through an existing production caller. Use disposable repositories and injected adapters in tests; no network or package installation is required.

## Risk controls

Unknown review identity, capability, account scope, store state, report coverage, or Git ancestry is an explicit inconclusive or fallback state. A report cannot promote a treatment, a lease cannot reserve beyond a known cap, and a carried trailer cannot satisfy CI or current review checks.
