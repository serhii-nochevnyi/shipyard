'use strict';

// path-owner.cjs — the ONE answer to "does this files_modified entry own this
// path", asked by Gate 2's overlap check, the scope gate and base-merge.
//
// The three used to ask it separately, and all three asked it wrong: each cut a
// declaration at its first wildcard and treated the stump as a directory
// prefix. `src/foo*.ts` then owned `src/foo` and NOT `src/fooBar.ts`, and
// `src/*.ts` owned everything under `src/`. The consequences ran in both
// directions — Gate 2 passed two unordered tickets that genuinely collide, the
// scope gate rejected a legitimate edit, and base-merge classified the ticket's
// OWN file as "not mine", took the base's edition over it, committed, and
// exited 0 reporting `resolved mechanically`. That is the only mechanical
// conflict resolver the conveyor has, deciding from a wrong owner.
//
// So the matcher is exact by construction: it either answers precisely or says
// it cannot parse the declaration, and a declaration it cannot parse is a Gate 2
// error rather than a guess.

const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const { parse, owns, mayIntersect, literalPrefix } = require(
  path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'path-owner.cjs')
);

const ok = (d, p) => assert.strictEqual(owns(d, p), true, `${d} should own ${p}`);
const no = (d, p) => assert.strictEqual(owns(d, p), false, `${d} must NOT own ${p}`);

suite('parse — the accepted grammar, and nothing else');

test('an exact path is a file declaration', () => {
  const r = parse('src/api/auth.ts');
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.kind, 'file');
  assert.deepStrictEqual(r.segs, ['src', 'api', 'auth.ts']);
});

test('a directory is accepted as dir, dir/ and dir/**', () => {
  for (const d of ['tests/fixtures', 'tests/fixtures/', 'tests/fixtures/**']) {
    const r = parse(d);
    assert.strictEqual(r.error, undefined, `${d}: ${r.error}`);
    assert.deepStrictEqual(r.segs, ['tests', 'fixtures'], d);
    assert.strictEqual(r.subtree, true, d);
  }
  assert.strictEqual(parse('tests/fixtures/').kind, 'dir');
  assert.strictEqual(parse('tests/fixtures/**').kind, 'dir');
});

test('a single * inside one segment is a glob', () => {
  for (const d of ['src/foo*.ts', 'src/*.ts', 'src/*/x.ts', 'src/*']) {
    const r = parse(d);
    assert.strictEqual(r.error, undefined, `${d}: ${r.error}`);
    assert.strictEqual(r.kind, 'glob', d);
    assert.strictEqual(r.subtree, false, d);
  }
});

