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
// AND THE VERDICT THIS MERGE DID NOT INVALIDATE (ADR-006 D2). Because this is
// the only thing in the conveyor that moves a head WITHOUT adding content, it is
// the only place a carried architecture verdict can be PROVED — measured on
// T-25-05, a merge whose whole tree was byte-identical cost a full re-judgement
// at ~150k tokens, 42% of that ticket's cost, once per cascade step per ticket.
// So after a merge it completed, this script hands the pre-merge and post-merge
// heads to `gate-trailer.cjs carry`, which re-derives both object identities
// itself and refuses otherwise. A merge that changed content resolves to a
// different tree and is refused BY CONSTRUCTION, so this caller needs no
// judgement of its own — and a refusal is not a failure here: the verdict is
// simply owed again, exactly as before.
//
// One consequence worth naming: the carry runs BEFORE the push (this script does
// not push), so between the two the trailer names a head origin has not seen and
// every reader says `stale`. That is the fail-closed direction — a verdict that
// counted a moment ago now does not — and it resolves the moment the fixer
// pushes, which is the next thing its own instructions tell it to do.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

if (git(['status', '--porcelain'], { tolerate: true }).out) {
  fail('the worktree has uncommitted changes — commit or stash before merging the base in');
}

if (!noFetch) git(['fetch', 'origin', '--prune'], { tolerate: true });

// Resolved AFTER the fetch, because that is when origin/<base> is current. The
// bare local name is what made this script report "already up to date" while
// origin's epic carried the parent's squash — see resolveBaseRef for the full
// account. From here on every git operation and every message uses baseRef; the
// caller must be able to see which ref was actually measured.
const baseRef = resolveBaseRef(worktree, base);

// The head the architecture verdict was rendered against, read before anything
// moves it. Everything the carry proves is about this sha and the one after.
const preMergeHead = git(['rev-parse', 'HEAD'], { tolerate: true }).out;

// WHICH PR, from the BOARD rather than from a flag. No prompt has to learn a new
// argument for the carry to happen — this script is named in ci-fix.md,
// review-fix.md and pr-sentinel.md, none of which can be taught here — and a
// project whose graph carries no delivery state simply keeps the behaviour this
// script had before the carry existed.
function boardPr(id) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json'), 'utf8'));
    const n = Number(((state || {})[id] || {}).pr);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

// Returns null when no carry was ATTEMPTED (the head did not move, or nothing
// knows this ticket's PR), and the carry's own outcome otherwise. Never throws
// and never changes this script's exit status: the merge either happened or it
// did not, and whether a verdict survived it is a separate fact.
function carryVerdict() {
  const postMergeHead = git(['rev-parse', 'HEAD'], { tolerate: true }).out;
  // Nothing moved, so the trailer already names this head: there is nothing to
  // carry, and re-stamping the same line would be a `gh` call for no reason.
  if (!preMergeHead || !postMergeHead || preMergeHead === postMergeHead) return null;
  const pr = boardPr(ticket);
  if (!pr) return null;
  const r = spawnSync('node', [
    path.join(__dirname, 'gate-trailer.cjs'), 'carry', ticket, '--pr', String(pr),
    ...(t.repo ? ['--repo', t.repo] : []),
    '--from', preMergeHead, '--to', postMergeHead, '--worktree', worktree, '--json',
  ], { encoding: 'utf8' });
  try {
    const out = JSON.parse(r.stdout);
    if (out && typeof out.carried === 'boolean') return out;
  } catch { /* fall through to the stderr reason below */ }
  return {
    ticket,
    pr,
    carried: false,
    reason: (r.stderr || '').trim().split('\n').pop()
      || `gate-trailer.cjs carry exited ${r.status} without a verdict`,
  };
}

const carryLine = (c) => (c.carried
  ? `The architecture verdict CARRIED onto ${c.to.slice(0, 7)}: the head tree and the base tree are `
    + 'the same objects the judge measured. CI still re-runs — a green is measured against a base.'
  : `No verdict carried — ${c.reason}. arch-review is owed against the new head.`);

const merge = git(['merge', '--no-edit', baseRef], { tolerate: true });
if (merge.status === 0) {
  const msg = /Already up to date/i.test(merge.out) ? 'already up to date' : 'merged cleanly';
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
const carry = carryVerdict();
const payload = { ticket, base: baseRef, requested_base: base, result: 'resolved mechanically', taken_from_base: taken, unresolved: [], contested: [], carry };
if (asJson) console.log(JSON.stringify(payload, null, 2));
else {
  console.log(`base-merge: ${ticket} — merged ${baseRef}; ${taken.length} undeclared path(s) taken from the base:`);
  for (const p of taken) console.log(`  - ${p}`);
  console.log('Push without --force. The PR diff now narrows to this ticket\'s own work.');
  if (carry) console.log(carryLine(carry));
}
