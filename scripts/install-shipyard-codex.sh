#!/usr/bin/env bash
set -euo pipefail

# install-shipyard-codex.sh — install the shipyard delivery conveyor onto an
# OpenAI Codex CLI setup on the host.
#
# Generates Codex-native artifacts from the canonical Claude plugin
# (plugins/delivery-pipeline/), places them non-destructively, and registers the
# runtime-agnostic GSD capability that contributes the blocking Gate 2 (ticket
# graph) and UAT gates. The Docker image is NOT involved — this is a host tool.
#
# Prerequisites:
#   - node on PATH
#   - gsd-core already installed for Codex:
#       npx --yes @opengsd/gsd-core@latest --codex --global
#
# Environment overrides:
#   CODEX_HOME         Codex config home (default: ~/.codex)
#   AGENTS_SKILLS_DIR  Codex/cursor/cline skills dir (default: ~/.agents/skills)
#   SHIPYARD_CODEX_PHASE  1 = investigate+decompose only; 2 = + deliver (default 2)
#   SHIPYARD_PROJECT_DIR  conveyor project root whose .planning/config.json is read
#
# Usage: bash scripts/install-shipyard-codex.sh [--phase 1|2] [--project-dir <dir>]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/delivery-pipeline"
CAP_SRC="$REPO_ROOT/capabilities/delivery-pipeline"
PHASE="${SHIPYARD_CODEX_PHASE:-2}"
PROJECT_DIR="${SHIPYARD_PROJECT_DIR:-$REPO_ROOT}"

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
BUNDLE_ROOT="$CODEX_HOME/shipyard"
GSD_TOOLS="$CODEX_HOME/gsd-core/bin/gsd-tools.cjs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:?}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:?}"; shift 2 ;;
    -h | --help) sed -n '3,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── preconditions ────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
[[ -d "$PLUGIN_DIR" ]] || { echo "error: plugin dir missing: $PLUGIN_DIR" >&2; exit 1; }
[[ -d "$CAP_SRC" ]] || { echo "error: capability dir missing: $CAP_SRC" >&2; exit 1; }
[[ -d "$PROJECT_DIR" ]] || { echo "error: project dir missing: $PROJECT_DIR" >&2; exit 1; }
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
# gsd-core is a hard dependency here — the generator cannot convert a command
# without it — so install/refresh it rather than telling the user to. Default is
# the latest: shipyard is a superstructure over GSD, and pinning the base while
# the superstructure moves is what left three different versions on one machine,
# with the Codex generator reading the oldest of them. SHIPYARD_GSD_AUTO_INSTALL=0
# opts out; GSD_CORE_VERSION pins.
if [[ "${SHIPYARD_GSD_AUTO_INSTALL:-1}" != "0" ]]; then
  bash "$REPO_ROOT/scripts/ensure-gsd-core.sh" codex
fi

if [[ ! -f "$GSD_TOOLS" ]]; then
  echo "error: gsd-core for Codex not found at $GSD_TOOLS" >&2
  echo "       install it first:" >&2
  echo "       npx --yes @opengsd/gsd-core@latest --codex --global" >&2
  echo "       (or re-run this installer with a network — it installs it for you)" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
