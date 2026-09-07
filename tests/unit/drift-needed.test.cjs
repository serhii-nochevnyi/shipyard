'use strict';

// drift-needed.cjs — the contract, against real git repositories.
//
// This suite exists to encode a MEASUREMENT, not an opinion. Over one full
// session on 2026-09-07, delivering three phases, the drift gate ran 17 times
// and returned `fresh` 17 times, for 1.24M subagent tokens — 21% of the entire
// session's agent spend, ~73k per scan. Thirteen of those scans produced nothing
// at all; all sixteen reuse candidates came from the four scans run against the
// EPIC after sibling tickets had squash-landed under the plan. The written
// condition in deliver.md Step 2 measures against the integration branch, which
// on that day took zero commits — so by the letter the correct number of scans
// was zero, and the four useful ones were the ones the rule does not describe.
//
// `the measured session's shape` below is that day, reduced: 17 tickets, plans
// all written today, a quiet integration branch, an epic taking one commit per
// sibling that landed. It must answer 4 needed and 13 not. Every other test here
// is a single mechanism feeding that one.
//
// Timestamps are driven through GIT_AUTHOR_DATE/GIT_COMMITTER_DATE, and every
// repository is hermetic (its own GIT_CONFIG_GLOBAL): a developer's ~/.gitconfig
// must not be able to change what this suite asserts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'drift-needed.cjs');

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const EPIC = 'epic/01-demo';

