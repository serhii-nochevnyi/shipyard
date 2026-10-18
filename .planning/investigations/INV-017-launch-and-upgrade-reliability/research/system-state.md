# INV-017 — research line 1: system state

Line: `system-state` · Subject: `INV-017-launch-and-upgrade-reliability:system-state` · Written: 2026-10-15
Authenticated source revision (packet): `d8a70decb32e5420fb69f8eebc17be08e82d6d86` (local `main`, plugin version 0.71.0)
Policy: ADR-014 `adr-014.v7`, policy hash `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570`
Caller-resolved selection: `claude-sonnet-5-5` / `xhigh`. Exact policy signals (preserved, DATA): `{}`
Inputs read: `PROBLEM.md` (sha256 `eea376aa…c426b`), `RESEARCH-CONTRACT.md` (`b2f49322…6765`), `DECISIONS.md` (`f773b0f7…76ea`), `EVIDENCE.md`, `OPEN-QUESTIONS.md`, `INV-015/LAUNCH-REFUSAL.md`, `docs/audits/2026-10-03-phase47-launch-fix.md`, `docs/audits/2026-10-03-phase47-runtime-failure-state-fix.md`. `tickets.json` was an optional reference with content omitted; it was not read.
Mode: read-only. No product code, planning scaffolding, installed files or user state was changed. No design is chosen here.

## 0. How to read this file

- **Citations.** `path:line` refers to the working tree at `/Volumes/KINGSTON/claude-shipyard`, which equals HEAD `d8a70dec` for every code path (`git status --short -- plugins scripts Makefile tests capabilities | wc -l` → `0`, E2). A prefix `origin/main:` means the local remote-tracking ref `origin/main` (`be7ab4f3`, tag `v0.72.2`), read with `git show origin/main:<path>` (E3–E4). I did not run `git fetch`, so the age of that ref is unknown.
- **Verification contract.** Every checkable claim names its check. `E<n>` is a shell command in §13 with its output. `Read`/`Grep` means I read that file range with the file tools. Claims I could not check are labelled `[UNKNOWN]`, `[ASSUMPTION]` or `[INFERENCE]` (from code reading, not executed) and each has a next check in §11–§12.
- **Confidence.** H = checked by command or by reading the exact code. M = code reading plus a consistent second source. L = inference.
- **Shell note.** The shell is zsh. In commands I report an exit status only where it was captured straight after the command it describes.

## 1. Findings in brief

