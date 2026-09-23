'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const source = require('../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs');

const MODULE_FILE = require.resolve('../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs');

function withInstalledCopy(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reference-content-'));
  const root = fs.realpathSync(temporary);
  const scripts = path.join(root, 'scripts');
  const references = path.join(root, 'references');
  fs.mkdirSync(scripts);
  fs.mkdirSync(references);
  const moduleFile = path.join(scripts, 'claude-reference-content.cjs');
  fs.copyFileSync(MODULE_FILE, moduleFile);
  const loader = require(moduleFile);
  try {
    run({ root, references, loader });
  } finally {
    delete require.cache[moduleFile];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

suite('claude-reference-content');

test('loads every approved installed Markdown reference by ID and exact path', () => {
  assert.deepEqual(source.REFERENCE_IDS, [
    'arch-review', 'ci-fix', 'drift-check', 'integrator',
    'inv-research', 'pr-sentinel', 'review-fix',
  ]);
  for (const id of source.REFERENCE_IDS) {
    const expected = fs.readFileSync(source.REFERENCE_PATHS[id], 'utf8');
    assert.equal(source.loadClaudeReferenceContent(id), expected);
    assert.equal(source.loadClaudeReferenceContent(source.REFERENCE_PATHS[id]), expected);
    assert.ok(!expected.includes(path.resolve(__dirname, '../../plugins/delivery-pipeline')));
    assert.ok(Buffer.byteLength(expected) <= source.MAX_REFERENCE_BYTES);
  }
});

test('rejects unknown IDs, arbitrary paths, traversal, and non-string selections', () => {
  const approved = source.REFERENCE_PATHS['ci-fix'];
  for (const selection of [
    'unknown', 'ci-fix.md', 'references/ci-fix.md', '../references/ci-fix.md',
    path.join(path.dirname(approved), 'unknown.md'),
    `${path.dirname(approved)}/../references/ci-fix.md`,
    `${approved}/../ci-fix.md`,
    '/tmp/ci-fix.md',
    null,
    { id: 'ci-fix', path: approved },
  ]) {
    assert.throws(() => source.loadClaudeReferenceContent(selection), { code: 'INVALID_REFERENCE' });
  }
});

test('rejects symlinked files and symlinked reference directories', () => {
  withInstalledCopy(({ root, references, loader }) => {
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, '# outside\n');
    fs.symlinkSync(outside, path.join(references, 'ci-fix.md'));
    assert.throws(() => loader.loadClaudeReferenceContent('ci-fix'), { code: 'INVALID_REFERENCE' });

    fs.rmSync(references, { recursive: true });
    const actual = path.join(root, 'actual-references');
    fs.mkdirSync(actual);
    fs.writeFileSync(path.join(actual, 'ci-fix.md'), '# hidden\n');
    fs.symlinkSync(actual, references, 'dir');
    assert.throws(() => loader.loadClaudeReferenceContent('ci-fix'), { code: 'INVALID_REFERENCE' });
  });
});

test('rejects oversized and path-leaking content without returning a truncated contract', () => {
  withInstalledCopy(({ root, references, loader }) => {
    const file = path.join(references, 'ci-fix.md');
    fs.writeFileSync(file, 'x'.repeat(loader.MAX_REFERENCE_BYTES + 1));
    assert.throws(() => loader.loadClaudeReferenceContent('ci-fix'), { code: 'INVALID_REFERENCE' });
    fs.writeFileSync(file, `Read ${root}/scripts/secret.cjs\n`);
    assert.throws(() => loader.loadClaudeReferenceContent('ci-fix'), { code: 'INVALID_REFERENCE' });
  });
});

done();
