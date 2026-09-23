#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-}"
shift || true
GSD_ROLE=""
WORKTREE=""
while (($#)); do
  case "$1" in
    --worktree)
      [[ -z "$WORKTREE" && $# -ge 2 && -n "$2" ]] || { echo "invalid --worktree" >&2; exit 2; }
      WORKTREE="$2"
      shift 2
      ;;
    --gsd-role)
      [[ -z "$GSD_ROLE" && $# -ge 2 && -n "$2" ]] || { echo "invalid --gsd-role" >&2; exit 2; }
      GSD_ROLE="$2"
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  --capability-only) [[ -z "$GSD_ROLE" && -z "$WORKTREE" ]] || { echo "--gsd-role and --worktree are only valid with --live" >&2; exit 2; } ;;
  --live) [[ -z "$GSD_ROLE" || "$GSD_ROLE" == "gsd-plan-checker" ]] || { echo "unsupported --gsd-role" >&2; exit 2; } ;;
  *) echo "usage: codex-runtime-smoke.sh --capability-only | --live [--worktree <clean-scratch-worktree>] [--gsd-role gsd-plan-checker]" >&2; exit 2 ;;
esac

if [[ -n "$WORKTREE" ]]; then
  WORKTREE="$(cd "$WORKTREE" 2>/dev/null && pwd -P)" || {
    echo '{"status":"refused","reason":"scratch_worktree_unavailable"}'
    exit 1
  }
  if [[ "$WORKTREE" == "$(cd "$ROOT" && pwd -P)" ]]; then
    echo '{"status":"refused","reason":"source_worktree_not_allowed"}'
    exit 1
  fi
  GIT_ROOT="$(git -C "$WORKTREE" rev-parse --show-toplevel 2>/dev/null)" || {
    echo '{"status":"refused","reason":"scratch_git_worktree_required"}'
    exit 1
  }
  if [[ "$(cd "$GIT_ROOT" 2>/dev/null && pwd -P)" != "$WORKTREE" ]]; then
    echo '{"status":"refused","reason":"scratch_worktree_root_required"}'
    exit 1
  fi
  if [[ -n "$(git -C "$WORKTREE" status --porcelain --untracked-files=all 2>/dev/null)" ]]; then
    echo '{"status":"refused","reason":"scratch_worktree_not_clean"}'
    exit 1
  fi
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shipyard-codex-runtime.XXXXXX")"
if [[ "${SHIPYARD_KEEP_SMOKE_ARTIFACTS:-}" == "1" ]]; then
  trap 'printf "SMOKE_ARTIFACTS=%s\\n" "$TMP_DIR" >&2' EXIT
else
  trap 'rm -rf "$TMP_DIR"' EXIT
fi
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
node - "$ROOT" "$TMP_DIR" "$CAPABILITIES_FILE" "$GSD_ROLE" "$WORKTREE" <<'NODE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = process.argv[2];
const temporary = process.argv[3];
const capabilities = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const gsdRole = process.argv[5];
const suppliedWorktree = process.argv[6];
const { createCodexDeliveryHost } = require(path.join(root, 'plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'));
const { createCodexDecomposeHost } = require(path.join(root, 'plugins/delivery-pipeline/scripts/codex-decompose-host.cjs'));
const { installedGsdAgent, signerProtectionPaths, signerPermissionProfileArgs } = require(path.join(root, 'plugins/delivery-pipeline/scripts/codex-runtime-host.cjs'));
const nonce = crypto.randomBytes(12).toString('hex');
const ticket = 'T-38-04';
const file = 'codex-smoke.txt';
const deliveryFile = 'codex-delivery-smoke.txt';
const runId = 'codex-smoke-' + nonce;
const repository = path.join(temporary, 'repository');
const worktree = suppliedWorktree || path.join(temporary, 'scratch-worktree');
const storageRoot = path.join(temporary, 'host-state');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

function prepareScratch() {
  let key = '';
  try { key = git(suppliedWorktree || root, 'config', '--get', 'user.signingkey'); }
  catch {}
  if (!key) refuse('SIGNER_UNAVAILABLE', 'Git user.signingkey is not configured');
  let secrets;
  try { secrets = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys', key],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (_) { refuse('SIGNER_UNAVAILABLE', 'Git signing key is unavailable to GPG'); }
  const lines = secrets.split(/\r?\n/);
  const fingerprint = lines.find((line) => line.startsWith('fpr:'))?.split(':')[9];
  if (lines.filter((line) => line.startsWith('sec:')).length !== 1
      || !/^[0-9A-F]{40}$/i.test(fingerprint || '')) {
    refuse('SIGNER_UNAVAILABLE', 'Git signing key has no unique full fingerprint');
  }
  let base;
  let branch;
  let graphDir;
  if (suppliedWorktree) {
    base = git(worktree, 'rev-parse', 'HEAD');
    branch = git(worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    graphDir = path.join(temporary, 'graph');
    fs.mkdirSync(graphDir);
  } else {
    branch = 'ticket/T-38-04-codex-smoke';
    fs.mkdirSync(repository);
    git(repository, 'init', '-q', '-b', 'main');
    git(repository, 'config', 'user.name', 'Codex Smoke');
    git(repository, 'config', 'user.email', 'codex-smoke@example.test');
    git(repository, 'config', 'user.signingkey', key);
    graphDir = path.join(repository, '.planning', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(repository, '.planning', 'config.json'), '{}\n');
  }
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: {
    [ticket]: { branch, pr_base: suppliedWorktree ? base : 'main', files: [file, deliveryFile] },
  } }) + '\n');
  if (!suppliedWorktree) {
    git(repository, 'add', '.planning');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'scratch base');
    base = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'worktree', 'add', '-q', '-b', branch, worktree, base);
  }
  if (git(worktree, 'status', '--porcelain', '--untracked-files=all')) {
    refuse('SCRATCH_NOT_CLEAN', 'new scratch worktree is not clean');
  }
  const fakeSigner = path.join(temporary, 'protected-signer-probe');
  fs.mkdirSync(fakeSigner, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fakeSigner, 'secret'), 'not-for-the-agent');
  const protectedPaths = [...new Set([...signerProtectionPaths(process.env, worktree), fakeSigner])];
  const command = 'printf ok > "$1/write-probe" && secret_output="$(gpg --batch --with-colons --list-secret-keys 2>/dev/null || true)"'
    + ' && case "$secret_output" in *"sec:"*) exit 70;; esac'
    + ' && if cat "$2/secret" >/dev/null 2>&1; then exit 71; fi';
  const probe = spawnSync('codex', ['sandbox', ...signerPermissionProfileArgs(protectedPaths, 'workspace-write'),
    '--permission-profile', 'shipyard-runtime', '--cd', worktree, '/bin/sh', '-c', command,
    'probe', worktree, fakeSigner], { encoding: 'utf8', env: process.env, timeout: 15000,
  stdio: ['ignore', 'pipe', 'ignore'] });
  const writeProbe = path.join(worktree, 'write-probe');
  const writable = fs.existsSync(writeProbe) && fs.readFileSync(writeProbe, 'utf8') === 'ok';
  fs.rmSync(writeProbe, { force: true });
  if (probe.error || probe.status !== 0 || !writable) {
    refuse('SIGNER_ISOLATION_FAILED', 'Codex permission profile could not write the worktree while denying signer paths');
  }
  return { base, signer: fingerprint, graphDir, signerIsolation: 'codex-permission-profile' };
}

