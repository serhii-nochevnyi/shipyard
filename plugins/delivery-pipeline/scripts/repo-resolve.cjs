#!/usr/bin/env node
'use strict';

// Resolve the reachable repository branches of ADR-010 D1. An explicit
// pipeline.repos entry wins; when it is absent, discovery searches only the
// declared roots and matches git origin. The choice branch is deliberately
// separate from resolution: it can validate an operator's path and record a
// clone decision without cloning anything. A missing or ambiguous checkout is
// trackable-only until that explicit choice earns the right to do more. The
// separate `clone` command performs the later write after validating the exact
// destination and proving the requested base exists in origin's namespace.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');
const { loadConfig, validateRepositoryDestination } = require('./pipeline-config.cjs');
const { originRefName, resolveOriginRef } = require('./graph-dir.cjs');
const { withLock, lockDirFor } = require('./lock.cjs');

const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const OPERATOR_CHOICES = ['clone', 'existing', 'skip'];
// A clone is a potentially long-running write. The ordinary two-minute lock
// TTL is a safety net for short state writes, but expiring it during a clone
// would let a second resolver inspect and adopt a partial checkout. This
// transaction therefore keeps ownership until the process releases it; a
// crashed clone remains an explicit lock-recovery decision instead of a race.
const CLONE_LOCK_TTL_MS = Number.MAX_SAFE_INTEGER;

function invalidArgument(message) {
  const error = new TypeError(`repo-resolve: ${message}`);
  error.code = 'INVALID_ARGUMENT';
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateArgs(input) {
  if (!isRecord(input)) invalidArgument('arguments must be an object');
  if (typeof input.repo !== 'string' || !REPO_SLUG.test(input.repo)) {
    invalidArgument(`repo must be an owner/name slug, got ${JSON.stringify(input.repo)}`);
  }
  if (input.ticket !== undefined && input.ticket !== null && typeof input.ticket !== 'string') {
    invalidArgument('ticket must be a string when provided');
  }
  if (!isRecord(input.config)) invalidArgument('config must be the loaded pipeline config object');
}

function trackOnly(ticket, repo, reason, options = {}) {
  return {
    ticket: ticket ?? null,
    repo,
    resolution: options.resolution || 'track-only',
    executable: false,
    configured_path: null,
    repository_root: null,
    reason,
    discovery_status: options.discovery_status || 'not-run',
    candidates: options.candidates || [],
    searched_roots: options.searched_roots || [],
  };
}

function resolved(ticket, repo, configuredPath, repositoryRoot, options = {}) {
  return {
    ticket: ticket ?? null,
    repo,
    resolution: options.resolution || 'configured',
    executable: true,
    configured_path: configuredPath,
    repository_root: repositoryRoot,
    reason: null,
    discovery_status: options.discovery_status || 'not-run',
    candidates: options.candidates || [],
    searched_roots: options.searched_roots || [],
  };
}

function gitRepositoryRoot(candidate) {
  const result = spawnSync(
    'git',
    ['-C', candidate, 'rev-parse', '--show-toplevel'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value ? path.resolve(value) : null;
}

function gitRemoteOrigin(candidate) {
  const result = spawnSync(
    'git',
    ['-C', candidate, 'remote', 'get-url', 'origin'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value || null;
}

function originProtocol(value) {
  if (typeof value !== 'string') return null;
  const origin = value.trim();
  if (/^(?:git@[^/:]+:|ssh:\/\/)/i.test(origin)) return 'ssh';
  if (/^https?:\/\//i.test(origin)) return 'https';
  return null;
}

function safeCloneUrl(value, protocol, repo) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: false, reason: `gh metadata has no usable ${protocol === 'ssh' ? 'sshUrl' : 'url'} for ${repo}` };
  }
  const url = value.trim();
  if (originProtocol(url) !== protocol) {
    return { valid: false, reason: `gh metadata URL for ${repo} does not use the project origin protocol (${protocol})` };
  }
  if (normalizeOrigin(url) !== repo.toLowerCase()) {
    return { valid: false, reason: `gh metadata URL does not identify ${repo}` };
  }
  if (/^(?:https?|ssh):\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.password || (parsed.username && (protocol === 'https' || parsed.username !== 'git'))) {
        return { valid: false, reason: `gh metadata URL for ${repo} contains credentials and was refused` };
      }
      if (parsed.search || parsed.hash) {
        return { valid: false, reason: `gh metadata URL for ${repo} contains query or fragment data and was refused` };
      }
    } catch {
      return { valid: false, reason: `gh metadata URL for ${repo} is not a valid ${protocol} URL` };
    }
  }
  return { valid: true, url };
}

/**
 * Choose the clone URL from the project's origin protocol. This pure decision
 * keeps gh's global git protocol preference out of the conveyor's policy.
 *
 * @param {string} projectOrigin
 * @param {{sshUrl?: string, url?: string}} metadata
 * @param {string} repo
 * @returns {{valid: boolean, protocol: string|null, field: string|null, url: string|null, reason: string|null}}
 */
function selectCloneUrl(projectOrigin, metadata, repo) {
  const protocol = originProtocol(projectOrigin);
  if (!protocol) {
    return {
      valid: false,
      protocol: null,
      field: null,
      url: null,
      reason: `project origin for ${repo} is neither SSH nor HTTPS; clone protocol cannot be selected safely`,
    };
  }
  const field = protocol === 'ssh' ? 'sshUrl' : 'url';
  if (!isRecord(metadata)) {
    return {
      valid: false,
      protocol,
      field,
      url: null,
      reason: `gh repo metadata for ${repo} is missing or not an object`,
    };
  }
  const selected = safeCloneUrl(metadata[field], protocol, repo);
  return {
    valid: selected.valid,
    protocol,
    field,
    url: selected.valid ? selected.url : null,
    reason: selected.valid ? null : selected.reason,
  };
}

function readGhRepositoryMetadata(repo, projectRoot, runner = spawnSync) {
  const result = runner(
    'gh',
    ['repo', 'view', repo, '--json', 'sshUrl,url'],
    {
      cwd: projectRoot || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
      },
    },
  );
  if (!result || result.status !== 0) {
    return {
      valid: false,
      metadata: null,
      reason: `gh repo view could not read clone metadata for ${repo} (exit ${result && result.status !== undefined ? result.status : 'unknown'})`,
    };
  }
  try {
    const metadata = JSON.parse(String(result.stdout || ''));
    if (!isRecord(metadata)) throw new Error('metadata is not an object');
    return { valid: true, metadata, reason: null };
  } catch {
    return {
      valid: false,
      metadata: null,
      reason: `gh repo view returned invalid clone metadata for ${repo}`,
    };
  }
}

