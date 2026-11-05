'use strict';

const { createRoleArtifactFixture, createRoleArtifactLifecycle } = require('./helpers/phase53-role-artifact-fixture.cjs');

function registerRoleArtifacts(test, context) {
  const {
    require, module, unitDir: __dirname, assert, suite, fs, path, execFileSync, testAuthorityArgs, targetBin,
    createDispatchBoundary, createDurableRecorder, ROLE_ARTIFACT, roleArtifact, git, fixture, clean,
    judgmentReceipt, judgmentFixture, archReviewResult, sealArchReview, phaseScopeFixture, cleanPhaseScope,
  } = context;

const { codexJudgmentFixtures } = context;

suite('role-artifact — Codex sealed architecture context');

for (const mutation of ['progress', 'duplicate-contract', 'duplicate-item', 'corrupt-terminal', 'failed-turn', 'incomplete-turn', 'foreign-session'])
test('original focused CLI retains progress and rejects invalid terminal results: ' + mutation, async () => {
  const f = codexJudgmentFixtures.fixture();
  const prototype = require('node:events').EventEmitter.prototype;
  const emit = prototype.emit;
  let observed = false;
  prototype.emit = function(event, bytes, ...args) {
    if (event === 'data' && Buffer.isBuffer(bytes) && bytes.toString().includes('shipyard.focused-architecture-review.v1')) {
      const rows = bytes.toString().trim().split('\n').map(JSON.parse);
      const index = rows.findIndex(row => row.item?.type === 'agent_message');
      if (index >= 0 && rows[index].item.text.includes('shipyard.focused-architecture-review.v1')) {
        observed = true;
        const progress = structuredClone(rows[index]);
        progress.item.id += '-progress'; progress.item.text = 'Inspecting the current diff and governing ADRs.';
        rows.splice(index, 0, progress);
        if (mutation === 'duplicate-contract') {
          const duplicate = structuredClone(rows[index + 1]); duplicate.item.id += '-duplicate';
          rows.splice(index + 1, 0, duplicate);
        }
        if (mutation === 'duplicate-item') progress.item.id = rows[index + 1].item.id;
        if (mutation === 'corrupt-terminal') {
          const corrupt = structuredClone(progress); corrupt.item.id += '-corrupt'; corrupt.item.text = '{"review_contract":';
          rows.splice(index + 2, 0, corrupt);
        }
        if (mutation === 'failed-turn') rows.splice(rows.length - 1, 0, { type: 'turn.failed', error: { message: 'original failed turn' } });
        if (mutation === 'incomplete-turn') rows.splice(rows.findIndex(row => row.type === 'turn.completed'), 1);
        if (mutation === 'foreign-session') rows.unshift({ ...rows[0], thread_id: 'foreign-session' });
        bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
    }
    return emit.call(this, event, bytes, ...args);
  };
  try {
    if (mutation === 'progress') {
      const { validationInput } = await codexJudgmentFixtures.unitJudgment(f);
      assert.equal(roleArtifact.validateJudgmentManifest(validationInput).envelope.verdict, 'conform');
      assert.equal(roleArtifact.read(validationInput).envelope.verdict, 'conform');
      assert.equal(roleArtifact.currentArchitectureVerdict({ worktreePath: f.root, pr: f.pr.number,
        head: f.head, baseName: 'main', baseCommit: f.base, headBranch: f.pr.headRefName,
        graphDir: path.join(f.root, '.planning/graph') })?.dispatch_id, validationInput.dispatchId);
    } else await assert.rejects(() => codexJudgmentFixtures.unitJudgment(f));
    assert.ok(observed, 'original registered native CLI boundary was exercised');
  } finally { prototype.emit = emit; codexJudgmentFixtures.cleanupJudgment(f); }
});

test('fresh Codex architecture artifact remains valid after CLI inflight cleanup', async () => {
  const f = codexJudgmentFixtures.fixture();
  try {
    const { validationInput } = await codexJudgmentFixtures.unitJudgment(f);
    assert.equal(roleArtifact.validateJudgmentManifest(validationInput).envelope.verdict, 'conform');
    const child = `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const input = JSON.parse(process.argv[1]);
      input.recorder = require(input.boundary).createDurableRecorder(input.store);
      input.io = { execFileSync(executable, args, options) {
        if (executable === 'gh') return JSON.stringify(input.fixturePr);
        if (executable === 'git' && args.includes('fetch')) return '';
        return execFileSync(executable, args, options);
      } };
      const validated = require(input.consumer).validateJudgmentManifest(input);
      process.stdout.write(JSON.stringify({ verdict: validated.envelope.verdict }));
    `;
    const childInput = { ...validationInput, recorder: undefined, io: undefined,
      fixturePr: f.pr, store: path.join(f.storage, 'receipts'),
      boundary: path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs'),
      consumer: path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs') };
    assert.equal(JSON.parse(execFileSync(process.execPath, [...testAuthorityArgs, '-e', child, JSON.stringify(childInput)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).verdict, 'conform');

  } finally { codexJudgmentFixtures.cleanupJudgment(f); }
});

for (const [name, mutate] of [
  ['ADR content', f => fs.appendFileSync(path.join(f.root,
    '.planning/architecture/ADR-014-host-bound-review.md'), '\nChanged authority.\n')],
  ['draft lifecycle', f => { f.pr.isDraft = !f.pr.isDraft; }],
  ['live head', f => { f.pr.headRefOid = 'a'.repeat(40); }],
  ['live base', f => { f.pr.baseRefOid = 'b'.repeat(40); }],
  ['plan authority', f => fs.appendFileSync(path.join(f.root,
    '.planning/phases/38-codex-arch-review/38-01-PLAN.md'), '\nChanged acceptance.\n')],
  ['graph authority', f => fs.appendFileSync(path.join(f.root,
    '.planning/graph/tickets.json'), ' ')],
  ['corpus membership', f => fs.writeFileSync(path.join(f.root,
    '.planning/architecture/ADR-099-new.md'), '# New architecture authority\n')],
  ['original transcript', (f, sealed) => fs.appendFileSync(sealed.transcript, '\n')],
  ['complete evidence', (f, sealed) => {
    const manifest = JSON.parse(fs.readFileSync(sealed.validationInput.artifactPath, 'utf8'));
    fs.appendFileSync(path.join(f.root, manifest.files.evidence.path), '\nChanged evidence.\n');
  }],
]) test('shared consumer refuses post-seal changed ' + name, async () => {
  const f = codexJudgmentFixtures.fixture();
  try {
    const sealed = await codexJudgmentFixtures.unitJudgment(f);
    mutate(f, sealed);
    assert.throws(() => roleArtifact.validateJudgmentManifest(sealed.validationInput),
      /changed|local changes|STALE|digest|transcript|head|base|identity differs/);
  } finally { codexJudgmentFixtures.cleanupJudgment(f); }
});

test('shared consumer refuses atomic source replacement while its original descriptor is open', async () => {
  const f = codexJudgmentFixtures.fixture();
  const originalOpen = fs.openSync;
  try {
    const sealed = await codexJudgmentFixtures.unitJudgment(f);
    const target = path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md');
    let replaced = false;
    fs.openSync = function (filePath, ...args) {
      const fd = originalOpen.call(fs, filePath, ...args);
      if (String(filePath) === target && !replaced) {
        replaced = true;
        const replacement = path.join(f.storage, 'replacement.md');
        fs.writeFileSync(replacement, '# Replaced complete architecture authority\n');
        fs.renameSync(replacement, target);
      }
      return fd;
    };
    assert.throws(() => roleArtifact.validateJudgmentManifest(sealed.validationInput), /changed/);
    assert.equal(replaced, true);
  } finally {
    fs.openSync = originalOpen;
    codexJudgmentFixtures.cleanupJudgment(f);
  }
});

test('public sealer cannot rebind an original native receipt to another canonical context', async () => {
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const f = codexJudgmentFixtures.fixture();
  const canonical = f.root + '-canonical';
  try {
    const { result, recorder, validationInput, transcript } = await codexJudgmentFixtures.unitJudgment(f);
    const originalRecordDigest = sha(JSON.stringify(recorder.getVerifiedRecord(result.receipt.dispatch_id)));
    const originalTranscriptDigest = sha(fs.readFileSync(transcript));
    const manifest = JSON.parse(fs.readFileSync(result.artifact.ref));
    const archived = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
    const evidence = fs.readFileSync(path.join(f.root, '.shipyard-arch-review-evidence.md'));
    execFileSync('git', ['-C', f.root, 'worktree', 'add', canonical, 'main'], { stdio: 'pipe' });
    fs.appendFileSync(path.join(canonical, '.planning/architecture/ADR-014-host-bound-review.md'),
      '\nNEW AUTHORITY NEVER REVIEWED BY ORIGINAL TRANSCRIPT.\n');
    fs.rmSync(path.join(f.root, '.shipyard-role-artifacts'), { recursive: true });
    fs.rmSync(path.join(f.root, '.planning/graph/dispatches.json'));
    fs.rmSync(path.join(f.root, '.planning/graph/provenance'), { recursive: true });
    const graphDir = path.join(canonical, '.planning/graph');
    assert.throws(() => context.prepare({ worktree: f.root, ticket: result.subject, phase: 38 },
      { role: 'arch-review', context: {}, signals: {} },
      { graphDir, getPullRequest: () => f.pr, refreshGit: false }), /historical archive.*missing|ENOENT/);
    fs.rmSync(roleArtifact.archiveAuthorityDirectory(f.root), { recursive: true, force: true });
    execFileSync('git', ['-C', canonical, 'add', '.planning/architecture/ADR-014-host-bound-review.md'], { stdio: 'pipe' });
    execFileSync('git', ['-C', canonical, 'commit', '-m', 'fixture: commit distinct canonical authority'], { stdio: 'pipe' });
    const fresh = context.prepare({ worktree: f.root, ticket: result.subject, phase: 38 },
      { role: 'arch-review', context: {}, signals: {} },
      { graphDir, getPullRequest: () => f.pr, refreshGit: false });
    const forged = { ...archived, host_context: { ...archived.host_context,
      graph_dir: graphDir, packet_digest: fresh.prepared.packet.digest,
      selected_refs: fresh.evidence.selected_refs, bookkeeping: [] } };
    fs.writeFileSync(path.join(f.root, '.shipyard-arch-review-evidence.md'), evidence);
    let rejection;
    try { roleArtifact.sealJudgment({ ...validationInput, result: forged }); }
    catch (error) { rejection = error; }
    assert.equal(sha(JSON.stringify(recorder.getVerifiedRecord(result.receipt.dispatch_id))), originalRecordDigest);
    assert.equal(sha(fs.readFileSync(transcript)), originalTranscriptDigest);
    assert.notEqual(forged.host_context.packet_digest, archived.host_context.packet_digest);
    assert(rejection, 'forged context was accepted with original receipt and transcript');
    assert.match(rejection.message, /original authenticated launch identity/);

  } finally {
    try { execFileSync('git', ['-C', f.root, 'worktree', 'remove', '--force', canonical], { stdio: 'pipe' }); } catch {}
    codexJudgmentFixtures.cleanupJudgment(f);
  }
});

test('shared consumer refuses corpus membership added during recursive inventory', async () => {
  const f = codexJudgmentFixtures.fixture();
  const originalRead = fs.readdirSync;
  try {
    const sealed = await codexJudgmentFixtures.unitJudgment(f);
    const directory = path.join(f.root, '.planning/architecture');
    let added = false;
    fs.readdirSync = function (filePath, ...args) {
      const entries = originalRead.call(fs, filePath, ...args);
      if (String(filePath) === directory && !added) {
        added = true;
        fs.writeFileSync(path.join(directory, 'ADR-099-added-during-inventory.md'), '# New authority\n');
      }
      return entries;
    };
    assert.throws(() => roleArtifact.validateJudgmentManifest(sealed.validationInput), /membership changed/);
    assert.equal(added, true);
  } finally {
    fs.readdirSync = originalRead;
    codexJudgmentFixtures.cleanupJudgment(f);
  }
});

suite('role-artifact — protected archive lifecycle');

test('phase-local archive scope: two original current tickets and older source receipts remain complete', () => {
  const value = phaseScopeFixture({ second: true });
  try {
    const selected = value.select();
    assert.equal(selected.evidence.length, 2);
    for (const row of selected.evidence) {
      assert.equal(row.files.length, 3);
      const manifest = JSON.parse(row.files.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).content);
      assert.notEqual(manifest.head, value.input.binding.subject.split(';head=')[1].split(';')[0]);
      assert.deepEqual(row.receipt, value.rows.find(original => original.dispatch_id === row.dispatch_id).receipt);
    }
    assert.deepEqual(roleArtifact.readPhaseArchiveRoster(value.input), value.roster);
    assert.deepEqual(roleArtifact.registerPhaseArchiveRoster(value.input), value.roster);
    assert.throws(() => roleArtifact.selectPhaseArchives(value.root, value.input.binding,
      { graphDir: value.input.graphDir, phaseArchiveSelection: { ...selected.selection, records: [] } }), /frozen/);
    const foreign = path.join(value.root, roleArtifact.ARTIFACT_ARCHIVE_DIR, 'foreign');
    fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, roleArtifact.MANIFEST_NAME), JSON.stringify({ ticket: 'T-38-01' }));
    fs.writeFileSync(path.join(foreign, 'findings.json'), 'changed foreign findings');
    assert.equal(roleArtifact.phaseArchitectureEvidenceDigest(value.select().evidence), roleArtifact.phaseArchitectureEvidenceDigest(selected.evidence));
    assert.throws(() => roleArtifact.authenticatedArchivePins(value.root), /membership/);
  } finally { cleanPhaseScope(value); }
});

function mutateFixtureCatalogue(value, mutate) {
  const directory = roleArtifact.archiveAuthorityDirectory(value.root);
  const file = path.join(directory, 'catalogue.json');
  const envelope = JSON.parse(fs.readFileSync(file)); mutate(envelope.payload);
  envelope.mac = require('node:crypto').createHmac('sha256', fs.readFileSync(path.join(directory, 'hmac.key')))
    .update(stableTestValue(envelope.payload)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(envelope));
}

function stableTestValue(value) {
  const normalize = value => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  return JSON.stringify(normalize(value));
}

for (const registered of [false, true])
for (const [name, mutate] of [
  ['missing selected manifest', value => fs.unlinkSync(path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).path))],
  ['missing selected evidence', value => fs.unlinkSync(path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith('.md')).path))],
  ['missing selected findings', value => fs.unlinkSync(path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith('/findings.json')).path))],
  ['removed entire selected family', value => fs.rmSync(path.dirname(path.join(value.root, value.rows[0].pins[0].path)), { recursive: true })],
  ['changed selected bytes', value => fs.appendFileSync(path.join(value.root, value.rows[0].pins[0].path), 'changed')],
  ['changed selected mode', value => fs.chmodSync(path.join(value.root, value.rows[0].pins[0].path), 0o644)],
  ['extra selected member', value => fs.writeFileSync(path.join(path.dirname(path.join(value.root, value.rows[0].pins[0].path)), 'extra'), 'extra')],
  ['nonregular selected member', value => fs.symlinkSync('missing', path.join(path.dirname(path.join(value.root, value.rows[0].pins[0].path)), 'extra'))],
  ['removed protected selected record', value => mutateFixtureCatalogue(value, payload => { delete payload.records[value.rows[0].dispatch_id]; })],
  ['changed protected original receipt', value => mutateFixtureCatalogue(value, payload => { payload.records[value.rows[0].dispatch_id].receipt.ticket = 'T-38-forged'; })],
  ['changed protected original pin', value => mutateFixtureCatalogue(value, payload => { payload.records[value.rows[0].dispatch_id].pins[0].sha256 = '0'.repeat(64); })],
  ['missing selected catalogue', value => fs.unlinkSync(path.join(roleArtifact.archiveAuthorityDirectory(value.root), 'catalogue.json'))],
  ['missing protected roster', value => fs.unlinkSync(value.roster.record_path)],
  ['tampered protected roster', value => fs.appendFileSync(value.roster.record_path, 'changed')],
  ['missing original recorder record', value => fs.rmSync(path.join(value.root, 'receipts'), { recursive: true })],
  ['relabelled manifest and removed authority before discovery', value => {
    const manifest = path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).path);
    fs.writeFileSync(manifest, JSON.stringify({ ticket: 'T-38-01', boundary_subject: 'T-38-01' }));
    fs.unlinkSync(path.join(roleArtifact.archiveAuthorityDirectory(value.root), 'catalogue.json'));
  }],
  ['forged current family', value => {
    const family = path.join(value.root, roleArtifact.ARTIFACT_ARCHIVE_DIR, 'forged'); fs.mkdirSync(family);
    fs.writeFileSync(path.join(family, roleArtifact.MANIFEST_NAME), JSON.stringify({ ticket: value.ticket }));
    mutateFixtureCatalogue(value, payload => { payload.records.forged = {
      dispatch_id: 'forged', ticket: value.input.binding.subject, receipt: { role: 'arch-review' }, pins: [],
    }; });
  }],
  ['changed actual membership', value => {
    const file = path.join(value.input.graphDir, 'tickets.json'); const graph = JSON.parse(fs.readFileSync(file));
    graph.tickets['T-47-extra'] = { ...graph.tickets[value.ticket] }; fs.writeFileSync(file, JSON.stringify(graph));
  }],
]) test('phase-local archive scope: ' + name + ' refuses against independent retained membership in ' + (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  try {
    const frozen = value.select().selection;
    const row = value.rows[registered ? 1 : 0];
    mutate({ ...value, root: row.worktree, ticket: row.ticket, rows: [row] });
    assert.throws(() => value.select({ phaseArchiveSelection: frozen }));
  } finally { cleanPhaseScope(value); }
});

