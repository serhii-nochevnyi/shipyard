#!/usr/bin/env node
'use strict';

// @contract: only normalized repository declarations authorize a workflow dispatch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { computeSignature } = require('./failure-signature.cjs');
const { loadConfig, repoValue } = require('./pipeline-config.cjs');
const { runBounded, diagnostic } = require('./command-runner.cjs');
const { withLock, lockDirFor } = require('./lock.cjs');
const coverage = require('./conveyor-coverage.cjs');
const { normalizeOrigin } = require('./repo-resolve.cjs');

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024;
const RUN_WINDOW_MS = 10 * 60 * 1000;
const scripts = __dirname;

function fail(message) { throw new Error(message); }
function command(file, args, options = {}) {
  const result = runBounded(file, args, { timeoutMs: TIMEOUT_MS, maxBuffer: MAX_BUFFER, ...options });
  if (result.status !== 0 || result.error) fail(`${file} failed: ${diagnostic(result)}`);
  return result.stdout.trim();
}
function ghJson(args) {
  const value = command('gh', args);
  try { return JSON.parse(value); } catch { return fail('gh returned invalid JSON'); }
}
function inputDigest(inputs = {}) {
  const pairs = Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}
function graphDir(flags = {}) {
  return path.resolve(flags.graph || process.env.SHIPYARD_GRAPH_DIR || path.join(process.cwd(), '.planning', 'graph'));
}
function project(graph) { return path.resolve(graph, '..', '..'); }
function projectRepository(graph) {
  const result = runBounded('git', ['-C', project(graph), 'remote', 'get-url', 'origin'],
    { timeoutMs: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  return result.status === 0 && !result.error ? normalizeOrigin(result.stdout) : null;
}
function graphData(graph) {
  const file = path.join(graph, 'tickets.json');
  if (!fs.existsSync(file)) fail(`no ticket graph at ${graph}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).tickets || {};
}
function declarationConfig(graph, repo) {
  if (!REPO.test(repo || '')) fail('invalid repository slug');
  const loaded = loadConfig(project(graph));
  if (!loaded.valid) fail(`invalid pipeline config: ${loaded.error && loaded.error.message}`);
  return loaded;
}
function declarations(graph, repo) {
  return repoValue(declarationConfig(graph, repo), 'repo_remedies', repo) || [];
}
function signatureFromFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) fail('signature file is empty');
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.signature === 'string' && parsed.signature) return parsed.signature;
  } catch {}
  if (/^(?:unknown-)?[0-9a-f]{16}$/.test(trimmed)) return trimmed;
  return computeSignature(raw).signature;
}
function signatureEvidenceFromFile(file) {
  if (!file) fail('run needs --signature-file with signature and head evidence');
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail('signature evidence must be JSON with signature and head'); }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || !/^(?:unknown-)?[0-9a-f]{16}$/.test(evidence.signature || '')
      || !OID.test(evidence.head || '')) {
    fail('signature evidence must contain a normalized signature and failure head');
  }
  return evidence;
}
function match({ repo, signatureFile, signature, graph = graphDir() }) {
  if (!signature && !signatureFile) fail('match needs a signature file');
  const current = signature || signatureFromFile(signatureFile);
  const entries = declarations(graph, repo);
  const index = entries.findIndex((entry) => entry.signature === current);
  return { match: index < 0 ? null : { entry_index: index, ...entries[index] }, candidates: [] };
}
function ticketState(graph, ticket, repo, pr) {
  const entry = graphData(graph)[ticket];
  const stateFile = path.join(graph, 'delivery-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const live = (state.tickets || state)[ticket];
  if (!entry || !live || (entry.repo || projectRepository(graph)) !== repo
      || (live.repo && live.repo !== repo) || (entry.pr && Number(entry.pr) !== Number(pr))
      || Number(live.pr) !== Number(pr)
      || !Number.isSafeInteger(Number(pr)) || Number(pr) < 1) {
    fail('ticket, repository and PR do not match the graph');
  }
  const branch = entry.branch || live.branch;
  if (!branch || (live.branch && live.branch !== branch)) fail('ticket branch mismatch');
  return branch;
}
function history(graph, ticket) {
  return JSON.parse(command(process.execPath,
    [path.join(scripts, 'attempt-history.cjs'), ticket, '--json', '--graph', graph]));
}
function prView(repo, pr) {
  const data = ghJson(['pr', 'view', String(pr), '--repo', repo,
    '--json', 'number,headRefName,headRefOid,headRepository']);
  if (Number(data.number) !== Number(pr)
      || !data.headRepository || data.headRepository.nameWithOwner !== repo
      || !OID.test(data.headRefOid || '')) fail('GitHub PR identity or head is invalid');
  return data;
}
function journal(graph) {
  const file = path.join(graph, 'delivery-log.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function run({ ticket, repo, pr, index, signatureFile, graph = graphDir() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(ticket || '')) fail('invalid ticket');
  const branch = ticketState(graph, ticket, repo, pr);
  return withLock(lockDirFor(project(graph)), 'repo-remedy', () => {
    const loaded = declarationConfig(graph, repo);
    const entries = repoValue(loaded, 'repo_remedies', repo) || [];
    if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length) fail('absent or invalid remedy entry');
    const entry = entries[index];
    if (!entry || !entry.signature || !entry.workflow || !entry.bot) fail('malformed remedy entry');
    const evidence = signatureEvidenceFromFile(signatureFile);
    if (evidence.signature !== entry.signature) fail('current failure signature does not match remedy entry');
    const budget = loaded.config.max_attempts;
    if (history(graph, ticket).attempts >= budget) fail(`remedy attempt budget exhausted (${budget})`);
    const view = prView(repo, pr);
    if (view.headRefName !== branch) fail('GitHub PR branch mismatch');
    if (evidence.head !== view.headRefOid) fail('signature evidence is stale for the current PR head');
    const head = view.headRefOid;
    const ref = entry.ref || branch;
    const args = ['workflow', 'run', entry.workflow, '--repo', repo, '--ref', ref];
    for (const [key, value] of Object.entries(entry.inputs || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      args.push('-f', `${key}=${value}`);
    }
    // @security: retain dispatch time before the API call so GitHub's run cannot predate its journal link.
    const ts = new Date().toISOString();
    command('gh', args);
    const fields = { ticket, pr: Number(pr), repo, entry_index: index, signature: entry.signature,
      workflow: entry.workflow, ref, bot: entry.bot, inputs_digest: inputDigest(entry.inputs), head };
    fs.appendFileSync(path.join(graph, 'delivery-log.jsonl'), JSON.stringify({ ts,
      event: 'remedy_dispatch', ...fields }) + '\n');
    return { dispatched: true, ...fields };
  });
}
function sameRun(runData, dispatch, repo) {
  const created = Date.parse(runData.created_at || '');
  const dispatched = Date.parse(dispatch.ts || '');
  return String(runData.id) !== '' && runData.repository && runData.repository.full_name === repo
    && runData.path === `.github/workflows/${dispatch.workflow}`
    && runData.event === 'workflow_dispatch' && runData.head_branch === dispatch.ref
    && runData.head_sha === dispatch.head
    && Number.isFinite(created) && Number.isFinite(dispatched)
    && created >= dispatched && created - dispatched <= RUN_WINDOW_MS;
}
function attribute({ ticket, repo, runId, graph = graphDir(), worktree = process.cwd() }) {
  const unattributed = (reason) => ({ result: 'unattributed', reason });
  if (!/^\d+$/.test(String(runId || ''))) return unattributed('invalid run id');
  try {
    const dispatches = journal(graph).filter((event) => event.event === 'remedy_dispatch'
      && event.ticket === ticket && event.repo === repo);
    if (!dispatches.length) return unattributed('no successful dispatch');
    const runData = ghJson(['api', `repos/${repo}/actions/runs/${runId}`]);
    if (String(runData.id) !== String(runId) || runData.status !== 'completed'
        || runData.conclusion !== 'success') return unattributed('run id or conclusion mismatch');
    const matches = dispatches.filter((event) => sameRun(runData, event, repo));
    if (matches.length !== 1) return unattributed('missing, stale or ambiguous dispatch');
    const dispatch = matches[0];
    const entries = declarations(graph, repo);
    const entry = entries[Number(dispatch.entry_index)];
    const branch = ticketState(graph, ticket, repo, dispatch.pr);
    if (!entry || entry.signature !== dispatch.signature || entry.workflow !== dispatch.workflow
        || (entry.ref || branch) !== dispatch.ref || entry.bot !== dispatch.bot
        || inputDigest(entry.inputs) !== dispatch.inputs_digest) {
      return unattributed('remedy declaration changed');
    }
    const listed = ghJson(['api', `repos/${repo}/actions/runs?event=workflow_dispatch&branch=${encodeURIComponent(dispatch.ref)}&per_page=100`]);
    const matchingRuns = Array.isArray(listed.workflow_runs)
      ? listed.workflow_runs.filter((item) => sameRun(item, dispatch, repo)) : [];
    if (!Array.isArray(listed.workflow_runs) || !Number.isSafeInteger(listed.total_count)
        || listed.total_count > 100
        || matchingRuns.length !== 1 || String(matchingRuns[0].id) !== String(runId)) {
      return unattributed('ambiguous workflow runs');
    }
    const view = prView(repo, dispatch.pr);
    if (view.headRefName !== branch || view.headRefOid === dispatch.head) return unattributed('branch head did not advance');
    const commit = ghJson(['api', `repos/${repo}/commits/${view.headRefOid}`]);
    if (commit.sha !== view.headRefOid || !commit.author || commit.author.login !== dispatch.bot
        || !Array.isArray(commit.parents) || commit.parents.length !== 1
        || commit.parents[0].sha !== dispatch.head) return unattributed('commit parent or bot mismatch');
    const meta = command('git', ['-C', worktree, 'show', '-s', '--format=%P%n%T', view.headRefOid]).split('\n');
    if (meta[0] !== dispatch.head || !OID.test(meta[1] || '')) return unattributed('local commit metadata mismatch');
    const record = coverage.createCoverageWriter().record({ kind: 'remedy', ticket, repo,
      commit: view.headRefOid, parents: [dispatch.head], tree: meta[1], worktree,
      remedy: { workflow: entry.workflow, run_id: String(runId), dispatch_head: dispatch.head } });
    return { result: 'attributed', record };
  } catch (error) { return unattributed(error.message); }
}
function parse(args) {
  const [action, ...tail] = args;
  const flags = {};
  const positional = [];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    if (arg === '--json') { flags.json = true; continue; }
    if (['--repo', '--pr', '--entry', '--signature-file', '--run', '--graph', '--worktree'].includes(arg)) {
      const value = tail[++i];
      if (!value || value.startsWith('--')) fail(`${arg} needs a value`);
      flags[arg.slice(2).replaceAll('-', '_')] = value;
    } else if (arg.startsWith('--')) fail(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  return { action, positional, flags };
}
if (require.main === module) {
  try {
    const { action, positional, flags } = parse(process.argv.slice(2));
    const graph = graphDir(flags);
    let result;
    if (action === 'match' && positional.length === 0 && flags.repo && flags.signature_file) {
      result = match({ repo: flags.repo, signatureFile: flags.signature_file, graph });
    } else if (action === 'run' && positional.length === 1 && flags.repo && flags.pr && flags.entry !== undefined) {
      if (!/^(?:0|[1-9]\d*)$/.test(flags.entry)) fail('invalid remedy entry index');
      result = run({ ticket: positional[0], repo: flags.repo, pr: flags.pr, index: Number(flags.entry),
        signatureFile: flags.signature_file, graph });
    } else if (action === 'attribute' && positional.length === 1 && flags.repo && flags.run) {
      result = attribute({ ticket: positional[0], repo: flags.repo, runId: flags.run, graph,
        worktree: flags.worktree || process.cwd() });
    } else fail('usage: repo-remedy.cjs match --repo <slug> --signature-file <file> | run <ticket> --repo <slug> --pr <n> --entry <index> --signature-file <evidence.json> | attribute <ticket> --repo <slug> --run <id>');
    console.log(flags.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    if (result.result === 'unattributed') process.exitCode = 1;
  } catch (error) {
    console.error(`repo-remedy: ${error.message}`);
    process.exitCode = 1;
  }
}
module.exports = { match, run, attribute, inputDigest, signatureFromFile, graphDir, projectRepository };
