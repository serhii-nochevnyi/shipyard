#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
HOME_DIR="$WORK/home"
PLUGIN="$WORK/plugin"
CLAUDE_HOME="$HOME_DIR/.claude"
mkdir -p "$CLAUDE_HOME" "$PLUGIN/scripts"
mkdir -p "$PLUGIN/.claude-plugin"
PLUGIN_VERSION="$(ROOT="$ROOT" node -e "const fs = require('node:fs'); const path = require('node:path'); const root = process.env.ROOT; process.stdout.write(JSON.parse(fs.readFileSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'), 'utf8')).version);")"
printf '{"version":"%s"}\n' "$PLUGIN_VERSION" > "$PLUGIN/.claude-plugin/plugin.json"

cat > "$PLUGIN/scripts/stop-gate.cjs" <<'EOF'
const wake = require('./run-waker.cjs');
process.stdout.write(wake);
EOF
cat > "$PLUGIN/scripts/run-waker.cjs" <<'EOF'
module.exports = require('./run-store.cjs');
EOF
cat > "$PLUGIN/scripts/run-store.cjs" <<'EOF'
module.exports = '{}';
EOF

SETTINGS="$CLAUDE_HOME/settings.json" OLD_STOP="$CLAUDE_HOME/hooks/shipyard-stop-gate.cjs" node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const settings = process.env.SETTINGS;
const oldStop = process.env.OLD_STOP;
fs.mkdirSync(path.dirname(oldStop), { recursive: true });
fs.writeFileSync(settings, JSON.stringify({
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: `node "${oldStop}"` }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }],
  },
}, null, 2) + '\n');
NODE

HOME="$HOME_DIR" CLAUDE_HOME="$CLAUDE_HOME" SHIPYARD_PLUGIN_DIR="$PLUGIN" \
  SHIPYARD_GSD_AUTO_INSTALL=0 bash "$ROOT/scripts/install-shipyard-claude-hook.sh" >/dev/null

node - "$CLAUDE_HOME/settings.json" "$CLAUDE_HOME/hooks/shipyard-stop-gate" "$CLAUDE_HOME/hooks/shipyard-pre-push-gate.sh" <<'NODE'
const fs = require('node:fs');
const [settingsFile, bundle, prePush] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const commands = (settings.hooks.Stop || []).flatMap((group) => (group.hooks || []).map((hook) => hook.command));
const prePushCommands = (settings.hooks.PreToolUse || []).flatMap((group) => (group.hooks || []).map((hook) => hook.command));
if (!commands.includes(`node "${bundle}/stop-gate.cjs"`)) throw new Error('new stop hook is missing');
if (!commands.includes(`node "${bundle}/session-observer.cjs" hook`)) throw new Error('session observer hook is missing');
if (!prePushCommands.includes(`bash "${prePush}"`)) throw new Error('pre-push hook is missing');
if (commands.some((command) => command.endsWith('/shipyard-stop-gate.cjs"'))) throw new Error('old stop hook remains');
if (!(settings.hooks.Notification || []).some((group) => (group.hooks || []).some((hook) => hook.command === 'echo keep-me'))) {
  throw new Error('unrelated hook was changed');
}
for (const file of ['stop-gate.cjs', 'run-waker.cjs', 'run-store.cjs', 'publish-gate.cjs', 'comment-policy.cjs', 'session-observer.cjs', 'usage-report.cjs']) {
  if (!fs.existsSync(require('node:path').join(bundle, file))) throw new Error(`missing bundled dependency: ${file}`);
}
NODE

node "$ROOT/scripts/shipyard-doctor.cjs" --json \
  --claude-home "$CLAUDE_HOME" --codex-home "$WORK/codex" > "$WORK/doctor.json"
node - "$WORK/doctor.json" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'ok') throw new Error('doctor did not report a healthy hook: ' + report.status);
NODE

HOME="$HOME_DIR" CLAUDE_HOME="$CLAUDE_HOME" SHIPYARD_PLUGIN_DIR="$PLUGIN" \
  SHIPYARD_GSD_AUTO_INSTALL=0 bash "$ROOT/scripts/install-shipyard-claude-hook.sh" --remove >/dev/null

[[ ! -e "$CLAUDE_HOME/hooks/shipyard-stop-gate" ]] || { echo "hook bundle was not removed" >&2; exit 1; }
if [[ -f "$CLAUDE_HOME/settings.json" ]] && grep -q 'shipyard-stop-gate' "$CLAUDE_HOME/settings.json"; then
  echo "stop hook remains after removal" >&2
  exit 1
fi

echo "claude hook smoke passed"