function addForeignPhaseFamilies(root) {
  const directory = path.join(root, roleArtifact.ARTIFACT_ARCHIVE_DIR);
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 1001; index++) {
    const family = path.join(directory, 'foreign-volume-' + String(index).padStart(4, '0'));
    fs.mkdirSync(family);
    fs.writeFileSync(path.join(family, roleArtifact.MANIFEST_NAME), JSON.stringify({
      ticket: 'T-38-01', boundary_subject: 'T-38-01' }));
    fs.writeFileSync(path.join(family, 'evidence.md'), 'foreign evidence');
    fs.writeFileSync(path.join(family, 'findings.json'), 'foreign findings');
  }
  return directory;
}

for (const registered of [false, true])
test('phase-local archive scope: foreign volume and unselected families do not affect literal selection in ' +
    (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  const previousReaddir = fs.readdirSync;
  try {
    const selected = value.select();
    const row = value.rows[registered ? 1 : 0];
    const directory = addForeignPhaseFamilies(row.worktree);
    const after = value.select();
    assert.deepEqual(after, selected);
    assert.equal(roleArtifact.phaseArchitectureEvidenceDigest(after.evidence),
      roleArtifact.phaseArchitectureEvidenceDigest(selected.evidence));
    for (const name of previousReaddir(directory).filter(name => name.startsWith('foreign-volume-'))) {
      fs.appendFileSync(path.join(directory, name, 'evidence.md'), 'changed');
      fs.appendFileSync(path.join(directory, name, 'findings.json'), 'changed');
    }
    assert.deepEqual(value.select(), selected);
    const omitted = 'zz-current-omitted';
    fs.mkdirSync(path.join(directory, omitted));
    fs.writeFileSync(path.join(directory, omitted, roleArtifact.MANIFEST_NAME), JSON.stringify({ ticket: row.ticket }));
    let scannedForeign = 0;
    fs.readdirSync = function(file, ...args) {
      const names = previousReaddir.call(this, file, ...args);
      if (file !== directory) return names;
      const foreign = names.filter(name => name.startsWith('foreign-volume-')).sort();
      scannedForeign = foreign.length;
      return [...names.filter(name => !foreign.includes(name) && name !== omitted), ...foreign, omitted];
    };
    assert.deepEqual(value.select(), selected);
    assert.equal(scannedForeign, 0);
  } finally { fs.readdirSync = previousReaddir; cleanPhaseScope(value); }
});

