'use strict';

// The two fan-out workflow scripts swallowed their own input errors. `args`
// arrives from the runtime as a JSON STRING often enough that both files
// normalize for it (2026-07-28), and both did it with `catch { return {} }` —
// so `args = '{invalid'` became `{}`, `argv.tickets || []` became an empty
// wave, and the script returned `[]`: no agent dispatched, no error raised, a
// board that reads as finished. Audit F25 reproduced exactly that.
//
// The mirror of it sits at the other end of the run: the fan-out returns an
// ARRAY, and a shorter array is indistinguishable from a shorter wave unless
// something counts. Both scripts already map a dead or throwing agent to a
// verdict of its own, so a missing id is never the agent — it is the plumbing,
// and an agent that never reported is a failed run, not a smaller one.
//
// These files cannot be `require`d or `node --check`ed: the Workflow DSL's
// top-level `return`/`await` is a syntax error outside a function body. The
// runtime wraps the source in an ASYNC function with `agent`/`parallel`/
// `phase`/`log`/`args` in scope — tests/smoke/overlay-image-smoke.sh
// replicates that wrap to syntax-check them — so this harness does the same.
// The plan names `new Function('agent','parallel','phase','log','args', src)`;
// the constructor used here is the async Function constructor with that exact
// parameter list, because plain `new Function` rejects `return await
// parallel(...)` outright. Same wrap, same five bindings.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const WORKFLOWS = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'workflows'
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function load(name) {
  const src = fs.readFileSync(path.join(WORKFLOWS, `${name}.mjs`), 'utf8')
    // the one module-level construct the runtime's wrap strips, mirrored from
    // the smoke test's canary (`sed 's/^export const meta/const meta/'`)
    .replace(/^export const meta/m, 'const meta');
  return new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', src);
}

// `results` rewrites what the fan-out hands back AFTER every thunk has run.
// That is the only way an id can go missing: both `.then` branches in both
// scripts force `id: t.id` onto whatever the agent returned, so a stubbed
// `agent` cannot itself produce a gap — only `parallel` can. The stub always
// invokes the thunks, so what is under test is the fan-out and not array
// arithmetic.
function harness({ agent, results = (all) => all } = {}) {
  const calls = [];
  return {
    calls,
    agent: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return agent ? agent(prompt, opts) : {};
    },
    parallel: async (thunks) => results(await Promise.all(thunks.map((f) => f()))),
    phase: () => {},
    log: () => {},
  };
}

async function run(name, args, opts) {
  const h = harness(opts);
  const value = await load(name)(h.agent, h.parallel, h.phase, h.log, args);
  return { value, calls: h.calls };
}

// Returns the thrown error. A resolved call is the failure being guarded
// against, so it is reported with the value it resolved to.
async function rejects(name, args, opts) {
  let value;
  try {
    ({ value } = await run(name, args, opts));
  } catch (e) {
    return e;
  }
  throw new assert.AssertionError({
    message: `${name}.mjs: expected a throw, resolved to ${JSON.stringify(value)}`,
  });
}

const parseErrorOf = (s) => {
  try {
    JSON.parse(s);
  } catch (e) {
    return e.message;
  }
  return '';
};

const TICKETS = [
  { id: 'T-99-01', planPath: '/p/99-01-PLAN.md', branch: 'ticket/T-99-01', prBase: 'epic/99' },
  { id: 'T-99-02', planPath: '/p/99-02-PLAN.md', branch: 'ticket/T-99-02', prBase: 'epic/99' },
  { id: 'T-99-03', planPath: '/p/99-03-PLAN.md', branch: 'ticket/T-99-03', prBase: 'epic/99' },
];

// Each script's own required args, beside `tickets`. drift-gate refuses
// without `driftRefPath`, so its cases carry one.
const SCRIPTS = [
  { name: 'executors', base: {} },
  { name: 'drift-gate', base: { driftRefPath: '/plugin/references/drift-check.md' } },
];

