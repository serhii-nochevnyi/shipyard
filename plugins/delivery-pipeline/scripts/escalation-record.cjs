#!/usr/bin/env node
'use strict';

// escalation-record.cjs — the durable home for an escalation, and the one place
// that writes the journal's `escalation` event.
//
//   escalation-record.cjs mark  <ticket> <reason...> [--graph <dir>]
//   escalation-record.cjs clear <ticket>
//   escalation-record.cjs list  [--json]
//
// Why this exists. An escalation ("the agent gave up", "attempts > max") reached
// the front through ONE channel: a `--parked T-xx` flag the caller had to re-pass
// on every state-sync, in every session. Nothing on disk recorded it. So the next
// session opened blind — the front offered the ticket back under `finalize`, and
// the run re-dispatched review-fix and arch-review agents against a PR a human had
// already been asked to resolve. Not a deadlock (the stop hook lets a second stop
// through), but real attempts and real money spent re-deciding something that was
// already decided, with the REASON — the only part a human would have wanted —
// gone.
//
// The proving ground had this exactly: six escalations in the journal with careful
// reasons, and a seventh (T-16-05) parked with none at all, because parking and
// journalling were two separate acts and only one of them got done. Hence one
// command that does both — the same lesson as `sentinel.cjs merge` owning its own
// merge record.
//
// EXPIRY, and why it is not optional. drift-record binds its verdict to the plan's
// content hash so re-planning lifts the park by itself; a verdict that never
// expired would be worse than none. The same rule applies here, over a different
// subject: an escalation is a verdict about the PR AS IT STOOD. So it is bound to
// a fingerprint of the delivery-state facts that a human acting would change —
// status, draft, review_decision, the check tallies. The human pushes a fix,
// answers the review, undrafts, and the fingerprint moves: the park lifts itself
// and the run reconsiders. Nothing moves, and the park holds, because nothing HAS
// changed since we gave up.
//
// A ticket with no PR yet fingerprints over the little it has (status, branch), so
// it simply stays parked until someone runs `clear`. That is the honest outcome
// for "the executor could not start" — there is no external event to wait for —
// and it falls out of the same rule rather than needing a special case.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(msg) {
  process.stderr.write(`escalation-record: ${msg}\n`);
  process.exit(1);
}

function graphDir(cwd = process.cwd()) {
  return path.join(cwd, '.planning', 'graph');
}

// The facts a human acting on the PR would move. Deliberately built from what
// delivery-state ALREADY carries: adding a field to state-sync's bulk `gh pr list`
// window is what made a monorepo sync take 41s instead of 7s, and state-sync runs
// on every babysit round.
function fingerprint(s = {}) {
  const c = s.checks || {};
  return crypto.createHash('sha256').update(JSON.stringify([
    s.status || null,
    s.draft === true,
    s.review_decision || null,
    s.pr || null,
    c.failing || 0, c.pending || 0, c.total || 0,
    s.branch || null,
  ])).digest('hex').slice(0, 16);
}

function readState(cwd) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir(cwd), 'delivery-state.json'), 'utf8'));
    return raw && raw.tickets ? raw.tickets : raw || {};
  } catch {
    return {};
  }
}

function load(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir(cwd), 'escalations.json'), 'utf8'));
    return raw && typeof raw === 'object' && raw.tickets ? raw : { tickets: {} };
  } catch {
    return { tickets: {} };
  }
}

function save(store, cwd = process.cwd()) {
  fs.mkdirSync(graphDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(graphDir(cwd), 'escalations.json'), JSON.stringify(store, null, 2) + '\n');
}

/**
 * The escalations still in force, as {ticket: reason} — the shape `computeFront`
 * takes as `opts.escalated`. An entry lifts itself when the PR facts move, and a
 * merged ticket is never parked: whatever we gave up on, it landed.
 *
 * `state` may be passed in by a caller that already has it (state-sync does),
 * otherwise it is read from disk.
 */
function activeEscalations(cwd = process.cwd(), state = null) {
  const live = state || readState(cwd);
  const out = {};
  for (const [id, rec] of Object.entries(load(cwd).tickets || {})) {
    if (!rec) continue;
    const s = live[id] || {};
    if (s.status === 'merged') continue;
    if (rec.fingerprint && fingerprint(s) !== rec.fingerprint) continue; // a human moved it
    out[id] = rec.reason || 'escalated to a human';
  }
  return out;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const gIdx = argv.indexOf('--graph');
  const cwd = gIdx === -1 ? process.cwd() : path.resolve(argv[gIdx + 1] || '', '..', '..');
  if (gIdx !== -1) argv.splice(gIdx, 2);
  const [cmd, ...rest] = argv;

  if (cmd === 'mark') {
    const [ticket, ...reason] = rest;
    if (!ticket) fail('usage: escalation-record.cjs mark <ticket> <reason...>');
    // A reason is the entire point — the next session inherits this string and
    // nothing else. "escalated" tells it no more than the disjunction it replaced.
    if (!reason.length) {
      fail(
        'an escalation with no reason is the defect this script exists to fix.\n' +
        '  The next session inherits ONLY this string: say what a human must decide,\n' +
        '  e.g. "auth token expired; the live capture this ticket rests on cannot run".'
      );
    }
    const state = readState(cwd);
    const s = state[ticket];
    if (!s) fail(`no ${ticket} in delivery-state.json — run state-sync.cjs first, or check the id`);

    const store = load(cwd);
    store.tickets[ticket] = {
      reason: reason.join(' '),
      fingerprint: fingerprint(s),
      pr: s.pr || null,
      at: new Date().toISOString(),
    };
    save(store, cwd);

    // The park and its journal entry are ONE act. Splitting them is how T-16-05
    // ended up parked but uncounted — invisible to pipeline-stats' escalation rate,
    // which is the metric that would have shown the problem.
    fs.appendFileSync(path.join(graphDir(cwd), 'delivery-log.jsonl'), JSON.stringify({
      ts: new Date().toISOString(),
      event: 'escalation',
      ticket,
      pr: s.pr || null,
      reason: reason.join(' '),
      by: 'escalation-record',
    }) + '\n');

    console.log(`escalation recorded for ${ticket} — it stays parked until a human moves the PR, or you run \`clear\``);
  } else if (cmd === 'clear') {
    const [ticket] = rest;
    if (!ticket) fail('usage: escalation-record.cjs clear <ticket>');
    const store = load(cwd);
    if (!store.tickets[ticket]) { console.log(`no escalation recorded for ${ticket}`); process.exit(0); }
    delete store.tickets[ticket];
    save(store, cwd);
    console.log(`escalation cleared for ${ticket}`);
  } else if (cmd === 'list') {
    const active = activeEscalations(cwd);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(active, null, 2));
    } else if (!Object.keys(active).length) {
      console.log('no escalations in force');
    } else {
      for (const [id, reason] of Object.entries(active)) console.log(`${id}: ${reason}`);
    }
  } else {
    fail('usage: escalation-record.cjs <mark|clear|list> …');
  }
}

module.exports = { activeEscalations, fingerprint };
