'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const flow = require(path.join(scripts, 'phase-code-review.cjs'));
const artifact = require(path.join(scripts, 'role-artifact.cjs'));
const target = require(path.join(scripts, 'architecture-target.cjs'));
const { fixture: artifactFixture, setOriginalReview, retainPlanningInput } = require('../fixtures/code-review/artifact-fixture.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function publicationFixture(action) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z29h-'))), homedir = os.homedir;
  os.homedir = () => home;
  const f = artifactFixture('unsent');
  try {
    const pr = 52, branch = f.branch;
    f.graph.epics = { '052': { branch, phaseDir: f.phase, repos: [null], jira: null } };
    Object.assign(f.graph.tickets['T-52-01'], { epic: branch, branch: 'feat/review-ticket', repo: null, phaseDir: f.phase });
    const config = path.join(f.root, '.planning/config.json');
    fs.writeFileSync(config, JSON.stringify({ git: { base_branch: 'main' }, delivery_pipeline: { code_review: 'report' } }));
    f.writeGraph();
    const live = () => ({ number: pr, state: 'OPEN', headRefName: branch, headRefOid: f.git(['rev-parse', 'HEAD']),
      baseRefName: 'main', baseRefOid: f.base });
    const input = () => ({ phase: 52, phaseDirectory: f.phase, pr, worktree: f.root, graphDir: f.graphDir });
    let round = 0, mutate, lookup, drift;
    const writes = [], comments = [], statuses = [];
    const operationPath = kind => path.join(home, '.local/state/shipyard/code-review-publications',
      hash(JSON.stringify([target.repositoryIdentity(f.root), null])), '.52.' + kind + '.json');
    const operation = kind => fs.existsSync(operationPath(kind)) ? JSON.parse(fs.readFileSync(operationPath(kind))) : null;
    const seal = () => {
      round++;
      fs.writeFileSync(path.join(f.root, 'round.txt'), String(round));
      f.git(['add', 'round.txt']); f.git(['commit', '--quiet', '-m', 'round ' + round]);
      f.writeGraph();
      const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52,
        repository: target.repositoryIdentity(f.root), branch, pr, head: live().headRefOid, base: f.base });
      const raw = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [], coverage: [] };
      const request = f.input(binding, 1, null, raw);
      Object.assign(request.result, require(path.join(scripts, 'code-review-core.cjs')).normalizeResult(raw, {
        round: 1, scope: 'full', priorFindings: [], readSource: file => fs.readFileSync(path.join(f.root, file), 'utf8') }));
      setOriginalReview(request, raw, []);
      artifact.sealJudgment(retainPlanningInput(f, request));
    };
    const options = { defaultBranch: 'main', getPullRequest({ pr: requested }) {
      const result = requested === pr ? live() : { number: requested, headRefOid: f.base };
      return requested === pr && drift ? drift(result) : result;
    }, gh(args) {
      const endpoint = args[1];
      const fields = Object.fromEntries(args.filter((_, index) => args[index - 1] === '-f').map(value => {
        const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)];
      }));
      if (args.includes('-f')) {
        const kind = endpoint.includes('/statuses/') ? 'status' : 'comment';
        const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'POST';
        writes.push({ kind, method, endpoint, fields });
        let result;
        if (kind === 'status') { result = { id: statuses.length + 1, ...fields, creator: { id: 1 } }; statuses.push(result); }
        else if (method === 'PATCH') { result = comments.find(row => endpoint.endsWith('/' + row.id)); result.body = fields.body; }
        else { result = { id: comments.length + 77, body: fields.body, user: { id: 1 } }; comments.push(result); }
        return mutate ? mutate(kind, result) : { ...result };
      }
      if (endpoint === 'user') return { id: 1 };
      if (endpoint === 'repos/{owner}/{repo}') return { id: 7, full_name: 'fixture/repository' };
      const kind = endpoint.includes('/commits/') ? 'status' : 'comment';
      const rows = kind === 'status' ? statuses : comments;
      return lookup ? lookup(kind, rows) : [rows];
    } };
    return action({ ...f, home, config, live, input, options, seal, writes, comments, statuses, operation, operationPath,
      setDrift: value => { drift = value; }, setMutation: value => { mutate = value; }, setLookup: value => { lookup = value; } });
  } finally { f.cleanup(); os.homedir = homedir; fs.rmSync(home, { recursive: true, force: true }); }
}

