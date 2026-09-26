#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SCHEMA = 'shipyard.phase-integrator-preflight.v1';
const OUTPUT_MAX_BYTES = 256 * 1024;
const PROOF_MAX_BYTES = 64 * 1024;
const SHA_RE = /^[a-f0-9]{40}$/;
const TICKET_RE = /^T-(\d+)-(\d+)$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function refuse(message, code = 'PREFLIGHT_REFUSED') {
  const error = new Error(`phase-integrator-preflight: ${message}`);
  error.code = code;
  throw error;
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!object(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function safeBranch(value, label) {
  if (typeof value !== 'string' || !BRANCH_RE.test(value) || value.includes('..') || value.startsWith('-')) {
    refuse(`${label} is not a safe branch name`);
  }
  return value;
}

function run(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', maxBuffer: OUTPUT_MAX_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).trim();
}

function git(options, cwd, args) {
  if (typeof options.git === 'function') return options.git(cwd, args);
  return run('git', args, cwd);
}

function ghJson(options, cwd, args) {
  const text = typeof options.gh === 'function' ? options.gh(cwd, args) : run('gh', args, cwd);
  try { return JSON.parse(text); } catch { refuse('GitHub returned invalid JSON'); }
}

function listMergedPullRequests(options, cwd, branch, repo) {
  if (typeof options.listPullRequests === 'function') return options.listPullRequests({ worktree: cwd, branch, repo });
  return ghJson(options, cwd, [...(repo ? ['--repo', repo] : []), 'pr', 'list', '--head', branch, '--state', 'all',
    '--limit', '100', '--json', 'number,state,headRefName,baseRefName,mergedAt']);
}

function viewPullRequest(options, cwd, pr, repo) {
  if (typeof options.getPullRequest === 'function') return options.getPullRequest({ worktree: cwd, pr, repo });
  return ghJson(options, cwd, [...(repo ? ['--repo', repo] : []), 'pr', 'view', String(pr), '--json',
    'number,state,title,body,headRefName,headRefOid,baseRefName,mergedAt,mergeCommit']);
}

function readJson(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { refuse(`${label} is unreadable: ${file}`); }
  try { return { value: JSON.parse(text), text }; } catch { refuse(`${label} is not valid JSON`); }
}

function phaseRows(graph, phase) {
  if (!object(graph) || !object(graph.tickets)) refuse('canonical graph has no tickets map');
  const rows = Object.entries(graph.tickets).filter(([, row]) => object(row) && String(row.phase) === phase)
    .map(([id, row]) => ({ id, row })).sort((a, b) => a.id.localeCompare(b.id));
  if (!rows.length) refuse(`phase ${phase} is absent from the canonical graph`);
  for (const { id, row } of rows) {
    const match = TICKET_RE.exec(id);
    if (!match || String(Number(match[1])) !== phase) refuse(`${id} is not a phase-${phase} ticket id`);
    if (typeof row.plan !== 'string' || !row.plan) refuse(`${id} has no plan path`);
    safeBranch(row.branch, `${id} branch`);
  }
  const dirs = new Set(rows.map(({ row }) => path.dirname(row.plan)));
  if (dirs.size !== 1) refuse('phase tickets resolve to multiple plan directories');
  const epics = new Set(rows.map(({ row }) => row.epic));
  if (epics.size !== 1) refuse('phase tickets span multiple epic branches');
  const epic = safeBranch([...epics][0], 'epic branch');
  return { rows, planDir: [...dirs][0], epic };
}

function assertCompletePlanSet(worktree, planDir, rows) {
  let names;
  try { names = fs.readdirSync(path.join(worktree, planDir)); } catch { refuse(`plan directory ${planDir} is unreadable`); }
  const plans = names.filter((name) => /^\d+-\d+-PLAN\.md$/.test(name)).map((name) => path.join(planDir, name)).sort();
  const mapped = rows.map(({ row }) => path.normalize(row.plan)).sort();
  if (canonicalJson(plans) !== canonicalJson(mapped)) {
    refuse(`graph ticket set does not match the phase plan set (plans=${plans.length}, tickets=${mapped.length}); re-run decompose`);
  }
}

function pinEpic(options, worktree, epic) {
  git(options, worktree, ['fetch', '--quiet', 'origin', `+refs/heads/${epic}:refs/remotes/origin/${epic}`]);
  const commit = git(options, worktree, ['rev-parse', '--verify', `refs/remotes/origin/${epic}^{commit}`]);
  const tree = git(options, worktree, ['rev-parse', '--verify', `${commit}^{tree}`]);
  if (!SHA_RE.test(commit) || !SHA_RE.test(tree)) refuse('pinned epic identity is not a full object id');
  return { commit, tree };
}

function markerMatches(id, live) {
  const match = TICKET_RE.exec(id);
  const text = `${live.title || ''}\n${live.body || ''}`;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}($|[^A-Za-z0-9-])`, 'i').test(text)
    || new RegExp(`(^|[^0-9])${match[1]}-${match[2]}($|[^0-9])`).test(text);
}

function proveTicket(options, worktree, epic, pinned, id, row, stateRow) {
  if (stateRow && stateRow.branch !== undefined && stateRow.branch !== row.branch) {
    refuse(`${id} delivery state maps a stale branch; re-run state-sync`);
  }
  const movedHead = Boolean(stateRow && stateRow.pr_branch !== undefined && stateRow.pr_branch !== row.branch);
  if (movedHead && (stateRow.status !== 'merged' || !Number.isSafeInteger(stateRow.pr) || stateRow.matched_by !== 'marker')) {
    refuse(`${id} has no authenticated merged-PR branch mapping; re-run state-sync`);
  }
  const branch = movedHead ? safeBranch(stateRow.pr_branch, `${id} PR branch`) : row.branch;
  const repo = row.repo || null;
  const list = listMergedPullRequests(options, worktree, branch, repo);
  if (!Array.isArray(list)) refuse(`GitHub returned an invalid PR list for ${id}`);
  const forBranch = list.filter((pr) => object(pr) && pr.headRefName === branch
    && (!stateRow || !Number.isSafeInteger(stateRow.pr) || pr.number === stateRow.pr));
  const merged = forBranch.filter((pr) => pr.mergedAt);
  if (!merged.length) {
    const open = forBranch.some((pr) => pr.state === 'OPEN');
    refuse(`${id} has no merged PR${open ? ' (PR still open)' : ''}; merge it into ${epic} before integration`);
  }
  if (merged.length !== 1) refuse(`${id} has ${merged.length} merged PRs; exactly one is required`);
  const live = viewPullRequest(options, worktree, merged[0].number, repo);
  const mergeCommit = object(live) && object(live.mergeCommit) ? live.mergeCommit.oid : null;
  if (!object(live) || live.number !== merged[0].number || live.state !== 'MERGED' || !live.mergedAt) {
    refuse(`${id} PR ${merged[0].number} is not live-merged`);
  }
  if (live.headRefName !== branch) refuse(`${id} PR ${live.number} head branch does not match the graph mapping`);
  if (live.baseRefName !== epic) refuse(`${id} PR ${live.number} targets ${live.baseRefName}, not ${epic}`);
  if (!SHA_RE.test(live.headRefOid || '')) refuse(`${id} PR ${live.number} has no head SHA`);
  if (!SHA_RE.test(mergeCommit || '')) refuse(`${id} PR ${live.number} has no merge commit SHA`);
  if (movedHead && !markerMatches(id, live)) refuse(`${id} PR ${live.number} does not identify the ticket`);
  try { git(options, worktree, ['merge-base', '--is-ancestor', mergeCommit, pinned.commit]); }
  catch { refuse(`${id} merge ${mergeCommit} is not an ancestor of pinned ${epic} ${pinned.commit}`); }
  return {
    entry: { id, pr: live.number, head: live.headRefOid, base: live.baseRefName, branch },
    merge: { id, pr: live.number, merge_commit: mergeCommit, merged_at: String(live.mergedAt), ancestor: true },
  };
}

function proofDigest(proof) {
  const { proof_digest: _ignored, ...body } = proof;
  return sha(canonicalJson(body));
}

function preflight(input, options = {}) {
  const phase = String(input.phase || '');
  if (!/^[1-9]\d{0,3}$/.test(phase)) refuse('--phase must be a phase number');
  if (!input.graphDir || !input.worktree) refuse('--graph-dir and --worktree are required');
  const worktree = path.resolve(input.worktree);
  const graphFile = path.join(input.graphDir, 'tickets.json');
  const graph = readJson(graphFile, 'canonical graph');
  const statePath = path.join(input.graphDir, 'delivery-state.json');
  const state = fs.existsSync(statePath) ? readJson(statePath, 'delivery state').value : {};
  const { rows, planDir, epic } = phaseRows(graph.value, phase);
  assertCompletePlanSet(worktree, planDir, rows);
  const pinned = pinEpic(options, worktree, epic);
  const head = git(options, worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== pinned.commit) refuse(`integrator worktree HEAD ${head} is not the pinned ${epic} head ${pinned.commit}`);
  const ticketSet = [];
  const merges = [];
  for (const { id, row } of rows) {
    const proved = proveTicket(options, worktree, epic, pinned, id, row, object(state) ? state[id] : undefined);
    ticketSet.push(proved.entry);
    merges.push(proved.merge);
  }
  const again = pinEpic(options, worktree, epic);
  if (again.commit !== pinned.commit || again.tree !== pinned.tree) refuse(`${epic} moved during preflight; re-run preflight`);
  const proof = {
    schema: SCHEMA,
    phase,
    plan_dir: planDir,
    graph: { path: 'tickets.json', digest: sha(graph.text), phase_rows_digest: sha(canonicalJson(rows)) },
    epic: { branch: epic, commit: pinned.commit, tree: pinned.tree },
    ticket_set: ticketSet,
    ticket_set_digest: sha(JSON.stringify(ticketSet)),
    merges,
  };
  proof.proof_digest = proofDigest(proof);
  if (Buffer.byteLength(JSON.stringify(proof)) > PROOF_MAX_BYTES) refuse('proof exceeds its bounded size');
  return proof;
}

function verifyProof(input, options = {}) {
  const proof = readJson(input.proofFile, 'proof').value;
  if (!object(proof) || proof.schema !== SCHEMA) refuse('proof schema is not recognised');
  if (proofDigest(proof) !== proof.proof_digest) refuse('proof digest does not match its body');
  if (sha(JSON.stringify(proof.ticket_set)) !== proof.ticket_set_digest) refuse('proof ticket-set digest is inconsistent');
  if (input.ticketSetFile) {
    const file = readJson(input.ticketSetFile, 'ticket-set file').value;
    if (sha(JSON.stringify(file)) !== proof.ticket_set_digest) refuse('runtime ticket-set file does not match the proof digest');
  }
  if (input.ticketSetDigest !== undefined && input.ticketSetDigest !== proof.ticket_set_digest) {
    refuse('integrator ticket-set digest does not match the proof');
  }
  const worktree = path.resolve(input.worktree);
  const head = git(options, worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const tree = git(options, worktree, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (head !== proof.epic.commit || tree !== proof.epic.tree) refuse('integrator worktree is not at the proof-pinned epic commit/tree');
  const live = pinEpic(options, worktree, proof.epic.branch);
  if (live.commit !== proof.epic.commit) refuse(`${proof.epic.branch} moved since the proof; re-run preflight`);
  return proof;
}

function parseArgs(argv) {
  const out = {};
  const names = { '--phase': 'phase', '--graph-dir': 'graphDir', '--worktree': 'worktree', '--proof-file': 'proofFile',
    '--ticket-set-file': 'ticketSetFile', '--ticket-set-digest': 'ticketSetDigest' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--verify') out.verify = true;
    else if (names[arg]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) refuse(`${arg} requires a value`, 'USAGE');
      out[names[arg]] = value;
      i += 1;
    } else refuse(`unknown argument ${arg}`, 'USAGE');
  }
  return out;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (!args.proofFile) refuse('--proof-file is required', 'USAGE');
    let proof;
    if (args.verify) proof = verifyProof(args);
    else {
      for (const file of [args.proofFile, args.ticketSetFile]) if (file && fs.existsSync(file)) fs.rmSync(file);
      proof = preflight(args);
      writeAtomic(args.proofFile, `${JSON.stringify(proof, null, 2)}\n`);
      if (args.ticketSetFile) writeAtomic(args.ticketSetFile, JSON.stringify(proof.ticket_set));
    }
    const summary = { ok: true, phase: proof.phase, epic: proof.epic, ticket_set_digest: proof.ticket_set_digest,
      proof_digest: proof.proof_digest, merges: proof.merges.map(({ id, pr, merge_commit: m }) => ({ id, pr, merge_commit: m })) };
    process.stdout.write(args.json ? `${JSON.stringify(summary)}\n`
      : `preflight ok: phase ${proof.phase} ${proof.merges.length} ticket(s) at ${proof.epic.branch}@${proof.epic.commit}\n`);
    return 0;
  } catch (error) {
    const message = String(error.message || error).slice(0, 2000);
    if (args && args.json) process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'ERROR', error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return error.code === 'USAGE' ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SCHEMA, preflight, verifyProof, proofDigest, main };