for (const { name, base } of SCRIPTS) {
  const args = (tickets) => ({ ...base, tickets });

  suite(`${name}.mjs — args validation before dispatch`);

  test('a malformed JSON string throws, carrying the parse error', async () => {
    const e = await rejects(name, '{invalid');
    assert.match(e.message, /not valid JSON/);
    assert.ok(
      e.message.includes(parseErrorOf('{invalid')),
      `parse error not carried into: ${e.message}`
    );
  });

  test('a valid JSON string is still tolerated (the 2026-07-28 runtime shape)', async () => {
    const { value, calls } = await run(name, JSON.stringify(args([TICKETS[0]])));
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(value.map((r) => r.id), ['T-99-01']);
  });

  test('an explicitly empty list returns [] and dispatches nothing', async () => {
    const { value, calls } = await run(name, args([]));
    assert.deepStrictEqual(value, []);
    assert.strictEqual(calls.length, 0);
  });

  test('args that is not an object throws naming args', async () => {
    for (const bad of [42, 'null', undefined, null, [TICKETS[0]]]) {
      const e = await rejects(name, bad);
      assert.match(e.message, /args must be an object/);
    }
  });

  test('a missing tickets list throws naming the field', async () => {
    const e = await rejects(name, { ...base });
    assert.match(e.message, /args\.tickets/);
  });

  test('a tickets value that is not an array throws naming the field', async () => {
    for (const bad of [{}, 'T-99-01', 3, null]) {
      const e = await rejects(name, { ...base, tickets: bad });
      assert.match(e.message, /args\.tickets/);
    }
  });

  suite(`${name}.mjs — every dispatch is accounted for`);

  test('a full fan-out returns one result per ticket', async () => {
    const { value, calls } = await run(name, args(TICKETS));
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(value.map((r) => r.id), ['T-99-01', 'T-99-02', 'T-99-03']);
  });

  test('a dropped result fails the run and names the missing ticket', async () => {
    // `dispatched` proves the gap is the fan-out's and not the test's: all
    // three thunks ran and produced a result, and only the array shrank.
    let dispatched = 0;
    const h = {
      results: (all) => {
        dispatched = all.length;
        return all.filter((_, i) => i !== 1);
      },
    };
    const e = await rejects(name, args(TICKETS), h);
    assert.strictEqual(dispatched, 3);
    assert.match(e.message, /T-99-02/);
    // the other two are accounted for and must not be blamed
    assert.ok(!/T-99-01/.test(e.message), `wrongly named T-99-01: ${e.message}`);
    assert.ok(!/T-99-03/.test(e.message), `wrongly named T-99-03: ${e.message}`);
  });

  test('exactly once — a duplicated result is as bad as a missing one', async () => {
    const h = { results: (all) => [all[0], all[0], all[2]] };
    const e = await rejects(name, args(TICKETS), h);
    assert.match(e.message, /T-99-01/);
    assert.match(e.message, /T-99-02/);
  });

  test('a non-array from the fan-out fails the run', async () => {
    const e = await rejects(name, args(TICKETS), { results: () => undefined });
    assert.match(e.message, /T-99-01/);
  });

  test('a surplus result the caller never dispatched fails the run, even with every requested id present', async () => {
    // Copilot review on PR #36: the "exactly once" check only walked the
    // DISPATCHED ids, so an extra result riding along beside all three
    // correct ones passed silently — every requested ticket accounted for,
    // plus a foreign id nothing downstream has a dispatch record for.
    const h = { results: (all) => [...all, { id: 'T-99-99' }] };
    const e = await rejects(name, args(TICKETS), h);
    assert.match(e.message, /T-99-99/);
    // the three legitimately dispatched tickets are not blamed
    assert.ok(!/T-99-01/.test(e.message), `wrongly named T-99-01: ${e.message}`);
    assert.ok(!/T-99-02/.test(e.message), `wrongly named T-99-02: ${e.message}`);
    assert.ok(!/T-99-03/.test(e.message), `wrongly named T-99-03: ${e.message}`);
  });
}

