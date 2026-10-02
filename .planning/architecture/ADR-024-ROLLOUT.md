# ADR-024 rollout, HOLD, and rollback procedure

- **Status:** Operational procedure for P46; not an activation record
- **Decision source:** accepted [ADR-024 model ladder](ADR-024-model-ladder-refresh.md)
- **Applies to:** isolated Codex and Claude validation homes only
- **Owners:** T-46-05 supplies package provenance; T-46-06 supplies real native receipts and HOLD evidence; the ADR-023 D6 owner retains outer activation

## Decision and boundary

Install and validate a reviewed ADR-024 package in a dedicated home for one
runtime at a time. This document defines evidence and rollback requirements; it
does not authorize changes to an operator's active Codex or Claude home, a
running controller, or outer coordination policy. Do not activate D6 here.

Keep the accepted source, package, installed files, native receipt, and review
record linked by immutable identifiers. A vendor announcement, account model
list, CLI capability list, or successful process exit establishes
discoverability or command completion only. It does not prove that a Shipyard
dispatch applied the requested model and effort.

## 1. Pin the source and package

Before installing, record all of the following in the rollout evidence:

1. Source root, `git rev-parse HEAD`, `git status --porcelain`, plugin version
   from `plugins/delivery-pipeline/.claude-plugin/plugin.json`, policy version,
   and policy fingerprint.
2. Install kind (`release` or `dogfood`), source SHA, dirty state, and source
   root from `.shipyard-provenance.json` using the existing
   `shipyard.host-provenance.v1` fields. A dirty source is dogfood and must
   remain explicitly marked dirty; the commit SHA alone does not identify
   uncommitted content.
3. The exact package artifact and its SHA-256. For the Codex package, also
   record `package-build.json`'s version and `digest`; the package digest binds
   the generated Codex package content. Never treat a version string by itself
   as a content digest.
4. The source-to-package mapping and the installed package tree or manifest
   digest. A reviewer must be able to reproduce the package from that pinned
   source or compare its installed files with the retained package artifact.

The marketplace installer derives the source version, commit, tag, and dirty
state. It accepts a clean tag-matching Claude release source; use the direct
dogfood procedure below for an untagged or dirty Claude checkout. Retain the
installer's provenance fields alongside the package SHA and installed
identity, rather than replacing one with another.

## 2. Prepare a verified candidate envelope before any installation

Use an absolute, dedicated `SHIPYARD_ISOLATION_ROOT` outside active runtime,
cache, defaults and controller state. CODEX_HOME or CLAUDE_CONFIG_DIR alone
cannot isolate GSD: the dependency writes through Node's native `os.homedir()`.
The shared owner `ensure-gsd-core.sh --isolation-env` is read-only: it checks
physical ancestors, unsafe aliases/file kinds/hardlinks, all declared writable
destinations and the exact Node executable's actual child OS home and temp path.
It returns JSON or refuses before mkdir, npm/npx, marketplace calls or tuning.

The verified environment supplies a private child HOME, npm cache/prefix/config,
XDG config/cache/data/state, temporary state, skills and capability destinations.
Absent defaults become candidate-owned; explicit destinations outside the
envelope refuse. Source, project and actual capability evidence are read-only
inputs that may be outside it. No active credentials or authentication files
are copied. This is a supported-dependency destination contract, not a kernel
sandbox or a guarantee for arbitrary packages. If a dependency requires a fixed
shared path, refuse; never run it and restore shared state afterward.

The following procedure is for a later operator-controlled installation, not
an instruction to execute installers during T-46-08 source verification. Set
absolute retained source/project/capability inputs and a unique candidate path:

