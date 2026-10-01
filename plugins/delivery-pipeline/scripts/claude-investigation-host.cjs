'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  registerClaudeWorkflowHost,
  WORKFLOW_SCRIPTS,
} = require('./claude-workflow-host.cjs');
const { createClaudeDeliveryHost, runClaudeDeliveryCli } = require('./claude-delivery-host.cjs');
const pipelineConfig = require('./pipeline-config.cjs');
const { formatHint } = require('./refusal-hints.cjs');

const INVESTIGATION_RESEARCH_SCRIPT = WORKFLOW_SCRIPTS['investigation-research'];
const REQUEST_MAX_BYTES = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reject(message, code = 'INVALID_HOST') {
  const error = new Error(`claude-investigation-host: ${message}`);
  error.code = code;
  throw error;
}

function resolveResearchSelections(args, worktree) {
  if (!isObject(args) || !Array.isArray(args.lines)) return args;
  const lines = args.lines.map((line) => {
    if (!isObject(line)) reject('research lines must be objects before runtime selection');
    const selection = pipelineConfig.resolveDispatch({
      root: worktree,
      runtime: 'claude',
      role: 'research',
      signals: line.signals || {},
    });
    if ((line.model !== undefined && line.model !== selection.model)
        || (line.effort !== undefined && line.effort !== selection.effort)) {
      reject('research line selection contradicts the host-resolved model or effort');
    }
    return { ...line, model: selection.model, effort: selection.effort };
  });
  return { ...args, lines };
}

function prepareResolvedRequestFile(requestFile) {
  const source = path.resolve(requestFile);
  let stat;
  try { stat = fs.lstatSync(source); }
  catch (error) { reject(`cannot stat request file: ${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REQUEST_MAX_BYTES) {
    reject('request must be a bounded regular file');
  }
  let request;
  try { request = JSON.parse(fs.readFileSync(source, 'utf8')); }
  catch (error) { reject(`request is invalid JSON: ${error.message}`); }
  if (!isObject(request) || !isObject(request.args)
      || typeof request.args.worktreePath !== 'string' || !path.isAbsolute(request.args.worktreePath)) {
    reject('request must include an absolute worktreePath before runtime selection');
  }
  let worktree;
  try { worktree = fs.realpathSync(request.args.worktreePath); }
  catch (error) { reject(`worktreePath cannot be resolved: ${error.message}`); }
  const resolved = { ...request, args: resolveResearchSelections(request.args, worktree) };
  let directory;
  try { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-investigation-request-')); }
  catch (error) { reject(`cannot create private request directory: ${error.message}`); }
  const file = path.join(directory, 'request.json');
  try {
    fs.writeFileSync(file, JSON.stringify(resolved) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    reject(`cannot prepare host-resolved request: ${error.message}`);
  }
  return Object.freeze({ file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) });
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
      const selected = typeof args.worktreePath === 'string' && Array.isArray(args.lines)
        ? resolveResearchSelections(args, fs.realpathSync(args.worktreePath)) : args;
      return registered.run('investigation-research', { args: selected });
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
  const prepared = prepareResolvedRequestFile(argv[1]);
  return Promise.resolve(runClaudeDeliveryCli([
    '--workflow', 'investigation-research', '--request-file', prepared.file,
  ], stdout)).finally(prepared.cleanup);
}

module.exports = Object.freeze({
  INVESTIGATION_RESEARCH_SCRIPT,
  resolveResearchSelections,
  prepareResolvedRequestFile,
  registerInvestigationWorkflowHost,
  runInvestigationResearchCli,
  runInvestigationResearch,
  runInvestigationRuntime(options = {}) {
    if (!isObject(options) || !isObject(options.args)) {
      const error = new Error('claude-investigation-host: runtime args must be an object');
      error.code = 'INVALID_HOST';
      throw error;
    }
    const args = typeof options.args.worktreePath === 'string' && Array.isArray(options.args.lines)
      ? resolveResearchSelections(options.args, fs.realpathSync(options.args.worktreePath)) : options.args;
    return createClaudeDeliveryHost(options).run('investigation-research', args);
  },
});

if (require.main === module) {
  Promise.resolve().then(runInvestigationResearchCli).catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.stderr.write(`${formatHint(error && error.code)}\n`);
    process.exitCode = 1;
  });
}
