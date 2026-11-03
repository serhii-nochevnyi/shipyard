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
    if (object(row) && (row.repo ?? null) === repo
        && (head === row.branch || head === recorded[ticket]?.pr_branch)) return { kind: 'ticket', ticket };
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
  return { mode: loaded.config.code_review, project_root, graph_dir, config_path,
    source: declared ? 'config' : 'default', valid: loaded.valid, error: loaded.error };
}

function assertPublicationConfig(mode) {
  const loaded = loadConfig(mode.project_root);
  if (!loaded.valid) throw Object.assign(new Error(
    `Refusing code review publication: invalid configuration ${loaded.error.file}: ${loaded.error.message}`),
  { code: 'CONFIG_INVALID', file: loaded.error.file });
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
    round_cap: core.ROUND_CAP, round_limit: core.ROUND_CAP, rounds_used: 0, scope: null, verdict: null, blocking_count: null,
    warning_count: null, review_completeness: null, reuse: false, retry: false, repair: 'none',
    disagreement_suppressed: 0, partitions_not_reviewed: 0, artifact_ref: null, extension: null, reason: match.reason || null };
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
  const history = { priorVerdicts: prior, mergeBase: git(worktree, ['merge-base', live.baseRefOid, live.headRefOid]), head: live.headRefOid,
    baseCommit: live.baseRefOid, readRecords: () => readExtensions({ repository, repo, pr, roots: [worktree, mode.project_root] }), isAncestor: (a, b) => {
    try { git(worktree, ['merge-base', '--is-ancestor', a, b]); return true; }
    catch (error) {
      if (error.status === 1 && !error.signal && !error.code && !error.killed && !error.error) return false;
      throw error;
    }
  } };
  const { countable, ...next } = core.roundLookup(history);
  let current = null;
  try {
    current = authority.currentCodeReviewVerdict({ worktreePath: worktree, graphDir: mode.graph_dir,
      pr, repo, head: live.headRefOid, headBranch: match.branch, baseName: live.baseRefName, baseCommit: live.baseRefOid });
  } catch (error) {
    if (error.code === 'REPOSITORY_IDENTITY_INVALID') throw error;
  }
  result.rounds_used = countable.length; result.round_limit = next.limit;
  const counted = current && current.subject === binding.subject && countable.some(entry => entry.artifact_ref === current.artifact_ref
    && entry.head === current.head && entry.base_commit === current.base_commit);
  if (current && current.review_completeness === 'complete' && counted) {
    Object.assign(result, { state: 'current', round: current.round, scope: current.scope, verdict: current.verdict,
      blocking_count: current.blocking_count, warning_count: current.findings.filter(finding => finding.severity === 'WARNING').length,
      review_completeness: current.review_completeness, reuse: true,
      repair: current.verdict === 'needs-fix' ? (core.repairAllowed(current.round) ? 'tickets' : 'human') : 'none',
      disagreement_suppressed: current.disagreement_suppressed, partitions_not_reviewed: current.partitions_not_reviewed,
      artifact_ref: current.artifact_ref, extension: current.extension ?? null, reason: current.verdict === 'pass' ? 'the complete verdict is current'
        : `the current verdict is ${current.verdict} with ${current.blocking_count} BLOCKERs` });
    details.set(result, { mode, current, ctx, prior: countable, history });
    return Object.freeze(result);
  }
  const incomplete = current || prior.filter(entry => entry.head === live.headRefOid
    && !countable.includes(entry)).at(-1);
  Object.assign(result, { state: next.state === 'limit' ? 'limit' : 'owed', round: next.round, scope: next.scope || null,
    retry: !!incomplete, review_completeness: incomplete?.review_completeness || null,
    partitions_not_reviewed: incomplete?.partitions_not_reviewed ?? 0, reason: next.state === 'limit'
      ? refusal('limit', core.limitMessage(next), mode)
      : `${incomplete ? (incomplete.review_completeness !== 'complete' ? 'the sealed review is incomplete'
        : 'the sealed delta has no complete full-scope lineage') + '; ' : ''}run deliver-dispatch.cjs build code-review first` });
  details.set(result, { mode, current, ctx, prior: countable, history });
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

