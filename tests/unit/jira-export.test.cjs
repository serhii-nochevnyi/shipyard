'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'jira-export.cjs'
);
const mod = require(SCRIPT);

function planBody(spec) {
  return [
    '## Goal',
    spec.goal || 'Goal body.',
    '',
    '## Scope',
    spec.scope || 'Scope body.',
    '',
    '## Acceptance criteria',
    spec.ac || 'AC body.',
    '',
  ].join('\n');
}

function planFrontmatter(id, spec) {
  const [, phase, plan] = id.split('-');
  return [
    '---',
    `phase: ${phase}`,
    `plan: ${plan}`,
    `title: "${spec.title || id}"`,
    'type: implementation',
    `depends_on: [${(spec.depends_on || []).join(', ')}]`,
    'files_modified: [x.ts]',
    'requirements: [REQ-1]',
    'delivery:',
    `  ticket: ${id}`,
    `  risk: ${spec.risk || 'low'}`,
    '  human_checkpoint: false',
    '---',
    '',
  ].join('\n');
}

function project(tickets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-jira-export-'));
  const g = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(g, { recursive: true });
  const view = { tickets: {} };
  for (const [id, spec] of Object.entries(tickets)) {
    const phaseDir = spec.phaseDir || `${spec.phase}-a-phase-title`;
    const planRel = path.join('.planning', 'phases', phaseDir, `${id.slice(2)}-PLAN.md`);
    const planAbs = path.join(dir, planRel);
    fs.mkdirSync(path.dirname(planAbs), { recursive: true });
    fs.writeFileSync(planAbs, planFrontmatter(id, spec) + planBody(spec));
    view.tickets[id] = {
      title: spec.title || id,
      plan: planRel,
      phase: String(spec.phase),
      repo: null,
      depends_on: spec.depends_on || [],
      risk: spec.risk || 'low',
      branch: `ticket/${id}-x`,
      epic: `epic/${phaseDir}`,
      pr_base: `epic/${phaseDir}`,
      jira: spec.jira || null,
    };
  }
  fs.writeFileSync(path.join(g, 'tickets.json'), JSON.stringify(view));
  return { dir, graph: g };
}

function run(graph, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--graph', graph], {
    encoding: 'utf8', cwd: os.tmpdir(), timeout: 20000,
  });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch {} }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const diamondAndChain = () => project({
  'T-01-01': { phase: 1, title: 'Root', depends_on: [] },
  'T-01-02': { phase: 1, title: 'Branch A', depends_on: ['T-01-01'] },
  'T-01-03': { phase: 1, title: 'Branch B', depends_on: ['T-01-01'] },
  'T-01-04': { phase: 1, title: 'Join', depends_on: ['T-01-02', 'T-01-03'] },
  'T-02-01': { phase: 2, title: 'Chain start', depends_on: [] },
  'T-02-02': { phase: 2, title: 'Chain middle', depends_on: ['T-02-01'] },
  'T-02-03': { phase: 2, title: 'Chain end', depends_on: ['T-02-02'] },
});


suite('plan — determinism and step ordering');

test('plan --json is byte-identical across two runs', () => {
  const p = diamondAndChain();
  const a = run(p.graph, ['plan', '--repo', 'acme/demo', '--project', 'MYD', '--json']);
  const b = run(p.graph, ['plan', '--repo', 'acme/demo', '--project', 'MYD', '--json']);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(a.stdout, b.stdout);
});

test('issue steps are topologically ordered: parents precede children', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  const issueIds = out.steps.filter((s) => s.step === 'issue').map((s) => s.ticket);
  const at = (id) => issueIds.indexOf(id);
  assert.ok(at('T-01-01') < at('T-01-02'), 'root before branch A');
  assert.ok(at('T-01-01') < at('T-01-03'), 'root before branch B');
  assert.ok(at('T-01-02') < at('T-01-04'), 'branch A before join');
  assert.ok(at('T-01-03') < at('T-01-04'), 'branch B before join');
  assert.ok(at('T-02-01') < at('T-02-02'), 'chain start before middle');
  assert.ok(at('T-02-02') < at('T-02-03'), 'chain middle before end');
});

test('steps come in fixed order: epics, then issues, then links', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  const kinds = out.steps.map((s) => s.step);
  const firstIssue = kinds.indexOf('issue');
  const firstLink = kinds.indexOf('link');
  const lastEpic = kinds.lastIndexOf('epic');
  assert.ok(lastEpic < firstIssue, 'every epic precedes every issue');
  const lastIssue = kinds.lastIndexOf('issue');
  assert.ok(lastIssue < firstLink, 'every issue precedes every link');
});