suite('executors.mjs — a dead or throwing agent is still a result');

test('a null agent result is a blocked verdict, not a gap', async () => {
  const { value } = await run('executors', { tickets: TICKETS }, { agent: async () => null });
  assert.strictEqual(value.length, 3);
  assert.deepStrictEqual([...new Set(value.map((r) => r.status))], ['blocked']);
});

suite('drift-gate.mjs — a dead or throwing judge is still a verdict');

test('a throwing judge is a drifted verdict, not a gap', async () => {
  const { value } = await run(
    'drift-gate',
    { tickets: TICKETS, driftRefPath: '/x/drift-check.md' },
    { agent: async () => { throw new Error('judge exploded'); } }
  );
  assert.strictEqual(value.length, 3);
  assert.deepStrictEqual([...new Set(value.map((v) => v.verdict))], ['drifted']);
});

// T-26-14 — executors.mjs returns a REFERENCE to the two documents it makes
// the agent write in its own worktree (the workflow script itself has no
// filesystem access — the dispatched subagent does, and it is the one
// writing them), not the documents themselves. Measured 2026-09-07: the
// twenty largest tool results in an 8.8MB orchestrator transcript were 38%
// of all tool-result bytes, every one a workflow completion carrying `prBody`
// and `evidence` inline (up to 37k characters), re-sent on every later turn.
suite('executors.mjs — a returned reference, not a document (T-26-14)');