const clip = (value, max) => value.slice(0, Math.max(0, max)).replace(/[\ud800-\udbff]$/, '').trimEnd();
// @security: sealed operator text is re-cleaned and cut here; it never reaches a public surface as markup.
function extensionLine(round, extension, room = Infinity) {
  let operator = clip(cleanText(extension.operator), 128) || 'unknown', reason = clip(cleanText(extension.reason), 200) || 'unknown';
  const time = clip(cleanText(extension.at), 16);
  const line = () => `round ${round} of ${core.ROUND_CAP}, extended by ${operator} at ${time}Z${reason ? `: ${reason}` : ''}`;
  const excess = () => Math.max(0, line().length - room);
  reason = clip(reason, reason.length - excess());
  operator = clip(operator, operator.length - excess());
  return line();
}

function statusDescription(current) {
  const count = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('status counts must be non-negative safe integers');
    return String(value);
  };
  const shown = text => {
    if (current.state !== 'current' || !current.extension) return text;
    return `${text}; ${extensionLine(current.round, current.extension, require('./gate-trailer.cjs').STATUS_MAX - text.length - 2)}`;
  };
  if (current.state === 'limit') return { state: 'pending',
    description: 'code review limit reached: no further review will run for this head' };
  if (current.state === 'owed' && current.retry) return { state: 'pending',
    description: `code review incomplete: ${count(current.partitions_not_reviewed)} partitions not reviewed` };
  if (current.state === 'current' && current.verdict === 'pass' && current.review_completeness === 'complete'
      && current.blocking_count === 0) return { state: 'success',
    description: shown(`code review: no blocking issues, ${count(current.warning_count)} notes`) };
  if (current.state === 'current' && current.verdict === 'needs-fix') return { state: 'pending',
    description: shown(`code review: ${count(current.blocking_count)} blocking issues, ${count(current.warning_count)} notes`) };
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
  const header = `<!-- code-review -->\nCode review — round ${sealed.round}, scope ${sealed.scope}\n`
    + (current.extension ? extensionLine(sealed.round, current.extension) + '\n' : '') + `Verdict: ${sealed.verdict}\n\n`;
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

const crypto = require('node:crypto');
const { withLock, writeAtomic } = require('./lock.cjs');
const publicationHash = value => crypto.createHash('sha256').update(value).digest('hex');
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const PUBLICATION_BOUND = 8192;

const publicationsRoot = () => path.join(fs.realpathSync(require('node:os').homedir()), '.local/state/shipyard/code-review-publications');

function publicationLocation(input) {
  const { repository, repo = null, pr, roots } = input ?? {};
  if (!positiveId(pr)) throw new Error('a pull request number is required');
  if (typeof repository !== 'string' || !repository) throw new Error('a repository identity is required');
  if (!Array.isArray(roots) || !roots.some(Boolean)) throw new Error('the checkout roots are required');
  const home = fs.realpathSync(require('node:os').homedir());
  const selector = repo === null ? null : repo.trim().toLowerCase();
  const directory = path.join(publicationsRoot(), publicationHash(JSON.stringify([repository, selector])));
  for (const root of roots.filter(Boolean)) {
    const relative = path.relative(fs.realpathSync(root), directory);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
      throw new Error('publication state cannot be inside a source or planning checkout');
  }
  return { home, selector, directory };
}

// @invariant: the writer and the reader judge every namespace segment by this one predicate.
function walkNamespace({ home, directory }, beforeSegment = () => {}) {
  let current = home;
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid()) throw new Error('unsafe publication home');
  for (const part of path.relative(home, directory).split(path.sep)) {
    current = path.join(current, part);
    beforeSegment(current);
    const stat = fs.lstatSync(current);
    const privateDirectory = current === directory || part === 'code-review-publications';
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & (privateDirectory ? 0o777 : 0o022)) !== (privateDirectory ? 0o700 : 0))
      throw new Error('unsafe publication namespace');
  }
}

function publicationNamespace(ctx) {
  const location = publicationLocation({ repository: ctx.repository, repo: ctx.repo, pr: ctx.pr,
    roots: [ctx.worktree, ctx.mode.project_root] });
  const identity = { schema: 'shipyard.code-review-publication.v1', repository: ctx.repository,
    selector: location.selector, pr: ctx.pr };
  const validate = () => walkNamespace(location, current => {
    assertPublicationConfig(ctx.mode);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  });
  validate();
  return { directory: location.directory, file: path.join(location.directory, `${ctx.pr}.json`), identity, validate };
}

// @security: private state files are read only here: own uid, mode 0600, bounded, no symlink.
function readPrivateRecord(file, bound, label, validate) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > bound)
    throw new Error(`unsafe ${label} record`);
  const same = value => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode']
    .every(key => value[key] === stat[key]);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let record;
  try {
    if (!same(fs.fstatSync(fd))) throw new Error(`${label} record changed`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error(`${label} record is unreadable`);
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) || !same(fs.fstatSync(fd))
        || !same(fs.lstatSync(file))) throw new Error(`${label} record changed`);
    record = JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
  return validate(record);
}

