'use strict';

// ONE VOCABULARY FOR CHECK STATE — gh classifies, we count.
//
// `gh pr checks --json name,state,bucket` already sorts every CI state it knows
// about into five buckets:
//
//   pass | fail | pending | skipping | cancel
//
// That field exists precisely so callers do not maintain a list of `state`
// strings. Three callers here maintained one anyway, and the three copies
// disagreed: `state-sync.cjs` and `sentinel.cjs` called `FAILURE, ERROR,
// CANCELLED, TIMED_OUT` failing and `PENDING, QUEUED, IN_PROGRESS, EXPECTED`
// pending; `ci-wait.cjs` added `ACTION_REQUIRED` to the failing list and the
// other two did not. Everything neither list named — `WAITING`, `REQUESTED`,
// `STALE`, `STARTUP_FAILURE`, and `ACTION_REQUIRED` in two of the three — fell
// through BOTH filters, and therefore counted as passed: the green test in
// `state-sync.cjs` and `front.cjs` alike is `failing === 0 && pending === 0`.
// A startup failure read as green and the merge gate landed on it.
//
// FAIL CLOSED. Anything gh's answer does not let us classify — an unknown bucket
// name, a missing `bucket` from an older gh, a row that is not an object at all —
// is PENDING, never passing. Pending is the one verdict that costs only time: it
// keeps the ticket in `waiting.ci`, where the waiter and the next sync look
// again. Calling such a row passing is the defect above; calling it failing
// would dispatch a fixer at a check nobody has read.
//
// AND A FOURTH STATE, which is not about a row at all: `unavailable` — the call
// did not answer, so there is no list to classify. An unreadable `gh pr checks`
// (a 503, a rate limit, an expired token, an old `gh` rejecting `bucket`) used
// to be folded into the three states above: first as an empty list, which reads
// `none_reported: true, failing: 0, pending: 0` — the exact tally the merge gate
// treats as unblocked — and then, once that was fixed, as a synthetic
// unknown-bucket row, which waits for the right reason while telling the board
// "1 check is still running" about a check nobody ever saw, and asks a person to
// confirm a reading that never happened. Neither is the fact. A reading that did
// not happen is its OWN state: no work is owed, nobody is asked to confirm
// anything, and the next sync simply looks again.
//
// It travels as a FLAG, not as a tally, so `total`/`failing`/`pending` stay
// honest — zero checks were read, because none were. The price of that honesty
// is that `failing === 0 && pending === 0` — the green test everywhere — HOLDS
// on an unavailable answer. So the arithmetic is not the green test any more:
// `isGreen` below is, and it asks the flag FIRST. Every consumer that walks a PR
// towards landing goes through it or names `unavailable` itself.

// gh's own five. Anything else is not a bucket we can act on.
const BUCKETS = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);

// The `--json` window every consumer asks for. `bucket` is what this module
// reads; `name` and `state` stay in it because they are what the human-readable
// refusals and the board print — a tally alone cannot say WHICH check is red.
const CHECK_FIELDS = 'name,state,bucket,link,startedAt,workflow';

// One row → one of gh's five buckets. Unreadable rows come back as `pending`,
// which is the fail-closed rule above, applied in the single place that knows it.
function stateBucket(row) {
  if (!row || typeof row !== 'object') return 'pending';
  const b = typeof row.bucket === 'string' ? row.bucket.trim().toLowerCase() : '';
  return BUCKETS.has(b) ? b : 'pending';
}

// A URL is a locator, not provider authority. Only the supported GitHub job
// locator can be associated with a run fetched from this repository's API.
function actionsJob(link) {
  try {
    const url = new URL(link);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?\/job\/([1-9]\d*)\/?$/);
    return match ? { repository: match[1].toLowerCase(), run_id: match[2],
      attempt: match[3] ? Number(match[3]) : null, job_id: match[4] } : null;
  } catch { return null; }
}

