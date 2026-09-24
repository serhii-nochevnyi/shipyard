#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const out = { remove: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remove') out.remove = true;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--')) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail(`${arg} needs a value`);
      out[arg.slice(2)] = value;
    } else fail(`unknown argument: ${arg}`);
  }
  return out;
}

function tomlBasic(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map(tomlBasic).join(', ')}]`;
}

function decodeString(raw) {
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { fail('notify contains an invalid basic TOML string'); }
  }
  return raw.slice(1, -1);
}

function parseStringArray(raw) {
  const values = [];
  let i = 1;
  while (i < raw.length - 1) {
    while (i < raw.length - 1 && /[\s,]/.test(raw[i])) i++;
    if (i >= raw.length - 1) break;
    const quote = raw[i];
    if (quote !== '"' && quote !== "'") fail('notify must be an array of strings');
    const start = i++;
    let escaped = false;
    while (i < raw.length - 1) {
      if (quote === '"' && !escaped && raw[i] === '\\') { escaped = true; i++; continue; }
      if (!escaped && raw[i] === quote) break;
      escaped = false;
      i++;
    }
    if (i >= raw.length - 1) fail('notify contains an unterminated string');
    values.push(decodeString(raw.slice(start, ++i)));
    while (i < raw.length - 1 && /\s/.test(raw[i])) i++;
    if (i < raw.length - 1 && raw[i] !== ',') fail('notify array has an invalid separator');
  }
  return values;
}

function arrayEnd(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && !escaped && c === '\\') { escaped = true; continue; }
      if (!escaped && c === quote) quote = null;
      escaped = false;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') {
      const end = text.indexOf('\n', i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function findNotify(text) {
  const lines = text.split('\n');
  let offset = 0;
  let tableSeen = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line) && !/^\s*#/.test(line)) tableSeen = true;
    if (!tableSeen) {
      const match = /^(\s*)notify\s*=\s*/.exec(line);
      if (match) {
        const keyStart = offset;
        const valueStart = offset + match[0].length;
        if (text[valueStart] !== '[') fail('notify must be a TOML array');
        const end = arrayEnd(text, valueStart);
        if (end === -1) fail('notify array is incomplete');
        const lineEnd = text.indexOf('\n', end);
        const tail = text.slice(end, lineEnd === -1 ? text.length : lineEnd);
        if (tail.trim() && !/^\s*#/.test(tail)) fail('notify has unexpected text after its array');
        const raw = text.slice(valueStart, end);
        return {
          exists: true,
          argv: parseStringArray(raw),
          start: keyStart,
          end,
          replacement: `${match[1]}notify = `,
        };
      }
    }
    offset += line.length + 1;
  }
  return { exists: false, argv: null };
}

function replaceNotify(text, argv) {
  const found = findNotify(text);
  const value = `notify = ${tomlArray(argv)}\n`;
  if (!found.exists) {
    return `${value}${text}`;
  }
  const lineStart = found.start;
  const lineEnd = text.indexOf('\n', found.end);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const tail = text.slice(found.end, end);
  const prefix = text.slice(lineStart, lineStart + found.replacement.length);
  return text.slice(0, lineStart) + `${prefix}${tomlArray(argv)}${tail}` + text.slice(end);
}

function resolvedTarget(file) {
  if (!fs.existsSync(file)) return file;
  const stat = fs.lstatSync(file);
  if (!stat.isSymbolicLink()) return file;
  try { return fs.realpathSync(file); } catch { fail(`refusing dangling config symlink: ${file}`); }
}

function writeAtomic(file, text, mode = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, text, { mode: mode || 0o600 });
    if (mode !== null) fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function verifyToml(file) {
  const result = spawnSync('python3', ['-c', [
    'import sys',
    'try:',
    '    import tomllib',
    'except Exception:',
    '    sys.exit(2)',
    'with open(sys.argv[1], "rb") as f:',
    '    tomllib.load(f)',
  ].join('\n'), file], { encoding: 'utf8' });
  if (result.error || result.status === 2) return 'skipped';
  if (result.status !== 0) fail(`Codex config does not parse as TOML: ${(result.stderr || '').trim()}`);
  return 'verified';
}

function readSidecar(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || !Array.isArray(value.delegate) && value.delegate !== null) return null;
    return value;
  } catch {
    return null;
  }
}

function isWrapper(argv, wrapper) {
  return Array.isArray(argv) && argv.some((value) => path.resolve(value) === path.resolve(wrapper));
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.config || !args.wrapper || !args['delegate-file']) {
    fail('usage: configure-codex-notify.cjs --config <file> --wrapper <file> --delegate-file <file> [--remove] [--json]');
  }
  const config = path.resolve(args.config);
  const wrapper = path.resolve(args.wrapper);
  const delegateFile = path.resolve(args['delegate-file']);
  const target = resolvedTarget(config);
  const existing = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const found = findNotify(existing);
  const currentSidecar = readSidecar(delegateFile);

  if (args.remove) {
    if (!found.exists || !isWrapper(found.argv, wrapper)) {
      return { changed: false, verification: 'not-installed' };
    }
    if (!currentSidecar) fail(`cannot remove Codex notify wrapper without a valid delegate record: ${delegateFile}`);
    const restored = currentSidecar.had_notify ? currentSidecar.delegate : null;
    const next = restored ? replaceNotify(existing, restored) : (() => {
      let start = found.start;
      if (start > 0 && existing[start - 1] === '\n') start--;
      const lineEnd = existing.indexOf('\n', found.end);
      const end = lineEnd === -1 ? existing.length : lineEnd;
      return existing.slice(0, start) + existing.slice(end + (lineEnd === -1 ? 0 : 1));
    })();
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
    writeAtomic(target, next, mode);
    try { fs.unlinkSync(delegateFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { changed: true, verification: verifyToml(target), restored: restored || null };
  }

  let delegate;
  let hadNotify = found.exists;
  if (found.exists && isWrapper(found.argv, wrapper)) {
    if (!currentSidecar) fail(`Codex notify is already wrapped but its delegate record is missing: ${delegateFile}`);
    delegate = currentSidecar.delegate;
    hadNotify = currentSidecar.had_notify === true;
  } else {
    delegate = found.argv;
  }
  const next = replaceNotify(existing, [process.execPath, wrapper]);
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const sidecar = {
    version: 1,
    wrapper,
    had_notify: hadNotify,
    delegate: delegate || null,
  };
  const previousSidecar = fs.existsSync(delegateFile) ? fs.readFileSync(delegateFile, 'utf8') : null;
  try {
    writeAtomic(delegateFile, JSON.stringify(sidecar, null, 2) + '\n');
    writeAtomic(target, next, mode);
  } catch (error) {
    if (previousSidecar === null) {
      try { fs.unlinkSync(delegateFile); } catch {}
    } else {
      try { writeAtomic(delegateFile, previousSidecar); } catch {}
    }
    throw error;
  }
  return { changed: true, verification: verifyToml(target), delegate: delegate || null };
}

if (require.main === module) {
  try {
    const result = main();
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(result) + '\n');
    else process.stdout.write(`Codex notify observer ${result.changed ? 'installed' : 'already installed'} (${result.verification})\n`);
  } catch (error) {
    process.stderr.write(`configure-codex-notify: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { findNotify, parseStringArray, replaceNotify, main };