function registerTests(test) {
  for (const kind of ['status', 'comment']) for (const edit of kind === 'comment' ? [false, true] : [false])
    for (const change of ['head', 'base', 'config', 'local-head'])
      test('prepared ' + kind + (edit ? ' PATCH' : ' POST') + ' refuses ' + change + ' before send and accepts next binding', () => publicationFixture(f => {
        f.seal();
        if (edit) { const first = flow.publish(f.input(), f.options); assert.equal(first.comment.ok, true); f.seal(); }
        const before = f.writes.filter(row => row.kind === kind).length, config = fs.readFileSync(f.config);
        let refused = false;
        f.setDrift(live => {
          if (!refused && f.operation(kind)?.stage === 'prepared') {
            refused = true;
            if (change === 'config') fs.appendFileSync(f.config, '\n');
            if (change === 'local-head') f.git(['update-ref', 'HEAD', f.base]);
            if (change === 'base') return { ...live, baseRefOid: 'f'.repeat(40) };
            if (change === 'head') return { ...live, headRefOid: 'f'.repeat(40) };
          }
          return live;
        });
        const head = f.live().headRefOid;
        const result = flow.publish(f.input(), f.options);
        assert.equal(refused, true);
        assert.equal(result[kind].ok, false);
        assert.equal(f.writes.filter(row => row.kind === kind).length, before);
        assert.equal(f.operation(kind).stage, 'prepared');
        f.setDrift(null); fs.writeFileSync(f.config, config);
        if (change === 'local-head') f.git(['update-ref', 'HEAD', head]);
        f.seal();
        for (let attempt = 0; attempt < 2; attempt++) assert.equal(flow.publish(f.input(), f.options)[kind].ok, true);
        assert.equal(f.writes.filter(row => row.kind === kind).length, before + 1);
        if (edit) assert.equal(f.writes.filter(row => row.kind === kind).at(-1).method, 'PATCH');
      }));
  for (const kind of ['status', 'comment']) for (const failure of ['lost-response', 'malformed-response', 'missing', 'duplicate', 'unavailable'])
    test('issued ' + kind + ' retains original across ' + failure + ' and never repeats mutation', () => publicationFixture(f => {
      f.seal();
      f.setMutation((issued, result) => {
        if (issued === kind) { if (failure === 'malformed-response') return {}; throw new Error('response lost'); }
        return { ...result };
      });
      assert.equal(flow.publish(f.input(), f.options)[kind].ok, false);
      assert.equal(f.operation(kind).stage, 'pending');
      const count = f.writes.filter(row => row.kind === kind).length;
      f.setMutation(null);
      f.setLookup((queried, rows) => {
        if (queried !== kind) return [rows];
        if (failure === 'missing') return [[]];
        if (failure === 'duplicate') return [[...rows, { ...rows[0], id: 999 }]];
        if (failure === 'unavailable') throw new Error('lookup unavailable');
        return [rows];
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const recovered = flow.publish(f.input(), f.options);
        assert.equal(recovered[kind].ok, ['lost-response', 'malformed-response'].includes(failure));
      }
      assert.equal(f.writes.filter(row => row.kind === kind).length, count);
    }));
  for (const kind of ['status', 'comment']) for (const fault of ['old-pending', 'foreign-owner', 'nonce', 'identity', 'body', 'repository', 'prepared-binding'])
    test('recovered ' + kind + ' refuses unproven or substituted ' + fault, () => publicationFixture(f => {
      f.seal();
      f.setDrift(live => f.operation(kind)?.stage === 'prepared' ? { ...live, headRefOid: f.base } : live);
      flow.publish(f.input(), f.options);
      const file = f.operationPath(kind), operation = f.operation(kind);
      assert.equal(operation.stage, 'prepared');
      if (fault === 'old-pending') { operation.stage = 'pending'; delete operation.preparation; }
      if (fault === 'foreign-owner') operation.actor = 99;
      if (fault === 'nonce') operation.nonce = 'f'.repeat(64);
      if (fault === 'identity') operation.identity = 'f'.repeat(64);
      if (fault === 'body') operation.body_hash = 'f'.repeat(64);
      if (fault === 'repository') operation.repository_id = 99;
      if (fault === 'prepared-binding') operation.preparation.config = 'f'.repeat(64);
      fs.writeFileSync(file, JSON.stringify(operation));
      const before = f.writes.filter(row => row.kind === kind).length;
      f.setDrift(null); f.seal();
      assert.equal(flow.publish(f.input(), f.options)[kind].ok, false);
      assert.equal(f.writes.filter(row => row.kind === kind).length, before);
      assert.deepEqual(f.operation(kind), operation);
    }));
  for (const kind of ['status', 'comment']) test('prepared ' + kind + ' persistence failure remains unsent across a cold module', () => publicationFixture(f => {
    f.seal();
    const sync = fs.fsyncSync;
    let failed = false;
    fs.fsyncSync = fd => {
      if (!failed && f.operation(kind)?.stage === 'prepared') { failed = true; throw new Error('fixture durable preparation failure'); }
      return sync(fd);
    };
    try { assert.equal(flow.publish(f.input(), f.options)[kind].ok, false); }
    finally { fs.fsyncSync = sync; }
    assert.equal(failed, true); assert.equal(f.writes.filter(row => row.kind === kind).length, 0);
    assert.equal(f.operation(kind).stage, 'prepared');
    const filename = require.resolve(path.join(scripts, 'phase-code-review.cjs')), cached = require.cache[filename];
    delete require.cache[filename];
    try {
      const cold = require(filename);
      assert.equal(cold.publish(f.input(), f.options)[kind].ok, true);
      assert.equal(cold.publish(f.input(), f.options)[kind].ok, true);
      assert.equal(f.writes.filter(row => row.kind === kind).length, 1);
    } finally { require.cache[filename] = cached; }
  }));

  for (const kind of ['status', 'comment']) test('issued ' + kind + ' cannot be downgraded to prepared by changing its stage', () => publicationFixture(f => {
    f.seal();
    f.setMutation((issued, result) => { if (issued === kind) throw new Error('lost response'); return result; });
    assert.equal(flow.publish(f.input(), f.options)[kind].ok, false);
    const operation = f.operation(kind); assert.equal(operation.stage, 'pending'); operation.stage = 'prepared';
    fs.writeFileSync(f.operationPath(kind), JSON.stringify(operation));
    f.setMutation(null);
    assert.equal(flow.publish(f.input(), f.options)[kind].ok, false);
    assert.equal(f.writes.filter(row => row.kind === kind).length, 1);
    assert.deepEqual(f.operation(kind), operation);
  }));

}

module.exports = { publicationFixture, registerTests };
if (require.main === module) {
  const { describe, test } = require('node:test');
  describe('Publication unsent recovery', { concurrency: 2 }, () =>
    registerTests((name, callback) => test(name, { timeout: 180000 }, callback)));
}