const trash = [];
process.on('exit', () => {
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function gitEnv(gitconfig) {
  return { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function git(cwd, args, { at = null, env } = {}) {
  const e = { ...env };
  if (at != null) { e.GIT_AUTHOR_DATE = `@${at} +0000`; e.GIT_COMMITTER_DATE = `@${at} +0000`; }
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: e });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  return (r.stdout || '').trim();
}

/**
 * A project shaped like the conveyor's: an origin, a checkout with `.planning/`,
 * one plan per ticket committed on the integration branch, and an epic that may
 * or may not have taken sibling commits since.
 *
 * @param {object} o
 * @param {number} o.tickets       how many tickets (and directories) to make
 * @param {number[]} o.moved       1-based ticket numbers whose directory the epic touched
 * @param {number} o.planAgeDays   how long ago the plans were committed
 * @param {object|null} o.config   .planning/config.json contents, when the test needs one
 * @param {boolean} o.staleRemote  rewind refs/remotes/origin/<epic> so the checkout
 *                                 has NOT seen what origin already holds
 * @param {string|null} o.base     the base to record in delivery-state.json
 * @param {boolean} o.noState      omit delivery-state.json entirely
 */
function build(o = {}) {
  const {
    tickets: n = 1, moved = [], planAgeDays = 0, config = null,
    staleRemote = false, base = EPIC, noState = false, files = null, mergeSibling = false,
  } = o;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-drift-'));
  trash.push(dir);
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const env = gitEnv(gitconfig);
  const origin = path.join(dir, 'origin');
  const proj = path.join(dir, 'proj');

  spawnSync('git', ['init', '-q', '--bare', origin], { env });
  spawnSync('git', ['init', '-q', proj], { env });
  git(proj, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { env });
  git(proj, ['config', 'user.email', 'drift@example.com'], { env });
  git(proj, ['config', 'user.name', 'Drift Test'], { env });

  const w = (rel, body) => {
    const abs = path.join(proj, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  const id = (i) => `T-01-${String(i).padStart(2, '0')}`;
  const modDir = (i) => `src/mod${String(i).padStart(2, '0')}`;
  const planRel = (i) => `.planning/phases/01-demo/01-${String(i).padStart(2, '0')}-PLAN.md`;

  // ── the source tree, committed a month ago ────────────────────────────────
  for (let i = 1; i <= n; i++) w(`${modDir(i)}/impl.cjs`, `// module ${i}\n`);
  w('README.md', '# demo\n');
  git(proj, ['add', '-A'], { env });
  git(proj, ['commit', '-qm', 'init'], { at: NOW - 30 * DAY, env });
  git(proj, ['remote', 'add', 'origin', origin], { env });
  git(proj, ['push', '-q', '-u', 'origin', 'main'], { env });

  // The epic is cut from the integration branch BEFORE the plans are written —
  // exactly the order the conveyor uses, and the reason a plan can be newer than
  // everything the epic inherited.
  git(proj, ['branch', EPIC], { env });
  git(proj, ['push', '-q', 'origin', EPIC], { env });
  const epicCut = git(proj, ['rev-parse', EPIC], { env });

  // ── the plans, written `planAgeDays` ago (+2h of slack so a sibling commit an
  //    hour later is still in the past) ───────────────────────────────────────
  const planTs = NOW - planAgeDays * DAY - 2 * 3600;
  for (let i = 1; i <= n; i++) w(planRel(i), `# plan ${i}\n\ndeclares ${modDir(i)}\n`);
  git(proj, ['add', '-A'], { env });
  git(proj, ['commit', '-qm', 'plans'], { at: planTs, env });
  git(proj, ['push', '-q', 'origin', 'main'], { env });

  // ── siblings landing in the epic, one commit each, AFTER the plans ─────────
  if (moved.length) {
    git(proj, ['checkout', '-q', EPIC], { env });
    moved.forEach((i, k) => {
      w(`${modDir(i)}/sibling.cjs`, `// landed by a sibling ticket\n`);
      git(proj, ['add', '-A'], { env });
      git(proj, ['commit', '-qm', `sibling ${i}`], { at: planTs + 3600 + k, env });
    });
    git(proj, ['push', '-q', 'origin', EPIC], { env });
    git(proj, ['checkout', '-q', 'main'], { env });
  }

  // A sibling landed as a MERGE COMMIT rather than a squash: the work itself is
  // dated BEFORE the plan (it was written on the sibling's branch), and only the
  // merge is dated after. Default history simplification hides a merge that is
  // TREESAME to a parent and walks into that parent's own commits, so a reader
  // that trusts the walk sees only pre-plan dates and calls the base quiet.
  if (mergeSibling) {
    git(proj, ['checkout', '-q', '-b', 'sibling', epicCut], { env });
    w(`${modDir(1)}/from-sibling.cjs`, '// written on the sibling branch, before the plan\n');
    git(proj, ['add', '-A'], { env });
    git(proj, ['commit', '-qm', 'sibling work'], { at: planTs - DAY, env });
    git(proj, ['checkout', '-q', EPIC], { env });
    git(proj, ['merge', '-q', '--no-ff', '-m', 'merge sibling', 'sibling'], { at: planTs + 3600, env });
    git(proj, ['push', '-q', 'origin', EPIC], { env });
    git(proj, ['checkout', '-q', 'main'], { env });
  }

  // The checkout that has not fetched: origin holds the sibling commits, this
  // working copy's remote-tracking ref still points at the cut.
  if (staleRemote) git(proj, ['update-ref', `refs/remotes/origin/${EPIC}`, epicCut], { env });

  // ── the graph ─────────────────────────────────────────────────────────────
  const tickets = {};
  const state = {};
  for (let i = 1; i <= n; i++) {
    tickets[id(i)] = {
      title: `ticket ${i}`,
      plan: planRel(i),
      phase: '1',
      repo: null,
      files: files ? files(i) : [`${modDir(i)}/impl.cjs`],
      branch: `ticket/${id(i)}-demo`,
      epic: EPIC,
      primary_parent: null,
      pr_base: EPIC,
    };
    state[id(i)] = { branch: `ticket/${id(i)}-demo`, pr: null, status: 'pending', epic: EPIC, ready: true };
    if (base !== null) state[id(i)].base = base;
  }
  const graph = path.join(proj, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (!noState) fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state, null, 2));
  if (config) fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify(config, null, 2));

  return { dir, proj, origin, env, graph, id, modDir, planRel, planTs };
}

/** Run the script from a NEUTRAL cwd, addressing the graph by flag — the way a
 *  caller standing anywhere but the project must be able to. */
function run(world, args, { cwd = null } = {}) {
  const argv = cwd ? args : [...args, '--graph', world.graph];
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd: cwd || world.dir, encoding: 'utf8', env: world.env,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not every invocation is --json */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// ── the base is the thing that moves ────────────────────────────────────────
suite('drift-needed — measured against the ticket\'s own base');

test('a plan committed after everything in its base is not stale', () => {
  const w = build({ tickets: 2 });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
  assert.strictEqual(r.json.base, EPIC);
  // the reason has to name the ref it measured and say nothing landed
  assert.ok(/origin\/epic\/01-demo/.test(r.json.reason), r.json.reason);
  assert.ok(/nothing/i.test(r.json.reason), r.json.reason);
  assert.strictEqual(r.json.base_moved_at, null);
});

test('one sibling commit in the base touching a declared directory makes it needed', () => {
  const w = build({ tickets: 2, moved: [1] });
  const hit = run(w, ['T-01-01', '--json']);
  assert.strictEqual(hit.json.needed, true, JSON.stringify(hit.json));
  assert.ok(/src\/mod01/.test(hit.json.reason), hit.json.reason);
  assert.ok(hit.json.base_moved_at, 'the moment the base moved is reported');
  assert.deepStrictEqual(hit.json.moved_paths, ['src/mod01']);
});

test('a sibling that landed as a MERGE, not a squash, still counts', () => {
  // The conveyor squashes, but a human `gh pr merge --merge` into an epic does
  // not, and neither does a base-merge of a moved epic into a parent branch.
  // The work is dated a day BEFORE the plan and only the merge is newer; a walk
  // that follows into the merged branch sees nothing but pre-plan dates and
  // reports a base that has visibly moved as quiet — the false `fresh` this
  // script exists to remove.
  const w = build({ tickets: 2, mergeSibling: true });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
  assert.ok(r.json.moved_paths.includes('src/mod01'), JSON.stringify(r.json.moved_paths));
  assert.ok(r.json.base_moved_at, 'the merge is the moment the base moved');
  // and it must not smear onto the ticket next door
  const other = run(w, ['T-01-02', '--json']);
  assert.strictEqual(other.json.needed, false, JSON.stringify(other.json));
});

test('a commit elsewhere in the same base leaves the other ticket alone', () => {
  const w = build({ tickets: 2, moved: [1] });
  const miss = run(w, ['T-01-02', '--json']);
  assert.strictEqual(miss.json.needed, false, JSON.stringify(miss.json));
});

test('the base is read from delivery-state.json, not re-derived', () => {
  const w = build({ tickets: 2, moved: [1], base: 'main' });
  // The epic moved under mod01, but this ticket's recorded base is the quiet
  // integration branch — the answer must follow the record.
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.base, 'main');
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
  assert.strictEqual(r.json.base_source, 'delivery-state.base');
});

test('with no delivery-state entry the ticket\'s pr_base is used and named', () => {
  const w = build({ tickets: 1, moved: [1], noState: true });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.base_source, 'tickets.pr_base');
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
});

// ── age ─────────────────────────────────────────────────────────────────────
suite('drift-needed — age is the second test, and it says so');

test('a 3-day-old plan on a quiet base is needed, by age', () => {
  const w = build({ tickets: 1, planAgeDays: 3 });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
  assert.ok(/older than 2 day/.test(r.json.reason), r.json.reason);
  assert.ok(r.json.age_days >= 3, `age_days=${r.json.age_days}`);
});

test('a 1-day-old plan on a quiet base is not', () => {
  const w = build({ tickets: 1, planAgeDays: 1 });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
});

test('drift_max_age_days is honoured from pipeline.*', () => {
  const w = build({ tickets: 1, planAgeDays: 3, config: { pipeline: { drift_max_age_days: 5 } } });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.max_age_days, 5);
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
});