ROLLBACK_ACTIVE=0
cleanup() {
  local status="${1:-0}"
  if [[ "$status" -ne 0 && "$ROLLBACK_ACTIVE" == 1 ]]; then
    echo "error: install failed after mutating installer-owned state; restoring the previous set" >&2
    restore_runtime_paths 2>/dev/null || echo "warning: runtime artifact rollback was incomplete; inspect ${AGENTS_SKILLS:-$HOME/.agents/skills}, ${BUNDLE_ROOT:-$CODEX_HOME/shipyard}, ${AGENTS_MD:-$CODEX_HOME/AGENTS.md} and ${CAPABILITY_TARGET:-${GSD_CAPABILITIES_ROOT:-$HOME/.gsd/capabilities}/delivery-pipeline}" >&2
    restore_config 2>/dev/null || echo "warning: config rollback was incomplete; inspect ${CONFIG_TARGET:-$CODEX_HOME/config.toml}" >&2
    restore_agents 2>/dev/null || echo "warning: agent rollback was incomplete; inspect ${AGENTS_DIR:-$CODEX_HOME/agents}" >&2
  fi
  rm -rf "$STAGE"
  trap - EXIT
  exit "$status"
}
restore_agents() {
  local index="${AGENT_BACKUP_INDEX:-}"
  local backup="${AGENT_BACKUP:-}"
  local state name target restore_status=0
  if [[ -n "$index" && -f "$index" && -n "$backup" && -n "${AGENTS_DIR:-}" ]]; then
    while IFS=$'\t' read -r state name; do
      [[ -n "$name" ]] || continue
      target="$AGENTS_DIR/$name"
      rm -rf "$target" || restore_status=1
      if [[ "$state" == present ]]; then
        cp -a "$backup/$name" "$target" || restore_status=1
      fi
    done < "$index"
  fi
  if [[ -n "${AGENT_MANIFEST_TARGET:-}" ]]; then
    rm -rf "$AGENT_MANIFEST_TARGET" || restore_status=1
    if [[ "${AGENT_MANIFEST_PREEXISTED:-0}" == 1 ]]; then
      cp -a "$AGENT_MANIFEST_BACKUP" "$AGENT_MANIFEST_TARGET" || restore_status=1
    fi
  fi
  if [[ "${AGENTS_DIR_PREEXISTED:-0}" == 0 ]]; then
    rmdir "$AGENTS_DIR" 2>/dev/null || true
  fi
  return "$restore_status"
}
restore_runtime_paths() {
  local index="${RUNTIME_BACKUP_INDEX:-}"
  local backup="${RUNTIME_BACKUP:-}"
  local state kind name target restore_status=0 backup_path restore_tmp copy_status
  [[ -n "$index" && -f "$index" && -n "$backup" ]] || return 0
  while IFS=$'\t' read -r state kind name target; do
    [[ -n "$kind" && -n "$name" ]] || continue
    if [[ -z "$target" ]]; then
      case "$kind" in
        bundle) target="$BUNDLE_ROOT" ;;
        skill) target="$AGENTS_SKILLS/$name" ;;
        capability) target="${CAPABILITY_TARGET:-${GSD_CAPABILITIES_ROOT:-$HOME/.gsd/capabilities}/$name}" ;;
        agents-md) target="${AGENTS_MD:-$CODEX_HOME/AGENTS.md}" ;;
        gsd-defaults) target="${GSD_DEFAULTS:-${GSD_DEFAULTS_PATH:-$HOME/.gsd/defaults.json}}" ;;
        *) continue ;;
      esac
    fi
    backup_path="$backup/$(runtime_backup_key "$target")"
    rm -rf "$target" || restore_status=1
    if [[ "$state" == present ]]; then
      mkdir -p "$(dirname "$target")" || restore_status=1
      restore_tmp="${target}.restore-$$"
      rm -rf "$restore_tmp" || restore_status=1
      copy_status=0
      if [[ -L "$backup_path" || ! -d "$backup_path" ]]; then
        cp -a "$backup_path" "$restore_tmp" || copy_status=1
      else
        mkdir -p "$restore_tmp" || copy_status=1
        cp -a "$backup_path/." "$restore_tmp/" || copy_status=1
      fi
      rm -rf "$target" || copy_status=1
      if [[ "$copy_status" == 0 ]] && mv "$restore_tmp" "$target"; then
        :
      else
        restore_status=1
        rm -rf "$restore_tmp" 2>/dev/null || true
      fi
    fi
  done < "$index"
  return "$restore_status"
}
restore_config() {
  local restore_status=0
  [[ -n "${CONFIG_PREEXISTED:-}" && -n "${CONFIG_TARGET:-}" ]] || return 0
  if [[ "${CONFIG_PREEXISTED:-0}" == 1 ]]; then
    cp -p "$CONFIG_BACKUP" "$CONFIG_TARGET" || restore_status=1
  else
    rm -f "$CONFIG_TARGET" || restore_status=1
  fi
  return "$restore_status"
}
replace_dir() {
  local src="$1" target="$2" label="$3"
  local tmp="${target}.tmp-$$" backup="${target}.bak-$$" had_target=0 status=0
  rm -rf "$tmp" "$backup"
  # Preserve executable bits and symlinks while staging the replacement. The
  # staged directory becomes the live target with one rename, so copying it
  # without archive semantics can silently change the installed bundle.
  cp -a "$src" "$tmp" || return $?
  if [[ -e "$target" || -L "$target" ]]; then
    mv "$target" "$backup" || return $?
    had_target=1
  fi
  if mv "$tmp" "$target"; then
    rm -rf "$backup"
    return 0
  else
    status=$?
  fi
  if [[ "$had_target" == 1 ]]; then
    if mv "$backup" "$target"; then
      rm -rf "$tmp"
    else
      echo "warning: could not restore previous $label at $target" >&2
    fi
  elif [[ -e "$tmp" || -L "$tmp" ]]; then
    rm -rf "$tmp"
  fi
  return "$status"
}
runtime_backup_key() {
  node -e "const crypto=require('crypto');process.stdout.write(crypto.createHash('sha256').update(process.argv[1]).digest('hex'))" "$1"
}
snapshot_runtime_path() {
  local kind="$1" name="$2" target="$3"
  local state=absent backup_path
  case "$target" in
    *$'\t'* | *$'\n'*)
      echo "error: refusing to snapshot a runtime path whose name cannot be recorded safely: $target" >&2
      exit 1
      ;;
  esac
  if awk -F '\t' -v target="$target" '$4 == target { found=1; exit } END { exit found ? 0 : 1 }' "$RUNTIME_BACKUP_INDEX"; then
    return 0
  fi
  backup_path="$RUNTIME_BACKUP/$(runtime_backup_key "$target")"
  if [[ -e "$target" || -L "$target" ]]; then
    mkdir -p "$(dirname "$backup_path")"
    cp -a "$target" "$backup_path"
    state=present
  fi
  printf '%s\t%s\t%s\t%s\n' "$state" "$kind" "$name" "$target" >> "$RUNTIME_BACKUP_INDEX"
}
trap 'cleanup $?' EXIT
OUT="$STAGE/bundle-out"
RUNTIME_BACKUP="$STAGE/runtime-before"
RUNTIME_BACKUP_INDEX="$STAGE/runtime-before.tsv"
mkdir -p "$RUNTIME_BACKUP"
: > "$RUNTIME_BACKUP_INDEX"

