'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const REPOSITORY_CLASS = '[^;\\x00-\\x1f\\x7f]+';
const REPOSITORY_VALUE = new RegExp(`^${REPOSITORY_CLASS}$`);
const PHASE_SUBJECT = new RegExp('^phase=(\\d+-[A-Za-z0-9._-]+);repository=(' + REPOSITORY_CLASS + ');tickets=([a-f0-9]{64});pr=([1-9]\\d*);head=([a-f0-9]{40});base=([a-f0-9]{40})$');
const GIT_SCOPE_KEYS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']);
const PHASE_SUBJECT_ROLES = Object.freeze(['arch-review', 'code-review']);
const PHASE_ONLY_ROLES = Object.freeze(['code-review']);
const gitEnvironment = () => {
  const env = { ...process.env };
  for (const key of GIT_SCOPE_KEYS) delete env[key];
  return env;
};
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

function repositoryInvalid(message, reason = 'value') {
  const error = new Error(`repository identity: ${message}`);
  error.code = 'REPOSITORY_IDENTITY_INVALID';
  error.reason = reason;
  return error;
}

function repositoryIdentity(cwd, { execFileSync: run = execFileSync } = {}) {
  let common;
  try { common = String(run('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', env: gitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] })).replace(/\r?\n$/, ''); }
  catch { throw repositoryInvalid('git common directory cannot be resolved', 'git'); }
  if (!common) throw repositoryInvalid('git common directory is empty', 'git');
  let real;
  try { real = fs.realpathSync(path.resolve(cwd, common)); }
  catch { throw repositoryInvalid('git common directory cannot be resolved', 'git'); }
  if (!REPOSITORY_VALUE.test(real)) throw repositoryInvalid('path contains ";" or a control character');
  return real;
}

function gitLine(cwd, args) {
  return String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] })).trim();
}

// @contract: pre-upgrade seals carry owner/repo for a github.com origin, otherwise the project root path
function legacyRepositoryForms(cwd) {
  try {
    const github = gitLine(cwd, ['config', '--get', 'remote.origin.url']).match(/(?:github\.com[:/])([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
    if (github) return [github[1].toLowerCase()];
  } catch {}
  const forms = [];
  const add = (resolve) => {
    try {
      const value = fs.realpathSync(resolve());
      if (REPOSITORY_VALUE.test(value) && !forms.includes(value)) forms.push(value);
    } catch { return; }
  };
  add(() => gitLine(cwd, ['rev-parse', '--show-toplevel']));
  add(() => path.dirname(gitLine(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
  return forms;
}

function acceptedRepositoryValues(cwd) {
  return [repositoryIdentity(cwd), ...legacyRepositoryForms(cwd)];
}

const R = REPOSITORY_CLASS;
const FAMILIES = Object.freeze({
  'planning-input': { keys: ['phase', 'input', 'repository'],
    pattern: new RegExp(`^phase=(\\d+);input=((?:INV|ADR)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*);repository=(${R})$`) },
  'decomposition-seal': { keys: ['phase', 'repository', 'adr'],
    pattern: new RegExp(`^phase=(\\d+);repository=(${R});adr=([a-f0-9]{64})$`) },
  integrator: { keys: ['phase', 'repository', 'tickets'],
    pattern: new RegExp(`^phase=(\\d+-[A-Za-z0-9][A-Za-z0-9._-]*);repository=(${R});tickets=([a-f0-9]{64})$`) },
  'architecture-review': { keys: ['phase', 'repository', 'tickets', 'pr', 'head', 'base'], pattern: PHASE_SUBJECT },
});

function family(name) {
  const entry = FAMILIES[name];
  if (!entry) throw new Error(`unknown subject family: ${name}`);
  return entry;
}

function buildSubject(name, fields = {}) {
  const { keys, pattern } = family(name);
  if (!REPOSITORY_VALUE.test(String(fields.repository ?? ''))) throw repositoryInvalid('repository contains ";", a control character or is empty');
  const subject = keys.map(key => `${key}=${fields[key]}`).join(';');
  if (!pattern.test(subject)) throw new Error(`invalid ${name} subject`);
  return subject;
}

function parseSubject(name, text) {
  const { keys, pattern } = family(name);
  const match = pattern.exec(typeof text === 'string' ? text : '');
  return match ? Object.freeze(Object.fromEntries(keys.map((key, index) => [key, match[index + 1]]))) : null;
}

module.exports = { GIT_SCOPE_KEYS, repositoryIdentity, legacyRepositoryForms, acceptedRepositoryValues, buildSubject, parseSubject,
  REPOSITORY_CLASS, resolveIntegrationBranch, architectureTarget, phaseBinding, phaseRows, PHASE_SUBJECT,
  PHASE_SUBJECT_ROLES, PHASE_ONLY_ROLES };
