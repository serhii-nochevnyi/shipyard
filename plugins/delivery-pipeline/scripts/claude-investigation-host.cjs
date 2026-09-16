'use strict';

// Production entry point for /shipyard:investigate. Keep the workflow path
// owned by the command adapter so callers cannot silently substitute a
// different DSL script while still claiming to run the research contract.
const {
  registerClaudeWorkflowHost,
  runClaudeWorkflowCli,
  WORKFLOW_SCRIPTS,
} = require('./claude-workflow-host.cjs');

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
  return runClaudeWorkflowCli(
    ['--workflow', 'investigation-research', ...argv],
    stdout,
    (host, args) => runInvestigationResearch({ ...host, args }),
  );
}

module.exports = Object.freeze({
  INVESTIGATION_RESEARCH_SCRIPT,
  registerInvestigationWorkflowHost,
  runInvestigationResearchCli,
  runInvestigationResearch,
});

if (require.main === module) {
  runInvestigationResearchCli().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
