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

## 2. Create isolated runtime homes

Use a unique path outside each runtime's active home and keep the prior
reviewed package at a separate immutable path. Do not copy active credentials,
reuse a release cache, wire global hooks, change shared runtime defaults, or
install both runtime variants into one home. Authenticate the isolated host
separately when native application evidence is ready.

### Codex

For the marketplace package path, select an explicit source-scoped Codex home
and invoke the existing installer from the pinned source:

```bash
SOURCE_ROOT="$(pwd -P)"
CODEX_DOGFOOD_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/shipyard/dogfood/codex/<source-id>"
CODEX_HOME="$CODEX_DOGFOOD_HOME" \
  node "$SOURCE_ROOT/scripts/install-shipyard-marketplace.cjs" codex --source "$SOURCE_ROOT"
```

`<source-id>` must distinguish this source from every other candidate. The
marketplace installer propagates the selected `CODEX_HOME`, checks for the
enabled `shipyard@shipyard` plugin, and requires the installed
`plugins/cache/shipyard/shipyard/<version>/package-build.json` before bootstrapping
the host. If validating the direct generated-bundle path instead, use the
installer that owns that layout:

```bash
: "${SHIPYARD_CODEX_CAPABILITIES_FILE:?Set this to the actual host capability evidence file}"
[[ -f "$SHIPYARD_CODEX_CAPABILITIES_FILE" && -r "$SHIPYARD_CODEX_CAPABILITIES_FILE" ]] || exit 1
SHIPYARD_CODEX_CAPABILITIES_FILE="$SHIPYARD_CODEX_CAPABILITIES_FILE" \
  bash "$SOURCE_ROOT/scripts/install-shipyard-codex.sh" \
  --dogfood-root "$CODEX_DOGFOOD_HOME" --project-dir "$PROJECT_DIR"
```

Do not point `CODEX_HOME` at the shared default. Supply the host's actual
capability evidence through `SHIPYARD_CODEX_CAPABILITIES_FILE` before running
the direct command; this readable file is mandatory. Never synthesize supported
models or efforts from ADR-024.

### Claude Code

Set the documented Claude CLI config directory and the hook installer's home
override to the same isolated config root. Use a versioned dogfood plugin root
so a later candidate cannot erase the prior reviewed files:

```bash
SOURCE_ROOT="$(pwd -P)"
CLAUDE_DOGFOOD_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/shipyard/dogfood/claude/<source-id>"
CLAUDE_PLUGIN_ROOT="$CLAUDE_DOGFOOD_HOME/plugins/shipyard/<package-id>"
CLAUDE_CONFIG_DIR="$CLAUDE_DOGFOOD_HOME/config" \
CLAUDE_HOME="$CLAUDE_DOGFOOD_HOME/config" \
  bash "$SOURCE_ROOT/scripts/ensure-gsd-core.sh" claude || exit 1
CLAUDE_CONFIG_DIR="$CLAUDE_DOGFOOD_HOME/config" \
CLAUDE_HOME="$CLAUDE_DOGFOOD_HOME/config" \
SHIPYARD_GSD_AUTO_INSTALL=0 \
  bash "$SOURCE_ROOT/scripts/install-shipyard-claude-hook.sh" \
    --dogfood-root "$CLAUDE_PLUGIN_ROOT"
CLAUDE_CONFIG_DIR="$CLAUDE_DOGFOOD_HOME/config" \
  claude --plugin-dir "$CLAUDE_PLUGIN_ROOT"
```

The explicit `ensure-gsd-core.sh claude` step installs the GSD payload and
runs `ensure-gsd-plugin.cjs` in the fresh isolated config: it registers
`open-gsd/gsd-core`, installs `gsd-core@gsd-core`, and verifies that dependency
is enabled before launch. Stop if setup fails. The dogfood hook installer
returns before its GSD setup without `--wire-hooks`, and
`SHIPYARD_GSD_AUTO_INSTALL=0` disables its automatic setup; neither replaces
this explicit dependency step.

Claude Code supports loading a development plugin directly from a folder with
`--plugin-dir`; see the [official plugin documentation](https://code.claude.com/docs/en/plugins).
The dogfood-root path must be outside
`$CLAUDE_HOME/plugins/cache`; the installer refuses a target inside that cache
and records `.shipyard-provenance.json` beside the copied plugin. Without
`--wire-hooks`, this command prepares the isolated plugin root and leaves hook
settings unchanged. `CLAUDE_CONFIG_DIR` selects the CLI's isolated settings,
credentials, session history, and plugin store; see the [Claude Code environment
variable reference](https://code.claude.com/docs/en/env-vars#variables). The
installer's `CLAUDE_HOME` is its hook/config destination, so keeping both
variables on the isolated root prevents that override from being mistaken for
runtime isolation.

For either runtime, stop and choose a new versioned target if the install path
already contains files without matching Shipyard provenance. Preserve the
former package and its checksums; do not overwrite it to save space.

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
`previous_dispatch_id`. A Claude Fable selection needs the measured-window
signal and existing `pipeline.fable: auto` consent. An independent reviewer
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
untouched until those sessions finish. Use the retained source/package and
that runtime's existing installer against the chosen quiescent or fresh target. For Codex, run the prior source's
`install-shipyard-marketplace.cjs codex --source <prior-source>` with the chosen
dedicated `CODEX_HOME`, or run its `install-shipyard-codex.sh` against the
dedicated `--dogfood-root` and a readable actual host
`SHIPYARD_CODEX_CAPABILITIES_FILE`. For Claude, prepare a new versioned `--dogfood-root`
from the prior reviewed source with `CLAUDE_HOME` and `CLAUDE_CONFIG_DIR` still
pointing at the chosen isolated config directory. For a fresh config, run the
prior source's `ensure-gsd-core.sh claude` with both overrides as in section 2
and stop on failure before launch. Then launch that exact root with
`claude --plugin-dir`. Confirm the prior installed identity and package digest
before allowing new work.

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
