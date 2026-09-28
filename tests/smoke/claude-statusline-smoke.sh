#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$ROOT/scripts/install-shipyard-claude-statusline.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/statusline-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
export CLAUDE_HOME="$HOME/.claude"
SETTINGS="$CLAUDE_HOME/settings.json"
BUNDLE="$CLAUDE_HOME/shipyard-statusline"
STATE="$HOME/.local/state/shipyard/claude/subscription"
mkdir -p "$CLAUDE_HOME"
[[ -f "$INSTALLER" ]] || { echo "statusline smoke: installer missing: $INSTALLER" >&2; exit 1; }

fail() { echo "statusline smoke: $*" >&2; exit 1; }
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
run() { bash "$INSTALLER" "$@"; }
mode() { node -e 'process.stdout.write((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }
BEFORE_TREE="$(git -C "$ROOT" status --porcelain --untracked-files=all)"

RENDERER="$CLAUDE_HOME/statusline.sh"
cat > "$RENDERER" <<'EOF'
cat >/dev/null
printf 'RENDER-OUT\n'
printf 'RENDER-ERR\n' >&2
exit 3
EOF

write_settings() {
  STATUS="$1" SETTINGS="$SETTINGS" node -e '
const fs = require("node:fs");
const s = { theme: "dark", hooks: { Stop: [] } };
if (process.env.STATUS !== "absent") s.statusLine = JSON.parse(process.env.STATUS);
fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2) + "\n");'
}

VALID='{"type":"command","command":"bash '"$RENDERER"'","padding":0}'

for bad in absent '"bash x.sh"' '{"type":"command","command":"bash x.sh","extra":1}'; do
  write_settings "$bad"
  before="$(sha "$SETTINGS")"
  if run >/dev/null 2>&1; then fail "case 1: install accepted $bad"; fi
  [[ "$(sha "$SETTINGS")" == "$before" ]] || fail "case 1: refusal changed settings for $bad"
  [[ ! -e "$BUNDLE" ]] || fail "case 1: refusal left a bundle for $bad"
done
echo "case 1 ok"

write_settings "$VALID"
cp "$SETTINGS" "$WORK/original.json"
run >/dev/null
[[ -f "$BUNDLE/owned.json" ]] || fail "case 2: owned.json missing"
SETTINGS="$SETTINGS" node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.env.SETTINGS, "utf8"));
if (s.theme !== "dark" || !Array.isArray(s.hooks.Stop)) throw new Error("unrelated keys changed");
if (s.statusLine.padding !== 0 || s.statusLine.type !== "command") throw new Error("statusLine shape changed");
if (!s.statusLine.command.includes("statusline-collector.cjs")) throw new Error("wrapper not installed");' || fail "case 2: settings"
before="$(sha "$SETTINGS")"
[[ "$(run --check)" == "installed" ]] || fail "case 2: --check did not print installed"
[[ "$(sha "$SETTINGS")" == "$before" ]] || fail "case 2: --check changed settings"
echo "case 2 ok"

CMD="$(SETTINGS="$SETTINGS" node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.SETTINGS,"utf8")).statusLine.command)')"
sed -n 2p "$ROOT/tests/fixtures/captured/claude-statusline.jsonl" > "$WORK/input.json"
status=0
/bin/sh -c "$CMD" < "$WORK/input.json" > "$WORK/out" 2> "$WORK/err" || status=$?
printf 'RENDER-OUT\n' > "$WORK/want-out"
printf 'RENDER-ERR\n' > "$WORK/want-err"
[[ "$status" == 3 ]] || fail "case 3: exit $status, want 3"
cmp -s "$WORK/out" "$WORK/want-out" || fail "case 3: stdout differs"
cmp -s "$WORK/err" "$WORK/want-err" || fail "case 3: stderr differs"
sample="$(ls "$STATE"/samples-*.jsonl 2>/dev/null | head -1 || true)"
[[ -n "$sample" ]] || fail "case 3: no sample under $STATE"
[[ "$(mode "$sample")" == 600 ]] || fail "case 3: sample mode"
[[ "$(mode "$STATE")" == 700 ]] || fail "case 3: state dir mode"
[[ "$(git -C "$ROOT" status --porcelain --untracked-files=all)" == "$BEFORE_TREE" ]] || fail "case 3: worktree changed"
echo "case 3 ok"

ACCOUNT_LABEL=claude-max-1 run >/dev/null
label="$(node "$ROOT/plugins/delivery-pipeline/scripts/subscription-store.cjs" label --runtime claude --home "$CLAUDE_HOME" --show)"
[[ "$label" == *'"label":"claude-max-1"'* ]] || fail "case 4: label not recorded: $label"
before="$(sha "$SETTINGS")"
if ACCOUNT_LABEL='me@x' run >/dev/null 2>&1; then fail "case 4: invalid label accepted"; fi
[[ "$(sha "$SETTINGS")" == "$before" ]] || fail "case 4: invalid label changed settings"
echo "case 4 ok"

run >/dev/null
BUNDLE="$BUNDLE" ORIG="$WORK/original.json" node -e '
const fs = require("node:fs");
const owned = JSON.parse(fs.readFileSync(process.env.BUNDLE + "/owned.json", "utf8"));
const orig = JSON.parse(fs.readFileSync(process.env.ORIG, "utf8")).statusLine;
if (JSON.stringify(owned.previous) !== JSON.stringify(orig)) throw new Error("owned.previous drifted");' || fail "case 5: double install"
run --remove >/dev/null
cmp -s "$SETTINGS" "$WORK/original.json" || fail "case 5: settings not restored byte-identically"
[[ ! -e "$BUNDLE" ]] || fail "case 5: bundle not removed"
[[ "$(run --check)" == "absent" ]] || fail "case 5: --check after remove"
echo "case 5 ok"

run >/dev/null
SETTINGS="$SETTINGS" node -e '
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.env.SETTINGS, "utf8"));
s.statusLine = { type: "command", command: "bash edited.sh" };
fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2) + "\n");'
cp "$SETTINGS" "$WORK/edited.json"
[[ "$(run --check)" == "foreign" ]] || fail "case 6: --check did not print foreign"
run --remove >/dev/null
cmp -s "$SETTINGS" "$WORK/edited.json" || fail "case 6: user edit not kept"
[[ ! -e "$BUNDLE" ]] || fail "case 6: bundle not removed"
echo "case 6 ok"

echo "claude statusline smoke passed"
