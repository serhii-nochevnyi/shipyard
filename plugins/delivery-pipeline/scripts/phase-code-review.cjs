#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const target = require('./architecture-target.cjs');
const core = require('./code-review-core.cjs');
const { resolveGraphDir } = require('./graph-dir.cjs');
const { loadConfig, DEFAULTS } = require('./pipeline-config.cjs');
const { hintForError } = require('./refusal-hints.cjs');
const details = new WeakMap();
const phaseNumber = value => Number(String(value).match(/^0*(\d+)/)?.[1]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error('current complete membership is unavailable or over its bound');
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (bytes.length !== stat.size || stat.dev !== after.dev || stat.ino !== after.ino
      || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
    throw new Error('current complete membership changed while reading');
  return JSON.parse(bytes);
}

function matchEpicPullRequest({ graph, state, live, repo = null, phase } = {}) {
  const unmatched = reason => ({ kind: 'unmatched', reason });
  if (!object(graph) || !object(graph.epics) || !object(graph.tickets))
    return unmatched('the canonical graph is unreadable or has no epics map');
  const head = live?.headRefName;
  if (typeof head !== 'string' || !head) return unmatched('the live PR has no head ref');
  const matches = Object.entries(graph.epics).filter(([key, row]) => object(row)
    && (phase === undefined || phaseNumber(key) === Number(phase)) && row.branch === head);
  if (matches.length > 1) return unmatched('more than one graph epic row names the live head ref');
  if (matches.length === 1) {
    const [key, epic] = matches[0], number = phaseNumber(key);
    if (!Number.isSafeInteger(number) || number < 1 || typeof epic.phaseDir !== 'string')
      return unmatched('the matched epic has no canonical phase directory or number');
    if (!Array.isArray(epic.repos) || !epic.repos.includes(repo))
      return unmatched('the matched epic does not list this repository');
    let rows;
    try { rows = target.phaseRows(graph, number, repo); }
    catch (error) { return unmatched(error.message); }
    if (rows.some(([, row]) => row.epic !== epic.branch))
      return unmatched('the phase ticket rows disagree on the epic branch');
    return { kind: 'epic', phase: number, phase_dir: epic.phaseDir, branch: epic.branch };
  }
  const recorded = state?.tickets || state || {};
  for (const [ticket, row] of Object.entries(graph.tickets)) {
    if (object(row) && (head === row.branch || head === recorded[ticket]?.pr_branch)) return { kind: 'ticket', ticket };
  }
  return unmatched('no graph epic row names the live head ref for this phase');
}

function resolveCodeReviewMode({ graphDir, worktree } = {}) {
  const resolved = graphDir ? { dir: path.resolve(graphDir), how: 'flag' } : resolveGraphDir([], worktree);
  if (resolved.how === 'none') return { mode: DEFAULTS.code_review, project_root: null,
    graph_dir: null, config_path: null, source: 'default' };
  const graph_dir = resolved.dir;
  const project_root = fs.realpathSync(path.resolve(graph_dir, '..', '..'));
  const config_path = path.join(project_root, '.planning/config.json');
  const loaded = loadConfig(project_root);
  for (const warning of loaded.warnings) process.stderr.write(`${warning}\n`);
  let declared = false;
  try { declared = Object.hasOwn(readJson(config_path)?.delivery_pipeline || {}, 'code_review'); } catch {}
  return { mode: loaded.config.code_review, project_root, graph_dir, config_path, source: declared ? 'config' : 'default' };
}

function git(worktree, args) {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', env,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 65536 }).trim();
}

function refusal(state, reason, mode) {
  return `phase code review is ${state}: ${reason}. The operator can set delivery_pipeline.code_review to "report" in ${
    mode.config_path || "the project root's .planning/config.json"} for this PR (nothing is held in report mode); there is no override flag and no waiver record.`;
}

function rejectTicket(mode) {
  const reason = 'this PR is a ticket PR; the phase code review applies only to the phase epic PR';
  throw Object.assign(new Error(refusal('ticket', reason, mode)), { code: 'CODE_REVIEW_TICKET_PR' });
}

function context(input, options) {
  const worktree = input.worktree || input.worktreePath || process.cwd();
  const repository = target.repositoryIdentity(worktree);
  const mode = resolveCodeReviewMode({ graphDir: input.graphDir, worktree });
  const repo = input.repo ?? null;
  const live = input.live || (options.getPullRequest ? options.getPullRequest({ pr: input.pr, repo, worktree })
    : JSON.parse((options.execFileSync || execFileSync)('gh', ['pr', 'view', String(input.pr),
      ...(repo ? ['--repo', repo] : []), '--json', 'number,state,headRefName,headRefOid,baseRefName,baseRefOid'],
    { cwd: worktree, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 })));
  const pr = input.pr ?? live.number;
  if (!Number.isSafeInteger(pr) || pr < 1 || live.number !== pr || live.state !== 'OPEN'
      || typeof live.headRefName !== 'string' || !live.headRefName.trim()
      || typeof live.baseRefName !== 'string' || !live.baseRefName.trim()
      || !/^[a-f0-9]{40}$/.test(live.headRefOid || '') || !/^[a-f0-9]{40}$/.test(live.baseRefOid || ''))
    throw new Error('live phase code review PR identity is incomplete');
  if (git(worktree, ['rev-parse', 'HEAD']) !== live.headRefOid) throw new Error('live PR head differs from worktree');
  const integration = target.resolveIntegrationBranch({ projectRoot: mode.project_root || worktree, repo,
    defaultBranch: options.defaultBranch, exec: options.execFileSync || execFileSync });
  if (!target.architectureTarget({ base: live.baseRefName, integrationBranch: integration }).required)
    throw new Error('phase code review requires an integration-target PR');
  let graph = null, state = null;
  try {
    graph = readJson(path.join(mode.graph_dir, 'tickets.json'));
    state = readJson(path.join(mode.graph_dir, 'delivery-state.json'));
  } catch { graph = null; state = null; }
  const match = matchEpicPullRequest({ graph, state, live, repo, phase: input.phase });
  return { worktree, repository, mode, repo, live, pr, graph, state, match };
}

function status(input, options = {}) {
  const ctx = context(input, options);
  const { worktree, repository, mode, repo, live, pr, graph, match } = ctx;
  if (match.kind === 'ticket') rejectTicket(mode);
  const result = { schema: 'shipyard.phase-code-review-status.v1', mode: mode.mode, phase: null, pr,
    head: live.headRefOid, base_commit: live.baseRefOid, subject: null, state: 'unmatched', round: null,
    round_cap: core.ROUND_CAP, rounds_used: 0, scope: null, verdict: null, blocking_count: null,
    warning_count: null, review_completeness: null, reuse: false, retry: false, repair: 'none',
    disagreement_suppressed: 0, partitions_not_reviewed: 0, artifact_ref: null, reason: match.reason || null };
  details.set(result, { mode, current: null, ctx });
  if (match.kind === 'unmatched') return Object.freeze(result);
  const binding = target.phaseBinding({ graph, state: ctx.state?.tickets || ctx.state, phase: match.phase,
    repository, repo, branch: match.branch, pr, head: live.headRefOid, base: live.baseRefOid });
  target.parseSubject('architecture-review', binding.subject);
  const selector = input.phaseDirectory || input.phaseDir;
  if (binding.phase !== match.phase_dir || (selector && selector !== binding.phase))
    throw new Error('phase selector must name its canonical directory');
  Object.assign(result, { phase: match.phase, subject: binding.subject });
  const authority = require('./role-artifact.cjs');
  const prior = authority.priorCodeReviewVerdicts({ worktreePath: worktree, repository,
    phaseDir: binding.phase, graphDir: mode.graph_dir });
  const history = { priorVerdicts: prior, head: live.headRefOid, isAncestor: (a, b) => {
    try { git(worktree, ['merge-base', '--is-ancestor', a, b]); return true; }
    catch (error) {
      if (error.status === 1 && !error.signal && !error.code && !error.killed && !error.error) return false;
      throw error;
    }
  } };
  const countable = core.countableVerdicts(history), next = core.nextRound(history);
  let current = null;
  try {
    current = authority.currentCodeReviewVerdict({ worktreePath: worktree, graphDir: mode.graph_dir,
      pr, repo, head: live.headRefOid, headBranch: match.branch, baseName: live.baseRefName, baseCommit: live.baseRefOid });
  } catch (error) {
    if (error.code === 'REPOSITORY_IDENTITY_INVALID') throw error;
  }
  result.rounds_used = countable.length;
  const counted = current && current.subject === binding.subject && countable.some(entry => entry.artifact_ref === current.artifact_ref
    && entry.head === current.head && entry.base_commit === current.base_commit);
  if (current && current.review_completeness === 'complete' && counted) {
    Object.assign(result, { state: 'current', round: current.round, scope: current.scope, verdict: current.verdict,
      blocking_count: current.blocking_count, warning_count: current.findings.filter(finding => finding.severity === 'WARNING').length,
      review_completeness: current.review_completeness, reuse: true,
      repair: current.verdict === 'needs-fix' ? (core.repairAllowed(current.round) ? 'tickets' : 'human') : 'none',
      disagreement_suppressed: current.disagreement_suppressed, partitions_not_reviewed: current.partitions_not_reviewed,
      artifact_ref: current.artifact_ref, reason: current.verdict === 'pass' ? 'the complete verdict is current'
        : `the current verdict is ${current.verdict} with ${current.blocking_count} BLOCKERs` });
    details.set(result, { mode, current, ctx, prior: countable });
    return Object.freeze(result);
  }
  const incomplete = current || prior.filter(entry => entry.head === live.headRefOid
    && !countable.includes(entry)).at(-1);
  Object.assign(result, { state: next.state === 'limit' ? 'limit' : 'owed', round: next.round, scope: next.scope || null,
    retry: !!incomplete, review_completeness: incomplete?.review_completeness || null,
    partitions_not_reviewed: incomplete?.partitions_not_reviewed ?? 0, reason: next.state === 'limit'
      ? refusal('limit', 'three rounds are spent; no further review can launch', mode)
      : `${incomplete ? (incomplete.review_completeness !== 'complete' ? 'the sealed review is incomplete'
        : 'the sealed delta has no complete full-scope lineage') + '; ' : ''}run deliver-dispatch.cjs build code-review first` });
  details.set(result, { mode, current, ctx, prior: countable });
  return Object.freeze(result);
}

function evaluateGate(input, options = {}) {
  const current = details.has(input) ? input : status(input, options);
  const mode = details.get(current)?.mode || resolveCodeReviewMode(input);
  const ok = current.mode === 'report' || (current.state === 'current' && current.reuse
    && current.verdict === 'pass' && current.blocking_count === 0 && current.review_completeness === 'complete');
  return { ok, state: current.state, reason: current.reason, message: current.mode === 'report'
    ? `phase code review is ${current.state}: ${current.reason}; nothing is held in report mode`
    : ok ? `phase code review is current: ${current.reason}`
      : current.state === 'limit' ? current.reason : refusal(current.state, current.reason, mode) };
}

function fixTickets(input, options = {}) {
  const current = status(input, options), stored = details.get(current);
  if (current.repair === 'human') (options.stderr || process.stderr).write(
    `The review can no longer re-check a repair; BLOCKERs stay visible on the PR. ${refusal(current.state, current.reason, stored.mode)}\n`);
  if (current.repair !== 'tickets') return [];
  return stored.current.findings.filter(finding => finding.severity === 'BLOCKER' && finding.blocking).map(finding => ({
    finding_id: finding.id, title: finding.fix_ticket.title, scope: finding.fix_ticket.scope,
    files: [...finding.fix_ticket.files], depends_on: [...(finding.fix_ticket.depends_on || [])] }));
}

function statusDescription(current) {
  const count = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('status counts must be non-negative safe integers');
    return String(value);
  };
  if (current.state === 'limit') return { state: 'pending',
    description: 'code review limit reached: no further review will run for this head' };
  if (current.state === 'owed' && current.retry) return { state: 'pending',
    description: `code review incomplete: ${count(current.partitions_not_reviewed)} partitions not reviewed` };
  if (current.state === 'current' && current.verdict === 'pass' && current.review_completeness === 'complete'
      && current.blocking_count === 0) return { state: 'success',
    description: `code review: no blocking issues, ${count(current.warning_count)} notes` };
  if (current.state === 'current' && current.verdict === 'needs-fix') return { state: 'pending',
    description: `code review: ${count(current.blocking_count)} blocking issues, ${count(current.warning_count)} notes` };
  throw new Error('publication requires a sealed verdict for the exact head or the limit state');
}

