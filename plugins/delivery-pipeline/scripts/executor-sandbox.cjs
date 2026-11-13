'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DOMAIN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_ENTRIES = 32;

function refusal(message) {
  const error = new Error('executor-sandbox: ' + message);
  error.code = 'EXECUTOR_SANDBOX_INVALID';
  return error;
}

function shapeError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be an object with allow_write and/or allowed_domains';
  const extra = Object.keys(value).find((key) => !['allow_write', 'allowed_domains'].includes(key));
  if (extra) return `has unknown field "${extra}"`;
  for (const key of ['allow_write', 'allowed_domains']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > MAX_ENTRIES
        || value[key].some((item) => typeof item !== 'string' || !item.trim())) {
      return `${key} must be an array of at most ${MAX_ENTRIES} non-empty strings`;
    }
  }
  for (const entry of value.allow_write || []) {
    if (!(path.isAbsolute(entry) || entry.startsWith('~/'))) return `allow_write entry "${entry}" must be absolute or start with ~/`;
    if (/[*?[\]{}]/.test(entry)) return `allow_write entry "${entry}" must be a plain path, not a glob`;
    if (entry.split(/[\\/]/).includes('..')) return `allow_write entry "${entry}" must not contain ..`;
  }
  for (const entry of value.allowed_domains || []) {
    if (!DOMAIN_RE.test(entry)) return `allowed_domains entry "${entry}" must be a lowercase host name or *.domain`;
  }
  return null;
}

function normalizeConfig(value) {
  const error = shapeError(value);
  if (error) return { ok: false, error };
  return {
    ok: true,
    value: {
      allow_write: [...new Set(value.allow_write || [])],
      allowed_domains: [...new Set(value.allowed_domains || [])],
    },
  };
}

function realpathClosest(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing.reverse());
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function gitCommonDir(worktree) {
  try {
    return execFileSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function protectedRoots({ home, worktree, extra }) {
  const roots = [
    path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.ssh'), path.join(home, '.gnupg'),
    path.join(home, '.config', 'gh'), path.join(home, '.config', 'git'), path.join(home, '.gitconfig'),
    path.join(home, '.local', 'state', 'shipyard'), path.join(home, '.agents'),
  ];
  const common = worktree && gitCommonDir(worktree);
  if (common) roots.push(common, path.dirname(common));
  return [...roots, ...(extra || [])].filter(Boolean).map(realpathClosest);
}

// @security: an allowance may neither contain nor sit inside a host-owned root, $HOME, or the worktree's ancestors.
function resolveExecutorSandbox(config, options = {}) {
  if (config === null || config === undefined) return { allowWrite: [], allowedDomains: [] };
  const normalized = normalizeConfig(config);
  if (!normalized.ok) throw refusal('delivery_pipeline.executor_sandbox ' + normalized.error);
  const home = realpathClosest(options.home || os.homedir());
  const worktree = options.worktree ? realpathClosest(options.worktree) : null;
  const roots = protectedRoots({ home, worktree, extra: options.protectedPaths });
  const allowWrite = normalized.value.allow_write.map((entry) => {
    const resolved = realpathClosest(entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry);
    if (resolved === path.parse(resolved).root || within(resolved, home)) {
      throw refusal(`allow_write entry "${entry}" resolves to ${resolved}, which contains the home directory`);
    }
    if (worktree && within(resolved, worktree)) {
      throw refusal(`allow_write entry "${entry}" resolves to ${resolved}, which contains the ticket worktree`);
    }
    const clash = roots.find((root) => within(root, resolved) || within(resolved, root));
    if (clash) throw refusal(`allow_write entry "${entry}" overlaps the host-owned path ${clash}`);
    return resolved;
  });
  return { allowWrite: [...new Set(allowWrite)], allowedDomains: normalized.value.allowed_domains.slice() };
}

module.exports = Object.freeze({ normalizeConfig, resolveExecutorSandbox, DOMAIN_RE });
