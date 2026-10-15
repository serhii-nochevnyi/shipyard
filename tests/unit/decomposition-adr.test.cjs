'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { sealDecomposition, decompositionAdr: adrBinding } = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
const { canonicalRequest } = require('../../plugins/delivery-pipeline/scripts/claude-decompose-host.cjs');
const codexHost = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');

suite('decomposition ADR binding');

const ADR = '.planning/architecture/ADR-001-greeting.md';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decomposition-adr-')));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  fs.mkdirSync(path.join(root, '.planning', 'architecture'), { recursive: true });
  fs.mkdirSync(path.join(root, '.planning', 'phases', '01-greeting'), { recursive: true });
  fs.writeFileSync(path.join(root, ADR), '# ADR 001\n');
  fs.writeFileSync(path.join(root, '.planning', 'phases', '01-greeting', 'CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(root, '.planning', 'phases', '01-greeting', '01-01-PLAN.md'), '# Plan\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  return root;
}

function seal(root, { subject, adr, adrBindingMode } = {}) {
  const resolved = adr === undefined ? adrBinding.resolveAdr(root, ADR) : adr;
  const phaseDir = path.join(root, '.planning', 'phases', '01-greeting');
  return sealDecomposition({
    root: path.join(root, '.sealed'),
    scope: {
      worktree: root,
      subject: subject === undefined ? adrBinding.decompositionSubject({ phase: 1, repository: root, adr: resolved }) : subject,
      sourceRevision: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      repository: root, policyHash: 'a'.repeat(64), status: 'completed', summary: 'planned',
    },
    plans: [path.join(phaseDir, 'CONTEXT.md'), path.join(phaseDir, '01-01-PLAN.md')],
    adr: resolved,
    ...(adrBindingMode ? { adrBinding: adrBindingMode } : {}),
  });
}

test('the digest is the sha256 of the ADR file bytes and the subject names it', () => {
  const root = project();
  try {
    const adr = adrBinding.resolveAdr(root, ADR);
    assert.deepEqual({ ...adr }, { path: ADR, sha256: sha('# ADR 001\n') });
    assert.equal(adrBinding.decompositionSubject({ phase: 1, repository: root, adr }), `phase=1;repository=${root};adr=${adr.sha256}`);
    const envelope = seal(root);
    assert.equal(envelope.subject, `phase=1;repository=${root};adr=${sha('# ADR 001\n')}`);
    assert.equal(envelope.schema, 'shipyard.decomposition-result.v1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an ADR path outside .planning/architecture, nested, absolute or not markdown is refused', () => {
  const root = project();
  try {
    fs.writeFileSync(path.join(root, 'ADR-x.md'), '# x\n');
    fs.mkdirSync(path.join(root, '.planning', 'architecture', 'nested'));
    fs.writeFileSync(path.join(root, '.planning', 'architecture', 'nested', 'ADR-y.md'), '# y\n');
    fs.writeFileSync(path.join(root, '.planning', 'architecture', 'notes.txt'), 'n\n');
    for (const bad of ['ADR-x.md', '../ADR-x.md', path.join(root, ADR), '.planning/architecture/nested/ADR-y.md',
      '.planning/architecture/notes.txt', '.planning/architecture/../ADR-x.md', '', 5, undefined]) {
      assert.throws(() => adrBinding.resolveAdr(root, bad), (error) => ['ADR_REQUIRED', 'ADR_PATH_INVALID'].includes(error.code), String(bad));
    }
    assert.throws(() => adrBinding.resolveAdr(root, '.planning/architecture/ADR-missing.md'), { code: 'ADR_UNAVAILABLE' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a symlinked ADR is refused', () => {
  const root = project();
  try {
    fs.symlinkSync(path.join(root, ADR), path.join(root, '.planning', 'architecture', 'ADR-link.md'));
    assert.throws(() => adrBinding.resolveAdr(root, '.planning/architecture/ADR-link.md'), { code: 'ADR_UNAVAILABLE' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an ADR edited after launch is refused when the envelope is sealed', () => {
  const root = project();
  try {
    const launched = adrBinding.resolveAdr(root, ADR);
    fs.appendFileSync(path.join(root, ADR), 'edited after launch\n');
    assert.throws(() => seal(root, { adr: launched, subject: adrBinding.decompositionSubject({ phase: 1, repository: root, adr: launched }) }),
      { code: 'ADR_CHANGED' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a subject without adr=, with another repository, or with another digest is refused', () => {
  const root = project();
  try {
    assert.throws(() => seal(root, { subject: `phase=1;repository=${root}` }), { code: 'DECOMPOSITION_SUBJECT_INVALID' });
    assert.throws(() => seal(root, { subject: `phase=1;repository=/elsewhere;adr=${sha('# ADR 001\n')}` }), { code: 'DECOMPOSITION_SUBJECT_INVALID' });
    assert.throws(() => seal(root, { subject: `phase=1;repository=${root};adr=${sha('another adr')}` }), { code: 'ADR_DIGEST_MISMATCH' });
    assert.throws(() => seal(root, { subject: `phase=1;repository=${root};adr=short` }), { code: 'DECOMPOSITION_SUBJECT_INVALID' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sealing a decomposition with no resolved ADR is refused, while a research seal may opt out', () => {
  const root = project();
  try {
    assert.throws(() => sealDecomposition({
      root: path.join(root, '.sealed'),
      scope: { worktree: root, subject: `phase=1;repository=${root};adr=${sha('# ADR 001\n')}`, sourceRevision: 'b'.repeat(40),
        repository: root, policyHash: 'a'.repeat(64), status: 'completed', summary: 's' },
      plans: [path.join(root, '.planning', 'phases', '01-greeting', 'CONTEXT.md')],
    }), { code: 'ADR_REQUIRED' });
    const research = sealDecomposition({
      root: path.join(root, '.sealed-research'),
      scope: { worktree: root, subject: `phase=1;repository=${root}`, sourceRevision: 'b'.repeat(40), repository: root,
        policyHash: 'a'.repeat(64), status: 'completed', summary: 's' },
      plans: [path.join(root, '.planning', 'phases', '01-greeting', 'CONTEXT.md')],
      adrBinding: 'none',
    });
    assert.equal(research.subject, `phase=1;repository=${root}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the Claude host requires the ADR for planner and checker, and resolves it from the worktree', () => {
  const root = project();
  try {
    const base = { phase: 1, worktree: root, prompt: 'Plan.' };
    for (const role of ['gsd-planner', 'gsd-plan-checker']) {
      assert.throws(() => canonicalRequest({ ...base, role }), { code: 'ADR_REQUIRED' });
      assert.throws(() => canonicalRequest({ ...base, role, adr: '.planning/architecture/ADR-missing.md' }), { code: 'ADR_UNAVAILABLE' });
      assert.deepEqual({ ...canonicalRequest({ ...base, role, adr: ADR }).adr }, { path: ADR, sha256: sha('# ADR 001\n') });
    }
    assert.equal(canonicalRequest({ ...base, role: 'gsd-phase-researcher' }).adr, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the Codex host accepts an adr path and refuses a malformed one', () => {
  const request = codexHost.requestValue({ gsd_role: 'gsd-planner', prompt: 'Plan.', adr: ADR });
  assert.equal(request.adr, ADR);
  assert.equal(Object.hasOwn(codexHost.requestValue({ gsd_role: 'gsd-planner', prompt: 'Plan.' }), 'adr'), false);
  for (const adr of ['', '  ', 5, {}]) {
    assert.throws(() => codexHost.requestValue({ gsd_role: 'gsd-planner', prompt: 'Plan.', adr }), { code: 'INVALID_INPUT' });
  }
});

done();
