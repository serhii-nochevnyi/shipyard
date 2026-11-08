'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDependencies, pendingInstall } = require('../../plugins/delivery-pipeline/scripts/worktree-deps.cjs');

function fixture(files, directories = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-deps-'));
  for (const file of files) fs.writeFileSync(path.join(root, file), '{}\n');
  for (const directory of directories) fs.mkdirSync(path.join(root, directory));
  return root;
}

function binDirectory(...programs) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-deps-bin-'));
  for (const program of programs) fs.writeFileSync(path.join(bin, program), '#!/bin/sh\n', { mode: 0o755 });
  return bin;
}

test('a project without a lockfile, without package.json or with node_modules needs nothing', () => {
  for (const root of [fixture(['package.json']), fixture(['pnpm-lock.yaml']), fixture(['package.json', 'pnpm-lock.yaml'], ['node_modules'])]) {
    try {
      assert.equal(pendingInstall(root), null);
      assert.deepEqual(ensureDependencies(root, { run() { throw new Error('must not run'); } }), { installed: false });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('a locked project without node_modules is installed from the lockfile with scripts disabled', () => {
  const root = fixture(['package.json', 'pnpm-lock.yaml']);
  const bin = binDirectory('pnpm');
  const calls = [];
  try {
    const result = ensureDependencies(root, { env: { PATH: bin }, run(program, args, cwd) { calls.push([program, args, cwd]); } });
    assert.deepEqual(calls, [['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], root]]);
    assert.equal(result.installed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('the manager follows the lockfile and a missing manager or failed install refuses with the command to run', () => {
  const npmRoot = fixture(['package.json', 'package-lock.json']);
  const bin = binDirectory('npm');
  try {
    const calls = [];
    ensureDependencies(npmRoot, { env: { PATH: bin }, run(program, args) { calls.push([program, args]); } });
    assert.deepEqual(calls, [['npm', ['ci', '--ignore-scripts']]]);
    assert.throws(() => ensureDependencies(npmRoot, { env: { PATH: bin },
      run() { const error = new Error('boom'); error.stderr = 'ERR_PNPM_X\nlockfile out of date'; throw error; } }),
    (error) => error.code === 'DEPENDENCIES_INSTALL_FAILED' && /npm ci --ignore-scripts/.test(error.message) && /lockfile out of date/.test(error.message));
    const pnpmRoot = fixture(['package.json', 'pnpm-lock.yaml']);
    try {
      assert.throws(() => ensureDependencies(pnpmRoot, { env: { PATH: bin }, run() { throw new Error('must not run'); } }),
        (error) => error.code === 'DEPENDENCIES_UNAVAILABLE' && /pnpm install --frozen-lockfile --ignore-scripts/.test(error.message));
    } finally { fs.rmSync(pnpmRoot, { recursive: true, force: true }); }
  } finally { fs.rmSync(npmRoot, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});
