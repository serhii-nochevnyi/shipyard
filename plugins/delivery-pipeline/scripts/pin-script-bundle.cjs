#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { payloadDigest } = require('./install-shipyard-git-hook.cjs');

function pinBundle({ pluginRoot, installRoot }) {
  const source = fs.realpathSync(pluginRoot);
  const hash = payloadDigest(source);
  const root = path.resolve(installRoot);
  if (root === source || root.startsWith(source + path.sep)) throw new Error('stable bundle must live outside the source cache');
  fs.mkdirSync(root, { recursive: true });
  const destination = path.join(root, hash);
  if (!fs.existsSync(destination)) {
    const temporary = fs.mkdtempSync(path.join(root, '.prepare-'));
    try {
      fs.cpSync(source, temporary, { recursive: true, dereference: false });
      if (payloadDigest(temporary) !== hash) throw new Error('source bundle changed while pinning');
      try { fs.renameSync(temporary, destination); }
      catch (error) { if (!fs.existsSync(destination)) throw error; }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  if (payloadDigest(destination) !== hash) throw new Error('pinned bundle was altered');
  return destination;
}
module.exports = { pinBundle };
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: pin-script-bundle.cjs <plugin-root> <retained-bundles-root>');
    process.stdout.write(pinBundle({ pluginRoot: process.argv[2], installRoot: process.argv[3] }) + '\n');
  } catch (error) { process.stderr.write('pin-script-bundle: ' + error.message + '\n'); process.exitCode = 1; }
}
