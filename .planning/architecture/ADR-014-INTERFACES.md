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
    priorApplied?: ApplicationReceipt
  },
  previous_dispatch_id?: string
})
```

Repair escalation accepts only a receipt returned by the routed boundary; the
generic `model`/`effort`/`dispatchId` shorthand is deliberately not valid.

The result is immutable launch input and contains `policy_version`, `policy_hash`,
`logical_model`, `model`, `effort`, `rung`, `signals_fired`, `route`, `runtime`,
`backend`, and either `agent_file` or explicit launch arguments.

```ts
type ApplicationReceipt = {
  receipt_type: 'adr-014.application',
  runtime: 'codex' | 'claude',
  role: string,
  dispatch_id: string,
  launch_id: string,
  requested_model: string,
  requested_effort: string,
  applied_model: string,
  applied_effort: string,
  observed_model: string | 'unknown',
  observed_effort: string | 'unknown',
  policy_hash: string,
  compliance: 'verified',
  compliance_proof: {
    status: 'verified',
    boundary: 'adr-014.dispatch-boundary',
    policy_hash: string,
    dispatch_id: string,
    launch_id: string
  },
  agent_file_digest?: string
}
```

## Application receipt

```json
{
  "receipt_type": "adr-014.application",
  "dispatch_id": "...",
  "runtime": "codex|claude",
  "role": "...",
  "launch_id": "...",
  "agent_file": "...",
  "requested_model": "...",
  "requested_effort": "...",
  "applied_model": "...",
  "applied_effort": "...",
  "observed_model": "...",
  "observed_effort": "...",
  "policy_hash": "...",
  "compliance": "verified",
  "compliance_proof": {
    "status": "verified",
    "boundary": "adr-014.dispatch-boundary",
    "policy_hash": "...",
    "dispatch_id": "...",
    "launch_id": "..."
  }
}
```

`applied_*` comes from the launch adapter, not from requested values copied by
the caller. `observed_*` may be unknown only when the runtime contract says the
fact is unavailable; unknown application is never compliant. Static Codex
receipts also carry the generated file's content digest.
