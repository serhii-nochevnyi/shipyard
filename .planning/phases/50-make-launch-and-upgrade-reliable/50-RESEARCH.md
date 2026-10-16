# Phase 50: Make launch and upgrade reliable - Research

**Researched:** 2026-10-15
**Domain:** Shipyard host-side delivery conveyor — installed-package launch, environment discovery, post-upgrade state adoption, shared subject contract, hermetic acceptance (Node.js `.cjs` scripts, no external libraries)
**Confidence:** HIGH for the code map and constraints (re-read at `v0.72.2`, `be7ab4f3`); MEDIUM for design skeletons (proposals, not yet built); LOW only where tagged `[ASSUMED]`

**Provenance note.** The 15 packet sources were re-hashed this session and every SHA-256 matched the attached digests. The packet's research lines cite `d8a70dec` line numbers; local `main` has since been fast-forwarded to `v0.72.2` (`git describe` → `v0.72.2`, HEAD `be7ab4f3`), and `v0.72.0` (#456) added ~7,900 lines (`git diff --stat d8a70dec HEAD -- plugins/delivery-pipeline/scripts` → `19 files changed, 7949 insertions(+), 337 deletions(-)`). **All line numbers in this file are `v0.72.2` unless a section says otherwise.** Tags: `[VERIFIED: path:lines]` = opened with `Read` this session and the value quoted beside it; `[grep-located]` = line found by `Grep` this session but not re-read (planner/executor must re-read before editing); `[CITED: file]` = taken from a packet document; `[ASSUMED]` = proposal or unverified.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

*(Copied verbatim from `.planning/phases/50-make-launch-and-upgrade-reliable/CONTEXT.md`, "Locked scope (from ADR-030)", then the accepted ADR-030 decisions that CONTEXT.md names as its source of truth.)*

**Goal (CONTEXT.md):** After install or upgrade, the ordinary command works in an existing project on both runtimes with no manual `export`, no artifact cleanup and no knowledge of internal host commands. This is the readiness criterion of ADR-030.

**Locked scope (CONTEXT.md):** Library-first shape with no launcher, no persisted launch context, no new script file; self-locating environment with digest-verified capabilities and a refusal on env/bundle conflict; automatic one-time adoption of legacy sidecars as `historical-unverified` in the protected authority state; changed legacy member or later unknown file blocks with a named remedy; shared preflight in every host before `controller.begin` with `--preflight`; Claude and Codex share one route; existing catalogue lock only for concurrency; one `repositoryIdentity()` and one subject grammar contract; hermetic CI acceptance core plus live receipts at release.

**Planning mode (CONTEXT.md):** `--tdd`, granularity `fine`. UI design: none, so `--skip-ui`.

**Constraints to carry into every ticket (CONTEXT.md):**
- Never weaken provenance, receipts, host-owned writer/lease, or the ADR-014 boundary; legacy files are never promoted to trusted evidence.
- `role-artifact.cjs` and `dispatch-record.cjs` changes need the runtime-digest refresh (`make refresh-runtime-digests`) and a regenerated `plugins/shipyard` package on main-bound PRs; never edit generated files by hand. **(See Discrepancy D-1: the digest pin does not cover those two files.)**
- Authority-touching tests override `os.homedir`; the acceptance harness isolates every state root and asserts real state is unchanged.
- The unauthenticated linked-worktree sidecar write path found by spike S-1 must be covered.
- Verification commands per ticket are scoped to `files_modified`.
- Concurrent Codex and Claude sessions share this checkout; do not move shared state (checkout, adoption) without the lock.

**ADR-030 Decision (accepted 2026-10-15, verbatim):**
- **L-1 Shape:** implement a library-first change (research Option B, "B-lite"): one shared environment resolver in an existing module and a preflight inside every host entry before any state is created, with no new launcher CLI, persisted launch context or new script file.
- **L-2 Self-locating environment:** a host derives its bundle root, Codex home, capabilities path and policy hash from the executing bundle's manifest. An explicit flag or environment value that agrees with the bundle is accepted; one that disagrees is a named conflict and refuses, naming both values. Without a bundle (source checkout) the explicit value is required. The resolver passes only the validated Codex home, capabilities path and runtime to child processes; other variables keep their current owners.
- **L-3 Capability evidence:** the evidence is the installer-written bundle copy, located from the bundle and verified against the manifest `capabilities_digest` and the ADR-014 grid at every launch. Discovery never synthesizes evidence and the installer's explicit-evidence refusal is unchanged. No live `codex debug models` probe per launch; snapshot staleness against the installed Codex CLI is reported by preflight.
- **L-4 Legacy-history adoption (MS1):** on first admission of a worktree with pre-existing sidecars and no authenticated record, the host adopts them automatically, once per worktree, under the existing catalogue lock, recording the inventory in the protected authority state under a separate versioned legacy field with status `historical-unverified`. Files stay in place and unchanged. Legacy members never become authenticated pins, never satisfy the existence check for a new dispatch id, and are never verified evidence. The unauthenticated linked-worktree write path is covered by adoption or pins its own sidecar.
- **L-5 After adoption:** a changed legacy member blocks the launch; any later unknown file blocks with a named remedy to update the host that wrote it. History is never deleted, archived or moved by a supported procedure.
- **L-6 Preflight:** every host runs preflight before `controller.begin` and before any bookkeeping, reports every incompatibility in one pass with a remedy that runs from the installed bundle, and every entry point prints `hint[CODE]` lines. Each host accepts `--preflight` to show the result without launching and to exit non-zero on any incompatibility. `--capability-only` keeps its always-exit-0 contract. A refused launch creates no authority directory and no sidecar.
- **L-7 Claude and Codex share one route:** the Claude delivery, role, investigation and decomposition hosts use the same resolver, preflight and bookkeeping admission as the Codex hosts; Claude gets no preparation hook.
- **L-8 Concurrency:** adoption and migration use only the existing catalogue lock; a second session waits a bounded time or gets a named refusal with a remedy. No new cross-runtime coordination.
- **L-9 One subject contract:** the canonical repository identity is the realpath of `git --git-common-dir`, built by one `repositoryIdentity()` in an existing module with one character class and one parse for every subject family; a contract test round-trips each family on both runtimes with a path containing whitespace, a non-ASCII path and a rejected character. Sealed artifacts that used the old Codex `owner/repo` form must still verify.
- **L-10 Acceptance:** a hermetic CI core (Linux, Node 24, isolated HOME, state roots and graph directory) covering launch without env variables on both runtimes; upgrade with each legacy variant (partial history, linked worktree, changed legacy member, new unknown member, symlinked member); concurrent Codex and Claude launches including during adoption; assertion that real user state is unchanged; and a UI smoke through the existing GSD path (`gsd-ui-phase` then `gsd-ui-review`) or an explicit declared gap if it cannot run non-interactively. Live receipts on both runtimes at release, as already required.
- **L-11 Verification obligations carried into delivery:** the first tickets must close these before relying on them: audit every reader of authority pins to show legacy members are never promoted; confirm bounded behaviour of `catalogue.lock` under pid reuse; record the result of upgrade → downgrade → upgrade as a known limitation unless it shows a hazard; define the legacy schema marker and version (the catalogue label `shipyard.role-archive-catalogue.v1` was reused when pins were added); check ordering with the run-store and planning-writer lease during adoption; measure Claude launch with no `CLAUDE_*`/`SHIPYARD_*` variables and the reader of `CLAUDE_HOME`; find which component writes the `.git/info/exclude` entries for provenance and runs and what happens in a fresh clone; decide whether GSD core exposes a reusable preflight.

### Claude's Discretion

CONTEXT.md declares no "Claude's Discretion" section. The matters ADR-030 leaves to decomposition are listed under **Open Questions** below with a recommendation each (module homes for the resolver/preflight, hint-code names, legacy schema marker string, repository character class, ticket slicing, test file names).

### Deferred Ideas (OUT OF SCOPE)

*(CONTEXT.md "Out of scope", verbatim; ADR-030 "Out of scope" adds the same items plus the cross-runtime coordination protocol and mutation of real user state during acceptance.)*

A launcher CLI, persisted launch context, a Claude preparation hook, deleting or archiving legacy history, ADR-014 policy changes, UI-SPEC/UI-review design (INV-015), extending `make doctor`.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (verbatim from `.planning/REQUIREMENTS.md:205-211`) | Research Support |
|----|-------------|------------------|
| REQ-197 | A Shipyard host locates its bundle, Codex home and installer-written capabilities file from the executing bundle manifest, verifies the file against the manifest `capabilities_digest` and the ADR-014 grid at every launch, never synthesizes evidence, and refuses an explicit flag or environment value that disagrees with the bundle by naming both values; the validated Codex home, capabilities path and runtime reach every child process. | Resolution-site map (§Architecture, Table A); **manifest lives in `<home>/agents/.shipyard-manifest.json`, not in the bundle** (Discrepancy D-2); reusable `validateCodexCapabilities` export (`gsd-tune.cjs:120`, `:271-274`); child-env boundaries (`codex-runtime-host.cjs:2650-2666`, `deliver-dispatch.cjs:254`, `codex-decompose-host.cjs:986`). |
| REQ-198 | On first admission of a worktree with pre-existing provenance sidecars and no authenticated record, the host adopts them once, automatically, under the catalogue lock as `historical-unverified` in a separate versioned legacy field of the protected authority state; legacy files stay unchanged and never become authenticated pins or verified evidence, a changed legacy member or a later unknown file blocks with a named remedy, and the unauthenticated linked-worktree write path is covered. | `trustedBookkeepingMutation` (`role-artifact.cjs:3936-3999`), `historicalBookkeepingPins` (`:3905-3920`), `authenticateBookkeeping`/`inflightBookkeepingRequired` (`dispatch-record.cjs:1294-1308`), `writeProvenanceOnce` (`:1567-1585`), spike S-1 reproduction, pin readers in `codex-arch-review-context.cjs`. |
| REQ-199 | Every Codex and Claude host entry runs one shared preflight before `controller.begin` and before any bookkeeping, reports every incompatibility in one pass with a remedy that runs from the installed bundle, prints `hint[CODE]` lines from every entry point, accepts `--preflight` to show the result without launching and exit non-zero on any incompatibility, leaves `--capability-only` exit-0, and a refused launch creates no authority directory or sidecar. | Host-entry table (Table B) with exact pre-`begin` insertion points; `refusal-hints.cjs` (16 keys, static strings); hint test word rules (`refusal-hints.test.cjs:24,75-81`); refusal side effects (`role-artifact.cjs:3943`, `:4005`). |
| REQ-200 | One `repositoryIdentity()` in an existing module (the realpath of `git --git-common-dir`) and one character class and parse serve every decomposition, integrator and architecture-review subject family on both runtimes, a contract test round-trips each family with a whitespace path, a non-ASCII path and a rejected character, and sealed artifacts that used the old Codex `owner/repo` form still verify. | Subject-grammar table (Table C) with verbatim regexes; spike S2 disagreement matrix; `run-contract.cjs:430-441` equality checks that must change together with producers. |
| REQ-201 | Adoption and migration use only the existing catalogue lock: a second session, including one from the other runtime, waits a bounded time or receives a named refusal with a remedy, proven by a concurrent Codex and Claude launch fixture including during adoption. | `withArchiveAuthorityLock` (`role-artifact.cjs:4002-4026`): a live owner is refused **immediately**, no wait; `lock.cjs` TTL/ownerless constants; `ARCHIVE_AUTHORITY_BUSY` has no hint today. |
| REQ-202 | A hermetic CI acceptance core with an isolated HOME, state roots and graph directory proves launch without environment variables on both runtimes, upgrade with each legacy-history variant, concurrent Codex and Claude launches and unchanged real user state, plus a UI smoke through the existing GSD `gsd-ui-phase` then `gsd-ui-review` path or an explicit declared gap; live receipts on both runtimes are produced at release. | Template: `tests/smoke/model-ladder-runtime-smoke.sh` (fixture HOME, fake CLIs exiting 99); `tests/unit/run.sh` injects `CODEX_HOME` (pitfall); writer-lease root ignores `HOME` (`planning-writer-lease.cjs:85-88`); CI Node `24.15.0`. |
| REQ-203 | The ADR-030 verification obligations are each closed with evidence or a recorded known limitation: every reader of authority pins audited, `catalogue.lock` behaviour under pid reuse, the legacy schema marker and version, run-store and planning-writer-lease ordering during adoption, Claude launch with no `CLAUDE_*`/`SHIPYARD_*` variables and the reader of `CLAUDE_HOME`, the `.git/info/exclude` writer and fresh-clone behaviour, the reusable GSD preflight question, and the upgrade → downgrade → upgrade result. | Pre-answered facts in §Verification Obligations (L-11) below: pin-reader list, pid-reuse reading of `role-artifact.cjs:4007-4018`, `CLAUDE_HOME` reader search, `.git/info/exclude` search + ADR-020 policy. |
</phase_requirements>

