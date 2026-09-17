#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_COMMENT_RATIO = 1;
const EXTENSIONS = new Map([
  ['.c', 'c-like'], ['.cc', 'c-like'], ['.cpp', 'c-like'], ['.cxx', 'c-like'],
  ['.h', 'c-like'], ['.hh', 'c-like'], ['.hpp', 'c-like'], ['.hxx', 'c-like'],
  ['.cs', 'c-like'], ['.dart', 'c-like'], ['.java', 'c-like'], ['.kt', 'c-like'],
  ['.kts', 'c-like'], ['.m', 'c-like'], ['.mm', 'c-like'], ['.php', 'c-like'],
  ['.rs', 'c-like'], ['.scala', 'c-like'], ['.swift', 'c-like'],
  ['.js', 'c-like'], ['.jsx', 'c-like'], ['.mjs', 'c-like'], ['.cjs', 'c-like'],
  ['.ts', 'c-like'], ['.tsx', 'c-like'], ['.vue', 'c-like'], ['.svelte', 'c-like'],
  ['.css', 'css'], ['.scss', 'css'], ['.less', 'css'],
  ['.py', 'hash'], ['.pyi', 'hash'], ['.rb', 'hash'], ['.rake', 'hash'],
  ['.pl', 'hash'], ['.pm', 'hash'], ['.ps1', 'hash'],
  ['.sh', 'hash'], ['.bash', 'hash'], ['.zsh', 'hash'], ['.fish', 'hash'],
  ['.yml', 'hash'], ['.yaml', 'hash'], ['.toml', 'hash'], ['.ini', 'hash'],
  ['.cfg', 'hash'], ['.conf', 'hash'], ['.properties', 'hash'], ['.env', 'hash'],
  ['.sql', 'sql'], ['.html', 'html'], ['.htm', 'html'], ['.xml', 'html'],
]);
const SPECIAL_FILES = new Map([
  ['Dockerfile', 'hash'], ['Makefile', 'hash'], ['GNUmakefile', 'hash'],
  ['.gitignore', 'hash'], ['.dockerignore', 'hash'], ['.env', 'hash'],
]);
const SPECS = {
  'c-like': { line: ['//'], block: ['/*', '*/'], quotes: ['\'', '"', '`'] },
  css: { line: [], block: ['/*', '*/'], quotes: ['\'', '"'] },
  hash: { line: ['#'], block: [], quotes: ['\'', '"', '`'], triple: ['\'\'\'', '"""'] },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: ['\'', '"', '`'] },
  html: { line: [], block: ['<!--', '-->'], quotes: ['\'', '"'] },
};

function languageFor(file) {
  const base = path.basename(file);
  if (SPECIAL_FILES.has(base)) return SPECIAL_FILES.get(base);
  return EXTENSIONS.get(path.extname(file).toLowerCase()) || null;
}

