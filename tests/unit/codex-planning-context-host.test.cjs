'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { buildContextPacket } = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const planningHost = require('../../plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-planning-context-')));
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, 'source.md'), '# Planning source\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function packetFor(root, sourceRevision = git(root, 'rev-parse', 'HEAD')) {
  const subject = 'phase=43;input=ADR-TEST;repository=shipyard/test';
  const packet = buildContextPacket({
    root,
    role: 'decomposition',
    subject,
    sourceRevision,
    policy: policy.POLICY,
    policyHash: policy.POLICY_HASH,
    scope: { files_modified: [] },
    acceptance: [],
    verification: [],
    requiredRefs: ['source.md'],
    roleContext: {
      adr_refs: [{ path: 'source.md' }],
      requirements: [{ path: 'source.md' }],
      research_refs: [],
      context: { phase: 43, input: 'ADR-TEST' },
    },
  });
  return { subject, sourceRevision, packet };
}

function requestFor(root) {
  const { subject, sourceRevision, packet } = packetFor(root);
  return {
    scope: {
      run_id: 'run-43-15', ticket: 'T-43-15', phase: 43,
      worktree: root, runtime: 'codex', provider: 'openai', repository: 'shipyard/test',
    },
    gsd_role: 'gsd-planner',
    prompt: 'Prepare plans for the accepted decision.',
    signals: {},
    subject,
    sourceRevision,
    contextPacket: packet,
    contextPacketRequired: true,
  };
}

function argsFile(root, request) {
  const file = path.join(root, 'request.json');
  fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  return file;
}

test('validates the packet at launch and delegates only the typed prompt to the receipt-owning host', async () => {
  const f = fixture();
  try {
    const request = requestFor(f.root);
    const file = argsFile(f.root, request);
    let delegated;
    let delegatedFile;
    const result = await planningHost.runCli(['--args-file', file], { write() {} }, {
      runHost: async (argv) => {
        assert.deepEqual(argv.slice(0, 1), ['--args-file']);
        delegatedFile = argv[1];
        delegated = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
        assert.equal(fs.statSync(argv[1]).mode & 0o777, 0o600);
        return { receipt: 'owned by codex-decompose-host' };
      },
    });
    assert.equal(result.receipt, 'owned by codex-decompose-host');
    assert.equal(delegated.scope.run_id, 'run-43-15');
    assert.equal(delegated.scope.repository, 'shipyard/test');
    assert.equal(delegated.gsd_role, 'gsd-planner');
    assert.equal(Object.hasOwn(delegated, 'contextPacket'), false);
    assert.match(delegated.prompt, /verified structured context packet/i);
    assert.ok(delegated.prompt.includes(JSON.stringify(request.contextPacket)));
    assert.equal(fs.existsSync(delegatedFile), false);
  } finally { f.clean(); }
});

test('refuses source edits made after packet construction before invoking the host', async () => {
  const f = fixture();
  try {
    const request = requestFor(f.root);
    const file = argsFile(f.root, request);
    fs.appendFileSync(path.join(f.root, 'source.md'), 'changed\n');
    let launched = false;
    await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, {
      runHost: async () => { launched = true; },
    }), (error) => error.code === 'STALE_CONTEXT_PACKET' && /changed after packet construction/.test(error.message));
    assert.equal(launched, false);
  } finally { f.clean(); }
});

test('refuses a moved source revision before invoking the host', async () => {
  const f = fixture();
  try {
    const request = requestFor(f.root);
    const file = argsFile(f.root, request);
    git(f.root, 'commit', '--allow-empty', '-q', '-m', 'advance source revision');
    let launched = false;
    await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, {
      runHost: async () => { launched = true; },
    }), (error) => error.code === 'STALE_CONTEXT_PACKET' && /source revision differs/.test(error.message));
    assert.equal(launched, false);
  } finally { f.clean(); }
});