# ── generate ─────────────────────────────────────────────────────────────────
echo "→ generating Codex bundle (phase $PHASE)…"
# Keep the runtime in the process context. Do not persist it into the shared
# project/global GSD config: the same checkout may be driven by Claude next.
GSD_RUNTIME=codex SHIPYARD_RUNTIME=codex node "$REPO_ROOT/scripts/gen-codex-shipyard.cjs" \
  --plugin "$PLUGIN_DIR" --out "$OUT" \
  --codex-home "$CODEX_HOME" --bundle-root "$BUNDLE_ROOT" --phase "$PHASE" \
  --project-dir "$PROJECT_DIR"

# ── skills + bundle install LAST ───────────────────────────────────────────────
# Keep both staged until agent/config/capability/AGENTS.md have succeeded, so a
# failure in those earlier steps cannot leave a partially updated runtime bundle.

# ── agents + non-destructive config.toml merge ───────────────────────────────
#
# AN INSTALLER OWNS WHAT IT WROTE (ADR-007 D5).
#
# The bundle above is replaced wholesale, so it cannot go stale by omission.
# `$CODEX_HOME/agents/` cannot be treated that way — the operator writes into
# that directory too — so the copy stays a copy and the PREVIOUS run's own
# manifest says what to take back. Without that, a shrunk palette or a dropped
# `-deep` variant leaves an agent file behind forever and "the file exists"
# certifies nothing: measured by running the real generator twice, at two Codex
# CLI versions, then applying this copy-over — four `-deep` files the second
# generation does not contain survived it.
#
# Ownership is the MANIFEST's, never the `shipyard-` prefix's. A glob over that
# name passes every other assertion this reconciliation has and deletes an agent
# the operator wrote by hand, which is the one outcome worth being slow about.
AGENT_MANIFEST_NAME=".shipyard-manifest.json"
if compgen -G "$OUT/agents/*.toml" >/dev/null; then
  echo "→ installing agents → $CODEX_HOME/agents"
  ROLLBACK_ACTIVE=1
  AGENTS_DIR="$CODEX_HOME/agents"
  AGENTS_DIR_PREEXISTED=0
  [[ -d "$AGENTS_DIR" ]] && AGENTS_DIR_PREEXISTED=1
  mkdir -p "$AGENTS_DIR"

  # Agent files and config.toml are one installation unit. The merge helper is
  # atomic for the config itself, but copying the files first would still leave
  # a fresh set beside the old registrations when validation rejects the
  # config. Snapshot only the generated names (the operator's other agents are
  # outside this installer's ownership) and restore those names on either copy
  # or merge failure. The successful path reaches the reconciliation only after
  # both halves have committed.
  AGENT_BACKUP="$STAGE/agents-before"
  AGENT_BACKUP_INDEX="$STAGE/agents-before.tsv"
  CONFIG_TARGET="$CODEX_HOME/config.toml"
  CONFIG_BACKUP="$STAGE/config-before.toml"
  AGENT_MANIFEST_TARGET="$AGENTS_DIR/$AGENT_MANIFEST_NAME"
  AGENT_MANIFEST_BACKUP="$STAGE/manifest-before.json"
  AGENT_MANIFEST_PREEXISTED=0
  CONFIG_PREEXISTED=0
  if [[ -e "$CONFIG_TARGET" || -L "$CONFIG_TARGET" ]]; then
    cp -p "$CONFIG_TARGET" "$CONFIG_BACKUP"
    CONFIG_PREEXISTED=1
  fi
  if [[ -e "$AGENT_MANIFEST_TARGET" || -L "$AGENT_MANIFEST_TARGET" ]]; then
    cp -a "$AGENT_MANIFEST_TARGET" "$AGENT_MANIFEST_BACKUP"
    AGENT_MANIFEST_PREEXISTED=1
  fi
  mkdir -p "$AGENT_BACKUP"
  : > "$AGENT_BACKUP_INDEX"

  # Snapshot every file the PREVIOUS manifest claims before reconciliation.
  # The current bundle may stop emitting a variant, so looking only at this
  # run's names leaves an old claimed file with no rollback copy. Invalid or
  # unsafe manifest entries are ignored here, exactly as the reconciler refuses
  # to act on them; the manifest itself is always backed up above.
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    target="$AGENTS_DIR/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      cp -a "$target" "$AGENT_BACKUP/$name"
      printf 'present\t%s\n' "$name" >> "$AGENT_BACKUP_INDEX"
    else
      printf 'absent\t%s\n' "$name" >> "$AGENT_BACKUP_INDEX"
    fi
  done < <(
    SHIPYARD_PREV_MANIFEST="$AGENT_MANIFEST_TARGET" node - <<'NODE'
const fs = require('fs');
const file = process.env.SHIPYARD_PREV_MANIFEST;
try {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const safe = /^shipyard-[A-Za-z0-9._-]*\.toml$/;
  if (manifest && Array.isArray(manifest.agent_files)) {
    for (const name of new Set(manifest.agent_files)) {
      if (typeof name === 'string' && safe.test(name)) process.stdout.write(`${name}\n`);
    }
  }
} catch { /* no trustworthy previous claim: reconcile conservatively */ }
NODE
  )

  snapshot_agent() {
    local source="$1" name target
    name="$(basename "$source")"
    if grep -Fqx $'present\t'"$name" "$AGENT_BACKUP_INDEX" \
      || grep -Fqx $'absent\t'"$name" "$AGENT_BACKUP_INDEX"; then
      return 0
    fi
    target="$AGENTS_DIR/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" || -L "$target" ]] || {
        echo "error: refusing to replace non-file agent target: $target" >&2
        exit 1
      }
      cp -a "$target" "$AGENT_BACKUP/$name"
      printf 'present\t%s\n' "$name" >> "$AGENT_BACKUP_INDEX"
    else
      printf 'absent\t%s\n' "$name" >> "$AGENT_BACKUP_INDEX"
    fi
  }
  for source in "$OUT"/agents/*.toml; do
    snapshot_agent "$source"
  done

  if cp "$OUT"/agents/*.toml "$AGENTS_DIR/"; then
    :
  else
    status=$?
    echo "error: could not install generated agent files; restoring the previous set" >&2
    exit "$status"
  fi

  echo "→ merging agent registrations → $CODEX_HOME/config.toml"
  if node "$REPO_ROOT/scripts/merge-codex-config.cjs" \
    --config "$CONFIG_TARGET" --fragment "$OUT/config.fragment.toml"; then
    :
  else
    status=$?
    echo "error: config merge failed; restoring the previous agent and config set" >&2
    exit "$status"
  fi
  # AFTER the merge, deliberately. Both halves are committed before this
  # reconciliation starts. The merge strips every `[agents.shipyard-*]` table
  # and the whole fenced fragment before writing the fresh one, so an orphan's
  # registration is already gone by the time its file is removed. A file whose
  # registration is gone is inert; a registration whose file is gone is ruled
  # out by the transaction above.
  echo "→ reconciling agent files this installer previously wrote"
  SHIPYARD_AGENTS_DIR="$CODEX_HOME/agents" \
  SHIPYARD_NEW_MANIFEST="$OUT/manifest.json" \
  SHIPYARD_MANIFEST_NAME="$AGENT_MANIFEST_NAME" \
  node - <<'NODE'
const fs = require('fs');
const path = require('path');

const dir = process.env.SHIPYARD_AGENTS_DIR;
const manifestName = process.env.SHIPYARD_MANIFEST_NAME;
const nextPath = process.env.SHIPYARD_NEW_MANIFEST;
const prevPath = path.join(dir, manifestName);
const say = (m) => process.stdout.write(`  ${m}\n`);

const read = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

// A name this installer may act on at all: one path segment, our own prefix,
// one extension. A manifest is a file on disk like any other, so an entry that
// is not a plain basename is refused rather than resolved — `path.join` would
// walk `../` out of this directory without complaint.
const OURS = /^shipyard-[A-Za-z0-9._-]*\.toml$/;
const actionable = (e) => typeof e === 'string' && path.basename(e) === e && OURS.test(e);

// THIS run's claim first, and nothing happens without it. An unreadable new
// manifest would otherwise mean "this install claims nothing", which turns
// every file the previous run wrote into an orphan — a mass delete produced by
// a failed read. There is no state in which that is the right answer.
//
// The SHAPE of the claim is checked here too, not only the previous run's
// entries: `claimed` licenses every removal below by set membership, so an
// entry in THIS manifest that is not a plain `shipyard-*.toml` basename could
// never protect the real file it was meant to name — a typo'd or truncated
// `agent_files` array would silently widen what counts as an orphan. Reading
// that as "no manifest" is the same conservative floor as an unreadable file.
const next = read(nextPath);
const nextOk = next && Array.isArray(next.agent_files) && next.agent_files.every(actionable);
if (!nextOk) {
  say(`this run produced no trustworthy manifest (${nextPath}) — removing nothing`);
  process.exit(0);
}
const claimed = new Set(next.agent_files);

const prev = read(prevPath);
// An older shipyard wrote a manifest with no `agent_files` key. It is a record
// that claims nothing, which is the same standing as no record at all: it is
// not evidence that a file is ours.
if (!prev || !Array.isArray(prev.agent_files)) {
  // NO PREVIOUS MANIFEST IS NOT LICENCE TO SWEEP. A first install, or an
  // install over a hand-made ~/.codex, removes nothing — the alternative
  // deletes an operator's own agents — and names what it is leaving alone,
  // because silence here reads as "there was nothing there".
  let unclaimed = [];
  try {
    unclaimed = fs.readdirSync(dir).filter((f) => f.endsWith('.toml') && !claimed.has(f)).sort();
  } catch { /* the directory was created a moment ago */ }
  say(
    unclaimed.length
      ? `no manifest from a previous install (${manifestName}) — removing nothing. `
        + `Leaving alone: ${unclaimed.join(', ')}`
      : `no manifest from a previous install (${manifestName}) — nothing to reconcile`,
  );
} else {
  const removed = [];
  const refused = [];
  for (const entry of prev.agent_files) {
    if (claimed.has(entry)) continue;
    if (!actionable(entry)) { refused.push(`${entry} (not a plain shipyard-*.toml name)`); continue; }
    const target = path.join(dir, entry);
    let st = null;
    try { st = fs.lstatSync(target); } catch { continue; } // already gone: nothing owed
    if (!st.isFile()) { refused.push(`${entry} (not a regular file)`); continue; }
    // A failed unlink (permissions, a read-only filesystem) must land as the
    // same conservative refusal as every other case here — this script runs
    // under the installer's `set -euo pipefail`, so an uncaught throw would
    // abort the WHOLE install over one orphan the reconciler could not remove,
    // which is a far worse outcome than leaving that one file in place.
    try {
      fs.unlinkSync(target);
    } catch (e) {
      refused.push(`${entry} (could not remove it: ${e.message})`);
      continue;
    }
    removed.push(entry);
  }
  // `registrations` is the other half of the previous run's claim, and this is
  // its reader: a field the generator writes and nobody reads is the shape
  // ADR-007 D6 calls a finding. A record written before the field existed falls
  // back to the derived form rather than reporting nothing.
  const prevRegs = Array.isArray(prev.registrations) ? prev.registrations : [];
  const registrationFor = (f) => {
    const derived = `agents.${f.replace(/\.toml$/, '')}`;
    if (!prevRegs.length) return derived;
    return prevRegs.includes(derived) ? derived : null;
  };
  if (removed.length) {
    const regs = removed.map(registrationFor).filter(Boolean);
    say(`removed ${removed.length} agent file(s) this install no longer emits: ${removed.join(', ')}`);
    if (regs.length) say(`their registrations went with the fragment above: ${regs.join(', ')}`);
  } else {
    say('nothing the previous install wrote is orphaned');
  }
  for (const r of refused) say(`left in place, the manifest claim is not one this installer may act on: ${r}`);
}

