# Risks

Full register (36 risks, a gate/ownership/instruction-loss table, hot-file owner chains, spikes): [research/risks.md](research/risks.md).

- **Phase-43 status is misread (high).** The phase-43 "merged" tickets are only in the epic, not in `main` or 0.68.0. Mitigation: judge independence against the unmerged `files_modified` and the epic → `main` merge, and recheck live before Gate 2.
- **S1 binding traps or releases the wrong session (high).** Mitigation: compare realpaths, never fall back to newest-wins when a binding exists, give a legacy marker a bounded behaviour, and test two armed sessions, a fork, a crash and a scope switch.
- **Adjudication becomes a verdict override (high, R10).** Mitigation: classification first. Adjudication only on an unchanged head, base and instruction set, with exact same-command evidence, the original violation preserved, and explicit authority.
- **Synthetic receipt or payload (high, P2, R17).** Mitigation: recover only authenticated original bytes and receipts; refuse when they are absent.
- **Hot-file serialization (high).** Mitigation: one owner per hot file, cross-phase `depends_on` on the owning T-43 ticket, and Gate 2 as the check.
- **Treatments cannot be measured (medium).** Mitigation: one treatment at a time on matched cohorts, results `inconclusive` otherwise, and review telemetry from ADR-022 as a prerequisite.
- **Merge-queue dependency (medium, R18-c).** Mitigation: keep `base-merge.cjs` as the fallback and verify plan availability and branch rules before committing to it.
- **Installed-host drift (medium).** The research did not inspect `~/.claude` or `~/.codex`. Mitigation: a doctor check before any installed-hook acceptance (S1).