function originalLocator(finding, sealed, prior, ctx, readSource) {
  const identity = finding.disagreement_identity || finding.identity;
  if (!identity) return null;
  const reusable = locator => {
    try {
      const priorFindings = core.carryPriorFindings({ priorFindings: sealed, deltaDiff: '', readSource });
      const disagreements = core.parseDisagreements(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1',
        entries: [{ ...locator, reason: 'locator validation', recorded_by: 'publication' }] }), { priorFindings });
      const carried = core.carryPriorFindings({ priorFindings: sealed, deltaDiff: '', disagreements, readSource });
      return carried.findIndex(entry => entry.disagreement !== null) === sealed.findings.indexOf(finding) ? locator : null;
    } catch { return null; }
  };
  const proven = candidate => {
    if (candidate.citation !== 'resolved' || candidate.identity !== identity
        || (candidate.disagreement_identity && candidate.disagreement_identity !== identity)) return null;
    try {
      if (core.lineIdentity({ path: candidate.path, lineText: candidate.line_text,
        ordinal: candidate.occurrence }) !== identity) return null;
      return reusable({ path: candidate.path, line_text: candidate.line_text, occurrence: candidate.occurrence });
    } catch { return null; }
  };
  for (const candidate of [finding, ...prior.flatMap(entry => entry.findings)]) {
    const locator = proven(candidate);
    if (locator) return locator;
  }
  if (!finding.disagreement_identity) return null;
  try {
    const priorFindings = core.carryPriorFindings({ priorFindings: sealed, deltaDiff: '',
      readSource });
    const loaded = core.loadDisagreements({ projectRoot: ctx.mode.project_root, phaseDirName: ctx.match.phase_dir,
      priorFindings, readFile: file => {
        const stat = fs.lstatSync(file);
        if (stat.size > 65536) throw new Error('disagreements exceed their bound');
        return { stat, text: JSON.stringify(readJson(file)) };
      } });
    const entry = loaded.entries[identity];
    if (entry && core.lineIdentity({ path: entry.path, lineText: entry.line_text,
      ordinal: entry.occurrence }) === identity)
      return reusable({ path: entry.path, line_text: entry.line_text, occurrence: entry.occurrence });
  } catch {}
  return null;
}