function fixtureAggregateHint(value, row, boundary) {
  const subject = value.input.binding.subject;
  const dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} },
    { ticket: subject, subject_kind: 'phase', phase: 47 });
  const id = dispatch.receipt.dispatch_id;
  const familyName = require('node:crypto').createHash('sha256').update(id).digest('hex');
  const family = path.join(roleArtifact.ARTIFACT_ARCHIVE_DIR, familyName);
  fs.mkdirSync(path.join(row.worktree, family));
  const pins = row.pins.filter(pin => !pin.path.endsWith(roleArtifact.MANIFEST_NAME)).map(pin => {
    const relative = path.join(family, path.basename(pin.path));
    fs.copyFileSync(path.join(row.worktree, pin.path), path.join(row.worktree, relative));
    fs.chmodSync(path.join(row.worktree, relative), 0o600);
    return { ...pin, path: relative };
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(row.worktree,
    row.pins.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).path)));
  Object.assign(manifest, { producer_dispatch: id, producer_dispatch_id: id, dispatch_id: id,
    producer_launch: dispatch.receipt.launch_id, boundary_subject: subject, policy_hash: dispatch.receipt.policy_hash,
    runtime: dispatch.receipt.runtime, role: dispatch.receipt.role });
  for (const field of ['evidence', 'findings']) {
    const pin = pins.find(pin => path.basename(pin.path) === path.basename(manifest.files[field].path));
    manifest.files[field] = { ...manifest.files[field], ...pin };
  }
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = path.join(family, roleArtifact.MANIFEST_NAME);
  fs.writeFileSync(path.join(row.worktree, manifestPath), bytes, { mode: 0o600 });
  pins.push({ path: manifestPath, bytes: bytes.length,
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') });
  return { familyName, id, record: { dispatch_id: id, ticket: subject, receipt: dispatch.receipt, pins } };
}

async function aggregateNativeDispatch(value, selected) {
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { createClaudeRuntimeHost } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const { createClaudeDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
  const { capture } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/captured/boundaries/claude-stream.json')));
  const streamPath = registry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
  assert.ok(streamPath, 'registered original Claude stream is required');
  const templates = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(record => !record.shipyard_fixture);
  const template = predicate => structuredClone(templates.find(predicate));
  const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  const session = crypto.randomUUID();
  const subject = value.input.binding.subject;
  const aggregate = { ...value, ticket: subject, ticketSet: value.input.binding.ticketSet };
  const result = archReviewResult(aggregate, { verdict: 'conform', blocking_count: 0,
    ticket_set: aggregate.ticketSet,
    host_context: { phase_archive_selection: selected.selection, graph_dir: value.input.graphDir,
      phase_repo: null, phase_evidence_digest: roleArtifact.phaseArchitectureEvidenceDigest(selected.evidence) } });
  const original = { ...result, evidence_markdown: 'complete architecture review evidence\n' };
  const requiredRefs = ['.planning/graph/tickets.json', '.planning/graph/delivery-state.json',
    path.relative(value.root, value.input.inventoryPath), ...selected.pins.map(pin => pin.path)];
  const base = git(value.root, ['rev-parse', 'main']);
  const packet = packets.buildContextPacket({ root: value.root, role: 'arch-review', subject,
    sourceRevision: result.head, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
    scope: { files_modified: requiredRefs }, requiredRefs, uniqueContent: true,
    roleContext: { adr_refs: [], exact_diff: { base, head: result.head,
      content: git(value.root, ['diff', base, 'HEAD', '--']) },
      integration_base: { ref: 'main', commit: base, tree: result.base_tree },
      ticket_set: aggregate.ticketSet, ticket_set_digest: value.input.binding.membership,
      phase_archive_roster: { identity: selected.selection.identity, roster_digest: selected.selection.roster_digest,
        inventory_digest: selected.selection.inventory_digest } } });
  packets.validateContextPacket(packet, { root: value.root, role: 'arch-review', subject,
    sourceRevision: result.head, policyHash: policy.POLICY_HASH });
  const prompt = '<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packet) + '\n</AUTHENTICATED_CONTEXT_PACKET>';
  const transcriptDir = path.join(value.root, 'aggregate-transcripts');
  let suppliedUserInput;
  const runtime = createClaudeRuntimeHost({
    scope: { run_id: 'archive-aggregate-' + session, ticket: subject, phase: 47, worktree: value.root },
    recorder: value.recorder, transcriptDir, uuid: () => session,
    startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
    sessionTranscriptRoot: path.join(value.root, 'aggregate-native'),
    probe: { status: 'available', executable: 'claude-fixture', runtime_version: registry.cli_version,
      capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
    spawn(_file, args) {
      const child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let framedInput = '';
      child.stdin = { write(bytes) { framedInput += bytes; }, end() {
        process.nextTick(() => {
          try {
            assert.ok(framedInput.endsWith('\n'));
            suppliedUserInput = JSON.parse(framedInput.slice(0, -1));
            assert.equal(suppliedUserInput.type, 'user');
            assert.equal(suppliedUserInput.message.role, 'user');
            assert.equal(suppliedUserInput.message.content, prompt);
            const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
            const init = template(row => row.type === 'system' && row.subtype === 'init');
            Object.assign(init, { session_id: session, model, cwd: value.root });
            const assistant = template(row => row.type === 'assistant');
            assistant.session_id = session;
            assistant.message.model = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
            assistant.message.content[0].input = original;
            const final = template(row => row.type === 'result');
            Object.assign(final, { session_id: session, is_error: false, structured_output: original, result: JSON.stringify(original) });
            const nativeFile = path.join(value.root, 'aggregate-native/project', session + '.jsonl');
            fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
            fs.writeFileSync(nativeFile, serialize([{ ...suppliedUserInput, sessionId: session },
              { ...structuredClone(assistant), sessionId: session, effort }]));
            const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
            const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
            const hookValue = name => hookArgs[hookArgs.indexOf(name) + 1];
            capture({ hook_event_name: 'SessionStart', source: 'startup', session_id: session,
              transcript_path: nativeFile, cwd: value.root }, {
              evidenceFile: hookValue('--evidence-file'), expectedSession: hookValue('--expected-session') });
            child.stdout.emit('data', Buffer.from(serialize([init, assistant, final])));
            child.emit('close', 0, null);
          } catch (error) { child.emit('error', error); }
        });
      } };
      return child;
    },
  });
  const adapter = createClaudeDispatchAdapter({ capabilities: runtime.capabilities, host: {
    async launch(selection) {
      const completed = await runtime.agent(prompt, selection);
      assert.deepEqual(completed.output, original);
      return runtime.applicationEvidence({ result: completed });
    },
  } });
  const dispatch = await createDispatchBoundary({ adapters: { claude: adapter }, recorder: value.recorder })
    .dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: subject, subject_kind: 'phase', phase: 47 });
  const receipt = dispatch.receipt;
  assert.equal(receipt.compliance, 'verified');
  assert.equal(receipt.session_id, session);
  assert.deepEqual(value.recorder.getVerifiedRecord(dispatch.dispatch_id).receipt, receipt);
  const stream = fs.readFileSync(receipt.transcript.path);
  const nativePath = path.join(path.dirname(receipt.transcript.path), 'projects', receipt.selection_evidence.transcript.path);
  const native = fs.readFileSync(nativePath);
  for (const [bytes, pin] of [[stream, receipt.transcript], [native, receipt.selection_evidence.transcript]]) {
    assert.equal(bytes.length, pin.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pin.sha256);
    assert.ok(bytes.toString('utf8').endsWith('\n'));
  }
  assert.notEqual(receipt.transcript.sha256, receipt.selection_evidence.transcript.sha256);
  const users = native.toString('utf8').trim().split('\n').map(JSON.parse)
    .filter(row => row.type === 'user' && row.sessionId === session);
  assert.equal(users.length, 1);
  assert.deepEqual(users[0].message, suppliedUserInput.message);
  return { aggregate: { ...aggregate, dispatch }, result, nativePath };
}

for (const conflict of [null, 'ticket', 'receipt.ticket', 'runtime_evidence.ticket'])
test('phase-local archive scope: batch catalogue aggregate identities ' + (conflict || 'discover current verdict'), async () => {
  const value = phaseScopeFixture();
  try {
    const graphPath = path.join(value.input.graphDir, 'tickets.json');
    const graph = JSON.parse(fs.readFileSync(graphPath));
    graph.tickets['T-47-02'] = { ...graph.tickets[value.ticket], repo: 'acme/foreign' };
    fs.writeFileSync(graphPath, JSON.stringify(graph));
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const originalSubject = target.PHASE_SUBJECT.exec(value.input.binding.subject);
    const bindingInput = { graph, state: {}, phase: 47, repository: originalSubject[2],
      branch: 'epic/47-scope', pr: 404, head: originalSubject[5], base: originalSubject[6] };
    assert.deepEqual(target.phaseBinding(bindingInput), value.input.binding);
    const foreignBinding = target.phaseBinding({ ...bindingInput, repo: 'acme/foreign' });
    assert.deepEqual(foreignBinding.ticketSet.map(member => member.id), ['T-47-02']);
    assert.notEqual(foreignBinding.subject, value.input.binding.subject);
    const selected = value.select();
    assert.deepEqual(selected.selection.records, value.roster.records);
    const subject = value.input.binding.subject;
    const { aggregate, result, nativePath } = await aggregateNativeDispatch(value, selected);
    const { dispatch } = aggregate;
    sealArchReview(aggregate, result);
    mutateFixtureCatalogue(value, payload => {
      const record = payload.records[dispatch.receipt.dispatch_id];
      delete record.ticket;
      record.receipt.ticket = subject;
      record.receipt.runtime_evidence = { ...record.receipt.runtime_evidence, ticket: subject };
      if (conflict === 'ticket') record.ticket = 'T-47-conflict';
      if (conflict === 'receipt.ticket') record.receipt.ticket = 'T-47-conflict';
      if (conflict === 'runtime_evidence.ticket') record.receipt.runtime_evidence.ticket = 'T-47-conflict';
    });
    const parsed = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').PHASE_SUBJECT.exec(subject);
    const lookup = extra => roleArtifact.currentArchitectureVerdict({ worktreePath: value.root,
      graphDir: value.input.graphDir, pr: 404, head: parsed[5], baseCommit: parsed[6],
      baseName: 'main', headBranch: 'epic/47-scope', ...extra });
    if (conflict) {
      for (const check of [value.select, lookup]) assert.throws(check,
        { code: 'ARCHIVE_AUTHORITY_INVALID', message: /original receipt identity differs/ });
    } else {
      assert.equal(value.select().candidates[0].dispatch_id, dispatch.receipt.dispatch_id);
      assert.equal(lookup().dispatch_id, dispatch.receipt.dispatch_id);
      assert.equal(lookup({ pr: 405 }), null);
      assert.equal(lookup({ head: parsed[6] }), null);
      assert.equal(lookup({ baseName: 'develop' }), null);
      assert.equal(lookup({ baseCommit: parsed[5] }), null);
      assert.equal(lookup({ repo: 'acme/foreign' }), null);
      const originalReceipt = JSON.stringify(value.recorder.getVerifiedRecord(dispatch.dispatch_id).receipt);
      for (const file of [dispatch.receipt.transcript.path, nativePath]) {
        const bytes = fs.readFileSync(file);
        const mode = fs.statSync(file).mode & 0o777;
        for (const malformed of [null, bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('altered\n')])]) {
          try {
            if (malformed === null) fs.unlinkSync(file);
            else fs.writeFileSync(file, malformed);
            assert.equal(lookup(), null, 'missing, truncated or altered original evidence must refuse current admission');
          } finally { fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); }
          assert.equal(lookup().dispatch_id, dispatch.receipt.dispatch_id);
          assert.equal(JSON.stringify(value.recorder.getVerifiedRecord(dispatch.dispatch_id).receipt), originalReceipt);
        }
      }
    }
  } finally { cleanPhaseScope(value); }
});

