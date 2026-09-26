#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_PROMPT = 'Reply with the single word OK and take no other action.';
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

function fail(message) {
  const error = new Error(message);
  error.code = 'CAPTURE_BOUNDARY_FIXTURES';
  throw error;
}

function replacePathPrefixes(input) {
  return input
    .replace(/\/(?:private\/)?var\/folders\/[^\s"'\\]*/g, '<TMP>')
    .replace(/\/tmp\/[^\s"'\\]*/g, '<TMP>')
    .replace(/\/(?:private\/)?(?:Users|home)\/[^/\s"'\\]+/g, '<HOME>');
}

function replaceTokens(input) {
  return input
    .replace(/(Bearer\s+)\S+/gi, '$1<TOKEN>')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '<TOKEN>')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '<TOKEN>')
    .replace(/\bsess-[A-Za-z0-9_-]{10,}\b/g, '<TOKEN>')
    .replace(/(["']?(?:api[_-]?key|apikey|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1<TOKEN>');
}

function replaceSessionIds(input, context) {
  const map = context.sessionIds || (context.sessionIds = new Map());
  return input.replace(UUID_RE, (match) => {
    const key = match.toLowerCase();
    if (!map.has(key)) map.set(key, `<SESSION-${map.size + 1}>`);
    return map.get(key);
  });
}

function replaceExtraPaths(input, context) {
  const extra = Array.isArray(context.paths) ? context.paths : [];
  const map = context.pathIds || (context.pathIds = new Map());
  let out = input;
  for (const candidate of extra) {
    if (typeof candidate !== 'string' || !candidate.trim() || !out.includes(candidate)) continue;
    if (!map.has(candidate)) map.set(candidate, `<PATH-${map.size + 1}>`);
    out = out.split(candidate).join(map.get(candidate));
  }
  return out;
}

function scrub(text, context = {}) {
  if (typeof text !== 'string') fail('scrub input must be text');
  let out = text;
  if (typeof context.homeDir === 'string' && context.homeDir) out = out.split(context.homeDir).join('<HOME>');
  if (typeof context.tmpDir === 'string' && context.tmpDir) out = out.split(context.tmpDir).join('<TMP>');
  out = replaceExtraPaths(out, context);
  out = replacePathPrefixes(out);
  out = replaceTokens(out);
  out = replaceSessionIds(out, context);
  return out;
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be non-empty text`);
  return value.trim();
}

function provenanceLine(meta = {}) {
  return JSON.stringify({
    shipyard_fixture: {
      boundary: requireText(meta.boundary, 'boundary'),
      cli: requireText(meta.cli, 'cli'),
      cli_version: requireText(meta.cli_version, 'cli_version'),
      captured_at: meta.captured_at ? requireText(meta.captured_at, 'captured_at') : new Date().toISOString(),
      scrubbed: true,
    },
  });
}

function locateNativeChildFile(codexHome, parentSessionId, now = new Date()) {
  const root = path.join(path.resolve(codexHome), 'sessions');
  const matches = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    const directory = path.join(root, String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    let names;
    try { names = fs.readdirSync(directory); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(directory, name);
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const first = raw.slice(0, raw.indexOf('\n') < 0 ? raw.length : raw.indexOf('\n'));
      let record;
      try { record = JSON.parse(first); } catch { continue; }
      if (record.type === 'session_meta' && record.payload && record.payload.parent_thread_id === parentSessionId) {
        matches.push(raw);
      }
    }
  }
  if (matches.length !== 1) fail(`could not uniquely locate the native child session for ${parentSessionId}`);
  return matches[0];
}

async function runClaudeStream({ scratchDir, transcriptDir }) {
  const host = require('../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const { CLAUDE_MODEL_ALIASES } = require('../plugins/delivery-pipeline/scripts/runtime-adapters.cjs');
  const probe = host.probeClaudeRuntime({});
  if (probe.status !== 'available') fail(`Claude CLI is not available for a live capture: ${probe.reason}`);
  const launcher = host.createClaudeCliLauncher({
    scope: { run_id: `capture-${Date.now()}`, ticket: 'capture', phase: 1, worktree: scratchDir, runtime: 'claude', provider: 'anthropic' },
    executable: probe.executable,
    transcriptDir,
  });
  const result = await launcher(CAPTURE_PROMPT, { model: CLAUDE_MODEL_ALIASES.fable, effort: 'low' });
  if (!result.transcript) fail('Claude launch produced no transcript to capture');
  const raw = fs.readFileSync(result.transcript.path, 'utf8');
  return { cliVersion: probe.runtime_version, outputs: [{ suffix: null, raw }] };
}

async function runCodexAgentStream({ scratchDir, transcriptDir, variant }) {
  const host = require('../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const { CODEX_MODEL_IDS } = require('../plugins/delivery-pipeline/scripts/runtime-adapters.cjs');
  const capabilities = { supportedModels: Object.values(CODEX_MODEL_IDS), supportedEfforts: [...host.EFFORTS] };
  const probe = host.probeCodexRuntime({ capabilities });
  if (probe.status !== 'available') fail(`Codex CLI is not available for a live capture: ${probe.reason}`);
  const scope = { run_id: `capture-${Date.now()}`, ticket: 'capture', phase: 1, worktree: scratchDir, runtime: 'codex', provider: 'openai' };
  const launcher = host.createCodexCliLauncher({ scope, executable: probe.executable, capabilities, transcriptDir });
  const needsChild = variant === 'child' || variant === 'parent' || !variant;
  const launchOptions = { model: CODEX_MODEL_IDS.luna, effort: 'low', sandbox_mode: 'workspace-write' };
  if (needsChild) launchOptions.gsd_role = 'gsd-plan-checker';
  const result = await launcher(CAPTURE_PROMPT, launchOptions);
  if (variant === 'exec') {
    if (!result.runtime_evidence.transcript) fail('Codex exec launch produced no transcript to capture');
    const raw = fs.readFileSync(result.runtime_evidence.transcript.path, 'utf8');
    return { cliVersion: probe.runtime_version, outputs: [{ suffix: 'exec', raw }] };
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const parentCandidates = host.nativeSessionCandidates(path.join(codexHome, 'sessions'), result.session_id);
  if (parentCandidates.length !== 1) fail(`could not uniquely locate the native parent session for ${result.session_id}`);
  const parentRaw = fs.readFileSync(parentCandidates[0], 'utf8');
  const outputs = [];
  if (variant === 'parent') {
    outputs.push({ suffix: 'parent', raw: parentRaw });
  } else if (variant === 'child') {
    outputs.push({ suffix: 'child', raw: locateNativeChildFile(codexHome, result.session_id) });
  } else {
    outputs.push({ suffix: 'parent', raw: parentRaw }, { suffix: 'child', raw: locateNativeChildFile(codexHome, result.session_id) });
  }
  return { cliVersion: probe.runtime_version, outputs };
}

const BOUNDARIES = Object.freeze({
  'claude-stream': { cli: 'claude', run: runClaudeStream },
  'codex-agent-stream': { cli: 'codex', run: runCodexAgentStream },
});

function parseArgs(argv) {
  const args = { outDir: 'tests/fixtures/captured' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--boundary') args.boundary = argv[++i];
    else if (flag === '--variant') args.variant = argv[++i];
    else if (flag === '--out-dir') args.outDir = argv[++i];
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--input') args.input = argv[++i];
    else fail(`unknown argument ${flag}`);
  }
  if (!args.boundary || !Object.prototype.hasOwnProperty.call(BOUNDARIES, args.boundary)) {
    fail(`--boundary must be one of: ${Object.keys(BOUNDARIES).join(', ')}`);
  }
  if (args.dryRun && !args.input) fail('--dry-run requires --input <file>');
  return args;
}

function writeFixture(outDir, name, raw, meta, context) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.jsonl`);
  const scrubbed = scrub(raw, context);
  fs.writeFileSync(file, `${provenanceLine(meta)}\n${scrubbed}`);
  process.stdout.write(`wrote ${file}\n`);
  return file;
}

async function main(argv) {
  const args = parseArgs(argv);
  const boundary = BOUNDARIES[args.boundary];
  const outDir = path.resolve(args.outDir);
  const context = {};
  const baseName = args.boundary + (args.variant ? `-${args.variant}` : '');

  if (args.dryRun) {
    const raw = fs.readFileSync(path.resolve(args.input), 'utf8');
    writeFixture(outDir, baseName, raw, {
      boundary: args.boundary, cli: boundary.cli, cli_version: 'dry-run',
    }, context);
    return;
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-capture-'));
  const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-capture-transcript-'));
  try {
    const { cliVersion, outputs } = await boundary.run({ scratchDir, transcriptDir, variant: args.variant });
    const written = [];
    for (const output of outputs) {
      const name = args.boundary + (output.suffix ? `-${output.suffix}` : (args.variant ? `-${args.variant}` : ''));
      written.push(writeFixture(outDir, name, output.raw, {
        boundary: args.boundary, cli: boundary.cli, cli_version: cliVersion,
      }, context));
    }
    process.stdout.write(`registry entry: update tests/fixtures/captured/boundaries/${args.boundary}.json fixtures with: ${written.join(', ')}\n`);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`capture-boundary-fixtures: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { scrub, provenanceLine };