test('every depends_on yields exactly one link, dependent on the outward (blocked) side', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  const links = out.steps.filter((s) => s.step === 'link');
  assert.equal(links.length, 6, 'one link per depends_on edge');
  const expect = [
    ['T-01-01', 'T-01-02'], ['T-01-01', 'T-01-03'],
    ['T-01-02', 'T-01-04'], ['T-01-03', 'T-01-04'],
    ['T-02-01', 'T-02-02'], ['T-02-02', 'T-02-03'],
  ];
  for (const [dep, dependent] of expect) {
    const l = links.find((x) => x.inward === dep && x.outward === dependent);
    assert.ok(l, `expected a link for ${dep} -> ${dependent}`);
    assert.equal(l.type, 'Blocks');
    assert.equal(l.phrase, `${dependent} is blocked by ${dep}`);
    assert.equal(l.required_semantics, 'inward description reads is blocked by');
  }
});


suite('plan — labels and the source-of-truth pointer');

test('issue labels are namespaced by owner-repo and fully lowercase', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'Acme/Demo-Repo', project: 'MYD' });
  const issue = out.steps.find((s) => s.step === 'issue' && s.ticket === 'T-01-01');
  assert.equal(issue.labels.length, 1);
  assert.equal(issue.labels[0], 'shipyard-acme-demo-repo-t-01-01');
  assert.equal(issue.labels[0], issue.labels[0].toLowerCase());
});

test('epic labels are namespaced by owner-repo and lowercase', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'Acme/Demo-Repo', project: 'MYD' });
  const epic = out.steps.find((s) => s.step === 'epic' && s.phase === '1');
  assert.equal(epic.labels[0], 'shipyard-epic-acme-demo-repo-1');
});

test('the source-of-truth pointer is exactly one line inside the description', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  const issue = out.steps.find((s) => s.step === 'issue' && s.ticket === 'T-01-01');
  const pointerLines = issue.description.split('\n').filter((l) => l.startsWith('Source of truth:'));
  assert.equal(pointerLines.length, 1);
  assert.equal(pointerLines[0], `Source of truth: acme/demo:${path.join('.planning', 'phases', '1-a-phase-title', '01-01-PLAN.md')} (this issue is a generated projection)`);
});

test('description carries the Goal, Scope and Acceptance criteria sections read from the PLAN file', () => {
  const p = project({
    'T-05-01': {
      phase: 5, title: 'Widget', depends_on: [],
      goal: 'Ship the widget.', scope: 'Only the widget.', ac: 'Widget exists.',
    },
  });
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  const issue = out.steps.find((s) => s.step === 'issue');
  assert.ok(issue.description.includes('Ship the widget.'));
  assert.ok(issue.description.includes('Only the widget.'));
  assert.ok(issue.description.includes('Widget exists.'));
});

test('the issue lookup is ordered primary, ADR-004 spelling, then bare legacy', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  const issue = out.steps.find((s) => s.step === 'issue' && s.ticket === 'T-01-01');
  const planPath = JSON.parse(fs.readFileSync(path.join(p.graph, 'tickets.json'), 'utf8')).tickets['T-01-01'].plan;
  const pointer = `Source of truth: acme/demo:${planPath} (this issue is a generated projection)`;

  assert.equal(issue.lookup.length, 3);
  assert.deepEqual(issue.lookup.map((e) => e.order), [1, 2, 3]);
  assert.deepEqual(issue.lookup.map((e) => e.kind), ['primary', 'adr-004', 'legacy']);
  assert.deepEqual(issue.lookup.map((e) => e.label), [
    'shipyard-acme-demo-t-01-01', 'shipyard-acme-demo-T-01-01', 'shipyard-T-01-01',
  ]);
  assert.deepEqual(issue.lookup.map((e) => e.jql), [
    'project = MYD AND labels = "shipyard-acme-demo-t-01-01"',
    'project = MYD AND labels = "shipyard-acme-demo-T-01-01"',
    'project = MYD AND labels = "shipyard-T-01-01"',
  ]);
  assert.deepEqual(issue.lookup[0].on_match, { action: 'update' });
  for (const entry of issue.lookup.slice(1)) {
    assert.equal(entry.requires_source_of_truth, `acme/demo:${planPath}`);
    assert.equal(entry.accepts_unprefixed, planPath);
    assert.equal(entry.on_foreign, 'skip');
    assert.equal(entry.on_match.action, 'migrate');
    assert.equal(entry.on_match.add_label, 'shipyard-acme-demo-t-01-01');
    assert.equal(entry.on_match.pointer, pointer);
    assert.equal(entry.on_match.comment, 'label migrated');
  }
  assert.equal(issue.on_no_match, 'create');
});


