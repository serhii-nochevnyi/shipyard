'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const CONTRACT_ID = 'shipyard.phase-code-review.v1';
const ROUND_CAP = 3;
const PART_BUDGET = 40000;
const PART_SCHEMA = Object.freeze({ type: 'object', required: ['part', 'review_completeness', 'limitations', 'unresolved_sources', 'summary', 'findings'],
  properties: { part: { type: 'string' }, review_completeness: { enum: ['complete', 'incomplete'] }, summary: { type: 'string' },
    limitations: { type: 'array', items: { type: 'string' } }, unresolved_sources: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'object' } } } });
const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'INFO']);
const VERDICTS = Object.freeze(['pass', 'needs-fix', 'incomplete']);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const bounded = (value, max = 1024) => typeof value === 'string' && value.trim() !== '' && Buffer.byteLength(value) <= max;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function requireText(value, label, max = 1024) {
  if (!bounded(value, max)) fail('INVALID_RESULT', `${label} must be a non-empty string of at most ${max} bytes`);
  return value;
}
function contractDigest(referenceDigest) { return hash(CONTRACT_ID + '\n' + referenceDigest); }
function normalizeSourceLine(text) { return text.normalize('NFC').replace(/\s+/gu, ' ').trim(); }
function normalizeCitedPath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024
      || /[\\\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)
      || value.split('/').includes('..')) return null;
  const normalized = path.posix.normalize(value.replace(/^[.][/]/, ''));
  return normalized === '.' ? null : normalized;
}
function lineIdentity({ path: file, lineText, ordinal }) {
  const normalized = normalizeCitedPath(file);
  if (!normalized || typeof lineText !== 'string' || !normalizeSourceLine(lineText) || !positive(ordinal))
    fail('INVALID_RESULT', 'a source identity requires a path, non-empty source line and positive ordinal');
  return hash([normalized, normalizeSourceLine(lineText), String(ordinal)].join('\n'));
}
function resolveCitation({ path: file, line, quotedText, readSource }) {
  const missing = { citation: 'missing', identity: null, line_text: null, occurrence: null, occurrences: null };
  const normalized = normalizeCitedPath(file);
  if (!normalized || !positive(line) || typeof readSource !== 'function') return missing;
  let source;
  try { source = readSource(normalized); } catch { return missing; }
  if (Buffer.isBuffer(source)) source = source.toString('utf8');
  if (typeof source !== 'string' || Buffer.byteLength(source) > SOURCE_MAX_BYTES || source.includes('\0')) return missing;
  const lines = source.split('\n');
  if (source.endsWith('\n')) lines.pop();
  if (line > lines.length) return missing;
  const text = normalizeSourceLine(lines[line - 1]);
  if (!text || Buffer.byteLength(text) > 1024) return missing;
  if (typeof quotedText === 'string' && quotedText.length > 0 && normalizeSourceLine(quotedText) !== text)
    return { ...missing, citation: 'unmatched' };
  let ordinal = 0, count = 0;
  for (let index = 0; index < lines.length; index++) {
    if (normalizeSourceLine(lines[index]) !== text) continue;
    count++;
    if (index < line) ordinal++;
  }
  return { citation: 'resolved', line_text: text, occurrence: ordinal, occurrences: count,
    identity: lineIdentity({ path: normalized, lineText: text, ordinal }) };
}
function createSourceReader({ git, head }) {
  const cache = new Map();
  return file => {
    const normalized = normalizeCitedPath(file);
    if (!normalized) return null;
    if (cache.has(normalized)) return cache.get(normalized);
    let text = null;
    try {
      const listing = git(['ls-tree', '-z', head, '--', normalized], 8192);
      const entries = String(listing).split('\0').filter(Boolean);
      const entry = entries.length === 1 && /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(entries[0]);
      if (entry && entry[3] === normalized) {
        const content = git(['cat-file', 'blob', entry[2]], SOURCE_MAX_BYTES);
        if (typeof content === 'string' && Buffer.byteLength(content) <= SOURCE_MAX_BYTES && !content.includes('\0')) text = content;
      }
    } catch {}
    cache.set(normalized, text);
    return text;
  };
}
function completeFixTicket(value) {
  return object(value) && bounded(value.title) && bounded(value.scope)
    && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 128 && value.files.every(file => bounded(file))
    && (value.depends_on === undefined || (Array.isArray(value.depends_on) && value.depends_on.length <= 128
      && value.depends_on.every(id => bounded(id) && !/\s/.test(id))));
}
function boundedList(value, label) {
  if (!Array.isArray(value) || value.length > 128 || value.some(text => !bounded(text)))
    fail('INVALID_RESULT', `${label} must have at most 128 strings of at most 1024 bytes`);
  return value;
}
function changePath(change) { return change.new_path ?? change.old_path; }
function pathGroups(changes, budget) {
  const weight = change => 1 + (change.additions ?? 0) + (change.deletions ?? 0);
  const directories = new Map();
  for (const change of [...changes].sort((a, b) => changePath(a) < changePath(b) ? -1 : changePath(a) > changePath(b) ? 1 : 0)) {
    const directory = path.posix.dirname(changePath(change));
    directories.set(directory, [...(directories.get(directory) || []), change]);
  }
  const groups = [];
  let open = null;
  const place = items => {
    const size = items.reduce((sum, change) => sum + weight(change), 0);
    if (open && open.size + size <= budget) { open.changes.push(...items); open.size += size; }
    else groups.push(open = { changes: [...items], size });
  };
  for (const items of directories.values()) {
    if (items.reduce((sum, change) => sum + weight(change), 0) <= budget) place(items);
    else for (const change of items) place([change]);
  }
  return groups.map((group, index) => ({ id: 'part-' + (index + 1), ordinal: index + 1, changes: group.changes,
    paths: [...new Set(group.changes.flatMap(change => change.paths))].sort() }));
}
function assertPathPartition(changes, parts) {
  const expected = changes.flatMap(change => change.paths).sort(), actual = parts.flatMap(part => part.paths).sort();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index]))
    fail('INVALID_RESULT', 'parts must cover every product path exactly once');
}
function findingSeverity(finding) {
  const severity = ({ CR: 'BLOCKER', WR: 'WARNING', IN: 'INFO' })[finding.severity] || finding.severity;
  if (!SEVERITIES.includes(severity)) fail('INVALID_RESULT', 'invalid finding severity');
  return severity;
}
function normalizePart(result, group) {
  if (!object(result) || result.part !== group.id || !['complete', 'incomplete'].includes(result.review_completeness)
      || !Array.isArray(result.findings) || result.findings.length > 128)
    fail('INVALID_RESULT', 'part result must echo its part id with completeness and at most 128 findings');
  const findings = result.findings.map((finding, index) => {
    if (!object(finding)) fail('INVALID_RESULT', 'part finding must be an object');
    const { id, path: file, line, line_text, summary, failure_scenario, rule, fix_ticket } = finding;
    const severity = findingSeverity(finding), { title, scope, files, depends_on } = object(fix_ticket) ? fix_ticket : {};
    return JSON.parse(JSON.stringify({ id, severity, path: file, line, line_text, summary, failure_scenario, rule,
      ...(severity === 'BLOCKER' ? { ref: `PB-${group.ordinal}-${index + 1}` } : {}),
      fix_ticket: object(fix_ticket) ? { title, scope, files, depends_on } : undefined }));
  });
  return { id: group.id, ordinal: group.ordinal, paths: group.paths, review_completeness: result.review_completeness,
    limitations: boundedList(result.limitations, 'limitations'), unresolved_sources: boundedList(result.unresolved_sources, 'unresolved_sources'),
    summary: requireText(result.summary, 'summary', 2048), findings };
}
function normalizeFinal(result, parts, options) {
  const coverage = parts.map((part, index) => ({ partition: index + 1, status: part.review_completeness === 'complete'
    && !part.limitations.length && !part.unresolved_sources.length ? 'reviewed' : 'not-reviewed' }));
  if (result.review_completeness === 'complete' && coverage.some(entry => entry.status !== 'reviewed'))
    fail('INVALID_RESULT', 'complete code review has unreviewed parts');
  const refs = parts.flatMap(part => part.findings.map(finding => finding.ref).filter(Boolean));
  const own = (Array.isArray(result.dispositions) ? result.dispositions : []).filter(entry => refs.includes(entry?.ref));
  const justified = ref => own.filter(entry => entry.ref === ref && ['resolved', 'unresolved', 'disputed'].includes(entry.disposition)
    && bounded(entry.justification));
  if (refs.some(ref => justified(ref).length !== 1))
    fail('JUDGMENT_OUTCOME_MISMATCH', 'each part BLOCKER needs one justified disposition keyed by its ref');
  const normalized = normalizeResult({ ...result, coverage,
    dispositions: (result.dispositions || []).filter(entry => !refs.includes(entry?.ref)) }, options);
  if (own.some(entry => entry.disposition === 'unresolved') && !normalized.blocking_count)
    fail('JUDGMENT_OUTCOME_MISMATCH', 'an unresolved part BLOCKER requires a blocking finding');
  return own.length ? { ...normalized, part_dispositions: own.map(({ ref, disposition, justification }) => ({ ref, disposition, justification })) } : normalized;
}
function normalizeResult(result, { round, scope, priorFindings = [], readSource } = {}) {
  if (!object(result) || !Array.isArray(result.findings) || result.findings.length > 128)
    fail('INVALID_RESULT', 'review requires at most 128 findings');
  if (!positive(round) || round > ROUND_CAP || !['full', 'delta'].includes(scope)) fail('INVALID_RESULT', 'invalid review round or scope');
  const limitations = boundedList(result.limitations, 'limitations');
  const unresolvedSources = boundedList(result.unresolved_sources, 'unresolved_sources');
  if (!['complete', 'incomplete'].includes(result.review_completeness)) fail('INVALID_RESULT', 'review_completeness must be complete or incomplete');
  const complete = result.review_completeness === 'complete' && limitations.length === 0 && unresolvedSources.length === 0;
  const stats = { info_dropped: 0, demoted_for_evidence: 0, disagreement_suppressed: 0, citations_unresolved: 0 };
  if (!Array.isArray(priorFindings) || priorFindings.length > 128) fail('INVALID_RESULT', 'prior findings exceed their bound');
  const priorByIdentity = new Map();
  const priorByRef = new Map();
  for (const prior of priorFindings) {
    if (!bounded(prior.ref, 64) || priorByRef.has(prior.ref)) fail('INVALID_RESULT', 'prior finding refs must be unique');
    priorByRef.set(prior.ref, prior);
    if (prior.identity) priorByIdentity.set(prior.identity, prior);
  }
  const ids = new Set();
  const returned = [];
  for (const finding of result.findings) {
    if (!object(finding)) fail('INVALID_RESULT', 'finding must be an object');
    const id = requireText(finding.id, 'finding.id', 128);
    if (ids.has(id)) fail('DUPLICATE_FINDING_ID', `duplicate finding id ${id}`);
    ids.add(id);
    let severity = findingSeverity(finding);
    requireText(finding.summary, 'finding.summary');
    const rule = finding.rule === undefined ? 'unlabelled' : finding.rule;
    if (typeof rule !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(rule) || rule.length > 64)
      fail('INVALID_RESULT', 'rule must be a kebab-case label of at most 64 characters');
    if (severity === 'INFO') { stats.info_dropped++; continue; }
    const file = normalizeCitedPath(finding.path), line = positive(finding.line) ? finding.line : null;
    if (typeof finding.failure_scenario === 'string' && Buffer.byteLength(finding.failure_scenario) > 1024)
      fail('INVALID_RESULT', 'failure_scenario exceeds 1024 bytes');
    if (severity === 'BLOCKER' && (!file || !line || !bounded(finding.failure_scenario) || !completeFixTicket(finding.fix_ticket))) {
      severity = 'WARNING'; stats.demoted_for_evidence++;
    }
    const citation = resolveCitation({ path: file, line, quotedText: finding.line_text, readSource });
    if (citation.citation !== 'resolved') stats.citations_unresolved++;
    const prior = citation.identity ? priorByIdentity.get(citation.identity) : null;
    returned.push({ id, rule, severity, path: file, line, summary: finding.summary,
      ...(bounded(finding.failure_scenario) ? { failure_scenario: finding.failure_scenario } : {}),
      ...(severity === 'BLOCKER' ? { fix_ticket: finding.fix_ticket } : {}),
      ...citation, classification: prior ? 'prior' : 'new', ...(prior ? { ref: prior.ref } : {}), blocking: severity === 'BLOCKER' });
  }
  const dispositionMap = new Map();
  if (result.dispositions !== undefined && !Array.isArray(result.dispositions)) fail('JUDGMENT_OUTCOME_MISMATCH', 'dispositions must be an array');
  if ((result.dispositions || []).length > 128) fail('JUDGMENT_OUTCOME_MISMATCH', 'too many dispositions');
  for (const entry of result.dispositions || []) {
    const prior = priorByRef.get(entry?.ref);
    if (!object(entry) || !prior || prior.severity !== 'BLOCKER' || prior.disagreement || dispositionMap.has(entry.ref)
        || !['resolved', 'unresolved', 'disputed'].includes(entry.disposition)
        || (entry.disposition !== 'resolved' && !bounded(entry.justification))
        || (entry.justification !== undefined && !bounded(entry.justification))
        || (entry.source !== undefined && entry.source !== 'reviewer'))
      fail('JUDGMENT_OUTCOME_MISMATCH', 'each carried BLOCKER needs one valid disposition keyed by ref');
    dispositionMap.set(entry.ref, { ref: entry.ref, disposition: entry.disposition, source: 'reviewer',
      ...(entry.justification === undefined ? {} : { justification: entry.justification }) });
  }
  const findings = returned.filter(finding => finding.classification === 'new');
  for (const prior of priorFindings) {
    const matches = returned.filter(finding => finding.ref === prior.ref);
    const carried = () => {
      const { stored_identity, delta_touch, disagreement, disposition, ref, ...finding } = prior;
      return { ...finding, ref, classification: 'prior', citation: prior.identity ? 'resolved' : 'missing',
        identity: prior.identity || null, line_text: prior.identity ? prior.line_text : null,
        occurrence: prior.identity ? prior.occurrence : null, blocking: prior.severity === 'BLOCKER' };
    };
    const matched = matches[0] ? { ...matches[0], ...(prior.disagreement_identity ? { disagreement_identity: prior.disagreement_identity } : {}) } : carried();
    if (prior.disagreement && (prior.stored_identity || prior.disagreement_identity)) {
      dispositionMap.set(prior.ref, { ref: prior.ref, disposition: 'disputed', source: 'recorded_disagreement', justification: prior.disagreement.reason });
      const { fix_ticket, ...finding } = matched;
      findings.push({ ...finding, severity: prior.severity, ...(prior.severity === 'BLOCKER' ? { fix_ticket: prior.fix_ticket, failure_scenario: prior.failure_scenario } : {}),
        disagreement_identity: prior.disagreement_identity || prior.stored_identity,
        suppressed: true, blocking: false, classification: 'prior', ref: prior.ref });
      stats.disagreement_suppressed++;
    } else if (prior.severity === 'BLOCKER') {
      const disposition = dispositionMap.get(prior.ref);
      if (!disposition) fail('JUDGMENT_OUTCOME_MISMATCH', `missing disposition for ${prior.ref}`);
      if (disposition.disposition === 'resolved' && matches.length) fail('JUDGMENT_OUTCOME_MISMATCH', `resolved finding ${prior.ref} was returned again`);
      if (disposition.disposition === 'unresolved') findings.push({ ...matched, severity: 'BLOCKER', blocking: true,
        failure_scenario: prior.failure_scenario, fix_ticket: prior.fix_ticket });
    } else if (prior.identity && !prior.delta_touch) {
      const { fix_ticket, ...finding } = matched;
      findings.push({ ...finding, severity: 'WARNING', blocking: false });
    }
  }
  if (findings.length > 128) fail('INVALID_RESULT', 'normalized review exceeds 128 findings');
  const reservedIds = new Set(findings.map(finding => finding.id));
  const finalIds = new Set();
  for (const [index, finding] of findings.entries()) {
    if (finalIds.has(finding.id)) {
      const label = `finding-${index + 1}-${hash(finding.id)}`;
      let candidate = label, suffix = 0;
      while (reservedIds.has(candidate) || finalIds.has(candidate)) candidate = `${label}-${++suffix}`;
      finding.id = candidate;
    }
    finalIds.add(finding.id);
  }
  const blockingCount = findings.filter(finding => finding.blocking).length;
  const verdict = complete ? (blockingCount ? 'needs-fix' : 'pass') : 'incomplete';
  if (result.verdict !== undefined && (!VERDICTS.includes(result.verdict) || result.verdict !== verdict))
    fail('JUDGMENT_OUTCOME_MISMATCH', 'claimed verdict differs from completeness or blocking findings');
  return { ...result, findings, dispositions: [...dispositionMap.values()], verdict, blocking_count: blockingCount, finding_count: findings.length,
    review_round: round, review_scope: scope, review_completeness: complete ? 'complete' : 'incomplete',
    limitations, unresolved_sources: unresolvedSources, ...stats };
}
function countableVerdicts({ priorVerdicts, head, isAncestor }) {
  const countable = [], heads = new Set();
  const ordered = priorVerdicts.map((verdict, index) => ({ verdict, index })).sort((a, b) =>
    String(a.verdict.sealed_at || '').localeCompare(String(b.verdict.sealed_at || '')) || a.index - b.index);
  for (const { verdict } of ordered) {
    if ((verdict.head === head || isAncestor(verdict.head, head)) && verdict.review_completeness === 'complete'
        && (verdict.review_scope === 'full' || (verdict.review_scope === 'delta' && heads.has(verdict.prior_head)))) {
      countable.push(verdict); heads.add(verdict.head);
    }
  }
  return countable;
}
function lineageComplete({ verdict, priorVerdicts }) {
  if (verdict.answer_authenticated === false || verdict.review_completeness !== 'complete') return false;
  if (verdict.review_scope === 'full') return true;
  const previous = countableVerdicts({ priorVerdicts: priorVerdicts.filter(entry => entry !== verdict
    && (!verdict.sealed_at || !entry.sealed_at || entry.sealed_at < verdict.sealed_at)), head: verdict.head, isAncestor: () => true });
  return verdict.review_scope === 'delta' && previous.some(entry => entry.head === verdict.prior_head
    && (!verdict.sealed_at || !entry.sealed_at || entry.sealed_at <= verdict.sealed_at));
}
function coverageComplete({ verdict, priorVerdicts, mergeBase, isAncestor }) {
  const ordered = priorVerdicts.filter(entry => entry !== verdict
    && (!verdict.sealed_at || entry.sealed_at < verdict.sealed_at));
  const prove = (entry, earlier) => {
    const material = entry.coverage_range;
    if (entry.answer_authenticated === false || entry.review_completeness !== 'complete' || !material || material.to !== entry.head
        || !material.merge_base || !isAncestor(material.merge_base, entry.head)) return null;
    if (entry.review_scope === 'full') return material.from === material.merge_base ? material.from : null;
    if (entry.review_scope !== 'delta' || material.from !== entry.prior_head
        || !isAncestor(entry.prior_head, entry.head)) return null;
    const previous = countableVerdicts({ priorVerdicts: earlier.filter(value => value.answer_authenticated !== false), head: entry.head, isAncestor }).at(-1);
    if (!previous || previous.head !== entry.prior_head) return null;
    const root = prove(previous, earlier.filter(value => value !== previous
      && value.sealed_at < previous.sealed_at));
    return root && isAncestor(root, material.merge_base) ? root : null;
  };
  const root = prove(verdict, ordered);
  return !!root && isAncestor(root, mergeBase) && isAncestor(mergeBase, verdict.head);
}
function nextRound(options) {
  const verdicts = countableVerdicts(options), used = verdicts.length;
  if (used >= ROUND_CAP) return { round: null, state: 'limit', rounds_used: used };
  const inherit = used && verdicts.at(-1).answer_authenticated !== false
    && (options.mergeBase === undefined || coverageComplete({ verdict: verdicts.at(-1),
    priorVerdicts: verdicts, mergeBase: options.mergeBase, isAncestor: options.isAncestor }));
  return { round: used + 1, state: 'ready', scope: inherit ? 'delta' : 'full', rounds_used: used,
    priorHead: used ? verdicts.at(-1).head : null, deltaBase: inherit ? verdicts.at(-1).head : null };
}
function repairAllowed(round) { return round === 1 || round === 2; }

