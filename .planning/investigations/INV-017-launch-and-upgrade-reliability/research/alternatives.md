# INV-017 — research line `alternatives` (alternatives and prior art)

Status: completed research artifact. This file offers options; it does **not** choose one, does **not** close Gate 1 and is **not** an ADR. The choice belongs to the user.

## 0. Run identity and scope

| Field | Value |
|---|---|
| Investigation | `INV-017-launch-and-upgrade-reliability` |
| Line | `alternatives` (canonical line id `alternatives`) |
| Artifact contract | `planning.v1` |
| Authenticated source revision | `d8a70decb32e5420fb69f8eebc17be08e82d6d86` (local `main`) — see §2.1 for why this is not the only relevant revision |
| Repository root | `/Volumes/KINGSTON/claude-shipyard` |
| Policy hash (ADR-014 `adr-014.v7`) | `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570` |
| Policy signals (exact, preserved) | `{}` |
| Caller-resolved selection | `claude-sonnet-5-5` / `xhigh` (research rung `base`) |
| Date | 2026-10-15 |

Write scope: only this file (and creating its parent `research/` directory). No product code, config, planning scaffolding, commits or PRs. No command read or modified `.planning/graph/provenance`, any role-artifact authority directory, `~/.local/state/shipyard/`, or `~/.codex/`. The installed build is therefore **not** inspected directly (see §2.1 and Q1).

Inputs read: `PROBLEM.md` (sha256 verified, E01), `RESEARCH-CONTRACT.md`, `DECISIONS.md`, `OPEN-QUESTIONS.md`, `EVIDENCE.md`, `.planning/investigations/INV-015-ui-lifecycle-integration/LAUNCH-REFUSAL.md` (launch-failure evidence only), `docs/audits/2026-10-03-phase47-launch-fix.md`, `docs/audits/2026-10-03-phase47-runtime-failure-state-fix.md` (E02). `.planning/codebase/` does not exist (E03), so source files were inspected directly.

Not analysed in this line (owned by the `system-state` / `risks` / `constraints` lines): `run-store.cjs`, `planning-writer-lease.cjs`, `session-observer.cjs` beyond its home-resolution line, `phase-integrator-preflight.cjs` internals beyond its purpose, full Claude host behaviour. Where an option depends on them, the dependency is listed as an unknown (§8).

## 1. Verification conventions (rule zero)

- Every checkable claim carries an evidence id `[Enn]` resolved in §10 with the exact command (or tool call and its shell equivalent), the path/output and the exit status where it was captured.
- `Read`, `Grep` and `Glob` were used through the agent's dedicated file tools; §10 gives the equivalent `rg`/`sed` command for each. Their exit status is not separately captured; the output is what is cited.
- Line numbers are for the working tree at `d8a70dec` unless prefixed `origin/main:` (a read-only `git show`/`git grep` against `origin/main`, never a checkout).
- Statements about behaviour that were derived by reading code but **not executed** are labelled "static reading". Claims that could not be checked are labelled **assumption** or **unknown** with the next check.
- Cost figures are estimates calibrated on precedent commits (E35); they are assumptions, not measurements.

## 2. Findings that shape the alternatives

### 2.1 Deployment state first: which revision is the baseline?

The problem statement is "X does not work after upgrade", so deployment state was checked before design work.

| Fact | Evidence |
|---|---|
| Local `main` = `d8a70dec…` (the authenticated source revision). `origin/main` = `be7ab4f3407b017a50e9fe2a49bf54e22e7d3202`, **9 commits ahead** of local `main`. | E04 |
| Tag `v0.72.2` is an ancestor of (and resolves to the same commit as) `origin/main`; tags containing `d8a70dec`: `phase-47`, `v0.72.0`, `v0.72.1`, `v0.72.2`. | E04, E05 |
| The legacy-provenance refusal (`unknown host provenance member before trusted mutation`) exists at `d8a70dec` (`role-artifact.cjs:1827`) and at `v0.72.0`, `v0.72.1`, `v0.72.2` and `origin/main` (`role-artifact.cjs:3955`). The refusal is therefore **present, not absent**, in every revision checked. | E06 |
| `LAUNCH-REFUSAL.md` cites the installed copy at `dispatch-record.cjs:1294` and `role-artifact.cjs:3954`. Those positions match the v0.72.x tree (3955, off by one; cause unknown), not `d8a70dec` (1827). The installed build is most likely a v0.72.x release. **Not verified**: `~/.codex/shipyard` was not read. | E06, E07 |
| PR #482 (`9415c1e7`, in `v0.72.0`+) already changed the admission predicate: `localInflightBookkeeping` became `inflightBookkeepingRequired`, which also returns true when the provenance directory is missing or empty ("first-run provenance"). A **populated** pre-existing provenance directory on the local worktree still hits the same refusal. | E08 |
| PR #486 (`78cdca26`, in `v0.72.1`+) already centralises the decomposition ADR-digest binding in `planning-result-sealer.cjs`. At `d8a70dec` and `v0.72.0` the `adr=` subject has **no producer in code**: it appears only in `commands/decompose.md:302,400` and in test fixtures (`tests/unit/planning-artifacts.test.cjs:434,520,528`). | E09, E10, E11 |
| `fix/bind-decomposition-to-adr` (tip `1ea923a4`) carries the same subject and the same 21-file change list as the merged #486 (`78cdca26`), so it appears to be #486's pre-squash branch (not confirmed by tree comparison); it is not an ancestor of local `main`. | E04, E09 |

Consequence for the options: any design chosen from this document must first be rebased on a chosen baseline (Q1). Options below cite `origin/main` where the revisions differ. File-touch estimates assume the baseline is `origin/main` / `v0.72.2`.

### 2.2 Environment, home, capabilities and runtime resolution: seven capability-file rules, eleven Codex-home expressions in eight scripts

The same inputs (Codex home, capabilities file, runtime) are resolved by independent code. For the **capabilities file** there are seven rules, which produce different outcomes when `SHIPYARD_CODEX_CAPABILITIES_FILE` and `CODEX_HOME` are both unset on a default global install whose bundle exists at `~/.codex/shipyard/codex-capabilities.json`:

| # | Site | Precedence | Outcome with both variables unset |
|---|---|---|---|
| 1 | `codex-runtime-host.cjs:160-171` (`capabilitiesFrom`) | `options.capabilities` → `options.capabilitiesFile` → `process.env.SHIPYARD_CODEX_CAPABILITIES_FILE` → `$CODEX_HOME/shipyard/codex-capabilities.json` (only if `process.env.CODEX_HOME` is set). It reads `process.env`, not an `options.env` object. | Refuses `RUNTIME_CAPABILITY_MISSING` "explicit Codex capability evidence is required" (line 169), later surfaced as `RUNTIME_UNAVAILABLE` (line 182 → 1549). **There is no `~/.codex` default here**, although the same file defaults home to `~/.codex` at lines 395, 441, 729, 882. |
| 2 | `codex-delivery-host.cjs:705-711` (`installedAgentOptions`) | `options.capabilitiesFile` → `env.SHIPYARD_CODEX_CAPABILITIES_FILE` only | Supplies `capabilitiesFile: undefined` next to the already-loaded `capabilities` object to the architecture-review installed-launch admission; the effect of `undefined` inside that admission was not traced. |
| 3 | `codex-agent.cjs:84-96` | `options.capabilities` → `options.host.capabilities` → `options.capabilitiesFile`/`--capabilities-file` | Refuses (`UNSUPPORTED_SELECTION`). Does not read the environment at all. |
| 4 | `gsd-tune.cjs:283-285` | `--capabilities`/`--capabilities-file` → env var | Refuses. |
| 5 | `scripts/gen-codex-shipyard.cjs:248-260` | `--capabilities` → env var → **probes `codex debug models`** | Succeeds by probing the CLI. |
| 6 | `scripts/install-shipyard-codex.sh:125-138` | env var only | Refuses before staging (pinned by `tests/smoke/codex-shipyard-smoke.sh:145-155`). |
| 7 | `scripts/bootstrap-shipyard-plugin.cjs:104-111` | env var → else probes the CLI and writes `$CODEX_HOME/shipyard-plugin/capabilities.json` | Succeeds by probing; hands the path to the installer child only (line 114). |

