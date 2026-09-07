#!/usr/bin/env node
'use strict';

// drift-needed.cjs — "does this ticket need a drift check", computed instead of
// judged.
//
//   drift-needed.cjs <ticket> [--graph <dir>] [--json] [--no-fetch]
//
// Always exits 0 with a verdict; the answer is the payload, not the exit code.
// (2 = no ticket graph, 1 = unknown ticket or bad usage — those are failures to
// ANSWER, not answers.)
//
// ── which rule is authoritative ──────────────────────────────────────────────
// This script SUPERSEDES the prose condition in `deliver.md` **Step 2 — Drift-
// gate the chosen tickets** (around line 742): *"whose plan is older than the
// last merge into the configured base — `git.base_branch` when set, the repo
// default otherwise, the same ref the epic is cut from — or if more than 2 days
// have passed"*. A reader who greps `deliver.md`, finds that sentence and acts
// on it is reading the OLD rule. Until the wiring lands, the loop calls this
// script by hand and this script's answer wins.
//
// The prose is still there because `deliver.md` is not in this ticket's
// `files_modified`: in phase 26 that file is owned by **T-26-12** (wave 14,
// blocked behind T-26-02), and no ticket is yet cut for the wiring itself.
// Waiting for one would have put this mechanism fifteen waves out, and the
// saving is wanted in the session that measured it. So: mechanism now, prose
// later, and the disagreement stated here rather than left for someone to find.
//
// ── why the prose was wrong, measured ────────────────────────────────────────
// One full session, 2026-09-07, three phases: **17 drift scans, 17 verdicts of
// `fresh`, zero `drifted`** — 1.24M subagent tokens, 21% of the session's entire
// agent spend, ~73k per scan. Thirteen of the seventeen produced no reuse
// candidate at all; **all sixteen candidates came from the four scans run
// against the EPIC**, which is the ref the written condition does not name. On
// that day `origin/main` took zero merges and zero code commits and every plan
// was written that morning, so by the letter of Step 2 the correct number of
// scans was zero — and the four useful ones were the ones the rule cannot
// describe.
//
// The rule names the wrong ref for `epic-stacked`. What moves under a plan there
// is the ticket's OWN base — the epic for a root ticket, the parent's branch for
// a cascade child — and it moves once per sibling that lands. The integration
// branch may not move for weeks, which is exactly why a condition anchored to it
// reads as never-fires. So the measurement is the base, and the base is the one
// `state-sync.cjs` already computed into `delivery-state.json`; nothing is
// re-derived here.
//
// ── the two tests, in order ──────────────────────────────────────────────────
//   1. Has the ticket's base taken any commit touching the DIRECTORIES its
//      `files_modified` names, since the plan was last committed? → needed.
//   2. Is the plan older than `drift_max_age_days` (default 2)? → needed.
// Anything that cannot be measured — no base, a base that resolves to no commit,
// a missing plan, a cross-repo ticket with no local checkout — answers `needed`
// with the reason. Unknown is not clean.
//
// ── the fetch is not optional ────────────────────────────────────────────────
// `origin/<base>` is only as current as the last `git fetch`, and nothing in
// deliver.md Steps 0–2 fetches: state-sync talks to `gh`, and the sentinel
// squash-merges through the GitHub API, so neither moves a remote-tracking ref.
// Without a fetch this script answers "nothing landed" for precisely the case it
// exists to catch — the sibling that just merged into the epic. So it fetches
// the one base ref first and resolves after, the way `base-merge.cjs` does
// (`--no-fetch` opts out, and the test suite uses it to reproduce the stale
// answer). This is not the blocking pre-publish gate whose no-network rule
// `scope-gate.cjs` records: this runs in the main loop, before a scan that costs
// 73k tokens, and a failed fetch is tolerated rather than fatal.
//
// ── config ───────────────────────────────────────────────────────────────────
// `drift_max_age_days` is read straight from `.planning/config.json` with the
// house precedence (`{...pipeline, ...delivery_pipeline}`), NOT through
// `pipeline-config.cjs`. That file is owned by four other tickets in this phase
// and is not in this ticket's `files_modified`, so the knob cannot be declared
// in `DEFAULTS` yet — which means `loadConfig` will WARN about it as an unknown
// key wherever else it is loaded. That warning is expected and harmless until a
// pipeline-config owner adds `drift_max_age_days: 2` to `DEFAULTS`; at that
// point this reader should be replaced by `loadConfig(root).config`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveGraphDir, resolveBaseRef } = require(path.join(__dirname, 'graph-dir.cjs'));

