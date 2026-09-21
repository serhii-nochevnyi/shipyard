'use strict';

// Production host binding for the Workflow DSL. Workflow scripts deliberately
// have no import surface, so the host must inject the typed dispatch factory as
// a sixth binding. The serializable `args` object is data only; capabilities,
// the durable recorder, and application evidence stay in this closure.
const fs = require('node:fs');
const path = require('node:path');
const { createClaudeWorkflowDispatch } = require('./claude-dispatch-adapter.cjs');
const { GSD_LAUNCH_MECHANISM, isDurableRecorder } = require('./dispatch-boundary.cjs');
const { isOwnerCapability, withSessionHandoff } = require('./session-handoff.cjs');
const roleArtifact = require('./role-artifact.cjs');

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

function handoffResource(options) {
  for (const name of ['handoff', 'sessionHandoff', 'ownerCapability', 'owner']) {
    const value = hostResource(options, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hostResource(options, name) {
  const host = options.host;
  if (host !== undefined && !object(host)) reject('host must be an object');
  return host && host[name] !== undefined ? host[name] : options[name];
}

function scopedContext(scope, context) {
  if (scope === undefined) return context;
  if (!object(scope)) reject('runScope must be an object');
  if (context !== undefined && !object(context)) reject('workflow context must be an object');
  const result = { ...(context || {}) };
  for (const field of ['run_id', 'ticket', 'runtime', 'provider']) {
    if (scope[field] === undefined) continue;
    if (result[field] !== undefined && result[field] !== scope[field]) {
      reject(`workflow context contradicts host-owned ${field}`);
    }
    result[field] = scope[field];
  }
  const phase = object(scope.phase) ? scope.phase.phase || scope.phase.id : scope.phase;
  if (phase !== undefined) {
    if (result.phase !== undefined && result.phase !== phase) reject('workflow context contradicts host-owned phase');
    result.phase = phase;
  }
  const worktree = object(scope.worktree) ? scope.worktree.path || scope.worktree.worktree : scope.worktree;
  if (worktree !== undefined) {
    if (result.worktreePath !== undefined && result.worktreePath !== worktree) {
      reject('workflow context contradicts host-owned worktree');
    }
    result.worktreePath = worktree;
  }
  for (const key of ['runScope', 'run_scope', 'authority', 'owner', 'session']) {
    if (Object.prototype.hasOwnProperty.call(result, key)) reject(`workflow context cannot carry ${key}`);
  }
  return Object.freeze(result);
}

function registeredHostOptions(options) {
  return Object.freeze({
    agent: options.agent,
    parallel: options.parallel,
    phase: options.phase,
    log: options.log,
    capabilities: hostResource(options, 'capabilities'),
    recorder: hostResource(options, 'recorder'),
    capacity: hostResource(options, 'capacity'),
    handoff: handoffResource(options),
    applicationEvidence: hostResource(options, 'applicationEvidence'),
    typedGsdCallback: hostResource(options, 'typedGsdCallback'),
    artifactConsumer: hostResource(options, 'artifactConsumer'),
    artifactPreparer: hostResource(options, 'artifactPreparer'),
    runScope: hostResource(options, 'runScope'),
    controller: hostResource(options, 'controller'),
    runId: hostResource(options, 'runId') || hostResource(options, 'run_id'),
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
        'artifactConsumer', 'artifactPreparer', 'handoff', 'sessionHandoff',
        'ownerCapability', 'owner', 'capacity', 'runScope', 'run_scope', 'controller',
        'runId', 'run_id',
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
  const capacity = hostResource(options, 'capacity');
  const handoff = handoffResource(options);
  const applicationEvidence = hostResource(options, 'applicationEvidence');
  const typedGsdCallback = hostResource(options, 'typedGsdCallback');
  const configuredArtifactConsumer = hostResource(options, 'artifactConsumer');
  const configuredArtifactPreparer = hostResource(options, 'artifactPreparer');
  const runScope = hostResource(options, 'runScope');
  const controller = hostResource(options, 'controller');
  const runId = hostResource(options, 'runId') || hostResource(options, 'run_id')
    || (runScope && runScope.run_id);
  if (!object(capabilities)) reject('explicit host capabilities are required');
  if (!durableRecorder(recorder)) reject('a frozen durable receipt recorder is required');
  if (handoff !== undefined && !isOwnerCapability(handoff)) {
    reject('handoff must be a host-held acknowledged session capability');
  }
  if (typeof applicationEvidence !== 'function') reject('host application evidence is required');
  if (typedGsdCallback !== undefined && typeof typedGsdCallback !== 'function') {
    reject('typedGsdCallback must be a function when provided');
  }
  if (configuredArtifactConsumer !== undefined && typeof configuredArtifactConsumer !== 'function') {
    reject('artifactConsumer must be a function when provided');
  }
  if (configuredArtifactPreparer !== undefined && typeof configuredArtifactPreparer !== 'function') {
    reject('artifactPreparer must be a function when provided');
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
  // The Workflow DSL may provide only serializable artifact metadata. This
  // closure owns the filesystem and recorder, so an agent cannot choose the
  // expected dispatch, revision, digest, or receipt used for acceptance.
  const artifactConsumer = configuredArtifactConsumer || function trustedArtifactConsumer(input = {}) {
    if (!object(input.artifact)) reject('workflow artifact metadata must be an object');
    if (!object(input.record) || !object(input.record.receipt)) reject('workflow artifact consumer requires the finalized receipt');
    return roleArtifact.seal({
      ...input.artifact,
      result: input.result,
      recorder,
      dispatchId: input.record.receipt.dispatch_id,
    });
  };
  const artifactPreparer = configuredArtifactPreparer || function trustedArtifactPreparer(input = {}) {
    if (!object(input.artifact)) reject('workflow artifact preparation requires artifact metadata');
    if (['ci-fix', 'review-fix', 'drift-check'].includes(input.artifact.role)) {
      return roleArtifact.prepareRoleArtifact(input.artifact);
    }
    return null;
  };
  const host = Object.freeze({
    capabilities,
    recorder,
    ...(capacity !== undefined ? { capacity } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    applicationEvidence: verifiedApplicationEvidence,
    artifactConsumer,
    artifactPreparer,
    ...(typedGsdCallback ? { typedGsdCallback } : {}),
  });
  return Object.freeze((dispatchOptions = {}) => {
    if (!object(dispatchOptions)) reject('dispatch options must be an object');
    if (controller && typeof controller.assertOwner === 'function') {
      if (typeof runId !== 'string' || !runId.trim()) reject('controller-owned host requires runId');
      controller.assertOwner(runId);
    }
    const context = scopedContext(runScope, dispatchOptions.context);
    return createClaudeWorkflowDispatch({
      ...dispatchOptions,
      agent: options.agent,
      host,
      ...(context === undefined ? {} : { context }),
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
  const execute = () => workflow(
    options.agent,
    options.parallel,
    typeof options.phase === 'function' ? options.phase : () => {},
    typeof options.log === 'function' ? options.log : () => {},
    options.args,
    bridge,
  );
  const handoff = handoffResource(options);
  return handoff === undefined ? execute() : withSessionHandoff(handoff, execute);
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
