'use strict';

// The journal is only readable beside its graph — pipeline-stats requires
// tickets.json next to it. So WHERE an event lands is not cosmetic: an event
// filed elsewhere is uncounted, and the directory it creates pollutes whatever
// repository the agent happened to be standing in. That is not hypothetical —
// a ci-fix on a cross-repo ticket left a one-event journal inside a borrowed
// checkout, invisible to every metric that mattered.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'log-event.cjs'
);

function run(cwd, args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-logevent-'));
  const project = path.join(dir, 'project');
  const borrowed = path.join(dir, 'borrowed');
  fs.mkdirSync(path.join(project, '.planning', 'graph'), { recursive: true });
  fs.mkdirSync(borrowed, { recursive: true });
  fs.writeFileSync(path.join(project, '.planning', 'graph', 'tickets.json'), '{"tickets":{}}');
  return { dir, project, borrowed, graph: path.join(project, '.planning', 'graph') };
}

const lines = (g) => {
  const f = path.join(g, 'delivery-log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

suite('log-event — the journal lands beside its graph');

test('logging from a checkout with no graph refuses, and creates nothing', () => {
  const { borrowed } = scratch();
  const r = run(borrowed, ['attempt', 'ticket=T-12-03', 'role=ci-fix']);
  assert.notStrictEqual(r.status, 0, 'it must fail rather than start a second journal');
  assert.ok(/no ticket graph/.test(r.stderr), r.stderr);
  assert.ok(/--graph/.test(r.stderr), 'the error must name the way out');
  assert.strictEqual(fs.existsSync(path.join(borrowed, '.planning')), false,
    'refusing must not leave a .planning/ behind in a borrowed repository');
});

test('logging from the project writes next to the graph', () => {
  const { project, graph } = scratch();
  const r = run(project, ['attempt', 'ticket=T-01-01', 'role=ci-fix']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(lines(graph).length, 1);
});

test('--graph files the event with the project, from anywhere, in any position', () => {
  const { borrowed, graph } = scratch();
  // Deliberately FIRST: positional parsing that only tolerates a trailing flag
  // would swallow it as the event name.
  const r = run(borrowed, ['--graph', graph, 'attempt', 'ticket=T-12-03', 'role=ci-fix']);
  assert.strictEqual(r.status, 0, r.stderr);
  const rec = JSON.parse(lines(graph)[0]);
  assert.strictEqual(rec.event, 'attempt');
  assert.strictEqual(rec.ticket, 'T-12-03');
  assert.strictEqual('--graph' in rec, false, 'the flag is ours, not telemetry');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, graph), false);
});

test('SHIPYARD_GRAPH_DIR does the same without touching the command line', () => {
  const { borrowed, graph } = scratch();
  const r = run(borrowed, ['attempt', 'ticket=T-12-04'], { SHIPYARD_GRAPH_DIR: graph });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(lines(graph)[0]).ticket, 'T-12-04');
});

test('a bad event name still reports usage, not the graph error', () => {
  const { project } = scratch();
  const r = run(project, ['NotAnEvent']);
  assert.strictEqual(r.status, 2);
  assert.ok(/usage:/.test(r.stderr), r.stderr);
});

done();