function verifySession(receipt, model, effort, sandbox = 'workspace-write') {
  if (!receipt || receipt.compliance !== 'verified') refuse('LIVE_SMOKE_RECEIPT_FAILED', 'dispatch receipt is not verified');
  const runtime = receipt.runtime_evidence;
  const native = runtime && runtime.native_session_evidence;
  const sandboxEvidence = runtime && runtime.sandbox_evidence;
  if (!runtime || runtime.applied_model !== model || runtime.applied_effort !== effort
      || !sandboxEvidence || sandboxEvidence.profile !== 'shipyard-runtime'
      || sandboxEvidence.base_profile !== (sandbox === 'read-only' ? ':read-only' : ':workspace')
      || !Array.isArray(sandboxEvidence.protected_paths) || sandboxEvidence.protected_paths.length < 2
      || !native || native.provider !== 'openai' || native.session_id !== runtime.session_id
      || !native.selections.some((entry) => entry.model === model && entry.effort === effort)) {
    refuse('LIVE_SMOKE_EVIDENCE_FAILED', 'native session does not prove the resolved model and effort');
  }
  return runtime;
}

function verifyEditAndBash(runtime, name, marker) {
  const target = path.join(worktree, name);
  const content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (content !== marker && content !== marker + '\n') refuse('LIVE_SMOKE_EDIT_FAILED', 'exact marker is missing');
  const transcript = runtime.transcript && runtime.transcript.path;
  if (typeof transcript !== 'string' || !fs.existsSync(transcript)) {
    refuse('LIVE_SMOKE_TRANSCRIPT_MISSING', 'Codex event stream transcript is missing');
  }
  let editApplied = false;
  let bashPassed = false;
  for (const line of fs.readFileSync(transcript, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    const item = record.item;
    if (!item) continue;
    if (item.type === 'file_change' && item.status === 'completed' && Array.isArray(item.changes)) {
      editApplied ||= item.changes.some((change) => change && typeof change.path === 'string'
        && path.resolve(worktree, change.path) === target);
    }
    if (item.type !== 'command_execution' || item.status !== 'completed' || item.exit_code !== 0) continue;
    const command = String(item.command || item.command_line || '');
    const output = String(item.aggregated_output || item.output || item.stdout || '');
    bashPassed ||= command.includes('bash -lc') && command.includes(name)
      && command.includes(marker) && command.includes('BASH_OK') && output.includes('BASH_OK');
  }
  if (!editApplied || !bashPassed) refuse('LIVE_SMOKE_BASH_FAILED', 'event stream lacks completed edit and Bash evidence');
}

function promptForEdit(name, marker) {
  return [
    'This is a one-run smoke test in a disposable scratch worktree.',
    'Use the patch or file-edit tool, not a shell write, to create only ' + name + ' with exactly this text: ' + marker + '.',
    'Then use Bash to run: bash -lc \'test "$(cat ' + name + ')" = "' + marker + '" && printf BASH_OK\'.',
    'Do not edit, create, or commit any other project file. Report the actual Bash result.',
  ].join('\n');
}

(async () => {
  try {
    if (!gsdRole && !fs.existsSync(path.join(root, 'plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs'))) {
      refuse('MISSING_FINALIZER', 'T-38-03 trusted commit finalizer has not landed in this worktree');
    }
    const scratch = prepareScratch();
    const scope = { run_id: runId, ticket, phase: 38, worktree, runtime: 'codex', provider: 'openai' };
    if (gsdRole) {
      if (!capabilities.supportedSelections.some((entry) => entry.model === 'gpt-6-sol' && entry.effort === 'high')) {
        refuse('RUNTIME_CAPABILITY_MISSING', 'Sol/high is absent from the active catalog');
      }
      const agent = installedGsdAgent(gsdRole);
      const prompt = 'Inspect .planning/graph/tickets.json in this disposable scratch worktree and report its ticket ID and branch. Do not edit files.';
      const result = await createCodexDecomposeHost({ scope, capabilities, recorderDir: path.join(storageRoot, 'receipts'),
        transcriptDir: path.join(storageRoot, 'transcripts') }).run({ gsd_role: gsdRole, prompt });
      const runtime = verifySession(result.receipt, 'gpt-6-sol', 'high', 'read-only');
      const child = runtime.native_child_evidence;
      if (result.receipt.gsd_role !== gsdRole || result.receipt.gsd_launch_mechanism !== 'typed-gsd-callback'
          || !child || child.schema !== 'shipyard.codex-native-child-evidence.v1'
          || child.agent_role !== gsdRole || child.agent_file !== agent.file
          || child.agent_file_digest !== agent.sha256 || child.parent_thread_id !== runtime.session_id
          || child.provider !== 'openai' || !child.session_id || child.session_id === runtime.session_id
          || !child.selections.some((entry) => entry.model === 'gpt-6-sol' && entry.effort === 'high')
          || agent.sandbox !== 'read-only') {
        refuse('LIVE_SMOKE_CHILD_EVIDENCE_FAILED', 'native child does not prove the typed role and Sol/high selection');
      }
      const deliveryRunId = runId + '-delivery';
      const deliveryScope = { ...scope, run_id: deliveryRunId };
      const deliveryResult = await createCodexDeliveryHost({ scope: deliveryScope, capabilities,
        graphDir: scratch.graphDir, storageRoot }).run({ role: 'executor', context: {
        prompt: promptForEdit(deliveryFile, nonce),
      } });
      const deliveryRuntime = verifySession(deliveryResult.receipt, 'gpt-6-luna', 'max');
      verifyEditAndBash(deliveryRuntime, deliveryFile, nonce);
      const artifact = deliveryResult.artifact;
      const expectedFiles = [deliveryFile];
      if (!artifact || artifact.schema !== 'shipyard.codex-delivery-artifact.v1'
          || artifact.status !== 'committed' || artifact.ticket !== ticket
          || artifact.commit !== git(worktree, 'rev-parse', 'HEAD')
          || artifact.signer !== scratch.signer || artifact.changed.length !== expectedFiles.length
          || expectedFiles.some((entry) => !artifact.changed.includes(entry))
          || git(worktree, 'rev-parse', 'HEAD^') !== scratch.base
          || git(worktree, 'status', '--porcelain', '--untracked-files=all')) {
        refuse('LIVE_SMOKE_ARTIFACT_FAILED', 'host artifact does not match the clean signed scratch commit');
      }
      git(worktree, 'verify-commit', artifact.commit);
      const signature = git(worktree, 'show', '-s', '--format=%G?%x00%GF', artifact.commit).split('\0');
      if (!['G', 'U'].includes(signature[0]) || signature[1] !== scratch.signer) {
        refuse('LIVE_SMOKE_SIGNATURE_FAILED', 'committed artifact signature does not match the configured signer');
      }
      console.log(JSON.stringify({ status: 'passed', gsd_role: gsdRole, model: 'gpt-6-sol', effort: 'high',
        provider: child.provider, parent_session_id: runtime.session_id, child_session_id: child.session_id,
        native_child: 'verified', child_policy: 'read_only',
        delivery: 'gpt-6-luna/max', bash: 'verified', artifact: 'committed', signature: 'verified',
        signer_isolation: scratch.signerIsolation,
        commit: artifact.commit }));
    } else {
      const result = await createCodexDeliveryHost({ scope, capabilities, graphDir: scratch.graphDir,
        storageRoot }).run({ role: 'executor', context: { prompt: promptForEdit(file, nonce) } });
      const runtime = verifySession(result.receipt, 'gpt-6-luna', 'max');
      verifyEditAndBash(runtime, file, nonce);
      const artifact = result.artifact;
      if (!artifact || artifact.schema !== 'shipyard.codex-delivery-artifact.v1'
          || artifact.status !== 'committed' || artifact.ticket !== ticket
          || artifact.commit !== git(worktree, 'rev-parse', 'HEAD')
          || artifact.signer !== scratch.signer || artifact.changed.length !== 1
          || artifact.changed[0] !== file || git(worktree, 'rev-parse', 'HEAD^') !== scratch.base
          || git(worktree, 'status', '--porcelain', '--untracked-files=all')) {
        refuse('LIVE_SMOKE_ARTIFACT_FAILED', 'host artifact does not match the clean signed scratch commit');
      }
      git(worktree, 'verify-commit', artifact.commit);
      const signature = git(worktree, 'show', '-s', '--format=%G?%x00%GF', artifact.commit).split('\0');
      if (!['G', 'U'].includes(signature[0]) || signature[1] !== scratch.signer) {
        refuse('LIVE_SMOKE_SIGNATURE_FAILED', 'committed artifact signature does not match the configured signer');
      }
      console.log(JSON.stringify({ status: 'passed', model: 'gpt-6-luna', effort: 'max', provider: 'openai',
        session_id: runtime.session_id, process_id: runtime.process_id, bash: 'verified', edit: 'verified',
        artifact: 'committed', commit: artifact.commit, signature: 'verified',
        signer_isolation: scratch.signerIsolation }));
    }
  } catch (error) {
    const unavailable = new Set([
      'RUNTIME_UNAVAILABLE', 'RUNTIME_EVIDENCE_MISSING', 'RUNTIME_CAPABILITY_MISSING',
      'RUNTIME_AUTH_UNAVAILABLE', 'SIGNER_UNAVAILABLE', 'SIGNER_ISOLATION_UNAVAILABLE',
      'STALE_GSD_AGENT', 'MISSING_FINALIZER',
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
