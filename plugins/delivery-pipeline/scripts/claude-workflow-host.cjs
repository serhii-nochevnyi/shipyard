'use strict';

// Production host binding for the Workflow DSL. Workflow scripts deliberately
// have no import surface, so the host must inject the typed dispatch factory as
// a sixth binding. The serializable `args` object is data only; capabilities,
// the durable recorder, and application evidence stay in this closure.
const fs = require('node:fs');
const path = require('node:path');
const { createClaudeWorkflowDispatch } = require('./claude-dispatch-adapter.cjs');
const { GSD_LAUNCH_MECHANISM, isDurableRecorder } = require('./dispatch-boundary.cjs');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WORKFLOW_PARAMETERS = ['agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch'];
const WORKFLOW_SCRIPTS = Object.freeze({
  'drift-gate': path.join(__dirname, '..', 'workflows', 'drift-gate.mjs'),
  executors: path.join(__dirname, '..', 'workflows', 'executors.mjs'),
  'fix-round': path.join(__dirname, '..', 'workflows', 'fix-round.mjs'),
  'investigation-research': path.join(__dirname, '..', 'workflows', 'investigation-research.mjs'),
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reject(message) {
  const error = new Error(`claude-workflow-host: ${message}`);
  error.code = 'INVALID_HOST';
  throw error;
}

function durableRecorder(value) {
  return isDurableRecorder(value);
}

function hostResource(options, name) {
  const host = options.host;
  if (host !== undefined && !object(host)) reject('host must be an object');
  return host && host[name] !== undefined ? host[name] : options[name];
}

function registeredHostOptions(options) {
  return Object.freeze({
    agent: options.agent,
    parallel: options.parallel,
    phase: options.phase,
    log: options.log,
    capabilities: hostResource(options, 'capabilities'),
    recorder: hostResource(options, 'recorder'),
    applicationEvidence: hostResource(options, 'applicationEvidence'),
    typedGsdCallback: hostResource(options, 'typedGsdCallback'),
  });
}

// Native Workflow has no module-import surface. This is the executable host
// registration used by the command adapters: native callbacks are registered
// once, workflow names are pinned to shipped DSL files, and only serializable
// `args` may vary per run. Keeping the callback/resource closure here is what
// makes the sixth binding available on the actual production path rather than
// only in a unit-test AsyncFunction constructor.
function registerClaudeWorkflowHost(options = {}) {
  if (!object(options)) reject('options must be an object');
  if (typeof options.agent !== 'function') reject('agent is required');
  if (typeof options.parallel !== 'function') reject('parallel is required');
  const hostOptions = registeredHostOptions(options);
  // Fail at registration, before a command can advertise a runnable Workflow,
  // if the host cannot satisfy the boundary's durable-evidence contract.
  createClaudeWorkflowDispatchBridge(hostOptions);
  return Object.freeze({
    run(name, runOptions = {}) {
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(WORKFLOW_SCRIPTS, name)) {
        reject(`unknown registered workflow ${JSON.stringify(name)}`);
      }
      if (!object(runOptions)) reject('workflow run options must be an object');
      if (Object.prototype.hasOwnProperty.call(runOptions, 'scriptPath')) {
        reject('registered workflow owns scriptPath');
      }
      for (const key of [
        'agent', 'parallel', 'phase', 'log', 'capabilities', 'recorder',
        'applicationEvidence', 'typedGsdCallback', 'host',
      ]) {
        if (Object.prototype.hasOwnProperty.call(runOptions, key)) {
          reject(`registered host owns ${key}`);
        }
      }
      return runClaudeWorkflow({
        ...hostOptions,
        ...(Object.prototype.hasOwnProperty.call(runOptions, 'args')
          ? { args: runOptions.args }
          : {}),
        scriptPath: WORKFLOW_SCRIPTS[name],
      });
    },
  });
}

function cliReject(message) {
  const error = new Error(`claude-workflow-host: ${message}`);
  error.code = 'INVALID_HOST';
  throw error;
}

function parseCliArguments(argv) {
  if (!Array.isArray(argv)) cliReject('CLI arguments must be an array');
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--workflow', '--args-file', '--host-module'].includes(flag)) {
      cliReject(`unknown CLI argument ${JSON.stringify(flag)}`);
    }
    const value = argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      cliReject(`${flag} requires a value`);
    }
    if (values[flag] !== undefined) cliReject(`${flag} may be provided only once`);
    values[flag] = value;
  }
  for (const flag of ['--workflow', '--args-file', '--host-module']) {
    if (values[flag] === undefined) cliReject(`${flag} is required`);
  }
  if (!Object.prototype.hasOwnProperty.call(WORKFLOW_SCRIPTS, values['--workflow'])) {
    cliReject(`unknown registered workflow ${JSON.stringify(values['--workflow'])}`);
  }
  return Object.freeze({
    workflow: values['--workflow'],
    argsFile: values['--args-file'],
    hostModule: values['--host-module'],
  });
}

