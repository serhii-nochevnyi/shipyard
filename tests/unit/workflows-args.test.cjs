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
// parallel(...)` outright. `__require` is the test host's explicit module
// bridge; the native Workflow host may inject the same bridge without putting
// a module import expression in the DSL source.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { createDispatchBoundary } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const {
  CLAUDE_MODEL_ALIASES,
  createClaudeDispatchAdapter,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');

const WORKFLOWS = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'workflows'
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function load(name) {
  const src = fs.readFileSync(path.join(WORKFLOWS, `${name}.mjs`), 'utf8')
    // the one module-level construct the runtime's wrap strips, mirrored from
    // the smoke test's canary (`sed 's/^export const meta/const meta/'`)
    .replace(/^export const meta/m, 'const meta');
  return new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', '__require', src);
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
  const value = await load(name)(h.agent, h.parallel, h.phase, h.log, args, require);
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
  { id: 'T-99-01', planPath: '/p/99-01-PLAN.md', branch: 'ticket/T-99-01', prBase: 'epic/99', model: 'sonnet', effort: 'max' },
  { id: 'T-99-02', planPath: '/p/99-02-PLAN.md', branch: 'ticket/T-99-02', prBase: 'epic/99', model: 'sonnet', effort: 'max' },
  { id: 'T-99-03', planPath: '/p/99-03-PLAN.md', branch: 'ticket/T-99-03', prBase: 'epic/99', model: 'sonnet', effort: 'max' },
];

const driftTickets = (tickets) => tickets.map((ticket) => ({
  ...ticket,
  model: 'opus',
  effort: 'max',
}));

// Each script's own required args, beside `tickets`. drift-gate refuses
// without `driftRefPath`, so its cases carry one.
const SCRIPTS = [
  { name: 'executors', base: {} },
  { name: 'drift-gate', base: { driftRefPath: '/plugin/references/drift-check.md' } },
];

for (const { name, base } of SCRIPTS) {
  const args = (tickets) => ({ ...base, tickets: name === 'drift-gate' ? driftTickets(tickets) : tickets });

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
    { tickets: driftTickets(TICKETS), driftRefPath: '/x/drift-check.md' },
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
    const ticket = { id: 'T-99-01', planPath: '/p/99-01-PLAN.md', branch: 'ticket/T-99-01', prBase: 'epic/99', worktreePath, model: 'sonnet', effort: 'max' };
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
  const ticket = { id: 'T-99-02', planPath: '/p/99-02-PLAN.md', branch: 'ticket/T-99-02', prBase: 'epic/99', worktreePath: '/does/not/exist', model: 'sonnet', effort: 'max' };
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
  const ticket = { id: 'T-99-03', planPath: '/p/99-03-PLAN.md', branch: 'ticket/T-99-03', prBase: 'epic/99', model: 'sonnet', effort: 'max' };
  const dead = await run('executors', { tickets: [ticket] }, { agent: async () => null });
  assert.strictEqual(dead.value[0].status, 'blocked');
  assert.ok(dead.value[0].summary.length <= 500);
  assert.strictEqual(dead.value[0].prBodyPath, '');

  const threw = await run('executors', { tickets: [ticket] }, { agent: async () => { throw new Error('boom'); } });
  assert.strictEqual(threw.value[0].status, 'blocked');
  assert.match(threw.value[0].summary, /boom/);
});

// ── BOUNDARY-MEDIATED WORKFLOW LAUNCH INPUT (T-36-05, ADR-014) ──────────────
//
// A Workflow's agent callback is the Claude host launch. It must be reached
// through createClaudeDispatchAdapter/createDispatchBoundary, so model/effort
// values are checked against the role grid and the application receipt is
// recorded before the workflow consumes the agent result.
suite('workflows/*.mjs — explicit resolver model and effort boundary');

const PR = {
  id: 'T-99-01', pr: 7, branch: 'ticket/T-99-01', worktreePath: '/w/T-99-01',
  planPath: '/p/99-01-PLAN.md', needsCiFix: true, needsReviewFix: true,
  model: 'opus', effort: 'medium',
};
const DISPATCH = [
  {
    name: 'executors',
    args: (over = {}) => ({ tickets: [{ ...TICKETS[0], model: 'sonnet', effort: 'max', ...over }] }),
    resolved: { model: 'sonnet', effort: 'max' },
  },
  {
    name: 'fix-round',
    args: (over = {}) => ({
      prs: [{ ...PR, model: 'opus', effort: 'medium', ...over }],
      ciFixRefPath: '/x/ci-fix.md', reviewFixRefPath: '/x/review-fix.md',
      reinitScript: '/x/scripts/reviewers.cjs',
    }),
    resolved: { model: 'opus', effort: 'medium' },
  },
  {
    name: 'drift-gate',
    args: (over = {}) => ({
      tickets: [{ ...TICKETS[0], model: 'opus', effort: 'max', ...over }],
      driftRefPath: '/x/drift-check.md',
    }),
    resolved: { model: 'opus', effort: 'max' },
  },
];

