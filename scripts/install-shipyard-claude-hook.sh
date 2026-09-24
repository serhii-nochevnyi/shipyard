#!/usr/bin/env bash
set -euo pipefail

# install-shipyard-claude-hook.sh — install shipyard's two host-side hooks into the
# user's global Claude Code settings.
#
#   UserPromptSubmit → shipyard-auto-route.sh   the pipeline is applied without the
#                                               user invoking /gsd-* or /shipyard:*
#   Stop             → shipyard-stop-gate.cjs   the run does not end while the
#                                               delivery front still has live work
#
# The two are opposite ends of the same conveyor: one gets work IN, the other
# refuses to let it be abandoned half-done.
#
# The route hook is one file. The stop gate is installed as a self-contained
# dependency bundle under ~/.claude/hooks/shipyard-stop-gate so a release cannot
# leave a copied hook with a missing sibling module.
#
# The Codex side of the auto-route policy lives in the global AGENTS.md and is
# installed by install-shipyard-codex.sh.
#
# Environment overrides:
#   CLAUDE_HOME   Claude config home (default: ~/.claude)
#
# Usage: bash scripts/install-shipyard-claude-hook.sh [--remove]

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="$CLAUDE_HOME/settings.json"

ROUTE_HOOK="$CLAUDE_HOME/hooks/shipyard-auto-route.sh"
ROUTE_CJS="$CLAUDE_HOME/hooks/shipyard-auto-route.cjs"
PRE_PUSH_HOOK="$CLAUDE_HOME/hooks/shipyard-pre-push-gate.sh"
STOP_DIR="$CLAUDE_HOME/hooks/shipyard-stop-gate"
STOP_HOOK="$STOP_DIR/stop-gate.cjs"
SESSION_HOOK="$STOP_DIR/session-observer.cjs"
OLD_STOP_HOOK="$CLAUDE_HOME/hooks/shipyard-stop-gate.cjs"
ROUTE_CMD="bash \"$ROUTE_HOOK\""
PRE_PUSH_CMD="bash \"$PRE_PUSH_HOOK\""
STOP_CMD="node \"$STOP_HOOK\""
SESSION_CMD="node \"$SESSION_HOOK\" hook"
OLD_STOP_CMD="node \"$OLD_STOP_HOOK\""

REMOVE=0
[[ "${1:-}" == "--remove" ]] && REMOVE=1

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }

# drop_hook <event> <command> — remove one command from one event, preserving
# every other hook, group and event.
drop_hook() {
  [[ -f "$SETTINGS" ]] || return 0
  EVENT="$1" CMD="$2" SETTINGS="$SETTINGS" node - <<'NODE'
const fs = require('fs'), p = process.env.SETTINGS, cmd = process.env.CMD, ev = process.env.EVENT;
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const groups = s.hooks && s.hooks[ev];
if (!Array.isArray(groups)) process.exit(0);
s.hooks[ev] = groups
  .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => h.command !== cmd) }))
  .filter((g) => (g.hooks || []).length);
if (!s.hooks[ev].length) delete s.hooks[ev];
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
NODE
}

