'use strict';

// The degenerate-green detector (ADR-001, D7).
//
// Two properties are under test and they pull in opposite directions, which is
// the whole reason this file is shaped the way it is:
//
//  1. Every enumerated mode is DETECTED on a realistic hunk — and at the right
//     file and line. A detector that fires on the wrong hunk is a false positive
//     wearing the right total, so every positive asserts file AND line, never a
//     count alone.
//
//  2. Every mode, and every independently-firing sub-pattern inside one, has a
//     NEGATIVE CONTROL that must stay silent. This repository has twice shipped a
//     check that could not fail and read the silence as safety, so a control here
//     asserts ZERO findings in total, not zero of its own mode: a control that
//     passes because some OTHER detector stayed quiet proves nothing, and
//     cross-firing is exactly how a report loses its reader.
//
// Positive and control run in the same process, next to each other, so the pair
// is read as one claim: this fires there, and it does not fire here.
//
// The mode fixtures drive the exported `scan()` directly — that is where the file
// and line come from. The CLI is spawned only for the contract that surrounds it:
// the exit code, the JSON shape, and the refusals. The most important assertion
// in the file is the dullest one — findings do not change the exit code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'degenerate-green.cjs');
const { scan, parseDiff, MODES } = require(SCRIPT);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-degen-'));
const D = (...lines) => lines.join('\n') + '\n';
const findingsOf = (diff) => scan(diff).findings;

/** A positive: exactly one finding, of this mode, at this file and this line. */
function fires(name, diff, want) {
  test(name, () => {
    const got = findingsOf(diff);
    assert.strictEqual(got.length, 1, `expected exactly one finding, got:\n${JSON.stringify(got, null, 2)}`);
    const f = got[0];
    assert.strictEqual(f.mode, want.mode, `mode: ${JSON.stringify(f)}`);
    assert.strictEqual(f.file, want.file, `file: ${JSON.stringify(f)}`);
    assert.strictEqual(f.line, want.line, `line: ${JSON.stringify(f)}`);
    if (want.text) assert.ok(f.text.includes(want.text), `matched text was: ${f.text}`);
    if (want.reason) assert.ok(want.reason.test(f.reason), `reason was: ${f.reason}`);
    // A finding a human cannot judge in isolation is noise, whatever it found.
    assert.ok(f.reason && f.reason.length > 20, `every finding carries a reason: ${JSON.stringify(f)}`);
  });
}

