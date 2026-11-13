#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function repoOf(row) {
  return typeof row.repo === 'string' && row.repo.trim() ? row.repo.trim() : null;
}

const MERGE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const UNDELIVERED = new Set(['pending', 'branched']);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// @contract: only the epic's own MERGED PR into its integration branch, with a merge sha, retires it.
function retiredEpicProof(proof, epic) {
  return object(proof) && nonEmpty(epic) && Number.isSafeInteger(proof.number) && proof.number > 0
    && proof.state === 'MERGED' && proof.branch === epic && nonEmpty(proof.base) && proof.base !== epic
    && typeof proof.merge_sha === 'string' && MERGE_SHA.test(proof.merge_sha);
}

// @contract: leave the epic only for a proven retired epic; an open PR must already target its integration branch.
function retiredEpicBase(row, board, parentState = null) {
  if (!object(row) || !object(board)) return null;
  const proof = board.epic_retired;
  if (!retiredEpicProof(proof, row.epic) || board.integration_branch !== proof.base) return null;
  if (board.status === 'pr-open' ? board.pr_base !== proof.base : !UNDELIVERED.has(board.status)) return null;
  if (parentState === null) return row.pr_base === row.epic ? proof.base : null;
  if (!object(parentState) || parentState.status !== 'merged') return null;
  if (parentState.merged_into === proof.base) return proof.base;
  if (parentState.merged_into !== row.epic) return null;
  const parentProof = parentState.epic_pr;
  if (!object(parentProof) || parentProof.number !== proof.number || parentProof.state !== 'MERGED'
      || parentProof.branch !== row.epic || parentProof.base !== proof.base
      || (parentProof.merge_sha !== undefined && parentProof.merge_sha !== proof.merge_sha)) return null;
  return proof.base;
}

// @contract: a parent merged outside its epic is a valid base only once the board proves that epic retired.
function mergedParentBase(row, board, parentState) {
  const retired = retiredEpicBase(row, board, parentState);
  if (retired) return retired;
  return !nonEmpty(row.epic) || parentState.merged_into === row.epic ? parentState.merged_into : null;
}

function rootTicketBase(row, board) {
  return retiredEpicBase(row, board) || row.pr_base;
}

function resolveTicketBase({ ticket, requestedBase, graph, state }) {
  if (typeof ticket !== 'string' || !ticket.trim()) {
    throw refusal('TICKET_REQUIRED', 'ticket id is required');
  }
  if (typeof requestedBase !== 'string' || !requestedBase.trim()) {
    throw refusal('BASE_REQUIRED', 'requested base is required');
  }
  if (!object(graph) || !object(graph.tickets)) {
    throw refusal('GRAPH_UNAVAILABLE', 'canonical ticket graph is unavailable');
  }
  const row = graph.tickets[ticket];
  if (!object(row) || typeof row.branch !== 'string' || typeof row.pr_base !== 'string') {
    return requestedBase;
  }

  const board = object(state) && object(state.tickets) ? state.tickets[ticket] : state && state[ticket];
  if (!object(board)) {
    throw refusal('BOARD_UNAVAILABLE', `ticket ${ticket} has no live delivery-board row`);
  }
  if (board.branch !== row.branch) {
    throw refusal('BOARD_MISMATCH', `ticket ${ticket} delivery-board branch differs from the canonical graph`);
  }
  if (typeof board.base !== 'string' || !board.base.trim()) {
    throw refusal('BOARD_UNAVAILABLE', `ticket ${ticket} has no live base on the delivery board`);
  }

  const parentId = typeof row.primary_parent === 'string' ? row.primary_parent : null;
  const parent = parentId && graph.tickets[parentId];
  const parentState = parentId && (object(state) && object(state.tickets) ? state.tickets : state)[parentId];
  if (parentId && object(parent) && repoOf(parent) === repoOf(row)) {
    if (parent.branch !== row.pr_base || !object(parentState) || parentState.branch !== parent.branch) {
      throw refusal('BOARD_MISMATCH', `ticket ${ticket} primary parent differs between the graph and delivery board`);
    }
    if (parentState.status === 'merged') {
      if (typeof parentState.merged_into !== 'string' || !parentState.merged_into.trim()
          || board.base !== mergedParentBase(row, board, parentState)) {
        throw refusal('BOARD_MISMATCH', `ticket ${ticket} live base does not match its merged primary parent`);
      }
    } else if (parentState.status === 'branched' || parentState.status === 'pr-open') {
      if (board.base !== parent.branch) {
        throw refusal('BOARD_MISMATCH', `ticket ${ticket} live base does not match its available primary parent`);
      }
    } else {
      throw refusal('PARENT_NOT_READY', `ticket ${ticket} primary parent ${parentId} is ${parentState.status || 'unavailable'}`);
    }
  }

  if (requestedBase !== row.pr_base && requestedBase !== board.base) {
    throw refusal('BASE_MISMATCH', `requested base ${requestedBase} is neither the canonical parent nor the live delivery base ${board.base}`);
  }
  return board.base;
}

function readJson(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') {
      const code = label === 'delivery board' ? 'BOARD_UNAVAILABLE' : 'GRAPH_UNAVAILABLE';
      throw refusal(code, `${label} is missing: ${file}`);
    }
    throw refusal('GRAPH_UNAVAILABLE', `cannot inspect ${label}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
    throw refusal('GRAPH_UNAVAILABLE', `${label} must be a bounded regular file`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw refusal('GRAPH_UNAVAILABLE', `cannot parse ${label}: ${error.message}`); }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--graph-dir', '--ticket', '--requested-base'].includes(flag)) {
      throw refusal('USAGE', `unknown argument ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw refusal('USAGE', `${flag} needs a value`);
    values[flag.slice(2).replace(/-/g, '_')] = value;
    index++;
  }
  return values;
}

function cli() {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (command !== 'resolve') throw refusal('USAGE', 'usage: ticket-base.cjs resolve --graph-dir <dir> --ticket <id> --requested-base <ref>');
    const values = parseArgs(argv);
    if (!values.graph_dir || !values.ticket || !values.requested_base) {
      throw refusal('USAGE', 'resolve requires --graph-dir, --ticket and --requested-base');
    }
    const graphDir = path.resolve(values.graph_dir || '.planning/graph');
    const graph = readJson(path.join(graphDir, 'tickets.json'), 'ticket graph');
    const row = object(graph) && object(graph.tickets) && graph.tickets[values.ticket];
    if (!object(row) || typeof row.branch !== 'string' || typeof row.pr_base !== 'string') {
      process.stdout.write(`${values.requested_base || ''}\n`);
      return;
    }
    const state = readJson(path.join(graphDir, 'delivery-state.json'), 'delivery board');
    process.stdout.write(`${resolveTicketBase({ ticket: values.ticket, requestedBase: values.requested_base, graph, state })}\n`);
  } catch (error) {
    process.stderr.write(`ticket-base: ${error.code || 'ERROR'}: ${error.message}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

if (require.main === module) cli();

module.exports = { resolveTicketBase, retiredEpicProof, retiredEpicBase, mergedParentBase, rootTicketBase, MAX_BYTES };
