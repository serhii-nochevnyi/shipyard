#!/usr/bin/env node
'use strict';

// Resolve the reachable repository branches of ADR-010 D1. An explicit
// pipeline.repos entry wins; when it is absent, discovery searches only the
// declared roots and matches git origin. Prompting and cloning are deliberately
// absent from this module; a missing or ambiguous checkout is trackable-only
// until a later resolver branch earns the right to do more.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./pipeline-config.cjs');

const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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

function rawPipelineFields(projectRoot) {
  const file = path.join(path.resolve(projectRoot || process.cwd()), '.planning', 'config.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { fields: undefined, error };
  }
  if (!isRecord(raw)) return { fields: undefined, error: null };

  // Keep the same shallow namespace precedence as pipeline-config.cjs. This
  // compatibility read exists only for the discovery ticket's CLI: older
  // pipeline-config readers do not yet expose repos_root, while silently
  // dropping an explicitly declared root makes discovery inspect the wrong
  // parent and report a false absence.
  const legacy = isRecord(raw.pipeline) ? raw.pipeline : {};
  const declared = isRecord(raw.delivery_pipeline) ? raw.delivery_pipeline : {};
  return { fields: { ...legacy, ...declared }, error: null };
}

function resolverConfig(loaded, projectRoot) {
  if (!loaded || !isRecord(loaded.config)) return loaded && loaded.config;
  if (loaded.valid === false) return loaded.config;
  const raw = rawPipelineFields(projectRoot).fields;
  const hasRoot = raw && Object.prototype.hasOwnProperty.call(raw, 'repos_root');
  const hasRepos = raw && Object.prototype.hasOwnProperty.call(raw, 'repos');
  if (!hasRoot && !hasRepos) return loaded.config;

  const declaredRoot = hasRoot ? raw.repos_root : undefined;
  const declaredRepos = hasRepos && isRecord(raw.repos) ? raw.repos : undefined;
  return declaredRoot === undefined && declaredRepos === undefined
    ? loaded.config
    : {
      ...loaded.config,
      ...(declaredRoot === undefined ? {} : { repos_root: declaredRoot }),
      ...(declaredRepos === undefined
        ? {}
        : { repos: { ...configuredRepos(loaded.config), ...declaredRepos } }),
    };
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
  } catch (error) {
    void error;
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
  if (path.resolve(repositoryRoot) !== path.resolve(checkoutPath)) {
    return trackOnly(
      ticket,
      repo,
      `configured checkout "${configuredPath}" is inside another git repository; supply its repository root`,
    );
  }
  return resolved(ticket, repo, checkoutPath, repositoryRoot);
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

module.exports = {
  REPO_SLUG,
  discoverRepo,
  discoverRepository,
  normalizeOrigin,
  resolveConfigured,
  resolveConfiguredRepo,
  resolveRepo,
  resolveRepository,
};

function cliError(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function parseCli(argv) {
  const options = { command: argv.shift() || null, repo: null, ticket: null, projectDir: process.cwd(), json: false };
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
    } else if (arg === '--ticket') {
      options.ticket = valueFor('--ticket', argv[++i]);
    } else if (arg === '--project-dir') {
      options.projectDir = valueFor('--project-dir', argv[++i]);
    } else if (arg.startsWith('--')) {
      invalidArgument(`unknown option ${arg}`);
    } else if (options.repo === null) {
      options.repo = arg;
    } else {
      invalidArgument(`unexpected argument ${arg}`);
    }
  }
  if (!['configured', 'discover', 'resolve'].includes(options.command)) {
    invalidArgument('usage: repo-resolve.cjs <configured|discover|resolve> <owner/name> [--ticket <T-id>] [--project-dir <path>] [--json]');
  }
  if (options.repo === null) invalidArgument('an owner/name repository slug is required');
  return options;
}

if (require.main === module) {
  try {
    const options = parseCli(process.argv.slice(2));
    const projectDir = path.resolve(options.projectDir);
    const loaded = loadConfig(projectDir);
    const input = {
      ticket: options.ticket,
      repo: options.repo,
      config: resolverConfig(loaded, projectDir),
      projectRoot: projectDir,
    };
    const result = options.command === 'configured'
      ? resolveConfiguredRepo(input)
      : options.command === 'discover'
        ? discoverRepository(input)
        : resolveRepository(input);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.executable) {
      process.stdout.write(`${result.repo}: ${result.resolution} checkout ${result.repository_root}\n`);
    } else {
      process.stdout.write(`${result.repo}: track-only — ${result.reason}\n`);
    }
  } catch (error) {
    cliError(error && error.message ? error.message : String(error));
  }
}
