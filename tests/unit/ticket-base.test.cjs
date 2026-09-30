'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveTicketBase } = require('../../plugins/delivery-pipeline/scripts/ticket-base.cjs');

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