test('a committed ticket returns paths and a short summary, never the documents, and summary never exceeds 500 chars', async () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-executors-'));
  try {
    // Stand-in for the real subagent: it has file access the workflow script
    // does not, so it writes the two documents; the workflow only ever gets
    // paths and a short summary back. Sized past today's observed 11k-char
    // prBody and the 500-char cap on `summary`, to prove both boundaries hold.
    const longPrBody = `Ticket: T-99-01\n${'x'.repeat(11000)}`;
    const longEvidence = `$ node tests/unit/x.test.cjs\n${'y'.repeat(9000)}`;
    const longSummary = 'z'.repeat(900);
    const ticket = { id: 'T-99-01', planPath: '/p/99-01-PLAN.md', branch: 'ticket/T-99-01', prBase: 'epic/99', worktreePath };
    const stubAgent = async (prompt) => {
      // The real agent is told exactly where to write — assert the prompt
      // actually names both paths, so a future edit can't drop the instruction
      // while leaving the workflow's own path formula unchanged.
      assert.ok(prompt.includes(path.join(worktreePath, '.shipyard-pr-body.md')), 'prompt must name the PR-body path');
      assert.ok(prompt.includes(path.join(worktreePath, '.shipyard-evidence.md')), 'prompt must name the evidence path');
      fs.writeFileSync(path.join(worktreePath, '.shipyard-pr-body.md'), longPrBody);
      fs.writeFileSync(path.join(worktreePath, '.shipyard-evidence.md'), longEvidence);
      return { id: ticket.id, status: 'committed', summary: longSummary };
    };
    const { value } = await run('executors', { tickets: [ticket] }, { agent: stubAgent });
    assert.strictEqual(value.length, 1);
    const r = value[0];
    // Only `summary` carries a length guarantee (Copilot review on PR #49):
    // `prBodyPath`/`evidencePath` are `worktreePath` plus a fixed suffix, so
    // their length follows the worktree's own path and is not this script's
    // to bound — asserting a blanket cap over every string field was true
    // here only by accident of `worktreePath` being a short mkdtemp path.
    assert.ok(r.summary.length <= 500, `summary is ${r.summary.length} chars, over the 500-char cap`);
    assert.strictEqual(r.status, 'committed');
    assert.ok(!('prBody' in r), 'prBody must not cross back — that is the whole point of this ticket');
    assert.ok(!('evidence' in r), 'evidence text must not cross back — that is the whole point of this ticket');
    assert.ok(path.isAbsolute(r.prBodyPath), `prBodyPath must be absolute: ${r.prBodyPath}`);
    assert.ok(r.prBodyPath.startsWith(worktreePath), `prBodyPath must be inside the worktree: ${r.prBodyPath}`);
    assert.ok(r.evidencePath.startsWith(worktreePath), `evidencePath must be inside the worktree: ${r.evidencePath}`);
    assert.strictEqual(
      fs.readFileSync(r.prBodyPath, 'utf8'), longPrBody,
      'prBodyPath content must be byte-identical to what prBody used to carry, so gh pr create --body-file needs no other change'
    );
    assert.strictEqual(
      fs.readFileSync(r.evidencePath, 'utf8'), longEvidence,
      'evidencePath content must be byte-identical to what evidence used to carry'
    );
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('a blocked ticket returns its reason inline — no file, no path, the loop acts without a file read', async () => {
  const ticket = { id: 'T-99-02', planPath: '/p/99-02-PLAN.md', branch: 'ticket/T-99-02', prBase: 'epic/99', worktreePath: '/does/not/exist' };
  const reason = 'the plan requires editing deliver.md, which is out of files_modified';
  const { value } = await run('executors', { tickets: [ticket] }, {
    agent: async () => ({ id: ticket.id, status: 'blocked', summary: reason }),
  });
  assert.strictEqual(value.length, 1);
  const r = value[0];
  assert.strictEqual(r.status, 'blocked');
  assert.strictEqual(r.summary, reason);
  assert.strictEqual(r.prBodyPath, '', 'a blocked ticket writes no PR body');
  assert.strictEqual(r.evidencePath, '', 'a blocked ticket writes no evidence file');
});

test('a dead or throwing agent still returns a capped reason inline, with no worktreePath required', async () => {
  const ticket = { id: 'T-99-03', planPath: '/p/99-03-PLAN.md', branch: 'ticket/T-99-03', prBase: 'epic/99' };
  const dead = await run('executors', { tickets: [ticket] }, { agent: async () => null });
  assert.strictEqual(dead.value[0].status, 'blocked');
  assert.ok(dead.value[0].summary.length <= 500);
  assert.strictEqual(dead.value[0].prBodyPath, '');

  const threw = await run('executors', { tickets: [ticket] }, { agent: async () => { throw new Error('boom'); } });
  assert.strictEqual(threw.value[0].status, 'blocked');
  assert.match(threw.value[0].summary, /boom/);
});

// ── THE DISPATCH DEFAULTS ARE THE LADDER'S ANSWER (T-27-01, ADR-006 D1) ──────
//
// `pipeline-config.cjs` is the single source for "which tier and how deep" — and
// the WORKFLOW PATH is the only path where `effort` is enforced at all, because
// the Agent tool carries no such parameter. So a literal in one of these scripts
// is not a harmless fallback: it is the effort a judge or a fixer actually thinks
// at whenever the caller omits one, and nothing else in the system would notice
// it disagreeing with the policy. `drift-gate.mjs` shipped `effort: 'low'` with
// the comment "cheap effort on purpose" while the ladder had moved drift-check to
// `high` — the role now expected to notice a plan the codebase has outgrown,
// which is the work the executor stopped doing.
//
// Resolved in a CONFIG-FREE temp cwd, through the CLI the skills themselves call:
// `pipeline-config.cjs` reads `process.cwd()` and nothing else, so this pins
// SHIPPED policy rather than whatever this checkout happens to be tuned to.
//
// Two designs are legitimate here and the table records WHICH each file uses,
// because a silent move between them is the drift this suite exists to catch:
//
//   'default'  the script carries a literal — allowed only where the role's row
//              is constant, and it must equal the row (drift-check → high);
//   'caller'   the script passes no effort at all and the orchestrator's resolved
//              value is the only one in force. Required where the row is keyed on
//              a signal a literal cannot express: the executor's is `xhigh` at
//              `--risk high` or `--checkpoint`, so any literal there would be
//              wrong for half the board.
suite('workflows/*.mjs — model and effort defaults equal the ladder\'s answer');

const CONFIG_FREE = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-ladder-'));
const RESOLVER = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs'
);
function policyFor(role) {
  const r = spawnSync(process.execPath, [RESOLVER, 'model', role, '--json'],
    { cwd: CONFIG_FREE, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, `pipeline-config model ${role} exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const PR = {
  id: 'T-99-01', pr: 7, branch: 'ticket/T-99-01', worktreePath: '/w/T-99-01',
  planPath: '/p/99-01-PLAN.md', needsCiFix: true, needsReviewFix: true,
};
const DISPATCH = [
  {
    name: 'executors',
    // One agent per ticket, so one ticket is one dispatch to read the opts off.
    args: (over = {}) => ({ tickets: [{ ...TICKETS[0], ...over }] }),
    roles: ['executor'],
    effort: 'caller',
  },
  {
    name: 'fix-round',
    args: (over = {}) => ({
      prs: [{ ...PR, ...over }],
      ciFixRefPath: '/x/ci-fix.md', reviewFixRefPath: '/x/review-fix.md',
      reinitScript: '/x/scripts/reviewers.cjs',
    }),
    // One fixer owns both roles for a round, so both must resolve to the tier it
    // is dispatched at — that is the premise the single agent rests on.
    roles: ['ci-fix', 'review-fix'],
    effort: 'caller',
  },
  {
    name: 'drift-gate',
    args: (over = {}) => ({
      tickets: [{ ...TICKETS[0], ...over }],
      driftRefPath: '/x/drift-check.md',
    }),
    roles: ['drift-check'],
    effort: 'default',
  },
];

for (const spec of DISPATCH) {
  const optsOf = async (over) => {
    const { calls } = await run(spec.name, spec.args(over));
    assert.strictEqual(calls.length, 1, `${spec.name}: expected exactly one dispatch`);
    return calls[0].opts;
  };

  test(`${spec.name}.mjs dispatches at the tier the ladder resolves for ${spec.roles.join('/')}`, async () => {
    const policies = spec.roles.map((role) => ({ role, ...policyFor(role) }));
    // A file that dispatches two roles from one agent needs them to agree; if
    // they ever stop agreeing, this file needs two agents and not a new literal.
    const tiers = [...new Set(policies.map((p) => p.model))];
    assert.strictEqual(tiers.length, 1,
      `${spec.name}: ${spec.roles.join('/')} resolve to different tiers (${tiers.join(', ')}) — one agent cannot carry both`);
    const opts = await optsOf();
    assert.strictEqual(opts.model, tiers[0],
      `${spec.name}: dispatches model "${opts.model}", the ladder says "${tiers[0]}"`);
  });

  if (spec.effort === 'default') {
    test(`${spec.name}.mjs carries an effort default, and it is the ladder's row`, async () => {
      const want = policyFor(spec.roles[0]).effort;
      const opts = await optsOf();
      // PRESENT is half the assertion: on this path `effort` is the only place
      // depth is enforced, so dropping the key hands the judge the runtime's
      // default and nothing anywhere would say so.
      assert.ok('effort' in opts,
        `${spec.name}: no effort default — the ${spec.roles[0]} row (${want}) would not be in force`);
      assert.strictEqual(opts.effort, want,
        `${spec.name}: dispatches effort "${opts.effort}", the ladder says "${want}"`);
    });

    test(`${spec.name}.mjs still lets the caller's resolved effort win`, async () => {
      const opts = await optsOf({ effort: 'xhigh' });
      assert.strictEqual(opts.effort, 'xhigh',
        'the orchestrator resolves per dispatch (a signal-keyed row, a repeated signature); the literal is only the floor');
    });
  } else {
    test(`${spec.name}.mjs passes NO effort literal — the row it dispatches is signal-keyed`, async () => {
      const opts = await optsOf();
      assert.ok(!('effort' in opts),
        `${spec.name}: a literal cannot express a signal-keyed row (executor: xhigh at --risk high), `
        + `so this file must carry none — got "${opts.effort}"`);
    });

    test(`${spec.name}.mjs passes the caller's resolved effort straight through`, async () => {
      const want = policyFor(spec.roles[0]).effort;
      const opts = await optsOf({ effort: want });
      assert.strictEqual(opts.effort, want, 'the ladder reaches the dispatch, or the table is decorative');
    });
  }
}

