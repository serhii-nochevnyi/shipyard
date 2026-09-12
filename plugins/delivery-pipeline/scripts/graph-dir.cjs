'use strict';

// graph-dir.cjs — "which ticket graph does this invocation belong to", for the
// gates that are handed a WORKTREE.
//
// base-merge and scope-gate both read `tickets.json`, and both resolved it from
// `process.cwd()`. Their documented caller is a fixer agent that has been told to
// `cd` into the ticket worktree — where `.planning/` does not exist whenever the
// project keeps it untracked, which the proving ground does. So the tool named in
// ci-fix.md and review-fix.md as the remedy for a moved base could not run from
// the one place those files put the agent, and it said "run validate-graph first",
// sending it to a command that cannot help and naming the wrong cause.
//
// Resolution order, and the reason for each step:
//   1. --graph <dir> / SHIPYARD_GRAPH_DIR — an explicit answer always wins. This
//      is the ONLY thing that works for a cross-repo ticket, where the worktree
//      lives in a sibling repository and the graph does not.
//   2. <cwd>/.planning/graph — the main loop's case; unchanged behaviour.
//   3. the worktree's OWN repository root, via `git rev-parse --git-common-dir`,
//      which reports the main repo's .git even from a linked worktree. This is
//      what rescues the agent, and it needs no change to any prompt contract.
//
// Nothing is guessed past that: a caller who lands here with no graph gets told
// the actual cause and the flag that fixes it, because a misdirecting error costs
// more than a missing one.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const hasGraph = (dir) => !!dir && fs.existsSync(path.join(dir, 'tickets.json'));

function repoRootOf(worktree) {
  const r = spawnSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const common = (r.stdout || '').trim();
  return common ? path.dirname(common) : null;
}

/**
 * @param {string[]} argv   process.argv.slice(2) — read for `--graph <dir>`
 * @param {string|null} worktree  the resolved --worktree path, when the caller has one
 * @returns {{dir: string|null, how: 'flag'|'env'|'cwd'|'worktree-repo'|'none'}}
 */
function resolveGraphDir(argv = [], worktree = null) {
  const at = argv.indexOf('--graph');
  if (at !== -1 && argv[at + 1]) return { dir: path.resolve(argv[at + 1]), how: 'flag' };
  if (process.env.SHIPYARD_GRAPH_DIR) return { dir: path.resolve(process.env.SHIPYARD_GRAPH_DIR), how: 'env' };

  const fromCwd = path.join(process.cwd(), '.planning', 'graph');
  if (hasGraph(fromCwd)) return { dir: fromCwd, how: 'cwd' };

  if (worktree) {
    const root = repoRootOf(worktree);
    const fromRepo = root && path.join(root, '.planning', 'graph');
    if (hasGraph(fromRepo)) return { dir: fromRepo, how: 'worktree-repo' };
  }
  // Report the cwd candidate so the error can name what was actually looked at.
  return { dir: fromCwd, how: 'none' };
}

/**
 * Load the ticket graph or exit with an error that names the real cause.
 * `label` is the calling script's name, for the message prefix.
 */
function loadTickets(argv, worktree, label) {
  const { dir, how } = resolveGraphDir(argv, worktree);
  if (how === 'none') {
    process.stderr.write(
      `${label}: no ticket graph found (looked in ${dir}` +
      (worktree ? ', and in the repository owning the worktree' : '') + ').\n' +
      '  This is usually a working-directory problem, not a missing graph: a ticket worktree has\n' +
      '  no .planning/ of its own when the project keeps it untracked. Pass\n' +
      '  --graph <project>/.planning/graph (or set SHIPYARD_GRAPH_DIR) — required for a\n' +
      '  cross-repo ticket, whose worktree sits in a different repository from its graph.\n'
    );
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'tickets.json'), 'utf8'));
  return { tickets: raw.tickets || {}, graphDir: dir, how };
}