for (const registered of [false, true])
test('phase-local archive scope: unselected missing producer is not opened in ' +
    (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  try {
    const selected = value.select();
    assert.deepEqual(selected.selection.records, value.roster.records);
    const row = value.rows[registered ? 1 : 0];
    const family = path.join(row.worktree, roleArtifact.ARTIFACT_ARCHIVE_DIR, 'missing-producer');
    fs.mkdirSync(family);
    fs.writeFileSync(path.join(family, roleArtifact.MANIFEST_NAME), JSON.stringify({
      boundary_subject: value.input.binding.subject }));
    for (const options of [{}, { currentDispatchId: '' }]) {
      assert.deepEqual(value.select(options), selected);
    }
  } finally { cleanPhaseScope(value); }
});

for (const registered of [false, true])
for (const target of ['catalogue.json', 'hmac.key'])
test('phase-local archive scope: changed ' + target + ' during selection refuses in ' +
    (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  const previousReaddir = fs.readdirSync;
  const row = value.rows[registered ? 1 : 0];
  const family = path.dirname(path.join(row.worktree, row.pins[0].path));
  let changed = false;
  try {
    fs.readdirSync = function(file, ...args) {
      const names = previousReaddir.call(this, file, ...args);
      if (file === family && !changed) {
        changed = true;
        const authority = path.join(roleArtifact.archiveAuthorityDirectory(row.worktree), target);
        if (target === 'catalogue.json') fs.appendFileSync(authority, ' ');
        else fs.chmodSync(authority, 0o400);
      }
      return names;
    };
    assert.throws(() => value.select(), { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /archive authority changed during phase selection/ });
    assert.equal(changed, true);
  } finally { fs.readdirSync = previousReaddir; cleanPhaseScope(value); }
});