const DEFAULT_MAX_AGE_DAYS = 2;
// `--since` prunes traversal, and a merge-based epic can carry commit dates out
// of order, so the window is opened a week EARLIER than the plan and the strict
// comparison is done in JS. The flag is a bound on how much history git walks,
// never the decision.
const SINCE_MARGIN_SEC = 7 * 86400;
const LOG_CAP = 500;

const ARGV = process.argv.slice(2);

function die(code, msg) {
  process.stderr.write(`drift-needed: ${msg}\n`);
  process.exit(code);
}

// One spelling of `--graph`, one parser — the wording is drift-record.cjs's,
// verbatim, because a caller who learns it once must not meet a second phrasing.
// A flag-shaped value silently resolves to a directory literally called
// "--json", which is how a graph lookup goes wrong without saying anything.
const graphAt = ARGV.indexOf('--graph');
if (graphAt !== -1) {
  const val = ARGV[graphAt + 1];
  if (val === undefined || val.startsWith('--')) {
    die(1, `--graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`})`);
  }
}

const asJson = ARGV.includes('--json');
const noFetch = ARGV.includes('--no-fetch');

// Positionals, with `--graph <dir>` skipped wherever it sits. Guarded on the -1
// case: an index-based filter with no flag present reads as `i !== 0` and eats
// the first argument, which here is the ticket id.
const positional = [];
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (a === '--graph') { i++; continue; }
  if (a === '--json' || a === '--no-fetch') continue;
  if (a.startsWith('--')) die(1, `unknown flag "${a}" (usage: drift-needed.cjs <ticket> [--graph <dir>] [--json] [--no-fetch])`);
  positional.push(a);
}
const TICKET = positional[0];
if (!TICKET) die(1, 'usage: drift-needed.cjs <ticket> [--graph <dir>] [--json] [--no-fetch]');
// A second positional is a caller mistake, not a second ticket to ignore —
// `attempt-history.cjs` rejects the same shape the same way, and this script
// answers about exactly one ticket.
if (positional.length > 1) die(1, `unexpected argument "${positional[1]}" (usage: drift-needed.cjs <ticket> [--graph <dir>] [--json] [--no-fetch])`);

// ── the graph ───────────────────────────────────────────────────────────────
const { dir: GRAPH_DIR, how } = resolveGraphDir(ARGV);
const NO_GRAPH_HELP =
  `no ticket graph at ${GRAPH_DIR} — nothing to answer about.\n` +
  '  Run this from the conveyor project, or pass --graph <project>/.planning/graph\n' +
  '  (or set SHIPYARD_GRAPH_DIR).';
if (how === 'none' || !fs.existsSync(path.join(GRAPH_DIR, 'tickets.json'))) die(2, NO_GRAPH_HELP);

const PROJECT_ROOT = path.resolve(GRAPH_DIR, '..', '..');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// A file that EXISTS but fails to parse is not the same fact as a file that
// is simply absent — the former means whatever it recorded is unknown, not
// that it recorded nothing. `readJson` above conflates the two into one
// fallback value, which is fine for `tickets.json` (an unknown ticket already
// dies) and for the one config knob below (a bad default is not a bad
// verdict), but `delivery-state.json` feeds the `base` this script measures
// against, and a corrupt read there must not silently fall back to
// `pr_base`/`epic` as if the ticket had simply never synced — "unknown is not
// clean" applies to reading the state, not only to what it says.
function readJsonDistinct(file) {
  if (!fs.existsSync(file)) return { data: null, corrupt: false };
  try { return { data: JSON.parse(fs.readFileSync(file, 'utf8')), corrupt: false }; }
  catch { return { data: null, corrupt: true }; }
}

const tickets = (readJson(path.join(GRAPH_DIR, 'tickets.json'), {}) || {}).tickets || {};
const ticket = tickets[TICKET];
if (!ticket) die(1, `unknown ticket ${TICKET} in ${path.join(GRAPH_DIR, 'tickets.json')}`);

// ── config: only this one knob, read raw (see the header) ───────────────────
// Computed BEFORE the delivery-state read below: a corrupt-state early exit
// calls `answer()`, whose output always carries `max_age_days`, so that
// constant must already exist by then rather than sitting in the temporal
// dead zone of a `const` declared further down the file.
function pipelineConfig() {
  const raw = readJson(path.join(PROJECT_ROOT, '.planning', 'config.json'), {}) || {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { ...obj(raw.pipeline), ...obj(raw.delivery_pipeline) };
}
const CFG = pipelineConfig();
const MAX_AGE_DAYS = (typeof CFG.drift_max_age_days === 'number'
  && Number.isFinite(CFG.drift_max_age_days)
  && CFG.drift_max_age_days > 0)
  ? CFG.drift_max_age_days
  : DEFAULT_MAX_AGE_DAYS;

// delivery-state.json is keyed by ticket id at the TOP level (state-sync writes
// it that way); a `.tickets` wrapper is accepted so a future reshape does not
// silently read as "no state".
const stateFile = path.join(GRAPH_DIR, 'delivery-state.json');
const stateRead = readJsonDistinct(stateFile);
if (stateRead.corrupt) {
  answer({
    needed: true,
    reason: `${stateFile} exists but is not valid JSON — its \`base\` is unknown, not absent, `
      + 'and unknown is not clean; run state-sync to regenerate it',
  });
}
const rawState = stateRead.data || {};
const state = (rawState && typeof rawState.tickets === 'object' && rawState.tickets) || rawState;
const entry = (state && state[TICKET]) || null;

