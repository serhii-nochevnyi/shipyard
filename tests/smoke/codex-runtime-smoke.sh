#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-}"
shift || true
WORKTREE=""
while (($#)); do
  case "$1" in
    --worktree)
      [[ -z "$WORKTREE" && $# -ge 2 && -n "$2" ]] || { echo "invalid --worktree" >&2; exit 2; }
      WORKTREE="$2"
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  --capability-only) [[ -z "$WORKTREE" ]] || { echo "--worktree is only valid with --live" >&2; exit 2; } ;;
  --live) [[ -n "$WORKTREE" ]] || { echo "usage: codex-runtime-smoke.sh --live --worktree <scratch-worktree>" >&2; exit 2; } ;;
  *) echo "usage: codex-runtime-smoke.sh --capability-only | --live --worktree <scratch-worktree>" >&2; exit 2 ;;
esac

if [[ "$MODE" == "--live" ]]; then
  WORKTREE="$(cd "$WORKTREE" 2>/dev/null && pwd -P)" || {
    echo '{"status":"refused","reason":"scratch_worktree_unavailable"}'
    exit 1
  }
  ROOT="$(cd "$ROOT" && pwd -P)"
  if [[ "$WORKTREE" == "$ROOT" ]]; then
    echo '{"status":"refused","reason":"source_worktree_not_allowed"}'
    exit 1
  fi
  GIT_ROOT="$(git -C "$WORKTREE" rev-parse --show-toplevel 2>/dev/null)" || {
    echo '{"status":"refused","reason":"scratch_git_worktree_required"}'
    exit 1
  }
  GIT_ROOT="$(cd "$GIT_ROOT" 2>/dev/null && pwd -P)" || {
    echo '{"status":"refused","reason":"scratch_git_worktree_required"}'
    exit 1
  }
  if [[ "$GIT_ROOT" != "$WORKTREE" ]]; then
    echo '{"status":"refused","reason":"scratch_worktree_root_required"}'
    exit 1
  fi
  GIT_STATUS="$(git -C "$WORKTREE" status --porcelain --untracked-files=all 2>/dev/null)" || {
    echo '{"status":"refused","reason":"scratch_worktree_status_unavailable"}'
    exit 1
  }
  if [[ -n "$GIT_STATUS" ]]; then
    echo '{"status":"refused","reason":"scratch_worktree_not_clean"}'
    exit 1
  fi
  [[ -f "$WORKTREE/.planning/config.json" ]] || {
    echo '{"status":"refused","reason":"planning_config_missing"}'
    exit 1
  }
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shipyard-codex-runtime.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
CATALOG_FILE="$TMP_DIR/catalog.json"
CAPABILITIES_FILE="$TMP_DIR/capabilities.json"

if ! codex debug models >"$CATALOG_FILE" 2>/dev/null; then
  echo '{"status":"unavailable","reason":"model_catalog_unavailable"}'
  exit 0
fi

if ! node - "$CATALOG_FILE" "$CAPABILITIES_FILE" <<'NODE'
'use strict';
const fs = require('node:fs');
const [catalogFile, outputFile] = process.argv.slice(2);
let catalog;
try { catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')); }
catch (_) { process.exit(1); }
if (!catalog || !Array.isArray(catalog.models)) process.exit(1);
const models = catalog.models.filter((model) => model && typeof model.slug === 'string'
  && model.slug && model.visibility === 'list' && model.supported_in_api === true);
const selections = models.flatMap((model) => (Array.isArray(model.supported_reasoning_levels)
  ? model.supported_reasoning_levels : [])
  .filter((level) => level && typeof level.effort === 'string' && level.effort)
  .map((level) => ({ model: model.slug, effort: level.effort })));
if (!selections.some((entry) => entry.model === 'gpt-6-luna' && entry.effort === 'max')) process.exit(1);
const version = require('node:child_process').spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 10000 });
if (version.error || version.status !== 0) process.exit(1);
const cliVersion = String(version.stdout || version.stderr).trim().replace(/^codex-cli\s+/i, '');
fs.writeFileSync(outputFile, JSON.stringify({
  supportedModels: [...new Set(models.map((model) => model.slug))].sort(),
  supportedEfforts: [...new Set(selections.map((entry) => entry.effort))].sort(),
  supportedSelections: selections,
  cliVersion,
}) + '\n', { mode: 0o600 });
NODE
then
  echo '{"status":"unavailable","reason":"gpt_6_luna_max_not_in_active_catalog"}'
  exit 0
fi

if ! codex login status >/dev/null 2>&1; then
  echo '{"status":"unavailable","reason":"chatgpt_login_unavailable"}'
  exit 0
fi

PROBE="$(node "$ROOT/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs" \
  --capability-only --capabilities-file "$CAPABILITIES_FILE")"
PROBE_RESULT="$(node - "$PROBE" "$ROOT" <<'NODE'
'use strict';
const path = require('node:path');
const probe = JSON.parse(process.argv[2]);
const root = process.argv[3];
if (probe.schema !== 'shipyard.codex-runtime-probe.v1' || probe.version !== 1) {
  throw new Error('invalid Codex runtime probe schema');
}
if (probe.status !== 'available') {
  process.stdout.write(JSON.stringify({ status: 'unavailable', reason: probe.reason || 'runtime_unavailable' }));
  process.exit(0);
}
const pair = probe.capabilities && Array.isArray(probe.capabilities.supportedSelections)
  && probe.capabilities.supportedSelections.some((entry) => entry.model === 'gpt-6-luna' && entry.effort === 'max');