// LAST, so the record only advances once the removals it licenses have actually
// happened. A run that dies in the middle leaves the older, wider claim in
// place and the next run reclaims those files; a record written first would
// have forgotten them.
//
// Symlink-safe and non-fatal. `copyFileSync(next, prev)` follows a symlink at
// `prevPath` and would overwrite whatever it points to — this record lives at
// a fixed, predictable name inside a directory the operator also writes into
// — and it throws outright if `prevPath` is a directory or otherwise
// unwritable, hard-failing the WHOLE installer over a bookkeeping step that
// runs after the removals it licenses already happened. Write to a temp file
// beside it and `rename()` over the target instead: rename replaces the
// directory ENTRY, never the file a symlink points through, so a symlink at
// `prevPath` is replaced rather than followed. A failure here is a warning,
// not an abort — the reconciler is conservative by design, and the next run
// simply reconciles against the older record.
const tmpManifestPath = `${prevPath}.tmp-${process.pid}`;
try {
  fs.copyFileSync(nextPath, tmpManifestPath);
  fs.renameSync(tmpManifestPath, prevPath);
} catch (e) {
  try { fs.unlinkSync(tmpManifestPath); } catch { /* never written, or already gone */ }
  say(`could not update the ownership record (${manifestName}): ${e.message} — the next install reconciles against the older record instead`);
}
NODE
fi