function runIdOf(row) {
  if (typeof row.run_id === 'string' && /^[1-9]\d*$/.test(row.run_id)) return row.run_id;
  if (row.source === 'check-run' || row.source === 'commit-status') return null;
  const job = actionsJob(row.link);
  return job ? job.run_id : null;
}

const positiveId = value => Number.isSafeInteger(value) && value > 0;

function actionsIdentity(row) {
  if (!row || row.source !== 'check-run' || !positiveId(row.id)
      || typeof row.repository !== 'string' || !SHA.test(row.head_sha || '')
      || row.app_id !== 15368 || row.app_slug !== 'github-actions'
      || !positiveId(row.check_suite_id) || !positiveId(row.workflow_id)
      || !positiveId(row.run_number) || !positiveId(row.run_attempt)
      || typeof row.event !== 'string' || !row.event || typeof row.name !== 'string' || !row.name) return null;
  const job = actionsJob(row.link);
  return job && job.repository === row.repository.toLowerCase()
    && job.run_id === row.run_id && job.job_id === row.job_id
    && (job.attempt === null || job.attempt === row.run_attempt) ? job : null;
}

// One relation for selection AND cancellation. Names qualify jobs only inside
// verified workflow/run/attempt identity; duplicate names within an attempt are
// ambiguous across attempts/runs and must keep their independent obligations.
function sameLogicalCheck(a, b, list) {
  if (!a || !b || a.name !== b.name || a.app_id !== b.app_id
      || a.workflow_id !== b.workflow_id || a.event !== b.event || a.head_sha !== b.head_sha
      || !actionsIdentity(a) || !actionsIdentity(b)
      || a.repository.toLowerCase() !== b.repository.toLowerCase()) return false;
  const conflicting = list.some(other => other && [a, b].some(row => other !== row
    && other.source === 'check-run' && typeof other.repository === 'string'
    && other.repository.toLowerCase() === row.repository.toLowerCase()
    && other.head_sha === row.head_sha && other.app_id === row.app_id
    && ((other.run_id === row.run_id && (other.workflow_id !== row.workflow_id
      || other.event !== row.event || other.run_number !== row.run_number
      || (other.run_attempt === row.run_attempt && other.name === row.name
        && (other.job_id !== row.job_id || other.id !== row.id))))
      || (other.job_id === row.job_id && (other.run_id !== row.run_id
        || other.run_attempt !== row.run_attempt || other.id !== row.id
        || other.check_suite_id !== row.check_suite_id || other.name !== row.name)))));
  if (conflicting) return false;
  if (a.run_id === b.run_id && a.run_attempt === b.run_attempt) {
    return a.id === b.id && a.job_id === b.job_id
      && a.check_suite_id === b.check_suite_id && a.run_number === b.run_number;
  }
  if (a.job_id === b.job_id || a.id === b.id) return false;
  if (a.run_id === b.run_id ? a.run_number !== b.run_number
    : a.run_number === b.run_number || a.check_suite_id === b.check_suite_id) return false;
  return true;
}

function supersedes(newer, older, list) {
  if (newer === older || !sameLogicalCheck(newer, older, list)) return false;
  const at = Date.parse(older.startedAt), next = Date.parse(newer.startedAt);
  if (!Number.isFinite(at) || !Number.isFinite(next) || next < at) return false;
  if (newer.run_id !== older.run_id)
    return newer.run_number > older.run_number && BigInt(newer.run_id) > BigInt(older.run_id);
  if (newer.run_attempt !== older.run_attempt) return newer.run_attempt > older.run_attempt;
  return next > at || (next === at && newer.id > older.id);
}

function isSuperseded(row, list) {
  return list.some(other => other && supersedes(other, row, list));
}

