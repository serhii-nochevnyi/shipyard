#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeAtomic } = require('./lock.cjs');

const RUNTIMES = Object.freeze(['claude', 'codex']);
const REQUIRED_STAGES = Object.freeze(['research', 'decompose', 'executor', 'publish', 'sentinel']);
const DAY_MS = 24 * 60 * 60 * 1000;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

function liveStateDir(options = {}) {
  return options.stateDir || process.env.SHIPYARD_LIVE_STATE_DIR
    || path.join(os.homedir(), '.local', 'state', 'shipyard', 'live');
}

function segment(name, value) {
  if (typeof value !== 'string' || !SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`live-receipt: ${name} must be a safe path segment`);
  }
  return value;
}

function receiptPath({ version, tree_sha: treeSha, runtime }, options = {}) {
  if (!RUNTIMES.includes(runtime)) throw new Error(`live-receipt: runtime must be one of ${RUNTIMES.join(', ')}`);
  return path.join(liveStateDir(options), segment('version', version), segment('tree_sha', treeSha), `${runtime}.json`);
}

function rungKey(rung) {
  if (!rung || typeof rung !== 'object') return null;
  return JSON.stringify({ model: rung.model ?? null, effort: rung.effort ?? null });
}

function receiptFailures(receipt) {
  const reasons = [];
  const stages = Array.isArray(receipt && receipt.stages) ? receipt.stages : [];
  for (const required of REQUIRED_STAGES) {
    if (!stages.some((stage) => stage && stage.stage === required)) reasons.push(`missing stage ${required}`);
  }
  for (const stage of stages) {
    const name = stage && stage.stage;
    if (!stage || stage.ok !== true) reasons.push(`stage ${name} not ok`);
    else if (REQUIRED_STAGES.includes(name)
      && (rungKey(stage.requested) === null || rungKey(stage.requested) !== rungKey(stage.applied))) {
      reasons.push(`stage ${name} applied rung differs from requested`);
    }
  }
  return reasons;
}

function write(input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const stages = Array.isArray(input.stages) ? input.stages : [];
  const receipt = {
    schema: 'shipyard.live-receipt/v1',
    version: input.version,
    tree_sha: input.tree_sha,
    head_sha: input.head_sha || null,
    runtime: input.runtime,
    cli_version: input.cli_version || null,
    written_at: now.toISOString(),
    stages,
  };
  receipt.ok = receiptFailures(receipt).length === 0;
  const file = receiptPath(receipt, options);
  writeAtomic(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return { path: file, ok: receipt.ok };
}

function check(input, options = {}) {
  const runtimes = Array.isArray(input.runtimes) ? input.runtimes : RUNTIMES;
  const maxAgeDays = Number.isFinite(input.maxAgeDays) ? input.maxAgeDays : 7;
  const now = input.now instanceof Date ? input.now.getTime() : Number(input.now || Date.now());
  const missing = [];
  const stale = [];
  const failed = [];
  for (const runtime of runtimes) {
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath({ ...input, runtime }, options), 'utf8'));
    } catch {
      missing.push(runtime);
      continue;
    }
    if (receipt.version !== input.version || receipt.tree_sha !== input.tree_sha || receipt.runtime !== runtime) {
      missing.push(runtime);
      continue;
    }
    const writtenAt = Date.parse(receipt.written_at);
    if (!Number.isFinite(writtenAt) || now - writtenAt > maxAgeDays * DAY_MS) {
      stale.push(runtime);
      continue;
    }
    const reasons = receiptFailures(receipt);
    if (reasons.length) failed.push({ runtime, reasons });
  }
  return { ok: !missing.length && !stale.length && !failed.length, missing, stale, failed };
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === 'write') {
    const stagesFile = flag(rest, '--stages-file');
    const stages = stagesFile
      ? fs.readFileSync(stagesFile, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
      : [];
    const result = write({
      version: flag(rest, '--version'), tree_sha: flag(rest, '--tree-sha'), head_sha: flag(rest, '--head-sha'),
      runtime: flag(rest, '--runtime'), cli_version: flag(rest, '--cli-version'), stages,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === 'check') {
    const runtimes = flag(rest, '--runtimes');
    const maxAgeDays = Number(flag(rest, '--max-age-days'));
    const result = check({
      version: flag(rest, '--version'), tree_sha: flag(rest, '--tree-sha'),
      runtimes: runtimes ? runtimes.split(',') : RUNTIMES,
      maxAgeDays: Number.isFinite(maxAgeDays) ? maxAgeDays : 7,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  process.stderr.write('usage: live-receipt.cjs write --version <v> --tree-sha <t> --runtime <r> [--head-sha <h>] [--cli-version <c>] [--stages-file <jsonl>]\n'
    + '   or: live-receipt.cjs check --version <v> --tree-sha <t> [--runtimes claude,codex] [--max-age-days 7]\n');
  return 2;
}

module.exports = Object.freeze({ RUNTIMES, REQUIRED_STAGES, liveStateDir, receiptPath, receiptFailures, write, check });

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
