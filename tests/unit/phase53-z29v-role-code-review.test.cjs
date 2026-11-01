'use strict';

const { createRoleArtifactFixture, createRoleArtifactLifecycle } = require('./helpers/phase53-role-artifact-fixture.cjs');

function registerRoleArtifacts(test, context) {
  const {
    require, module, unitDir: __dirname, assert, suite, fs, path, os, spawnSync, createDurableRecorder,
    roleArtifact, git, fixture, retainPlanningInput, foreignCodeReviewArchive, roleArtifactInternals,
  } = context;

function withOriginalPlanning(f) {
  const input = f.input;
  f.input = (...args) => retainPlanningInput(f, input(...args));
  return f;
}

function reverseReviewKeys(value) {
  if (Array.isArray(value)) return value.map(reverseReviewKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, item]) => [key, reverseReviewKeys(item)]));
  return value;
}

suite('original protected planning containment');

for (const incomplete of [false, true]) test('legacy reordered code-review membership reads publicly: incomplete=' + incomplete, () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    f.graph.tickets['T-52-01'].files = ['source.js', 'round.txt'];
    const binding = f.advance(1);
    const input = f.input(binding, 1, null, incomplete ? {
      ...JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/code-review/review.json'))),
      review_completeness: 'incomplete', limitations: ['Unread source remains'] } : undefined);
    input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
    assert.deepEqual(input.result.ticket_set, binding.ticketSet);
    assert.notEqual(JSON.stringify(input.result.ticket_set), JSON.stringify(binding.ticketSet));
    if (incomplete) {
      input.result.review_completeness = 'incomplete';
      input.result.verdict = 'incomplete';
      input.result.limitations = ['Unread source remains'];
    }
    const sealed = roleArtifact.sealJudgment(input);
    const original = fs.readFileSync(sealed.artifact_ref);
    const retainedFiles = [sealed.artifact_ref,
      ...roleArtifact.authenticatedArchivePins(f.root).map(pin => path.join(f.root, pin.path)),
      path.join(roleArtifact.archiveAuthorityDirectory(f.root), 'catalogue.json'),
      ...fs.readdirSync(f.recorder.storeDir).filter(name => name.startsWith('record-'))
        .map(name => path.join(f.recorder.storeDir, name))];
    const retainedBytes = retainedFiles.map(file => fs.readFileSync(file));
    const history = () => roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
      repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir });
    const prior = history();
    assert.equal(prior.length, 1);
    assert.equal(prior[0].blocking_count, 1);
    assert.equal(prior[0].review_completeness, incomplete ? 'incomplete' : 'complete');
    assert.equal(f.lookup().artifact_digest, sealed.artifact_digest);
    if (incomplete) {
      assert.equal(core.countableVerdicts({ priorVerdicts: prior, head: prior[0].head, isAncestor: () => false }).length, 0);
      const next = core.nextRound({ priorVerdicts: prior, head: input.result.head });
      assert.equal(next.rounds_used, 0);
      assert.equal(next.round, 1);
      assert.equal(next.scope, 'full');
      assert.equal(f.lookup().verdict, 'incomplete');
    }
    for (const [index, file] of retainedFiles.entries()) assert.deepEqual(fs.readFileSync(file), retainedBytes[index]);
    const manifest = JSON.parse(original);
    const findingsPath = path.join(f.root, manifest.files.findings.path);
    const findings = JSON.parse(fs.readFileSync(findingsPath));
    findings.ticket_set[0].row.files.reverse();
    fs.writeFileSync(findingsPath, JSON.stringify(findings));
    assert.throws(history);
    assert.equal(f.lookup(), null);
  } finally { f.cleanup(); }
});