| # | Finding | Conf. |
|---|---|---|
| F0 | **The packet revision is not the build that produced the observed failures.** Local `main` (`d8a70dec`) is 9 commits behind `origin/main` (E3). The INV-015 evidence cites installed `role-artifact.cjs:3954`; that rejection sits at line `1827` at `d8a70dec` but at `3955` in every commit from `c7633d9e` (#456) to `be7ab4f3` (E9). The observed host is therefore a v0.72.x-family build, not `d8a70dec`. Behaviour relevant to INV-017 is unchanged on `origin/main`, with the exceptions in §2. | H |
| F1 | **No component is a single launcher.** The agent runs `pipeline-config.cjs resolve`, `deliver-dispatch.cjs build … > file`, then a host script, in whatever environment the Codex or Claude session provides. `deliver-dispatch.cjs launch` exists only for `executor` and `pr-sentinel` and passes `process.env` through without validating it (§3). | H |
| F2 | **Codex home, capability evidence and agents dir are resolved by at least 20 sites with at least 8 distinct rules** (§4). The decisive one: `codex-runtime-host.cjs:160-171` finds the installed `$CODEX_HOME/shipyard/codex-capabilities.json` **only if `CODEX_HOME` is set**, while every neighbouring site defaults an unset home to `~/.codex`. Reproduced with the supported probe CLI: a default home containing the file is refused until `CODEX_HOME` is exported (E11). | H |
| F3 | **Capability evidence has three possible homes and no reader checks the digest.** Env/flag document → marketplace snapshot `$CODEX_HOME/shipyard-plugin/capabilities.json` → bundle copy `$CODEX_HOME/shipyard/codex-capabilities.json`. The manifest binds the bundle copy by digest at install time only (`gsd-tune.cjs:200-215`). Runtime readers check shape only (`codex-runtime-host.cjs:142-158`). `codex-agent.cjs` has no env or bundle fallback at all (`:84-96`). | H |
| F4 | **The local bookkeeping route has no path for pre-existing history.** `d8a70dec` added `trustedBookkeepingMutation` and its unknown-member rejection (E7). With no authority catalogue, the "authenticated" set is empty, so any existing sidecar refuses a required mutation (`role-artifact.cjs:1826-1827`). The refusal also creates the authority directory and key as a side effect (`:1815`, `:1043-1048`). `origin/main` still has the rejection (E9). The only function named by the error text, `admitHistoricalArchive`, admits retained *role archives*, has no CLI and no non-test caller (E12). | H |
| F5 | **Which hosts hit F4 depends on a per-call-site flag.** `codex-delivery-host` and `claude-role-host` pass `worktree` and are "required" when it equals the project root. At `d8a70dec` `claude-delivery-host` did not pass `worktree`, so by code reading its sidecar is written unpinned and a later required host would refuse it (`[INFERENCE]`; #482's regression test "fresh linked-worker provenance remains authenticated when the next host runs at the project root" targets this ordering). `origin/main` (#482) adds `worktree` there and makes a missing or empty provenance dir "required". It does not migrate legacy history (E10). | H for the flag logic, M for the ordering |
| F6 | **The phase + repository + ADR-digest binding did not exist at `d8a70dec`.** `decompose.md:302,314,400` promised `phase=;repository=;adr=<digest>`; neither decompose host built it and the sealer accepted any non-empty subject. It exists on `origin/main` (#486, `78cdca26`) in `planning-result-sealer.cjs`, shared by both hosts. Four more subject grammars and four repository-identity formats are still implemented separately (§6). | H |
| F7 | **Preflight does not cover host environment or project-local state.** `make doctor` checks installed hooks, bundle and agents; it does not check capabilities, the policy hash, the authority catalogue or provenance sidecars, and it ignores the `CODEX_HOME` env var (`shipyard-doctor.cjs:218`). Hints print from four hosts only. `ARCHIVE_AUTHORITY_*`, `RUNTIME_CAPABILITY_MISSING` and `AMBIGUOUS_RUNTIME` have no named remedy; `RUNTIME_UNAVAILABLE` has a remedy ("install and authenticate the runtime") that does not match the capability cause (§7). | H |
| F8 | **No test exercises the failure class.** There is no unit, smoke or live test for launch with no env variables, for an upgrade carrying pre-existing sidecars with no catalogue, or for the installed bundle driven from a clean shell (§8). `tests/live/live-round.sh` runs source-tree scripts against a fresh fixture. | H |

## 2. Deployment-state check (contract hypothesis #1)

The problem is "launch and upgrade fail", not "X does not happen", but the contract asks me to prove which code is present before analysing defects.

| Question | Answer | Check |
|---|---|---|
| Is `d8a70dec` on the integration branch? | Yes. | `git merge-base --is-ancestor d8a70dec main` → exit `0` (E8). |
| Which commit added the legacy-history rejection? | `d8a70dec` (PR #421, 2026-10-09). All of `historicalBookkeepingPins`, `trustedBookkeepingMutation` and the `unknown host provenance member` rejection are `+` lines in its diff. | E7. |
| Is local `main` current? | No. `origin/main` is 9 commits ahead, 0 behind. Tags `v0.72.0`, `v0.72.1`, `v0.72.2` all point at commits that are ancestors of `origin/main` and not of local `main`. `v0.71.0` is an ancestor of `main`. | E3, E5. |
| What changed on `origin/main` that touches INV-017? | #456 (arch review, moves the rejection to line 3955); #482 first-run provenance (`inflightBookkeepingRequired`); #486 ADR-digest binding; #484 and #487 builders and investigation host before a first graph exists. **No** change to capability discovery, `codex-agent.cjs`, `shipyard-doctor.cjs` home resolution, or legacy-history admission. | E4, E10, E13, E14. |
| Which build produced the INV-015 refusals? | `[INFERENCE]` A v0.72.x-family build: installed line 3954 matches the post-#456 layout (3955, off by one for the generated bundle) and not `d8a70dec` (1827). | E9. |
| Which build is installed under `~/.codex/shipyard` and in the Codex plugin cache? | `[UNKNOWN]` The file tools are confined to the repo ("outside /Volumes/KINGSTON/claude-shipyard; --restricted confines the file tools"). Installed files and `~/.local/state/shipyard` could not be read. Next check: `node scripts/shipyard-doctor.cjs --json` and `cat ~/.codex/shipyard-plugin/installed.json` by someone with access. | §14. |

Consequence: line numbers below are `d8a70dec` unless prefixed. Whenever a claim matters to the observed failures I re-checked it on `origin/main`.

## 3. Entry points and data flow today

### 3.1 Codex, ordinary command

1. **Package skill.** The generated skill (`scripts/package-shipyard-codex.cjs:36-46`) tells the agent to run `bash "<plugin-root>/host/scripts/ensure-gsd-core.sh" --launch-bootstrap`, then to read `${CODEX_HOME:-$HOME/.codex}/shipyard-native-skills/shipyard-<name>/SKILL.md` and follow it. A `SessionStart` hook runs the same bootstrap (`:48-50`).
2. **Bootstrap** (`scripts/bootstrap-shipyard-plugin.cjs:64-146`). Home = `CODEX_HOME` or `~/.codex` (`:65`). If `SHIPYARD_CODEX_CAPABILITIES_FILE` is unset it runs `codex debug models` and writes `$home/shipyard-plugin/capabilities.json` (`:104-111`), then runs `install-shipyard-codex.sh` with `CODEX_HOME`, `AGENTS_SKILLS_DIR` and `SHIPYARD_CODEX_CAPABILITIES_FILE` set in the **child** env (`:112-122`). It returns early when the marker matches build digest, GSD version and installed file digests (`:97-101`). The early return does not compare the Codex CLI version or the capability snapshot, so the snapshot is not refreshed until the package digest changes `[INFERENCE]`.
3. **Native workflow.** The converted `commands/*.md` tell the agent to run, in the session's own shell (`commands/investigate.md:31-36, 98-115, 219-222`): `pipeline-config.cjs resolve --json`; `deliver-dispatch.cjs build <role> … --runtime <r> > "$requestFile"`; `codex-delivery-host.cjs --args-file "$requestFile"`. Nothing in this chain exports `CODEX_HOME` or `SHIPYARD_CODEX_CAPABILITIES_FILE` for those commands. The README lists them as optional overrides (`README.md:108-109`), and the installer's dogfood mode prints `export CODEX_HOME="<dedicated>"` as a manual step (`scripts/install-shipyard-marketplace.cjs:97-98`). `[UNKNOWN]` which variables the Codex CLI itself sets for tool subprocesses.
4. **`deliver-dispatch.cjs`** (`:1198-1227`): `build` (stdout request JSON, no environment check), `launch`, `status`, `wait`. `launch` supports only `executor` and `pr-sentinel` (`ROLE_BUCKETS`, `:25-28`; `:308-375`; `--runtime` is mandatory, `:474-485`), spawns `process.execPath <host>` detached with `{...process.env, ...options.env, SHIPYARD_GRAPH_DIR}` (`:250-255`), and has a preflight only for `pr-sentinel` (`:332-339`, `sentinel-preflight.cjs`). Research, decomposition, arch-review, integrator, ci-fix and review-fix are launched by the agent running the host directly (`commands/deliver.md:1226-1231`).
5. **Host** (`codex-delivery-host.cjs:runCli`, `:1784-1955`): parse request → arch-review prepare (`:1794-1808`) → `policy.resolveDispatch` (`:1814`) → typed-GSD writer lease (`:1823-1835`) → `controller.begin` (`:1859`) → **`recordInflight`** (`:1878`, trusted bookkeeping, §5) → `createCodexDeliveryHost` (`:1881`) → `createCodexRuntimeHost` → **probe**: capabilities, then `codex --version`, then `codex exec --help` markers (`codex-runtime-host.cjs:173-230, 1537-1550`) → native launch, receipts. Hints print on a failure exit (`:1976-1985`).

Ordering consequence: the legacy-history refusal (`:1878`) fires before the capability refusal (`:1881`), which matches the INV-015 sequence.

### 3.2 Claude

`${CLAUDE_PLUGIN_ROOT}` is supplied by Claude Code, so Claude command text has a host-provided root. The Claude hosts probe the runtime live (`claude --version`, `--help` markers, `claude auth status --json`; `claude-runtime-host.cjs:178-219`). **There is no capability file on the Claude side.** The config dir is `CLAUDE_CONFIG_DIR` or `$HOME/.claude` (`:363, :371`).

### 3.3 Host entry points

| Script | Role | Environment validated | Prints `hint[...]`? |
|---|---|---|---|
| `codex-delivery-host.cjs` | research, executor, repair, integrator, arch-review, sentinel | capabilities, via the probe | yes (`:1981`) |
| `codex-decompose-host.cjs` | typed GSD planner and checker | same | yes (`:1389`) |
| `claude-delivery-host.cjs` | executors, fix round, drift | live probe | no (`:1170-1174`) |
| `claude-role-host.cjs` | arch-review, integrator, sentinel | live probe | no (`:1478-1485`) |
| `claude-investigation-host.cjs` | research | live probe | yes (`:143`) |
| `claude-decompose-host.cjs` | planner and checker | live probe | yes (`:718`) |
| `codex-planning-context-host.cjs` | packet validation, then decompose host | none | no (`:411-416`) |
| `deliver-dispatch.cjs` | build / launch / status / wait | none | no (`:1249-1254`) |
| `codex-runtime-host.cjs --capability-only` | supported probe CLI | capabilities, CLI | n/a; **always exits 0**, even when unavailable (`:1667-1681`, E11) |

## 4. Where Codex home, capabilities, agents dir and the active runtime are resolved

### 4.1 Codex-side sites

| # | Site | Resolves | Rule (in order) | If unset |
|---|---|---|---|---|
| 1 | `codex-runtime-host.cjs:160-171` `capabilitiesFrom` | capability evidence | `options.capabilities` → `options.capabilitiesFile` → `process.env.SHIPYARD_CODEX_CAPABILITIES_FILE` → `process.env.CODEX_HOME/shipyard/codex-capabilities.json` | **fail** `RUNTIME_CAPABILITY_MISSING` "explicit Codex capability evidence is required". Reads `process.env`, not `options.env`. No `os.homedir()` default. |
| 2 | `codex-runtime-host.cjs:395, 441, 729, 882` | Codex home for sessions and GSD agents | `env.CODEX_HOME` → `process.env.CODEX_HOME` → `~/.codex` | defaults to `~/.codex` (differs from #1 in the same file) |
| 3 | `codex-delivery-host.cjs:705-711` `installedAgentOptions` | agents dir, capability file | agents: `options.agentDir` → `(env.CODEX_HOME ‖ ~/.codex)/agents`. Capability file: `options.capabilitiesFile` → `env.SHIPYARD_CODEX_CAPABILITIES_FILE` | agents default; capability file `undefined` (no bundle fallback) |
| 4 | `codex-delivery-host.cjs:765-772` `storageDirectory` | host state root | `options.storageRoot` → `os.homedir()/.local/state/shipyard/codex` | home-based |
| 5 | `codex-decompose-host.cjs:518` | agents dir (recovery) | `options.agentDir` → `options.env.CODEX_HOME` (unguarded property access) → `~/.codex` | default |
| 6 | `codex-agent.cjs:69-72` / `:84-96` | agents dir / capabilities | agents: `--agent-dir` → `(env.CODEX_HOME ‖ ~/.codex)/agents`. Capabilities: `options.capabilities` → `options.host.capabilities` → `options.capabilitiesFile` → `--capabilities-file` | agents default; **capabilities fail** `UNSUPPORTED_SELECTION` with `CAPABILITIES_CONTRACT` (`:18`). No env var, no bundle fallback. |
| 7 | `dispatch-record.cjs:450-456` `codexAgentDir` | agents dir for `mark` flag checks | `SHIPYARD_CODEX_AGENT_DIR` → `CODEX_HOME/agents` → `~/.codex/agents` | default (a fourth variable) |
| 8 | `gsd-tune.cjs:283-285` / `:784` | bundle-validation capability file / Codex `config.toml` | file: `--capabilities` → `--capabilities-file` → env. Config: `CODEX_HOME` → `HOME/.codex` (`process.env.HOME ‖ ''`) | validation fails / default |
| 9 | `scripts/gen-codex-shipyard.cjs:216, 248-260` | home / capabilities | home: `--codex-home` → `CODEX_HOME` → `~/.codex`. Capabilities: `--capabilities` → env → **falls back to running `codex debug models`** (`:38-68`) | generator falls back; the installer script refuses (row 10) |
| 10 | `scripts/install-shipyard-codex.sh:34-41, 63-114, 125-138` | home / capabilities | `CODEX_HOME` (empty refused) → `$HOME/.codex`; dogfood overrides to `~/.local/state/shipyard/dogfood/codex/<sha256(realpath source)[:16]>`. Capabilities: env **required** (exit 2) | refuses; asserted by `tests/smoke/codex-shipyard-smoke.sh:145-155` |
| 11 | `scripts/bootstrap-shipyard-plugin.cjs:65, 104-114` | home / capabilities | home as above; capability file = env → `$home/shipyard-plugin/capabilities.json` generated from `codex debug models` | auto-derives |
| 12 | `scripts/install-shipyard-marketplace.cjs:78-109` | target home | explicit absolute `CODEX_HOME` → shared default; dogfood computes a dedicated home and **prints `export CODEX_HOME=…`** (`:97-98`) | prints a manual step |
| 13 | `scripts/install-shipyard-capability.sh:28-35` | GSD tools home | `${CODEX_HOME:-$HOME/.codex}` | default |
| 14 | `scripts/shipyard-doctor.cjs:218` | home to inspect | `--codex-home` → `~/.codex`; **ignores the `CODEX_HOME` env var** | default |
| 15 | `session-observer.cjs:295-296` | Codex log DB | `CODEX_HOME` → `~/.codex`; DB `SHIPYARD_CODEX_LOG_DB` → `<home>/logs_2.sqlite` | default |
| 16 | `codex-notify.cjs:26, 32-33` | home / delegate file | `CODEX_HOME` → **script-relative `__dirname/../..`**; delegate `SHIPYARD_CODEX_NOTIFY_DELEGATE` → script-relative. The only site that derives home from the installed location. | script location |
| 17 | `scripts/package-shipyard-codex.cjs:44-45` | skill wrapper | shell `${CODEX_HOME:-$HOME/.codex}` | default |
| 18 | `runtime-context.cjs:100-116` `installedRuntime` | runtime hint | `CODEX_HOME` set **and** `<home>/config.toml` exists → `codex-config-home` (weakest, non-routed only) | none |
| 19 | `planning-writer-lease.cjs:85-100` | writer-lease root | `os.userInfo().homedir/.local/state/shipyard/planning-writers/shared`; legacy roots also scan `os.homedir()` and `process.env.HOME` | `userInfo` home (ignores a `HOME` override) |
| 20 | `role-artifact.cjs:984-1009` | authority directory | `fs.realpathSync(os.homedir())/.local/state/shipyard/role-artifact-authority/<sha256(realpath worktree)>` | `os.homedir()` (honours `HOME`) |

Disagreements that can strand a launch (all `H`, from the rows above):

- **#1 vs #2, #3, #6–#8.** Home defaults to `~/.codex` for sessions and agents but is *required* for the bundle capability lookup. A default-home install has the file and the runtime host cannot see it.
- **#6 vs #1.** The selector (`codex-agent.cjs`) has no env or bundle path for capabilities; the runtime host has both.
- **#9 vs #10.** The generator derives capabilities from `codex debug models` when none is given; the installer script refuses to; the marketplace bootstrap derives them and hands the snapshot to the installer.
- **#14.** `make doctor` inspects `~/.codex` even when `CODEX_HOME` points elsewhere (`tests/live/live-round.sh:140` works around this by passing `--codex-home`).
- **#19 vs #20 vs `claude-decompose-host.cjs:190` (`process.env.HOME ‖ os.homedir()`).** Three home sources for host state. Under a `HOME` override the writer-lease root stays at the real user home while the authority catalogue and decompose store move.
- **Dogfood path formula** is written three times: `Makefile:127`, `install-shipyard-codex.sh:66-75` (comment at `:62`: "Mirrors install-shipyard-marketplace.cjs's dogfoodHome formula") and `install-shipyard-marketplace.cjs`.

### 4.2 Claude-side sites

| Site | Resolves | Rule |
|---|---|---|
| `claude-runtime-host.cjs:363, 371` | config dir | `environment.CLAUDE_CONFIG_DIR` → `process.env.CLAUDE_CONFIG_DIR` → `$HOME/.claude` (no `CLAUDE_HOME`) |
| `claude-decompose-host.cjs:353, 606, 692` | config dir | `CLAUDE_CONFIG_DIR` → `$HOME/.claude` |
| `claude-decompose-host.cjs:188-192` | private store | `process.env.HOME ‖ os.homedir()`/`.local/state/shipyard/claude-decompose/<hash>` |
| `scripts/install-shipyard-claude-hook.sh:28` | home | `CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude` |
| `scripts/install-shipyard-capability.sh:29, 34` | home | `CLAUDE_CONFIG_DIR` → `CLAUDE_HOME` → `~/.claude` — **opposite precedence to the hook installer** |
| `scripts/install-shipyard-marketplace.cjs:12`, `bootstrap-shipyard-plugin.cjs:15` | validated variables | `CLAUDE_HOME`, `CLAUDE_CONFIG_DIR` |
| `tests/live/live-round.sh:141` | doctor argument | `CLAUDE_CONFIG_DIR` → `CLAUDE_HOME` |

### 4.3 Active-runtime resolution

- `runtime-context.cjs:resolveRuntime` (`:118-168`), non-routed order: `options.runtime` → `SHIPYARD_RUNTIME` → `GSD_RUNTIME` → runtime marker → GSD tools marker → `GSD_CORE_HOME` marker → bundle path (`:77-87`, only a `.codex` or `.claude` path segment) → host session env (`CODEX_SANDBOX*`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_ENTRYPOINT`; `:89-98`) → legacy project `runtime` → `CODEX_HOME` + `config.toml` → `defaultRuntime` → ambiguous.
- `resolveDispatchContext` (`:195-253`, routed): collects **every** candidate (`SHIPYARD_RUNTIME`, `GSD_RUNTIME`, markers, bundle path, session env). Any two that disagree throw `AMBIGUOUS_RUNTIME` (`:224-227`). None throws `AMBIGUOUS_RUNTIME` with "project-config-legacy, CODEX_HOME and defaultRuntime are compatibility-only" (`:230-233`). `[INFERENCE]` a Codex host launched from a process that also carries `CLAUDE_PLUGIN_ROOT` or `CLAUDE_CODE_ENTRYPOINT` would hit the conflict path; `tests/live/live-round.sh:22-24` strips `CLAUDECODE` and `CLAUDE_CODE_*` variables before a Codex round, which suggests the hazard is known.
- The hosts hard-code their runtime: `normalizeScope` rejects anything but `codex`/`openai` (`codex-runtime-host.cjs:103-107`); `deliver-dispatch.cjs build|launch` take an explicit `--runtime`; `commands/investigate.md:31-33` tells the agent to read `config.gsd.runtime` from `pipeline-config.cjs resolve --json` and keep it fixed.
- `[INFERENCE]` The bundle-path marker cannot identify a dogfood Codex install: its scripts live under `~/.local/state/shipyard/dogfood/codex/<hash>/shipyard/` (`docs/audits/2026-10-03-phase47-launch-fix.md:8`), which has no `.codex` segment (regex at `runtime-context.cjs:84`). Not executed.

## 5. What the installers write

Direct installer `scripts/install-shipyard-codex.sh` (the README calls it the "legacy direct bundle installer", `README.md:122-123`; `make install-shipyard-codex` uses the marketplace route, `Makefile:24-25`):

| Artifact | Path | Writer | Validation |
|---|---|---|---|
| Bundle payload (`scripts/`, `references/`, `templates/`, `workflows/`, `skills/delivery-rules`, `codex-capabilities.json`) | `$CODEX_HOME/shipyard/` | `replace_dir` (`install-shipyard-codex.sh:785`) | staged manifest validated by `gsd-tune.cjs:139-269` before replacement (`:332-333`) |
| Agents (`shipyard-*.toml`) and ownership manifest | `$CODEX_HOME/agents/`, `.shipyard-manifest.json` | copy plus reconcile (`:356-635`) | runtime adapter reads the manifest (`codex-dispatch-adapter.cjs:271, 317-349`) |
| Install provenance record | `$CODEX_HOME/agents/.shipyard-provenance.json` | `host-provenance.cjs record` (`:803-811`) | doctor (`shipyard-doctor.cjs:396-397`) |
| Agent registrations, notify wrapper, delegate | `$CODEX_HOME/config.toml`, `shipyard-notify-delegate.json` | `merge-codex-config.cjs`, `configure-codex-notify.cjs` (`:490-498, 791-795`) | doctor |
| Route block | `$CODEX_HOME/AGENTS.md` | managed block (`:660-675`) | doctor `codex-route-block` |
| GSD capability | `${GSD_CAPABILITIES_DIR:-~/.gsd/capabilities}/delivery-pipeline` | `gsd-tools capability install` (`:641-653`) | — |
| Model-shaped defaults | `~/.gsd/defaults.json` | `gsd-tune --global --apply` (`:683-695`) | — |
| Skills | `$AGENTS_SKILLS_DIR` (default `~/.agents/skills`; marketplace: `$CODEX_HOME/shipyard-native-skills`) | `replace_dir` (`:699-714`) | — |

Marketplace bootstrap adds `$CODEX_HOME/shipyard-plugin/{capabilities.json, installed.json, install.lock, previous-skills-*}` (`bootstrap-shipyard-plugin.cjs:71-140`). The generated bundle manifest (`gen-codex-shipyard.cjs:360-388`) records `shipyard_version`, `policy_id/version/hash`, `capabilities_file`, `capabilities_digest`, `codexHome`, `scriptsRoot`, file lists and digests, `gsd_lib` and its digest.

Facts to carry forward:

- **Manifest location mismatch `[INFERENCE]`.** The manifest is written to the stage root (`gen-codex-shipyard.cjs:388`) and copied only to `$CODEX_HOME/agents/.shipyard-manifest.json` (`install-shipyard-codex.sh:356, 507`). `shipyard-doctor.cjs:317-373` reads `$CODEX_HOME/shipyard/manifest.json`. A `Grep` for `shipyard/manifest.json` and `'manifest.json'` over `tests/`, `scripts/`, `plugins/delivery-pipeline/scripts/` and `docs/` found no writer for that path, and no test runs the doctor against real installer output (the only doctor tests use a hand-made `$WORK/codex`, `tests/smoke/claude-hook-smoke.sh:86-113`). So the doctor's Codex bundle section may report "skip" on a real install. Next check in §12 (S2).
- **Capability bytes are carried, not synthesised.** "A policy-derived copy would claim support that was never measured" (`gen-codex-shipyard.cjs:352-354`); a bare install is refused and asserted (`tests/smoke/codex-shipyard-smoke.sh:145-155`). Any discovery design has to keep that stance (see §10).
- **Generated files** are never edited directly (`CLAUDE.md:76-81`); `plugins/shipyard/host/` is a generated copy. `diff -rq plugins/delivery-pipeline plugins/shipyard/host/plugins/delivery-pipeline` reports only `Only in plugins/delivery-pipeline/scripts: .claude` (E15), so source and generated copy are otherwise byte-identical at HEAD. I did not inspect that `.claude` directory (the command was denied, §14).

## 6. The local bookkeeping admission route and pre-existing history

Terminology (INV-015 already separates these): `.shipyard-provenance.json` under `$CODEX_HOME/agents` is the **install** provenance record. `.planning/graph/provenance/<dispatch_id>.json` is the **project-local dispatch sidecar**. Only the second is involved in the refusal.

### 6.1 Flow at HEAD

1. `recordInflight(input)` (`dispatch-record.cjs:1533-1555`) → `mutate(cwd, fn, undefined, true, localInflightBookkeeping(input, cwd))` (`:1307-1327`) → `authenticateBookkeeping(cwd, fn, ['.planning/graph/dispatches.json'], required)` (`:1294-1300`). The route is trusted if `required`, **or** `<project>/.shipyard-role-artifacts` exists, **or** `historicalBookkeepingPins(project)` is non-empty. Otherwise `fn()` runs unauthenticated.
2. `writeProvenanceOnce` (`:1564-1582`) writes one sidecar per dispatch id (`@invariant … never overwritten`, `:1563`) with the host stamp (`shipyard.host-provenance.v1`, `host-provenance.cjs:9`) plus `dispatch_id`, `ticket`, `role`, `recorded_at`; same `authenticateBookkeeping`, declared path `.planning/graph/provenance/<id>.json`.
3. `role-artifact.cjs:trustedBookkeepingMutation` (`:1808-1871`): catalogue lock (`:1874-1898`, live owner → `ARCHIVE_AUTHORITY_BUSY`) → `authorityState(worktree, true)` (`:1037-1065`: creates the private dir and `hmac.key`) → `previous = historicalBookkeepingPins` (`:1777-1792`; returns `[]` when `catalogue.json` is absent) → list `.planning/graph/provenance/*` → **refuse if any member is not in `previous`** (`:1826-1827`) → verify each pin's bytes and size (`:1828-1846`, `readPinnedArchiveFile` `:953-977`) → run the writer → re-verify undeclared pins (`:1850-1853`) → refuse undeclared new members (`:1855-1856`) → store `bookkeeping_state` pins (`:1857-1867`) → HMAC-sealed catalogue write (`:1794-1807`).
4. Authority location: `~/.local/state/shipyard/role-artifact-authority/<sha256(realpath worktree)>/{hmac.key, catalogue.json, architecture-sources-*, phase-archive-roster-*, planning-containment-*}` (`:984-1009, 1043-1052`).

### 6.2 What `d8a70dec` changed

E7: in the `d8a70dec` diff of `role-artifact.cjs`, `historicalBookkeepingPins`, `trustedBookkeepingMutation`, the rejection string and the two exports are all `+` lines. E6: the diff of `dispatch-record.cjs` adds `authenticateBookkeeping`, `localInflightBookkeeping`, the `authenticate` parameter of `mutate`, and the `writeProvenanceOnce` wrapper; the parent used a plain `withLock`. Nothing in that commit pins, quarantines or flags pre-existing files. The "legacy" branch in `trustedBookkeepingMutation` (`:1829-1843`) handles pins derived from `latest_bookkeeping` of an already-catalogued arch-review record (`:1782-1790`), not uncatalogued files on disk.

### 6.3 Behaviour matrix for pre-existing state

| State at launch | Result | Check |
|---|---|---|
| No catalogue, no sidecars | accepted; catalogue created | `LAUNCH-REFUSAL.md` table row "clean provenance"; unit `role-artifact.test.cjs:987-1016` |
| No catalogue, ≥1 sidecar, call is *required* | `ARCHIVE_AUTHORITY_INVALID` "unknown host provenance member before trusted mutation"; **authority dir and key created anyway** (`:1815` precedes `:1826`) | code; INV-015 reproduced it with 64 sidecars; the authority directory "was created at the refused launch" |
| Catalogue exists, a new or forged sidecar appears | same refusal | `tests/unit/role-artifact.test.cjs:1013-1014`; `tests/unit/dispatch-record.test.cjs` (`origin/main`, "after-forgery") |
| Catalogue exists, a pinned file's bytes change (including `dispatches.json`) | `ARCHIVE_AUTHORITY_INVALID` (…changed…) before the writer runs | `role-artifact.test.cjs:1008-1011`; `[INFERENCE]` `dispatches.json` is **tracked** (`git ls-files .planning/graph/dispatches.json` lists it, E16), so a `git pull`, `checkout` or rollback that rewrites it would trip the pin on the next trusted mutation. Not reproduced (S3). |
| Project moved or renamed, or `~/.local/state/shipyard/role-artifact-authority` removed | `[INFERENCE]` empty catalogue for the new realpath hash → same as row 2. Not reproduced. | `archiveAuthorityDirectory` `:1007-1009` |
| Call is not *required* and nothing is pinned | unauthenticated write; the new sidecar is **unpinned**, so a later required host refuses it | `:1297-1298`; this is the first-run defect fixed by #482 |

### 6.4 Which hosts are exposed

| Call site | Passes `worktree`? | *Required*? (HEAD) | On `origin/main` |
|---|---|---|---|
| `codex-delivery-host.cjs:1871-1878` | yes | iff `worktree == project realpath` (`dispatch-record.cjs:1302-1305`) | `inflightBookkeepingRequired` (`:1302-1308`): same, **or** provenance dir missing or empty |
| `claude-role-host.cjs:1350-1354` | yes | same | same |
| `claude-delivery-host.cjs:1133, 1141` | **no** | never | #482 adds `worktree` (E10) |
| `dispatch-record.cjs mark|clear` and other `mutate` callers | n/a | trusted only if a catalogue or pins already exist | unchanged |

So the legacy-history refusal is **not Codex-only**: `claude-role-host` (arch-review, integrator, sentinel) has the same exposure. `[UNKNOWN]` not reproduced on Claude (S1).

### 6.5 Existing "admit legacy" machinery

- `ARCHIVE_AUTHORITY_REQUIRED`, "archive catalogue is missing; explicit trusted legacy admission is required" (`role-artifact.cjs:1061`), points at `admitHistoricalArchive` (`:2050-2077`, export `:4021`). It requires an explicit `archives` inventory with receipts, manifest digests and retained pins (`validateHistoricalArchive`, `:1978-2048`), and refuses unknown membership (`:2038-2039, 2062-2063`). It covers **retained role archives**, not dispatch sidecars. `Grep admitHistoricalArchive` finds only the definition, the export and tests (`tests/unit/codex-arch-review-context.test.cjs:1036-1068`, `tests/unit/role-artifact.test.cjs:1041-1045`), and no CLI (E12). The `role-artifact.cjs` CLI exposes `seal`, `validate`, `read` only (`:3938-3981`).
- `grep -i migrat` over `plugins/delivery-pipeline/scripts` shows no migration of `.planning/graph` bookkeeping, authority catalogue, run store or writer-lease state. Existing precedents elsewhere: read-time normalisation of a legacy rollout flag with a `migrated_from` marker (`run-rollout.cjs:15, 138-161`), `gsd-tune.cjs --apply` migrating a legacy global runtime key (`:314-316, 655, 951`), and `planning-untrack.cjs`, which is a dry run unless `--confirm untrack-planning` is given (`Makefile:135-140`). These are facts, not recommendations.

### 6.6 Other persistent stores that an upgrade meets

| Store | Path | Version gate | On unknown or old |
|---|---|---|---|
| Sidecars | `.planning/graph/provenance/` (untracked; excluded by `.git/info/exclude:10` in this checkout) | none | see §6.3 |
| `dispatches.json`, `delivery-front.json` | `.planning/graph/` (`dispatches.json` tracked) | none | pinned after first trusted mutation |
| Authority catalogue and key | `~/.local/state/shipyard/role-artifact-authority/<hash>/` | `shipyard.role-archive-catalogue.v1` (`role-artifact.cjs:1053, 1062`) | key lost with catalogue present → `ARCHIVE_AUTHORITY_INVALID` (`:1045-1046`) |
| Run store | `~/.local/state/shipyard/codex/<sha256(run_id\0worktree)>/runs` (`codex-delivery-host.cjs:765-772, 1836-1840`) | `shipyard.run-store.v1` (`run-store.cjs:10, 266-268`) | `INVALID_STORE` "unknown schema". Each build mints a fresh run id (`deliver-dispatch.cjs:942, 1004`), so old runs probably do not block. `[UNKNOWN]` (§11). |
| Planning writer lease | `~/.local/state/shipyard/planning-writers/shared` (`planning-writer-lease.cjs:85-87`) | `shipyard.planning-writer-lease.v1` | `CORRUPT_STATE`; `LEGACY_WRITER_STATE` for unreleased private writer state (`:120-144`) |
| Receipts, transcripts | `<state dir>/receipts`, `transcripts` (`codex-delivery-host.cjs:1889-1890`) | recorder schema | — |
| Claude equivalents | `~/.local/state/shipyard/claude/…`, `claude-decompose/<hash>` (`claude-decompose-host.cjs:188-192`) | — | — |

### 6.7 Who treats a sidecar as evidence

`codex-arch-review-context.cjs:443-458` pins the **current** dispatch's `dispatches.json` and sidecar as host-owned bookkeeping and checks `row.host === 'codex'`, `row.pid === process.pid`, `provenance.dispatch_id/ticket/role`. `claude-role-host.cjs:1099-1109` digests the same files for round-owned file checks. `readProvenance` (`dispatch-record.cjs:1584`) has test callers only. So blanket-pinning old sidecars would feed them into the same pin logic that arch-review treats as host-owned evidence; this is the "legacy mistaken for verified" surface.

## 7. The phase + repository + ADR-digest binding: producers and consumers

### 7.1 Subject grammars in use

| # | Grammar | Producers | Consumers / validators | Shared definition? |
|---|---|---|---|---|
| S1 | `phase=<N>;input=<INV-id\|ADR-id>;repository=<repo>` (planning-input run subject) | `deliver-dispatch.cjs:986` (Codex decomposition builder) | `run-contract.cjs:233-236`; `dispatch-record.cjs:1503-1507` via `normalizeTicketIdentity`; packet identity `context-packet.cjs:523`, called from `codex-planning-context-host.cjs:76-79` | no (regex in `run-contract.cjs`) |
| S2 | seal subject. **HEAD:** `phase=<N>;repository=<repo>`. **`origin/main`:** `phase=<N>;repository=<repo>;adr=<64 hex>` | `codex-decompose-host.cjs:134-147`; `claude-decompose-host.cjs:166-186` | **HEAD:** `planning-result-sealer.cjs:239-258` accepts any non-empty subject. **`origin/main`:** `SUBJECT_PATTERN` (`:298`), `assertDecompositionSubject` (`:357-367`), `sealDecomposition(…, adr, adrBinding)` (`:375-381`) | **`origin/main`: yes**, `decompositionAdr` exported from `planning-result-sealer.cjs` and used by both hosts (E13) |
| S3 | integrator `phase=<N-name>;repository=<common-dir>;tickets=<64 hex>` | `claude-role-host.cjs:611-612` | `role-artifact.cjs:2790-2795`; `run-contract.cjs:228-231`; `dispatch-record.cjs:1509` | no — a template literal repeated in producer and consumer, with three different phase patterns: `(\d+)-name` (`run-contract.cjs:228`), `[A-Za-z0-9._-]+` (`dispatch-record.cjs:1509`), `(\d+-[A-Za-z0-9._-]+)` (`architecture-target.cjs:8`) |
| S4 | arch-review aggregate `phase=…;repository=…;tickets=…;pr=…;head=…;base=…` | `architecture-target.cjs:57-58` | `PHASE_SUBJECT` (`:8`), imported by `run-contract.cjs:229`, `dispatch-record.cjs:1500`, `role-artifact.cjs:1395, 1686, 1725, 1797`, `dispatch-boundary.cjs:1066`, `codex-arch-review-context.cjs` | **yes**, the only grammar with one definition and one builder |
| S5 | research `<INV-ID>:<line-id>` | host seal | `planning-result-sealer.cjs:54-57, 176-178` (`LINE_PATTERN`) | yes (sealer) |

### 7.2 Repository identity is built four ways

| Form | Where |
|---|---|
| lowercase GitHub `owner/repo` from `remote.origin.url`, else the project path | `deliver-dispatch.cjs:774-781` (`planningRepository`), used by the Codex planning builder |
| realpath of `git --git-common-dir` | `claude-decompose-host.cjs:129-131`; `claude-role-host.cjs:611` (`canonical.commonPath`); `role-artifact.cjs:243, 1387-1389, 1445-1446`; `codex-planning-context-host.cjs:251-258` |
| `scope.repository` string, or object `repository_id`/`id` | `codex-decompose-host.cjs:135-136, 1296-1298` |
| `realpath(worktree)` fallback | `codex-decompose-host.cjs:136` |

Consequence at HEAD: the same decomposition seals under `repository=<common dir>` on Claude and `repository=<owner/repo>` on Codex (code reading; not run), so a sealed result is not comparable across runtimes.

### 7.3 State at the packet revision versus `origin/main`

- **`d8a70dec`.** `commands/decompose.md:302, 312-314, 400` document `phase=<phase>;repository=<repo>;adr=<ADR digest>` and "a wrong phase or ADR digest … is a hard refusal". The hosts sealed without `adr=` and nothing checked an ADR identity. The fix commit says so: "Neither host built that subject … nothing checked an ADR identity at all, so a decomposition could be sealed for any ADR" (E14). The docs also name the builder packet subject as `phase=<N>;repository=<repo>;adr=<ADR digest>` (`:400`), whereas the builder emits `phase=;input=;repository=` (`deliver-dispatch.cjs:986`).
- **`origin/main`.** #486 (`78cdca26`, 2026-10-15) puts `resolveAdr` / `decompositionSubject` / `assertDecompositionSubject` in `planning-result-sealer.cjs`; both hosts call `decompositionSubject` and the builder supplies `adr` (`deliver-dispatch.cjs:1005-1011, 1052`). `planning-result-sealer.cjs` on `origin/main` is byte-identical to the unmerged branch `fix/bind-decomposition-to-adr` tip `1ea923a4` (E14). Research seals opt out with `adrBinding: 'none'` (`codex-decompose-host.cjs:193`).
- **What still diverges after #486.** The run-scope subject (S1, `…;input=…;repository=…`) and the seal subject (S2, `…;repository=…;adr=…`) are different grammars checked by different code (`run-contract.cjs:233` vs `planning-result-sealer.cjs:298`). Repository identity (§7.2) is still produced four ways. S3 is still two template literals.
- `[UNKNOWN]` the specific "earlier incident" in `PROBLEM.md:18` (date, command, refusal text). The text in `PROBLEM.md` could describe the absent-`adr=` case above or a mismatch between S1 and S2. Owner: user (§11).

## 8. Preflight and refusal surface

### 8.1 What exists

| Component | Checks | Wired where |
|---|---|---|
| `refusal-hints.cjs` | maps 16 codes to hint and remedy; default entry for the rest | printed by 4 hosts only (`tests/unit/refusal-hints.test.cjs:16-21` pins the four) |
| `host-verification.cjs` | verification of PLAN commands (admit, allow-list, sandbox run, evidence) | the executor candidate path in `codex-delivery-host.cjs`; not a launch preflight |
| `phase-integrator-preflight.cjs` | graph, plan set, merged-PR proofs, pinned epic for integrator | integrator launch |
| `sentinel-preflight.cjs` | fetch, divergence, dirty-outside-graph for the PR round | `deliver-dispatch.cjs launch --role pr-sentinel` only (`:332-339`) |
| `gsd-tune.cjs` | project config drift, model floors, Codex CLI version floors, `config.toml` registrations (`:694-940`) | operator command `make gsd-tune` |
| `make doctor` / `scripts/shipyard-doctor.cjs` | Claude hooks and bundle, Codex bundle (see F7 and §5), agents manifest file existence, provenance records, release-cache comparison | operator command; also `tests/live/live-round.sh:143`; **no capability, policy-hash, authority or sidecar checks** (E17, see the note below) |
| `codex-runtime-host.cjs --capability-only` | capability document shape, `codex --version`, `exec --help` markers | used by `tests/smoke/codex-runtime-smoke.sh:104`; a `Grep` for `capability-only` finds no command document that tells an operator to run it; always exits 0 |
| `run-rollout.cjs status\|probe --json` | runtime CLI login (`claude auth status --json`, `codex login status`; `:317-366`), presence of runtime files, and supplied *live* evidence of schema `shipyard.runtime-capability.v1` (`:219-286`, `:369-394`) | gates **autonomous controller launches** only; `commands/investigate.md:43-46` says it does not disable a command-issued run. It neither reads `CODEX_HOME` nor the host capability document, and returns `LIVE_PROBE_REQUIRED` without live evidence |

Note on E17: the count is of lines containing `capabilit` in `shipyard-doctor.cjs`. I read the whole file; all five lines (`:13, 221, 223, 226, 227`) belong to the source `capability.json` version comparison, not to a Codex capability-evidence check.

### 8.2 Refusals in this INV's chain and what the user is told

Hint map checked with E18 (loads `refusal-hints.cjs`, no side effects).

| Refusal | Source | `hint[...]` text the user sees | Supported remedy named? |
|---|---|---|---|
| `ARCHIVE_AUTHORITY_INVALID` (unknown host provenance member) | `role-artifact.cjs:1827` | default: "The host refused the request for a reason this map does not name. — remedy: Re-run the command and check the surrounding stderr" (quoted verbatim in `LAUNCH-REFUSAL.md`) | **No.** No supported recovery exists; the only one used was a manual, user-authorised archive-and-delete. |
| `ARCHIVE_AUTHORITY_REQUIRED` / `ARCHIVE_AUTHORITY_BUSY` | `role-artifact.cjs:1061, 1882-1908` | default | No |
| capability evidence missing | `codex-runtime-host.cjs:169` raises `RUNTIME_CAPABILITY_MISSING`; the probe flattens it to `unavailable/capability_evidence_missing` (`:179-183`); the host re-raises `RUNTIME_UNAVAILABLE` (`:1545-1549`) with the message prefixed twice | `RUNTIME_UNAVAILABLE`: "The runtime this host needs is not reachable right now. — remedy: Install and authenticate the runtime, then re-run." (`refusal-hints.cjs:53-56`) | **A remedy exists but does not match the cause.** It never mentions `SHIPYARD_CODEX_CAPABILITIES_FILE` or `CODEX_HOME`. `RUNTIME_CAPABILITY_MISSING` itself is unmapped. |
| `AMBIGUOUS_RUNTIME`, `UNKNOWN_RUNTIME`, `STALE_POLICY`, `RUNTIME_PROVIDER_MISMATCH`, `MISSING_ADAPTER`, `WRITER_FENCED`, `LEGACY_WRITER_STATE` | `runtime-context.cjs`, hosts, writer lease | default | No (E18) |
| `STALE_GENERATED_AGENT` | `codex-dispatch-adapter.cjs` | "Reinstall the generated agents: run make install-shipyard-codex" (`refusal-hints.cjs:57-60`) | Yes, but `make …` needs a Shipyard checkout; `CODEX_GENERATED_AGENT_FIX` names `install-shipyard-codex.sh --phase 2` (`:71`), which the README calls the legacy direct installer (`README.md:122-123`) |
| `CODEX_CONFIG_FIX` | `codex-model-remap.cjs` | remedy `node plugins/delivery-pipeline/scripts/gsd-tune.cjs --runtime codex --apply` (`:67`) | Yes, but the path is checkout-relative and not runnable from an installed bundle alone |
| `REFERENCE_UNAVAILABLE` | hosts | remedy `bash scripts/ensure-gsd-core.sh claude` (`:11`) | checkout-relative |

Other observations: `deliver-dispatch.cjs`, `claude-delivery-host.cjs`, `claude-role-host.cjs` and `codex-planning-context-host.cjs` print only the message. The `RUNTIME_UNAVAILABLE` message reads `codex-runtime-host: codex-runtime-host: explicit Codex capability evidence is required` because the error is wrapped twice (`codex-runtime-host.cjs:32-38, 182, 1549`; confirmed against the probe's single-prefix `detail` in E11-A and the doubled text in `LAUNCH-REFUSAL.md`).

## 9. Tests and e2e entry points

### 9.1 What exists

| Layer | Command | Relevant coverage |
|---|---|---|
| Unit (147 `*.test.cjs`) | `make test-unit` → `tests/unit/run.sh` (unsets `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX*`, but not `CODEX_HOME` or `SHIPYARD_CODEX_CAPABILITIES_FILE`) | `refusal-hints`, `runtime-context`, `role-artifact` (trusted bookkeeping `:987-1016`, legacy *archive* admission `:1018-1048`), `dispatch-record` (`:2181-2205` external graph history not admitted), `codex-runtime-host` (probe `:494-513`), `codex-agent`, `gen-codex-shipyard`, `marketplace-installer` (many `CODEX_HOME: undefined` cases for the **installer**) |
| Smoke | `make test-codex-shipyard` → `tests/smoke/codex-shipyard-smoke.sh` (installs with explicit capability env into a temp home; asserts bare install is refused `:145-155`; asserts the bundle carries the exact capability bytes `:140-143`); `make test-model-ladder-runtime`; `tests/smoke/codex-runtime-smoke.sh` (probe with `--capabilities-file`, `:104`) | installer-side |
| Acceptance | `tests/smoke/phase47-runtime-acceptance.cjs` | pins `SHIPYARD_CODEX_CAPABILITIES_FILE` explicitly (`:679`); uses an absolute handoff path under `~/.local/state/shipyard` (`:16`) |
| Live | `make test-live` → `tests/live/live-round.sh --runtime claude|codex` (needs `gh auth` and `SHIPYARD_LIVE_REPO`) | runs **source-tree** `plugins/delivery-pipeline/scripts` (`:5, 253, 265`) against a fresh fixture project; precondition `shipyard-doctor.cjs` (`:143`); ambient env for capabilities |
| Doctor | `make doctor` | `tests/smoke/claude-hook-smoke.sh:86-113` against a hand-made Codex dir only |

### 9.2 Results I obtained

E19: with `HOME` pointed at a temporary directory and the runtime and session variables unset, these existing unit files each exited `0`: `runtime-context` (16 passed, 0 failed), `planning-result-sealer` (27/0), `dispatch-record` (100/0), `role-artifact` (176/0), `codex-runtime-host` (48/0), `codex-agent` (30/0), `refusal-hints` (exit `0`; the `node:test` summary was not captured as a pass count). I did not run `make test`, `make test-fast`, the smoke scripts, or any network-backed test.

### 9.3 Gaps (all `H`, from the greps in §14)

- No test exercises `capabilitiesFrom`'s env or `CODEX_HOME` branches: the only probe test passes `capabilities` directly or `null` (`codex-runtime-host.test.cjs:494-513`). A `Grep` for `SHIPYARD_CODEX_CAPABILITIES_FILE|capabilitiesFile|capabilities-file` over `tests/` finds the variable only in installer, generator, smoke and acceptance files, and `--capabilities-file` in the `codex-agent` tests; none of the `codex-runtime-host`, `codex-delivery-host` or `codex-decompose-host` unit tests sets it.
- No test runs a host from a clean shell against the installed bundle, or with `CODEX_HOME` unset after an install.
- No test covers an upgrade with pre-existing sidecars and no catalogue. The nearest tests assert the refusal as intended behaviour once a catalogue exists, plus a "fresh first-run" case on `origin/main` only.
- No test runs `shipyard-doctor.cjs` against real installer output.
- The live round does not test the installed package and starts from an empty project.

Installed-package entry points that exist today: the marketplace skill and bootstrap (`ensure-gsd-core.sh --launch-bootstrap`), the installed bundle scripts under `$CODEX_HOME/shipyard/scripts/` (what INV-015 ran), and `plugins/shipyard/host/` inside the package. Dogfood installs live under `~/.local/state/shipyard/dogfood/{claude,codex}/<hash>` and coexist with the tagged release (`docs/audits/2026-10-03-phase47-launch-fix.md:8-9`).

## 10. Known warts, consolidated

1. Required-vs-optional home: capability lookup demands `CODEX_HOME`; everything else defaults it (§4.1 #1 vs #2).
2. Three capability-file locations; no runtime reader checks the manifest digest (F3).
3. `codex-agent.cjs` and the delivery host's `installedAgentOptions` cannot read the installed capability copy.
4. The probe CLI exits 0 on failure (`codex-runtime-host.cjs:1679`).
5. Capability failure is reported as `RUNTIME_UNAVAILABLE` with an "install and authenticate" remedy.
6. A double `codex-runtime-host:` prefix in the message.
7. Refusal remedies are checkout-relative (`make …`, `bash scripts/…`, `node plugins/…`) while the supported install is a package.
8. A refused trusted mutation leaves an authority dir and key behind (`role-artifact.cjs:1815`).
9. `ARCHIVE_AUTHORITY_REQUIRED` names a legacy-admission path with no CLI and no coverage of sidecars.
10. Doctor ignores `CODEX_HOME`, and its Codex bundle path may not match the installer layout (`[INFERENCE]`).
11. Opposite `CLAUDE_HOME` / `CLAUDE_CONFIG_DIR` precedence between two installers (§4.2).
12. Three home sources for host state (`userInfo().homedir`, `os.homedir()`, `HOME`).
13. The dogfood home formula is written three times; dogfood asks the user to export `CODEX_HOME`.
14. Bootstrap marker short-circuit does not refresh capabilities after a Codex CLI change (`[INFERENCE]`).
15. `commands/decompose.md` promised a binding that was not implemented at the packet revision (F6).
16. Subject grammars and repository identity forms are implemented separately (§7).
17. `[INFERENCE]` The strict routed runtime resolver fails on mixed session env, and the bundle-path marker cannot identify a dogfood home.
18. The word "capability" names two unrelated documents: the Codex host evidence (`supportedModels`/`supportedEfforts`, read by the runtime host and the installer) and `shipyard.runtime-capability.v1` live evidence (`run-rollout.cjs`). A refusal that says "capability" does not say which one.

## 11. Constraints observed (seeds for line 3)

Each carries its source. These are observations, not decisions.

- **Provenance, receipts and host admission must not be bypassed**; legacy files must not be silently trusted; no runtime or provider switch; ADR-014 unchanged (`PROBLEM.md` out-of-scope list; `CLAUDE.md:94`; `commands/investigate.md:47-56`: an unavailable host "cannot switch to the peer"). H.
- **No model-policy changes.** `CLAUDE.md:88-103`. H.
- **Capability evidence must be explicit host evidence, never synthesised from policy** (`gen-codex-shipyard.cjs:352-354`, `install-shipyard-codex.sh:315-318`, smoke `:145-155`, `CLAUDE.md:105-108`). The marketplace bootstrap does derive it from `codex debug models` (`bootstrap-shipyard-plugin.cjs:104-111`), so "explicit" currently includes a measured CLI catalogue. M.
- **Generated outputs are not edited directly**; edit the canonical script, then `make package-shipyard-codex` (`CLAUDE.md:76-81`). The runtime-file digest pin changes only via `make refresh-runtime-digests` and its trailer (`CLAUDE.md:133-134`). H.
- **Hint text must not propose bypass, skip, direct run, runtime switch or the stop-gate kill switch** (`tests/unit/refusal-hints.test.cjs:75-81`); the four-host list and the required-codes list are pinned by that test. H.
- **Host-owned writer and lease, and state outside the model worktree** (`commands/investigate.md:58-71`; `codex-delivery-host.cjs:1404`). H.
- **`tests/smoke/docs-smoke.sh` is the contract for the supported host workflow** (`CLAUDE.md:59-62`); the README must change with the supported install flow (`CLAUDE.md:132`). H.

## 12. Unknowns, as open-question drafts

- [ ] Which build is installed in `~/.codex/shipyard` and in the Codex plugin cache (version, `package-build.json` digest, bundle line numbers)? Next check: `node scripts/shipyard-doctor.cjs --json` and `cat ~/.codex/shipyard-plugin/installed.json`. — owner: user (read access to `~/.codex`)
- [ ] Do `~/.codex/shipyard/codex-capabilities.json` and `~/.codex/shipyard-plugin/capabilities.json` exist on the user's machine, and is `CODEX_HOME` set in the Codex session's tool environment? Next check: `ls -l` both files and `env | grep -E '^(CODEX|SHIPYARD|GSD)'` from inside a real Codex session. — owner: user
- [ ] Which exact incident is "the ADR-digest producer/consumer mismatch" (date, command, refusal text)? It may be the absent `adr=` binding fixed by #486 or an S1-vs-S2 grammar mismatch. — owner: user
- [ ] Is the local `origin/main` ref current, and did anything after `be7ab4f3` touch the sites above? Next check: `git fetch origin && git log --oneline main..origin/main`. — owner: operator with network access
- [ ] Does the legacy-sidecar refusal reproduce through `claude-role-host` (arch-review, integrator, sentinel) on Claude with pre-existing sidecars and no catalogue? — owner: research (spike S1)
- [ ] Does a change to tracked `dispatches.json` after catalogue creation (git pull, checkout, rollback) refuse the next trusted mutation? — owner: research (spike S3)
- [ ] Does moving or renaming a project, or removing `~/.local/state/shipyard/role-artifact-authority`, reproduce the refusal? — owner: research (spike S3)
- [ ] Does the doctor's Codex bundle section ever find `manifest.json` after a real install? — owner: research (spike S2)
- [ ] Do old run-store or writer-lease records ever block a new launch, and is there an upgrade path for `shipyard.run-store.v1`? Next check: read `run-controller.cjs` handling of `INVALID_STORE`, and test with an old-schema file. — owner: research
- [ ] Which environment variables does the Codex CLI set for tool subprocesses (`CODEX_HOME`, `CODEX_SANDBOX*`)? — owner: user / Codex documentation
- [ ] Does the resolver's mixed-environment conflict (`AMBIGUOUS_RUNTIME`) occur in real dual-runtime sessions? Next check: run the probe and `pipeline-config.cjs resolve --json` under combined env. — owner: research
- [ ] What is the untracked `plugins/delivery-pipeline/scripts/.claude` directory seen in the parity diff (E15)? Next check: `ls -A` and `git check-ignore -v` on it. — owner: operator

## 13. Recommended spikes (not performed, per the shared rules)

- **S1** `/gsd-spike "reproduce the legacy-sidecar refusal on the v0.72.2 build: scratch project, scratch HOME, N pre-existing sidecars, no catalogue; drive codex-delivery-host and claude-role-host"` — turns F4/F5 from code reading plus INV-015's reproduction into this INV's own evidence for both runtimes.
- **S2** `/gsd-spike "scratch marketplace install with a stubbed codex debug models; run shipyard-doctor, the capability probe and a host from the default home with no env"` — settles the manifest-path question, F2 on an installed bundle, and stale-snapshot behaviour after a CLI change.
- **S3** `/gsd-spike "after the first trusted mutation: git checkout of tracked dispatches.json, rename the project directory, delete the authority directory"` — measures the rollback and move hazards in §6.3.
- **S4** `/gsd-spike "which home does the bundle-path marker resolve for a dogfood bundle, and what does resolveDispatchContext do under mixed session env"` — settles §4.3.

## 14. Evidence log

Commands were run from `/Volumes/KINGSTON/claude-shipyard` in zsh. "Read" and "Grep" are the file tools. I report exit statuses only where captured directly.

| ID | Command | Result |
|---|---|---|
| E1 | `git rev-parse HEAD` | `d8a70decb32e5420fb69f8eebc17be08e82d6d86` |
| E2 | `git status --short -- plugins scripts Makefile tests capabilities \| wc -l` | `0` (no change under code dirs; only `.planning` and `docs` paths differ from HEAD) |
| E3 | `git for-each-ref --format='%(refname:short) %(objectname:short) %(committerdate:iso)' refs/heads/main refs/remotes/origin/main`; `git rev-list --count main..origin/main`; `git rev-list --count origin/main..main` | `main d8a70dec 2026-10-09`; `origin/main be7ab4f3 2026-10-15`; `9`; `0` |
| E4 | `git log --format='%h %ad %s' --date=short main..origin/main`; `git diff --stat main origin/main -- plugins/delivery-pipeline scripts Makefile capabilities` | nine commits: #456, #480, #481, #482, #483, #484, #486, #485, #487. 27 source files changed. |
| E5 | `git tag -l 'v0.7*' --sort=-creatordate`; `git log -1 --format='%h' <tag>^{commit}`; `git merge-base --is-ancestor <tag> origin/main\|main` | `v0.72.0`→`9415c1e7`, `v0.72.1`→`76653dfa`, `v0.72.2`→`be7ab4f3`; all three are ancestors of `origin/main`; `v0.72.0` is **not** an ancestor of `main`; `v0.71.0` is |
| E6 | `git diff d8a70dec^ d8a70dec -- plugins/delivery-pipeline/scripts/dispatch-record.cjs` | adds `authenticateBookkeeping`, `localInflightBookkeeping`, `mutate(…, authenticate)`, wrapped `writeProvenanceOnce`; parent used plain `withLock` |
| E7 | `git diff d8a70dec^ d8a70dec -- plugins/delivery-pipeline/scripts/role-artifact.cjs \| grep -n "^[-+].*\(trustedBookkeepingMutation\|historicalBookkeepingPins\|unknown host provenance member\|bookkeeping_state\)"` | only `+` lines: functions at diff lines 947, 978; rejection at 997; exports at 1620-1621 |
| E8 | `git merge-base --is-ancestor d8a70dec main; echo $?` | `0` |
| E9 | loop over `d8a70dec c7633d9e 91d2b643 3cdac993 9415c1e7 8c080373 e89817d6 78cdca26 76653dfa be7ab4f3`: `git show <c>:…/role-artifact.cjs \| grep -n 'unknown host provenance member before'` and `…/dispatch-record.cjs \| grep -n '^function authenticateBookkeeping'` | rejection at line `1827` for `d8a70dec`, `3955` for all later commits; `authenticateBookkeeping` at `1294` for all. Plugin version `0.71.0` at `d8a70dec`, `0.72.0` at `91d2b643`, `0.72.1` at `76653dfa` |
| E10 | `git diff main origin/main -- plugins/delivery-pipeline/scripts/dispatch-record.cjs`; `git show 9415c1e7 -- …/claude-delivery-host.cjs …/codex-runtime-host.cjs \| grep '^[-+]'` | `localInflightBookkeeping` → `inflightBookkeepingRequired` (adds the missing-or-empty provenance case); #482 adds `worktree` to the Claude delivery host's in-flight input |
| E11 | with `HOME=<temp>`, `CODEX_HOME`, `SHIPYARD_CODEX_CAPABILITIES_FILE`, `CODEX_SANDBOX*`, `CLAUDE_*` unset and a fixture `<temp>/.codex/shipyard/codex-capabilities.json`: `node plugins/delivery-pipeline/scripts/codex-runtime-host.cjs --capability-only` (A: no env; B: `CODEX_HOME=<temp>/.codex`; C: `--capabilities-file <fixture>`) | A: `status":"unavailable","reason":"capability_evidence_missing","detail":"codex-runtime-host: explicit Codex capability evidence is required"`; B and C: `status":"available"` with `codex-cli 0.162.1`; all three exited `0` |
| E12 | `Grep admitHistoricalArchive`, `ARCHIVE_AUTHORITY_REQUIRED` over the repo (`*.cjs,*.sh,*.md,*.json,*.yml`) | definition `role-artifact.cjs:2050`, export `:4021`, error at `:1061`; callers only in `tests/unit/codex-arch-review-context.test.cjs` and `tests/unit/role-artifact.test.cjs` |
| E13 | `git show origin/main:plugins/delivery-pipeline/scripts/planning-result-sealer.cjs \| grep -n adr`; same for both decompose hosts and `deliver-dispatch.cjs` | `SUBJECT_PATTERN` `:298`, `decompositionAdr` `:370`, `sealDecomposition` `:375-381`; both hosts import it; builder passes `adr` |
| E14 | `git log --oneline main..fix/bind-decomposition-to-adr`; `git merge-base --is-ancestor fix/bind-decomposition-to-adr main; echo $?`; `git show --stat 1ea923a4`; `git diff --quiet 1ea923a4 origin/main -- …/planning-result-sealer.cjs` | branch is 7 commits ahead of `main`; not an ancestor (`1`); commit message quoted in §7.3; sealer identical to `origin/main` |
| E15 | `diff -rq plugins/delivery-pipeline plugins/shipyard/host/plugins/delivery-pipeline; echo $?` | `Only in plugins/delivery-pipeline/scripts: .claude`; exit `1`. `plugins/shipyard/package-build.json` version `0.71.0+codex.b319402d6ef6389f` |
| E16 | `ls .planning/graph/provenance \| wc -l`; `git ls-files .planning/graph/provenance \| wc -l`; `git check-ignore -v .planning/graph/provenance/x.json`; `git ls-files .planning/graph/dispatches.json`; `ls -d .shipyard-role-artifacts` | `2` (count only; names not listed); `0` tracked; excluded by `.git/info/exclude:10`; `dispatches.json` tracked; `.shipyard-role-artifacts` absent |
| E17 | `Grep -c capabilit scripts/shipyard-doctor.cjs` (case-insensitive) | `5`; every hit is the source `capability.json` version check (`:13, 223-228`), confirmed by reading the whole file |
| E18 | `node -e` loading `refusal-hints.cjs`, printing `Object.keys(HINTS)` and whether `hintFor(code)` is a mapped entry | 16 mapped codes. Unmapped (default entry): `RUNTIME_CAPABILITY_MISSING`, `ARCHIVE_AUTHORITY_INVALID`, `ARCHIVE_AUTHORITY_REQUIRED`, `AMBIGUOUS_RUNTIME`, `UNKNOWN_RUNTIME`, `WRITER_FENCED`, `MISSING_ADAPTER`, `RUNTIME_PROVIDER_MISMATCH`, `STALE_POLICY`. Mapped: `UNSUPPORTED_SELECTION` |
| E19 | for `refusal-hints runtime-context planning-result-sealer dispatch-record role-artifact codex-runtime-host codex-agent`: `node tests/unit/<name>.test.cjs` under a temp `HOME` and temp git config | each exit `0`; counts in §9.2 |
| E20 | `git ls-files 'tests/unit/*.test.cjs' \| wc -l`; `git ls-files tests/unit \| wc -l` | `147`; `152` |

Other reads: the `Read` tool on the files cited in §3–§9; `Grep` for `SHIPYARD_CODEX_CAPABILITIES_FILE|CODEX_HOME|codex-capabilities.json`, `formatHint|hintFor|refusal-hints`, `recordInflight\(|clearInflight\(`, `migrat`, `\.shipyard-role-artifacts`, `readProvenance`, `subject`, `shipyard/manifest\.json`, `capability-only`, `ROLE_BUCKETS|function parseLaunchArgs`, `function validateHistoricalArchive`.

### Limits and what was blocked

- **Installed tree unreadable.** `Read /Users/serhii/.codex/shipyard/scripts/dispatch-record.cjs` was refused: "outside /Volumes/KINGSTON/claude-shipyard; --restricted confines the file tools". `~/.codex`, `~/.local/state/shipyard` and the authority directories were not read or changed, as the research contract requires. Every statement about installed bytes is `[UNKNOWN]` or `[INFERENCE]`.
- **Two shell commands were denied by the harness** and not retried: a `sed -n` over the installer scripts (I used `Read` instead), and `git grep … d8a70dec^ -- <path>` (I used `git diff` and `git show` instead). A third, combined command (inspect the untracked `.claude` directory, then delete my scratch directory) was denied for needing approval.
- **Scratch directory left behind.** `/tmp/claude-502/inv017-home.OyGKtt` holds my fixture (`.codex/shipyard/codex-capabilities.json`), a temp git config, the unit-test output files and a `.local/state` tree the tests created under the temporary `HOME`. It contains no user data and is safe to delete. I could not delete it.
- **Provenance dir.** The only read of `.planning/graph/provenance` was a count (`ls | wc -l` → 2); names and contents were not listed or opened.
- **Not run:** `make test`, `make test-fast`, any smoke or live script, the installers, `git fetch`, any network call. No claim here depends on them.
- **Not executed, only read:** the mixed-environment `AMBIGUOUS_RUNTIME` path, the bundle-path marker on a dogfood path, the `dispatches.json` pin hazard, the project-move case, and the cross-runtime repository-identity difference.
