# Evidence known at intake (2026-10-15)

Facts observed in this checkout. They are inputs for research, not accepted findings.

- Legacy provenance refusal and its isolated reproduction (`ARCHIVE_AUTHORITY_INVALID`; 64 sidecars; no catalogue; introduced by `d8a70dec`/PR #421): `.planning/investigations/INV-015-ui-lifecycle-integration/LAUNCH-REFUSAL.md`.
- The user-authorized cleanup archived those sidecars to `~/.local/state/shipyard/legacy-bookkeeping-backups/claude-shipyard-20261015T144954Z`; this was local state cleanup, not a compatibility fix.
- Next refusal after cleanup: `RUNTIME_UNAVAILABLE: explicit Codex capability evidence is required` (separate admission requirement).
- Env/home/capabilities resolution sites: `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:707-710`, `codex-runtime-host.cjs:167-168,395,441,729,882`, `codex-decompose-host.cjs:518`, `codex-agent.cjs:71,93`, `dispatch-record.cjs:453`, `gsd-tune.cjs:121,283-285`, `runtime-context.cjs:100-106`; installers `scripts/install-shipyard-codex.sh:22-38`, `scripts/install-shipyard-capability.sh:19-35`.
- Earlier host-side defects fixed in the phase-47 line: `docs/audits/2026-10-03-phase47-launch-fix.md`, `docs/audits/2026-10-03-phase47-runtime-failure-state-fix.md`.
- A grep for ADR-digest naming in `deliver-dispatch.cjs`/`run-contract.cjs` found no obvious shared symbol; locating the producer and consumer is a research task, not a settled fact.

# Research run (2026-10-15)

- Host: `claude-investigation-host.cjs` from the installed plugin `shipyard@shipyard` 0.72.2, request built by `deliver-dispatch.cjs build research INV-017-launch-and-upgrade-reliability --runtime claude`. No env variables or manual cleanup were needed to launch.
- Controller run `deliver-build-research-82fa6294-b69e-48bd-ae8e-ceac052391b3`; state dir `~/.local/state/shipyard/claude/2debdeafa840fd0c5cd5dc6ed1e7613cbfd8d6b28d6856b53ad4416fcaae6a11/`.
- Four lines `completed`, each with an `adr-014.application` receipt: requested = applied = observed `claude-sonnet-5-5` / `xhigh`, policy hash `3978b087…4570`, `compliance: verified`. Sealed artifact sha256 matches the local copies in `research/`: system-state `bb3d1cbd…1e4f`, alternatives `6cea7c2c…8c7c`; constraints and risks verified the same way.
- Operator check after research (the researcher's sandbox could not read `$HOME`): installed Codex bundle `shipyard_version 0.72.2`; `~/.codex/shipyard/codex-capabilities.json` sha256 `ccf2a48b…4aad` equals the manifest `capabilities_digest`; `~/.codex/shipyard/scripts/role-artifact.cjs:3955` contains the refusal; `CODEX_HOME` unset in the session; local `main` is 9 commits behind `origin/main`.
- Research noted `request phase: 46` / ticket `T-46-00` come from the builder, not from this INV.

# Spikes S-1 and S2 (2026-10-15)

See `spikes/SPIKES.md`. S-1 reproduced the legacy-sidecar refusal on v0.72.2 for the call shape all three hosts pass, showed refused launches create an authority directory, an unpinned linked-worktree sidecar that blocks the next project-root host, and harmless orphan sidecars. S2 showed the subject grammars already disagree on whitespace in the repository value.

# Original ADR-digest incident (found 2026-10-15 in the parallel Codex session)

Source: `~/.codex/sessions/2026/10/15/rollout-2026-10-15T13-17-05-01a13f10-c474-79f2-b554-de7676c54b8a.jsonl`, records 101–139, 2026-10-15T11:31–11:37Z, session working on FlowPDF Phase 9 planning with Shipyard run from `/Volumes/KINGSTON/claude-shipyard`.
- The decomposition contract (`commands/decompose.md:302,314,400`) requires the authenticated subject `phase=<phase>;repository=<repo>;adr=<ADR digest>`. The session found that `codex-decompose-host.cjs:140` records only phase and repository, with no `adr=`, in both the installed copy (`/Users/serhii/.codex/shipyard/scripts/codex-decompose-host.cjs`) and the source checkout.
- The session therefore refused to accept the plan-generation path as contract-conforming and asked permission to fix Shipyard outside FlowPDF. An earlier blocker, a read-only researcher, had already been fixed.
- This matches research finding F6: the incident is the missing `adr=` binding at `d8a70dec`/v0.71 (fixed by #486 in v0.72.1), not a mismatch between two present grammars. The remaining divergence (S1 versus S2 grammars, four repository identities, whitespace) is a separate latent defect found by research and spike S2.
