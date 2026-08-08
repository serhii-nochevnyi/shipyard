#!/usr/bin/env node
'use strict';

// Gate 2 validator + generator of the ticket graph view.
//
// Scans .planning/phases/*/*-PLAN.md, reads plan frontmatter (GSD fields:
// phase, plan, type, wave, depends_on, files_modified, requirements + our
// `delivery:` block), validates the DAG and emits:
//   .planning/graph/tickets.json  (machine view, consumed by state-sync/deliver)
//   .planning/graph/tickets.yaml  (human view; generated -- do not edit)
//
// Checks: unique ticket ids, non-empty files_modified (the parallel-safety
// contract) and non-empty requirements, resolvable deps, no cycles, no
// files_modified overlap between dependency-unordered tickets, high risk =>
// human_checkpoint. Exits non-zero with an explicit error list when invalid.
//
// A ticket may target ANOTHER repository (`delivery.repo: owner/name`) — a phase
// that spans a backend and a frontend repo is normal. The repo is part of the
// graph's semantics, not decoration: branches do not exist across repos, so a
// dependency that crosses one cannot cascade (it has to MERGE first), and two
// tickets in different repos never "overlap" on an identical path.
//
// Every problem is COLLECTED and reported together: a malformed plan must not
// hide the other nine. The frontmatter parser lives in ./frontmatter.cjs.

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require(path.join(__dirname, 'frontmatter.cjs'));

const ROOT = process.cwd();
const PHASES_DIR = path.join(ROOT, '.planning', 'phases');
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');

function fail(msg) {
  console.error(`validate-graph: ${msg}`);
  process.exit(1);
}

function pad(n) {
  const s = String(n);
  return s.length >= 2 ? s : '0' + s;
}

// Ticket ids are compared as strings all over the conveyor (frontmatter,
// branches, PR titles, Jira labels), so they must normalize to ONE spelling:
// every numeric segment zero-padded to two digits. `T-1-1`, `01-02` and `5`
// (with phase 2) all resolve into the canonical `T-01-01` / `T-01-02` / `T-02-05`.
function normTicketId(id, phase) {
  if (id == null) return null;
  let s = String(id).trim();
  if (s === '') return null;
  if (/^t-/i.test(s)) s = s.slice(2);
  else if (/^\d+$/.test(s) && phase != null) s = `${phase}-${s}`;
  const parts = s.split('-').map((p) => (/^\d+$/.test(p) ? pad(p) : p.toUpperCase()));
  return 'T-' + parts.join('-');
}

// Branch naming: ticket/<ID>-<slug(title)>. The slug is the ticket title with
// all punctuation/symbols stripped: lowercase, Cyrillic transliterated,
// every run of non-[a-z0-9] collapsed to a single "-", trimmed, max 40 chars.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh',
  з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e',
  ё: 'e', ъ: '',
};
function slugify(title, max = 40) {
  const lat = String(title).toLowerCase().split('')
    .map((c) => (c in TRANSLIT ? TRANSLIT[c] : c)).join('');
  return lat
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}
function branchFor(id, title) {
  const slug = slugify(title);
  return slug ? `ticket/${id}-${slug}` : `ticket/${id}`;
}
const BRANCH_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._/-]*[a-zA-Z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// A path that leaves the repo root can never be delivered: the executor works in
// a `git worktree` whose parent directory is the worktree ROOT, so
// `../other-repo/x.ts` resolves to nothing there — which is how tickets aimed at
// a sibling checkout became permanent no-ops (the run kept them "ready", the
// executor found nothing, the front never emptied honestly).
// This is a WARNING plus a flag, not a Gate 2 error: an unreachable path breaks
// ONE ticket, and failing the gate would stop delivery for every valid ticket in
// the graph. state-sync parks the flagged ticket with this reason instead.
function escapesRepo(f) {
  const s = String(f);
  return s.startsWith('/') || s === '..' || s.startsWith('../') || s.split('/').includes('..');
}

// --- collect plans ---
if (!fs.existsSync(PHASES_DIR)) fail(`missing ${path.relative(ROOT, PHASES_DIR)} — run decomposition first`);

const planFiles = [];
for (const phaseDir of fs.readdirSync(PHASES_DIR).sort()) {
  const dir = path.join(PHASES_DIR, phaseDir);
  let stat;
  try { stat = fs.statSync(dir); } catch { continue; } // dangling symlink / vanished entry
  if (!stat.isDirectory()) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    if (/-PLAN\.md$/.test(f)) planFiles.push(path.join(dir, f));
  }
}
if (planFiles.length === 0) fail('no *-PLAN.md files under .planning/phases/');