## Summary

Phase 50 is a **library-first hardening of existing host scripts**, not a new component. Everything the planner needs already exists as in-repo seams: a leaf module for runtime resolution (`runtime-context.cjs`, only `fs`/`path` requires), a leaf hint map (`refusal-hints.cjs`), one authority module that owns the only trusted bookkeeping writer (`role-artifact.cjs:trustedBookkeepingMutation`), a reusable capability-grid validator (`gsd-tune.cjs:validateCodexCapabilities`, exported), and a hermetic installed-bundle smoke to copy (`tests/smoke/model-ladder-runtime-smoke.sh`). The work is wiring and tightening: one resolver, one preflight called before any side effect in eight entry points, one adoption branch inside the single bookkeeping writer, one `repositoryIdentity()`, and a new hermetic acceptance harness.

Three findings change how the ADR must be implemented and should be settled before tickets are cut: **(D-2)** the installed bundle contains *no* manifest — the installer writes it only to `$CODEX_HOME/agents/.shipyard-manifest.json`, so "the executing bundle's manifest" must be located as `<dirname(bundleRoot)>/agents/.shipyard-manifest.json`; **(D-1)** the runtime-digest pin covers exactly two files (`claude-dispatch-adapter.cjs`, `runtime-adapters.cjs`), so CONTEXT.md/ADR-030's claim that `role-artifact.cjs` and `dispatch-record.cjs` need `make refresh-runtime-digests` is wrong as stated; **(D-3)** the catalogue lock refuses a *live* owner immediately and never reaches its timed wait, so L-8's "waits a bounded time" is only true for dead/absent owners and a pid-reuse crash can hold the lock indefinitely.

**Primary recommendation:** Build in this order — (1) hint/remedy registry, resolver, read-only legacy classifier and `repositoryIdentity()` as four independent leaf tickets; (2) adoption inside `trustedBookkeepingMutation` + the `authenticateBookkeeping` linked-worktree fix; (3) the shared `preflight()` and its insertion before `controller.begin`/bookkeeping in every entry; (4) subject-grammar migration; (5) the acceptance harness and the L-11 evidence record — with every ticket written red-first (`--tdd`) and scoped to the modules below.

## Architectural Responsibility Map