// ── ONE DISPATCH, ONE BASE (T-27-06) ────────────────────────────────────────
//
// `baseRef` was ONE value for a whole round. In epic-stacked delivery that is
// wrong by construction: a root ticket's base is the phase epic, a dependent
// ticket's base is its primary parent's BRANCH, and two tickets picked in the
// same round routinely differ. Measured 2026-09-08 dispatching T-26-03
// (base `ticket/T-26-15-…`) beside T-25-03 (base `ticket/T-25-02-…`, another
// phase): the round had to be split into two invocations, one per base, or the
// judges would be handed a diff dominated by the work each ticket is
// deliberately stacked on. `drift-needed.cjs:257` already resolves the
// per-ticket base — the value is on the board at the call site, so the args
// contract is the only thing that was missing.

suite('drift-gate.mjs — one dispatch carries one base (T-27-06)');

const driftArgs = (tickets, over = {}) => ({
  tickets, driftRefPath: '/x/drift-check.md', ...over,
});
const promptFor = (calls, id) => {
  const c = calls.find((x) => x.opts && x.opts.label === `drift:${id}`);
  assert.ok(c, `no dispatch for ${id}`);
  return c.prompt;
};

test('a mixed-base cascade dispatches each judge with ITS OWN baseRef', async () => {
  const { calls } = await run('drift-gate', driftArgs([
    { ...TICKETS[0], baseRef: 'origin/ticket/T-26-15-a' },
    { ...TICKETS[1], baseRef: 'origin/ticket/T-25-02-b' },
  ]));
  assert.strictEqual(calls.length, 2);
  const a = promptFor(calls, 'T-99-01');
  const b = promptFor(calls, 'T-99-02');
  assert.ok(a.includes('origin/ticket/T-26-15-a'), `T-99-01 must be judged against its own base: ${a}`);
  assert.ok(!a.includes('origin/ticket/T-25-02-b'), 'and never against the other ticket\'s base');
  assert.ok(b.includes('origin/ticket/T-25-02-b'), `T-99-02 must be judged against its own base: ${b}`);
  assert.ok(!b.includes('origin/ticket/T-26-15-a'), 'and never against the other ticket\'s base');
});

test('the round-level baseRef stays the FALLBACK, so no existing caller breaks', async () => {
  const { calls } = await run('drift-gate', driftArgs(
    [TICKETS[0], { ...TICKETS[1], baseRef: 'origin/epic/25-x' }],
    { baseRef: 'origin/main' }
  ));
  assert.ok(promptFor(calls, 'T-99-01').includes('origin/main'), 'a ticket with no base of its own takes the round\'s');
  const b = promptFor(calls, 'T-99-02');
  assert.ok(b.includes('origin/epic/25-x'), 'and a ticket that carries one wins over it');
  assert.ok(!b.includes('origin/main'), `the fallback must not ride along beside it: ${b}`);
});

test('no base anywhere is still legal, and says nothing about a ref it does not have', async () => {
  const { calls } = await run('drift-gate', driftArgs([TICKETS[0]]));
  const p = promptFor(calls, 'T-99-01');
  assert.ok(/Has landed/.test(p), p);
  assert.ok(!/\(\)/.test(p), `an absent base must not print an empty parenthesis: ${p}`);
});

done();
