'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const TOOL = path.join(__dirname, '..', 'smoke', 'phase52-diff-sizes.cjs');
const SCHEMA = 'shipyard.phase52-diff-sizes.v1';
const MISSING_SHA = 'a'.repeat(40);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phase52-diff-sizes-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function write(repo, relative, content) {
  const absolute = path.join(repo, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function commit(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function newRepo(name) {
  const repo = path.join(scratch, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.abbrev', '40');
  return repo;
}

function bulk(lines) {
  return Array.from({ length: lines }, (_, index) => `line ${String(index).padStart(6, '0')} ${'x'.repeat(40)}\n`).join('');
}

function tool(...args) {
  const result = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function rows(repo, ...commits) {
  const run = tool('--repo', repo, ...commits.flatMap(sha => ['--commit', sha]), '--json');
  assert.strictEqual(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.strictEqual(parsed.schema, SCHEMA);
  assert.strictEqual(parsed.repo, repo);
  return parsed.rows;
}

const repo = newRepo('main');
write(repo, 'base.txt', 'base\n');
const root = commit(repo, 'root');
write(repo, 'src/a.txt', 'one\ntwo\nthree\n');
write(repo, '.planning/phases/52/note.md', bulk(50));
write(repo, 'docs/audits/phase52/evidence.md', bulk(50));
write(repo, '.shipyard-pr-body.md', bulk(10));
write(repo, 'CLAUDE.md', bulk(10));
const small = commit(repo, 'small product change plus artifacts');
write(repo, '.planning/only.md', bulk(10));
write(repo, 'docs/audits/only.md', bulk(10));
const artifactsOnly = commit(repo, 'artifacts only');
write(repo, 'src/medium.txt', bulk(20000));
const medium = commit(repo, 'between one and two MiB');
write(repo, 'src/large.txt', bulk(40000));
const large = commit(repo, 'over two MiB');

suite('phase52-diff-sizes: measurement');

test('reports the exact byte size of a known product diff and ignores development artifacts', () => {
  const blob = git(repo, 'hash-object', 'src/a.txt');
  const expected = [
    'diff --git a/src/a.txt b/src/a.txt',
    'new file mode 100644',
    `index ${'0'.repeat(40)}..${blob}`,
    '--- /dev/null',
    '+++ b/src/a.txt',
    '@@ -0,0 +1,3 @@',
    '+one', '+two', '+three', '',
  ].join('\n');
  const [row] = rows(repo, small);
  assert.strictEqual(row.commit, small);
  assert.strictEqual(row.product_files, 1);
  assert.strictEqual(row.product_diff_bytes, Buffer.byteLength(expected));
  assert.strictEqual(row.estimated_tokens, Math.ceil(Buffer.byteLength(expected) / 4));
  assert.strictEqual(row.over_diff_max_bytes, false);
  assert.strictEqual(row.over_legacy_diff_max_bytes, false);
  assert.strictEqual(row.over_arch_review_tokens, false);
});

test('a commit that changes only .planning and docs/audits paths measures zero', () => {
  const [row] = rows(repo, artifactsOnly);
  assert.strictEqual(row.product_files, 0);
  assert.strictEqual(row.product_diff_bytes, 0);
  assert.strictEqual(row.estimated_tokens, 0);
});

test('a diff between 1 MiB and 2 MiB trips only the legacy and token flags', () => {
  const [row] = rows(repo, medium);
  assert.ok(row.product_diff_bytes > 1048576 && row.product_diff_bytes <= 2097152, String(row.product_diff_bytes));
  assert.strictEqual(row.over_legacy_diff_max_bytes, true);
  assert.strictEqual(row.over_diff_max_bytes, false);
  assert.strictEqual(row.over_arch_review_tokens, true);
});

test('a diff over 2 MiB trips every flag', () => {
  const [row] = rows(repo, large);
  assert.ok(row.product_diff_bytes > 2097152, String(row.product_diff_bytes));
  assert.strictEqual(row.over_legacy_diff_max_bytes, true);
  assert.strictEqual(row.over_diff_max_bytes, true);
  assert.strictEqual(row.over_arch_review_tokens, true);
});

test('several commits keep their order and the table output names each one', () => {
  const measured = rows(repo, large, small);
  assert.deepStrictEqual(measured.map(row => row.commit), [large, small]);
  const run = tool('--repo', repo, '--commit', small, '--commit', medium);
  assert.strictEqual(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(small) && run.stdout.includes(medium));
});

suite('phase52-diff-sizes: flag boundaries');

test('each bound flips strictly above its limit', () => {
  const { flagsFor } = require(TOOL);
  assert.deepStrictEqual(flagsFor(2097152), { over_diff_max_bytes: false, over_legacy_diff_max_bytes: true, over_arch_review_tokens: true });
  assert.strictEqual(flagsFor(2097153).over_diff_max_bytes, true);
  assert.strictEqual(flagsFor(1048576).over_legacy_diff_max_bytes, false);
  assert.strictEqual(flagsFor(1048577).over_legacy_diff_max_bytes, true);
  assert.strictEqual(flagsFor(240000).over_arch_review_tokens, false);
  assert.strictEqual(flagsFor(240001).over_arch_review_tokens, true);
  assert.strictEqual(flagsFor(0).over_arch_review_tokens, false);
});

suite('phase52-diff-sizes: refusals');

test('a root commit is refused with exit 1 naming the sha', () => {
  const run = tool('--repo', repo, '--commit', root);
  assert.strictEqual(run.status, 1);
  assert.ok(run.stderr.includes(root), run.stderr);
  assert.strictEqual(run.stdout, '');
});

test('an unknown sha is refused with exit 1 naming the sha', () => {
  const run = tool('--repo', repo, '--commit', MISSING_SHA);
  assert.strictEqual(run.status, 1);
  assert.ok(run.stderr.includes(MISSING_SHA), run.stderr);
  assert.strictEqual(run.stdout, '');
});

test('a refusal on a later commit prints no partial table', () => {
  const run = tool('--repo', repo, '--commit', small, '--commit', MISSING_SHA, '--json');
  assert.strictEqual(run.status, 1);
  assert.ok(run.stderr.includes(MISSING_SHA), run.stderr);
  assert.strictEqual(run.stdout, '');
});

test('a directory that is not a git repository is refused with exit 1', () => {
  const plain = path.join(scratch, 'plain');
  fs.mkdirSync(plain);
  const run = tool('--repo', plain, '--commit', small);
  assert.strictEqual(run.status, 1);
  assert.ok(run.stderr.includes(plain), run.stderr);
});

suite('phase52-diff-sizes: usage errors');

test('a malformed sha is a usage error with exit 2', () => {
  for (const sha of ['xyz', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '--json']) {
    const run = tool('--repo', repo, '--commit', sha);
    assert.strictEqual(run.status, 2, `${sha}: ${run.stderr}`);
  }
});

test('missing arguments, an unknown option and a bad repo are usage errors with exit 2', () => {
  assert.strictEqual(tool('--commit', small).status, 2);
  assert.strictEqual(tool('--repo', repo).status, 2);
  assert.strictEqual(tool('--repo', repo, '--commit', small, '--bogus').status, 2);
  assert.strictEqual(tool('--repo', path.join(scratch, 'absent'), '--commit', small).status, 2);
  assert.strictEqual(tool('--repo').status, 2);
});

test('a hostile --repo value is never interpreted by a shell', () => {
  const marker = path.join(scratch, 'shell-ran');
  const run = tool('--repo', `${repo}; touch ${marker}`, '--commit', small);
  assert.strictEqual(run.status, 2);
  assert.strictEqual(fs.existsSync(marker), false);
});

done();
