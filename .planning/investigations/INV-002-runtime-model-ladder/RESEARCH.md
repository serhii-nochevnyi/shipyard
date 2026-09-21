# Research

<!-- Drafts from the research fan-out (lines 1 and 3), refined in the dialog. -->
<!-- Every claim about the codebase carries a file path; every external one carries a source. -->

## Current system state

The shared resolver in `plugins/delivery-pipeline/scripts/pipeline-config.cjs`
implements the superseded Claude-centric tier vocabulary and caps Codex to an
old two-entry Terra/Astra palette. Sol and Luna are absent from the configured
Codex palette, and `decomposition` is absent from the resolver role list.

`plugins/delivery-pipeline/scripts/codex-agent.cjs` can select generated files
and dynamically resolve executors, but its result is not a mandatory wrapper
around every actual launch. `plugins/delivery-pipeline/commands/deliver.md`
still documents paths where executor work can fall back inline or inherit the
session model. `plugins/delivery-pipeline/scripts/dispatch-record.cjs` checks
claimed routing after launch; it does not prove the runtime applied the claim.

Claude workflow callers in `plugins/delivery-pipeline/workflows/executors.mjs`,
`fix-round.mjs`, and `drift-gate.mjs` pass optional model/effort values and have
literal defaults. The existing Claude palette itself is not the defect and is
out of scope for replacement.

## Constraints

### Technical

- Codex requires explicit concrete model/effort or a resolver-selected static
  agent file; no model-less fallback is acceptable.
- Claude accepts its existing palette aliases; the adapter must preserve those
  aliases while adding a mandatory application receipt.
- Repair progression must use evidence that the prior rung actually ran;
  `repeat_exhausted` cannot merely count attempts.

### Product

### Delivery

The working tree already contains user-owned, uncommitted delivery/usage
changes. Investigation artifacts must not overwrite or revert them.

## Unknowns

<!-- Every unknown has a mirror checkbox in OPEN-QUESTIONS.md -->

- Exact escalation signal matrix and whether measured input-window pressure is
  allowed to promote each judgment role.
- Whether `risk: high`/`checkpoint` should promote judgment roles, or only
  control safety/checkpoint behavior while the role's model remains fixed.
- Required regeneration/install steps for the expanded Codex agent set.

## Fan-out synthesis

The four research passes converge on Option A: one canonical role/escalation
resolver with thin runtime adapters. The requested Codex policy needs named
model entries and three-rung repair/research progression; the current ordered
floor/ceiling palette cannot express it. Static Codex files should be generated
from the canonical policy, while dynamic executor/decomposition launches must
receive explicit model and effort arguments.

The safest repair sequence is `first/progress → Luna/max`, `repeat → Sol/medium`,
`repeat_exhausted → Astra/medium` for CI-fix and review-fix. Fixed roles
(`executor`, `pr-sentinel`, and `drift-check`) should not be promoted by global
window or repair signals. `contested` and measured input pressure are existing
signals for judgment roles, but their exact scope needs operator confirmation.

Hard enforcement must reject ambiguous runtime, unsupported model/effort,
missing generated variant, stale agent file, GSD remap that overrides policy,
inline/session-inherited launch, or telemetry without a launch receipt.

## Locked signal matrix

The investigation adopts the role-scoped matrix recorded in DECISIONS.md. The
important exclusion is intentional: global `risk`, `checkpoint`, and context
window signals cannot promote fixed `executor`, `pr-sentinel`, or `drift-check`
tuples. Repair escalation is valid only when the prior rung's applied launch
evidence exists. Combined signals retain all reasons and select the highest
allowed rung for that role.
