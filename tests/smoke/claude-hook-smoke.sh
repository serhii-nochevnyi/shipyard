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

ROUTE_HOOK="$CLAUDE_HOME/hooks/shipyard-auto-route.sh"
ROUTE_CJS="$CLAUDE_HOME/hooks/shipyard-auto-route.cjs"

node - "$CLAUDE_HOME/settings.json" "$CLAUDE_HOME/hooks/shipyard-stop-gate" "$CLAUDE_HOME/hooks/shipyard-pre-push-gate.sh" "$ROUTE_HOOK" <<'NODE'
const fs = require('node:fs');
const [settingsFile, bundle, prePush, routeHook] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const commands = (settings.hooks.Stop || []).flatMap((group) => (group.hooks || []).map((hook) => hook.command));
const prePushCommands = (settings.hooks.PreToolUse || []).flatMap((group) => (group.hooks || []).map((hook) => hook.command));
const routeCommands = (settings.hooks.UserPromptSubmit || []).flatMap((group) => (group.hooks || []).map((hook) => hook.command));
if (!commands.includes(`node "${bundle}/stop-gate.cjs"`)) throw new Error('new stop hook is missing');
if (!commands.includes(`node "${bundle}/session-observer.cjs" hook`)) throw new Error('session observer hook is missing');
if (!prePushCommands.includes(`bash "${prePush}"`)) throw new Error('pre-push hook is missing');
if (!routeCommands.includes(`bash "${routeHook}"`)) throw new Error('route hook is not registered');
if (commands.some((command) => command.endsWith('/shipyard-stop-gate.cjs"'))) throw new Error('old stop hook remains');
if (!(settings.hooks.Notification || []).some((group) => (group.hooks || []).some((hook) => hook.command === 'echo keep-me'))) {
  throw new Error('unrelated hook was changed');
}
for (const file of ['stop-gate.cjs', 'run-waker.cjs', 'run-store.cjs', 'publish-gate.cjs', 'comment-policy.cjs', 'session-observer.cjs', 'usage-report.cjs']) {
  if (!fs.existsSync(require('node:path').join(bundle, file))) throw new Error(`missing bundled dependency: ${file}`);
}
NODE

[[ -f "$ROUTE_HOOK" ]] || { echo "route hook wrapper is missing" >&2; exit 1; }
[[ -f "$ROUTE_CJS" ]] || { echo "route hook module is missing" >&2; exit 1; }

PLAIN_OUT="$(printf '{"prompt":"add a new feature"}' | bash "$ROUTE_HOOK")"
[[ -n "$PLAIN_OUT" ]] || { echo "a plain prompt did not inject" >&2; exit 1; }
grep -q '/shipyard:route' <<<"$PLAIN_OUT" || { echo "installed policy is missing /shipyard:route" >&2; exit 1; }
grep -q '/shipyard:investigate' <<<"$PLAIN_OUT" || { echo "installed policy is missing /shipyard:investigate" >&2; exit 1; }

NOTIF_OUT="$(printf '{"prompt":"<task-notification>ping</task-notification>"}' | bash "$ROUTE_HOOK")"
[[ -z "$NOTIF_OUT" ]] || { echo "a task-notification prompt unexpectedly injected" >&2; exit 1; }

SLASH_OUT="$(printf '{"prompt":"/shipyard:deliver"}' | bash "$ROUTE_HOOK")"
[[ -z "$SLASH_OUT" ]] || { echo "a slash command unexpectedly injected" >&2; exit 1; }

INVALID_OUT="$(printf 'not json' | bash "$ROUTE_HOOK")"
[[ -n "$INVALID_OUT" ]] || { echo "invalid JSON did not inject" >&2; exit 1; }

EMPTY_OUT="$(printf '' | bash "$ROUTE_HOOK")"
[[ -n "$EMPTY_OUT" ]] || { echo "empty stdin did not inject" >&2; exit 1; }

node "$ROOT/scripts/shipyard-doctor.cjs" --json \
  --claude-home "$CLAUDE_HOME" --codex-home "$WORK/codex" > "$WORK/doctor.json"
node - "$WORK/doctor.json" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'ok') throw new Error('doctor did not report a healthy hook: ' + report.status);
const agents = report.checks.find((c) => c.name === 'codex-agents');
if (!agents || agents.level !== 'skip') throw new Error('an absent agents manifest must skip: ' + JSON.stringify(agents));
NODE

CODEX_AGENTS_DIR="$WORK/codex/agents"
mkdir -p "$CODEX_AGENTS_DIR"
printf 'name = "shipyard-executor"\n' > "$CODEX_AGENTS_DIR/shipyard-executor.toml"
printf '{"agent_files":["shipyard-executor.toml"]}' > "$CODEX_AGENTS_DIR/.shipyard-manifest.json"
node "$ROOT/scripts/shipyard-doctor.cjs" --json \
  --claude-home "$CLAUDE_HOME" --codex-home "$WORK/codex" > "$WORK/doctor-agents.json"
