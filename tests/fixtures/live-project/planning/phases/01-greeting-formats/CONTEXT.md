# Phase 1 — Greeting formats

Source: `.planning/architecture/ADR-001-greeting-formats.md` (accepted).

## Decisions

- D-01: `greet(name, options)` accepts an optional `options.style`: `"casual"` (default, the current output) or `"formal"` (returns `Good day, <name>.`). Each style has a test.
- D-02: `README.md` documents the `style` option with one usage example.

## Constraints

- Existing callers keep the current output; no new dependencies.
- Two tickets, one per decision; the documentation ticket depends on the code ticket.