function readPublication(state) {
  return readPrivateRecord(state.file, PUBLICATION_BOUND, 'publication', record => {
    if (!object(record) || Object.keys(record).sort().join(',') !== 'body_hash,comment_id,pr,repository,schema,selector'
        || Object.entries(state.identity).some(([key, value]) => record[key] !== value)
        || !positiveId(record.comment_id) || typeof record.body_hash !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.body_hash))
      throw new Error('publication record identity or schema mismatch');
    return record;
  });
}

function persistPublication(ctx, state, record) {
  assertPublicationConfig(ctx.mode);
  state.validate();
  readPublication(state);
  const temporary = path.join(state.directory, `.${path.basename(state.file)}.tmp-${process.pid}`);
  assertPublicationConfig(ctx.mode);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  fs.closeSync(fd);
  try {
    const bytes = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(bytes) > PUBLICATION_BOUND) throw new Error('publication record exceeds bound');
    assertPublicationConfig(ctx.mode);
    writeAtomic(state.file, bytes);
    const persisted = fs.openSync(state.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(persisted); } finally { fs.closeSync(persisted); }
    const directory = fs.openSync(state.directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    state.validate();
    if (JSON.stringify(readPublication(state)) !== JSON.stringify(record))
      throw new Error('publication record persistence failed');
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

const EXTENSION_SCHEMA = 'shipyard.code-review-extension.v1';
const EXTENSION_LIMIT = 16;
const hex40 = /^[a-f0-9]{40}$/;
const plainText = (value, max) => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys;
const extensionRecord = value => exactKeys(value, 'base_commit,created_at,head,operator,reason')
  && hex40.test(value.head) && hex40.test(value.base_commit)
  && plainText(value.operator, 128) && plainText(value.reason, 200)
  && typeof value.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.created_at)
  && !Number.isNaN(Date.parse(value.created_at)) && new Date(value.created_at).toISOString() === value.created_at;

function extensionStore(location, input) {
  return { ...location, file: path.join(location.directory, `${input.pr}.extensions.json`),
    identity: { schema: EXTENSION_SCHEMA, repository: input.repository, selector: location.selector, pr: input.pr } };
}

function readExtensionFile(store) {
  return readPrivateRecord(store.file, PUBLICATION_BOUND, 'extension', file => {
    if (!exactKeys(file, 'pr,records,repository,schema,selector')
        || Object.entries(store.identity).some(([key, value]) => file[key] !== value)
        || !Array.isArray(file.records) || file.records.length > EXTENSION_LIMIT
        || !file.records.every(extensionRecord)
        || new Set(file.records.map(row => row.head + row.base_commit)).size !== file.records.length)
      throw new Error('extension record identity or schema mismatch');
    return file;
  });
}

// @security: this read grants rounds, so it checks the namespace with lstat only and creates nothing.
// @contract: a corrupt store throws and never reads as empty; only an absent store is empty.
function readExtensions(input) {
  let store;
  try { store = extensionStore(publicationLocation(input), input); walkNamespace(store); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return readExtensionFile(store)?.records ?? [];
}

function appendExtension(ctx, record) {
  if (!extensionRecord(record)) throw new Error('extension record is invalid');
  if (!object(ctx?.mode)) throw new Error('the code review mode is required');
  const state = publicationNamespace(ctx);
  const store = extensionStore({ directory: state.directory, selector: state.identity.selector }, ctx);
  return withLock(state.directory, `extend-${ctx.pr}`, () => {
    state.validate();
    const records = readExtensionFile(store)?.records ?? [];
    const existing = records.find(row => row.head === record.head && row.base_commit === record.base_commit);
    if (existing) return existing;
    if (records.length >= EXTENSION_LIMIT) throw new Error('extension record limit reached');
    const next = { ...store.identity, records: [...records, record] };
    const bytes = JSON.stringify(next) + '\n';
    if (Buffer.byteLength(bytes) > PUBLICATION_BOUND) throw new Error('extension record exceeds bound');
    const temporary = path.join(state.directory, `.${path.basename(store.file)}.tmp-${process.pid}`);
    assertPublicationConfig(ctx.mode);
    fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
    try {
      assertPublicationConfig(ctx.mode);
      writeAtomic(store.file, bytes);
      for (const target of [store.file, state.directory]) {
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      state.validate();
      if (JSON.stringify(readExtensionFile(store)) !== JSON.stringify(next))
        throw new Error('extension record persistence failed');
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return record;
  }, { label: 'code review extension', waitMs: 10000 });
}

const EXTEND_CONFIRM = 'extend-review-round';
const EXTEND_USAGE = `phase-code-review.cjs extend --phase N --pr P --reason "..." --confirm ${EXTEND_CONFIRM} [--repo owner/name] [--graph dir] [--worktree path]`;
const refuseExtension = message => { throw Object.assign(new Error(message), { code: 'EXTENSION_REFUSED' }); };
const cleanText = value => String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/[@<>`]/g, '').replace(/\s+/g, ' ').trim();

function extend(input, options = {}) {
  // @security: only the operator grants a round; a role-hosted child is refused before any other step.
  if (process.env.SHIPYARD_ROLE_CHILD === '1') refuseExtension('a role-hosted child cannot grant a review round; only the operator runs extend');
  if (input.confirm !== EXTEND_CONFIRM || typeof input.reason !== 'string')
    throw Object.assign(new Error(EXTEND_USAGE), { code: 'USAGE', exitCode: 2 });
  const worktree = input.worktree || input.worktreePath || process.cwd();
  let named = '';
  try { named = git(worktree, ['config', 'user.name']); } catch {}
  const operator = cleanText(named) || cleanText(require('node:os').userInfo().username), reason = cleanText(input.reason);
  if (!reason) refuseExtension('the reason is empty after cleaning; state why one more round is needed');
  if (Buffer.byteLength(reason) > 200) refuseExtension('the reason is over 200 bytes');
  if (!operator || Buffer.byteLength(operator) > 128) refuseExtension('the operator name from git user.name is empty or over 128 bytes; set a shorter git user.name and run extend again');
  const created_at = new Date().toISOString(), hygiene = require('./pr-hygiene.cjs');
  if (hygiene.applies({ root: worktree })) {
    const line = `round ${core.ROUND_CAP + 1} of ${core.ROUND_CAP}, extended by ${operator} at ${created_at}: ${reason}`;
    const rules = [...new Set(['comment', 'status'].flatMap(field => hygiene.internalLeakViolations(field, line)).map(found => found.rule))];
    if (rules.length) refuseExtension(`the reason or the git user.name would be refused in public text (${rules.join(', ')}); rephrase the reason or set a different git user.name`);
  }
  const current = status(input, options), { ctx, history } = details.get(current);
  const records = readExtensions({ repository: ctx.repository, repo: ctx.repo, pr: ctx.pr, roots: [ctx.worktree, ctx.mode.project_root] });
  const report = (record, recorded, round, limit) => ({ pr: ctx.pr, head: record.head, base_commit: record.base_commit, round, limit,
    operator: record.operator, created_at: record.created_at, recorded });
  const existing = records.find(row => row.head === current.head && row.base_commit === current.base_commit);
  if (existing) return report(existing, 'existing', current.round, current.round_limit);
  if (current.state === 'current') refuseExtension(current.verdict === 'pass' ? 'this head already has a passing counted review; no extension is needed'
    : 'this head already has a counted review that needs fixes; push the fixes first, then run extend for the new head');
  if (current.state === 'owed') refuseExtension('no review limit has been reached for this head; the review is owed, so no extension is needed');
  if (current.state !== 'limit') refuseExtension(`phase code review is ${current.state}: ${current.reason}`);
  if (current.round_limit >= core.ROUND_CEILING) refuseExtension(`the ceiling of ${core.ROUND_CEILING} rounds is reached; the human decides from the findings on the PR,`
    + ' or sets delivery_pipeline.code_review to "report", which applies to the whole project until it is set back to "hold"');
  const probe = { head: current.head, base_commit: current.base_commit, operator, created_at, reason };
  const lookup = core.roundLookup({ ...history, readRecords: () => [...records, probe] });
  if (lookup.state !== 'ready') refuseExtension(core.limitMessage(lookup));
  const stored = appendExtension(ctx, probe);
  return report(stored, stored === probe ? 'created' : 'existing', lookup.round, lookup.limit);
}

function publish(input, options = {}) {
  const worktree = input.worktree || input.worktreePath || process.cwd(), repo = input.repo ?? null;
  assertPublicationConfig(resolveCodeReviewMode({ graphDir: input.graphDir, worktree }));
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
  assertPublicationConfig(ctx.mode);
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
  const screen = require('./pr-hygiene.cjs');
  let summary = statusDescription(current);
  if (current.extension && screen.applies({ root: ctx.worktree }) && screen.internalLeakViolations('status', summary.description).length)
    summary = statusDescription({ ...current, extension: null });
  const api = ctx.repo ? `repos/${ctx.repo}` : 'repos/{owner}/{repo}';
  const result = { schema: 'shipyard.phase-code-review-publish.v1',
    status: { ok: false, action: 'failed', head: current.head, ...summary }, comment: { ok: false }, rules: [] };
  assertPublicationConfig(ctx.mode);
  try {
    request(['api', `${api}/statuses/${current.head}`, '-f', `state=${summary.state}`,
      '-f', 'context=code-review', '-f', `description=${summary.description}`]);
    result.status.ok = true; result.status.action = 'posted';
  } catch (error) {
    if (error.code === 'CONFIG_INVALID') throw error;
    result.status.reason = error.message;
  }
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
    const state = publicationNamespace(ctx);
    assertPublicationConfig(ctx.mode);
    withLock(state.directory, `pr-${ctx.pr}`, () => {
      state.validate();
      const binding = readPublication(state);
      const pages = request(['api', `${api}/issues/${ctx.pr}/comments`, '--paginate', '--slurp']);
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page)
          || page.some(comment => !object(comment) || !positiveId(comment.id) || typeof comment.body !== 'string')))
        throw new Error('comment lookup is unavailable');
      const comments = pages.flat();
      if (new Set(comments.map(comment => comment.id)).size !== comments.length)
        throw new Error('comment lookup contains duplicate identities');
      const candidate = binding && comments.find(comment => comment.id === binding.comment_id);
      const existing = candidate && publicationHash(candidate.body) === binding.body_hash ? candidate : null;
      const latest = readPR(ctx.pr);
      if (['number', 'state', 'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid']
        .some(key => latest[key] !== ctx.live[key]) || git(ctx.worktree, ['rev-parse', 'HEAD']) !== current.head)
        throw new Error('live phase PR identity changed before comment publication');
      state.validate();
      assertPublicationConfig(ctx.mode);
      const posted = request(['api', existing ? `${api}/issues/comments/${existing.id}` : `${api}/issues/${ctx.pr}/comments`,
        '--method', existing ? 'PATCH' : 'POST', '-f', `body=${body}`]);
      if (!object(posted) || !positiveId(posted.id) || posted.body !== body
          || (existing && posted.id !== existing.id)) throw new Error('comment publication response is invalid');
      persistPublication(ctx, state, { ...state.identity, comment_id: posted.id, body_hash: publicationHash(body) });
      result.comment = { ok: true, action: existing ? 'edited' : 'created', id: posted.id };
    }, { label: 'code review publication', waitMs: 10000 });
  } catch (error) {
    if (error.code === 'CONFIG_INVALID') throw error;
    result.comment = { ok: false, action: 'failed', reason: error.message };
  }
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

module.exports = { publish, extend, publicationsRoot, readExtensions, appendExtension, statusDescription, status, evaluateGate, fixTickets, matchEpicPullRequest, refusalText: refusal, resolveCodeReviewMode, verifyCodeReview };

if (require.main === module) {
  try {
    const argv = process.argv.slice(2), verb = argv[0];
    const usage = message => { throw Object.assign(new Error(message), { code: 'USAGE', exitCode: 2 }); };
    const extending = verb === 'extend';
    if (!['status', 'gate', 'fix-tickets', 'publish', 'extend'].includes(verb) || (!extending && (!argv[1] || argv[1].startsWith('--'))))
      usage('phase-code-review.cjs <status|gate|fix-tickets|publish> <phase-directory> --phase N --pr P [--repo owner/name] [--graph dir] [--worktree path]');
    const input = extending ? {} : { phaseDirectory: argv[1] }, seen = new Set();
    const names = { '--phase': 'phase', '--pr': 'pr', '--repo': 'repo', '--graph': 'graphDir', '--worktree': 'worktree',
      ...(extending ? { '--reason': 'reason', '--confirm': 'confirm' } : {}) };
    for (let i = extending ? 1 : 2; i < argv.length; i += 2) {
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
    } else if (extending) console.log(JSON.stringify(extend(input)));
    else console.log(JSON.stringify(verb === 'status' ? status(input) : fixTickets(input)));
  } catch (error) {
    process.stderr.write(`${error.code ? error.code + ': ' : ''}${error.message}\n`);
    const hint = hintForError(error); if (hint) process.stderr.write(`${hint}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