const recorderFor = (records) => (record) => {
  records.push(record);
  return true;
};

for (const spec of DISPATCH) {
  const runSpec = async (over = {}, withRecorder = false) => {
    const records = [];
    const args = spec.args(over);
    if (withRecorder) args.dispatchRecorder = recorderFor(records);
    const result = await run(spec.name, args);
    return { ...result, records };
  };

  test(`${spec.name}.mjs applies the caller-resolved model and effort only after boundary validation`, async () => {
    const { calls } = await runSpec();
    assert.strictEqual(calls.length, 1, `${spec.name}: expected exactly one boundary-mediated dispatch`);
    assert.strictEqual(calls[0].opts.model, spec.resolved.model);
    assert.strictEqual(calls[0].opts.effort, spec.resolved.effort);
  });

  test(`${spec.name}.mjs records a boundary-verified application receipt before returning`, async () => {
    const { calls, records } = await runSpec({}, true);
    assert.strictEqual(calls.length, 1, `${spec.name}: expected one host launch`);
    assert.strictEqual(records.length, 1, `${spec.name}: expected one persisted dispatch record`);
    assert.strictEqual(records[0].receipt.compliance, 'verified');
    assert.strictEqual(records[0].receipt.applied_model, spec.resolved.model);
    assert.strictEqual(records[0].receipt.applied_effort, spec.resolved.effort);
  });

  test(`${spec.name}.mjs refuses omitted launch values without invoking the host`, async () => {
    const { calls, value } = await runSpec({ model: undefined, effort: undefined });
    assert.strictEqual(calls.length, 0, `${spec.name}: missing selection must fail before agent()`);
    assert.ok(value.length === 1);
    assert.ok(['blocked', 'drifted', 'escalate'].includes(value[0].status || value[0].verdict));
  });
}

test('executor critical selection is resolved by signals and preserves Claude Sonnet/max → Opus/high', async () => {
  const { calls } = await run('executors', {
    tickets: [{ ...TICKETS[0], model: 'opus', effort: 'high', signals: { critical: true } }],
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.model, 'opus');
  assert.strictEqual(calls[0].opts.effort, 'high');
});

test('unsupported or contradictory workflow selections fail closed before agent()', async () => {
  const executor = await run('executors', {
    tickets: [{ ...TICKETS[0], model: 'sonnet', effort: 'xhigh' }],
  });
  assert.strictEqual(executor.calls.length, 0);
  assert.strictEqual(executor.value[0].status, 'blocked');

  const drift = await run('drift-gate', {
    tickets: [{ ...TICKETS[0], model: 'fable', effort: 'high' }],
    driftRefPath: '/x/drift-check.md',
  });
  assert.strictEqual(drift.calls.length, 0);
  assert.strictEqual(drift.value[0].verdict, 'drifted');

  const fix = await run('fix-round', {
    prs: [{ ...PR, model: 'sonnet', effort: 'max' }],
    ciFixRefPath: '/x/ci-fix.md', reviewFixRefPath: '/x/review-fix.md',
    reinitScript: '/x/scripts/reviewers.cjs',
  });
  assert.strictEqual(fix.calls.length, 0);
  assert.strictEqual(fix.value[0].status, 'escalate');
});

suite('strict Claude adapter — native aliases and explicit application evidence (T-36-05)');

const CLAUDE_CAPABILITIES = {
  supportedModels: Object.values(CLAUDE_MODEL_ALIASES),
  supportedEfforts: ['high', 'medium', 'max'],
  observedModel: false,
  observedEffort: false,
};

function claudeFixture(extra = {}) {
  const calls = [];
  const host = {
    capabilities: CLAUDE_CAPABILITIES,
    launch: (selection) => {
      calls.push(selection);
      return {
        launch_id: `claude-launch-${calls.length}`,
        applied_model: selection.model,
        applied_effort: selection.effort,
      };
    },
    ...(extra.host || {}),
  };
  const adapter = createClaudeDispatchAdapter({ ...extra, host });
  const recorder = extra.recorder || (() => true);
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder });
  return { calls, adapter, boundary, recorder };
}

