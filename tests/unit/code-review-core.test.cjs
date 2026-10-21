'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, '../fixtures/code-review', name), 'utf8');
const read = name => file => file === 'source.js' ? fixture(name) : null;
const raw = () => JSON.parse(fixture('review.json'));
const review = (result = raw(), options = {}) => core.normalizeResult(result, { round: 1, scope: 'full', priorFindings: [], readSource: read('source.js'), ...options });
const code = expected => error => error.code === expected;
const carry = (findings, diff = '', source = 'source.js', disagreements = {}) => core.carryPriorFindings({ priorFindings: findings, deltaDiff: diff, readSource: read(source), disagreements });

test('tracer drops INFO, keeps WARNING and evidenced BLOCKER, and rejects false passes', () => {
  const result = review();
  assert.equal(result.verdict, 'needs-fix');
  assert.equal(result.blocking_count, 1);
  assert.equal(result.info_dropped, 1);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].citation, 'resolved');
  assert.equal(result.findings[0].rule, 'unlabelled');
  assert.deepEqual(result.findings[0].fix_ticket, raw().findings[0].fix_ticket);
  const missing = raw(); delete missing.findings[0].failure_scenario;
  assert.equal(review(missing).demoted_for_evidence, 1);
  assert.equal(review(missing).verdict, 'pass');
  assert.throws(() => review({ ...raw(), verdict: 'pass' }), code('JUDGMENT_OUTCOME_MISMATCH'));
  const incomplete = { ...raw(), review_completeness: 'incomplete', limitations: ['unread file'] };
  assert.equal(review(incomplete).verdict, 'incomplete');
  assert.throws(() => review({ ...incomplete, verdict: 'pass' }), code('JUDGMENT_OUTCOME_MISMATCH'));
  for (const changes of [{ findings: Array(129).fill(raw().findings[0]) }, { limitations: Array(129).fill('x') }, { unresolved_sources: ['x'.repeat(1025)] }])
    assert.throws(() => review({ ...raw(), ...changes }));
  for (const field of ['id', 'severity', 'summary']) {
    const value = raw(); delete value.findings[0][field]; assert.throws(() => review(value));
  }
});

test('host identity survives line shifts, labels, whitespace and severity; statements differ', () => {
  const first = review().findings[0];
  const shifted = carry([first], fixture('shift-u50.diff'), 'shift.js');
  assert.equal(shifted[0].line, 112); assert.equal(shifted[0].delta_touch, false);
  assert.equal(shifted[0].identity, first.identity);
  const result = review({ ...raw(), dispositions: [{ref:'P-01',disposition:'unresolved',justification:'Still present'}], findings: [{ ...raw().findings[0], id: 'WR-77', severity: 'WR', line: 112, rule: 'other-label', summary: 'Other prose' }] }, { priorFindings: shifted, readSource: read('shift.js') });
  assert.equal(result.findings[0].classification, 'prior');
  assert.equal(result.findings[0].ref, 'P-01');
  assert.equal(core.lineIdentity({ path: './source.js', lineText: '\t const\u00a0 value100 = 100; ', ordinal: 1 }), first.identity);
  assert.notEqual(core.lineIdentity({ path: 'source.js', lineText: 'const other100 = 100;', ordinal: 1 }), first.identity);
  assert.equal(core.normalizeSourceLine(' e\u0301\t \u00a0x\r'), 'é x');
});

test('identical source lines have ordinals and are reread when a twin is inserted above', () => {
  const base = { ...raw(), findings: [2,4,6].map((line,i) => ({ id: 'WR-'+i, severity: 'WARNING', summary: 'Repeated return', path: 'source.js', line })) };
  const first = review(base, { readSource: read('twins.js') });
  assert.deepEqual(first.findings.map(f => f.occurrence), [1,2,3]);
  assert.equal(new Set(first.findings.map(f => f.identity)).size, 3);
  const prior = carry(first.findings, fixture('twins.diff'), 'twins-added.js');
  assert.deepEqual(prior.map(f => f.occurrence), [2,3,4]);
  const second = review({ ...base, findings: base.findings.map(f => ({ ...f, line: f.line+1 })) }, { priorFindings: prior, readSource: read('twins-added.js') });
  assert.deepEqual(second.findings.map(f => f.ref), ['P-01','P-02','P-03']);
  assert.equal(second.findings.length, 3);
});

