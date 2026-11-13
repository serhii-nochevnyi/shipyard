'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveTicketBase, retiredEpicBase, mergedParentBase, rootTicketBase,
} = require('../../plugins/delivery-pipeline/scripts/ticket-base.cjs');

function fixture(parentStatus = 'merged', boardBase = 'epic/43') {
  const parentBranch = 'ticket/T-43-06-parent';
  const parent = { branch: parentBranch, pr_base: 'epic/43', epic: 'epic/43', files: ['src/parent.js'] };
  const child = {
    branch: 'ticket/T-43-17-child', pr_base: parentBranch, primary_parent: 'T-43-06',
    epic: 'epic/43', files: ['src/child.js'],
  };
  return {
    parentBranch,
    graph: { tickets: { 'T-43-06': parent, 'T-43-17': child } },
    state: {
      'T-43-06': { branch: parentBranch, status: parentStatus, merged_into: parentStatus === 'merged' ? 'epic/43' : undefined },
      'T-43-17': { branch: child.branch, status: 'pending', base: boardBase },
    },
  };
}

test('uses the live epic when the canonical primary parent has merged', () => {
  const value = fixture();
  assert.equal(resolveTicketBase({
    ticket: 'T-43-17', requestedBase: value.parentBranch, graph: value.graph, state: value.state,
  }), 'epic/43');
});

test('keeps an available unmerged primary parent as the worktree base', () => {
  const value = fixture('pr-open', 'ticket/T-43-06-parent');
  assert.equal(resolveTicketBase({
    ticket: 'T-43-17', requestedBase: value.parentBranch, graph: value.graph, state: value.state,
  }), value.parentBranch);
});

test('refuses an unrelated requested ref before worktree creation', () => {
  const value = fixture();
  assert.throws(() => resolveTicketBase({
    ticket: 'T-43-17', requestedBase: 'main', graph: value.graph, state: value.state,
  }), { code: 'BASE_MISMATCH' });
});

test('refuses a live base that disagrees with the merged parent proof', () => {
  const value = fixture('merged', 'ticket/T-43-06-parent');
  assert.throws(() => resolveTicketBase({
    ticket: 'T-43-17', requestedBase: value.parentBranch, graph: value.graph, state: value.state,
  }), { code: 'BOARD_MISMATCH' });
});

test('refuses a child whose primary parent is not yet branchable', () => {
  const value = fixture('pending', 'epic/43');
  assert.throws(() => resolveTicketBase({
    ticket: 'T-43-17', requestedBase: value.parentBranch, graph: value.graph, state: value.state,
  }), { code: 'PARENT_NOT_READY' });
});

test('leaves legacy graphs without canonical branch metadata on their supplied base', () => {
  assert.equal(resolveTicketBase({
    ticket: 'T-01', requestedBase: 'main', graph: { tickets: { 'T-01': { files: ['src/a.js'] } } }, state: {},
  }), 'main');
});

const EPIC_MERGE = 'f'.repeat(40);

function retiredFixture(overrides = {}) {
  const value = fixture('merged', 'main');
  const proof = { number: 257, branch: 'epic/43', state: 'MERGED', base: 'main', merge_sha: EPIC_MERGE };
  value.state['T-43-06'].epic_pr = { ...proof, landed: false };
  Object.assign(value.state['T-43-17'], {
    status: 'pr-open', pr: 258, pr_base: 'main', integration_branch: 'main', epic: 'epic/43',
    epic_retired: { ...proof }, ...overrides,
  });
  return value;
}

function resolve(value, requestedBase = 'main') {
  return resolveTicketBase({ ticket: 'T-43-17', requestedBase, graph: value.graph, state: value.state });
}

test('a verified merged epic and a PR retargeted to the integration branch resolve the integration branch', () => {
  const value = retiredFixture();
  assert.equal(resolve(value), 'main');
  assert.equal(resolve(value, value.parentBranch), 'main');
  assert.equal(value.state['T-43-06'].merged_into, 'epic/43');
});

test('a merged parent inside a still-open epic keeps the epic as the base', () => {
  const value = fixture('merged', 'epic/43');
  Object.assign(value.state['T-43-17'], { status: 'pr-open', pr_base: 'epic/43', integration_branch: 'main' });
  assert.equal(resolve(value, 'epic/43'), 'epic/43');
  const retargeted = fixture('merged', 'main');
  Object.assign(retargeted.state['T-43-17'], { status: 'pr-open', pr_base: 'main', integration_branch: 'main' });
  assert.throws(() => resolve(retargeted), { code: 'BOARD_MISMATCH' });
});

