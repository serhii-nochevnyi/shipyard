'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pipeline = require('../../plugins/delivery-pipeline/scripts/pipeline-config.cjs');
const { assignPlan } = require('../../plugins/delivery-pipeline/scripts/host-verification.cjs');

test('live bootstrap preserves approved sandbox verification and refuses other programs', () => {
  const root = path.resolve(__dirname, '../..');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-live-fixture-'));
  try {
    fs.cpSync(path.join(root, 'tests/fixtures/live-project'), project, { recursive: true });
    fs.renameSync(path.join(project, 'planning'), path.join(project, '.planning'));
    execFileSync(process.execPath, [path.join(root, 'plugins/delivery-pipeline/scripts/adr-bootstrap.cjs'),
      '--adr', '.planning/architecture/ADR-001-greeting-formats.md', '--phase', '1', '--json'], { cwd: project });
    execFileSync(process.execPath, [path.join(root, 'plugins/delivery-pipeline/scripts/gsd-tune.cjs'),
      '--apply', '--runtime', 'codex'], { cwd: project });
    const config = pipeline.loadConfig(project);
    assert.equal(config.valid, true);
    const allowList = pipeline.repoValue(config, 'verification_commands', 'example/live');
    const assigned = assignPlan('## Verification commands\n- `node --test tests/greeting.test.cjs`', allowList);
    assert.deepEqual(assigned.map(({ argv, profile }) => ({ argv, profile })),
      [{ argv: ['node', '--test', 'tests/greeting.test.cjs'], profile: 'sandbox' }]);
    assert.equal(assignPlan('## Verification commands\n- `node -e "require(\'node:assert\').ok(true)"`', allowList)[0].profile, 'sandbox');
    assert.throws(() => assignPlan('## Verification commands\n- `bash deploy.sh`', allowList), /no approved profile/);
    assert.throws(() => assignPlan('## Verification commands\n- `node unapproved.cjs`', allowList), /no approved profile/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
