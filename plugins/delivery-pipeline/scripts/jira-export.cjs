#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
const { parseFrontmatter } = require(path.join(__dirname, 'frontmatter.cjs'));
const { resolveGraphDir } = require(path.join(__dirname, 'graph-dir.cjs'));

const TICKET_ID_RE = /^T-\d{2}-\d{2}$/;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PROJECT_RE = /^[A-Z][A-Z0-9]*$/;

function fail(message) {
  process.stderr.write(`jira-export: ${message}\n`);
  process.exit(1);
}

function hasGraph(dir) {
  try { return fs.statSync(path.join(dir, 'tickets.json')).isFile(); } catch { return false; }
}

function sanitizeSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titleFromSlug(slug) {
  const stripped = String(slug).replace(/^\d+-/, '');
  const words = stripped.replace(/[-_]+/g, ' ').trim();
  if (!words) return stripped;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function topoOrder(tickets) {
  const ids = Object.keys(tickets).sort();
  const indeg = {};
  for (const id of ids) indeg[id] = 0;
  for (const id of ids) {
    for (const d of tickets[id].depends_on || []) {
      if (tickets[d]) indeg[id]++;
    }
  }
  const queue = ids.filter((id) => indeg[id] === 0).sort();
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const other of ids) {
      if ((tickets[other].depends_on || []).includes(id) && --indeg[other] === 0) {
        queue.push(other);
      }
    }
    queue.sort();
  }
  if (order.length !== ids.length) {
    throw new Error('tickets.json has a dependency cycle — run validate-graph.cjs first');
  }
  return order;
}

function bodyAfterFrontmatter(text) {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

function sectionsOf(body) {
  const lines = body.split(/\r\n|\r|\n/);
  const map = {};
  let current = null;
  let buf = [];
  const flush = () => { if (current !== null) map[current] = buf.join('\n').trim(); };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1].trim();
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return map;
}

function issueLabels(owner, repo, ticketId) {
  return {
    primary: `shipyard-${owner}-${repo}-${ticketId.toLowerCase()}`,
    legacy: `shipyard-${ticketId}`,
  };
}

function epicLabels(owner, repo, phase) {
  return {
    primary: `shipyard-epic-${owner}-${repo}-${phase}`,
    legacy: `shipyard-epic-${phase}`,
  };
}

function lookupOf(project, labels) {
  return {
    jql: `project = ${project} AND labels = "${labels.primary}"`,
    legacy_jql: `project = ${project} AND labels = "${labels.legacy}"`,
  };
}