# ── GSD capability (Gate 2 / UAT gates) ──────────────────────────────────────
# Stage the capability with a bundled validator so graph-gate.cjs resolves it
# from its own checks/ dir on a host (there is no /opt/delivery-pipeline here).
echo "→ registering GSD capability (Gate 2 / UAT gates)…"
CAP_STAGE="$STAGE/capability/delivery-pipeline"
GSD_CAPABILITIES_ROOT="${GSD_CAPABILITIES_DIR:-$HOME/.gsd/capabilities}"
CAPABILITY_TARGET="$GSD_CAPABILITIES_ROOT/delivery-pipeline"
snapshot_runtime_path capability delivery-pipeline "$CAPABILITY_TARGET"
mkdir -p "$CAP_STAGE/checks"
cp -R "$CAP_SRC/." "$CAP_STAGE/"
# The validator requires sibling modules (frontmatter.cjs, pipeline-config.cjs),
# so the whole .cjs set travels with it — staging validate-graph.cjs alone would
# leave the gate unable to load its parser.
cp "$PLUGIN_DIR"/scripts/*.cjs "$CAP_STAGE/checks/"
GSD_RUNTIME=codex SHIPYARD_RUNTIME=codex node "$GSD_TOOLS" capability install "$CAP_STAGE" --scope global --yes

# ── auto-route policy → global AGENTS.md (Codex's always-loaded instructions) ──
# So the pipeline is applied without the user invoking $shipyard-* by hand.
# Idempotent: managed block between markers, rewritten in place on reinstall.
# Honour CODEX_HOME: with a custom home everything else installs there, so
# hardcoding ~/.codex here split the install across two locations.
AGENTS_MD="${CODEX_AGENTS_MD:-$CODEX_HOME/AGENTS.md}"
snapshot_runtime_path agents-md main "$AGENTS_MD"
echo "→ ensuring shipyard auto-route block in $AGENTS_MD"
mkdir -p "$(dirname "$AGENTS_MD")"
SHIPYARD_INSTALL_PHASE="$PHASE" CODEX_AGENTS_MD="$AGENTS_MD" node - <<'NODE'
const fs = require('fs');
const p = process.env.CODEX_AGENTS_MD;
const phase = Number(process.env.SHIPYARD_INSTALL_PHASE || 2);
const BEGIN = '<!-- shipyard-auto-route:begin -->';
const END = '<!-- shipyard-auto-route:end -->';
const largeRoute = phase >= 2
  ? '  large / multi-ticket -> `$shipyard-decompose` -> `$shipyard-deliver`; a small'
  : '  large / multi-ticket -> `$shipyard-decompose`; install phase 2 before delivery; a small';
const block = `${BEGIN}
## shipyard auto-route (managed by shipyard install — do not edit between markers)

When a message defines a scope of work or asks to implement / build / change /
fix something in a codebase, handle it through shipyard rather than ad hoc — do
not wait to be told to run a command:
- Use the shipyard router \`$shipyard-route\` to size and dispatch the work:
${largeRoute}
  change, an existing ticket, or "no ticket" -> \`$shipyard-bench\`; a one-liner ->
  inline.
- Research first (proportionate) and apply GSD at full across stages
  (research -> plan -> implement -> verify -> review), driving GSD/shipyard
  yourself.
- The user should not have to invoke GSD or shipyard manually.
Skip this entirely for pure questions, discussion, or non-code chatter.
${END}`;
let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
const re = new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
if (text.includes(BEGIN) && text.includes(END)) text = text.replace(re, block);
else text = (text.trimEnd() + '\n\n' + block + '\n').replace(/^\n+/, '');
fs.writeFileSync(p, text);
NODE

# ── GSD's global defaults for this runtime ───────────────────────────────────
# See install-shipyard-claude-hook.sh for the full reasoning. In short:
# ~/.gsd/defaults.json is inherited by any directory with no `.planning/`. Runtime
# is deliberately not written there: GSD's Codex install marker and this process
# handshake select Codex without overwriting Claude's context. Only model-shaped
# keys belong there — conveyor settings stay per-project.
GSD_TUNE="$REPO_ROOT/plugins/delivery-pipeline/scripts/gsd-tune.cjs"
GSD_DEFAULTS="${GSD_DEFAULTS_PATH:-$HOME/.gsd/defaults.json}"
snapshot_runtime_path gsd-defaults defaults.json "$GSD_DEFAULTS"
[[ -f "$GSD_TUNE" ]] || GSD_TUNE="$BUNDLE_ROOT/scripts/gsd-tune.cjs"
if [[ -f "$GSD_TUNE" ]]; then
  echo "→ GSD global defaults (~/.gsd/defaults.json)"
  GSD_RUNTIME=codex SHIPYARD_RUNTIME=codex node "$GSD_TUNE" --global --runtime codex --apply 2>&1 | sed 's/^/  /' || true
fi

# ── skills → ~/.agents/skills (only our own shipyard-* dirs are touched) ──────
echo "→ installing skills → $AGENTS_SKILLS"
mkdir -p "$AGENTS_SKILLS"
for d in "$OUT"/skills/*/; do
  name="$(basename "${d%/}")"
  snapshot_runtime_path skill "$name" "$AGENTS_SKILLS/$name"
