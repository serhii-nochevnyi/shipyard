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
// nothing of its work is discarded. That protection is only as good as the
// matcher — an inexact "does this declaration own this path" put a declared file
// in the FIRST branch and discarded exactly the work the rule exists to protect,
// so ownership is answered by path-owner.cjs and by nothing local to this file.
//
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { statusIgnoringScratch } = require('./conveyor-scratch.cjs');
const { createCoverageWriter, repoSlug } = require('./conveyor-coverage.cjs');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const noFetch = argv.includes('--no-fetch');
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
// `--graph` is in the exclusion list because its VALUE is a path: left out, a
// flag-first invocation made that path positional[0] and the "ticket" — the same
// off-by-the-flag trap drift-record documents. Deliberately NOT generalized to
// "skip any token after any flag": --json/--no-fetch are boolean, and a generic
// rule would eat the ticket after them.
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--worktree', '--base', '--graph'].includes(argv[i - 1]));
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
const { loadTickets, resolveBaseRef } = require(path.join(__dirname, 'graph-dir.cjs'));
const { tickets, graphDir } = loadTickets(argv, worktree, 'base-merge');
const t = tickets[ticket];
if (!t) fail(`ticket ${ticket} is not in the graph`);
const declared = Array.isArray(t.files) ? t.files : [];
if (!declared.length) fail(`ticket ${ticket} declares no files — Gate 2 should have rejected that graph`);

// The ONE ownership matcher, shared with Gate 2's overlap check and the scope
// gate. The old test cut a declaration at its first wildcard and compared the
// stump as a directory prefix, so `src/foo*.ts` did not own `src/fooBar.ts`: the
// conflict fell into the branch below, this script took the BASE's edition over
// the ticket's implementation, committed it and exited 0 reporting `resolved
// mechanically` (audit F01; ADR-004 D1). An inexact owner here is not a bad
// message — it is a silent mutation.
const { parse: parseDecl, owns: ownsPath, isGlob, GRAMMAR } = require(path.join(__dirname, 'path-owner.cjs'));

// No certainty, no mutation. Refused BEFORE the merge starts, like the dirty
// worktree above: the alternative — merging and then leaving every conflict
// unresolved — hands back a half-merged tree for a graph that was never
// validated. Gate 2 rejects such an entry, so getting here means it never ran.
const unanswerable = declared.filter((d) => parseDecl(d).error);
if (unanswerable.length) {
  fail(
    `ticket ${ticket} declares ${unanswerable.length} entr${unanswerable.length === 1 ? 'y' : 'ies'} the ownership ` +
    `matcher cannot answer exactly: ${unanswerable.map((d) => `"${d}"`).join(', ')} — Gate 2 should have rejected ` +
    `that graph (run validate-graph.cjs). ${GRAMMAR}. Nothing was merged: which side of a conflict wins is a ` +
    'mutation, and it is not decided from a declaration nobody can resolve.'
  );
}
const owns = (p) => declared.some((d) => ownsPath(d, p));

// Who ELSE in the graph claims this path through a wildcard declaration. A
// conflict in a file the ticket owns is already left for judgement; when a
// sibling's glob matches it too, the agent resolving it is looking at a path two
// tickets claim, and the other side may be that sibling's work rather than a
// stale snapshot. Gate 2 now rejects such a pair when the two are unordered, so
// this is the ordered case — and worth saying out loud either way.
function contestedBy(p) {
  const out = [];
  for (const [id, row] of Object.entries(tickets)) {
    if (id === ticket) continue;
    // Different repositories are different file systems (state-sync and Gate 2
    // draw the same boundary): an identical path in two repos is not the same file.
    if ((row.repo || null) !== (t.repo || null)) continue;
    for (const d of Array.isArray(row.files) ? row.files : []) {
      if (isGlob(d) && ownsPath(d, p)) out.push(`${id} via "${d}"`);
    }
  }
  return out;
}