for (const digestForm of ['omitted', 'alias'])
  test('legacy reordered membership preserves supported result digest form: ' + digestForm, () => {
    const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const f = withOriginalPlanning(reviewFixture());
    try {
      const binding = f.advance(1), input = f.input(binding);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      delete input.result.ticket_set_digest;
      if (digestForm === 'alias') input.result.ticketSetDigest = '0'.repeat(64);
      else input.ticketSetDigest = '0'.repeat(64);
      assert.throws(() => roleArtifact.sealJudgment(input), { code: 'JUDGMENT_DIGEST_MISMATCH' });
      input.ticketSetDigest = binding.membership;
      if (digestForm === 'alias') input.result.ticketSetDigest = binding.membership;
      const sealed = roleArtifact.sealJudgment(input);
      const prior = roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
        repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir });
      assert.equal(prior.length, 1);
      assert.equal(prior[0].artifact_digest, sealed.artifact_digest);
      assert.equal(f.lookup().artifact_digest, sealed.artifact_digest);
    } finally { f.cleanup(); }
  });

for (const mutation of ['manifest', 'file-index', 'mac', 'receipt', 'digest', 'subject', 'nested-evidence'])
  test('public legacy code-review consumers reject authentic archive tampering: ' + mutation, () => {
    const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const f = withOriginalPlanning(reviewFixture());
    try {
      const binding = f.advance(1), input = f.input(binding);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      const sealed = roleArtifact.sealJudgment(input);
      const manifest = JSON.parse(fs.readFileSync(sealed.artifact_ref));
      if (mutation === 'manifest') {
        manifest.head = f.base;
        fs.writeFileSync(sealed.artifact_ref, JSON.stringify(manifest));
      } else if (['file-index', 'mac'].includes(mutation)) {
        const file = path.join(roleArtifact.archiveAuthorityDirectory(f.root), 'catalogue.json');
        const envelope = JSON.parse(fs.readFileSync(file));
        if (mutation === 'mac') envelope.mac = '0'.repeat(64);
        else envelope.payload.records[input.dispatchId].pins[0].sha256 = '0'.repeat(64);
        fs.writeFileSync(file, JSON.stringify(envelope));
      } else if (mutation === 'receipt') {
        const file = 'record-' + require('node:crypto').createHash('sha256')
          .update(manifest.producer_dispatch).digest('hex') + '.json';
        assert.ok(fs.existsSync(path.join(f.recorder.storeDir, file)));
        fs.appendFileSync(path.join(f.recorder.storeDir, file), 'x');
      } else {
        const file = path.join(f.root, manifest.files.findings.path);
        const result = JSON.parse(fs.readFileSync(file));
        if (mutation === 'digest') result.ticket_set_digest = '0'.repeat(64);
        if (mutation === 'subject') result.id = binding.subject.replace('pr=52;', 'pr=53;');
        if (mutation === 'nested-evidence') result.ticket_set[0].evidence.status = 'pending';
        fs.writeFileSync(file, JSON.stringify(result));
      }
      assert.throws(() => roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
        repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir }));
      assert.equal(f.lookup(), null);
    } finally { f.cleanup(); }
  });

for (const mutation of ['added', 'deleted', 'member-order', 'row', 'evidence', 'array-order', 'digest', 'subject'])
  test('fresh code-review sealing rejects changed membership: ' + mutation, () => {
    const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
    const f = withOriginalPlanning(reviewFixture());
    try {
      f.graph.tickets['T-52-01'].files = ['source.js', 'round.txt'];
      const binding = f.advance(2);
      const input = f.input(binding);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      if (mutation === 'added') input.result.ticket_set.push({ id: 'T-52-99', row: {}, evidence: {} });
      if (mutation === 'deleted') input.result.ticket_set.pop();
      if (mutation === 'member-order') input.result.ticket_set.reverse();
      if (mutation === 'row') input.result.ticket_set[0].row.epic = 'epic/forged';
      if (mutation === 'evidence') input.result.ticket_set[0].evidence.status = 'pending';
      if (mutation === 'array-order') input.result.ticket_set[0].row.files.reverse();
      if (mutation === 'digest') input.result.ticket_set_digest = input.ticketSetDigest = '0'.repeat(64);
      if (mutation === 'subject') input.result.id = binding.subject.replace('pr=52;', 'pr=53;');
      assert.throws(() => roleArtifact.sealJudgment(input));
    } finally { f.cleanup(); }
  });

