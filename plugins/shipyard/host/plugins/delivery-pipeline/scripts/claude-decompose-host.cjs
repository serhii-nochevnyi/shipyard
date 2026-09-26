#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClaudeRuntimeHost, probeClaudeRuntime } = require('./claude-runtime-host.cjs');
const { createClaudeWorkflowDispatch } = require('./claude-dispatch-adapter.cjs');
const { createDurableRecorder } = require('./dispatch-boundary.cjs');
const { createRunController } = require('./run-controller.cjs');
const { createRunScope } = require('./run-scope.cjs');
const { matchesModelObservation } = require('./runtime-adapters.cjs');
const pipelineConfig = require('./pipeline-config.cjs');
const { formatHint } = require('./refusal-hints.cjs');

const ROLES = Object.freeze({
  'gsd-phase-researcher': 'research',
  'gsd-planner': 'decomposition',
  'gsd-plan-checker': 'decomposition',
});
const REFERENCE = /@(?:~\/\.claude\/gsd-core|gsd-core)\/([A-Za-z0-9_./-]+\.md)/g;
const MAX_SOURCE = 256 * 1024;
const MAX_PROMPT = 256 * 1024;

function refuse(code, message) {
  const error = new Error(`claude-decompose-host: ${message}`);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max
      || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_INPUT', `${label} must be bounded non-empty text`);
  }
  return value;
}

function realFile(file, directory, max = MAX_SOURCE) {
  const root = fs.realpathSync(directory);
  const target = path.resolve(directory, file);
  if (!target.startsWith(`${path.resolve(directory)}${path.sep}`)) refuse('REFERENCE_UNAVAILABLE', 'reference escaped its trusted root');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || fs.realpathSync(target) !== path.join(root, file)) {
    refuse('REFERENCE_UNAVAILABLE', 'reference is not a bounded regular file');
  }
  return fs.readFileSync(target, 'utf8');
}

function inlineReferences(source, root) {
  const included = new Set();
  function expand(text, stack) {
    return text.replace(REFERENCE, (reference, relative) => {
      if (!/^(references|templates|workflows)\/[A-Za-z0-9_./-]+\.md$/.test(relative)
          || relative.split('/').includes('..') || relative.split('/').includes('.')) {
        refuse('REFERENCE_UNAVAILABLE', `unsupported GSD reference ${reference}`);
      }
      if (stack.includes(relative)) refuse('REFERENCE_UNAVAILABLE', `cyclic GSD reference ${relative}`);
      if (included.has(relative)) return `\n<GSD reference ${relative} included above>\n`;
      included.add(relative);
      const content = expand(realFile(relative, root), [...stack, relative]);
      return `\n<gsd-reference source="${relative}">\n${content}\n</gsd-reference>\n`;
    });
  }
  const output = expand(source, []);
  if (Buffer.byteLength(output) > MAX_SOURCE) refuse('REFERENCE_UNAVAILABLE', 'expanded GSD role exceeds the 256 KiB limit');
  return output;
}

function trustedAgent(role, configRoot) {
  const agents = path.join(configRoot, 'agents');
  const source = realFile(`${role}.md`, agents);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(source);
  if (!match) refuse('REFERENCE_UNAVAILABLE', 'GSD agent definition is malformed');
  const field = (name) => match[1].split(/\r?\n/).find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  if (field('name') !== role || !field('description') || !field('tools')) {
    refuse('REFERENCE_UNAVAILABLE', 'GSD agent identity is invalid');
  }
  const frontmatter = match[1].split(/\r?\n/)
    .filter((line) => !/^(model|effort):(?:\s|$)/.test(line)).join('\n');
  const prompt = inlineReferences(match[2], path.join(configRoot, 'gsd-core'));
  return `---\n${frontmatter}\n---\n${prompt}`;
}

function git(worktree, ...args) {
  return execFileSync('git', args, { cwd: worktree, encoding: 'utf8', timeout: 10000 }).trim();
}