test('delivery_pipeline.* wins over pipeline.*, as everywhere else', () => {
  const w = build({
    tickets: 1, planAgeDays: 3,
    config: { pipeline: { drift_max_age_days: 5 }, delivery_pipeline: { drift_max_age_days: 1 } },
  });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.max_age_days, 1);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
});

test('a moved base is reported ahead of age when both are true', () => {
  const w = build({ tickets: 1, moved: [1], planAgeDays: 3 });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, true);
  assert.ok(/src\/mod01/.test(r.json.reason), r.json.reason);
});

// ── unknown is not clean ────────────────────────────────────────────────────
suite('drift-needed — unknown is not clean');

test('a base that resolves to no commit answers needed, naming the failure', () => {
  const w = build({ tickets: 1, base: 'epic/does-not-exist' });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
  assert.ok(/epic\/does-not-exist/.test(r.json.reason), r.json.reason);
  assert.ok(/resolve/i.test(r.json.reason), r.json.reason);
});

test('a ticket with no recorded base at all answers needed', () => {
  const w = build({ tickets: 1, base: null });
  // strip pr_base too, so nothing is left to measure against
  const tj = path.join(w.graph, 'tickets.json');
  const raw = JSON.parse(fs.readFileSync(tj, 'utf8'));
  raw.tickets['T-01-01'].pr_base = null;
  raw.tickets['T-01-01'].epic = null;
  fs.writeFileSync(tj, JSON.stringify(raw, null, 2));
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
  assert.ok(/state-sync/.test(r.json.reason), r.json.reason);
});