test('code-review lineage survives real fix-ticket membership changes and keeps reuse exact', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    const digests = [], snapshots = [], verdicts = [];
    for (let round=1; round<=3; round++) {
      const binding = f.advance(round); digests.push(binding.membership);
      snapshots.push(structuredClone({graph:f.graph,state:f.state}));
      const input = f.input(binding,round,verdicts.at(-1)?.head || null);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      const sealed = roleArtifact.sealJudgment(input);
      const validated = roleArtifact.validateJudgmentManifest({...input,artifactPath:sealed.artifact_ref,artifactDigest:sealed.artifact_digest});
      assert.equal(validated.manifest.repository_identity,target.repositoryIdentity(f.root));
      const prior = roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:target.repositoryIdentity(f.root),phaseDir:f.phase,graphDir:f.graphDir});
      assert.equal(prior.length,round); assert.deepEqual(prior.map(v=>v.review_round),Array.from({length:round},(_,i)=>i+1));
      verdicts.push(prior.at(-1));
      const next = core.nextRound({priorVerdicts:prior,head:input.result.head,isAncestor:(a,b)=>{try{f.git(['merge-base','--is-ancestor',a,b]);return true;}catch{return false;}}});
      assert.equal(next.rounds_used,round); assert.equal(next.round,round===3?null:round+1);
      assert.equal(next.state,round===3?'limit':'ready');
      if(round<3) assert.equal(next.scope,'delta');
      assert.equal(f.lookup().artifact_digest,sealed.artifact_digest);
    }
    const latestBinding=require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').phaseBinding({graph:f.graph,state:f.state,phase:52,repository:target.repositoryIdentity(f.root),pr:52,head:f.git(['rev-parse','HEAD']),base:f.base,branch:f.branch});
    const otherPhase={...latestBinding,subject:latestBinding.subject.replace('phase=52-review;','phase=53-other;')};
    roleArtifact.sealJudgment(f.input(otherPhase));
    const arch=f.dispatch('arch-review',latestBinding.subject);
    const archEvidence=path.join(f.root,'.shipyard-arch-review-evidence.md');fs.writeFileSync(archEvidence,'Complete architecture evidence');
    roleArtifact.sealJudgment({worktreePath:f.root,base:'main',role:'arch-review',ticket:latestBinding.subject,pr:52,ticketSet:latestBinding.ticketSet,ticketSetDigest:latestBinding.membership,recorder:f.recorder,dispatchId:arch.receipt.dispatch_id,evidencePath:archEvidence,result:{id:latestBinding.subject,pr:52,head:f.git(['rev-parse','HEAD']),base_tree:f.git(['rev-parse',f.base+'^{tree}']),ticket_set:latestBinding.ticketSet,ticket_set_digest:latestBinding.membership,verdict:'conform',blocking_count:0,findings:[]}});
    const integrationSubject=target.buildSubject('integrator',{phase:f.phase,repository:target.repositoryIdentity(f.root),tickets:latestBinding.membership});
    const integration=f.dispatch('integrator',integrationSubject);
    const integrationEvidence=path.join(f.root,'.planning/phases',f.phase,'INTEGRATION.md');fs.mkdirSync(path.dirname(integrationEvidence),{recursive:true});fs.writeFileSync(integrationEvidence,'Complete integration evidence');
    roleArtifact.sealJudgment({worktreePath:f.root,base:'main',role:'integrator',ticket:integrationSubject,phase:f.phase,ticketSet:latestBinding.ticketSet,ticketSetDigest:latestBinding.membership,recorder:f.recorder,dispatchId:integration.receipt.dispatch_id,evidencePath:integrationEvidence,result:{phase:f.phase,head:f.git(['rev-parse','HEAD']),base:'main',base_tree:f.git(['rev-parse',f.base+'^{tree}']),ticket_set:latestBinding.ticketSet,ticket_set_digest:latestBinding.membership,outcome:'passed',blocking_count:0,findings:[]}});
    assert.equal(roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:target.repositoryIdentity(f.root),phaseDir:f.phase}).length,3);
    assert.equal(new Set(digests).size,3);
    assert.equal(core.lineageComplete({verdict:verdicts[2],priorVerdicts:verdicts}),true);
    assert.deepEqual(roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:target.repositoryIdentity(f.root),phaseDir:'54-absent'}),[]);
    assert.deepEqual(roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:'/another/repository',phaseDir:f.phase}),[]);
    for(const snapshot of snapshots.slice(0,2)) {
      fs.writeFileSync(path.join(f.graphDir,'tickets.json'),JSON.stringify(snapshot.graph));
      fs.writeFileSync(path.join(f.graphDir,'delivery-state.json'),JSON.stringify({tickets:snapshot.state}));
      assert.equal(f.lookup(),null);
    }
    f.writeGraph();
    f.git(['commit','--allow-empty','--quiet','-m','moved head']); assert.equal(f.lookup(),null);
  } finally { f.cleanup(); }
});

