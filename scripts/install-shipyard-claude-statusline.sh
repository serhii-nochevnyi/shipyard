#!/usr/bin/env bash
set -euo pipefail

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="$CLAUDE_HOME/settings.json"
BUNDLE="$CLAUDE_HOME/shipyard-statusline"
OWNED="$BUNDLE/owned.json"
SRC="$ROOT/plugins/delivery-pipeline/scripts"
SAMPLES="$HOME/.local/state/shipyard/claude/subscription"

MODE=install
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove) MODE=remove; shift ;;
    --check) MODE=check; shift ;;
    *) echo "error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }

settings_js() {
  ACTION="$1" SETTINGS="$SETTINGS" OWNED="$OWNED" BUNDLE="$BUNDLE" CLAUDE_HOME="$CLAUDE_HOME" node - <<'NODE'
const fs = require('node:fs');
const { SETTINGS, OWNED, BUNDLE, CLAUDE_HOME, ACTION } = process.env;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
const same = (a, b) => a !== undefined && b !== undefined && canon(a) === canon(b);
const settings = fs.existsSync(SETTINGS) ? readJson(SETTINGS) : {};
if (settings === null) { console.error('error: settings.json is not valid JSON'); process.exit(3); }
const current = settings.statusLine;
const owned = readJson(OWNED);
const installed = owned && owned.schema === 'shipyard.claude-statusline-ownership.v1' ? owned.installed : undefined;
const write = (s) => fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
if (ACTION === 'check') {
  process.stdout.write(same(current, installed) ? 'installed\n' : installed !== undefined ? 'foreign\n' : 'absent\n');
} else if (ACTION === 'state') {
  process.stdout.write(same(current, installed) ? 'installed' : 'other');
} else if (ACTION === 'validate') {
  const ok = current && typeof current === 'object' && !Array.isArray(current) && current.type === 'command'
    && typeof current.command === 'string' && current.command.trim() !== ''
    && Object.keys(current).every((k) => ['type', 'command', 'padding'].includes(k));
  if (!ok) { console.error('error: statusLine must be {type:"command", command:<string>[, padding]}; refusing'); process.exit(3); }
  if (current.command.includes('shipyard-statusline/statusline-collector.cjs')) {
    console.error('error: statusLine already runs a Shipyard wrapper without a matching ownership record; refusing');
    process.exit(3);
  }
} else if (ACTION === 'apply') {
  const previous = current;
  const b64 = Buffer.from(previous.command, 'utf8').toString('base64');
  const next = { type: 'command',
    command: `node '${BUNDLE}/statusline-collector.cjs' wrap --home '${CLAUDE_HOME}' --previous-b64 ${b64}` };
  if (Object.prototype.hasOwnProperty.call(previous, 'padding')) next.padding = previous.padding;
  fs.writeFileSync(OWNED, JSON.stringify({ schema: 'shipyard.claude-statusline-ownership.v1', previous, installed: next }, null, 2) + '\n');
  settings.statusLine = next;
  write(settings);
} else if (ACTION === 'remove') {
  if (installed !== undefined && same(current, installed)) {
    if (owned.previous === undefined) delete settings.statusLine;
    else settings.statusLine = owned.previous;
    write(settings);
    console.log('  restored the previous statusLine');
  } else if (installed !== undefined) {
    console.log('  statusLine was changed by the user; settings.json left unchanged');
  }
}
NODE
}

apply_label() {
  [[ -n "${ACCOUNT_LABEL:-}" ]] || return 0
  node "$1/subscription-store.cjs" label --runtime claude --home "$CLAUDE_HOME" --set "$ACCOUNT_LABEL" >/dev/null \
    || { echo "error: invalid ACCOUNT_LABEL; settings unchanged" >&2; return 1; }
  echo "  account label: $ACCOUNT_LABEL"
}

if [[ "$MODE" == check ]]; then
  settings_js check
  exit 0
fi

if [[ "$MODE" == remove ]]; then
  [[ -f "$SETTINGS" ]] && settings_js remove
  rm -rf "$BUNDLE"
  echo "✓ removed $BUNDLE; private samples kept under $SAMPLES"
  exit 0
fi

[[ -f "$SETTINGS" ]] || { echo "error: $SETTINGS not found; no statusLine to wrap" >&2; exit 3; }
if [[ "$(settings_js state)" == installed ]]; then
  apply_label "$BUNDLE"
  echo "✓ statusline wrapper already installed; no change"
  exit 0
fi
settings_js validate

TMP=""
cleanup() { [[ -z "$TMP" || ! -e "$TMP" ]] || rm -rf "$TMP"; }
trap cleanup EXIT
mkdir -p "$CLAUDE_HOME"
TMP="$(mktemp -d "$CLAUDE_HOME/shipyard-statusline.XXXXXX")"
for file in statusline-collector.cjs subscription-observation.cjs subscription-store.cjs lock.cjs; do
  cp "$SRC/$file" "$TMP/$file"
  node --check "$TMP/$file"
done
OK_B64="$(printf 'printf ok' | base64)"
[[ "$(printf '{}' | node "$TMP/statusline-collector.cjs" wrap --home "$CLAUDE_HOME" --previous-b64 "$OK_B64")" == ok ]] \
  || { echo "error: bundled collector failed its smoke run" >&2; exit 1; }
apply_label "$TMP"
rm -rf "$BUNDLE"
mv "$TMP" "$BUNDLE"
TMP=""
settings_js apply
echo "✓ statusline wrapper installed ($BUNDLE); run with --check or --remove"