```bash
: "${SOURCE_ROOT:?Set the absolute reviewed Shipyard checkout}"
: "${PROJECT_DIR:?Set the absolute existing target project}"
: "${SHIPYARD_ISOLATION_ROOT:?Set an absolute dedicated candidate envelope}"
[[ "$SOURCE_ROOT" = /* && -d "$SOURCE_ROOT" && "$PROJECT_DIR" = /* && -d "$PROJECT_DIR" ]] || exit 1
[[ "$SHIPYARD_ISOLATION_ROOT" = /* ]] || exit 1
candidate_run() {
  local runtime="$1"
  shift
  node - "$SOURCE_ROOT" "$runtime" "$SHIPYARD_ISOLATION_ROOT" "$@" <<'NODE'
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [source, runtime, root, executable, ...argv] = process.argv.slice(2);
const guard = spawnSync('/bin/bash', [path.join(source, 'scripts/ensure-gsd-core.sh'),
  '--isolation-env', runtime, root], { env: process.env, encoding: 'utf8' });
if (guard.error || guard.status !== 0) {
  process.stderr.write(guard.stderr || 'candidate preflight failed'); process.exit(guard.status || 1);
}
const environment = JSON.parse(guard.stdout).environment;
const result = spawnSync(executable, argv, { env: { ...process.env, ...environment }, stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
NODE
}
```

Set any inherited runtime/defaults/skills/capability/npm/XDG/temporary overrides to candidate paths, or remove
those overrides in a subshell so the guard can supply its defaults. The guard
never silently ignores an explicitly escaping destination. Preserve unrelated
NODE_OPTIONS; if its native-home behavior defeats the contract, stop on refusal.
An untrusted success marker cannot replace child-entry revalidation.

### Codex direct and marketplace

Both supported paths use the same selected runtime home and prepared child
HOME. Each child revalidates before its own state/lock/installation mutation,
including matching-core, auto-install-disabled and bootstrap early-return paths.
Original active-home exclusions apply before HOME is rebased.

```bash
(
  export SHIPYARD_ISOLATION_ROOT
  export CODEX_HOME="$SHIPYARD_ISOLATION_ROOT/codex"
  : "${SHIPYARD_CODEX_CAPABILITIES_FILE:?Set the absolute actual host capability evidence file}"
  [[ "$SHIPYARD_CODEX_CAPABILITIES_FILE" = /* && -r "$SHIPYARD_CODEX_CAPABILITIES_FILE" ]] || exit 1
  export SHIPYARD_CODEX_CAPABILITIES_FILE SHIPYARD_PROJECT_DIR="$PROJECT_DIR"
  candidate_run codex /bin/bash "$SOURCE_ROOT/scripts/install-shipyard-codex.sh" --project-dir "$PROJECT_DIR"
)
```

For a direct dogfood root, choose a fresh target outside the originally active
Codex home, export CODEX_HOME to that selected target and SHIPYARD_INSTALL_KIND
to `dogfood`; do not use --dogfood-root equal to the originally active home.
For the alternative marketplace path, use a separate fresh envelope and run:

```bash
(
  export SHIPYARD_ISOLATION_ROOT CODEX_HOME="$SHIPYARD_ISOLATION_ROOT/codex"
  export SHIPYARD_PROJECT_DIR="$PROJECT_DIR"
  candidate_run codex bash "$SOURCE_ROOT/scripts/ensure-gsd-core.sh" --launch-marketplace codex --source "$SOURCE_ROOT"
)
```

Do not synthesize capabilities from ADR-024. Marketplace bootstrap requires an
enabled plugin and a matching installed package-build identity. Any isolated
dependency or tuning failure is fatal. Ordinary active release installation
retains its established destinations and optional-failure policy.

### Claude standalone dependency and dogfood

Claude's multi-directory layout requires the explicit bounded envelope. An
ambiguous isolated config/dogfood invocation refuses before copying a plugin,
writing provenance or settings. Keep both config overrides consistent:

```bash
(
  export SHIPYARD_ISOLATION_ROOT
  export CLAUDE_CONFIG_DIR="$SHIPYARD_ISOLATION_ROOT/claude/config"
  export CLAUDE_HOME="$CLAUDE_CONFIG_DIR"
  CLAUDE_DOGFOOD_PLUGIN="$SHIPYARD_ISOLATION_ROOT/claude/plugins/shipyard/<package-id>"
  candidate_run claude /bin/bash "$SOURCE_ROOT/scripts/ensure-gsd-core.sh" claude || exit 1
  SHIPYARD_GSD_AUTO_INSTALL=0 candidate_run claude /bin/bash "$SOURCE_ROOT/scripts/install-shipyard-claude-hook.sh" --dogfood-root "$CLAUDE_DOGFOOD_PLUGIN" || exit 1
)
```

