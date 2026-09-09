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
#
# Usage: bash scripts/install-shipyard-codex.sh [--phase 1|2]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/delivery-pipeline"
CAP_SRC="$REPO_ROOT/capabilities/delivery-pipeline"
PHASE="${SHIPYARD_CODEX_PHASE:-2}"

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
BUNDLE_ROOT="$CODEX_HOME/shipyard"
GSD_TOOLS="$CODEX_HOME/gsd-core/bin/gsd-tools.cjs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:?}"; shift 2 ;;
    -h | --help) sed -n '3,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── preconditions ────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
[[ -d "$PLUGIN_DIR" ]] || { echo "error: plugin dir missing: $PLUGIN_DIR" >&2; exit 1; }
[[ -d "$CAP_SRC" ]] || { echo "error: capability dir missing: $CAP_SRC" >&2; exit 1; }
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
trap 'rm -rf "$STAGE"' EXIT
OUT="$STAGE/bundle-out"

# ── generate ─────────────────────────────────────────────────────────────────
echo "→ generating Codex bundle (phase $PHASE)…"
node "$REPO_ROOT/scripts/gen-codex-shipyard.cjs" \
  --plugin "$PLUGIN_DIR" --out "$OUT" \
  --codex-home "$CODEX_HOME" --bundle-root "$BUNDLE_ROOT" --phase "$PHASE"