// ── git ─────────────────────────────────────────────────────────────────────
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function answer(fields) {
  // A fetch that was attempted and failed (offline, an unreachable origin, a
  // ref-lock race with a concurrent base-merge) is tolerated — a gate that dies
  // there is worse than one that answers. But it must not hand back a possibly
  // behind ref as a clean bill of health, so every reason measured against such
  // a ref says so. `--no-fetch` is the caller's own choice and stays silent.
  const stale = fields.base_ref && fields.fetched === false && !noFetch
    ? ` [the fetch of origin/${fields.base} failed, so ${fields.base_ref} may be behind what origin holds]`
    : '';
  const out = {
    ticket: TICKET,
    needed: fields.needed,
    reason: fields.reason + stale,
    base: fields.base ?? null,
    base_ref: fields.base_ref ?? null,
    base_source: fields.base_source ?? null,
    plan: ticket.plan || null,
    plan_time: fields.plan_time ?? null,
    plan_time_source: fields.plan_time_source ?? null,
    base_moved_at: fields.base_moved_at ?? null,
    moved_paths: fields.moved_paths ?? [],
    scan_paths: fields.scan_paths ?? [],
    age_days: fields.age_days ?? null,
    max_age_days: MAX_AGE_DAYS,
    fetched: fields.fetched ?? false,
  };
  if (asJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.stdout.write(`${TICKET}: drift check ${out.needed ? 'NEEDED' : 'not needed'} — ${out.reason}\n`);
  }
  process.exit(0);
}

