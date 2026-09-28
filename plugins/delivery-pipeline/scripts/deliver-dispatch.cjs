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

function buildFail(field, message) {
  const error = new Error(`deliver-dispatch: ${message}`);
  error.code = 'BUILD_REFUSED';
  error.field = field;
  error.exitCode = 2;
  throw error;
}

function parseBuildArgs(argv) {
  const role = argv[0];
  const ticket = argv[1];
  if (!['arch-review', 'ci-fix', 'review-fix'].includes(role)) {
    buildFail('--role', `build role must be arch-review, ci-fix, or review-fix`);
  }
  if (typeof ticket !== 'string' || !ticket.trim()) buildFail('<ticket>', 'build ticket is required');
  const args = { role, ticket, runtime: 'claude' };
  const seen = new Set();
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--runtime', '--pr', '--failure-file', '--review-file'].includes(flag)) {
      buildFail(flag, `unsupported build field ${flag}`);
    }
    if (seen.has(flag)) buildFail(flag, `${flag} may be supplied only once`);
    seen.add(flag);
    const value = argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      buildFail(flag, `${flag} requires a value`);
    }
    if (flag === '--runtime') {
      if (value !== 'claude' && value !== 'codex') buildFail(flag, '--runtime must be claude or codex');
      args.runtime = value;
    } else if (flag === '--pr') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        buildFail(flag, '--pr must be a positive integer');
      }
      args.pr = Number(value);
    } else if (flag === '--failure-file') args.failureFile = value;
    else args.reviewFile = value;
  }
  if (role === 'ci-fix' && !args.failureFile) buildFail('--failure-file', 'ci-fix requires --failure-file <f>');
  if (role === 'review-fix' && !args.reviewFile) buildFail('--review-file', 'review-fix requires --review-file <f>');
  if (role !== 'ci-fix' && args.failureFile) buildFail('--failure-file', '--failure-file is only valid for ci-fix');
  if (role !== 'review-fix' && args.reviewFile) buildFail('--review-file', '--review-file is only valid for review-fix');
  return args;
}

function resolveBuildGraphDir(worktree, options) {
  if (options.graphDir) {
    if (!fs.existsSync(path.join(options.graphDir, 'tickets.json'))) {
      buildFail('--graph-dir', `canonical ticket graph is unavailable: ${options.graphDir}`);
    }
    try { return canonicalizeGraphDir(options.graphDir, worktree, 'flag'); }
    catch (error) { buildFail('--graph-dir', error.message.replace(/^deliver-dispatch: /, '')); }
  }
  if (trackedAtHead(worktree, '.planning/graph/tickets.json')) {
    try { return canonicalizeGraphDir(path.join(worktree, '.planning', 'graph'), worktree, 'worktree'); }
    catch (error) { buildFail('graph', error.message.replace(/^deliver-dispatch: /, '')); }
  }
  const resolved = resolveGraphDir([], worktree);
  if (resolved.how === 'none' || !fs.existsSync(path.join(resolved.dir, 'tickets.json'))) {
    buildFail('graph', `no canonical ticket graph found (looked in ${resolved.dir}); set SHIPYARD_GRAPH_DIR`);
  }
  try { return canonicalizeGraphDir(resolved.dir, worktree, resolved.how); }
  catch (error) { buildFail('graph', error.message.replace(/^deliver-dispatch: /, '')); }
}

