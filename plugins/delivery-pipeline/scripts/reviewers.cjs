#!/usr/bin/env node
'use strict';

// Reviewer plumbing for the babysit loop.
//
//   reviewers.cjs reinit     <pr> [--json] [--force]
//        re-initialize the bot reviewers after a push: CodeRabbit full re-review
//        + re-request Copilot. Idempotent by design (see below).
//   reviewers.cjs unresolved <pr>
//        print unresolved review threads as JSON (input for the review-fix agent)
//   reviewers.cjs feedback   <pr>
//        EVERYTHING a reviewer said, in one call: unresolved threads + the bots'
//        PR-level comments (CodeRabbit's summary/nitpick blocks, Copilot's
//        remarks) + review verdicts + engagement. Threads alone miss the
//        PR-level half, which is where CodeRabbit files most of its findings —
//        a fixer working from `unresolved` only never saw them.
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

if (!['reinit', 'unresolved', 'status', 'feedback', 'resolve'].includes(cmd) || !Number.isInteger(pr) || pr <= 0) {
  console.error('usage: reviewers.cjs <reinit|unresolved|feedback|status> <pr-number> [--json] [--force] [--repo owner/name]\n' +
                '       reviewers.cjs resolve <pr-number> <threadId> [<threadId> ...] [--repo owner/name]');
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

// cmd === 'resolve' — mark threads resolved by their GraphQL node id.
//
// This exists because "resolve the thread" was an instruction with no tool
// behind it: the ids were not in the payload, and assembling the mutation by
// hand is the kind of step that quietly does not happen. A thread answered but
// left open is indistinguishable, to every counter downstream, from a thread
// ignored — the merge gate refuses on it and the guard re-serves the same PR.
if (cmd === 'resolve') {
  const ids = argv.slice(2).filter((a) => !a.startsWith('--') && a !== String(pr) && argv[argv.indexOf(a) - 1] !== '--repo');
  if (!ids.length) {
    console.error('reviewers: resolve needs at least one threadId (get them from `reviewers.cjs unresolved <pr>`)');
    process.exit(2);
  }
  const done = [];
  const failed = [];
  for (const id of ids) {
    const out = gh([
      'api', 'graphql',
      '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}',
      '-f', `id=${id}`,
    ], { tolerate: true });
    if (typeof out === 'string' && /"isResolved"\s*:\s*true/.test(out)) done.push(id);
    else failed.push({ id, error: typeof out === 'string' ? out.trim().slice(0, 160) : out.error });
  }
  // Report failures loudly: a half-resolved round that reads as success is how
  // the merge gate ends up refusing on work the run believed it had finished.
  console.log(JSON.stringify({ pr, resolved: done.length, failed }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

// cmd === 'unresolved' | 'feedback'
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
          id
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
    // The GraphQL node id, and the ONLY way to resolve the thread
    // (`resolveReviewThread(input:{threadId:…})`). It was missing from both the
    // query and this projection, so every consumer was told to resolve threads
    // it had no handle for — which is why they were answered and left open, and
    // why the merge gate then refused on its own reviewers' work.
    id: t.id,
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
const threadReport = {
  pr,
  unresolved_count: unresolved.length,
  truncated_threads: truncatedThreads,
  threads: unresolved,
};

if (cmd === 'unresolved') {
  console.log(JSON.stringify(threadReport, null, 2));
  process.exit(0);
}

// cmd === 'feedback' — the whole reviewer surface for one PR.
// Bots do not put everything in resolvable threads: CodeRabbit posts its summary
// and most nitpicks as PR-level issue comments, and a Copilot verdict lives on
// the review, not on a thread. A fixer that only read `unresolved` silently
// skipped them, which is how "green with 0 unresolved" coexisted with a page of
// unaddressed review findings.
const MAX_BODY = 6000;
const MAX_ITEMS = 30;
const clip = (body) => {
  const s = String(body || '');
  return s.length > MAX_BODY
    ? { body: s.slice(0, MAX_BODY), body_truncated: true, body_length: s.length }
    : { body: s, body_truncated: false, body_length: s.length };
};

const issueComments = ghJson(['api', `repos/${OWNER_REPO}/issues/${pr}/comments`, '--paginate'], []);
const reviews = ghJson(['api', `repos/${OWNER_REPO}/pulls/${pr}/reviews`, '--paginate'], []);
const isBot = (login) => isCodeRabbit(login) || isCopilot(login);

const botComments = issueComments
  .filter((c) => isBot(c.user && c.user.login))
  // our own re-review asks are echoed back by nobody, but keep the filter honest
  .filter((c) => !String(c.body || '').includes(REVIEW_MARKER))
  .slice(-MAX_ITEMS)
  .map((c) => ({ author: c.user.login, created_at: c.created_at, url: c.html_url, ...clip(c.body) }));

const verdicts = reviews
  .filter((r) => r.state && r.state !== 'PENDING')
  .slice(-MAX_ITEMS)
  .map((r) => ({
    author: (r.user && r.user.login) || 'unknown',
    bot: isBot(r.user && r.user.login),
    state: r.state,
    submitted_at: r.submitted_at,
    url: r.html_url,
    ...clip(r.body),
  }));

const activity = prActivity();
console.log(JSON.stringify({
  ...threadReport,
  bot_comments: botComments,
  bot_comment_count: botComments.length,
  reviews: verdicts,
  changes_requested: verdicts.some((v) => v.state === 'CHANGES_REQUESTED'),
  engagement: {
    coderabbit: { engaged: activity.lastCodeRabbit > 0, last_activity: activity.lastCodeRabbit ? new Date(activity.lastCodeRabbit).toISOString() : null },
    copilot: { engaged: activity.lastCopilot > 0, last_activity: activity.lastCopilot ? new Date(activity.lastCopilot).toISOString() : null },
    last_review_request: activity.lastRequest ? new Date(activity.lastRequest).toISOString() : null,
    // "no unresolved threads" on a PR a bot never looked at is not a clean bill
    // of health, and the sentinel has to be able to say which one it is.
    awaiting_response: activity.lastRequest > Math.max(activity.lastCodeRabbit, activity.lastCopilot),
  },
}, null, 2));
