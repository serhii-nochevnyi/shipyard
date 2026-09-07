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
const path = require('path');
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

done();