Without --wire-hooks, dogfood preparation exits before dependency setup and
leaves hook settings unchanged; it does not replace the explicit dependency
step. Optional --wire-hooks may write only the verified candidate config.
Unreleased Claude marketplace sources still refuse. Supported release
marketplace setup propagates the same environment through dependency, hooks
and capability installation. Native authentication and launches are a separate
T-46-06/operator action; normal OS HOME plus isolated config/Keychain is not
proof of candidate OS-home authentication. Fresh redacted dedicated-home status
(`claude-authenticated-dedicated-home-status.json`, auth exit 0/loggedIn true)
now establishes Claude candidate OS-profile authentication via a dedicated
isolated Keychain, with active default/search metadata and shared defaults unchanged.
Both OS profiles are authenticated; all eight native pairs, rollback rehearsal,
final release live-round and activation remain HOLD. No credential copying is permitted.

The controlled source attempt at `3eea0e4d58e327970c5a70aa3e498317a79d88ae`
recorded Codex install 0, Claude dependency 0 and Claude hook 3: the read-only
guard rejected a legitimate npm-created contained `.bin/anthropic-ai-sdk` link.
Shared approved defaults were unchanged at every stage. Requested core 1.14.0
was installed, while the actually discovered Claude marketplace dependency was
1.15.0; do not treat the marketplace as pinned to 1.14.0.
The continuation permits only npm executable links in `node_modules/.bin` whose
every intermediate symlink hop and path component stays within the subtree;
final regular file targets have one hardlink and stay physically within
the same `node_modules` subtree inside the candidate npm cache/prefix, candidate
`npm`, or physically contained candidate Codex/Claude runtime plugin caches.
This permits contained npm executable links only; it does not permit general
plugin-cache aliases or links escaping those subtrees. Other symlinks
and outside/dangling/cyclic/directory/active-state/hardlink hazards still refuse
before writes. The earlier npm-cache-only correction was subsequently tested as recorded below; the later plugin-cache installation succeeded at `6a33b2ae`; the current hook change awaits coordinator
execution; the earlier workaround and failed hook remain historical.
The owned global tuner child still performs the real `codex --version` floor
probe. That native CLI can leave `CODEX_HOME/tmp/arg0/codex-arg0<suffix>`
helpers pointing to its external executable. Before the next parent scan/write,
`run_isolated_tuner` captures pre-child parent/leaf identities and the resolved
native CLI binary and its PATH alias-chain identities, then unlinks only newly created `apply_patch`, `applypatch`
and `codex-execve-wrapper` symlink leaves targeting that same binary. Parents
and the captured CLI alias chain must remain unchanged. Parents
must remain physically inside the candidate, owned directories without writable
shared permissions or aliases. The target is never modified. Existing,
repointed, unknown or shim-targeted aliases refuse; the initial shared guard
continues to reject escaping CLI aliases. Both Codex and Claude tuner invocations
use this lifecycle boundary; marketplace/bootstrap reach it through the direct
installer. This is bounded installer-owned cleanup, not a kernel sandbox or a
claim of total race safety. Other child-created aliases still refuse. The failed
`e99a8782` real update remains failed; the coordinator owns the subsequent retry.

Candidate Codex staging and Claude hook verification use explicit templates
under the validated TMPDIR, because BSD/macOS mktemp can ignore TMPDIR when
no template is supplied. Ordinary active installation keeps its default temporary
directory behavior. The exported Codex marketplace entry validates and prepares
the candidate environment before its first CLI read.

Retain redacted-only status filenames `codex-authenticated-status.json`,
`claude-authenticated-normal-home-status.json`, and
`claude-authenticated-dedicated-home-status.json`; never retain credentials,
passwords or Keychain contents in this proof.

