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
# Both are installed as SELF-CONTAINED copies under ~/.claude/hooks. The stop gate
# reads only `.planning/graph/delivery-front.json`, so it needs nothing from the
# plugin at run time — and copying it keeps the hook off the plugin's versioned
# cache path, which changes on every release and would silently break the hook.
# Re-run this installer after upgrading shipyard to refresh the copy.
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
STOP_HOOK="$CLAUDE_HOME/hooks/shipyard-stop-gate.cjs"
ROUTE_CMD="bash \"$ROUTE_HOOK\""
STOP_CMD="node \"$STOP_HOOK\""

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
  drop_hook Stop "$STOP_CMD"
  rm -f "$ROUTE_HOOK" "$STOP_HOOK"
  echo "✓ removed shipyard auto-route and stop-gate hooks from Claude"
  exit 0
fi

mkdir -p "$CLAUDE_HOME/hooks"

cat > "$ROUTE_HOOK" <<'EOF'
#!/usr/bin/env bash
# Managed by shipyard: inject the auto-route policy on every user prompt so the
# pipeline is applied without the user manually invoking GSD or shipyard.
set -euo pipefail
cat <<'POLICY'
[shipyard auto-route] If this message defines a scope of work or asks to
implement / build / change / fix something in a codebase, handle it through
shipyard rather than ad hoc — do not wait to be told to run a command:
- Use the shipyard router (/shipyard:route) to size and dispatch the work:
  large / multi-ticket → /shipyard:decompose → /shipyard:deliver; a small change,
  an existing ticket, or "no ticket" → /shipyard:bench; a one-liner → inline.
- Research first (proportionate) and apply GSD at full across stages
  (research → plan → implement → verify → review), driving GSD/shipyard yourself.
- The user should not have to invoke GSD or shipyard manually.
Skip this entirely for pure questions, discussion, or non-code chatter.
POLICY
EOF
chmod +x "$ROUTE_HOOK"
echo "→ wrote $ROUTE_HOOK"

# The plugin sits in the repo when this runs from a checkout, and at
# /opt/delivery-pipeline inside the image (where this script lives in
# /usr/local/bin and $ROOT resolves to /usr/local). Try both rather than assume.
STOP_SRC=""
for candidate in \
  "${SHIPYARD_PLUGIN_DIR:-}/scripts/stop-gate.cjs" \
  "$ROOT/plugins/delivery-pipeline/scripts/stop-gate.cjs" \
  "/opt/delivery-pipeline/scripts/stop-gate.cjs"
do
  [[ -f "$candidate" ]] && { STOP_SRC="$candidate"; break; }
done
[[ -n "$STOP_SRC" ]] || { echo "error: stop-gate.cjs not found (looked under $ROOT/plugins/delivery-pipeline and /opt/delivery-pipeline)" >&2; exit 1; }
cp "$STOP_SRC" "$STOP_HOOK"
chmod +x "$STOP_HOOK"
echo "→ wrote $STOP_HOOK"

add_hook UserPromptSubmit "$ROUTE_CMD"
add_hook Stop "$STOP_CMD"

echo "✓ shipyard auto-route + stop-gate hooks installed for Claude Code (new sessions; open /hooks or restart to load in a running session)"