# ── skills → ~/.agents/skills (only our own shipyard-* dirs are touched) ──────
echo "→ installing skills → $AGENTS_SKILLS"
mkdir -p "$AGENTS_SKILLS"
for d in "$OUT"/skills/*/; do
  name="$(basename "$d")"
  rm -rf "${AGENTS_SKILLS:?}/$name"
  cp -R "${d%/}" "$AGENTS_SKILLS/$name"
done

# ── bundle payload (CLAUDE_PLUGIN_ROOT target: scripts/references/templates) ──
# REPLACED, not merged over — the same way the skills above are. Copying onto an
# existing bundle leaves every file the plugin has since deleted or renamed in
# place forever, still reachable by path. Three stale `*.mjs.bak` files survived
# an upgrade that way, and a renamed script would be worse: both editions present,
# the old one silently callable. The bundle is wholly generated, so nothing
# user-authored is at risk.
echo "→ installing bundle payload → $BUNDLE_ROOT"
rm -rf "${BUNDLE_ROOT:?}"
mkdir -p "$BUNDLE_ROOT"
cp -R "$OUT"/bundle/. "$BUNDLE_ROOT/"
find "$BUNDLE_ROOT" -name '*.sh' -exec chmod +x {} +

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
  mkdir -p "$CODEX_HOME/agents"
  cp "$OUT"/agents/*.toml "$CODEX_HOME/agents/"
  echo "→ merging agent registrations → $CODEX_HOME/config.toml"
  node "$REPO_ROOT/scripts/merge-codex-config.cjs" \
    --config "$CODEX_HOME/config.toml" --fragment "$OUT/config.fragment.toml"
  # AFTER the merge, deliberately. The merge strips every `[agents.shipyard-*]`
  # table and the whole fenced fragment before writing the fresh one, so an
  # orphan's registration is already gone by the time its file is removed — and
  # if the merge refuses (a duplicate table, a config that will not parse), it
  # exits non-zero here and BOTH halves stay as they were. The other order
  # produces the one broken state worth ruling out: a registration whose file is
  # gone. A file whose registration is gone is merely inert.
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

// THIS run's claim first, and nothing happens without it. An unreadable new
// manifest would otherwise mean "this install claims nothing", which turns
// every file the previous run wrote into an orphan — a mass delete produced by
// a failed read. There is no state in which that is the right answer.
const next = read(nextPath);
if (!next || !Array.isArray(next.agent_files)) {
  say(`this run produced no readable manifest (${nextPath}) — removing nothing`);
  process.exit(0);
}
const claimed = new Set(next.agent_files);

// A name this installer may act on at all: one path segment, our own prefix,
// one extension. A manifest is a file on disk like any other, so an entry that
// is not a plain basename is refused rather than resolved — `path.join` would
// walk `../` out of this directory without complaint.
const OURS = /^shipyard-[A-Za-z0-9._-]*\.toml$/;
const actionable = (e) => typeof e === 'string' && path.basename(e) === e && OURS.test(e);

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
    fs.unlinkSync(target);
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
fs.copyFileSync(nextPath, prevPath);
NODE
fi

# ── GSD capability (Gate 2 / UAT gates) ──────────────────────────────────────
# Stage the capability with a bundled validator so graph-gate.cjs resolves it
# from its own checks/ dir on a host (there is no /opt/delivery-pipeline here).
echo "→ registering GSD capability (Gate 2 / UAT gates)…"
CAP_STAGE="$STAGE/capability/delivery-pipeline"
mkdir -p "$CAP_STAGE/checks"
cp -R "$CAP_SRC/." "$CAP_STAGE/"
# The validator requires sibling modules (frontmatter.cjs, pipeline-config.cjs),
# so the whole .cjs set travels with it — staging validate-graph.cjs alone would
# leave the gate unable to load its parser.
cp "$PLUGIN_DIR"/scripts/*.cjs "$CAP_STAGE/checks/"
node "$GSD_TOOLS" capability install "$CAP_STAGE" --scope global --yes

# ── auto-route policy → global AGENTS.md (Codex's always-loaded instructions) ──
# So the pipeline is applied without the user invoking $shipyard-* by hand.
# Idempotent: managed block between markers, rewritten in place on reinstall.
# Honour CODEX_HOME: with a custom home everything else installs there, so
# hardcoding ~/.codex here split the install across two locations.
AGENTS_MD="${CODEX_AGENTS_MD:-$CODEX_HOME/AGENTS.md}"
echo "→ ensuring shipyard auto-route block in $AGENTS_MD"
mkdir -p "$(dirname "$AGENTS_MD")"
CODEX_AGENTS_MD="$AGENTS_MD" node - <<'NODE'
const fs = require('fs');
const p = process.env.CODEX_AGENTS_MD;
const BEGIN = '<!-- shipyard-auto-route:begin -->';
const END = '<!-- shipyard-auto-route:end -->';
const block = `${BEGIN}
## shipyard auto-route (managed by shipyard install — do not edit between markers)

When a message defines a scope of work or asks to implement / build / change /
fix something in a codebase, handle it through shipyard rather than ad hoc — do
not wait to be told to run a command:
- Use the shipyard router \`$shipyard-route\` to size and dispatch the work:
  large / multi-ticket -> \`$shipyard-decompose\` -> \`$shipyard-deliver\`; a small
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
# ~/.gsd/defaults.json is inherited by any directory with no `.planning/`, it
# holds ONE `runtime` shared by both installs, and only model-shaped keys belong
# there — conveyor settings stay per-project.
GSD_TUNE="$REPO_ROOT/plugins/delivery-pipeline/scripts/gsd-tune.cjs"
[[ -f "$GSD_TUNE" ]] || GSD_TUNE="$BUNDLE_ROOT/scripts/gsd-tune.cjs"
if [[ -f "$GSD_TUNE" ]]; then
  echo "→ GSD global defaults (~/.gsd/defaults.json)"
  node "$GSD_TUNE" --global --runtime codex --apply 2>&1 | sed 's/^/  /' || true
fi

deliver_hint=""
[[ "$PHASE" -ge 2 ]] && deliver_hint=' | $shipyard-deliver'
echo "✓ shipyard installed for Codex."
echo "  In Codex: \$shipyard-route | \$shipyard-investigate | \$shipyard-decompose${deliver_hint} | \$shipyard-bench"
echo "  (auto-route is in $AGENTS_MD — describe the work and the router picks the entry)"
