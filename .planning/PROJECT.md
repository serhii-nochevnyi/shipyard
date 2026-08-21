# shipyard

## What this is

The shipyard delivery conveyor plus the container it runs in. No application
code — this repository is infrastructure, and its two deliverables are described
in `CLAUDE.md` at the repo root, which is the authoritative architecture
document. This file exists so GSD has a project anchor; it deliberately does not
duplicate CLAUDE.md.

## Why it is now a GSD project

Until v0.38.0 the conveyor was built by hand and validated against a separate
proving ground. Running shipyard's own remaining work THROUGH the conveyor is the
strongest available conformance signal: every gate, verdict and escalation path
is exercised on a repository whose maintainer reads the output closely.

Two properties make this safe rather than recursive:

- the running plugin is the INSTALLED cache (`~/.claude/plugins/cache/…`), not the
  working tree, so a ticket editing `sentinel.cjs` cannot change the guard that is
  driving it — that only happens on an explicit `claude plugin update`;
- `make test-fast` is seconds, offline and deterministic, which makes it an
  honest per-ticket Verification command rather than a formality.

## Constraints that outrank convenience

- **Two runtimes.** A behaviour change to a command doc or a script reaches both
  Claude Code and the Codex CLI. It must not assume Claude-only capabilities.
- **Codex artifacts are generated**, never hand-edited.
- **The plugin and its capability ship as one product** — bump both versions
  together.
- **Release is five steps and the last has no other feedback**: bump → tests →
  merge → signed tag → `gh release create`.