// Rows → tallies. The four counters PARTITION the rows, so
// `failing + pending + passing + skipped === total` always holds; a row that
// fell through every counter is exactly the bug this module replaces.
//
// `skipping` counts towards `total` and towards nothing else: a skipped check is
// neither owed work nor a reason to wait, but it is a check that existed, and
// `total` is how a caller tells "nothing ran" from "something ran".
//
// A NON-ARRAY argument is the fourth state, and the whole reason it exists.
// `null` from a `gh` call that did not answer means "unreachable this round,
// look again"; `[]` means "this PR has no checks configured". Those are different
// facts with different remedies — the second is a decision a person makes once
// per repository (`merge_without_ci`), the first is nobody's decision at all —
// and they used to arrive here as the same argument. So the distinction is made
// ONCE, here: a non-array is `unavailable`, never `none_reported`, and callers no
// longer keep their own `Array.isArray` guard to compensate. Hand the unread
// answer straight over as `null`; the flag comes back on the tally.
function classify(rows) {
  const readable = Array.isArray(rows);
  const list = readable ? rows : [];
  const out = {
    total: list.length,
    failing: 0,
    pending: 0,
    passing: 0,
    skipped: 0,
    cancelled: 0,
    superseded: 0,
    cancelled_runs: [],
    // Mutually exclusive by construction: an observed empty list is
    // `none_reported`, an answer that never arrived is `unavailable`. Both false
    // is the ordinary case; both true is unreachable.
    none_reported: readable && list.length === 0,
    unavailable: !readable,
  };
  for (const row of list) {
    const bucket = stateBucket(row);
    if (bucket === 'cancel' && isSuperseded(row, list)) { out.superseded += 1; continue; }
    switch (bucket) {
      case 'pass': out.passing += 1; break;
      case 'fail': out.failing += 1; break;
      // @invariant: a lone latest cancel is pending and cancelled, never passing, so never green.
      case 'cancel':
        out.pending += 1;
        out.cancelled += 1;
        out.cancelled_runs.push({ name: row.name || null, run_id: runIdOf(row), started_at: row.startedAt || null });
        break;
      case 'skipping': out.skipped += 1; break;
      // 'pending', plus every unreadable row — see the fail-closed note above.
      default: out.pending += 1; break;
    }
  }
  return out;
}

// THE GREEN TEST, in the one place that owns the vocabulary it reads.
//
// `failing === 0 && pending === 0` was written out at every consumer, which was
// harmless while an unreadable answer arrived carrying a pending row — the
// arithmetic happened to be fail-closed. It is not any more: an `unavailable`
// tally is all zeros, so the arithmetic ALONE says green about a PR nobody read.
// Asking the flag first is a one-line rule and therefore exactly the kind of rule
// that gets forgotten at the fourth call site, so it is a function.
//
// A MISSING checks object is deliberately NOT decided here: a caller that has no
// checks at all knows whether that means "no PR yet" or "a board we cannot
// trust", and the two are its own business. `isGreen(undefined)` reads the empty
// tally, exactly as the inline expressions it replaces did.
// The flag is read for TRUTH, not for the literal `true`, and the polarity is
// this module's own fail-closed rule rather than a style choice. `classify`
// always writes a real boolean, so anything else arrived from a board some other
// process wrote — and between "withhold a merge on a value we do not recognise"
// and "call a PR green on one", the first costs a tick and the second is the
// defect this whole state exists to remove. An ABSENT key stays green-capable:
// that is every board written before this release, whose unreadable answers were
// already held by the synthetic pending row they carried instead.
function isGreen(checks) {
  const c = checks || {};
  if (c.unavailable) return false;
  if ((c.cancelled || 0) > 0) return false;
  return !((c.failing || 0) > 0) && !((c.pending || 0) > 0);
}