function planExport(graphDir, opts = {}) {
  if (!REPO_RE.test(String(opts.repo || ''))) {
    throw new Error(`--repo "${opts.repo}" is not an owner/name slug (e.g. acme/demo)`);
  }
  const [ownerRaw, repoRaw] = String(opts.repo).split('/');
  const owner = sanitizeSlug(ownerRaw);
  const repo = sanitizeSlug(repoRaw);

  const project = String(opts.project || '');
  if (!PROJECT_RE.test(project)) {
    throw new Error(`--project "${opts.project}" is not a valid Jira project key (e.g. MYD)`);
  }

  const issueType = opts.issueType || 'Task';
  const epicRaw = opts.epicIssueType === undefined ? 'Epic' : opts.epicIssueType;
  const skipEpics = epicRaw === 'none';
  const epicIssueType = skipEpics ? null : epicRaw;

  if (!hasGraph(graphDir)) throw new Error(`no ticket graph at ${graphDir}`);
  const raw = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json'), 'utf8'));
  const tickets = raw.tickets || {};
  const root = path.resolve(graphDir, '..', '..');
  const order = topoOrder(tickets);

  const steps = [];

  if (!skipEpics) {
    const phases = new Map();
    for (const id of order) {
      const t = tickets[id];
      if (!phases.has(t.phase)) {
        phases.set(t.phase, {
          phaseDir: path.basename(path.dirname(t.plan)),
          branch: t.epic,
        });
      }
    }
    const phaseIds = [...phases.keys()].sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const phase of phaseIds) {
      const info = phases.get(phase);
      const title = titleFromSlug(info.phaseDir);
      const labels = epicLabels(owner, repo, phase);
      steps.push({
        step: 'epic',
        phase,
        issue_type: epicIssueType,
        summary: `[${phase}] ${title}`,
        description: `Epic for phase ${phase}: ${title}.\nBranch: ${info.branch}`,
        labels: [labels.primary],
        lookup: lookupOf(project, labels),
      });
    }
  }

  for (const id of order) {
    const t = tickets[id];
    const body = bodyAfterFrontmatter(fs.readFileSync(path.join(root, t.plan), 'utf8'));
    const secs = sectionsOf(body);
    const labels = issueLabels(owner, repo, id);
    const pointer = `Source of truth: ${owner}/${repo}:${t.plan} (this issue is a generated projection)`;
    const description = [
      'Goal:', secs.Goal || '', '',
      'Scope:', secs.Scope || '', '',
      'Acceptance criteria:', secs['Acceptance criteria'] || '', '',
      pointer,
    ].join('\n');
    steps.push({
      step: 'issue',
      ticket: id,
      issue_type: issueType,
      summary: `${id}: ${t.title}`,
      description,
      labels: [labels.primary],
      epic: skipEpics ? null : t.phase,
      lookup: lookupOf(project, labels),
    });
  }

  const links = [];
  for (const id of order) {
    for (const dep of tickets[id].depends_on || []) {
      if (!tickets[dep]) continue;
      links.push({
        step: 'link',
        type: 'Blocks',
        inward: dep,
        outward: id,
        phrase: `${id} is blocked by ${dep}`,
        required_semantics: 'inward description reads is blocked by',
      });
    }
  }
  links.sort((a, b) => {
    if (a.outward !== b.outward) return a.outward < b.outward ? -1 : 1;
    return a.inward < b.inward ? -1 : a.inward > b.inward ? 1 : 0;
  });
  steps.push(...links);

  return {
    repo: `${owner}/${repo}`,
    project,
    issue_type: issueType,
    epic_issue_type: epicIssueType,
    steps,
  };
}

function upsertJiraKey(text, key) {
  const lines = text.split('\n');
  const bare = (l) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  if (bare(lines[0]) !== '---') {
    throw new Error('PLAN file has no frontmatter (expected a leading "---" line)');
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (bare(lines[i]) === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) throw new Error('PLAN file frontmatter has no closing "---" line');

  let deliveryIdx = -1;
  for (let i = 1; i < closeIdx; i++) {
    if (/^delivery:\s*$/.test(bare(lines[i]))) { deliveryIdx = i; break; }
  }
  if (deliveryIdx === -1) throw new Error('PLAN file frontmatter has no delivery: block');

  let blockEnd = deliveryIdx + 1;
  while (blockEnd < closeIdx && /^[ \t]+\S/.test(bare(lines[blockEnd]))) blockEnd++;

  let indent = '  ';
  if (blockEnd > deliveryIdx + 1) {
    const m = /^([ \t]+)/.exec(bare(lines[deliveryIdx + 1]));
    if (m) indent = m[1];
  }

  let jiraIdx = -1;
  for (let i = deliveryIdx + 1; i < blockEnd; i++) {
    if (bare(lines[i]).startsWith(`${indent}jira:`)) { jiraIdx = i; break; }
  }

  const eol = /\r$/.test(lines[deliveryIdx]) ? '\r' : '';
  const newLine = `${indent}jira: ${key}${eol}`;

  if (jiraIdx !== -1) {
    lines[jiraIdx] = newLine;
  } else {
    lines.splice(blockEnd, 0, newLine);
  }
  return lines.join('\n');
}

function recordKey(graphDir, ticketId, key) {
  if (!TICKET_ID_RE.test(String(ticketId || ''))) {
    throw new Error(`"${ticketId}" is not a valid ticket id — expected T-NN-MM (e.g. T-01-02)`);
  }
  if (!JIRA_KEY_RE.test(String(key || ''))) {
    throw new Error(`"${key}" is not a valid Jira key — expected e.g. MYD-123`);
  }
  if (!hasGraph(graphDir)) throw new Error(`no ticket graph at ${graphDir}`);
  const raw = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json'), 'utf8'));
  const tickets = raw.tickets || {};
  const ticket = tickets[ticketId];
  if (!ticket) {
    throw new Error(`${ticketId} is not in tickets.json at ${graphDir} — refusing to record a key for an unknown ticket`);
  }
  const root = path.resolve(graphDir, '..', '..');
  const planPath = path.join(root, ticket.plan);
  return withLock(lockDirFor(root), 'jira-export', () => {
    const before = fs.readFileSync(planPath, 'utf8');
    const { data, errors } = parseFrontmatter(before);
    if (!data || errors.length) {
      throw new Error(`${planPath} has invalid frontmatter — refusing to edit it`);
    }
    if (!data.delivery || typeof data.delivery !== 'object') {
      throw new Error(`${planPath} has no delivery: block — refusing to insert jira: outside it`);
    }
    const after = upsertJiraKey(before, key);
    if (after !== before) writeAtomic(planPath, after);
    return { ticket: ticketId, key, plan: planPath };
  }, { label: 'jira-export' });
}

function stripFlag(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1) return argv.slice();
  const out = argv.slice();
  out.splice(at, 2);
  return out;
}

