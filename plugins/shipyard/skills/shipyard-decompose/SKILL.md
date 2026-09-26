---
name: shipyard-decompose
description: "Decomposition (loop 2): ADR → GSD plan-tickets with dependencies → valid graph (Gate 2), then export to Jira. Finds undecomposed ADRs on its own. Use when the user explicitly wants an accepted design/ADR broken into tickets — it creates tickets, so invoke it deliberately, not from idle discussion."
---

# Shipyard decompose

Resolve this installed skill directory from its supplied absolute SKILL.md path. The plugin root is two directories above it. Run, with that absolute root:

```sh
node "<plugin-root>/host/scripts/bootstrap-shipyard-plugin.cjs"
```

This idempotently installs/enables the GSD marketplace dependency and prepares native Codex host components. On any failure stop and report the exact setup error; do not run a partial workflow. If setup registered agents for the first time, start a new Codex session before dispatching them.

Read the complete file at `${CODEX_HOME:-$HOME/.codex}/shipyard-native-skills/shipyard-decompose/SKILL.md` using shell expansion (CODEX_HOME takes precedence), then execute that workflow with the original user arguments. Do not summarize or substitute its runtime policy, model selection, validation, gates, or receipts.
