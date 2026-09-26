'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { installClaudeMarketplace } = require('../../scripts/install-shipyard-marketplace.cjs');

function fixture({ pinned = true, failInstall = false } = {}) {
  let marketplace = { name: 'shipyard', source: 'github', repo: 'serhii-nochevnyi/shipyard',
    ...(pinned ? { ref: 'v0.64.0' } : {}) };
  let plugin = { id: 'shipyard@shipyard', version: '0.64.0', enabled: true };
  const calls = [];
  const read = (_command, args) => args[1] === 'marketplace'
    ? marketplace ? [marketplace] : [] : plugin ? [plugin] : [];
  const execute = (_command, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'marketplace') {
      if (args[2] === 'remove') { marketplace = undefined; plugin = undefined; }
      if (args[2] === 'add') {
        const source = args[3];
        const [repo, ref] = source.split('@');
        marketplace = { name: 'shipyard', source: 'github', repo, ...(ref ? { ref } : {}) };
      }
    } else if (args[1] === 'install') {
      if (failInstall && !marketplace.ref) throw new Error('new plugin unavailable');
      plugin = { id: 'shipyard@shipyard', version: marketplace.ref || '0.65.1', enabled: true };
    }
  };
  return { read, execute, calls, state: () => ({ marketplace, plugin }) };
}

test('upgrades a pinned Claude marketplace to the current unpinned source', () => {
  const host = fixture();
  installClaudeMarketplace('serhii-nochevnyi/shipyard', host.execute, host.read);
  assert.equal(host.state().marketplace.ref, undefined);
  assert.equal(host.state().plugin.version, '0.65.1');
  assert.deepEqual(host.calls, ['plugin marketplace remove shipyard',
    'plugin marketplace add serhii-nochevnyi/shipyard', 'plugin install shipyard@shipyard']);
});

test('restores pinned marketplace and plugin if replacement install fails', () => {
  const host = fixture({ failInstall: true });
  assert.throws(() => installClaudeMarketplace('serhii-nochevnyi/shipyard', host.execute, host.read),
    /new plugin unavailable/);
  assert.equal(host.state().marketplace.ref, 'v0.64.0');
  assert.equal(host.state().plugin.version, 'v0.64.0');
});

test('refreshes an existing unpinned marketplace in place', () => {
  const host = fixture({ pinned: false });
  installClaudeMarketplace('serhii-nochevnyi/shipyard', host.execute, host.read);
  assert.deepEqual(host.calls, ['plugin marketplace update shipyard',
    'plugin update shipyard@shipyard']);
});