function protectedComment(text) {
  if (text.trimStart().startsWith('#!')) return true;
  const body = text
    .replace(/^\s*(?:\/\*+|\/\/|#|--|<!--)\s?/, '')
    .replace(/\s*(?:\*\/|-->|--)?\s*$/, '')
    .trim();
  return /^(?:SPDX-License-Identifier\b|copyright\b|\(c\)\b|@(?:ts-check|ts-ignore|ts-expect-error|generated)\b|eslint(?:-disable|-enable)?\b|biome-ignore\b|tslint(?::|-)\s*|prettier-ignore\b|jshint\b|c8\s+ignore\b|istanbul\s+ignore\b|coverage:\s*|shellcheck\b|noqa\b|nosec\b|nolint\b|lint:ignore\b|go:(?:build|generate|embed|linkname)\b|line\s+\S+:\d+\b|pragma\b|keep\b|shipyard(?:[-:]|\s)|gsd-sync\b|managed\s+by\b|do\s+not\s+edit\b|generated\s+file\b)/i.test(body);
}

function scanText(text, language) {
  const spec = SPECS[language];
  if (!spec) throw new Error(`unsupported language: ${language}`);
  const lines = text.split('\n');
  const state = { block: null, quote: null };
  const scanned = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fragments = [];
    let code = false;
    let i = 0;

    while (i < line.length) {
      if (state.block) {
        const close = line.indexOf(state.block.close, i);
        const end = close === -1 ? line.length : close + state.block.close.length;
        fragments.push({
          text: line.slice(i, end),
          protected: state.block.protected,
          block: true,
          openedHere: false,
          closedHere: close !== -1,
        });
        i = end;
        if (close === -1) break;
        state.block = null;
        continue;
      }

      if (state.quote) {
        code = true;
        if (state.quote.length > 1 && line.startsWith(state.quote, i)) {
          i += state.quote.length;
          state.quote = null;
          continue;
        }
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (state.quote.length === 1 && line[i] === state.quote) state.quote = null;
        i++;
        continue;
      }

      const lineToken = spec.line.find((token) => line.startsWith(token, i));
      if (lineToken) {
        const fragment = line.slice(i);
        fragments.push({ text: fragment, protected: line.trimStart().startsWith('#!') || protectedComment(fragment), block: false, openedHere: true, closedHere: true });
        break;
      }

      const blockOpen = spec.block[0] && line.startsWith(spec.block[0], i);
      if (blockOpen) {
        const close = line.indexOf(spec.block[1], i + spec.block[0].length);
        const end = close === -1 ? line.length : close + spec.block[1].length;
        const fragment = line.slice(i, end);
        const isProtected = protectedComment(fragment);
        fragments.push({
          text: fragment,
          protected: isProtected,
          block: true,
          openedHere: true,
          closedHere: close !== -1,
        });
        if (close === -1) {
          state.block = { close: spec.block[1], protected: isProtected };
          break;
        }
        i = end;
        continue;
      }

      const tripleQuote = (spec.triple || []).find((token) => line.startsWith(token, i));
      if (tripleQuote) {
        code = true;
        state.quote = tripleQuote;
        i += tripleQuote.length;
        continue;
      }

      const quote = spec.quotes.find((token) => line[i] === token);
      if (quote) {
        code = true;
        state.quote = quote;
        i++;
        continue;
      }

      if (!/\s/.test(line[i])) code = true;
      i++;
    }

    if (state.quote && state.quote.length === 1 && state.quote !== '`') {
      const backslashes = (line.match(/\\+$/) || [''])[0].length;
      if (backslashes % 2 === 0) state.quote = null;
    }

    const normal = fragments.filter((fragment) => !fragment.protected);
    const hasComment = normal.length > 0;
    const protectedOnly = fragments.length > 0 && !hasComment;
    const commentOnly = hasComment && !code;
    const cleanable = commentOnly
      && normal.every((fragment) => !fragment.block
        || (fragment.openedHere && fragment.closedHere));

    scanned.push({
      line: lineIndex + 1,
      text: line,
      code,
      comment: hasComment,
      protected: protectedOnly,
      cleanable,
      fragments,
    });
  }
  return scanned;
}

function parseQuotedPath(value) {
  if (!value.startsWith('"')) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function diffPath(value, prefix) {
  if (value === '/dev/null') return null;
  const decoded = parseQuotedPath(value);
  return decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded;
}

function parseDiff(diff) {
  const additions = new Map();
  let file = null;
  let nextLine = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = diffPath(raw.slice(4), 'b/');
      nextLine = null;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!file || nextLine === null || raw.length === 0) continue;
    if (raw[0] === '+') {
      if (!raw.startsWith('+++ ')) {
        if (!additions.has(file)) additions.set(file, new Set());
        additions.get(file).add(nextLine);
        nextLine++;
      }
      continue;
    }
    if (raw[0] === '-') continue;
    if (raw[0] === ' ') nextLine++;
  }
  return additions;
}