node - "$WORK/doctor-agents.json" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const agents = report.checks.find((c) => c.name === 'codex-agents');
if (!agents || agents.level !== 'ok') throw new Error('a populated agents manifest must report ok: ' + JSON.stringify(agents));
if (report.status !== 'ok') throw new Error('a valid agents manifest must not fail the report: ' + report.status);
NODE

printf '{ not json' > "$CODEX_AGENTS_DIR/.shipyard-manifest.json"
node "$ROOT/scripts/shipyard-doctor.cjs" --json \
  --claude-home "$CLAUDE_HOME" --codex-home "$WORK/codex" > "$WORK/doctor-corrupt.json" || true
node - "$WORK/doctor-corrupt.json" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const agents = report.checks.find((c) => c.name === 'codex-agents');
if (!agents || agents.level !== 'error') throw new Error('a corrupt agents manifest must fail: ' + JSON.stringify(agents));
if (report.status !== 'error') throw new Error('a corrupt agents manifest must fail the overall report: ' + report.status);
NODE

HOME="$HOME_DIR" CLAUDE_HOME="$CLAUDE_HOME" SHIPYARD_PLUGIN_DIR="$PLUGIN" \
  SHIPYARD_GSD_AUTO_INSTALL=0 bash "$ROOT/scripts/install-shipyard-claude-hook.sh" --remove >/dev/null

[[ ! -e "$CLAUDE_HOME/hooks/shipyard-stop-gate" ]] || { echo "hook bundle was not removed" >&2; exit 1; }
[[ ! -e "$ROUTE_HOOK" ]] || { echo "route hook wrapper was not removed" >&2; exit 1; }
[[ ! -e "$ROUTE_CJS" ]] || { echo "route hook module was not removed" >&2; exit 1; }
if [[ -f "$CLAUDE_HOME/settings.json" ]] && grep -q 'shipyard-stop-gate' "$CLAUDE_HOME/settings.json"; then
  echo "stop hook remains after removal" >&2
  exit 1
fi
if [[ -f "$CLAUDE_HOME/settings.json" ]] && grep -q 'shipyard-auto-route' "$CLAUDE_HOME/settings.json"; then
  echo "route hook remains after removal" >&2
  exit 1
fi

RELEASE_CACHE="$CLAUDE_HOME/plugins/cache/shipyard/shipyard/$PLUGIN_VERSION"
mkdir -p "$RELEASE_CACHE"
printf 'release\n' > "$RELEASE_CACHE/marker.txt"
CACHE_BEFORE="$(ls -laR "$CLAUDE_HOME/plugins/cache")"
DOGFOOD="$WORK/dogfood"
HOME="$HOME_DIR" CLAUDE_HOME="$CLAUDE_HOME" SHIPYARD_GSD_AUTO_INSTALL=0 \
  bash "$ROOT/scripts/install-shipyard-claude-hook.sh" --dogfood-root "$DOGFOOD" > "$WORK/dogfood.out"
grep -q "claude --plugin-dir \"$DOGFOOD\"" "$WORK/dogfood.out" || { echo "dogfood launch line is missing" >&2; exit 1; }
[[ -f "$DOGFOOD/.claude-plugin/plugin.json" ]] || { echo "dogfood payload was not copied" >&2; exit 1; }
node - "$DOGFOOD/.shipyard-provenance.json" "$(git -C "$ROOT" rev-parse HEAD)" <<'NODE'
const fs = require('node:fs');
const [file, sha] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
if (p.schema !== 'shipyard.host-provenance.v1' || p.install_kind !== 'dogfood') throw new Error('bad dogfood record: ' + JSON.stringify(p));
if (p.source_sha !== sha || typeof p.dirty !== 'boolean') throw new Error('dogfood record lacks sha or dirty: ' + JSON.stringify(p));
if ((fs.statSync(file).mode & 0o777) !== 0o644) throw new Error('dogfood record mode is not 0644');
NODE
[[ "$(ls -laR "$CLAUDE_HOME/plugins/cache")" == "$CACHE_BEFORE" ]] || { echo "dogfood install touched the Claude cache" >&2; exit 1; }
if HOME="$HOME_DIR" CLAUDE_HOME="$CLAUDE_HOME" SHIPYARD_GSD_AUTO_INSTALL=0 \
  bash "$ROOT/scripts/install-shipyard-claude-hook.sh" --dogfood-root "$RELEASE_CACHE/../dogfood" >/dev/null 2>&1; then
  echo "a dogfood root inside the Claude cache was accepted" >&2
  exit 1
fi
[[ ! -e "$RELEASE_CACHE/../dogfood" ]] || { echo "refused dogfood root was still created" >&2; exit 1; }
[[ "$(ls -laR "$CLAUDE_HOME/plugins/cache")" == "$CACHE_BEFORE" ]] || { echo "refused dogfood install touched the Claude cache" >&2; exit 1; }

