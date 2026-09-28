# Open questions

## Decisions (maintainer)
- [x] Q1: Phase-level strategy: A (S1 only), B (correctness-first, then measured treatments), C (host-owned conveyor bundle) or D (buy hosted primitives)? — see [OPTIONS.md](OPTIONS.md)
- [x] Q2: Accept the recommended per-package options (the bold rows in OPTIONS.md) as the contracts?
- [x] Q3: R10 adjudication authority: a deterministic policy (R10-b) or a human-signed record (R10-c)?
- [x] Q4: R18: GitHub merge queue (R18-c) or a host merge-result attestation (R18-b), both with `base-merge.cjs` as fallback?

## Research-answerable (closed by the four lines)
- [x] Which packages are already fixed on 0.68.0? N47; N43 partly (#316); the PREFLIGHT host blocker. — [RESEARCH.md](RESEARCH.md)
- [x] Which packages can be delivered now and which wait for phase 43, with the blocking tickets? — RESEARCH.md "Independence from phase 43"; [research/constraints.md](research/constraints.md) §4.2
- [x] Which packages are correctness fixes and which are measured treatments? — RESEARCH.md "Product"
- [x] Which shared files need one serialized owner? — RESEARCH.md hot files
- [x] Is the phase-40 Codex research/decomposition artifact host installed at this revision? Yes, in the source (`codex-delivery-host.cjs:583-656`); the installed copy is checked by the doctor at delivery.

## Follow-up owned elsewhere (not blocking Gate 1)
- [x] Merge-queue availability for this repository's plan and `epic/*` branch rules: a spike at the start of R18. — recorded in RISKS.md
- [x] Whether a worktree-local writable reviewer `TMPDIR` is admissible under ADR-020 (R10-d): a spike at the start of R10. — recorded in RESEARCH.md "Unknowns"
- [x] Whether the installed hook and bundles match 0.68.0: checked by the doctor before S1 acceptance. — RISKS.md

All decisions are recorded in [DECISIONS.md](DECISIONS.md) (2026-09-28).
