#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const { computeFront } = require('./front.cjs');
const { resolveGraphDir } = require('./graph-dir.cjs');
const { assertCanonicalGraph } = require('./plan-delivery.cjs');
const claudeHost = require('./claude-delivery-host.cjs');
const codexHost = require('./codex-delivery-host.cjs');
const claudeRoleHost = require('./claude-role-host.cjs');
const sentinelPreflight = require('./sentinel-preflight.cjs');
const prHygiene = require('./pr-hygiene.cjs');
const { buildContextPacket } = require('./context-packet.cjs');
const modelPolicy = require('./model-policy.cjs');
const pipelineConfig = require('./pipeline-config.cjs');
const runWaker = require('./run-waker.cjs');

const ROLE_BUCKETS = Object.freeze({
  executor: Object.freeze(['execute']),
  'pr-sentinel': Object.freeze(['fix', 'finalize', 'merge']),
});

const EXIT_CODES = Object.freeze({ running: 0, 'exited-ok': 0, 'exited-failed': 1, lost: 2 });

function fail(code, message) {
  const error = new Error(`deliver-dispatch: ${message}`);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function git(dir, argv) {
  return execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function trackedAtHead(dir, relPath) {
  try {
    execFileSync('git', ['-C', dir, 'cat-file', '-e', `HEAD:${relPath}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function readJsonBounded(file, maxBytes = 8 * 1024 * 1024) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isInsidePath(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function canonicalizeGraphDir(dir, worktree, source) {
  let resolved;
  try { resolved = fs.realpathSync(dir); }
  catch { return fail('GRAPH_UNRESOLVED', `canonical graph directory is unavailable: ${dir}; pass --graph-dir <project>/.planning/graph`); }
  try { assertCanonicalGraph({ graphDir: resolved, worktree, source }); }
  catch (error) { fail(error.code || 'GRAPH_NOT_CANONICAL', error.message.replace(/^plan-delivery: /, '')); }
  return resolved;
}

function resolveLaunchGraphDir({ worktree, explicitGraphDir }) {
  if (explicitGraphDir) {
    if (!fs.existsSync(path.join(explicitGraphDir, 'tickets.json'))) {
      fail('GRAPH_UNRESOLVED', `no canonical ticket graph found (looked in ${explicitGraphDir})`);
    }
    return canonicalizeGraphDir(explicitGraphDir, worktree, 'flag');
  }
  if (trackedAtHead(worktree, '.planning/graph/tickets.json')) {
    return canonicalizeGraphDir(path.join(worktree, '.planning', 'graph'), worktree, 'worktree');
  }
  const resolved = resolveGraphDir([], null);
  if (resolved.how === 'none' || !fs.existsSync(path.join(resolved.dir, 'tickets.json'))) {
    fail('GRAPH_UNRESOLVED', `no canonical ticket graph found (looked in ${resolved.dir}); pass --graph-dir <project>/.planning/graph`);
  }
  return canonicalizeGraphDir(resolved.dir, worktree, resolved.how);
}

function buildSignals(row) {
  const signals = {};
  if (row.risk !== undefined) signals.risk = row.risk;
  if (row.human_checkpoint === true) signals.checkpoint = true;
  if (row.critical === true) signals.critical = true;
  return signals;
}

function contextReadPaths(planText) {
  const lines = planText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Context\s*\(Reads\)\s*$/i.test(line.trim()));
  if (start === -1) return [];
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    section.push(line);
  }
  const text = section.join('\n');
  const re = /`([^`\s]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?`/g;
  const seen = new Set();
  const out = [];
  let match;
  while ((match = re.exec(text))) {
    const found = match[1];
    if (seen.has(found)) continue;
    seen.add(found);
    out.push(found);
  }
  return out;
}

function sentinelRoundPrs(tickets, state, front) {
  const ids = [...front.actionable.fix, ...front.actionable.finalize, ...front.actionable.merge];
  return ids.map((ticketId) => {
    const row = tickets[ticketId] || {};
    const s = state[ticketId] || {};
    const base = s.pr_base || s.base || row.pr_base;
    return { ticket: ticketId, base, ...(row.repo ? { repo: row.repo } : {}) };
  });
}

function buildExecutorPacket({ worktreePath, row, id, planPath, planSha256, planInWorktree, sourceRevision, planText }) {
  const scope = { files_modified: row.files || [] };
  const roleContext = {
    plan: { path: row.plan, sha256: planSha256 },
    scope,
    acceptance: [],
    verification: [],
    backlog: [],
    ...(planInWorktree ? {} : { planSha256 }),
  };
  const options = {
    root: worktreePath,
    role: 'executor',
    subject: id,
    sourceRevision,
    policy: modelPolicy.POLICY,
    policyHash: modelPolicy.POLICY_HASH,
    scope,
    acceptance: [],
    verification: [],
    roleContext,
    backend: 'unspecified',
  };
  if (planInWorktree) {
    options.requiredRefs = [planPath, ...contextReadPaths(planText)];
  }
  return buildContextPacket(options);
}

function buildClaudeExecutorRequest({ id, row, worktreePath, planPath, planSha256, packet, hygiene, projectRoot, resolve }) {
  const signals = buildSignals(row);
  const selection = (resolve || pipelineConfig.resolveDispatch)({
    root: projectRoot || worktreePath, runtime: 'claude', role: 'executor', signals,
  });
  const entry = {
    id,
    branch: row.branch,
    planPath,
    planSha256,
    worktreePath,
    prBase: row.pr_base,
    model: selection.model,
    effort: selection.effort,
    signals,
    contextPacket: packet,
    contextPacketRequired: true,
  };
  return {
    schema: claudeHost.REQUEST_SCHEMA,
    scope: { run_id: `deliver-${crypto.randomUUID()}`, ticket: id, phase: phaseNumber(row.phase), worktree: worktreePath },
    args: {
      tickets: [entry],
      ...(hygiene ? { prBodyGuide: prHygiene.NEUTRAL_PR_BODY_GUIDE, deliveryRulesHint: prHygiene.NEUTRAL_DELIVERY_RULES_HINT } : {}),
    },
  };
}

function phaseNumber(value) {
  const match = /^0*(\d+)(?:-|$)/.exec(String(value));
  if (!match || Number(match[1]) < 1) fail('INVALID_PHASE', `ticket phase ${value} has no positive phase number`);
  return Number(match[1]);
}

function buildCodexExecutorRequest({ id, row, worktreePath, planSha256 }) {
  return {
    scope: {
      run_id: `deliver-${crypto.randomUUID()}`, ticket: id, phase: phaseNumber(row.phase),
      worktree: worktreePath, runtime: 'codex', provider: 'openai',
    },
    role: 'executor',
    signals: buildSignals(row),
    context: {
      prompt: `Implement ticket ${id}${row.title ? ` (${row.title})` : ''} exactly as its delivered PLAN describes, `
        + 'within its files_modified, and run its Verification commands to green.',
      plan_sha256: planSha256,
    },
  };
}

function dispatchStateDir(options = {}) {
  return options.stateDir || path.join(os.homedir(), '.local', 'state', 'shipyard', 'dispatch');
}

function prepareDispatchDir(options) {
  const stateDir = dispatchStateDir(options);
  const dispatchId = `dd-${crypto.randomUUID()}`;
  const dir = path.join(stateDir, dispatchId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dispatchId, dir };
}

function writeRequestFile(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

// @invariant: no intermediate shell — process.execPath is invoked directly (Pitfall 3).
function spawnDetached({ dir, dispatchId, hostScript, hostArgs, worktreePath, graphDir, ticket, role, runtime, options }) {
  const resultFile = path.join(dir, 'result.jsonl');
  const logFile = path.join(dir, 'host.log');
  const outFd = fs.openSync(resultFile, 'a');
  const errFd = fs.openSync(logFile, 'a');
  const spawnFn = options.spawn || spawn;
  let child;
  try {
    child = spawnFn(process.execPath, [hostScript, ...hostArgs], {
      cwd: worktreePath,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...(options.env || {}), SHIPYARD_GRAPH_DIR: graphDir },
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  child.on('error', (error) => {
    try { fs.appendFileSync(logFile, `deliver-dispatch: spawn error: ${error.message}\n`); } catch { /* best-effort */ }
  });
  child.unref();
  const record = {
    dispatch_id: dispatchId, ticket, role, runtime, graph_dir: graphDir,
    pid: child.pid, result: resultFile, log: logFile, started_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(record));
  return Object.freeze({ dispatch_id: dispatchId, ticket, role, runtime, log: logFile, result: resultFile });
}

function launchPrSentinel({ args, row, projectRoot, graphDir, dispatchId, dir, options }) {
  if (args.runtime === 'claude') {
    const request = {
      schema: claudeRoleHost.REQUEST_SCHEMA,
      role: 'pr-sentinel',
      worktree: projectRoot,
      phase: String(row.phase),
    };
    const hostScript = options.roleHostScript || path.join(__dirname, 'claude-role-host.cjs');
    const argsFile = writeRequestFile(dir, 'args.json', request);
    return spawnDetached({
      dir, dispatchId, hostScript, hostArgs: ['--args-file', argsFile],
      worktreePath: projectRoot, graphDir, ticket: args.ticket, role: args.role, runtime: args.runtime, options,
    });
  }
  const request = {
    scope: {
      run_id: `deliver-${crypto.randomUUID()}`, ticket: args.ticket, phase: phaseNumber(row.phase),
      worktree: projectRoot, runtime: 'codex', provider: 'openai',
    },
    role: 'pr-sentinel',
    signals: buildSignals(row),
    context: {
      prompt: `Guard the open pull request of ticket ${args.ticket}: read its live CI and review state, perform the `
        + 'documented sentinel duty for it, and report what you performed or refused.',
    },
  };
  codexHost.validateArgs({ role: request.role, signals: request.signals, context: request.context });
  const hostScript = options.codexHostScript || path.join(__dirname, 'codex-delivery-host.cjs');
  const argsFile = writeRequestFile(dir, 'args.json', request);
  return spawnDetached({
    dir, dispatchId, hostScript, hostArgs: ['--args-file', argsFile],
    worktreePath: projectRoot, graphDir, ticket: args.ticket, role: args.role, runtime: args.runtime, options,
  });
}

async function launch(argv, options = {}) {
  const args = parseLaunchArgs(argv);
  const cwd = options.cwd || process.cwd();
  let worktreePath;
  try { worktreePath = fs.realpathSync(cwd); }
  catch { return fail('USAGE', `worktree ${cwd} does not exist`); }

  const graphDir = resolveLaunchGraphDir({ worktree: worktreePath, explicitGraphDir: args.graphDir });
  const graph = readJsonBounded(path.join(graphDir, 'tickets.json'));
  const row = graph && object(graph.tickets) ? graph.tickets[args.ticket] : undefined;
  if (!object(row)) fail('UNKNOWN_TICKET', `ticket ${args.ticket} has no canonical graph entry in ${graphDir}`);
  const rawState = readJsonBounded(path.join(graphDir, 'delivery-state.json')) || {};
  const state = object(rawState) && object(rawState.tickets) ? rawState.tickets : rawState;

  const computeFrontFn = options.computeFront || computeFront;
  const front = computeFrontFn(graph.tickets, state, options.frontOptions || {});
  const buckets = ROLE_BUCKETS[args.role];
  if (!buckets) fail('UNSUPPORTED_ROLE', `role ${args.role} is not supported by deliver-dispatch`);
  const isActionable = buckets.some((bucket) => (front.actionable[bucket] || []).includes(args.ticket));
  if (!isActionable) fail('NOT_ACTIONABLE', `${args.ticket} is not actionable for role ${args.role}`);

  const projectRoot = path.resolve(graphDir, '..', '..');
  const { dispatchId, dir } = prepareDispatchDir(options);

  if (args.role === 'pr-sentinel') {
    const prs = sentinelRoundPrs(graph.tickets, state, front);
    const preflightFn = options.preflightRound || sentinelPreflight.preflightRound;
    preflightFn({
      projectWorktree: worktreePath, graphDir, prs,
      ...(options.preflightRun ? { run: options.preflightRun } : {}),
    });
    return launchPrSentinel({ args, row, projectRoot, graphDir, dispatchId, dir, options });
  }

  const planPath = path.resolve(projectRoot, row.plan);
  let planBytes;
  try { planBytes = fs.readFileSync(planPath); }
  catch { return fail('PLAN_UNAVAILABLE', `canonical plan is unavailable: ${planPath}`); }
  const planSha256 = crypto.createHash('sha256').update(planBytes).digest('hex');
  const planInWorktree = isInsidePath(worktreePath, planPath);
  const sourceRevision = git(worktreePath, ['rev-parse', 'HEAD']);

  const packet = buildExecutorPacket({
    worktreePath, row, id: args.ticket, planPath, planSha256, planInWorktree, sourceRevision,
    planText: planBytes.toString('utf8'),
  });
  const hygiene = prHygiene.applies({ root: projectRoot, ref: row.pr_base });

  if (args.runtime === 'claude') {
    const request = buildClaudeExecutorRequest({ id: args.ticket, row, worktreePath, planPath, planSha256, packet, hygiene, projectRoot });
    claudeHost.validateRequest('executors', request);
    const hostScript = options.claudeHostScript || path.join(__dirname, 'claude-delivery-host.cjs');
    const requestFile = writeRequestFile(dir, 'request.json', request);
    return spawnDetached({
      dir, dispatchId, hostScript, hostArgs: ['--workflow', 'executors', '--request-file', requestFile],
      worktreePath, graphDir, ticket: args.ticket, role: args.role, runtime: args.runtime, options,
    });
  }

  const request = buildCodexExecutorRequest({ id: args.ticket, row, worktreePath, planSha256 });
  codexHost.validateArgs({ role: request.role, signals: request.signals, context: request.context });
  const hostScript = options.codexHostScript || path.join(__dirname, 'codex-delivery-host.cjs');
  const argsFile = writeRequestFile(dir, 'args.json', request);
  return spawnDetached({
    dir, dispatchId, hostScript, hostArgs: ['--args-file', argsFile],
    worktreePath, graphDir, ticket: args.ticket, role: args.role, runtime: args.runtime, options,
  });
}

function readRecord(stateDir, dispatchId) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, dispatchId, 'record.json'), 'utf8')); }
  catch { return null; }
}

function readResult(resultFile) {
  let raw = '';
  try { raw = fs.readFileSync(resultFile, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter((line) => line.trim());
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

// @security: EPERM means the pid belongs to another user, so it still counts as live.
function pidLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function statusOnce(dispatchId, options = {}) {
  const record = readRecord(dispatchStateDir(options), dispatchId);
  if (!record) return Object.freeze({ dispatch_id: dispatchId, status: 'lost' });
  const isLive = (options.pidLive || pidLive)(record.pid);
  if (isLive) {
    return Object.freeze({
      dispatch_id: dispatchId, status: 'running', ticket: record.ticket, role: record.role, runtime: record.runtime,
    });
  }
  const result = readResult(record.result);
  return Object.freeze({
    dispatch_id: dispatchId,
    status: result ? 'exited-ok' : 'exited-failed',
    ticket: record.ticket,
    role: record.role,
    runtime: record.runtime,
    ...(result ? { result } : {}),
  });
}

async function waitOnce(dispatchId, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15 * 60 * 1000;
  const intervalMs = Number.isSafeInteger(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 2000;
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = clock() + timeoutMs;
  for (;;) {
    const current = statusOnce(dispatchId, options);
    if (current.status !== 'running') {
      if (current.status !== 'lost') {
        const record = readRecord(dispatchStateDir(options), dispatchId);
        const recordWakeEventFn = options.recordWakeEvent || runWaker.recordWakeEvent;
        try {
          recordWakeEventFn({
            graph_dir: record && record.graph_dir,
            run_id: dispatchId,
            kind: 'dispatch',
            event_id: `deliver-dispatch:${dispatchId}`,
            reason: current.status,
          });
        } catch { /* best-effort */ }
      }
      return Object.freeze({ ...current, exit_code: EXIT_CODES[current.status] });
    }
    const remaining = deadline - clock();
    if (remaining <= 0) return Object.freeze({ ...current, exit_code: 3 });
    await sleep(Math.min(intervalMs, remaining));
  }
}

function flagValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function parseLaunchArgs(argv) {
  const runtime = flagValue(argv, '--runtime');
  const ticket = flagValue(argv, '--ticket');
  const role = flagValue(argv, '--role');
  const graphDir = flagValue(argv, '--graph-dir');
  if (runtime !== 'claude' && runtime !== 'codex') {
    fail('USAGE', 'usage: deliver-dispatch.cjs launch --runtime claude|codex --ticket <id> --role <role> [--graph-dir <d>]');
  }
  if (typeof ticket !== 'string' || !ticket) fail('USAGE', '--ticket is required');
  if (typeof role !== 'string' || !role) fail('USAGE', '--role is required');
  return { runtime, ticket, role, graphDir };
}

async function main(argv = process.argv.slice(2), output = process.stdout, options = {}) {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === 'launch') {
    const result = await launch(rest, options);
    output.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (command === 'status') {
    const id = flagValue(rest, '--dispatch');
    if (!id) fail('USAGE', 'usage: deliver-dispatch.cjs status --dispatch <id>');
    const result = statusOnce(id, options);
    output.write(`${JSON.stringify(result)}\n`);
    return result.status === 'exited-failed' ? 1 : result.status === 'lost' ? 2 : 0;
  }
  if (command === 'wait') {
    const id = flagValue(rest, '--dispatch');
    if (!id) fail('USAGE', 'usage: deliver-dispatch.cjs wait --dispatch <id> [--timeout-ms n]');
    const timeoutMs = Number(flagValue(rest, '--timeout-ms'));
    const result = await waitOnce(id, { ...options, ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}) });
    output.write(`${JSON.stringify(result)}\n`);
    return result.exit_code;
  }
  return fail('USAGE', 'usage: deliver-dispatch.cjs launch|status|wait ...');
}

module.exports = Object.freeze({
  ROLE_BUCKETS,
  buildSignals,
  contextReadPaths,
  resolveLaunchGraphDir,
  buildExecutorPacket,
  buildClaudeExecutorRequest,
  buildCodexExecutorRequest,
  phaseNumber,
  sentinelRoundPrs,
  launch,
  statusOnce,
  waitOnce,
  pidLive,
  dispatchStateDir,
  main,
});

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
