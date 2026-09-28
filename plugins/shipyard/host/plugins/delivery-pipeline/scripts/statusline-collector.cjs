'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { buildEnvelope, CLAUDE_WINDOW_MINUTES } = require('./subscription-observation.cjs');
const store = require('./subscription-store.cjs');

const MAX_INPUT_BYTES = 1048576;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// @security: only allow-listed rate_limits fields reach an envelope; the rest of the input is never copied.
function parseStatusline(json, context = {}) {
  const ctx = object(context) ? context : {};
  const envelopes = [];
  if (!object(json) || !object(json.rate_limits)) return envelopes;
  const label = typeof ctx.accountLabel === 'string' && ctx.accountLabel ? ctx.accountLabel : null;
  const observedAt = typeof ctx.observedAt === 'string' ? ctx.observedAt : new Date().toISOString();
  for (const [bucketId, windowValue] of Object.entries(json.rate_limits)) {
    if (!object(windowValue)) continue;
    const used = windowValue.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    envelopes.push(buildEnvelope({
      source: 'claude-statusline',
      account_label: label,
      attribution: label ? 'declared' : 'unattributed',
      bucket_id: bucketId,
      window_minutes: Object.prototype.hasOwnProperty.call(CLAUDE_WINDOW_MINUTES, bucketId)
        ? CLAUDE_WINDOW_MINUTES[bucketId] : null,
      resets_at: Number.isSafeInteger(windowValue.resets_at) ? windowValue.resets_at : null,
      used_percent: used,
      observed_at: observedAt,
      freshness: 'observed',
      concurrency: 'unknown',
    }));
  }
  return envelopes;
}

function collect(buffer, home, options = {}) {
  const opts = object(options) ? options : {};
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_INPUT_BYTES) return [];
  const json = JSON.parse(buffer.toString('utf8'));
  const stateRoot = opts.stateRoot;
  const label = store.readLabel({ runtime: 'claude', home, stateRoot });
  const envelopes = parseStatusline(json, { accountLabel: label, observedAt: new Date(opts.now || Date.now()).toISOString() });
  return envelopes.map((envelope) => store.append(envelope, { runtime: 'claude', stateRoot, now: opts.now }));
}

function readStdin() {
  const chunks = [];
  const chunk = Buffer.alloc(65536);
  for (;;) {
    let read;
    try { read = fs.readSync(0, chunk, 0, chunk.length, null); }
    catch (error) {
      if (error && error.code === 'EAGAIN') continue;
      if (error && error.code === 'EOF') break;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, read)));
  }
  return Buffer.concat(chunks);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--home') args.home = argv[++i];
    else if (flag === '--previous-b64') args.previous = argv[++i];
    else if (flag === '--state-root') args.stateRoot = argv[++i];
  }
  return args;
}

function wrap(argv) {
  const args = parseArgs(argv);
  let input = Buffer.alloc(0);
  try { input = readStdin(); } catch {}
  const previous = Buffer.from(args.previous || '', 'base64').toString('utf8');
  const result = spawnSync('/bin/sh', ['-c', previous], {
    input, stdio: ['pipe', 'inherit', 'inherit'], env: process.env, maxBuffer: Infinity,
  });
  try { collect(input, args.home, { stateRoot: args.stateRoot }); } catch {}
  if (result.error) process.exit(127);
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(typeof result.status === 'number' ? result.status : 127);
}

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'wrap') wrap(rest);
  else process.exit(2);
}

module.exports = Object.freeze({ MAX_INPUT_BYTES, parseStatusline, collect });
