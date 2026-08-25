#!/usr/bin/env node
'use strict';

// escalation-record.cjs — the durable home for an escalation, and the one place
// that writes the journal's `escalation` event.
//
//   escalation-record.cjs mark  <ticket> <reason...> [--graph <dir>]
//   escalation-record.cjs mark-plan-defect <ticket> <plan-path> <reason...>
//                               [--signature <sig>]... [--graph <dir>]
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
//
// TWO KINDS, ONE STORE. `plan_defect` — k distinct failure signatures with no
// green, i.e. the plan is wrong rather than the attempt — is a verdict about a
// different subject, so it expires by a different rule: drift-record's plan hash,
// REQUIRED from there rather than reimplemented. The PR fingerprint is ignored for
// it on purpose. A push or an answered review says nothing about whether the plan
// can be delivered as written, and lifting on one would hand the same wrong plan
// straight back to an executor; re-decomposition rewrites the plan file, and that
// is what lifts it. A record with no `kind` is every record written before this
// existed, so it keeps the fingerprint rule byte for byte — a second store would
// have been the easy way to get that guarantee, and the wrong one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
// Required, never reimplemented: two stores that expire against a plan must agree
// on what "the same plan" means, or a re-decomposition lifts one park and not the
// other.
const { planHash } = require(path.join(__dirname, 'drift-record.cjs'));

// Applied at READ time, never stored. The front prints this string as its
// why-message and the sentinel as its PARKED_WHY, so the instruction the morning
// human needs reaches both for free — with no change in either file.
const PLAN_DEFECT_PREFIX = 'plan_defect — re-decompose: ';

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

// Read-modify-write plus the journal line, under ONE lock and written atomically.
// state-sync and the sentinel read this store concurrently — the sentinel runs
// alongside the main loop by design — and a torn read silently un-parks the
// ticket for that round, which is the exact harm the record exists to prevent.
function mutate(cwd, fn) {
  fs.mkdirSync(graphDir(cwd), { recursive: true });
  return withLock(lockDirFor(cwd), 'escalation-record', () => {
    const store = load(cwd);
    const extra = fn(store);
    writeAtomic(path.join(graphDir(cwd), 'escalations.json'), JSON.stringify(store, null, 2) + '\n');
    if (extra) fs.appendFileSync(path.join(graphDir(cwd), 'delivery-log.jsonl'), JSON.stringify(extra) + '\n');
  }, { label: 'escalation-record' });
}