test('phase-local archive scope: total selected judgment bound precedes all candidate manifests', () => {
  const value = phaseScopeFixture({ second: true });
  const previousOpen = fs.openSync;
  try {
    for (const row of value.rows) mutateFixtureCatalogue({ root: row.worktree }, payload => {
      for (let i = 0; i < 501; i++) payload.records['candidate-' + i] = {
        dispatch_id: 'candidate-' + i, ticket: value.input.binding.subject,
        receipt: { role: 'arch-review' }, pins: [],
      };
    });
    fs.openSync = function(file, ...args) {
      if (String(file).includes('candidate-')) throw new Error('candidate opened before total bound');
      return previousOpen.call(this, file, ...args);
    };
    assert.throws(value.select, { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /selected phase judgments exceed their total bound/ });
  } finally { fs.openSync = previousOpen; cleanPhaseScope(value); }
});

test('phase-local archive scope: 10000 registered foreign worktree hints never open archive bodies or authority', () => {
  const value = phaseScopeFixture({ mixed: true });
  const graphPath = path.join(value.input.graphDir, 'tickets.json');
  const graph = JSON.parse(fs.readFileSync(graphPath));
  graph.tickets.foreign.epic = 'epic/47-scope';
  fs.writeFileSync(graphPath, JSON.stringify(graph));
  const foreign = path.join(path.dirname(value.root), 'foreign-' + Date.now());
  const gitShim = path.join(targetBin, 'git');
  const previousOpen = fs.openSync, previousReaddir = fs.readdirSync;
  try {
    execFileSync('git', ['-C', value.root, 'worktree', 'add', '--detach', foreign, 'HEAD'], { stdio: 'ignore' });
    addForeignPhaseFamilies(foreign);
    const authority = roleArtifact.archiveAuthorityDirectory(foreign);
    const expected = value.select();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(gitShim, '#!/usr/bin/env node\n' +
      'const cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
      'process.stdout.write(cp.execFileSync(' + JSON.stringify(realGit) + ', args));\n' +
      'if (args.includes("worktree") && args.includes("list")) for (let i = 0; i < 10000; i++) ' +
      'process.stdout.write("worktree " + ' + JSON.stringify('/tmp/t4716-unselected-') + ' + i + "\\n\\n");\n',
      { mode: 0o755 });
    fs.openSync = function(file, ...args) {
      if (String(file).startsWith(foreign + path.sep) || String(file).startsWith(authority + path.sep))
        throw new Error('foreign body or key opened');
      return previousOpen.call(this, file, ...args);
    };
    fs.readdirSync = function(file, ...args) {
      if (String(file).endsWith(roleArtifact.ARTIFACT_ARCHIVE_DIR)) throw new Error('archive enumerated');
      return previousReaddir.call(this, file, ...args);
    };
    assert.deepEqual(value.select(), expected);
    const subject = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').PHASE_SUBJECT.exec(value.input.binding.subject);
    assert.equal(roleArtifact.currentArchitectureVerdict({ worktreePath: value.root,
      graphDir: value.input.graphDir, pr: 404, head: subject[5], baseCommit: subject[6],
      baseName: 'main', headBranch: 'epic/47-scope' }), null);
  } finally {
    fs.openSync = previousOpen; fs.readdirSync = previousReaddir;
    if (fs.existsSync(gitShim)) fs.unlinkSync(gitShim);
    execFileSync('git', ['-C', value.root, 'worktree', 'remove', '--force', foreign], { stdio: 'ignore' });
    cleanPhaseScope(value);
  }
});