function resolveCloneUrl(input) {
  const { repo } = input;
  const projectOrigin = input.projectOrigin !== undefined
    ? input.projectOrigin
    : gitRemoteOrigin(input.projectRoot || process.cwd());
  if (!projectOrigin) {
    return {
      valid: false,
      protocol: null,
      field: null,
      url: null,
      reason: `project origin for ${repo} could not be read; clone is refused`,
    };
  }
  const metadataResult = input.cloneMetadata !== undefined
    ? { valid: true, metadata: input.cloneMetadata, reason: null }
    : readGhRepositoryMetadata(repo, input.projectRoot);
  if (!metadataResult.valid) {
    return {
      valid: false,
      protocol: originProtocol(projectOrigin),
      field: null,
      url: null,
      reason: metadataResult.reason,
    };
  }
  return selectCloneUrl(projectOrigin, metadataResult.metadata, repo);
}

/**
 * Normalize the GitHub URL forms a local git checkout commonly stores.
 *
 * @param {string} value
 * @returns {string|null} lower-case owner/name, or null for a non-GitHub origin
 */
function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const origin = value.trim().replace(/\/+$/, '');
  const match = /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+)$/i.exec(origin);
  if (!match) return null;
  const owner = match[1];
  const name = match[2].replace(/\.git$/i, '');
  const slug = `${owner}/${name}`.toLowerCase();
  return REPO_SLUG.test(slug) ? slug : null;
}

function configuredRepos(config) {
  return isRecord(config.repos) ? config.repos : {};
}

function hasConfiguredRepo(config, repo) {
  return Object.prototype.hasOwnProperty.call(configuredRepos(config), repo);
}

function discoveryRoots(config, projectRoot) {
  const project = path.resolve(projectRoot || process.cwd());
  const roots = [];
  const add = (value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return;
    const resolvedRoot = path.resolve(value);
    if (!roots.includes(resolvedRoot)) roots.push(resolvedRoot);
  };

  // `repos_root` is consumed here when the caller already has that normalized
  // value. pipeline-config.cjs owns its parsing/default in the later destination
  // ticket; until then, the project parent remains the safe documented root.
  add(config.repos_root);
  add(path.dirname(project));
  return roots;
}

function immediateDirectories(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function isDirectChild(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative)
    && !relative.includes(path.sep);
}

function discovered(ticket, repo, candidate, candidates, searchedRoots) {
  return resolved(ticket, repo, null, candidate.path, {
    resolution: 'discovered',
    discovery_status: 'unique',
    candidates,
    searched_roots: searchedRoots,
  });
}

/**
 * Discover an existing checkout by its origin over one level of declared roots.
 * No directory is created, changed, or selected by basename.
 *
 * @param {{ticket?: string|null, repo: string, config: object, projectRoot?: string}} input
 */
