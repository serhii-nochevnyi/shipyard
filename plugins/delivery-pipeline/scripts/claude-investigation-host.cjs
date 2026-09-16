'use strict';

// Production entry point for /shipyard:investigate. Keep the workflow path
// owned by the command adapter so callers cannot silently substitute a
// different DSL script while still claiming to run the research contract.
const path = require('node:path');
const { runClaudeWorkflow } = require('./claude-workflow-host.cjs');

const INVESTIGATION_RESEARCH_SCRIPT = path.join(
  __dirname,
  '..',
  'workflows',
  'investigation-research.mjs',
);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  return runClaudeWorkflow({
    ...options,
    scriptPath: INVESTIGATION_RESEARCH_SCRIPT,
  });
}

module.exports = Object.freeze({
  INVESTIGATION_RESEARCH_SCRIPT,
  runInvestigationResearch,
});