// ── which repository holds the base ─────────────────────────────────────────
// A cross-repo ticket's base lives in a sibling checkout. Tracking one needs
// nothing local, but MEASURING one does, so a ticket whose repo is not checked
// out is unknown rather than clean.
let repoRoot = PROJECT_ROOT;
if (ticket.repo) {
  const repos = (CFG.repos && typeof CFG.repos === 'object') ? CFG.repos : {};
  const at = repos[ticket.repo];
  if (at && fs.existsSync(path.resolve(at))) {
    repoRoot = path.resolve(at);
  } else {
    answer({
      needed: true,
      reason: `the ticket delivers into ${ticket.repo} and no local checkout is configured (pipeline.repos) — `
        + 'the base cannot be measured, and unknown is not clean',
    });
  }
}

// ── the base, read rather than re-derived ───────────────────────────────────
let base = null;
let baseSource = null;
if (entry && entry.base) { base = entry.base; baseSource = 'delivery-state.base'; }
else if (ticket.pr_base) { base = ticket.pr_base; baseSource = 'tickets.pr_base'; }
else if (ticket.epic) { base = ticket.epic; baseSource = 'tickets.epic'; }

if (!base) {
  answer({
    needed: true,
    reason: `no base recorded for ${TICKET} — delivery-state.json has no \`base\` and the graph no \`pr_base\`. `
      + 'Run state-sync; unknown is not clean.',
  });
}

// Fetch the ONE ref, then resolve — origin/<base> is what the PR is measured
// against, and it only moves when something fetches it.
let fetched = false;
if (!noFetch) {
  const f = git(repoRoot, ['fetch', '-q', 'origin', base]);
  fetched = f.status === 0;
}

