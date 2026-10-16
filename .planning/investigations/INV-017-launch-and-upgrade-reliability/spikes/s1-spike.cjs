// S-1 spike: legacy provenance refusal on the v0.72.2 source, scratch HOME + scratch projects only.
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const SRC = process.argv[2];
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's1-spike-')));
const home = path.join(root, 'home'); fs.mkdirSync(home);
os.homedir = () => home; process.env.HOME = home;
delete process.env.SHIPYARD_GRAPH_DIR;
const dr = require(path.join(SRC, 'dispatch-record.cjs'));
const out = [];
let n = 0;
function project(legacy) {
  const p = path.join(root, `proj${++n}`); fs.mkdirSync(p);
  cp.execFileSync('git', ['init', '-q', p]);
  fs.mkdirSync(path.join(p, '.planning/graph/provenance'), { recursive: true });
  for (let i = 0; i < legacy; i++) fs.writeFileSync(path.join(p, `.planning/graph/provenance/dispatch-legacy${i}.json`), JSON.stringify({ host: 'codex', dispatch_id: `dispatch-legacy${i}`, ticket: 'T-01-01', role: 'executor' }) + '\n');
  return fs.realpathSync(p);
}
const sidecars = (p) => fs.readdirSync(path.join(p, '.planning/graph/provenance')).sort();
const authority = () => { const d = path.join(home, '.local/state/shipyard/role-artifact-authority'); return fs.existsSync(d) ? fs.readdirSync(d).map((h) => ({ h: h.slice(0, 8), files: fs.readdirSync(path.join(d, h)) })) : []; };
function attempt(label, p, host, extra, id) {
  const before = sidecars(p).length;
  let res;
  try {
    dr.recordInflight({ graphDir: path.join(p, '.planning/graph'), worktree: extra.worktree === undefined ? p : extra.worktree, ticket: 'T-01-01', role: 'executor', dispatch_id: id, pid: process.pid, host, refreshBoard: false });
    res = 'ACCEPTED';
  } catch (e) { res = `REFUSED ${e.code || ''} ${String(e.message).slice(0, 110)}`; }
  out.push({ label, host, result: res, sidecars_before: before, sidecars_after: sidecars(p).length, authority: authority().length });
}
// 1: clean project baseline
let p = project(0);
attempt('clean project, worktree=root', p, 'codex', {}, 'dispatch-new-1');
attempt('same project, second dispatch', p, 'codex', {}, 'dispatch-new-2');
// 2: legacy sidecars, no catalogue, one per host name (host only labels the row; all three hosts pass worktree=project root at v0.72.2)
for (const host of ['codex', 'claude']) {
  p = project(3);
  const hist = sidecars(p).map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(p, '.planning/graph/provenance', f))).digest('hex').slice(0, 8));
  attempt(`3 legacy sidecars, no catalogue, worktree=root (${host} call shape)`, p, host, {}, `dispatch-new-${host}`);
  const after = sidecars(p).map((f) => f.startsWith('dispatch-legacy') ? crypto.createHash('sha256').update(fs.readFileSync(path.join(p, '.planning/graph/provenance', f))).digest('hex').slice(0, 8) : null).filter(Boolean);
  out.push({ label: '  legacy bytes unchanged', ok: JSON.stringify(hist) === JSON.stringify(after) });
}
// 3: linked-worktree shape: worktree != project root, provenance non-empty => not required
p = project(3);
const linked = path.join(root, 'linked'); fs.mkdirSync(linked);
attempt('legacy sidecars, linked worktree (not required)', p, 'claude', { worktree: fs.realpathSync(linked) }, 'dispatch-linked-1');
attempt('  then the project-root host launches next', p, 'codex', {}, 'dispatch-next-1');
// 4: orphan: failed launch after record leaves a sidecar?  (clean project, accepted record, nothing clears it)
p = project(0);
attempt('clean, record then never cleared (failed launch)', p, 'codex', {}, 'dispatch-orphan-1');
attempt('  next launch with an orphan sidecar present', p, 'codex', {}, 'dispatch-orphan-2');
console.log(JSON.stringify(out, null, 1));
fs.rmSync(root, { recursive: true, force: true });