const tickets = {};
const errors = [];
const warnings = [];

for (const file of planFiles.sort()) {
  const rel = path.relative(ROOT, file);
  const { data: fm, errors: fmErrors } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  for (const e of fmErrors) errors.push(`${rel}:${e.line}: ${e.message}`);
  if (!fm) { errors.push(`${rel}: missing frontmatter`); continue; }
  const delivery = fm.delivery && typeof fm.delivery === 'object' && !Array.isArray(fm.delivery) ? fm.delivery : {};
  if (fm.delivery != null && !Object.keys(delivery).length) {
    errors.push(`${rel}: delivery: is present but not a mapping — expected the ticket/risk/human_checkpoint block`);
  }
  const base = path.basename(file).replace(/-PLAN\.md$/, ''); // e.g. "01-02"
  const [fPhase] = base.split('-');
  const id = normTicketId(delivery.ticket, fm.phase ?? fPhase) || normTicketId(base, fPhase);
  if (tickets[id]) { errors.push(`${rel}: duplicate ticket id ${id} (also in ${tickets[id].file})`); continue; }

  // Duplicate deps would double-count in the topological sort and surface as a
  // phantom cycle, so they are collapsed here and surfaced as a warning.
  const rawDeps = Array.isArray(fm.depends_on) ? fm.depends_on : [];
  const deps = [];
  for (const d of rawDeps) {
    const nd = normTicketId(d, null);
    if (nd == null) continue;
    if (deps.includes(nd)) {
      warnings.push(`${id}: depends_on lists ${nd} more than once — collapsed`);
      continue;
    }
    deps.push(nd);
  }
  if (deps.includes(id)) {
    errors.push(`${id}: depends_on includes itself`);
  }

  const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : base;
  tickets[id] = {
    id,
    file: rel,
    title,
    phase: String(fm.phase ?? fPhase),
    phaseDir: path.basename(path.dirname(rel)),
    type: fm.type ?? 'implementation',
    depends_on: deps.filter((d) => d !== id),
    files: Array.isArray(fm.files_modified) ? fm.files_modified.map(String) : [],
    risk: String(delivery.risk ?? 'medium'),
    human_checkpoint: delivery.human_checkpoint === true,
    // default branch is derived from the ticket title (sanitized); an explicit
    // delivery.branch wins but must be a valid git ref chunk
    branch: delivery.branch || branchFor(id, title),
    // optional projection into an external tracker (written back by
    // /shipyard:decompose Step 5); pass-through only — never a Gate 2 input
    jira: delivery.jira != null ? String(delivery.jira) : null,
    // null = the project's own repo (where .planning/ lives)
    repo: delivery.repo != null && String(delivery.repo).trim() ? String(delivery.repo).trim() : null,
    declaredWave: Number.isInteger(fm.wave) ? fm.wave : null,
  };
  if (tickets[id].repo && !REPO_RE.test(tickets[id].repo)) {
    errors.push(`${id}: delivery.repo "${tickets[id].repo}" is not an owner/name slug (e.g. pdffiller/jsfiller)`);
  }
  if (delivery.branch && (!BRANCH_RE.test(delivery.branch) || String(delivery.branch).includes('..'))) {
    errors.push(`${id}: delivery.branch "${delivery.branch}" contains invalid characters — expected form: ${branchFor(id, title)}`);
  }
  if (!['low', 'medium', 'high'].includes(tickets[id].risk)) {
    errors.push(`${id}: delivery.risk "${tickets[id].risk}" is not one of low|medium|high`);
  }
  // Gate 2 core guarantee: files_modified is what makes the "dependency-unordered
  // tickets never touch the same paths" check (below) meaningful, and it is the
  // executor's scope contract (delivery-rules §4). An empty/missing list silently
  // turns the overlap check into a no-op — so it is a hard error, not a warning.
  if (tickets[id].files.length === 0) {
    errors.push(`${id}: files_modified is empty — Gate 2's file-overlap guarantee and the executor scope both depend on it (delivery-rules §4); list every path the plan touches`);
  } else {
    for (const f of tickets[id].files) {
      if (globPrefix(f) === '') {
        warnings.push(`${id}: files_modified entry "${f}" is a bare glob matching everything — narrow it (delivery-rules §4: resolve overlap by a dependency or a re-slice, never by widening globs)`);
      }
      if (/#/.test(f)) {
        errors.push(`${id}: files_modified entry "${f}" contains "#" — a YAML trailing comment leaked into the value; move the comment onto its own line`);
      }
      if (escapesRepo(f)) tickets[id].unreachable_paths = true;
    }
    if (tickets[id].unreachable_paths) {
      const outside = tickets[id].files.filter(escapesRepo);
      warnings.push(
        `${id}: ${outside.length} of ${tickets[id].files.length} files_modified entries point OUTSIDE the repo ` +
        `(e.g. "${outside[0]}") — a worktree executor cannot reach them, so this ticket cannot be delivered as ` +
        'written. If the work belongs to another repository, declare `delivery.repo: <owner>/<name>` and list the ' +
        'paths relative to THAT repo. state-sync parks the ticket until then.'
      );
    }
    // A ticket whose paths all live under a top-level directory this repo does
    // not have is the signature of an undeclared foreign-repo ticket — the exact
    // shape that reads as `pending` forever while its PR is green elsewhere.
    if (!tickets[id].repo && !tickets[id].unreachable_paths) {
      const missing = [...new Set(tickets[id].files
        .map((f) => globPrefix(f).split('/')[0])
        .filter((seg) => seg && !seg.includes('*')))]
        .filter((seg) => !fs.existsSync(path.join(ROOT, seg)));
      if (missing.length && missing.length === new Set(tickets[id].files.map((f) => globPrefix(f).split('/')[0])).size) {
        warnings.push(
          `${id}: every files_modified path is under "${missing.join('", "')}", which does not exist in this repo — ` +
          'if the ticket targets another repository declare `delivery.repo: <owner>/<name>`, otherwise ignore this ' +
          '(a brand-new top-level directory looks the same). An undeclared foreign ticket can never leave `pending`.'
        );
      }
    }
  }
  // depends_on must be an explicit decomposer decision, not an omission
  // ([] = a legitimate root ticket; a MISSING key is a smell worth surfacing).
  if (!Array.isArray(fm.depends_on)) {
    warnings.push(`${id}: frontmatter has no depends_on[] — declare it explicitly (use [] for a root ticket)`);
  }
  // requirements[] is mandatory (delivery-rules §1). GSD's plan-checker also
  // blocks on it, but the import path (deliver.md Step 0) can materialize plans
  // without GSD ever running — so Gate 2 must own this too, as a hard error.
  if (!Array.isArray(fm.requirements) || fm.requirements.length === 0) {
    errors.push(`${id}: frontmatter has no requirements[] — reference ROADMAP requirement ids (or the external tracker id for imported plans)`);
  } else {
    for (const r of fm.requirements) {
      if (/#/.test(String(r))) {
        errors.push(`${id}: requirements entry "${r}" contains "#" — a YAML trailing comment leaked into the value; move the comment onto its own line`);
      }
    }
  }
}

