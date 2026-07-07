#!/usr/bin/env node
'use strict';

// Gate 2 validator + generator of the ticket graph view.
//
// Scans .planning/phases/*/​*-PLAN.md, reads plan frontmatter (GSD fields:
// phase, plan, type, wave, depends_on, files_modified + our `delivery:` block),
// validates the DAG and emits:
//   .planning/graph/tickets.json  (machine view, consumed by state-sync/deliver)
//   .planning/graph/tickets.yaml  (human view; generated -- do not edit)
//
// Checks: unique ticket ids, resolvable deps, no cycles, no files_modified
// overlap between dependency-unordered tickets, high risk => human_checkpoint.
// Exits non-zero with an explicit error list when the graph is invalid.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PHASES_DIR = path.join(ROOT, '.planning', 'phases');
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');

function fail(msg) {
  console.error(`validate-graph: ${msg}`);
  process.exit(1);
}

// --- minimal YAML frontmatter parser (scalars, inline/block lists, one nested map) ---
function parseFrontmatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  let target = out;
  let targetIndent = 0;
  let lastKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent < targetIndent) { target = out; targetIndent = 0; }
    if (line.startsWith('- ')) {
      const key = lastKey;
      if (!key || !Array.isArray(target[key])) {
        fail(`${file}: stray list item "${line}" in frontmatter`);
      }
      target[key].push(scalar(line.slice(2)));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) fail(`${file}: unparseable frontmatter line "${line}"`);
    const [, key, valRaw] = kv;
    const val = valRaw.trim();
    if (val === '') {
      // block list or nested map follows; decide on the next line -- prepare both
      target[key] = [];
      if (indent === 0) {
        // could be a nested map (e.g. delivery:); switch target lazily
        out[key] = [];
        target = out;
        targetIndent = 0;
        lastKey = key;
        // peek handled implicitly: nested "k: v" lines with indent>0 convert below
        continue;
      }
      lastKey = key;
      continue;
    }
    if (indent > 0 && target === out && lastKey && Array.isArray(out[lastKey]) && out[lastKey].length === 0 && !line.startsWith('- ')) {
      // previous empty key was actually a nested map: convert
      out[lastKey] = {};
      target = out[lastKey];
      targetIndent = indent;
    }
    if (val.startsWith('[')) {
      const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
      target[key] = inner === '' ? [] : inner.split(',').map((s) => scalar(s));
    } else {
      target[key] = scalar(val);
    }
    if (target === out) lastKey = key;
  }
  return out;
}

