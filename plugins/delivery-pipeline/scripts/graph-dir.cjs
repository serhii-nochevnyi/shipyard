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
// @invariant: explicit graph, then a linked project worktree's untracked graph, then the main checkout's, then cwd's.
//
// Nothing is guessed past that: a caller who lands here with no graph gets told
// the actual cause and the flag that fixes it, because a misdirecting error costs
// more than a missing one.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const hasGraph = (dir) => !!dir && fs.existsSync(path.join(dir, 'tickets.json'));
const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const isDeliveryBranch = (name) => name.startsWith('ticket/') || name.startsWith('epic/');

function gitOut(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

function repoRootOf(worktree) {
  const common = gitOut(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? path.dirname(common) : null;
}

function realOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

function parseWorktreeRows(output) {
  const rows = [];
  let row = null;
  for (const line of output.split('\n')) {
    if (!line) { if (row) rows.push(row); row = null; continue; }
    if (!row) row = {};
    const at = line.indexOf(' ');
    if (at === -1) row[line] = true;
    else row[line.slice(0, at)] = line.slice(at + 1);
  }
  if (row) rows.push(row);
  return rows;
}

function containingRow(rows, dir) {
  let best = null;
  for (const row of rows) {
    if (typeof row.worktree !== 'string') continue;
    const wt = realOrNull(row.worktree);
    if (!wt) continue;
    const rel = path.relative(wt, dir);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || wt.length > best.wt.length) best = { ...row, wt };
    }
  }
  return best;
}

function readGraphFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return undefined; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GRAPH_BYTES) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function graphTickets(graph) {
  const tickets = graph && graph.tickets;
  return tickets !== null && typeof tickets === 'object' && !Array.isArray(tickets) ? tickets : {};
}

function deliveryBranches(graph) {
  const names = new Set();
  for (const row of Object.values(graphTickets(graph))) {
    if (row && typeof row.branch === 'string') names.add(row.branch);
    if (row && typeof row.epic === 'string') names.add(row.epic);
  }
  const epics = graph && graph.epics;
  if (epics !== null && typeof epics === 'object') {
    for (const epic of Object.values(epics)) {
      if (epic && typeof epic.branch === 'string') names.add(epic.branch);
    }
  }
  return names;
}

function trackedAtHead(worktree, relative) {
  return gitOut(worktree, ['cat-file', '-e', `HEAD:${relative.split(path.sep).join('/')}`]) !== null;
}

// @contract: a project worktree is linked, on a named non-delivery branch no graph names, holding rows main lacks.
function projectWorktree(dir, { graphDir = null, requester = null } = {}) {
  const real = realOrNull(dir);
  if (!real) return null;
  const list = gitOut(real, ['worktree', 'list', '--porcelain']);
  if (!list) return null;
  const rows = parseWorktreeRows(list);
  const main = rows.length ? realOrNull(rows[0].worktree) : null;
  const own = main && containingRow(rows, real);
  if (!own || own.wt === main) return null;
  if (typeof own.branch !== 'string' || !own.branch.startsWith('refs/heads/')) return null;
  const branch = own.branch.slice('refs/heads/'.length);
  if (isDeliveryBranch(branch)) return null;
  const localDir = realOrNull(graphDir || path.join(own.wt, '.planning', 'graph'))
    || path.resolve(graphDir || path.join(own.wt, '.planning', 'graph'));
  const relative = path.relative(own.wt, localDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const local = readGraphFile(path.join(localDir, 'tickets.json'));
  const mainGraph = readGraphFile(path.join(main, relative, 'tickets.json'));
  if (local === null || mainGraph === null) return null;
  if (deliveryBranches(local).has(branch) || deliveryBranches(mainGraph).has(branch)) return null;
  if (local && mainGraph) {
    const mainIds = graphTickets(mainGraph);
    if (Object.keys(graphTickets(local)).every((id) => Object.hasOwn(mainIds, id))) return null;
  }
  if (requester) {
    const requesterRepo = repoRootOf(requester);
    const ownRepo = repoRootOf(own.wt);
    if (!requesterRepo || !ownRepo || realOrNull(requesterRepo) !== realOrNull(ownRepo)) return null;
  }
  return { worktree: own.wt, branch, main };
}

function ownProjectGraph(origin) {
  const facts = gitOut(origin, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!facts) return null;
  const [gitDir, commonDir, top] = facts.split('\n');
  if (!top || realOrNull(gitDir) === realOrNull(commonDir)) return null;
  const toplevel = realOrNull(top);
  if (!toplevel || !fs.existsSync(path.join(toplevel, '.planning'))) return null;
  const dir = path.join(toplevel, '.planning', 'graph');
  if (hasGraph(dir)) {
    if (trackedAtHead(toplevel, '.planning/graph/tickets.json')) return null;
  } else if (trackedAtHead(toplevel, '.planning')) return null;
  if (!projectWorktree(toplevel, { graphDir: dir })) return null;
  return { dir, graph: hasGraph(dir) };
}

/**
 * @param {string[]} argv   process.argv.slice(2) — read for `--graph <dir>`
 * @param {string|null} worktree  the resolved --worktree path, when the caller has one
 * @returns {{dir: string|null, how: 'flag'|'env'|'cwd'|'project-worktree'|'worktree-repo'|'none'}}
 */
function resolveGraphDir(argv = [], worktree = null) {
  const at = argv.indexOf('--graph');
  if (at !== -1 && argv[at + 1]) return { dir: path.resolve(argv[at + 1]), how: 'flag' };
  if (process.env.SHIPYARD_GRAPH_DIR) return { dir: path.resolve(process.env.SHIPYARD_GRAPH_DIR), how: 'env' };

  const fromCwd = path.join(process.cwd(), '.planning', 'graph');
  for (const origin of [worktree, process.cwd()]) {
    const own = origin && ownProjectGraph(origin);
    if (own) return { dir: own.dir, how: own.graph ? 'project-worktree' : 'none' };
    const root = origin && repoRootOf(origin);
    const fromRepo = root && path.join(root, '.planning', 'graph');
    if (hasGraph(fromRepo)) return { dir: fromRepo, how: 'worktree-repo' };
  }
  if (hasGraph(fromCwd)) return { dir: fromCwd, how: 'cwd' };
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
      '  cross-repo ticket, whose worktree sits in a different repository from its graph, and\n' +
      '  for a ticket of a graph kept in a linked project worktree (<that worktree>/.planning/graph).\n'
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
  parseWorktreeRows,
  containingRow,
  projectWorktree,
  originRefName,
  originBaseLabel,
  resolveOriginRef,
  resolveLocalBranchRef,
  resolveBaseRef,
};
