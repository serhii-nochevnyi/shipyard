'use strict';
const path = require('node:path');
const SRC = process.argv[2];
const sealer = require(path.join(SRC, 'planning-result-sealer.cjs'));
const contract = require(path.join(SRC, 'run-contract.cjs'));
const dr = require(path.join(SRC, 'dispatch-record.cjs'));
const at = require(path.join(SRC, 'architecture-target.cjs'));
const sha = 'a'.repeat(64), h40 = 'b'.repeat(40);
const repos = { plain: '/Volumes/KINGSTON/claude-shipyard/.git', space: '/Volumes/My Disk/claude-shipyard/.git', cyrillic: '/Users/сергій/репо/.git', tab: '/tmp/a\tb/.git', semicolon: '/tmp/a;b/.git', ownerrepo: 'serhii-nochevnyi/shipyard' };
const t = (f) => { try { const r = f(); return r === false ? 'refuse' : 'accept'; } catch (e) { return `refuse(${e.code || e.message.slice(0, 40)})`; } };
const rows = [];
for (const [k, r] of Object.entries(repos)) {
  rows.push({
    repo: k,
    'S2 seal build+match (sealer)': t(() => { const d = sealer.decompositionAdr; const m = d.SUBJECT_PATTERN.exec(d.decompositionSubject({ phase: 47, repository: r, adr: { sha256: sha } })); return !!m && m[2] === r; }),
    'S1 run subject planning (run-contract)': t(() => contract.normalizeTicketIdentity({ ticket: `phase=47;input=INV-017-x;repository=${r}` }, { role: 'decomposition', phase: 47 })),
    'S3 integrator (run-contract)': t(() => contract.normalizeTicketIdentity({ ticket: `phase=47-name;repository=${r};tickets=${sha}` }, { role: 'integrator', phase: 47 })),
    'S3 integrator (dispatch-record inflight)': t(() => dr.recordInflight && require(path.join(SRC, 'dispatch-record.cjs')) && /^phase=[A-Za-z0-9._-]+;repository=\/[^;\x00-\x1f]+;tickets=[a-f0-9]{64}$/.test(`phase=47-name;repository=${r};tickets=${sha}`)),
    'S4 arch-review PHASE_SUBJECT': t(() => at.PHASE_SUBJECT.test(`phase=47-name;repository=${r};tickets=${sha};pr=1;head=${h40};base=${h40}`)),
  });
}
console.table(rows);
console.log(Object.keys(contract).filter((k) => /ticket|identity/i.test(k)).join(','));
