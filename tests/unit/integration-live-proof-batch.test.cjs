'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadOwner } = require('./helpers/integration-owner.cjs');
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller,
  originalPartitionSessions, projectOptions, write, commit } = loadOwner(['publicIntegrationFixture',
  'publicPartitionFixture', 'supportedPartitionCaller', 'originalPartitionSessions', 'projectOptions', 'write', 'commit']);
const host = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');

function transport(f, mutate = () => {}) {
  const legacy = projectOptions(f), calls = [];
  const live = branch => ({ ...legacy.listPullRequests({ branch })[0], baseRefOid: f.base, reviewDecision: '' });
  const options = { ...legacy };
  delete options.listPullRequests;
  delete options.getPullRequest;
  options.execFileSync = (file, argv, execution) => {
    if (file !== 'gh') return legacy.execFileSync(file, argv, execution);
    calls.push({ argv, cwd: execution.cwd });
    if (argv[0] === 'repo') return JSON.stringify({ nameWithOwner: 'fixture/repository', url: 'https://github.example/fixture/repository' });
    if (argv[0] === 'pr' && argv[1] === 'list') return JSON.stringify([live(argv[argv.indexOf('--head') + 1])]);
    if (argv[0] === 'pr' && argv[1] === 'view') {
      const branch = Object.values(f.rows).find(row => legacy.listPullRequests({ branch: row.branch })[0].number === Number(argv[2])).branch;
      return JSON.stringify(live(branch));
    }
    assert.deepEqual(argv.slice(0, 5), ['api', '--hostname', 'github.example', 'graphql', '-f']);
    const query = argv[5];
    assert.ok(query.startsWith('query=query{repository(owner:"fixture",name:"repository")'));
    const repository = { nameWithOwner: 'fixture/repository' };
    for (const match of query.matchAll(/(p\d+):pullRequests\(first:100,states:\[CLOSED,MERGED\],headRefName:("(?:[^"\\]|\\.)*")\)/g)) {
      repository[match[1]] = { nodes: [{ ...live(JSON.parse(match[2])), reviewDecision: null }], pageInfo: { hasNextPage: false } };
    }
    const response = { data: { repository } };
    mutate(response, calls.filter(call => call.argv[0] === 'api').length);
    return JSON.stringify(response);
  };
  return { options, calls, legacy: { ...legacy,
    listPullRequests: ({ branch }) => [live(branch)],
    getPullRequest: ({ pr }) => live(Object.values(f.rows).find(row => legacy.listPullRequests({ branch: row.branch })[0].number === pr).branch) } };
}

test('pure complete proof preserves null versus empty reviewDecision serialization in two independent batches', async () => {
  await publicIntegrationFixture(async f => {
    const t = transport(f);
    const expected = host.prepareNativeIntegratorContext(t.legacy, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
    const actual = host.prepareNativeIntegratorContext(t.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
    assert.deepEqual(actual.nativeMergeProof, expected.nativeMergeProof);
    assert.deepEqual(actual.ticketSet, expected.ticketSet);
    assert.ok(actual.nativeMergeProof.merges.every(member => member.review_decision === ''));
    assert.equal(t.calls.filter(call => call.argv[0] === 'api').length, 2);
    assert.equal(t.calls.filter(call => call.argv[0] === 'repo').length, 2);
    assert.ok(t.calls.every(call => call.cwd === f.worktree));
  });
});

const malformed = {
  errors: response => { response.errors = []; },
  'null data': response => { response.data = null; },
  'unknown alias': response => { response.data.repository.foreign = {}; },
  'missing alias': response => { delete response.data.repository.p0; },
  pagination: response => { response.data.repository.p0.pageInfo.hasNextPage = true; },
  'missing field': response => { delete response.data.repository.p0.nodes[0].body; },
  'foreign branch': response => { response.data.repository.p0.nodes[0].headRefName = 'foreign'; },
  'duplicate PR': response => { response.data.repository.p0.nodes.push(response.data.repository.p0.nodes[0]); },
  'detail overflow': response => { response.data.repository.p0.nodes[0].body = 'x'.repeat(65536); },
  'foreign repository': response => { response.data.repository.nameWithOwner = 'foreign/repository'; },
  'null connection': response => { response.data.repository.p0 = null; },
  'null node': response => { response.data.repository.p0.nodes[0] = null; },
  'unknown node field': response => { response.data.repository.p0.nodes[0].unknown = true; },
  'unknown page field': response => { response.data.repository.p0.pageInfo.endCursor = 'cursor'; },
  'invalid review decision': response => { response.data.repository.p0.nodes[0].reviewDecision = ''; },
  'unsafe PR': response => { response.data.repository.p0.nodes[0].number = Number.MAX_SAFE_INTEGER + 1; },
  'wrong known PR': response => { response.data.repository.p0.nodes[0].number = 999; },
  'invalid merge commit': response => { response.data.repository.p0.nodes[0].mergeCommit = {}; },
  'duplicate across branches': response => { response.data.repository.p1.nodes[0].number = response.data.repository.p0.nodes[0].number; },
  'too many nodes': response => { response.data.repository.p0.nodes = Array(101).fill(response.data.repository.p0.nodes[0]); },
  'transport overflow': response => { response.padding = 'x'.repeat(262144); },
};
test('pure malformed complete observations fail closed', async () => {
  await publicIntegrationFixture(async f => {
    for (const [name, mutate] of Object.entries(malformed)) {
      const t = transport(f, mutate);
      assert.throws(() => host.prepareNativeIntegratorContext(t.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' }), undefined, name);
      assert.equal(t.calls.filter(call => call.argv[0] === 'pr').length, 0, name);
    }
    const changed = transport(f, (response, pass) => {
      if (pass === 2) response.data.repository.p0.nodes[0].reviewDecision = 'APPROVED';
    });
    assert.throws(() => host.prepareNativeIntegratorContext(changed.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' }));
  });
});

for (const count of [1, 2, 38]) test('pure complete transport count is independent of membership M=' + count, async () => {
  await publicIntegrationFixture(async f => {
    const template = f.rows['T-49-01'];
    for (const row of Object.values(f.rows)) fs.unlinkSync(path.join(f.worktree, row.plan));
    f.rows = {};
    f.state = {};
    for (let index = 1; index <= count; index++) {
      const suffix = String(index).padStart(2, '0'), id = 'T-49-' + suffix;
      const row = { ...template, branch: 'ticket/' + id,
        plan: '.planning/phases/49-lineage/49-' + suffix + '-PLAN.md' };
      f.rows[id] = row;
      f.state[id] = { status: 'merged', pr: 100 + index, branch: row.branch };
      write(f.worktree, row.plan, '---\nphase: 49\nplan: ' + suffix + '\n---\nADR-014\n## Acceptance criteria\n- Complete merged behavior.\n');
    }
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
    commit(f, 'bounded membership fixture');
    const t = transport(f);
    for (let invocation = 1; invocation <= 2; invocation++) {
      const actual = host.prepareNativeIntegratorContext(t.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
      assert.equal(actual.nativeMergeProof.merges.length, count);
      assert.equal(t.calls.filter(call => call.argv[0] === 'api').length, invocation * 2);
      assert.equal(t.calls.length, invocation * 4);
    }
  });
});

test('pure either custom adapter or explicit supplied capacity preserves legacy transport', async () => {
  await publicIntegrationFixture(async f => {
    for (const mode of ['list', 'get', 'capacity']) {
      const t = transport(f), options = { ...t.options };
      if (mode === 'list') options.listPullRequests = t.legacy.listPullRequests;
      if (mode === 'get') options.getPullRequest = t.legacy.getPullRequest;
      if (mode === 'capacity') options.integrationCapacity = {};
      host.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
      assert.equal(t.calls.filter(call => call.argv[0] === 'api' || call.argv[0] === 'repo').length, 0);
      assert.equal(t.calls.length, mode === 'capacity' ? 8 : 4);
    }
  });
});

test('pure repository resolution refuses invalid identities before querying', async () => {
  await publicIntegrationFixture(async f => {
    for (const identity of [null, {}, { nameWithOwner: 'fixture/repository', url: 'http://github.example/fixture/repository' },
      { nameWithOwner: 'fixture/repository', url: 'https://github.example/foreign/repository' },
      { nameWithOwner: 'fixture/repository', url: 'https://user@github.example/fixture/repository' },
      { nameWithOwner: 'fixture/repository', url: 'https://github.example/fixture/repository?query=1' }]) {
      const t = transport(f), run = t.options.execFileSync;
      let queries = 0;
      t.options.execFileSync = (file, argv, options) => {
        if (file === 'gh' && argv[0] === 'repo') return JSON.stringify(identity);
        if (file === 'gh' && argv[0] === 'api') queries++;
        return run(file, argv, options);
      };
      assert.throws(() => host.prepareNativeIntegratorContext(t.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' }));
      assert.equal(queries, 0);
      assert.equal(t.calls.filter(call => call.argv[0] === 'pr').length, 0);
    }
  });
});

test('pure command-only bulk failure reruns complete independent fresh legacy passes', async () => {
  await publicIntegrationFixture(async f => {
    for (const failed of ['repo', 'api']) {
      const t = transport(f), run = t.options.execFileSync, calls = [];
      t.options.execFileSync = (file, argv, options) => {
        if (file === 'gh') calls.push([...argv]);
        if (file === 'gh' && argv[0] === failed) {
          const error = new Error('unsupported fixture command');
          error.status = 2; error.stdout = ''; error.stderr = 'unsupported fixture command';
          throw error;
        }
        return run(file, argv, options);
      };
      const expected = host.prepareNativeIntegratorContext(t.legacy, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
      const actual = host.prepareNativeIntegratorContext(t.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
      assert.deepEqual(actual.nativeMergeProof, expected.nativeMergeProof);
      assert.deepEqual(host.assertNativeIntegrationMergeProof(actual.nativeMergeProof,
        { worktree: f.worktree, graphDir: f.graphDir }, t.options), expected.nativeMergeProof);
      const pass = [...(failed === 'api' ? ['repo', 'api'] : ['repo']), 'pr list', 'pr view', 'pr list', 'pr view'];
      assert.deepEqual(calls.map(argv => argv[0] === 'pr' ? argv.slice(0, 2).join(' ') : argv[0]), Array(4).fill(pass).flat());
      assert.ok(calls.filter(argv => argv[0] === 'pr' && argv[1] === 'list').every(argv =>
        argv[argv.indexOf('--state') + 1] === 'closed' && argv[argv.indexOf('--limit') + 1] === '100'));
    }
  });
});

test('pure bulk response failures never select legacy transport', async () => {
  await publicIntegrationFixture(async f => {
    for (const failed of ['repo', 'api']) {
      for (const mode of ['invalid JSON', 'null JSON', 'command response', 'overflow']) {
        const t = transport(f), run = t.options.execFileSync;
        let legacyCalls = 0;
        t.options.execFileSync = (file, argv, options) => {
          if (file === 'gh' && argv[0] === 'pr') legacyCalls++;
          if (file !== 'gh' || argv[0] !== failed) return run(file, argv, options);
          if (mode === 'invalid JSON') return '{';
          if (mode === 'null JSON') return 'null';
          const error = new Error(mode);
          if (mode === 'overflow') error.code = 'ENOBUFS';
          else { error.status = 1; error.stdout = JSON.stringify({ data: null, errors: [{ message: 'incomplete' }] }); }
          throw error;
        };
        assert.throws(() => host.prepareNativeIntegratorContext(t.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' }), undefined, failed + ': ' + mode);
        assert.equal(legacyCalls, 0);
      }
    }
  });
});

test('pure legacy fallback preserves list and detail refusal and independent-pass drift checks', async () => {
  await publicIntegrationFixture(async f => {
    for (const failed of ['repo', 'api']) {
      for (const mode of ['list error', 'detail error', 'list null', 'detail null', 'second pass drift', 'second pass detail error']) {
        const t = transport(f), run = t.options.execFileSync;
        let pass = 0, lists = 0, details = 0;
        t.options.execFileSync = (file, argv, options) => {
          if (file === 'gh' && argv[0] === failed) {
            pass++;
            throw new Error('unsupported fixture command');
          }
          const raw = run(file, argv, options);
          if (file !== 'gh' || argv[0] !== 'pr') return raw;
          if (argv[1] === 'list') {
            lists++;
            if (mode === 'list error') throw new Error('list unavailable');
            if (mode === 'list null') return 'null';
          } else {
            details++;
            if (mode === 'detail error' || (mode === 'second pass detail error' && pass === 2)) throw new Error('detail unavailable');
            if (mode === 'detail null') return 'null';
            if (mode === 'second pass drift' && pass === 2) return JSON.stringify({ ...JSON.parse(raw), reviewDecision: 'APPROVED' });
          }
          return raw;
        };
        assert.throws(() => host.prepareNativeIntegratorContext(t.options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' }), undefined, failed + ': ' + mode);
        assert.ok(lists > 0);
        if (mode.startsWith('second pass')) { assert.equal(pass, 2); assert.ok(details > 2); }
      }
    }
  });
});

for (const runtime of ['codex', 'claude']) {
  for (const mode of ['strict', 'observed']) test('behavior ' + runtime + ' ordered ' + mode + ' original custody and independent final', async () => {
    await publicIntegrationFixture(async f => {
      const observed = mode !== 'strict';
      const prepared = publicPartitionFixture(f, runtime, { observed });
      const events = [];
      prepared.controls.onLaunch = (_input, payload) => {
        events.push({ kind: payload.kind, unit: payload.unit_id });
        const envelopes = fs.readdirSync(authority.archiveAuthorityDirectory(f.worktree))
          .filter(name => name.startsWith('integration-launch-'))
          .map(name => JSON.parse(fs.readFileSync(path.join(authority.archiveAuthorityDirectory(f.worktree), name))).payload)
          .filter(launch => launch.kind === 'unit');
        if (payload.kind === 'unit' && observed) {
          assert.deepEqual(envelopes.map(launch => launch.unit_id).sort(),
            events.filter(event => event.kind === 'unit').map(event => event.unit).sort());
        }
        if (payload.kind === 'unit' && !observed && events.length === 1) {
          const plans = fs.readdirSync(authority.archiveAuthorityDirectory(f.worktree))
            .filter(name => name.startsWith('integration-plan-'))
            .map(name => JSON.parse(fs.readFileSync(path.join(authority.archiveAuthorityDirectory(f.worktree), name))).payload.plan);
          assert.equal(envelopes.length, plans[0].units.length);
        }
        if (payload.kind === 'phase') {
          assert.equal(payload.unit_artifacts.length, events.filter(event => event.kind === 'unit').length);
          assert.equal(payload.unit_results.length, payload.unit_artifacts.length);
          if (observed) assert.equal(payload.assignments.length, payload.unit_artifacts.length);
          else assert.equal(Object.hasOwn(payload, 'assignments'), false);
        }
      };
      assert.equal((await supportedPartitionCaller(f, runtime, prepared.options)).result.outcome, 'passed');
      const sessions = originalPartitionSessions(f, runtime, prepared.recorder, prepared.controls);
      assert.equal(sessions.filter(session => session.result.kind === 'phase').length, 1);
    });
  });
}