test('Claude receives the canonical native alias and effort for every base role', () => {
  const f = claudeFixture();
  for (const role of policy.ROLES) {
    const result = f.boundary.dispatch({ runtime: 'claude', role });
    const launch = f.calls.at(-1);
    assert.ok(Object.values(CLAUDE_MODEL_ALIASES).includes(launch.model), `${role} must use a Claude alias`);
    assert.ok(!/^gpt-/.test(launch.model), `${role} must not receive a Codex model id`);
    assert.strictEqual(result.applied_model, launch.model);
    assert.strictEqual(result.applied_effort, launch.effort);
    assert.strictEqual(result.observed_model, 'unknown');
    assert.strictEqual(result.observed_effort, 'unknown');
    assert.strictEqual(result.receipt.compliance, 'verified');
  }
});

test('Claude repair launches consume the preceding boundary receipt and preserve the escalated tuple', () => {
  const f = claudeFixture();
  const base = f.boundary.dispatch({ runtime: 'claude', role: 'ci-fix' });
  const repeat = f.boundary.dispatch({
    runtime: 'claude',
    role: 'ci-fix',
    previous_dispatch_id: base.dispatch_id,
    signals: { signatureState: 'repeat', priorApplied: base.receipt },
  });
  assert.deepStrictEqual(f.calls.map((selection) => [selection.model, selection.effort]), [
    ['opus', 'medium'],
    ['opus', 'max'],
  ]);
  assert.strictEqual(repeat.receipt.compliance, 'verified');
  assert.strictEqual(repeat.receipt.applied_model, 'opus');
  assert.strictEqual(repeat.receipt.applied_effort, 'max');
});

test('missing capabilities, launch methods, and application evidence fail closed before dispatch', () => {
  const missingCapabilities = claudeFixture({ capabilities: {} });
  assert.throws(
    () => missingCapabilities.boundary.dispatch({ runtime: 'claude', role: 'executor' }),
    (error) => error.code === 'UNSUPPORTED_SELECTION',
  );
  assert.strictEqual(missingCapabilities.calls.length, 0);

  const missingLaunch = claudeFixture({ host: { launch: undefined } });
  assert.strictEqual(missingLaunch.adapter.launch, undefined, 'missing host.launch must not expose adapter.launch');
  assert.throws(
    () => missingLaunch.boundary.dispatch({ runtime: 'claude', role: 'executor' }),
    (error) => error.code === 'MISSING_ADAPTER',
  );
  assert.strictEqual(missingLaunch.calls.length, 0);

  const reservations = [];
  const missingLaunchWithRecorder = claudeFixture({
    host: { launch: undefined },
    recorder: {
      reserve(dispatchId) {
        reservations.push(dispatchId);
        return { reserved: true };
      },
      record() { return { recorded: true }; },
    },
  });
  assert.throws(
    () => missingLaunchWithRecorder.boundary.dispatch({ runtime: 'claude', role: 'executor' }),
    (error) => error.code === 'MISSING_ADAPTER',
  );
  assert.strictEqual(reservations.length, 0, 'a missing launch method must not reserve a durable dispatch id');

  const badEvidence = claudeFixture({ host: {
    launch: () => ({ launch_id: 'bad', applied_model: 'sonnet', applied_effort: 'low' }),
  } });
  assert.throws(
    () => badEvidence.boundary.dispatch({ runtime: 'claude', role: 'executor' }),
    (error) => error.code === 'NONCOMPLIANT_RECEIPT',
  );
});

test('Claude rejects contradictory, inherited, and stale launch selections', () => {
  const f = claudeFixture();
  for (const context of [
    { model: 'opus' },
    { effort: 'medium' },
    { launch_arguments: { model: 'fable' } },
    { session: { inherit: true } },
  ]) {
    assert.throws(
      () => f.boundary.dispatch({ runtime: 'claude', role: 'executor' }, context),
      (error) => ['CONFLICTING_OVERRIDE', 'UNSUPPORTED_SELECTION'].includes(error.code),
    );
  }
  const resolution = f.boundary.resolve({ runtime: 'claude', role: 'executor', dispatch_id: 'stale-claude' });
  assert.throws(
    () => f.adapter.launch({ ...resolution, policy_hash: 'stale-policy' }),
    (error) => error.code === 'STALE_POLICY',
  );
  assert.strictEqual(f.calls.length, 0);
});

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
  tickets: driftTickets(tickets), driftRefPath: '/x/drift-check.md', ...over,
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