test('missing and unmatched citations are retained as new, never suppressible', () => {
  const bad = [ { path: '/abs' }, { path: '../escape' }, { path: 'a\\b' }, { path: 'a\u0000' }, { path: '' }, { line: 1.5 }, { line: 999 }, { path: 'absent.js' }, { line_text: 'another statement' }, { line_text: '   ' } ];
  for (const patch of bad) {
    const result = review({ ...raw(), findings: [{ ...raw().findings[0], ...patch }] });
    const finding = result.findings[0];
    assert.equal(finding.classification, 'new'); assert.equal(finding.identity, null);
    assert.equal(finding.line_text, null); assert.equal(finding.occurrence, null);
    assert.equal(result.citations_unresolved, 1); assert.equal(result.findings.length, 1);
    assert.equal(finding.severity, core.normalizeCitedPath(patch.path ?? 'source.js') && Number.isInteger(patch.line ?? 100) ? 'BLOCKER' : 'WARNING');
  }
  for (const text of ['a\u0000b\n', '\n', 'x'.repeat(core.SOURCE_MAX_BYTES+1)]) {
    assert.equal(core.resolveCitation({ path: 'source.js', line: 1, readSource: () => text }).citation, 'missing');
  }
  assert.equal(core.resolveCitation({ path: 'source.js', line: 2, readSource: () => 'one\n' }).citation, 'missing');
  assert.equal(core.resolveCitation({ path: 'source.js', line: 1, readSource: () => { throw Error('unreadable'); } }).citation, 'missing');
});

test('source reader accepts one regular blob, bounds and caches git reads', () => {
  let calls = [];
  const git = (args, maxBuffer) => { calls.push([args,maxBuffer]); return args[0] === 'ls-tree' ? '100644 blob '+ 'a'.repeat(40)+'\tsource.js\0' : 'hello\n'; };
  const reader = core.createSourceReader({ git, head: 'a'.repeat(40) });
  assert.equal(reader('source.js'), 'hello\n'); assert.equal(reader('source.js'), 'hello\n'); assert.equal(calls.length, 2);
  assert.equal(calls[1][1], core.SOURCE_MAX_BYTES);
  for (const tree of ['120000 blob ', '160000 commit ', '', '100644 tree ']) {
    const r = core.createSourceReader({ head: 'a'.repeat(40), git: () => tree && tree+'a'.repeat(40)+'\tsource.js\0' });
    assert.equal(r('source.js'), null);
  }
  for (const output of ['x\0', 'x'.repeat(core.SOURCE_MAX_BYTES+1)])
    assert.equal(core.createSourceReader({ head: 'a'.repeat(40), git: args => args[0] === 'ls-tree' ? '100755 blob '+'a'.repeat(40)+'\tsource.js\0' : output })('source.js'), null);
  assert.equal(core.createSourceReader({ head: 'a'.repeat(40), git: () => { throw Error('git failed'); } })('source.js'), null);
});

test('all lines map identically at context sizes 0, 3 and 50, and nearby fixes preserve identity', () => {
  for (const key of ['A','B','C']) {
    for (let line = 1; line <= 220; line++) {
      const expected = key === 'A' && [70,105,149].includes(line) ? { touched: true }
        : key === 'B' && line > 90 ? { line: line+3 }
        : key === 'C' && [81,82].includes(line) ? { touched: true }
        : { line: key === 'C' && line > 82 ? line-2 : line };
      for (const context of [0,3,50]) assert.deepEqual(core.mapLineThroughDiff('source.js', line, fixture(key+'-u'+context+'.diff')), expected, `${key} u${context} line ${line}`);
    }
    const first = review().findings[0];
    const prior = carry([first], fixture(key+'-u50.diff'), key+'.js');
    assert.equal(prior[0].delta_touch, false); assert.equal(prior[0].identity, first.identity);
    assert.equal(prior[0].line, key === 'A' ? 100 : key === 'B' ? 103 : 98);
    const second = review({ ...raw(), findings: [{ ...raw().findings[0], line: prior[0].line }], dispositions: [{ ref:'P-01', disposition:'unresolved', justification:'Still present' }] }, { priorFindings: prior, readSource: read(key+'.js') });
    assert.equal(second.findings[0].classification, 'prior');
  }
  for (const line of [70,105,149]) {
    const earlier = review({ ...raw(), findings: [{ ...raw().findings[0], line, line_text: undefined }] }).findings[0];
    assert.equal(carry([earlier],fixture('A-u50.diff'),'A.js')[0].identity, null);
  }
});

