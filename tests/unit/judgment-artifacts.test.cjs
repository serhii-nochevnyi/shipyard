'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { createDurableRecorder, createDispatchBoundary } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const roleArtifact = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');

function retainPlanningInput(f, input, planningRoot = f.root, repo = null) {
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const crypto = require('node:crypto');
  const refs = input.result.ticket_set.map(item => item.row.plan);
  for (const plan of refs) {
    const absolute = path.join(planningRoot, plan);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, '# Original complete acceptance\n');
  }
  const graphDir = path.join(planningRoot, '.planning/graph');
  const packet = packets.buildContextPacket({ root: planningRoot, role: 'code-review', subject: input.ticket,
    sourceRevision: input.result.head, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
    scope: { files_modified: ['source.js'] }, requiredRefs: refs, roleContext: {
      planning_reference: packets.resolvePlanningReference({ worktree: f.root, graphDir, repo }),
      ticket_set: input.result.ticket_set, prior_findings: [], plan_acceptance: [],
      exact_diff: { content: f.git([
        'diff', '--no-ext-diff', '--no-textconv', '--unified=50',
        input.result.review_scope === 'delta' ? input.result.prior_head : f.base,
        'HEAD', ...require('../../plugins/delivery-pipeline/scripts/development-artifacts.cjs').productPathspec()
      ]) },
      integration_base: { commit: f.base } } });
  const boundary = createDispatchBoundary({ recorder: f.recorder, adapters: { claude: { launch(r) {
    const session = 'original-' + r.dispatch_id;
    const transcript = path.join(planningRoot, '.planning', session + '.jsonl');
    const content = JSON.stringify({ type: 'user', sessionId: session, message: {
      content: '<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packets.encodeUniqueContent(packet))
        + '\n</AUTHENTICATED_CONTEXT_PACKET>' } }) + '\n';
    fs.writeFileSync(transcript, content);
    return { receipt_type: 'adr-014.application', runtime: r.runtime, role: r.role, dispatch_id: r.dispatch_id,
      launch_id: session, session_id: session, requested_model: r.requested_model, requested_effort: r.requested_effort,
      applied_model: r.model, applied_effort: r.effort, observed_model: r.model, observed_effort: r.effort,
      policy_hash: r.policy_hash, selection_evidence: { source: 'claude-session-assistant-transcript',
        session_id: session, assistant_records: 1, model: r.model, effort: r.effort,
        transcript: { path: transcript, bytes: Buffer.byteLength(content),
          sha256: crypto.createHash('sha256').update(content).digest('hex') } } };
  } } } });
  const dispatch = boundary.dispatch({ runtime: 'claude', role: 'code-review', signals: {} },
    { ticket: input.ticket, subject_kind: 'phase' });
  return { ...input, dispatchId: dispatch.dispatch_id };
}

function withOriginalPlanning(f) {
  const input = f.input;
  f.input = (...args) => retainPlanningInput(f, input(...args));
  return f;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function receiptFor(resolution) {
  const launchId = `judgment-launch-${resolution.dispatch_id}`;
  return {
    receipt_type: 'adr-014.application',
    runtime: resolution.runtime,
    role: resolution.role,
    dispatch_id: resolution.dispatch_id,
    launch_id: launchId,
    requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort,
    applied_model: resolution.model,
    applied_effort: resolution.effort,
    observed_model: resolution.model,
    observed_effort: resolution.effort,
    policy_hash: resolution.policy_hash,
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: launchId,
    },
  };
}

function fakeAdapter() {
  return {
    launch: (resolution) => receiptFor(resolution),
  };
}

const INTEGRATION_PHASE = '33-reduce-orchestration-context-and-transfer-sessions-safely';

function roundSubject(ticketSet) {
  return `round:${crypto.createHash('sha256').update(JSON.stringify(ticketSet)).digest('hex')}`;
}

function phaseSubject(root, ticketSet) {
  const common = git(root, ['rev-parse', '--git-common-dir']);
  const repository = fs.realpathSync(path.resolve(root, common));
  const ticketSetDigest = crypto.createHash('sha256').update(JSON.stringify(ticketSet)).digest('hex');
  return `phase=${INTEGRATION_PHASE};repository=${repository};tickets=${ticketSetDigest}`;
}

function integrationEvidencePath(root) {
  return path.join(root, '.planning', 'phases', INTEGRATION_PHASE, 'INTEGRATION.md');
}

function fixture(role, boundaryTicket) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-judgment-artifact-'));
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'judgment-artifact@example.test']);
  git(root, ['config', 'user.name', 'Judgment Artifact Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '--quiet', '-m', 'judgment artifact base']);
  git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'main'])]);
  const branchName = `ticket/${role}-fixture`;
  git(root, ['switch', '--quiet', '-c', branchName]);
  fs.writeFileSync(path.join(root, 'change.txt'), 'change\n');
  git(root, ['add', 'change.txt']);
  git(root, ['commit', '--quiet', '-m', 'judgment artifact change']);

  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const boundary = createDispatchBoundary({
    adapters: { claude: fakeAdapter() },
    recorder,
  });
  const ticket = typeof boundaryTicket === 'function' ? boundaryTicket(root) : boundaryTicket;
  const dispatch = boundary.dispatch(
    { runtime: 'claude', role, signals: {} },
    { ticket, ...(role === 'pr-sentinel' ? { subject_kind: 'round' } : {}) },
  );
  return { root, recorder, dispatch, boundaryTicket: ticket, branchName };
}

function revision(root) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const headTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const base = git(root, ['rev-parse', 'main']);
  const baseTree = git(root, ['rev-parse', `${base}^{tree}`]);
  const mergeBase = git(root, ['merge-base', 'main', 'HEAD']);
  const mergeBaseTree = git(root, ['rev-parse', `${mergeBase}^{tree}`]);
  return { head, headTree, base, baseTree, mergeBase, mergeBaseTree };
}

