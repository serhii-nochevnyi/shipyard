#!/usr/bin/env node
'use strict';

// Gate 1 structural validator for an investigation package.
//
//   validate-inv.cjs <INV-dir>
//
// Checks structure only (content quality is the human gate):
//   - all required artifacts exist and have non-stub content
//   - OPEN-QUESTIONS.md has no unchecked "- [ ]" items
//   - DECISIONS.md contains at least one decision entry ("## ")
// Exit 0 = structurally ready to close; non-zero lists what is missing.

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: validate-inv.cjs <path-to-INV-dir>');
  process.exit(2);
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`validate-inv: not a directory: ${dir}`);
  process.exit(1);
}

const REQUIRED = ['PROBLEM.md', 'RESEARCH.md', 'OPTIONS.md', 'RISKS.md', 'OPEN-QUESTIONS.md', 'DECISIONS.md'];
const MIN_BODY_CHARS = 200; // below this an artifact is still a template stub

const errors = [];

function body(text) {
  // strip headings, comments and blank lines to measure real content
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('<!--'))
    .join('\n');
}

for (const f of REQUIRED) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) {
    errors.push(`${f}: missing`);
    continue;
  }
  const text = fs.readFileSync(p, 'utf8');
  if (body(text).length < MIN_BODY_CHARS && f !== 'OPEN-QUESTIONS.md') {
    errors.push(`${f}: looks like an unfilled stub (<${MIN_BODY_CHARS} chars of content)`);
  }
  if (f === 'OPEN-QUESTIONS.md') {
    const open = text.split('\n').filter((l) => /^\s*-\s*\[ \]/.test(l));
    if (open.length) {
      errors.push(`OPEN-QUESTIONS.md: ${open.length} question(s) still open:`);
      for (const q of open) errors.push(`    ${q.trim()}`);
    }
  }
  if (f === 'DECISIONS.md' && !/^##\s+/m.test(text)) {
    errors.push('DECISIONS.md: no decision entries (expected "## <decision title>" sections)');
  }
}

if (errors.length) {
  console.error(`validate-inv: NOT READY (${errors.length} issue(s))`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`validate-inv: OK — ${path.basename(dir)} is structurally ready for Gate 1 close`);