function discoverRepository(input) {
  validateArgs(input);
  if (input.projectRoot !== undefined && typeof input.projectRoot !== 'string') {
    invalidArgument('projectRoot must be a string when provided');
  }

  const { ticket = null, repo, config } = input;
  const searchedRoots = discoveryRoots(config, input.projectRoot);
  const candidates = [];
  const seen = new Set();
  for (const root of searchedRoots) {
    let canonicalRoot;
    try {
      canonicalRoot = fs.realpathSync(root);
      if (!fs.statSync(canonicalRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const directory of immediateDirectories(root)) {
      let candidatePath;
      try {
        candidatePath = fs.realpathSync(directory);
        if (!fs.statSync(candidatePath).isDirectory()) continue;
      } catch {
        continue;
      }
      // A root may contain symlinks, but discovery must remain bounded by the
      // root's real path and its one-level boundary. A link to a checkout
      // elsewhere is not an implicit declaration of that location.
      if (!isDirectChild(canonicalRoot, candidatePath)) continue;
      if (seen.has(candidatePath)) continue;
      seen.add(candidatePath);
      const repositoryRoot = gitRepositoryRoot(candidatePath);
      // `git -C` walks upward. A plain directory inside a larger repository is
      // not a checkout discovered at this scan depth.
      if (!repositoryRoot || path.resolve(repositoryRoot) !== candidatePath) continue;
      const origin = gitRemoteOrigin(repositoryRoot);
      const normalized = normalizeOrigin(origin);
      if (normalized !== repo.toLowerCase()) continue;
      // Keep only the identity used for matching. The raw remote may contain
      // credentials in an HTTPS URL and must never cross this output boundary.
      candidates.push({ path: repositoryRoot, origin: normalized });
    }
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  if (candidates.length === 1) {
    return discovered(ticket, repo, candidates[0], candidates, searchedRoots);
  }
  if (candidates.length > 1) {
    return trackOnly(
      ticket,
      repo,
      `multiple checkouts for ${repo} were found in declared roots; choose one explicitly`,
      { resolution: 'ambiguous', discovery_status: 'ambiguous', candidates, searched_roots: searchedRoots },
    );
  }
  return trackOnly(
    ticket,
    repo,
    `no checkout for ${repo} was found in declared roots`,
    { resolution: 'undiscovered', discovery_status: 'none', searched_roots: searchedRoots },
  );
}

/**
 * Resolve only an already configured local checkout.
 *
 * @param {{ticket?: string|null, repo: string, config: object}} input
 * @returns {{ticket: string|null, repo: string, resolution: string, executable: boolean, configured_path: string|null, repository_root: string|null, reason: string|null}}
 */
function resolveConfiguredRepo(input) {
  validateArgs(input);

  const { ticket = null, repo, config } = input;
  const configured = configuredRepos(config);
  if (!Object.prototype.hasOwnProperty.call(configured, repo)) {
    return trackOnly(ticket, repo, `no pipeline.repos["${repo}"] entry is configured`);
  }

  const rawPath = configured[repo];
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return trackOnly(ticket, repo, `pipeline.repos["${repo}"] is not a non-empty checkout path`);
  }
  if (!path.isAbsolute(rawPath)) {
    return trackOnly(ticket, repo, `pipeline.repos["${repo}"] path "${rawPath}" is relative; it must be absolute`);
  }

  const configuredPath = path.resolve(rawPath);
  let checkoutPath;
  let stat;
  try {
    checkoutPath = fs.realpathSync(configuredPath);
    stat = fs.statSync(checkoutPath);
  } catch (error) {
    return trackOnly(ticket, repo, `configured checkout "${configuredPath}" is not available (${error.code || error.message})`);
  }
  if (!stat.isDirectory()) {
    return trackOnly(ticket, repo, `configured checkout "${configuredPath}" is not a directory`);
  }

  const repositoryRoot = gitRepositoryRoot(checkoutPath);
  if (!repositoryRoot) {
    return trackOnly(ticket, repo, `configured checkout "${configuredPath}" is not a git repository`);
  }
  return resolved(ticket, repo, checkoutPath, repositoryRoot);
}

function suppliedPathResult(input, suppliedPath) {
  validateArgs(input);
  const { ticket = null, repo, config } = input;
  if (typeof suppliedPath !== 'string' || suppliedPath.length === 0) {
    return trackOnly(ticket, repo, `an existing checkout path is required for ${repo}`, {
      resolution: 'supplied-invalid',
      discovery_status: 'not-run',
    });
  }

  // Reuse the configured branch for the common path, directory and git checks.
  // The temporary map is in memory only; adopting a path never writes config.
  const configured = {
    ...config,
    repos: { ...configuredRepos(config), [repo]: suppliedPath },
  };
  const base = resolveConfiguredRepo({ ...input, config: configured });
  if (!base.executable) {
    return trackOnly(ticket, repo, base.reason, {
      resolution: 'supplied-invalid',
      discovery_status: 'not-run',
    });
  }

  if (path.resolve(base.repository_root) !== path.resolve(base.configured_path)) {
    return trackOnly(
      ticket,
      repo,
      `existing checkout "${base.configured_path}" resolves inside another git repository; supply its repository root`,
      { resolution: 'supplied-invalid', discovery_status: 'not-run' },
    );
  }

  const normalized = normalizeOrigin(gitRemoteOrigin(base.repository_root));
  if (normalized !== repo.toLowerCase()) {
    return trackOnly(
      ticket,
      repo,
      `existing checkout "${base.repository_root}" has an origin that does not resolve to ${repo}`,
      { resolution: 'supplied-invalid', discovery_status: 'not-run' },
    );
  }

  const nesting = validateRepositoryDestination(base.repository_root, {
    projectRoot: input.projectRoot,
    subRepos: config.sub_repos,
    label: 'existing checkout',
  });
  if (!nesting.valid) {
    return trackOnly(ticket, repo, nesting.reason, {
      resolution: 'supplied-invalid',
      discovery_status: 'not-run',
    });
  }

  return resolved(ticket, repo, base.configured_path, base.repository_root, {
    resolution: 'supplied',
  });
}

function defaultCloneDestination(repo, projectRoot, config) {
  const configuredRoot = config.repos_root;
  let root;
  if (configuredRoot !== undefined) {
    if (typeof configuredRoot !== 'string' || !path.isAbsolute(configuredRoot)) {
      return {
        error: `pipeline.repos_root must be an absolute path before ${repo} can be cloned`,
      };
    }
    root = path.resolve(configuredRoot);
  } else {
    root = path.dirname(path.resolve(projectRoot || process.cwd()));
  }
  return {
    root,
    destination: path.join(root, repo.split('/').slice(-1)[0]),
  };
}

function cloneChoiceResult(input, initial, destinationInfo) {
  const { repo } = input;
  if (destinationInfo.error) {
    return {
      ...initial,
      resolution: 'track-only',
      executable: false,
      reason: destinationInfo.error,
      decision: 'clone',
      operator_choice: 'clone',
      choice_source: 'operator',
      park_reason: destinationInfo.error,
    };
  }

  const { root, destination } = destinationInfo;
  const destinationValidation = validateRepositoryDestination(destination, {
    projectRoot: input.projectRoot,
    reposRoot: root,
    subRepos: input.config.sub_repos,
    requireInsideRoot: true,
    label: 'clone destination',
  });
  if (!destinationValidation.valid) {
    return {
      ...initial,
      resolution: 'track-only',
      executable: false,
      reason: destinationValidation.reason,
      decision: 'clone',
      operator_choice: 'clone',
      choice_source: 'operator',
      destination,
      clone_root: root,
      park_reason: destinationValidation.reason,
    };
  }

  // D7: an existing destination with the right origin is adopted. An existing
  // destination with anything else is refused; this branch never overwrites.
  if (fs.existsSync(destination)) {
    const adopted = suppliedPathResult(input, destination);
    if (adopted.executable) {
      return {
        ...adopted,
        decision: 'clone',
        operator_choice: 'clone',
        choice_source: 'operator',
        adopted: true,
        destination,
        clone_root: root,
      };
    }
    const reason = `clone destination "${destination}" already exists and cannot be adopted: ${adopted.reason}`;
    return {
      ...initial,
      resolution: 'track-only',
      executable: false,
      reason,
      decision: 'clone',
      operator_choice: 'clone',
      choice_source: 'operator',
      destination,
      clone_root: root,
      park_reason: reason,
    };
  }

  const clone = resolveCloneUrl(input);
  if (!clone.valid) {
    const reason = `operator chose clone for ${repo}, but clone preparation was refused: ${clone.reason}`;
    return {
      ...initial,
      resolution: 'track-only',
      executable: false,
      reason,
      decision: 'clone',
      operator_choice: 'clone',
      choice_source: 'operator',
      destination,
      clone_root: root,
      park_reason: reason,
    };
  }

  // T-30-06 records a protocol-bound URL and intent only. A later delivery
  // ticket owns the actual clone/write-back transaction.
  const reason = `operator chose clone for ${repo}; clone is pending a delivery step`;
  return {
    ...initial,
    resolution: 'track-only',
    executable: false,
    reason,
    decision: 'clone',
    operator_choice: 'clone',
    choice_source: 'operator',
    destination,
    clone_root: root,
    clone_url: clone.url,
    clone_protocol: clone.protocol,
    clone_source: clone.field,
    park_reason: reason,
  };
}

function cloneCommand(cloneUrl, destination) {
  // Keep this deliberately boring. A full clone is a correctness requirement:
  // graph resolution and ticket-worktree both need origin/<base>, so adding a
  // depth, filter, or single-branch flag here would create a clone that lies
  // about the branch set it can execute against.
  return ['clone', '--origin', 'origin', cloneUrl, destination];
}

function localCloneSourcePath(value) {
  if (path.isAbsolute(value)) return value;
  if (!/^file:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.hostname && parsed.hostname !== 'localhost') return null;
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

function localCloneSourceInfo(value, repo) {
  const sourcePath = localCloneSourcePath(value);
  if (!sourcePath) {
    return { valid: false, origin: null, reason: `local clone source for ${repo} is not a usable checkout path` };
  }
  const repositoryRoot = gitRepositoryRoot(sourcePath);
  if (!repositoryRoot) {
    return { valid: false, origin: null, reason: `local clone source for ${repo} is not a git repository` };
  }
  const rawOrigin = gitRemoteOrigin(repositoryRoot);
  const protocol = originProtocol(rawOrigin);
  if (!protocol) {
    return { valid: false, origin: null, reason: `local clone source for ${repo} has no supported GitHub origin` };
  }
  const safe = safeCloneUrl(rawOrigin, protocol, repo);
  if (!safe.valid) {
    return { valid: false, origin: null, reason: `local clone source for ${repo} was refused: ${safe.reason}` };
  }
  return { valid: true, origin: safe.url, reason: null };
}

function safeExecutionCloneUrl(value, repo, projectOrigin) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: false, url: null, protocol: null, field: null, reason: `clone URL for ${repo} is missing` };
  }
  const url = value.trim();
  const protocol = originProtocol(url);
  if (protocol) {
    if (projectOrigin) {
      const expectedProtocol = originProtocol(projectOrigin);
      if (expectedProtocol && protocol !== expectedProtocol) {
        return {
          valid: false,
          url: null,
          protocol,
          field: null,
          reason: `clone URL for ${repo} does not use the project origin protocol (${expectedProtocol})`,
        };
      }
    }
    const safe = safeCloneUrl(url, protocol, repo);
    return safe.valid
      ? { valid: true, url: safe.url, protocol, field: null, reason: null }
      : { ...safe, protocol, field: null };
  }
  // Local paths and file:// URLs are useful for deterministic fixtures and are
  // also valid git clone sources. They do not go through GitHub URL matching.
  if (url.startsWith('-') || url.includes('\0')) {
    return { valid: false, url: null, protocol: null, field: null, reason: `clone URL for ${repo} is malformed` };
  }
  if (/^file:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname && parsed.hostname !== 'localhost'
          || parsed.username || parsed.password || parsed.search || parsed.hash) {
        return { valid: false, url: null, protocol: null, field: null, reason: `clone URL for ${repo} contains credentials or query data and was refused` };
      }
    } catch {
      return { valid: false, url: null, protocol: null, field: null, reason: `clone URL for ${repo} is malformed` };
    }
  } else if (!path.isAbsolute(url)) {
    return { valid: false, url: null, protocol: null, field: null, reason: `clone URL for ${repo} is not an absolute local path or supported remote URL` };
  }
  const local = localCloneSourceInfo(url, repo);
  if (!local.valid) return { valid: false, url: null, protocol: null, field: null, reason: local.reason };
  return {
    valid: true,
    url,
    protocol: null,
    field: null,
    source_origin: local.origin,
    reason: null,
  };
}

