# Options

<!-- The recommendation is not written by the agent — the choice belongs to the human (DECISIONS.md). -->
Source: `research/alternatives.md` §3–§5. Every option is a complete package covering environment preparation, preflight, legacy-state migration, digest contract and end-to-end verification, and keeps the constraints in `RESEARCH.md`.

Building blocks the options combine differently:
- **ED2 self-locating environment**: derive the bundle root from the executing script, read home, capabilities path/digest and policy hash from the bundle manifest; env vars are explicit overrides; an env value that disagrees with the bundle is a named conflict, not a silent pick.
- **MS1 adopt-as-historical-unverified**: under the authority lock, record the physical inventory of pre-existing sidecars in the HMAC-protected catalogue under a new separate versioned field; files stay in place; the unknown-member check allows `authenticated ∪ legacy`; new or altered members still refuse; legacy is never added to `bookkeeping_state`/pins.
- **DC2 one subject-contract module**: build/parse/verify for every subject family plus a single `repositoryIdentity()`.
Obligations for any MS1 variant (research alternatives §3.2): legacy members never become pins, never satisfy the `writeProvenanceOnce` existence short-circuit for a new dispatch id, adoption is one-shot and lock-serialised, later change of a legacy member is reported, the record is versioned.

## Option A — Minimal change: repair each failing site
Add the `~/.codex` default and bundle file to `codex-runtime-host.cjs`, share a small helper in an existing module, add hint keys and fix the `RUNTIME_UNAVAILABLE` remedy, implement MS1 in `role-artifact.cjs`, adopt #486 plus a cross-module contract test. No new entry point; agents still launch hosts directly. Roughly 12–25 files (assumption calibrated on #482 = 10, #486 = 21).

## Option B — [chosen as B-lite] Library-first: shared environment + preflight module, hosts self-prepare
One resolver (ED2) and one `preflight()` with a shared remedy catalogue, called by every host entry before `controller.begin`; `--preflight` flag per host; MS1 as a preflight step; DC2. Documented host invocations stay valid; a direct host call now self-prepares. Roughly 25–45 files.

## Option C — New single launcher CLI ("front door"); hosts stay strict
A bundle script (e.g. `shipyard-launch.cjs <role> --args-file X`) self-locates, runs the full preflight, performs MS1, then spawns the existing host with a validated child environment and passes exit code/`hint[CODE]` through. Commands and generated skills call the launcher. Hosts keep strict behaviour for direct calls. Builds on B's library. Roughly 30–50 files. Conflicts with the single-launcher shape ADR-025 rejected for phase 47, so it needs its own accepted decision.

## Option D — Lifecycle-time preparation: persisted launch context at install/upgrade/session start
Extend the Codex `SessionStart` bootstrap and installer to write a digest-bound `launch-context.json` and run MS1 for the session's project; hosts read it through a small reader. Claude has no equivalent preparation hook. Roughly 20–35 files plus hook-semantics uncertainty.

## Comparison

| | A — Minimal | B — Library, hosts self-prepare | C — Launcher CLI | D — Lifecycle prep |
|---|---|---|---|---|
| One supported launch path | No | By convention (host entries) | Yes | Implicit (session start) |
| Env discovery (req 1) | Partial (3 sites) | Yes, all sites | Yes | Codex only, if context present |
| Legacy historical/unverified (req 2) | Yes (MS1) | Yes (MS1) | Yes (MS1) | Session project only |
| Shared digest contract (req 3) | Partial (#486 + test) | Yes (DC2) | Yes (DC2) | Independent |
| Installed e2e (req 4) | New harness | New harness on existing entries | Launcher is the entry | Install→session harness |
| Preflight before any agent (req 5) | Messages after failure | In each host, optional flag | Standalone and automatic | Session start only |
| Claude coverage | MS1 yes, env n/a | Yes | Yes | No hook; needs in-host fallback |
| Files touched (assumption) | 12–25 | 25–45 | 30–50 | 20–35 |
| New file / publication pin | 0 | 0–1 | ≥1 | ≥1 |
| Command prose and pinned tests | No change | No change | Change | Minor |
| Rollback | Revert PR | Revert PR | Revert docs, launcher inert | Revert, leftover file harmless |
| What it forecloses | Nothing; drift can recur | A single typed front door | Direct-host path deprecated; extra process hop | Command-time diagnosis; non-hook invocations; Claude |
| Biggest unknown | `role-artifact.cjs` change review | A missed host | Signal/lease behaviour through a wrapper | Hook semantics |

Chosen: B-lite with MS1 (DECISIONS.md, 2026-10-15). Composition notes (facts, not a recommendation): MS1 and the hint fixes are needed by every option; B's library is the natural core of C; D's context file is orthogonal and could be added to B or C later. The status quo (refuse and document manual recovery) is not offered: it cannot satisfy success items 1, 2 and 5.
