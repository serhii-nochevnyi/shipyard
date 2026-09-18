'use strict';

const fs = require('fs');
const path = require('path');

function heading(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
}

function headings(lines) {
  const found = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    const token = heading(line);
    if (token) found.push({ ...token, index });
  }
  return found;
}

function compact(lines) {
  return lines
    .map((line) => {
      const token = heading(line);
      return token ? token.title : line.trim();
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionNodes(lines) {
  const found = headings(lines);
  return found
    .filter((item) => item.level === 2)
    .map((item, position, sections) => {
      const end = sections[position + 1] ? sections[position + 1].index : lines.length;
      const children = found
        .filter((child) => child.level === 3 && child.index > item.index && child.index < end)
        .map((child, childPosition, childItems) => {
          const next = childItems[childPosition + 1];
          const childEnd = next ? next.index : end;
          return {
            title: child.title,
            body: lines.slice(child.index + 1, childEnd),
          };
        });
      return {
        title: item.title,
        start: item.index,
        end,
        body: lines.slice(item.index + 1, end),
        children,
      };
    });
}

function canonical(title) {
  const normalized = title.toLowerCase().replace(/[\s:._-]+/g, ' ').trim();
  if (/^decisions?$/.test(normalized)) return 'decision';
  if (/^consequences?(?: .*)?$/.test(normalized)) return 'consequences';
  if (/^(?:scope fences|scope fence|out of scope|non goals)$/.test(normalized)) return 'out-of-scope';
  if (/^supersession$/.test(normalized)) return 'update';
  if (/^(?:rollout|rollout and rollback)$/.test(normalized)) return 'plan';
  return null;
}

function directEntries(lines, children) {
  const firstChild = children.length === 0 ? lines.length : lines.findIndex((line) => heading(line)?.level === 3);
  return lines
    .slice(0, firstChild < 0 ? lines.length : firstChild)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s+/, '').trim())
    .filter(Boolean);
}

function childEntry(child) {
  const body = compact(child.body);
  return `- **${child.title}**${body ? `: ${body}` : ''}`;
}

function normalizedSection(section, kind) {
  const entries = directEntries(section.body, section.children);
  const childEntries = section.children.map(childEntry);
  const all = [...entries.map((entry) => `- ${entry}`), ...childEntries];
  if (kind === 'consequences') {
    return [`## ${section.title}`, '', ...all, ''];
  }
  if (kind === 'out-of-scope') {
    return ['## Out of scope', '', ...all, ''];
  }
  if (kind === 'update') {
    return ['## Update', '', ...all, ''];
  }
  if (kind === 'plan') {
    return ['## Plan', '', ...all, ''];
  }
  return ['## Decision', '', ...all, ''];
}

function normalizeAdr(markdown) {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const sections = sectionNodes(lines);
  const replacements = sections
    .map((section) => ({ section, kind: canonical(section.title) }))
    .filter(({ kind, section }) => kind && (section.children.length > 0 || kind === 'out-of-scope' || kind === 'update' || kind === 'plan'));
  if (replacements.length === 0) return { content: source, changed: false, decisions: countDecisionEntries(sections) };

  const output = [];
  let cursor = 0;
  for (const replacement of replacements) {
    const { section, kind } = replacement;
    output.push(...lines.slice(cursor, section.start));
    output.push(...normalizedSection(section, kind));
    cursor = section.end;
  }
  output.push(...lines.slice(cursor));
  const content = output.join('\n');
  return { content, changed: content !== source, decisions: countDecisionEntries(sectionNodes(content.split('\n'))) };
}

function countDecisionEntries(sections) {
  return sections
    .filter((section) => canonical(section.title) === 'decision')
    .reduce((total, section) => total + directEntries(section.body, section.children).length + section.children.length, 0);
}

function validateAdr(result, input) {
  if (result.decisions > 0) return;
  throw new Error(`${input}: no decisions were found under an ADR Decision section`);
}

function parseArgs(argv) {
  const args = { inputs: [], output: null, outputDir: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.inputs.push(argv[++index] || '');
    else if (arg === '--output') args.output = argv[++index] || '';
    else if (arg === '--output-dir') args.outputDir = argv[++index] || '';
    else if (arg === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.inputs.length === 0) throw new Error('Missing required --input <path>');
  if (args.output && args.inputs.length !== 1) throw new Error('--output requires exactly one --input');
  if (args.output && args.outputDir) throw new Error('Use either --output or --output-dir, not both');
  if (!args.output && !args.outputDir) throw new Error('Missing --output <path> or --output-dir <path>');
  return args;
}

function outputPath(input, args) {
  if (args.output) return args.output;
  const name = path.basename(input).replace(/\.md$/i, '.ingest.md');
  return path.join(args.outputDir, name);
}

function processInput(input, args) {
  const source = fs.readFileSync(input, 'utf8');
  const result = normalizeAdr(source);
  validateAdr(result, input);
  const output = outputPath(input, args);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.content.endsWith('\n') ? result.content : `${result.content}\n`);
  return { input, output, changed: result.changed, decisions: result.decisions };
}

function prepareOutputDir(args) {
  if (!args.outputDir) return;
  fs.mkdirSync(args.outputDir, { recursive: true });
  for (const name of fs.readdirSync(args.outputDir)) {
    if (!name.endsWith('.ingest.md')) continue;
    const target = path.join(args.outputDir, name);
    if (fs.statSync(target).isFile()) fs.unlinkSync(target);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  prepareOutputDir(args);
  const results = args.inputs.map((input) => processInput(input, args));
  process.stdout.write(args.json ? `${JSON.stringify(results)}\n` : results.map((item) => `${item.input} -> ${item.output} (${item.decisions} decisions)`).join('\n') + '\n');
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
  canonical,
  normalizeAdr,
  sectionNodes,
  validateAdr,
};