/** A control: NOTHING fires. Zero in total, so cross-firing is caught here too. */
function silent(name, diff) {
  test(name, () => {
    const got = findingsOf(diff);
    assert.deepStrictEqual(got, [], `the negative control fired:\n${JSON.stringify(got, null, 2)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
suite('the diff parser — findings are only as good as the line they name');

test('line numbers follow the NEW file across context, additions and removals', () => {
  const { files } = parseDiff(D(
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,4 +10,4 @@ function f() {',
    '  const a = 1;',
    '-  const b = 2;',
    '+  const b = 3;',
    '  return a + b;',
    ' }'
  ));
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].path, 'src/a.ts');
  const kinds = files[0].hunks[0].lines.map((l) => `${l.kind}${l.newLine}`);
  // The removed line reports the new-file cursor it was taken out of (11), which
  // is the only sane place to point at a deletion.
  assert.deepStrictEqual(kinds, [' 10', '-11', '+11', ' 12', ' 13']);
});

test('a hunk header without counts parses', () => {
  const { files, wellFormed } = parseDiff(D(
    '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-old', '+new'
  ));
  assert.strictEqual(wellFormed, true);
  assert.strictEqual(files[0].hunks[0].newStart, 1);
});

test('/dev/null on either side marks the file new or deleted', () => {
  const add = parseDiff(D('diff --git a/n b/n', '--- /dev/null', '+++ b/n', '@@ -0,0 +1 @@', '+x'));
  assert.strictEqual(add.files[0].isNew, true);
  const del = parseDiff(D('diff --git a/g b/g', '--- a/g', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'));
  assert.strictEqual(del.files[0].isDeleted, true);
  assert.strictEqual(del.files[0].path, 'g');
});

test('text that is not a diff is reported as not well formed', () => {
  assert.strictEqual(parseDiff('the build is green now\n').wellFormed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
suite('weakened assertion');

fires('a strict equality replaced by a truthiness check', D(
  'diff --git a/tests/unit/order.test.ts b/tests/unit/order.test.ts',
  '--- a/tests/unit/order.test.ts',
  '+++ b/tests/unit/order.test.ts',
  '@@ -40,6 +40,6 @@ describe(\'order total\', () => {',
  "   it('sums the line items', () => {",
  '     const total = sum(order);',
  '-    expect(total).toEqual(4200);',
  '+    expect(total).toBeTruthy();',
  '   });',
  ' });'
), { mode: 'weakened_assertion', file: 'tests/unit/order.test.ts', line: 42, text: 'toBeTruthy' });

silent('CONTROL — the same edit in reverse: a truthiness check made exact', D(
  'diff --git a/tests/unit/order.test.ts b/tests/unit/order.test.ts',
  '--- a/tests/unit/order.test.ts',
  '+++ b/tests/unit/order.test.ts',
  '@@ -40,6 +40,6 @@ describe(\'order total\', () => {',
  "   it('sums the line items', () => {",
  '     const total = sum(order);',
  '-    expect(total).toBeTruthy();',
  '+    expect(total).toEqual(4200);',
  '   });',
  ' });'
));

// The transition is the finding. Without this, every weak assertion anywhere in
// a diff would be reported, and the report would be a style opinion.
silent('CONTROL — a truthiness check in a brand-new test, with nothing strict removed', D(
  'diff --git a/tests/unit/order.test.ts b/tests/unit/order.test.ts',
  '--- a/tests/unit/order.test.ts',
  '+++ b/tests/unit/order.test.ts',
  "@@ -50,2 +50,5 @@ describe('order total', () => {",
  ' ',
  "+  it('returns something for an empty order', () => {",
  '+    expect(sum(empty)).toBeTruthy();',
  '+  });',
  ' });'
));

fires('an assertion over literals — the test cannot fail', D(
  'diff --git a/tests/unit/harness.test.cjs b/tests/unit/harness.test.cjs',
  '--- a/tests/unit/harness.test.cjs',
  '+++ b/tests/unit/harness.test.cjs',
  "@@ -12,2 +12,4 @@ suite('the harness');",
  " test('records a pass', () => {",
  '+  // the line below is the whole test',
  '+  expect(true).toBe(true);',
  ' });'
), { mode: 'weakened_assertion', file: 'tests/unit/harness.test.cjs', line: 14, reason: /cannot fail/ });

silent('CONTROL — the same matcher over a real value', D(
  'diff --git a/tests/unit/harness.test.cjs b/tests/unit/harness.test.cjs',
  '--- a/tests/unit/harness.test.cjs',
  '+++ b/tests/unit/harness.test.cjs',
  "@@ -12,2 +12,4 @@ suite('the harness');",
  " test('records a pass', () => {",
  "+  const result = harness.record('ok');",
  '+  expect(result).toBe(true);',
  ' });'
));

// ─────────────────────────────────────────────────────────────────────────────
suite('skip');

fires('a failing test registered as skipped', D(
  'diff --git a/tests/unit/auth.test.ts b/tests/unit/auth.test.ts',
  '--- a/tests/unit/auth.test.ts',
  '+++ b/tests/unit/auth.test.ts',
  "@@ -18,3 +18,3 @@ describe('token', () => {",
  ' ',
  "-  it('rejects an expired token', async () => {",
  "+  it.skip('rejects an expired token', async () => {",
  '     await expect(verify(expired)).rejects.toThrow();'
), { mode: 'skip', file: 'tests/unit/auth.test.ts', line: 19, text: 'it.skip' });

fires('focusing one test, which skips every other one in the file', D(
  'diff --git a/tests/unit/parser.test.ts b/tests/unit/parser.test.ts',
  '--- a/tests/unit/parser.test.ts',
  '+++ b/tests/unit/parser.test.ts',
  "@@ -7,2 +7,2 @@ describe('header parser', () => {",
  ' ',
  "-  it('parses the header', () => {",
  "+  it.only('parses the header', () => {"
), { mode: 'skip', file: 'tests/unit/parser.test.ts', line: 8, reason: /focus/ });

silent('CONTROL — a test deleted along with the feature it covered', D(
  'diff --git a/src/coupon.ts b/src/coupon.ts',
  'deleted file mode 100644',
  '--- a/src/coupon.ts',
  '+++ /dev/null',
  '@@ -1,7 +0,0 @@',
  '-export function applyCoupon(order: Order, code: string): Order {',
  '-  const coupon = lookup(code);',
  '-  if (!coupon) {',
  '-    throw new UnknownCoupon(code);',
  '-  }',
  '-  return { ...order, total: order.total - coupon.amount };',
  '-}',
  'diff --git a/tests/unit/coupon.test.ts b/tests/unit/coupon.test.ts',
  'deleted file mode 100644',
  '--- a/tests/unit/coupon.test.ts',
  '+++ /dev/null',
  '@@ -1,5 +0,0 @@',
  "-describe('applyCoupon', () => {",
  "-  it('subtracts the coupon amount', () => {",
  "-    expect(applyCoupon(order, 'TENOFF').total).toEqual(3200);",
  '-  });',
  '-});',
  'diff --git a/src/__snapshots__/coupon.test.ts.snap b/src/__snapshots__/coupon.test.ts.snap',
  'deleted file mode 100644',
  '--- a/src/__snapshots__/coupon.test.ts.snap',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-exports[`applyCoupon subtracts the coupon amount 1`] = `',
  '-{ "total": 3200 }',
  '-`;'
));

// ─────────────────────────────────────────────────────────────────────────────
suite('rewritten snapshot');

fires('a stored expectation rewritten to match the new output', D(
  'diff --git a/src/__snapshots__/render.test.ts.snap b/src/__snapshots__/render.test.ts.snap',
  '--- a/src/__snapshots__/render.test.ts.snap',
  '+++ b/src/__snapshots__/render.test.ts.snap',
  '@@ -3,4 +3,4 @@ exports[`renders the header 1`] = `',
  ' <header>',
  '-  <span>3 items</span>',
  '+  <span>0 items</span>',
  ' </header>',
  ' `;'
), { mode: 'rewritten_snapshot', file: 'src/__snapshots__/render.test.ts.snap', line: 4 });

silent('CONTROL — a NEW snapshot file, which is a new expectation and not a rewritten one', D(
  'diff --git a/src/__snapshots__/badge.test.ts.snap b/src/__snapshots__/badge.test.ts.snap',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/__snapshots__/badge.test.ts.snap',
  '@@ -0,0 +1,3 @@',
  '+exports[`renders the badge 1`] = `',
  '+<span class="badge">new</span>',
  '+`;'
));

fires('the test command switched to updating snapshots', D(
  'diff --git a/Makefile b/Makefile',
  '--- a/Makefile',
  '+++ b/Makefile',
  '@@ -169,2 +169,2 @@ test-unit:',
  ' test-render:',
  '-\tnpx vitest run render',
  '+\tnpx vitest run render --update-snapshots'
), { mode: 'rewritten_snapshot', file: 'Makefile', line: 170 });

// The short form is the one the control below is about, so it needs a positive
// of its own: without it, "curl -u stays silent" would be satisfied by a rule
// that never fires at all.
fires('the short `-u` form, next to a test runner', D(
  'diff --git a/package.json b/package.json',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -8,2 +8,2 @@',
  '   "scripts": {',
  '-    "test": "jest --ci",',
  '+    "test": "jest --ci -u"'
), { mode: 'rewritten_snapshot', file: 'package.json', line: 9, text: '-u' });

silent('CONTROL — `-u` that is curl\'s credentials flag, not a test runner\'s', D(
  'diff --git a/scripts/publish.sh b/scripts/publish.sh',
  '--- a/scripts/publish.sh',
  '+++ b/scripts/publish.sh',
  '@@ -12,2 +12,3 @@ publish() {',
  '   local url="$1"',
  '+  curl -sSf -u "$USER:$TOKEN" --upload-file "$artifact" "$url"',
  ' }'
));

fires('an inline snapshot rewritten in place', D(
  'diff --git a/tests/unit/render.test.ts b/tests/unit/render.test.ts',
  '--- a/tests/unit/render.test.ts',
  '+++ b/tests/unit/render.test.ts',
  "@@ -22,3 +22,3 @@ describe('render', () => {",
  "   it('renders the count', () => {",
  '-    expect(render(3)).toMatchInlineSnapshot(`<span>3 items</span>`);',
  '+    expect(render(3)).toMatchInlineSnapshot(`<span>0 items</span>`);',
  '   });'
), { mode: 'rewritten_snapshot', file: 'tests/unit/render.test.ts', line: 23 });

silent('CONTROL — an inline snapshot written for a brand-new test', D(
  'diff --git a/tests/unit/render.test.ts b/tests/unit/render.test.ts',
  '--- a/tests/unit/render.test.ts',
  '+++ b/tests/unit/render.test.ts',
  "@@ -30,2 +30,5 @@ describe('render', () => {",
  ' ',
  "+  it('renders an empty basket', () => {",
  '+    expect(render(0)).toMatchInlineSnapshot(`<span>0 items</span>`);',
  '+  });',
  ' });'
));

// ─────────────────────────────────────────────────────────────────────────────
suite('raised timeout');

fires('a test timeout raised around the assertion that was failing', D(
  'diff --git a/tests/e2e/checkout.ts b/tests/e2e/checkout.ts',
  '--- a/tests/e2e/checkout.ts',
  '+++ b/tests/e2e/checkout.ts',
  '@@ -14,2 +14,2 @@ export async function payAndWait(page: Page) {',
  "   await page.click('#pay');",
  "-  await page.waitForSelector('#receipt', { timeout: 5000 });",
  "+  await page.waitForSelector('#receipt', { timeout: 45000 });"
), { mode: 'raised_timeout', file: 'tests/e2e/checkout.ts', line: 15, reason: /5000 to 45000/ });

// The control differs from the positive in the FILENAME alone. Both sit under
// `tests/`, so the test-path rule admits both and only the config exclusion can
// keep this one quiet — which is what makes the exclusion load-bearing rather
// than shadowed by a broader rule.
silent('CONTROL — the same raise, in a config file', D(
  'diff --git a/tests/e2e/vitest.config.ts b/tests/e2e/vitest.config.ts',
  '--- a/tests/e2e/vitest.config.ts',
  '+++ b/tests/e2e/vitest.config.ts',
  '@@ -14,2 +14,2 @@ export default defineConfig({',
  '   test: {',
  '-    testTimeout: 5000,',
  '+    testTimeout: 45000,'
));

// A client timeout raised in production code is ordinary engineering; this
// detector is about what a run did to the MEASUREMENT.
silent('CONTROL — the same raise, in production code', D(
  'diff --git a/src/client.ts b/src/client.ts',
  '--- a/src/client.ts',
  '+++ b/src/client.ts',
  '@@ -14,2 +14,2 @@ export function makeClient(base: string) {',
  '   return new Client(base, {',
  '-    timeout: 5000,',
  '+    timeout: 45000,'
));

silent('CONTROL — a timeout on a brand-new wait, with none lowered away', D(
  'diff --git a/tests/e2e/refund.ts b/tests/e2e/refund.ts',
  '--- a/tests/e2e/refund.ts',
  '+++ b/tests/e2e/refund.ts',
  '@@ -8,2 +8,3 @@ export async function refundAndWait(page: Page) {',
  "   await page.click('#refund');",
  "+  await page.waitForSelector('#done', { timeout: 45000 });",
  ' }'
));

// ─────────────────────────────────────────────────────────────────────────────
suite('any / @ts-ignore');

fires('a type error silenced with a pragma', D(
  'diff --git a/src/api.ts b/src/api.ts',
  '--- a/src/api.ts',
  '+++ b/src/api.ts',
  '@@ -30,2 +30,3 @@ export async function load(url: string) {',
  '   const res = await fetch(url);',
  '+  // @ts-ignore',
  '   return res.json();'
), { mode: 'any_or_ts_ignore', file: 'src/api.ts', line: 31, text: '@ts-ignore' });

fires('a type widened to `any` until the checker stopped objecting', D(
  'diff --git a/src/api.ts b/src/api.ts',
  '--- a/src/api.ts',
  '+++ b/src/api.ts',
  '@@ -40,2 +40,2 @@ export async function parse(res: Response) {',
  '   const res = await fetch(url);',
  '-  const payload: Invoice = await res.json();',
  '+  const payload: any = await res.json();'
), { mode: 'any_or_ts_ignore', file: 'src/api.ts', line: 41, text: ': any' });

silent('CONTROL — `any` in a declaration file, which is how a declaration says "untyped upstream"', D(
  'diff --git a/types/vendor.d.ts b/types/vendor.d.ts',
  '--- a/types/vendor.d.ts',
  '+++ b/types/vendor.d.ts',
  "@@ -5,2 +5,3 @@ declare module 'legacy-sdk' {",
  '   export function connect(url: string): Client;',
  '+  export function raw(query: string): Promise<any>;',
  ' }'
));

// `type: any` is a legitimate declaration in a schema, and no type checker reads
// the file it lives in. Only the TypeScript gate keeps this one quiet — the prose
// exclusion below does not reach it.
silent('CONTROL — `type: any` in an API schema', D(
  'diff --git a/openapi/invoice.yaml b/openapi/invoice.yaml',
  '--- a/openapi/invoice.yaml',
  '+++ b/openapi/invoice.yaml',
  '@@ -30,2 +30,3 @@ components:',
  '     metadata:',
  '+      type: any',
  '       description: opaque passthrough'
));

// Found in the field, on this repository's own history: the ADR that specifies
// this detector lists every mode by name, and each mention was reported as an
// occurrence. A pragma in a document silences nothing — it is the subject.
silent('CONTROL — `any` and a pragma named in prose, in a file no checker reads', D(
  'diff --git a/docs/options.md b/docs/options.md',
  '--- a/docs/options.md',
  '+++ b/docs/options.md',
  '@@ -12,2 +12,4 @@',
  ' The reader accepts:',
  '+- `mode: any` of `strict`, `loose`, `off`',
  '+- never reach for `@ts-ignore` to get a red check green',
  ' '
));

// ─────────────────────────────────────────────────────────────────────────────
suite('swallowed catch');

fires('an error caught and discarded on one line', D(
  'diff --git a/src/flush.ts b/src/flush.ts',
  '--- a/src/flush.ts',
  '+++ b/src/flush.ts',
  '@@ -18,2 +18,2 @@ export async function flushAll(queue: Queue) {',
  '   for (const item of queue) {',
  '-    await flush(item);',
  '+    try { await flush(item); } catch (e) {}'
), { mode: 'swallowed_catch', file: 'src/flush.ts', line: 19, text: 'catch (e) {}' });

fires('a handler whose whole body is a log line', D(
  'diff --git a/src/flush.ts b/src/flush.ts',
  '--- a/src/flush.ts',
  '+++ b/src/flush.ts',
  '@@ -18,3 +18,7 @@ export async function flushAll(queue: Queue) {',
  '   for (const item of queue) {',
  '-    await flush(item);',
  '+    try {',
  '+      await flush(item);',
  '+    } catch (err) {',
  '+      console.error(err);',
  '+    }',
  '   }'
), { mode: 'swallowed_catch', file: 'src/flush.ts', line: 21, text: 'catch (err) {' });

silent('CONTROL — a handler that logs and rethrows', D(
  'diff --git a/src/flush.ts b/src/flush.ts',
  '--- a/src/flush.ts',
  '+++ b/src/flush.ts',
  '@@ -18,3 +18,8 @@ export async function flushAll(queue: Queue) {',
  '   for (const item of queue) {',
  '-    await flush(item);',
  '+    try {',
  '+      await flush(item);',
  '+    } catch (err) {',
  "+      logger.error({ err }, 'flush failed');",
  '+      throw err;',
  '+    }',
  '   }'
));

// Rule 3: what cannot be seen is not asserted. The rethrow may be on the first
// line after the hunk, and a false positive is the cheapest way to lose the
// reader's trust in every other finding in the report.
silent('CONTROL — a handler whose closing brace falls outside the hunk', D(
  'diff --git a/src/flush.ts b/src/flush.ts',
  '--- a/src/flush.ts',
  '+++ b/src/flush.ts',
  '@@ -18,1 +18,5 @@ export async function flushAll(queue: Queue) {',
  '   for (const item of queue) {',
  '+    try {',
  '+      await flush(item);',
  '+    } catch (err) {',
  '+      console.error(err);'
));

fires('the re-raise deleted from a handler that is still catching', D(
  'diff --git a/src/queue.ts b/src/queue.ts',
  '--- a/src/queue.ts',
  '+++ b/src/queue.ts',
  '@@ -30,4 +30,3 @@ export async function drain(queue: Queue) {',
  '   } catch (err) {',
  "     logger.error({ err }, 'drain failed');",
  '-    throw err;',
  '   }'
), { mode: 'swallowed_catch', file: 'src/queue.ts', line: 32, reason: /re-raise was removed/ });

silent('CONTROL — the same throw replaced by a richer one, not removed', D(
  'diff --git a/src/queue.ts b/src/queue.ts',
  '--- a/src/queue.ts',
  '+++ b/src/queue.ts',
  '@@ -30,4 +30,4 @@ export async function drain(queue: Queue) {',
  '   } catch (err) {',
  "     logger.error({ err }, 'drain failed');",
  '-    throw err;',
  "+    throw new DrainFailed('drain failed', { cause: err });",
  '   }'
));

fires('an `except` whose entire body is `pass`', D(
  'diff --git a/tools/sync.py b/tools/sync.py',
  '--- a/tools/sync.py',
  '+++ b/tools/sync.py',
  '@@ -20,2 +20,6 @@ def sync(records):',
  '     for batch in records:',
  '+        try:',
  '+            push(batch)',
  '+        except TransportError:',
  '+            pass',
  '     return True'
), { mode: 'swallowed_catch', file: 'tools/sync.py', line: 23, text: 'except TransportError:' });

silent('CONTROL — an `except` that logs and re-raises', D(
  'diff --git a/tools/sync.py b/tools/sync.py',
  '--- a/tools/sync.py',
  '+++ b/tools/sync.py',
  '@@ -20,2 +20,7 @@ def sync(records):',
  '     for batch in records:',
  '+        try:',
  '+            push(batch)',
  '+        except TransportError:',
  '+            log.warning("retrying %s", batch)',
  '+            raise',
  '     return True'
));

fires('a workflow step whose failure no longer fails the job', D(
  'diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml',
  '--- a/.github/workflows/test.yml',
  '+++ b/.github/workflows/test.yml',
  '@@ -40,2 +40,3 @@ jobs:',
  '       - name: make test-fast',
  '+        continue-on-error: true',
  '         run: make test-fast'
), { mode: 'swallowed_catch', file: '.github/workflows/test.yml', line: 41 });

silent('CONTROL — the same key set to false', D(
  'diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml',
  '--- a/.github/workflows/test.yml',
  '+++ b/.github/workflows/test.yml',
  '@@ -40,2 +40,3 @@ jobs:',
  '       - name: make test-fast',
  '+        continue-on-error: false',
  '         run: make test-fast'
));

silent('CONTROL — the same key quoted in documentation, where it runs nothing', D(
  'diff --git a/docs/ci-recipes.md b/docs/ci-recipes.md',
  '--- a/docs/ci-recipes.md',
  '+++ b/docs/ci-recipes.md',
  '@@ -20,2 +20,3 @@',
  ' Never do this to a required check:',
  '+        continue-on-error: true',
  ' '
));

fires('a test runner\'s exit code discarded with `|| true`', D(
  'diff --git a/scripts/ci.sh b/scripts/ci.sh',
  '--- a/scripts/ci.sh',
  '+++ b/scripts/ci.sh',
  '@@ -22,2 +22,2 @@ run_suite() {',
  '   echo "running the fast suite"',
  '-  make test-fast',
  '+  make test-fast || true'
), { mode: 'swallowed_catch', file: 'scripts/ci.sh', line: 23, text: '|| true' });

// `|| true` is ordinary on a cleanup line; firing there is how this detector
// would teach its reader to skim past it.
silent('CONTROL — `|| true` on a cleanup line that runs no tests', D(
  'diff --git a/scripts/ci.sh b/scripts/ci.sh',
  '--- a/scripts/ci.sh',
  '+++ b/scripts/ci.sh',
  '@@ -30,2 +30,3 @@ cleanup() {',
  '   echo "cleaning up"',
  '+  rm -rf "$SCRATCH/shipyard-build" || true',
  ' }'
));

// ─────────────────────────────────────────────────────────────────────────────
suite('narrowed matcher');

fires('an exact comparison replaced by a partial one', D(
  'diff --git a/tests/unit/invoice.test.ts b/tests/unit/invoice.test.ts',
  '--- a/tests/unit/invoice.test.ts',
  '+++ b/tests/unit/invoice.test.ts',
  "@@ -55,2 +55,2 @@ describe('invoice', () => {",
  "   it('returns the paid invoice', async () => {",
  "-    expect(res.body).toEqual({ id: 7, status: 'paid', total: 4200 });",
  "+    expect(res.body).toEqual(expect.objectContaining({ status: 'paid' }));"
), { mode: 'narrowed_matcher', file: 'tests/unit/invoice.test.ts', line: 56, text: 'objectContaining' });

silent('CONTROL — a partial matcher in a brand-new test, with nothing exact removed', D(
  'diff --git a/tests/unit/invoice.test.ts b/tests/unit/invoice.test.ts',
  '--- a/tests/unit/invoice.test.ts',
  '+++ b/tests/unit/invoice.test.ts',
  "@@ -60,2 +60,5 @@ describe('invoice', () => {",
  ' ',
  "+  it('reports the paid status', async () => {",
  "+    expect(res.body).toEqual(expect.objectContaining({ status: 'paid' }));",
  '+  });',
  ' });'
));

fires('a pattern loosened toward `.*`', D(
  'diff --git a/tests/unit/gate.test.cjs b/tests/unit/gate.test.cjs',
  '--- a/tests/unit/gate.test.cjs',
  '+++ b/tests/unit/gate.test.cjs',
  "@@ -18,2 +18,2 @@ test('the gate names the offending path', () => {",
  "   const r = run(GATE, proj, ['T-01-02']);",
  '-  assert.ok(/scope-gate: T-01-02 OK/.test(r.stdout));',
  '+  assert.ok(/scope-gate.*/.test(r.stdout));'
), { mode: 'narrowed_matcher', file: 'tests/unit/gate.test.cjs', line: 19, reason: /loosened/ });

silent('CONTROL — the same pattern tightened instead', D(
  'diff --git a/tests/unit/gate.test.cjs b/tests/unit/gate.test.cjs',
  '--- a/tests/unit/gate.test.cjs',
  '+++ b/tests/unit/gate.test.cjs',
  "@@ -18,2 +18,2 @@ test('the gate names the offending path', () => {",
  "   const r = run(GATE, proj, ['T-01-02']);",
  '-  assert.ok(/scope-gate.*/.test(r.stdout));',
  '+  assert.ok(/scope-gate: T-01-02 OK/.test(r.stdout));'
));

// A file PATH is a regex literal as far as any pattern is concerned — two
// slashes with text between them. Without the matching-context requirement on
// the removed line, an unrelated path edit arms the loosened-regex rule.
silent('CONTROL — a path with slashes on the removed line is not a tightened pattern', D(
  'diff --git a/tests/unit/gate.test.cjs b/tests/unit/gate.test.cjs',
  '--- a/tests/unit/gate.test.cjs',
  '+++ b/tests/unit/gate.test.cjs',
  "@@ -18,3 +18,3 @@ test('the gate reports the resolved base', () => {",
  "-  const SCRIPTS = 'plugins/delivery-pipeline/scripts';",
  "+  const SCRIPTS = path.join(ROOT, 'plugins/delivery-pipeline/scripts');",
  '   const r = run(SCRIPTS, proj, [\'T-01-02\']);',
  "-  assert.ok(r.stdout.includes('origin/epic'));",
  '+  assert.ok(/origin\\/epic.*/.test(r.stdout));'
));

// ─────────────────────────────────────────────────────────────────────────────
suite('the contract: it reports, and it never gates');

const writeDiff = (name, text) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, text);
  return p;
};
// SHIPYARD_GRAPH_DIR is cleared so the run is measured against the cwd, which is
// a temp dir with no .planning/ — the case the soft graph resolution exists for.
const cli = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: cwd || TMP, encoding: 'utf8', env: { ...process.env, SHIPYARD_GRAPH_DIR: '' },
});

