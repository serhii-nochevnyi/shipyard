#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('./pipeline-config.cjs');
const { normalizeOrigin, REPO_SLUG } = require('./repo-resolve.cjs');

const MANIFEST_RELATIVE = ['plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'];

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

// @security: fail-closed — an unreadable or unparsable manifest means hygiene applies.
function applies({ root, ref } = {}) {
  if (typeof root !== 'string' || !root) return true;
  try {
    const raw = ref
      ? execFileSync('git', ['-C', root, 'show', `${ref}:${MANIFEST_RELATIVE.join('/')}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : fs.readFileSync(path.join(root, ...MANIFEST_RELATIVE), 'utf8');
    const manifest = JSON.parse(raw);
    return !manifest || manifest.name !== 'shipyard';
  } catch {
    return true;
  }
}

const TICKET_TYPE_TO_CONVENTIONAL = Object.freeze({
  implementation: 'feat',
  tdd: 'feat',
  execute: 'feat',
  fix: 'fix',
  bugfix: 'fix',
  gap_closure: 'fix',
  docs: 'docs',
  refactor: 'refactor',
  test: 'test',
  chore: 'chore',
  config: 'chore',
});

function conventionalType(ticketType) {
  return TICKET_TYPE_TO_CONVENTIONAL[ticketType] || 'feat';
}

const CONVENTIONAL_TYPES = Object.freeze([
  'feat', 'fix', 'docs', 'refactor', 'test', 'perf', 'build', 'ci', 'chore', 'revert',
]);
const SLUG_RE_SOURCE = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const JIRA_RE_SOURCE = '[A-Z][A-Z]+-\\d+';
const HEAD_RE = new RegExp(`^(?:${CONVENTIONAL_TYPES.join('|')})\\/(?:${JIRA_RE_SOURCE}-)?${SLUG_RE_SOURCE}$`);

const PLACEHOLDER_PATTERNS = Object.freeze({
  type: `(?:${CONVENTIONAL_TYPES.join('|')})`,
  scope: '[^{}()\\[\\]]+',
  jira: JIRA_RE_SOURCE,
  subject: '.+',
});
const PLACEHOLDER_NAMES = new Set(Object.keys(PLACEHOLDER_PATTERNS));
const DEFAULT_TITLE_FORMAT = '{type}{[({scope})]}{[!]}: {subject}';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTitleTemplate(pattern) {
  if (typeof pattern !== 'string' || !pattern) return { error: 'the title format must be a non-empty string' };
  const top = [];
  let optionalNodes = null;
  const seen = new Set();
  let literal = '';
  const flush = (target) => {
    if (literal) { target.push({ literal }); literal = ''; }
  };
  let i = 0;
  while (i < pattern.length) {
    const target = optionalNodes || top;
    if (pattern.startsWith(']}', i)) {
      if (!optionalNodes) return { error: 'a literal "]}" is invalid outside an optional segment' };
      flush(optionalNodes);
      top.push({ optional: optionalNodes });
      optionalNodes = null;
      i += 2;
      continue;
    }
    if (pattern.startsWith('{[', i)) {
      if (optionalNodes) return { error: 'nested optional segments ("{[" inside "{[…]}") are invalid' };
      flush(top);
      optionalNodes = [];
      i += 2;
      continue;
    }
    if (pattern[i] === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close === -1) return { error: 'an unclosed "{" placeholder is invalid' };
      const name = pattern.slice(i + 1, close);
      if (!PLACEHOLDER_NAMES.has(name)) return { error: `unknown placeholder "{${name}}"` };
      if (seen.has(name)) return { error: `placeholder "{${name}}" is used more than once` };
      seen.add(name);
      flush(target);
      target.push({ placeholder: name });
      i = close + 1;
      continue;
    }
    literal += pattern[i];
    i++;
  }
  if (optionalNodes) return { error: 'an optional segment is never closed with "]}"' };
  flush(top);
  return { nodes: top };
}

function compileNodes(nodes) {
  let source = '';
  for (const node of nodes) {
    if (node.literal !== undefined) source += escapeRegExp(node.literal);
    else if (node.placeholder) source += `(?<${node.placeholder}>${PLACEHOLDER_PATTERNS[node.placeholder]})`;
    else if (node.optional) source += `(?:${compileNodes(node.optional)})?`;
  }
  return source;
}

function compileTitleFormat(pattern, key = 'titleFormat') {
  const parsed = parseTitleTemplate(pattern);
  if (parsed.error) fail('TITLE_FORMAT_INVALID', `${key}: ${parsed.error}`, { key, pattern });
  let regex;
  try {
    regex = new RegExp(`^${compileNodes(parsed.nodes)}$`, 'd');
  } catch (error) {
    fail('TITLE_FORMAT_INVALID', `${key}: ${error.message}`, { key, pattern });
  }
  return { pattern, key, nodes: parsed.nodes, regex };
}

function resolveTitlePattern({ root, repo }) {
  const { config } = loadConfig(root);
  const configured = config.pr_title_format;
  if (configured == null) return { pattern: DEFAULT_TITLE_FORMAT, key: 'pr_title_format (default)' };
  if (typeof configured === 'string') return { pattern: configured, key: 'pr_title_format' };
  if (!repo) {
    fail('TITLE_FORMAT_INVALID', 'pr_title_format is a map, but no repository slug was given or could be resolved');
  }
  if (Object.prototype.hasOwnProperty.call(configured, repo)) {
    return { pattern: configured[repo], key: `pr_title_format["${repo}"]` };
  }
  if (Object.prototype.hasOwnProperty.call(configured, 'default')) {
    return { pattern: configured.default, key: 'pr_title_format["default"]' };
  }
  return { pattern: DEFAULT_TITLE_FORMAT, key: 'pr_title_format (default)' };
}

function titleFormat({ root, repo } = {}) {
  const { pattern, key } = resolveTitlePattern({ root, repo });
  return compileTitleFormat(pattern, key);
}

function asCompiledFormat(format) {
  if (format === undefined || format === null) return compileTitleFormat(DEFAULT_TITLE_FORMAT, 'pr_title_format (default)');
  if (typeof format === 'string') return compileTitleFormat(format, 'titleFormat');
  if (format && typeof format === 'object' && Array.isArray(format.nodes) && format.regex instanceof RegExp) return format;
  fail('TITLE_FORMAT_INVALID', 'titleFormat must be a compiled format, a template string, or omitted for the default');
}

function collectPlaceholders(nodes) {
  return nodes.filter((node) => node.placeholder).map((node) => node.placeholder);
}

function hasValue(fields, name) {
  const value = fields ? fields[name] : undefined;
  return value !== undefined && value !== null && String(value) !== '';
}

function renderNodes(nodes, fields) {
  let out = '';
  for (const node of nodes) {
    if (node.literal !== undefined) { out += node.literal; continue; }
    if (node.optional) {
      const names = collectPlaceholders(node.optional);
      if (names.length === 0) continue;
      if (!names.every((name) => hasValue(fields, name))) continue;
      out += renderNodes(node.optional, fields);
      continue;
    }
    if (!hasValue(fields, node.placeholder)) {
      fail('TITLE_FORMAT_UNRENDERABLE', `the "{${node.placeholder}}" placeholder has no value`, { field: node.placeholder });
    }
    out += String(fields[node.placeholder]);
  }
  return out;
}

function formatTitle(fields, format) {
  const compiled = asCompiledFormat(format);
  return renderNodes(compiled.nodes, fields || {});
}

const NEUTRAL_PR_BODY_GUIDE =
  'PR body: Summary (what changed and why), Changes (bullet list), Tests (how it was verified) — no internal identifiers or tool names.';
const NEUTRAL_DELIVERY_RULES_HINT =
  'Work only within files_modified; commit with a Conventional Commits subject and no internal identifiers.';

const INTERNAL_LEAK_RULES = Object.freeze([
  ['ticket-id', /T-\d{2}-\d{2}/i],
  ['ticket-marker', /Ticket:/i],
  ['phase-number', /\bPhase\s+\d+/i],
  ['adr-number', /ADR-\d+/i],
  ['plan-file', /PLAN\.md/i],
  ['ticket-branch-prefix', new RegExp('ticket/', 'i')],
  ['epic-branch-prefix', new RegExp('epic/', 'i')],
  ['planning-path', new RegExp('\\.planning/', 'i')],
  ['shipyard-path', new RegExp('\\.shipyard/', 'i')],
  ['gate-status-trailer', /gate_status:/i],
  ['internal-tool-word', /\b(?:shipyard|gsd|conveyor)\b/i],
]);

function internalLeakViolations(field, text) {
  const value = String(text || '');
  const violations = [];
  for (const [rule, regex] of INTERNAL_LEAK_RULES) {
    const match = regex.exec(value);
    if (match) violations.push({ field, rule, excerpt: match[0] });
  }
  return violations;
}

function jiraViolations(field, text, jiraKeys, jiraSpan) {
  const allowed = new Set((jiraKeys || []).map(String));
  const scan = new RegExp(JIRA_RE_SOURCE, 'g');
  const value = String(text || '');
  const violations = [];
  let match;
  while ((match = scan.exec(value))) {
    const start = match.index;
    const end = start + match[0].length;
    const atFormatSlot = field === 'title' && jiraSpan && jiraSpan[0] === start && jiraSpan[1] === end;
    if (field === 'title' && !atFormatSlot) {
      violations.push({ field, rule: 'jira-key-misplaced', excerpt: match[0] });
      continue;
    }
    if (!allowed.has(match[0])) violations.push({ field, rule: 'jira-key-not-listed', excerpt: match[0] });
  }
  return violations;
}

function pathViolation(entry) {
  const status = String((entry && entry.status) || '').trim().toUpperCase();
  if (status.startsWith('D')) return null;
  const target = String((entry && entry.path) || '');
  if (target.startsWith('.planning/') || target.startsWith('.shipyard/')) {
    return { field: 'paths', rule: 'internal-path', excerpt: `${status || '?'} ${target}` };
  }
  return null;
}

function check(input = {}) {
  const { title, body, head, base, paths = [], commits = [], jiraKeys = [], titleFormat: format } = input;
  void base;
  const compiled = asCompiledFormat(format);
  const violations = [];

  const titleMatch = compiled.regex.exec(String(title || ''));
  if (!titleMatch) {
    violations.push({ field: 'title', rule: 'title-format', excerpt: String(title || '').slice(0, 120) });
  }
  const jiraSpan = titleMatch && titleMatch.indices && titleMatch.indices.groups
    ? titleMatch.indices.groups.jira
    : undefined;

  if (!HEAD_RE.test(String(head || ''))) {
    violations.push({ field: 'head', rule: 'head-format', excerpt: String(head || '').slice(0, 120) });
  }

  for (const field of ['title', 'body', 'head']) violations.push(...internalLeakViolations(field, input[field]));
  commits.forEach((subject, index) => violations.push(...internalLeakViolations(`commits[${index}]`, subject)));

  violations.push(...jiraViolations('title', title, jiraKeys, jiraSpan));
  violations.push(...jiraViolations('body', body, jiraKeys));
  violations.push(...jiraViolations('head', head, jiraKeys));

  for (const entry of paths) {
    const violation = pathViolation(entry);
    if (violation) violations.push(violation);
  }

  return { ok: violations.length === 0, violations };
}

function flagValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) fail('USAGE', `--${name} requires a value`);
  return value;
}

function required(argv, name) {
  const value = flagValue(argv, name);
  if (value === undefined) fail('USAGE', `--${name} is required`);
  return value;
}

function resolveRepoSlug(root, explicit) {
  if (explicit) {
    if (!REPO_SLUG.test(explicit)) fail('USAGE', `--repo "${explicit}" is not an owner/name slug`);
    return explicit;
  }
  try {
    const origin = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return normalizeOrigin(origin) || undefined;
  } catch {
    return undefined;
  }
}

function collectPaths(root, base, head) {
  const output = execFileSync('git', ['-C', root, 'diff', '--name-status', `${base}...${head}`], { encoding: 'utf8' });
  return output.split('\n').filter(Boolean).map((line) => {
    const columns = line.split('\t');
    return { status: columns[0], path: columns[columns.length - 1] };
  });
}

function collectCommits(root, base, head) {
  const output = execFileSync('git', ['-C', root, 'log', '--format=%s', `${base}..${head}`], { encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function runCheckCli(argv) {
  const root = path.resolve(required(argv, 'project-root'));
  const json = argv.includes('--json');
  if (!applies({ root })) {
    console.log(json ? JSON.stringify({ exempt: true }, null, 2) : 'exempt');
    return 0;
  }
  const base = required(argv, 'base');
  const head = required(argv, 'head');
  const title = required(argv, 'title');
  const bodyFile = required(argv, 'body-file');
  const repo = resolveRepoSlug(root, flagValue(argv, 'repo'));
  const body = fs.readFileSync(path.resolve(bodyFile), 'utf8');
  const paths = collectPaths(root, base, head);
  const commits = collectCommits(root, base, head);
  const format = titleFormat({ root, repo });
  const result = check({ title, body, head, base, paths, commits, jiraKeys: [], titleFormat: format });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log('pr-hygiene: OK');
  } else {
    console.error(`pr-hygiene: BLOCKED — ${result.violations.length} violation(s)`);
    for (const violation of result.violations) {
      console.error(`  - ${violation.field} [${violation.rule}]: ${violation.excerpt}`);
    }
  }
  return result.ok ? 0 : 2;
}

function runFormatCli(argv) {
  const root = path.resolve(required(argv, 'project-root'));
  const type = required(argv, 'type');
  const scope = flagValue(argv, 'scope');
  const jira = flagValue(argv, 'jira');
  const subject = required(argv, 'subject');
  const repo = resolveRepoSlug(root, flagValue(argv, 'repo'));
  const format = titleFormat({ root, repo });
  console.log(formatTitle({ type, scope, jira, subject }, format));
  return 0;
}

module.exports = {
  applies,
  conventionalType,
  CONVENTIONAL_TYPES,
  DEFAULT_TITLE_FORMAT,
  compileTitleFormat,
  titleFormat,
  formatTitle,
  check,
  NEUTRAL_PR_BODY_GUIDE,
  NEUTRAL_DELIVERY_RULES_HINT,
};

if (require.main === module) {
  const [, , command, ...rest] = process.argv;
  try {
    if (command === 'check') process.exitCode = runCheckCli(rest);
    else if (command === 'format') process.exitCode = runFormatCli(rest);
    else fail('USAGE', 'usage: pr-hygiene.cjs check --project-root <r> [--repo <owner/name>] --base <b> --head <h> --title <t> --body-file <f> [--json]\n   or: pr-hygiene.cjs format --project-root <r> [--repo <owner/name>] --type <t> [--scope <s>] [--jira <KEY>] --subject <text>');
  } catch (error) {
    process.stderr.write(`pr-hygiene: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 2;
  }
}