test('diff parser reads prefixes and exact counts, refuses malformed, renamed and deleted sections', () => {
  const prefix = 'diff --git a/source.js b/source.js\n--- a/source.js\n+++ b/source.js\n';
  const body = Array(50).fill(' context').concat(['----old', '++++new'], Array(50).fill(' @@content')).join('\n');
  const diff = prefix+'@@ -1,101 +1,101 @@\n'+body+'\n\\ No newline at end of file\n';
  for (let line=1; line<=101; line++) assert.deepEqual(core.mapLineThroughDiff('source.js',line,diff), line===51 ? {touched:true} : {line});
  for (const tail of ['@@ invalid\n', '@@ -1,2 +1,2 @@\n one\n', '@@ -1 +1 @@\n one\n extra\n', '@@ -2 +2 @@\n x\n@@ -1 +1 @@\n y\n', 'rename from source.js\nrename to other.js\n', 'deleted file mode 100644\n'])
    assert.deepEqual(core.mapLineThroughDiff('source.js',100,prefix+tail),{touched:true});
  assert.deepEqual(core.mapLineThroughDiff('absent.js',5,diff),{line:5});
  assert.deepEqual(core.mapLineThroughDiff('source.js',0,diff),{touched:true});
});

test('prior blockers require dispositions, unresolved stays once, resolved contradictions fail', () => {
  const prior = carry(review().findings);
  assert.throws(() => review({ ...raw(), findings: [] }, { priorFindings: prior }), code('JUDGMENT_OUTCOME_MISMATCH'));
  for (const disposition of ['resolved','disputed','unresolved']) {
    const result = review({ ...raw(), findings: [], dispositions: [{ ref:'P-01', disposition, justification:'Checked the failure' }] }, { priorFindings: prior });
    assert.equal(result.blocking_count, disposition === 'unresolved' ? 1 : 0);
    assert.equal(result.findings.filter(f=>f.severity==='WARNING').length,1);
  }
  assert.throws(() => review({ ...raw(), dispositions: [{ ref:'P-01', disposition:'resolved' }] }, { priorFindings: prior }), code('JUDGMENT_OUTCOME_MISMATCH'));
  const unresolved = review({ ...raw(), dispositions: [{ ref:'P-01', disposition:'unresolved', justification:'Still fails' }] }, { priorFindings: prior });
  assert.equal(unresolved.findings.length,2); assert.equal(unresolved.blocking_count,1);
  const touched = carry(review().findings,fixture('C-u50.diff'),'C.js');
  assert.equal(touched[0].delta_touch,false);
});