This project has no browser/SSR/CDN tiers; the tiers below are the real layers of the conveyor (`CLAUDE.md:66-83`).

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bundle self-location, manifest read, capability digest + grid check, env-vs-bundle conflict (REQ-197) | Shared library: `runtime-context.cjs` (leaf, `fs`/`path` only) | Installer/generator (`scripts/gen-codex-shipyard.cjs`, `install-shipyard-codex.sh`) as the *writer* of what is verified | Resolver must be loadable by both runtimes' hosts from the packaged tree without cycles; installer already owns the evidence bytes and digest |
| Preflight (collect-all findings, `--preflight`) (REQ-199) | Shared library (same module, lazy-requires authority/probe code) | Every host entry CLI (call site) | One implementation, many callers; the entry must call it before `controller.begin` |
| Remedy text / `hint[CODE]` (REQ-199) | `refusal-hints.cjs` (leaf) | Hosts print via `formatHint` | Hint test pins "one shared map" (`refusal-hints.test.cjs:83-91`) |
| Legacy adoption + never-promote guarantee (REQ-198) | Authority module `role-artifact.cjs` (only trusted writer) | `dispatch-record.cjs` (route selection `authenticateBookkeeping`) | HMAC key, lock and catalogue writer live only here; hosts must not write the catalogue |
| Concurrency (REQ-201) | Existing catalogue lock (`role-artifact.cjs:4002`, `lock.cjs`) | — | ADR forbids new coordination |
| Subject grammar + `repositoryIdentity()` (REQ-200) | One existing module (recommended `architecture-target.cjs`, see Open Q-1) | Producers: `deliver-dispatch.cjs`, decompose hosts, `claude-role-host.cjs`, `role-artifact.cjs`; consumers: `run-contract.cjs`, `dispatch-record.cjs`, `planning-result-sealer.cjs` | `PHASE_SUBJECT` already lives there and is imported by 6 modules |
| Hermetic acceptance (REQ-202) | `tests/smoke/` shell+node harness in `make test-fast-rest` (CI) | `tests/unit/` contract tests; `tests/live/live-round.sh` at release | CI is `make test-fast` only (`docs-smoke.sh:95-98`) |
| Installed package / generated mirror | `plugins/shipyard/**` (generated, never hand-edited) | `make package-shipyard-codex` | `CLAUDE.md:76-81` |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js built-ins only (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:os`) | CI pinned `24.15.0` [VERIFIED: tests/smoke/docs-smoke.sh:98 `grep -q "node-version: '24.15.0'" .github/workflows/test.yml`]; this machine `v24.21.0` [VERIFIED: `node --version`] | All production code in `plugins/delivery-pipeline/scripts/*.cjs` | Repo has no `package.json` and no `node_modules` (`tests/unit/run.sh:4` "No network or node_modules") |
| `node:test` + `node:assert/strict` | bundled with Node | Unit tests, one file per module, run as `node tests/unit/<name>.test.cjs` | `tests/unit/run.sh:122` executes each `*.test.cjs` with `node` [VERIFIED] |
| Existing in-repo modules to reuse | see table below | The seams this phase wires together | ADR-030 L-1: "no new script file" |

### Supporting (in-repo seams, all `[VERIFIED]` by Read this session)
| Module | Reuse for | Evidence |
|--------|-----------|----------|
| `runtime-context.cjs` | Home of resolver + preflight (leaf: `const fs = require('fs'); const path = require('path');` at `:9-10`; lazy `require('./model-policy.cjs')` at `:234`) | Hosts do **not** import it today; only `pipeline-config.cjs:91` and `session-handoff.cjs:350` do [grep-located] |
| `refusal-hints.cjs` | Remedy registry; `formatHint(code)` → `` `hint[${label}]: ${entry.hint} — remedy: ${entry.remedy}` `` (`:83`) | leaf, no requires |
| `gsd-tune.cjs` `validateCodexCapabilities(capabilities, phase = 2)` | ADR-014 grid check at launch | exported at `:271-274` (`module.exports = { codexSkillNames, codexStaticVariants, validateCodexCapabilities, validateCodexBundle, payloadFiles, payloadDigests, CODEX_CAPABILITIES_BUNDLE_FILE }`); `main()` guarded by `if (require.main === module) main();` at `:1163` [grep-located] so `require` has no side effects. `validateCodexBundle` is **not** reusable: it validates the *staged* layout (`manifest.json`, `bundle/`, `agents/`, `skills/` under one root, `:148,188`) |
| `lock.cjs` `acquire`/`withLock` | Already used by authority (`role-artifact.cjs:12`) | TTL `DEFAULT_TTL_MS = 120_000` (`:48`), `OWNERLESS_GRACE_MS = 2_000` (`:59`) |
| `architecture-target.cjs` | Candidate home for `repositoryIdentity()` and the shared subject grammar | requires only `fs`, `path`, `crypto`, `child_process` (`:3-6`); already exports `PHASE_SUBJECT` (`:79`) imported by `run-contract.cjs:229,437`, `dispatch-record.cjs:1503`, `role-artifact.cjs` (many), `dispatch-boundary.cjs:1066`, `codex-arch-review-context.cjs:12` |
| `tests/smoke/model-ladder-runtime-smoke.sh` | Template for the installed-bundle harness | fixture `HOME`, fake `npx npm codex claude curl wget` that `exit 99` (`:39-42`), fake GSD converter/tools (`:43-50`), real `install-shipyard-codex.sh` run (`:85-87`), byte-identical evidence assertion (`:102`) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Resolver in `runtime-context.cjs` | `codex-runtime-host.cjs` (3,760 lines, Codex-only) | Claude hosts would import a Codex module; rejected (L-7 shares one route) |
| `repositoryIdentity()` in `architecture-target.cjs` | `run-contract.cjs` (requires `model-policy`, `runtime-adapters`; pure-contract style) or `planning-result-sealer.cjs` | Any of the three satisfies "existing module"; `architecture-target.cjs` has the widest existing import fan-in and no plugin-module requires, so no cycle risk |
| New launcher / persisted launch context / Claude hook | — | **Locked out** by ADR-030 L-1, L-7 |

**Installation:** none. No package is installed by this phase.

**Version verification:** not applicable — no external package. `package.json` is absent at repo root and at `plugins/delivery-pipeline/` [VERIFIED: `ls` → `No such file or directory` for both].

## Package Legitimacy Audit

> This phase installs **no external packages** (Node built-ins and in-repo modules only). The legitimacy gate (`gsd_run query package-legitimacy check`) was therefore not run; there is nothing to check.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| *(none)* | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
 operator/agent shell with NO exported variables
   │   node <bundle>/scripts/<host>.cjs [--preflight] --args-file|--request-file <json>
   ▼
 HOST ENTRY (8 today; see Table B)         ── parse argv (+ new --preflight)
   │
   ▼
 resolveHostEnvironment()  [runtime-context.cjs]
   │  bundle = realpath(__dirname/..)   (must contain scripts/ + codex-capabilities.json)
   │  home   = dirname(bundle)          manifest = <home>/agents/.shipyard-manifest.json   ← D-2
   │  verify: sha256(bundle/codex-capabilities.json) == manifest.capabilities_digest
   │          validateCodexCapabilities(parsed, manifest.phase)   (ADR-014 grid)
   │  flag/env vs bundle: agree → accept │ differ → ENV_CONFLICT refusal naming both values
   │  no bundle (source checkout) → explicit value required, validated as today
   ▼
 preflight()  — collects ALL findings, no early return
   │  env/bundle · capability evidence · runtime identity (AMBIGUOUS/UNKNOWN_RUNTIME) ·
   │  policy hash/agents manifest · legacy provenance classification (READ-ONLY, never creates authority dir) ·
   │  planning-writer legacy state · run-store schema · snapshot staleness vs `codex --version`
   │  ├─ --preflight → print findings + hint[CODE] lines, exit non-zero if any, STOP (no side effects)
   │  └─ any finding → refuse here (hint[CODE] printed); NOTHING created
   ▼ (ok)
 SIDE-EFFECT SECTION  (today's order; preflight sits in front of ALL of it)
   policy.resolveDispatch → [typed GSD: writer lease] → controller.begin → recordInflight
        └─ trustedBookkeepingMutation (under catalogue lock)
              ├─ no catalogue + provenance members + all regular/safe → ADOPT once → legacy_bookkeeping (historical-unverified)
              ├─ legacy member bytes changed → refuse LEGACY_HISTORY_CHANGED
              └─ unknown member (not authenticated, not legacy) → refuse with "update the host that wrote it"
   → capability probe (`codex --version`, `exec --help` markers) → native launch (child env from resolver) → receipts
```

### Recommended Project Structure (no new script files — ADR-030 L-1)

```
plugins/delivery-pipeline/scripts/
├── runtime-context.cjs        # + resolveHostEnvironment(), launchEnvironment(), preflight()  (leaf; lazy requires)
├── refusal-hints.cjs          # + hint entries; formatHint(code, vars?) for {bundle}/{host} tokens
├── role-artifact.cjs          # + legacy classification (read-only), adoption branch in trustedBookkeepingMutation
├── dispatch-record.cjs        # authenticateBookkeeping routes legacy-bearing worktrees; writeProvenanceOnce collision guard
├── architecture-target.cjs    # + repositoryIdentity(), REPOSITORY_CLASS, shared subject build/parse (recommended)
├── codex-*-host.cjs, claude-*-host.cjs, deliver-dispatch.cjs   # call preflight; stop re-deriving CODEX_HOME / repository
tests/unit/                     # new *.test.cjs files (auto-sharded; weight default 5, tests/unit/shard-files.cjs:10)
tests/smoke/                    # new installed-launch smoke + Makefile target added to TEST_FAST_REST
```

### Table A — where Codex home / capabilities / agents dir / runtime are resolved at `v0.72.2`

`41` matches for `CODEX_HOME|SHIPYARD_CODEX_CAPABILITIES_FILE|SHIPYARD_CODEX_AGENT_DIR|SHIPYARD_CODEX_LOG_DB|CLAUDE_HOME|CLAUDE_CONFIG_DIR|codex-capabilities\.json` across `12` plugin scripts [VERIFIED: Grep count this session]. `†` = re-read.

| File | Lines | Rule |
|------|-------|------|
| `codex-runtime-host.cjs` | `162-173`† | `capabilitiesFrom`: see verbatim quote below; reads `process.env`, not `options.env`; **no `~/.codex` default** |
| `codex-runtime-host.cjs` | 397, 443, 732, 886, 1501, 2380, 2890, 3209†, 3577 [grep-located] | `env.CODEX_HOME \|\| process.env.CODEX_HOME \|\| path.join(os.homedir(), '.codex')` (defaults to `~/.codex`, unlike line 170) |
| `codex-delivery-host.cjs` | `718-721`†, 928, 3065 | agents dir = `options.agentDir` or `(env.CODEX_HOME \|\| ~/.codex)/agents`; capability file = `options.capabilitiesFile \|\| env.SHIPYARD_CODEX_CAPABILITIES_FILE` (no bundle fallback) |
| `codex-decompose-host.cjs` | 540 | `options.env.CODEX_HOME` (unguarded property access) `\|\| ~/.codex` |
| `codex-agent.cjs` | 71, 93, 203 | agents dir default; capabilities **only** `options`/`--capabilities-file` — no env, no bundle |
| `dispatch-record.cjs` | `450-456` (452-453) | `SHIPYARD_CODEX_AGENT_DIR` → `CODEX_HOME/agents` → `~/.codex/agents` |
| `gsd-tune.cjs` | `283-285`†, 784 | capabilities flag/env only; Codex config `CODEX_HOME \|\| (process.env.HOME \|\| '')/.codex` |
| `role-artifact.cjs` | 2612, 3468 (new since `d8a70dec`), 3066 (`CLAUDE_CONFIG_DIR`) | `process.env.CODEX_HOME \|\| ~/.codex` |
| `session-observer.cjs` | 295-296 | `CODEX_HOME \|\| ~/.codex`; DB `SHIPYARD_CODEX_LOG_DB` |
| `codex-notify.cjs` | 26 | `process.env.CODEX_HOME \|\| path.resolve(__dirname, '..', '..')` — the only install-relative derivation |
| `runtime-context.cjs` | `100-116`† | `CODEX_HOME` + `config.toml` ⇒ weak `codex-config-home`; compatibility-only for routed dispatch (`:232`) |
| `claude-runtime-host.cjs` | 363, 371 | `CLAUDE_CONFIG_DIR` → `~/.claude` |
| `claude-decompose-host.cjs` | 362, 615, 701 | `CLAUDE_CONFIG_DIR` → `(process.env.HOME \|\| os.homedir())/.claude` |
| root scripts | `gen-codex-shipyard.cjs:216`, `install-shipyard-codex.sh:35,37`, `shipyard-doctor.cjs:318,376` | generator/installer home; doctor reads `…/shipyard/manifest.json` (`:318`) **and** `…/agents/.shipyard-manifest.json` (`:376`) |

Verbatim current evidence rule (the INV-015 `RUNTIME_UNAVAILABLE` cause) [VERIFIED: codex-runtime-host.cjs:168-171]:
```js
  const file = options.capabilitiesFile
    || process.env.SHIPYARD_CODEX_CAPABILITIES_FILE
    || (process.env.CODEX_HOME && path.join(process.env.CODEX_HOME, 'shipyard', 'codex-capabilities.json'));
  if (!file) fail('RUNTIME_CAPABILITY_MISSING', 'explicit Codex capability evidence is required');
```

### Table B — host entries and the exact pre-`begin` insertion point

All `†` rows were read this session. "Preflight goes" = last point at which nothing has yet been created.

| Entry (`require.main` line) | Modes / argv | Order today | Prints `hint[...]`? | Preflight goes |
|---|---|---|---|---|
| `codex-delivery-host.cjs` (`3634-3643`†) | `--args-file <json>` only (`parseCliArguments:3275-3281`† requires `argv.length === 2`); plus `--resume-finalization <id> --scope-file` and `--resume-repair-actions <id> --scope-file` (`:3424-3430`†) | `readRequestFile` → `canonicalCliScope` → `archReviewContext.prepare` (`:3439`) → `policy.resolveDispatch` (`:3461`) → typed-GSD writer lease (`:3468-3480`) → `controller.begin(run)` (`:3504`) → `recordInflight` (`:3523`) → `createCodexDeliveryHost` (probe, `:3526`); resume path has its own `controller.begin` (`:3362`) | yes (`:3639`) | immediately after `canonicalCliScope(parsed.scope)` (`:3432`), before `archReviewContext.prepare` |
| `codex-decompose-host.cjs` (`1408`) | `--args-file`, `--detach --args-file` (`:892-902`), `recover --dispatch <id> --args-file` (`:937-939`) | `controller.begin` at `:1204` and `:1339` | yes (`:1411`) | before both `begin` calls; `--detach` spawns a child at `:986-994` (child env `{ ...process.env, ...options.env }`) |
| `codex-planning-context-host.cjs` (`413-418`†) | `--args-file` | validates packet → `codexDecomposeHost.runCli(['--detach','--args-file',…])` (`:350`†) | **no** (`:415` message only) | at `runCli` entry (`:319`†), before the detach so the failure reaches the caller synchronously |
| `claude-delivery-host.cjs` (`1176-1181`†) | `--workflow <executors\|fix-round\|drift-gate\|investigation-research> --request-file <json>` (`parseCli:1039-1046`† requires `argv.length === 4`) | `validateRequest` → realpath/repo-root checks → `createRunController` (`:1133`) → `controller.begin(scope)` (`:1137`†) → `recordInflight` (`:1147`†; inflight **includes** `worktree` at `:1139`† — resolves the `d8a70dec` gap) | **no** | after the canonical-root check (`:1118-1120`†), before `createRunController` |
| `claude-investigation-host.cjs` (`140-145`†) | `--request-file <json>` → `runClaudeDeliveryCli(['--workflow','investigation-research',…])` (`:116-118`†) | inherits delivery host | yes (`:143`†) | covered by the delivery-host call; needs a contract test, not a second call |
| `claude-role-host.cjs` (`1602-1609`†) | `--capability-only` **or** `--args-file <json>` (`parseCli:1555-1570`†) | prepare (writes private files, `:1436-1449`†) → `controller.begin(scope)` (`:1454`†) → `recordInflight` (`:1463`†) | **no** | in `runClaudeRoleCli` after `parseCli`, before `createClaudeRoleHost(...).run` (`:1572-1582`†) |
| `claude-decompose-host.cjs` (`724-729`) | `--request-file <json>` | `controller.begin` at `:369` | yes (`:727`) | before `:369` |
| `deliver-dispatch.cjs` (`1297-1301`) | `build` / `launch` / `status` / `wait` | `launch` spawns the host **detached** with `{ ...process.env, ...(options.env \|\| {}), SHIPYARD_GRAPH_DIR: graphDir }` (`:254`) | **no** | `launch` must run preflight in-process **before** the detached spawn, or the refusal is invisible to the caller |
| `claude-workflow-host.cjs` (`507`) | `--workflow --args-file --host-module` | no `controller.begin` | no | not a launch entry by itself; list it in the enumeration test as an explicit exclusion with a reason |

Probe CLIs that must **keep exit 0** (L-6): `codex-runtime-host.cjs --capability-only` [VERIFIED: `parseCliArguments` `:3715-3736`; `process.exitCode = 0;` at `:3750`] and `claude-role-host.cjs --capability-only` (`:1558-1560`†, `:1574-1578`†). Existing caller: `tests/smoke/codex-runtime-smoke.sh:104`.

### Table C — subject grammars and repository identity at `v0.72.2`

| # | Grammar (verbatim) | Producer | Consumer / validator |
|---|---|---|---|
| S1 | `` `phase=${args.phase};input=${args.ticket};repository=${repository}` `` [VERIFIED: deliver-dispatch.cjs:1019] | `deliver-dispatch.cjs:1016-1019` (`repository = planningRepository(...)`, `:805-812`† remote `owner/repo` lowercased, else project path) | `run-contract.cjs:233` `/^phase=(\d+);input=((?:INV\|ADR)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*);repository=[^;\s]+$/`; equality `subjectRepository !== repository.repository_id` → `SCOPE_MISMATCH` at `:430-433`† |
| S2 | `` `phase=${Number(phase)};repository=${repository};adr=${adr.sha256}` `` [VERIFIED: planning-result-sealer.cjs:354]; `SUBJECT_PATTERN = /^phase=(\d+);repository=([^;]+);adr=([a-f0-9]{64})$/` (`:298`) | both decompose hosts via `decompositionAdr.decompositionSubject` (`codex-decompose-host.cjs:165`†) | `assertDecompositionSubject` (`:357-368`†): `if (match[2] !== repository)` — **equality against a caller-supplied value**, so it is form-agnostic |
| S3 | `` `phase=${phase};repository=${repositoryIdentity};tickets=${ticketSetDigest}` `` [grep-located: claude-role-host.cjs:610-611, `repositoryIdentity = canonical.commonPath`] and `role-artifact.cjs:4939` | `claude-role-host.cjs`, `role-artifact.cjs` | `run-contract.cjs:228` `…;repository=[^;\s]+;tickets=…`; `dispatch-record.cjs:1512` `/^phase=[A-Za-z0-9._-]+;repository=\/[^;\x00-\x1f]+;tickets=[a-f0-9]{64}$/`† (requires leading `/`); `role-artifact.cjs:2668,2687,3704,4096` further regexes |
| S4 | `PHASE_SUBJECT = /^phase=(\d+-[A-Za-z0-9._-]+);repository=([^;\s]+);tickets=([a-f0-9]{64});pr=([1-9]\d*);head=([a-f0-9]{40});base=([a-f0-9]{40})$/` [VERIFIED: architecture-target.cjs:8]; built at `:57` | `architecture-target.cjs:phaseBinding` | shared import in 6 modules (only fully shared grammar) |
| S5 | research `<INV-ID>:<line>` | host seal | `planning-result-sealer.cjs:54-57`, `LINE_PATTERN` — **out of scope** (no repository component) |

Repository identity is built four ways [grep-located unless †]: remote `owner/repo` (`deliver-dispatch.cjs:805-812`†); `realpath(--git-common-dir)` (`claude-decompose-host.cjs:131`, `claude-role-host.cjs:179-180`, `role-artifact.cjs:230,2045,2146,2333,2391,2645,3663,3761`, `codex-planning-context-host.cjs:249`†, `conveyor-coverage.cjs:30-34` as `'git-common:' + sha256`); `scope.repository` string/object (`codex-decompose-host.cjs:149-150`†); `realpath(worktree)` fallback (same lines). The Codex host also uses `'git-common:' + sha256(commonDir)` (`codex-delivery-host.cjs:1320,1404,2153`) and `run-contract.cjs:438` accepts either form for arch-review — that hashed form is **not** one of the ADR's subject families and must stay as it is.

Spike S2 result [CITED: spikes/SPIKES.md]: with a space in the path the seal pattern and `dispatch-record` S3 regex **accept** while the S1, S3 `run-contract` and S4 patterns **refuse**; Cyrillic passes everywhere; tab refuses everywhere except the sealer; `;` refuses everywhere; `owner/repo` is refused by the `dispatch-record` S3 regex (needs a leading `/`).

### Pattern 1: Self-locating resolver (REQ-197) — design skeleton

**What:** derive bundle root from the executing script, read the manifest from the agents dir, verify, then compare explicit values. **When:** at every host entry, before anything else.
**Facts it rests on** (all `[VERIFIED]`):
- The bundle directory `$CODEX_HOME/shipyard` receives only the staged `bundle/` payload: `replace_dir "$OUT/bundle" "$BUNDLE_ROOT" "bundle payload"` (`install-shipyard-codex.sh:785`, grep-located) with `BUNDLE_ROOT="$CODEX_HOME/shipyard"` (`:37`); payload = `scripts`, `references`, `templates`, `workflows`, `skills/delivery-rules`, `codex-capabilities.json` (`gen-codex-shipyard.cjs:340-355`).
- The manifest is staged at `writeFile(path.join(stageDir, 'manifest.json'), …)` (`gen-codex-shipyard.cjs:388`) — outside `bundle/` — and installed only as `fs.copyFileSync(nextPath, tmpManifestPath); fs.renameSync(tmpManifestPath, prevPath);` with `prevPath = path.join(dir, manifestName)`, `dir = $CODEX_HOME/agents`, `manifestName = ".shipyard-manifest.json"` (`install-shipyard-codex.sh:356,516,627-630`).
- Manifest fields to use: `capabilities_file: CODEX_CAPABILITIES_BUNDLE_FILE`, `capabilities_digest: digest(capabilitiesRaw)`, `codexHome`, `scriptsRoot`, `phase`, `policy_hash` (`gen-codex-shipyard.cjs:360-372`); `digest` is `createHash('sha256').update(content).digest('hex')` (`:113`); `CODEX_CAPABILITIES_BUNDLE_FILE = 'codex-capabilities.json'` (`gsd-tune.cjs:68`).
- `manifest.codexHome` is written exactly as passed (`expandHome(args['codex-home']) || process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex')`, `gen-codex-shipyard.cjs:216`, grep-located) — **not realpathed**; comparing to `realpath(dirname(bundle))` needs `fs.realpathSync` on both sides (macOS `/var`→`/private/var`, symlinked `~/.codex`).

```js
// DESIGN SKELETON — names are proposals [ASSUMED]; every value in the Facts list above is verified.
function resolveHostEnvironment({ scriptDir, env = process.env, flags = {}, runtime }) {
  const bundleRoot = fs.realpathSync(path.resolve(scriptDir, '..'));          // <home>/shipyard
  const looksInstalled = fs.existsSync(path.join(bundleRoot, 'codex-capabilities.json'));
  if (!looksInstalled) return requireExplicitOrRefuse({ env, flags });        // source checkout: today's rules
  const home = path.dirname(bundleRoot);
  const manifest = readJson(path.join(home, 'agents', '.shipyard-manifest.json'));   // D-2
  const bytes = fs.readFileSync(path.join(bundleRoot, manifest.capabilities_file));
  if (sha256(bytes) !== manifest.capabilities_digest) refuse('CAPABILITY_EVIDENCE_STALE', …);
  require('./gsd-tune.cjs').validateCodexCapabilities(JSON.parse(bytes), manifest.phase);   // ADR-014 grid
  for (const [name, explicit] of explicitHomes(env, flags))                    // CODEX_HOME, flag, …
    if (explicit && fs.realpathSync(explicit) !== home) refuse('ENV_CONFLICT', /* name BOTH values */);
  return Object.freeze({ bundleRoot, codexHome: home, capabilitiesFile: …, runtime, manifest });
}
```
**Pitfall guard:** an explicit `SHIPYARD_CODEX_CAPABILITIES_FILE` that points at a *different* file than the bundle copy is a conflict too (compare by path, then by digest); "agrees" means same path or same bytes.

### Pattern 2: Preflight that collects everything and creates nothing (REQ-199)

**What:** a function returning `{ ok, findings: [{ code, detail, remedy_vars }] }` that never throws on the first problem and never calls `authorityState(…, true)`. **Rule:** the legacy-history check must be read-only. `archiveAuthorityDirectory(worktree)` with `create = false` only *returns a path* (`role-artifact.cjs:1019-1021`, namespace short-circuits at `:1006` `if (!create) return directory;`) but `authorityState(worktree, false, …)` calls `fs.realpathSync(directory)` at `:1052` and **throws raw `ENOENT`** if the directory is absent — so the classifier must `fs.existsSync(directory)` first (and the catalogue file) and treat "absent" as "no catalogue".
**Checks (all independent):** env/bundle (Pattern 1); capability evidence; runtime identity via `resolveDispatchContext` (`runtime-context.cjs:195-253` throws `UNKNOWN_RUNTIME`/`AMBIGUOUS_RUNTIME`); policy hash vs `model-policy.cjs` (`manifest.policy_hash`); legacy provenance classification; `assertNoLegacyPlanningWriter` (`codex-delivery-host.cjs:3470`†, `LEGACY_WRITER_STATE`); run-store schema (`run-store.cjs` `INVALID_STORE`); snapshot staleness vs `codex --version` (report only, per L-3). Claude: runtime identity, `probeClaudeRuntime`, provenance classification, writer legacy state.
**Remedy text rule:** `refusal-hints.test.cjs:24` fails any hint/remedy matching ``/\b(bypass|skip|directly|other runtime|switch runtime)\b|SHIPYARD_STOP_GATE/i`` — and the existing `STALE_GENERATED_AGENT` remedy `Reinstall the generated agents: run make install-shipyard-codex, then re-run.` (`refusal-hints.cjs:57-60`) and `CODEX_CONFIG_FIX` `node plugins/delivery-pipeline/scripts/gsd-tune.cjs …` (`:67`) are checkout-relative; new remedies must run from the bundle (tokens such as `{host}`/`{bundle}` substituted by `formatHint(code, vars)`; `CODEX_CONFIG_FIX` already carries a `{key}` token, so token substitution has precedent) and must not name `make` or `plugins/delivery-pipeline/…`.

### Pattern 3: Legacy adoption inside the single trusted writer (REQ-198)

**Today's refusal** [VERIFIED: role-artifact.cjs:3953-3955]:
```js
    const authenticatedPaths = previous.map(pin => pin.path);
    if (inventory().some(relative => !authenticatedPaths.includes(relative)))
      fail('ARCHIVE_AUTHORITY_INVALID', 'unknown host provenance member before trusted mutation');
