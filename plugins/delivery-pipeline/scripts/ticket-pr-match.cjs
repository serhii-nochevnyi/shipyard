'use strict';

// Shared ticket↔PR matching for state-sync.cjs and pipeline-stats.cjs.
//
// Primary key: exact head-branch match against tickets.json's canonical branch.
// Fallback: ticket-ID marker in the PR title ("T-02-06: …", "… (T-02-06)") or a
// `ticket/<ID>-` branch prefix — needed because a re-decompose can rename the
// canonical branch slug and orphan an already-merged PR (observed in the wild:
// merged work re-surfacing on the board as `ready`).
//
// Several workspaces can deliver into the SAME repo with colliding ticket IDs
// (two different "T-01-01"s), so an ID hit alone is not enough: fallback
// candidates must also clear a title-similarity threshold vs the ticket title.

const PR_STATE_RANK = { MERGED: 0, OPEN: 1, CLOSED: 2 };
const SIMILARITY_MIN = 0.5;

function tokens(s) {
  return new Set(
    String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  );
}

// share of the ticket-title tokens that also appear in the PR title
function titleSimilarity(ticketTitle, prTitle) {
  const want = tokens(ticketTitle);
  if (!want.size) return 0;
  const got = tokens(prTitle);
  let hit = 0;
  for (const w of want) if (got.has(w)) hit++;
  return hit / want.size;
}

function hasIdMarker(id, pr) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w-])${esc}([^\\w-]|$)`);
  return re.test(pr.title || '') || String(pr.headRefName || '').startsWith(`ticket/${id}-`);
}

// prs: rows from `gh pr list --json number,state,title,headRefName,...`
// → { pr, matchedBy: 'branch' | 'marker' } | null
function matchTicketPr(id, ticket, prs) {
  const exact = prs
    .filter((p) => p.headRefName === ticket.branch)
    .sort((a, b) => (PR_STATE_RANK[a.state] ?? 9) - (PR_STATE_RANK[b.state] ?? 9));
  if (exact.length) return { pr: exact[0], matchedBy: 'branch' };

  const candidates = prs
    .filter((p) => hasIdMarker(id, p))
    .map((p) => ({ p, sim: titleSimilarity(ticket.title, p.title) }))
    .filter((c) => c.sim >= SIMILARITY_MIN)
    .sort(
      (a, b) =>
        (PR_STATE_RANK[a.p.state] ?? 9) - (PR_STATE_RANK[b.p.state] ?? 9) || b.sim - a.sim
    );
  return candidates.length ? { pr: candidates[0].p, matchedBy: 'marker' } : null;
}

module.exports = { matchTicketPr, titleSimilarity, PR_STATE_RANK };