# add_hook <event> <command> — idempotent merge.
add_hook() {
  [[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
  EVENT="$1" CMD="$2" SETTINGS="$SETTINGS" node - <<'NODE'
const fs = require('fs'), p = process.env.SETTINGS, cmd = process.env.CMD, ev = process.env.EVENT;
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const h = (s.hooks ||= {});
const groups = (h[ev] ||= []);
if (groups.some((g) => (g.hooks || []).some((x) => x.command === cmd))) {
  console.log(`  ${ev}: already present — no change`);
  process.exit(0);
}
groups.push({ hooks: [{ type: 'command', command: cmd }] });
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
console.log(`  ${ev}: merged into ${p}`);
NODE
}

if [[ "$REMOVE" == 1 ]]; then
  drop_hook UserPromptSubmit "$ROUTE_CMD"
  drop_hook PreToolUse "$PRE_PUSH_CMD"
  drop_hook Stop "$STOP_CMD"
  drop_hook Stop "$SESSION_CMD"
  drop_hook Stop "$OLD_STOP_CMD"
  drop_hook Stop "node \"$STOP_DIR/stop-gate.cjs\""
  rm -f "$ROUTE_HOOK" "$ROUTE_CJS" "$PRE_PUSH_HOOK" "$STOP_HOOK"
  rm -rf "$STOP_DIR" "$OLD_STOP_HOOK"
  echo "✓ removed shipyard auto-route and stop-gate hooks from Claude"
  exit 0
fi

# ── gsd-core, the thing shipyard is a superstructure over ────────────────────
# Default on: a superstructure that never updates its base rots against it, which
# is what three different gsd-core versions on one machine looked like. Opt out
# with SHIPYARD_GSD_AUTO_INSTALL=0 when the host manages GSD separately.
if [[ "${SHIPYARD_GSD_AUTO_INSTALL:-1}" != "0" ]]; then
  if [[ -x "$ROOT/scripts/ensure-gsd-core.sh" ]]; then
    bash "$ROOT/scripts/ensure-gsd-core.sh" claude || \
      echo "  (continuing: the hooks below do not need gsd-core)"
  fi
fi

mkdir -p "$CLAUDE_HOME/hooks"

ROUTE_SRC=""
for candidate in \
  "${SHIPYARD_PLUGIN_DIR:-}/scripts/auto-route.cjs" \
  "$ROOT/plugins/delivery-pipeline/scripts/auto-route.cjs"
do
  [[ -f "$candidate" ]] && { ROUTE_SRC="$candidate"; break; }
done
[[ -n "$ROUTE_SRC" ]] || { echo "error: auto-route.cjs not found under $ROOT/plugins/delivery-pipeline" >&2; exit 1; }
cp "$ROUTE_SRC" "$ROUTE_CJS"
chmod +x "$ROUTE_CJS"
echo "→ wrote $ROUTE_CJS"

cat > "$ROUTE_HOOK" <<EOF
#!/usr/bin/env bash
# Managed by shipyard: do not edit.
set -euo pipefail
node "$ROUTE_CJS" || true
EOF
chmod +x "$ROUTE_HOOK"
echo "→ wrote $ROUTE_HOOK"

# Copy the relative CommonJS dependency closure. Dynamic and external requires
# are rejected here because they cannot be made self-contained safely.
copy_stop_bundle() {
  local source="$1" dest="$2"
  SOURCE="$source" DEST="$dest" node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const source = fs.realpathSync(process.env.SOURCE);
const dest = path.resolve(process.env.DEST);
const root = path.dirname(source);
const copied = new Set();
const localRequire = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

function resolveLocal(from, request) {
  const base = path.resolve(path.dirname(from), request);
  const relative = path.relative(root, base);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`dependency escapes the hook bundle root: ${request} from ${from}`);
  }
  const candidates = [
    base,
    `${base}.cjs`,
    `${base}.js`,
    path.join(base, 'index.cjs'),
    path.join(base, 'index.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) throw new Error(`missing relative dependency ${request} required by ${from}`);
  return fs.realpathSync(found);
}

function copy(file) {
  if (copied.has(file)) return;
  copied.add(file);
  const relative = path.relative(root, file);
  const target = path.join(dest, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  const sourceText = fs.readFileSync(file, 'utf8');
  for (const match of sourceText.matchAll(localRequire)) copy(resolveLocal(file, match[1]));
}

copy(source);
process.stdout.write(String(copied.size));
NODE
}

# The plugin normally sits in the repo when this runs from a checkout. A custom
# SHIPYARD_PLUGIN_DIR is supported for callers that keep the source elsewhere.
STOP_SRC=""
for candidate in \
  "${SHIPYARD_PLUGIN_DIR:-}/scripts/stop-gate.cjs" \
  "$ROOT/plugins/delivery-pipeline/scripts/stop-gate.cjs"
do
  [[ -f "$candidate" ]] && { STOP_SRC="$candidate"; break; }
done
[[ -n "$STOP_SRC" ]] || { echo "error: stop-gate.cjs not found under $ROOT/plugins/delivery-pipeline" >&2; exit 1; }
STOP_TMP=""
cleanup_stop_tmp() {
  [[ -z "$STOP_TMP" || ! -e "$STOP_TMP" ]] || rm -rf "$STOP_TMP"
}
trap cleanup_stop_tmp EXIT
STOP_TMP="$(mktemp -d "$CLAUDE_HOME/hooks/.shipyard-stop-gate.XXXXXX")"
COPIED="$(copy_stop_bundle "$STOP_SRC" "$STOP_TMP")"
PUBLISH_SRC="$(dirname "$STOP_SRC")/publish-gate.cjs"
if [[ ! -f "$PUBLISH_SRC" ]]; then
  PUBLISH_SRC="$ROOT/plugins/delivery-pipeline/scripts/publish-gate.cjs"
fi
[[ -f "$PUBLISH_SRC" ]] || { echo "error: publish-gate.cjs not found under $ROOT/plugins/delivery-pipeline" >&2; exit 1; }
COPIED_PUBLISH="$(copy_stop_bundle "$PUBLISH_SRC" "$STOP_TMP")"
SESSION_SRC="$(dirname "$STOP_SRC")/session-observer.cjs"
if [[ ! -f "$SESSION_SRC" ]]; then
  SESSION_SRC="$ROOT/plugins/delivery-pipeline/scripts/session-observer.cjs"
fi
[[ -f "$SESSION_SRC" ]] || { echo "error: session-observer.cjs not found under $ROOT/plugins/delivery-pipeline" >&2; exit 1; }
COPIED_SESSION="$(copy_stop_bundle "$SESSION_SRC" "$STOP_TMP")"
STOP_META="$(cd "$(dirname "$STOP_SRC")/.." && pwd)/.claude-plugin/plugin.json"
if [[ -f "$STOP_META" ]]; then
  STOP_VERSION_JSON="$(META="$STOP_META" node - <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.META, 'utf8')).version || null;
process.stdout.write(JSON.stringify(value));
NODE
)"
  printf '{"shipyard_version":%s}\n' "$STOP_VERSION_JSON" > "$STOP_TMP/version.json"
fi
while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find "$STOP_TMP" -type f \( -name '*.cjs' -o -name '*.js' \) -print0)
VERIFY_CWD="$(mktemp -d)"
VERIFY_STATUS=0
printf '{}\n' | (cd "$VERIFY_CWD" && node "$STOP_TMP/$(basename "$STOP_SRC")") >/dev/null || VERIFY_STATUS=$?
rm -rf "$VERIFY_CWD"
(( VERIFY_STATUS == 0 )) || exit "$VERIFY_STATUS"
rm -rf "$STOP_DIR"
mv "$STOP_TMP" "$STOP_DIR"
STOP_TMP=""
chmod +x "$STOP_HOOK"
rm -f "$OLD_STOP_HOOK"
echo "→ wrote $STOP_HOOK ($COPIED files)"
PRE_PUSH_SRC="$ROOT/scripts/shipyard-pre-push-gate.sh"
[[ -f "$PRE_PUSH_SRC" ]] || { echo "error: shipyard-pre-push-gate.sh not found under $ROOT/scripts" >&2; exit 1; }
cp "$PRE_PUSH_SRC" "$PRE_PUSH_HOOK"
chmod +x "$PRE_PUSH_HOOK"
echo "→ wrote $PRE_PUSH_HOOK ($COPIED_PUBLISH publish-gate modules)"
echo "→ bundled session observer ($COPIED_SESSION modules)"

add_hook UserPromptSubmit "$ROUTE_CMD"
drop_hook Stop "$OLD_STOP_CMD"
drop_hook Stop "node \"$CLAUDE_HOME/hooks/shipyard-stop-gate/stop-gate.cjs\""
add_hook Stop "$STOP_CMD"
add_hook Stop "$SESSION_CMD"
add_hook PreToolUse "$PRE_PUSH_CMD"

# ── GSD's global defaults for this runtime ───────────────────────────────────
# ~/.gsd/defaults.json is what a directory with no `.planning/` inherits — a new
# project before anyone has configured it. Runtime is deliberately NOT written
# here: GSD's per-install `.gsd-runtime` marker and the process handshake keep
# Claude and Codex independent on a dual-runtime machine.
#
# Only model-shaped keys are written here. Conveyor settings (branching,
# worktrees, agent_skills) stay per-project: this file is inherited by GSD
# projects that never asked for shipyard, and an ordinary one legitimately wants
# phase branches.
GSD_TUNE=""
for candidate in \
  "${SHIPYARD_PLUGIN_DIR:-}/scripts/gsd-tune.cjs" \
  "$ROOT/plugins/delivery-pipeline/scripts/gsd-tune.cjs"
do
  [[ -f "$candidate" ]] && { GSD_TUNE="$candidate"; break; }
done
if [[ -n "$GSD_TUNE" ]]; then
  echo "→ GSD global defaults (~/.gsd/defaults.json)"
  # Never fatal: a shipyard install must not fail because GSD is absent or its
  # defaults file is unreadable. `--check` exits 1 on drift, which is data here.
  GSD_RUNTIME=claude SHIPYARD_RUNTIME=claude node "$GSD_TUNE" --global --runtime claude --apply 2>&1 | sed 's/^/  /' || true
fi

echo "✓ shipyard auto-route + stop-gate hooks installed for Claude Code (new sessions; open /hooks or restart to load in a running session)"
