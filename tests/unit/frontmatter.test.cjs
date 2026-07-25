'use strict';

// Frontmatter parser contract. Gate 2 reads plan frontmatter produced by
// gsd-planner, by the import path and by hand — so the parser must either
// represent a construct correctly or report an error, NEVER half-parse it.

const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { parseFrontmatter, stripComment } =
  require(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'frontmatter.cjs'));

const fm = (body) => parseFrontmatter(`---\n${body}\n---\n\n# Body\n`);

suite('stripComment');

test('strips a trailing comment after whitespace', () => {
  assert.strictEqual(stripComment('[a, b]   # note').trim(), '[a, b]');
});

test('keeps a # that is inside a double-quoted scalar', () => {
  assert.strictEqual(stripComment('"fixes #42"'), '"fixes #42"');
});

test('keeps a # that is inside a single-quoted scalar', () => {
  assert.strictEqual(stripComment("'issue #7 here'"), "'issue #7 here'");
});

test('keeps a # glued to a word (URL fragment)', () => {
  assert.strictEqual(stripComment('http://x/y#frag'), 'http://x/y#frag');
});

suite('parseFrontmatter — the regression that voided Gate 2');

test('a trailing comment does NOT leak into the last flow-list entry', () => {
  const { data, errors } = fm('files_modified: [src/a.ts, src/b.ts]   # what it touches');
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(data.files_modified, ['src/a.ts', 'src/b.ts']);
});

test('a trailing comment does not turn an int into a string', () => {
  const { data } = fm('wave: 2      # 1 + max(dep wave)');
  assert.strictEqual(data.wave, 2);
});

suite('parseFrontmatter — scalars');

test('quoted title containing a colon survives', () => {
  const { data } = fm('title: "Add API endpoint (v2): auth"');
  assert.strictEqual(data.title, 'Add API endpoint (v2): auth');
});

test('booleans, null and numbers are typed; quoted digits stay strings', () => {
  const { data } = fm(['a: true', 'b: false', 'c: null', 'd: ~', 'e: 42', 'f: -1.5', 'g: "07"'].join('\n'));
  assert.strictEqual(data.a, true);
  assert.strictEqual(data.b, false);
  assert.strictEqual(data.c, null);
  assert.strictEqual(data.d, null);
  assert.strictEqual(data.e, 42);
  assert.strictEqual(data.f, -1.5);
  assert.strictEqual(data.g, '07');
});

test('a glob with commas inside quotes stays one entry', () => {
  const { data } = fm('files_modified: ["src/{a,b}/*.ts", src/c.ts]');
  assert.deepStrictEqual(data.files_modified, ['src/{a,b}/*.ts', 'src/c.ts']);
});

suite('parseFrontmatter — structure');

test('nested map (the delivery block)', () => {
  const { data, errors } = fm([
    'phase: 01',
    'delivery:',
    '  ticket: T-01-02',
    '  risk: high',
    '  human_checkpoint: true',
    'type: implementation',
  ].join('\n'));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(data.delivery, { ticket: 'T-01-02', risk: 'high', human_checkpoint: true });
  assert.strictEqual(data.type, 'implementation');
});

test('block sequence indented under its key', () => {
  const { data } = fm(['depends_on:', '  - T-01-01', '  - T-01-02'].join('\n'));
  assert.deepStrictEqual(data.depends_on, ['T-01-01', 'T-01-02']);
});

test('block sequence at the PARENT indent (also valid YAML)', () => {
  const { data } = fm(['depends_on:', '- T-01-01', '- T-01-02', 'type: implementation'].join('\n'));
  assert.deepStrictEqual(data.depends_on, ['T-01-01', 'T-01-02']);
  assert.strictEqual(data.type, 'implementation');
});

test('sequence of maps (what used to hard-exit the validator)', () => {
  const { data, errors } = fm([
    'tasks:',
    '  - name: build',
    '    done: true',
    '  - name: test',
    '    done: false',
    'phase: 2',
  ].join('\n'));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(data.tasks, [{ name: 'build', done: true }, { name: 'test', done: false }]);
  assert.strictEqual(data.phase, 2);
});

test('multi-line flow sequence', () => {
  const { data, errors } = fm([
    'files_modified: [',
    '  src/a.ts,',
    '  src/b.ts',
    ']',
    'phase: 1',
  ].join('\n'));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(data.files_modified, ['src/a.ts', 'src/b.ts']);
  assert.strictEqual(data.phase, 1);
});

test('block scalar (literal) is captured, not treated as structure', () => {
  const { data, errors } = fm([
    'notes: |',
    '  line one',
    '  line two',
    'phase: 3',
  ].join('\n'));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(data.notes, 'line one\nline two');
  assert.strictEqual(data.phase, 3);
});

test('block scalar (folded) joins lines', () => {
  const { data } = fm(['summary: >', '  a', '  b', 'phase: 1'].join('\n'));
  assert.strictEqual(data.summary, 'a b');
});

test('deep nesting does not collapse', () => {
  const { data } = fm(['a:', '  b:', '    c: 1', '  d: 2', 'e: 3'].join('\n'));
  assert.deepStrictEqual(data, { a: { b: { c: 1 }, d: 2 }, e: 3 });
});

test('full-line comments and blank lines are ignored', () => {
  const { data, errors } = fm(['# leading', '', 'phase: 1', '   # indented comment', 'plan: 2'].join('\n'));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(data, { phase: 1, plan: 2 });
});

test('CRLF line endings parse identically', () => {
  const { data, errors } = parseFrontmatter('---\r\nphase: 1\r\ndelivery:\r\n  ticket: T-01-01\r\n---\r\nbody\r\n');
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(data, { phase: 1, delivery: { ticket: 'T-01-01' } });
});

suite('parseFrontmatter — errors are reported, never half-parsed');

test('unterminated flow collection is an error', () => {
  const { errors } = fm('files_modified: [src/a.ts, src/b.ts');
  assert.ok(errors.length > 0, 'expected an error');
  assert.match(errors[0].message, /unterminated flow/);
});

test('a line with no key is reported with its line number', () => {
  const { errors } = fm(['phase: 1', 'this line has no colon'].join('\n'));
  assert.ok(errors.length > 0);
  assert.strictEqual(errors[0].line, 2);
});

test('missing frontmatter yields data === null, not a crash', () => {
  const { data, errors } = parseFrontmatter('# Just a heading\n\nbody\n');
  assert.strictEqual(data, null);
  assert.deepStrictEqual(errors, []);
});

test('empty frontmatter yields an empty map', () => {
  const { data, errors } = parseFrontmatter('---\n\n---\nbody\n');
  assert.deepStrictEqual(data, {});
  assert.deepStrictEqual(errors, []);
});

done();