test('recorded disagreements match stored identity across shifts and survive into another round', () => {
  const first = review();
  const prior = carry(first.findings, fixture('shift-u50.diff'), 'shift.js');
  const entries = core.parseDisagreements(fixture('disagreements.json'), { priorFindings: prior });
  const carried = carry(first.findings, fixture('shift-u50.diff'), 'shift.js', entries);
  assert.equal(carried[0].disagreement.recorded_by,'operator');
  const result = review({ ...raw(), findings: [{...raw().findings[0],line:112}] }, { priorFindings:carried,readSource:read('shift.js') });
  assert.equal(result.blocking_count,0); assert.equal(result.disagreement_suppressed,1);
  assert.equal(result.findings[0].suppressed,true); assert.equal(result.findings[0].blocking,false);
  assert.equal(result.dispositions[0].source,'recorded_disagreement');
  const next = carry(result.findings,'','shift.js', entries);
  assert.equal(next[0].disagreement.reason,carried[0].disagreement.reason);
  const loaded = core.loadDisagreements({projectRoot:'/project',phaseDirName:'52-review',priorFindings:prior,readFile:()=>({text:fixture('disagreements.json'),stat:{isFile:()=>true,isSymbolicLink:()=>false}})});
  assert.match(loaded.dispositions_digest,/^[a-f0-9]{64}$/);
  for (const file of ['disagreements-invalid.json','disagreements-duplicate.json']) assert.throws(()=>core.parseDisagreements(fixture(file),{priorFindings:prior}),code('DISPOSITIONS_INVALID'));
  for (const occurrence of [0,-1,1.5]) {
    const value = JSON.parse(fixture('disagreements.json')); value.entries[0].occurrence=occurrence;
    assert.throws(()=>core.parseDisagreements(JSON.stringify(value),{priorFindings:prior}),code('DISPOSITIONS_INVALID'));
  }
  assert.throws(()=>core.parseDisagreements(fixture('disagreements.json'),{priorFindings:[]}),code('DISPOSITION_TARGET_UNKNOWN'));
  assert.throws(()=>core.parseDisagreements('x'.repeat(65537),{priorFindings:prior}),code('DISPOSITIONS_INVALID'));
  for (const type of ['symlink','directory']) assert.throws(()=>core.loadDisagreements({projectRoot:'/project',phaseDirName:'52-review',priorFindings:prior,readFile:()=>({text:'',stat:{isFile:()=>false,isSymbolicLink:()=>type==='symlink'}})}),code('DISPOSITIONS_INVALID'));
  assert.deepEqual(core.loadDisagreements({projectRoot:'/project',phaseDirName:'52-review',priorFindings:prior,readFile:()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}}),{entries:{},dispositions_digest:null});
});

test('rounds count only complete full-scope lineage, independently of ticket set and contract', () => {
  const priorVerdicts = [1,2,3].map((n)=>({head:'h'+n, sealed_at:'2026-01-0'+n, review_completeness:'complete', review_scope:n===1?'full':'delta', prior_head:n===1?null:'h'+(n-1), ticket_set_digest:String(n),contract_digest:String(n),base_commit:'base'+n,pr:n}));
  for(let n=0;n<=3;n++) {
    const actual = core.nextRound({priorVerdicts:priorVerdicts.slice(0,n),head:'current',isAncestor:()=>true});
    assert.equal(actual.rounds_used,n); assert.equal(actual.round,n===3?null:n+1);
    if(n<3) { assert.equal(actual.scope,n===0?'full':'delta'); if(n) assert.equal(actual.deltaBase,'h'+n); }
    else assert.equal(actual.state,'limit');
  }
  assert.equal(core.lineageComplete({verdict:priorVerdicts[2],priorVerdicts}),true);
  const incomplete = [{...priorVerdicts[0],review_completeness:'incomplete'},priorVerdicts[1]];
  assert.equal(core.nextRound({priorVerdicts:incomplete,head:'current',isAncestor:()=>true}).round,1);
  assert.equal(core.lineageComplete({verdict:priorVerdicts[1],priorVerdicts:incomplete}),false);
  assert.equal(core.nextRound({priorVerdicts,head:'current',isAncestor:()=>false}).round,1);
  assert.deepEqual([1,2,3].map(core.repairAllowed),[true,true,false]);
});

