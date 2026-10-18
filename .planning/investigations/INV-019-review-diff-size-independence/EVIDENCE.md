# Evidence known at intake (2026-10-18)

Facts observed in this checkout and on the phase 50 epic. They are inputs for research, not accepted findings.

## Measured on phase 50 (epic/50 -> main, PR #521, head f80dfea7)

- Integrator v1 prompt captured from the Claude host (stdin of the `claude` child): 2,647,625 bytes. One section `## Complete integration artifact` holds a JSON packet of 2,635,307 bytes: `dictionary` (34 content blocks, 2,525,390 B), `body` 97 KB (role_context 68 KB, required_refs 13 KB, logical_source_obligations 10 KB), `obligations` 16 KB.
- The dictionary: one block of 2,043,596 B is the combined diff; 29 phase-50 plan files (6.8–38.8 KB each, ~0.38 MB total); ADR-014 (10 KB) and its JSON ladder (9 KB), ADR-020 (8.5 KB), ADR-030 (9 KB). No other repository content, no earlier phase artifacts.
- Diff composition (107 files): `tests/unit` 661 KB, `plugins/shipyard` (generated mirror) 643 KB, `plugins/delivery-pipeline` 628 KB, `tests/smoke` 81 KB. Changed lines are 674 KB (33%); context plus headers 1,369 KB (67%) because the host runs `git diff --unified=50`. The mirror files duplicate their sources byte for byte (for example `role-artifact.cjs` 99,159 vs 99,247 B).
- Result: `terminal_reason: prompt_too_long`, Claude child exit 1; `claude-role-host` printed only `Claude process exited 1` (the child's stderr is not surfaced). The estimated packet is 640,131 tokens; the raised host bound is 750,000 (`INTEGRATOR_MAX_PACKET_TOKENS`), so the host admits a prompt the model refuses.
- Earlier epics' product diff (without `.planning/` and the mirror, `--unified=50`): 36: 1.79 MB, 43: 1.72 MB, 46: 1.57 MB, 45: 1.13 MB, 33: 1.08 MB, 39: 0.61 MB, 44: 0.29 MB. Phase 50 is 1.43 MB on that measure, so it is not unusually large.

## Where the diff is embedded (to be verified by research)

- Claude integrator: `plugins/delivery-pipeline/scripts/claude-role-host.cjs` `diffText` (~459) and the integrator preparation (~625 `combinedDiff`), `DIFF_MAX_BYTES`, `INTEGRATOR_MAX_PACKET_TOKENS`, `PROMPT_MAX_BYTES`; Claude arch-review preparation (~490-560) builds a diff with `--unified=50` and `FILE_LIMITS.material`.
- Pathspec: `plugins/delivery-pipeline/scripts/development-artifacts.cjs` `productPathspec()` excludes development artifacts but not `plugins/shipyard/`.
- Codex arch-review: `plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs` (`FILE_LIMITS` ~110, the diff ~1093, integration-review v2 binding ~643); Codex delivery host `codex-delivery-host.cjs` (review contract v1/v2 ~120, ~793, ~984-1001, ~3091); `phase-integrator-preflight.cjs`.
- Packet validation: `context-packet.cjs` `AUTHORITY_KEYS` (~34, includes `receipt`) and `rejectAuthorityKeys` (~196, called ~455 and ~523); `role-artifact.cjs` `registerPhaseArchiveRoster` (~2438), `selectPhaseArchives` (~2627), `ARCHIVE_AUTHORITY_REQUIRED` (~2479).
- Role instructions: `plugins/delivery-pipeline/references/integrator.md`, `references/arch-review.md`.

## Other observations from the phase 50 attempt (not yet root-caused)

- Integrator v2 (`shipyard.integration-review.v2`) hits `CONTEXT_OVER_BOUND` in `codex-arch-review-context.cjs`: impact sources 25.7 MB / 1523 files against `FILE_LIMITS.material` 16 MiB; with the bound at 64 MiB the packet was 5,211,605 tokens.
- Phase arch-review on the Claude host: `CONTEXT_PACKET_AUTHORITY: packet.role_context.phase_archive_selection.records.0.receipt is host-owned launch authority`; the same code is on main.
- `claude-role-host` always reads `<worktree>/.planning/graph` (no graph-dir option) and rewrites a tracked `delivery-front.json` there, making the next run refuse a dirty tree; a retained phase roster must be registered against that graph directory.
- The phase architecture review requires a roster of the phase tickets' original receipts retained outside the worktree (`ARCHIVE_AUTHORITY_REQUIRED`).

# Research run (2026-10-18)

- Host: `claude-investigation-host.cjs` from the installed plugin `shipyard@shipyard` 0.73.0; request built by `deliver-dispatch.cjs build research INV-019-review-diff-size-independence --runtime claude`. Source revision `1c34583b`.
- Four lines `completed`, each with an `adr-014.application` receipt, applied = observed `claude-sonnet-5-5` / `xhigh`, compliance verified, policy hash `3978b087…4570`; sealed artifacts copied to `research/` (system-state 67,167 B sha256 `dd23ca80…939d`; alternatives 65,400 B; constraints 69,459 B; risks 62,981 B).
- Disclosure from the `constraints` line: its cleanup glob removed three scratch files in the shared temp directory that belonged to sibling research workers (`inv019-devart.txt`, `inv019-home`, `inv019-roles.txt`). No investigation artifact was touched; commands whose output lived there may need re-running.
- Corrections to the intake evidence are listed in RESEARCH.md ("Corrections to the intake evidence").
