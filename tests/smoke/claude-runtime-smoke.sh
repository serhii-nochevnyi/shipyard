#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ "${1:-}" == "--capability-only" && $# -eq 1 ]]; then
  probe="$(node "$ROOT/plugins/delivery-pipeline/scripts/claude-runtime-host.cjs" --capability-only)"
  node - "$probe" <<'NODE'
'use strict';
const result = JSON.parse(process.argv[2]);
if (result.schema !== 'shipyard.claude-runtime-probe.v1' || result.version !== 1) {
  throw new Error('invalid Claude runtime probe schema');
}
if (result.status === 'available') {
  if (typeof result.runtime_version !== 'string' || !result.runtime_version) throw new Error('available probe lacks runtime version');
  if (!result.capabilities || !result.capabilities.supportedModels.includes('sonnet')) throw new Error('available probe lacks Claude model capability');
  if (!result.capabilities.supportedModels.includes('claude-opus-5-5')) throw new Error('available probe lacks pinned Opus capability');
  if (!result.capabilities.supportedEfforts.includes('max')) throw new Error('available probe lacks effort capability');
  if (result.capabilities.sandboxedBash !== true || result.capabilities.assistantTranscriptEvidence !== true) {
    throw new Error('available probe lacks scoped runtime guarantees');
  }
  console.log(JSON.stringify({ status: 'available', runtime_version: result.runtime_version }));
} else if (result.status === 'unavailable') {
  if (typeof result.reason !== 'string' || !result.reason) throw new Error('unavailable probe lacks a machine reason');
  if (Object.prototype.hasOwnProperty.call(result, 'receipt')) throw new Error('unavailable probe fabricated a receipt');
  console.error(JSON.stringify({ status: 'unavailable', reason: result.reason }));
} else {
  throw new Error(`unknown Claude probe status ${JSON.stringify(result.status)}`);
}
NODE
  exit 0
fi

if [[ "${1:-}" != "--live" || $# -ne 3 || "${2:-}" != "--worktree" || -z "${3:-}" ]]; then
  echo "usage: claude-runtime-smoke.sh --capability-only | --live --worktree <scratch-worktree>" >&2
  exit 2
fi

node - "$ROOT" "$3" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createClaudeRuntimeHost, probeClaudeRuntime } = require(path.join(
  process.argv[2], 'plugins/delivery-pipeline/scripts/claude-runtime-host.cjs',
));

function emit(status, fields = {}) {
  process.stdout.write(`${JSON.stringify({ status, ...fields })}\n`);
}

function gitStatus(directory) {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
  });
  return result.status === 0 ? result.stdout : null;
}

function nativeToolUse(records, sessionId, outsidePath) {
  const uses = [];
  for (const record of records) {
    if (record.type !== 'assistant' || record.sessionId !== sessionId || !record.message) continue;
    if (!Array.isArray(record.message.content)) continue;
    for (const item of record.message.content) {
      if (item && item.type === 'tool_use' && typeof item.name === 'string') uses.push(item);
    }
  }
  const results = [];
  for (const record of records) {
    if (record.type !== 'user' || record.sessionId !== sessionId || !record.message) continue;
    const blocks = Array.isArray(record.message.content) ? record.message.content : [];
    results.push(...blocks.filter((item) => item && item.type === 'tool_result'));
  }
  const editUse = uses.find((item) => item.name === 'Write' || item.name === 'Edit');
  const bashUse = uses.find((item) => item.name === 'Bash');
  const outsideUse = uses.find((item) => (item.name === 'Write' || item.name === 'Edit')
    && path.resolve(item.input?.file_path || '') === outsidePath);
  const outsideResult = outsideUse && results.find((item) => item.tool_use_id === outsideUse.id);
  const bashResult = bashUse && results.find((item) => item.tool_use_id === bashUse.id && item.is_error !== true);
  const bashText = bashResult && (typeof bashResult.content === 'string'
    ? bashResult.content
    : Array.isArray(bashResult.content)
      ? bashResult.content.map((item) => item && item.text || '').join('\n') : '');
  return {
    edit: !!editUse,
    bash: !!bashUse && /shipyard-scoped-bash-ok/.test(bashText || ''),
    outsideEditDenied: !!outsideUse && outsideResult?.is_error === true,
    outsideBashDenied: /shipyard-outside-write-blocked/.test(bashText || '')
      && !/shipyard-outside-write-escaped/.test(bashText || ''),
  };
}

