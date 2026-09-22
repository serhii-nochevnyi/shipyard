'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  CLAUDE_MODEL_ALIASES,
  createClaudeWorkflowDispatch,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { registerClaudeWorkflowHost } = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');

const TICKET = 'T-33-03-repair';
const ROLE_ARTIFACT = path.join(
  __dirname,
  '../../plugins/delivery-pipeline/scripts/role-artifact.cjs',
);
const roleArtifact = require(ROLE_ARTIFACT);

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function repairFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-repair-artifact-'));
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'repair-artifact@example.test']);
  git(root, ['config', 'user.name', 'Repair Artifact Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '--quiet', '-m', 'repair artifact base']);
  git(root, ['switch', '--quiet', '-c', `ticket/${TICKET}`]);

  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  const host = registerClaudeWorkflowHost({
    agent: async (prompt, launchOptions) => {
      fs.writeFileSync(path.join(root, '.shipyard-repair-evidence.md'), [
        '# Repair evidence',
        'Hypothesis: the fixer must preserve the original failure cause.',
        'Verification: node tests/unit/repair-artifacts.test.cjs — exit 0.',
        'Finding: complete repair notes remain on disk.',
      ].join('\n') + '\n');
      const result = {
        id: TICKET,
        pr: 303,
        pushed: false,
        status: 'fixed',
        notes: 'bounded repair synopsis',
        hypothesis: 'the fixer must preserve the original failure cause',
      };
      evidence.set(result, {
        launch_id: 'repair-artifact-launch',
        applied_model: launchOptions.model,
        applied_effort: launchOptions.effort,
        observed_model: launchOptions.model,
        observed_effort: launchOptions.effort,
      });
      return result;
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    capabilities: {
      supportedModels: [CLAUDE_MODEL_ALIASES.opus],
      supportedEfforts: ['medium', 'max'],
      observedModel: true,
      observedEffort: true,
    },
    recorder,
    applicationEvidence: ({ result }) => evidence.get(result),
  });
  return { root, recorder, host };
}

function roleWorkflowFixture({ role, ticket, pr, result, evidenceText }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-role-artifact-'));
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'role-artifact@example.test']);
  git(root, ['config', 'user.name', 'Role Artifact Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '--quiet', '-m', 'role artifact base']);
  git(root, ['switch', '--quiet', '-c', `ticket/${ticket}`]);

  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  let launch = 0;
  const host = registerClaudeWorkflowHost({
    agent: async (prompt, launchOptions) => {
      const evidencePath = role === 'drift-check'
        ? path.join(root, '.shipyard-drift-evidence.md')
        : path.join(root, '.shipyard-repair-evidence.md');
      assert.ok(prompt.includes(evidencePath), `${role} prompt must name its complete evidence path`);
      assert.equal(fs.existsSync(evidencePath), false,
        `${role} dispatch must rotate the previous fixed producer evidence before launch`);
      fs.writeFileSync(evidencePath, evidenceText);
      const value = JSON.parse(JSON.stringify(result));
      evidence.set(value, {
        launch_id: `${role}-launch-${++launch}`,
        applied_model: launchOptions.model,
        applied_effort: launchOptions.effort,
        observed_model: launchOptions.model,
        observed_effort: launchOptions.effort,
      });
      return value;
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    capabilities: {
      supportedModels: [CLAUDE_MODEL_ALIASES.opus],
      supportedEfforts: ['medium', 'max'],
      observedModel: true,
      observedEffort: true,
    },
    recorder,
    applicationEvidence: ({ result: value }) => evidence.get(value),
  });
  return { root, recorder, host, ticket, pr, role };
}

function roleArgs(fixture, extra = {}) {
  if (fixture.role === 'drift-check') {
    return {
      tickets: [{
        id: fixture.ticket,
        planPath: path.join(fixture.root, 'PLAN.md'),
        worktreePath: fixture.root,
        baseRef: 'main',
        model: 'claude-opus-5-5',
        effort: 'max',
      }],
      driftRefPath: '/plugin/references/drift-check.md',
      ...extra,
    };
  }
  return {
    prs: [{
      id: fixture.ticket,
      pr: fixture.pr,
      branch: `ticket/${fixture.ticket}`,
      worktreePath: fixture.root,
      planPath: path.join(fixture.root, 'PLAN.md'),
      base: 'main',
      needsCiFix: fixture.role === 'ci-fix',
      needsReviewFix: fixture.role === 'review-fix',
      model: 'claude-opus-5-5',
      effort: 'medium',
    }],
    ciFixRefPath: '/plugin/references/ci-fix.md',
    reviewFixRefPath: '/plugin/references/review-fix.md',
    reinitScript: '/plugin/scripts/reviewers.cjs',
    ...extra,
  };
}

suite('repair artifacts — bounded Workflow evidence');

test('the direct prepare command rotates fixed producer evidence before launch', () => {
  const fixture = repairFixture();
  const evidencePath = path.join(fixture.root, roleArtifact.REPAIR_EVIDENCE_NAME);
  fs.writeFileSync(evidencePath, 'evidence from an earlier attempt\n');
  try {
    const prepared = spawnSync(process.execPath, [
      ROLE_ARTIFACT,
      'prepare',
      '--worktree', fixture.root,
      '--role', 'ci-fix',
    ], { encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stderr);
    const value = JSON.parse(prepared.stdout);
    assert.equal(value.cleared, true);
    assert.equal(value.relative, roleArtifact.REPAIR_EVIDENCE_NAME);
    assert.equal(fs.existsSync(evidencePath), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('artifact identity prefers the live origin base over a stale bare branch', async () => {
  const fixture = repairFixture();
  const baseCommit = git(fixture.root, ['rev-parse', 'main']);
  git(fixture.root, ['update-ref', 'refs/remotes/origin/main', baseCommit]);
  try {
    const [bounded] = await fixture.host.run('fix-round', {
      args: {
        prs: [{
          id: TICKET,
          pr: 303,
          branch: `ticket/${TICKET}`,
          worktreePath: fixture.root,
          planPath: path.join(fixture.root, 'PLAN.md'),
          base: 'main',
          needsCiFix: true,
          needsReviewFix: false,
          model: 'claude-opus-5-5',
          effort: 'medium',
        }],
        ciFixRefPath: '/plugin/references/ci-fix.md',
        reviewFixRefPath: '/plugin/references/review-fix.md',
        reinitScript: '/plugin/scripts/reviewers.cjs',
      },
    });
    const resolved = roleArtifact.read({
      worktreePath: fixture.root,
      role: 'ci-fix',
      ticket: TICKET,
      pr: 303,
      base: 'main',
      recorder: fixture.recorder,
      dispatchId: bounded.receipt.dispatch_id,
      artifactPath: bounded.artifact_ref,
      artifactDigest: bounded.artifact_digest,
    });
    assert.equal(resolved.base, 'origin/main');
    assert.equal(resolved.envelope.role, 'ci-fix');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a real fix round returns a bounded, validated artifact reference', async () => {
  const fixture = repairFixture();
  try {
    const result = await fixture.host.run('fix-round', {
      args: {
        prs: [{
          id: TICKET,
          pr: 303,
          branch: `ticket/${TICKET}`,
          worktreePath: fixture.root,
          planPath: path.join(fixture.root, 'PLAN.md'),
          base: 'main',
          needsCiFix: true,
          needsReviewFix: false,
          model: 'claude-opus-5-5',
          effort: 'medium',
        }],
        ciFixRefPath: '/plugin/references/ci-fix.md',
        reviewFixRefPath: '/plugin/references/review-fix.md',
        reinitScript: '/plugin/scripts/reviewers.cjs',
      },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'fixed');
    assert.equal(result[0].pr, 303);
    assert.ok(result[0].artifact_ref, 'repair results must carry a reference, not inline evidence');
    assert.ok(result[0].artifact_digest);
    assert.ok(result[0].evidence_index);
    assert.ok(!('evidence' in result[0]), 'complete repair evidence must stay behind the reference');
    const validated = roleArtifact.validate({
      worktreePath: fixture.root,
      role: 'ci-fix',
      ticket: TICKET,
      pr: 303,
      base: 'main',
      recorder: fixture.recorder,
      dispatchId: result[0].receipt.dispatch_id,
      artifactPath: result[0].artifact_ref,
      artifactDigest: result[0].artifact_digest,
    });
    assert.equal(validated.envelope.status, 'fixed');
    assert.equal(validated.envelope.hypothesis, 'the fixer must preserve the original failure cause');
    assert.match(validated.evidence, /complete repair notes remain on disk/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('review-fix uses the same strict artifact consumer and preserves its hypothesis', async () => {
  const ticket = 'T-33-03-review-fix';
  const fixture = roleWorkflowFixture({
    role: 'review-fix',
    ticket,
    pr: 304,
    result: {
      id: ticket,
      pr: 304,
      pushed: false,
      status: 'no-op',
      notes: 'the review comment is invalid after checking the current code',
      hypothesis: 'the reported issue is already prevented by the current guard',
    },
    evidenceText: '# Review repair evidence\nThread 17 was checked and answered with the current guard.\n',
  });
  try {
    const [bounded] = await fixture.host.run('fix-round', { args: roleArgs(fixture) });
    assert.equal(bounded.status, 'no-op');
    assert.equal(bounded.pushed, false);
    assert.equal(bounded.pr, 304);
    assert.ok(bounded.artifact_ref);
    const read = roleArtifact.read({
      worktreePath: fixture.root,
      role: 'review-fix',
      ticket,
      pr: 304,
      base: 'main',
      recorder: fixture.recorder,
      dispatchId: bounded.receipt.dispatch_id,
      artifactPath: bounded.artifact_ref,
      artifactDigest: bounded.artifact_digest,
    });
    assert.equal(read.findings.hypothesis, 'the reported issue is already prevented by the current guard');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the direct trusted consumer seals and rereads drift evidence with the same contract', async () => {
  const ticket = 'T-33-03-direct-drift';
  const fixture = roleWorkflowFixture({
    role: 'drift-check',
    ticket,
    result: {},
    evidenceText: '# Complete direct drift evidence\nChecked integration base and reuse behavior.\n',
  });
  const result = {
    id: ticket,
    verdict: 'fresh',
    moved: [],
    reuse_candidates: ['plugins/existing.mjs:12 — build on the existing guard'],
    evidence: ['git diff main...HEAD --name-status — exit 0'],
    summary: 'direct drift evidence is retained by reference',
  };
  try {
    const completed = await createClaudeWorkflowDispatch({
      agent: async () => {
        fs.writeFileSync(
          path.join(fixture.root, roleArtifact.DRIFT_EVIDENCE_NAME),
          '# Complete direct drift evidence\nChecked integration base and reuse behavior.\n',
        );
        return result;
      },
      prompt: 'direct drift result',
      role: 'drift-check',
      model: 'claude-opus-5-5',
      effort: 'max',
      context: { ticket },
      capabilities: {
        supportedModels: [CLAUDE_MODEL_ALIASES.opus],
        supportedEfforts: ['max'],
        observedModel: true,
        observedEffort: true,
      },
      recorder: fixture.recorder,
      applicationEvidence: ({ result: applied }) => ({
        launch_id: 'direct-drift-launch',
        applied_model: 'claude-opus-5-5',
        applied_effort: 'max',
        observed_model: 'claude-opus-5-5',
        observed_effort: 'max',
        result_id: applied.id,
      }),
    });
    const sealed = roleArtifact.seal({
      worktreePath: fixture.root,
      role: 'drift-check',
      ticket,
      base: 'main',
      recorder: fixture.recorder,
      dispatchId: completed.receipt.dispatch_id,
      result,
    });
    assert.ok(sealed.artifact_ref);
    assert.equal(sealed.envelope.reuse_candidates_count, 1);
    const read = roleArtifact.read({
      worktreePath: fixture.root,
      role: 'drift-check',
      ticket,
      base: 'main',
      recorder: fixture.recorder,
      dispatchId: completed.receipt.dispatch_id,
      artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest,
    });
    assert.equal(read.findings.reuse_candidates[0], result.reuse_candidates[0]);
    assert.equal(read.findings.evidence[0], result.evidence[0]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('missing repair evidence is a failed result, never a no-op', async () => {
  const ticket = 'T-33-03-missing-evidence';
  const fixture = roleWorkflowFixture({
    role: 'ci-fix',
    ticket,
    pr: 305,
    result: {
      id: ticket,
      pr: 305,
      pushed: false,
      status: 'no-op',
      notes: 'the fixer claims no change',
      hypothesis: 'the failure is outside the ticket scope',
    },
    evidenceText: '',
  });
  try {
    await assert.rejects(
      () => fixture.host.run('fix-round', { args: roleArgs(fixture) }),
      (error) => error.code === 'MISSING_ARTIFACT',
    );
    assert.equal(fs.existsSync(path.join(fixture.root, roleArtifact.ARTIFACT_ARCHIVE_DIR)), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('repair receipt lookalikes cannot replace the boundary-owned receipt', async () => {
  const ticket = 'T-33-03-forged-receipt';
  const fixture = roleWorkflowFixture({
    role: 'review-fix',
    ticket,
    pr: 306,
    result: {
      id: ticket,
      pr: 306,
      pushed: false,
      status: 'no-op',
      notes: 'the review finding is not actionable',
      hypothesis: 'the current implementation already satisfies the thread',
      applicationReceipt: { dispatch_id: 'agent-forged' },
    },
    evidenceText: '# Review evidence\nThe existing implementation was checked.\n',
  });
  try {
    await assert.rejects(
      () => fixture.host.run('fix-round', { args: roleArgs(fixture) }),
      (error) => error.code === 'FORGED_RECEIPT',
    );
    assert.equal(fs.existsSync(path.join(fixture.root, roleArtifact.ARTIFACT_ARCHIVE_DIR)), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('drift findings and reuse candidates overflow the envelope without loss', async () => {
  const ticket = 'T-33-03-drift-overflow';
  const moved = Array.from({ length: 120 }, (_, index) => ({
    id: `drift-${index + 1}`,
    path: `plugins/example-${index}.mjs`,
    command: `git diff --check -- plugins/example-${index}.mjs`,
    detail: `complete moved finding ${index + 1}`,
  }));
  const reuseCandidates = Array.from({ length: 400 }, (_, index) =>
    `plugins/reuse-${index}.mjs:10 — existing candidate ${index + 1} $(do-not-execute)`);
  const evidence = Array.from({ length: 600 }, (_, index) =>
    `git show main:plugins/example-${index}.mjs — checked path and exit 0`);
  const fixture = roleWorkflowFixture({
    role: 'drift-check',
    ticket,
    result: {
      id: ticket,
      verdict: 'drifted',
      moved,
      reuse_candidates: reuseCandidates,
      evidence,
      recorded: 'no (test keeps the finding in the validated artifact)',
      summary: 'drift findings are complete behind a bounded reference',
    },
    evidenceText: '# Complete drift evidence\nEvery moved path and candidate is retained here.\n',
  });
  try {
    const result = await fixture.host.run('drift-gate', { args: roleArgs(fixture) });
    assert.equal(result.length, 1);
    const bounded = result[0];
    assert.equal(bounded.verdict, 'drifted');
    assert.equal(bounded.moved_count, moved.length);
    assert.equal(bounded.reuse_candidates_count, reuseCandidates.length);
    assert.equal(bounded.evidence_count, evidence.length);
    assert.ok(bounded.artifact_ref);
    assert.ok(bounded.findings_index);
    assert.ok(!('moved' in bounded));
    assert.ok(!('reuse_candidates' in bounded));
    assert.ok(!('evidence' in bounded));
    assert.equal(bounded.receipt.compliance, 'verified');

    const validated = roleArtifact.read({
      worktreePath: fixture.root,
      role: 'drift-check',
      ticket,
      base: 'main',
      recorder: fixture.recorder,
      dispatchId: bounded.receipt.dispatch_id,
      artifactPath: bounded.artifact_ref,
      artifactDigest: bounded.artifact_digest,
    });
    assert.equal(validated.findings.moved.length, moved.length);
    assert.equal(validated.findings.reuse_candidates.length, reuseCandidates.length);
    assert.equal(validated.findings.evidence.length, evidence.length);
    assert.equal(validated.findings.reuse_candidates[399], reuseCandidates[399]);
    assert.ok(!fs.existsSync(path.join(fixture.root, 'do-not-execute')),
      'candidate text is fenced data, not a shell instruction');
    assert.equal('recorded' in validated.findings, false,
      'agent-owned recorded status must not become accepted artifact data');
    assert.equal('recorded' in validated.envelope, false,
      'agent-owned recorded status must not enter the bounded envelope');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('missing and duplicate drift ids refuse a fresh verdict before persistence', async () => {
  for (const moved of [
    [{ detail: 'missing identity' }],
    [{ id: 'same', detail: 'first' }, { id: 'same', detail: 'second' }],
  ]) {
    const ticket = `T-33-03-drift-${moved.length}`;
    const fixture = roleWorkflowFixture({
      role: 'drift-check',
      ticket,
      result: {
        id: ticket,
        verdict: 'fresh',
        moved,
        reuse_candidates: [],
        evidence: ['git status --short — exit 0'],
        summary: 'invalid drift identity must not become fresh',
      },
      evidenceText: '# Drift evidence\nThe malformed finding is intentionally rejected.\n',
    });
    try {
      await assert.rejects(
        () => fixture.host.run('drift-gate', { args: roleArgs(fixture) }),
        (error) => {
          assert.ok(['MISSING_DRIFT_ID', 'DUPLICATE_DRIFT_ID'].includes(error.code), error.message);
          return true;
        },
      );
      assert.equal(fs.existsSync(path.join(fixture.root, '.shipyard-role-artifacts')), false,
        'invalid findings must not be persisted as a drift artifact');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('drift evidence bound to an old integration base cannot be reused as fresh', async () => {
  const ticket = 'T-33-03-stale-base';
  const fixture = roleWorkflowFixture({
    role: 'drift-check',
    ticket,
    result: {
      id: ticket,
      verdict: 'fresh',
      moved: [],
      reuse_candidates: ['plugins/existing.mjs:12 — reusable behavior'],
      evidence: ['git diff main...HEAD --name-status — exit 0'],
      summary: 'base was fresh when checked',
    },
    evidenceText: '# Drift evidence\nBase identity was checked before the base moved.\n',
  });
  try {
    const [bounded] = await fixture.host.run('drift-gate', { args: roleArgs(fixture) });
    git(fixture.root, ['switch', '--quiet', 'main']);
    fs.writeFileSync(path.join(fixture.root, 'base-moved.txt'), 'new base\n');
    git(fixture.root, ['add', 'base-moved.txt']);
    git(fixture.root, ['commit', '--quiet', '-m', 'advance integration base']);
    git(fixture.root, ['switch', '--quiet', `ticket/${ticket}`]);
    assert.throws(
      () => roleArtifact.validate({
        worktreePath: fixture.root,
        role: 'drift-check',
        ticket,
        base: 'main',
        recorder: fixture.recorder,
        dispatchId: bounded.receipt.dispatch_id,
        artifactPath: bounded.artifact_ref,
        artifactDigest: bounded.artifact_digest,
      }),
      (error) => error.code === 'STALE_ARTIFACT',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('drift evidence bound to an old producer head cannot be reused as current', async () => {
  const ticket = 'T-33-03-stale-drift-head';
  const fixture = roleWorkflowFixture({
    role: 'drift-check',
    ticket,
    result: {
      id: ticket,
      verdict: 'fresh',
      moved: [],
      reuse_candidates: [],
      evidence: ['git status --short — exit 0'],
      summary: 'producer head was checked',
    },
    evidenceText: '# Drift evidence\nProducer head was checked before it moved.\n',
  });
  try {
    const [bounded] = await fixture.host.run('drift-gate', { args: roleArgs(fixture) });
    fs.writeFileSync(path.join(fixture.root, 'head-moved.txt'), 'new producer head\n');
    git(fixture.root, ['add', 'head-moved.txt']);
    git(fixture.root, ['commit', '--quiet', '-m', 'advance producer head']);
    assert.throws(
      () => roleArtifact.validate({
        worktreePath: fixture.root,
        role: 'drift-check',
        ticket,
        base: 'main',
        recorder: fixture.recorder,
        dispatchId: bounded.receipt.dispatch_id,
        artifactPath: bounded.artifact_ref,
        artifactDigest: bounded.artifact_digest,
      }),
      (error) => error.code === 'STALE_ARTIFACT',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('historical repair evidence survives a legitimate head advance but is not a fresh verdict', async () => {
  const fixture = repairFixture();
  try {
    const [bounded] = await fixture.host.run('fix-round', {
      args: {
        prs: [{
          id: TICKET,
          pr: 303,
          branch: `ticket/${TICKET}`,
          worktreePath: fixture.root,
          planPath: path.join(fixture.root, 'PLAN.md'),
          base: 'main',
          needsCiFix: true,
          needsReviewFix: false,
          model: 'claude-opus-5-5',
          effort: 'medium',
        }],
        ciFixRefPath: '/plugin/references/ci-fix.md',
        reviewFixRefPath: '/plugin/references/review-fix.md',
        reinitScript: '/plugin/scripts/reviewers.cjs',
      },
    });
    const dispatchId = bounded.receipt.dispatch_id;
    fs.writeFileSync(path.join(fixture.root, 'legitimate-next-round.txt'), 'head advanced\n');
    git(fixture.root, ['add', 'legitimate-next-round.txt']);
    git(fixture.root, ['commit', '--quiet', '-m', 'advance repair head']);
    assert.throws(
      () => roleArtifact.validate({
        worktreePath: fixture.root,
        role: 'ci-fix',
        ticket: TICKET,
        pr: 303,
        base: 'main',
        recorder: fixture.recorder,
        dispatchId,
        artifactPath: bounded.artifact_ref,
        artifactDigest: bounded.artifact_digest,
      }),
      (error) => error.code === 'STALE_ARTIFACT',
    );
    const historical = roleArtifact.read({
      worktreePath: fixture.root,
      role: 'ci-fix',
      ticket: TICKET,
      pr: 303,
      base: 'main',
      historical: true,
      recorder: fixture.recorder,
      dispatchId,
      artifactPath: bounded.artifact_ref,
      artifactDigest: bounded.artifact_digest,
    });
    assert.equal(historical.historical, true);
    assert.equal(historical.findings.hypothesis, 'the fixer must preserve the original failure cause');
    assert.equal(historical.manifest.head, historical.producer_head);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('wrong PR, receipt, and escaped artifact references fail closed', async () => {
  const fixture = repairFixture();
  try {
    const [bounded] = await fixture.host.run('fix-round', {
      args: {
        prs: [{
          id: TICKET,
          pr: 303,
          branch: `ticket/${TICKET}`,
          worktreePath: fixture.root,
          planPath: path.join(fixture.root, 'PLAN.md'),
          base: 'main',
          needsCiFix: true,
          needsReviewFix: false,
          model: 'claude-opus-5-5',
          effort: 'medium',
        }],
        ciFixRefPath: '/plugin/references/ci-fix.md',
        reviewFixRefPath: '/plugin/references/review-fix.md',
        reinitScript: '/plugin/scripts/reviewers.cjs',
      },
    });
    const common = {
      worktreePath: fixture.root,
      role: 'ci-fix',
      ticket: TICKET,
      pr: 303,
      base: 'main',
      recorder: fixture.recorder,
      dispatchId: bounded.receipt.dispatch_id,
      artifactPath: bounded.artifact_ref,
      artifactDigest: bounded.artifact_digest,
    };
    assert.throws(() => roleArtifact.validate({ ...common, pr: 304 }),
      (error) => error.code === 'ARTIFACT_IDENTITY_MISMATCH');
    assert.throws(() => roleArtifact.validate({
      ...common,
      artifactDigest: undefined,
      artifact_digest: undefined,
    }), (error) => error.code === 'INVALID_ARTIFACT');
    assert.throws(() => roleArtifact.validate({ ...common, dispatchId: 'not-the-receipt' }),
      (error) => ['RECORD_FAILED', 'MISSING_RECEIPT'].includes(error.code));

    const outside = path.join(path.dirname(fixture.root), 'outside-evidence.md');
    fs.writeFileSync(outside, 'outside\n');
    const evidencePath = path.join(
      fixture.root,
      roleArtifact.ARTIFACT_ARCHIVE_DIR,
      require('node:crypto').createHash('sha256').update(bounded.receipt.dispatch_id).digest('hex'),
      roleArtifact.REPAIR_EVIDENCE_NAME,
    );
    fs.unlinkSync(evidencePath);
    fs.symlinkSync(outside, evidencePath);
    assert.throws(() => roleArtifact.validate(common),
      (error) => error.code === 'ARTIFACT_PATH_ESCAPE');

    const archiveRoot = path.join(fixture.root, roleArtifact.ARTIFACT_ARCHIVE_DIR);
    const movedArchiveRoot = `${archiveRoot}.real`;
    fs.renameSync(archiveRoot, movedArchiveRoot);
    fs.symlinkSync(movedArchiveRoot, archiveRoot, 'dir');
    assert.throws(() => roleArtifact.validate(common),
      (error) => error.code === 'ARTIFACT_PATH_ESCAPE');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the real journal writer records artifact references and details resolve only historically', async () => {
  const fixture = repairFixture();
  const graph = path.join(fixture.root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), '{"tickets":{}}');
  try {
    const [bounded] = await fixture.host.run('fix-round', {
      args: {
        prs: [{
          id: TICKET,
          pr: 303,
          branch: `ticket/${TICKET}`,
          worktreePath: fixture.root,
          planPath: path.join(fixture.root, 'PLAN.md'),
          base: 'main',
          needsCiFix: true,
          needsReviewFix: false,
          model: 'claude-opus-5-5',
          effort: 'medium',
        }],
        ciFixRefPath: '/plugin/references/ci-fix.md',
        reviewFixRefPath: '/plugin/references/review-fix.md',
        reinitScript: '/plugin/scripts/reviewers.cjs',
      },
    });
    const logEvent = path.join(__dirname, '../../plugins/delivery-pipeline/scripts/log-event.cjs');
    const logged = spawnSync('node', [
      logEvent, 'attempt', `ticket=${TICKET}`, 'pr=303', 'n=1', 'role=ci-fix',
      'outcome=pushed', 'pushed=true', 'hypothesis=bounded prior hypothesis',
      `dispatch_id=${bounded.receipt.dispatch_id}`,
      `artifact_ref=${bounded.artifact_ref}`,
      `artifact_digest=${bounded.artifact_digest}`,
      `artifact_worktree=${fixture.root}`,
      'artifact_role=ci-fix', 'artifact_base=main',
      `boundary_store=${path.join(fixture.root, 'receipts')}`,
      '--graph', graph,
    ], { encoding: 'utf8' });
    assert.equal(logged.status, 0, logged.stderr);
    const recorded = JSON.parse(fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8'));
    assert.equal(recorded.artifact_ref, bounded.artifact_ref);
    assert.equal(recorded.artifact_digest, bounded.artifact_digest);

    const history = spawnSync('node', [
      path.join(__dirname, '../../plugins/delivery-pipeline/scripts/attempt-history.cjs'),
      TICKET, '--json', '--details', '--graph', graph,
    ], { encoding: 'utf8' });
    assert.equal(history.status, 0, history.stderr);
    const details = JSON.parse(history.stdout);
    assert.equal(details.events[0].artifact_historical, true);
    assert.equal(details.events[0].artifact_hypothesis,
      'the fixer must preserve the original failure cause');
    assert.equal(details.events[0].artifact_notes, 'bounded repair synopsis');
    assert.equal(details.attempts, 1, 'resolving details must not charge or reset repair attempts');

    const tampered = JSON.parse(fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8'));
    tampered.artifact_digest = 'f'.repeat(64);
    fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'), `${JSON.stringify(tampered)}\n`);
    const refused = spawnSync('node', [
      path.join(__dirname, '../../plugins/delivery-pipeline/scripts/attempt-history.cjs'),
      TICKET, '--details', '--graph', graph,
    ], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0, 'tampered references cannot become a clean history');
    assert.match(refused.stderr, /artifact|digest|verified/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

done();
