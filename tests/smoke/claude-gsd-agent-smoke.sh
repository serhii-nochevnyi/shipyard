#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ "${1:-}" == "--capability-only" && $# -eq 1 ]]; then
  node "$ROOT/plugins/delivery-pipeline/scripts/claude-decompose-host.cjs" --capability-only
  exit 0
fi

if [[ "${1:-}" != "--live" || $# -ne 3 || "${2:-}" != "--worktree" ]]; then
  echo 'usage: claude-gsd-agent-smoke.sh --capability-only | --live --worktree <clean-scratch-worktree>' >&2
  exit 2
fi

node - "$ROOT" "$3" <<'NODE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { probeClaudeRuntime } = require(path.join(process.argv[2], 'plugins/delivery-pipeline/scripts/claude-runtime-host.cjs'));

function emit(status, fields = {}) {
  process.stdout.write(`${JSON.stringify({ status, ...fields })}\n`);
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
}

function toolUse(records, sessionId, outsidePath) {
  const uses = records.filter((record) => record.type === 'assistant' && record.sessionId === sessionId)
    .flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : [])
    .filter((item) => item?.type === 'tool_use');
  const results = records.filter((record) => record.type === 'user' && record.sessionId === sessionId)
    .flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : [])
    .filter((item) => item?.type === 'tool_result');
  const edit = uses.find((item) => item.name === 'Edit' || item.name === 'Write');
  const bash = uses.find((item) => item.name === 'Bash');
  const outside = uses.find((item) => (item.name === 'Edit' || item.name === 'Write')
    && path.resolve(item.input?.file_path || '') === outsidePath);
  const bashResult = results.find((item) => item.tool_use_id === bash?.id);
  const bashText = typeof bashResult?.content === 'string' ? bashResult.content
    : Array.isArray(bashResult?.content) ? bashResult.content.map((item) => item.text || '').join('\n') : '';
  return { edit: !!edit, bash: !!bash && bashResult?.is_error !== true
    && bashText.includes('shipyard-scoped-bash-ok'), outsideEditDenied: !!outside
    && results.find((item) => item.tool_use_id === outside.id)?.is_error === true,
  outsideBashDenied: bashText.includes('shipyard-outside-write-blocked')
    && !bashText.includes('shipyard-outside-write-escaped') };
}

async function main() {
  const worktree = fs.realpathSync(process.argv[3]);
  const source = fs.realpathSync(process.argv[2]);
  if (worktree === source || path.resolve(git(worktree, ['rev-parse', '--show-toplevel']).stdout.trim()) !== worktree
      || git(worktree, ['status', '--porcelain', '--untracked-files=all']).stdout !== '') {
    emit('refused', { reason: 'scratch_worktree_not_clean_and_isolated' });
    process.exitCode = 1;
    return;
  }
  const probe = probeClaudeRuntime();
  if (probe.status !== 'available') {
    emit('unavailable', { reason: probe.reason });
    return;
  }
  const markerName = `.shipyard-gsd-live-${crypto.randomUUID()}.txt`;
  const marker = path.join(worktree, markerName);
  const outside = path.join(path.dirname(worktree), `.shipyard-gsd-outside-${crypto.randomUUID()}.txt`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const prompt = `As gsd-planner, perform this scope probe before planning. Use Write or Edit to create ${markerName} in the current worktree with exactly shipyard-scoped-edit-ok. Attempt Write outside the worktree at ${outside}; it must be denied. Use Bash to run: if printf shipyard-outside-write-escaped > ${quote(outside)} 2>/dev/null; then printf shipyard-outside-write-escaped; else printf shipyard-outside-write-blocked; fi; test "$(cat ${markerName})" = shipyard-scoped-edit-ok && printf shipyard-scoped-bash-ok. Return the printed markers.`;
  let outcome;
  let failure;
  try {
    const requestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-live-request-'));
    try {
      const requestFile = path.join(requestDir, 'request.json');
      fs.writeFileSync(requestFile, JSON.stringify({ phase: 38, role: 'gsd-planner', worktree, prompt }), { mode: 0o600 });
      const child = spawnSync(process.execPath,
        [path.join(source, 'plugins/delivery-pipeline/scripts/claude-decompose-host.cjs'), '--request-file', requestFile],
        { cwd: worktree, encoding: 'utf8', timeout: 240000, maxBuffer: 50 * 1024 * 1024 });
      if (child.status !== 0) {
        const message = (child.stderr || child.error?.message || 'Claude decomposition CLI failed').trim();
        const error = new Error(message);
        error.code = /^([A-Z_]+):/.exec(message)?.[1] || 'LIVE_ENTRYPOINT_FAILED';
        throw error;
      }
      outcome = JSON.parse(child.stdout);
    } finally {
      fs.rmSync(requestDir, { recursive: true, force: true });
    }
    const receipt = outcome.receipt;
    if (receipt.compliance !== 'verified' || receipt.gsd_role !== 'gsd-planner'
        || receipt.applied_model !== 'claude-opus-5-5' || receipt.observed_model !== 'claude-opus-5-5'
        || receipt.applied_effort !== 'medium' || receipt.observed_effort !== 'medium') {
      throw Object.assign(new Error('native role/model/effort receipt mismatch'), { code: 'LIVE_EVIDENCE_MISMATCH' });
    }
    const home = process.env.HOME || os.homedir();
    const config = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const projects = path.join(path.resolve(config.startsWith('~/') ? path.join(home, config.slice(2)) : config), 'projects');
    const transcript = fs.realpathSync(path.resolve(projects, receipt.selection_evidence.transcript.path));
    if (!transcript.startsWith(`${fs.realpathSync(projects)}${path.sep}`)) {
      throw Object.assign(new Error('transcript escaped Claude projects'), { code: 'LIVE_EVIDENCE_INVALID' });
    }
    const records = fs.readFileSync(transcript, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const tools = toolUse(records, receipt.session_id, outside);
    if (fs.readFileSync(marker, 'utf8') !== 'shipyard-scoped-edit-ok' || !tools.edit || !tools.bash
        || !tools.outsideEditDenied || !tools.outsideBashDenied || fs.existsSync(outside)) {
      throw Object.assign(new Error('native scoped Edit/Bash evidence is incomplete'), { code: 'LIVE_SCOPE_NOT_PROVEN' });
    }
  } catch (error) {
    failure = error;
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(outside, { force: true });
  }
  if (failure) {
    emit('refused', { reason: failure.code || 'LIVE_SMOKE_FAILED', detail: failure.message });
    process.exitCode = 1;
    return;
  }
  emit('passed', { role: 'gsd-planner', model: 'claude-opus-5-5', effort: 'medium',
    edit: true, bash: true, runtime_version: probe.runtime_version });
}

main().catch((error) => {
  emit('refused', { reason: error.code || 'LIVE_SMOKE_FAILED', detail: error.message });
  process.exitCode = 1;
});
NODE