LIVE_CODEX="$WORK/live-codex"
CODEX_RELEASE="$LIVE_CODEX/plugins/cache/shipyard/shipyard/1.0.0+codex.0123456789abcdef"
mkdir -p "$CODEX_RELEASE" "$HOME_DIR/.codex"
: > "$WORK/codex-dogfood.err"
LIVE_BEFORE="$(ls -laR "$LIVE_CODEX")"
for refused in "$LIVE_CODEX" "$CODEX_RELEASE" "$CODEX_RELEASE/../dogfood" "$HOME_DIR/.codex/dogfood"; do
  status=0
  HOME="$HOME_DIR" CODEX_HOME="$LIVE_CODEX" SHIPYARD_GSD_AUTO_INSTALL=0 \
    bash "$ROOT/scripts/install-shipyard-codex.sh" --dogfood-root "$refused" >/dev/null 2>"$WORK/codex-dogfood.err" || status=$?
  [[ "$status" == 3 ]] || { echo "codex dogfood root $refused was not refused (exit $status)" >&2; exit 1; }
done
[[ ! -e "$CODEX_RELEASE/../dogfood" && ! -e "$HOME_DIR/.codex/dogfood" ]] || { echo "refused codex dogfood root was still created" >&2; exit 1; }
[[ "$(ls -laR "$LIVE_CODEX")" == "$LIVE_BEFORE" ]] || { echo "refused codex dogfood install touched the live CODEX_HOME" >&2; exit 1; }
HOME="$HOME_DIR" CODEX_HOME="$LIVE_CODEX" SHIPYARD_GSD_AUTO_INSTALL=0 \
  bash "$ROOT/scripts/install-shipyard-codex.sh" --dogfood-root "$WORK/codex-dogfood" >/dev/null 2>"$WORK/codex-dogfood.err" || true
if grep -q 'refusing dogfood root' "$WORK/codex-dogfood.err"; then
  echo "a separate codex dogfood root was refused" >&2
  exit 1
fi

REL_REPO="$WORK/release-repo"
mkdir -p "$REL_REPO/plugins/delivery-pipeline/scripts" "$REL_REPO/plugins/shipyard"
printf 'released\n' > "$REL_REPO/plugins/delivery-pipeline/scripts/a.cjs"
printf '{"version":"1.0.0+codex.0123456789abcdef","digest":"good"}\n' > "$REL_REPO/plugins/shipyard/package-build.json"
git -C "$REL_REPO" init -q
git -C "$REL_REPO" add .
git -C "$REL_REPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm release
git -C "$REL_REPO" -c tag.gpgsign=false tag v1.0.0
CACHE_HOME="$WORK/cache-claude"
CODEX_CACHE_HOME="$WORK/cache-codex"
mkdir -p "$CACHE_HOME/plugins/cache/shipyard/shipyard/1.0.0/scripts" \
  "$CODEX_CACHE_HOME/plugins/cache/shipyard/shipyard/1.0.0+codex.0123456789abcdef"
cp "$REL_REPO/plugins/delivery-pipeline/scripts/a.cjs" "$CACHE_HOME/plugins/cache/shipyard/shipyard/1.0.0/scripts/a.cjs"
cp "$REL_REPO/plugins/shipyard/package-build.json" "$CODEX_CACHE_HOME/plugins/cache/shipyard/shipyard/1.0.0+codex.0123456789abcdef/"

cache_doctor() {
  node "$ROOT/scripts/shipyard-doctor.cjs" --json --claude-home "$CACHE_HOME" \
    --codex-home "$CODEX_CACHE_HOME" --release-repo "$REL_REPO" > "$WORK/doctor-cache.json" || true
  node - "$WORK/doctor-cache.json" "$1" "$2" "$3" <<'NODE'
const fs = require('node:fs');
const [file, name, level, pattern] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const c = report.checks.find((x) => x.name === name);
if (!c || c.level !== level || !new RegExp(pattern).test(c.detail)) throw new Error(`${name} expected ${level} /${pattern}/: ` + JSON.stringify(c));
NODE
}
cache_doctor 'claude-cache 1.0.0' ok 'matches v1.0.0'
cache_doctor 'codex-cache 1.0.0+codex.0123456789abcdef' ok 'matches v1.0.0'
printf 'unmerged\n' > "$CACHE_HOME/plugins/cache/shipyard/shipyard/1.0.0/scripts/a.cjs"
printf '{"version":"1.0.0+codex.0123456789abcdef","digest":"bad"}\n' \
  > "$CODEX_CACHE_HOME/plugins/cache/shipyard/shipyard/1.0.0+codex.0123456789abcdef/package-build.json"
CACHE_TREE_BEFORE="$(ls -laR "$CACHE_HOME" "$CODEX_CACHE_HOME")"
cache_doctor 'claude-cache 1.0.0' error 'cache matches no release \(1 files differ: scripts/a\.cjs\)'
cache_doctor 'codex-cache 1.0.0+codex.0123456789abcdef' error 'codex cache matches no release'
[[ "$(ls -laR "$CACHE_HOME" "$CODEX_CACHE_HOME")" == "$CACHE_TREE_BEFORE" ]] || { echo "doctor wrote into a cache" >&2; exit 1; }
mv "$CACHE_HOME/plugins/cache/shipyard/shipyard/1.0.0" "$CACHE_HOME/plugins/cache/shipyard/shipyard/2.0.0"
cache_doctor 'claude-cache 2.0.0' skip 'no v2.0.0 tag'

echo "claude hook smoke passed"