test('an unverified epic retirement stays fail closed', () => {
  const unverified = {
    'closed-unmerged epic PR': (v) => { v.state['T-43-17'].epic_retired.state = 'CLOSED'; },
    'missing merge commit': (v) => { delete v.state['T-43-17'].epic_retired.merge_sha; },
    'epic merged elsewhere': (v) => { v.state['T-43-17'].epic_retired.base = 'release'; },
    'proof for another epic': (v) => { v.state['T-43-17'].epic_retired.branch = 'epic/44'; },
    'ticket PR still on the epic': (v) => { v.state['T-43-17'].pr_base = 'epic/43'; },
    'ticket already delivered': (v) => { v.state['T-43-17'].status = 'merged'; },
    'board lacks the integration branch': (v) => { delete v.state['T-43-17'].integration_branch; },
    'parent epic proof disagrees': (v) => { v.state['T-43-06'].epic_pr.number = 300; },
    'parent epic proof missing': (v) => { delete v.state['T-43-06'].epic_pr; },
    'parent epic proof other merge': (v) => { v.state['T-43-06'].epic_pr.merge_sha = 'e'.repeat(40); },
    'parent merged into another branch': (v) => { v.state['T-43-06'].merged_into = 'ticket/other'; },
  };
  for (const [name, mutate] of Object.entries(unverified)) {
    const value = retiredFixture();
    mutate(value);
    assert.throws(() => resolve(value), { code: 'BOARD_MISMATCH' }, name);
  }
});

test('an unreadable primary parent stays fail closed after the epic retired', () => {
  const value = retiredFixture();
  delete value.state['T-43-06'];
  assert.throws(() => resolve(value), { code: 'BOARD_MISMATCH' });
  const child = value.graph.tickets['T-43-17'];
  assert.equal(retiredEpicBase(child, value.state['T-43-17'], undefined), null);
});

test('every consumer helper agrees on the retired-epic base', () => {
  const value = retiredFixture();
  const child = value.graph.tickets['T-43-17'];
  const board = value.state['T-43-17'];
  assert.equal(mergedParentBase(child, board, value.state['T-43-06']), 'main');
  assert.equal(mergedParentBase(child, { ...board, epic_retired: undefined }, value.state['T-43-06']), 'epic/43');
  const root = { branch: 'ticket/T-43-01-root', pr_base: 'epic/43', epic: 'epic/43' };
  assert.equal(rootTicketBase(root, board), 'main');
  assert.equal(rootTicketBase(root, { ...board, pr_base: 'epic/43' }), 'epic/43');
  assert.equal(rootTicketBase({ ...root, pr_base: 'ticket/foreign' }, board), 'ticket/foreign');
});

function undeliveredFixture(status, parentMergedInto) {
  const value = retiredFixture();
  const child = value.state['T-43-17'];
  child.status = status;
  delete child.pr;
  delete child.pr_base;
  if (parentMergedInto === 'main') {
    value.state['T-43-06'].merged_into = 'main';
    delete value.state['T-43-06'].epic_pr;
  }
  return value;
}

test('a ticket without a PR leaves a verified merged epic for the integration branch', () => {
  for (const status of ['pending', 'branched']) {
    for (const mergedInto of ['epic/43', 'main']) {
      const value = undeliveredFixture(status, mergedInto);
      assert.equal(resolve(value, value.parentBranch), 'main', `${status}/${mergedInto}`);
    }
  }
});

test('a parent merged into the integration branch without a retired-epic proof fails closed', () => {
  for (const boardBase of ['main', 'epic/43']) {
    const value = undeliveredFixture('pending', 'main');
    delete value.state['T-43-17'].epic_retired;
    value.state['T-43-17'].base = boardBase;
    assert.throws(() => resolve(value, value.parentBranch), { code: 'BOARD_MISMATCH' }, boardBase);
    const child = value.graph.tickets['T-43-17'];
    assert.equal(mergedParentBase(child, value.state['T-43-17'], value.state['T-43-06']), null);
  }
});
