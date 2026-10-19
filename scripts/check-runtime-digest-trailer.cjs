#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const result = spawnSync(process.execPath, [
  path.join(__dirname, 'refresh-runtime-digests.cjs'), '--check',
], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status === null ? 1 : result.status);