const baseRef = resolveBaseRef(repoRoot, base);
const resolved = git(repoRoot, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`]);
if (resolved.status !== 0) {
  answer({
    needed: true,
    base,
    base_ref: baseRef,
    base_source: baseSource,
    fetched,
    reason: `base "${base}" does not resolve to a commit in ${repoRoot} (tried origin/${base} and ${base}) — `
      + 'unknown is not clean',
  });
}

// ── when was the plan last written ──────────────────────────────────────────
// The plan lives in the PROJECT, always — even when the base lives in a sibling
// repository. A commit date is the honest answer; an mtime is the fallback for a
// project that keeps `.planning/` untracked (the proving ground does), where
// `git log` reports nothing at all.
const planRel = ticket.plan || null;
const planAbs = planRel ? (path.isAbsolute(planRel) ? planRel : path.join(PROJECT_ROOT, planRel)) : null;
if (!planAbs || !fs.existsSync(planAbs)) {
  answer({
    needed: true,
    base,
    base_ref: baseRef,
    base_source: baseSource,
    fetched,
    reason: `the plan file ${planRel || '(none declared)'} is not there — nothing to date the ticket against, `
      + 'and unknown is not clean',
  });
}

let planTs = null;
let planTimeSource = null;
{
  const rel = path.relative(PROJECT_ROOT, planAbs) || planAbs;
  const r = git(PROJECT_ROOT, ['log', '-1', '--format=%ct', '--', rel]);
  const t = r.status === 0 ? (r.stdout || '').trim() : '';
  if (t && /^\d+$/.test(t)) { planTs = Number(t); planTimeSource = 'commit'; }
  else { planTs = Math.floor(fs.statSync(planAbs).mtimeMs / 1000); planTimeSource = 'mtime'; }
}
const planIso = new Date(planTs * 1000).toISOString();
const ageDays = Math.round(((Date.now() / 1000) - planTs) / 864) / 100;

// A glob metacharacter makes a `files_modified` entry's OWN directory
// ambiguous (`src/**/foo.ts`'s dirname is the glob-laden `src/**`, not a real
// path), and passing that through to `git log -- <path>` mis-measures drift
// against whatever git's own (version-dependent) pathspec glob rules happen to
// do with it (Copilot review on PR #48). `scope-gate.cjs`, `validate-graph.cjs`
// and `base-merge.cjs` already answer "where does this declaration's ownership
// end" the same way — cut at the first wildcard character — so this reuses
// that cut rather than trusting git to interpret the glob itself. ADR-004 D1
// wants ONE such matcher; until that module exists, this is the same rule
// duplicated a fourth time, not a fifth DIFFERENT one.
function globPrefix(g) {
  const i = g.search(/[*?[]/);
  return i === -1 ? g : g.slice(0, i);
}

// ── what the base has taken since ───────────────────────────────────────────
// The scope is the DIRECTORIES `files_modified` names, not the files: what a
// drift check is actually looking for is a sibling reorganizing the area the
// ticket is about, which usually lands in a neighbouring file. The exception is
// a file at the repository root, whose directory IS the repository — measuring
// that would report every commit anywhere as drift and the ticket would never be
// fresh, so a root-level declaration is measured as itself.
//
// A ROOT-LEVEL glob (`*.ts`, `**`, validate-graph.cjs already accepts these as
// declarations) is the one shape `globPrefix` cannot turn into a directory: the
// cut lands at index 0, so the prefix is `''`. Earlier this fell back to
// pushing the raw glob itself into `scan_paths`, right back into the git-log
// pathspec this whole rule exists to keep glob-free (Copilot review on PR #48,
// round 3 — the case this file's own scanPaths comment had not yet named).
// There is no directory narrower than "the repository" to express that
// declaration's scope, so it is not a per-file entry at all: it makes the
// WHOLE SCAN unrestricted, same as the ticket declaring no files.
function scanPaths(files) {
  const out = new Set();
  for (const f of files || []) {
    const p = String(f).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) continue;
    const prefix = globPrefix(p);
    if (prefix === '' && prefix !== p) return []; // root-level glob: unrestricted, not a path to add
    let d;
    if (prefix === p) {
      // no wildcard: unchanged behaviour
      d = path.posix.dirname(p);
    } else if (prefix.endsWith('/')) {
      // the cut landed exactly on a path boundary (`src/` from `src/*.ts` or
      // `src/**/foo.ts`) — the prefix, minus its trailing slash, IS the
      // directory whose siblings matter.
      d = prefix.replace(/\/+$/, '');
    } else {
      // the cut landed mid-segment (`src/foo` from `src/foo*.ts`) — that is a
      // partial filename, not a directory, so its OWN dirname is the safe
      // (broader, never narrower) directory to scan.
      d = path.posix.dirname(prefix);
    }
    out.add(d === '.' || d === '' || d === '/' ? p : d);
  }
  return [...out];
}
const paths = scanPaths(ticket.files);

// `--first-parent` is load-bearing, not tidiness. The question is "what has this
// BASE taken, and when did it take it" — and for a merge landing those are two
// different commits. Default simplification hides a merge that is TREESAME to a
// parent and walks into the merged branch, whose commits carry the dates the
// work was written ON THAT BRANCH, typically BEFORE the plan. The strict
// `ts > planTs` filter then discards all of them and the script answers `fresh`
// for a base that has visibly moved: the false negative this whole ticket exists
// to remove. Walking first parents makes the MERGE the unit of "what landed",
// dated when it landed, and (git ≥ 2.31) `--name-only` then lists the files it
// brought in. Squash landings — what the conveyor itself does — are linear and
// read exactly the same either way; this is for the human `--merge` and for a
// base-merge into a cascade parent.
const since = new Date((planTs - SINCE_MARGIN_SEC) * 1000).toISOString();
const logArgs = ['log', '--first-parent', baseRef, `--since=${since}`, `-n${LOG_CAP}`, '--name-only', '--format=%x00%ct'];
if (paths.length) logArgs.push('--', ...paths);
const log = git(repoRoot, logArgs);
if (log.status !== 0) {
  answer({
    needed: true,
    base,
    base_ref: baseRef,
    base_source: baseSource,
    plan_time: planIso,
    plan_time_source: planTimeSource,
    scan_paths: paths,
    age_days: ageDays,
    fetched,
    reason: `could not read the history of ${baseRef} (${(log.stderr || '').trim() || 'git log failed'}) — `
      + 'unknown is not clean',
  });
}

// `%x00` starts every record, so a filename can never be mistaken for a header.
const records = (log.stdout || '').split('\0').filter((c) => c.trim());
const movedPaths = new Set();
let movedAt = null;
for (const chunk of records) {
  const lines = chunk.split('\n');
  const ts = Number((lines.shift() || '').trim());
  if (!Number.isFinite(ts) || ts <= planTs) continue;   // strictly newer than the plan; the --since margin is only a bound
  if (movedAt === null || ts > movedAt) movedAt = ts;
  for (const f of lines) {
    const file = f.trim();
    if (!file) continue;
    const hit = paths.find((p) => file === p || file.startsWith(`${p}/`));
    movedPaths.add(hit || file);
  }
}

const scope = paths.length
  ? paths.join(', ')
  : (ticket.files && ticket.files.length
    ? 'the whole repository (a declared file resolves to a root-level glob)'
    : 'the whole repository (the ticket declares no files)');

// `-nLOG_CAP` bounds how much history `git log` walks; hitting that cap means
// there may be MORE first-parent commits in the `--since` window than were
// read, and any of the unread ones could be the sibling that touched the
// scanned paths (Copilot review on PR #48). Nothing was found in what WAS
// read, but "nothing found in a truncated read" is not "nothing landed" —
// unknown is not clean, so a hit at the cap answers `needed` rather than
// `fresh`. Checked only when nothing already forced `needed: true` above;
// a real move found within the cap is still reported as itself.
if (movedAt === null && records.length >= LOG_CAP) {
  answer({
    needed: true,
    base,
    base_ref: baseRef,
    base_source: baseSource,
    plan_time: planIso,
    plan_time_source: planTimeSource,
    scan_paths: paths,
    age_days: ageDays,
    fetched,
    reason: `${baseRef}'s first-parent history since the plan was written (${planIso}) hit the `
      + `${LOG_CAP}-commit log cap with nothing found in what was read — there may be more history `
      + 'than this scan saw, and unknown is not clean',
  });
}