test('sealed disagreements retain their original target through three rounds and twin ordinal shifts', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const source = name => fs.readFileSync(path.join(__dirname, '../fixtures/code-review', name), 'utf8');
  for (const lines of [[2,4,6], [4]]) {
    const f = withOriginalPlanning(reviewFixture());
    try {
      fs.writeFileSync(path.join(f.root, 'source.js'), source('twins.js'));
      f.git(['add', 'source.js']);
      const raw = JSON.parse(source('review.json'));
      const first = f.input(f.advance(1), 1, null, { ...raw, findings: lines.map((line, index) => ({
        ...raw.findings[0], id: 'CR-' + index, line, line_text: 'return null;',
      })) });
      roleArtifact.sealJudgment(first);
      const file = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [{
        path: 'source.js', line_text: 'return null;', occurrence: 2,
        reason: 'The middle caller handles absence', recorded_by: 'operator',
      }] });
      fs.writeFileSync(path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json'), file);
      const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
      let previous = first.result.head;
      for (const round of [2,3]) {
        if (round === 2) {
          fs.writeFileSync(path.join(f.root, 'source.js'), source('twins-added.js'));
          f.git(['add', 'source.js']);
        }
        const binding = f.advance(round);
        const prior = roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
          repository: target.repositoryIdentity(f.root), phaseDir: f.phase }).at(-1);
        const deltaDiff = f.git(['diff', '--unified=50', previous, 'HEAD']);
        const preCarry = core.carryPriorFindings({ priorFindings: prior, deltaDiff, readSource });
        const disagreements = core.parseDisagreements(file, { priorFindings: preCarry });
        const priorFindings = core.carryPriorFindings({ priorFindings: prior, deltaDiff, disagreements, readSource });
        assert.deepEqual(priorFindings.filter(finding => finding.disagreement).map(finding => finding.line), [5]);
        const blank = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [] };
        const original = { ...blank,
          findings: round === 2 ? [{ ...raw.findings[0], line: 5, line_text: 'return null;' }] : [],
          dispositions: priorFindings.filter(finding => !finding.disagreement).map(finding => ({
            ref: finding.ref, disposition: 'unresolved', justification: 'The other caller still fails',
          })),
        };
        const result = core.normalizeResult(original, { round, scope: 'delta', priorFindings, readSource });
        const input = f.input(binding, round, previous, blank);
        input.result = { ...input.result, ...result };
        require('../fixtures/code-review/artifact-fixture.cjs').setOriginalReview(input, original, priorFindings);
        retainPlanningInput(f, input);
        const sealed = roleArtifact.sealJudgment(input);
        const validated = roleArtifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest });
        const suppressed = validated.findings.findings.filter(finding => finding.suppressed);
        assert.deepEqual(suppressed.map(finding => finding.line), [5]);
        assert.equal(suppressed[0].occurrence, 3);
        assert.equal(suppressed[0].disagreement_identity, first.result.findings.find(finding => finding.line === 4).identity);
        assert.equal(f.lookup().disagreement_suppressed, 1);
        assert.equal(f.lookup().blocking_count, lines.length - 1);
        previous = input.result.head;
      }
    } finally { f.cleanup(); }
  }
});

