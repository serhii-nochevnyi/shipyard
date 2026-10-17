---
status: closed
closed: 2026-10-15
adr: .planning/architecture/ADR-030-launch-and-upgrade-reliability.md
---
# Problem

## What we are solving
Make one supported launch path for the Shipyard host that prepares its own environment, verifies compatibility and launches the host. Today part of these duties is left to the invoking agent, so a missing environment variable or old local state blocks work before any role runs. Investigate launch and upgrade reliability of the installed pipeline: environment discovery, post-upgrade state migration, producer/consumer contract sharing, installed-package end-to-end checks and preflight diagnostics.

## For whom
Shipyard operators and agents who install or upgrade the pipeline and then run ordinary commands in an existing project; Shipyard maintainers.

## Current pain
Origin (stated by the user, 2026-10-15): these failures surfaced in a parallel Codex session working in this same repository. The 64 legacy sidecars and the refused launches came from Codex host runs sharing this checkout's project-local state (`.planning/graph/`) and the per-user authority namespace with Claude sessions. Mixed-runtime concurrent sessions on one project are therefore a normal scenario, not an edge case.
Observed during the INV-015 launch (see `.planning/investigations/INV-015-ui-lifecycle-integration/LAUNCH-REFUSAL.md`):
- An upgraded host refused a project carrying 64 pre-existing provenance sidecars (`ARCHIVE_AUTHORITY_INVALID`, "unknown host provenance member before trusted mutation") because the local-bookkeeping route added by `d8a70dec` (PR #421) has no migration for old history. The only recovery was a manual, user-authorized archive-and-delete of history.
- After that, the host refused with `RUNTIME_UNAVAILABLE`: "explicit Codex capability evidence is required". The capabilities file and Codex home were supposed to come from `SHIPYARD_CODEX_CAPABILITIES_FILE` / `CODEX_HOME` in the caller's environment; several scripts each resolve them differently (`codex-delivery-host.cjs`, `codex-runtime-host.cjs`, `codex-agent.cjs`, `gsd-tune.cjs`, `dispatch-record.cjs`).
- An ADR-digest producer/consumer mismatch (phase + repository + ADR digest) was observed in an earlier incident; its formation and its check do not share one implementation.
Stated failure class: a forgotten variable or stale data blocks work, and recovery requires knowledge of internal host commands.

## What success will be
After install or upgrade, the ordinary command works in an existing project with no manual `export`, no artifact cleanup and no knowledge of internal host commands. Concretely, the user requires:
1. Automatic environment discovery: the launcher finds the active Codex home and the installed capabilities file, validates them and passes them to every child process.
2. Post-upgrade state migration: old dispatch/launch records are kept as historical and unverified, never trusted, and never block new launches. Deleting history is not a required procedure.
3. One contract for producer and consumer: building and verifying phase + repository + ADR digest use a shared implementation.
4. End-to-end checks of the installed package through real supported entry points: launch with no env variables, repository upgrade carrying old history, and a full UI cycle.
5. A clear preflight before any agent launches, naming the concrete incompatibility and the supported recovery.
Definition of done: the criterion above holds on both runtimes' supported paths. The investigation must return evidence, two to four alternatives with costs and risks, and a user-selected design.

## What is definitely out of scope
- The UI lifecycle investigation (`INV-015-ui-lifecycle-integration`) is separate and this INV has no dependency on it. The "full UI cycle" check means only an installed-package end-to-end run of the existing supported UI path through real entry points; it does not decide UI-SPEC, UI-review or `ui-phase` design.
- No production changes, tickets, PRs, commits, deployment or edits to target projects during investigation.
- No bypass of provenance, receipts or host admission; no silent trust of legacy files; no switching runtime or provider; no model-policy changes (ADR-014 stays as is).
- Cleaning or deleting the user's existing history is not an accepted remedy and is not performed here.
