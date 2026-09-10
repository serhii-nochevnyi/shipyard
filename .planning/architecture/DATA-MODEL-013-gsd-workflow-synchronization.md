# Data model — ADR-013 GSD workflow synchronization

## Source record

```text
PlanRecord {
  phase: string
  plan: string
  ticket: string
  title: string
  requirements: string[]
  files_modified: string[]
  delivery_status: pending | branched | pr-open | merged | unknown
  integration_status: passed | needs-fix | pending | unknown
  verification_status: passed | gaps_found | pending | failed
}
```

`ticket` comes from PLAN `delivery.ticket` and must match the graph identity.
Unknown or duplicate identities are blockers.

## Derived project state

```text
SyncSnapshot {
  source_fingerprint: sha256
  current_phase: string | null
  total_plans: integer
  completed_plans: integer
  verified_phases: integer
  blockers: string[]
}
```

The fingerprint covers the normalized bytes of source plans, graph state,
roadmap, integration evidence, and synchronizer version. It does not include
generated output, timestamps, absolute paths, or network state.

## Status precedence

For a plan: `merged` > `pr-open|branched` > `pending` > `unknown` only when the
source contains a valid status; malformed or missing source is always a
blocker, never a default.

For a phase: explicit failed/needs-fix evidence > pending/missing evidence >
passed evidence. A phase cannot be `passed` unless every plan is merged and the
required verification evidence exists.
