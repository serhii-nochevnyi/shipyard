#!/usr/bin/env node
'use strict';

// Reviewer plumbing for the babysit loop.
//
//   reviewers.cjs reinit     <pr> [--json] [--force]
//        re-initialize the bot reviewers after a push: CodeRabbit full re-review
//        + re-request Copilot. Idempotent by design (see below).
//   reviewers.cjs unresolved <pr>
//        print unresolved review threads as JSON (input for the review-fix agent),
//        plus `review_decision` and a `clean` verdict. A review VERDICT outlives
//        the threads it was filed with, so "0 unresolved" is not "settled" —
//        report both or the caller reads a clean board over a standing
//        CHANGES_REQUESTED.
//   reviewers.cjs feedback   <pr> [--no-since-head]
//        EVERYTHING a reviewer said SINCE THE LAST PUSH, in one call: unresolved
//        threads + the bots' PR-level comments (CodeRabbit's summary/nitpick
//        blocks, Copilot's remarks) + review verdicts + engagement. Threads alone
//        miss the PR-level half, which is where CodeRabbit files most of its
//        findings — a fixer working from `unresolved` only never saw them.
//        The window is the head commit's date, because a fixer on round 4 read
//        rounds 1–3's already-addressed comments as live work. `--no-since-head`
//        restores the whole history for a human who wants the record.
//   reviewers.cjs status     <pr> [--json]
//        which bot reviewers have ACTUALLY engaged on this PR, plus the review
//        verdicts BOTH ways — the raw history and the current one-per-reviewer
//        reduction — so the difference between "it said" and "it says" is visible
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
// `{owner}/{repo}` is a placeholder `gh api` expands from the current repository
// — and NOTHING expands it anywhere else. It belongs in an api PATH and never in
// a `--repo` flag, where gh wants an OWNER/REPO slug and errors on anything else.
// Measured 2026-09-07: `unresolved 27` reported `clean: false` with zero
// unresolved threads (the decision query had errored and `null` is not clean)
// while the same call with an explicit `--repo` reported `clean: true` — a false
// "review not settled" that keeps a green PR out of `merge` indefinitely. Every
// `gh pr …` call takes REPO_ARG; only api paths take this.
const OWNER_REPO = REPO || '{owner}/{repo}';

// Default ON: the feedback a fixer acts on is the feedback filed against the
// code that is actually on the branch. `--no-since-head` is the escape hatch for
// a human reading the record rather than a round servicing it.
const sinceHead = !argv.includes('--no-since-head');