function cloneFailure(input, reason, fields = {}) {
  return {
    ticket: input.ticket ?? null,
    repo: input.repo,
    resolution: fields.resolution || 'clone-failed',
    executable: false,
    configured_path: null,
    repository_root: null,
    reason,
    discovery_status: 'not-run',
    candidates: [],
    searched_roots: [],
    decision: 'clone',
    operator_choice: 'clone',
    choice_source: fields.choice_source || 'operator',
    destination: fields.destination || null,
    clone_root: fields.clone_root || null,
    clone_url: fields.clone_url || null,
    clone_protocol: fields.clone_protocol || null,
    clone_source: fields.clone_source || null,
    required_base: fields.required_base || null,
    base_ref: fields.base_ref || null,
    base_verified: false,
    park_reason: reason,
  };
}

/**
 * Execute the explicit clone transaction prepared by the D3 choice.
 *
 * The destination must be absent and must already satisfy the same physical
 * nesting policy as the choice step. `base` is mandatory: a clone is not
 * executable until the named `origin/<base>` ref is proven. The runner is
 * injectable for command-contract tests; production uses spawnSync directly.
 *
 * @param {{ticket?: string|null, repo: string, config: object, projectRoot?: string, destination?: string, base: string, cloneUrl?: string, projectOrigin?: string, cloneMetadata?: object}} input
 * @param {Function} runner
 */
