'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const shards = require('./shard-files.cjs');

suite('unit-test sharding');

const root = path.resolve(__dirname, '../..');
const files = shards.unitFiles();
const weights = shards.readWeights();
const integrationOwner = 'phase49-incremental-integration.test.cjs';
const integrationTasks = [1, 2, 3, 4, 5, 6].map(number => integrationOwner + '#integration-partition=' + number);
const expectedTasks = [...files.filter(file => file !== integrationOwner), ...integrationTasks].sort();

test('every unit-test file is in exactly one shard, for any shard count', () => {
  assert.ok(files.length > 100);
  for (let count = 1; count <= 8; count++) {
    const seen = shards.assign(files, weights, count).flatMap((shard) => shard.files);
    assert.deepEqual([...seen].sort(), [...files].sort(), `count ${count}`);
    assert.equal(new Set(seen).size, seen.length, `count ${count}: no file twice`);
  }
});

test('the split is deterministic and does not depend on the order files are listed in', () => {
  const first = shards.assign(files, weights, 4);
  assert.deepEqual(shards.assign([...files].reverse(), weights, 4), first);
  assert.deepEqual(shards.assign(files, weights, 4), first);
});

test('shards are balanced to within the weight of the heaviest single file', () => {
  const weightOf = (name) => (Number.isFinite(weights[name]) && weights[name] > 0 ? weights[name] : shards.DEFAULT_WEIGHT);
  const heaviest = Math.max(...files.map(weightOf));
  const totals = shards.assign(files, weights, 4).map((shard) => shard.total);
  assert.ok(Math.max(...totals) - Math.min(...totals) <= heaviest, `spread ${totals.join(', ')} > ${heaviest}`);
});

test('a file with no recorded weight is still assigned, not skipped', () => {
  const split = shards.assign([...files, 'brand-new.test.cjs'], weights, 4).flatMap((shard) => shard.files);
  assert.ok(split.includes('brand-new.test.cjs'));
});

test('the weight table names only existing ordinary owners or the six integration tasks in seconds', () => {
  const stale = Object.keys(weights).filter((name) => !expectedTasks.includes(name));
  assert.deepEqual(stale, [], 'remove stale entries from tests/unit/shard-weights.json');
  assert.ok(!Object.hasOwn(weights, integrationOwner));
  assert.deepEqual(integrationTasks.map(task => weights[task]), [1597.8, 1318.2, 1369.2, 1368, 1368, 1368.6]);
  for (const [name, seconds] of Object.entries(weights)) {
    assert.ok(Number.isFinite(seconds) && seconds > 0, `${name} weight must be a positive number`);
  }
});

test('virtual integration tasks expand before assignment with complete disjoint coverage for every supported count', () => {
  assert.deepEqual(shards.unitTasks(files), expectedTasks);
  assert.deepEqual(shards.unitTasks([...files].reverse()), expectedTasks);
  assert.deepEqual(shards.unitTasks(['ordinary.test.cjs']), ['ordinary.test.cjs']);
  for (let count = 1; count <= 8; count++) {
    const selections = Array.from({ length: count }, (_, index) => shards.selectTaskShard(`${index + 1}/${count}`));
    const selected = selections.flat();
    assert.deepEqual([...selected].sort(), expectedTasks, `count ${count}`);
    assert.equal(new Set(selected).size, expectedTasks.length);
    assert.equal(selected.filter(task => task === 'integration-test-partitions.test.cjs').length, 1);
    assert.ok(!selected.includes(integrationOwner));
    assert.deepEqual(selections, shards.assign(expectedTasks, weights, count).map(shard => shard.files));
  }
  const split = shards.assign(shards.unitTasks([...files, 'brand-new.test.cjs']), weights, 6);
  assert.equal(split.flatMap(shard => shard.files).filter(task => task === 'brand-new.test.cjs').length, 1);
  assert.deepEqual(shards.assign(integrationTasks, {}, 6).map(shard => shard.files), integrationTasks.map(task => [task]));
  assert.deepEqual(shards.assign([...integrationTasks].reverse(), {}, 6), shards.assign(integrationTasks, {}, 6));
});