/**
 * The parks still in force, as {ticket: reason} — the shape `computeFront` takes
 * as `opts.escalated` and the sentinel reads straight into its PARKED_WHY. A
 * merged ticket is never parked, whichever kind it carries: whatever we gave up
 * on, it landed.
 *
 * The two kinds expire against different subjects — an escalation against the PR
 * it was a verdict about, a plan defect against the plan — and that branch is the
 * whole of the difference. The RETURN SHAPE is deliberately unchanged, which is
 * why the guard and the front need no edit to honour the new kind.
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

    if (rec.kind === 'plan_defect') {
      // Bound to the PLAN, and to nothing about the PR. A record with no plan
      // recorded is spent rather than eternal (drift-record's rule), and reading
      // it that way also keeps a hand-damaged store from throwing here — this
      // function runs on every babysit round, for every ticket.
      if (!rec.plan) continue;
      const current = planHash(path.isAbsolute(rec.plan) ? rec.plan : path.join(cwd, rec.plan));
      if (!current || current !== rec.plan_hash) continue; // re-decomposed, or the plan is gone
      out[id] = PLAN_DEFECT_PREFIX + (rec.reason || 'the plan cannot be delivered as written');
      continue;
    }

    // No kind (every record written before plan_defect existed) — the original
    // rule, unchanged: the verdict was about the PR as it stood.
    if (rec.fingerprint && fingerprint(s) !== rec.fingerprint) continue; // a human moved it
    out[id] = rec.reason || 'escalated to a human';
  }
  return out;
}

// Repeatable and accepted in ANY position — the fixer that reaches this verdict
// has one signature per distinct failure and pastes them in whatever order the
// journal gave them. Enumerating the flag rather than inferring `--key value` is
// what keeps it from eating the ticket id or the first word of the reason.
function takeSignatures(args) {
  const rest = [];
  const sigs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--signature') {
      const v = args[++i];
      // A following flag (e.g. `--signature --signature abc123`) is not a value:
      // consuming it would record the literal string "--signature" as evidence.
      // Found by Copilot's review of this PR.
      if (!v || v.startsWith('--')) fail('--signature needs a value — it is the evidence the verdict rests on');
      sigs.push(v);
      continue;
    }
    rest.push(args[i]);
  }
  // Distinct: the same signature twice is one piece of evidence, and the k-rule
  // that produced this verdict counted distinct ones too.
  return { rest, signatures: [...new Set(sigs)] };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const gIdx = argv.indexOf('--graph');
  // A `--graph` with no value, or one immediately followed by another flag, is
  // not a directory: resolving it anyway (the old `|| ''` fallback resolved to
  // TWO levels above cwd) would read/write escalations.json in a directory
  // nobody asked for, silently. Same class of bug already fixed this round in
  // failure-signature.cjs and attempt-history.cjs; found here by Copilot's
  // review of this PR.
  if (gIdx !== -1) {
    const val = argv[gIdx + 1];
    if (val === undefined || val.startsWith('--')) {
      fail(`--graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`})`);
    }
  }
  const cwd = gIdx === -1 ? process.cwd() : path.resolve(argv[gIdx + 1], '..', '..');
  if (gIdx !== -1) argv.splice(gIdx, 2);
  // Fail-closed, matching drift-record.cjs/log-event.cjs's convention (CLAUDE.md,
  // "the two durable stores"): a mark/mark-plan-defect run from a ticket worktree
  // that happens to carry a stray/tracked delivery-state.json would otherwise
  // succeed silently while state-sync and the front read the PROJECT graph,
  // losing the verdict. `list`/`clear` are read/no-op-safe and stay permissive —
  // only the write paths need the refusal.
  const [cmd, ...rest] = argv;
  if ((cmd === 'mark' || cmd === 'mark-plan-defect') && gIdx === -1 && !fs.existsSync(path.join(graphDir(cwd), 'tickets.json'))) {
    fail(
      `no ticket graph at ${graphDir(cwd)} — refusing to record a verdict nothing will read.\n` +
      '  state-sync and the front read the PROJECT\'s graph; one written elsewhere is invisible to them.\n' +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph.'
    );
  }

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

    // The park and its journal entry are ONE act, in one locked section. Splitting
    // them is how T-16-05 ended up parked but uncounted — invisible to
    // pipeline-stats' escalation rate, the metric that would have shown this.
    mutate(cwd, (store) => {
      store.tickets[ticket] = {
        reason: reason.join(' '),
        fingerprint: fingerprint(s),
        pr: s.pr || null,
        at: new Date().toISOString(),
      };
      return {
        ts: new Date().toISOString(),
        event: 'escalation',
        ticket,
        pr: s.pr || null,
        reason: reason.join(' '),
        by: 'escalation-record',
      };
    });

    console.log(`escalation recorded for ${ticket} — it stays parked until a human moves the PR, or you run \`clear\``);
  } else if (cmd === 'mark-plan-defect') {
    const { rest: positional, signatures } = takeSignatures(rest);
    const [ticket, plan, ...reason] = positional;
    if (!ticket || !plan) {
      fail('usage: escalation-record.cjs mark-plan-defect <ticket> <plan-path> <reason...> [--signature <sig>]... [--graph <dir>]');
    }
    // Same guard as `mark`, different words on purpose: this reason is read by
    // someone deciding how to RE-PLAN, not how to unblock a PR. Checked on the
    // JOINED, TRIMMED string, not the argument count — `mark-plan-defect T plan
    // ""` has a non-empty positional array but nothing a human could read. Found
    // by Copilot's review of this PR.
    if (!reason.join(' ').trim().length) {
      fail(
        'a plan defect with no reason is a dead end for whoever picks it up in the morning.\n' +
        '  They inherit ONLY this string and the signatures: say what the PLAN got wrong,\n' +
        '  e.g. "the plan assumes a sync endpoint; the API streams, so no fix inside these\n' +
        '  files can pass" — never just "plan defect".'
      );
    }
    const hash = planHash(plan);
    if (!hash) fail(`cannot read the plan at ${plan} — a verdict with no plan to bind to would never expire`);
    // The typo guard `mark` has, for the same reason: a park recorded against an
    // id nothing knows is invisible to every reader. It also supplies the PR the
    // journal line is attributed to.
    const s = readState(cwd)[ticket];
    if (!s) fail(`no ${ticket} in delivery-state.json — run state-sync.cjs first, or check the id`);
    // Absolute, like drift-record's: this command runs from a ticket worktree
    // while `activeEscalations` reads from the project root, so a path relative
    // to either one resolves in the other.
    const planAbs = path.resolve(plan);

    mutate(cwd, (store) => {
      const at = new Date().toISOString();
      store.tickets[ticket] = {
        kind: 'plan_defect',
        reason: reason.join(' '),
        plan: planAbs,
        plan_hash: hash,
        signatures,
        pr: s.pr || null,
        at,
      };
      return {
        ts: at,
        event: 'plan_defect',
        ticket,
        pr: s.pr || null,
        reason: reason.join(' '),
        plan: planAbs,
        signatures,
        plan_hash: hash,
        by: 'escalation-record',
      };
    });

    console.log(
      `plan defect recorded for ${ticket} — it stays parked until ${planAbs} changes ` +
      '(re-decompose it), or you run `clear`. Moving the PR does NOT lift it.'
    );
  } else if (cmd === 'clear') {
    const [ticket] = rest;
    if (!ticket) fail('usage: escalation-record.cjs clear <ticket>');
    const had = !!load(cwd).tickets[ticket];
    if (had) mutate(cwd, (store) => { delete store.tickets[ticket]; });
    console.log(had ? `escalation cleared for ${ticket}` : `no escalation recorded for ${ticket}`);
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
    fail('usage: escalation-record.cjs <mark|mark-plan-defect|clear|list> …');
  }
}

module.exports = { activeEscalations, fingerprint };