Preserve former package/provenance/checksums. Stop if an existing target has
foreign ownership, unsafe aliases or cannot satisfy the boundary. See the
[retained proof](../../docs/audits/phase46/2026-10-01-isolated-native-rollout-proof.md)
for the original violation, approved baseline, historical workaround and HOLD.

## 3. Verify installed identity before dispatch

Compare these records before making a native model call:

| Evidence | Codex | Claude Code |
|---|---|---|
| Runtime identity | `codex plugin list --json`: enabled `pluginId` `shipyard@shipyard`, installed version, and matching cache entry | `claude plugin list --json`: enabled `id` `shipyard@shipyard` for a marketplace install, or the exact version in `<plugin-root>/.claude-plugin/plugin.json` for `--plugin-dir` |
| Package identity | Installed cache `package-build.json` version and `digest`; compare with retained artifact | Installed plugin version plus retained package SHA-256 and installed-tree/manifest digest |
| Generated/installed manifest | `$CODEX_HOME/agents/.shipyard-manifest.json` and the installed `shipyard/manifest.json`; confirm each listed agent exists and its selection matches policy | Installed plugin manifest, exact plugin root, and any package manifest produced by the release builder |
| Host provenance | `$CODEX_HOME/agents/.shipyard-provenance.json` | `<plugin-root>/.shipyard-provenance.json` |

The provenance sidecar is `.shipyard-provenance.json` with schema
`shipyard.host-provenance.v1`; compare `install_kind`, `version`, `source_sha`,
`dirty`, and optional `source_root` to the pinned source record. Check package
digest separately: provenance identifies where an install came from, while the
package digest identifies what was installed. A missing, malformed, stale, or
contradictory identity is HOLD.

## 4. Require same-session native application evidence

T-46-06 must exercise a real Shipyard dispatch in the isolated host after the
installed identity passes. Retain one durable dispatch record and its linked
native application evidence with the same dispatch/session identity. It must
contain distinct values for:

```text
requested.model      requested.effort
applied.model        applied.effort
observed.model       observed.effort
```

Also retain runtime, role, task level/rung, policy version and fingerprint,
fired policy signals, launch ID, application receipt, and the native evidence
that binds the observation to that same session. Requested values must not be
copied into applied or observed fields. If the host cannot expose an observed
selection, record that limitation and HOLD; a capability declaration, picker
entry, model list, prompt statement, or process exit is not a substitute.

Review the selected pair and signal against the current table in
`docs/gsd_multilevel_delivery_pipeline.md` and the accepted model ADR. A repair
promotion needs the immediately preceding rung's boundary-verified receipt and
`previous_dispatch_id`. When a model-axis escalation's host capability
assessment is unsupported or unknown, the boundary may select only the
immediately preceding policy rung in the same runtime. This also covers Claude
Sonnet→Opus escalations, not only Opus→Fable: for example, research
Opus/high (`very-complex`) falls back to Sonnet/xhigh (`base`). The selected
fallback must pass final pair validation and a fresh dispatch's application
verification; an earlier receipt cannot prove the new dispatch. The resolution
records the capability assessment and requested versus fallback pairs. A repair
fallback to `repeat` or `repeat_exhausted` requires that fallback rung's own
authenticated predecessor; the current boundary refuses it with
`UNSUPPORTED_REPAIR_FALLBACK` rather than manufacturing or reusing that authority.
Ordinary unsupported final pairs still refuse. A Claude Fable selection needs the measured-window
signal and existing `pipeline.fable: auto` consent; fallback never bypasses
that consent check. An independent reviewer
who did not prepare the package must compare the source, package, installed
identity, matrix, and same-session receipt before any operator decision.

## 5. HOLD conditions and ownership

HOLD rollout and make no global change if any of these conditions applies:

- source commit, dirty state, package SHA-256, package-build digest, installed
  manifest, plugin ID/version, or provenance sidecar is absent or mismatched;
- a required model/effort selection is unsupported by the isolated host, the
  installed generated agent is stale, or the host applies a different pair;
- requested, applied, or observed receipt fields are missing, disagree, or do
  not refer to the same native session and application receipt;