function cloneRepository(input, runner = spawnSync) {
  validateArgs(input);
  if (input.projectRoot !== undefined && typeof input.projectRoot !== 'string') {
    invalidArgument('projectRoot must be a string when provided');
  }
  const projectRoot = path.resolve(input.projectRoot || process.cwd());
  // The destination check and the clone are one critical section. A second
  // resolver arriving after the first clone must see the completed checkout
  // and adopt it, never race the first `git clone` or overwrite its path.
  return withLock(lockDirFor(projectRoot), 'repo-resolve', () => (
    cloneRepositoryUnlocked({ ...input, projectRoot }, runner)
  ), { label: `repo-resolve clone ${input.repo}`, ttlMs: CLONE_LOCK_TTL_MS });
}

function cloneRepositoryUnlocked(input, runner = spawnSync) {
  validateArgs(input);
  if (input.projectRoot !== undefined && typeof input.projectRoot !== 'string') {
    invalidArgument('projectRoot must be a string when provided');
  }
  if (input.base === undefined || input.base === null || String(input.base).trim() === '') {
    return cloneFailure(input, `clone for ${input.repo} requires a named base ref to verify origin refs`);
  }
  const baseName = originRefName(input.base);
  if (!baseName) {
    return cloneFailure(input, `clone for ${input.repo} received an invalid base ref ${JSON.stringify(input.base)}`,
      { required_base: String(input.base) });
  }

  const projectRoot = path.resolve(input.projectRoot || process.cwd());
  const destinationInfo = defaultCloneDestination(input.repo, projectRoot, input.config);
  if (destinationInfo.error) return cloneFailure(input, destinationInfo.error);
  let destination = destinationInfo.destination;
  if (input.destination !== undefined && input.destination !== null) {
    if (typeof input.destination !== 'string' || !path.isAbsolute(input.destination)) {
      return cloneFailure(input, 'clone destination must be an absolute path');
    }
    destination = path.resolve(input.destination);
  }
  const root = destinationInfo.root;
  const destinationValidation = validateRepositoryDestination(destination, {
    projectRoot,
    reposRoot: root,
    subRepos: input.config.sub_repos,
    requireInsideRoot: true,
    label: 'clone destination',
  });
  if (!destinationValidation.valid) {
    return cloneFailure(input, destinationValidation.reason, {
      destination,
      clone_root: root,
      required_base: `origin/${baseName}`,
    });
  }
  if (fs.existsSync(destination)) {
    const adopted = suppliedPathResult(input, destination);
    if (adopted.executable) {
      const baseRef = resolveOriginRef(destination, baseName);
      if (!baseRef) {
        return cloneFailure(input,
          `clone destination "${destination}" matches ${input.repo} but required ref origin/${baseName} is missing`, {
            resolution: 'clone-unverified',
            destination,
            clone_root: root,
            required_base: `origin/${baseName}`,
          });
      }
      return {
        ...adopted,
        resolution: 'adopted',
        decision: 'clone',
        operator_choice: 'clone',
        choice_source: 'operator',
        adopted: true,
        destination,
        clone_root: root,
        required_base: baseRef,
        base_ref: baseRef,
        base_verified: true,
        park_reason: null,
      };
    }
    return cloneFailure(input,
      `clone destination "${destination}" already exists and cannot be adopted: ${adopted.reason}`, {
        destination,
        clone_root: root,
        required_base: `origin/${baseName}`,
      });
  }

  const projectOrigin = input.projectOrigin !== undefined
    ? input.projectOrigin
    : gitRemoteOrigin(projectRoot);
  const clone = input.cloneUrl !== undefined
    ? safeExecutionCloneUrl(input.cloneUrl, input.repo, projectOrigin)
    : resolveCloneUrl(input);
  if (!clone.valid) {
    return cloneFailure(input, `clone for ${input.repo} was refused: ${clone.reason}`, {
      destination,
      clone_root: root,
      required_base: `origin/${baseName}`,
    });
  }

  const commandOptions = {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  };
  const result = runner('git', cloneCommand(clone.url, destination), commandOptions);
  if (!result || result.status !== 0) {
    const exit = result && result.status !== undefined ? result.status : 'unknown';
    return cloneFailure(input, `git clone for ${input.repo} failed (exit ${exit}); the checkout remains unverified`, {
      destination,
      clone_root: root,
      clone_url: clone.url,
      clone_protocol: clone.protocol || null,
      clone_source: clone.field || null,
      required_base: `origin/${baseName}`,
    });
  }

  // A local/file source is validated by its own GitHub origin, but git clone
  // records the filesystem path as the destination's origin. Restore the
  // validated origin before checking the checkout so local test fixtures and
  // any explicitly supported local source cannot bypass repository identity.
  if (clone.source_origin) {
    const originResult = runner('git', ['-C', destination, 'remote', 'set-url', 'origin', clone.source_origin], commandOptions);
    if (!originResult || originResult.status !== 0) {
      const exit = originResult && originResult.status !== undefined ? originResult.status : 'unknown';
      return cloneFailure(input,
        `clone for ${input.repo} completed at "${destination}" but its origin could not be set safely (exit ${exit})`, {
          resolution: 'clone-unverified',
          destination,
          clone_root: root,
          clone_url: clone.url,
          clone_protocol: clone.protocol || null,
          clone_source: clone.field || null,
          required_base: `origin/${baseName}`,
        });
    }
  }

  const destinationOrigin = normalizeOrigin(gitRemoteOrigin(destination));
  if (destinationOrigin !== input.repo.toLowerCase()) {
    return cloneFailure(input,
      `clone for ${input.repo} completed at "${destination}" but its origin does not resolve to ${input.repo}`, {
        resolution: 'clone-unverified',
        destination,
        clone_root: root,
        clone_url: clone.url,
        clone_protocol: clone.protocol || null,
        clone_source: clone.field || null,
        required_base: `origin/${baseName}`,
      });
  }

  const baseRef = resolveOriginRef(destination, baseName);
  if (!baseRef) {
    return cloneFailure(input,
      `clone for ${input.repo} completed at "${destination}" but required ref origin/${baseName} is missing`, {
        resolution: 'clone-unverified',
        destination,
        clone_root: root,
        clone_url: clone.url,
        clone_protocol: clone.protocol || null,
        clone_source: clone.field || null,
        required_base: `origin/${baseName}`,
      });
  }

  const repositoryRoot = (() => {
    try { return fs.realpathSync(destination); } catch { return path.resolve(destination); }
  })();
  return {
    ...resolved(input.ticket ?? null, input.repo, destination, repositoryRoot, { resolution: 'cloned' }),
    decision: 'clone',
    operator_choice: 'clone',
    choice_source: 'operator',
    destination,
    clone_root: root,
    clone_url: clone.url,
    clone_protocol: clone.protocol || null,
    clone_source: clone.field || null,
    required_base: baseRef,
    base_ref: baseRef,
    base_verified: true,
    park_reason: null,
  };
}

