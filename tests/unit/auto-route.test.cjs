'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  AUTO_ROUTE_BEGIN,
  AUTO_ROUTE_END,
  claudePolicy,
  codexBlock,
  shouldInject,
} = require('../../plugins/delivery-pipeline/scripts/auto-route.cjs');

const SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'auto-route.cjs');

function run(input) {
  return spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' });
}

suite('auto-route — policy text');

test('claudePolicy names both the router and the investigate route', () => {
  const text = claudePolicy();
  assert.match(text, /\/shipyard:route/);
  assert.match(text, /\/shipyard:investigate/);
});

test('codexBlock is marker-delimited and names the investigate route for phase 1 and 2', () => {
  for (const phase of [1, 2]) {
    const block = codexBlock(phase);
    assert.strictEqual(block.startsWith(AUTO_ROUTE_BEGIN), true);
    assert.strictEqual(block.endsWith(AUTO_ROUTE_END), true);
    assert.match(block, /\$shipyard-investigate/);
    assert.match(block, /\$shipyard-route/);
  }
});

test('codexBlock keeps the phase-aware large-work route', () => {
  assert.match(codexBlock(2), /`\$shipyard-decompose` -> `\$shipyard-deliver`/);
  assert.match(codexBlock(1), /install phase 2 before delivery/);
  assert.strictEqual(/`\$shipyard-decompose` -> `\$shipyard-deliver`/.test(codexBlock(1)), false);
});

suite('auto-route — shouldInject classification');

test('a plain prompt injects', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ prompt: 'add a feature' })), true);
});

test('a prompt_text payload injects', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ prompt_text: 'add a feature' })), true);
});

test('a task-notification prompt stays silent', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ prompt: '<task-notification>ping</task-notification>' })), false);
});

test('leading whitespace before a task-notification still stays silent', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ prompt: '  <task-notification>ping</task-notification>' })), false);
});

test('a slash command stays silent', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ prompt: '/shipyard:deliver' })), false);
});

test('a command-name payload stays silent', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ prompt: 'run <command-name>shipyard:deliver</command-name>' })), false);
});

test('a command-message payload stays silent', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ prompt: 'ctx <command-message>deliver</command-message>' })), false);
});

test('invalid JSON injects', () => {
  assert.strictEqual(shouldInject('not json'), true);
});

test('empty stdin injects', () => {
  assert.strictEqual(shouldInject(''), true);
});

test('JSON with no string prompt or prompt_text injects', () => {
  assert.strictEqual(shouldInject(JSON.stringify({ other: 'field' })), true);
  assert.strictEqual(shouldInject(JSON.stringify([1, 2, 3])), true);
  assert.strictEqual(shouldInject(JSON.stringify(null)), true);
  assert.strictEqual(shouldInject(JSON.stringify('a bare string')), true);
});

suite('auto-route — CLI (spawned process)');

test('a plain request prints the policy and exits 0', () => {
  const result = run(JSON.stringify({ prompt: 'implement the missing endpoint' }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), claudePolicy());
});

test('a prompt_text payload prints the policy and exits 0', () => {
  const result = run(JSON.stringify({ prompt_text: 'implement the missing endpoint' }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), claudePolicy());
});

test('/shipyard:deliver prints nothing and exits 0', () => {
  const result = run(JSON.stringify({ prompt: '/shipyard:deliver' }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

test('a <command-name> payload prints nothing and exits 0', () => {
  const result = run(JSON.stringify({ prompt: '<command-name>shipyard:deliver</command-name>' }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

test('a <task-notification> payload prints nothing and exits 0', () => {
  const result = run(JSON.stringify({ prompt: '<task-notification>done</task-notification>' }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

test('invalid JSON prints the policy and exits 0', () => {
  const result = run('{not valid json');
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), claudePolicy());
});

test('empty stdin prints the policy and exits 0', () => {
  const result = run('');
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), claudePolicy());
});

test('the CLI never echoes prompt content back', () => {
  const secret = 'super-secret-prompt-content-xyz';
  const result = run(JSON.stringify({ prompt: secret }));
  assert.strictEqual(result.stdout.includes(secret), false);
});

done();