const git = (args, { tolerate = false } = {}) => {
  const r = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' });
  if (r.status !== 0 && !tolerate) fail(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

// THE QUESTION IS ABOUT UNSAVED WORK, AND THAT MEANS TRACKED CONTENT.
// `--porcelain` alone prints `?? path` for untracked files, and the executor
// contract writes the files named by conveyor-scratch.cjs into EVERY
// executor worktree as untracked scratch (T-26-14, on the reasoning that the
// scope gate reads `git diff` and never sees them — right about the scope gate,
// wrong about every other reader of `git status`). So this script refused in the
// one state the conveyor creates for every executed ticket. Reproduced: exit 2
// with both files present, `merged cleanly` with them moved aside and nothing
// else changed. Not cosmetic — this script is named as THE remedy for a moved
// base in deliver.md, references/ci-fix.md, references/review-fix.md and
// references/pr-sentinel.md, three of them read by dispatched agents, none of
// which is told what to do about the refusal.
//
// The shared scratch definition is used here while the tracked-only question
// stays unchanged.
//
// What the relaxed check stops covering is an untracked path the incoming BASE
// ADDS at the same path — and that is still refused, by `git merge` itself,
// with git's own message naming the path (it lands in the "reported no
// conflicted paths" fail below, which prints git's stderr verbatim). Nothing is
// matched against that text here: a locale-dependent string match on git output
// would be a new fragility, and git's own wording is the better message.
// A `git status` that FAILS prints nothing, and reading that silence as "clean"
// is the same bug ticket-worktree.sh's GC checks went fail-closed for: a status
// this script could not establish is never treated as a status of "no changes".
let dirtyCheck;
try {
  dirtyCheck = statusIgnoringScratch(worktree, { untracked: 'no' });
} catch (error) {
  fail(`git status failed — cannot confirm the worktree is clean: ${String(error.stderr || error.message).trim() || 'unknown error'}`);
}
if (!dirtyCheck.ok) fail(`git status failed — cannot confirm the worktree is clean: ${dirtyCheck.code}`);
if (dirtyCheck.entries.length) {
  fail('the worktree has uncommitted changes to tracked files — commit or stash before merging the base in');
}

if (!noFetch) {
  const fetched = git(['fetch', 'origin', '--prune'], { tolerate: true });
  if (fetched.status !== 0) fail(`fetch failed; refusing cached origin refs before merge: ${fetched.err || fetched.out}`);
}

// Resolved AFTER the fetch, because that is when origin/<base> is current. The
// bare local name is what made this script report "already up to date" while
// origin's epic carried the parent's squash — see resolveBaseRef for the full
// account. From here on every git operation and every message uses baseRef; the
// caller must be able to see which ref was actually measured.
const baseRef = resolveBaseRef(worktree, base);

const preMergeHead = git(['rev-parse', 'HEAD'], { tolerate: true }).out;

function boardPr(id) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json'), 'utf8'));
    const n = Number(((state.tickets || state || {})[id] || {}).pr);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function carryVerdict() {
  const postMergeHead = git(['rev-parse', 'HEAD'], { tolerate: true }).out;
  if (!preMergeHead || !postMergeHead || preMergeHead === postMergeHead) return null;
  const pr = boardPr(ticket);
  if (!pr) return null;
  const target = require('./architecture-target.cjs');
  let integrationBranch;
  try { integrationBranch = target.resolveIntegrationBranch({ projectRoot: path.resolve(graphDir, '../..'), repo: t.repo || null }); }
  catch {}
  const architecture = target.architectureTarget({ base, integrationBranch,
    epic: t.epic, ticketBranches: Object.values(tickets).filter(row => (row.repo || null) === (t.repo || null)).map(row => row.branch) });
  return { ticket, pr, carried: false, carry: architecture.required ? 're-owed' : 'skipped-by-target',
    architecture: architecture.status,
    reason: 'head moved; retained review remains history' };
}

const carryLine = (c) => (c.carried
  ? `The architecture verdict CARRIED onto ${c.to.slice(0, 7)} (${c.carry}). `
    + 'CI still re-runs — a green is measured against a base.'
  : `No verdict carried — ${c.reason}. Architecture review: ${c.architecture}.`);

// @security: a merge is covered only when this script committed it itself.
function recordMerge(taken) {
  const commit = git(['rev-parse', 'HEAD']).out;
  const parents = git(['show', '-s', '--format=%P', commit]).out.split(' ').filter(Boolean);
  const tree = git(['show', '-s', '--format=%T', commit]).out;
  if (parents.length < 2) return;
  try {
    createCoverageWriter().record({ commit, parents, tree, ticket, repo: repoSlug(worktree, t.repo),
      worktree, kind: 'base-merge',
      base_merge: { base: baseRef, requested_base: base, taken_from_base: taken } });
  } catch (error) { fail(`merge commit ${commit} exists but coverage recording failed: ${error.message}`); }
}

const merge = git(['merge', '--no-edit', baseRef], { tolerate: true });
if (merge.status === 0) {
  const msg = /Already up to date/i.test(merge.out) ? 'already up to date' : 'merged cleanly';
  if (git(['rev-parse', 'HEAD']).out !== preMergeHead) recordMerge([]);
  const carry = carryVerdict();
  if (asJson) console.log(JSON.stringify({ ticket, base: baseRef, requested_base: base, result: msg, taken_from_base: [], unresolved: [], contested: [], carry }, null, 2));
  else {
    console.log(`base-merge: ${ticket} — ${msg} with ${baseRef}`);
    if (carry) console.log(carryLine(carry));
  }
  process.exit(0);
}

const conflicted = git(['diff', '--name-only', '--diff-filter=U'], { tolerate: true }).out
  .split('\n').map((s) => s.trim()).filter(Boolean);
if (!conflicted.length) {
  fail(`git merge failed but reported no conflicted paths — not guessing:\n${merge.err || merge.out}`);
}

const taken = [];
const real = [];
const contested = [];
for (const p of conflicted) {
  if (owns(p)) {
    real.push(p);
    const claims = contestedBy(p);
    if (claims.length) contested.push({ path: p, also_claimed_by: claims });
    continue;
  }
  // Take the base's edition wholesale. `checkout <ref> -- <path>` also covers
  // add/add, where `--theirs` has no stage to read; a path the base deleted is
  // removed instead, which is the same rule applied to a file that no longer
  // exists there.
  const co = git(['checkout', baseRef, '--', p], { tolerate: true });
  if (co.status === 0) { git(['add', '--', p], { tolerate: true }); taken.push(p); continue; }
  const rm = git(['rm', '-q', '--', p], { tolerate: true });
  if (rm.status === 0) { taken.push(p); continue; }
  real.push(p); // could not apply the rule — do not pretend it is resolved
}

if (real.length) {
  // No carry: nothing was committed, so the head has not moved and there is
  // nothing to prove about it.
  const payload = { ticket, base: baseRef, requested_base: base, result: 'conflicts remain', taken_from_base: taken, unresolved: real, contested, carry: null };
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else {
    console.error(`base-merge: ${ticket} — ${taken.length} path(s) taken from ${baseRef}, ${real.length} REAL conflict(s) left:`);
    for (const p of real) console.error(`  - ${p}`);
    console.error('');
    console.error('These are files the ticket declares, so its side is not a stale snapshot —');
    console.error('resolve them on their merits, then `git add` and commit the merge.');
    console.error('The merge is deliberately left in progress; nothing was committed.');
    if (contested.length) {
      console.error('');
      console.error('Ownership of these is CONTESTED — another ticket claims them through a wildcard');
      console.error('declaration, so the other side of the conflict may be its work and not a stale');
      console.error('snapshot. Read it before you pick a side:');
      for (const c of contested) console.error(`  - ${c.path}: also claimed by ${c.also_claimed_by.join(', ')}`);
    }
  }
  process.exit(1);
}

git(['commit', '--no-edit']);
recordMerge(taken);
const carry = carryVerdict();
const payload = { ticket, base: baseRef, requested_base: base, result: 'resolved mechanically', taken_from_base: taken, unresolved: [], contested: [], carry };
if (asJson) console.log(JSON.stringify(payload, null, 2));
else {
  console.log(`base-merge: ${ticket} — merged ${baseRef}; ${taken.length} undeclared path(s) taken from the base:`);
  for (const p of taken) console.log(`  - ${p}`);
  console.log('Push without --force. The PR diff now narrows to this ticket\'s own work.');
  if (carry) console.log(carryLine(carry));
}