test('the epic lookup has a legacy entry and the epic description carries one pointer line', () => {
  const p = project({ 'T-01-01': { phase: '01', title: 'Root', depends_on: [] } });
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  const epic = out.steps.find((s) => s.step === 'epic');
  const sourcePath = '.planning/phases/01-a-phase-title';
  const pointer = `Source of truth: acme/demo:${sourcePath} (this issue is a generated projection)`;

  assert.equal(epic.lookup.length, 2);
  assert.equal(epic.lookup[0].kind, 'primary');
  assert.equal(epic.lookup[0].label, 'shipyard-epic-acme-demo-01');
  assert.deepEqual(epic.lookup[0].on_match, { action: 'update' });
  assert.equal(epic.lookup[1].order, 2);
  assert.equal(epic.lookup[1].kind, 'legacy');
  assert.equal(epic.lookup[1].label, 'shipyard-epic-01');
  assert.equal(epic.lookup[1].requires_source_of_truth, `acme/demo:${sourcePath}`);
  assert.equal(epic.lookup[1].accepts_unprefixed, sourcePath);
  assert.equal(epic.lookup[1].on_foreign, 'skip');
  assert.equal(epic.lookup[1].on_match.action, 'migrate');
  assert.equal(epic.lookup[1].on_match.add_label, 'shipyard-epic-acme-demo-01');
  assert.equal(epic.lookup[1].on_match.pointer, pointer);
  assert.equal(epic.lookup[1].on_match.comment, 'label migrated');
  assert.equal(epic.on_no_match, 'create');

  const pointerLines = epic.description.split('\n').filter((l) => l.startsWith('Source of truth:'));
  assert.equal(pointerLines.length, 1);
  assert.equal(pointerLines[0], pointer);
});


suite('resolveLookup — ADR-004 D8 migration and foreign-repo refusal');

function issueStepFor(id) {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  return out.steps.find((s) => s.step === 'issue' && s.ticket === id);
}

test('resolveLookup refuses a foreign-repo legacy issue and falls through to create', () => {
  const issue = issueStepFor('T-01-01');
  const legacyOrder = issue.lookup.find((e) => e.kind === 'legacy').order;
  const hits = { [legacyOrder]: [{ key: 'MYD-999', description: 'Source of truth: other/repo:some/plan.md (this issue is a generated projection)' }] };
  assert.deepEqual(mod.resolveLookup(issue, hits), { action: 'create' });
});

test('resolveLookup migrates an unprefixed legacy issue with the label migrated note', () => {
  const issue = issueStepFor('T-01-01');
  const legacy = issue.lookup.find((e) => e.kind === 'legacy');
  const hits = { [legacy.order]: [{ key: 'MYD-7', description: `Source of truth: ${legacy.accepts_unprefixed} (this issue is a generated projection)` }] };
  assert.deepEqual(mod.resolveLookup(issue, hits), {
    action: 'migrate',
    key: 'MYD-7',
    add_label: legacy.on_match.add_label,
    pointer: legacy.on_match.pointer,
    comment: 'label migrated',
  });
});

test('resolveLookup migrates an ADR-004-spelled hit naming this repo', () => {
  const issue = issueStepFor('T-01-01');
  const adr004 = issue.lookup.find((e) => e.kind === 'adr-004');
  const hits = { [adr004.order]: [{ key: 'MYD-5', description: `Source of truth: acme/demo:${adr004.accepts_unprefixed} (this issue is a generated projection)` }] };
  assert.equal(mod.resolveLookup(issue, hits).action, 'migrate');
  assert.equal(mod.resolveLookup(issue, hits).key, 'MYD-5');
});

test('resolveLookup updates a namespaced hit', () => {
  const issue = issueStepFor('T-01-01');
  const primary = issue.lookup.find((e) => e.kind === 'primary');
  const legacy = issue.lookup.find((e) => e.kind === 'legacy');
  const hits = {
    [primary.order]: [{ key: 'MYD-3', description: 'anything' }],
    [legacy.order]: [{ key: 'MYD-4', description: `Source of truth: ${legacy.accepts_unprefixed} (this issue is a generated projection)` }],
  };
  assert.deepEqual(mod.resolveLookup(issue, hits), { action: 'update', key: 'MYD-3' });
});

test('resolveLookup reports two hits on one entry as ambiguous and never claims an issue without a pointer', () => {
  const issue = issueStepFor('T-01-01');
  const primary = issue.lookup.find((e) => e.kind === 'primary');
  const legacy = issue.lookup.find((e) => e.kind === 'legacy');
  const ambiguous = mod.resolveLookup(issue, { [primary.order]: [{ key: 'A', description: '' }, { key: 'B', description: '' }] });
  assert.deepEqual(ambiguous, { action: 'ambiguous', order: primary.order, keys: ['A', 'B'] });

  const noPointer = mod.resolveLookup(issue, { [legacy.order]: [{ key: 'MYD-8', description: 'no pointer line at all' }] });
  assert.deepEqual(noPointer, { action: 'create' });
});


suite('plan — --epic-issue-type none');

