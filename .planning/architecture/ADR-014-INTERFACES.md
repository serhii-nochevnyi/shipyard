# ADR-014 interfaces

## Resolver

```js
resolveDispatch({
  runtime: 'codex' | 'claude',
  role: 'research' | 'decomposition' | 'executor' | 'pr-sentinel'
      | 'integrator' | 'drift-check' | 'arch-review'
      | 'ci-fix' | 'review-fix',
  signals: {
    type?: 'facts' | 'alternatives',
    complexity?: 'normal' | 'very-complex',
    risk?: 'low' | 'medium' | 'high',
    checkpoint?: boolean,
    contested?: boolean,
    signatureState?: 'first' | 'progress' | 'repeat' | 'repeat_exhausted' | 'flake' | 'plan_defect',
    inputTokens?: number,
    priorApplied?: { model: string, effort: string, dispatchId: string }
  }
})
```

The result is immutable launch input and contains `policy_version`, `policy_hash`,
`logical_model`, `model`, `effort`, `rung`, `signals_fired`, `route`, `runtime`,
`backend`, and either `agent_file` or explicit launch arguments.

## Application receipt

```json
{
  "dispatch_id": "...",
  "runtime": "codex|claude",
  "launch_id": "...",
  "agent_file": "...",
  "requested_model": "...",
  "requested_effort": "...",
  "applied_model": "...",
  "applied_effort": "...",
  "observed_model": "...",
  "observed_effort": "...",
  "policy_hash": "..."
}
```

`applied_*` comes from the launch adapter, not from requested values copied by
the caller. `observed_*` may be unknown only when the runtime contract says the
fact is unavailable; unknown application is never compliant.