- a promotion signal lacks its trusted source, preceding receipt, or required
  consent; or scope is uncertain and the role has no permitted promotion;
- independent review has not accepted the source/package/install/receipt chain.

Existing old-policy in-flight dispatches stay owned by the package and policy
fingerprint with which they started. Let their existing owner finish and retain
their records under that fingerprint. Do not switch policy mid-session, stop or
relaunch a controller to force adoption, rewrite a historical receipt, or
retroactively label an old run as ADR-024. A clean new dispatch is the only
application proof for the candidate.

## 6. Roll back to the prior reviewed package

Before a rollout, record the prior reviewed package's source SHA, version,
package SHA-256/build digest, installed manifest identity, and isolated target
path. Keep that package available while the candidate is under review.

On HOLD, stop admitting new candidate dispatches. Leave in-flight work with its
original owner, home, package, and policy. Restore into the same isolated
runtime home only after it is quiescent: all sessions and dispatches using that
home have finished, and no controller can admit new work there. If work is
still in flight, install the prior reviewed version into a separate fresh
isolated runtime home for future work; leave the original home and package
untouched until those sessions finish. Use the retained prior source/package only through the section-2 guarded
procedure, with the same verified child OS HOME and bounded destinations.
The prior reviewed installer must support the read-only --isolation-env guard;
if it does not, HOLD and obtain a reviewed guard-bearing rollback package
rather than executing its unsafe dependency setup. For Codex, set the chosen
fresh/quiescent envelope and CODEX_HOME and use candidate_run with either direct
or marketplace installation. For Claude, set that envelope and both config
overrides, run the guarded standalone dependency step, then prepare a new
versioned dogfood root with candidate_run. Check prior installed identity,
package digest and provenance before admitting work. An unexecuted procedure
or archived prior identity is not a successful rollback rehearsal.

Rollback changes only which package future isolated dispatches load. Preserve
the candidate package, HOLD reason, prior/new checksums, all dispatch records,
and both review decisions. This procedure has no global fallback and does not
change ADR-023's D6 ownership.

## Handoff

- **T-46-05:** retain the source/package SHA-256, package-build digest where
  available, version/tag/dirty provenance, installed identity, and immutable
  prior-reviewed rollback target.
- **T-46-06:** produce real same-session requested/applied/observed native
  receipts for supported candidate selections; record HOLD for any missing or
  mismatched evidence. Do not synthesize live model evidence.
- **Operator and independent reviewer:** decide only after both dependency
  slices and the checklist above are complete. The ADR-023 D6 owner alone
  decides any outer activation.

Earlier actual controlled source `cbf11a60841a1a9228267ba01cb6b02e64fe856a`
(signed by the trusted host, per operator report) ran a fresh full installation:
Codex 0, Claude dependency 0, Claude hook 3 on
`claude/config/plugins/cache/gsd-core/gsd-core/1.15.0/node_modules/.bin/acorn`.
All three redacted attempts record shared defaults unchanged. The previous npm
cache correction therefore did not complete the actual plugin-cache hook path.
The current guard includes candidate runtime plugin caches and requires the fully
resolved single-link regular executable to stay in its own physical dependency
`node_modules` subtree. External Codex `tmp/arg0` shims remain forbidden.
Only redacted `attempts.json` and `claude-install.log` were read for this latest
observation; no other fresh installation, authentication or credential artifact
was read. The later corrected plugin-cache installation succeeded at source `6a33b2ae`, as recorded below; this earlier failed attempt remains historical evidence.

## Latest retained successful installation and current review boundary