function parsePlanArgs(argv) {
  const VALUED = ['--repo', '--project', '--issue-type', '--epic-issue-type'];
  const BOOLEAN = ['--json'];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLEAN.includes(a)) { flags[a] = true; continue; }
    if (VALUED.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      flags[a] = v;
      i++;
      continue;
    }
    throw new Error(`unknown argument "${a}"`);
  }
  return flags;
}

function cli() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (cmd === 'plan') {
    const graphDir = resolveGraphDir(rest, process.cwd()).dir;
    let flags;
    try {
      flags = parsePlanArgs(stripFlag(rest, '--graph'));
    } catch (e) { fail(e.message); return; }
    try {
      const out = planExport(graphDir, {
        repo: flags['--repo'],
        project: flags['--project'],
        issueType: flags['--issue-type'],
        epicIssueType: flags['--epic-issue-type'],
      });
      if (flags['--json']) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        const counts = { epic: 0, issue: 0, link: 0 };
        for (const s of out.steps) counts[s.step]++;
        console.log(`${out.steps.length} step(s): ${counts.epic} epic, ${counts.issue} issue, ${counts.link} link`);
      }
    } catch (e) { fail(e.message); }
  } else if (cmd === 'record') {
    const graphDir = resolveGraphDir(rest, process.cwd()).dir;
    const [ticketId, key, ...extra] = stripFlag(rest, '--graph');
    if (extra.length) { fail(`unexpected argument "${extra[0]}"`); return; }
    try {
      const result = recordKey(graphDir, ticketId, key);
      console.log(`${result.ticket}: jira set to ${result.key} in ${result.plan}`);
      console.log('Re-run validate-graph.cjs so tickets.json picks up the change.');
    } catch (e) { fail(e.message); }
  } else {
    fail('usage: jira-export.cjs plan --repo <owner/repo> --project <KEY> [--issue-type <t>] [--epic-issue-type <t|none>] [--graph <dir>] [--json]\n' +
      '  jira-export.cjs record <T-NN-MM> <KEY> [--graph <dir>]');
  }
}

module.exports = {
  planExport, recordKey, upsertJiraKey, topoOrder, sanitizeSlug, titleFromSlug,
  bodyAfterFrontmatter, sectionsOf, issueLabels, epicLabels, lookupOf,
  TICKET_ID_RE, JIRA_KEY_RE, REPO_RE, PROJECT_RE, hasGraph,
};

if (require.main === module) {
  cli();
}
