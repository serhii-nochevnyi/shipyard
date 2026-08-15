#!/usr/bin/env node
'use strict';

// base-merge.cjs — bring a moved base into a ticket branch, resolving the
// mechanical half of the conflicts and leaving only the real ones.
//
//   base-merge.cjs <ticket> --worktree <path> --base <ref> [--json] [--no-fetch]
//
// WHY MERGE AND NOT REBASE. A ticket branch with an open PR has been pushed, so
// rebasing it is a force-push — which resets review threads and can erase a
// commit the sentinel or a reviewer pushed between our read and our write. In a
// cascade that is not one force-push but one per parent that squashes into the
// epic. And the history a rebase protects does not survive: ticket PRs land with
// `--squash`, so the epic gets one commit per ticket regardless.
//
// The merge is also the actual FIX, not a way around one. The problem after a
// parent squash-merges is a stale merge base: GitHub computes a PR's diff with
// three dots, so a lagging base makes the PR appear to contain other people's
// changes. Merging the base in moves the merge base forward, and the diff
// narrows to this ticket's own work again.
//
// THE CONFLICT RULE, and why it is mechanical. After a squash-merge the parent's
// commits are not ancestors of the epic (new SHA, same content), so a child
// still carrying them conflicts on every file the parent touched. Judgement is
// not needed for most of it:
//
//   * conflict in a file the ticket does NOT declare → take the BASE's edition.
//     The ticket does not own that file; its side is a stale snapshot.
//   * conflict in a file the ticket DOES declare → a real conflict. Left alone
//     for an agent or a human.
//
// Keying on `files_modified` rather than on "this file is not mine" is what
// makes the rule safe: a child that legitimately edits a file its parent also
// touched will have DECLARED it, so the conflict lands in the second branch and
// nothing of its work is discarded.

const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const noFetch = argv.includes('--no-fetch');
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--worktree', '--base'].includes(argv[i - 1]));
const ticket = positional[0];

function fail(msg, code = 2) { process.stderr.write(`base-merge: ${msg}\n`); process.exit(code); }
if (!ticket || !flag('worktree') || !flag('base')) {
  fail('usage: base-merge.cjs <ticket> --worktree <path> --base <ref> [--json] [--no-fetch]');
}
const worktree = path.resolve(flag('worktree'));
const base = flag('base');

// Resolved, not assumed from cwd: the documented caller is a fixer agent standing
// IN the worktree, which has no .planning/ of its own when the project keeps it
// untracked. See graph-dir.cjs for the order and why each step exists.
const { loadTickets } = require(path.join(__dirname, 'graph-dir.cjs'));
const { tickets } = loadTickets(argv, worktree, 'base-merge');
const t = tickets[ticket];
if (!t) fail(`ticket ${ticket} is not in the graph`);
const declared = Array.isArray(t.files) ? t.files : [];
if (!declared.length) fail(`ticket ${ticket} declares no files — Gate 2 should have rejected that graph`);

// Same coverage semantics as Gate 2 and the scope gate: an entry covers
// everything at or under its pre-glob prefix.
const globPrefix = (g) => { const i = g.search(/[*?[]/); return (i === -1 ? g : g.slice(0, i)).replace(/\/+$/, ''); };
const prefixes = declared.map(globPrefix);
const owns = (p) => prefixes.some((pre) => !pre || p === pre || p.startsWith(pre + '/'));

const git = (args, { tolerate = false } = {}) => {
  const r = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' });
  if (r.status !== 0 && !tolerate) fail(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

if (git(['status', '--porcelain'], { tolerate: true }).out) {
  fail('the worktree has uncommitted changes — commit or stash before merging the base in');
}

if (!noFetch) git(['fetch', 'origin', '--prune'], { tolerate: true });

const merge = git(['merge', '--no-edit', base], { tolerate: true });
if (merge.status === 0) {
  const msg = /Already up to date/i.test(merge.out) ? 'already up to date' : 'merged cleanly';
  if (asJson) console.log(JSON.stringify({ ticket, base, result: msg, taken_from_base: [], unresolved: [] }, null, 2));
  else console.log(`base-merge: ${ticket} — ${msg} with ${base}`);
  process.exit(0);
}

const conflicted = git(['diff', '--name-only', '--diff-filter=U'], { tolerate: true }).out
  .split('\n').map((s) => s.trim()).filter(Boolean);
if (!conflicted.length) {
  fail(`git merge failed but reported no conflicted paths — not guessing:\n${merge.err || merge.out}`);
}

const taken = [];
const real = [];
for (const p of conflicted) {
  if (owns(p)) { real.push(p); continue; }
  // Take the base's edition wholesale. `checkout <ref> -- <path>` also covers
  // add/add, where `--theirs` has no stage to read; a path the base deleted is
  // removed instead, which is the same rule applied to a file that no longer
  // exists there.
  const co = git(['checkout', base, '--', p], { tolerate: true });
  if (co.status === 0) { git(['add', '--', p], { tolerate: true }); taken.push(p); continue; }
  const rm = git(['rm', '-q', '--', p], { tolerate: true });
  if (rm.status === 0) { taken.push(p); continue; }
  real.push(p); // could not apply the rule — do not pretend it is resolved
}

if (real.length) {
  const payload = { ticket, base, result: 'conflicts remain', taken_from_base: taken, unresolved: real };
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else {
    console.error(`base-merge: ${ticket} — ${taken.length} path(s) taken from ${base}, ${real.length} REAL conflict(s) left:`);
    for (const p of real) console.error(`  - ${p}`);
    console.error('');
    console.error('These are files the ticket declares, so its side is not a stale snapshot —');
    console.error('resolve them on their merits, then `git add` and commit the merge.');
    console.error('The merge is deliberately left in progress; nothing was committed.');
  }
  process.exit(1);
}

git(['commit', '--no-edit']);
const payload = { ticket, base, result: 'resolved mechanically', taken_from_base: taken, unresolved: [] };
if (asJson) console.log(JSON.stringify(payload, null, 2));
else {
  console.log(`base-merge: ${ticket} — merged ${base}; ${taken.length} undeclared path(s) taken from the base:`);
  for (const p of taken) console.log(`  - ${p}`);
  console.log('Push without --force. The PR diff now narrows to this ticket\'s own work.');
}