function choicePrompt(repo, destination) {
  return `Repository ${repo} is not reachable. Choose one: clone to ${destination}, provide an existing checkout path, or skip for now (skip parks the ticket).`;
}

function parkedChoice(initial, choice, reason, extras = {}) {
  return {
    ...initial,
    resolution: 'track-only',
    executable: false,
    reason,
    decision: choice,
    operator_choice: choice,
    park_reason: reason,
    ...extras,
  };
}

function normalizeChoice(value) {
  if (value === undefined || value === null || value === '') return null;
  const choice = String(value).trim().toLowerCase();
  const aliases = { c: 'clone', e: 'existing', s: 'skip' };
  const normalized = aliases[choice] || choice;
  if (!OPERATOR_CHOICES.includes(normalized)) {
    invalidArgument(`choice must be one of ${OPERATOR_CHOICES.join('|')}, got ${JSON.stringify(value)}`);
  }
  return normalized;
}

/**
 * Apply D3 after configured resolution and origin discovery.
 *
 * This function never clones, creates a directory, or writes pipeline config.
 * Its `park_reason` is the durable message the delivery caller must pass to
 * escalation-record.cjs when the result is not executable.
 *
 * @param {{ticket?: string|null, repo: string, config: object, projectRoot?: string, choice?: string, existingPath?: string, destination?: string, resolutionResult?: object}} input
 */