test('none yields no epic steps, and issue steps carry no epic reference', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD', epicIssueType: 'none' });
  assert.equal(out.steps.filter((s) => s.step === 'epic').length, 0);
  assert.equal(out.epic_issue_type, null);
  const issue = out.steps.find((s) => s.step === 'issue' && s.ticket === 'T-01-01');
  assert.equal(issue.epic, null);
});

test('the default epic issue type is Epic, and issues reference their phase', () => {
  const p = diamondAndChain();
  const out = mod.planExport(p.graph, { repo: 'acme/demo', project: 'MYD' });
  assert.equal(out.epic_issue_type, 'Epic');
  const epic = out.steps.find((s) => s.step === 'epic' && s.phase === '1');
  assert.equal(epic.summary, '[1] A phase title');
  const issue = out.steps.find((s) => s.step === 'issue' && s.ticket === 'T-01-01');
  assert.equal(issue.epic, '1');
});

test('CLI: --epic-issue-type none produces zero epic steps end to end', () => {
  const p = diamondAndChain();
  const out = run(p.graph, ['plan', '--repo', 'acme/demo', '--project', 'MYD', '--epic-issue-type', 'none', '--json']);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.json.steps.filter((s) => s.step === 'epic'), []);
});


suite('record — a targeted line edit inside the delivery: block');

test('record inserts jira: and changes only that one line', () => {
  const p = diamondAndChain();
  const planPath = path.join(p.dir, JSON.parse(fs.readFileSync(path.join(p.graph, 'tickets.json'), 'utf8')).tickets['T-01-01'].plan);
  const before = fs.readFileSync(planPath, 'utf8');
  const r = run(p.graph, ['record', 'T-01-01', 'MYD-42']);
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(planPath, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length + 1);
  const added = afterLines.filter((l) => !beforeLines.includes(l));
  assert.deepEqual(added, ['  jira: MYD-42']);
  const removed = beforeLines.filter((l) => !afterLines.includes(l));
  assert.deepEqual(removed, []);
  assert.ok(/^ {2}jira: MYD-42$/m.test(after));
});

test('record is idempotent: running it twice yields byte-identical files', () => {
  const p = diamondAndChain();
  const planPath = path.join(p.dir, JSON.parse(fs.readFileSync(path.join(p.graph, 'tickets.json'), 'utf8')).tickets['T-01-01'].plan);
  const first = run(p.graph, ['record', 'T-01-01', 'MYD-42']);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = fs.readFileSync(planPath, 'utf8');
  const second = run(p.graph, ['record', 'T-01-01', 'MYD-42']);
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = fs.readFileSync(planPath, 'utf8');
  assert.equal(afterFirst, afterSecond);
});

test('record replaces an existing jira: line rather than duplicating it', () => {
  const p = diamondAndChain();
  const planPath = path.join(p.dir, JSON.parse(fs.readFileSync(path.join(p.graph, 'tickets.json'), 'utf8')).tickets['T-01-01'].plan);
  run(p.graph, ['record', 'T-01-01', 'MYD-42']);
  const r = run(p.graph, ['record', 'T-01-01', 'MYD-99']);
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(planPath, 'utf8');
  assert.equal((after.match(/jira:/g) || []).length, 1);
  assert.ok(/^ {2}jira: MYD-99$/m.test(after));
});

test('record prints a reminder to re-run validate-graph.cjs', () => {
  const p = diamondAndChain();
  const r = run(p.graph, ['record', 'T-01-01', 'MYD-42']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /validate-graph\.cjs/);
});

suite('record — refusals, exit 1');

test('an unknown ticket id (well-formed but absent) is refused with exit 1', () => {
  const p = diamondAndChain();
  const r = run(p.graph, ['record', 'T-09-09', 'MYD-1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /T-09-09/);
});

test('a malformed ticket id is refused with exit 1', () => {
  const p = diamondAndChain();
  const r = run(p.graph, ['record', 'not-a-ticket', 'MYD-1']);
  assert.equal(r.status, 1);
});

test('a malformed Jira key is refused with exit 1', () => {
  const p = diamondAndChain();
  const r = run(p.graph, ['record', 'T-01-01', 'lowercase-1']);
  assert.equal(r.status, 1);
});


suite('jira-export touches no network — asserted as a SOURCE TOKEN sweep');

test('no client, no socket, no subprocess anywhere in jira-export.cjs', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const token of [/\bfetch\b/, /https?:/, /\bmcp\b/i, /\bgh\b/, /\bcurl\b/,
    /\bspawnSync\b/, /\bexecSync\b/, /\bchild_process\b/, /XMLHttpRequest/,
    /require\(['"](https?|net|tls|dgram)['"]\)/]) {
    assert.ok(!token.test(src), `jira-export.cjs must not contain ${token}`);
  }
});

done();
