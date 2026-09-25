# Open questions

- [ ] Which projection inputs form each local fingerprint and which aggregate dependencies must invalidate together? — owner: system-state research
- [ ] Which existing handoff transition safely bounds parent context while preserving active dispatch ownership and attempt history? — owner: alternatives research
- [ ] What candidate/evidence contract allows trusted finalization recovery on an unchanged tree, and what must be revalidated after base movement? — owner: constraints research
- [ ] Which wakeup/installation gaps remain after the shipped T-39-03 and T-39-17, and which only require regression verification? — owner: system-state research
- [ ] How will full-prompt observations and verified outcomes join existing telemetry without double counting or unproven quota claims? — owner: constraints research
- [ ] Which phase-40 file owners need dependency changes to preserve phase 41 before phase 40 without duplicate work? — owner: risks research

Gate 1 remains open until evidence resolves these questions and decisions are
recorded. No completed research or accepted ADR is implied by the seed audits.

- [ ] Resolve the phase-40 Codex planning prerequisites needed to plan phase 41: promote their minimal dependency closure or revise phase ordering. See ../../phases/41-reduce-pipeline-subscription-overhead/PLANNING-BLOCKERS.md. — owner: maintainer and planning
