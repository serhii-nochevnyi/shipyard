#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
const { TICKET_ID_RE, REPO_RE } = require(path.join(__dirname, 'jira-export.cjs'));

const SCHEMA = 'shipyard.pr-ledger.v1';
const STORE_NAME = 'pr-ledger.json';
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function storeFile(dir) {
  return path.join(dir, STORE_NAME);
}

function lockRootFor(dir) {
  return path.resolve(dir, '..', '..');
}

function safeBranch(value, label) {
  if (typeof value !== 'string' || !BRANCH_RE.test(value) || value.includes('..') || value.startsWith('-')) {
    throw new Error(`${label} is not a safe branch name`);
  }
  return value;
}

function validTicket(id) {
  if (!TICKET_ID_RE.test(String(id || ''))) {
    throw new Error(`"${id}" is not a valid ticket id — expected T-NN-NN (e.g. T-01-02)`);
  }
  return id;
}

function validNumber(value) {
  const str = typeof value === 'number' ? String(value) : value;
  if (typeof str !== 'string' || !/^[1-9]\d*$/.test(str)) {
    throw new Error(`"${value}" is not a positive integer PR number`);
  }
  return Number(str);
}

function validRepo(repo) {
  if (repo === undefined || repo === null || repo === '') return null;
  if (!REPO_RE.test(String(repo))) {
    throw new Error(`"${repo}" is not a valid repo — expected owner/name`);
  }
  return repo;
}

function readLedger(graphDir) {
  const file = storeFile(graphDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { schema: SCHEMA, entries: {} };
    throw new Error(`pr-ledger: cannot read ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`pr-ledger: ${file} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.schema !== SCHEMA
      || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    throw new Error(`pr-ledger: ${file} does not match schema "${SCHEMA}"`);
  }
  return parsed;
}

function recordPr({ graphDir, ticket, number, head, repo, replace = false }) {
  const id = validTicket(ticket);
  const n = validNumber(number);
  const branch = safeBranch(head, '--head');
  const repoValue = validRepo(repo);
  fs.mkdirSync(graphDir, { recursive: true });
  return withLock(lockDirFor(lockRootFor(graphDir)), 'pr-ledger', () => {
    const store = readLedger(graphDir);
    const existing = store.entries[id];
    if (existing && existing.number !== n && !replace) {
      throw new Error(
        `${id} is already recorded against PR #${existing.number}; refusing to record #${n}`
      );
    }
    const entry = { number: n, head: branch, repo: repoValue, created_at: new Date().toISOString() };
    store.entries[id] = entry;
    writeAtomic(storeFile(graphDir), JSON.stringify(store, null, 2) + '\n');
    return entry;
  }, { label: 'pr-ledger' });
}

module.exports = { recordPr, readLedger, SCHEMA, STORE_NAME };