async function main() {
  const repository = path.resolve(process.argv[2]);
  const worktree = path.resolve(process.argv[3]);
  let worktreeReal;
  try { worktreeReal = fs.realpathSync(worktree); }
  catch { emit('refused', { reason: 'scratch_worktree_unavailable' }); process.exitCode = 1; return; }
  if (worktreeReal === fs.realpathSync(repository)) {
    emit('refused', { reason: 'scratch_worktree_is_repository_root' }); process.exitCode = 1; return;
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: worktreeReal,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (top.status !== 0 || path.resolve((top.stdout || '').trim()) !== worktreeReal) {
    emit('refused', { reason: 'scratch_worktree_not_git_root' }); process.exitCode = 1; return;
  }
  const baseline = gitStatus(worktreeReal);
  if (baseline === null || baseline !== '') {
    emit('refused', { reason: 'scratch_worktree_not_clean' }); process.exitCode = 1; return;
  }

  const probe = probeClaudeRuntime();
  if (probe.status !== 'available') {
    emit('unavailable', { reason: probe.reason || 'runtime_unavailable' });
    return;
  }

  const filename = `.shipyard-live-${crypto.randomUUID()}.txt`;
  const marker = path.join(worktreeReal, filename);
  const outsidePath = path.join(path.dirname(worktreeReal), `.shipyard-outside-${crypto.randomUUID()}.txt`);
  if (fs.existsSync(outsidePath)) {
    emit('refused', { reason: 'outside_probe_path_already_exists' }); process.exitCode = 1; return;
  }
  let result;
  let failure;
  try {
    const host = createClaudeRuntimeHost({
      scope: {
        run_id: `live-${crypto.randomUUID()}`,
        ticket: 'T-38-02-live-smoke',
        phase: 38,
        worktree: worktreeReal,
        runtime: 'claude',
        provider: 'anthropic',
      },
      probe,
      recorder: { record() {} },
      transcriptDir: null,
    });
    const shellOutsidePath = `'${outsidePath.replaceAll("'", "'\\''")}'`;
    const prompt = `Use Write or Edit to create ${filename} in the current working directory with exactly shipyard-scoped-edit-ok. Then use Write to try creating ${outsidePath} with the text shipyard-outside-edit-escaped; that file operation must be denied. After that, make one Bash tool call that runs: if printf shipyard-outside-bash-escaped > ${shellOutsidePath} 2>/dev/null; then printf shipyard-outside-write-escaped; else printf shipyard-outside-write-blocked; fi; pwd && test "$(cat ${filename})" = shipyard-scoped-edit-ok && printf shipyard-scoped-bash-ok. Do not use another method to access files outside the current working directory. Return the printed markers.`;
    result = await host.agent(prompt, { model: 'claude-opus-5-5', effort: 'low' });
    const evidence = host.applicationEvidence({ result });
    const info = fs.lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== 'shipyard-scoped-edit-ok') {
      throw Object.assign(new Error('scoped edit did not produce the expected file'), { code: 'LIVE_EDIT_NOT_PROVEN' });
    }
    const home = process.env.HOME || os.homedir();
    const config = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const resolvedConfig = config.startsWith('~/') ? path.join(home, config.slice(2)) : config;
    const projectsRoot = path.join(path.resolve(resolvedConfig), 'projects');
    const transcriptPath = path.resolve(projectsRoot, evidence.selection_evidence.transcript.path);
    if (!transcriptPath.startsWith(`${projectsRoot}${path.sep}`)) throw new Error('session transcript reference escaped the Claude projects directory');
    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    const records = transcript.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const tools = nativeToolUse(records, evidence.session_id, outsidePath);
    if (!tools.edit || !tools.bash || !tools.outsideEditDenied || !tools.outsideBashDenied || fs.existsSync(outsidePath)) {
      throw Object.assign(new Error('scoped tool boundary was not present in the native transcript'), { code: 'LIVE_SCOPE_NOT_PROVEN' });
    }
    if (evidence.applied_model !== 'claude-opus-5-5' || evidence.observed_model !== 'claude-opus-5-5'
        || evidence.applied_effort !== 'low' || evidence.observed_effort !== 'low') {
      throw Object.assign(new Error('live runtime selection differs from the requested Opus selection'), { code: 'LIVE_SELECTION_MISMATCH' });
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      const info = fs.lstatSync(marker);
      if (info.isFile() || info.isSymbolicLink()) fs.unlinkSync(marker);
    } catch (_) {}
    try {
      const info = fs.lstatSync(outsidePath);
      if (info.isFile() || info.isSymbolicLink()) fs.unlinkSync(outsidePath);
      else if (info.isDirectory()) fs.rmdirSync(outsidePath);
    } catch (_) {}
  }

  const finalStatus = gitStatus(worktreeReal);
  if (finalStatus === null || finalStatus !== baseline) {
    emit('refused', { reason: 'scratch_worktree_changed_outside_smoke_file' }); process.exitCode = 1; return;
  }
  if (failure) {
    const code = typeof failure.code === 'string' ? failure.code : 'RUNTIME_EVIDENCE_INVALID';
    const status = code === 'RUNTIME_UNAVAILABLE' || code === 'RUNTIME_AUTH_UNAVAILABLE'
      ? 'unavailable' : 'refused';
    emit(status, { reason: code });
    if (status === 'refused') process.exitCode = 1;
    return;
  }
  emit('passed', {
    model: 'claude-opus-5-5',
    effort: 'low',
    edit: true,
    bash: true,
    runtime_version: probe.runtime_version,
  });
}

main().catch((error) => {
  emit('refused', { reason: typeof error.code === 'string' ? error.code : 'LIVE_SMOKE_FAILED' });
  process.exitCode = 1;
});
NODE