Latest retained controlled installation used source `6a33b2ae1a8cf8884c4336e01170a1c6ed2ea158`: Codex installation, Claude dependency and Claude plugin preparation all exited 0, with shared defaults unchanged in all three records. Evidence: `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-plugin-links-fresh-20261002/attempts.json` (1790 bytes, SHA-256 `ddb3b2aafa05cab7e6be472d81d3e79333f2f41514cbb0fe3278c0533873cb92`). The redacted durable index `/tmp/phase46-full-auth-success-install-durable.json` reports archive SHA-256 `cd3f525c362bda711e5a948b5d0dd4c2dfa568e5af0d5094201359675eb35de2`; the archive itself was not opened. Authentication and profile readiness are already true per retained operator evidence; they do not establish complete native-pair receipts. Installed Codex source `dad21495143a5b4e06fe1ecd5aa2e4eee56be9e3` is a separate later identity verified read-only from `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-candidate/agents/.shipyard-provenance.json` (`source_sha` matches and `dirty: false`), not the source of the historical three-stage result. The hook change in this review round has not undergone a fresh actual installation; that check is coordinator-owned. All eight complete native pairs, rollback rehearsal, live release round, release, operator checkpoint and activation remain HOLD.

### Isolated child execution environment

Isolated installation supports empty `NODE_OPTIONS`, `--no-warnings` and
`--trace-warnings` only. Other options refuse explicitly before the shared
preflight launches Node; they are never silently removed. In particular,
`--require`, `--import` and loader options can run code during otherwise
read-only validators, CLI lists, metadata readers and guard/parsing children.
Their exit handlers can invalidate checked paths before parent writes or cache
consumption. Ordinary active installation retains its inherited environment.
Use a separate invocation with a supported environment to install a candidate.

The installer also revalidates after bundle validation and after the marketplace
plugin list, before consuming the installed cache bootstrap. This does not
sandbox arbitrary malicious parent code or dependencies, or provide total race
safety against concurrent filesystem replacement. Existing verified isolated
CLI-version helpers, npm links and temporary templates retain their supported
checks; preload refusal does not relax alias validation. Native authentication,
application and operator rollout remain HOLD.

### Supported startup boundary

For isolated marketplace setup use `bash "$SOURCE_ROOT/scripts/ensure-gsd-core.sh" --launch-marketplace codex --source "$SOURCE_ROOT"` or the same command with `claude`, under the candidate environment above. Rollback marketplace setup uses this same shell entry with the reviewed rollback source. The fixed launcher validates NODE_OPTIONS before launching its sibling Node installer. Empty options, `--no-warnings` and `--trace-warnings` are supported and retained; all other options refuse with exit 3 before Node starts.

Packaged SessionStart and all six skill bootstrap instructions use `bash "${PLUGIN_ROOT}/host/scripts/ensure-gsd-core.sh" --launch-bootstrap` (skills resolve their absolute plugin root first). Cached marketplace bootstrap uses that same fixed mode. This protects bootstrap startup, not the already-running host process. Direct external `node scripts/install-shipyard-marketplace.cjs` or `node .../bootstrap-shipyard-plugin.cjs` with a malicious preload is unsupported for candidate isolation: preloads execute before JavaScript guards. Exported trusted JS helpers cannot retroactively isolate their parent. This does not sandbox arbitrary parent code, dependencies or concurrent filesystem replacements.

The require/import evaluation-and-exit write regressions are hermetic fixture evidence only. They do not relabel the retained successful 6a33b2ae installation or authentication readiness as shell-launcher installation proof. Complete native pairs, rollback rehearsal and operator activation remain HOLD.

The published local preparation sequence starts with `make package-shipyard-codex`.
That fixed Make recipe imports `scripts/ensure-gsd-core.sh --library` and calls
`validate_isolated_node_options` in the same shell before its package-generator
Node command. `make install-shipyard-codex` reuses that guarded prerequisite.
The README dogfood sequence also uses a Node-based Make root calculation; it
imports the same library and validates before that calculation starts Node.
Neither path clears NODE_OPTIONS or adds a third launcher mode. Direct external
package-generator Node startup has the same unsupported-preloaded-parent limit.
The process regression executes all three primary README/CLAUDE marketplace
examples and the package/local-install/two release-marketplace Make targets in
disposable checkout fixtures. Require/import evaluation-and-exit writers are
refused with complete package/candidate/outside snapshots unchanged; direct-Node
controls demonstrate the writers work. Safe package generation, ordinary release
setup and the published local route use real package/installer processes with
fixture dependency and CLI responses. These checks are fixture evidence only;
retained real installation/authentication records and native/operator HOLDs above
remain separate.