if (movedAt !== null) {
  answer({
    needed: true,
    base,
    base_ref: baseRef,
    base_source: baseSource,
    plan_time: planIso,
    plan_time_source: planTimeSource,
    base_moved_at: new Date(movedAt * 1000).toISOString(),
    moved_paths: [...movedPaths].sort(),
    scan_paths: paths,
    age_days: ageDays,
    fetched,
    reason: `${baseRef} has taken work in ${[...movedPaths].sort().join(', ')} since the plan was written `
      + `(${planIso}) — the ticket is cut from a base that has moved under it`,
  });
}

if (ageDays > MAX_AGE_DAYS) {
  answer({
    needed: true,
    base,
    base_ref: baseRef,
    base_source: baseSource,
    plan_time: planIso,
    plan_time_source: planTimeSource,
    scan_paths: paths,
    age_days: ageDays,
    fetched,
    reason: `nothing has landed in ${baseRef} touching ${scope}, but the plan is older than `
      + `${MAX_AGE_DAYS} day(s) (${ageDays} — written ${planIso})`,
  });
}

answer({
  needed: false,
  base,
  base_ref: baseRef,
  base_source: baseSource,
  plan_time: planIso,
  plan_time_source: planTimeSource,
  scan_paths: paths,
  age_days: ageDays,
  fetched,
  reason: `nothing has landed in ${baseRef} touching ${scope} since the plan was written (${planIso}), `
    + `and it is ${ageDays} day(s) old (limit ${MAX_AGE_DAYS})`,
});