test('task decoding refuses malformed virtual tasks without changing the physical file API', () => {
  assert.deepEqual(shards.parseTask('ordinary.test.cjs'), { file: 'ordinary.test.cjs', partition: null });
  for (const [index, task] of integrationTasks.entries())
    assert.deepEqual(shards.parseTask(task), { file: integrationOwner, partition: index + 1 });
  for (const task of [integrationOwner + '#integration-partition=0', integrationOwner + '#integration-partition=7',
    integrationOwner + '#integration-partition=01', integrationOwner + '#integration-partition=1.0',
    integrationOwner + '#integration-partition=', integrationOwner + '#unknown=1',
    integrationTasks[0] + '#integration-partition=2', 'other.test.cjs#integration-partition=1',
    '../ordinary.test.cjs', 'unknown']) assert.throws(() => shards.parseTask(task), /task/, task);
  for (const task of [...integrationTasks, 'other.test.cjs#unknown=1'])
    assert.throws(() => shards.unitTasks([task]), /task/, task);
  for (const spec of ['7/6', '0/6', 'unknown']) assert.throws(() => shards.selectTaskShard(spec), /shard/);
  assert.deepEqual(shards.selectShard('1/1'), files);
});

test('a malformed or out-of-range shard is refused', () => {
  for (const spec of ['', '0/4', '5/4', '1/0', 'a/b', '1-4', '1/4/4', '-1/4']) {
    assert.throws(() => shards.parseSpec(spec), /shard/, spec);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'shard-files.cjs'), spec], { encoding: 'utf8' });
    assert.equal(result.status, 2, spec);
  }
  assert.deepEqual(shards.parseSpec('2/4'), { index: 2, count: 4 });
});

test('the CLI prints one repository-relative path per file of the shard', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'shard-files.cjs'), '3/4'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const printed = result.stdout.trim().split('\n');
  assert.deepEqual(printed, shards.selectShard('3/4').map((name) => `tests/unit/${name}`));
  assert.ok(printed.every((file) => fs.existsSync(path.join(root, file))));
});

test('CI runs as many unit shards as the workflow matrix declares', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
  const matrix = /shard:\s*\[([^\]]+)\]/.exec(workflow);
  assert.ok(matrix, 'the unit job declares a shard matrix');
  const declared = matrix[1].split(',').map((item) => Number(item.trim()));
  assert.deepEqual(declared, [1, 2, 3, 4, 5, 6], 'matrix is exactly six shards');
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /timeout-minutes: 90/);
  for (const pattern of [/UNIT_SHARD:\s*\$\{\{ matrix\.shard \}\}\/(\d+)/, /unit \(shard \$\{\{ matrix\.shard \}\}\/(\d+)\)/, /unit tests, shard \$\{\{ matrix\.shard \}\}\/(\d+)/]) {
    const found = pattern.exec(workflow);
    assert.ok(found, `${pattern} is present`);
    assert.equal(Number(found[1]), declared.length, 'denominator equals the number of matrix shards');
  }
});

test('the test-fast job is the single result and waits for every part', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
  assert.match(workflow, /\n {2}test-fast:\n {4}needs: \[unit, rest\]\n {4}if: always\(\)/);
  assert.match(workflow, /run: make test-fast-rest/);
  assert.ok(workflow.includes('UNIT: ${{ needs.unit.result }}'));
  assert.ok(workflow.includes('REST: ${{ needs.rest.result }}'));
  assert.ok(workflow.includes('[ "$UNIT" = "success" ] && [ "$REST" = "success" ]'));
  const makefile = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
  assert.match(makefile, /^test-fast: test-unit \$\(TEST_FAST_REST\)$/m);
  assert.match(makefile, /^test-fast-rest: \$\(TEST_FAST_REST\)$/m);
});

test('the runner refuses a malformed worker count before running anything', () => {
  for (const workers of ['0', '-2', 'many', '2.5']) {
    const result = spawnSync('bash', [path.join(__dirname, 'run.sh')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, UNIT_WORKERS: workers },
    });
    assert.equal(result.status, 2, workers);
    assert.match(result.stdout + result.stderr, /UNIT_WORKERS must be a positive integer or auto/);
  }
});

done();