test('packet hides host digests, binds subject identity and refuses missing vocabulary', () => {
  const identity = {id:'subject',repository:'/repo',pr:1,head:'h',base_commit:'b',merge_base:'m',base_tree:'t',ticket_set_digest:'d'};
  const options = {subject:'subject',identity,exactDiff:'',integrationBase:'main',ticketSet:[],planAcceptance:[],priorFindings:carry(review().findings),round:{round:1,scope:'full'},changeMetadata:{},referenceDigest:'a'.repeat(64)};
  const packet = core.assemblePacket(options);
  assert.equal(packet.focused.id,'subject'); assert.equal(packet.review_contract,core.CONTRACT_ID);
  assert(!Object.hasOwn(packet.prior_findings[0],'identity')); assert(!Object.hasOwn(packet.prior_findings[0],'stored_identity'));
  const retained = core.assemblePacket({ ...options, priorFindings: [{ ...options.priorFindings[0], disagreement_identity: 'a'.repeat(64) }] });
  assert(!Object.hasOwn(retained.prior_findings[0], 'disagreement_identity'));
  for(const key of ['exactDiff','integrationBase','ticketSet','planAcceptance','priorFindings']) { const value={...options}; delete value[key]; assert.throws(()=>core.assemblePacket(value)); }
  assert.throws(()=>core.assemblePacket({...options,subject:'different'}));
  const key = core.reuseKey({head:'h',baseCommit:'b',contractDigest:'c'});
  assert.notEqual(key,core.reuseKey({head:'h',baseCommit:'other',contractDigest:'c'}));
  assert.notEqual(key,core.reuseKey({head:'h',baseCommit:'b',contractDigest:'other'}));
});

test('evidence demotion covers every missing blocker field and unresolved prior input cannot match', () => {
  for (const patch of [{path:null},{line:0},{line:'100'},{failure_scenario:''},{failure_scenario:null},{fix_ticket:null},{fix_ticket:{title:'Incomplete'}}]) {
    const result=review({...raw(),findings:[{...raw().findings[0],...patch}]});
    assert.equal(result.demoted_for_evidence,1); assert.equal(result.findings[0].severity,'WARNING'); assert.equal(result.blocking_count,0);
  }
  const first=review({...raw(),findings:[{...raw().findings[0],line_text:'wrong quote'}]});
  const prior=carry(first.findings);
  assert.equal(prior[0].stored_identity,null);assert.equal(prior[0].identity,null);assert.equal(prior[0].delta_touch,false);
  const second=review({...raw(),findings:[{...raw().findings[0],line_text:'wrong quote'}],dispositions:[{ref:'P-01',disposition:'unresolved',justification:'Still fails'}]},{priorFindings:prior});
  assert.equal(second.findings.filter(f=>f.classification==='new').length,1);
  assert.equal(second.citations_unresolved,1);assert.equal(second.blocking_count,2);
});

test('disposition bounds refuse unknown, duplicate or missing justification and malformed carrier entries', () => {
  const prior=carry(review().findings);
  for(const dispositions of [[{ref:'P-99',disposition:'resolved'}],[{ref:'P-01',disposition:'unresolved'}],[{ref:'P-01',disposition:'disputed'}],[{ref:'P-01',disposition:'resolved'},{ref:'P-01',disposition:'resolved'}]])
    assert.throws(()=>review({...raw(),findings:[],dispositions},{priorFindings:prior}),code('JUDGMENT_OUTCOME_MISMATCH'));
  for(const patch of [{reason:'x'.repeat(1025)},{recorded_by:'x'.repeat(129)},{line_text:'x'.repeat(1025)},{path:'../escape'},{occurrence:'1'},{rule:'not-a-carrier-field'}]) {
    const value=JSON.parse(fixture('disagreements.json'));Object.assign(value.entries[0],patch);
    assert.throws(()=>core.parseDisagreements(JSON.stringify(value),{priorFindings:prior}),code('DISPOSITIONS_INVALID'));
  }
  const value=JSON.parse(fixture('disagreements.json'));value.entries=Array(129).fill(value.entries[0]);
  assert.throws(()=>core.parseDisagreements(JSON.stringify(value),{priorFindings:prior}),code('DISPOSITIONS_INVALID'));
  assert.throws(()=>core.parseDisagreements('{',{priorFindings:prior}),code('DISPOSITIONS_INVALID'));
});

