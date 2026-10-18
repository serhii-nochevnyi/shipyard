# Decisions

<!-- Every accepted position is recorded IMMEDIATELY at the moment of the decision, not at the end. -->
<!-- Record format: -->
<!-- ## <decision, as an affirmative statement> -->
<!-- **Why:** ... -->
<!-- **What was rejected:** ... -->
<!-- **Scope fence:** what this decision explicitly does NOT cover -->
<!-- These sections become the locked decisions in the ADR when Gate 1 is closed. -->

## The generated mirror `plugins/shipyard/` is excluded from every review diff of the integrator and arch-review (accepted 2026-10-18)
**Why:** the mirror is a byte-for-byte generated copy of `plugins/delivery-pipeline` (31% of the phase 50 integrator diff, 643 KB of 2.04 MB), so the reviewer reads the same code twice; its parity with the source is proven by the package freshness check, not by a model review. Stated by the user as certain.
**What was rejected:** adding the mirror to `PREFIXES` in `development-artifacts.cjs`: that classifier also drives CI product-change scope, scope-gate, PR hygiene, comment-policy parity and the unresolved-review-thread gate, so a mirror-only PR would look "development only" and skip product jobs (research: `system-state.md` §8.3, `constraints.md` §4).
**Scope fence:** this fixes only the mirror. It does not decide whether `.planning/**` stays in arch-review diffs, how mirror parity is proven at review time, or how the diff-size dependence is removed (open questions). A review-specific pathspec must be applied at every diff site of all four paths and pinned by a test.
