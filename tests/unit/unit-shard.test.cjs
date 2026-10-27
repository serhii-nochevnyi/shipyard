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
    const selections = shards.assign(expectedTasks, weights, count).map(shard => shard.files);
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

test('frozen shards cover all tasks and preserve existing shards when new tests arrive', () => {
  const baseline = shards.readManifest();
  const manifest = shards.appendShard(baseline, expectedTasks);
  assert.deepEqual(manifest.shards.slice(0, baseline.shards.length), baseline.shards);
  assert.ok(manifest.shards.length >= 16);
  const seen = manifest.shards.flat();
  assert.deepEqual([...seen].sort(), expectedTasks);
  assert.equal(new Set(seen).size, seen.length);
  for (let index = 0; index < manifest.shards.length; index++)
    assert.deepEqual(shards.selectTaskShard(`${index + 1}/${manifest.shards.length}`), manifest.shards[index]);
  const added = [...expectedTasks, 'brand-new.test.cjs', 'brand-new-two.test.cjs'];
  assert.throws(() => shards.validateManifest(manifest, added), /unassigned tests/);
  const extended = shards.appendShard(manifest, added);
  assert.deepEqual(extended.shards.slice(0, manifest.shards.length), manifest.shards);
  assert.deepEqual(extended.shards.slice(manifest.shards.length), [['brand-new-two.test.cjs'], ['brand-new.test.cjs']]);
  assert.deepEqual(shards.appendShard(extended, added), extended);
  const further = shards.appendShard(extended, [...added, 'another-new.test.cjs']);
  assert.deepEqual(further.shards.slice(0, extended.shards.length), extended.shards);
  assert.deepEqual(further.shards[extended.shards.length], ['another-new.test.cjs']);
  assert.throws(() => shards.validateManifest({ ...manifest, shards: [...manifest.shards, [seen[0]]] }, expectedTasks), /duplicate/);
  assert.throws(() => shards.validateManifest(manifest, expectedTasks.slice(1)), /stale/);
  assert.throws(() => shards.selectTaskShard('1/6'), /count must match/);
});

test('the CLI isolates new tests automatically and can freeze them without moving existing tasks', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'unit-shard-cli-'));
  try {
    const script = path.join(directory, 'shard-files.cjs');
    fs.copyFileSync(path.join(__dirname, 'shard-files.cjs'), script);
    const baseline = { version: 1, shards: Array.from({ length: 16 }, (_, i) => [`fixture-${i}.test.cjs`]) };
    for (const file of baseline.shards.flat()) fs.writeFileSync(path.join(directory, file), '');
    const manifestPath = path.join(directory, 'shard-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(baseline));
    const run = arg => spawnSync(process.execPath, [script, arg], { encoding: 'utf8' });
    assert.equal(run('--matrix').status, 0);
    fs.writeFileSync(path.join(directory, 'new.test.cjs'), '');
    const automatic = run('--matrix');
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.equal(JSON.parse(automatic.stdout).shard.length, 17);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), baseline);
    fs.writeFileSync(path.join(directory, 'another-new.test.cjs'), '');
    assert.equal(JSON.parse(run('--matrix').stdout).shard.length, 18);
    assert.deepEqual(shards.selectTaskShard('17/18', directory, baseline), ['another-new.test.cjs']);
    assert.deepEqual(shards.selectTaskShard('18/18', directory, baseline), ['new.test.cjs']);
    const tasks = shards.unitTasks(shards.unitFiles(directory));
    const selected = Array.from({ length: 18 }, (_, i) => shards.selectTaskShard(`${i + 1}/18`, directory, baseline)).flat();
    assert.deepEqual(selected.sort(), tasks);
    assert.equal(new Set(selected).size, tasks.length);
    assert.throws(() => shards.selectTaskShard('1/16', directory, baseline), /count must match/);
    assert.equal(run('--append').status, 0);
    const extended = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(extended.shards, [...baseline.shards, ['another-new.test.cjs'], ['new.test.cjs']]);
    assert.equal(JSON.parse(run('--matrix').stdout).shard.length, 18);
    const saved = fs.readFileSync(manifestPath, 'utf8');
    assert.equal(run('--append').status, 0);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), saved);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CI derives its matrix from the validated manifest', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'shard-files.cjs'), '--matrix'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = shards.appendShard(shards.readManifest(), expectedTasks);
  assert.deepEqual(JSON.parse(result.stdout), { shard: manifest.shards.map((_, i) => `${i + 1}/${manifest.shards.length}`) });
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
  assert.ok(workflow.includes('matrix: ${{ fromJSON(needs.shards.outputs.matrix) }}'));
  assert.ok(workflow.includes('node tests/unit/shard-files.cjs --matrix'));
  assert.ok(workflow.includes('UNIT_SHARD: ${{ matrix.shard }}'));
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /timeout-minutes: 90/);
});

test('the test-fast job is the single result and waits for every part', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
  assert.match(workflow, /\n {2}test-fast:\n {4}needs: \[shards, unit, rest\]\n {4}if: always\(\)/);
  assert.match(workflow, /run: make test-fast-rest/);
  assert.ok(workflow.includes('UNIT: ${{ needs.unit.result }}'));
  assert.ok(workflow.includes('REST: ${{ needs.rest.result }}'));
  assert.ok(workflow.includes('[ "$SHARDS" = "success" ] && [ "$UNIT" = "success" ] && [ "$REST" = "success" ]'));
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
