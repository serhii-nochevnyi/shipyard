'use strict';

const { test } = require('node:test');
const { runShard } = require('../fixtures/phase53/combined-followup-helpers.cjs');

test('combined repaired source and staged consumers: complete positive scenarios', { timeout: 600000 }, async t => {
  await runShard(t, 'positive');
});
