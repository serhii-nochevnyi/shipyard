# Research

Synthesis of four sealed research lines (Claude, `claude-sonnet-5-5` / `xhigh`, ADR-014 `adr-014.v7`, application receipts `compliance: verified`, run `deliver-build-research-82fa6294-b69e-48bd-ae8e-ceac052391b3`). Full findings with command ledgers: `research/system-state.md`, `research/alternatives.md`, `research/constraints.md`, `research/risks.md`. Sealed copies and receipts: `~/.local/state/shipyard/claude/2debdeaf…/planning-artifacts/` and `EVIDENCE.md`. Citations below are `path:line` at `d8a70dec` unless prefixed `origin/main:` (= `v0.72.2`, `be7ab4f3`).

## Current system state

### Baseline and deployment state
- The packet revision `d8a70dec` is 9 commits behind `origin/main` (`v0.72.2`). The observed refusals came from a v0.72.x build: the rejection is at `role-artifact.cjs:1827` at `d8a70dec` and at `:3955` on every commit from #456 to `v0.72.2` (system-state F0, §2).
- Verified by the operator-side check after research (not by the sandboxed researcher): the installed Codex bundle is `shipyard_version 0.72.2`, `~/.codex/shipyard/scripts/role-artifact.cjs:3955` contains the refusal, `~/.codex/shipyard/codex-capabilities.json` exists and its sha256 equals the agents manifest `capabilities_digest`, and `CODEX_HOME` is not set in the session environment. So the INV-015 `RUNTIME_UNAVAILABLE` was an environment-resolution miss, not missing evidence.
- `d8a70dec` (PR #421) is contained in `v0.72.0`–`v0.72.2`. The refusal persists in all of them; #482 only fixes the first-run case.

### No single launcher; environment is the caller's job
- The agent runs `pipeline-config.cjs resolve`, `deliver-dispatch.cjs build … > file`, then a host script in whatever environment its session provides (`commands/investigate.md:31-36,98-115`). `deliver-dispatch.cjs launch` exists only for `executor` and `pr-sentinel`, passes `process.env` through unvalidated (`deliver-dispatch.cjs:250-255,308-375`).
- Codex home, capability evidence and agents dir are resolved at 20+ sites with 8+ distinct rules (system-state §4). Decisive: `codex-runtime-host.cjs:160-171` finds `$CODEX_HOME/shipyard/codex-capabilities.json` only when `CODEX_HOME` is set, while sibling sites default to `~/.codex`. Reproduced with the supported probe CLI (system-state E11). `codex-agent.cjs:84-96` has no env or bundle fallback at all.
- Capability evidence has three possible homes (env/flag document, marketplace snapshot, bundle copy). The manifest binds the bundle copy by digest at install only; runtime readers check shape only (`codex-runtime-host.cjs:142-158`, `gsd-tune.cjs:200-215`).
- Claude has no capability file; it probes the CLI live (`claude-runtime-host.cjs:178-219`). Its home has three precedences (`CLAUDE_CONFIG_DIR`, `CLAUDE_HOME`, `$HOME/.claude`).
- Launch order is bookkeeping before capabilities (`codex-delivery-host.cjs:1878` then `:1881`), so failures appear one at a time and the first leaves state behind (authority dir and key are created before the refusal, `role-artifact.cjs:1815` precedes `:1826`).

### Pre-existing history after an upgrade
- Local bookkeeping route: `dispatch-record.cjs:1294-1327` → `role-artifact.cjs:trustedBookkeepingMutation` (`:1808-1871`). With no authority catalogue the authenticated set is empty (`:1777-1792`), so any existing `.planning/graph/provenance/*` member refuses a required mutation (`:1826-1827`). No migration, quarantine or "historical" status exists anywhere (`grep -i migrat` over the scripts shows none for bookkeeping, catalogue, run store or writer lease).
- The only legacy-admission API, `admitHistoricalArchive` (`role-artifact.cjs:2050-2077`), covers retained role archives, has no CLI and no non-test caller. The error text at `:1061` names a path that does not exist for sidecars.
- Not Codex-only: `claude-role-host.cjs:1350-1354` has the same exposure; at v0.72.0+ the Claude delivery CLI also passes `worktree` and is exposed (constraints §0.1 item 3). Claude-side reproduction was not run.
- `dispatches.json` is tracked, so a `git pull`/checkout/rollback that rewrites it would trip its pin on the next trusted mutation (inference, not reproduced). Authority is keyed by realpath and `os.homedir()`; a renamed project or removed authority dir behaves like "no catalogue" (inference).
- Consumers that treat sidecars as host-owned evidence: `codex-arch-review-context.cjs:443-458`, `claude-role-host.cjs:1099-1109`. Blanket-pinning old sidecars would feed them into that logic.

### phase + repository + ADR digest
- At `d8a70dec` the binding did not exist: `commands/decompose.md:302,314,400` promised `phase=;repository=;adr=<digest>`, neither host built it and the sealer accepted any non-empty subject.
- On `origin/main` (#486, `78cdca26`) both decomposition hosts share `decompositionSubject`/`assertDecompositionSubject` in `planning-result-sealer.cjs`. The record of the original incident was not found in the repository.
- Still divergent after #486: five subject grammars (S1 run subject `phase;input;repository`, S2 seal subject `phase;repository;adr`, S3 integrator `…;tickets=`, S4 arch-review `PHASE_SUBJECT`, S5 research `<INV>:<line>`), only S4 and S2 (since #486) with a shared definition; three different phase patterns for S3; and four ways to build repository identity (remote `owner/repo`, git-common realpath, `scope.repository`, worktree realpath). The same decomposition seals under different repository strings on Claude and Codex.

### Preflight and refusal surface
- `make doctor` checks installed hooks, bundle and agents; not capabilities, policy hash, authority catalogue or sidecars; it ignores the `CODEX_HOME` env var (`shipyard-doctor.cjs:218`) and is checkout-only. `codex-runtime-host.cjs --capability-only` always exits 0. `run-rollout.cjs` gates autonomous controller launches only. `sentinel-preflight.cjs` runs only for `pr-sentinel`.
- `hint[CODE]` lines print from four hosts only. `ARCHIVE_AUTHORITY_*`, `RUNTIME_CAPABILITY_MISSING`, `AMBIGUOUS_RUNTIME`, `STALE_POLICY` and others have no named remedy; `RUNTIME_UNAVAILABLE`'s remedy ("install and authenticate the runtime") does not match the capability cause, and its message is double-prefixed. Several remedies are checkout-relative (`make …`, `scripts/…`) and cannot run from an installed bundle.

### Tests
- No unit, smoke or live test covers launch with no env variables, upgrade with pre-existing sidecars and no catalogue, or the installed bundle driven from a clean shell. `tests/live/live-round.sh` runs source-tree scripts against a fresh fixture (system-state §9).
- The repository has no UI entry point (only `--skip-ui` in `commands/decompose.md:386-390`); "the existing supported UI path" is GSD-owned and undefined here (constraints §0.1 item 5).

## Constraints

### Technical
- Authority is per-worktree, HMAC-protected, private, bounded and written only through `trustedBookkeepingMutation` under the catalogue lock. Trust-bearing markers belong in the protected authority namespace, not under `.planning/`; legacy sidecar bytes stay frozen; forged new or altered members must keep refusing (constraints T-01…T-12).
- Capability evidence is installer-written, byte-identical and manifest-digest-bound. Discovery may locate and validate it, never synthesize it from policy (T-16, pinned by `tests/smoke/codex-shipyard-smoke.sh:145-155`).
- Runtime identity needs explicit active evidence; `CODEX_HOME` alone is compatibility-only (`runtime-context.cjs:193-233`). The native child environment is scrubbed; no provider fallback (`codex-runtime-host.cjs:1215-1238`).
- Claude launches sandbox-deny the model's read/write of the authority directory (`claude-runtime-host.cjs:751`), so adoption and preflight must be host-side code.
- Both bookkeeping and capabilities must be checked before any state is created.

### Product
- README/Makefile command surface is pinned by `tests/smoke/docs-smoke.sh`. ADR-014 v7 is untouched by launching/preflight.
- ADR-025 (untracked in this checkout) puts "automatic environment adjudication" out of phase-47 scope and rejected a single-launcher shape for that phase; this INV's design therefore needs its own accepted decision (constraints PR-02, T-25).

### Delivery
- CI is `make test-fast` on Linux/Node 24.15.0; main-bound PRs regenerate `plugins/shipyard`; the digest pin changes only via `make refresh-runtime-digests`; release needs live receipts on both runtimes; authority-touching tests must override `os.homedir`; a new script file costs a publication-pin update.

## Unknowns
Mirrored in OPEN-QUESTIONS.md. Not measured by research: Claude-side no-env behaviour and reproduction of the refusal on the Claude hosts; rollback after migration; behaviour of an orphan sidecar after a failed launch; Codex `SessionStart` hook semantics; whether GSD core exposes a reusable preflight; the incident record for the ADR-digest mismatch; field inventory of upgraded projects with legacy history.
