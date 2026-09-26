#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const repoKey = (row) => (row && row.repo) || null;

function nonPrimaryParents(id, tickets) {
  const row = (tickets || {})[id];
  if (!row) return [];
  return (row.depends_on || []).filter((d) => {
    const p = tickets[d];
    return p && d !== row.primary_parent && String(p.phase) === String(row.phase) && repoKey(p) === repoKey(row);
  });
}

function landedInEpic(id, tickets, state, epic) {
  const row = (tickets || {})[id];
  const visited = new Set();
  let cur = id;
  for (;;) {
    visited.add(cur);
    const s = (state || {})[cur];
    if (!s) return { landed: false, reason: `${cur} has no entry in delivery state` };
    if (s.status !== 'merged') return { landed: false, reason: `${cur} is ${s.status}` };
    if (!s.merged_into) return { landed: false, reason: `${cur} is merged but the branch it merged into was not recorded` };
    if (s.merged_into === epic) return { landed: true };
    const owner = Object.entries(tickets).find(([tid, o]) => tid !== cur && o.branch === s.merged_into
      && String(o.phase) === String(row.phase) && repoKey(o) === repoKey(row));
    if (!owner) return { landed: false, reason: `${cur} merged into ${s.merged_into}, which is neither ${epic} nor a same-phase ticket branch` };
    if (visited.has(owner[0])) return { landed: false, reason: `${cur} merged into ${s.merged_into}, which loops back through ${owner[0]}` };
    const next = (state || {})[owner[0]];
    if (!next || next.status !== 'merged') {
      return { landed: false, reason: `${cur} merged into ${s.merged_into}, and ${owner[0]} is ${next ? next.status : 'unknown'} — not yet in ${epic}` };
    }
    cur = owner[0];
  }
}

function git(root, args, env) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: env || process.env });
}

function scopeBase({ root, base, row, tickets, env }) {
  const { resolveOriginRef } = require(path.join(__dirname, 'graph-dir.cjs'));
  const plain = { kind: 'ref', ref: base };
  if (!row || !row.epic) return plain;
  const id = Object.keys(tickets || {}).find((k) => tickets[k] === row);
  if (!id || !nonPrimaryParents(id, tickets).length) return plain;
  const epicRef = resolveOriginRef(root, row.epic);
  if (!epicRef) return plain;
  const epicSha = git(root, ['rev-parse', '--verify', `${epicRef}^{commit}`], env).stdout.trim();
  if (git(root, ['merge-base', '--is-ancestor', epicSha, 'HEAD'], env).status !== 0) return plain;
  if (git(root, ['merge-base', '--is-ancestor', epicSha, base], env).status === 0) return plain;
  const mt = git(root, ['merge-tree', '--write-tree', base, epicSha], env);
  const tree = (mt.stdout || '').split('\n')[0].trim();
  if (mt.status !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`diamond scope base: merging ${epicRef} into ${base} does not yield a clean tree ` +
      `(git merge-tree exited ${mt.status}) — refusing rather than measuring against ${base} alone`);
  }
  return { kind: 'tree', tree, epic: epicRef };
}

module.exports = { nonPrimaryParents, landedInEpic, scopeBase };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ticket = argv.find((a, i) => i > 0 && !a.startsWith('--') && argv[i - 1] !== '--graph');
  if (argv[0] !== 'non-primary' || !ticket) {
    process.stderr.write('usage: diamond-parents.cjs non-primary <ticket> [--graph <dir>] --json\n');
    process.exit(2);
  }
  const { loadTickets } = require(path.join(__dirname, 'graph-dir.cjs'));
  const { tickets } = loadTickets(argv, process.cwd(), 'diamond-parents');
  const row = tickets[ticket];
  if (!row) {
    process.stderr.write(`diamond-parents: ticket ${ticket} is not in the graph\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    ticket, primary_parent: row.primary_parent || null, epic: row.epic || null,
    non_primary: nonPrimaryParents(ticket, tickets),
  }) + '\n');
}