test('an untracked plan is dated by its mtime, not treated as unknown', () => {
  // The proving ground keeps `.planning/` out of git, so `git log -- <plan>`
  // reports nothing at all for every ticket in the project.
  const w = build({ tickets: 1 });
  const rel = '.planning/phases/01-demo/01-99-PLAN.md';
  fs.writeFileSync(path.join(w.proj, rel), '# never committed\n');
  const tj = path.join(w.graph, 'tickets.json');
  const raw = JSON.parse(fs.readFileSync(tj, 'utf8'));
  raw.tickets['T-01-01'].plan = rel;
  fs.writeFileSync(tj, JSON.stringify(raw, null, 2));
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.plan_time_source, 'mtime');
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
});

test('a cross-repo ticket with no local checkout is unknown, not clean', () => {
  const w = build({ tickets: 1 });
  const tj = path.join(w.graph, 'tickets.json');
  const raw = JSON.parse(fs.readFileSync(tj, 'utf8'));
  raw.tickets['T-01-01'].repo = 'acme/other';
  fs.writeFileSync(tj, JSON.stringify(raw, null, 2));
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
  assert.ok(/acme\/other/.test(r.json.reason), r.json.reason);
});

test('a plan file that is not there answers needed rather than fresh', () => {
  const w = build({ tickets: 1 });
  fs.rmSync(path.join(w.proj, w.planRel(1)));
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
});

test('an unknown ticket is an error, not a verdict', () => {
  const w = build({ tickets: 1 });
  const r = run(w, ['T-99-99', '--json']);
  assert.strictEqual(r.status, 1);
  assert.ok(/T-99-99/.test(r.stderr), r.stderr);
});

test('a corrupt delivery-state.json answers needed, not a silent fallback to pr_base', () => {
  // A file that exists but fails to parse is a DIFFERENT fact than a file that
  // is simply absent: the latter has a defined fallback (pr_base/epic), the
  // former means the recorded base is unknown, and unknown is not clean —
  // exactly the rule this whole ticket exists to apply consistently.
  const w = build({ tickets: 1 });
  fs.writeFileSync(path.join(w.graph, 'delivery-state.json'), '{ this is not json');
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
  assert.ok(/delivery-state\.json/.test(r.json.reason), r.json.reason);
  assert.ok(/not valid JSON/.test(r.json.reason), r.json.reason);
});

test('a second positional argument is a caller mistake, not a second ticket to ignore', () => {
  const w = build({ tickets: 2 });
  const r = run(w, ['T-01-01', 'T-01-02', '--json']);
  assert.strictEqual(r.status, 1);
  assert.ok(/unexpected argument/.test(r.stderr), r.stderr);
  assert.ok(/T-01-02/.test(r.stderr), r.stderr);
});

test('no ticket graph at all exits 2 with the flag that fixes it', () => {
  const w = build({ tickets: 1 });
  const r = spawnSync(process.execPath, [SCRIPT, 'T-01-01', '--json'], {
    cwd: w.dir, encoding: 'utf8', env: w.env,
  });
  assert.strictEqual(r.status, 2);
  assert.ok(/--graph/.test(r.stderr), r.stderr);
});

