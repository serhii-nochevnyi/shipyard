#!/usr/bin/env node
'use strict';

// Resolve every role through the authoritative configuration bridge. Selection
// is a preflight result, not proof of launch; callers launch through the dispatch
// boundary with createCodexDispatchAdapter and a native host implementation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pc = require('./pipeline-config.cjs');
const boundary = require('./dispatch-boundary.cjs');
const policy = require('./model-policy.cjs');
const { createCodexDispatchAdapter, REPAIR } = require('./codex-dispatch-adapter.cjs');
const { readProjectConfig, validateCodexConfiguration } = require('./codex-model-remap.cjs');

const ROLE_ALIASES = Object.freeze({ 'inv-research': 'research' });

function fail(message, code = 'INVALID_INPUT') {
  throw policy.policyError(code, message + '. ' + REPAIR);
}
function expandHome(value) {
  if (value === '~') return os.homedir();
  return value && value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  const booleans = new Set(['contested', 'checkpoint', 'critical', 'json']);
  const values = new Set([
    'agent-dir', 'project-dir', 'capabilities-file', 'risk', 'type', 'complexity',
    'input-tokens', 'signature-state', 'dispatch-id',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (!booleans.has(name) && !values.has(name)) fail('unknown option --' + name);
    if (flags.has(name)) fail('--' + name + ' given more than once');
    if (booleans.has(name)) { flags.set(name, true); continue; }
    const value = argv[++index];
    if (value === undefined || String(value).startsWith('--') || String(value).trim() === '') fail('--' + name + ' needs a value');
    flags.set(name, String(value));
  }
  return { flags, positionals };
}
function signalsFrom(flags) {
  const signals = {};
  for (const [flag, key] of [
    ['risk', 'risk'], ['type', 'type'], ['complexity', 'complexity'],
    ['input-tokens', 'inputTokens'], ['signature-state', 'signatureState'],
    ['contested', 'contested'], ['checkpoint', 'checkpoint'], ['critical', 'critical'],
  ]) {
    if (flags.has(flag)) signals[key] = flags.get(flag);
  }
  return policy.normalizeSignals(signals);
}
function projectDirFrom(flags) {
  return path.resolve(expandHome(flags.get('project-dir')) || process.cwd());
}
function agentDirFrom(flags, env = process.env) {
  return path.resolve(expandHome(flags.get('agent-dir'))
    || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'agents'));
}
function readCapabilities(file) {
  if (!file) fail('provide current host capabilities using --capabilities-file (supportedModels and supportedEfforts)', 'UNSUPPORTED_SELECTION');
  try { return JSON.parse(fs.readFileSync(path.resolve(expandHome(file)), 'utf8')); }
  catch (error) { fail('cannot read host capabilities: ' + error.message, 'UNSUPPORTED_SELECTION'); }
}

function selectAgentInternal(role, options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const flags = options.flags || new Map();
  const env = options.env || process.env;
  if (options.runtime !== undefined && options.runtime !== 'codex') fail('Codex selector cannot launch another runtime');
  const loaded = pc.loadConfig(cwd, { runtime: 'codex', env, routed: true });
  const capabilities = options.capabilities || options.host?.capabilities
    || readCapabilities(options.capabilitiesFile || flags.get('capabilities-file'));
  const resolution = pc.resolveDispatch({
    ...options, config: loaded.config, runtime: 'codex',
    role: ROLE_ALIASES[role] || role, signals: options.signals || {},
    dispatch_id: options.dispatch_id === undefined ? boundary.newDispatchId() : options.dispatch_id,
  });
  validateCodexConfiguration(resolution, readProjectConfig(cwd, loaded.file), capabilities);
  const agentsDir = path.resolve(options.agentDir || agentDirFrom(flags, env));
  const adapter = createCodexDispatchAdapter({ agentsDir, agentManifest: options.agentManifest, capabilities });
  boundary.validateDispatch(resolution, { adapters: { codex: adapter } });
  const evidence = resolution.agent_file ? adapter.validateGeneratedAgent(resolution) : null;
  return Object.freeze({
    ...resolution, project_dir: cwd,
    agent_path: resolution.agent_file ? path.join(agentsDir, resolution.agent_file) : null,
    ...(evidence ? { agent_file_digest: evidence.agent_file_digest } : {}),
  });
}

function selectAgent(role, options = {}) {
  try { return selectAgentInternal(role, options); }
  catch (error) {
    if (!error.message.includes(REPAIR)) error.message += '. ' + REPAIR;
    throw error;
  }
}

function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (positionals.length !== 2 || positionals[0] !== 'select') {
    fail('usage: codex-agent.cjs select <role> --capabilities-file <json> [--json] [--project-dir <project>] [--agent-dir <dir>] [canonical signals]');
  }
  const result = selectAgent(positionals[1], {
    flags, cwd: projectDirFrom(flags), signals: signalsFrom(flags),
    agentDir: agentDirFrom(flags), dispatch_id: flags.get('dispatch-id'),
  });
  // Plain output must also carry both dynamic launch arguments. A model alone
  // would invite the caller to omit reasoning effort.
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = Object.freeze({ selectAgent, parseArgs, signalsFrom, projectDirFrom, ROLE_ALIASES });
if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write('codex-agent: ' + error.message + '\n');
    process.exitCode = error.exitCode || 1;
  }
}