Evidence: E12, E13, E14, E15. The same codex-runtime-host rule is unchanged on `origin/main` (lines 169-170, E16).

Codex **home** expressions (eleven, four variants). Variant 1, `CODEX_HOME || ~/.codex`: `codex-agent.cjs:71`, `codex-decompose-host.cjs:518`, `codex-delivery-host.cjs:707`, `codex-runtime-host.cjs:395,441,729,882`, `session-observer.cjs:295` (the log database path additionally honours `SHIPYARD_CODEX_LOG_DB`, line 296). Variant 2, with an agent-directory override first: `dispatch-record.cjs:450-456` (`SHIPYARD_CODEX_AGENT_DIR`). Variant 3, self-location fallback: `codex-notify.cjs:26` (`CODEX_HOME || __dirname/../..`). Variant 4: `gsd-tune.cjs:784` (`CODEX_HOME || (process.env.HOME || '') + '/.codex'`; an unset `HOME` yields a relative `.codex`). Installer side: `scripts/install-shipyard-marketplace.cjs:103-104` **deletes** `CODEX_HOME` for a default-home install, so the hosts' `~/.codex` fallback is load-bearing, but rule 1 does not honour it for capabilities (E12, E17).

**Other environment inputs** a "validated environment for every child" would have to define (grep hits; only `graph-dir.cjs:15,49,75` and `codex-arch-review-context.cjs:960` were read in context): `SHIPYARD_GRAPH_DIR` (graph-directory override: `graph-dir.cjs`, `deliver-dispatch.cjs:254,562-577`, `dispatch-record.cjs:1141-1145`, `codex-delivery-host.cjs:131,166-167,1797`, `codex-decompose-host.cjs:965-966,1015`, `session-observer.cjs:355`, `codex-arch-review-context.cjs:432,762,960,980`); `SHIPYARD_RUNTIME`/`GSD_RUNTIME` (`runtime-context.cjs:124-125,198-205`, `gsd-tune.cjs:996,1113`); `SHIPYARD_GSD_TOOLS`/`GSD_TOOLS`/`GSD_CORE_HOME`/`GSD_HOME` (`runtime-context.cjs:127-128,179,208-211`); `GSD_DEFAULTS_PATH`, `SHIPYARD_DELIVERY_RULES_SOURCE` (`gsd-tune.cjs`); `SHIPYARD_DISPATCH_TTL_MS` (`dispatch-record.cjs:109`). `graph-dir.cjs:14-25` is an in-repo precedent for the style a resolver should follow: documented order, explicit input always wins, "nothing is guessed past that", and the error names the real cause (E44).

**Runtime** resolution is a third system: `runtime-context.cjs` `resolveRuntime` (lenient, 7 explicit candidates, then session env, then legacy project config, then `CODEX_HOME`+`config.toml`) versus `resolveDispatchContext` (strict; throws `UNKNOWN_RUNTIME`/`AMBIGUOUS_RUNTIME`; `CODEX_HOME` is deliberately not a source, lines 195-253). `markerFromPath` (line 84) recognises a runtime only from a path segment exactly `.codex` or `.claude`; the dogfood Codex root `~/.local/state/shipyard/dogfood/codex/<hash>/shipyard` (computed in `Makefile:127`) has no such segment, so path-based inference (used only when a caller passes `scriptPath`) cannot identify a dogfood bundle (E18). Claude side: `CLAUDE_CONFIG_DIR` with `~/.claude` default (`claude-runtime-host.cjs:363-371`, `claude-decompose-host.cjs:353,606,692`). The Claude hosts probe the Claude CLI (`--capability-only`, `runtime_capability_missing`: `claude-runtime-host.cjs:197-202,1004-1020`) and synthesise a capabilities object from the resolved selection (`claude-decompose-host.cjs:640`); none of the `capabilit` hits in the four Claude host scripts reads a capabilities **file** (E19).

What the installer **writes** that a launcher could use (E20, E21): `$CODEX_HOME/shipyard/manifest.json` (fields `codexHome`, `scriptsRoot`, `policy_hash`, `capabilities_file`, `capabilities_digest`, `bundle_files`, `bundle_digests`, `agent_digests`, `shipyard_version`; `gen-codex-shipyard.cjs:360-388`) and a byte-exact copy of the operator-supplied capability document at `$CODEX_HOME/shipyard/codex-capabilities.json` (`gen-codex-shipyard.cjs:352-355`: "a durable copy of the caller's input … a policy-derived copy would claim support that was never measured"). `gsd-tune.cjs:200-215` already checks `sha256(bundled file) == manifest.capabilities_digest` — but inside `validateCodexBundle`, which validates a **staged** directory (`agents/`, `skills/`, `bundle/`) at generation time, not the flattened installed layout; reuse at launch time needs adaptation (cost unknown, Q9).

### 2.3 Local bookkeeping admission and legacy history

Mechanism (E22, E23, E24):

1. `dispatch-record.cjs:1294-1300` `authenticateBookkeeping(cwd, fn, writtenPaths, required)` calls `fn()` directly **only if** `required` is false **and** no `.shipyard-role-artifacts` exists **and** the authenticated catalogue has no pins; otherwise it calls `role-artifact.cjs:1808` `trustedBookkeepingMutation`.
2. `d8a70dec` added this function and made `recordInflight`, `clearInflight` and `writeProvenanceOnce` pass `required = localInflightBookkeeping(input, cwd)` (true when the launching worktree **is** the project holding the graph). Before `d8a70dec` these paths took no authenticated route at all (`git diff d8a70dec^ d8a70dec -- dispatch-record.cjs`, E22).
3. `trustedBookkeepingMutation` (`role-artifact.cjs:1808-1871`) creates the authority directory and HMAC key (`authorityState(worktree, true)`, line 1815 / 1037-1065), then compares the physical `.planning/graph/provenance/*` listing to `historicalBookkeepingPins()`; with **no `catalogue.json`** that set is `[]` (line 1779), so any existing member refuses `ARCHIVE_AUTHORITY_INVALID` "unknown host provenance member before trusted mutation" (lines 1825-1827). This is exactly the INV-015 observation.
4. The refusal is **runtime-neutral**: both delivery hosts call `recordInflight` with `worktree` (`claude-delivery-host.cjs:1147`, `codex-delivery-host.cjs:3523` on `origin/main`, E25). A Claude-runtime launch on the same upgraded worktree is expected to refuse the same way (static reading; not reproduced).

Machinery that already exists and bounds the design space:

- A catalogue schema-evolution precedent: `payload.bookkeeping_state` supersedes `payload.latest_bookkeeping`; `trustedBookkeepingMutation` handles both (lines 1781, 1829-1843). `authorityState` validates only `schema`, `worktree` and `records` (lines 1062-1063), and `writeArchiveCatalogue` re-serialises `state.payload` whole (lines 1794-1807). By static reading an **additive catalogue field is ignored, and preserved, by older code**.
- A message that already names the missing concept: `ARCHIVE_AUTHORITY_REQUIRED` "archive catalogue is missing; explicit trusted legacy admission is required" (`role-artifact.cjs:1061`). `admitHistoricalArchive` (`role-artifact.cjs:2050`, exported at 4021) is the only "legacy admission" function; it admits **retained role archives** with manifests/receipts, has **no production caller** (grep over `plugins/delivery-pipeline` finds only its definition and export; unit tests call it) and does not cover dispatch sidecars (E26). `LAUNCH-REFUSAL.md:38` reaches the same conclusion.
- Consumers: `readProvenance` (`dispatch-record.cjs:1584,1922`) has **no non-test caller** (E27). Architecture review reads only the *current* dispatch's sidecar and requires `provenance.dispatch_id/ticket/role` to match (`codex-arch-review-context.cjs:441-460`, pins at 957-974). But `historicalBookkeepingPins()` **is** consumed as authenticated attestation (`codex-arch-review-context.cjs:510-512,631,775,983,1018,1094`), so legacy members must never be merged into that list (E28b).
- A collision hazard for any "adopt" design: `writeProvenanceOnce` returns early when the sidecar path already exists (`dispatch-record.cjs:1566-1567`), and callers may supply `dispatch_id` (`codex-delivery-host.cjs:1813`: `archDispatchId || request.dispatch_id || newDispatchId()`). A planted or legacy file whose name equals a future dispatch id would satisfy that check without being written by the host.
- Tests: `tests/unit/dispatch-record.test.cjs:2181-2205` pins only the **non-local** route (an external ticket worktree must not pin the canonical graph's legacy file). No test covers "same-worktree route + pre-existing provenance + no catalogue" (the observed failure) (E29).
- A store-level precedent for treating old records conservatively: `activeDispatches` binds an old record to the rule it was written under and fails "toward offering the work" (`dispatch-record.cjs:1398-1437`).

### 2.4 Producer/consumer of phase + repository + ADR digest

| Subject family | Producer | Consumer / parser |
|---|---|---|
| Planning packet / run-scope ticket `phase=<n>;input=<INV|ADR-id>;repository=<repo>` | `deliver-dispatch.cjs:986` (`origin/main:1019`) | `run-contract.cjs:233` regex `[^;\s]+`, plus positional slice `ticket.slice(indexOf(';repository=')+…)` at `run-contract.cjs:430-435` |
| Decomposition seal `phase=<n>;repository=<repo>` (d8a70dec) → `…;adr=<sha256>` (origin/main, #486) | d8a70dec: `codex-decompose-host.cjs:140`, `claude-decompose-host.cjs:175`; origin/main: `decompositionAdr.decompositionSubject` (`planning-result-sealer.cjs:348-355`) | origin/main: `SUBJECT_PATTERN` regex `[^;]+` (`planning-result-sealer.cjs:298`), `assertDecompositionSubject` (357-368), `sealDecomposition` (375) |
| Integrator/sentinel `phase=<id>;repository=/…;tickets=<sha256>` | `role-artifact.cjs:2794`, `claude-role-host.cjs:612` | `run-contract.cjs:228` (`[^;\s]+`), `dispatch-record.cjs:1509` (`\/[^;\x00-\x1f]+`) |
| Aggregate arch-review `phase=…;repository=…;tickets=…;pr=…;head=…;base=…` | `architecture-target.cjs:57` | `architecture-target.cjs:8` `PHASE_SUBJECT` |

Findings (E09, E10, E30, E31):

- At `d8a70dec`, `commands/decompose.md:302,400` promises `phase=<phase>;repository=<repo>;adr=<ADR digest>` and "a wrong phase or ADR digest … is a hard refusal", but no production code forms or checks `adr=`: producer and consumer disagree with the documented contract. The merged #486 closes this for the decomposition **seal** by putting form (`decompositionSubject`), parse (`SUBJECT_PATTERN`) and verify (`assertDecompositionSubject`, `assertAdrUnchanged`) in one module used by both decompose hosts (`origin/main`: `claude-decompose-host.cjs:134,182`, `codex-decompose-host.cjs:77,165`).
- After #486 the **other** subject families are still formed with template strings and checked by separate regexes in different files. Their repository character classes differ (`[^;]+`, `[^;\s]+`, `\/[^;\x00-\x1f]+`). Whether a repository path containing whitespace passes one and fails another is **unknown** (static reading only; spike S2).
- "Repository" has at least four definitions: remote `owner/name` lower-cased else project path (`deliver-dispatch.cjs:805-812`), `git rev-parse --git-common-dir` realpath (`deliver-dispatch.cjs:1159`, `role-artifact.cjs:2332,2390`), `git-common:<sha256(commonDir)>` (`codex-delivery-host.cjs:1320,1404,2153`, `conveyor-coverage.cjs:34`, `run-contract.cjs:438`), and `scope.repository`/`realpath(worktree)` (`codex-decompose-host.cjs:149`).
- The "ADR digest" is `sha256` of the ADR file bytes, resolved from the authenticated worktree at launch and re-verified at seal time (`resolveAdr`, `assertAdrUnchanged`, `planning-result-sealer.cjs:317-346`); it is not a property of the planning packet subject, whose ADR integrity rides on the packet's `sourceRefs[].sha256` (`deliver-dispatch.cjs:812-817,986-1001`).
- Sealed envelopes persist the subject string. Any change of its format must keep previously sealed artifacts verifiable (INV-014 research lines are to be preserved, `investigate.md:236-237`).

### 2.5 Preflight and refusal surface

- `refusal-hints.cjs` has 16 hint keys (`HINTS`, lines 8-73). `ARCHIVE_AUTHORITY_INVALID`, `ARCHIVE_AUTHORITY_REQUIRED`, `ARCHIVE_ADMISSION_REQUIRED` and `RUNTIME_CAPABILITY_MISSING` have **no key** and fall to the default "reason this map does not name … Re-run the command and check the surrounding stderr" (lines 3-6, 75-84; matches `LAUNCH-REFUSAL.md:12`). `RUNTIME_UNAVAILABLE` has a key whose remedy is "Install and authenticate the runtime" (lines 53-56) — it does not name the capabilities file, so the capability refusal reaches the user with a misleading remedy (E32).
- Hosts print `formatHint(error.code)` only on a non-zero CLI exit (`codex-delivery-host.cjs:1976-1985`). `investigate.md:51-56` instructs the invoking agent to read the hint and explain it: the supported remedy is whatever that single line says.
- `make doctor` → `scripts/shipyard-doctor.cjs` checks hook bundles, Codex bundle/manifest presence, route block, notify delegate, agent manifest and release-cache provenance. It does **not** check the capabilities file, Codex home consistency, runtime resolution, or project-local bookkeeping. It resolves everything from `ROOT = __dirname/..` (a source checkout) and is **not packaged**: `scripts/package-shipyard-codex.cjs:9-10` lists eight scripts (no doctor) and `plugins/shipyard/host/scripts/` contains exactly those eight (E33).
- `sentinel-preflight.cjs` and `phase-integrator-preflight.cjs` are git/graph/PR-state preflights (fast-forward, dirty graph, merged PRs, plan sets), not environment or install preflights (E34).
- `gsd-tune.cjs` is a project/runtime configuration reporter and bundle validator; with `--validate-codex-bundle` it checks a staged bundle against supplied capabilities (E22b).

### 2.6 Packaging, test and delivery facts that drive cost

- Every plugin script change is mirrored byte-for-byte under `plugins/shipyard/host/plugins/delivery-pipeline/…` and also edits `plugins/shipyard/.codex-plugin/plugin.json` and `plugins/shipyard/package-build.json` (`scripts/package-shipyard-codex.cjs:19-23`; visible in `git show --stat` of #482, #486, `d8a70dec`, E35).
- #486's message records that its helpers were put into an existing file because "a separate script file would change the package inventory that the phase 49 publication pins track" — a new script file has a publication-pin cost (E35).
- `scripts/check-runtime-digest-trailer.cjs` + `tests/unit/runtime-file-digests.json` require a `Runtime-Digest-Refresh:` trailer when pinned runtime files change; CI (`.github/workflows/test.yml`) runs `make test-fast`'s publish gate, trailer check and sandbox backend (E36).
- Prose-pinned tests: `tests/unit/source-contract.test.cjs:1024-1026,2105-2114` and `host-state-prose-contract.test.cjs:41` assert that `investigate.md`/`deliver.md` name `codex-delivery-host.cjs`; `investigate.md`, `deliver.md` and `decompose.md` name a host script on 8 + 12 + 9 lines (E37).
- `tests/smoke/phase47-runtime-acceptance.cjs:658-680` asserts that the recorded approval is the direct host invocation `['node', <installed codex-planning-context-host.cjs>, '--args-file', <request>]` and that its environment **contains** `CODEX_HOME` (equal to the runtime root), `SHIPYARD_GRAPH_DIR` and `SHIPYARD_CODEX_CAPABILITIES_FILE` (equal to the installation's capabilities path). Changing the "caller supplies env" contract or the supported invocation touches this harness (E38).
- Existing end-to-end entry points (E39): `tests/smoke/codex-shipyard-smoke.sh` (installs into a temp `CODEX_HOME` with an explicit capabilities file, runs bundled helper scripts; network-backed; not in `test-fast`), `tests/smoke/model-ladder-runtime-smoke.sh` (in `test-fast`, installs with explicit env), `tests/unit/marketplace-installer.test.cjs` (isolated candidate install with a fake `codex`), `tests/live/live-round.sh` (real CLIs, `gh auth`, throwaway repo; calls hosts directly with `--args-file`/`--request-file`; clean fixture; requires `shipyard-doctor`). **None** launches with the environment variables cleared, upgrades a project carrying old history, or runs a UI cycle. `plugins/delivery-pipeline/commands/` has no UI command; the only UI reference is `--skip-ui` in `decompose.md:386-390` (E40) — "the existing supported UI path" is not identifiable from this repository (Q12).

## 3. Design dimensions (building blocks the options combine differently)

### 3.1 Environment-discovery rule (ED)

| Id | Rule | Notes |
|---|---|---|
| ED1 | Patch each site to "explicit option → env var → `~/.codex`-relative default → bundle-adjacent file". | Smallest. Keeps N copies; precedence can drift again. |
| ED2 | **Self-locating**: derive the bundle root from the executing script (`__dirname/..` when `manifest.json` is present), read `codexHome`, `capabilities_file`, `capabilities_digest`, `policy_hash` from the manifest; env vars are explicit overrides; env that disagrees with the bundle is a **named conflict**, not a silent pick. | Works for global, dogfood and custom homes with no env. `codex-notify.cjs:26` is a precedent for script-relative home. Strengthens today's shape-only check (`readCapabilities`, `codex-runtime-host.cjs:142-158`) with a digest binding. Not available for a source checkout (no manifest). |
| ED3 | **Persisted launch context** (`launch-context.json`) written at install/session start and read by hosts. | A new file to keep fresh: the same stale-state failure class if home or build changes. |

### 3.2 State-migration scheme (MS) for pre-existing provenance/dispatch records

| Id | Scheme | Satisfies PROBLEM req. 2 ("kept as historical and unverified, never trusted, never block, deleting history not required")? |
|---|---|---|
| MS0 | Status quo: refuse; operator archives/deletes history (what was done on 2026-10-15). | No — the user rejected it as a remedy. |
| MS1 | **Adopt-as-historical-unverified**: on first admission with no authenticated catalogue, the host (under `withArchiveAuthorityLock`) records the physical inventory in the HMAC-protected catalogue under a **new, separate field** (e.g. `legacy_bookkeeping` with schema/version, host version, timestamp, per-member path/bytes/sha256), status `historical-unverified`; files are left in place; the "unknown member" check allows `authenticated ∪ legacy`; any **new or altered** member still refuses. | Yes, if the design obligations below hold. |
| MS2 | Same record, but only by an explicit operator command. | Only if some supported surface runs it automatically; otherwise it fails "no knowledge of internal host commands". |
| MS3 | **Namespace split**: new sidecars go to a new directory/location; the old directory is never enumerated or trusted. | Yes, but every hard-coded `.planning/graph/provenance/…` path must move (`dispatch-record.cjs:1560,1581`, `role-artifact.cjs:1784,1811,1818,1823`, `codex-arch-review-context.cjs:446,965,1105`), and old hosts then see an un-enumerated directory. Higher blast radius. |

**Obligations any MS1/MS3 variant must meet** (derived from §2.3; each is a verification item, not a decision): (a) legacy members are never added to `bookkeeping_state`/`historicalBookkeepingPins()`; (b) legacy members never satisfy the `writeProvenanceOnce` existence short-circuit for a **new** dispatch id; (c) adoption is one-shot per worktree (re-adoption policy is Q4); (d) a legacy member changed after adoption is reported, and the policy (block/warn) is Q5; (e) concurrent first launches are serialised by the existing authority lock; (f) the record is versioned so a later host can tell adopted-legacy from authenticated.

### 3.3 Digest/subject contract (DC)

| Id | Scheme | Notes |
|---|---|---|
| DC0 | Status quo of `origin/main`: shared decomposition-seal helpers (#486), other subject families separate. | Local `main` lacks #486 entirely. |
| DC1 | Adopt #486 and add a **cross-module contract test**: build every subject family with its producer and parse it with every consumer; assert one repository identity and character class. | No production code move; catches drift after the fact. |
| DC2 | **One subject-contract module** exporting build/parse/verify for each family plus a single `repositoryIdentity(worktree)`; replace the template strings and regexes listed in §2.4. | Either extend `planning-result-sealer.cjs` (no new inventory entry) or add a file (publication-pin cost, §2.6). |
| DC3 | **Structured subject**: carry `{phase, repository, input, adr:{path,sha256}}` as fields and compare fields instead of strings; keep the string only for display. | Changes sealed-envelope/manifest schema; old sealed artifacts must stay verifiable; widest change. |

## 4. Options

Every option is a complete package: how the environment is prepared, how compatibility is checked before an agent launches, how legacy state is migrated, how the digest contract is shared, and how it is verified end to end. All options keep the cross-option constraints in §6.

### Option A — Minimal change: repair each failing site, no new entry point

Sketch
- ED1 at the failing sites: give `codex-runtime-host.cjs:166-168` the same `~/.codex` default its siblings use and a bundle-adjacent file (`<home>/shipyard/codex-capabilities.json`); make `codex-delivery-host.cjs:710` and `codex-agent.cjs:93` call the same small helper, placed in an **existing** module (for example `runtime-context.cjs`) to avoid a new inventory entry.
- Preflight = better messages only: add hint keys for `ARCHIVE_AUTHORITY_INVALID`, `ARCHIVE_AUTHORITY_REQUIRED`, `RUNTIME_CAPABILITY_MISSING` and correct the `RUNTIME_UNAVAILABLE` remedy in `refusal-hints.cjs`. The agent still launches the host directly and learns the remedy from the failure.
- MS1 implemented inside `trustedBookkeepingMutation`/`historicalBookkeepingPins` (the same file and style as #482's predicate change).
- DC1: land #486 on the baseline (it is absent from local `main`) and add the cross-module contract test.
- Verification: unit tests for each changed site; extend `codex-shipyard-smoke.sh`/`dispatch-record.test.cjs` with a legacy-history fixture; an installed-package e2e still has to be built (none exists, §2.6).

| Dimension | Assessment |
|---|---|
| Cost (assumption, E35 calibration: #482 = 10 files, #486 = 21 files) | about 12–25 files including generated mirrors; one authority-module change (`role-artifact.cjs`, 4047 lines) is the riskiest part. |
| Authority | Unchanged. The existing HMAC catalogue authority gains one additive field; no new component mints trust. |
| Compatibility | All entry points, command prose and prose-pinned tests unchanged. Explicit env still wins. Older hosts ignore the additive catalogue field (static reading). |
| Rollback | Revert the PR(s). An older host given a populated legacy directory refuses exactly as today; no data is corrupted. |
| Meets PROBLEM req. 1–5 | R1 partial (only the patched sites; `gsd-tune`, `session-observer`, `dispatch-record` agent-dir stay separate). R2 yes. R3 partial (#486 only; other families unchanged). R4 not by itself. R5 partial (messages after failure, no pre-launch check). |
| Forecloses | Nothing structural — but it leaves about seven independent resolution sites and four subject families, so the divergence that produced this INV can recur. |
| Main risks | Drift between sites persists; hints help only agents that read stderr; touching `role-artifact.cjs` needs the runtime-digest trailer and review of authority semantics. |

### Option B — Library-first: one shared environment + preflight module, called by every host at start (hosts self-prepare)

Sketch
- A shared module (either extended `runtime-context.cjs`/`planning-result-sealer.cjs`, or a new file) exports `resolveEnvironment({runtime, env, scriptDir})` returning a frozen record (`runtime`, `home`, `capabilities{path,sha256}`, `agentDir`, `bundleRoot`, `sources[]`) using ED2, and `preflight({runtime, project, role})` returning ordered checks `{id, status, detail, remedy_code}` with one remedy catalogue shared with `refusal-hints.cjs`.
- Every host entry (`codex-delivery-host`, `codex-decompose-host`, `codex-planning-context-host`, `claude-delivery-host`, `claude-investigation-host`, `claude-decompose-host`) runs the preflight **before** `controller.begin`, replaces its local `CODEX_HOME || …` expressions with the record, and builds child environments from it. `gsd-tune`, `session-observer`, `dispatch-record` and `codex-agent` use the same resolver. A `--preflight` flag per host CLI exposes the checks without launching.
- MS1 runs as a preflight step ("project state": classify provenance as clean / legacy-adoptable / refuse) and is executed in-process under the authority lock.
- DC2 (extend `planning-result-sealer.cjs` to all subject families + `repositoryIdentity`) so builder and parsers are one implementation.
- Verification: unit tests for the resolver conflict/precedence table and the preflight check list; installed-bundle e2e that clears the environment and calls the **existing** host entry points (`--args-file`).

| Dimension | Assessment |
|---|---|
| Cost (assumption) | about 25–45 files: six host entries, the resolver, `refusal-hints`, the migration, the contract module, mirrors, tests. Medium. |
| Authority | Preflight is read-mostly; only the adoption step writes, through the existing authority module. Hosts remain the admission points; an agent cannot skip preflight because it lives in the host entry. A bundle-digest check strengthens today's capabilities validation. |
| Compatibility | Command prose and the documented host invocations (`--args-file`, `--request-file`) stay valid; direct `node <host>` now self-prepares. Prose-pinned tests need no change. Env overrides remain (conflict behaviour is Q7). |
| Rollback | Revert the PR; entry points are unchanged so no command/skill rollback. Catalogue field additive. |
| Meets PROBLEM req. 1–5 | R1 yes (one resolver, all sites). R2 yes. R3 yes. R4 enables a clean e2e on existing entry points (the e2e itself still must be written). R5 yes inside each host; no single standalone "front door" unless the `--preflight` flags are counted. |
| Forecloses | A single place a user or agent types to "launch Shipyard" (launch stays "call the right host"); hosts become heavier and each new host must remember to call the library (needs a test that enumerates host entry points). |
| Main risks | Many call sites change at once; a missed host keeps the old behaviour; a new file costs a publication-pin update (§2.6) unless the library lives in an existing module. |

### Option C — New single launcher CLI ("front door"); hosts stay strict

Sketch
- A new script in the bundle (for example `shipyard-launch.cjs`) invoked as `node <bundle>/scripts/shipyard-launch.cjs <role> --args-file X [--runtime auto|codex|claude] [--preflight-only]`. It self-locates (ED2), runs the full preflight (bundle digests vs `manifest.json`, capabilities digest vs `capabilities_digest`, policy hash vs `model-policy.cjs`, agents manifest, project bookkeeping classification), performs MS1 adoption, then spawns the existing host with a **validated child environment** (at least `CODEX_HOME`, `SHIPYARD_CODEX_CAPABILITIES_FILE`, `SHIPYARD_RUNTIME`; whether it also owns `SHIPYARD_GRAPH_DIR` and the `GSD_*` family from §2.2 is Q17) and passes the host's JSON/exit code through (distinct exit code and `hint[CODE]` line for preflight refusals).
- `investigate.md`, `deliver.md` and `decompose.md` (29 lines naming a host script) and the generated Codex skills call the launcher instead of host scripts. Hosts keep their strict "no silent default" stance for direct invocation (defence in depth), but the supported path never hits it. Host-level admission of adopted state (MS1 in `role-artifact.cjs`) is still required.
- DC2 as in Option B (the launcher does not own the digest contract).
- Verification: the launcher is a natural **real entry point** for the e2e checks in PROBLEM req. 4 (no env; upgrade with old history; both runtimes); the full UI cycle depends on Q12.

| Dimension | Assessment |
|---|---|
| Cost (assumption) | about 30–50 files: launcher, resolver/preflight library (as B), three commands + pinned prose tests (`source-contract.test.cjs`, `host-state-prose-contract.test.cjs`), packaged skills, mirrors, e2e harness. Medium-large. |
| Authority | The launcher mints no trust: env values it passes are data that hosts re-validate; "launched via the launcher" must **not** become an admission signal (a design rule to test). Adoption still goes through the authority module. |
| Compatibility | Additive. Old direct host calls keep working under the existing env contract. Docs and prose-pinned tests change; `phase47-runtime-acceptance.cjs:673-679` encodes the caller-supplies-env contract and needs review. |
| Rollback | Point the commands back to the hosts; the hosts are unchanged and the launcher file is inert. Catalogue field additive. |
| Meets PROBLEM req. 1–5 | R1 yes. R2 yes. R3 yes (with DC2). R4 yes (best-fitting entry point). R5 yes (explicit, standalone, before any agent). |
| Forecloses | The "agents call hosts directly" path becomes deprecated and needs a lint/test to keep prose honest; the launcher must track every host CLI contract (including resume arguments, `parseResumeArguments`) or pass them through opaquely; one more process hop that must forward signals and keep the host's lease/heartbeat semantics (unknown, spike S5). |
| Main risks | Two front doors during migration; a new file's publication-pin cost; wrapper/host exit-code and stdout contract drift. |

### Option D — Lifecycle-time preparation: persisted launch context and migration at install / upgrade / session start

Sketch
- Extend what already runs automatically on Codex: the marketplace `SessionStart` hook (`hooks/hooks.json` → `ensure-gsd-core.sh --launch-bootstrap` → `bootstrap-shipyard-plugin.cjs`, `package-shipyard-codex.cjs:48-50`; idempotent, 360 s timeout) and the installer. They write `<bundle>/launch-context.json` (ED3: home, bundle digest, capabilities path+digest, policy hash, runtime) and run MS1 for the project the session starts in (`SHIPYARD_PROJECT_DIR` is already passed to the installer, `bootstrap-shipyard-plugin.cjs:114`). Hosts read the context through a small shared reader and refuse with a named remedy when it is absent or stale.
- Claude: the Claude plugin has no preparation hook (`plugins/delivery-pipeline/hooks/` does not exist). The only `SessionStart` wiring in tracked source is the Codex marketplace package's generated `hooks/hooks.json` and a per-launch Claude agent-start **evidence** hook registered in `claude-runtime-host.cjs:759-771` (10 s timeout) — not a preparation hook (E41). Claude would need either changes to the settings-based hook installer or in-host resolution. MS1 must also exist in the hosts for projects the session did not start in.
- DC1 or DC2 independently.
- Verification: e2e covers install → upgrade → session start → ordinary command, which matches the "after install or upgrade" wording of PROBLEM.

| Dimension | Assessment |
|---|---|
| Cost (assumption) | about 20–35 files: installer, generator, bootstrap, reader, hosts, tests, mirrors; plus uncertainty about hook semantics. Medium. |
| Authority | `launch-context.json` is one more file to trust and keep fresh; it must be validated against the manifest digest at use, otherwise it recreates the stale-data failure class. |
| Compatibility | Codex marketplace/installer path only; manual `make install-shipyard-codex` also goes through the marketplace launcher (`Makefile:24-25`), dogfood installs go through the installer. Sessions on an older build have no context until upgrade runs. |
| Rollback | Older hosts ignore the file; leaving it is harmless. Catalogue field additive. |
| Meets PROBLEM req. 1–5 | R1 yes for Codex when the context exists. R2 yes for the session's project only. R3 independent. R4 natural (install → session). R5 at session start only; failures surface away from the failing command. |
| Forecloses | Diagnosing at command time; headless/CI/`codex exec` children if hooks do not fire there (unknown, S3); a Claude solution (no equivalent hook); a rule "no persisted state" for the launch path. |
| Main risks | Hook cwd/env/timing semantics are unverified; a persisted context drifts when `CODEX_HOME` or the build changes; per-session migration races (lock exists for install, `bootstrap-shipyard-plugin.cjs:76-80`). |

## 5. Comparison

| | A — Minimal repairs | B — Shared library, hosts self-prepare | C — Single launcher CLI | D — Lifecycle preparation |
|---|---|---|---|---|
| One supported launch path (PROBLEM intro) | No | By convention (host entry points) | Yes | Implicit (session start) |
| R1 auto env discovery | Partial (3 sites) | Yes, all sites | Yes | Codex only, if context present |
| R2 legacy kept historical/unverified | Yes (MS1) | Yes (MS1) | Yes (MS1) | Yes for session project (MS1) |
| R3 shared digest contract | Partial (DC1, #486) | Yes (DC2) | Yes (DC2) | Independent (DC1/DC2) |
| R4 installed e2e through real entry points | Needs new harness | Needs new harness on existing entries | Needs harness; launcher is the entry | Needs harness; install→session |
| R5 preflight before any agent | Messages only | In each host, optional `--preflight` | Standalone and automatic | At session start only |
| Claude coverage | MS1 yes; env n/a | Yes | Yes | No hook; needs in-host fallback |
| New files (publication-pin cost) | 0 | 0–1 | ≥1 | ≥1 |
| Command prose / pinned tests change | No | No | Yes | Minor |
| Estimated files touched (assumption) | 12–25 | 25–45 | 30–50 | 20–35 |
| Authority impact | None | Preflight read-mostly | Launcher must not vouch | Persisted context must be digest-bound |
| Rollback | Revert PR | Revert PR | Revert docs; launcher inert | Revert; leftover file harmless |
| Forecloses | Nothing; drift can recur | A single typed front door | Direct-host path becomes deprecated; extra process hop | Command-time diagnosis; non-hook invocations; Claude |
| Biggest unknown | `role-artifact.cjs` change review | Missed-host risk | Signal/lease behaviour through a wrapper | Hook semantics |

Composition notes (facts, not a recommendation): A's MS1 and hint changes are needed by every option; B's library is the natural core of C; D's context file is orthogonal and could be added to B or C later.

## 6. Constraints that hold for every option (taken from PROBLEM/CONTRACT; not re-opened here)

- No bypass of provenance, receipts or host admission; no silent trust of legacy files; no provider/runtime switching or fallback; no ADR-014/model-policy change (`PROBLEM.md` out-of-scope list).
- Legacy history stays on disk and in place; cleaning or deleting it (including the archive-and-remove cleanup done by hand on 2026-10-15) is not an accepted remedy (`PROBLEM.md` success item 2 and out-of-scope list; `LAUNCH-REFUSAL.md:36-38`).
- Generated Codex files are not edited directly; source is `plugins/delivery-pipeline/**` and `scripts/**`, mirrored by `make package-shipyard-codex` (`package-shipyard-codex.cjs:19-23`).
- The installer must not fabricate capability evidence (pinned by `tests/smoke/codex-shipyard-smoke.sh:145-155`); using the **operator-supplied bundled copy** at launch is a separate question (Q6).
- Host-owned writer/lease and authority-key ownership are unchanged; any new write goes through the existing authority module. Claude launches sandbox-deny the model's read and write of the archive-authority directory (`claude-runtime-host.cjs:751`, `denyRead`/`denyWrite: [archiveAuthority]`), so adoption and preflight must be host-side code, never an instruction the agent carries out.
- Investigation only: this INV authorises no implementation, ticket, PR or deployment (`DECISIONS.md`).

## 7. Status-quo reference and "buy, not build"

- **Status quo (not offered as an option):** keep refusing and document the manual recovery. #482 already softened the first-run case, but an upgraded worktree with populated history and a default-home install without exported variables still fail; the user's cleanup on 2026-10-15 was the only recovery (`LAUNCH-REFUSAL.md:40-46`). It cannot satisfy PROBLEM success items 1, 2 and 5.
- **Buy, not build:** no external product was identified that owns Shipyard's project-local bookkeeping authority. GSD core (`ensure-gsd-core.sh`, `gsd-tools capability install`) owns the runtime marker and capability install, but whether it exposes a reusable preflight/doctor is **unknown** and was not checked because `~/.codex/gsd-core` is outside this line's read scope (Q10).

## 8. Unknowns and draft open questions (mirror into `OPEN-QUESTIONS.md`)

- [ ] Q1. Which revision is the design baseline — local `main` `d8a70dec`, `origin/main`/`v0.72.2` (`be7ab4f3`, 9 commits ahead, containing #482 and #486) — and which build is actually installed at `~/.codex/shipyard`? Next check: the user reads `shipyard_version` from `~/.codex/shipyard/manifest.json` (outside this line's read scope). — owner: user
- [ ] Q2. Must legacy adoption (MS1) run automatically at first launch, or only on explicit consent (MS2)? PROBLEM item 2 implies automatic. — owner: user
- [ ] Q3. Is a structured `legacy_bookkeeping` catalogue field with its own schema/version acceptable, or must legacy status be expressible without touching the catalogue payload? — owner: user
- [ ] Q4. After the one-shot adoption, how are files written by an older concurrent host (partial history) handled: refuse, or allow repeatable adoption? — owner: user
- [ ] Q5. A legacy-unverified member that changes after adoption: block, warn, or ignore? — owner: user
- [ ] Q6. Is the bundle's byte-exact `codex-capabilities.json` acceptable as "explicit capability evidence" at launch, and must launch re-check it against the live Codex CLI (`codex debug models`) for staleness? — owner: user
- [ ] Q7. When an env override disagrees with the bundle manifest (digest or home): refuse by default, or let env win with a visible warning? — owner: user
- [ ] Q8. Is a standalone preflight-only command (`--preflight`) wanted, and for both runtimes? — owner: user
- [ ] Q9. Can `validateCodexBundle` checks be reused against the installed layout, or must they be rewritten? Next check: a `/gsd-spike` comparing staged and installed layouts. — owner: research
- [ ] Q10. Does GSD core expose a preflight/doctor worth reusing? Next check: read `gsd-tools --help` in an isolated candidate install. — owner: research
- [ ] Q11. May the shared resolver/contract live in a **new** script file, or must it extend an existing module because of the phase 49 package-inventory pins (#486 message)? — owner: maintainer / user
- [ ] Q12. What is "the existing supported UI path" for the installed-package full-UI-cycle check? The repository has no UI command; only `--skip-ui` in `decompose.md:386-390`. — owner: user
- [ ] Q13. Which repository identity is canonical for subjects: remote `owner/name`, git-common realpath, `git-common:<sha256>` or worktree path (four definitions, §2.4)? — owner: maintainer / user
- [ ] Q14. Do Codex `SessionStart` hooks receive the project cwd and can their effects persist to later commands and to headless children? (Option D feasibility.) — owner: research (spike S3)
- [ ] Q15. Does the Claude runtime need an equivalent preparation hook, or is in-host resolution enough? — owner: user
- [ ] Q16. Do `run-store.cjs` and `planning-writer-lease.cjs` impose ordering or fencing on a catalogue write during adoption? (Not analysed in this line.) — owner: system-state line / research
- [ ] Q17. Which environment inputs does the "validated environment passed to every child" own — only Codex home, capabilities file and runtime, or also `SHIPYARD_GRAPH_DIR`, `SHIPYARD_CODEX_AGENT_DIR`, `SHIPYARD_CODEX_LOG_DB` and the `GSD_*` family (§2.2)? — owner: user

## 9. Recommended spikes (not performed; throwaway code is out of scope for this line)

- `/gsd-spike "legacy provenance adoption on a scratch worktree with synthetic sidecars: allowed-set semantics, new/altered member refusal, writeProvenanceOnce collision, older-host behaviour with the extra catalogue field"` (S1; informs Q3–Q5)
- `/gsd-spike "repository path containing whitespace across planning-result-sealer SUBJECT_PATTERN, run-contract planning regex and dispatch-record integrator regex"` (S2; informs Q13)
- `/gsd-spike "Codex SessionStart hook: cwd, environment propagation, headless exec children, 360 s timeout"` (S3; Option D)
- `/gsd-spike "self-locating bundle discovery over global, dogfood and custom Codex homes using synthetic bundles; env/manifest conflict table"` (S4; informs Q6, Q7, ED2)
- `/gsd-spike "launcher wrapper around a host that holds a writer lease: SIGINT/SIGTERM forwarding, exit-code and stdout passthrough"` (S5; Option C)

## 10. Evidence ledger (commands and results)

All commands were run from `/Volumes/KINGSTON/claude-shipyard`. Where the agent's dedicated `Read`/`Grep`/`Glob` tool was used, the equivalent shell command is given for reproduction. Exit status was captured only where stated.

| Id | Command (or tool call) | Result relied on |
|---|---|---|
| E01 | `git rev-parse HEAD; shasum -a 256 .planning/investigations/INV-017-launch-and-upgrade-reliability/PROBLEM.md` | `d8a70decb32e5420fb69f8eebc17be08e82d6d86`; PROBLEM.md sha256 `eea376aa962b01c1c304f37410a61e331f95a7cc67728080fc4f3548c26c426b` (matches packet). |
| E02 | `shasum -a 256` of `RESEARCH-CONTRACT.md`, `DECISIONS.md`, `EVIDENCE.md`, `OPEN-QUESTIONS.md`, INV-015 `LAUNCH-REFUSAL.md`, the two `docs/audits/2026-10-03-phase47-*-fix.md` (exit 0 captured) | `b2f49322…`, `f773b0f7…`, `98cf82c0…`, `bb48677e…`, `990a8b43…`, `9e06c3e1…`, `f31c1088…`; RESEARCH-CONTRACT and DECISIONS match the packet. |
| E03 | `Glob .planning/codebase/**` (shell: `ls .planning/codebase`) | "No files found" — no codebase map. |
| E04 | `git rev-parse main origin/main`; `git rev-list --count main..origin/main`; `git log --oneline main..origin/main`; `git tag --contains d8a70dec`; `git branch --contains d8a70dec`; `git log --oneline main..fix/bind-decomposition-to-adr`; `git merge-base --is-ancestor fix/bind-decomposition-to-adr main` | main `d8a70dec`, origin/main `be7ab4f3`, count `9` (list includes #482, #484, #486, #487, 0.72.0/0.72.1 prep); tags `phase-47 v0.72.0 v0.72.1 v0.72.2`; branch tip `1ea923a4` printed "NOT ancestor of main" (the `||` branch ran, so merge-base exited non-zero). |
| E05 | `git rev-parse v0.72.2; git log -1 --format='%h %s' v0.72.2; git merge-base --is-ancestor v0.72.2 origin/main` | tag object `4dab1e91…` → commit `be7ab4f3` (#487); ancestor of origin/main. |
| E06 | `for t in v0.72.0 v0.72.1 v0.72.2 origin/main; do git grep -n "unknown host provenance member" $t -- plugins/delivery-pipeline/scripts/role-artifact.cjs; git grep -n "function authenticateBookkeeping" $t -- …/dispatch-record.cjs; git grep -c inflightBookkeepingRequired $t -- …/dispatch-record.cjs; done` | all four: `3955`, `1294`, `4`. |
| E07 | `Read .planning/investigations/INV-015-ui-lifecycle-integration/LAUNCH-REFUSAL.md` | cites installed `dispatch-record.cjs:1294`, `role-artifact.cjs:3954`; 64 sidecars; no catalogue; `RUNTIME_UNAVAILABLE` after cleanup. |
| E08 | `git diff d8a70dec origin/main -- plugins/delivery-pipeline/scripts/dispatch-record.cjs`; `git show --stat 9415c1e7`; `git tag --contains 9415c1e7` | `localInflightBookkeeping` → `inflightBookkeepingRequired` (true if worktree == project **or** provenance dir missing/empty); #482 is 10 files; tags `v0.72.0 v0.72.1 v0.72.2`. |
| E09 | `git show --stat --format=… 1ea923a4`; `git show --stat 78cdca26`; `git tag --contains 78cdca26` | #486 message ("neither host built that subject … nothing checked an ADR identity at all"; helpers kept in `planning-result-sealer.cjs` because a new script changes package inventory); 21 files; tags `v0.72.1 v0.72.2`. |
| E10 | `Grep pattern=";adr=\|adr=" path=plugins/delivery-pipeline` and `path=tests` on the working tree at `d8a70dec` (shell equivalent: `git grep -n -e 'adr=' d8a70dec -- plugins/delivery-pipeline tests`) | only `commands/decompose.md:302,400` in plugins; tests only `tests/unit/planning-artifacts.test.cjs:434,520,528`. |
| E11 | `git grep -n "adr=\|decompositionSubject\|resolveAdr\|SUBJECT_PATTERN" origin/main -- plugins/delivery-pipeline/scripts plugins/delivery-pipeline/commands`; `git show origin/main:plugins/delivery-pipeline/scripts/planning-result-sealer.cjs \| sed -n '290,375p'` | `SUBJECT_PATTERN` line 298; `resolveAdr` 317; `assertAdrUnchanged` 341; `decompositionSubject` 348; `assertDecompositionSubject` 357 (confirmed with `git grep -n -e "function assertDecompositionSubject" -e "function sealDecomposition" origin/main -- …/planning-result-sealer.cjs` → 357, 375); consumers in both decompose hosts. |
| E12 | `rg -n "SHIPYARD_CODEX_CAPABILITIES_FILE\|CODEX_HOME\|codex-capabilities\.json" plugins/delivery-pipeline/scripts` and `… scripts` | the site list in §2.2. |
| E13 | `sed -n '142,182p' plugins/delivery-pipeline/scripts/codex-runtime-host.cjs`; `grep -n "RUNTIME_UNAVAILABLE\|RUNTIME_CAPABILITY_MISSING\|capability_evidence_missing" …/codex-runtime-host.cjs` | rule 1 at 160-171; 169 `fail('RUNTIME_CAPABILITY_MISSING','explicit Codex capability evidence is required')`; 182 → `capability_evidence_missing`; 1549 `fail('RUNTIME_UNAVAILABLE', probe.detail …)`. |
| E14 | `sed -n '84,96p' …/codex-agent.cjs`; `sed -n '705,711p' …/codex-delivery-host.cjs`; `sed -n '276,298p' …/gsd-tune.cjs` | rules 2–4. |
| E15 | `sed -n '248,260p' scripts/gen-codex-shipyard.cjs`; `sed -n '116,138p' scripts/install-shipyard-codex.sh`; `scripts/bootstrap-shipyard-plugin.cjs:64-125` (Read) | rules 5–7. |
| E16 | `git grep -n "SHIPYARD_CODEX_CAPABILITIES_FILE\|CODEX_HOME" origin/main -- …codex-runtime-host.cjs …codex-delivery-host.cjs …codex-agent.cjs …codex-decompose-host.cjs` | same two-tier rule at `origin/main:codex-runtime-host.cjs:169-170`. |
| E17 | `sed -n '100,106p' scripts/install-shipyard-marketplace.cjs` | line 103-104: `if (hasExplicitHome \|\| … dogfood \|\| pinDefaultHome) env.CODEX_HOME = home; else delete env.CODEX_HOME;`. |
| E18 | `Read plugins/delivery-pipeline/scripts/runtime-context.cjs` (84, 89-168, 195-253); `sed -n '127p' Makefile` | `markerFromPath` needs a `.codex`/`.claude` segment; dogfood root = `~/.local/state/shipyard/dogfood/<runtime>/<hash16>`. |
| E19 | `rg -n "CLAUDE_CONFIG_DIR\|CLAUDE_HOME" plugins/delivery-pipeline/scripts`; `grep -n capabilit plugins/delivery-pipeline/scripts/claude-{runtime,delivery,decompose,role}-host.cjs` (output read line by line) | Claude config-dir sites in §2.2; the `capabilit` lines are the CLI probe (`runtime_capability_missing`, `--capability-only`), a synthesised object (`claude-decompose-host.cjs:640`) and host plumbing; none reads a capabilities file. |
| E20 | `sed -n '38,68p;352,388p' scripts/gen-codex-shipyard.cjs` | `readCodexCliCapabilities`; bundle copy of caller input; manifest fields. |
| E21 | `Read plugins/delivery-pipeline/scripts/gsd-tune.cjs` lines 120-215 | `validateCodexBundle` capabilities-digest check at 200-215 (staged layout). |
| E22 | `git diff d8a70dec^ d8a70dec -- plugins/delivery-pipeline/scripts/dispatch-record.cjs`; `git show --stat d8a70dec` (22b: `sed -n '276,298p' gsd-tune.cjs`) | `authenticateBookkeeping`, `localInflightBookkeeping` added; `mutate`, `recordInflight`, `clearInflight`, `writeProvenanceOnce` gain `authenticate`. |
| E23 | `Read plugins/delivery-pipeline/scripts/role-artifact.cjs` 990-1065 and 1777-1871 | `authorityState`, `historicalBookkeepingPins`, `trustedBookkeepingMutation`, refusal at 1825-1827, `ARCHIVE_AUTHORITY_REQUIRED` at 1061. |
| E24 | `Read plugins/delivery-pipeline/scripts/dispatch-record.cjs` 1270-1330, 1398-1442, 1498-1609; `git show origin/main:…/role-artifact.cjs \| sed -n '3905,3962p'` | admission flow; origin/main refusal at 3955. |
| E25 | `git grep -n "recordInflight(\|clearInflight(" origin/main -- plugins/delivery-pipeline/scripts`; `git show origin/main:…/claude-delivery-host.cjs \| sed -n '1130,1150p'`; `git show origin/main:…/codex-delivery-host.cjs \| sed -n '3510,3526p'` | both hosts pass `worktree` in the in-flight input. |
| E26 | `rg -n "admitHistoricalArchive" plugins/delivery-pipeline`; `rg -n "admitHistoricalArchive\|validateHistoricalArchive" tests` | definition `role-artifact.cjs:2050`, export 4021, no other production caller; tests only. |
| E27 | `rg -c "readProvenance" . --glob '!{node_modules,.git,.planning,docs,plugins/shipyard/host}/**'` | `dispatch-record.cjs:2`, `tests/unit/claude-role-host.test.cjs:1`, `tests/unit/dispatch-record.test.cjs:3`. |
| E28 | `Read plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs` 436-465, 955-975, 1095-1115 (28b: `rg -n "historicalBookkeepingPins\|historical_bookkeeping\|bookkeeping_state\|latest_bookkeeping" plugins/delivery-pipeline/scripts`) | current-dispatch sidecar binding; `historicalBookkeepingPins` used as authenticated attestation at 510-512, 631, 775, 983, 1018, 1094. |
| E29 | `Read tests/unit/dispatch-record.test.cjs` 2170-2207; `rg -n "unknown host provenance member\|pre-existing provenance\|legacy.*provenance" tests` | only the non-local-route test exists; no same-worktree legacy test. |
| E30 | `git grep -n -e "phase=" origin/main -- <scripts listed in §2.4>`; `git show origin/main:plugins/delivery-pipeline/scripts/run-contract.cjs \| sed -n '425,445p'`; `Read run-contract.cjs 205-260` | subject formation/parse sites and the positional slice at 430-435. |
| E31 | `git grep -n -e "git-common:" -e "function repositoryIdentity" -e "const repository = " origin/main -- plugins/delivery-pipeline/scripts`; `git grep -n -A 12 -e "function planningRepository" origin/main -- …/deliver-dispatch.cjs` | four repository-identity definitions in §2.4. |
| E32 | `Read plugins/delivery-pipeline/scripts/refusal-hints.cjs`; `rg -c "RUNTIME_CAPABILITY_MISSING\|ARCHIVE_AUTHORITY_INVALID\|RUNTIME_UNAVAILABLE" plugins/delivery-pipeline/scripts` | 16 keys; refusal-hints.cjs matches only `RUNTIME_UNAVAILABLE` (1 hit); no ARCHIVE_* or RUNTIME_CAPABILITY_MISSING key. |
| E33 | `Read scripts/shipyard-doctor.cjs`; `rg -l shipyard-doctor . --glob '!{node_modules,.git,.planning,docs}/**'`; `sed -n '1,60p' scripts/package-shipyard-codex.cjs`; `Glob plugins/shipyard/host/scripts/*` | doctor referenced only by tests, `README.md`, `Makefile:60-61`, `scripts/`; not in the packaged script list; host/scripts has 8 files. |
| E34 | `rg -n "^function \|PREFLIGHT" plugins/delivery-pipeline/scripts/sentinel-preflight.cjs plugins/delivery-pipeline/scripts/phase-integrator-preflight.cjs plugins/delivery-pipeline/scripts/host-verification.cjs` | git/graph/PR-state and plan-command admission functions. |
| E35 | `git show --stat --format='%h %s' d8a70dec 9415c1e7 78cdca26` | #482 = 10 files, #486 = 21 files (+540/−87), `d8a70dec` ≈ 80+ files; every script edit mirrored under `plugins/shipyard/host/…` plus `plugin.json` and `package-build.json`. |
| E36 | `sed -n '1,40p' scripts/check-runtime-digest-trailer.cjs`; `sed -n '1,80p' .github/workflows/test.yml`; `sed -n '1,60p' tests/unit/run.sh`; `Read Makefile` | trailer key `Runtime-Digest-Refresh`, pin file `tests/unit/runtime-file-digests.json`; CI = `make test-fast` scope; `tests/unit` has 152 entries (`ls tests/unit \| wc -l`). |
| E37 | `grep -n "codex-delivery-host" tests/unit/host-state-prose-contract.test.cjs tests/unit/source-contract.test.cjs`; `grep -c "codex-delivery-host.cjs\|claude-investigation-host.cjs\|claude-delivery-host.cjs\|codex-decompose-host.cjs\|claude-decompose-host.cjs" plugins/delivery-pipeline/commands/{investigate,deliver,decompose}.md` | tests pin the host name in command prose; counts 8, 12, 9. |
| E38 | `grep -n "CODEX_HOME\|SHIPYARD_CODEX_CAPABILITIES_FILE" tests/smoke/phase47-runtime-acceptance.cjs`; `Read tests/smoke/phase47-runtime-acceptance.cjs` 644-687 | lines 658-659 (argv is `node <host> --args-file <request>`), 673-680 (environment must carry `CODEX_HOME`, `SHIPYARD_GRAPH_DIR`, `SHIPYARD_CODEX_CAPABILITIES_FILE`). |
| E39 | `Read tests/smoke/codex-shipyard-smoke.sh` 86-155; `Read tests/live/live-round.sh` 120-270; `rg -n "SHIPYARD_CODEX_CAPABILITIES_FILE\|CODEX_HOME" tests/smoke tests/live`; `Read tests/unit/marketplace-installer.test.cjs` 600-625 | bare-install refusal pinned at 145-155; live round calls hosts directly; no env-cleared, legacy-upgrade or UI e2e. |
| E40 | `ls plugins/delivery-pipeline/commands`; `grep -n "skip-ui\|UI-SPEC\|ui-phase\|ui-review" plugins/delivery-pipeline/commands/*.md plugins/delivery-pipeline/references/*.md` | commands: `bench route decompose deliver investigate`; only `decompose.md:386-390` mentions `--skip-ui`. |
| E41 | `git grep -n "SessionStart" d8a70dec -- plugins/delivery-pipeline scripts plugins/shipyard/hooks` (full output read); `ls plugins/delivery-pipeline/hooks`; `Read plugins/delivery-pipeline/scripts/claude-runtime-host.cjs` 722-771 | `SessionStart` hits: Claude agent-start evidence code (`claude-agent-start-hook.cjs`, `claude-runtime-host.cjs:411-620,759-771,843`, `claude-decompose-host.cjs:592`), Codex session-callback names (`codex-runtime-host.cjs`, `onSessionStarted`, unrelated to hooks), and the Codex package hook `plugins/shipyard/hooks/hooks.json:3` / `scripts/package-shipyard-codex.cjs:48`; `ls` reported "No such file or directory" (non-zero exit). |
| E42 | `grep -n "dispatchId = " plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` | line 1813 `archDispatchId \|\| request.dispatch_id \|\| newDispatchId()`. |
| E43 | A first attempt `wc -l docs/audits/…; ls scripts; ls .planning/codebase` was **denied** by the session (computed-path read policy) and not retried; the codebase-map check was redone with E03. No claim in this file depends on the denied call. | — |
| E44 | `Read plugins/delivery-pipeline/scripts/graph-dir.cjs` 1-80; `Grep (SHIPYARD\|GSD)_[A-Z0-9_]{3,}` over twelve scripts with `-o` (shell: `rg -o "(SHIPYARD\|GSD)_[A-Z0-9_]{3,}" <files>`); a second attempt to build the same inventory with a `grep … \| sed -E …` pipeline was **denied** by the session and not retried | `graph-dir.cjs:14-25` resolution order and `SHIPYARD_GRAPH_DIR`; the environment-name inventory in §2.2 (the pattern also matches non-environment identifiers such as `GSD_ROLES`; only names that read as environment inputs are listed, and the unread ones are marked "grep hits"). |

## 11. Limits of this line

- No behaviour was executed: no unit test, smoke test or reproduction was run in this line; test statements come from reading test source. The INV-015 reproduction (`LAUNCH-REFUSAL.md:24-34`) is cited as prior evidence, not re-run.
- The installed `~/.codex/shipyard` and `~/.local/state/shipyard` were not read (read-scope boundary of this task), so "installed build ≈ v0.72.x" is an inference from line numbers.
- Cost figures are calibrated estimates (E35); they are not schedules.
- This file does not rank the options. The user's selection, plus the acceptance, compatibility, rollout and rollback evidence required for it, remain open (OPEN-QUESTIONS items 7 and 8 of the intake list).