test('code-review reuse refuses a moved base or reference contract and ticket-form subject', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    const binding=f.advance(1);
    const historicalRoot = path.join(f.root, '.planning/historical-reference');
    fs.cpSync(path.join(__dirname, '../../plugins/delivery-pipeline'), historicalRoot, { recursive: true });
    fs.appendFileSync(path.join(historicalRoot, 'references/code-review.md'), '\nChanged reference\n');
    const reference = require(path.join(historicalRoot, 'scripts/claude-reference-content.cjs')).loadClaudeReferenceContent('code-review');
    const fixtures = require('../fixtures/code-review/artifact-fixture.cjs');
    const input = fixtures.retainPlanningInput(f, f.input(binding), f.root, null, { reference });
    const historical = require(path.join(historicalRoot, 'scripts/role-artifact.cjs'));
    const historicalRecorder = require(path.join(historicalRoot, 'scripts/dispatch-boundary.cjs')).createDurableRecorder(path.join(f.root, 'receipts'));
    const sealed = historical.sealJudgment({ ...input, recorder: historicalRecorder });
    assert.equal(historical.currentCodeReviewVerdict({ worktreePath: f.root, pr: 52, head: input.result.head,
      baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.branch }).artifact_digest, sealed.artifact_digest);
    assert.equal(f.lookup(),null);
    roleArtifact.sealJudgment(f.input(binding)); assert.equal(f.lookup().authenticated,true);
    const head=f.git(['rev-parse','HEAD']);
    f.git(['update-ref','refs/remotes/origin/main',head]); assert.equal(f.lookup(),null);
    f.git(['update-ref','refs/remotes/origin/main',f.base]); assert.equal(f.lookup().authenticated,true);
    const {judgmentSubject}=roleArtifactInternals(['judgmentSubject']);
    assert.throws(()=>judgmentSubject('code-review',{ticket:'T-52-01'},{repository:{identity:'/repo'},head,base_commit:f.base},{},{digest:binding.membership},52));
  } finally {f.cleanup();}
});

for (const changed of ['config mapping', 'epic membership', 'graph symlink', 'source', 'untracked source', 'head', 'base', 'manifest', 'index', 'receipt', 'mac'])
  test('sealed foreign current authority refuses ' + changed, () => {
    const f = foreignCodeReviewArchive();
    try {
      const seal = roleArtifact.sealJudgment(retainPlanningInput(f, f.input, f.coordinator, 'acme/app'));
      assert.equal(f.lookup().verdict, 'pass');
      if (changed === 'config mapping') fs.writeFileSync(path.join(f.coordinator, '.planning/config.json'),
        JSON.stringify({ delivery_pipeline: { repos: { 'acme/app': f.coordinator } } }));
      if (changed === 'epic membership') {
        f.graph.epics['52'].repos = ['acme/other'];
        fs.writeFileSync(path.join(f.graphDir, 'tickets.json'), JSON.stringify(f.graph));
      }
      if (changed === 'graph symlink') {
        fs.renameSync(f.graphDir, f.graphDir + '-moved'); fs.symlinkSync(f.graphDir + '-moved', f.graphDir);
      }
      if (changed === 'source') fs.appendFileSync(path.join(f.root, 'source.js'), '\nchanged source');
      if (changed === 'untracked source') fs.writeFileSync(path.join(f.root, 'unexpected.js'), 'new source');
      if (changed === 'head') f.git(['commit', '--quiet', '--allow-empty', '-m', 'moved head']);
      if (changed === 'base') f.git(['update-ref', 'refs/remotes/origin/main', f.live.headRefOid]);
      if (changed === 'manifest') fs.appendFileSync(seal.artifact_ref, ' ');
      if (changed === 'index') {
        const manifest = JSON.parse(fs.readFileSync(seal.artifact_ref));
        manifest.envelope.findings_index.sha256 = '0'.repeat(64);
        fs.writeFileSync(seal.artifact_ref, JSON.stringify(manifest));
      }
      if (changed === 'receipt') {
        const manifest = JSON.parse(fs.readFileSync(seal.artifact_ref));
        const record = 'record-' + require('node:crypto').createHash('sha256')
          .update(manifest.producer_dispatch).digest('hex') + '.json';
        assert.ok(fs.existsSync(path.join(f.recorder.storeDir, record)));
        const file = path.join(f.recorder.storeDir, record), raw = JSON.parse(fs.readFileSync(file));
        raw.integrity.mac = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(raw));
      }
      if (changed === 'mac') {
        const catalogue = path.join(roleArtifact.archiveAuthorityDirectory(f.root), 'catalogue.json');
        const raw = JSON.parse(fs.readFileSync(catalogue));
        raw.mac = '0'.repeat(64); fs.writeFileSync(catalogue, JSON.stringify(raw));
      }
      let verdict;
      try { verdict = f.lookup(); } catch { verdict = null; }
      assert.equal(verdict, null);
    } finally { f.cleanup(); }
  });

