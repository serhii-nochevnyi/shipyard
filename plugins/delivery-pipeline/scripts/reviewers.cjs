#!/usr/bin/env node
'use strict';

// Reviewer plumbing for the babysit loop.
//
//   reviewers.cjs reinit <pr>      re-initialize both bot reviewers after a push:
//                                  CodeRabbit full re-review + re-request Copilot
//   reviewers.cjs unresolved <pr>  print unresolved review threads as JSON
//                                  (input for the review-fix agent)
//
// Copilot does not re-review a push on its own — it must be re-requested.
// A missing Copilot reviewer on the repo is a warning, not a failure.

const { execFileSync } = require('child_process');

const [, , cmd, prArg] = process.argv;
const pr = Number(prArg);
if (!['reinit', 'unresolved'].includes(cmd) || !Number.isInteger(pr) || pr <= 0) {
  console.error('usage: reviewers.cjs <reinit|unresolved> <pr-number>');
  process.exit(2);
}

function gh(args, { tolerate = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = `gh ${args.join(' ')} failed: ${e.stderr ? String(e.stderr).trim() : e.message}`;
    if (tolerate) {
      console.error(`WARNING: ${msg}`);
      return null;
    }
    console.error(`reviewers: ${msg}`);
    process.exit(1);
  }
}

const COPILOT_BOT = 'copilot-pull-request-reviewer[bot]';

if (cmd === 'reinit') {
  gh(['pr', 'comment', String(pr), '--body', '@coderabbitai full review']);
  console.log(`PR #${pr}: requested CodeRabbit full review`);
  const ok = gh(
    ['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${pr}/requested_reviewers`,
     '-f', `reviewers[]=${COPILOT_BOT}`],
    { tolerate: true }
  );
  console.log(ok !== null
    ? `PR #${pr}: re-requested Copilot review`
    : `PR #${pr}: Copilot re-request skipped (reviewer unavailable on this repo)`);
  process.exit(0);
}

// cmd === 'unresolved'
const repo = JSON.parse(gh(['repo', 'view', '--json', 'owner,name']));
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
          comments(first: 20) {
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
  }));

console.log(JSON.stringify({ pr, unresolved_count: unresolved.length, threads: unresolved }, null, 2));