// --- referential integrity ---
for (const t of Object.values(tickets)) {
  for (const d of t.depends_on) {
    if (!tickets[d]) errors.push(`${t.id}: depends_on ${d} does not exist`);
  }
}

// --- cycle check + topo order (Kahn) ---
const order = [];
{
  const indeg = {};
  for (const id of Object.keys(tickets)) indeg[id] = 0;
  for (const t of Object.values(tickets)) {
    for (const d of t.depends_on) if (tickets[d]) indeg[t.id]++;
  }
  const q = Object.keys(indeg).filter((id) => indeg[id] === 0).sort();
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const t of Object.values(tickets)) {
      if (t.depends_on.includes(id) && --indeg[t.id] === 0) q.push(t.id);
    }
    q.sort();
  }
  if (order.length !== Object.keys(tickets).length) {
    const cyclic = Object.keys(tickets).filter((id) => !order.includes(id)).sort();
    errors.push(`dependency cycle involving: ${cyclic.join(', ')}`);
  }
}
const acyclic = order.length === Object.keys(tickets).length;

// --- transitive ancestors ---
// Computed iteratively over the TOPOLOGICAL order, so every dependency's closure
// is already complete before its dependents read it. (The previous recursive
// version shared one `visited` set across sibling branches and then memoized the
// truncated result — in a diamond that cached an EMPTY ancestor set for the
// second branch, which made Gate 2 report a properly-ordered pair as
// "dependency-unordered" and reject a valid graph.)
const ancestors = {};
if (acyclic) {
  for (const id of order) {
    const acc = new Set();
    for (const d of tickets[id].depends_on) {
      if (!tickets[d]) continue;
      acc.add(d);
      for (const a of ancestors[d]) acc.add(a);
    }
    ancestors[id] = acc;
  }
}

