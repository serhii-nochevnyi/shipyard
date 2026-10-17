# INV-017 — research line `constraints`

- Investigation: INV-017-launch-and-upgrade-reliability
- Line: `constraints` (feeds RESEARCH.md "Constraints" and seeds CONSTRAINTS)
- Bound source revision (context packet): `d8a70decb32e5420fb69f8eebc17be08e82d6d86` (= `HEAD` of `/Volumes/KINGSTON/claude-shipyard`, verified [V1])
- Repository: `/Volumes/KINGSTON/claude-shipyard`
- Policy hash (packet, ADR-014 `adr-014.v7`): `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570`; the live module reports the same hash [V13]
- Runtime selection resolved by the caller: `claude-sonnet-5-5` / effort `xhigh` (research base rung). Policy signals (DATA, preserved verbatim): `{}`
- PROBLEM.md sha256 verified against the packet: `eea376aa962b01c1c304f37410a61e331f95a7cc67728080fc4f3548c26c426b` [V2]
- Date of research: 2026-10-15
- Scope fence honoured: read-only on product code; this file is the only file written. No commits, PRs, config changes, installs. `~/.planning/graph/provenance` contents, authority directories and `~/.local/state/shipyard/` were not read or modified (see §0.3).

Notation: `file:line` is at the bound revision `d8a70dec` unless suffixed `@v0.72.2` / `@<sha>`. `[Vn]` points to the verification ledger in §10 (exact command and result). Confidence is **high** (read in source and/or command output), **medium** (inferred from code or from a record I could not re-observe), or **low** (assumption).

---

## 0. Read this first

### 0.1 Five findings that change how the constraints must be read

1. **The bound revision is not the revision the user's failing host ran.** `HEAD` (`d8a70dec`) is **9 commits behind `origin/main`** (`be7ab4f3` = tag `v0.72.2`; `origin/main..HEAD` = 0) [V6]. Two of the nine commits matter here:
   - `9415c1e7` (v0.72.0) changed the in-flight bookkeeping gate in `dispatch-record.cjs` and made the Claude delivery CLI authenticated too [V9].
   - `78cdca26` (v0.72.1) introduced a shared ADR-digest module in `planning-result-sealer.cjs` [V10].
   - `c7633d9e` (v0.72.0, "streamline architecture review and phase delivery") also changed `role-artifact.cjs`; the rejection moves from line 1827 to line 3955 [V7][V8]. I did not read that diff.
   The installed line numbers cited in `INV-015/LAUNCH-REFUSAL.md` (`role-artifact.cjs:3954`, `dispatch-record.cjs:1294`) match the v0.72.x layout (rejection at line 3955 in v0.72.0, .1 and .2) and not `d8a70dec` (line 1827) [V8]. So the installed host is most likely ≥ v0.72.0 (medium confidence: I could not read the installed file, §0.3). Every constraint below therefore states both revisions where they differ.