test('phase-local archive scope: authenticated empty history differs from missing history', () => {
  const value = phaseScopeFixture({ empty: true });
  try {
    assert.deepEqual(value.select().evidence, []);
    fs.unlinkSync(value.roster.record_path);
    assert.throws(value.select, /roster is missing/);
  } finally { cleanPhaseScope(value); }
});

test('phase-local archive scope: retained inventory cannot invent receipts, pins or roster replacements', () => {
  const value = phaseScopeFixture();
  try {
    for (const mutate of [rows => { rows[0].receipt.ticket = 'T-38-forged'; },
      rows => { rows[0].pins.pop(); }, rows => { rows[0].ticket = 'T-38-forged'; },
      rows => { rows.length = 0; }]) {
      const rows = structuredClone(value.rows); mutate(rows);
      fs.writeFileSync(value.input.inventoryPath, JSON.stringify({ rows }));
      const expectedInventoryDigest = require('node:crypto').createHash('sha256').update(fs.readFileSync(value.input.inventoryPath)).digest('hex');
      assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest }));
      assert.deepEqual(value.select().selection.records, value.roster.records);
    }
    assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest: '0'.repeat(64) }), /inventory differs/);
  } finally { cleanPhaseScope(value); }
});

test('phase-local archive scope: independent inventory and authenticated roster retain their 1000 limits', () => {
  const value = phaseScopeFixture();
  const original = fs.readFileSync(value.roster.record_path);
  try {
    const rows = Array.from({ length: 1001 }, () => value.rows[0]);
    fs.writeFileSync(value.input.inventoryPath, JSON.stringify({ rows }));
    const expectedInventoryDigest = require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(value.input.inventoryPath)).digest('hex');
    assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest }),
      { code: 'ARCHIVE_AUTHORITY_INVALID', message: /complete retained current inventory rows are required/ });
    const envelope = JSON.parse(original);
    envelope.payload.records = Array.from({ length: 1001 }, () => value.roster.records[0]);
    envelope.mac = require('node:crypto').createHmac('sha256',
      fs.readFileSync(path.join(path.dirname(value.roster.record_path), 'hmac.key')))
      .update(stableTestValue(envelope.payload)).digest('hex');
    fs.writeFileSync(value.roster.record_path, JSON.stringify(envelope));
    assert.throws(() => value.select(), { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /current phase roster authentication or membership differs/ });
  } finally { fs.writeFileSync(value.roster.record_path, original); cleanPhaseScope(value); }
});