// THE CAUSE OF AN UNREADABLE ANSWER, in the module that owns what one means.
//
// The note reaches the board's warning, the front's why-message, the guard's duty
// and the merge refusal, so it has to name something a person can act on. It was
// written out at BOTH `ghChecks` callers, which is the same second-home problem
// `classify` exists to remove — and the callers had already drifted apart on the
// shape of the answer. One order, stated once:
//
//   stderr       what `gh` itself printed ("HTTP 503: Service Unavailable", "API
//                rate limit exceeded"). The best answer whenever there is one.
//   spawn error  no `gh` on PATH at all. Its exit status is `null` and "exited
//                null" names nothing, so this arm comes before the exit code.
//   stdout       `gh` ANSWERED — just not with a JSON array (an API error
//                object, a wrapper, a notice contaminating stdout). Its exit code
//                is routinely 0 on this cell, so the status is worthless here and
//                what it actually said is the only useful thing left. Collapsed
//                to one line and clipped, because every consumer prints the note
//                inside a one-line message.
//   exit code    nothing on either stream: the status is all there is. A template
//                literal, so the note is never empty while `unavailable` is true.
function unavailableNote(r) {
  const answered = (r.stdout || '').replace(/\s+/g, ' ').trim();
  return (r.stderr || '').trim().split('\n').filter(Boolean)[0]
    || (r.error ? r.error.message : '')
    || (answered ? `gh pr checks answered but not with a JSON array: ${answered.length > 80 ? `${answered.slice(0, 80)}…` : answered}` : '')
    || `gh pr checks exited ${r.status}`;
}

// Version 1 could already have discarded independent rows before publication.
const CI_OBSERVATION_VERSION = 2;
const SHA = /^[0-9a-f]{40}$/i;

// @security: Unknown remote states remain pending, as with unknown gh buckets.
function remoteBucket(state) {
  switch (state) {
    case 'SUCCESS': return 'pass';
    case 'FAILURE': case 'ERROR': case 'TIMED_OUT': case 'ACTION_REQUIRED': return 'fail';
    case 'NEUTRAL': case 'SKIPPED': return 'skipping';
    case 'CANCELLED': return 'cancel';
    default: return 'pending';
  }
}

