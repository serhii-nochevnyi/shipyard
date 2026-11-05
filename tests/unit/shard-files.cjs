'use strict';

// @invariant: every file is in exactly one shard, and the same files and weights always give the same split.

const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY = __dirname;
const WEIGHTS_FILE = path.join(DIRECTORY, 'shard-weights.json');
const DEFAULT_WEIGHT = 5;
const MANIFEST_FILE = path.join(DIRECTORY, 'shard-manifest.json');
const INTEGRATION_OWNER = 'phase49-incremental-integration.test.cjs';

function parseSpec(spec) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(spec));
  if (!match) throw new Error(`shard must look like 2/4, got ${JSON.stringify(spec)}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) throw new Error(`shard ${index} is outside 1..${count}`);
  return { index, count };
}

function unitFiles(directory = DIRECTORY) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.test.cjs')).sort();
}

function parseTask(task) {
  const match = /^(phase49-incremental-integration\.test\.cjs)#integration-partition=([1-6])$/.exec(task);
  if (match) return { file: match[1], partition: Number(match[2]) };
  if (typeof task === 'string' && /^[a-zA-Z0-9_-]+\.test\.cjs$/.test(task))
    return { file: task, partition: null };
  throw new Error(`invalid unit task ${JSON.stringify(task)}`);
}

function unitTasks(files) {
  return files.flatMap(file => {
    if (parseTask(file).partition !== null) throw new Error(`expected physical unit task ${JSON.stringify(file)}`);
    return file === INTEGRATION_OWNER
      ? [1, 2, 3, 4, 5, 6].map(partition => `${file}#integration-partition=${partition}`) : [file];
  }).sort();
}

function readWeights(file = WEIGHTS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// @invariant: every file lands in exactly one of the `count` shards; same input, same output.
function assign(files, weights, count) {
  const weightOf = (name) => (Number.isFinite(weights[name]) && weights[name] > 0 ? weights[name] : DEFAULT_WEIGHT);
  const shards = Array.from({ length: count }, () => ({ total: 0, files: [] }));
  const ordered = [...files].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : 1));
  for (const name of ordered) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.total < lightest.total) lightest = shard;
    lightest.files.push(name);
    lightest.total += weightOf(name);
  }
  return shards.map((shard) => ({ total: shard.total, files: shard.files.sort() }));
}

function selectShard(spec, directory = DIRECTORY, weights = readWeights()) {
  const { index, count } = parseSpec(spec);
  return assign(unitFiles(directory), weights, count)[index - 1].files;
}

function readManifest(file = MANIFEST_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateManifest(manifest, tasks) {
  if (manifest.version !== 1 || !Array.isArray(manifest.shards) || manifest.shards.length < 16)
    throw new Error('shard manifest must contain at least 16 shards (version 1)');
  const seen = new Set();
  const available = new Set(tasks);
  for (const shard of manifest.shards) {
    if (!Array.isArray(shard) || shard.length === 0) throw new Error('empty shard in manifest');
    for (const task of shard) {
      parseTask(task);
      if (seen.has(task)) throw new Error(`duplicate shard task: ${task}`);
      if (!available.has(task)) throw new Error(`stale shard task: ${task}`);
      seen.add(task);
    }
  }
  const missing = tasks.filter(task => !seen.has(task));
  if (missing.length) throw new Error(`unassigned tests: ${missing.join(', ')}; run node tests/unit/shard-files.cjs --append`);
  return manifest;
}

function selectTaskShard(spec, directory = DIRECTORY, manifest = readManifest()) {
  const { index, count } = parseSpec(spec);
  manifest = appendShard(manifest, unitTasks(unitFiles(directory)));
  if (count !== manifest.shards.length) throw new Error(`shard count must match manifest (${manifest.shards.length})`);
  return [...manifest.shards[index - 1]];
}

function appendShard(manifest, tasks) {
  const existing = new Set(manifest.shards.flat());
  const added = tasks.filter(task => !existing.has(task)).sort();
  const next = { ...manifest, shards: [...manifest.shards.map(shard => [...shard]), ...added.map(task => [task])] };
  return validateManifest(next, tasks);
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--append') {
      const manifest = appendShard(readManifest(), unitTasks(unitFiles()));
      fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
      process.stdout.write(`Registered ${manifest.shards.length} shards\n`);
    } else if (process.argv[2] === '--matrix') {
      const manifest = appendShard(readManifest(), unitTasks(unitFiles()));
      const count = manifest.shards.length;
      process.stdout.write(JSON.stringify({ shard: manifest.shards.map((_, index) => `${index + 1}/${count}`) }) + '\n');
    } else {
      for (const name of selectShard(process.argv[2])) process.stdout.write(`tests/unit/${name}\n`);
    }
  } catch (error) {
    process.stderr.write(`shard-files: ${error.message}\n`);
    process.exit(2);
  }
}

module.exports = { DEFAULT_WEIGHT, appendShard, readManifest, validateManifest, assign, parseSpec, parseTask, readWeights, selectShard, selectTaskShard, unitFiles, unitTasks };
