#!/usr/bin/env bash
set -euo pipefail

# install-shipyard-claude-hook.sh — set up the shipyard auto-route UserPromptSubmit
# hook in the user's global Claude Code settings, so the pipeline is applied
# without the user invoking /gsd-* or /shipyard:* by hand.
#
# Writes ~/.claude/hooks/shipyard-auto-route.sh (the injected policy) and merges a
# UserPromptSubmit hook into ~/.claude/settings.json — idempotently, preserving
# every other hook/event. The Codex side of the same policy lives in the global
# AGENTS.md and is installed by install-shipyard-codex.sh.
#
# Environment overrides:
#   CLAUDE_HOME   Claude config home (default: ~/.claude)
#
# Usage: bash scripts/install-shipyard-claude-hook.sh [--remove]

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
HOOK="$CLAUDE_HOME/hooks/shipyard-auto-route.sh"
SETTINGS="$CLAUDE_HOME/settings.json"
CMD="bash \"$HOOK\""
REMOVE=0
[[ "${1:-}" == "--remove" ]] && REMOVE=1

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }

if [[ "$REMOVE" == 1 ]]; then
  CMD="$CMD" SETTINGS="$SETTINGS" node - <<'NODE'
const fs = require('fs'), p = process.env.SETTINGS, cmd = process.env.CMD;
if (!fs.existsSync(p)) process.exit(0);
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const ups = s.hooks && s.hooks.UserPromptSubmit;
if (Array.isArray(ups)) {
  s.hooks.UserPromptSubmit = ups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => h.command !== cmd) }))
    .filter((g) => (g.hooks || []).length);
  if (!s.hooks.UserPromptSubmit.length) delete s.hooks.UserPromptSubmit;
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
}
NODE
  rm -f "$HOOK"
  echo "✓ removed shipyard auto-route hook from Claude"
  exit 0
fi

mkdir -p "$CLAUDE_HOME/hooks"
cat > "$HOOK" <<'EOF'
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
chmod +x "$HOOK"
echo "→ wrote $HOOK"

[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
CMD="$CMD" SETTINGS="$SETTINGS" node - <<'NODE'
const fs = require('fs'), p = process.env.SETTINGS, cmd = process.env.CMD;
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const h = (s.hooks ||= {});
const ups = (h.UserPromptSubmit ||= []);
const present = ups.some((g) => (g.hooks || []).some((x) => x.command === cmd));
if (present) { console.log('settings hook already present — no change'); process.exit(0); }
ups.push({ hooks: [{ type: 'command', command: cmd }] });
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
console.log('merged UserPromptSubmit hook into ' + p);
NODE

echo "✓ shipyard auto-route hook installed for Claude Code (new sessions; open /hooks or restart to load in a running session)"