function collectCiObservation({ pr, repo, head, pollId }, request) {
  const observation = {
    schema_version: CI_OBSERVATION_VERSION, repository: repo || null,
    pr: Number(pr), checked_head: null, poll_id: pollId,
    availability: 'unavailable', complete: false, rows: null, sources: null,
  };
  function json(args) {
    const r = request(args);
    if (!r || r.error || r.status !== 0)
      throw Object.assign(new Error(unavailableNote(r || {})), { transportUnavailable: true });
    try { return JSON.parse(r.stdout); } catch { throw new Error('CI transport returned malformed JSON'); }
  }
  try {
    if (typeof pollId !== 'string' || !pollId) throw new Error('CI poll identity is missing');
    if (!SHA.test(head || '')) throw new Error('Expected PR head is unavailable');
    if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('CI repository identity is invalid');
    if (!repo) {
      const resolved = json(['repo', 'view', '--json', 'owner,name']);
      repo = resolved && resolved.owner && resolved.owner.login && resolved.name
        ? `${resolved.owner.login}/${resolved.name}` : null;
      if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('CI repository identity is unavailable');
      observation.repository = repo;
    }
    const base = `repos/${repo}`;
    let headRepository = repo;
    const pull = () => {
      const p = json(['api', `${base}/pulls/${pr}`]);
      if (!p || p.number !== Number(pr) || p.state !== 'open'
          || !p.head || !SHA.test(p.head.sha || '')
          || !p.base || !p.base.repo || typeof p.base.repo.full_name !== 'string'
          || p.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) {
        throw new Error('CI pull request identity is unproven');
      }
      const associatedRepo = p.head.repo && p.head.repo.full_name || repo;
      if (typeof associatedRepo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(associatedRepo))
        throw new Error('CI head repository identity is unproven');
      headRepository = associatedRepo;
      return p.head.sha;
    };
    const checkedHead = pull();
    if (checkedHead !== head) throw new Error('PR head moved before CI collection');
    const pages = (endpoint, field, association) => {
      const data = json(['api', endpoint, '--paginate', '--slurp']);
      if (!Array.isArray(data) || !data.length) throw new Error('CI pages are missing');
      const total = data[0] && data[0].total_count;
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('CI page total is missing');
      const rows = [];
      for (const page of data) {
        if (!page || page.total_count !== total || !Array.isArray(page[field])
            || !association(page) || (data.length > 1 && page[field].length === 0)) {
          throw new Error('CI pages are incomplete or not commit-associated');
        }
        rows.push(...page[field]);
      }
      if (rows.length !== total || new Set(rows.map(r => r && r.id)).size !== rows.length)
        throw new Error('CI page coverage is incomplete or duplicated');
      return { rows, total_count: total, pages: data.length };
    };
    const checkRuns = pages(`${base}/commits/${checkedHead}/check-runs?per_page=100&filter=all`,
      'check_runs', p => p.check_runs.every(r => r && r.head_sha === checkedHead));
    const statuses = pages(`${base}/commits/${checkedHead}/status?per_page=100`,
      'statuses', p => p.sha === checkedHead);
    const workflows = new Map();
    const rows = checkRuns.rows.map(r => {
      if (typeof r.name !== 'string' || !r.name || !positiveId(r.id))
        throw new Error('CI check identity is incomplete');
      const state = String(r.status === 'completed' ? r.conclusion || 'unknown' : r.status || 'unknown').toUpperCase();
      const row = { name: r.name, state, bucket: remoteBucket(state), link: r.details_url || r.html_url || '',
        startedAt: r.started_at || '', workflow: '', source: 'check-run', id: r.id, head_sha: checkedHead,
        repository: repo.toLowerCase(), app_id: positiveId(r.app?.id) ? r.app.id : null,
        app_slug: typeof r.app?.slug === 'string' ? r.app.slug : null,
        check_suite_id: positiveId(r.check_suite?.id) ? r.check_suite.id : null,
        run_id: null, job_id: null, workflow_id: null, event: '', run_number: null, run_attempt: null };
      const job = actionsJob(row.link);
      if (row.app_id === 15368 && row.app_slug === 'github-actions'
          && job && job.repository === repo.toLowerCase() && row.check_suite_id !== null) {
        // Attempt-specific locators require the original attempt response. A
        // latest-run response alone cannot assign its attempt to an older job.
        const runPath = `${base}/actions/runs/${job.run_id}${job.attempt === null ? '' : `/attempts/${job.attempt}`}`;
        if (!workflows.has(runPath)) workflows.set(runPath, json(['api', runPath]));
        const run = workflows.get(runPath);
        if (run && String(run.id) === job.run_id && run.head_sha === checkedHead
            && run.head_repository?.full_name?.toLowerCase() === headRepository.toLowerCase()
            && (!run.repository || run.repository.full_name?.toLowerCase() === repo.toLowerCase())
            && run.check_suite_id === row.check_suite_id && positiveId(run.workflow_id)
            && positiveId(run.run_number) && positiveId(run.run_attempt)
            && (job.attempt === null || job.attempt === run.run_attempt)
            && typeof run.name === 'string' && typeof run.event === 'string' && run.event) {
          Object.assign(row, { workflow: run.name, event: run.event, workflow_id: run.workflow_id,
            run_id: job.run_id, job_id: job.job_id, run_number: run.run_number, run_attempt: run.run_attempt });
        }
      }
      return row;
    });
    // Unknown/conflicting identities retain all rows. Retain cancelled originals
    // even when proven obsolete so publication and the waiter share the evidence.
    const selectedRows = rows.filter(row => row.bucket === 'cancel' || !isSuperseded(row, rows));
    const latestStatuses = new Map();
    for (const r of statuses.rows) {
      if (!r || typeof r.context !== 'string' || !r.context || !Number.isSafeInteger(r.id))
        throw new Error('CI status identity is incomplete');
      const prior = latestStatuses.get(r.context);
      if (!prior || r.id > prior.id) latestStatuses.set(r.context, r);
    }
    for (const r of latestStatuses.values()) {
      const state = String(r.state || 'unknown').toUpperCase();
      selectedRows.push({ name: r.context, state, bucket: remoteBucket(state), link: r.target_url || '',
        startedAt: r.created_at || '', workflow: '', source: 'commit-status', id: r.id,
        head_sha: checkedHead, repository: repo.toLowerCase(), run_id: null });
    }
    const expectedHeadRepository = headRepository;
    if (pull() !== checkedHead || headRepository.toLowerCase() !== expectedHeadRepository.toLowerCase())
      throw new Error('PR head moved during CI collection');
    Object.assign(observation, { checked_head: checkedHead, availability: 'available', complete: true, rows: selectedRows,
      sources: { check_runs: { total_count: checkRuns.total_count, pages: checkRuns.pages,
          selected_count: selectedRows.filter(r => r.source === 'check-run').length },
        statuses: { total_count: statuses.total_count, pages: statuses.pages, sha: checkedHead,
          selected_count: latestStatuses.size } } });
  } catch (error) {
    observation.note = error.message;
    if (error.transportUnavailable === true) observation.transport_unavailable = true;
  }
  return observation;
}