if (!pair) {
  process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'gpt_6_luna_max_not_supported' }));
  process.exit(0);
}
let providerRefusal = false;
try {
  require(path.join(root, 'plugins/delivery-pipeline/scripts/codex-runtime-host.cjs')).normalizeScope({
    run_id: 'provider-check', ticket: 'T-38-04', phase: 38, worktree: '/tmp', runtime: 'codex', provider: 'anthropic',
  });
} catch (error) {
  if (error.code !== 'RUNTIME_PROVIDER_MISMATCH') throw error;
  providerRefusal = true;
}
if (!providerRefusal) throw new Error('Codex host accepted Anthropic provider scope');
process.stdout.write(JSON.stringify({ status: 'available', runtime_version: probe.runtime_version,
  model: 'gpt-6-luna', effort: 'max', provider: 'openai', auth: 'chatgpt', provider_refusal: 'verified' }));
NODE
)"
PROBE_STATUS="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.status)' "$PROBE_RESULT")"
if [[ "$PROBE_STATUS" != "available" ]]; then
  echo "$PROBE_RESULT"
  exit 0
fi

if [[ "$MODE" == "--capability-only" ]]; then
  echo "$PROBE_RESULT"
  exit 0
fi

set +e
node - "$ROOT" "$WORKTREE" "$CAPABILITIES_FILE" <<'NODE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const worktree = process.argv[3];
const capabilities = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const { createCodexDeliveryHost } = require(path.join(root, 'plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'));
const nonce = crypto.randomBytes(12).toString('hex');
const file = '.shipyard-codex-smoke-' + nonce + '.txt';
const runId = 'codex-smoke-' + nonce;
const prompt = [
  'This is a one-run runtime smoke test in the current worktree.',
  'Use the patch or file-edit tool, not a shell write, to create only ' + file + ' with exactly this text: ' + nonce + '.',
  'Then use Bash to run: bash -lc \'test "$(cat ' + file + ')" = "' + nonce + '" && printf BASH_OK\'.',
  'Do not edit, create, or commit any other project file. Do not claim success unless that Bash command prints BASH_OK.',
].join('\n');
const scope = {
  run_id: runId,
  ticket: 'T-38-04-smoke',
  phase: 38,
  worktree,
  runtime: 'codex',
  provider: 'openai',
};

(async () => {
  try {
    const result = await createCodexDeliveryHost({ scope, capabilities }).run({
      role: 'executor',
      context: { prompt },
    });
    const receipt = result.receipt;
    const runtimeEvidence = receipt && receipt.runtime_evidence;
    const native = runtimeEvidence && runtimeEvidence.native_session_evidence;
    const target = path.join(worktree, file);
    const markerContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (markerContent !== nonce && markerContent !== nonce + '\n') {
      throw Object.assign(new Error('Codex did not create the exact smoke marker'), { code: 'LIVE_SMOKE_EDIT_FAILED' });
    }
    if (!runtimeEvidence || runtimeEvidence.applied_model !== 'gpt-6-luna'
        || runtimeEvidence.applied_effort !== 'max'
        || !native || native.provider !== 'openai' || native.session_id !== runtimeEvidence.session_id
        || !native.selections.some((entry) => entry.model === 'gpt-6-luna' && entry.effort === 'max')) {
      throw Object.assign(new Error('Codex native session did not prove Luna/max'), { code: 'LIVE_SMOKE_EVIDENCE_FAILED' });
    }
    const transcriptPath = runtimeEvidence.transcript && runtimeEvidence.transcript.path;
    if (typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
      throw Object.assign(new Error('Codex event stream transcript is missing'), { code: 'LIVE_SMOKE_TRANSCRIPT_MISSING' });
    }
    let editApplied = false;
    let bashPassed = false;
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (_) { continue; }
      const item = record.item;
      if (!item) continue;
      if (item.type === 'file_change' && item.status === 'completed' && Array.isArray(item.changes)) {
        editApplied = editApplied || item.changes.some((change) => {
          const changedPath = change && typeof change.path === 'string' ? change.path : '';
          return changedPath && path.resolve(worktree, changedPath) === target;
        });
      }
      if (item.type !== 'command_execution' || item.status !== 'completed' || item.exit_code !== 0) continue;
      const command = String(item.command || item.command_line || '');
      const output = String(item.aggregated_output || item.output || item.stdout || '');
      bashPassed = bashPassed || (command.includes('bash -lc') && command.includes(file)
        && command.includes(nonce) && command.includes('BASH_OK') && output.includes('BASH_OK'));
    }
    if (!editApplied || !bashPassed) {
      throw Object.assign(new Error('Codex event stream does not prove the requested Bash command and output'), { code: 'LIVE_SMOKE_BASH_FAILED' });
    }
    console.log(JSON.stringify({
      status: 'passed', model: native.models[0], effort: native.efforts[0],
      provider: native.provider, session_id: native.session_id,
      process_id: runtimeEvidence.process_id, bash: 'verified', edit: 'verified',
    }));
  } catch (error) {
    const unavailable = new Set([
      'RUNTIME_UNAVAILABLE', 'RUNTIME_EVIDENCE_MISSING', 'RUNTIME_CAPABILITY_MISSING',
      'RUNTIME_AUTH_UNAVAILABLE',
    ]);
    const status = unavailable.has(error.code) ? 'unavailable' : 'refused';
    const details = error.details || {};
    const detail = String(details.stderr || details.detail || error.message || '')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      .replace(/(?:OPENAI|CODEX)_API_KEY[=:]\s*\S+/g, '[redacted]')
      .slice(0, 240);
    console.log(JSON.stringify({ status, reason: error.code || 'live_smoke_failed', detail }));
    process.exitCode = 1;
  }
})();
NODE
LIVE_STATUS=$?
set -e
exit "$LIVE_STATUS"
