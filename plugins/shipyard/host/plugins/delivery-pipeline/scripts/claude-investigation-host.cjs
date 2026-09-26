'use strict';

const {
  registerClaudeWorkflowHost,
  WORKFLOW_SCRIPTS,
} = require('./claude-workflow-host.cjs');
const { createClaudeDeliveryHost, runClaudeDeliveryCli } = require('./claude-delivery-host.cjs');
const { formatHint } = require('./refusal-hints.cjs');

const INVESTIGATION_RESEARCH_SCRIPT = WORKFLOW_SCRIPTS['investigation-research'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function registerInvestigationWorkflowHost(options = {}) {
  const registered = registerClaudeWorkflowHost(options);
  return Object.freeze({
    run(args) {
      if (!isObject(args)) {
        const error = new Error('claude-investigation-host: workflow args must be an object');
        error.code = 'INVALID_HOST';
        throw error;
      }
      return registered.run('investigation-research', { args });
    },
  });
}

function runInvestigationResearch(options = {}) {
  if (!isObject(options)) {
    const error = new Error('claude-investigation-host: options must be an object');
    error.code = 'INVALID_HOST';
    throw error;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'scriptPath')) {
    const error = new Error('claude-investigation-host: scriptPath is fixed to the research workflow');
    error.code = 'INVALID_HOST';
    throw error;
  }
  const { args, ...hostOptions } = options;
  return registerInvestigationWorkflowHost(hostOptions).run(args);
}

function runInvestigationResearchCli(argv = process.argv.slice(2), stdout = process.stdout) {
  if (!Array.isArray(argv) || argv[0] !== '--request-file' || argv.length !== 2) {
    const error = new Error('claude-investigation-host: --request-file <json> is required');
    error.code = 'INVALID_HOST';
    throw error;
  }
  return runClaudeDeliveryCli(['--workflow', 'investigation-research', ...argv], stdout);
}

module.exports = Object.freeze({
  INVESTIGATION_RESEARCH_SCRIPT,
  registerInvestigationWorkflowHost,
  runInvestigationResearchCli,
  runInvestigationResearch,
  runInvestigationRuntime(options = {}) {
    if (!isObject(options) || !isObject(options.args)) {
      const error = new Error('claude-investigation-host: runtime args must be an object');
      error.code = 'INVALID_HOST';
      throw error;
    }
    return createClaudeDeliveryHost(options).run('investigation-research', options.args);
  },
});

if (require.main === module) {
  Promise.resolve().then(runInvestigationResearchCli).catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.stderr.write(`${formatHint(error && error.code)}\n`);
    process.exitCode = 1;
  });
}
