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

module.exports = { resolveGraphDir, loadTickets, repoRootOf };
