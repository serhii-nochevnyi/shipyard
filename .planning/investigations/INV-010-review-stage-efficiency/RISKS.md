# Risks

The full register, with evidence, is in [research/risks.md](research/risks.md) §2. High-severity risks are listed first.

- **R-1 (high): a looser carry certifies an interaction nobody judged.** Mitigation: any new carry must be provable from object identities; governing-input changes always re-owe review; the integrator is named as the interaction check, with N44 fixed first.
- **R-2 (high): carry and reuse combine into a verdict for inputs neither judged.** Mitigation: precedence reuse (exact input) → carry (identity proof) → fresh launch, and carry never feeds reuse, with a negative test for this.
- **R-7 (high): environment-only adjudication becomes a verdict override.** Mitigation: keep R10's constraints, prefer prevention (a pre-launch environment check) over later adjudication, and count adjudications separately.
- **R-8 (high): the success metric cannot be computed from the tracked journal.** Mitigation: make journalling of every launch, reuse, carry and re-owe a prerequisite; derive the baseline from role-host receipts; accept `inconclusive`.
- **R-11 (high): ownership collisions with pending tickets and work packages.** Mitigation: the ADR states a combination rule plus deltas assigned to the existing owners, and sequences them after the phase-43 epic where needed.
- **R-14 (high): the reuse manifest misses a new input.** Mitigation: every new input INV-010 adds (draft state, candidate position, carried-from lineage, adjudication record) enters the C1 manifest with a mutation test.
- **R-3 (medium): deferral trades review cost for wall time.** Mitigation: measure wall time and sentinel rounds per merged ticket; a treatment that lowers reviews but raises total consumption fails.
- **R-4 (medium): "the base stopped moving" is not observable.** Mitigation: define stability as a conveyor-controlled property (next merge candidate by a deterministic priority), with the head-bound gate as the backstop.
- **R-5 (medium): once-per-stack review exceeds the packet bound and loses per-ticket accountability.**
- **R-6 (medium): the draft/undraft order fix can open a merge window.** Mitigation: the host accepts `isDraft` as a recorded input, and undraft stays unreachable without conform.
- **R-9 (medium): the "phase 43" 23/13 baseline is from the MYD-17835 target-project run.** Corrected in RESEARCH.md; cohorts are kept separate.
- **R-10 (medium): cross-runtime parity is asymmetric.** Codex runs arch-review through the generic delivery host without the Claude host's identity checks. Shared deterministic layers (duty ordering, carry) apply to both; host-side reuse is Claude-first and the Codex part is a named gap.
- **R-12 (medium): phase-43 epic latency blocks T-43-13 and C1.** Mitigation: pilot the independent levers first.
- **R-13 (medium): size-based model or effort invalidates cohorts.** Kept as a study only, run as a separate ADR-021 experiment after the timing change.
- **R-15 (medium): integrator overlap removed too eagerly.** Mitigation: fix N44 first and keep the integrator judging the combination.
- **R-16 (low): orchestrator re-read cost is not addressed by review count.** Measured separately.