function canonicalRequest(input) {
  if (!object(input)) refuse('INVALID_INPUT', 'request must be an object');
  const keys = new Set(['role', 'phase', 'worktree', 'prompt', 'signals']);
  if (Object.keys(input).some((key) => !keys.has(key))) refuse('INVALID_INPUT', 'request has unsupported fields');
  const role = safeText(input.role, 'role', 32);
  if (!Object.hasOwn(ROLES, role)) refuse('UNSUPPORTED_ROLE', `unsupported GSD role ${role}`);
  const phase = Number(input.phase);
  if (!Number.isSafeInteger(phase) || phase < 1 || String(input.phase) !== String(phase)) {
    refuse('INVALID_INPUT', 'phase must be a positive integer');
  }
  const worktree = fs.realpathSync(safeText(input.worktree, 'worktree', 4096));
  if (path.resolve(git(worktree, 'rev-parse', '--show-toplevel')) !== worktree) {
    refuse('SCOPE_MISMATCH', 'worktree must be the canonical Git root');
  }
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    refuse('INVALID_INPUT', 'prompt must be bounded text');
  }
  const signals = input.signals === undefined ? {} : input.signals;
  if (!object(signals) || Object.keys(signals).some((key) => !['complexity', 'critical', 'checkpoint'].includes(key))) {
    refuse('INVALID_SIGNAL', 'unsupported decomposition signal');
  }
  if (signals.complexity !== undefined && !['simple', 'moderate', 'complex', 'very-complex'].includes(signals.complexity)) {
    refuse('INVALID_SIGNAL', 'invalid complexity signal');
  }
  for (const key of ['critical', 'checkpoint']) {
    if (signals[key] !== undefined && typeof signals[key] !== 'boolean') refuse('INVALID_SIGNAL', `invalid ${key} signal`);
  }
  const common = fs.realpathSync(path.resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir')));
  return Object.freeze({ role, phase, worktree, prompt, signals: Object.freeze({ ...signals }),
    ticket: `T-${phase}-DECOMPOSE`, repository: common });
}

function privateStore(scope) {
  const key = crypto.createHash('sha256').update(`${scope.repository}\n${scope.worktree}\n${scope.phase}`).digest('hex');
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.local', 'state', 'shipyard', 'claude-decompose', key);
}

