#!/usr/bin/env node
'use strict';

// THE `gate_status:` TRAILER — one writer, one reader, and a verdict bound to
// the diff it judged.
//
//   gate-trailer.cjs write <pr> [--repo owner/name] --arch-review conform
//        --drift-check <fresh|skipped> --degenerate-green <clean|N|skipped>
//        [--checks green]
//
// WHY A SCRIPT. The trailer IS the merge gate: `sentinel.cjs merge` refuses
// without it. It was assembled by hand in two prompts (`deliver.md`,
// `pr-sentinel.md`) via `gh pr edit --body`, which left three defects that no
// amount of prose could hold:
//
//   1. IT NAMED NO DIFF. The sequence that costs the most is ordinary: record
//      the verdict → undraft → a bot review lands on the now-undrafted PR →
//      review-fix pushes → CI goes green again → the untouched trailer still
//      reads `conform`, and the guard lands a diff arch-review never saw. It
//      happened on PR #31 and twice more after it; the guards were stripping the
//      trailer by hand to force a re-review. So the trailer now carries
//      `head=<sha>` and every reader treats a trailer for another head as
//      ABSENT.
//   2. A HAND-ASSEMBLED BODY GROWS A SECOND TRAILER LINE, which hides the
//      verdict above it (the reader takes the LAST one). That failure mode has
//      its own test; here it cannot happen — every existing `gate_status:` line
//      is stripped before the new one is appended, so a body carries exactly one
//      and it never has a stale head underneath.
//   3. "WRITING IT WHILE A THREAD IS OPEN IS FALSIFYING THE GATE" was a
//      sentence. It is now a refusal.
//
// The three readers (`state-sync.cjs`, `sentinel.cjs`, `front.cjs`) had three
// copies of the parser and two of the conform test. The parser, the
// classification and its words live here and are imported, because a rule the
// board and the guard must agree on cannot be held by two texts happening to
// match — the board must never offer what the guard refuses.

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// The invocation the two command docs name. Exported so a test can pin the docs
// against the script instead of against a copy of its usage.
const USAGE = 'gate-trailer.cjs write <pr> [--repo owner/name] --arch-review conform '
  + '--drift-check <fresh|skipped> --degenerate-green <clean|N|skipped> [--checks green]';

// ── the reader, shared by state-sync, sentinel and front ────────────────────