function scalar(s) {
  const v = s.trim().replace(/^["']|["']$/g, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function normTicketId(id, phase) {
  if (id == null) return null;
  let s = String(id).trim();
  if (/^T-/i.test(s)) return 'T-' + s.slice(2).toUpperCase();
  if (/^\d+-\d+$/.test(s)) return 'T-' + s; // "01-02" -> "T-01-02"
  if (/^\d+$/.test(s) && phase != null) return `T-${pad(phase)}-${pad(s)}`;
  return s;
}

function pad(n) {
  const s = String(n);
  return s.length >= 2 ? s : '0' + s;
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

// --- collect plans ---
if (!fs.existsSync(PHASES_DIR)) fail(`missing ${path.relative(ROOT, PHASES_DIR)} — run decomposition first`);

const planFiles = [];
for (const phaseDir of fs.readdirSync(PHASES_DIR)) {
  const dir = path.join(PHASES_DIR, phaseDir);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (/-PLAN\.md$/.test(f)) planFiles.push(path.join(dir, f));
  }
}
if (planFiles.length === 0) fail('no *-PLAN.md files under .planning/phases/');

const tickets = {};
const errors = [];
const warnings = [];

for (const file of planFiles.sort()) {
  const rel = path.relative(ROOT, file);
  const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'), rel);
  if (!fm) { errors.push(`${rel}: missing frontmatter`); continue; }
  const delivery = typeof fm.delivery === 'object' && !Array.isArray(fm.delivery) ? fm.delivery : {};
  const base = path.basename(file).replace(/-PLAN\.md$/, ''); // e.g. "01-02"
  const [fPhase] = base.split('-');
  const id = normTicketId(delivery.ticket, fm.phase ?? fPhase) || `T-${base}`;
  if (tickets[id]) { errors.push(`${rel}: duplicate ticket id ${id} (also in ${tickets[id].file})`); continue; }
  const deps = (Array.isArray(fm.depends_on) ? fm.depends_on : [])
    .map((d) => normTicketId(d, null));
  const title = typeof fm.title === 'string' ? fm.title : base;
  tickets[id] = {
    id,
    file: rel,
    title,
    phase: String(fm.phase ?? fPhase),
    type: fm.type ?? 'implementation',
    depends_on: deps,
    files: Array.isArray(fm.files_modified) ? fm.files_modified.map(String) : [],
    risk: String(delivery.risk ?? 'medium'),
    human_checkpoint: delivery.human_checkpoint === true,
    // default branch is derived from the ticket title (sanitized); an explicit
    // delivery.branch wins but must be a valid git ref chunk
    branch: delivery.branch || branchFor(id, title),
  };
  if (delivery.branch && (!BRANCH_RE.test(delivery.branch) || String(delivery.branch).includes('..'))) {
    errors.push(`${id}: delivery.branch "${delivery.branch}" contains invalid characters — expected form: ${branchFor(id, title)}`);
  }
  // GSD 1.7: `requirements` is mandatory in plan frontmatter (empty = BLOCKER
  // in the plan-checker). Warn here so imported plans surface it before GSD does.
  if (!Array.isArray(fm.requirements) || fm.requirements.length === 0) {
    warnings.push(`${id}: frontmatter has no requirements[] — GSD 1.7 plan-checker treats this as a BLOCKER`);
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
const ancestors = {};
function ancestorsOf(id, seen = new Set()) {
  if (ancestors[id]) return ancestors[id];
  const acc = new Set();
  for (const d of tickets[id]?.depends_on ?? []) {
    if (!tickets[d] || seen.has(d)) continue;
    seen.add(d);
    acc.add(d);
    for (const a of ancestorsOf(d, seen)) acc.add(a);
  }
  ancestors[id] = acc;
  return acc;
}
const ids = Object.keys(tickets).sort();
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const a = tickets[ids[i]];
    const b = tickets[ids[j]];
    const ordered = ancestorsOf(a.id).has(b.id) || ancestorsOf(b.id).has(a.id);
    if (ordered) continue;
    for (const fa of a.files) {
      for (const fb of b.files) {
        if (overlaps(fa, fb)) {
          errors.push(`${a.id} and ${b.id} are dependency-unordered but touch overlapping paths ("${fa}" vs "${fb}") — add a dependency or re-slice`);
        }
      }
    }
  }
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

fs.mkdirSync(GRAPH_DIR, { recursive: true });
const view = {
  generated_by: 'validate-graph.cjs — do not edit by hand',
  tickets: {},
};
for (const id of order) {
  const t = tickets[id];
  view.tickets[id] = {
    title: t.title,
    plan: t.file,
    phase: t.phase,
    wave: depth[id],
    depends_on: t.depends_on,
    files: t.files,
    risk: t.risk,
    human_checkpoint: t.human_checkpoint,
    branch: t.branch,
  };
}
fs.writeFileSync(path.join(GRAPH_DIR, 'tickets.json'), JSON.stringify(view, null, 2) + '\n');

const yaml = [`# ${view.generated_by}`, 'tickets:'];
for (const [id, t] of Object.entries(view.tickets)) {
  yaml.push(`  ${id}:`);
  yaml.push(`    title: "${t.title}"`);
  yaml.push(`    plan: ${t.plan}`);
  yaml.push(`    phase: "${t.phase}"`);
  yaml.push(`    wave: ${t.wave}`);
  yaml.push(`    depends_on: [${t.depends_on.join(', ')}]`);
  yaml.push(`    files: [${t.files.join(', ')}]`);
  yaml.push(`    risk: ${t.risk}`);
  yaml.push(`    human_checkpoint: ${t.human_checkpoint}`);
  yaml.push(`    branch: ${t.branch}`);
}
fs.writeFileSync(path.join(GRAPH_DIR, 'tickets.yaml'), yaml.join('\n') + '\n');

console.log(`validate-graph: OK — ${order.length} ticket(s), ${Math.max(...Object.values(depth))} wave(s)`);
for (const w of warnings) console.log(`  warning: ${w}`);
console.log(`wrote .planning/graph/tickets.json and tickets.yaml`);