const DIRTY = D(
  'diff --git a/tests/unit/order.test.ts b/tests/unit/order.test.ts',
  '--- a/tests/unit/order.test.ts',
  '+++ b/tests/unit/order.test.ts',
  '@@ -40,2 +40,2 @@',
  '     const total = sum(order);',
  '-    expect(total).toEqual(4200);',
  '+    expect(total).toBeTruthy();'
);
const CLEAN = D(
  'diff --git a/src/sum.ts b/src/sum.ts',
  '--- a/src/sum.ts',
  '+++ b/src/sum.ts',
  '@@ -3,2 +3,2 @@ export function sum(order: Order): number {',
  '   const lines = order.lines ?? [];',
  '-  return lines.reduce((a, l) => a + l.price, 0);',
  '+  return lines.reduce((a, l) => a + l.price * l.qty, 0);'
);
const dirtyPath = writeDiff('dirty.diff', DIRTY);
const cleanPath = writeDiff('clean.diff', CLEAN);

test('findings do NOT change the exit code — this is the whole of D7', () => {
  const withFindings = cli(['T-21-04', '--diff', dirtyPath]);
  const without = cli(['T-21-04', '--diff', cleanPath]);
  assert.strictEqual(withFindings.status, 0, withFindings.stdout + withFindings.stderr);
  assert.strictEqual(without.status, 0, without.stdout + without.stderr);
  assert.strictEqual(withFindings.status, without.status, 'the exit code must not carry the verdict');
  assert.ok(/weakened_assertion/.test(withFindings.stdout), withFindings.stdout);
  assert.ok(/clean/.test(without.stdout), without.stdout);
});