for (const partitioned of [false, true]) for (const changed of ['plan', 'config', 'transcript'])
  test('existing-format foreign native input retains original planning pins: partitions=' + partitioned + ', ' + changed, () => {
    const f = foreignCodeReviewArchive();
    try {
      const plan = f.graph.tickets['T-52-01'].plan;
      const fixtures = require('../fixtures/code-review/artifact-fixture.cjs');
      fixtures.retainPlanningInput(f, f.input, f.coordinator, 'acme/app',
        { transport: partitioned ? 'host-files' : 'inline' });
      const native = f.recorder.getVerifiedRecord(f.input.dispatchId).receipt.selection_evidence.transcript;
      const transcript = native.path;
      assert.equal(f.input.result.host_context, undefined);
      const seal = roleArtifact.sealJudgment(f.input);
      assert.equal(f.lookup().artifact_digest, seal.artifact_digest);
      if (changed === 'plan') fs.appendFileSync(path.join(f.coordinator, plan), 'Changed acceptance\n');
      if (changed === 'config') fs.appendFileSync(path.join(f.coordinator, '.planning/config.json'), ' ');
      if (changed === 'transcript') fs.appendFileSync(transcript, ' ');
      let current;
      try { current = f.lookup(); } catch { current = null; }
      assert.equal(current, null);
      const prior = roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
        repository: require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').repositoryIdentity(f.root),
        phaseDir: f.phase, graphDir: f.graphDir });
      assert.equal(prior[0].artifact_digest, seal.artifact_digest);
    } finally { f.cleanup(); }
  });

  registerCarrierFreshness(test, context);
}

