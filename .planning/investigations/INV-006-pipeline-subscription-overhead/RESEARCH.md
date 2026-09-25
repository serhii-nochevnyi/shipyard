# Research

## Current system state

Existing seed evidence, not a completed formal four-line research handback:

- ../../../docs/audits/2026-09-25-claude-session-efficiency.md
- ../../../docs/audits/2026-09-25-claude-session-usage.json
- ../../../docs/audits/2026-09-25-pipeline-subscription-efficiency.md
- ../../phases/41-reduce-pipeline-subscription-overhead/CONTEXT.md

The audits already identify relevant code and measured session costs. Research
should resolve the open implementation questions, not repeat corpus discovery.

## Runtime preflight

Commands executed at kickoff:

- `node /Users/serhii/.codex/shipyard/scripts/pipeline-config.cjs resolve --json`:
  config.gsd.runtime = codex (bundle-path).
- `node /Users/serhii/.codex/shipyard/scripts/codex-runtime-host.cjs --capability-only`:
  unavailable/capability_evidence_missing. Default discovery alone is insufficient.
- The same probe with `--capabilities-file /Users/serhii/.codex/shipyard/codex-capabilities.json`:
  available, codex-cli 0.156.1; Sol/high selection listed.

Use the explicit installed capability file for host launches. The probe is
capability evidence only, not a launched research callback, receipt or artifact.
Formal research callbacks have not yet been launched by this kickoff.

## Constraints

### Technical

Reuse session-handoff, run ownership, usage-attribution, orchestration-overhead
and trusted finalization. Preserve exact source/base/evidence identity and
model-policy boundaries. Inspect finalized T-39-17 before modifying its files.

### Product

Reduce repeated context and work without weakening review, losing constraints
or reporting fictional subscription savings.

### Delivery

No existing worker is assigned phase-41 code by this kickoff. Work in other
worktrees remains independently owned; reconcile phase-40 shared files during
planning. No new ticket IDs or graph entries are materialized here.

## Unknowns

See OPEN-QUESTIONS.md. All are researchable technical questions; user scope is
already recorded in the phase context.