// --- files overlap between dependency-unordered tickets ---
function globPrefix(g) {
  const i = g.search(/[*?[]/);
  return (i === -1 ? g : g.slice(0, i)).replace(/\/+$/, '');
}
function overlaps(a, b) {
  const pa = globPrefix(a);
  const pb = globPrefix(b);
  if (!pa || !pb) return true; // bare glob like "**" overlaps everything
  return pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/');
}
if (acyclic) {
  const contested = new Map();
  const ids = Object.keys(tickets).sort();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = tickets[ids[i]];
      const b = tickets[ids[j]];
      if (ancestors[a.id].has(b.id) || ancestors[b.id].has(a.id)) continue;
      // Different repositories = different file systems: an identical path in two
      // repos is not a conflict, and treating it as one would force a bogus
      // dependency between a backend and a frontend ticket.
      if ((a.repo || null) !== (b.repo || null)) continue;
      for (const fa of a.files) {
        for (const fb of b.files) {
          if (overlaps(fa, fb)) {
            // Group by the CONTESTED PATH, not by the ticket pair. Reporting
            // every (pair × file) restates one fact once per combination: a
            // single hot file touched by four tickets produced six lines, and a
            // real graph produced 52 errors that were really a handful of files.
            // A gate whose output cannot be read is a gate that gets skimmed.
            const key = fa === fb ? fa : `${fa} ~ ${fb}`;
            const entry = contested.get(key) || { ids: new Set(), phases: new Set() };
            entry.ids.add(a.id); entry.ids.add(b.id);
            entry.phases.add(String(a.phase)); entry.phases.add(String(b.phase));
            contested.set(key, entry);
          }
        }
      }
    }
  }

  for (const [path_, { ids, phases }] of [...contested.entries()].sort()) {
    const who = [...ids].sort().join(', ');
    // The remedy depends on whether the clash crosses a phase boundary, and
    // getting this wrong sends the reader into a construct the conveyor warns
    // about: a cross-phase dependency cannot cascade (delivery-rules §7), so
    // "add a dependency" is advice that only works inside one phase.
    const remedy = phases.size > 1
      ? `these tickets span phases ${[...phases].sort().join('/')}, and a cross-phase dependency cannot cascade (there is no shared branch to stack on) — RE-SLICE so the path belongs to one phase, do not wire a dependency across them`
      : 'add a dependency between them, or re-slice';
    errors.push(`contested path "${path_}" — ${who} are dependency-unordered but all touch it; ${remedy}`);
  }
} else {
  warnings.push('file-overlap check skipped — fix the dependency cycle first');
}

// --- risk policy ---
for (const t of Object.values(tickets)) {
  if (t.risk === 'high' && !t.human_checkpoint) {
    errors.push(`${t.id}: risk is high but delivery.human_checkpoint is not true`);
  }
}