// Pinning the ABSENT behaviour, not merely the present one: ADR-001 D7 defers
// blocking until the false-positive rate is measured, so no flag may turn this
// report into a gate. If someone adds one, this test is what says no.
test('no flag turns the report into a gate', () => {
  for (const extra of [['--strict'], ['--fail-on', 'any'], ['--fail-on', '1']]) {
    const r = cli(['T-21-04', '--diff', dirtyPath, ...extra]);
    assert.strictEqual(r.status, 0, `${extra.join(' ')} changed the exit code:\n${r.stdout}${r.stderr}`);
  }
});

test('the usage text says so too, so the next reader does not add one', () => {
  const r = cli([]);
  assert.strictEqual(r.status, 2);
  assert.ok(/Exit 0 ALWAYS/.test(r.stderr), r.stderr);
  assert.ok(/Do NOT add --strict or --fail-on/.test(r.stderr), r.stderr);
});

test('--json carries the documented shape', () => {
  const r = cli(['T-21-04', '--diff', dirtyPath, '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(out).sort(), ['counts', 'findings', 'source', 'ticket']);
  assert.strictEqual(out.ticket, 'T-21-04');
  assert.ok(Array.isArray(out.findings));
  assert.deepStrictEqual(Object.keys(out.findings[0]).sort(), ['file', 'line', 'mode', 'reason', 'text']);
  assert.strictEqual(Number.isInteger(out.findings[0].line), true);
  // Every mode key is always present, so a consumer reads counts.skip without
  // first checking whether anything of that kind was found.
  assert.deepStrictEqual(Object.keys(out.counts).sort(), ['total', ...MODES].sort());
  assert.strictEqual(out.counts.total, out.findings.length);
  assert.strictEqual(out.counts.skip, 0);
  assert.strictEqual(out.counts.weakened_assertion, 1);
  // A missing graph is a missing label, never a failed run.
  assert.strictEqual(out.source.graph, null);
});

test('the seven enumerated modes, and no eighth', () => {
  assert.deepStrictEqual(MODES, [
    'weakened_assertion', 'skip', 'rewritten_snapshot', 'raised_timeout',
    'any_or_ts_ignore', 'swallowed_catch', 'narrowed_matcher',
  ]);
});

test('an empty diff is an answer, not a failure', () => {
  const r = cli(['T-21-04', '--diff', writeDiff('empty.diff', ''), '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).findings, []);
});

test('a malformed diff cannot run, and the message names the cause', () => {
  const r = cli(['T-21-04', '--diff', writeDiff('junk.txt', 'the suite is green now\n')]);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(/not a unified diff/.test(r.stderr), r.stderr);
  assert.ok(/junk\.txt/.test(r.stderr), 'the message names WHAT was measured');
});

test('a missing diff file cannot run, and the message names the cause', () => {
  const r = cli(['T-21-04', '--diff', path.join(TMP, 'nope.diff')]);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(/no such file/.test(r.stderr), r.stderr);
});

test('--base without --worktree cannot run', () => {
  const r = cli(['T-21-04', '--base', 'epic']);
  assert.strictEqual(r.status, 2);
  assert.ok(/--worktree/.test(r.stderr), r.stderr);
});

test('a value flag with no value does not swallow the next flag as its value', () => {
  // `--diff --json` used to read `--json` as the diff's FILENAME instead of
  // naming the mistake — Copilot caught this on PR #15. Same shape for `--base`
  // and `--worktree`: each needs a real value, never the next flag in line.
  for (const [name, extra] of [['diff', []], ['base', ['--worktree', TMP]], ['worktree', ['--base', 'epic']]]) {
    const r = cli(['T-21-04', `--${name}`, '--json', ...extra]);
    assert.strictEqual(r.status, 2, `--${name} --json should refuse to run:\n${r.stdout}${r.stderr}`);
    assert.ok(new RegExp(`--${name} needs a value`).test(r.stderr), r.stderr);
  }
});

test('a flag-first invocation does not make a flag value the ticket', () => {
  const r = cli(['--diff', dirtyPath, 'T-21-04', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).ticket, 'T-21-04');
});

test('--base measures the branch against the base, and prints the ref it measured', () => {
  const repo = path.join(TMP, 'repo');
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  git('config', 'user.email', 't@e');
  git('config', 'user.name', 'T');
  const testFile = path.join(repo, 'tests', 'order.test.ts');
  fs.writeFileSync(testFile, 'it("sums", () => {\n  expect(total).toEqual(4200);\n});\n');
  git('add', '.'); git('commit', '-qm', 'init');
  git('branch', '-q', 'epic');
  git('checkout', '-qb', 'ticket');
  fs.writeFileSync(testFile, 'it("sums", () => {\n  expect(total).toBeTruthy();\n});\n');
  git('commit', '-qam', 'weaken');

  const r = cli(['T-21-04', '--base', 'epic', '--worktree', repo, '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.source.base, 'epic', 'the resolved ref is reported, never silently substituted');
  assert.strictEqual(out.counts.weakened_assertion, 1, r.stdout);
  assert.strictEqual(out.findings[0].file, 'tests/order.test.ts');
  assert.strictEqual(out.findings[0].line, 2);

  const text = cli(['T-21-04', '--base', 'epic', '--worktree', repo]);
  assert.ok(/epic\.\.\.HEAD/.test(text.stdout), text.stdout);
});

done();
