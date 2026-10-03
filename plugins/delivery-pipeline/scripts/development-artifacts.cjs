'use strict';

const { execFileSync } = require('node:child_process');

const PREFIXES = Object.freeze(['.planning/', '.shipyard/', '.shipyard-', 'docs/audits/']);
const FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md']);

function isDevelopmentArtifact(file) {
  let relative = String(file).replaceAll('\\', '/');
  if (relative.startsWith('./')) relative = relative.slice(2);
  if (relative.split('/').some(part => part === '..') || relative.startsWith('/')) return false;
  return FILES.includes(relative) || relative === '.planning' || relative === '.shipyard'
    || PREFIXES.some(prefix => relative.startsWith(prefix));
}

function productPathspec() {
  return ['--', '.', ...PREFIXES.map(prefix => `:(exclude)${prefix.endsWith('/') ? prefix.slice(0, -1) : prefix + '*'}`),
    ...FILES.map(file => `:(exclude)${file}`)];
}

function changedProductPaths(base, head = 'HEAD', cwd = process.cwd()) {
  const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head],
    { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  return paths.filter(file => !isDevelopmentArtifact(file));
}

if (require.main === module) {
  const base = process.argv[2];
  if (!base) throw new Error('usage: development-artifacts.cjs <base> [head]');
  const paths = changedProductPaths(base, process.argv[3] || 'HEAD');
  process.stdout.write(`product_changes=${paths.length > 0}\n`);
}

module.exports = { isDevelopmentArtifact, productPathspec, changedProductPaths };
