# ADR-001: Greeting formats

- Status: Accepted
- UI design: none

## Context

`greet(name)` returns one fixed English greeting. Callers want a formal variant.

## Decision

Make one small change, delivered as two tickets:

1. Add an optional `options.style` argument to `greet` accepting `"casual"` (default, current output)
   and `"formal"` (returns `Good day, <name>.`), with a test for each style.
2. Document the `style` option in `README.md` with one usage example.

## Consequences

- Existing callers keep the current output because `"casual"` is the default.
- No new dependencies.