test('untouched context warnings remain, changed warnings leave, and missing current citations never vanish', () => {
  const finding=review({...raw(),findings:[{id:'WR-01',severity:'WARNING',path:'source.js',line:105,summary:'A changed statement'}]}).findings[0];
  const prior=carry([finding],fixture('A-u50.diff'),'A.js');
  assert.equal(prior[0].delta_touch,true);assert.equal(prior[0].identity,null);
  assert.equal(review({...raw(),findings:[]},{priorFindings:prior,readSource:read('A.js')}).findings.length,0);
  const returned=review({...raw(),findings:[{...raw().findings[0],line:105,line_text:'const repaired105 = true;'}]},{priorFindings:prior,readSource:read('A.js')});
  assert.equal(returned.findings[0].classification,'new');assert.equal(returned.findings[0].severity,'BLOCKER');
  const noSource=review({...raw(),findings:[raw().findings[0]]},{readSource:()=>null});
  assert.equal(noSource.findings[0].severity,'BLOCKER');assert.equal(noSource.findings[0].classification,'new');
});

test('diff sections support standalone unified, spaces and Git quoted UTF-8 paths', () => {
  const hunk='@@ -1,2 +1,3 @@\n one\n+inserted\n two\n';
  for(const file of ['source.js','space name.js']) {
    const diff=`--- a/${file}\n+++ b/${file}\n${hunk}`;
    assert.deepEqual(core.mapLineThroughDiff(file,2,diff),{line:3});
  }
  const file='é.js', quoted='"a/\\303\\251.js" "b/\\303\\251.js"';
  assert.deepEqual(core.mapLineThroughDiff(file,2,'diff --git '+quoted+'\n--- "a/\\303\\251.js"\n+++ "b/\\303\\251.js"\n'+hunk),{line:3});
  const noNewlineExtra='diff --git a/source.js b/source.js\n@@ -1 +1 @@\n one\n\\ No newline at end of file\n extra\n';
  assert.deepEqual(core.mapLineThroughDiff('source.js',4,noNewlineExtra),{touched:true});
});

test('a recorded disagreement stays on its original twin through three rounds', () => {
  const first = review({ ...raw(), findings: [2,4,6].map((line, index) => ({
    ...raw().findings[0], id: 'CR-' + index, line, line_text: 'return null;',
  })) }, { readSource: read('twins.js') });
  const text = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [{
    path: 'source.js', line_text: 'return null;', occurrence: 2,
    reason: 'The middle caller handles absence', recorded_by: 'operator',
  }] });
  let carried = carry(first.findings, '', 'twins.js');
  const entries = core.parseDisagreements(text, { priorFindings: carried });
  carried = carry(first.findings, fixture('twins.diff'), 'twins-added.js', entries);
  const second = review({ ...raw(), findings: [], dispositions: [
    { ref: 'P-01', disposition: 'unresolved', justification: 'First caller still fails' },
    { ref: 'P-03', disposition: 'unresolved', justification: 'Last caller still fails' },
  ] }, { round: 2, scope: 'delta', priorFindings: carried, readSource: read('twins-added.js') });
  assert.deepEqual(second.findings.map(f => [f.line, f.suppressed === true]), [[3,false],[5,true],[7,false]]);
  const latest = carry(second, '', 'twins-added.js');
  const unchangedFile = core.parseDisagreements(text, { priorFindings: latest });
  const thirdPrior = carry(second, '', 'twins-added.js', unchangedFile);
  assert.deepEqual(thirdPrior.map(f => Boolean(f.disagreement)), [false,true,false]);
  const third = review({ ...raw(), findings: [], dispositions: second.dispositions.filter(d => d.source === 'reviewer') },
    { round: 3, scope: 'delta', priorFindings: thirdPrior, readSource: read('twins-added.js') });
  assert.deepEqual(third.findings.map(f => [f.line, f.suppressed === true]), [[3,false],[5,true],[7,false]]);
  assert.equal(third.blocking_count, 2);
  assert.equal(third.disagreement_suppressed, 1);
});