2. **Deployment-state check (hypothesis #1) — code is present, not absent.** The change that introduced the refusal, `d8a70dec` (PR #421), is on `main` and contained in tags `v0.72.0`, `v0.72.1`, `v0.72.2` [V3][V5]. The parent revision has neither `trustedBookkeepingMutation` nor `historicalBookkeepingPins` [V4]. The refusal persists unchanged at `v0.72.2` (`unknown host provenance member before trusted mutation` at `role-artifact.cjs:3955@v0.72.2`; no legacy-admission function exists) [V11]. This is a real behavioural regression for old history, not an absence-of-code artifact. Whether the user's installed bundle is exactly `v0.72.x` is **unverified** (U-01).
3. **A legacy sidecar refusal is narrower than "every launch" but wider than Codex.** At `d8a70dec` it is triggered only when `input.worktree` resolves to the project that owns the graph dir (`dispatch-record.cjs:1302-1305`). That holds for `codex-delivery-host.cjs:1872` and `claude-role-host.cjs:1350`, but not for `claude-delivery-host.cjs:1133` (no `worktree` in the in-flight record). At `v0.72.0+` the Claude delivery CLI also passes `worktree` [V9], and `inflightBookkeepingRequired` additionally authenticates linked-worktree launches when the provenance directory is missing or empty. The test added by `9415c1e7` still asserts `/unknown host provenance/` for a forged file [V9]. So the "both runtimes' supported paths" success criterion is real, and the Claude path is now exposed to the same refusal at v0.72.x (T-15).
4. **There is no supported way to admit legacy provenance sidecars.** The only legacy-admission API, `admitHistoricalArchive` (`role-artifact.cjs:2050-2077`), requires a retained manifest digest, receipt digest and exactly three archive pins per record (`:1978-1982`). It has no CLI and no non-test caller in `plugins/` [V19]. The error text at `role-artifact.cjs:1061` ("explicit trusted legacy admission is required") names a path that does not exist for sidecars.
5. **The UI-cycle e2e has no entry point in this repository.** A sweep of README, docs, plugins, scripts, tests, capabilities and CLAUDE.md for `ui-phase|UI-SPEC|ui-review|ui_phase|gsd-ui` finds only a captured JSONL fixture line [V19]. The "existing supported UI path" is therefore GSD-owned (external dependency) and undefined here (U-05).

### 0.2 Constraint status summary

| Area | Verdict |
|---|---|
| Provenance/authority authentication, receipts, host-owned writer/lease, no provider fallback, ADR-014 grid | Hard; no design may weaken (§2.1–2.3: T-01…T-24). |
| Automatic discovery of Codex home / capabilities | Allowed only as *locate-and-validate* of installer-written, digest-bound measured evidence; synthesis from policy is forbidden; ADR-025 puts "automatic environment adjudication" out of phase-47 scope, so it needs a new accepted decision (T-16, T-25, PR-02). |
| Legacy-history migration | Must keep records historical/unverified, never rewrite sidecars, keep trust-bearing state in the protected authority namespace, keep refusing *new* unknown members (§2.5: M-01…M-06; T-05, T-11, T-12). |
| Shared digest contract | A shared module already exists for the *sealed* decomposition subject at v0.72.1; the launch subject is still built and parsed separately (§2.6: G-01…G-03). |
| Preflight | Remedies must pass existing hint tests (no bypass words); new refusal codes need a `HINTS` entry; `make doctor` is checkout-only and not packaged (§2.7: P-01…P-05; T-19). |
| Delivery | CI = `make test-fast` on Linux/Node 24.15.0; package must be regenerated on main-bound PRs; release needs live receipts on both runtimes (§2.9: D-01…D-05). |

### 0.3 Limits of this research (what I could not check, and why)

- The sandbox denied every read of `$HOME` paths. One probe, `ls ~/.codex/shipyard ~/.local/state/shipyard`, was denied and, per the denial text, **not retried** [V21]. Consequently the installed Codex bundle, the installed manifests, `codex-capabilities.json`, the authority directory and the archived legacy backup (`~/.local/state/shipyard/legacy-bookkeeping-backups/claude-shipyard-20261015T144954Z`) were **not inspected**. Facts about them come from `LAUNCH-REFUSAL.md` and are labelled "recorded, not re-observed".
- Several Bash calls were denied by the tool-permission layer ("names a path that is computed at run time" / "multiple operations") [V21]. Where that happened I used the dedicated Grep/Read tools with the same patterns. The ledger names the tool and pattern in each case.
- `origin/main` is the local remote-tracking ref as of the last fetch (no network used). It may be ahead of what I saw.
- No throwaway reproduction was run (research contract). Behavioural claims at `v0.72.2` rest on diffs and committed tests; the spike to confirm them is S-1 (§8).
- The harness created empty `.claude/.cc-writes/` directories under several checkout directories (e.g. `plugins/delivery-pipeline/scripts/.claude`, `tests/.claude`, `plugins/.claude`, this investigation directory) when the shell cwd changed [V16b]. They are empty, untracked, and ignored by the package-freshness test (its `snapshot()` drops empty directories, `tests/unit/marketplace-install.test.cjs:63-69`). I did not delete them (outside the "write only the artifact" fence); `rmdir` them if unwanted.

---

## 1. Resolution-site matrix (what the constraints must stay compatible with)

### 1.1 Codex home and capabilities

| Site | Codex home rule | Capabilities rule | Notes |
|---|---|---|---|
| `scripts/install-shipyard-codex.sh:34-37` | empty `CODEX_HOME` refused (exit 3); else `$HOME/.codex` | `SHIPYARD_CODEX_CAPABILITIES_FILE` **required** (`:125-138`), exit 2 if absent/unreadable | bundle root = `$CODEX_HOME/shipyard` (`:37`) |
| `scripts/bootstrap-shipyard-plugin.cjs:65,104-114` | `CODEX_HOME` (must be absolute, `:15-16`) else `os.homedir()/.codex` | env var if set; **else probes `codex debug models`** and writes `<home>/shipyard-plugin/capabilities.json`, then passes it to the installer as the env var | accepted *measured-evidence* auto-source |
| `scripts/install-shipyard-marketplace.cjs:78-109` | explicit `CODEX_HOME` must be absolute; dogfood → dedicated `~/.local/state/shipyard/dogfood/codex/<sha256(source)[:16]>`, refuses shared default (`:89-93`) | n/a | prints `export CODEX_HOME=…` (`:98`) |
| `scripts/ensure-gsd-core.sh:352` | `${CODEX_HOME:-$HOME/.codex}` | n/a | isolation machinery `:38-117,309-317` |
| `codex-delivery-host.cjs:705-711` | `(options.env‖process.env).CODEX_HOME` else `os.homedir()/.codex` (agents dir) | `options.capabilitiesFile ‖ env.SHIPYARD_CODEX_CAPABILITIES_FILE`; **no `CODEX_HOME` default** | passes `options.env` through (`:1400`) |
| `codex-runtime-host.cjs:160-171` | – | `options.capabilitiesFile ‖ **process.env**.SHIPYARD_CODEX_CAPABILITIES_FILE ‖ (process.env.CODEX_HOME && <CODEX_HOME>/shipyard/codex-capabilities.json)`; else `RUNTIME_CAPABILITY_MISSING "explicit Codex capability evidence is required"` | reads `process.env`, **ignores `options.env`**; no `~/.codex` default |
| `codex-runtime-host.cjs:395,441,729,882` | `env.CODEX_HOME ‖ process.env.CODEX_HOME ‖ os.homedir()/.codex` (sessions, GSD agents) | – | |
| `codex-decompose-host.cjs:518` | `options.env.CODEX_HOME ‖ os.homedir()/.codex` | via host | |
| `codex-agent.cjs:69-72,93-95` | `env.CODEX_HOME ‖ os.homedir()/.codex` (agents) | `--capabilities-file` flag only; no env, no default | |
| `dispatch-record.cjs:450-455` | `SHIPYARD_CODEX_AGENT_DIR ‖ CODEX_HOME/agents ‖ os.homedir()/.codex/agents` | none | extra env var used nowhere else |
| `gsd-tune.cjs:283-285,784` | `process.env.CODEX_HOME ‖ (process.env.HOME‖'')/.codex` | `--capabilities`/`--capabilities-file` ‖ env var; no default | |
| `runtime-context.cjs:100-116` | `CODEX_HOME` existence + `config.toml` ⇒ `installedRuntime` (weak) | – | compatibility-only for routed dispatches (`:193-233`) |
| `session-observer.cjs:295` | `CODEX_HOME ‖ os.homedir()/.codex` | – | |
| `codex-notify.cjs:26` | `CODEX_HOME ‖ bundle-relative ../..` | – | only site with an install-relative fallback |
| `scripts/shipyard-doctor.cjs:217-218` | `--codex-home` flag else `os.homedir()/.codex`; **env ignored** | does not read `codex-capabilities.json` | |

### 1.2 Claude home

| Site | Precedence |
|---|---|
| `scripts/install-shipyard-claude-hook.sh:28` | `CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude` |
| `scripts/install-shipyard-capability.sh:29,34`; `ensure-gsd-core.sh:353`; `install-shipyard-marketplace.cjs:177` | `CLAUDE_CONFIG_DIR` → `CLAUDE_HOME` → `~/.claude` |
| `claude-runtime-host.cjs:363,371`; `claude-decompose-host.cjs:353,692` | `CLAUDE_CONFIG_DIR` → `~/.claude` (**`CLAUDE_HOME` ignored**) |
| `shipyard-doctor.cjs:217` | `--claude-home` flag else `~/.claude`; env ignored |
| `ensure-gsd-core.sh:104-107` (isolation) | sets both; **refuses** if both set and different ("conflicting Claude homes") |

Claude has no capabilities file; capability evidence is a live probe of the `claude` CLI (probe code around `claude-runtime-host.cjs:190-235`; `tests/smoke/claude-runtime-smoke.sh --capability-only`).

### 1.3 "Home" itself has three spellings

`os.homedir()` (honours `HOME`; used by the authority namespace `role-artifact.cjs:985`, state roots `codex-delivery-host.cjs:293`, `deliver-dispatch.cjs:224`), `process.env.HOME || ''` (`gsd-tune.cjs:322,784`) and `os.userInfo().homedir` (passwd entry; planning-writer lease root `planning-writer-lease.cjs:86`, plus legacy-root scan over all three `:92`). Under isolation `HOME` is rebased to `<root>/.shipyard-home` (`ensure-gsd-core.sh:85`), so `os.homedir()`-keyed state (authority) moves with it while the passwd-keyed writer lease does not. (Confidence high; read in source.)

### 1.4 Other environment inputs the hosts consume

`SHIPYARD_RUNTIME`, `GSD_RUNTIME`, `SHIPYARD_GSD_TOOLS`/`GSD_TOOLS`, `GSD_CORE_HOME` (`runtime-context.cjs:124-128,197-215`); `SHIPYARD_GRAPH_DIR` (`codex-delivery-host.cjs:131,166-167,1797`; `deliver-dispatch.cjs:562-563`); `SHIPYARD_ISOLATION_ROOT`, `SHIPYARD_DOGFOOD_ROOT`, `SHIPYARD_INSTALL_KIND`, `SHIPYARD_SOURCE_*`, `XDG_STATE_HOME`, `GSD_DEFAULTS_PATH`, `GSD_CAPABILITIES_DIR`, `AGENTS_SKILLS_DIR`, `CODEX_AGENTS_MD`, `GSD_HOME` (installers/isolation). Workflow prose (`plugins/delivery-pipeline/commands/*.md`, `references/*.md`) never mentions `SHIPYARD_CODEX_CAPABILITIES_FILE` or `CODEX_HOME` [V19], so the variable is purely implicit for an agent that follows the commands.

---

## 2. Constraint register

Format: **ID — constraint.** Source. Confidence. *Implication for a design.* (Design choice is the user's; implications only state what must remain true.)

### 2.1 Trust, authentication and receipts — must not weaken

**T-01 — The authority namespace is keyed by the worktree's realpath under `os.homedir()` and must be a private, symlink-free tree.** `<os.homedir()>/.local/state/shipyard/role-artifact-authority/<sha256(realpath(worktree))>`; each ancestor a non-symlink directory with `realpath===path`; the namespace and per-worktree directory must have no group/other mode bits. Source: `role-artifact.cjs:984-1009`, `authorityState` `:1037-1065`. Confidence high. *A moved/renamed worktree, a changed `HOME`, or an isolated `HOME` yields a different, empty namespace — equivalent to "no catalogue". A refused launch still creates the namespace and `hmac.key` as a side effect (`trustedBookkeepingMutation` calls `authorityState(worktree, true)` at `:1815` before the inventory check at `:1826`), matching the INV-015 observation that the authority directory was created by the refused launch (recorded, not re-observed).*

**T-02 — The catalogue is an HMAC-authenticated envelope; the key is private and irreplaceable.** 32 random bytes in `hmac.key` created with `wx`/0600 and read with `O_NOFOLLOW` + stat identity checks; "existing protected records require their original authority key"; envelope `{payload, mac}` with HMAC-SHA256 over stable JSON, `timingSafeEqual`; payload must carry schema `shipyard.role-archive-catalogue.v1`, matching `worktree` and an object `records`. Source: `role-artifact.cjs:1011-1065`. Confidence high. *Any migration must write through the same keyed writer (`writeArchiveCatalogue` `:1794-1807`); there is no unauthenticated path and none may be added.*

**T-03 — Pins are exact bytes, bounded, and race-checked.** `readPinnedArchiveFile` requires `{path, bytes ≤ 4 MiB, sha256}`, a regular non-symlink file, size equality and identical dev/ino/size/mtime/ctime before, during and after the read. The serialized catalogue must stay ≤ `HISTORICAL_ARCHIVE_MAX_BYTES` = 4 MiB (`:951,1794-1799`); archive inventory ≤ 3000 paths (`:1343`); batch admission ≤ 1000 records (`:2054`). Confidence high. *A scheme that records N legacy sidecars in the catalogue must fit these bounds (64 sidecars at roughly 150–200 B per pin ≈ 10–13 KB — an estimate, low confidence).*

**T-04 — `trustedBookkeepingMutation` is the single writer contract for `dispatches.json` and `provenance/*.json`.** Allowed written paths only `.planning/graph/dispatches.json` and `.planning/graph/provenance/[A-Za-z0-9_.-]+.json` (`:1810-1813`); unknown physical members refused before the callback (`:1826-1827`) and after (`:1855-1856`); changed pinned bytes refused (`:1840-1841,1850-1853`); runs under `withArchiveAuthorityLock` (live-owner lock, `waitMs:1000`, `ARCHIVE_AUTHORITY_BUSY`; `:1874-1908`). Committed tests pin each behaviour: `tests/unit/role-artifact.test.cjs:987-1016` (updates stay mutable; changed bytes and unknown members refused with `/unknown host provenance/`), `:1050-1077` (lock timeout never invokes the writer). Confidence high. *New entries must be tamper-evident from the moment of admission; unknown members added **after** a migration must still refuse.*

**T-05 — The refusal of a forged unknown member is regression-pinned at v0.72.x.** `9415c1e7` added a test asserting `recordInflight` throws `/unknown host provenance/` for a forged `unknown.json` while leaving `dispatches.json` and the forged file untouched [V9]. Confidence high. *Any change that lets "legacy" files pass must be distinguishable from a forged file added later — by authenticated, pre-launch inventory, not by filename or location.*

**T-06 — The existing admission API does not apply to sidecars.** `validateHistoricalArchive/admitHistoricalArchive` (`:1978-2077`) require independently retained manifest + receipt digests, exactly three archive pins, git object identities (`gitObjectIdentity`) and a runtime receipt (`:1981-1989,2017-2030`). Sidecars have none of those. The function is exported (`:4021`) but `Grep` finds no caller outside `role-artifact.cjs` and tests [V19]; the `role-artifact.cjs` CLI offers only `prepare|seal|validate|read` (`:3900-3984`). Confidence high. *A legacy-sidecar scheme needs a new, explicitly designed admission; reusing this API as-is is not possible.*

**T-07 — Receipts and the dispatch boundary are mandatory and must not be synthesized.** ADR-014 mandatory boundary "resolve → validate → launch → receipt"; unknown/ambiguous runtimes, stale generated variants, inline/session-inherited selection and missing receipts hard-refuse (`CLAUDE.md:94`). `rejectSerializedAuthority` (`run-contract.cjs:213,263`); containment baselines cannot be supplied as serialized caller authority (`docs/audits/2026-10-03-phase47-launch-fix.md:16`). Confidence high. *A launcher/preflight may prepare environment and refuse early; it must not mint, accept or substitute receipts or serialized authority.*

**T-08 — The native child is launched with an isolating command line and a scrubbed environment; no provider fallback.** Codex: `--ignore-user-config`, `model_provider="openai"`, `forced_login_method="chatgpt"`, explicit model and effort, permission profile with protected paths; env deletes `CODEX_MODEL*`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `OPENAI_API_KEY`, `CODEX_API_KEY`, any `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `GNUPGHOME`, `GPG_*`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`; the host copies `{...process.env, ...environment}` first (`codex-runtime-host.cjs:1215-1238`). Denied paths include the state root, `~/.gnupg`, `~/.ssh` (`codex-delivery-host.cjs:504-505`). Claude: explicit credential-env list (`claude-runtime-host.cjs:35-45`). Out-of-scope statements: "Automatic cross-provider fallback…" (`ADR-024-model-ladder-refresh.md:73`), "provider fallback, automatic environment adjudication, signing relaxation" (`ADR-025…:35`). Confidence high. *`CODEX_HOME` and `SHIPYARD_*` are not scrubbed, so "pass the validated environment to every child" is compatible — provided nothing credential-bearing is added and the scrub list is not shrunk.*

**T-09 — Runtime identity for routed dispatches comes from explicit active evidence only.** `resolveDispatchContext` accepts option/`SHIPYARD_RUNTIME`/`GSD_RUNTIME`/markers/bundle path/session env; `CODEX_HOME`, project config and defaults are "compatibility-only"; two disagreeing signals → `AMBIGUOUS_RUNTIME`; none → `AMBIGUOUS_RUNTIME` (`runtime-context.cjs:193-233`). Test `tests/unit/runtime-context.test.cjs` "project, installed-home and default runtime values remain compatibility-only" passes (16/16) [V12]. **Empirically** the `bundle-path` signal works for a global install path (`…/.codex/shipyard/scripts/x.cjs` → `codex`, source `bundle-path`) but **not** for a dogfood install path (`…/.local/state/shipyard/dogfood/codex/<digest>/shipyard/scripts/x.cjs` → `AMBIGUOUS_RUNTIME`) [V13]. Confidence high. *A launcher must supply runtime evidence explicitly for dogfood installs; "the Codex home exists" is not evidence.*

**T-10 — Host-owned planning writer and lease.** Typed GSD roles acquire the lease before launch (`codex-delivery-host.cjs:1823-1834`); the host verifies the writer snapshot and lease binding or fails `WRITER_FENCED` (`:1407-1422`); lease root is the passwd home `…/planning-writers/shared` (`planning-writer-lease.cjs:85-88`); legacy private writer roots under every home are scanned and any non-`released` or malformed record refuses with `LEGACY_WRITER_STATE` (`:120-146`); TTLs: run lease 30 min (`run-controller.cjs:10`, `planning-writer-lease.cjs:11`), in-flight 90 min default (`dispatch-record.cjs:112`). Confidence high. *`LEGACY_WRITER_STATE` is a second legacy-state class that can block a new launch and has no hint (§2.8). A migration/launcher must not take, steal or reset a lease.*

**T-11 — Trust-bearing state must live outside the worktree and outside the native child's write set.** State root is forced outside the worktree (`stateRootOutsideWorktree`, `codex-delivery-host.cjs:291-300`); the child is denied the state root and `roleArtifact.archiveAuthorityDirectory(worktree)` (`:1404`). Confidence high. *A "historical/unverified" marker stored in `.planning/` (child-writable, git-visible) cannot be trusted; trust-bearing markers belong in the protected authority namespace. In-worktree annotations are advisory at most.*

**T-12 — Provenance sidecar shape and history are frozen.** `// @contract: Install provenance is a sidecar file, never a receipt field; its shape is frozen for both runtimes` (`host-provenance.cjs:4`, schema `shipyard.host-provenance.v1`); the per-dispatch sidecar is stamp + `{dispatch_id, ticket, role, recorded_at}`, written once and never overwritten (`// @invariant` `dispatch-record.cjs:1563-1582`). Historical receipt/control bytes are preserved and not rewritten (`ADR-024-model-ladder-refresh.md:26,73`). Confidence high. *Migration must leave legacy sidecars byte-identical; the "legacy/unverified" classification must live outside them.*

**T-13 — `dispatches.json` is git-tracked and byte-pinned after the first authenticated mutation; `provenance/` is local-only.** `git ls-files .planning/graph` lists `dispatches.json`; `git ls-files .planning/graph/provenance` is empty and `.git/info/exclude:10` excludes the directory [V16]. After a trusted mutation the exact bytes are pinned; `role-artifact.test.cjs:1006-1011` shows a non-host edit makes the next mutation refuse without invoking the callback. Confidence high. *Git operations that rewrite `dispatches.json` (checkout, merge, rebase, manual edit) after pinning, and per-clone/per-worktree divergence of the untracked sidecar set, are both inherent to the model; a migration cannot rely on git to carry its state.*

**T-14 — Launch attestation binds pins and capabilities; changes must precede admission.** `launchDigest` includes `bookkeeping`, `historical_archives`, `historical_bookkeeping` (`codex-arch-review-context.cjs:976-985`); `capabilities_sha256 = digest(JSON.stringify(options.capabilities))` (`:929,949`). Confidence high. *Discovery/migration must finish before prepare/admission, and discovery must hand the host the same parsed object it validated (no re-serialization differences).*

**T-15 — Which launches take the authenticated bookkeeping route.**
- `d8a70dec`: `authenticateBookkeeping(cwd, fn, writtenPaths, required)` (`dispatch-record.cjs:1294-1300`) calls `trustedBookkeepingMutation` when `required`, **or** when `<worktree>/.shipyard-role-artifacts` exists, **or** when historical pins already exist; `required` = `localInflightBookkeeping` = `input.worktree` realpath equals the graph's project (`:1302-1305,1551-1552,1606`). Callers carrying `worktree`: `codex-delivery-host.cjs:1872`, `claude-role-host.cjs:1350`; not `claude-delivery-host.cjs:1133`.
- `v0.72.0+` (`9415c1e7`): `inflightBookkeepingRequired` — project-root worktree ⇒ required; a *linked* worktree ⇒ required only when `.planning/graph/provenance` is missing or empty ("first-run"); `claude-delivery-host.cjs` now passes `worktree` [V9].
- Order inside a Codex launch: `controller.begin(run)` (`codex-delivery-host.cjs:1859`) → `recordInflight` (`:1878`, **bookkeeping refusal here**) → `createCodexDeliveryHost` → runtime probe (`:1881…`, **capability refusal here**). A failure after `begin` is recorded as a failed run (`finishDeliveryRun`, `:1931-1935`), so each refusal leaves controller state.
Confidence high (source + diff). *A preflight must reproduce this order or check both conditions before any state is created; otherwise fixing the first refusal just surfaces the second (exactly what INV-015 observed).*

**T-16 — Capability evidence rules (what discovery may and may not do).**
- The installer refuses a bare install, non-mutating, with "explicit Codex host capability evidence is required" (`install-shipyard-codex.sh:125-128`; pinned by `tests/smoke/codex-shipyard-smoke.sh:145-155`, incl. `diff -ruN` before/after). `model-ladder-runtime-smoke.sh:125-130` pins refusal for an incapable file, non-mutating.
- "Never synthesize capabilities from ADR-014" (`install-shipyard-codex.sh:315-318`; `ADR-024-ROLLOUT.md:135`: "Do not synthesize capabilities from ADR-024").
- The installed bundle must carry a **byte-identical** copy as `<bundle>/codex-capabilities.json`, with `capabilities_file` and `capabilities_digest` in the manifest (`gen-codex-shipyard.cjs:352-355,366-367`; `gsd-tune.cjs:200-215`; smoke `:140-143`). The manifest is installed as `$CODEX_HOME/agents/.shipyard-manifest.json` (`install-shipyard-codex.sh:356,377,507`; `bootstrap-shipyard-plugin.cjs:83`).
- Measured evidence from the real CLI is already accepted at the marketplace bootstrap (`codex debug models`: `gen-codex-shipyard.cjs:38-68`, `bootstrap-shipyard-plugin.cjs:104-111`; README.md:105-109).
- The runtime host needs explicit evidence and refuses pre-launch without it: `codex-runtime-host.cjs:160-171`; `tests/unit/codex-runtime-host.test.cjs:494-513`; `tests/unit/phase47-launch-contract.test.cjs:175-181` (missing evidence ⇒ `RUNTIME_UNAVAILABLE`, zero native launches).
- At launch `readCapabilities` validates **shape only** (non-empty `supportedModels`/`supportedEfforts` arrays, optional array `supportedSelections`; `codex-runtime-host.cjs:142-158`); it does not compare the file with `capabilities_digest` in the manifest (read of the function; no such call).
- `README.md:108-109` says `CODEX_HOME` and `AGENTS_SKILLS_DIR` "remain supported" and `SHIPYARD_CODEX_CAPABILITIES_FILE` "can supply explicit host evidence" (marketplace flow), whereas `README.md:163` says the Codex dogfood install "still needs" the variable (direct installer).
Confidence high. *Locating `<CODEX_HOME or ~/.codex>/shipyard/codex-capabilities.json` is consistent with the installer layout (README.md:98-100); trusting any file found without checking it against the installer-owned manifest digest would be weaker than the installer's own contract. If the file is absent, stale or mismatched the refusal must stay; the bare-install refusal and "no synthesis" rules apply to the installer and must be changed (or explicitly left alone) by decision, not by side effect.*

### 2.2 ADR-014 boundary (model/effort/provider policy)

**T-17 — The v7 grid and fingerprint are fixed.** Codex Sol `gpt-6.1-sol`, Luna `gpt-6-luna`; Claude Sonnet `claude-sonnet-5-5`, Opus `claude-opus-5-5`, Fable measured-window-only; "do not use a compatibility palette, generic GSD tier default, or per-role override as launch authority" (`CLAUDE.md:88-106`). Policy id `adr-014.v7`, hash `3978b087…` (live module, [V13]); the packaged copy asserts the same version/hash (`marketplace-install.test.cjs:74-87`). Confidence high. *A launcher/preflight carries no model or effort and cannot alias grids. The packet's `window_threshold_tokens` (250000) and role/rung tables are policy, not launcher input.*

### 2.3 Installer and generated package

**T-18 — Generated files are never edited by hand; regenerate from the canonical plugin.** `CLAUDE.md:76-81` (Codex artifacts generated; `plugins/shipyard/host/` never edited; regeneration on the epic before epic→`main`). Generation: `scripts/package-shipyard-codex.cjs` (copies `plugins/delivery-pipeline` + `capabilities/delivery-pipeline` into `plugins/shipyard/host`, renders skills and `hooks/hooks.json`, content-addressed `package-build.json`). Freshness is asserted in `tests/unit/marketplace-install.test.cjs:70-103` and is required unless the base ref starts with `epic/` or `ticket/` (`package-shipyard-codex.cjs:71-74`). Current state: six sampled scripts are byte-identical between `plugins/delivery-pipeline/scripts` and `plugins/shipyard/host/…`; a fresh build into `$TMPDIR` differs only by the harness `.claude` directory [V15]. Confidence high.

**T-19 — What ships where is an allowlist.** Root scripts packaged into `host/scripts/`: `bootstrap-shipyard-plugin.cjs`, `ensure-gsd-plugin.cjs`, `ensure-gsd-core.sh`, `install-shipyard-codex.sh`, `install-shipyard-capability.sh`, `gen-codex-shipyard.cjs`, `merge-codex-config.cjs`, `configure-codex-notify.cjs` (`package-shipyard-codex.cjs:9-10`). `scripts/shipyard-doctor.cjs` is **not** in the list (the packaged `host/scripts` has eight files [V14b]) — **`make doctor` is a checkout-only tool**. Everything under `plugins/delivery-pipeline/scripts/` is packaged automatically (`:20-23`), copied into the bundle (`gen-codex-shipyard.cjs:340-343`) and digest-bound (`manifest.bundle_digests`, `:379-380`); the Claude capability installer also stages every `scripts/*.cjs` into the gate (`install-shipyard-capability.sh:88-92`). Confidence high. *A preflight that must work from an installed package without the repo must live under `plugins/delivery-pipeline/scripts/` (or be added to the allowlist); `refusal-hints.cjs` is already shared there.*

**T-20 — The installed bundle is replaced wholesale on every install; ownership is manifest-bound.** `replace_dir "$OUT/bundle" "$BUNDLE_ROOT"` — "REPLACED, not merged" (`install-shipyard-codex.sh:776-789`); agent files reconcile against the previous manifest (`:342-356`; ADR-007 D5, `ADR-007…:193-196`). Other installer-owned locations: `$CODEX_HOME/shipyard-plugin/{installed.json,install.lock,previous-skills-*}` (`bootstrap-shipyard-plugin.cjs:71-76,128,140`), `shipyard-native-skills`, `shipyard-notify-delegate.json`, `agents/.shipyard-manifest.json`. Confidence high. *Files placed by hand inside `$CODEX_HOME/shipyard/` do not survive an upgrade; durable launcher state needs a location the installer owns or leaves alone.*

**T-21 — Installer rollback covers installer-owned files only; it does not cover `~/.local/state/shipyard`.** Snapshot/restore for agents, skills, bundle, config and capability while `ROLLBACK_ACTIVE=1` (`install-shipyard-codex.sh:165-255,296-307,801`); marketplace add/upgrade rollback (`install-shipyard-marketplace.cjs:134-159,201-219`); bootstrap early-returns when build digest, GSD version, native skills and all manifest digests match (`bootstrap-shipyard-plugin.cjs:97-101`). Confidence high. *Anything a migration writes to the authority namespace or run stores is outside installer rollback; its rollback story must be designed separately (U-10).*

**T-22 — Codex setup is spread across four triggers, one of which is "the agent runs a command".** (a) one-command marketplace installer; (b) `SessionStart` hook `bash "${PLUGIN_ROOT}/host/scripts/ensure-gsd-core.sh" --launch-bootstrap`, timeout 360 s, **requires the user to trust the hook** (`plugins/shipyard/hooks/hooks.json`; `README.md:90-96`); (c) the first line of every generated skill instructs the agent to run `--launch-bootstrap` and "on any failure stop and report" (`package-shipyard-codex.cjs:36-46`) — a duty left to the invoking agent; (d) the direct installer, which README says not to combine with the marketplace flow (`README.md:122-123`). Confidence high. *The hook cannot be the only mechanism (trust-gated); the skill text lives in the generator and must be changed there, then regenerated.*

**T-23 — Claude supported paths: released tag or explicit dogfood root.** `refuseUnreleasedClaudeSource` refuses a dirty/untagged local Claude marketplace source (`install-shipyard-marketplace.cjs:111-119`); unreleased Claude code runs via `install-shipyard-claude-hook.sh --dogfood-root`. Hooks are copied bundles (`install-shipyard-claude-hook.sh:217-295`; `README.md:55-62`). Confidence high.

**T-24 — Isolation envelope rules bind any new child launcher/e2e fixture.** `ensure-gsd-core.sh --isolation-env` is read-only, refuses aliases and active-state overlap (`.codex`, `.claude`, `.gsd`, `.agents`, `.local/state/shipyard…`), rebases `HOME`, supplies private npm/XDG/tmp, and honours `NODE_OPTIONS` only for `--no-warnings|--trace-warnings` (`ensure-gsd-core.sh:28-117`; `ADR-024-ROLLOUT.md:47-64`). Explicit destinations outside the envelope refuse. Confidence high. *An installed-package e2e that wants the real installer must live inside this envelope; the authority namespace then lands in the rebased `HOME` (T-01).*

### 2.4 Environment-resolution compatibility

**T-25 — An explicit value always wins; dogfood and release homes are separate; the shared default is protected.** `README.md:152-161`; `install-shipyard-marketplace.cjs:78-109`; `tests/unit/marketplace-installer.test.cjs:188-229` (dogfood with `CODEX_HOME` unset ⇒ dedicated per-checkout home; two checkouts ⇒ two homes; dogfood aimed at the shared default ⇒ refusal; explicit non-default wins; tagged release not redirected). The dogfood home is `…/dogfood/codex/<sha256(realpath(source))[:16]>`: for this checkout `dd87ca208f1943ba`; the digest named in `docs/audits/2026-10-03-phase47-launch-fix.md:9` (`6cba328f5f0de395`) belongs to the `phase47-investigation` worktree [V18]. Confidence high. *Discovery must pick among N homes deterministically (explicit setting, then the install the executing scripts belong to) and must never fall from a dogfood home to `~/.codex` or vice-versa silently.*

**T-26 — Validation rules differ per site and must be reconciled, not tightened silently.** Installer: empty `CODEX_HOME` refused; bootstrap/marketplace: must be absolute; runtime host: `env.CODEX_HOME || process.env.CODEX_HOME` so an empty string falls through to the default, a relative value is resolved against cwd (`path.resolve`). Confidence high. *Behaviour for empty/relative values is currently a per-site accident.*

### 2.5 Legacy-history and migration constraints

**M-01 — Required semantics (user, PROBLEM.md §Success 2).** Old dispatch/launch records stay historical and unverified, are never trusted, never block a new launch; deleting history is not a procedure; no silent trust of legacy files; no bypass of provenance, receipts or host admission. Confidence high (stated requirement).

**M-02 — The repository already has an idiom for "readable, not authority".** `dispatch-record.cjs:519-520` ("legacy flags … remain readable historical telemetry. They cannot populate applied_* or mint an application_receipt"), `:856-863` ("Receiptless records … remain readable compatibility telemetry … a new route cannot be written until the boundary has authenticated the launch"), `:1400-1403,1424-1427` (fail toward offering the work; an upgrade mid-flight does not hide a ticket nor re-read an old record under a rule it was not written under). Confidence high. *The requested behaviour is consistent with existing conventions; it is the *new* authenticated route that broke them.*

**M-03 — Catalogue schema precedent for upgrade-compatible shapes.** `historicalBookkeepingPins` accepts both the current `bookkeeping_state` array and the older `records[].bookkeeping` + `latest_bookkeeping` shape (`role-artifact.cjs:1777-1792`; `trustedBookkeepingMutation` handles a `legacy` flag `:1829-1843`). `authorityState` checks only schema, `worktree` and `records` (`:1062`). Confidence medium (no test of a foreign field). *An additional MAC-covered payload field is likely tolerated by an older reader (it would ignore it and refuse legacy sidecars again — no worse than today). Unverified: U-10.*

**M-04 — Other legacy-state classes that can block a new launch.**
- `.shipyard-role-artifacts/` present but no catalogue ⇒ every authenticated mutation sees empty pins (`dispatch-record.cjs:1297-1298`); `authenticatedArchivePins` without a catalogue and with inventory ⇒ `ARCHIVE_AUTHORITY_REQUIRED` (`role-artifact.cjs:1351,1061`); admission needs independent manifest/receipt pins (T-06).
- Legacy private writer leases ⇒ `LEGACY_WRITER_STATE` (T-10).
- Legacy sealed decomposition subjects (pre-v0.72.1 `phase=N;repository=R`) vs the new `adr=` grammar (G-02).
Confidence high (read). *"Old history never blocks" has at least four independent state classes to cover, not only sidecars.*

**M-05 — Concurrency.** The catalogue lock waits 1 s then fails `ARCHIVE_AUTHORITY_BUSY` (`:1892-1894`; `role-artifact.test.cjs:1050-1077`); two sessions starting in one worktree race on it. Per-worktree authority means concurrent sessions in *different* worktrees do not interact. Confidence high. *A migration must be idempotent, run under the same lock, and be safe to re-run after a crash.*

**M-06 — User state already modified outside the repo (recorded, not re-observed).** The user archived 64 sidecars to `~/.local/state/shipyard/legacy-bookkeeping-backups/claude-shipyard-20261015T144954Z`, verified SHA-256 against a manifest, then removed them; "not a source-code fix" (`LAUNCH-REFUSAL.md:42`). At research time `.planning/graph/provenance` holds **2 entries** (count only, contents not read) [V16] — presumably sidecars from the post-cleanup launch attempts (inference, not checked). *Acceptance for upgrade-with-history cannot assume the original 64-file state still exists locally; a fixture must be synthesized.*

### 2.6 Producer/consumer contract sharing (phase + repository + ADR digest)

**G-01 — Subject grammars at the bound revision are copies, not one implementation.**
| Subject | Producer | Consumer(s) | Shared symbol? |
|---|---|---|---|
| decomposition launch: `phase=N;input=<INV\|ADR-id>;repository=R` | `deliver-dispatch.cjs:986` (template literal) | inline regex `run-contract.cjs:233`; `dispatch-record.cjs:1501-1506` via `normalizeTicketIdentity` | no |
| sealed decomposition/research: `phase=N;repository=R` | `codex-decompose-host.cjs:140`; `claude-decompose-host.cjs:175` | `planning-result-sealer.cjs:243` (opaque non-empty string) | no |
| integrator/pr-sentinel: `phase=<NN-name>;repository=R;tickets=<sha256>` | `claude-role-host.cjs:612`; `role-artifact.cjs:2794` | `run-contract.cjs:228` (`repository=[^;\s]+`); `dispatch-record.cjs:1508-1509` (`repository=\/[^;\x00-\x1f]+`) — different strictness | no |
| arch-review aggregate (adds `pr`, `head`, `base`) | `architecture-target.cjs:57-58` | `PHASE_SUBJECT` regex (`:8`) imported by five modules (`codex-arch-review-context`, `dispatch-boundary`, `run-contract`, `dispatch-record`, `role-artifact`) | **yes** (the only exported shared pattern) |
Confidence high.

**G-02 — At `v0.72.1` (`78cdca26`, after the bound revision) a shared ADR-digest module exists for the *sealed* subject.** `planning-result-sealer.cjs` exports `decompositionAdr = { ADR_DIRECTORY, SUBJECT_PATTERN, resolveAdr, assertAdrUnchanged, decompositionSubject, assertDecompositionSubject }` with `SUBJECT_PATTERN = /^phase=(\d+);repository=([^;]+);adr=([a-f0-9]{64})$/`; both decompose hosts call it (`codex-decompose-host.cjs:15,77,165@v0.72.2`; `claude-decompose-host.cjs:22,134,182@v0.72.2`) and `sealDecomposition` refuses a subject without `adr=`, a wrong digest or an ADR edited after launch (`adrBinding: 'required'|'none'`) [V10]. **Not** shared: the launch subject is still built at `deliver-dispatch.cjs:1019@v0.72.2` and parsed by the unchanged regex `run-contract.cjs:233`. The new refusal codes `ADR_REQUIRED`, `ADR_PATH_INVALID`, `ADR_UNAVAILABLE`, `ADR_CHANGED`, `ADR_DIGEST_MISMATCH`, `DECOMPOSITION_SUBJECT_INVALID` have no `HINTS` entry (16-key map at v0.72.2 [V11]). Confidence high. *PROBLEM.md success item 3 must be re-scoped against v0.72.2: part of it is delivered; the open part is the launch-subject producer/consumer and the integrator subject copies. I found no incident record naming the original ADR-digest mismatch (a Grep of `docs/` for ADR-digest/mismatch language finds only planning prose), so its exact location is unconfirmed (U-09).*

**G-03 — Constraints on any shared implementation.** The ADR digest is `sha256` of the bytes of exactly one accepted ADR file directly under `.planning/architecture/`, regular, non-symlink, ≤ 1 MiB, re-read and unchanged at seal time (`resolveAdr/assertAdrUnchanged`). Unmodified, already-sealed historical artifacts must remain verifiable (`verifySealedLine`, `planning-result-sealer.cjs:176-178` for research lines); whether pre-v0.72.1 sealed decompositions still verify is unknown (U-09). A shared module must be loadable by both runtimes' hosts from the packaged tree and must not weaken the `run-contract.cjs` identity normalization (T-07). Confidence medium (G-03 last sentence), high otherwise.

### 2.7 Preflight and diagnostics

**P-01 — Current preflight surface, by what it actually checks.**
| Surface | Checks | Env/home/capabilities/provenance? | Ships in the installed package? |
|---|---|---|---|
| `make doctor` → `scripts/shipyard-doctor.cjs` | Claude hook bundle, Codex bundle `manifest.json` version, agent manifest file presence, release-cache provenance | **No** capabilities file, no authority/sidecar state, no active runtime; homes only via flags (`:217-218`) | **No** (T-19) |
| `gsd-tune.cjs` (+ `--validate-codex-bundle`) | project `.planning/config.json` drift, version floors, registered agents; install-time bundle/manifest/capabilities validation | capabilities only when passed/env; reads `process.env.HOME` | yes (bundle) |
| `phase-integrator-preflight.cjs` | git/gh base and PR identity for integrator | no | yes |
| `sentinel-preflight.cjs` | base fetch / branch safety for sentinel rounds; its refusals embed the exact remedy command (e.g. `run: git -C … fetch …`, `:59`) | no | yes |
| `host-verification.cjs` | host-run exact-argv verification of PLAN commands | no | yes |
| `refusal-hints.cjs` | after-the-fact mapping code → hint/remedy, printed by five CLIs only: `claude-investigation-host.cjs:143`, `claude-decompose-host.cjs:702,718`, `codex-decompose-host.cjs:1389`, `codex-delivery-host.cjs:1981` (+ remedy strings via `codex-model-remap.cjs`) | partially | yes |
Not printing hints: `deliver-dispatch.cjs`, `claude-role-host.cjs`, `claude-delivery-host.cjs`, `dispatch-record.cjs`, `role-artifact.cjs` (Grep of `formatHint|hintFor`, [V19]). Confidence high. `deliver-dispatch.cjs build` has no capability or authority check (no `capabilit`/`CODEX_HOME` reference in the file [V19]); INV-015 recorded the builder exiting 0 before the host refused.

**P-02 — Which refusals reach the user with a supported remedy.** The `HINTS` map has 16 keys: `REFERENCE_UNAVAILABLE, INVALID_INPUT, UNSUPPORTED_ROLE, SCOPE_MISMATCH, INVALID_SIGNAL, CONFLICTING_OVERRIDE, NONCOMPLIANT_RECEIPT, MISSING_RECEIPT, INVALID_HOST, INVALID_ARTIFACT, INVALID_RESULT, RUNTIME_UNAVAILABLE, STALE_GENERATED_AGENT, UNSUPPORTED_SELECTION, CODEX_CONFIG_FIX, CODEX_GENERATED_AGENT_FIX` (`refusal-hints.cjs:8-73`; unchanged at v0.72.2 [V11]). Codes on the launch path with **no entry** (so `formatHint` prints "a reason this map does not name … Re-run the command and check the surrounding stderr", `:3-6`): `ARCHIVE_AUTHORITY_INVALID` (observed verbatim in LAUNCH-REFUSAL.md:11-12; 92 source lines in `role-artifact.cjs` match the three ARCHIVE/capability codes [V19]), `ARCHIVE_AUTHORITY_REQUIRED`, `ARCHIVE_ADMISSION_REQUIRED`, `ARCHIVE_AUTHORITY_BUSY`, `RUNTIME_CAPABILITY_MISSING`, `LEGACY_WRITER_STATE`, `WRITER_FENCED`, `AMBIGUOUS_RUNTIME`, `UNKNOWN_RUNTIME`, and (v0.72.1) the ADR_* codes. The capability refusal surfaces as `RUNTIME_UNAVAILABLE` (`codex-runtime-host.cjs:1546-1549`, which also calls `controller.markUnavailable`), whose remedy is "Install and authenticate the runtime, then re-run" — it does not name the capabilities file or `CODEX_HOME`. Confidence high.

**P-03 — Hard rules for new hint/remedy text.** `tests/unit/refusal-hints.test.cjs:24,75-81` fails if any hint or remedy matches `\b(bypass|skip|directly|other runtime|switch runtime)\b|SHIPYARD_STOP_GATE` (case-insensitive); `:9-14,26-35` require the 14 listed codes; `:37-40` require frozen objects; `:83-91` require each of four hosts to `require('./refusal-hints.cjs')` (no local hint text). Both tests pass today (9/9) [V12]. Confidence high. *New remedies must be phrased without those words ("run this installed command" is fine; "run it directly" is not). A new code needs a frozen `HINTS` entry.*

**P-04 — Preflight philosophy already stated in the code and ADRs.** gsd-tune: report-only, "REPORTED, never rewritten. A user's environment is not this script's to write" (`gsd-tune.cjs:739-776`), measured only where the project asked (`:778-783`), "a false blocker is the unsafe direction for a preflight, and the one that gets a gate switched off" (`:826-828`); ADR-007 D4 "None of this … rewrites their environment — it reports" (`ADR-007…:187-192`); ADR-004 "positive evidence before a mutation" (absence of a signal is not permission; "we could not look" ≠ "nothing there"). Confidence high. *A preflight may refuse early and name a remedy; auto-repairing the user's environment conflicts with these. Computing the validated environment for its own child processes is not a write to the user's environment.*

**P-05 — Time budgets that exist today.** Codex probes 10 s each (`codex-runtime-host.cjs:174-197`); `codex debug models` 20 s (`gen-codex-shipyard.cjs:42`); `ensure-gsd-core.sh --isolation-env` 15 s (`bootstrap-shipyard-plugin.cjs:21-22`); bootstrap child 300 s; SessionStart hook 360 s (`hooks.json`); archive lock wait 1 s; native session wait 5 s (`codex-runtime-host.cjs:17`); CI job 15 min (`test.yml:37`). Confidence high. *A launcher preflight sits in front of every launch; it should stay well inside the probe budgets and must not re-run `codex debug models` per launch without deciding that cost (assumption, low).*

### 2.8 Product constraints (flows that must not change)

**PR-01 — Supported entry points and README contract.** Commands `/shipyard:route|investigate|decompose|deliver|bench` and `$shipyard:shipyard-*` (`docs-smoke.sh:33-36`). `tests/smoke/docs-smoke.sh:57-87` pins: exactly **2** README marketplace launcher lines, each exactly `bash scripts/ensure-gsd-core.sh --launch-marketplace codex --source "$PWD"`; byte-exact Makefile recipes for `package-shipyard-codex`, `install-shipyard-codex`, `install-shipyard-marketplace-codex|claude`, and the `dogfood_root` macro. `:15-19` fails if README uses the words docker/container/kubernetes/k8s/dockerfile/compose/image/entrypoint; `:90-93` requires every `make <target>` mentioned in README to exist. Confidence high. *A new supported command needs README text (CLAUDE.md:132) that avoids those words and, if it names a `make` target, a real target.*

**PR-02 — ADR-025 scoping.** Accepted 2026-10-03, **untracked in this checkout** (`git status`: `?? .planning/architecture/ADR-025-…`), phase-47-only: chose option A ("correct existing producer/consumer … Do not relocate all coordination into a new host-owned operation", `:19`; wider option B rejected `:31`) and lists "provider fallback, **automatic environment adjudication**, signing relaxation" as out of scope (`:35`). Confidence high that the text says this; medium that it binds INV-017 (it is phase-scoped, but the operator rejected the larger-operation shape once). *A single launcher is the kind of "new host-owned operation" that ADR-025 deliberately avoided for phase 47; INV-017 needs its own user-selected, accepted decision (the investigation may not write one: DECISIONS.md scope fence). ADR-025's acceptance is not in git history (U-12).*

**PR-03 — Dogfood hosts never reach default-branch merges.** The sentinel refuses a dogfood host when a PR targets the default integration branch (`README.md:172-174`). *A launcher that auto-selects an install must preserve install-kind identity (`host-provenance` `release|dogfood`).*

**PR-04 — Scope fence of this investigation (DECISIONS.md, PROBLEM.md).** No production changes, tickets, PRs, commits, deployment or target-project edits; no bypass of provenance/receipts/admission; no silent trust of legacy files; no runtime/provider switch; no model-policy change; no deletion of the user's history; INV-015 UI design is out of scope. Confidence high.

### 2.9 Delivery constraints

**D-01 — CI is `make test-fast` only.** `.github/workflows/test.yml`: `ubuntu-latest`, Node `24.15.0` (asserted by `docs-smoke.sh:96`), product-change scope filter via `development-artifacts.cjs`, `publish-gate.cjs --working-tree` (comment policy), `check-runtime-digest-trailer.cjs` on PRs, bubblewrap OS-sandbox with `SHIPYARD_REQUIRE_OS_SANDBOX=1`, then `make test-fast`. Not in CI: `test-codex-shipyard` (network, `npx` gsd-core), `test-live`, `test-releases` (`test.yml:10-16`; `Makefile:64-68`). Confidence high. *A new e2e must be hermetic (no network, no real Codex/Claude CLI) to run in CI; Linux/Node 24 only is exercised there, while the failures at issue were observed on macOS (isolation `/private` aliasing, passwd-vs-`HOME` homedirs).*

**D-02 — Runtime-file digest pin.** `tests/unit/runtime-file-digests.json` pins exactly two files: `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`; changed only with `make refresh-runtime-digests` and the printed `Runtime-Digest-Refresh:` trailer (`CLAUDE.md:133-134`; `scripts/refresh-runtime-digests.cjs`). `node scripts/refresh-runtime-digests.cjs --check` exits 0 now [V14]. Confidence high. *Touching only other scripts does not need the trailer; touching either adapter does.*

**D-03 — PR and package conventions.** Product PRs targeting `main` must carry a regenerated `plugins/shipyard` package (T-18); PRs into `epic/*` or stacked on `ticket/*` skip the check and regenerate once before epic→`main` (`CLAUDE.md:79-81`). After each edit run `make test-fast` (`CLAUDE.md:56`); add a focused unit/fixture test with every new rule (`CLAUDE.md:85-86`); commits carry `Shipyard-Verification-Evidence:` trailers in this history (see `git show d8a70dec`). Confidence high.

**D-04 — Release gate requires live receipts on both runtimes.** `scripts/release.sh`: version must equal `plugin.json`, clean tree, no existing tag, a fresh passing live receipt per runtime at the tree sha (stages `research, decompose, executor, publish, sentinel`; `live-receipt.cjs:9-10`), then the release-notes smoke. `tests/live/live-round.sh` needs `gh auth`, a throwaway GitHub repo (`SHIPYARD_LIVE_REPO`), the real CLIs, runs the **checkout's** `plugins/delivery-pipeline/scripts` (`live-round.sh:5,246-267`) against a **freshly initialised** project (no legacy history) and does not set `SHIPYARD_CODEX_CAPABILITIES_FILE` itself (it inherits the caller's environment — no assignment of that variable exists in the file [V19]); its precondition runs `shipyard-doctor.cjs` with `--codex-home`/`--claude-home` (`:139-143`). Receipts live in `~/.local/state/shipyard/live` (`live-receipt.cjs:14-17`). Confidence high. *A release carrying a launcher/migration needs both live receipts; "upgrade with old history" and "launch with no env" are not stages today (a new stage would change `REQUIRED_STAGES`).*

**D-05 — Test-isolation conventions for anything touching authority.** The suites that exercise the authority replace `os.homedir` with a disposable directory (`role-artifact.test.cjs:9-13`, `dispatch-record.test.cjs:2184-2186`, `codex-decompose-host.test.cjs:12-14`, `claude-role-host.test.cjs:11-15`); `tests/unit/run.sh` unsets `CLAUDE_PLUGIN_ROOT CLAUDE_CODE_ENTRYPOINT CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED` and uses a throwaway git config (`run.sh:10,22-30`). Confidence high. *New code that locates authority must resolve it through `os.homedir()` to stay testable, and tests must override it; a suite that does not would write into the developer's real `~/.local/state/shipyard/role-artifact-authority` (the reason I did not run the broader suites, §10).*

---

## 3. What existing tests cover (and what they do not)

Counts: 147 `tests/unit/*.test.cjs` files, 18 files under `tests/smoke/` [V17]. `make test-fast` = `test-unit test-graph test-worktree test-worktree-gates test-sentinel test-docs test-hooks test-comment-policy test-model-ladder-runtime test-statusline`; `make test` adds `test-codex-shipyard` and `test-releases` (`Makefile:64-68`). Grep-based line counts of `test(` in the most relevant suites: `dispatch-record` 131, `role-artifact` 59, `codex-delivery-host` 72, `codex-runtime-host` 24, `gsd-tune` 102, `marketplace-installer` 65, `gen-codex-shipyard` 38 [V17].

| Concern | Covered by | Gap relevant to INV-017 |
|---|---|---|
| Trusted bookkeeping: mutable updates, changed bytes, unknown member, lock timeout | `role-artifact.test.cjs:987-1016,1050-1077` | no test where *pre-existing* sidecars are accepted as historical |
| Fresh vs forged sidecars at project root; external graph history not admitted | `dispatch-record.test.cjs` (v0.72.0 test 'fresh linked-worker provenance…' [V9]) and `:2181-2205` (external canonical graph) | legacy sidecars + no catalogue is never exercised as an *accepted* case |
| Codex host CLI in-flight lifecycle | `codex-delivery-host.test.cjs:850-874` | fixture's `scope.worktree` (`root`, `:107`) differs from the graph's project (`project`, `:109-110`), so `recordInflight` takes the **unauthenticated** branch; the project-root + authority case is not covered |
| Capability probe shape / missing evidence | `codex-runtime-host.test.cjs:494-513`; `phase47-launch-contract.test.cjs:175-181` | tests inject `capabilities`/`probe`; none resolves evidence from `CODEX_HOME`/default location with a scrubbed env |
| Runtime resolution fail-closed | `runtime-context.test.cjs` (16/16 pass [V12]) | dogfood bundle-path ambiguity is not asserted (empirical only, [V13]) |
| Installer refuses bare/incapable install, bundle carries byte-identical evidence | `codex-shipyard-smoke.sh:140-155,702` (network, not CI); `model-ladder-runtime-smoke.sh:72-130` (hermetic, in `test-fast`) | pins "explicit evidence required" at *install*; none for *launch* |
| Isolation/dogfood home selection, marketplace flows with fake CLIs | `marketplace-installer.test.cjs` (65) | install-time only |
| Hints map/format/bypass words/host wiring | `refusal-hints.test.cjs` (9/9 pass [V12]) | no coverage that archive/capability/runtime codes have a named remedy |
| Controlled boundary: unchanged builder bytes → real parser → controller → protected native launcher (spawn stubbed), selectable package root | `phase47-launch-contract.test.cjs` (`SHIPYARD_TEST_PACKAGE_ROOT`, `:11-17`; used by `phase47-package-publication.test.cjs:2086`) | injects `probe`/`env`; does not traverse `runCli → recordInflight → authority` |
| Package freshness / generated mirror | `marketplace-install.test.cjs:70-103` | n/a |
| Full real round (both runtimes) | `tests/live/live-round.sh` (`make test-live`, not CI) | fresh project only; checkout scripts, not the installed bundle |

---

## 4. End-to-end entry points

| Class | Entry point (real, supported) | Needs | Exercises today |
|---|---|---|---|
| Global release install (Codex) | `bash scripts/ensure-gsd-core.sh --launch-marketplace codex [--source …]`; `bash <plugin-root>/host/scripts/ensure-gsd-core.sh --launch-bootstrap` (SessionStart hook; first line of each skill) | `codex` CLI, network for GSD | marketplace-installer unit tests (fake CLIs), isolation guards |
| Installed bundle commands (Codex) | `$CODEX_HOME/shipyard/scripts/deliver-dispatch.cjs build|launch|status|wait`; `codex-delivery-host.cjs --args-file <json>`; `codex-decompose-host.cjs --args-file`; `codex-planning-context-host.cjs`; `dispatch-record.cjs`; `gsd-tune.cjs` (commands/*.md name them) | evidence + authority state | model-ladder smoke requires the installed scripts but substitutes fixture hosts for native launches |
| Claude | `/shipyard:*`; `claude-delivery-host.cjs --workflow X --request-file`; `claude-investigation-host.cjs --request-file`; `claude-decompose-host.cjs --request-file`; `claude-role-host.cjs --args-file`; hooks via `make install-shipyard-claude-hook` | tagged release or dogfood root (T-23) | `claude-hook-smoke.sh`, `claude-delivery-roles-smoke.sh`, `claude-runtime-smoke.sh --capability-only` |
| Dogfood (Codex) | `make install-shipyard-dogfood-codex` (direct; needs `SHIPYARD_CODEX_CAPABILITIES_FILE`) **or** `bash scripts/ensure-gsd-core.sh --launch-marketplace codex --source "$PWD"` (auto dedicated home; prints `export CODEX_HOME=…`; bootstrap probes the CLI) | dedicated home `…/dogfood/codex/<digest>` | `marketplace-installer.test.cjs:156-229` |
| Dogfood (Claude) | `make install-shipyard-dogfood-claude` (`--dogfood-root`) | – | `claude-hook-smoke.sh` |
| Checkout (no install) | `node plugins/delivery-pipeline/scripts/…` from the repo; `make doctor`; `make gsd-tune` | – | `tests/live/live-round.sh` runs this |
| Installed-package e2e harness candidates | (a) `SHIPYARD_TEST_PACKAGE_ROOT=<absolute package root>` with `phase47-launch-contract.test.cjs`; (b) the hermetic install in `model-ladder-runtime-smoke.sh` (fixture HOME, fake `npx/npm/codex/claude/curl/wget` that exit 99) | hermetic | neither launches the installed host CLI with an empty env nor carries old history |
| UI cycle | **none in this repo** (§0.1-5); GSD-owned | – | – |

---

## 5. Seeds for RESEARCH.md → "Constraints"

### Technical
- Authority is per-worktree, keyed by `os.homedir()`, HMAC-protected, private (0700/0600), bounded (4 MiB), written only through `trustedBookkeepingMutation` under the catalogue lock (T-01–T-04). Source `role-artifact.cjs:984-1065,1794-1908`. High.
- Trust-bearing markers must live in the protected authority namespace, not under `.planning/`; legacy sidecar bytes and shape are frozen (T-11, T-12). `codex-delivery-host.cjs:1404`; `host-provenance.cjs:4`. High.
- Forged unknown members must keep refusing (T-05). `dispatch-record.test.cjs` (`9415c1e7`), `role-artifact.test.cjs:1013-1014`. High.
- Capability evidence is installer-written, byte-identical and manifest-digest-bound; discovery may locate and validate it, never synthesize it (T-16). `install-shipyard-codex.sh:315-318`, `gen-codex-shipyard.cjs:352-367`. High.
- Runtime identity needs explicit active evidence; `CODEX_HOME`/install presence is compatibility-only; dogfood bundle paths are not recognized as Codex (T-09). `runtime-context.cjs:193-233`, [V13]. High.
- Native child environment is scrubbed; no provider fallback (T-08). `codex-runtime-host.cjs:1215-1238`. High.
- Home resolution has three spellings and Claude has three precedences; an explicit value must keep winning (§1, T-25). High.
- Launch order is bookkeeping → capabilities; both must be checked before any state is created (T-15). High.
- Subject grammars: only `PHASE_SUBJECT` and (since v0.72.1) `decompositionAdr` are shared (G-01, G-02). High.

### Product
- Supported entry points and the README/Makefile contract are pinned (PR-01). `docs-smoke.sh`. High.
- ADR-014 v7 grid is not touched by launching/preflight (T-17). High.
- A single launcher conflicts with the shape ADR-025 rejected for phase 47 and needs its own accepted decision (PR-02). Medium.
- Dogfood installs keep their identity and dedicated homes (PR-03, T-25). High.

### Delivery
- CI = `make test-fast` on Linux/Node 24.15.0; new e2e must be hermetic (D-01). High.
- Regenerate `plugins/shipyard` for main-bound PRs; never hand-edit generated files (T-18, D-03). High.
- Digest pin only via `make refresh-runtime-digests` (two files) (D-02). High.
- Release needs live receipts for both runtimes; no legacy-history stage exists (D-04). High.
- Authority-touching tests must override `os.homedir` (D-05). High.
- New hint text must avoid bypass words and use `HINTS` (P-03). High.

---

## 6. Native acceptance needs implied by the constraints (evidence the design will have to produce)

(Contract §risks asks research to *identify* native acceptance needs; it does not choose a design.)

1. **Launch with no env variables** against an *installed* bundle in an isolated HOME, through `deliver-dispatch.cjs build` → `codex-delivery-host.cjs --args-file`, asserting that evidence is found from the install and refused when absent/stale/mismatched (no synthesis) — and that both a global and a dogfood install resolve their *own* home.
2. **Upgrade carrying old history**: synthesized fixture (the user's original 64-file state no longer exists locally, M-06) at project root with no catalogue, plus the variants in M-04; assert new launch proceeds, legacy bytes unchanged, legacy classified historical/unverified, a *later* forged member still refuses, and the migration is idempotent under concurrent start (lock) and survives a crash.
3. **Both runtimes**: the Claude role-host and (v0.72.0+) Claude delivery CLI paths are subject to the same refusal; success criterion needs a Claude-side case.
4. **Preflight output**: named concrete incompatibility and a remedy that passes `refusal-hints.test.cjs` word rules, reaching the user from every entry CLI (today six entry points do not print hints, P-01).
5. **Installed-package full UI cycle**: cannot be specified until the supported GSD UI entry point is named (U-05).
6. **Release evidence**: both live receipts (D-04); package regeneration (T-18); `make test-fast` green on Linux/Node 24.

---

## 7. Open questions / unknowns (mirror checkboxes for OPEN-QUESTIONS.md)

- [ ] U-01 Which Shipyard build is actually installed in `~/.codex/shipyard` (and in this checkout's dogfood home `…/dogfood/codex/dd87ca208f1943ba`)? Evidence to read: `~/.codex/agents/.shipyard-manifest.json` (`shipyard_version`, `policy_hash`, `capabilities_digest`), `~/.codex/shipyard-plugin/installed.json`. Blocked in this sandbox — owner: user.
- [ ] U-02 Does `~/.codex/shipyard/codex-capabilities.json` exist, and does its sha256 equal the manifest's `capabilities_digest`? (If yes, the INV-015 `RUNTIME_UNAVAILABLE` was purely an environment-resolution miss: `codex-runtime-host.cjs:166-169` needs `CODEX_HOME` in `process.env`.) — owner: user.
- [ ] U-03 Should this investigation be re-bound to `v0.72.2` (`origin/main`, 9 commits ahead of the checkout) before options are weighed? The packet binds `d8a70dec`; the bookkeeping gate (`9415c1e7`) and ADR-digest module (`78cdca26`) post-date it. — owner: user.
- [ ] U-04 Does the legacy-sidecar refusal reproduce at `v0.72.2` with a disposable `HOME`, project-root worktree, ≥1 pre-existing sidecar, no catalogue — for Codex delivery host, Claude role host **and** Claude delivery CLI? (Code + diff say yes; not run.) — owner: spike S-1.
- [ ] U-05 Which GSD command(s) form "the existing supported UI path" for the installed-package full-UI-cycle check, given the repo has no UI entry point? — owner: user / INV-015 output / GSD documentation.
- [ ] U-06 Can a Codex `SessionStart` hook influence the environment of later agent-run commands, or is it limited to side effects (and it is trust-gated, README.md:90-96)? Not established. — owner: spike S-3.
- [ ] U-07 Should installer-level behaviour stay "explicit evidence required" (`install-shipyard-codex.sh:125-128`, pinned by `codex-shipyard-smoke.sh:145-155`) while bootstrap already measures the CLI (`bootstrap-shipyard-plugin.cjs:104-111`)? Which of the two documented accounts in README.md:105-109 vs :163 is authoritative? — owner: user (decision).
- [ ] U-08 Should launch-time discovery verify the capability file against the manifest's `capabilities_digest` (currently shape-only, `codex-runtime-host.cjs:142-158`)? — owner: user / maintainer.
- [ ] U-09 Which incident and which two code locations produced the original ADR-digest producer/consumer mismatch (no incident record found), and do pre-`78cdca26` sealed decompositions still verify under v0.72.1+ readers? — owner: maintainer.
- [ ] U-10 Is rollback to an older host after a catalogue gains a migration marker required to stay safe? (An older reader checks only schema/worktree/records, `role-artifact.cjs:1062`; not tested.) — owner: user; spike S-4.
- [ ] U-11 What is the real inventory of projects with `.shipyard-role-artifacts/` but no catalogue, or legacy writer leases (M-04)? No deletion is permitted; inventory only. — owner: user.
- [ ] U-12 ADR-025 is untracked in this checkout (`git status`): is its acceptance durable enough to cite as a constraint? — owner: user.
- [ ] U-13 Must new acceptance tests run on macOS as well as CI's Linux/Node 24.15.0 (isolation `/private` aliasing, passwd vs `HOME`)? — owner: maintainer.
- [ ] U-14 Is a project-root `runCli → recordInflight → authority` test (not covered, §3) part of the required acceptance? — owner: maintainer.
- [ ] U-15 Are the harness-created empty `.claude/.cc-writes/` directories (§0.3) acceptable to leave in the checkout? — owner: user.

---

## 8. Spike recommendations (not executed — research contract forbids throwaway code)

- **S-1** `/gsd-spike "legacy provenance sidecars at project root on v0.72.2 with a disposable HOME: reproduce or refute ARCHIVE_AUTHORITY_INVALID for codex-delivery-host, claude-role-host and claude-delivery-host"`
- **S-2** `/gsd-spike "installed Codex bundle launched with a scrubbed environment (HOME only): which resolver fails first and with what hint, with and without ~/.codex/shipyard/codex-capabilities.json present and digest-matching"`
- **S-3** `/gsd-spike "does a Codex SessionStart hook's output or exit reach later agent commands as environment; behaviour when the hook is untrusted"`
- **S-4** `/gsd-spike "an extra MAC-covered catalogue payload field read by the pre-change authorityState and historicalBookkeepingPins; refusal behaviour unchanged"`

---

## 9. Command-backed claims about requirement statements in PROBLEM.md

| PROBLEM.md statement | Status | Evidence |
|---|---|---|
| `d8a70dec` (PR #421) added the mandatory local in-flight route and the unknown-member rejection with no migration | **Confirmed** | [V3][V4]; no legacy admission at v0.72.2 [V11] |
| "Several scripts each resolve [Codex home/capabilities] differently" | **Confirmed**, more sites than listed (also `session-observer.cjs`, `codex-notify.cjs`, `runtime-context.cjs`, `shipyard-doctor.cjs`, `bootstrap`, `ensure-gsd-core.sh`) and Claude precedence disagrees three ways | §1 |
| ADR-digest producer/consumer "do not share one implementation" | **Partly outdated**: shared sealed-subject module exists since v0.72.1; launch subject and integrator subject are still separate copies | G-01, G-02 |
| Items 1–5 of "What success will be" | not yet met at v0.72.2 as far as read; item 4's "full UI cycle" has no in-repo entry point | §0.1, §4 |

---

## 10. Verification ledger

Each entry: tool, exact command/pattern, and the result I observed. "Exit status not captured" means the command was run as a pipeline under zsh where `PIPESTATUS` was unavailable; the outcome is from the printed result.

**Git / revision**
- [V1] Bash `git rev-parse HEAD` → `d8a70decb32e5420fb69f8eebc17be08e82d6d86`.
- [V2] Bash `sha256sum <INV-017>/PROBLEM.md || shasum -a 256 <INV-017>/PROBLEM.md` → `eea376aa962b01c1c304f37410a61e331f95a7cc67728080fc4f3548c26c426b`.
- [V3] Bash `git log --oneline -S'unknown host provenance member before trusted mutation' -- plugins/delivery-pipeline/scripts/role-artifact.cjs`; `… -S'localInflightBookkeeping' -- …/dispatch-record.cjs`; `… -S'trustedBookkeepingMutation' -- …/role-artifact.cjs` → each returns only `d8a70dec`.
- [V4] Bash `git show d8a70dec^:plugins/delivery-pipeline/scripts/dispatch-record.cjs | grep -n 'authenticateBookkeeping\|trustedBookkeepingMutation\|localInflightBookkeeping\|function mutate'` → only `1293:function mutate(…`; `git show d8a70dec^:…/role-artifact.cjs | grep -n 'trustedBookkeepingMutation\|historicalBookkeepingPins\|unknown host provenance'` → no output, `grep` exit 1.
- [V5] Bash `git branch --contains d8a70dec` → includes `main`, `epic/49-…`, many `ticket/T-49-*`; `git merge-base --is-ancestor d8a70dec HEAD` → exit 0; `git tag --contains d8a70dec` → `v0.72.0 v0.72.1 v0.72.2`; `git describe --tags --always d8a70dec` → `phase-47`.
- [V6] Bash `git rev-list --count HEAD..v0.72.0|v0.72.1|v0.72.2` → `4|8|9`; `git rev-list --count HEAD..origin/main` → `9`; `git rev-list --count origin/main..HEAD` → `0`; `git log -1 origin/main` → `be7ab4f3407b017a50e9fe2a49bf54e22e7d3202`, Thu Oct 15 17:32:48 2026 +0300 (local ref, no fetch).
- [V7] Bash `git log --oneline d8a70dec..v0.72.2` → `be7ab4f3, 76653dfa, 78cdca26, e89817d6, 8c080373, 9415c1e7, 3cdac993, 91d2b643, c7633d9e`; `… -- role-artifact.cjs dispatch-record.cjs codex-runtime-host.cjs refusal-hints.cjs` → `9415c1e7`, `c7633d9e`.
- [V8] Bash loop over `d8a70dec v0.72.0 v0.72.1 v0.72.2`: `git show <rev>:…/role-artifact.cjs | grep -n "unknown host provenance member"` → lines `1827, 3955, 3955, 3955`; `git show <rev>:…/dispatch-record.cjs | grep -n "trustedBookkeepingMutation(worktree"` → `1299` in all four. LAUNCH-REFUSAL.md (Read) cites installed `role-artifact.cjs:3954`, `dispatch-record.cjs:1294`.
- [V9] Bash `git show 9415c1e7 -- plugins/delivery-pipeline/scripts/dispatch-record.cjs …/claude-delivery-host.cjs …/codex-runtime-host.cjs tests/unit/dispatch-record.test.cjs` → `localInflightBookkeeping` replaced by `inflightBookkeepingRequired`; `claude-delivery-host.cjs` in-flight record gains `worktree`; new test asserts `/unknown host provenance/` for `unknown.json`.
- [V10] Bash `git show 78cdca26 -- …/planning-result-sealer.cjs …/deliver-dispatch.cjs` and per-file `git show v0.72.2:<file> | grep -n 'decompositionAdr\|decompositionSubject\|assertDecompositionSubject\|SUBJECT_PATTERN\|;input=\|adr=\|;repository=\|resolveAdr'` for `deliver-dispatch, run-contract, codex-decompose-host, claude-decompose-host, codex-planning-context-host, planning-result-sealer, context-packet` → results as cited in G-02.
- [V11] Bash at `v0.72.2`: `grep -n "unknown host provenance|function trustedBookkeepingMutation|function historicalBookkeepingPins|admitLegacy|legacyBookkeeping|function admitHistoricalArchive"` on `role-artifact.cjs` → `3905, 3936, 3955, 4195`, no `admitLegacy`/`legacyBookkeeping`; `refusal-hints.cjs` has 16 `Object.freeze` entries and no `ARCHIVE|CAPABILITY|LEGACY` match; `capabilitiesFrom` text identical to the bound revision.

**Executed code (hermetic, `$TMPDIR` only)**
- [V12] Bash `node tests/unit/refusal-hints.test.cjs` → `tests 9 / pass 9 / fail 0`; `node tests/unit/runtime-context.test.cjs` → `16 passed, 0 failed`. Exit statuses not captured (pipeline under zsh).
- [V13] Bash `node -e` calling `runtime-context.cjs resolveRuntime('/nonexistent-root',{routed:true,env:{},scriptPath:<p>})` with `<p>` = `/h/.codex/shipyard/scripts/x.cjs` → `{"runtime":"codex","source":"bundle-path",…,"policy_hash":"3978b087…"}`; with `<p>` = `/h/.local/state/shipyard/dogfood/codex/6cba328f5f0de395/shipyard/scripts/x.cjs` → `REFUSED AMBIGUOUS_RUNTIME runtime-context: no active runtime; project-config-legacy, CODEX_HOME and defaultRuntime are compatibility-only`. (Paths are strings; nothing under `$HOME` was read.)
- [V14] Bash `node -e "require('./tests/unit/runtime-file-digests.json')…"` → schema `shipyard.runtime-file-digests.v1`, 2 files; `node scripts/refresh-runtime-digests.cjs --check` → exit 0.
- [V14b] Bash `ls plugins/shipyard/host plugins/shipyard/hooks plugins/shipyard/.codex-plugin`; `ls plugins/shipyard/host/scripts` → eight scripts (no `shipyard-doctor.cjs`).
- [V15] Bash `cmp -s` for `dispatch-record, role-artifact, codex-runtime-host, codex-delivery-host, refusal-hints, runtime-context` between `plugins/delivery-pipeline/scripts/` and `plugins/shipyard/host/plugins/delivery-pipeline/scripts/` → all `IDENTICAL`; Bash `node -e` building the package into `$TMPDIR` via `require('./scripts/package-shipyard-codex.cjs').build(dir)` then `diff -rq <dir> plugins/shipyard` → exit 1, single line `Only in …/host/plugins/delivery-pipeline/scripts: .claude` (the harness directory, §0.3).
- [V16] Bash `git check-ignore -v .planning/graph/provenance/x.json` → `.git/info/exclude:10:.planning/graph/provenance/` exit 0; `git ls-files .planning/graph/provenance | wc -l` → `0`; `git ls-files .planning/graph` lists `dispatches.json` among 12 tracked files; `ls .planning/graph/provenance | wc -l` → `2` (count only).
- [V16b] Bash `find . -name .cc-writes` → `./plugins/.claude/.cc-writes`, `./plugins/delivery-pipeline/scripts/.claude/.cc-writes`, `./tests/.claude/.cc-writes`, `./.claude/.cc-writes`, `./.planning/investigations/INV-017-…/.claude/.cc-writes`.
- [V17] Bash `ls tests/unit/*.test.cjs | wc -l` → 147; `ls tests/smoke | wc -l` → 18; `grep -c "test("` per file: `dispatch-record` 131, `role-artifact` 59, `codex-delivery-host` 72, `codex-runtime-host` 24, `gsd-tune` 102, `marketplace-installer` 65, `gen-codex-shipyard` 38.
- [V18] Bash `node -e` `sha256(<path>).slice(0,16)` → `/Volumes/KINGSTON/claude-shipyard` → `dd87ca208f1943ba`; `/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard` → `6cba328f5f0de395`.

**Search and read tools** (used where Bash was denied or the dedicated tool fits)
- [V19] Grep sweeps over `plugins/delivery-pipeline/scripts/*.cjs` unless stated: (a) `CODEX_HOME|SHIPYARD_CODEX_CAPABILITIES_FILE|codex-capabilities|CLAUDE_HOME|SHIPYARD_RUNTIME|SHIPYARD_DOGFOOD|os\.homedir\(\)` (basis of §1); (b) `admitHistoricalArchive|authenticatedArchivePins|require\.main` with `!**/role-artifact.cjs` over `plugins/delivery-pipeline` → no caller of `admitHistoricalArchive` outside tests and `role-artifact.cjs`; (c) `refusal-hints|formatHint|hintFor` over scripts/tests → five printing CLIs listed in P-01; (d) `ARCHIVE_AUTHORITY_INVALID|ARCHIVE_AUTHORITY_REQUIRED|RUNTIME_CAPABILITY_MISSING` count → `role-artifact.cjs` 92, `codex-runtime-host.cjs` 7, `claude-runtime-host.cjs` 8, tests; (e) `SHIPYARD_CODEX_CAPABILITIES_FILE|codex-delivery-host\.cjs|…|CODEX_HOME` over `plugins/delivery-pipeline/**/*.md` → no mention of the capabilities variable or `CODEX_HOME` in command prose (host script names only); (f) `ui-phase|UI-SPEC|ui-review|ui_phase|UI lifecycle|gsd-ui` over README/docs/plugins/scripts/tests/capabilities/CLAUDE.md → one fixture hit; (g) `readProvenance|graph/provenance` over `tests` and plugin markdown; (h) `dispatches\.json` over scripts (writers: `dispatch-record.cjs` only); (i) `capabilit` over `deliver-dispatch.cjs` → no hit; (j) `LEGACY_WRITER_STATE|WRITER_FENCED|…` counts over hint/host files; (k) `SHIPYARD_CODEX_CAPABILITIES_FILE|CODEX_HOME=|codex-capabilities` over `tests/{smoke,live,fixtures}` → hits in `model-ladder-runtime-smoke.sh`, `codex-shipyard-smoke.sh`, `phase47-runtime-acceptance.cjs`, `claude-hook-smoke.sh`; none in `live-round.sh`.
- [V20] Read (full or ranged): `INV-015/LAUNCH-REFUSAL.md`; `docs/audits/2026-10-03-phase47-launch-fix.md`, `…runtime-failure-state-fix.md`; INV-017 `EVIDENCE.md`, `OPEN-QUESTIONS.md`, `OPTIONS.md`, `RESEARCH.md`, `RISKS.md` (via Bash `cat` in one loop that was permitted); `Makefile`; `CLAUDE.md`; `README.md:40-190`; `scripts/install-shipyard-codex.sh` (1-260, 300-420, 676-825), `install-shipyard-capability.sh`, `bootstrap-shipyard-plugin.cjs`, `install-shipyard-marketplace.cjs`, `package-shipyard-codex.cjs`, `ensure-gsd-core.sh` (1-120, 300-360), `gen-codex-shipyard.cjs` (28-120, 225-405), `shipyard-doctor.cjs` (215-424), `release.sh`; plugin scripts: `codex-runtime-host.cjs`, `codex-delivery-host.cjs`, `dispatch-record.cjs`, `role-artifact.cjs`, `runtime-context.cjs`, `refusal-hints.cjs`, `gsd-tune.cjs`, `planning-writer-lease.cjs`, `deliver-dispatch.cjs`, `claude-delivery-host.cjs`, `claude-role-host.cjs`, `claude-runtime-host.cjs`, `claude-decompose-host.cjs`, `codex-decompose-host.cjs`, `codex-agent.cjs`, `codex-arch-review-context.cjs`, `architecture-target.cjs`, `host-provenance.cjs`, `host-verification.cjs`, `sentinel-preflight.cjs`, `phase-integrator-preflight.cjs`, `live-receipt.cjs`; tests: `refusal-hints`, `role-artifact` (975-1085), `dispatch-record` (2140-2208), `codex-delivery-host` (104-128, 836-885), `codex-runtime-host` (488-530), `phase47-launch-contract`, `marketplace-install` (55-114), `docs-smoke.sh`, `codex-shipyard-smoke.sh` (84-163), `model-ladder-runtime-smoke.sh` (24-165), `live-round.sh` (20-267), `unit/run.sh`; ADRs `ADR-004` (head), `ADR-007` (160-222), `ADR-024-ROLLOUT.md` (30-150), `ADR-024-model-ladder-refresh.md` (grep), `ADR-025`; `.github/workflows/test.yml`.
- [V21] Denied and **not** retried: (1) Bash `cat docs/audits/…launch-fix.md; cat docs/audits/…runtime-failure-state-fix.md` ("names a path that is computed at run time") → used Read; (2) Bash multi-file `grep -n … codex-delivery-host.cjs …` → used Grep; (3) Bash `ls "$HOME/.codex/shipyard"; ls "$HOME/.local/state/shipyard"` ("contains multiple operations") → installed/authority state not inspected (§0.3); (4) Bash `cat tests/unit/run.sh …`, `wc -l …; grep …`, `sed -n …` on other paths → used Read/Grep; (5) Bash `node -e` that read files by a variable path to diff refusal codes against `HINTS` → replaced by the explicit lists in P-02 (built from Read of `refusal-hints.cjs` and the Grep counts above).

**Not run, deliberately.** `tests/unit/role-artifact.test.cjs`, `dispatch-record.test.cjs`, `codex-delivery-host.test.cjs` and other suites that create authority/state under `os.homedir()` or need a GPG agent: some override `os.homedir`, but I could not confirm every case without risking writes to the developer's real `~/.local/state/shipyard` (research contract: do not touch that tree). `make test-fast`, `make test-codex-shipyard` (network) and `make test-live` (real CLIs, `gh`) were not run.
