#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const AUTO_ROUTE_BEGIN = '<!-- shipyard-auto-route:begin -->';
const AUTO_ROUTE_END = '<!-- shipyard-auto-route:end -->';

function claudePolicy() {
  return [
    '[shipyard auto-route] If this message defines a scope of work or asks to',
    'implement / build / change / fix something in a codebase, handle it through',
    'shipyard rather than ad hoc — do not wait to be told to run a command:',
    '- Use the shipyard router (/shipyard:route) to size and dispatch the work:',
    '  large / multi-ticket → /shipyard:decompose → /shipyard:deliver; a small change,',
    '  an existing ticket, or "no ticket" → /shipyard:bench; a one-liner → inline.',
    '- Route unclear, research-needing or decision-pending work to',
    '  /shipyard:investigate via /shipyard:route.',
    '- Research first (proportionate) and apply GSD at full across stages',
    '  (research → plan → implement → verify → review), driving GSD/shipyard yourself.',
    '- Keep the native model ladder: bounded routine work uses Sonnet, critical or',
    '  repeated recovery uses Opus, and Fable is reserved for measured long-context',
    '  routes. The selected model and effort must remain visible in the dispatch.',
    '- Do not replace deterministic gates with a model response, and do not mix',
    '  Anthropic work with Codex models.',
    '- The user should not have to invoke GSD or shipyard manually.',
    'Skip this entirely for pure questions, discussion, or non-code chatter.',
  ].join('\n');
}

function codexBlock(phase, marketplace = false) {
  const largeRoute = phase >= 2
    ? '  large / multi-ticket -> `$shipyard-decompose` -> `$shipyard-deliver`; a small'
    : '  large / multi-ticket -> `$shipyard-decompose`; install phase 2 before delivery; a small';
  const block = [
    AUTO_ROUTE_BEGIN,
    '## shipyard auto-route (managed by shipyard install — do not edit between markers)',
    '',
    'When a message defines a scope of work or asks to implement / build / change /',
    'fix something in a codebase, handle it through shipyard rather than ad hoc — do',
    'not wait to be told to run a command:',
    '- Use the shipyard router `$shipyard-route` to size and dispatch the work:',
    largeRoute,
    '  change, an existing ticket, or "no ticket" -> `$shipyard-bench`; a one-liner ->',
    '  inline.',
    '- Route unclear, research-needing or decision-pending work to',
    '  `$shipyard-investigate` via `$shipyard-route`.',
    '- Research first (proportionate) and apply GSD at full across stages',
    '  (research -> plan -> implement -> verify -> review), driving GSD/shipyard',
    '  yourself.',
    '- Keep the native Codex ladder: Luna at max is the executor baseline; promote',
    '  to Sol only for explicit critical or measured recovery signals. Do not use',
    '  Anthropic models in a Codex dispatch.',
    '- The user should not have to invoke GSD or shipyard manually.',
    'Skip this entirely for pure questions, discussion, or non-code chatter.',
    AUTO_ROUTE_END,
  ].join('\n');
  return marketplace ? block.replace(/\$shipyard-(route|investigate|decompose|deliver|bench)/g,
    '$shipyard:shipyard-$1') : block;
}

function shouldInject(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return true;
  }
  const isObject = payload !== null && typeof payload === 'object';
  const prompt = isObject && typeof payload.prompt === 'string'
    ? payload.prompt
    : isObject && typeof payload.prompt_text === 'string'
      ? payload.prompt_text
      : null;
  if (prompt === null) return true;
  const trimmed = prompt.trim();
  if (trimmed.startsWith('<task-notification>')) return false;
  if (trimmed.startsWith('/') || trimmed.includes('<command-name>') || trimmed.includes('<command-message>')) {
    return false;
  }
  return true;
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (shouldInject(raw)) process.stdout.write(claudePolicy() + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write(claudePolicy() + '\n');
  }
  process.exitCode = 0;
}

module.exports = { AUTO_ROUTE_BEGIN, AUTO_ROUTE_END, claudePolicy, codexBlock, shouldInject };
