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
    { ticket },
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
  const value = fixture('pr-sentinel', 'round:wrong-ticket-set');
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

done();