// The LAST line starting with `gate_status:` wins: a re-verdict appends, so the
// newest line is the current one. Parts with no `=` are dropped rather than
// recorded with an empty value — that is the shape a hand-written trailer takes,
// and `null` (not `{}`) means "this body carries no verdict at all", which is
// what state-sync stores against.
function parseGate(body) {
  const line = String(body || '').split('\n').reverse().find((l) => /^\s*gate_status:/i.test(l));
  if (!line) return null;
  const out = {};
  for (const part of line.replace(/^\s*gate_status:/i, '').split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

// An absent head and an empty one are the same fact. gh omits the field, a stub
// prints `""`, a hand-written trailer says `head=` — all three mean "no head".
const normSha = (v) => String(v == null ? '' : v).trim().toLowerCase();
const shortSha = (v) => (normSha(v) ? normSha(v).slice(0, 7) : '(none)');

/**
 * WHICH of the four states the architecture verdict is in, for one PR.
 *
 *   conform    — recorded, and about the diff that is on the branch now.
 *   unrecorded — no `arch-review=conform` in the body at all.
 *   stale      — recorded for a DIFFERENT head: something was pushed after the
 *                verdict, so the verdict is owed again.
 *   unbound    — recorded with no head, on a board that knows the head. A
 *                trailer written by the previous release; nothing can say which
 *                diff it covered, so it does not count.
 *
 * The classification is exported rather than each caller sniffing the `why`
 * string, because the three readers must agree on the STATE while phrasing
 * their own remedy (the board says what is owed, the guard says why it refuses).
 *
 * `headSha` is the head to measure against: the board's `state[id].head_sha` for
 * the cached readers, the LIVE `headRefOid` for the merge gate — the merge must
 * not trust a snapshot that is minutes old.
 *
 * Exact comparison, deliberately: a short-sha trailer counts as `stale` and
 * costs one re-review, which self-heals the moment arch-review writes again (the
 * writer always records the full oid). Prefix tolerance would be the fail-OPEN
 * direction on the one gate that decides what lands.
 */
function gateKind(gate, headSha) {
  const g = gate || {};
  if (String(g['arch-review'] || '').toLowerCase() !== 'conform') return 'unrecorded';
  const judged = normSha(g.head);
  const live = normSha(headSha);
  // Neither side knows a head: a trailer written by the previous release on a
  // board synced by it. There is nothing to compare, so the verdict stands —
  // this is the only direction backwards compatibility runs in, and it bites
  // only a PR verdicted before the upgrade and not merged before it.
  if (!judged && !live) return 'conform';
  if (!judged) return 'unbound';
  return judged === live ? 'conform' : 'stale';
}

// Is the architecture verdict recorded AND still about the diff on the branch?
const gateConform = (gate, headSha) => gateKind(gate, headSha) === 'conform';

/**
 * WHY the verdict does not count, as a DIAGNOSIS with no remedy attached —
 * callers append their own, and they differ (record a verdict / re-judge this
 * head / land it). Returns null when it is conform.
 */
function gateWhy(gate, headSha) {
  const kind = gateKind(gate, headSha);
  if (kind === 'conform') return null;
  if (kind === 'unrecorded') return 'no `gate_status: arch-review=conform` trailer';
  if (kind === 'unbound') {
    return 'the conform trailer carries no head — it predates head binding, and the PR is at '
      + shortSha(headSha);
  }
  return `the conform trailer is for ${shortSha((gate || {}).head)}, the PR is at ${shortSha(headSha)}`;
}

module.exports = { USAGE, parseGate, gateKind, gateConform, gateWhy, shortSha };

// ── write: the only thing that composes a trailer ───────────────────────────
// Behind require.main because front.cjs imports this file (and sentinel.cjs
// imports front.cjs): a module that parsed argv at load would exit inside its
// own readers.
if (require.main === module) {
  const argv = process.argv.slice(2);

  const die = (msg, code = 1) => {
    console.error(`gate-trailer: ${msg}`);
    process.exit(code);
  };

  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) die(`--${name} needs a value\nusage: ${USAGE}`, 2);
    return v;
  };

  if (argv[0] !== 'write') die(`unknown command "${argv[0] || ''}"\nusage: ${USAGE}`, 2);
  const pr = Number(argv[1]);
  if (!Number.isInteger(pr) || pr <= 0) die(`write needs a PR number\nusage: ${USAGE}`, 2);

  const repo = flag('repo');
  const repoArg = repo ? ['--repo', repo] : [];
  const archReview = flag('arch-review');
  if (!archReview) die(`--arch-review is required (the verdict IS the gate)\nusage: ${USAGE}`, 2);
  const driftCheck = flag('drift-check');
  if (!driftCheck) die(`--drift-check is required\nusage: ${USAGE}`, 2);
  const degenerateGreen = flag('degenerate-green');
  if (!degenerateGreen) die(`--degenerate-green is required\nusage: ${USAGE}`, 2);
  // The trailer is only ever written on a green PR, so `green` is the default
  // rather than a thing every caller has to remember to say.
  const checks = flag('checks') || 'green';

  // The live PR: the body to rewrite and the head the verdict is about. A head
  // the writer cannot read is fatal — writing a head-less trailer would have
  // this script manufacture the very legacy shape the readers fail closed on.
  const view = spawnSync('gh', ['pr', 'view', String(pr), ...repoArg, '--json', 'body,headRefOid'], { encoding: 'utf8' });
  if (view.status !== 0) {
    die(`gh pr view ${pr} failed: ${(view.stderr || '').trim() || `exit ${view.status}`}`);
  }
  let live = {};
  try { live = JSON.parse(view.stdout); } catch (e) { die(`gh pr view returned unparseable JSON (${e.message})`); }
  const head = normSha(live.headRefOid);
  if (!head) die(`PR #${pr} reports no headRefOid — refusing to write a trailer that names no diff`);

  // Refusing on an open thread is the rule `pr-sentinel.md` could only state:
  // a verdict recorded over unanswered review feedback is a falsified gate.
  // Unreadable threads refuse too — the merge gate is fail-closed here and the
  // writer must not be the softer of the two.
  const threads = spawnSync('node', [path.join(__dirname, 'reviewers.cjs'), 'unresolved', String(pr), ...repoArg], { encoding: 'utf8' });
  if (threads.status !== 0) {
    die(`could not read the review threads (reviewers.cjs unresolved exited ${threads.status}) — refusing to write blind`);
  }
  let unresolved = null;
  try { unresolved = JSON.parse(threads.stdout).unresolved_count; } catch { unresolved = null; }
  if (typeof unresolved !== 'number') die('review threads unreadable — refusing to write blind');
  if (unresolved > 0) {
    die(`${unresolved} unresolved review thread(s) — recording the verdict now would falsify the gate; `
      + 'service them first (fix or reply with reasoning, then RESOLVE each one)');
  }

  // One trailer per body: every previous `gate_status:` line goes, including its
  // stale head. Appending instead would leave a shadowed verdict behind — the
  // exact shape that made a recorded verdict read as missing.
  const kept = String(live.body || '').split('\n').filter((l) => !/^\s*gate_status:/i.test(l));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const trailer = `gate_status: arch-review=${archReview}, drift-check=${driftCheck}, `
    + `degenerate-green=${degenerateGreen}, checks=${checks}, head=${head}`;
  const body = `${kept.join('\n')}\n\n${trailer}\n`;

  try {
    execFileSync('gh', ['pr', 'edit', String(pr), ...repoArg, '--body', body], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    die(`gh pr edit ${pr} failed: ${e.stderr ? String(e.stderr).trim() : e.message}`);
  }
  console.log(JSON.stringify({ pr, head, trailer, unresolved }, null, 2));
}