function findingsComment(current, sealed, prior, ctx) {
  const readSource = core.createSourceReader({ git: args => git(ctx.worktree, args), head: sealed.head });
  const header = `<!-- code-review -->\nCode review — round ${sealed.round}, scope ${sealed.scope}\nVerdict: ${sealed.verdict}\n\n`;
  const stop = current.mode === 'hold' && !(current.state === 'current' && current.verdict === 'pass');
  const footer = `\n${sealed.disagreement_suppressed} findings not raised again because of a recorded disagreement.\n`
    + `citations_unresolved: ${sealed.citations_unresolved}\n`
    + (stop ? '\nOperator exit: set delivery_pipeline.code_review to "report" for this PR.\n' : '');
  const blocks = sealed.findings.map(finding => {
    let text = `${finding.severity} [${finding.rule}] ${finding.path || '(unresolved path)'}:${finding.line || '?'}`
      + (finding.suppressed ? ' (recorded disagreement; not blocking)' : '') + '\n'
      + `${finding.summary}\n`;
    if (finding.severity === 'BLOCKER') {
      const locator = originalLocator(finding, sealed, prior, ctx, readSource);
      text += `Failure scenario: ${finding.failure_scenario}\n`
        + `Proposed fix-ticket title: ${finding.fix_ticket.title}\n`
        + `Source line (full text), occurrence ${finding.occurrence ?? 'unresolved'}:\n`
        + `    ${JSON.stringify(finding.line_text)}\n`
        + (locator ? 'Recorded disagreement values (path, line_text, occurrence):\n'
          + `    ${JSON.stringify(locator)}\n` : 'No reusable original locator is available.\n');
    }
    return text + '\n';
  });
  let body = header, included = 0;
  for (const block of blocks) {
    if (body.length + block.length + footer.length + 64 > 60000) break;
    body += block; included++;
  }
  if (included < blocks.length) body += `and ${blocks.length - included} more findings.\n`;
  return body + footer;
}

