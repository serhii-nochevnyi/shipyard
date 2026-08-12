#!/usr/bin/env node
'use strict';

// scope-gate.cjs — does the branch's diff stay inside the ticket's declared
// `files_modified`?
//
//   scope-gate.cjs <ticket> --worktree <path> --base <ref> [--json]
//
// The conveyor had two gates around an executor and a hole between them. Gate 2
// validates the DECLARATION (every plan lists its paths, and unordered tickets
// do not collide). The "did work" gate checks that COMMITS EXIST. Nothing
// checked the thing both of those are about: that what the branch actually
// changed is what the ticket said it would. Run by hand against a real project
// this found three PRs in seconds, two of them genuinely dangerous.
//
// That gap matters more here than in an ordinary repo, because `files_modified`
// is not documentation — it is what makes "dependency-unordered tickets never
// collide" a checkable claim. A branch that edits outside it silently voids the
// guarantee for every ticket running in parallel beside it, and the collision
// surfaces later as a conflict, or worse, as a merge that quietly drops someone
// else's change.
//
// Blocking, like the did-work gate: an out-of-scope edit is either work that
// belongs to another ticket (escalate) or a plan that was wrong (re-plan). Both
// are decisions, and neither is "push it and see".

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const ticket = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--worktree' && argv[argv.indexOf(a) - 1] !== '--base');

function fail(msg, code = 2) {
  process.stderr.write(`scope-gate: ${msg}\n`);
  process.exit(code);
}

if (!ticket || !flag('worktree') || !flag('base')) {
  fail('usage: scope-gate.cjs <ticket> --worktree <path> --base <ref> [--json]');
}

const worktree = path.resolve(flag('worktree'));
const base = flag('base');

const TICKETS = path.join(process.cwd(), '.planning', 'graph', 'tickets.json');
if (!fs.existsSync(TICKETS)) fail(`missing ${TICKETS} — run validate-graph first`);
const { tickets } = JSON.parse(fs.readFileSync(TICKETS, 'utf8'));
const t = tickets[ticket];
if (!t) fail(`ticket ${ticket} is not in the graph`);

const declared = Array.isArray(t.files) ? t.files : [];
if (!declared.length) fail(`ticket ${ticket} declares no files — Gate 2 should have rejected that graph`);

// Same coverage semantics as Gate 2's overlap check, so a path that satisfies
// one cannot fail the other: a declared entry covers everything at or under its
// pre-glob prefix.
function globPrefix(g) {
  const i = g.search(/[*?[]/);
  return (i === -1 ? g : g.slice(0, i)).replace(/\/+$/, '');
}
const prefixes = declared.map(globPrefix);
const covered = (p) => prefixes.some((pre) => !pre || p === pre || p.startsWith(pre + '/'));

let changed;
try {
  // Three dots: what the BRANCH added, not what the base did meanwhile. With two
  // dots a base that moved ahead would be reported as this ticket's work — the
  // gate would then block on other people's merged commits, which is exactly the
  // false positive that gets a gate switched off.
  const out = execFileSync('git', ['-C', worktree, 'diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  changed = out.split('\n').map((s) => s.trim()).filter(Boolean);
} catch (e) {
  fail(`git diff failed in ${worktree}: ${e.stderr ? String(e.stderr).trim() : e.message}`);
}

const outside = changed.filter((p) => !covered(p));
const result = { ticket, base, worktree, changed: changed.length, declared, outside };

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(outside.length ? 1 : 0);
}

if (!changed.length) {
  console.log(`scope-gate: ${ticket} — no changes against ${base} (the did-work gate is the one that should have caught this)`);
  process.exit(0);
}
if (!outside.length) {
  console.log(`scope-gate: ${ticket} OK — ${changed.length} changed path(s), all inside files_modified`);
  process.exit(0);
}

console.error(`scope-gate: ${ticket} — ${outside.length} of ${changed.length} changed path(s) are OUTSIDE files_modified:`);
for (const p of outside) console.error(`  - ${p}`);
console.error('');
console.error('declared:');
for (const d of declared) console.error(`  - ${d}`);
console.error('');
console.error('This is a decision, not a retry. Either the edit belongs to another ticket');
console.error('(revert it here and escalate: `files_modified` is what makes parallel tickets');
console.error('non-colliding, and an undeclared edit voids that for everyone running beside');
console.error('it), or the plan was wrong and the ticket needs re-planning with the path in');
console.error('it. Do NOT push and open the PR over this.');
process.exit(1);
