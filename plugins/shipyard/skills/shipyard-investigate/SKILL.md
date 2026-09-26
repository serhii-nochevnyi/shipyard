---
name: shipyard-investigate
description: "Deep investigation (loop 1): pick up an open INV or create a new one; intake interview, research fan-out, iterative dialogue, Gate 1 → ADR. Use when a topic is unclear, needs research, or the key decisions are not made yet — before any tickets or code."
---

# Shipyard investigate

Resolve this installed skill directory from its supplied absolute SKILL.md path. The plugin root is two directories above it. Run, with that absolute root:

```sh
node "<plugin-root>/host/scripts/bootstrap-shipyard-plugin.cjs"
```

This idempotently installs/enables the GSD marketplace dependency and prepares native Codex host components. On any failure stop and report the exact setup error; do not run a partial workflow. If setup registered agents for the first time, start a new Codex session before dispatching them.

Read the complete file at `${CODEX_HOME:-$HOME/.codex}/shipyard-native-skills/shipyard-investigate/SKILL.md` using shell expansion (CODEX_HOME takes precedence), then execute that workflow with the original user arguments. Do not summarize or substitute its runtime policy, model selection, validation, gates, or receipts.
