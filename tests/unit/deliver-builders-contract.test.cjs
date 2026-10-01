'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');
const deliverPath = path.join(repositoryRoot, 'plugins/delivery-pipeline/commands/deliver.md');
const scriptPath = path.join(repositoryRoot, 'plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
const dispatcher = require(scriptPath);
const deliver = fs.readFileSync(deliverPath, 'utf8');

suite('deliver request builders: command contract');

test('deliver.md uses the build subcommand for all three roles', () => {
  for (const role of ['arch-review', 'ci-fix', 'review-fix']) {
    assert.ok(deliver.includes(`deliver-dispatch.cjs build ${role}`), `${role} builder command is missing`);
  }
});

test('the referenced script and build subcommand resolve', () => {
  assert.ok(fs.existsSync(scriptPath));
  assert.equal(typeof dispatcher.build, 'function');
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /command === 'build'/);
});

test('these role instructions no longer hand-build boundary requests', () => {
  const ciStart = deliver.indexOf('first | progress | repeat | repeat_exhausted — build the role request');
  const reviewStart = deliver.indexOf('b. reviewers.cjs feedback <pr>');
  const archStart = deliver.indexOf('c. arch-review agent — host-bound judgment');
  const archEnd = deliver.indexOf('the same step runs the degenerate-green detector', archStart);
  assert.ok(ciStart >= 0 && reviewStart > ciStart && archStart > reviewStart && archEnd > archStart);

  const ci = deliver.slice(ciStart, reviewStart);
  const review = deliver.slice(reviewStart, archStart);
  const arch = deliver.slice(archStart, archEnd);
  for (const [role, section] of [['ci-fix', ci], ['review-fix', review], ['arch-review', arch]]) {
    assert.ok(section.includes(`deliver-dispatch.cjs build ${role}`), `${role} section does not use its builder`);
    assert.ok(!section.includes('boundary.dispatch('), `${role} section still hand-builds a boundary request`);
  }
});

done();
