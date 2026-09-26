---
name: shipyard-delivery-rules
description: Delivery-conveyor rules for GSD planner/executor agents — plan frontmatter contract, delivery block, branch naming, scope discipline. Injected via the project-relative .shipyard/generated/gsd-delivery-rules projection; also useful when authoring or editing PLAN.md files by hand.
---

# Shipyard delivery-rules

Resolve this installed skill directory from its supplied absolute SKILL.md path. The plugin root is two directories above it. Run, with that absolute root:

```sh
node "<plugin-root>/host/scripts/bootstrap-shipyard-plugin.cjs"
```

This idempotently installs/enables the GSD marketplace dependency and prepares native Codex host components. On any failure stop and report the exact setup error; do not run a partial workflow. If setup registered agents for the first time, start a new Codex session before dispatching them.

Read the complete file at `${CODEX_HOME:-$HOME/.codex}/shipyard-native-skills/shipyard-delivery-rules/SKILL.md` using shell expansion (CODEX_HOME takes precedence), then execute that workflow with the original user arguments. Do not summarize or substitute its runtime policy, model selection, validation, gates, or receipts.