function buildTicketContext(args, options) {
  const cwd = options.cwd || process.cwd();
  let worktree;
  try { worktree = fs.realpathSync(cwd); }
  catch { buildFail('worktree', `ticket worktree ${cwd} does not exist`); }
  const graphDir = resolveBuildGraphDir(worktree, options);
  const graph = readJsonBounded(path.join(graphDir, 'tickets.json'));
  const row = graph && object(graph.tickets) ? graph.tickets[args.ticket] : null;
  if (!object(row)) buildFail('ticket', `ticket ${args.ticket} has no canonical graph entry in ${graphDir}`);
  if (typeof row.branch !== 'string' || !row.branch.trim()) buildFail('branch', 'graph row branch is required');
  if (typeof row.plan !== 'string' || !row.plan.trim() || path.isAbsolute(row.plan)
      || row.plan.split(/[\\/]/).includes('..')) buildFail('planPath', 'graph row plan path is invalid');
  if (!Array.isArray(row.files) || !row.files.length
      || row.files.some((file) => typeof file !== 'string' || !file.trim())) {
    buildFail('files', 'graph row files must be an array of paths');
  }
  try { phaseNumber(row.phase); }
  catch (error) { buildFail('phase', error.message.replace(/^deliver-dispatch: /, '')); }
  let branch;
  try { branch = git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']); }
  catch { buildFail('branch', 'ticket worktree must be on a named branch'); }
  if (branch !== row.branch) buildFail('branch', `worktree branch ${branch} differs from canonical graph branch ${row.branch}`);
  const projectRoot = path.resolve(graphDir, '..', '..');
  const planPath = path.resolve(projectRoot, row.plan);
  if (!isInsidePath(projectRoot, planPath)) buildFail('planPath', 'canonical plan path escapes the project root');
  let planStat;
  try { planStat = fs.lstatSync(planPath); } catch { buildFail('planPath', `canonical plan is unavailable: ${planPath}`); }
  if (!planStat.isFile() || planStat.isSymbolicLink()) buildFail('planPath', 'canonical plan must be a regular file');
  const rawState = readJsonBounded(path.join(graphDir, 'delivery-state.json')) || {};
  const state = object(rawState) && object(rawState.tickets) ? rawState.tickets : rawState;
  const stateRow = object(state) && object(state[args.ticket]) ? state[args.ticket] : {};
  return { worktree, graphDir, graph, row, projectRoot, planPath, stateRow };
}

function evidenceInput(worktree, value, field) {
  const candidate = path.resolve(worktree, value);
  let realPath;
  try { realPath = fs.realpathSync(candidate); }
  catch { buildFail(field, `${field} file is unavailable: ${candidate}`); }
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { buildFail(field, `${field} file is unavailable: ${candidate}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) buildFail(field, `${field} must be a regular non-symlink file`);
  if (stat.size > 8 * 1024 * 1024) buildFail(field, `${field} exceeds the 8388608-byte limit`);
  let bytes;
  try { bytes = fs.readFileSync(candidate); } catch { buildFail(field, `${field} file cannot be read: ${candidate}`); }
  if (bytes.length !== stat.size) buildFail(field, `${field} changed while its digest was computed`);
  return Object.freeze({ path: realPath, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}

function validateBuildRequest(role, validator, request) {
  try { return validator(request); }
  catch (error) {
    const message = String(error && error.message || error);
    const field = ['schema', 'role', 'worktree', 'ticket', 'pr', 'signals', 'scope', 'args', 'phase']
      .find((name) => new RegExp(`\\b${name}\\b`, 'i').test(message)) || 'request';
    buildFail(field, `${role} request field ${field} rejected by host validator: ${message}`);
  }
}

function claudeFixCandidate(args, input, evidence) {
  const isCi = args.role === 'ci-fix';
  const pr = args.pr || input.stateRow.pr;
  if (!Number.isSafeInteger(pr) || pr < 1) buildFail('--pr', 'fix request needs --pr or a canonical delivery-state PR number');
  const base = input.stateRow.base || input.stateRow.pr_base || input.row.pr_base;
  if (typeof base !== 'string' || !base.trim()) buildFail('base', 'fix request needs a canonical delivery-state base');
  return {
    schema: claudeHost.REQUEST_SCHEMA,
    scope: {
      run_id: `deliver-build-${args.role}-${args.ticket}`,
      ticket: args.ticket,
      phase: phaseNumber(input.row.phase),
      worktree: input.worktree,
    },
    args: {
      prs: [{
        id: args.ticket,
        pr,
        branch: input.row.branch,
        worktreePath: input.worktree,
        planPath: input.planPath,
        base,
        needsCiFix: isCi,
        needsReviewFix: !isCi,
        signals: buildSignals(input.row),
        repo: input.row.repo || null,
        files_modified: input.row.files,
        ...(isCi ? { failureEvidence: evidence } : { reviewEvidence: evidence }),
      }],
    },
  };
}

function codexCandidate(args, input, evidence) {
  return {
    role: args.role,
    signals: buildSignals(input.row),
    context: {
      ticket: args.ticket,
      pr: args.pr || input.stateRow.pr || null,
      worktreePath: input.worktree,
      branch: input.row.branch,
      repository: input.row.repo || null,
      files_modified: input.row.files,
      evidence_path: evidence ? evidence.path : null,
      evidence_sha256: evidence ? evidence.sha256 : null,
    },
  };
}

function incompleteHostReason(runtime, role) {
  if (runtime === 'codex' && role === 'arch-review') {
    return 'codex arch-review host contract missing: the released host requires a caller-built prompt and does not derive the graph-bound PR diff and ADR corpus';
  }
  if (runtime === 'codex') {
    const evidence = role === 'ci-fix' ? 'failure' : 'review';
    return `codex ${role} host contract missing: the released host does not bind the graph ticket, PR, and ${evidence} evidence SHA-256 at launch`;
  }
  const evidence = role === 'ci-fix' ? 'failure' : 'review';
  return `claude ${role} host contract missing: fix-round does not authenticate the supplied ${evidence} evidence path and SHA-256 at launch`;
}

function build(argv, options = {}) {
  const args = parseBuildArgs(argv);
  const input = buildTicketContext(args, options);
  const signals = buildSignals(input.row);
  const evidence = args.failureFile
    ? evidenceInput(input.worktree, args.failureFile, '--failure-file')
    : args.reviewFile ? evidenceInput(input.worktree, args.reviewFile, '--review-file') : null;

  if (args.role === 'arch-review' && args.runtime === 'claude') {
    const pr = args.pr || (Number.isSafeInteger(input.stateRow.pr) && input.stateRow.pr > 0
      ? input.stateRow.pr : undefined);
    const request = {
      schema: claudeRoleHost.REQUEST_SCHEMA,
      role: args.role,
      worktree: input.worktree,
      ticket: args.ticket,
      ...(pr ? { pr } : {}),
      ...(Object.keys(signals).length ? { signals } : {}),
    };
    validateBuildRequest(args.role, (value) => claudeRoleHost.parseRequest(value), request);
    return request;
  }

  if (args.runtime === 'claude') {
    const request = claudeFixCandidate(args, input, evidence);
    validateBuildRequest(args.role, (value) => claudeHost.validateRequest('fix-round', value), request);
    buildFail('host contract', incompleteHostReason(args.runtime, args.role));
  }

  const request = codexCandidate(args, input, evidence);
  validateBuildRequest(args.role, (value) => codexHost.validateArgs(value), request);
  buildFail('host contract', incompleteHostReason(args.runtime, args.role));
}

async function main(argv = process.argv.slice(2), output = process.stdout, options = {}) {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === 'build') {
    const request = build(rest, options);
    output.write(`${JSON.stringify(request)}\n`);
    return 0;
  }
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
  return fail('USAGE', 'usage: deliver-dispatch.cjs build|launch|status|wait ...');
}

module.exports = Object.freeze({
  ROLE_BUCKETS,
  buildSignals,
  contextReadPaths,
  resolveLaunchGraphDir,
  buildExecutorPacket,
  buildClaudeExecutorRequest,
  buildCodexExecutorRequest,
  parseBuildArgs,
  build,
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
    process.exitCode = error && error.exitCode === 2 ? 2 : 1;
  });
}
