#!/usr/bin/env node
'use strict';

// Resolve the first branch of ADR-010 D1: a checkout explicitly configured in
// pipeline.repos. Discovery, prompting and cloning are deliberately absent from
// this module; a missing checkout is a trackable-only result until a later
// resolver branch earns the right to do more.

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

function trackOnly(ticket, repo, reason) {
  return {
    ticket: ticket ?? null,
    repo,
    resolution: 'track-only',
    executable: false,
    configured_path: null,
    repository_root: null,
    reason,
  };
}

function resolved(ticket, repo, configuredPath, repositoryRoot) {
  return {
    ticket: ticket ?? null,
    repo,
    resolution: 'configured',
    executable: true,
    configured_path: configuredPath,
    repository_root: repositoryRoot,
    reason: null,
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

/**
 * Resolve only an already configured local checkout.
 *
 * @param {{ticket?: string|null, repo: string, config: object}} input
 * @returns {{ticket: string|null, repo: string, resolution: string, executable: boolean, configured_path: string|null, repository_root: string|null, reason: string|null}}
 */
function resolveConfiguredRepo(input) {
  validateArgs(input);

  const { ticket = null, repo, config } = input;
  const configured = isRecord(config.repos) ? config.repos : {};
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

// Short alias for callers that already use the resolver's command-style name.
const resolveConfigured = resolveConfiguredRepo;

module.exports = {
  REPO_SLUG,
  resolveConfigured,
  resolveConfiguredRepo,
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
  if (options.command !== 'configured') {
    invalidArgument('usage: repo-resolve.cjs configured <owner/name> [--ticket <T-id>] [--project-dir <path>] [--json]');
  }
  if (options.repo === null) invalidArgument('an owner/name repository slug is required');
  return options;
}

if (require.main === module) {
  try {
    const options = parseCli(process.argv.slice(2));
    const projectDir = path.resolve(options.projectDir);
    const loaded = loadConfig(projectDir);
    const result = resolveConfiguredRepo({
      ticket: options.ticket,
      repo: options.repo,
      config: loaded.config,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.executable) {
      process.stdout.write(`${result.repo}: configured checkout ${result.repository_root}\n`);
    } else {
      process.stdout.write(`${result.repo}: track-only — ${result.reason}\n`);
    }
  } catch (error) {
    cliError(error && error.message ? error.message : String(error));
  }
}