test('a single recorded target remains known after its occurrence ordinal changes', () => {
  const first = review({ ...raw(), findings: [{ ...raw().findings[0], line: 4, line_text: 'return null;' }] }, { readSource: read('twins.js') });
  const text = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [{
    path: 'source.js', line_text: 'return null;', occurrence: 2, reason: 'Caller handles absence', recorded_by: 'operator',
  }] });
  const entries = core.parseDisagreements(text, { priorFindings: carry(first.findings, '', 'twins.js') });
  const prior = carry(first.findings, fixture('twins.diff'), 'twins-added.js', entries);
  const second = review({ ...raw(), findings: [] }, { round: 2, scope: 'delta', priorFindings: prior, readSource: read('twins-added.js') });
  const latest = carry(second, '', 'twins-added.js');
  const reloaded = core.parseDisagreements(text, { priorFindings: latest });
  const thirdPrior = carry(second, '', 'twins-added.js', reloaded);
  assert.equal(thirdPrior[0].disagreement.reason, 'Caller handles absence');
  const third = review({ ...raw(), findings: [] }, { round: 3, scope: 'delta', priorFindings: thirdPrior, readSource: read('twins-added.js') });
  assert.equal(third.blocking_count, 0);
  assert.equal(third.disagreement_suppressed, 1);
});

test('colliding boundary-size finding labels remain deterministic, unique and within 128 UTF-8 bytes', () => {
  for (const id of ['x'.repeat(128), 'é'.repeat(64), '界'.repeat(42) + 'ab']) {
    const first = review({ ...raw(), findings: [{ ...raw().findings[0], id }] });
    const prior = carry(first.findings);
    const result = { ...raw(), findings: [{ id, severity: 'WARNING', summary: 'Another statement', path: 'source.js', line: 101 }],
      dispositions: [{ ref: 'P-01', disposition: 'unresolved', justification: 'Still fails' }] };
    const options = { round: 2, scope: 'delta', priorFindings: prior };
    const second = review(result, options);
    assert.equal(new Set(second.findings.map(f => f.id)).size, 2);
    for (const finding of second.findings) assert(Buffer.byteLength(finding.id) <= 128, finding.id);
    assert.deepEqual(second, review(result, options));
  }
});

test('retained disagreements keep their original carrier identity and ignore model-supplied bindings', () => {
  const first = review({ ...raw(), findings: [{ ...raw().findings[0], line: 4, line_text: 'return null;' }] }, { readSource: read('twins.js') });
  const entry = { path: 'source.js', line_text: 'return null;', occurrence: 2, reason: 'Caller handles absence', recorded_by: 'operator' };
  const text = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [entry] });
  const disagreements = core.parseDisagreements(text, { priorFindings: carry(first.findings, '', 'twins.js') });
  const priorFindings = carry(first.findings, fixture('twins.diff'), 'twins-added.js', disagreements);
  const second = review({ ...raw(), findings: [] }, { round: 2, scope: 'delta', priorFindings, readSource: read('twins-added.js') });
  const latest = carry(second, '', 'twins-added.js');
  const duplicate = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [entry, entry] });
  assert.throws(() => core.parseDisagreements(duplicate, { priorFindings: latest }), code('DISPOSITIONS_INVALID'));
  assert.throws(() => core.parseDisagreements(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [{ ...entry, occurrence: 3 }] }), { priorFindings: latest }), code('DISPOSITION_TARGET_UNKNOWN'));
  assert.equal(latest[0].disagreement_identity, first.findings[0].identity);
  const forged = review({ ...raw(), findings: [{ ...raw().findings[0], disagreement_identity: first.findings[0].identity, suppressed: true }] });
  assert.equal(forged.blocking_count, 1);
  assert(!Object.hasOwn(forged.findings[0], 'disagreement_identity'));
});