test('phase-local archive scope: independently authenticated original record with conflicting receipt ticket refuses', () => {
  const value = phaseScopeFixture();
  try {
    const recorder = createDurableRecorder(path.join(value.root, 'conflicting-receipts'));
    const boundary = createDispatchBoundary({ adapters: { claude: { launch(resolution) {
      return { ...judgmentReceipt(resolution), ticket: 'T-38-conflicting' };
    } } }, recorder });
    const dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: value.ticket });
    const original = recorder.getVerifiedRecord(dispatch.receipt.dispatch_id);
    assert.equal(original.ticket, value.ticket);
    assert.equal(original.receipt.ticket, 'T-38-conflicting');
    const rows = [{ ...value.rows[0], dispatch_id: dispatch.receipt.dispatch_id,
      receipt: original.receipt, receipt_store: path.join(value.root, 'conflicting-receipts') }];
    fs.writeFileSync(value.input.inventoryPath, JSON.stringify({ rows }));
    const expectedInventoryDigest = require('node:crypto').createHash('sha256').update(fs.readFileSync(value.input.inventoryPath)).digest('hex');
    assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest }), /ticket identities conflict/);
  } finally { cleanPhaseScope(value); }
});

suite('original protected planning containment');

for (const repo of [null, 'acme/selected']) test('mixed repository archive scope retains exact selected evidence: ' + repo, () => {
  const value = phaseScopeFixture({repo,mixed:true});
  try {
    const selected = value.select();
    assert.deepEqual(selected.selection.identity.tickets,['T-47-01']);
    assert.equal(selected.evidence.length,1);
    for (const edit of [{repo:'acme/missing'}, {repo:repo === null ? 'acme/foreign' : null},
      {rows:[]}, {membership:'0'.repeat(64)}])
      assert.throws(()=>roleArtifact.selectPhaseArchives(value.root,{...value.input.binding,...edit},{graphDir:value.input.graphDir}));
    const pin = value.rows[0].pins.find(pin=>pin.path.endsWith('.md'));
    fs.unlinkSync(path.join(value.root,pin.path));
    assert.throws(()=>value.select({phaseArchiveSelection:selected.selection}));
  } finally {cleanPhaseScope(value);}
});

for (const corrupt of [false, true]) test('current integration excludes foreign catalogue before authority reads: ' + corrupt, () => {
  const value = phaseScopeFixture({ second: true });
  const read = fs.readFileSync;
  try {
    const foreign = path.join(roleArtifact.archiveAuthorityDirectory(fs.realpathSync(value.second)), 'catalogue.json');
    if (corrupt) fs.writeFileSync(foreign, 'corrupt foreign catalogue'.repeat(800000));
    let opened = 0;
    fs.readFileSync = function(file, ...args) {
      if (String(file) === foreign) { opened++; throw new Error('foreign catalogue must not be opened'); }
      return read.call(this, file, ...args);
    };
    const head = git(value.root, ['rev-parse', 'HEAD']);
    assert.equal(roleArtifact.currentIntegrationVerdict({ worktreePath: value.root, head,
      baseName: 'main', baseCommit: git(value.root, ['rev-parse', 'main']),
      graphDir: value.input.graphDir, headBranch: 'epic/47-scope' }), null);
    assert.equal(opened, 0);
  } finally { fs.readFileSync = read; cleanPhaseScope(value); }
});