done
snapshot_runtime_path bundle payload "$BUNDLE_ROOT"
for d in "$OUT"/skills/*/; do
  name="$(basename "$d")"
  replace_dir "${d%/}" "$AGENTS_SKILLS/$name" "skill directory" || {
    status=$?
    echo "error: could not install skill $name" >&2
    exit "$status"
  }
done

# ── bundle payload (CLAUDE_PLUGIN_ROOT target: scripts/references/templates) ──
# REPLACED, not merged over — the same way the skills above are. Copying onto an
# existing bundle leaves every file the plugin has since deleted or renamed in
# place forever, still reachable by path. Three stale `*.mjs.bak` files survived
# an upgrade that way, and a renamed script would be worse: both editions present,
# the old one silently callable. The bundle is wholly generated, so nothing
# user-authored is at risk.
echo "→ installing bundle payload → $BUNDLE_ROOT"
find "$OUT/bundle" -name '*.sh' -exec chmod +x {} +
replace_dir "$OUT/bundle" "$BUNDLE_ROOT" "bundle payload" || {
  status=$?
  echo "error: could not install bundle payload" >&2
  exit "$status"
}

# Nothing installer-owned remains to roll back after this point. Keeping the
# rollback active through both replacement loops is what makes a failed second
# skill or bundle swap restore the earlier swaps as one generation.
ROLLBACK_ACTIVE=0

deliver_hint=""
[[ "$PHASE" -ge 2 ]] && deliver_hint=' | $shipyard-deliver'
echo "✓ shipyard installed for Codex."
echo "  In Codex: \$shipyard-route | \$shipyard-investigate | \$shipyard-decompose${deliver_hint} | \$shipyard-bench"
echo "  (auto-route is in $AGENTS_MD — describe the work and the router picks the entry)"