function diffPath(value) {
  if (!value.startsWith('"')) return value.split('\t')[0];
  const bytes = [];
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (char === '"') return Buffer.concat(bytes).toString('utf8');
    if (char !== '\\') { bytes.push(Buffer.from(char)); continue; }
    const octal = /^[0-7]{1,3}/.exec(value.slice(index + 1));
    if (octal) { bytes.push(Buffer.from([parseInt(octal[0], 8)])); index += octal[0].length; }
    else { index++; bytes.push(Buffer.from(({t:'\t',n:'\n',r:'\r','\\':'\\','"':'"'})[value[index]] || value[index])); }
  }
  return null;
}

function mapLineThroughDiff(file, line, diffText) {
  if (!positive(line) || !normalizeCitedPath(file) || typeof diffText !== 'string') return { touched: true };
  const lines = diffText.split('\n');
  let selected = false, matched = false, renamed = false, malformed = false;
  let shift = 0, mapped = null, oldEnd = 0, newEnd = 0, oldPath = null;
  for (let index = 0; index < lines.length; index++) {
    const value = lines[index];
    if (value.startsWith('diff --git ')) {
      const rest = value.slice(11);
      const names = /^("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/.exec(rest);
      const oldName = names && diffPath(names[1]), newName = names && diffPath(names[2]);
      selected = rest === `a/${file} b/${file}` || oldName === 'a/' + file || newName === 'b/' + file;
      oldPath = null;
      if (selected && matched) malformed = true;
      if (selected) matched = true;
      continue;
    }
    if (value.startsWith('--- ')) {
      oldPath = diffPath(value.slice(4));
      if (oldPath === 'a/' + file) { selected = true; matched = true; }
      continue;
    }
    if (value.startsWith('+++ ')) {
      const newPath = diffPath(value.slice(4));
      if (newPath === 'b/' + file || oldPath === 'a/' + file) {
        selected = true; matched = true;
        if (oldPath !== 'a/' + file || newPath !== 'b/' + file) renamed = true;
      }
      continue;
    }
    if (!selected) continue;
    if (/^(?:rename from |rename to |deleted file mode )/.test(value)) { renamed = true; continue; }
    if (/^(?:Binary files |GIT binary patch)/.test(value)) { malformed = true; break; }
    if (!value.startsWith('@@')) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(value);
    if (!header) { malformed = true; break; }
    const a = Number(header[1]), b = header[2] === undefined ? 1 : Number(header[2]);
    const c = Number(header[3]), d = header[4] === undefined ? 1 : Number(header[4]);
    const oldStart = a + (b === 0 ? 1 : 0), newStart = c + (d === 0 ? 1 : 0);
    if ((b === 0 && d === 0) || ![a,b,c,d,oldStart,newStart].every(Number.isSafeInteger) || oldStart < 1 || newStart < 1
        || oldStart < oldEnd || newStart < newEnd || newStart - oldStart !== shift) { malformed = true; break; }
    let old = oldStart, fresh = newStart, removed = 0, added = 0;
    while (removed < b || added < d) {
      const body = lines[++index];
      if (body === undefined) { malformed = true; break; }
      if (body.startsWith('\\')) continue;
      if (body[0] === ' ') {
        if (old === line) mapped = { line: fresh };
        old++; fresh++; removed++; added++;
      } else if (body[0] === '-') {
        if (old === line) mapped = { touched: true };
        old++; removed++;
      } else if (body[0] === '+') { fresh++; added++; }
      else { malformed = true; break; }
      if (removed > b || added > d) { malformed = true; break; }
    }
    if (malformed) break;
    while (lines[index+1]?.startsWith('\\')) index++;
    const next = lines[index+1];
    if (next && [' ', '+', '-'].includes(next[0]) && !next.startsWith('--- ') && !next.startsWith('+++ ')) { malformed = true; break; }
    if (next?.startsWith('--- ') || next?.startsWith('+++ ')) { malformed = true; break; }
    if (line >= old) shift += d - b;
    else if (mapped === null && line < oldStart) mapped = { line: line + shift };
    oldEnd = old; newEnd = fresh;
    if (line < old && mapped !== null) {
      shift = fresh - old;
    }
  }
  return malformed || renamed ? { touched: true } : mapped || { line: line + shift };
}
function disagreementTargets(priorFindings) {
  const targets = new Map();
  for (const [index, finding] of priorFindings.entries()) {
    if (finding.disagreement_identity) {
      if (targets.has(finding.disagreement_identity)) fail('DISPOSITIONS_INVALID', 'duplicate retained disagreement target');
      targets.set(finding.disagreement_identity, index);
    }
  }
  for (const [index, finding] of priorFindings.entries()) {
    if (!finding.disagreement_identity && finding.stored_identity && !targets.has(finding.stored_identity))
      targets.set(finding.stored_identity, index);
  }
  return targets;
}
function carryPriorFindings({ priorFindings, deltaDiff, disagreements = {}, readSource }) {
  const sealed = Array.isArray(priorFindings) ? { findings: priorFindings, dispositions: [] } : priorFindings;
  if (!object(sealed) || !Array.isArray(sealed.findings) || sealed.findings.length > 128) fail('INVALID_RESULT', 'prior findings must be a sealed index');
  const entries = disagreements instanceof Map ? disagreements : disagreements.entries || disagreements;
  const carried = sealed.findings.map((finding, index) => {
    const storedIdentity = finding.citation === 'resolved' ? finding.identity : null;
    const entry = { id: finding.id, rule: finding.rule || 'unlabelled', severity: finding.severity, path: finding.path, line: finding.line,
      line_text: finding.line_text, occurrence: finding.occurrence, summary: finding.summary, failure_scenario: finding.failure_scenario,
      ...(finding.severity === 'BLOCKER' ? { fix_ticket: finding.fix_ticket } : {}),
      disposition: (sealed.dispositions || []).find(value => value.ref === finding.ref)?.disposition || finding.disposition || null,
      ref: 'P-' + String(index+1).padStart(2,'0'), delta_touch: false, stored_identity: storedIdentity, identity: null,
      ...(finding.disagreement_identity ? { disagreement_identity: finding.disagreement_identity } : {}),
      disagreement: null };
    if (!storedIdentity) return entry;
    const mapped = mapLineThroughDiff(finding.path, finding.line, deltaDiff);
    if (mapped.touched) return { ...entry, delta_touch: true };
    const citation = resolveCitation({ path: finding.path, line: mapped.line, quotedText: finding.line_text, readSource });
    return { ...entry, line: mapped.line, ...(citation.citation === 'resolved'
      ? { line_text: citation.line_text, occurrence: citation.occurrence, identity: citation.identity }
      : { delta_touch: true }) };
  });
  const targets = disagreementTargets(carried);
  for (const [identity, disagreement] of entries instanceof Map ? entries : Object.entries(entries)) {
    const index = targets.get(identity);
    if (index === undefined) continue;
    carried[index].disagreement_identity = identity;
    carried[index].disagreement = { reason: disagreement.reason, recorded_by: disagreement.recorded_by };
  }
  return carried;
}
function parseDisagreements(text, { priorFindings }) {
  const invalid = message => fail('DISPOSITIONS_INVALID', message);
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) invalid('disagreements exceed 64 KiB');
  let file;
  try { file = JSON.parse(text); } catch { invalid('disagreements must be valid JSON'); }
  if (!object(file) || file.schema !== 'shipyard.code-review-disagreements.v1' || !Array.isArray(file.entries) || file.entries.length > 128
      || Object.keys(file).some(key => !['schema','entries'].includes(key))) invalid('invalid disagreements schema');
  const earlier = disagreementTargets(priorFindings);
  const entries = {};
  for (const entry of file.entries) {
    if (!object(entry) || !normalizeCitedPath(entry.path) || !bounded(entry.line_text) || !normalizeSourceLine(entry.line_text)
        || !positive(entry.occurrence) || !bounded(entry.reason) || !bounded(entry.recorded_by,128)
        || Object.keys(entry).some(key => !['path','line_text','occurrence','reason','recorded_by'].includes(key))) invalid('invalid disagreement entry');
    const identity = lineIdentity({ path: entry.path, lineText: entry.line_text, ordinal: entry.occurrence });
    if (entries[identity]) invalid('duplicate disagreement identity');
    if (!earlier.has(identity)) fail('DISPOSITION_TARGET_UNKNOWN', 'The entry names no finding of the latest review; a line the fix changed is no longer carried, so the entry can be deleted.');
    entries[identity] = { ...entry, path: normalizeCitedPath(entry.path), line_text: normalizeSourceLine(entry.line_text), identity };
  }
  return entries;
}
function loadDisagreements({ projectRoot, phaseDirName, priorFindings, readFile }) {
  if (typeof projectRoot !== 'string' || !/^\d+-[A-Za-z0-9._-]+$/.test(phaseDirName || '') || typeof readFile !== 'function')
    fail('DISPOSITIONS_INVALID', 'disagreements need a project root, phase directory and bounded reader');
  let file;
  try { file = readFile(path.join(projectRoot,'.planning/phases',phaseDirName,'code-review-disagreements.json'),65536); }
  catch (error) { if (error.code === 'ENOENT') return { entries: {}, dispositions_digest: null }; fail('DISPOSITIONS_INVALID','cannot read regular disagreements file'); }
  if (file === null) return { entries: {}, dispositions_digest: null };
  if (!object(file) || !file.stat || file.stat.isSymbolicLink() || !file.stat.isFile() || file.stat.size > 65536)
    fail('DISPOSITIONS_INVALID','disagreements must be a regular file of at most 64 KiB');
  const text = Buffer.isBuffer(file.text) ? file.text.toString('utf8') : file.text;
  return { entries: parseDisagreements(text,{priorFindings}), dispositions_digest: hash(text) };
}
function assemblePacket({ subject, identity, exactDiff, integrationBase, ticketSet, planAcceptance, priorFindings, round, changeMetadata, referenceDigest }) {
  if (!object(identity) || identity.id !== subject) fail('JUDGMENT_IDENTITY_MISMATCH','packet identity differs from subject');
  for (const [key,value] of Object.entries({exact_diff:exactDiff,integration_base:integrationBase,ticket_set:ticketSet,plan_acceptance:planAcceptance,prior_findings:priorFindings}))
    if (value === undefined || value === null) fail('MISSING_JUDGMENT_CONTEXT',`packet requires ${key}`);
  if (!Array.isArray(priorFindings) || priorFindings.length > 128)
    fail('INVALID_RESULT', 'original normalization findings exceed their bound');
  const focused = { review_contract: CONTRACT_ID };
  for (const key of ['repository','id','pr','head','base_commit','merge_base','base_tree','ticket_set_digest']) {
    if (identity[key] === undefined || identity[key] === null) fail('MISSING_JUDGMENT_CONTEXT',`packet identity requires ${key}`);
    focused[key] = identity[key];
  }
  return { review_contract: CONTRACT_ID, focused, subject, exact_diff: exactDiff, integration_base: integrationBase,
    ticket_set: ticketSet, plan_acceptance: planAcceptance,
    normalization_inputs: { prior_findings: structuredClone(priorFindings) },
    prior_findings: priorFindings.map(({ identity: _identity, stored_identity: _stored, disagreement_identity: _disagreement, ...finding }) => finding),
    review_round: round.round, review_scope: round.scope, prior_head: round.priorHead || null,
    change_metadata: changeMetadata, contract_digest: contractDigest(referenceDigest) };
}
function reuseKey({ head, baseCommit, contractDigest: contract }) { return hash(['code-review',head,baseCommit,contract].join('\n')); }
module.exports = { CONTRACT_ID, ROUND_CAP, PART_BUDGET, PART_SCHEMA, pathGroups, assertPathPartition, normalizePart, normalizeFinal, SOURCE_MAX_BYTES, SEVERITIES, VERDICTS, contractDigest, normalizeResult,
  normalizeSourceLine, normalizeCitedPath, lineIdentity, resolveCitation, createSourceReader, countableVerdicts,
  lineageComplete, coverageComplete, nextRound, repairAllowed, mapLineThroughDiff, carryPriorFindings, parseDisagreements, loadDisagreements,
  assemblePacket, reuseKey };