if (!['reinit', 'unresolved', 'status', 'feedback', 'resolve'].includes(cmd) || !Number.isInteger(pr) || pr <= 0) {
  console.error('usage: reviewers.cjs <reinit|unresolved|feedback|status> <pr-number> [--json] [--force] [--repo owner/name]\n' +
                '                        feedback [--no-since-head]   (default: only what was said since the head commit)\n' +
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

// Timestamps, in one place: `prActivity` reduces rows to their newest date and
// the verdict reduction below reduces them to the newest ROW. Same comparison,
// two shapes, and it used to exist only inside the first.
const at = (v) => (v ? Date.parse(v) : 0);
const latest = (rows, pick) => rows.reduce((max, r) => Math.max(max, at(pick(r))), 0);

// A verdict is the reviewer's LAST word. `changes_requested` used to be
// `some(state === 'CHANGES_REQUESTED')` over EVERY historical review, so a
// reviewer who later approved still read as blocking and the PR could never be
// called settled. GitHub's own `reviewDecision` reduces to one state per author;
// the bot verdicts this script aggregates have to be reduced the same way or the
// two disagree about the same PR.
//
// Only DECIDING states take part. A COMMENTED review is not an opinion about
// whether the PR may land, and GitHub does not let one supersede a
// CHANGES_REQUESTED — a reduction that took the plain last row would call a PR
// settled because its reviewer left a remark afterwards.
const DECIDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
function currentVerdicts(rows) {
  const byAuthor = new Map();
  for (const r of rows) {
    if (!DECIDING.has(r.state)) continue;
    const author = r.author || 'unknown';
    const prev = byAuthor.get(author);
    if (!prev || at(r.submitted_at) >= at(prev.submitted_at)) byAuthor.set(author, r);
  }
  return [...byAuthor.values()].sort((a, b) => at(a.submitted_at) - at(b.submitted_at));
}
const verdictRow = (r) => ({
  author: (r.user && r.user.login) || 'unknown',
  bot: isCodeRabbit(r.user && r.user.login) || isCopilot(r.user && r.user.login),
  state: r.state,
  submitted_at: r.submitted_at,
  url: r.html_url,
});

function prActivity() {
  const comments = ghJson(['api', `repos/${OWNER_REPO}/issues/${pr}/comments`, '--paginate'], []);
  const reviews = ghJson(['api', `repos/${OWNER_REPO}/pulls/${pr}/reviews`, '--paginate'], []);

  return {
    comments,
    reviews,
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
  // BOTH views of the verdicts, because the difference is the thing a human
  // came here to see: "CodeRabbit requested changes" and "CodeRabbit currently
  // approves" are both true of the same PR, and only one of them decides
  // anything. The raw list is the evidence; the reduction is the answer.
  const raw = a.reviews.filter((r) => r.state && r.state !== 'PENDING').map(verdictRow);
  const current = currentVerdicts(raw);
  const say = (rows) => (rows.length ? rows.map((v) => `${v.author} ${v.state}`).join(', ') : 'none');
  const result = {
    pr,
    coderabbit: { engaged: a.lastCodeRabbit > 0, last_activity: a.lastCodeRabbit ? new Date(a.lastCodeRabbit).toISOString() : null },
    copilot: { engaged: a.lastCopilot > 0, last_activity: a.lastCopilot ? new Date(a.lastCopilot).toISOString() : null },
    last_review_request: a.lastRequest ? new Date(a.lastRequest).toISOString() : null,
    reviews_raw: raw,
    current_reviews: current,
    changes_requested: current.some((v) => v.state === 'CHANGES_REQUESTED'),
    lines: [
      `PR #${pr}: CodeRabbit ${a.lastCodeRabbit ? 'engaged' : 'NEVER responded'}, Copilot ${a.lastCopilot ? 'engaged' : 'NEVER responded'}`,
      `  reviews (every one, oldest first): ${say(raw)}`,
      `  reviews (current, one per reviewer): ${say(current)}`
        + ` → changes_requested: ${current.some((v) => v.state === 'CHANGES_REQUESTED')}`,
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
  // The review DECISION, not just the threads. A verdict lives on the review and
  // survives every thread being resolved, so "0 unresolved" and
  // CHANGES_REQUESTED coexist happily — measured on PR #645, which the board
  // reported as `17/17, 0 threads` and planned to merge while CodeRabbit's
  // CHANGES_REQUESTED still stood, unmoved by two later commits. `front.cjs` and
  // `sentinel.cjs` both read this field and both refuse the merge; the command
  // the loop actually reads before deciding a PR is clean did not report it, so
  // the only thing that ever saw the verdict was the thing already refusing.
  // REPO_ARG, not OWNER_REPO: `gh` does not expand `{owner}/{repo}` in a `--repo`
  // flag, so passing the placeholder errored the query and the `null` fallback
  // made `clean` false over zero unresolved threads. With no --repo given, gh
  // resolves the repository from the current directory — which is what this
  // command always meant.
  //
  // Three more fields ride on the same call, and that is the point of putting
  // them here: `sentinel.cjs duty` has to know whether the base moved under the
  // branch, it already spawns this command once per open PR per babysit round,
  // and `mergeStateStatus` costs nothing extra on a single-PR view. A second
  // query per PR per tick would be paid on every tick of the conveyor.
  const view = ghJson(['pr', 'view', String(pr), ...REPO_ARG, '--json',
    'reviewDecision,mergeStateStatus,baseRefName,headRefName'], null);
  console.log(JSON.stringify({
    ...threadReport,
    // GitHub's own verdict on whether this branch can land as it stands: CLEAN,
    // DIRTY (conflicts) or BEHIND (the base moved, reported only where branch
    // protection requires up-to-date branches). `null` when the query failed —
    // never a benign default, because the caller's rule is "an unknown is not a
    // green" and it cannot apply that to a value we invented.
    merge_state: (view && view.mergeStateStatus) || null,
    base: (view && view.baseRefName) || null,
    head: (view && view.headRefName) || null,
    // null is honest for "the query failed" AND for "nobody has reviewed yet";
    // neither is a clean bill of health, and `clean` below says which is which.
    review_decision: (view && view.reviewDecision) || null,
    // The one-line answer to "may this PR be treated as settled". Threads alone
    // never were — and neither is a query that did not come back: `view === null`
    // means we do not KNOW the decision, which is not the same as knowing it is
    // benign. Unknown reads as not-clean, or this field would say `true` loudest
    // exactly when it has the least evidence.
    clean: unresolved.length === 0 && view !== null && view.reviewDecision !== 'CHANGES_REQUESTED',
  }, null, 2));
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

// WHEN the code under review last changed. Everything a reviewer said before
// that was said about a different diff: a fixer on round 4 was handed rounds
// 1–3's comments, every one of them already addressed, and re-litigated them.
// One `gh pr view` for the PR's commits; the newest committedDate is the push.
// `headRefOid` + one commit lookup is the fallback for a view that answered
// without the commit list.
//
// Unreadable → NO filtering, deliberately. Showing an addressed comment costs a
// paragraph; hiding a live one costs an unaddressed finding, and this window is
// not worth that trade.
function headCommitAt() {
  if (!sinceHead) return null;
  const view = ghJson(['pr', 'view', String(pr), ...REPO_ARG, '--json', 'commits,headRefOid'], null);
  if (!view) return null;
  const dates = (Array.isArray(view.commits) ? view.commits : [])
    .map((c) => at(c.committedDate || c.authoredDate))
    .filter((n) => n > 0);
  if (dates.length) return Math.max(...dates);
  if (!view.headRefOid) return null;
  const raw = gh(['api', `repos/${OWNER_REPO}/commits/${view.headRefOid}`,
    '--jq', '.commit.committer.date'], { tolerate: true });
  const t = typeof raw === 'string' ? at(raw.trim()) : 0;
  return t > 0 ? t : null;
}
const headAt = headCommitAt();

const allBotComments = issueComments
  .filter((c) => isBot(c.user && c.user.login))
  // our own re-review asks are echoed back by nobody, but keep the filter honest
  .filter((c) => !String(c.body || '').includes(REVIEW_MARKER));
const liveBotComments = headAt === null
  ? allBotComments
  : allBotComments.filter((c) => at(c.created_at) >= headAt);

const botComments = liveBotComments
  .slice(-MAX_ITEMS)
  .map((c) => ({ author: c.user.login, created_at: c.created_at, url: c.html_url, ...clip(c.body) }));

const verdicts = reviews
  .filter((r) => r.state && r.state !== 'PENDING')
  .slice(-MAX_ITEMS)
  .map((r) => ({ ...verdictRow(r), ...clip(r.body) }));
// One state per reviewer, newest wins. See currentVerdicts: the raw list is the
// evidence and this is the answer, and `some()` over the raw one called a PR
// blocked because a reviewer had once said so.
const current = currentVerdicts(verdicts);

const activity = prActivity();
console.log(JSON.stringify({
  ...threadReport,
  // The window itself, so a reader is never guessing whether they are looking at
  // the whole record or the live slice of it.
  since_head: headAt === null ? null : new Date(headAt).toISOString(),
  bot_comments: botComments,
  bot_comment_count: botComments.length,
  // Dropping evidence silently is its own defect: say how much was left out.
  bot_comments_before_head: allBotComments.length - liveBotComments.length,
  reviews: verdicts,
  current_reviews: current,
  changes_requested: current.some((v) => v.state === 'CHANGES_REQUESTED'),
  engagement: {
    coderabbit: { engaged: activity.lastCodeRabbit > 0, last_activity: activity.lastCodeRabbit ? new Date(activity.lastCodeRabbit).toISOString() : null },
    copilot: { engaged: activity.lastCopilot > 0, last_activity: activity.lastCopilot ? new Date(activity.lastCopilot).toISOString() : null },
    last_review_request: activity.lastRequest ? new Date(activity.lastRequest).toISOString() : null,
    // "no unresolved threads" on a PR a bot never looked at is not a clean bill
    // of health, and the sentinel has to be able to say which one it is.
    awaiting_response: activity.lastRequest > Math.max(activity.lastCodeRabbit, activity.lastCopilot),
  },
}, null, 2));
