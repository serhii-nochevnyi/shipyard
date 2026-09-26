---
name: shipyard-route
description: "Entry router for shipyard — surface this automatically whenever a scope of work has been defined in conversation and no shipyard loop is already running. It sizes the work and routes it: large/heavy multi-ticket efforts → investigate/decompose/deliver; small changes, an existing ticket, or 'no ticket' → bench; a one-liner → inline. Read-only and advisory: it classifies and hands off, and never creates tickets, branches, PRs, or commits itself (so it is safe to trigger on its own). Triggers: a defined scope of work, 'route this', 'what should we do with this', 'here's the scope — take it', 'kick off shipyard for this', or any implement/build/fix request where the right entry is unclear."
---

# Shipyard route

Resolve this installed skill directory from its supplied absolute SKILL.md path. The plugin root is two directories above it. Run, with that absolute root:

```sh
node "<plugin-root>/host/scripts/bootstrap-shipyard-plugin.cjs"
```

This idempotently installs/enables the GSD marketplace dependency and prepares native Codex host components. On any failure stop and report the exact setup error; do not run a partial workflow. If setup registered agents for the first time, start a new Codex session before dispatching them.

Read the complete file at `${CODEX_HOME:-$HOME/.codex}/shipyard-native-skills/shipyard-route/SKILL.md` using shell expansion (CODEX_HOME takes precedence), then execute that workflow with the original user arguments. Do not summarize or substitute its runtime policy, model selection, validation, gates, or receipts.
