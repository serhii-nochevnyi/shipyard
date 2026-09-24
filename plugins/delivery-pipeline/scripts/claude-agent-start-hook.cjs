#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--evidence-file', '--expected-session', '--expected-agent'].includes(name)) {
      throw new Error(`unsupported argument ${name}`);
    }
    const value = argv[++index];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} requires a value`);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (result[key] !== undefined) throw new Error(`${name} may be provided only once`);
    result[key] = value;
  }
  if (!result.evidenceFile || !result.expectedSession) throw new Error('evidence file and expected session are required');
  return result;
}

function capture(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || input.hook_event_name !== 'SessionStart' || input.source !== 'startup'
      || input.session_id !== options.expectedSession
      || typeof input.transcript_path !== 'string' || !input.transcript_path.trim()
      || typeof input.cwd !== 'string' || !input.cwd.trim()) {
    throw new Error('SessionStart input does not match the requested launch');
  }
  if (options.expectedAgent !== undefined && input.agent_type !== options.expectedAgent) {
    throw new Error('SessionStart agent_type does not match the requested GSD agent');
  }
  const evidence = {
    hook_event_name: input.hook_event_name,
    source: input.source,
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    ...(typeof input.agent_type === 'string' ? { agent_type: input.agent_type } : {}),
    cwd: input.cwd,
  };
  const descriptor = fs.openSync(options.evidenceFile, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(evidence)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function main(argv, stdin) {
  const options = parseArguments(argv);
  const raw = stdin.toString('utf8');
  if (!raw.trim() || Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new Error('SessionStart input is empty or too large');
  let input;
  try { input = JSON.parse(raw); }
  catch (error) { throw new Error(`SessionStart input is invalid JSON: ${error.message}`); }
  capture(input, options);
}

if (require.main === module) {
  try { main(process.argv.slice(2), fs.readFileSync(0)); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ parseArguments, capture, main });