for (const runtime of ['codex', 'claude']) test('aggregate original subject reconciles retained and legacy ' + runtime, () => {
  const value = judgmentFixture();
  try {
    const subject = 'phase=47-scope;repository=/fixture;tickets=' + 'a'.repeat(64);
    const launch = resolution => ({ ...judgmentReceipt(resolution),
      ...(resolution.agent_file ? { agent_file: resolution.agent_file,
        agent_file_digest: resolution.agent_file_digest } : {}) });
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const selected = policy.resolveDispatch({ runtime, role: 'integrator', signals: {} });
    const agentsDir = path.join(value.root, 'agents');
    if (runtime === 'codex') {
      fs.mkdirSync(agentsDir);
      const content = [
        '# shipyard-policy-id = "' + policy.POLICY.id + '"',
        '# shipyard-policy-version = "' + selected.policy_version + '"',
        '# shipyard-policy-hash = "' + selected.policy_hash + '"',
        '# shipyard-policy-runtime = "codex"',
        '# shipyard-policy-role = "' + selected.role + '"',
        '# shipyard-policy-rung = "' + selected.rung + '"',
        'name = "' + selected.agent_file.replace(/\.toml$/, '') + '"',
        'model = "' + selected.model + '"',
        'model_reasoning_effort = "' + selected.effort + '"',
        "developer_instructions = '''\nAuthenticate the original integration subject.\n'''", '',
      ].join('\n');
      fs.writeFileSync(path.join(agentsDir, selected.agent_file), content);
      fs.writeFileSync(path.join(agentsDir, '.shipyard-manifest.json'), JSON.stringify({
        policy_id: policy.POLICY.id, policy_version: selected.policy_version, policy_hash: selected.policy_hash,
        agent_files: [selected.agent_file], agent_digests: {
          [selected.agent_file]: require('node:crypto').createHash('sha256').update(content).digest('hex'),
        },
      }));
    }
    const boundary = createDispatchBoundary({ adapters: { [runtime]: {
      ...(runtime === 'codex' ? { agentsDir } : {}), launch, launchStatic: launch,
    } }, recorder: value.recorder });
    const dispatch = boundary.dispatch({ runtime, role: 'integrator', signals: {} }, { ticket: subject });
    if (runtime === 'codex') {
      assert.equal(dispatch.receipt.agent_file, selected.agent_file);
      assert.equal(dispatch.receipt.agent_file_digest,
      require('node:crypto').createHash('sha256')
        .update(fs.readFileSync(path.join(agentsDir, selected.agent_file))).digest('hex'));
    }
    const Module = require('node:module');
    const isolated = new Module(ROLE_ARTIFACT, module);
    isolated.filename = ROLE_ARTIFACT;
    isolated.paths = Module._nodeModulePaths(path.dirname(ROLE_ARTIFACT));
    isolated._compile(fs.readFileSync(ROLE_ARTIFACT, 'utf8')
      + '\nmodule.exports = { authenticatedRecordSubject };', ROLE_ARTIFACT);
    const record = { dispatch_id: dispatch.receipt.dispatch_id, receipt: dispatch.receipt,
      review_current: { receipt_store: value.recorder.storeDir } };
    const read = isolated.exports.authenticatedRecordSubject;
    assert.equal(read(record), subject);
    assert.equal(read({ ...record, review_current: undefined, receipt_store: value.recorder.storeDir }), subject);
    assert.equal(read({ ...record, ticket: subject }), subject);
    assert.throws(() => read({ ...record, ticket: subject + '-foreign' }));
    assert.throws(() => read({ ...record, receipt: { ...record.receipt, ticket: 'foreign' } }));
    assert.throws(() => read({ ...record, review_current: {} }));
    assert.throws(() => read({ ...record, dispatch_id: 'missing-original' }));
  } finally { clean(value); }
});

test('original native architecture authority reads coordinator-only planning on the reviewed epic', async () => {
  const f = codexJudgmentFixtures.fixture();
  const reviewed = f.root + '-epic';
  try {
    codexJudgmentFixtures.git(f.root, ['switch', 'main']);
    codexJudgmentFixtures.git(f.root, ['worktree', 'add', reviewed, codexJudgmentFixtures.BRANCH]);
    f.reviewRoot = fs.realpathSync(reviewed);
    codexJudgmentFixtures.git(reviewed, ['rm', '-r', '.planning']);
    codexJudgmentFixtures.git(reviewed, ['commit', '-qm', 'coordinator owns planning']);
    f.head = codexJudgmentFixtures.git(reviewed, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
    assert.equal(fs.existsSync(path.join(reviewed, '.planning')), false);
    const { validationInput, value } = await codexJudgmentFixtures.unitJudgment(f);
    assert.equal(value.prepared.packet.planning_reference.root, f.root);
    assert.equal(value.prepared.canonical.worktree, f.reviewRoot);
    assert.equal(roleArtifact.validateJudgmentManifest(validationInput).envelope.verdict, 'conform');
    assert.equal(roleArtifact.read(validationInput).envelope.verdict, 'conform');
    const lookup = { worktreePath: reviewed, pr: f.pr.number, head: f.head, baseName: 'main',
      baseCommit: f.base, headBranch: f.pr.headRefName, graphDir: path.join(f.root, '.planning/graph') };
    assert.equal(roleArtifact.currentArchitectureVerdict(lookup)?.dispatch_id, validationInput.dispatchId);
    fs.appendFileSync(path.join(f.root, '.planning/config.json'), ' ');
    assert.equal(roleArtifact.currentArchitectureVerdict(lookup), null);
  } finally {
    codexJudgmentFixtures.cleanupJudgment(f);
    fs.rmSync(reviewed, { recursive: true, force: true });
  }
});
}

module.exports = { registerRoleArtifacts };

if (require.main === module) {
  const { test, after } = require('node:test');
  const lifecycle = createRoleArtifactLifecycle();
  lifecycle.start();
  try {
    const context = createRoleArtifactFixture({ unitDir: __dirname,
      scriptsDir: require('node:path').resolve(__dirname, '../../plugins/delivery-pipeline/scripts'),
      require, module, assert: require('node:assert'), suite() {}, lifecycle });
    registerRoleArtifacts((name, callback) => test(name, { timeout: 180000, concurrency: 2 },
      () => lifecycle.run(callback)), context);
    after(async () => { await lifecycle.settle(); lifecycle.cleanup(); });
  } catch (error) { lifecycle.cleanup(); throw error; }
}
