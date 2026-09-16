'use strict';

// Production host binding for the Workflow DSL. Workflow scripts deliberately
// have no import surface, so the host must inject the typed dispatch factory as
// a sixth binding. The serializable `args` object is data only; capabilities,
// the durable recorder, and application evidence stay in this closure.
const fs = require('node:fs');
const { createClaudeWorkflowDispatch } = require('./claude-dispatch-adapter.cjs');
const { isDurableRecorder } = require('./dispatch-boundary.cjs');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WORKFLOW_PARAMETERS = ['agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch'];

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
  const host = Object.freeze({
    capabilities,
    recorder,
    applicationEvidence,
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
  runClaudeWorkflow,
});