function registerCarrierFreshness(test, context) {
  const {
    require, module, unitDir: __dirname, assert, suite, fs, path, os, spawnSync, createDurableRecorder,
    roleArtifact, git, fixture, retainPlanningInput, foreignCodeReviewArchive,
  } = context;
suite('original protected planning containment');
test('code-review carrier freshness authentic canonical lifecycle on both runtimes and transports', async () => {
  if (process.env.SHIPYARD_CARRIER_FRESHNESS_CHILD !== '1') {
    const child = spawnSync(process.execPath, ['-e', `
      const path = require('node:path');
      const file = process.argv[1], unitDir = path.dirname(file);
      const localRequire = require('node:module').createRequire(file);
      const { registerCarrierFreshness } = localRequire(file);
      const { createRoleArtifactFixture, createRoleArtifactLifecycle } = localRequire('./helpers/phase53-role-artifact-fixture.cjs');
      const harness = localRequire('./assert-harness.cjs');
      const lifecycle = createRoleArtifactLifecycle();
      lifecycle.start();
      try {
        const context = createRoleArtifactFixture({ unitDir,
          scriptsDir: path.resolve(unitDir, '../../plugins/delivery-pipeline/scripts'),
          require: localRequire, module: require.cache[file], assert: harness.assert, suite: harness.suite, lifecycle });
        registerCarrierFreshness((name, callback) => harness.test(name, () => lifecycle.run(callback)), context);
        lifecycle.settle().finally(() => { lifecycle.cleanup(); harness.done(); });
      } catch (error) { lifecycle.cleanup(); throw error; }
    `, __filename], {
      env: { ...process.env, SHIPYARD_CARRIER_FRESHNESS_CHILD: '1' }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }

  const Module = require('node:module');
  const savedHome = os.homedir, savedPath = process.env.PATH;
  const markers = new Map(['SHIPYARD_RUNTIME', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']
    .map(key => [key, process.env[key]]));
  const loadFixture = (name, exports) => {
    const file = path.join(__dirname, name);
    const loaded = new Module(file, module);
    loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'node:test') return () => {};
      return load.call(this, name, ...args);
    };
    try { loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = {' + exports + '};\n', file); }
    finally { Module._load = load; }
    return loaded.exports;
  };
  try {
    const codex = loadFixture('codex-code-review-context.test.cjs', 'fixture, review');
    const claude = loadFixture('claude-role-host.test.cjs',
      'coordinatorOnlyPlanning, hostOptions, livePr, phasePreparationRequest, cleanupFixture, PHASE');
    const context = require('../../plugins/delivery-pipeline/scripts/codex-code-review-context.cjs');
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const flow = require('../../plugins/delivery-pipeline/scripts/phase-code-review.cjs');
    const originalCarrier = Buffer.from(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [] }) + '\n');
    for (const runtime of ['codex', 'claude']) for (const partitioned of [false, true]) for (const present of [false, true]) {
      const source = ('const captured = "' + 'x'.repeat(1024) + '";\n').repeat(1020);
      const f = runtime === 'codex' ? codex.fixture() : claude.coordinatorOnlyPlanning('code-review',
        partitioned ? { sourceContent: source } : {});
      try {
        if (runtime === 'codex' && partitioned) f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), source));
        const phase = runtime === 'codex' ? path.basename(path.dirname(f.row.plan)) : claude.PHASE;
        const configFile = path.join(f.project, '.planning/config.json');
        const config = JSON.parse(fs.readFileSync(configFile));
        config.delivery_pipeline = { ...config.delivery_pipeline, code_review: 'hold' };
        fs.writeFileSync(configFile, JSON.stringify(config));
        const carrier = path.join(f.project, '.planning/phases', phase, 'code-review-disagreements.json');
        if (present) fs.writeFileSync(carrier, originalCarrier);
        const graphFile = path.join(f.graphDir, 'tickets.json');
        const graph = JSON.parse(fs.readFileSync(graphFile));
        graph.epics = { ...graph.epics, [Number(phase.match(/^\d+/)[0])]: {
          branch: Object.values(graph.tickets)[0].epic, phaseDir: phase, repos: [null],
        } };
        fs.writeFileSync(graphFile, JSON.stringify(graph));
        let result, recorder, packet, dispatchId;
        if (runtime === 'codex') {
          const review = codex.review(f);
          result = review.result; recorder = review.recorder; dispatchId = review.dispatch.dispatch_id;
          packet = review.value.prepared.packet;
          assert.equal(!!context.admittedFileInput(review.value), partitioned);
        } else {
          const options = claude.hostOptions(f, { originalStream: true, onLaunch(prompt) {
            assert.equal(prompt.includes('<AUTHENTICATED_FOCUSED_INPUT>'), partitioned);
          } });
          const factory = options.createRuntimeHost;
          options.createRuntimeHost = input => { const runtimeHost = factory(input); recorder = runtimeHost.recorder; return runtimeHost; };
          options.getPullRequest = () => ({ ...claude.livePr(f), baseRefName: 'integration' });
          result = await require('../fixtures/phase53/code-review-native-driver.cjs')
            .produceHistoricalClaudeReview(options, claude.phasePreparationRequest(f));
          dispatchId = result.dispatch.receipt.dispatch_id;
        }
        const pr = runtime === 'codex' ? f.pr : { ...claude.livePr(f), baseRefName: 'integration' };
        const lookup = { worktreePath: f.root, graphDir: f.graphDir, headBranch: pr.headRefName,
          pr: pr.number, head: pr.headRefOid, baseName: pr.baseRefName, baseCommit: pr.baseRefOid };
        const current = () => roleArtifact.currentCodeReviewVerdict(lookup);
        const prior = () => roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root, graphDir: f.graphDir,
          repository: target.repositoryIdentity(f.root), phaseDir: phase });
        const before = prior();
        const seal = before.at(-1), original = fs.readFileSync(seal.artifact_ref);
        assert.equal(current()?.dispatch_id, dispatchId);
        assert.ok(recorder.getVerifiedRecord(dispatchId));
        const validation = { worktreePath: f.root, role: 'code-review', ticket: result.subject || result.ticket,
          pr: pr.number, phase, base: JSON.parse(original).base, recorder, dispatchId,
          ticketSet: result.result.ticket_set, ticketSetDigest: result.result.ticket_set_digest,
          artifactPath: seal.artifact_ref, artifactDigest: seal.artifact_digest };
        assert.equal(roleArtifact.validateJudgmentManifest(validation).envelope.outcome, 'pass');
        assert.equal(roleArtifact.read(validation).envelope.outcome, 'pass');
        if (packet) assert.equal(packet.role_context.dispositions_digest, present
          ? require('node:crypto').createHash('sha256').update(originalCarrier).digest('hex') : null);
        const restore = () => { fs.rmSync(carrier, { recursive: true, force: true }); if (present) fs.writeFileSync(carrier, originalCarrier); };
        const stale = () => {
          assert.equal(current(), null);
          const status = flow.status({ worktree: f.root, graphDir: f.graphDir, phase: Number(phase.match(/^\d+/)[0]),
            pr: pr.number, live: pr, defaultBranch: runtime === 'codex' ? 'main' : 'integration' });
          assert.equal(status.reuse, false);
          assert.equal(status.rounds_used, 1); assert.equal(status.round_cap, 3);
          assert.equal(flow.evaluateGate(status).ok, false);
          assert.deepEqual(prior(), before);
          assert.deepEqual(fs.readFileSync(seal.artifact_ref), original);
        };
        for (const mutate of [
          () => fs.writeFileSync(carrier, Buffer.concat([originalCarrier, Buffer.from(' ')])),
          () => { fs.rmSync(carrier, { force: true }); if (!present) fs.writeFileSync(carrier, originalCarrier); },
          () => fs.writeFileSync(carrier, '{'),
          () => fs.writeFileSync(carrier, Buffer.from([0xff])),
          () => fs.writeFileSync(carrier, 'x'.repeat(65537)),
          () => { fs.rmSync(carrier, { force: true }); fs.mkdirSync(carrier); },
          () => { fs.rmSync(carrier, { force: true }); fs.symlinkSync(path.join(f.project, '.planning/config.json'), carrier); },
        ]) {
          mutate(); stale(); restore(); assert.equal(current()?.artifact_digest, seal.artifact_digest);
        }
        const shadow = path.join(f.root, '.planning/phases', phase, 'code-review-disagreements.json');
        fs.mkdirSync(path.dirname(shadow), { recursive: true }); fs.writeFileSync(shadow, originalCarrier);
        fs.writeFileSync(carrier, Buffer.concat([originalCarrier, Buffer.from(' ')]));
        stale(); restore(); assert.equal(current()?.artifact_digest, seal.artifact_digest);
      } finally { if (runtime === 'codex') f.cleanup(); else claude.cleanupFixture(f); }
    }
  } finally {
    os.homedir = savedHome; process.env.PATH = savedPath;
    for (const [key, value] of markers) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
}

module.exports = { registerRoleArtifacts, registerCarrierFreshness };

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