test('--graph with a flag for a value is refused, not resolved', () => {
  const w = build({ tickets: 1 });
  const r = spawnSync(process.execPath, [SCRIPT, 'T-01-01', '--graph', '--json'], {
    cwd: w.proj, encoding: 'utf8', env: w.env,
  });
  assert.notStrictEqual(r.status, 0);
  assert.ok(/--graph needs a directory/.test(r.stderr), r.stderr);
});

// ── the fetch, which is the difference between a real answer and a stale one ─
suite('drift-needed — origin/<base> is only as current as the last fetch');

test('a checkout that has not fetched still sees what landed on origin', () => {
  const w = build({ tickets: 1, moved: [1], staleRemote: true });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.fetched, true, JSON.stringify(r.json));
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
});

test('--no-fetch reproduces the stale answer, which is why the fetch is there', () => {
  const w = build({ tickets: 1, moved: [1], staleRemote: true });
  const r = run(w, ['T-01-01', '--json', '--no-fetch']);
  assert.strictEqual(r.json.fetched, false);
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
});

test('a fetch that FAILED is said out loud, because the answer may then be stale', () => {
  const w = build({ tickets: 1, moved: [1], staleRemote: true });
  fs.rmSync(w.origin, { recursive: true, force: true });   // offline / origin unreachable
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.fetched, false);
  // it still answers — a waiter that dies on an unreachable origin is worse —
  // but it must not present a possibly-behind ref as a clean bill of health
  assert.ok(/fetch/.test(r.json.reason), r.json.reason);
});

// ── a glob does not reach git as-is ─────────────────────────────────────────
suite('drift-needed — a glob in files_modified is scoped, not passed through');

test('a glob path is scoped to its pre-glob-prefix directory, and a sibling under it still counts', () => {
  // scope-gate.cjs / validate-graph.cjs / base-merge.cjs already cut a
  // declaration at its first wildcard for ownership purposes (ADR-004 D1);
  // this proves drift-needed.cjs's OWN scan scope follows the same rule
  // rather than handing git a pathspec whose glob semantics this script does
  // not control.
  const w = build({ tickets: 2, moved: [1], files: (i) => (i === 1 ? ['src/mod01/**/*.ts'] : ['src/mod02/impl.cjs']) });
  const r = run(w, ['T-01-01', '--json']);
  assert.deepStrictEqual(r.json.scan_paths, ['src/mod01']);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
});

test('a glob that lands mid-filename scopes to the directory above it, not the partial name', () => {
  const w = build({ tickets: 1, files: () => ['src/mod01/impl*.cjs'] });
  const r = run(w, ['T-01-01', '--json']);
  assert.deepStrictEqual(r.json.scan_paths, ['src/mod01']);
});

// ── the log cap bounds what was READ, not what happened ─────────────────────
suite('drift-needed — hitting the log cap is unknown, not fresh');

