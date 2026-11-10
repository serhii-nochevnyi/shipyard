'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const HOOK = path.resolve(__dirname, '../../scripts/shipyard-pre-push-gate.sh');

for (const command of ['git push', 'git -C "$W" push', 'cd "$W"; git push',
  'git --no-pager -C "/path with spaces" push', 'git push origin other:branch']) {
  test('tool compatibility hook does not infer pushed refs from: ' + command, () => {
    const result = spawnSync('bash', [HOOK], { input: JSON.stringify({
      cwd: '/does/not/exist', tool_input: { command },
    }), encoding: 'utf8', env: { ...process.env, SHIPYARD_PUBLISH_GATE: '/must/not/be/executed' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
}

test('tool compatibility hook tolerates missing or malformed JSON', () => {
  for (const input of ['', '{invalid', '{}']) {
    assert.equal(spawnSync('bash', [HOOK], { input, encoding: 'utf8' }).status, 0);
  }
});
