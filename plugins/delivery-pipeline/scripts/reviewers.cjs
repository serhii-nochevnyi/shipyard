#!/usr/bin/env node
'use strict';

// Reviewer plumbing for the babysit loop.
//
//   reviewers.cjs reinit     <pr> [--json] [--force]
//        re-initialize the bot reviewers after a push: CodeRabbit full re-review
//        + re-request Copilot. Idempotent by design (see below).
//   reviewers.cjs unresolved <pr>
//        print unresolved review threads as JSON (input for the review-fix agent)
//   reviewers.cjs status     <pr> [--json]
//        which bot reviewers have ACTUALLY engaged on this PR
//
// Copilot does not re-review a push on its own — it must be re-requested.
// A missing/disabled reviewer is a warning, not a failure, but the warning now
// carries the real API error: the previous blanket "reviewer unavailable on this
// repo" masked payload bugs indistinguishably from a repo without Copilot.
//
// CodeRabbit re-review is requested by posting a comment, and the babysit loop
// calls reinit after EVERY push — which turned into an unbounded comment stream
// on repos where CodeRabbit is not installed at all. So reinit only asks again
// once the bot has actually responded to the previous ask (`--force` overrides).

const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const cmd = argv[0];
const pr = Number(argv[1]);
const asJson = argv.includes('--json');
const force = argv.includes('--force');

// A PR NUMBER means nothing without a repo, and this script resolves the repo
// from the current directory. In a multi-repo phase that is a live hazard: run it
// from the wrong checkout and `reinit` posts "@coderabbitai full review" on some
// unrelated PR that happens to share the number. `--repo owner/name` pins it.
const repoIdx = argv.indexOf('--repo');
const REPO = repoIdx === -1 ? null : String(argv[repoIdx + 1] || '');
if (repoIdx !== -1 && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(REPO)) {
  console.error(`reviewers: --repo "${REPO}" is not an owner/name slug`);
  process.exit(2);
}
const REPO_ARG = REPO ? ['--repo', REPO] : [];
const OWNER_REPO = REPO || '{owner}/{repo}';

if (!['reinit', 'unresolved', 'status'].includes(cmd) || !Number.isInteger(pr) || pr <= 0) {
  console.error('usage: reviewers.cjs <reinit|unresolved|status> <pr-number> [--json] [--force] [--repo owner/name]');
  process.exit(2);
}

function gh(args, { tolerate = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    const msg = `gh ${args.join(' ')} failed: ${detail}`;
    if (tolerate) return { error: detail };
    console.error(`reviewers: ${msg}`);
    process.exit(1);
  }
}

function ghJson(args, fallback) {
  const out = gh(args, { tolerate: true });
  if (typeof out !== 'string') return fallback;
  try { return JSON.parse(out); } catch { return fallback; }
}

const CODERABBIT = 'coderabbitai';
const COPILOT_BOT = 'copilot-pull-request-reviewer[bot]';
const REVIEW_MARKER = '@coderabbitai full review';

const isCodeRabbit = (login) => String(login || '').toLowerCase().startsWith(CODERABBIT);
const isCopilot = (login) => String(login || '').toLowerCase().startsWith('copilot');

function prActivity() {
  const comments = ghJson(['api', `repos/${OWNER_REPO}/issues/${pr}/comments`, '--paginate'], []);
  const reviews = ghJson(['api', `repos/${OWNER_REPO}/pulls/${pr}/reviews`, '--paginate'], []);
  const at = (v) => (v ? Date.parse(v) : 0);
  const latest = (rows, pick) => rows.reduce((max, r) => Math.max(max, at(pick(r))), 0);

  return {
    lastRequest: latest(
      comments.filter((c) => String(c.body || '').includes(REVIEW_MARKER)),
      (c) => c.created_at
    ),
    lastCodeRabbit: Math.max(
      latest(comments.filter((c) => isCodeRabbit(c.user && c.user.login)), (c) => c.created_at),
      latest(reviews.filter((r) => isCodeRabbit(r.user && r.user.login)), (r) => r.submitted_at)
    ),
    lastCopilot: Math.max(
      latest(comments.filter((c) => isCopilot(c.user && c.user.login)), (c) => c.created_at),
      latest(reviews.filter((r) => isCopilot(r.user && r.user.login)), (r) => r.submitted_at)
    ),
  };
}

