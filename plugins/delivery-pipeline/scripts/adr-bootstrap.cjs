'use strict';

const fs = require('fs');
const path = require('path');
const { decisionEntries } = require('./adr-ingest.cjs');

function parseArgs(argv) {
  const args = { adr: null, phase: 1, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--adr') args.adr = argv[++index] || '';
    else if (arg === '--phase') args.phase = Number(argv[++index]);
    else if (arg === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.adr) throw new Error('Missing required --adr <path>');
  if (!Number.isInteger(args.phase) || args.phase < 1) throw new Error('--phase must be a positive integer');
  return args;
}

function adrHeading(markdown) {
  const line = markdown.replace(/\r\n?/g, '\n').split('\n').find((entry) => /^#\s+\S/.test(entry));
  const title = line ? line.replace(/^#\s+/, '').trim() : 'Untitled';
  const match = /^(\S+)\s*[—-]\s*(.+)$/.exec(title);
  return match ? { id: match[1], title: match[2].trim() } : { id: title, title };
}

function requirementId(index) {
  return `REQ-${String(index + 1).padStart(2, '0')}`;
}

function configContent() {
  return `${JSON.stringify({ git: { branching_strategy: 'none' } })}\n`;
}

function roadmapContent(phase, heading, requirements) {
  const ids = requirements.map((entry) => entry.id).join(', ');
  return [
    `### Phase ${phase}: ${heading.title}`,
    `**Status**: planned (${heading.id})`,
    `**Requirements**: ${ids}`,
    '',
    `Implement ${heading.id}: ${heading.title}.`,
    '',
  ].join('\n');
}

function requirementsContent(phase, requirements) {
  const checklist = requirements.map((entry) => `- [ ] **${entry.id}**: ${entry.decision}`);
  const rows = requirements.map((entry) => `| ${entry.id} | Phase ${phase} | Pending |`);
  return [
    '# Requirements',
    '',
    ...checklist,
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function writeIfMissing(file, data) {
  try {
    fs.writeFileSync(file, data, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function bootstrap(args) {
  const markdown = fs.readFileSync(args.adr, 'utf8');
  const decisions = decisionEntries(markdown);
  if (decisions.length === 0) {
    throw new Error(`${args.adr} has no bullets under ## Decision; add one bullet per locked decision (see templates/adr/ADR.md) and re-run`);
  }
  const heading = adrHeading(markdown);
  const requirements = decisions.map((decision, index) => ({ id: requirementId(index), decision }));

  const root = process.cwd();
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });

  const targets = [
    { rel: path.join('.planning', 'config.json'), data: configContent() },
    { rel: path.join('.planning', 'ROADMAP.md'), data: roadmapContent(args.phase, heading, requirements) },
    { rel: path.join('.planning', 'REQUIREMENTS.md'), data: requirementsContent(args.phase, requirements) },
  ];

  const created = [];
  const skippedExisting = [];
  for (const target of targets) {
    if (writeIfMissing(path.join(root, target.rel), target.data)) created.push(target.rel);
    else skippedExisting.push(target.rel);
  }

  return { created, skipped_existing: skippedExisting, requirements };
}

function printReport(report) {
  for (const item of report.created) process.stdout.write(`created: ${item}\n`);
  for (const item of report.skipped_existing) process.stdout.write(`skipped_existing: ${item}\n`);
  for (const entry of report.requirements) process.stdout.write(`requirement: ${entry.id}: ${entry.decision}\n`);
}

function main(argv) {
  const args = parseArgs(argv);
  const report = bootstrap(args);
  if (args.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else printReport(report);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  adrHeading,
  requirementId,
  configContent,
  roadmapContent,
  requirementsContent,
  bootstrap,
  main,
};
