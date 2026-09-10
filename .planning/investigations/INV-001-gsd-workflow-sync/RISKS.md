# Risks

## Historical evidence is incomplete

severity: high
mitigation: Generate `pending` or `gaps_found` verification status when a phase
has no passing integration evidence; never infer a phase pass from merged ticket
counts alone. Keep the existing integration reports unchanged.

## Generated artifacts could overwrite human work

severity: high
mitigation: Make generated files wholly owned by the synchronizer or update only
explicit marker blocks. Refuse to overwrite a non-generated artifact with a
conflicting owner marker, and provide `--check` before mutation.

## Concurrent workflow writers could publish a mixed snapshot

severity: high
mitigation: Serialize projection writes with the existing project lock and use
temporary files plus atomic rename. Re-read the source fingerprint while holding
the lock before publishing.

## GSD parser behavior can change between versions

severity: medium
mitigation: Pin and test the required artifact grammar against the supported GSD
engine range; run the installed `phase uat-passed`, `roadmap.analyze`, and
`validate.health` queries in the smoke suite.

## The installed capability may be stale

severity: medium
mitigation: Keep the canonical synchronizer in the plugin script set, copy it
through both installers/generator, and make the gate name the installed path
when the bundle is incomplete.

## A global gate could affect non-conveyor projects

severity: high
mitigation: Scope every synchronizer gate to the presence of `.planning/phases`,
at least one `*-PLAN.md`, and at least one top-level `delivery:` block; otherwise
exit as not applicable.