/**
 * Which edition of <base> is the MEASUREMENT: origin's, when it exists.
 *
 * Both worktree gates take `--base <ref>` and both were run against the bare
 * local name. But the thing being measured — the PR's base, its three-dot diff —
 * lives on ORIGIN; a local branch of the same name is a snapshot from whenever it
 * was last touched. After the sentinel squash-merges a parent via the GitHub API
 * the local epic does not move, and the bare name made both gates lie in the two
 * worst directions at once: base-merge reported "already up to date" while
 * origin/epic was ahead (a silent false SUCCESS — the worktree never received the
 * parent's work), and scope-gate, run right after a correct base merge, flagged
 * the parent's files as a scope violation (a false FAILURE — the kind that gets a
 * gate switched off). Same lesson CLAUDE.md records for ticket-worktree.sh: a
 * remote-only ref does not resolve through a bare name, and a stale local one is
 * worse because it does.
 *
 * The full refs/remotes/ probe makes SHAs and explicit refs safe. A shorthand
 * `origin/foo` is tried as the literal branch name first, then as the common
 * remote-qualified spelling for `foo`; this preserves a real branch named
 * `origin/foo` while keeping existing callers compatible. Callers print the
 * resolved ref: a silently substituted base would be a new invisible
 * behaviour, which is the exact class this exists to remove.
 */
function parseOriginBase(base) {
  if (typeof base !== 'string') return null;
  const raw = base.trim();
  if (!raw) return null;
  let mode = 'bare';
  let value = raw;
  if (raw.startsWith('refs/remotes/origin/')) {
    mode = 'explicit-remote';
    value = raw.slice('refs/remotes/origin/'.length);
  } else if (raw.startsWith('refs/heads/')) {
    mode = 'explicit-local';
    value = raw.slice('refs/heads/'.length);
  } else if (raw.startsWith('refs/')) {
    return null;
  } else if (raw.startsWith('origin/')) {
    mode = 'origin-shorthand';
    value = raw.slice('origin/'.length);
  }
  // This is used as one component of a ref path passed to git. Keep the
  // accepted vocabulary narrower than git's full ref grammar so a malformed
  // ticket base cannot escape the intended refs/remotes/origin namespace.
  if (!value || value.startsWith('-') || value.endsWith('/') || value.endsWith('.lock')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.includes('//')) return null;
  return { mode, raw, value };
}

function originRefName(base) {
  const parsed = parseOriginBase(base);
  return parsed ? parsed.value : null;
}

function originRefCandidates(base) {
  const parsed = parseOriginBase(base);
  if (!parsed) return [];
  if (parsed.mode === 'origin-shorthand') return [parsed.raw, parsed.value];
  return [parsed.value];
}

function originBaseLabel(base) {
  const name = originRefName(base);
  return name ? `origin/${name}` : null;
}

/**
 * Resolve a named base strictly through origin's remote-tracking namespace.
 * A missing result is deliberately null: callers that require a fresh clone
 * must not silently fall back to a local branch or bare name.
 *
 * @param {string} worktreePath
 * @param {string} base
 * @returns {string|null} `origin/<base>` when the commit exists
 */
function resolveOriginRef(worktreePath, base) {
  for (const name of originRefCandidates(base)) {
    const r = spawnSync('git',
      ['-C', worktreePath, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${name}^{commit}`],
      { encoding: 'utf8' });
    if (r.status === 0) return `origin/${name}`;
  }
  return null;
}

/**
 * Resolve a local branch for a local clone source. The destination clone still
 * proves the resulting origin ref; this accepts a source checkout whose branch
 * exists locally but whose own remote-tracking namespace has not been refreshed.
 */
function resolveLocalBranchRef(worktreePath, base) {
  for (const name of originRefCandidates(base)) {
    const r = spawnSync('git',
      ['-C', worktreePath, 'rev-parse', '--verify', '-q', `refs/heads/${name}^{commit}`],
      { encoding: 'utf8' });
    if (r.status === 0) return `refs/heads/${name}`;
  }
  return null;
}

function resolveBaseRef(worktreePath, base) {
  return resolveOriginRef(worktreePath, base) || base;
}

module.exports = {
  resolveGraphDir,
  loadTickets,
  repoRootOf,
  originRefName,
  originBaseLabel,
  resolveOriginRef,
  resolveLocalBranchRef,
  resolveBaseRef,
};
