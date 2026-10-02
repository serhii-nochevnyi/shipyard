'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDevelopmentArtifact, productPathspec, changedProductPaths } = require('../../plugins/delivery-pipeline/scripts/development-artifacts.cjs');

test('process metadata is excluded while executable pipeline source stays in scope', () => {
  for (const file of ['.planning/phases/46/PLAN.md', '.planning/graph/tickets.json', '.shipyard/state.json', '.shipyard-run.json', 'docs/audits/run.json', 'AGENTS.md', 'CLAUDE.md']) assert.equal(isDevelopmentArtifact(file), true, file);
  for (const file of ['plugins/delivery-pipeline/scripts/gsd-sync.cjs', '.github/workflows/test.yml', 'tests/unit/planning-artifacts.test.cjs', 'README.md', 'docs/user-guide.md', '.planning-other/code.js', '../.planning/x']) assert.equal(isDevelopmentArtifact(file), false, file);
});

test('mixed changes and moves out of process directories retain product coverage', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-product-scope-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git(['init', '-q']); git(['config', 'user.email', 'scope@example.invalid']); git(['config', 'user.name', 'Scope']);
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'source.cjs'), 'original');
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline']);
  const base = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(cwd, '.planning', 'notes.json'), 'invalid json is not a quality target');
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'process only']);
  assert.deepEqual(changedProductPaths(base, 'HEAD', cwd), []);
  fs.renameSync(path.join(cwd, '.planning', 'source.cjs'), path.join(cwd, 'product.cjs'));
  git(['add', '-A']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'move to product']);
  assert.deepEqual(changedProductPaths(base, 'HEAD', cwd), ['product.cjs']);
  const diff = git(['diff', base, 'HEAD', ...productPathspec()]);
  assert.match(diff, /product.cjs/); assert.doesNotMatch(diff, /notes.json|\.planning\/source/);
});

test('process-only changes do not require a refreshed review, mixed changes do', () => {
  const { reviewFreshness } = require('../../plugins/delivery-pipeline/scripts/reviewers.cjs');
  const view = { reviewDecision: 'APPROVED', headRefOid: 'new-head', files: [{ path: '.planning/STATE.md' }] };
  assert.equal(reviewFreshness(view, [], true, []).review_freshness_required, false);
  view.files.push({ path: 'scripts/runtime.cjs' });
  assert.equal(reviewFreshness(view, [], true, []).review_freshness_required, true);
});