```
with `previous = historicalBookkeepingPins(worktree)` (`:3944`) which returns `[]` when `catalogue.json` is absent (`:3907`), and the catalogue is written whole from `state.payload` (`writeArchiveCatalogue`, `:3922-3935`), MAC over `stable(state.payload)`, bounded by `HISTORICAL_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024` (`:963`, `:3926`).
**Adoption design (all steps inside `withArchiveAuthorityLock`):**
1. Classify `inventory()` members: each must match `^\.planning\/graph\/provenance\/[A-Za-z0-9_.-]+\.json$` (the `allowed` regex at `:3938-3939`), be a regular non-symlink file (use the `lstat` + `O_NOFOLLOW` + stable-stat read pattern of `readPinnedArchiveFile`, `:965-989`), and fit the byte bound; anything else → named refusal, **not adopted**.
2. If no `bookkeeping_state` and no prior legacy record → write `payload.legacy_bookkeeping = { schema, version, status: 'historical-unverified', … members: [{ path, bytes, sha256 }] }` `[ASSUMED: field name from DECISIONS/OPEN-QUESTIONS; schema string and member fields are proposals]` **without** touching `bookkeeping_state`.
3. Allow `authenticated ∪ legacy` in the pre-check (`:3954`) **and** in the post-callback check (`:3983`); new/altered members still refuse. Re-verify each legacy member's bytes at every mutation (L-5: changed → refuse).
4. `historicalBookkeepingPins` (`:3905-3920`) **must keep returning only authenticated pins** — it feeds attestation digests (`codex-arch-review-context.cjs:1350`, `:1782`, `:2152`, `:2234`). Add a separate accessor for legacy.
5. **No new state on refusal:** both `trustedBookkeepingMutation` (`:3943` `authorityState(worktree, true)`) and `withArchiveAuthorityLock` (`:4005` `authorityState(worktree, true)`) create the per-worktree directory and `hmac.key` *before* the unknown-member check at `:3954` — the check (or the read-only classifier) must run before creation when no catalogue exists. Adoption itself legitimately creates it.
6. **Route fix (S-1 linked-worktree defect):** `authenticateBookkeeping` returns `fn()` unauthenticated when [VERIFIED: dispatch-record.cjs:1297-1298] ``if (!required && !fs.existsSync(path.join(worktree, '.shipyard-role-artifacts')) && authority.historicalBookkeepingPins(worktree).length === 0) return fn();``. A worktree that has legacy members but no pins therefore takes the unauthenticated branch whenever `required` is false (linked worktree with a non-empty provenance dir, `inflightBookkeepingRequired` `:1302-1308`), writing an **unpinned** sidecar that blocks the next project-root host [CITED: spikes/SPIKES.md S-1]. The condition must also route to the trusted path when the provenance directory has members that are not authenticated (i.e. when adoption is pending or legacy is recorded).
7. **Collision guard:** `writeProvenanceOnce` returns early on `if (fs.existsSync(file)) return false;` (`dispatch-record.cjs:1570`) — a legacy file whose name equals a new `dispatch_id` would silently satisfy it. Refuse that case with a named error before the `existsSync` short-circuit.

### Pattern 4: Hermetic installed-bundle acceptance (REQ-202)

Copy the structure of `model-ladder-runtime-smoke.sh` [VERIFIED: `:9-130`] and **change the environment rule**: that smoke sets `HOME`, `CODEX_HOME` and `SHIPYARD_CODEX_CAPABILITIES_FILE` for the *installer* (`:72-81`). The new harness must install with them, then launch hosts with them **absent** (`env -i` style: only `PATH` and `HOME`). Recommended assertions: (a) a fake `codex` records its argv and `CODEX_HOME` to a file and satisfies `--version` and `exec --help` containing every marker in `REQUIRED_HELP_MARKERS = Object.freeze(['--json', '--model', '--config', '--cd', '--ignore-user-config'])` (`codex-runtime-host.cjs:15`); a launch "succeeds" for this phase when the host passes preflight, records inflight, passes the probe and reaches `codex exec` with the bundle's home in the child env — sealing a model result is not required; (b) a fake `claude` for the Claude probe `[ASSUMED: marker set not read this session — read `claude-runtime-host.cjs` probe before writing it]`; (c) snapshot the file listing of the real `~/.local/state/shipyard` (names/mtimes only) before and after.

### Anti-Patterns to Avoid
- **A launcher, persisted launch context or `SessionStart`-based preparation** — locked out (L-1, L-7).
- **Pinning legacy files into `bookkeeping_state`** — would make them authenticated attestation input (`codex-arch-review-context.cjs:1350,2152`).
- **Fixing one refusal at a time** — the first refusal masks the next (INV-015 sequence); the preflight must report all.
- **Writing `.git/info/exclude` or `.gitignore`** — ADR-020 D-08: "No `.gitignore` or `info/exclude` writes." [VERIFIED: ADR-020 line 35 via grep, `.planning/architecture/ADR-020-target-project-delivery-at-scale.md:35`].
- **Editing `plugins/shipyard/host/**` by hand** (`CLAUDE.md:81`).
- **Changing `--capability-only` to exit non-zero** — pinned by `codex-runtime-smoke.sh:104` and unknown external callers.

## Recommended decomposition seams (proposal for the planner — `fine`, `--tdd`)

Ticket ids are proposals `[ASSUMED]`. Every ticket's first commit is its failing test. "Files" are the *modified* production files (CONTEXT: verification scoped to `files_modified`). Shared-file contention is real: `role-artifact.cjs`, `dispatch-record.cjs`, `codex-runtime-host.cjs` and `codex-delivery-host.cjs` appear in several seams — serialize those or keep them in separate waves.

| Wave | Seam | REQ | Files (production) | First failing tests | Depends on |
|---|---|---|---|---|---|
| 1 | **S1 Hint/remedy registry** — map every launch/upgrade code (`ARCHIVE_AUTHORITY_INVALID/REQUIRED/BUSY`, `RUNTIME_CAPABILITY_MISSING`, `LEGACY_WRITER_STATE`, `AMBIGUOUS_RUNTIME`, `UNKNOWN_RUNTIME`, `STALE_POLICY`, `INVALID_STORE`, `ADR_*`, `DECOMPOSITION_SUBJECT_INVALID`, new conflict/legacy codes); fix `RUNTIME_UNAVAILABLE` remedy; `formatHint(code, vars)` | 199 | `refusal-hints.cjs` | extend `refusal-hints.test.cjs` (all codes mapped, bypass-word rule, bundle-runnable remedies contain no `make`/`plugins/` paths) | — |
| 1 | **S2 Resolver** — Pattern 1 (self-location, manifest in agents dir, digest, grid, conflict) | 197 | `runtime-context.cjs` | new `launch-environment.test.cjs` over synthetic bundles in a temp HOME: global, dogfood, custom home, missing/stale/mismatched evidence, symlinked home, env agrees/conflicts | — |
| 1 | **S3 Read-only legacy classifier + schema marker** | 198, 203 | `role-artifact.cjs` (new exported pure function) | new `legacy-bookkeeping-adoption.test.cjs`: absent dir/catalogue, regular/symlink/oversize/bad-name members; asserts no directory is created | — |
| 1 | **S4 `repositoryIdentity()` + shared grammar + contract test** (no producer/consumer migration yet) | 200 | `architecture-target.cjs` | new `subject-contract.test.cjs`: round-trip S1–S4 with space, Cyrillic, tab, `;`, old `owner/repo` | — |
| 1 | **S5 L-11 evidence tickets that need no design** — pid-reuse test, run-store/lease ordering reading, `CLAUDE_HOME` reader, exclude-writer note, pin-reader audit list | 203 | tests + one `docs/audits/` note | tests that pin current behaviour (e.g. a live-but-unrelated pid in `owner.json` ⇒ `ARCHIVE_AUTHORITY_BUSY`) | — |
| 2 | **S6 Child-env builder + conflict wiring** | 197 | `runtime-context.cjs` | `launch-environment.test.cjs` additions | S2 |
| 2 | **S7 Adoption in `trustedBookkeepingMutation`** (Pattern 3 steps 1-5) | 198, 201 | `role-artifact.cjs` | `legacy-bookkeeping-adoption.test.cjs`: adopt once, idempotent, bytes unchanged, pins exclude legacy, changed member blocks, unknown member blocks, refused launch creates no directory | S3 |
| 2 | **S8 Subject migration — producers** (`deliver-dispatch.cjs`, both decompose hosts, `claude-role-host.cjs`, `codex-planning-context-host.cjs`, `role-artifact.cjs:4939`) | 200 | those files | `subject-contract.test.cjs` + existing host tests | S4 |
| 3 | **S9 Route + collision guard** (Pattern 3 steps 6-7) | 198 | `dispatch-record.cjs` | `dispatch-record.test.cjs`: linked-worktree sidecar with legacy history is pinned or adopted; legacy name collision refuses | S7 |
| 3 | **S10 Replace Codex resolution sites** — three tickets by file to avoid conflicts: `codex-runtime-host.cjs`; `codex-delivery-host.cjs` + `codex-decompose-host.cjs`; the small modules (`codex-agent.cjs`, `dispatch-record.cjs:450-456`, `session-observer.cjs`, `gsd-tune.cjs`, `role-artifact.cjs:2612,3468`) | 197 | as listed | per-file tests replace the `CODEX_HOME`-required lookup with resolver calls; unset-env case now resolves from bundle | S2, S6 |
| 3 | **S11 Preflight library** (Pattern 2) | 199 | `runtime-context.cjs` | new `host-preflight.test.cjs`: two simultaneous defects reported in one pass; read-only | S1, S2, S3 |
| 3 | **S12 Subject migration — consumers** (`run-contract.cjs:228-235,430-441`, `dispatch-record.cjs:1506-1512`, `role-artifact.cjs:2668,2687,3704,4096`) with old-form acceptance | 200 | those files | `subject-contract.test.cjs` + `run-contract.test.cjs` | S4, S8 |
| 4 | **S13 Wire preflight + `--preflight` + hints into Codex entries** | 199 | `codex-delivery-host.cjs`, `codex-decompose-host.cjs`, `codex-planning-context-host.cjs` | host tests: refusal before `controller.begin`; `--preflight` exit codes | S1, S11, S10 |
| 4 | **S14 Wire into Claude entries + `deliver-dispatch.cjs launch`** | 199 | `claude-delivery-host.cjs`, `claude-role-host.cjs`, `claude-decompose-host.cjs`, `claude-investigation-host.cjs`, `deliver-dispatch.cjs` | same, per host | S1, S11 |
| 4 | **S15 Entry-enumeration contract test** (extend `HOST_FILES` pattern, `refusal-hints.test.cjs:16-21,83-91`) + `--capability-only` exit-0 pin | 199 | tests only | new `host-entry-contract.test.cjs` | S13, S14 |
| 5 | **S16 Acceptance harness** — split: Codex no-env launch; Claude no-env launch; upgrade variants (partial history, linked worktree, changed legacy member, new unknown member, symlinked member); concurrent Codex+Claude incl. during adoption; real-state-unchanged; UI smoke or declared gap | 202, 201 | `tests/smoke/…`, `Makefile` (add to `TEST_FAST_REST`, `Makefile:65`) | harness itself | S9, S13, S14 |
| 5 | **S17 Docs + release readiness** — README `105-109` vs `163` reconciliation, `--preflight` documented, `docs-smoke` green, L-11 results record, package regeneration on the epic | 197-203 | `README.md`, `docs/audits/…` | `make test-docs` | all |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Trusted catalogue write / HMAC / key | a second writer or a legacy-only file | `writeArchiveCatalogue` + `authorityState` + `withArchiveAuthorityLock` (`role-artifact.cjs`) | One keyed writer; no unauthenticated path may be added (T-02) |
| Tamper-evident file read | `fs.readFileSync` + hash | `readPinnedArchiveFile` pattern (`O_NOFOLLOW`, dev/ino/size/mtime/ctime before-during-after, `:965-989`) | TOCTOU and symlink races are already solved there |
| Cross-process lock | `mkdir` loops | `lock.cjs` `acquire` (token-owned release, exactly-once takeover) | audit F12 history in `lock.cjs:32-42` |
| ADR-014 grid check at launch | re-deriving rungs | `validateCodexCapabilities` (`gsd-tune.cjs:120-137`) | install-time and launch-time must agree |
| Hint formatting | per-host strings | `formatHint` in `refusal-hints.cjs` | `refusal-hints.test.cjs:83-91` forbids local hint text |
| Runtime identity | `CODEX_HOME`/path sniffing | `resolveDispatchContext` (`runtime-context.cjs:195-253`) | `CODEX_HOME` is compatibility-only by design |
| Subject digests | new hashing | `decompositionAdr.resolveAdr`/`assertAdrUnchanged` (`planning-result-sealer.cjs:317-346`) | ADR digest contract already shared by both decompose hosts since #486 |
| Hermetic install fixture | ad-hoc installer stubs | `model-ladder-runtime-smoke.sh` structure | already proves real installer + fake CLIs |

**Key insight:** every difficult property here (tamper-evidence, locking, runtime identity, grid validation) already has one implementation. The defect class is *divergence* (41 resolution matches, 4 repository identities, 5 grammars); the fix is to route callers through the existing implementations, not to add new ones.

## Runtime State Inventory

This phase is an upgrade/state-migration phase (not a rename). All five categories answered explicitly.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `.planning/graph/provenance/<dispatch_id>.json` sidecars (untracked; per-clone); `.planning/graph/dispatches.json` (**tracked**, byte-pinned after the first trusted mutation — a checkout/rebase that rewrites it trips the pin on the next mutation [CITED: constraints.md T-13; not reproduced]); authority catalogue + `hmac.key` under `~/.local/state/shipyard/role-artifact-authority/<sha256(realpath worktree)>/` (`role-artifact.cjs:996-1021`); run stores `~/.local/state/shipyard/codex/<hash>/runs` and Claude `…/controller`; planning-writer lease `~/.local/state/shipyard/planning-writers/shared` | **Data migration (adoption):** record the legacy inventory in the authority catalogue's new legacy field; never rewrite sidecar bytes. **Code edit:** new records keep today's format. Run-store/lease: inventory only (L-11) |
| Live service config | None — verified: Shipyard has no external service registry in this repo; Codex agent registrations live in `$CODEX_HOME/config.toml` and are written by the installer (`install-shipyard-codex.sh:490-498`), not renamed or changed by this phase | None |
| OS-registered state | None — no launchd/systemd/Task Scheduler entries are created by the scripts reviewed; the Codex `SessionStart` hook is a *package* hook (`plugins/shipyard/hooks/hooks.json`) whose trust is a user decision (`README.md:90-96`) and is untouched (no preparation hook is added) | None |
| Secrets/env vars | `CODEX_HOME`, `SHIPYARD_CODEX_CAPABILITIES_FILE`, `SHIPYARD_CODEX_AGENT_DIR`, `SHIPYARD_CODEX_LOG_DB`, `CLAUDE_CONFIG_DIR`, `SHIPYARD_GRAPH_DIR`, `GSD_*`. **Names unchanged; precedence/conflict behaviour changes for `CODEX_HOME` and the capabilities path only**; other variables keep their owners (L-2). `CLAUDE_HOME` has no reader in `plugins/delivery-pipeline/scripts/*.cjs` (only a comment, `runtime-context.cjs:82`) [VERIFIED by Grep scoped to that directory] | Code edit only; document precedence in README |
| Build artifacts / installed packages | Installed bundle `$CODEX_HOME/shipyard` is replaced wholesale on every install (`replace_dir`, "REPLACED, not merged" [CITED: constraints.md T-20]); generated mirror `plugins/shipyard/host/**` + `package-build.json`; an N-1 host already installed on a machine will not carry the new resolver/preflight until reinstall | Regenerate `plugins/shipyard` once on the epic before epic → `main` (`CLAUDE.md:79-81`); acceptance must cover host N against state written by N-1 |

**The canonical question — after the repo is updated, what runtime state still has the old shape?** Pre-existing sidecars with no catalogue (handled by adoption); a catalogue that carries the older `latest_bookkeeping`/`records[].bookkeeping` shape (already read by `historicalBookkeepingPins`, `:3909-3919`); orphan unpinned sidecars from linked-worktree writes (S-1); old Codex-form sealed subjects (`repository=owner/repo`) in recorded runs (parser must keep accepting them); `LEGACY_WRITER_STATE` private writer roots (`planning-writer-lease.cjs:90-109`).

## Common Pitfalls

### Pitfall 1: Unit tests already have `CODEX_HOME` set, so "no env" cannot be tested in-process
**What goes wrong:** a test that expects launch to work "without env" passes trivially. **Why:** `tests/unit/run.sh:116-122` runs each file with `HOME="$unit_worker/home" CODEX_HOME="$unit_worker/codex" CLAUDE_CONFIG_DIR="$unit_worker/claude" …` [VERIFIED]. **Avoid:** spawn the host as a child with an explicit minimal env (`PATH`, `HOME` only), or `delete process.env.CODEX_HOME` inside the test and assert it. **Warning sign:** a no-env test that passes before the resolver exists.

### Pitfall 2: The bundle has no manifest (D-2)
**What goes wrong:** code that looks for `<bundle>/manifest.json` finds nothing (the same mistake `shipyard-doctor.cjs:318` makes: `path.join(codexBundle, 'manifest.json')`, so the doctor's Codex section reports "skip" on a real install [CITED: system-state.md §5; no writer of that path found by Grep of `scripts/*.cjs`: only readers at doctor `:318` and writers at `gen:388`(stage) and `install-shipyard-codex.sh:627-630`(agents dir)]). **Avoid:** read `<home>/agents/.shipyard-manifest.json`. **Do not** extend `make doctor` (out of scope).

### Pitfall 3: `realpath` and alias mismatches (macOS vs CI Linux)
`manifest.codexHome` is stored unresolved; `/var` vs `/private/var` and a symlinked `~/.codex` make string equality wrong. Compare `fs.realpathSync` of both. CI is Linux-only (`test.yml`), the failures were observed on macOS [CITED: constraints.md D-01] — write tests that create a symlinked home explicitly.

### Pitfall 4: A refused launch still creates the authority directory
`trustedBookkeepingMutation` (`:3943`) and `withArchiveAuthorityLock` (`:4005`) both call `authorityState(worktree, true)`, which `mkdirSync`s the directory and writes `hmac.key` (`:1051`, `:1059`), before the unknown-member check (`:3954`). Spike S-1 confirmed one new directory per refused attempt [CITED: SPIKES.md S-1 row 3]. L-6 requires none.

### Pitfall 5: The catalogue lock does not wait on a live owner (D-3)
[VERIFIED: role-artifact.cjs:4013-4018] `if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) { let live = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; } if (live) fail('ARCHIVE_AUTHORITY_BUSY', 'archive catalogue lock has a live owner'); }`. The timed wait (`acquire(..., { waitMs: 1000, … })`, `:4020`) is reached only when the lock is absent, the owner file is unreadable, or the pid is dead. Consequences: (a) a concurrent second session is refused instantly (named refusal needed — `ARCHIVE_AUTHORITY_BUSY` has no hint, `refusal-hints.cjs:9-72`); (b) a crashed owner whose pid is reused by an unrelated live process blocks the worktree until that process exits — `lock.cjs`'s 120 s TTL takeover (`:48`, `:364-369`) is never consulted. The existing stale-lock test uses a dead pid `2147483647` (`role-artifact.test.cjs:994`); **no test covers a live-but-unrelated pid**.

### Pitfall 6: `writeProvenanceOnce` treats any existing file as "already written"
(`dispatch-record.cjs:1570`) — see Pattern 3 step 7. Also, `recordInflight` performs **two** trusted mutations (dispatches.json at `:1546-1554`, sidecar at `:1555`); adoption occurs in the first.

### Pitfall 7: Legacy members must not reach attestation consumers
`historicalBookkeepingPins` is consumed as authenticated evidence at `codex-arch-review-context.cjs:1069-1071`, `:1201`, `:1350`, `:1563-1564`, `:1782`, `:2152`, `:2234` [grep-located]; `dispatch-record.cjs:1298` uses `.length === 0` as the "no authority yet" test. Existing tests that pin this shape: `codex-arch-review-context.test.cjs:1214,1218`, `claude-delivery-host.test.cjs:232`, `dispatch-record.test.cjs:2191,2227`, `role-artifact.test.cjs:1051`.

### Pitfall 8: Subject changes must move producer, parser and run-scope together
`run-contract.cjs:430-433`† compares the subject's repository to `repository.repository_id`; `deliver-dispatch.cjs:1041` puts the same `repository` into the run scope. Changing only the builder to the git-common path (which can contain a space) makes `run-contract.cjs:233` (`[^;\s]+`) refuse. Migrate in the S8→S12 order and keep the parsers accepting old `owner/repo` strings.

### Pitfall 9: Preflight must come before `archReviewContext.prepare` and the writer lease, not just `controller.begin`
In `codex-delivery-host.cjs` the arch-review prepare (`:3439`) and the typed-GSD lease acquire (`:3473-3477`) both precede `controller.begin` (`:3504`) and both create state. In `claude-role-host.cjs` private input files are written (`:1438`) before `controller.begin` (`:1454`).

### Pitfall 10: Hermetic harness leaks into real state through the writer-lease root
`sharedPlanningWriterRoot` = `realpathClosest(testWriterStateRoot || path.join(os.userInfo().homedir, '.local','state','shipyard','planning-writers','shared'))` [VERIFIED: planning-writer-lease.cjs:85-88] — `os.userInfo().homedir` ignores `HOME`, and `testWriterStateRoot` is not reachable from a CLI. `legacyPlanningWriterRoots` also scans the real home (`:92`). **Typed-GSD roles (`request.gsd_role`) acquire this lease (`codex-delivery-host.cjs:3468-3480`)** — a CLI-level harness must use non-typed roles, or run the lease-bearing scenario in-process with `testWriterStateRoot`. Changing the root derivation is a host-owned-lease change and is **not** authorized.

### Pitfall 11: Native child and `CODEX_HOME`
The native launcher builds `const env = { ...process.env, ...environment };` and deletes only a named list (`CODEX_MODEL…`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_*`, `GNUPGHOME`, `GPG_*`, `SSH_*`; `codex-runtime-host.cjs:2650-2666`†). `CODEX_HOME` passes through. The host reads native session files from `env.CODEX_HOME || process.env.CODEX_HOME || ~/.codex` (`:397`), so the child and the host **must** see the same home or session evidence is not found. Whether a dogfood home (`~/.local/state/shipyard/dogfood/codex/<digest>`) carries a Codex login for the child is unknown `[ASSUMED]` — see Open Q-3.

### Pitfall 12: Docs and test-contract traps
`docs-smoke.sh:15-19` fails the build if `README.md` contains the whole words `docker container kubernetes k8s dockerfile compose image entrypoint` (write "entry point", two words); `:90-93` requires every `make <target>` named in the README to exist; `:61-66` pins exactly two marketplace launcher lines. `refusal-hints.test.cjs` requires `HOST_FILES` to `require('./refusal-hints.cjs')` — extend deliberately. The unit shard assigner picks up new `*.test.cjs` files automatically (`shard-files.cjs:21-23`).

### Pitfall 13: Stale line numbers in the packet
The research lines cite `d8a70dec` numbers (e.g. refusal at `role-artifact.cjs:1827`, `capabilities` at `codex-runtime-host.cjs:160-171`). At `v0.72.2` they are `:3955` and `:162-173`. Re-read before editing.

## Code Examples

### Verbatim: the route that skips authentication [VERIFIED: dispatch-record.cjs:1294-1308]
```js
function authenticateBookkeeping(cwd, fn, writtenPaths, required = false) {
  const worktree = path.resolve(graphDir(cwd), '../..');
  const authority = require('./role-artifact.cjs');
  if (!required && !fs.existsSync(path.join(worktree, '.shipyard-role-artifacts'))
      && authority.historicalBookkeepingPins(worktree).length === 0) return fn();
  return authority.trustedBookkeepingMutation(worktree, fn, writtenPaths);
}

function inflightBookkeepingRequired(input, cwd) {
  if (typeof input.worktree !== 'string') return false;
  const project = fs.realpathSync(path.resolve(graphDir(cwd), '../..'));
  if (fs.realpathSync(input.worktree) === project) return true;
  const provenance = path.join(project, '.planning', 'graph', 'provenance');
  return !fs.existsSync(provenance) || fs.readdirSync(provenance).length === 0;
}
```

### Verbatim: today's host entry hint wiring to extend [VERIFIED: codex-delivery-host.cjs:3634-3643]
```js
if (require.main === module) {
  runCli().then((result) => {
    if (result?.status === 'blocked' || result?.status === 'verification_failed') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write('codex-delivery-host: ' + (error && error.message ? error.message : error) + '\n');
    process.stderr.write(formatHint(error && error.code) + '\n');
    …
    process.exitCode = 1;
  });
}
```

### Skeleton: adoption branch (proposal — identifiers other than `inventory`, `authenticatedPaths`, `state.payload`, `fail`, `withArchiveAuthorityLock` are `[ASSUMED]`)
```js
// inside trustedBookkeepingMutation, replacing the single unknown-member check at role-artifact.cjs:3954-3955
const legacy = legacyMembers(state.payload);                       // from payload.legacy_bookkeeping, never from bookkeeping_state
const unknown = inventory().filter(rel => !authenticatedPaths.includes(rel) && !legacy.has(rel));
if (unknown.length && !state.payload.bookkeeping_state && !state.payload.legacy_bookkeeping) {
  adoptLegacy(state, worktree, unknown);                            // classify safe → write legacy_bookkeeping under the held lock
} else if (unknown.length) {
  fail('ARCHIVE_AUTHORITY_INVALID', 'unknown host provenance member after adoption …');   // named code/remedy via S1
}
for (const rel of legacy) assertLegacyUnchanged(worktree, state.payload.legacy_bookkeeping, rel);   // L-5
```

### Skeleton: preflight output contract (proposal)
```
$ node <bundle>/scripts/codex-delivery-host.cjs --preflight --args-file req.json
preflight: 2 incompatibilities
hint[ENV_CONFLICT]: CODEX_HOME=/a disagrees with the installed bundle home=/b — remedy: unset CODEX_HOME, or reinstall into /a
hint[CAPABILITY_EVIDENCE_STALE]: …
exit 1
```
Names `ENV_CONFLICT` and `CAPABILITY_EVIDENCE_STALE` are proposals `[ASSUMED]`; today's emitted codes are `RUNTIME_CAPABILITY_MISSING` (`codex-runtime-host.cjs:149,154,157,171`) and `ARCHIVE_AUTHORITY_INVALID`.

## State of the Art

| Old Approach (`d8a70dec` and packet) | Current Approach (`v0.72.2`) | When Changed | Impact |
|---|---|---|---|
| Claude delivery CLI omitted `worktree` from the in-flight record | `inflight = graphDir ? { graphDir, worktree, dispatch_id: …, pid: process.pid } : null` [VERIFIED: claude-delivery-host.cjs:1139] | #482, `v0.72.0` | Claude delivery now takes the same route and has the same legacy-history exposure |
| `localInflightBookkeeping` (project-root only) | `inflightBookkeepingRequired` adds "provenance dir missing or empty" (`dispatch-record.cjs:1302-1308`) | #482 | First-run linked worktrees authenticate; **populated** legacy dirs still refuse |
| Decomposition seal subject `phase=;repository=` (no `adr=`) | `phase=…;repository=…;adr=<sha256>` shared by both decompose hosts (`planning-result-sealer.cjs:298,348-368`) | #486, `v0.72.1` | Part of the original ADR-digest mismatch is already fixed; S1/S3/S4 and repository identity remain divergent |
| Refusal at `role-artifact.cjs:1827` | `:3955` | #456, `v0.72.0` | Update every cited line |

**Deprecated/outdated:** packet statements "`claude-delivery-host.cjs` passes no `worktree`", "ADR-digest `adr=` has no producer", "preflight is checkout-only `make doctor`" are accurate for `d8a70dec` only.

## Verification Obligations (L-11) — what research already established

Each is a *starting fact* for REQ-203 tickets, not a closure.

| Obligation | Pre-established fact | Still to do |
|---|---|---|
| Pin-reader audit | Consumers of `historicalBookkeepingPins`/`bookkeeping_state`: `codex-arch-review-context.cjs:1005,1069-1071,1201,1350,1563-1564,1764,1782,2152,2225,2234`; `role-artifact.cjs:3905-3920,3944,3957,3985`; `dispatch-record.cjs:1298`; `readProvenance` (`dispatch-record.cjs:1587`, exported `:1925`) has test callers only [CITED: packet E27] [grep-located] | Ticket reads each, adds a negative test per consumer |
| `catalogue.lock` + pid reuse | Pitfall 5: live pid ⇒ immediate refusal, TTL never consulted | Test with a live unrelated pid; decide documented limitation vs fix (fix would change lock semantics — keep out unless it shows a hazard beyond a named refusal) |
| Schema marker/version | Label `shipyard.role-archive-catalogue.v1` is checked at `role-artifact.cjs:1074` as `payload.schema !== 'shipyard.role-archive-catalogue.v1' \|\| payload.worktree !== worktree \|\| !object(payload.records)`; extra payload fields are re-serialised whole (`:3923`) and MAC-covered by `stable(payload)` | Choose `legacy_bookkeeping.schema`/`version`; do **not** bump the catalogue label |
| Run-store / lease ordering during adoption | Adoption happens inside `recordInflight` (dispatch-record) after `controller.begin` (`run-store`) and after the typed-GSD lease (`codex-delivery-host.cjs:3473-3504`); `run-store.cjs` rejects an unknown schema with `INVALID_STORE` [CITED: system-state.md §6.6] | Test: adoption never touches run store/lease state; failure leaves both released (`finishDeliveryRun`, `:3401-3420`†) |
| Claude no-env + `CLAUDE_HOME` | `CLAUDE_HOME` has **no** reader in `plugins/delivery-pipeline/scripts/*.cjs`; Claude hosts read `CLAUDE_CONFIG_DIR` (`claude-runtime-host.cjs:363,371`; `claude-decompose-host.cjs:362,701`; `role-artifact.cjs:3066`) [grep-located]; the Claude sandbox denies the model the authority directory (`claude-runtime-host.cjs:751` per packet) | Measure a Claude launch with no `CLAUDE_*`/`SHIPYARD_*`; record |
| `.git/info/exclude` writer | Grep of `plugins/`, `scripts/`, `capabilities/` (`*.cjs *.sh *.mjs *.md`) for `info/exclude` → **no match**; `tests/live/live-round.sh:158-159` copies a prepared exclude file into its fixture (`mv .git-info-exclude .git/info/exclude`); ADR-020 forbids Shipyard writing it (`ADR-020…:35`) | Record: in a fresh clone the provenance directory is not excluded unless the operator/GSD adds it; adoption must not rely on it |
| GSD reusable preflight | Not checked: `~/.codex/gsd-core` is outside this session's read scope | Spike in an isolated candidate install |
| Upgrade → downgrade → upgrade | Not run. At `HEAD`, a downgraded host's `authorityState` checks only schema/worktree/records (`:1074`), so an additive field is tolerated by the same code; **released** older tags `v0.72.0`/`v0.72.1` were not executed `[ASSUMED]` | Record as known limitation unless the fixture shows a hazard |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Proposed names (`resolveHostEnvironment`, `launchEnvironment`, `preflight`, `legacy_bookkeeping` schema string, hint codes `ENV_CONFLICT`/`CAPABILITY_EVIDENCE_STALE`/`LEGACY_HISTORY_*`, new test file names, Makefile target) | Patterns, Seams | Cosmetic; collisions with existing names should be checked at ticket time |
| A2 | Per-member catalogue entry ≈150–200 B, 64 members ≈ 10–13 KB, far below the 4 MiB bound [CITED: constraints.md T-03, itself an estimate] | Pattern 3 | A project with thousands of legacy sidecars could exceed `HISTORICAL_ARCHIVE_MAX_BYTES` → adoption must refuse with a named error, not truncate |
| A3 | A dogfood Codex home may not hold the user's Codex login; exporting the bundle-derived home to the native child could change auth lookup | Pitfall 11, Open Q-3 | Native launch fails for dogfood installs after the resolver "fixes" the home; needs a spike before S6/S10 |
| A4 | The Claude probe markers/`claude auth status --json` surface (`claude-runtime-host.cjs:178-219` per packet) were not re-read; hermetic fake `claude` must match them | Pattern 4 | Harness fake is wrong; read the probe first |
| A5 | `os.homedir()` follows `HOME` on POSIX (authority tests override it; unit files ran green under a temp `HOME`, packet E19) | Validation | Authority tests write to the developer's real state if not overridden |
| A6 | Released `v0.72.0`/`v0.72.1`/`v0.72.2` hosts ignore the additive catalogue field (static reading of `HEAD`; older tags not executed) | L-11 | Downgrade hazard larger than assumed (S-2/S-4 spikes not run) |
| A7 | The GSD `gsd-ui-phase` → `gsd-ui-review` path cannot be driven non-interactively in a hermetic CI harness | Open Q-7 | If it can, the declared-gap ticket is unnecessary |
| A8 | The operator's installed bundle is `0.72.2` with a digest-matching capabilities file [CITED: INV-017 RESEARCH.md:9, an operator-side check; `~/.codex` unreadable here] | Summary | INV-015 `RUNTIME_UNAVAILABLE` could be missing evidence rather than a resolution miss |
| A9 | CI Linux/Node 24 behaviour equals macOS behaviour for realpath/aliasing except where tests create symlinks explicitly | Pitfall 3 | A macOS-only failure ships; mitigate with explicit symlink fixtures |

## Open Questions

1. **Where do the resolver, preflight and `repositoryIdentity()` live? (Q-1)**
   - Known: ADR forbids a new script file; `runtime-context.cjs` is a leaf with no plugin-module requires and is not imported by hosts today; `architecture-target.cjs` is the widest-imported subject module.
   - Recommendation: resolver + preflight in `runtime-context.cjs` (lazy-require `role-artifact`, `gsd-tune`, probes inside functions, as `dispatch-record.cjs:1296` already does); `repositoryIdentity()` and the shared grammar in `architecture-target.cjs`. Hint text only in `refusal-hints.cjs`.
2. **How is "the executing bundle's manifest" located? (Q-2 / D-2)**
   - Known: no manifest exists inside the bundle; it is at `<home>/agents/.shipyard-manifest.json`; the marketplace bootstrap reads the same path (`bootstrap-shipyard-plugin.cjs:83`).
   - Recommendation: lock the rule "bundle root = `realpath(__dirname/..)` containing `codex-capabilities.json`; home = its parent; manifest = `<home>/agents/.shipyard-manifest.json`; require `manifest.scriptsRoot`/`codexHome` to realpath-match". Do not add a second manifest copy to the bundle (would change `bundle_files`/`bundle_digests` and the generated package).
3. **Does passing the bundle-derived `CODEX_HOME` to the native `codex exec` child break dogfood auth? (Q-3)**
   - Known: host and child must agree on the sessions home (Pitfall 11); dogfood homes are separate (`README.md:152-161`).
   - Recommendation: a one-hour spike in the harness fake before S6 decides whether the child gets `CODEX_HOME` only when the operator exported it, or always.
4. **Do `--resume-finalization`, `--resume-repair-actions`, decompose `--detach`/`recover` modes get `--preflight`? (Q-4)**
   - Known: each reaches `controller.begin` (`codex-delivery-host.cjs:3362`) or spawns a child.
   - Recommendation: run the *environment* part of preflight on all of them (cheap, side-effect free); run the legacy-history part only where `recordInflight` is reached. The enumeration test (S15) lists each mode.
5. **Which single repository character class? (Q-5)**
   - Known: `[^;]+` (seal), `[^;\s]+` (S1, S3 `run-contract`, S4), `\/[^;\x00-\x1f]+` (S3 `dispatch-record`); the decided identity can contain spaces and non-ASCII.
   - Recommendation: `[^;\x00-\x1f]+` (what `dispatch-record.cjs:1512` already uses), builder rejects `;` and control characters; keep S4's `PHASE_SUBJECT` anchors; accept old `owner/repo` strings in parsers.
6. **Digest-refresh scope (Q-6 / D-1).**
   - Known: `tests/unit/runtime-file-digests.json` pins only `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` [VERIFIED: `:3-6`]; `check-runtime-digest-trailer.cjs:7` names that pin file.
   - Recommendation: require `make refresh-runtime-digests` + trailer only in tickets that touch those two files; correct the CONTEXT.md/ADR-030 statement when the plan is written.
7. **UI smoke (Q-7).** Recommendation: plan the explicit declared-gap path (L-10 allows it): the harness prints a `GAP:` record naming `gsd-ui-phase`/`gsd-ui-review` and the reason, and a unit test pins that record; attempt a real scenario only if a non-interactive GSD driver is found.
8. **`deliver-dispatch.cjs launch` (Q-8).** It spawns hosts detached, so a refusal inside the host is invisible to the caller. Recommendation: run preflight in-process before the spawn and print `hint[CODE]`; add `deliver-dispatch.cjs` to the enumeration test.
9. **`claude-workflow-host.cjs` (Q-9).** Not named by ADR-030 L-7, has a CLI (`:507`) but no `controller.begin`. Recommendation: exclude with a recorded reason in the enumeration test.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | all scripts and tests | ✓ | v24.21.0 local; CI `24.15.0` | — |
| git | identity, worktrees, fixtures | ✓ | 2.54.0 (Apple Git-157) | — |
| bash | smoke scripts, `tests/unit/run.sh` | ✓ | 3.2.57 (macOS system bash — keep scripts 3.2-compatible) | — |
| `codex` CLI | live receipts only; **hermetic tests must not call it** | ✓ `/opt/homebrew/bin/codex` | codex-cli 0.162.1 | fake `codex` in the harness (pattern: `model-ladder-runtime-smoke.sh:39-42`) |
| `claude` CLI | live receipts only | ✗ not on `PATH` | — | fake `claude` for the harness |
| `gh` | `make test-live`, release | present but unusable in this sandbox (`failed to read configuration … operation not permitted`) | — | not needed for CI core |
| Network | `make test-codex-shipyard` only | not required for the new core | — | none; keep new tests hermetic |

**Missing dependencies with no fallback:** none for the CI core.
**Missing dependencies with fallback:** `claude` (fake CLI).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` + `node:assert/strict`; shell smokes under `tests/smoke/` |
| Config file | none; shard weights `tests/unit/shard-weights.json` (default weight 5, `shard-files.cjs:10`) |
| Quick run command | `env -u CODEX_HOME -u SHIPYARD_CODEX_CAPABILITIES_FILE HOME="$(mktemp -d)" node tests/unit/<file>.test.cjs` (files that touch authority also override `os.homedir` in-test — `role-artifact.test.cjs:7-13`) |
| Full suite command | `make test-fast` (CI: `UNIT_SHARD=<i>/4 ./tests/unit/run.sh` + `make test-fast-rest`, `CLAUDE.md:39`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-197 | bundle self-location, digest, grid, conflict; child env | unit | `node tests/unit/launch-environment.test.cjs` | ❌ Wave 0 |
| REQ-197 | installed bundle launches with no env (Codex) | smoke | `./tests/smoke/installed-launch-smoke.sh codex` | ❌ Wave 0 |
| REQ-198 | adopt once; never pinned; changed/unknown block; no dir on refusal | unit | `node tests/unit/legacy-bookkeeping-adoption.test.cjs` | ❌ Wave 0 |
| REQ-198 | linked-worktree sidecar covered; collision refused | unit | `node tests/unit/dispatch-record.test.cjs` | ✅ extend |
| REQ-199 | one-pass findings, read-only; hints from every entry | unit | `node tests/unit/host-preflight.test.cjs`, `node tests/unit/refusal-hints.test.cjs` | ❌ / ✅ extend |
| REQ-199 | every entry calls preflight; `--capability-only` exits 0 | unit | `node tests/unit/host-entry-contract.test.cjs` | ❌ Wave 0 |
| REQ-200 | round-trip each subject family (space, non-ASCII, `;`, old `owner/repo`) | unit | `node tests/unit/subject-contract.test.cjs`, `node tests/unit/run-contract.test.cjs`, `node tests/unit/decomposition-adr.test.cjs` | ❌ / ✅ extend |
| REQ-201 | concurrent Codex + Claude incl. during adoption; live-owner refusal named | smoke + unit | `./tests/smoke/installed-launch-smoke.sh concurrent`, `node tests/unit/role-artifact.test.cjs` | ❌ / ✅ extend |
| REQ-202 | core scenarios + real state unchanged + UI gap record | smoke | `make test-installed-launch` (target name `[ASSUMED]`; add to `TEST_FAST_REST`, `Makefile:65`) | ❌ Wave 0 |
| REQ-203 | each L-11 item has evidence or a recorded limitation | unit + doc | `node tests/unit/role-artifact.test.cjs`; `docs/audits/<date>-launch-upgrade-verification.md` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the ticket's own test file(s) (scoped to `files_modified`).
- **Per wave merge:** `make test-unit` (+ `make test-docs` when `README.md` changes).
- **Phase gate:** `make test-fast` green, regenerated package on the epic, then live receipts on both runtimes at release (`make test-live`; `scripts/release.sh` requires them).

### Wave 0 Gaps
- [ ] `tests/unit/launch-environment.test.cjs` — REQ-197 (synthetic bundle builder; consider a shared helper because several tests need an installed-layout fixture — no helper module exists today: `tests/unit` has only `*.test.cjs`, `run.sh`, `shard-*`, `runtime-file-digests.json`)
- [ ] `tests/unit/legacy-bookkeeping-adoption.test.cjs` — REQ-198/201
- [ ] `tests/unit/host-preflight.test.cjs`, `tests/unit/host-entry-contract.test.cjs` — REQ-199
- [ ] `tests/unit/subject-contract.test.cjs` — REQ-200
- [ ] `tests/smoke/installed-launch-smoke.sh` + Makefile target — REQ-202 (fake `codex`/`claude`, isolated HOME/XDG/`SHIPYARD_GRAPH_DIR`)
- [ ] no framework install needed.

## Security Domain

`security_enforcement` is `true` and `security_asvs_level` is `1` in `.planning/config.json` (read this session), `security_block_on: "high"`.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (no user auth added) | — |
| V3 Session Management | no | — |
| V4 Access Control | yes | authority namespace/dir private (`mode & 0o077` refused, `role-artifact.cjs:1014`, `:1053`); native child denied the authority directory (`claude-runtime-host.cjs:751`, `codex-delivery-host.cjs:1404` per packet) |
| V5 Input Validation | yes | anchored regexes + length bounds; subject/identity grammar; `fixedPath` for authority paths; reject symlink/oversize/odd-name members |
| V6 Cryptography | yes | reuse HMAC-SHA256 catalogue (`writeArchiveCatalogue`, `:3922-3925`) and sha256 digests — never hand-roll |
| V12 Files and Resources | yes | `O_NOFOLLOW` + stable-stat reads (`readPinnedArchiveFile`, `:965-989`) for every adopted member |
| V7 Error Handling | yes | refusals name both conflicting values (paths) — acceptable; do not echo file contents of legacy members |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Legacy file promoted to trusted evidence (shortcut: "pin whatever is on disk") | Elevation of privilege | separate `legacy_bookkeeping` field, never merged into `bookkeeping_state`/`historicalBookkeepingPins`; negative tests per consumer |
| Forged/new sidecar planted after adoption | Tampering | inventory check `authenticated ∪ legacy`; unknown member refuses (existing test `role-artifact.test.cjs:1066-1067`) |
| Symlink / hardlink / odd-name member in provenance dir | Tampering | `lstat` + `O_NOFOLLOW`, name regex `[A-Za-z0-9_.-]+\.json`, byte bound; refuse, do not adopt |
| TOCTOU between classification and adoption | Tampering | classify and adopt inside one `withArchiveAuthorityLock`; re-read with before/during/after stat identity |
| Poisoned `CODEX_HOME` / capabilities path redirecting evidence | Spoofing | bundle self-location wins; disagreeing explicit value refuses; digest + grid verified. **Limit:** a principal able to rewrite both the bundle copy and the agents manifest can also rewrite the scripts — the digest detects staleness/corruption, not that attacker `[ASSUMED]` |
| Pid reuse holding `catalogue.lock` | Denial of service | named `ARCHIVE_AUTHORITY_BUSY` hint; document as limitation or fix under a separate decision |
| Capability evidence synthesized from policy | Spoofing | forbidden (`install-shipyard-codex.sh` refuses bare installs; smoke `codex-shipyard-smoke.sh:145-155`) |
| Credential leakage into child env | Information disclosure | keep the scrub list at `codex-runtime-host.cjs:2656-2666`; the resolver adds only `CODEX_HOME`, capabilities path, runtime |

## Project Constraints (from CLAUDE.md)

Extracted from `./CLAUDE.md` (read this session); no `.claude/skills` or `.agents/skills` directory exists.
- Canonical implementation is `plugins/delivery-pipeline/`; Codex output is generated by `scripts/gen-codex-shipyard.cjs` — edit the Claude/shared script first, then `make package-shipyard-codex`; never edit `plugins/shipyard/host/` directly. Ticket PRs into `epic/*` (or stacked on `ticket/*`) do not regenerate the package; regenerate once on the epic before epic → `main`.
- Keep shell scripts on `set -euo pipefail` and validate preconditions early; keep generated state in existing `.planning` locations; preserve unrelated worktree changes (the repo is edited during active delivery sessions).
- When adding a rule, add a focused unit or fixture test with it; run `make test-fast` after each edit; `tests/smoke/docs-smoke.sh` is the supported-workflow contract; update `README.md` when the supported command or install flow changes.
- Change the runtime-file digest pin only with `make refresh-runtime-digests` and the printed trailer.
- ADR-014 v7 routed dispatch policy (`adr-014.v7`, Sonnet `claude-sonnet-5-5`, Opus `claude-opus-5-5`, Codex Sol `gpt-6.1-sol`, Luna `gpt-6-luna`): every routed launch must resolve → validate → launch → receipt; no compatibility palette, no provider fallback, no inline/session-inherited selection; **launching/preflight must not alter model or effort selection**.
- `pipeline-config.cjs` is a compatibility reader and cannot authorize routed dispatches; Codex capability file is required when the installer validates measured model availability.
- Authority-touching tests override `os.homedir`; `make doctor` stays read-only and checkout-only.

## Discrepancies found (resolve before tickets are cut)

- **D-1 Digest-refresh scope.** CONTEXT.md ("`role-artifact.cjs` and `dispatch-record.cjs` changes need the runtime-digest refresh") and ADR-030 Consequences say so; `tests/unit/runtime-file-digests.json:3-6` pins only `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`. Fix the statement, or confirm the intent with the operator.
- **D-2 Manifest location.** ADR-030 L-2 says the host derives its settings "from the executing bundle's manifest"; no manifest is inside the bundle (see Pattern 1).
- **D-3 "Waits a bounded time" (L-8, REQ-201).** A live lock owner is refused immediately (`role-artifact.cjs:4016`); the wait applies only to dead/absent owners.
- **D-4 Stale citations.** Packet line numbers are `d8a70dec`; use this file's numbers.
- **D-5 Entry list.** ADR-030 L-7 lists four Claude hosts; `claude-investigation-host.cjs` delegates to the delivery host, `deliver-dispatch.cjs launch` and `codex-planning-context-host.cjs` are launch-adjacent entries that print no hints, and `claude-workflow-host.cjs` has a CLI with no `begin`.

## Sources

### Primary (HIGH confidence) — read this session
- `.planning/phases/50-make-launch-and-upgrade-reliable/CONTEXT.md`; `.planning/REQUIREMENTS.md:204-211,417-424`; `.planning/ROADMAP.md` (Phase 50 section); `.planning/config.json`; `CLAUDE.md`; `README.md:84-175`
- `.planning/architecture/ADR-030-launch-and-upgrade-reliability.md`; INV-017 `PROBLEM.md`, `RESEARCH-CONTRACT.md`, `DECISIONS.md`, `RESEARCH.md`, `OPTIONS.md`, `RISKS.md`, `OPEN-QUESTIONS.md`, `research/{system-state,constraints,alternatives,risks}.md`, `spikes/SPIKES.md` (all packet digests verified)
- Source at `v0.72.2`: `role-artifact.cjs:955-1094,3895-4034`; `dispatch-record.cjs:1285-1330,1494-1612`; `codex-runtime-host.cjs:96-232,2556-2706,3160-3229,3705-3752`; `codex-delivery-host.cjs:706-736,3270-3643`; `claude-delivery-host.cjs:1030-1182`; `claude-role-host.cjs:1436-1465,1555-1610`; `claude-investigation-host.cjs:96-147`; `claude-workflow-host.cjs:1-60`; `codex-planning-context-host.cjs:236-419`; `codex-decompose-host.cjs:130-180`; `deliver-dispatch.cjs:800-830,1000-1060`; `planning-result-sealer.cjs:225-415,648-662`; `run-contract.cjs:215-255,420-455`; `architecture-target.cjs:1-80`; `runtime-context.cjs:70-260`; `refusal-hints.cjs`; `lock.cjs`; `planning-writer-lease.cjs:80-110`; `gsd-tune.cjs:120-300`
- `scripts/gen-codex-shipyard.cjs:330-400`; `scripts/install-shipyard-codex.sh:440-640`; `tests/unit/run.sh`; `tests/unit/shard-files.cjs`; `tests/unit/refusal-hints.test.cjs`; `tests/unit/role-artifact.test.cjs:985-1130`; `tests/unit/runtime-file-digests.json`; `tests/smoke/docs-smoke.sh`; `tests/smoke/model-ladder-runtime-smoke.sh:1-170`; `tests/smoke/codex-runtime-smoke.sh:1-130`; `Makefile:56-145`

### Secondary (MEDIUM) — `Grep`-located, re-read before editing
- Line numbers marked `[grep-located]` (resolution sites in Table A, `claude-role-host.cjs:610-611`, `role-artifact.cjs` subject regexes, `codex-arch-review-context.cjs` pin consumers).

### Tertiary (LOW)
- Every `[ASSUMED]` row in the Assumptions Log. No external web, Context7 or package-registry source was needed or used (all domain knowledge is in-repo); the `research-plan`/`classify-confidence` seams were not exercised for that reason.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no external dependencies; Node/CI versions read from `docs-smoke.sh`/`node --version`.
- Architecture (seams, insertion points, adoption design): HIGH for facts, MEDIUM for the proposed shapes (names, schema string, module homes).
- Pitfalls: HIGH where quoted from source/tests; MEDIUM where `[grep-located]`; LOW for A3/A4/A6/A7.

**Research date:** 2026-10-15
**Valid until:** until `main` advances past `v0.72.2` in the files above (re-run the Table A/B greps); the packet is bound to `be7ab4f3`. Re-validate if #456-style large refactors land (line numbers moved ~2,100 lines between `d8a70dec` and `v0.72.2`).