// `src/**` is deliberately NOT in this list, though a predecessor's draft had it
// there: `dir/**` IS the accepted directory spelling, asserted two tests up for
// `tests/fixtures/**` and below for `shared/**`. The plan rejects `**` MID-pattern
// (`src/**/x.ts`) and a `**` with no literal part at all (`**`), which is a
// declaration owning the whole repository.
test('everything outside the three forms is an error naming the declaration', () => {
  for (const d of ['src/**/x.ts', 'a?.ts', 'src/[ab].ts', 'src/{a,b}.ts', '**', 'src/a*b*.ts', 'src/foo*/**', 'src/*/x*.ts', '']) {
    const r = parse(d);
    assert.ok(r.error, `${d} must not parse, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.decl, d, 'the rejection carries the declaration it is about');
  }
});

test('a path that merely escapes the repo still parses — that is escapesRepo\'s concern', () => {
  // The validator warns about these and flags the ticket `unreachable_paths`;
  // turning them into a parse error would promote ONE parked ticket into a
  // Gate 2 failure for the whole graph.
  for (const d of ['../other-repo/src/x.ts', '/etc/hosts', 'a/../b.ts']) {
    assert.strictEqual(parse(d).error, undefined, `${d} must parse`);
  }
});

suite('owns — the F01 answers');

test('a segment glob matches within its own segment only', () => {
  ok('src/foo*.ts', 'src/fooBar.ts');
  ok('src/foo*.ts', 'src/foo.ts');
  no('src/foo*.ts', 'src/foo');
  no('src/foo*.ts', 'src/bar.ts');
  ok('src/*.ts', 'src/x.ts');
  no('src/*.ts', 'src/a/b.ts');
  no('src/*.ts', 'src/x.md');
  no('src/*.ts', 'x.ts');
});

test('a bare path owns itself and everything under it', () => {
  // A declaration cannot be known to name a file rather than a directory
  // without touching the working tree, and Gate 2 must not depend on it —
  // `tests/fixtures` is a real declaration in this repo for a directory that
  // does not exist yet.
  ok('tests/fixtures', 'tests/fixtures/a/b');
  ok('tests/fixtures', 'tests/fixtures');
  no('tests/fixtures', 'tests/fixtures-old/a');
  ok('CLAUDE.md', 'CLAUDE.md');
  no('CLAUDE.md', 'CLAUDE.md.bak');
});

test('a directory declaration owns its subtree in all three spellings', () => {
  for (const d of ['shared', 'shared/', 'shared/**']) {
    ok(d, 'shared/tools.ts');
    ok(d, 'shared/deep/nested/x.ts');
    no(d, 'shared-other/tools.ts');
  }
});

test('an unparseable declaration owns nothing — the caller must ask parse first', () => {
  no('src/**/x.ts', 'src/a/x.ts');
  no('a?.ts', 'ab.ts');
});

suite('mayIntersect — two declarations that can name the same path');

test('the F01 pair: a segment glob and a path it matches', () => {
  assert.strictEqual(mayIntersect('src/foo*.ts', 'src/fooBar.ts'), true);
  assert.strictEqual(mayIntersect('src/fooBar.ts', 'src/foo*.ts'), true);
  assert.strictEqual(mayIntersect('src/*.ts', 'src/fooBar.ts'), true);
});

test('a directory intersects anything under it, in either order', () => {
  assert.strictEqual(mayIntersect('src', 'src/a/b.ts'), true);
  assert.strictEqual(mayIntersect('src/a/b.ts', 'src/'), true);
  assert.strictEqual(mayIntersect('src/**', 'src/a/b.ts'), true);
});

test('declarations that cannot name a common path do not intersect', () => {
  assert.strictEqual(mayIntersect('src/*.ts', 'src/a/b.ts'), false);
  assert.strictEqual(mayIntersect('src/*.ts', 'src/x.md'), false);
  assert.strictEqual(mayIntersect('docs/*.md', 'src/*.ts'), false);
  assert.strictEqual(mayIntersect('src/a.ts', 'src/b.ts'), false);
  assert.strictEqual(mayIntersect('src/foo*.ts', 'src/bar.ts'), false);
  assert.strictEqual(mayIntersect('src/*', 'src/a/b.ts'), false);
});

test('two globs intersect when a witness path satisfies both', () => {
  assert.strictEqual(mayIntersect('src/foo*.ts', 'src/*Bar.ts'), true);   // src/fooBar.ts
  assert.strictEqual(mayIntersect('src/a*', 'src/*b'), true);             // src/ab
  assert.strictEqual(mayIntersect('src/foo*.ts', 'src/bar*.ts'), false);  // prefixes disagree
  assert.strictEqual(mayIntersect('src/*.ts', 'src/*.md'), false);        // suffixes disagree
});

test('an unparseable declaration is assumed to collide, never assumed safe', () => {
  // Gate 2 rejects the entry itself; while it is in the graph the overlap
  // question must fail closed.
  assert.strictEqual(mayIntersect('src/**/x.ts', 'docs/readme.md'), true);
  assert.strictEqual(mayIntersect('docs/readme.md', 'a?.ts'), true);
});

suite('literalPrefix — the leading literal part, for the validator warnings');

test('it stops at the first wildcard segment', () => {
  assert.strictEqual(literalPrefix('src/api/auth.ts'), 'src/api/auth.ts');
  assert.strictEqual(literalPrefix('tests/fixtures/'), 'tests/fixtures');
  assert.strictEqual(literalPrefix('shared/**'), 'shared');
  assert.strictEqual(literalPrefix('docs/*.md'), 'docs');
  assert.strictEqual(literalPrefix('src/foo*.ts'), 'src');
  assert.strictEqual(literalPrefix('*.ts'), '');
  assert.strictEqual(literalPrefix('**'), '');
});

done();