function chooseRepository(input) {
  validateArgs(input);
  if (input.projectRoot !== undefined && typeof input.projectRoot !== 'string') {
    invalidArgument('projectRoot must be a string when provided');
  }

  const initial = input.resolutionResult || resolveRepository(input);
  if (initial.executable) return initial;
  const choice = normalizeChoice(input.choice);
  const destinationInfo = defaultCloneDestination(input.repo, input.projectRoot, input.config);
  if (input.destination !== undefined && input.destination !== null) {
    destinationInfo.destination = input.destination;
  }

  // A configured-but-invalid path is an explicit declaration, not permission to
  // replace it with a user choice or a discovered checkout.
  if (!['undiscovered', 'ambiguous'].includes(initial.resolution)) {
    const reason = initial.reason || `repository ${input.repo} is trackable-only`;
    return parkedChoice(initial, 'skip', reason, { choice_source: 'resolver' });
  }

  if (choice === null) {
    const reason = `repository ${input.repo} is not reachable; no operator choice was provided, so it was skipped`;
    return parkedChoice(initial, 'skip', reason, { choice_source: 'unattended' });
  }
  if (choice === 'skip') {
    const reason = `operator chose skip for ${input.repo}; repository remains trackable-only`;
    return parkedChoice(initial, 'skip', reason, { choice_source: 'operator' });
  }
  if (choice === 'existing') {
    const supplied = suppliedPathResult(input, input.existingPath);
    if (supplied.executable) {
      return {
        ...supplied,
        decision: 'existing',
        operator_choice: 'existing',
        choice_source: 'operator',
      };
    }
    const reason = `operator supplied a checkout for ${input.repo}, but it was rejected: ${supplied.reason}`;
    return parkedChoice(initial, 'existing', reason, {
      choice_source: 'operator',
      supplied_path: input.existingPath || null,
    });
  }

  if (input.destination !== undefined && input.destination !== null) {
    if (typeof input.destination !== 'string' || !path.isAbsolute(input.destination)) {
      destinationInfo.error = 'clone destination must be an absolute path';
    } else {
      destinationInfo.destination = path.resolve(input.destination);
    }
  }
  return cloneChoiceResult(input, initial, destinationInfo);
}

/**
 * Resolve in ADR-010 D1 order: configured first, then origin discovery. An
 * invalid explicit entry is returned as track-only and is never silently
 * replaced by a discovered checkout.
 */
function resolveRepository(input) {
  validateArgs(input);
  const configured = resolveConfiguredRepo(input);
  if (hasConfiguredRepo(input.config, input.repo) || configured.executable) return configured;
  return discoverRepository(input);
}