function evidence(root, name, text) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`, 'utf8');
  return file;
}

function archResult(root, ticket, extra = {}) {
  const identity = revision(root);
  return {
    id: ticket,
    pr: 404,
    verdict: 'violation',
    head: identity.head,
    base_tree: identity.mergeBaseTree,
    blocking_count: 1,
    summary: 'summary deliberately capped while the complete blocker remains archived '.repeat(8),
    findings: [{
      id: 'late-blocker',
      type: 'violation',
      adr: 'ADR-014',
      section: '§4 mandatory dispatch boundary',
      file: 'plugins/delivery-pipeline/scripts/role-artifact.cjs',
      line: 44,
      hunk: 'role-artifact.cjs:44',
      remediation: 'validate the complete finding index before writing the conform trailer',
      summary: 'blocker beyond the bounded synopsis',
    }],
    ...extra,
  };
}

function sealInput(fixtureValue, result, extra = {}) {
  const role = extra.role || 'arch-review';
  let defaultPr;
  if (role === 'arch-review') {
    defaultPr = extra.pr;
    if (defaultPr === undefined && result && result.pr !== undefined) defaultPr = result.pr;
    if (defaultPr === undefined) defaultPr = 404;
  }
  return {
    worktreePath: fixtureValue.root,
    role,
    ticket: fixtureValue.boundaryTicket,
    base: 'main',
    recorder: fixtureValue.recorder,
    dispatchId: fixtureValue.dispatch.receipt.dispatch_id,
    ...(defaultPr === undefined ? {} : { pr: defaultPr }),
    result,
    ...extra,
  };
}

suite('judgment artifacts — complete evidence at the consuming boundary');

test('architecture conform/violation results retain every blocker and exact reviewed tree', () => {
  const value = fixture('arch-review', 'T-33-04-arch');
  try {
    const result = archResult(value.root, value.boundaryTicket);
    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...result,
        verdict: 'conform',
        blocking_count: 0,
        summary: 'the synopsis omits the late blocker '.repeat(100),
      }, {
        role: 'arch-review',
        evidencePath: evidence(value.root, '.shipyard-arch-review-evidence.md', 'complete evidence with a late blocker'),
      })),
      (error) => error && error.code === 'JUDGMENT_COUNT_MISMATCH',
    );
    const sealed = roleArtifact.seal(sealInput(value, result, {
      role: 'arch-review',
      ticket: value.boundaryTicket,
      evidencePath: evidence(value.root, '.shipyard-arch-review-evidence.md', [
        'Command: gh pr diff 404 --repo example/shipyard',
        'Path: plugins/delivery-pipeline/scripts/role-artifact.cjs:44',
        'ADR-014 §4 violation; remediation: validate the complete finding index.',
      ].join('\n')),
    }));
    assert.equal(sealed.envelope.verdict, 'violation');
    assert.equal(sealed.envelope.blocking_count, 1);
    assert.equal(sealed.envelope.finding_count, 1);
    assert.equal(sealed.envelope.reviewed_head, result.head);
    assert.equal(sealed.envelope.reviewed_base_tree, result.base_tree);
    assert.ok(sealed.findings_index);

    const read = roleArtifact.read({
      ...sealInput(value, undefined, {
        role: 'arch-review',
        ticket: value.boundaryTicket,
        artifactPath: sealed.artifact_ref,
        artifactDigest: sealed.artifact_digest,
      }),
    });
    assert.equal(read.findings.findings[0].remediation, result.findings[0].remediation);
    assert.match(read.evidence, /complete finding index/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('architecture evidence without the reviewed head or merge-base tree cannot be sealed', () => {
  const value = fixture('arch-review', 'T-33-04-arch-missing-revision');
  try {
    const result = archResult(value.root, value.boundaryTicket, { head: undefined });
    assert.throws(
      () => roleArtifact.seal(sealInput(value, result, {
        role: 'arch-review',
        evidencePath: evidence(value.root, '.shipyard-arch-review-evidence.md', 'complete evidence'),
      })),
      (error) => error && error.code === 'MISSING_REVIEWED_REVISION',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('judgment preparation rotates stale role evidence before a fresh dispatch result', () => {
  const value = fixture('arch-review', 'T-33-04-arch-rotation');
  try {
    const evidencePath = evidence(value.root, '.shipyard-arch-review-evidence.md', 'evidence from an earlier attempt');
    const prepared = roleArtifact.prepareRoleArtifact({
      worktreePath: value.root,
      role: 'arch-review',
    });
    assert.equal(prepared.path, path.join(fs.realpathSync(value.root), path.basename(evidencePath)));
    assert.equal(prepared.cleared, true);
    assert.equal(fs.existsSync(evidencePath), false);
    assert.throws(
      () => roleArtifact.seal(sealInput(value, archResult(value.root, value.boundaryTicket), {
        role: 'arch-review',
        evidencePath,
      })),
      (error) => error && error.code === 'MISSING_ARTIFACT',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('a conform architecture judgment cannot hide a non-blocking ADR finding', () => {
  const value = fixture('arch-review', 'T-33-04-arch-nonblocking');
  try {
    const result = archResult(value.root, value.boundaryTicket, {
      verdict: 'conform',
      blocking_count: 0,
      findings: [{
        id: 'informational-violation',
        type: 'violation',
        blocking: false,
        adr: 'ADR-014',
        section: '§4 mandatory dispatch boundary',
        file: 'plugins/delivery-pipeline/scripts/role-artifact.cjs',
        line: 44,
        hunk: 'role-artifact.cjs:44',
        remediation: 'retain the finding instead of reporting conform',
        summary: 'non-blocking finding still records an ADR violation',
      }],
    });
    assert.throws(
      () => roleArtifact.seal(sealInput(value, result, {
        role: 'arch-review',
        evidencePath: evidence(value.root, '.shipyard-arch-review-evidence.md', 'complete evidence'),
      })),
      (error) => error && error.code === 'JUDGMENT_OUTCOME_MISMATCH',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('a conform architecture judgment can retain an unknown type as an informational note', () => {
  const value = fixture('arch-review', 'T-33-04-arch-conform-unknown-note');
  try {
    const result = archResult(value.root, value.boundaryTicket, {
      verdict: 'conform',
      blocking_count: 0,
      findings: [{ id: 'F1', type: 'future-review-signal', summary: 'unrecognized but informational' }],
    });
    const sealed = roleArtifact.seal(sealInput(value, result, {
      role: 'arch-review',
      evidencePath: evidence(value.root, '.shipyard-arch-review-evidence.md', 'complete evidence'),
    }));
    assert.equal(sealed.envelope.verdict, 'conform');
    assert.equal(sealed.envelope.outcome, 'conform');
    assert.equal(sealed.envelope.blocking_count, 0);
    assert.equal(sealed.envelope.finding_count, 1);

    const read = roleArtifact.read(sealInput(value, undefined, {
      role: 'arch-review',
      ticket: value.boundaryTicket,
      artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest,
    }));
    assert.deepEqual(read.findings.findings[0], {
      id: 'F1',
      type: 'informational',
      summary: 'unrecognized but informational',
      original_type: 'future-review-signal',
      blocking: false,
    });
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('a known informational or note finding cannot forge original_type under conform', () => {
  for (const type of ['informational', 'note']) {
    const value = fixture('arch-review', `T-33-04-arch-forged-original-${type}`);
    try {
      const result = archResult(value.root, value.boundaryTicket, {
        verdict: 'conform',
        blocking_count: 0,
        findings: [{
          id: 'F1', type, blocking: false, summary: 'known informational finding', original_type: 'future-review-signal',
        }],
      });
      assert.throws(
        () => roleArtifact.seal(sealInput(value, result, {
          role: 'arch-review',
          evidencePath: evidence(value.root, '.shipyard-arch-review-evidence.md', 'complete evidence'),
        })),
        (error) => error && error.code === 'JUDGMENT_OUTCOME_MISMATCH',
      );
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test('a sentinel round is bound to its complete guarded ticket set, not one fabricated ticket', () => {
  const tickets = [
    { id: 'T-33-A', pr: 501, head: 'a'.repeat(40), base: 'epic/33' },
    { id: 'T-33-B', pr: 502, head: 'b'.repeat(40), base: 'epic/33' },
  ];
  const value = fixture('pr-sentinel', roundSubject(tickets));
  try {
    const result = {
      outcome: 'clear',
      blocking_count: 0,
      summary: 'guard completed the deterministic live duties',
      ticket_set: tickets,
      performed: [
        { ticket: 'T-33-A', duty: 'wait-ci', status: 'handed-back' },
        { ticket: 'T-33-B', duty: 'undraft', status: 'complete' },
      ],
      refused: [],
    };
    const sealed = roleArtifact.seal(sealInput(value, result, {
      role: 'pr-sentinel',
      ticketSet: tickets,
      evidencePath: evidence(value.root, '.shipyard-sentinel-evidence.md', 'every live duty was checked'),
    }));
    assert.match(sealed.envelope.subject, /^round:/);
    assert.equal(sealed.envelope.performed_count, 2);
    assert.equal(sealed.envelope.refused_count, 0);
    assert.equal(sealed.envelope.blocking_count, 0);
    assert.ok(sealed.envelope.duties_index);
    assert.deepStrictEqual(sealed.findings_index, sealed.envelope.findings_index);

    const missingTicket = { ...result, performed: [result.performed[0]] };
    assert.throws(
      () => roleArtifact.seal(sealInput(value, missingTicket, {
        role: 'pr-sentinel',
        ticketSet: tickets,
        evidencePath: path.join(value.root, '.shipyard-sentinel-evidence.md'),
      })),
      (error) => error && error.code === 'INCOMPLETE_DUTY_SET',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('sentinel surplus duties and refused gates cannot be presented as a clear round', () => {
  const tickets = [{ id: 'T-33-A', pr: 503, head: 'c'.repeat(40), base: 'epic/33' }];
  const value = fixture('pr-sentinel', roundSubject(tickets));
  try {
    const result = {
      outcome: 'clear',
      blocking_count: 0,
      summary: 'false clear',
      ticket_set: tickets,
      performed: [{ ticket: 'T-33-X', duty: 'merge', status: 'complete' }],
      refused: [],
    };
    assert.throws(
      () => roleArtifact.seal(sealInput(value, result, {
        role: 'pr-sentinel',
        ticketSet: tickets,
        evidencePath: evidence(value.root, '.shipyard-sentinel-evidence.md', 'complete'),
      })),
      (error) => error && error.code === 'JUDGMENT_IDENTITY_MISMATCH',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('a sentinel round authenticates its ticket-set digest and allows separate duties per ticket', () => {
  const tickets = [{ id: 'T-33-A', pr: 504, head: 'd'.repeat(40), base: 'epic/33' }];
  const value = fixture('pr-sentinel', roundSubject(tickets));
  try {
    const result = {
      outcome: 'clear',
      blocking_count: 0,
      summary: 'all duties completed',
      ticket_set: tickets,
      performed: [
        { ticket: 'T-33-A', duty: 'wait-ci', status: 'complete' },
        { ticket: 'T-33-A', duty: 'undraft', status: 'complete' },
      ],
      refused: [],
    };
    const sealed = roleArtifact.seal(sealInput(value, result, {
      role: 'pr-sentinel',
      ticketSet: tickets,
      evidencePath: evidence(value.root, '.shipyard-sentinel-evidence.md', 'complete evidence'),
    }));
    assert.equal(sealed.envelope.performed_count, 2);

    const duplicateDuty = {
      ...result,
      performed: [result.performed[0], { ...result.performed[0] }],
    };
    assert.throws(
      () => roleArtifact.seal(sealInput(value, duplicateDuty, {
        role: 'pr-sentinel',
        ticketSet: tickets,
        evidencePath: path.join(value.root, '.shipyard-sentinel-evidence.md'),
      })),
      (error) => error && error.code === 'DUPLICATE_DUTY',
    );

    const refusedStatusInPerformed = {
      ...result,
      performed: [{ ticket: 'T-33-A', duty: 'wait-ci', status: 'refused' }],
    };
    assert.throws(
      () => roleArtifact.seal(sealInput(value, refusedStatusInPerformed, {
        role: 'pr-sentinel',
        ticketSet: tickets,
        evidencePath: path.join(value.root, '.shipyard-sentinel-evidence.md'),
      })),
      (error) => error && error.code === 'INCOMPLETE_DUTY',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('a sentinel receipt for another round cannot seal this ticket set', () => {
  const tickets = [{ id: 'T-33-A', pr: 505, head: 'e'.repeat(40), base: 'epic/33' }];
  const value = fixture('pr-sentinel', `round:${'0'.repeat(64)}`);
  try {
    const result = {
      outcome: 'clear',
      blocking_count: 0,
      summary: 'wrong round',
      ticket_set: tickets,
      performed: [{ ticket: 'T-33-A', duty: 'wait-ci', status: 'complete' }],
      refused: [],
    };
    assert.throws(
      () => roleArtifact.seal(sealInput(value, result, {
        role: 'pr-sentinel',
        ticketSet: tickets,
        evidencePath: evidence(value.root, '.shipyard-sentinel-evidence.md', 'complete evidence'),
      })),
      (error) => error && error.code === 'JUDGMENT_IDENTITY_MISMATCH',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('integrator preserves human-review-required findings and rejects duplicate or tampered delivery', () => {
  const tickets = ['T-33-01', 'T-33-02', 'T-33-03'];
  const value = fixture('integrator', (root) => phaseSubject(root, tickets));
  try {
    const identity = revision(value.root);
    const prepared = roleArtifact.prepareRoleArtifact({
      worktreePath: value.root,
      role: 'integrator',
      phase: INTEGRATION_PHASE,
    });
    assert.equal(prepared.path, path.join(
      fs.realpathSync(value.root),
      '.planning', 'phases', INTEGRATION_PHASE, 'INTEGRATION.md',
    ));
    const integrationPath = evidence(value.root, path.relative(value.root, integrationEvidencePath(value.root)), [
      '# Integration judgment',
      'Outcome: human-review-required',
      'Question: approve the retained live gate before phase completion.',
    ].join('\n'));
    const result = {
      outcome: 'human-review-required',
      head: identity.head,
      head_tree: identity.headTree,
      base: identity.base,
      base_tree: identity.baseTree,
      ticket_set: tickets,
      ticket_set_digest: crypto.createHash('sha256').update(JSON.stringify(tickets)).digest('hex'),
      blocking_count: 1,
      summary: 'human judgment remains required',
      findings: [{
        id: 'human-question-1',
        type: 'human-question',
        question: 'Should the phase land with the mandatory live gate retained?',
        evidence: '.planning/phases/33-reduce-orchestration-context-and-transfer-sessions-safely/INTEGRATION.md:3',
        summary: 'phase completion needs a human decision',
      }],
    };
    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...result,
        ticket_set_digest: '0'.repeat(64),
      }, {
        role: 'integrator',
        phase: INTEGRATION_PHASE,
        ticketSet: tickets,
        evidencePath: integrationPath,
      })),
      (error) => error && error.code === 'JUDGMENT_DIGEST_MISMATCH',
    );
    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...result,
        outcome: 'passed',
        blocking_count: 0,
        finding_count: 0,
        findings: [{ ...result.findings[0], id: 'surplus-finding' }],
      }, {
        role: 'integrator',
        phase: INTEGRATION_PHASE,
        ticketSet: tickets,
        evidencePath: integrationPath,
      })),
      (error) => error && error.code === 'JUDGMENT_COUNT_MISMATCH',
    );
    const sealed = roleArtifact.seal(sealInput(value, result, {
      role: 'integrator',
      phase: INTEGRATION_PHASE,
      ticketSet: tickets,
      evidencePath: integrationPath,
    }));
    assert.equal(sealed.envelope.outcome, 'human-review-required');
    assert.equal(sealed.envelope.blocking_count, 1);
    assert.equal(sealed.envelope.finding_count, 1);
    assert.equal(sealed.envelope.ticket_set_digest, result.ticket_set_digest);
    assert.equal(sealed.envelope.reviewed_head, identity.head);
    assert.equal(sealed.envelope.reviewed_base_tree, identity.baseTree);

    const substitutedTickets = ['T-33-01', 'T-33-02'];
    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...result,
        ticket_set: substitutedTickets,
        ticket_set_digest: crypto.createHash('sha256').update(JSON.stringify(substitutedTickets)).digest('hex'),
      }, {
        role: 'integrator',
        phase: INTEGRATION_PHASE,
        ticketSet: substitutedTickets,
        evidencePath: integrationPath,
      })),
      (error) => error && error.code === 'JUDGMENT_IDENTITY_MISMATCH',
    );

    const duplicate = roleArtifact.seal(sealInput(value, result, {
      role: 'integrator',
      phase: INTEGRATION_PHASE,
      ticketSet: tickets,
      evidencePath: integrationPath,
    }));
    assert.equal(duplicate.artifact_digest, sealed.artifact_digest);

    fs.appendFileSync(integrationPath, '\nchanged after judgment\n');
    assert.throws(
      () => roleArtifact.validate({
        ...sealInput(value, undefined, {
          role: 'integrator',
          phase: INTEGRATION_PHASE,
          ticketSet: tickets,
          artifactPath: sealed.artifact_ref,
          artifactDigest: sealed.artifact_digest,
        }),
      }),
      (error) => error && error.code === 'ARTIFACT_DIGEST_MISMATCH',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('integrator findings state the ticket and fix_ticket contract with a named remedy', () => {
  const tickets = ['T-33-01'];
  const value = fixture('integrator', (root) => phaseSubject(root, tickets));
  try {
    const identity = revision(value.root);
    const integrationPath = evidence(value.root, path.relative(value.root, integrationEvidencePath(value.root)), 'complete integration evidence');
    const base = {
      outcome: 'needs-fix',
      head: identity.head,
      head_tree: identity.headTree,
      base: identity.base,
      base_tree: identity.baseTree,
      ticket_set: tickets,
      ticket_set_digest: crypto.createHash('sha256').update(JSON.stringify(tickets)).digest('hex'),
      blocking_count: 1,
      summary: 'fix required',
    };
    const sealOpts = { role: 'integrator', phase: INTEGRATION_PHASE, ticketSet: tickets, evidencePath: integrationPath };

    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...base,
        findings: [{ id: 'F1', type: 'fix-ticket', blocking: true, summary: 'seam' }],
      }, sealOpts)),
      (error) => error && error.code === 'INCOMPLETE_FINDING' && /fix_ticket is required/.test(error.message),
    );

    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...base,
        findings: [{ id: 'F1', type: 'fix-ticket', blocking: true, summary: 'seam',
          fix_ticket: { title: 'Fix title', scope: 'scope text', files: [] } }],
      }, sealOpts)),
      (error) => error && error.code === 'INCOMPLETE_FINDING' && /fix_ticket\.files/.test(error.message),
    );

    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...base,
        findings: [{ id: 'F1', type: 'informational', blocking: true, summary: 'seam', ticket: 42 }],
      }, sealOpts)),
      (error) => error && error.code === 'INVALID_RESULT' && /\.ticket is a number/.test(error.message) && /remedy:/.test(error.message),
    );

    assert.throws(
      () => roleArtifact.seal(sealInput(value, {
        ...base,
        findings: [{ id: 'F1', type: 'informational', blocking: true, summary: 'seam', ticket: null,
          fix_ticket: { title: 'Fix title', scope: 'scope text', files: ['a.cjs'] } }],
      }, sealOpts)),
      (error) => error && error.code === 'INVALID_RESULT' && /only valid on a fix-ticket finding/.test(error.message),
    );

    const sealed = roleArtifact.seal(sealInput(value, {
      ...base,
      findings: [
        { id: 'F1', type: 'fix-ticket', blocking: true, summary: 'seam summary', ticket: null,
          fix_ticket: { title: 'Fix title', scope: 'scope text', files: ['a.cjs'], depends_on: [] } },
      ],
    }, sealOpts));
    assert.equal(sealed.envelope.outcome, 'needs-fix');
    assert.equal(sealed.envelope.blocking_count, 1);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('integrator refuses missing or empty complete integration evidence', () => {
  const tickets = [];
  const value = fixture('integrator', (root) => phaseSubject(root, tickets));
  try {
    const identity = revision(value.root);
    const result = {
      outcome: 'passed',
      head: identity.head,
      head_tree: identity.headTree,
      base: identity.base,
      base_tree: identity.baseTree,
      ticket_set: [],
      ticket_set_digest: crypto.createHash('sha256').update('[]').digest('hex'),
      blocking_count: 0,
      summary: 'passed',
      findings: [],
    };
    const integrationPath = integrationEvidencePath(value.root);
    fs.mkdirSync(path.dirname(integrationPath), { recursive: true });
    fs.writeFileSync(integrationPath, '');
    assert.throws(
      () => roleArtifact.seal(sealInput(value, result, {
        role: 'integrator',
        phase: INTEGRATION_PHASE,
        ticketSet: [],
        evidencePath: integrationPath,
      })),
      (error) => error && error.code === 'MISSING_ARTIFACT',
    );
    assert.throws(
      () => roleArtifact.seal(sealInput(value, result, {
        role: 'integrator',
        phase: INTEGRATION_PHASE,
        ticketSet: [],
        evidencePath: path.join(value.root, 'missing-INTEGRATION.md'),
      })),
      (error) => error && error.code === 'ARTIFACT_IDENTITY_MISMATCH',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('a changed combined base refuses an already passed integrator result', () => {
  const tickets = ['T-33-01'];
  const value = fixture('integrator', (root) => phaseSubject(root, tickets));
  try {
    const identity = revision(value.root);
    const integrationPath = evidence(value.root, path.relative(value.root, integrationEvidencePath(value.root)), 'complete integration evidence');
    const result = {
      outcome: 'passed',
      head: identity.head,
      head_tree: identity.headTree,
      base: identity.base,
      base_tree: identity.baseTree,
      ticket_set: tickets,
      ticket_set_digest: crypto.createHash('sha256').update(JSON.stringify(tickets)).digest('hex'),
      blocking_count: 0,
      summary: 'passed',
      findings: [],
    };
    const sealed = roleArtifact.seal(sealInput(value, result, {
      role: 'integrator',
      phase: INTEGRATION_PHASE,
      ticketSet: tickets,
      evidencePath: integrationPath,
    }));
    fs.writeFileSync(path.join(value.root, 'base-new.txt'), 'base moved\n');
    git(value.root, ['switch', '--quiet', 'main']);
    git(value.root, ['add', 'base-new.txt']);
    git(value.root, ['commit', '--quiet', '-m', 'move integration base']);
    git(value.root, ['update-ref', 'refs/remotes/origin/main', git(value.root, ['rev-parse', 'main'])]);
    git(value.root, ['switch', '--quiet', value.branchName]);
    assert.throws(
      () => roleArtifact.validate({
        ...sealInput(value, undefined, {
          role: 'integrator',
          phase: INTEGRATION_PHASE,
          ticketSet: tickets,
          artifactPath: sealed.artifact_ref,
          artifactDigest: sealed.artifact_digest,
        }),
      }),
      (error) => error && error.code === 'STALE_ARTIFACT',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('integrator resolves a bare reported base with the live origin preference', () => {
  const tickets = ['T-33-01'];
  const value = fixture('integrator', (root) => phaseSubject(root, tickets));
  try {
    fs.writeFileSync(path.join(value.root, 'base-new.txt'), 'base moved forward\n');
    git(value.root, ['switch', '--quiet', 'main']);
    git(value.root, ['add', 'base-new.txt']);
    git(value.root, ['commit', '--quiet', '-m', 'move remote integration base']);
    const remoteBase = git(value.root, ['rev-parse', 'main']);
    const remoteBaseTree = git(value.root, ['rev-parse', `${remoteBase}^{tree}`]);
    git(value.root, ['update-ref', 'refs/remotes/origin/main', remoteBase]);
    git(value.root, ['switch', '--quiet', value.branchName]);

    const result = {
      outcome: 'passed',
      head: git(value.root, ['rev-parse', 'HEAD']),
      head_tree: git(value.root, ['rev-parse', 'HEAD^{tree}']),
      base: 'main',
      base_tree: remoteBaseTree,
      ticket_set: tickets,
      ticket_set_digest: crypto.createHash('sha256').update(JSON.stringify(tickets)).digest('hex'),
      blocking_count: 0,
      summary: 'passed',
      findings: [],
    };
    const sealed = roleArtifact.seal(sealInput(value, result, {
      role: 'integrator',
      phase: INTEGRATION_PHASE,
      base: 'origin/main',
      ticketSet: tickets,
      evidencePath: evidence(value.root, path.relative(value.root, integrationEvidencePath(value.root)), 'complete integration evidence'),
    }));
    assert.equal(sealed.envelope.reviewed_base, 'origin/main');
    assert.equal(sealed.envelope.reviewed_base_tree, remoteBaseTree);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('code-review tracer validates in plain, spaced and non-ASCII worktrees and refuses tampering', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  for(const suffix of ['plain','with space','українська']) {
    const f = withOriginalPlanning(reviewFixture(suffix));
    try {
      const binding=f.advance(1), input=f.input(binding), sealed=roleArtifact.sealJudgment(input);
      const validated=roleArtifact.validateJudgmentManifest({...input,artifactPath:sealed.artifact_ref,artifactDigest:sealed.artifact_digest});
      assert.equal(validated.manifest.repository_identity,require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').repositoryIdentity(f.root));
      assert.equal(f.lookup().verdict,'needs-fix'); assert.equal(f.lookup().blocking_count,1);
      fs.appendFileSync(path.join(f.root,'.shipyard-code-review-evidence.md'),'altered');
      assert.throws(()=>roleArtifact.validateJudgmentManifest({...input,artifactPath:sealed.artifact_ref,artifactDigest:sealed.artifact_digest}));
    } finally { f.cleanup(); }
  }
});

test('code-review artifact rejects false passes, invalid citations and missing repair evidence', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const f=withOriginalPlanning(reviewFixture());
  try {
    const binding=f.advance(1);
    for(const mutate of [
      r=>{r.verdict='pass';}, r=>{r.verdict='pass';r.review_completeness='incomplete';},
      r=>{delete r.findings[0].fix_ticket;},r=>{delete r.findings[0].identity;},
      r=>{r.findings[0].line_text=null;},r=>{r.findings[0].occurrence=null;},
      r=>{r.findings[0].citation='unmatched';},r=>{r.findings[0].citation='missing';},
      r=>{r.id='T-52-01';},r=>{r.head='a'.repeat(40);},r=>{r.ticket_set_digest='a'.repeat(64);},
      r=>{r.base_commit='a'.repeat(40);},
    ]) {const input=f.input(binding);mutate(input.result);assert.throws(()=>roleArtifact.sealJudgment(input));}
    const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/code-review/review.json'),'utf8'));
    raw.review_completeness='incomplete';raw.limitations=['Unread source'];
    const input=f.input(binding,1,null,raw);roleArtifact.sealJudgment(input);
    assert.equal(f.lookup().review_completeness,'incomplete'); assert.equal(f.lookup().verdict,'incomplete');
  } finally {f.cleanup();}
});

test('code-review suppressed index survives sealing, while evidence and findings tampering cannot authenticate', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const f=withOriginalPlanning(reviewFixture());
  try {
    const binding=f.advance(1), first=f.input(binding), current=first.result.findings[0];
    const prior=core.carryPriorFindings({priorFindings:first.result.findings,deltaDiff:'',readSource:file=>fs.readFileSync(path.join(f.root,file),'utf8'),disagreements:{[current.identity]:{reason:'Caller guarantees acknowledgement',recorded_by:'operator'}}});
    const normalized=core.normalizeResult({review_completeness:'complete',limitations:[],unresolved_sources:[],findings:[],dispositions:[]},{round:1,scope:'full',priorFindings:prior,readSource:file=>fs.readFileSync(path.join(f.root,file),'utf8')});
    first.result={...first.result,...normalized};
    for (const disagreement_identity of [null, {}, ['a'.repeat(64)], 'a'.repeat(63), 'A'.repeat(64)]) {
      const invalid = structuredClone(first.result);
      invalid.findings[0].disagreement_identity = disagreement_identity;
      assert.throws(() => roleArtifact.sealJudgment({ ...first, result: invalid }), error => error.code === 'INCOMPLETE_FINDING');
    }
    const duplicate = structuredClone(first.result);
    duplicate.findings[1] = { ...duplicate.findings[1], classification: 'prior', ref: 'P-02',
      disagreement_identity: duplicate.findings[0].disagreement_identity };
    assert.throws(() => roleArtifact.sealJudgment({ ...first, result: duplicate }), error => error.code === 'JUDGMENT_OUTCOME_MISMATCH');
    const sealed=roleArtifact.sealJudgment(first);
    const checked=roleArtifact.validateJudgmentManifest({...first,artifactPath:sealed.artifact_ref,artifactDigest:sealed.artifact_digest});
    assert.equal(checked.findings.findings[0].suppressed,true);
    assert.equal(f.lookup().disagreement_suppressed,1); assert.equal(f.lookup().verdict,'pass');
    fs.appendFileSync(path.join(f.root,checked.manifest.files.findings.path),' ');
    assert.equal(f.lookup(),null);
    assert.throws(()=>roleArtifact.validateJudgmentManifest({...first,artifactPath:sealed.artifact_ref,artifactDigest:sealed.artifact_digest}));
  } finally {f.cleanup();}
});

test('code-review seals a recorded WARNING returned with BLOCKER severity without repair fields', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    const input = f.input(f.advance(1));
    const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
    const warning = { ...input.result.findings[0], severity: 'WARNING', blocking: false };
    delete warning.fix_ticket;
    const priorFindings = core.carryPriorFindings({ priorFindings: [warning], deltaDiff: '', readSource,
      disagreements: { [warning.identity]: { reason: 'Caller handles this case', recorded_by: 'operator' } } });
    const normalized = core.normalizeResult({ review_completeness: 'complete', limitations: [], unresolved_sources: [],
      findings: [input.result.findings[0]], dispositions: [] }, { round: 1, scope: 'full', priorFindings, readSource });
    input.result = { ...input.result, ...normalized };
    const sealed = roleArtifact.sealJudgment(input);
    const validated = roleArtifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest });
    assert.equal(validated.findings.findings[0].severity, 'WARNING');
    assert.equal(validated.findings.findings[0].suppressed, true);
    assert.equal(validated.findings.findings[0].fix_ticket, undefined);
    assert.equal(f.lookup().verdict, 'pass');
  } finally { f.cleanup(); }
});

test('code-review seals 129 small reviewed references within the shared asset capacity', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const { FILE_LIMITS } = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    const binding = f.advance(1);
    const coverage = Array.from({ length: 129 }, (_, index) => {
      const content = 'reference-' + index;
      return { path: `src/reference-${index}.js`, bytes: Buffer.byteLength(content),
        sha256: crypto.createHash('sha256').update(content).digest('hex'), status: 'reviewed' };
    });
    assert(coverage.reduce((total, ref) => total + ref.bytes, 0) < FILE_LIMITS.material);
    assert(coverage.length <= FILE_LIMITS.assets);
    for (const count of [129, FILE_LIMITS.assets]) {
      const refs = Array.from({ length: count }, (_, index) => ({ ...coverage[index % coverage.length], path: `src/reference-${index}.js` }));
      const raw = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [], coverage: refs };
      const input = f.input(binding, 1, null, raw);
      assert.equal(input.result.coverage.length, count);
      const sealed = roleArtifact.sealJudgment(input);
      const validated = roleArtifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest });
      assert.equal(validated.manifest.partitions_total, count);
      assert.equal(validated.manifest.partitions_not_reviewed, 0);
      assert.equal(f.lookup().verdict, 'pass');
    }
    for (const coverage of [Array(FILE_LIMITS.assets + 1).fill({ status: 'reviewed' }), [{ status: 'unknown' }]]) {
      const input = f.input(binding);
      input.result.coverage = coverage;
      assert.throws(() => roleArtifact.sealJudgment(input), error => error.code === 'INVALID_RESULT');
    }
    const input = f.input(binding);
    input.result.coverage = coverage.map((ref, index) => ({ ...ref, status: index ? 'reviewed' : 'not-reviewed' }));
    assert.throws(() => roleArtifact.sealJudgment(input), error => error.code === 'JUDGMENT_OUTCOME_MISMATCH');
    input.result.verdict = 'incomplete';
    input.result.review_completeness = 'incomplete';
    input.result.limitations = ['One source was not reviewed'];
    const sealed = roleArtifact.sealJudgment(input);
    const validated = roleArtifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest });
    assert.equal(validated.manifest.partitions_total, 129);
    assert.equal(validated.manifest.partitions_not_reviewed, 1);
    assert.equal(f.lookup().review_completeness, 'incomplete');
  } finally { f.cleanup(); }
});

test('code-review seals colliding 128-byte labels after normalization', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    const binding = f.advance(1);
    for (const id of ['x'.repeat(128), 'é'.repeat(64), '界'.repeat(42) + 'ab']) {
      const input = f.input(binding);
      const first = { ...input.result.findings[0], id };
      const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
      const priorFindings = core.carryPriorFindings({ priorFindings: [first], deltaDiff: '', readSource });
      const result = core.normalizeResult({ review_completeness: 'complete', limitations: [], unresolved_sources: [],
        findings: [{ id, severity: 'WARNING', path: 'source.js', line: 101, summary: 'Another statement' }],
        dispositions: [{ ref: 'P-01', disposition: 'unresolved', justification: 'Still fails' }] },
      { round: 1, scope: 'full', priorFindings, readSource });
      input.result = { ...input.result, ...result };
      const sealed = roleArtifact.sealJudgment(input);
      const validated = roleArtifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest });
      assert.equal(validated.findings.findings.length, 2);
      assert.equal(new Set(validated.findings.findings.map(finding => finding.id)).size, 2);
      assert(validated.findings.findings.every(finding => Buffer.byteLength(finding.id) <= 128));
    }
  } finally { f.cleanup(); }
});

test('code-review incomplete first round cannot authorize a complete delta pass', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const f=withOriginalPlanning(reviewFixture());
  try {
    const raw={review_completeness:'incomplete',limitations:['unread diff'],unresolved_sources:[],findings:[],dispositions:[]};
    const first=f.input(f.advance(1),1,null,raw);roleArtifact.sealJudgment(first);
    const second=f.input(f.advance(2),2,first.result.head,{...raw,review_completeness:'complete',limitations:[]});
    assert.throws(()=>roleArtifact.sealJudgment(second),error=>error.code==='JUDGMENT_OUTCOME_MISMATCH');
  } finally {f.cleanup();}
});


test('old-format code-review remains historical and cannot open the default hold', () => {
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const flow = require('../../plugins/delivery-pipeline/scripts/phase-code-review.cjs');
  const f = require('../fixtures/code-review/artifact-fixture.cjs').fixture();
  try {
    f.graph.epics = { 52: { branch: f.branch, phaseDir: f.phase, repos: [null] } };
    Object.assign(f.graph.tickets['T-52-01'], {
      epic: f.branch, branch: 'feat/old-ticket', repo: null, phaseDir: f.phase,
    });
    fs.writeFileSync(path.join(f.root, '.planning/config.json'), JSON.stringify({ git: { base_branch: 'main' } }));
    const input = f.input(f.advance(1), 1, null, {
      review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [],
    });
    assert.throws(() => roleArtifact.sealJudgment(input),
      error => error.code === 'JUDGMENT_OUTCOME_MISMATCH');
    const producerPath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const preCoverageRepairProducer = {
      baseline: 'ef8f03864fedd506a9dd2216e29cec97996cbaa7',
      path: 'plugins/delivery-pipeline/scripts/role-artifact.cjs',
      sha256: 'd0f5bbba03b66e3c3142c040e37fec87ece7457197ac7013db027c52fdff6428',
      gzip: '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',
    };
    const producerBytes = require('node:zlib').gunzipSync(Buffer.from(preCoverageRepairProducer.gzip, 'base64'));
    assert.equal(require('node:crypto').createHash('sha256').update(producerBytes).digest('hex'),
      preCoverageRepairProducer.sha256);
    const Module = require('node:module');
    const producer = new Module(producerPath, module);
    producer.filename = producerPath;
    producer.paths = Module._nodeModulePaths(path.dirname(producerPath));
    producer._compile(producerBytes.toString('utf8'), producerPath);
    const sealed = producer.exports.sealJudgment(input);
    const archives = roleArtifact.authenticatedArchivePins(f.root).map(pin => ({
      ...pin, bytes: fs.readFileSync(path.join(f.root, pin.path)),
    }));
    assert.equal(f.lookup(), null);
    const prior = roleArtifact.priorCodeReviewVerdicts({
      worktreePath: f.root, repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir,
    });
    assert.equal(prior[0].artifact_digest, sealed.artifact_digest);
    const live = {
      number: 52, state: 'OPEN', headRefName: f.branch, headRefOid: f.git(['rev-parse', 'HEAD']),
      baseRefName: 'main', baseRefOid: f.base,
    };
    const status = flow.status({
      worktree: f.root, graphDir: f.graphDir, phase: 52, pr: 52, live,
    }, { defaultBranch: 'main' });
    assert.equal(status.state, 'owed');
    assert.equal(flow.evaluateGate(status).ok, false);
    for (const pin of archives) assert.deepEqual(fs.readFileSync(path.join(f.root, pin.path)), pin.bytes);
  } finally {
    f.cleanup();
  }
});

test('D-32 unit labels cannot obtain ordinary integrator phase sealing', () => {
  const tickets = [{ id: 'T-33-01', pr: 81, head: 'a'.repeat(40), base: 'main', branch: 'ticket/T-33-01' }];
  const value = fixture('integrator', root => phaseSubject(root, tickets));
  try {
    const integrationPath = evidence(value.root, path.relative(value.root, integrationEvidencePath(value.root)), 'Original phase fixture evidence.');
    const input = sealInput(value, { phase: INTEGRATION_PHASE, head: git(value.root, ['rev-parse', 'HEAD']),
      base: 'main', base_tree: git(value.root, ['rev-parse', 'main^{tree}']), ticket_set: tickets,
      outcome: 'passed', summary: 'Unit cannot act as a phase.', blocking_count: 0, findings: [],
      review_contract: 'shipyard.integration-review.v3', kind: 'unit', schema: 'shipyard.integration-unit-result.v1' }, {
      role: 'integrator', phase: INTEGRATION_PHASE, ticketSet: tickets, evidencePath: integrationPath });
    assert.throws(() => roleArtifact.sealJudgment(input), /unit results cannot/);
    assert.throws(() => roleArtifact.sealIntegrationUnit({ ...input, prepared: {
      plan_sha256: 'a'.repeat(64), unit_id: 'u000001', kind: 'unit' } }), /original private unit/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('D-32 legacy v2 and D-34 authenticated chain finals preserve separate current authority', async () => {
  const Module = require('node:module');
  const filename = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalLoad = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { test() {} };
    return originalLoad.call(this, name, ...args);
  };
  const source = fs.readFileSync(filename, 'utf8').replace('const live = branch => {',
    'const live = branch => { if (f.mergePrs) return f.mergePrs.find(pr => pr.headRefName === branch);');
  try { loaded._compile(source + '\nmodule.exports = { fixture, runIntegration, publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, currentPartitionConsumer, originalPartitionSessions };\n', filename); }
  finally { Module._load = originalLoad; }
  await loaded.exports.fixture(async f => {
    const current = await loaded.exports.runIntegration(f);
    const artifact = JSON.parse(fs.readFileSync(current.result.artifact.artifact_path, 'utf8'));
    assert.equal(artifact.artifact_kind, 'judgment');
    assert.equal(artifact.current_review.contract, 'shipyard.integration-review.v2');
    assert.equal(artifact.integration_partition, undefined);
    assert.equal(artifact.current_review.integration_partition, undefined);
    assert.equal(roleArtifact.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head,
      baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.pr.headRefName })?.authenticated, true);
    assert.throws(() => roleArtifact.prepareIntegrationPartitions({ review: current, capacity: {} }), /private/);
  });
  await loaded.exports.publicIntegrationFixture(async f => {
    const run = args => execFileSync('git', ['-C', f.worktree, '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { encoding: 'utf8', stdio: 'pipe' }).trim();
    const tree = run(['rev-parse', 'HEAD^{tree}']);
    const makeCommit = (parent, label) => run(['commit-tree', tree, '-p', parent, '-m', label]);
    const childHead = makeCommit(f.head, 'child source');
    const childMerge = makeCommit(f.head, 'child squash into parent');
    const parentHead = makeCommit(childMerge, 'parent actual merged head');
    const terminalMerge = makeCommit(f.head, 'parent squash into epic');
    run(['reset', '--hard', terminalMerge]); f.head = terminalMerge; f.pr.headRefOid = f.head;
    run(['update-ref', 'refs/remotes/origin/' + f.pr.headRefName, f.head]);
    const branches = Object.values(f.rows).map(row => row.branch);
    f.mergePrs = [childHead, parentHead].map((head, index) => ({ number: 101 + index, state: 'MERGED',
      headRefName: branches[index], headRefOid: head, baseRefName: index ? f.pr.headRefName : branches[1],
      baseRefOid: null, mergedAt: '2026-10-09T12:00:00Z', mergeCommit: { oid: index ? terminalMerge : childMerge },
      title: 'T-49-0' + (index + 1), body: '', isDraft: false }));
    const caller = loaded.exports.publicPartitionFixture(f, 'codex');
    const prFile = path.join(f.root, 'current-prs.json');
    const savePrs = () => fs.writeFileSync(prFile, JSON.stringify(f.mergePrs)); savePrs();
    fs.writeFileSync(path.join(f.root, 'bin/gh'), '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const prs = JSON.parse(fs.readFileSync(${JSON.stringify(prFile)}));
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view') process.stdout.write('main');
else if (args[0] === 'pr' && args[1] === 'list')
  process.stdout.write(JSON.stringify(prs.filter(pr => pr.headRefName === args[args.indexOf('--head') + 1])));
else if (args[0] === 'pr' && args[1] === 'view') {
  const pr = prs.find(pr => pr.number === Number(args[2]));
  if (!pr) process.exit(2); process.stdout.write(JSON.stringify(pr));
} else process.exit(2);
`, { mode: 0o755 });
    const result = await loaded.exports.supportedPartitionCaller(f, 'codex', caller.options);
    assert.equal(result.result.kind, 'phase');
    const current = loaded.exports.currentPartitionConsumer(f);
    assert.equal(current?.authenticated, true);
    const sessions = loaded.exports.originalPartitionSessions(f, 'codex', caller.recorder, caller.controls);
    const final = sessions.find(session => session.result.kind === 'phase');
    const proof = final.launch.payload.reviewed_identity.preflight;
    assert.equal(proof.schema, 'shipyard.native-integration-merge-proof.v1');
    assert.deepEqual(proof.paths[0].tickets, ['T-49-01', 'T-49-02']);
    assert.equal(proof.ticket_set_digest, crypto.createHash('sha256').update(proof.ticket_set_json).digest('hex'));
    const collector = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
    const proofInput = { worktree: f.worktree, graphDir: f.graphDir };
    for (const change of [
      p => { p.schema = 'unknown'; }, p => { delete p.proof_digest; },
      p => { p.paths[0].tickets.reverse(); }, p => { p.merges[0].base_branch = 'wrong'; },
      p => { p.merges[0].merge_commit = terminalMerge; }, p => { p.merges[0].head = parentHead; },
      p => { p.merges[0].merged_at = 'changed'; }, p => { p.merges[0].pr = 999; },
    ]) {
      const forged = structuredClone(proof); change(forged);
      assert.throws(() => collector.assertNativeIntegrationMergeProof(forged, proofInput));
      if (!Object.hasOwn(forged, 'proof_digest')) continue;
      const { proof_digest: ignored, ...body } = forged;
      const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
      forged.proof_digest = crypto.createHash('sha256').update(stable(body)).digest('hex');
      assert.throws(() => collector.assertNativeIntegrationMergeProof(forged, proofInput), /schema|facts|path|current|changed/);
    }
    const originalPrs = structuredClone(f.mergePrs);
    for (const change of [
      prs => { prs[0].baseRefName = 'wrong/base'; }, prs => { prs[0].baseRefOid = f.base; },
      prs => { prs[0].headRefOid = parentHead; }, prs => { prs[0].mergedAt = 'changed-time'; },
      prs => { prs[0].mergeCommit.oid = childHead; }, prs => { prs[1].headRefOid = childHead; },
      prs => { prs[1].state = 'OPEN'; }, prs => { prs.pop(); },
    ]) {
      f.mergePrs = structuredClone(originalPrs); change(f.mergePrs); savePrs();
      assert.equal(loaded.exports.currentPartitionConsumer(f), null, 'stale fresh PR facts cannot retain final authority');
      f.mergePrs = structuredClone(originalPrs); savePrs();
      assert.equal(loaded.exports.currentPartitionConsumer(f)?.dispatch_id, current.dispatch_id);
    }
    for (const file of [path.join(f.graphDir, 'tickets.json'), path.join(f.worktree, f.rows['T-49-01'].plan)]) {
      const saved = fs.readFileSync(file);
      try {
        fs.appendFileSync(file, '\n ');
        assert.equal(loaded.exports.currentPartitionConsumer(f), null, 'frozen graph/PLAN bytes must remain current');
      } finally { fs.writeFileSync(file, saved); }
    }
    const graphFile = path.join(f.graphDir, 'tickets.json'), savedGraph = fs.readFileSync(graphFile);
    try {
      const graph = JSON.parse(savedGraph); delete graph.tickets['T-49-02'];
      fs.writeFileSync(graphFile, JSON.stringify(graph));
      assert.equal(loaded.exports.currentPartitionConsumer(f), null, 'complete canonical membership cannot shrink');
    } finally { fs.writeFileSync(graphFile, savedGraph); }
    const savedNative = fs.readFileSync(final.pin.path);
    try {
      fs.writeFileSync(final.pin.path, savedNative.toString().replace('shipyard.native-integration-merge-proof.v1', 'forged.native-merge-proof.v1'));
      assert.equal(loaded.exports.currentPartitionConsumer(f), null, 'tampered original final input cannot authenticate a swapped proof');
    } finally { fs.writeFileSync(final.pin.path, savedNative); }
    assert.equal(loaded.exports.currentPartitionConsumer(f)?.dispatch_id, current.dispatch_id);
    assert.equal(current.contract, roleArtifact.INTEGRATION_REVIEW_V3);
  });
});

done();