function report(result) {
  if (asJson) {
    const { lines, ...data } = result;
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  for (const line of result.lines) console.log(line);
}

if (cmd === 'status') {
  const a = prActivity();
  const result = {
    pr,
    coderabbit: { engaged: a.lastCodeRabbit > 0, last_activity: a.lastCodeRabbit ? new Date(a.lastCodeRabbit).toISOString() : null },
    copilot: { engaged: a.lastCopilot > 0, last_activity: a.lastCopilot ? new Date(a.lastCopilot).toISOString() : null },
    last_review_request: a.lastRequest ? new Date(a.lastRequest).toISOString() : null,
    lines: [
      `PR #${pr}: CodeRabbit ${a.lastCodeRabbit ? 'engaged' : 'NEVER responded'}, Copilot ${a.lastCopilot ? 'engaged' : 'NEVER responded'}`,
    ],
  };
  report(result);
  process.exit(0);
}

if (cmd === 'reinit') {
  const a = prActivity();
  const lines = [];
  const result = { pr, coderabbit: {}, copilot: {}, lines };

  // Ask CodeRabbit again only when it responded to the previous ask (or we have
  // never asked). Otherwise the ask is still outstanding and repeating it just
  // adds noise — on a repo without CodeRabbit, forever.
  const shouldAsk = force || a.lastRequest === 0 || a.lastCodeRabbit > a.lastRequest;
  if (shouldAsk) {
    // tolerated: a repo that rejects PR comments must not abort the babysit round
    const posted = gh(['pr', 'comment', String(pr), ...REPO_ARG, '--body', REVIEW_MARKER], { tolerate: true });
    if (typeof posted === 'string') {
      result.coderabbit = { requested: true, reason: force ? 'forced' : a.lastRequest === 0 ? 'first request' : 'bot responded to the previous request' };
      lines.push(`PR #${pr}: requested CodeRabbit full review`);
    } else {
      result.coderabbit = { requested: false, error: posted.error };
      lines.push(`PR #${pr}: CodeRabbit request FAILED — ${posted.error}`);
    }
  } else {
    result.coderabbit = { requested: false, reason: 'a previous request is still unanswered — not repeating it (use --force to override)' };
    lines.push(`PR #${pr}: CodeRabbit request skipped — the previous one is still unanswered${a.lastCodeRabbit === 0 ? ' (CodeRabbit has never responded on this PR — is it installed?)' : ''}`);
  }

  const copilot = gh(
    ['api', '-X', 'POST', `repos/${OWNER_REPO}/pulls/${pr}/requested_reviewers`,
     '-f', `reviewers[]=${COPILOT_BOT}`],
    { tolerate: true }
  );
  if (typeof copilot === 'string') {
    result.copilot = { requested: true };
    lines.push(`PR #${pr}: re-requested Copilot review`);
  } else {
    result.copilot = { requested: false, error: copilot.error };
    lines.push(`PR #${pr}: Copilot re-request FAILED — ${copilot.error}`);
    lines.push('  (if this repo has no Copilot code review enabled that is expected; otherwise the payload/permissions need attention — it is NOT silently fine)');
  }

  report(result);
  process.exit(0);
}

// cmd === 'unresolved'
const repo = REPO
  ? { owner: { login: REPO.split('/')[0] }, name: REPO.split('/')[1] }
  : JSON.parse(gh(['repo', 'view', '--json', 'owner,name']));
const query = `
query($owner: String!, $name: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            totalCount
            pageInfo { hasNextPage }
            nodes { author { login } body url }
          }
        }
      }
    }
  }
}`;

const threads = [];
let cursor = null;
for (;;) {
  const args = ['api', 'graphql',
    '-f', `query=${query}`,
    '-f', `owner=${repo.owner.login}`,
    '-f', `name=${repo.name}`,
    '-F', `pr=${pr}`];
  if (cursor) args.push('-f', `cursor=${cursor}`);
  const page = JSON.parse(gh(args)).data.repository.pullRequest.reviewThreads;
  threads.push(...page.nodes);
  if (!page.pageInfo.hasNextPage) break;
  cursor = page.pageInfo.endCursor;
}

const unresolved = threads
  .filter((t) => !t.isResolved)
  .map((t) => ({
    path: t.path,
    line: t.line,
    outdated: t.isOutdated,
    author: t.comments.nodes[0]?.author?.login ?? 'unknown',
    url: t.comments.nodes[0]?.url ?? null,
    comments: t.comments.nodes.map((c) => c.body),
    // a silently truncated thread would hide the reviewer's actual point
    comment_count: t.comments.totalCount,
    comments_truncated: t.comments.pageInfo.hasNextPage === true,
  }));

const truncatedThreads = unresolved.filter((t) => t.comments_truncated).map((t) => t.url);
console.log(JSON.stringify({
  pr,
  unresolved_count: unresolved.length,
  truncated_threads: truncatedThreads,
  threads: unresolved,
}, null, 2));