if (errors.length) {
  console.error(`validate-graph: INVALID (${errors.length} error(s))`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// --- waves (longest dependency depth) ---
const depth = {};
for (const id of order) {
  const deps = tickets[id].depends_on.filter((d) => tickets[d]);
  depth[id] = deps.length ? Math.max(...deps.map((d) => depth[d])) + 1 : 1;
}
// `wave` in the frontmatter is documentation for the human reader; the graph is
// authoritative. Surface a disagreement instead of silently overriding it.
for (const id of order) {
  const declared = tickets[id].declaredWave;
  if (declared != null && declared !== depth[id]) {
    warnings.push(`${id}: frontmatter wave: ${declared} disagrees with the computed dependency depth ${depth[id]} — the graph wins; fix the frontmatter`);
  }
}

// --- epic integration branches (epic-stacked delivery) ---
// One epic branch per phase, cut from the repo default branch at delivery time.
// Root tickets PR into the epic; a dependent ticket cascades — it PRs into its
// primary same-phase parent's branch, so the flow never blocks on a merge. The
// final PR is epic -> default branch. `base` is left null here: the runtime
// (epic-branch.sh / state-sync) resolves the real default branch (main|master).
const epics = {};
for (const id of order) {
  const t = tickets[id];
  if (!epics[t.phase]) epics[t.phase] = { branch: `epic/${t.phaseDir}`, base: null, phaseDir: t.phaseDir, repos: [] };
  else if (epics[t.phase].phaseDir !== t.phaseDir) {
    warnings.push(`phase ${t.phase} spans two directories (${epics[t.phase].phaseDir}, ${t.phaseDir}) — the epic branch is cut from the first one; keep one directory per phase`);
  }
  // One epic branch NAME per phase, but it has to exist in every repo the phase
  // touches — each repo integrates its own slice through its own epic PR.
  if (!epics[t.phase].repos.includes(t.repo || null)) epics[t.phase].repos.push(t.repo || null);
}
// primary parent = deepest same-phase, SAME-REPO dependency (tie-break: lowest
// id). Cascading means "PR into the parent's branch", and a branch does not
// exist outside its own repo — a cross-REPO parent (even in the same phase)
// therefore cannot be cascaded from and must merge first. Getting this wrong
// produced a `pr_base` pointing at a branch in another repository, so
// `gh pr create --base …` failed and the ticket stalled with no recovery path.
// A CROSS-phase dependency likewise cannot stack onto a branch in another epic:
// it is satisfied only once its own phase has landed on the default branch.
function primaryParent(t) {
  const same = t.depends_on.filter((d) => tickets[d] && tickets[d].phase === t.phase && (tickets[d].repo || null) === (t.repo || null));
  if (!same.length) return null;
  return same.slice().sort((a, b) => depth[b] - depth[a] || (a < b ? -1 : 1))[0];
}
for (const id of order) {
  const t = tickets[id];
  t.epic = epics[t.phase].branch;
  t.primary_parent = primaryParent(t);
  t.pr_base = t.primary_parent ? tickets[t.primary_parent].branch : t.epic;
  const same = t.depends_on.filter((d) => tickets[d] && tickets[d].phase === t.phase && (tickets[d].repo || null) === (t.repo || null));
  t.cross_repo_deps = t.depends_on.filter((d) => tickets[d] && (tickets[d].repo || null) !== (t.repo || null));
  t.cross_phase_deps = t.depends_on.filter((d) => tickets[d] && tickets[d].phase !== t.phase && (tickets[d].repo || null) === (t.repo || null));
  if (t.cross_repo_deps.length) {
    warnings.push(
      `${id}: dependency on ${t.cross_repo_deps.join(', ')} crosses a repository boundary (${t.repo || 'this repo'} ← ` +
      `${t.cross_repo_deps.map((d) => tickets[d].repo || 'this repo').join('/')}) — branches do not cascade across repos, so ` +
      `${id} waits for the parent's PR to MERGE and then PRs into its own epic. Slice contract changes so the consumer ` +
      'side can be written against the agreed shape instead of waiting.'
    );
  }
  if (same.length > 1) {
    warnings.push(
      `${id}: ${same.length} same-phase parents (${same.join(', ')}) — the cascade bases on ${t.primary_parent} only; the others land through the epic. Linearize the chain if ${id} needs every parent's code at once.`
    );
  }
  if (t.cross_phase_deps.length) {
    warnings.push(
      `${id}: cross-phase dependency on ${t.cross_phase_deps.join(', ')} — it cannot cascade through an epic, so ${id} stays blocked until phase ${t.cross_phase_deps.map((d) => tickets[d].phase).join('/')} has landed on the default branch. Prefer same-phase slicing.`
    );
  }
}

fs.mkdirSync(GRAPH_DIR, { recursive: true });
const view = {
  generated_by: 'validate-graph.cjs — do not edit by hand',
  epics: {},
  tickets: {},
};
for (const [phase, e] of Object.entries(epics)) {
  view.epics[phase] = { branch: e.branch, base: e.base, repos: e.repos };
}
for (const id of order) {
  const t = tickets[id];
  view.tickets[id] = {
    title: t.title,
    plan: t.file,
    phase: t.phase,
    repo: t.repo,
    wave: depth[id],
    depends_on: t.depends_on,
    cross_phase_deps: t.cross_phase_deps,
    cross_repo_deps: t.cross_repo_deps,
    unreachable_paths: t.unreachable_paths === true,
    files: t.files,
    risk: t.risk,
    type: t.type,
    human_checkpoint: t.human_checkpoint,
    branch: t.branch,
    epic: t.epic,
    primary_parent: t.primary_parent,
    pr_base: t.pr_base,
    jira: t.jira,
  };
}
fs.writeFileSync(path.join(GRAPH_DIR, 'tickets.json'), JSON.stringify(view, null, 2) + '\n');

// The YAML view is a convenience mirror, but it must still PARSE: an unquoted
// glob (`src/**/*.ts`) starts with a YAML alias indicator and a title with a
// quote breaks the document. Everything goes through one conservative quoter.
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  const plainSafe = /^[A-Za-z][A-Za-z0-9 ._/-]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(s) &&
    !/\s$/.test(s);
  return plainSafe ? s : `'${s.replace(/'/g, "''")}'`;
}
const yamlList = (arr) => `[${arr.map(yamlScalar).join(', ')}]`;

const yaml = [`# ${view.generated_by}`, 'epics:'];
for (const [phase, e] of Object.entries(view.epics)) {
  yaml.push(`  ${yamlScalar(phase)}:`);
  yaml.push(`    branch: ${yamlScalar(e.branch)}`);
  yaml.push(`    repos: ${yamlList(e.repos || [null])}`);
}
yaml.push('tickets:');
for (const [id, t] of Object.entries(view.tickets)) {
  yaml.push(`  ${yamlScalar(id)}:`);
  yaml.push(`    title: ${yamlScalar(t.title)}`);
  yaml.push(`    plan: ${yamlScalar(t.plan)}`);
  yaml.push(`    phase: ${yamlScalar(t.phase)}`);
  yaml.push(`    repo: ${yamlScalar(t.repo)}`);
  yaml.push(`    wave: ${t.wave}`);
  yaml.push(`    depends_on: ${yamlList(t.depends_on)}`);
  yaml.push(`    files: ${yamlList(t.files)}`);
  yaml.push(`    risk: ${yamlScalar(t.risk)}`);
  yaml.push(`    human_checkpoint: ${t.human_checkpoint}`);
  yaml.push(`    branch: ${yamlScalar(t.branch)}`);
  yaml.push(`    epic: ${yamlScalar(t.epic)}`);
  yaml.push(`    primary_parent: ${yamlScalar(t.primary_parent)}`);
  yaml.push(`    pr_base: ${yamlScalar(t.pr_base)}`);
  yaml.push(`    jira: ${yamlScalar(t.jira)}`);
}
fs.writeFileSync(path.join(GRAPH_DIR, 'tickets.yaml'), yaml.join('\n') + '\n');

const maxWave = order.length ? Math.max(...order.map((id) => depth[id])) : 0;
console.log(`validate-graph: OK — ${order.length} ticket(s), ${maxWave} wave(s)`);
for (const w of warnings) console.log(`  warning: ${w}`);
console.log('wrote .planning/graph/tickets.json and tickets.yaml');