function git(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function resolveBase(worktree, requested) {
  const candidates = requested.startsWith('refs/')
    ? [requested]
    : requested.startsWith('origin/')
      ? [requested, `refs/remotes/${requested}`]
      : [`refs/remotes/origin/${requested}`, requested, `refs/heads/${requested}`];
  for (const candidate of candidates) {
    try {
      const value = execFileSync('git', [
        '-C', worktree, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (value) return value;
    } catch {}
  }
  throw new Error(`base ref cannot be resolved in ${worktree}: ${requested}`);
}

function contained(worktree, relative) {
  const root = path.resolve(worktree);
  const candidate = path.resolve(root, relative);
  const fromRoot = path.relative(root, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`diff path escapes worktree: ${relative}`);
  }
  return candidate;
}

function diffFor(worktree, base, workingTree) {
  const revision = workingTree ? base : `${base}...HEAD`;
  return git(worktree, [
    'diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames',
    '--diff-filter=ACMR', revision, '--',
  ]);
}

function ratioFor(comments, code) {
  if (!comments) return 0;
  if (!code) return null;
  return comments / code;
}

function analyze(worktree, base, options = {}) {
  const resolvedBase = resolveBase(worktree, base);
  const diff = diffFor(worktree, resolvedBase, Boolean(options.workingTree));
  const additions = parseDiff(diff);
  const files = [];
  const skipped = [];
  let totals = {
    added_lines: 0,
    code_lines: 0,
    comment_lines: 0,
    protected_comment_lines: 0,
    cleanable_comment_lines: 0,
    manual_comment_lines: 0,
  };

  for (const [relative, lineNumbers] of additions) {
    const language = languageFor(relative);
    if (!language) {
      skipped.push({ path: relative, reason: 'unsupported-file-type' });
      continue;
    }
    const file = contained(worktree, relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { throw new Error(`changed file cannot be read: ${relative}: ${error.message}`); }
    if (stat.isSymbolicLink()) throw new Error(`changed file is a symlink: ${relative}`);
    if (!stat.isFile()) throw new Error(`changed path is not a regular file: ${relative}`);
    const content = fs.readFileSync(file);
    if (content.includes(0)) {
      skipped.push({ path: relative, reason: 'binary-file' });
      continue;
    }
    const scanned = scanText(content.toString('utf8'), language);
    const findings = [];
    const counts = {
      added_lines: 0,
      code_lines: 0,
      comment_lines: 0,
      protected_comment_lines: 0,
      cleanable_comment_lines: 0,
      manual_comment_lines: 0,
    };
    for (const line of [...lineNumbers].sort((a, b) => a - b)) {
      const item = scanned[line - 1];
      if (!item) throw new Error(`diff line is outside file: ${relative}:${line}`);
      counts.added_lines++;
      if (item.code) counts.code_lines++;
      if (item.comment) {
        counts.comment_lines++;
        if (item.cleanable) counts.cleanable_comment_lines++;
        else counts.manual_comment_lines++;
      } else if (item.protected) {
        counts.protected_comment_lines++;
      }
      if (item.comment) {
        findings.push({
          line,
          kind: item.cleanable ? 'cleanable' : 'manual',
          text: item.text.trim().slice(0, 160),
        });
      }
    }
    const violation = counts.comment_lines > counts.code_lines;
    const entry = {
      path: relative,
      language,
      ...counts,
      ratio: ratioFor(counts.comment_lines, counts.code_lines),
      violation,
      findings,
    };
    files.push(entry);
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }

  const violations = files.filter((file) => file.violation);
  return {
    base: resolvedBase,
    requested_base: base,
    worktree,
    working_tree: Boolean(options.workingTree),
    policy: {
      max_comment_ratio: MAX_COMMENT_RATIO,
      scope: 'non-protected comments on added lines in supported code/config files',
      per_file: true,
    },
    ok: violations.length === 0,
    files,
    skipped,
    violations: violations.map((file) => file.path),
    totals: {
      ...totals,
      ratio: ratioFor(totals.comment_lines, totals.code_lines),
    },
  };
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

function argumentsFor(argv) {
  const valueFlags = new Set(['--worktree', '--base']);
  const positionals = argv.filter((value, index) => !value.startsWith('--') && !valueFlags.has(argv[index - 1]));
  const command = positionals[0];
  const ticket = positionals[1];
  if (!['check', 'clean'].includes(command) || !ticket) {
    throw new Error('usage: comment-policy.cjs check|clean <ticket> --worktree <path> --base <ref> [--json] [--apply]');
  }
  const worktree = flag(argv, 'worktree');
  const base = flag(argv, 'base');
  if (!worktree || !base) throw new Error('usage: comment-policy.cjs check|clean <ticket> --worktree <path> --base <ref> [--json] [--apply]');
  return {
    command,
    ticket,
    worktree: path.resolve(worktree),
    base,
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
  };
}

function humanRatio(value) {
  return value === null ? '∞' : value.toFixed(2);
}

function printCheck(result, ticket) {
  if (result.ok) {
    console.log(`comment-policy: ${ticket} OK — ${result.totals.comment_lines} non-protected comment line(s) / ${result.totals.code_lines} code line(s)`);
    if (result.skipped.length) console.log(`comment-policy: skipped ${result.skipped.length} unsupported or binary file(s)`);
    return;
  }
  console.error(`comment-policy: ${ticket} BLOCKED — added non-protected comments exceed code in ${result.violations.length} file(s)`);
  for (const file of result.files.filter((entry) => entry.violation)) {
    console.error(`  - ${file.path}: ${file.comment_lines} comment line(s) / ${file.code_lines} code line(s), ratio ${humanRatio(file.ratio)}; cleanable ${file.cleanable_comment_lines}, manual ${file.manual_comment_lines}`);
  }
  console.error(`comment-policy: run clean ${ticket} --worktree ${result.worktree} --base ${result.base} --json for a dry run`);
}

function printClean(result, ticket, before, removed = []) {
  if (result.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (before.ok) {
    console.log(`comment-policy: ${ticket} OK — no cleanup needed`);
    return;
  }
  const cleanable = before.files.flatMap((file) => file.findings
    .filter((finding) => finding.kind === 'cleanable')
    .map((finding) => `${file.path}:${finding.line}`));
  if (!removed.length) {
    console.error(`comment-policy: ${ticket} cleanup preview — ${cleanable.length} removable line(s)`);
    for (const item of cleanable) console.error(`  - ${item}`);
    if (before.files.some((file) => file.manual_comment_lines)) {
      console.error('comment-policy: manual comments remain; remove or justify them before push');
    }
    return;
  }
  console.log(`comment-policy: ${ticket} removed ${removed.length} comment line(s); rerun verification, amend the commit, and run check again`);
  if (!result.ok) console.error('comment-policy: manual comments still exceed the policy');
}

function applyCleanup(input, before) {
  const dirty = git(input.worktree, ['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty) throw new Error('clean --apply requires a clean tracked worktree; commit the change before cleanup');
  const removed = [];
  for (const file of before.files) {
    const lines = file.findings
      .filter((finding) => finding.kind === 'cleanable')
      .map((finding) => finding.line)
      .sort((a, b) => b - a);
    if (!lines.length) continue;
    const target = contained(input.worktree, file.path);
    const content = fs.readFileSync(target, 'utf8');
    const scanned = scanText(content, file.language);
    for (const line of lines) {
      const item = scanned[line - 1];
      if (!item || !item.comment || !item.cleanable) throw new Error(`file changed while cleaning: ${file.path}:${line}`);
      scanned[line - 1].remove = true;
      removed.push({ path: file.path, line });
    }
    const next = content.split('\n').filter((_, index) => !scanned[index].remove).join('\n');
    fs.writeFileSync(target, next);
  }
  return removed;
}

function main(argv = process.argv.slice(2)) {
  const input = argumentsFor(argv);
  const before = analyze(input.worktree, input.base);
  if (input.command === 'check') {
    if (input.json) console.log(JSON.stringify({ ticket: input.ticket, ...before }, null, 2));
    else printCheck(before, input.ticket);
    return before.ok ? 0 : 1;
  }
  if (!input.apply) {
    const result = {
      ticket: input.ticket,
      command: 'clean',
      apply: false,
      ok: before.ok,
      json: input.json,
      before,
    };
    printClean(result, input.ticket, before);
    return before.ok ? 0 : 1;
  }
  const removed = applyCleanup(input, before);
  const after = analyze(input.worktree, input.base, { workingTree: true });
  const result = {
    ticket: input.ticket,
    command: 'clean',
    apply: true,
    removed,
    before,
    after,
    ok: after.ok,
    json: input.json,
    requires_amend: removed.length > 0,
  };
  printClean(result, input.ticket, before, removed);
  return result.ok ? 0 : 1;
}

module.exports = {
  MAX_COMMENT_RATIO,
  languageFor,
  protectedComment,
  scanText,
  parseDiff,
  analyze,
  argumentsFor,
  main,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`comment-policy: ${error.message}\n`);
    process.exitCode = 2;
  }
}