// Short aliases for callers that use command-style names.
const resolveConfigured = resolveConfiguredRepo;
const discoverRepo = discoverRepository;
const resolveRepo = resolveRepository;
const resolveSupplied = suppliedPathResult;
const chooseRepo = chooseRepository;

module.exports = {
  CHOICES: OPERATOR_CHOICES,
  REPO_SLUG,
  choicePrompt,
  cloneCommand,
  cloneRepository,
  chooseRepo,
  chooseRepository,
  discoverRepo,
  discoverRepository,
  normalizeOrigin,
  originProtocol,
  readGhRepositoryMetadata,
  resolveConfigured,
  resolveConfiguredRepo,
  resolveCloneUrl,
  resolveRepo,
  resolveRepository,
  resolveSupplied,
  selectCloneUrl,
  suppliedPathResult,
};

function cliError(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function parseCli(argv) {
  const options = {
    command: argv.shift() || null,
    repo: null,
    ticket: null,
    projectDir: process.cwd(),
    json: false,
    choice: null,
    existingPath: null,
    destination: null,
    base: null,
    cloneUrl: null,
    nonInteractive: false,
  };
  const valueFor = (flag, value) => {
    if (value === undefined || value.startsWith('--')) {
      invalidArgument(`${flag} requires a value (got ${value === undefined ? 'nothing' : `the flag "${value}"`})`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--non-interactive') {
      options.nonInteractive = true;
    } else if (arg === '--ticket') {
      options.ticket = valueFor('--ticket', argv[++i]);
    } else if (arg === '--project-dir') {
      options.projectDir = valueFor('--project-dir', argv[++i]);
    } else if (arg === '--choice') {
      options.choice = normalizeChoice(valueFor('--choice', argv[++i]));
    } else if (arg === '--path' || arg === '--existing-path') {
      options.existingPath = valueFor(arg, argv[++i]);
    } else if (arg === '--destination') {
      options.destination = valueFor('--destination', argv[++i]);
    } else if (arg === '--base') {
      options.base = valueFor('--base', argv[++i]);
    } else if (arg === '--clone-url') {
      options.cloneUrl = valueFor('--clone-url', argv[++i]);
    } else if (arg.startsWith('--')) {
      invalidArgument(`unknown option ${arg}`);
    } else if (options.repo === null) {
      options.repo = arg;
    } else {
      invalidArgument(`unexpected argument ${arg}`);
    }
  }
  if (!['configured', 'discover', 'resolve', 'choose', 'clone'].includes(options.command)) {
    invalidArgument('usage: repo-resolve.cjs <configured|discover|resolve|choose|clone> <owner/name> [--ticket <T-id>] [--project-dir <path>] [--choice <clone|existing|skip>] [--path <checkout>] [--destination <path>] [--base <ref>] [--clone-url <url>] [--non-interactive] [--json]');
  }
  if (options.repo === null) invalidArgument('an owner/name repository slug is required');
  return options;
}

async function readInteractiveChoice(repo, destination) {
  const readline = require('readline');
  process.stderr.write(`${choicePrompt(repo, destination)}\n`);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => prompt.question('> ', resolve));
  prompt.close();
  try {
    return normalizeChoice(answer);
  } catch {
    process.stderr.write('Unrecognized choice; treating it as unanswered and parking the ticket.\n');
    return null;
  }
}

if (require.main === module) {
  (async () => {
    try {
    const options = parseCli(process.argv.slice(2));
    const projectDir = path.resolve(options.projectDir);
    const loaded = loadConfig(projectDir);
    const config = loaded.config;
    const input = {
      ticket: options.ticket,
      repo: options.repo,
      config,
      projectRoot: projectDir,
    };
    let result;
    if (options.command === 'configured') {
      result = resolveConfiguredRepo(input);
    } else if (options.command === 'discover') {
      result = discoverRepository(input);
    } else if (options.command === 'resolve') {
      result = resolveRepository(input);
    } else if (options.command === 'clone') {
      result = cloneRepository({
        ...input,
        destination: options.destination,
        base: options.base,
        cloneUrl: options.cloneUrl,
      });
    } else {
      let choice = options.choice;
      const destinationInfo = options.destination
        ? { destination: path.resolve(options.destination) }
        : defaultCloneDestination(options.repo, projectDir, config);
      if (choice === null && !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY) {
        choice = await readInteractiveChoice(options.repo, destinationInfo.destination || '<validated destination>');
      }
      result = chooseRepository({
        ...input,
        choice,
        existingPath: options.existingPath,
        destination: options.destination,
      });
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.executable && result.base_verified) {
      process.stdout.write(`${result.repo}: cloned checkout ${result.repository_root}; verified ${result.base_ref}\n`);
    } else if (result.executable) {
      process.stdout.write(`${result.repo}: ${result.resolution} checkout ${result.repository_root}\n`);
    } else {
      process.stdout.write(`${result.repo}: track-only — ${result.reason}\n`);
    }
    } catch (error) {
      cliError(error && error.message ? error.message : String(error));
    }
  })();
}