function publish(input, options = {}) {
  const worktree = input.worktree || input.worktreePath || process.cwd(), repo = input.repo ?? null;
  const request = args => {
    const output = options.gh ? options.gh(args) : (options.execFileSync || execFileSync)('gh', args,
      { cwd: worktree, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return typeof output === 'string' ? (output.trim() ? JSON.parse(output) : null) : output;
  };
  const readPR = pr => options.getPullRequest ? options.getPullRequest({ pr, repo, worktree })
    : request(['pr', 'view', String(pr), ...(repo ? ['--repo', repo] : []),
      '--json', 'number,state,headRefName,headRefOid,baseRefName,baseRefOid']);
  const current = status(input, { ...options, getPullRequest: ({ pr }) => readPR(pr) });
  const { ctx, current: sealed, prior } = details.get(current);
  if (ctx.match.kind !== 'epic') throw new Error(`phase code review is unmatched: ${current.reason}`);
  if (current.state !== 'limit' && (!sealed || sealed.head !== current.head || sealed.subject !== current.subject
      || !(current.state === 'current' || (current.state === 'owed' && current.retry && sealed.review_completeness === 'incomplete'))))
    throw new Error('publication requires a sealed verdict for the exact head; the review is owed');
  const recorded = ctx.state?.tickets || ctx.state || {};
  for (const [ticket, row] of Object.entries(ctx.graph.tickets)) {
    if ((row.repo ?? null) !== ctx.repo) continue;
    const pr = recorded[ticket]?.pr;
    if (pr === undefined || pr === null) continue;
    if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('graph ticket PR identity is incomplete');
    if (pr === ctx.pr) rejectTicket(ctx.mode);
    const live = readPR(pr);
    if (live?.number !== pr || !/^[a-f0-9]{40}$/.test(live.headRefOid || ''))
      throw new Error('live graph ticket PR head is unavailable');
    if (live.headRefOid === current.head) rejectTicket(ctx.mode);
  }
  const live = readPR(ctx.pr);
  const match = matchEpicPullRequest({ graph: ctx.graph, state: ctx.state, live, repo: ctx.repo, phase: current.phase });
  if (match.kind === 'ticket') rejectTicket(ctx.mode);
  if (match.kind !== 'epic') throw new Error(`phase code review is unmatched: ${match.reason}`);
  if (['number', 'state', 'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid'].some(key => live[key] !== ctx.live[key])
      || live.headRefOid !== current.head || git(ctx.worktree, ['rev-parse', 'HEAD']) !== current.head)
    throw new Error('live phase PR identity changed before publication');
  const summary = statusDescription(current);
  const api = ctx.repo ? `repos/${ctx.repo}` : 'repos/{owner}/{repo}';
  const result = { schema: 'shipyard.phase-code-review-publish.v1',
    status: { ok: false, action: 'failed', head: current.head, ...summary }, comment: { ok: false }, rules: [] };
  try {
    request(['api', `${api}/statuses/${current.head}`, '-f', `state=${summary.state}`,
      '-f', 'context=code-review', '-f', `description=${summary.description}`]);
    result.status.ok = true; result.status.action = 'posted';
  } catch (error) { result.status.reason = error.message; }
  if (current.state === 'limit') {
    result.comment = { ok: true, action: 'skipped', reason: 'limit publishes status only' };
    return result;
  }
  try {
    const body = findingsComment(current, sealed, prior, ctx);
    const hygiene = require('./pr-hygiene.cjs');
    const violations = hygiene.applies({ root: ctx.worktree }) ? hygiene.internalLeakViolations('comment', body) : [];
    result.rules = [...new Set(violations.map(violation => violation.rule))];
    if (result.rules.length) {
      result.comment = { ok: false, action: 'refused', reason: 'PR hygiene refused comment' };
      return result;
    }
    const pages = request(['api', `${api}/issues/${ctx.pr}/comments`, '--paginate', '--slurp']);
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('comment lookup is unavailable');
    const existing = pages.flat().find(comment => typeof comment.body === 'string' && comment.body.includes('<!-- code-review -->'));
    if (existing && (!Number.isSafeInteger(existing.id) || existing.id < 1)) throw new Error('comment identity is unavailable');
    const posted = request(['api', existing ? `${api}/issues/comments/${existing.id}` : `${api}/issues/${ctx.pr}/comments`,
      '--method', existing ? 'PATCH' : 'POST', '-f', `body=${body}`]);
    result.comment = { ok: true, action: existing ? 'edited' : 'created', id: existing?.id ?? posted?.id };
  } catch (error) { result.comment = { ok: false, action: 'failed', reason: error.message }; }
  return result;
}

function verifyCodeReview(input, options = {}) {
  const worktree = input.worktree || input.worktreePath || process.cwd();
  const mode = resolveCodeReviewMode({ graphDir: input.graphDir, worktree });
  const integration = target.resolveIntegrationBranch({ projectRoot: mode.project_root || worktree, repo: input.repo ?? null,
    defaultBranch: options.defaultBranch, exec: options.execFileSync || execFileSync });
  if (!target.architectureTarget({ base: input.live.baseRefName, integrationBranch: integration }).required) return null;
  let graph = null, state = null;
  try { graph = readJson(path.join(mode.graph_dir, 'tickets.json')); state = readJson(path.join(mode.graph_dir, 'delivery-state.json')); }
  catch { graph = null; state = null; }
  const match = matchEpicPullRequest({ graph, state, live: input.live, repo: input.repo ?? null });
  if (match.kind === 'ticket') return null;
  const current = status({ ...input, worktree, pr: input.live.number, phase: match.kind === 'epic' ? match.phase : undefined }, options);
  const gate = evaluateGate(current);
  return { ...current, ok: gate.ok, reason: gate.ok ? current.reason : gate.message };
}

module.exports = { publish, statusDescription, status, evaluateGate, fixTickets, matchEpicPullRequest, resolveCodeReviewMode, verifyCodeReview };

if (require.main === module) {
  try {
    const argv = process.argv.slice(2), verb = argv[0];
    const usage = message => { throw Object.assign(new Error(message), { exitCode: 2 }); };
    if (!['status', 'gate', 'fix-tickets', 'publish'].includes(verb) || !argv[1] || argv[1].startsWith('--'))
      usage('usage: phase-code-review.cjs <status|gate|fix-tickets|publish> <phase-directory> --phase N --pr P [--repo owner/name] [--graph dir] [--worktree path]');
    const input = { phaseDirectory: argv[1] }, seen = new Set();
    const names = { '--phase': 'phase', '--pr': 'pr', '--repo': 'repo', '--graph': 'graphDir', '--worktree': 'worktree' };
    for (let i = 2; i < argv.length; i += 2) {
      const name = names[argv[i]], value = argv[i + 1];
      if (!name || seen.has(name) || !value || value.startsWith('--')) usage(`invalid argument ${argv[i]}`);
      seen.add(name);
      if (['phase', 'pr'].includes(name)) {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) usage(`${argv[i]} requires a positive integer`);
        input[name] = Number(value);
      } else {
        if (name === 'repo' && (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
            || value.split('/').some(part => part === '.' || part === '..'))) usage('--repo requires owner/name');
        input[name] = value;
      }
    }
    if (!input.phase || !input.pr) usage('--phase and --pr are required');
    if (verb === 'gate') {
      const gate = evaluateGate(input); process.stderr.write(`${gate.message}\n`); process.exitCode = gate.ok ? 0 : 1;
    } else if (verb === 'publish') {
      const result = publish(input); console.log(JSON.stringify(result));
      process.exitCode = result.status.ok && result.comment.ok ? 0 : 1;
    } else console.log(JSON.stringify(verb === 'status' ? status(input) : fixTickets(input)));
  } catch (error) {
    process.stderr.write(`${error.code ? error.code + ': ' : ''}${error.message}\n`);
    const hint = hintForError(error); if (hint) process.stderr.write(`${hint}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