// @security: Publication generation and separately sampled PR head do not prove checked-head coverage.
function compatibleCiObservation(o, { pr, repo, head, pollId } = {}) {
  if (!o || o.schema_version !== CI_OBSERVATION_VERSION || o.complete !== true
      || o.availability !== 'available' || !Array.isArray(o.rows)
      || typeof o.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(o.repository)
      || !Number.isSafeInteger(o.pr) || o.pr < 1 || !SHA.test(o.checked_head || '')
      || typeof o.poll_id !== 'string' || !o.poll_id
      || (pr !== undefined && o.pr !== Number(pr))
      || (repo && o.repository.toLowerCase() !== repo.toLowerCase())
      || (head !== undefined && o.checked_head !== head)
      || (pollId !== undefined && o.poll_id !== pollId)) return false;
  const sources = o.sources;
  if (!sources || !sources.check_runs || !sources.statuses || sources.statuses.sha !== o.checked_head) return false;
  for (const surface of [sources.check_runs, sources.statuses]) {
    if (!Number.isSafeInteger(surface.total_count) || surface.total_count < 0
        || !Number.isSafeInteger(surface.pages) || surface.pages < 1) return false;
  }
  if (!o.rows.every(r => r && typeof r.name === 'string' && r.name
      && typeof r.state === 'string' && r.bucket === remoteBucket(r.state)
      && typeof r.link === 'string' && typeof r.startedAt === 'string' && typeof r.workflow === 'string'
      && Number.isSafeInteger(r.id) && r.head_sha === o.checked_head
      && r.repository === o.repository.toLowerCase()
      && (r.source === 'check-run' || r.source === 'commit-status')
      && (r.run_id === null || (typeof r.run_id === 'string' && /^\d+$/.test(r.run_id))))) return false;
  if (new Set(o.rows.map(r => `${r.source}:${r.id}`)).size !== o.rows.length) return false;
  const checkRows = o.rows.filter(r => r.source === 'check-run');
  const statusRows = o.rows.filter(r => r.source === 'commit-status');
  return checkRows.length === sources.check_runs.selected_count
    && checkRows.length <= sources.check_runs.total_count
    && (sources.check_runs.total_count === 0 || checkRows.length > 0)
    && statusRows.length === sources.statuses.selected_count
    && statusRows.length <= sources.statuses.total_count
    && (sources.statuses.total_count === 0 || statusRows.length > 0);
}

module.exports = { classify, stateBucket, isGreen, runIdOf, unavailableNote, CHECK_FIELDS, BUCKETS,
  collectCiObservation, compatibleCiObservation, CI_OBSERVATION_VERSION };