test('generated collision labels cannot steal a model label reserved elsewhere in the index', () => {
  const id = 'x'.repeat(128);
  const first = review({ ...raw(), findings: [{ ...raw().findings[0], id }] });
  const priorFindings = carry(first.findings);
  const reserved = 'finding-3-' + require('node:crypto').createHash('sha256').update(id).digest('hex');
  const result = { ...raw(), findings: [
    { id, severity: 'WARNING', summary: 'Another statement', path: 'source.js', line: 101 },
    { id: reserved, severity: 'WARNING', summary: 'A third statement', path: 'source.js', line: 102 },
  ], dispositions: [{ ref: 'P-01', disposition: 'unresolved', justification: 'Still fails' }] };
  const normalized = review(result, { priorFindings });
  assert.equal(normalized.findings.length, 3);
  assert.equal(new Set(normalized.findings.map(finding => finding.id)).size, 3);
  assert.equal(normalized.findings[1].id, reserved);
  assert(normalized.findings.every(finding => Buffer.byteLength(finding.id) <= 128));
});

test('a recorded WARNING keeps its original severity and sealable shape when returned as a BLOCKER', () => {
  const first = review({ ...raw(), findings: [{ ...raw().findings[0], severity: 'WARNING' }] });
  const priorFindings = carry(first.findings, '', 'source.js', {
    [first.findings[0].identity]: { reason: 'The caller handles this case', recorded_by: 'operator' },
  });
  const second = review({ ...raw(), findings: [raw().findings[0]] }, { priorFindings });
  assert.equal(second.findings.length, 1);
  assert.equal(second.findings[0].severity, 'WARNING');
  assert.equal(second.findings[0].suppressed, true);
  assert.equal(second.blocking_count, 0);
  assert.equal(second.disagreement_suppressed, 1);
  assert(!Object.hasOwn(second.findings[0], 'fix_ticket'));
});

test('coverage and permanent round costs stay independent across expanding and non-expanding bases', () => {
  const isAncestor = (a, b) => ['A', 'B', 'H', 'I'].indexOf(a) <= ['A', 'B', 'H', 'I'].indexOf(b);
  const full = { head: 'H', review_scope: 'full', review_completeness: 'complete', sealed_at: '1',
    coverage_range: { from: 'B', to: 'H', merge_base: 'B' } };
  const options = { priorVerdicts: [full], head: 'H', isAncestor, mergeBase: 'A' };
  assert.deepEqual(core.nextRound(options), { round: 2, state: 'ready', scope: 'full', rounds_used: 1,
    priorHead: 'H', deltaBase: null });
  assert.equal(core.nextRound({ ...options, mergeBase: 'B' }).scope, 'delta');
  assert.equal(core.nextRound({ ...options, mergeBase: 'H' }).scope, 'delta');
  const unsafe = { head: 'H', prior_head: 'H', review_scope: 'delta', review_completeness: 'complete', sealed_at: '2',
    coverage_range: { from: 'H', to: 'H', merge_base: 'A' } };
  const later = { ...unsafe, head: 'I', sealed_at: '3', coverage_range: { from: 'H', to: 'I', merge_base: 'B' } };
  const history = [full, unsafe, later];
  assert.equal(core.countableVerdicts({ priorVerdicts: history, head: 'I', isAncestor }).length, 3);
  assert.equal(core.coverageComplete({ verdict: unsafe, priorVerdicts: history, mergeBase: 'A', isAncestor }), false);
  assert.equal(core.coverageComplete({ verdict: later, priorVerdicts: history, mergeBase: 'B', isAncestor }), false);
  assert.equal(core.nextRound({ ...options, priorVerdicts: history, head: 'I' }).state, 'limit');
  const refresh = { ...full, sealed_at: '2', coverage_range: { from: 'A', to: 'H', merge_base: 'A' } };
  assert.equal(core.nextRound({ ...options, priorVerdicts: [full, refresh] }).round, 3);
  assert.equal(core.nextRound({ ...options, priorVerdicts: [full, refresh] }).scope, 'delta');
  assert.equal(core.nextRound({ ...options, priorVerdicts: [{ ...full, review_completeness: 'incomplete' }] }).round, 1);
  assert.equal(core.coverageComplete({ verdict: { ...full, coverage_range: null }, priorVerdicts: [], mergeBase: 'B', isAncestor }), false);
  assert.throws(() => core.coverageComplete({ verdict: full, priorVerdicts: [], mergeBase: 'B',
    isAncestor() { throw Error('Git unavailable'); } }), /Git unavailable/);
});