function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    cliReject(`cannot read ${label} ${JSON.stringify(filePath)}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    cliReject(`${label} ${JSON.stringify(filePath)} is not valid JSON: ${error.message}`);
  }
}

function loadHostModule(modulePath) {
  let loaded;
  try {
    loaded = require(path.resolve(modulePath));
  } catch (error) {
    cliReject(`cannot load host module ${JSON.stringify(modulePath)}: ${error.message}`);
  }
  if (!object(loaded)) cliReject('host module must export an object of host-owned callbacks and resources');
  return loaded;
}

// Executable bridge for runtimes that cannot import CommonJS from the native
// Workflow tool. The request file contains only serializable workflow args;
// the host module is the non-serializable production side that owns native
// callbacks, capabilities, the durable recorder, and application evidence.
async function runClaudeWorkflowCli(argv = process.argv.slice(2), stdout = process.stdout, runner) {
  const parsed = parseCliArguments(argv);
  const args = readJsonFile(parsed.argsFile, 'args file');
  const host = loadHostModule(parsed.hostModule);
  const result = typeof runner === 'function'
    ? await runner(host, args)
    : await registerClaudeWorkflowHost(host).run(parsed.workflow, { args });
  if (!stdout || typeof stdout.write !== 'function') cliReject('stdout must provide write()');
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

function createClaudeWorkflowDispatchBridge(options = {}) {
  if (!object(options)) reject('options must be an object');
  for (const name of ['agent', 'parallel']) {
    if (typeof options[name] !== 'function') reject(`${name} is required`);
  }
  const capabilities = hostResource(options, 'capabilities');
  const recorder = hostResource(options, 'recorder');
  const applicationEvidence = hostResource(options, 'applicationEvidence');
  const typedGsdCallback = hostResource(options, 'typedGsdCallback');
  if (!object(capabilities)) reject('explicit host capabilities are required');
  if (!durableRecorder(recorder)) reject('a frozen durable receipt recorder is required');
  if (typeof applicationEvidence !== 'function') reject('host application evidence is required');
  if (typedGsdCallback !== undefined && typeof typedGsdCallback !== 'function') {
    reject('typedGsdCallback must be a function when provided');
  }

  // These are the only resources the workflow bridge can trust. A workflow's
  // JSON args may contain same-named values for compatibility, but they cannot
  // replace this host-owned closure.
  const verifiedApplicationEvidence = function verifiedApplicationEvidence(input = {}) {
    let evidence;
    try {
      evidence = applicationEvidence.call(options.host || options, input);
    } catch (error) {
      throw error;
    }
    const context = input && input.context;
    if (context && context.gsd_role !== undefined
        && (!object(evidence)
          || evidence.gsd_role !== context.gsd_role
          || evidence.gsd_launch_mechanism !== GSD_LAUNCH_MECHANISM)) {
      reject(`host application evidence must attest ${context.gsd_role} through ${GSD_LAUNCH_MECHANISM}`);
    }
    return evidence;
  };
  const host = Object.freeze({
    capabilities,
    recorder,
    applicationEvidence: verifiedApplicationEvidence,
    ...(typedGsdCallback ? { typedGsdCallback } : {}),
  });
  return Object.freeze((dispatchOptions = {}) => {
    if (!object(dispatchOptions)) reject('dispatch options must be an object');
    return createClaudeWorkflowDispatch({
      ...dispatchOptions,
      agent: options.agent,
      host,
    });
  });
}

async function runClaudeWorkflow(options = {}) {
  if (!object(options)) reject('options must be an object');
  if (typeof options.scriptPath !== 'string' || !options.scriptPath.trim()) {
    reject('scriptPath is required');
  }
  let source;
  try {
    source = fs.readFileSync(options.scriptPath, 'utf8');
  } catch (error) {
    reject(`cannot read scriptPath ${JSON.stringify(options.scriptPath)}: ${error.message}`);
  }
  // The native Workflow host wraps the DSL body in an async function and
  // treats the metadata export as a declaration. Mirror that exact production
  // boundary rather than handing the body to a generic Node evaluator.
  source = source.replace(/^export const meta/m, 'const meta');
  const workflow = new AsyncFunction(...WORKFLOW_PARAMETERS, source);
  const bridge = createClaudeWorkflowDispatchBridge(options);
  return workflow(
    options.agent,
    options.parallel,
    typeof options.phase === 'function' ? options.phase : () => {},
    typeof options.log === 'function' ? options.log : () => {},
    options.args,
    bridge,
  );
}

module.exports = Object.freeze({
  createClaudeWorkflowDispatchBridge,
  registerClaudeWorkflowHost,
  runClaudeWorkflow,
  runClaudeWorkflowCli,
  WORKFLOW_SCRIPTS,
});

if (require.main === module) {
  runClaudeWorkflowCli().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
