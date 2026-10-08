'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PHASE_SUBJECT = /^phase=(\d+-[A-Za-z0-9._-]+);repository=([^;\s]+);tickets=([a-f0-9]{64});pr=([1-9]\d*);head=([a-f0-9]{40});base=([a-f0-9]{40})$/;
const normalizeBranch = value => typeof value === 'string' ? value.trim().replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/, '') : null;

function resolveIntegrationBranch({ projectRoot = process.cwd(), repo = null, config, defaultBranch, exec = execFileSync } = {}) {
  if (!config) {
    try { config = JSON.parse(fs.readFileSync(path.join(projectRoot, '.planning/config.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; config = {}; }
  }
  const configured = !repo && (config.gsd?.base_branch || config.git?.base_branch);
  const value = configured || defaultBranch || exec('gh', ['repo', 'view', ...(repo ? [repo] : []), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    { cwd: projectRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 4096 });
  const branch = normalizeBranch(typeof value === 'string' ? value : null);
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..'))
    throw new Error('repository integration branch is unavailable');
  return branch;
}

function architectureTarget({ base, integrationBranch, epic, ticketBranches = [] } = {}) {
  const target = normalizeBranch(base), integration = normalizeBranch(integrationBranch);
  const required = !target || (integration ? target === integration
    : ![epic, ...ticketBranches].filter(Boolean).map(normalizeBranch).includes(target));
  return Object.freeze({ required, status: required ? 'required' : 'skipped-by-target', target,
    integration_branch: integration });
}

function phaseRows(graph, phase, repo = null) {
  if (repo !== null && (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)))
    throw new Error('invalid phase repository selector');
  const rows = Object.entries(graph.tickets || {}).filter(([, row]) =>
    Number(String(row.phase).match(/^0*(\d+)/)?.[1]) === Number(phase) && (row.repo ?? null) === repo).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) throw new Error('phase absent from canonical graph');
  return rows;
}

function phaseBinding({ graph, state, phase, repository, repo = null, pr, head, base, branch }) {
  const rows = phaseRows(graph, phase, repo);
  const directories = new Set(rows.map(([, row]) => path.posix.basename(path.posix.dirname(row.plan || ''))));
  const epics = new Set(rows.map(([, row]) => row.epic).filter(Boolean));
  const repos = new Set(rows.map(([, row]) => row.repo || null));
  if (directories.size !== 1 || epics.size !== 1 || repos.size !== 1 || !epics.has(branch))
    throw new Error('integration review must bind one canonical phase epic and repository');
  const phaseName = [...directories][0];
  if (!/^\d+-[A-Za-z0-9._-]+$/.test(phaseName) || !Number.isSafeInteger(pr) || pr < 1
      || !/^[a-f0-9]{40}$/.test(head || '') || !/^[a-f0-9]{40}$/.test(base || ''))
    throw new Error('incomplete phase PR identity');
  const ticketSet = rows.map(([id, row]) => ({ id, row, evidence: Object.fromEntries(
    ['status', 'pr', 'head_sha', 'merge_sha', 'pr_branch', 'branch', 'repo'].filter(key => state[id]?.[key] !== undefined)
      .map(key => [key, state[id][key]])) }));
  const membership = hash(ticketSet);
  const subject = `phase=${phaseName};repository=${repository};tickets=${membership};pr=${pr};head=${head};base=${base}`;
  if (!PHASE_SUBJECT.test(subject)) throw new Error('invalid aggregate architecture subject');
  return Object.freeze({ subject, phase: phaseName, membership, ticketSet,
    rows: rows.map(([id, row]) => ({ id, row })), repo: [...repos][0] });
}

function phaseEvidencePaths(project, binding) {
  const directory = path.posix.dirname(binding.rows[0].row.plan);
  const paths = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(project, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('phase evidence contains a symlink');
      const child = relative + '/' + entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) paths.push(child);
      if (paths.length > 2000) throw new Error('complete phase evidence exceeds its file-count bound');
    }
  }
  walk(directory);
  return paths;
}

module.exports = { resolveIntegrationBranch, architectureTarget, phaseBinding, phaseRows, phaseEvidencePaths, PHASE_SUBJECT };