test('hitting the log cap answers needed, not fresh, when nothing was found in what was read', () => {
  const w = build({ tickets: 1 });
  // More than LOG_CAP (500) first-parent commits that GENUINELY touch the
  // scanned path, all dated BEFORE the plan (so none would set `movedAt` even
  // if read in full) — enough to fill the `-n500` output on their own. A real
  // repository could bury a POST-plan match behind that many pre-plan ones
  // whenever committer dates are not strictly increasing (the same
  // out-of-order-dates risk `SINCE_MARGIN_SEC`'s own comment already names for
  // merge commits); this proves the script answers `needed` when the read hit
  // the cap, rather than trusting a `null` it cannot actually vouch for.
  //
  // Built via ONE `git fast-import` stream (505 commits) rather than 505
  // separate git invocations — the same repository shape at a fraction of the
  // process-spawn cost, which matters here: `make test-fast` is meant to run
  // in seconds, and a per-commit subprocess loop at this count alone pushed a
  // single test past a minute.
  const ts = w.planTs - 100;
  const when = `${ts} +0000`;
  const lines = [];
  let parentMark = null;
  const NOISE_COMMITS = 505; // > the script's own LOG_CAP (500)
  for (let i = 1; i <= NOISE_COMMITS; i++) {
    lines.push(
      `commit refs/heads/${EPIC}`,
      `mark :${i}`,
      `author Drift Test <drift@example.com> ${when}`,
      `committer Drift Test <drift@example.com> ${when}`,
      `data <<COMMITMSG`,
      `noise ${i}`,
      `COMMITMSG`,
      ...(parentMark ? [`from ${parentMark}`] : [`from ${EPIC}^0`]),
      `M 100644 inline src/mod01/noise.txt`,
      `data <<BLOB`,
      `noise ${i}`,
      `BLOB`,
      '',
    );
    parentMark = `:${i}`;
  }
  lines.push(`reset refs/heads/${EPIC}`, `from ${parentMark}`, '');
  const importStream = lines.join('\n');
  const imported = spawnSync('git', ['-C', w.proj, 'fast-import', '--quiet'], { input: importStream, env: w.env });
  assert.strictEqual(imported.status, 0, (imported.stderr || '').toString());
  const noise = spawnSync('git', ['-C', w.proj, 'push', '-q', 'origin', EPIC], { env: w.env });
  assert.strictEqual(noise.status, 0, noise.stderr);
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, true, JSON.stringify(r.json));
  assert.ok(/log cap/.test(r.json.reason), r.json.reason);
});

// ── the measurement, encoded ────────────────────────────────────────────────
suite('drift-needed — the measured session (2026-09-07)');

test('17 tickets, a quiet integration branch, 4 siblings landed in the epic → 4 needed, 13 not', () => {
  const w = build({ tickets: 17, moved: [1, 2, 3, 4] });
  const verdicts = [];
  for (let i = 1; i <= 17; i++) {
    const r = run(w, [w.id(i), '--json']);
    assert.strictEqual(r.status, 0, `${w.id(i)}: ${r.stderr}`);
    verdicts.push([w.id(i), r.json.needed]);
  }
  const needed = verdicts.filter(([, v]) => v).map(([k]) => k);
  const not = verdicts.filter(([, v]) => !v).map(([k]) => k);
  assert.deepStrictEqual(needed, ['T-01-01', 'T-01-02', 'T-01-03', 'T-01-04'],
    `needed=${needed.join(',')}`);
  assert.strictEqual(not.length, 13, `not-needed=${not.length}`);
});

// ── shape and ergonomics ────────────────────────────────────────────────────
suite('drift-needed — shape');

test('the JSON carries every field the contract names', () => {
  const w = build({ tickets: 1 });
  const r = run(w, ['T-01-01', '--json']);
  for (const k of ['needed', 'reason', 'base', 'plan_time', 'base_moved_at']) {
    assert.ok(k in r.json, `missing ${k} in ${JSON.stringify(r.json)}`);
  }
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(r.json.plan_time), r.json.plan_time);
});

test('without --json it prints a line a human can read, and still exits 0', () => {
  const w = build({ tickets: 1, moved: [1] });
  const r = run(w, ['T-01-01']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/T-01-01/.test(r.stdout), r.stdout);
  assert.ok(/needed/i.test(r.stdout), r.stdout);
});

test('the graph is found from the project cwd with no flag', () => {
  const w = build({ tickets: 1 });
  const r = run(w, ['T-01-01', '--json'], { cwd: w.proj });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
});

test('a root-level declared file does not make the whole repository its scope', () => {
  // dirname('README.md') is the repo root; measuring that would report every
  // commit anywhere as drift and the ticket would never be fresh.
  const w = build({ tickets: 1, moved: [1], files: () => ['README.md'] });
  const r = run(w, ['T-01-01', '--json']);
  assert.strictEqual(r.json.needed, false, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.scan_paths, ['README.md']);
});

test('the header names the prose it supersedes', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8').slice(0, 6000);
  assert.ok(/deliver\.md/.test(src), 'the header must name deliver.md');
  assert.ok(/Step 2/.test(src), 'the header must name Step 2');
  assert.ok(/T-26-12/.test(src), 'the header must name the current owner of deliver.md');
});

done();