async function runDecomposition(request, dependencies = {}) {
  const scope = canonicalRequest(request);
  const dispatchId = `decompose-${crypto.randomUUID()}`;
  const resolution = (dependencies.resolveDispatch || pipelineConfig.resolveDispatch)({
    root: scope.worktree, runtime: 'claude', role: ROLES[scope.role],
    signals: scope.signals, dispatch_id: dispatchId,
  });
  if (!object(resolution) || resolution.dispatch_id !== dispatchId || resolution.runtime !== 'claude'
      || resolution.role !== ROLES[scope.role] || typeof resolution.model !== 'string'
      || typeof resolution.effort !== 'string') {
    refuse('CONFLICTING_OVERRIDE', 'routed resolution does not match the requested GSD launch');
  }
  const configRoot = dependencies.configRoot || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  const definition = trustedAgent(scope.role, configRoot);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-definition-'));
  fs.chmodSync(temporary, 0o700);
  try {
    fs.writeFileSync(path.join(temporary, `${scope.role}.md`), definition, { flag: 'wx', mode: 0o600 });
    const store = dependencies.store || privateStore(scope);
    const recorder = (dependencies.recorderFactory || createDurableRecorder)(path.join(store, 'receipts'));
    const controller = (dependencies.controllerFactory || createRunController)({ storeDir: path.join(store, 'runs') });
    const runId = `decompose-${crypto.randomUUID()}`;
    controller.begin(createRunScope({
      run_id: runId, repository_id: scope.repository, phase: scope.phase, ticket: scope.ticket,
      worktree: scope.worktree, runtime: 'claude', owner_id: controller.owner_id,
      dispatch: { dispatch_id: dispatchId, role: ROLES[scope.role], model: resolution.model, effort: resolution.effort },
    }));
    let heartbeatFailure;
    const heartbeat = setInterval(() => {
      try { controller.heartbeat(runId); }
      catch (error) { heartbeatFailure = error; }
    }, 60 * 1000);
    heartbeat.unref();
    try {
      const probe = (dependencies.probe || probeClaudeRuntime)();
      const host = (dependencies.runtimeHostFactory || createClaudeRuntimeHost)({
        scope: { run_id: runId, ticket: scope.ticket, phase: scope.phase, worktree: scope.worktree,
          runtime: 'claude', provider: 'anthropic', repository: scope.repository },
        recorder, controller, probe, gsdAgentRoot: temporary,
        transcriptDir: path.join(store, 'transcripts'),
      });
      const output = await createClaudeWorkflowDispatch({
        host, prompt: scope.prompt, role: ROLES[scope.role], gsdRole: scope.role,
        model: resolution.model, effort: resolution.effort, signals: scope.signals,
        dispatchId, requireGsdRole: true,
        context: { ticket: scope.ticket, phase: scope.phase, run_id: runId,
          worktreePath: scope.worktree, runtime: 'claude', provider: 'anthropic' },
      });
      if (!output || output.receipt?.compliance !== 'verified'
          || output.receipt.gsd_role !== scope.role
          || output.receipt.applied_model !== resolution.model
          || output.receipt.applied_effort !== resolution.effort
          || !matchesModelObservation('claude', output.receipt.observed_model, resolution.model)
          || output.receipt.observed_effort !== resolution.effort
          || output.receipt.gsd_agent_evidence?.role !== scope.role
          || output.receipt.gsd_agent_evidence?.session_id !== output.receipt.session_id
          || output.receipt.gsd_agent_evidence?.session_start_agent_type !== scope.role
          || output.receipt.gsd_agent_evidence?.transcript_agent_setting !== scope.role
          || output.receipt.selection_evidence?.session_id !== output.receipt.session_id) {
        refuse('NONCOMPLIANT_RECEIPT', 'typed GSD dispatch has no compliant exact-role receipt');
      }
      if (heartbeatFailure) throw heartbeatFailure;
      controller.assertOwner(runId);
      controller.complete(runId);
      return Object.freeze({ role: scope.role, result: output.result, receipt: output.receipt,
        run_id: runId, dispatch_id: dispatchId });
    } catch (error) {
      if (controller.status(runId).state === 'running') controller.fail(runId, { reason: error.message });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--capability-only') return { capabilityOnly: true };
  if (argv.length !== 2 || argv[0] !== '--request-file') refuse('INVALID_INPUT', 'expected --request-file <bounded JSON file>');
  return { requestFile: argv[1] };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.capabilityOnly) {
    const probe = probeClaudeRuntime();
    if (probe.status !== 'available') {
      process.stdout.write(`${JSON.stringify({ status: 'unavailable', reason: probe.reason || 'runtime_unavailable' })}\n`);
      return;
    }
    try {
      const configRoot = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
      for (const [role, boundaryRole] of Object.entries(ROLES)) {
        pipelineConfig.resolveDispatch({ root: process.cwd(), runtime: 'claude',
          role: boundaryRole, signals: {}, dispatch_id: `capability-${role}` });
        trustedAgent(role, configRoot);
      }
      process.stdout.write(`${JSON.stringify({ status: 'available', runtime_version: probe.runtime_version,
        roles: Object.keys(ROLES), live_execution: 'not_run' })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'unavailable', reason: error.code || 'role_unavailable',
        detail: error.message, live_execution: 'not_run', hint: formatHint(error.code) })}\n`);
    }
    return;
  }
  const stat = fs.lstatSync(args.requestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROMPT) refuse('INVALID_INPUT', 'request file is not bounded and regular');
  const request = JSON.parse(fs.readFileSync(args.requestFile, 'utf8'));
  const scope = canonicalRequest(request);
  process.chdir(scope.worktree);
  const output = await runDecomposition(request);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'FAILED'}: ${error.message}\n`);
    process.stderr.write(`${formatHint(error.code)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ ROLES, canonicalRequest, inlineReferences, trustedAgent, parseArguments, runDecomposition, main });
