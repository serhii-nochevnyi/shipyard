'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { loadOwner } = require('./integration-owner.cjs');
const TRANSFORM = `.replaceAll('const identity = payload.reviewed_identity, assignment = payload.assignment;',
    'const identity = payload.identity?.scalar_tree ? ((table) => { const expand = value => Array.isArray(value) ? value.map(expand) : value && typeof value === \"object\" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : table.values[value]; return expand(table.scalar_tree); })(payload.identity) : payload.identity || payload.reviewed_identity, assignment = payload.assignment || { unit_id: payload.unit_id, primary_segments: [], support_segments: [], primary_obligation_ids: [], support_obligation_ids: [], seam_ids: [] };')
    .replaceAll('payload.seams.map(', '(payload.seams || []).map(')`;
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, phaseBinding, projectOptions, write, git, commit, agent } = loadOwner(['publicIntegrationFixture', 'publicPartitionFixture', 'supportedPartitionCaller', 'phaseBinding', 'projectOptions', 'write', 'git', 'commit', 'agent'], TRANSFORM);
const root = '../../../plugins/delivery-pipeline/scripts/';
const claude = require(root + 'claude-role-host.cjs');
const delivery = require(root + 'codex-delivery-host.cjs');
const collector = require(root + 'codex-arch-review-context.cjs');
const roleArtifact = require(root + 'role-artifact.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const artifactOwner = path.resolve(__dirname, root + 'role-artifact.cjs');
const measured = new Module(artifactOwner, module);
measured.filename = artifactOwner;
measured.paths = Module._nodeModulePaths(path.dirname(artifactOwner));
measured._compile(fs.readFileSync(artifactOwner, 'utf8') + '\nmodule.exports = { partitionSegments, partitionInputBytes, compactInteractionDomain, compactPair, compactStaticTables, compactDomainJudgments, compactBinding, compactReviewedIdentity, compactAggregatePayload, buildPartitionUnits, observedPartitionProfile, compactProfile, partitionUnitPayload, renderPartitionInput, partitionHash, partitionCoverage, assertPartitionCoverage, partitionPlanRecord, assertPartitionInputBound, partitionResult };', artifactOwner);
const { partitionSegments, partitionInputBytes, compactInteractionDomain, compactPair, compactStaticTables, compactDomainJudgments, compactBinding, compactReviewedIdentity, compactAggregatePayload, buildPartitionUnits, observedPartitionProfile, compactProfile, partitionUnitPayload, renderPartitionInput, partitionHash, partitionCoverage, assertPartitionCoverage, partitionPlanRecord, assertPartitionInputBound, partitionResult } = measured.exports;
const MiB = 1024 * 1024;
const stable = require(root + 'model-policy-internal.cjs').stableStringify;
function endpoints(f, sources, provider = 'exports.value = 2;\n') {
  for (const [name, content] of Object.entries(sources)) write(f.worktree, name, content);
  git(f.worktree, 'add', '.');
  git(f.worktree, 'commit', '-qm', 'unchanged scan endpoint');
  f.base = git(f.worktree, 'rev-parse', 'HEAD');
  f.pr.baseRefOid = f.base;
  git(f.worktree, 'update-ref', 'refs/heads/main', f.base);
  git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
  write(f.worktree, 'src/provider.cjs', provider);
  commit(f, 'tiny required change');
  f.memberHead = f.head;
}
function prepare(f, runtime) {
  const options = projectOptions(f);
  const context = claude.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
  let instructionBinding, generatedInstructionBytes;
  if (runtime === 'codex') {
    const installed = agent(f, 'integrator', context.signals);
    const instructions = collector.instructionEvidence(installed.dir, installed.selection.agent_file, installed.manifest);
    generatedInstructionBytes = instructions.generated_instruction_bytes;
    instructionBinding = { agent_file: installed.selection.agent_file,
      agent_path: path.join(installed.dir, installed.selection.agent_file), agent_sha256: instructions.sha256,
      installed_files: instructions.installed_files, policy_hash: installed.selection.policy_hash };
  } else {
    const referencePath = require(root + 'claude-reference-content.cjs').REFERENCE_PATHS.integrator;
    const reference = fs.readFileSync(referencePath);
    generatedInstructionBytes = reference.length;
    instructionBinding = { agent_file: path.basename(referencePath), agent_path: referencePath,
      agent_sha256: hash(reference), installed_files: [], policy_hash: require(root + 'model-policy.cjs').POLICY_HASH };
  }
  const scope = { worktree: f.worktree, phase: 49, ticket: context.ticket, run_id: 'impact-' + runtime + ++f.count };
  return delivery.prepareIntegrationLineage(scope, context, { ...options, nativeRuntime: runtime,
    dispatchId: scope.run_id, storageRoot: path.join(f.root, scope.run_id), generatedInstructionBytes, instructionBinding });
}
function originalCompactFixtureAnswer(result, payload) {
  if (payload.schema !== 'shipyard.integration-partition-input.v2') return;
  const unit = payload.kind === 'unit';
  const groups = [];
  for (const domain of ['pairs', 'edges']) {
    const count = domain === 'pairs' ? payload.binding.pair_count : payload.binding.explicit_edge_count;
    const incident = domain === 'pairs' ? payload.interaction_domain.unit_ids.length > 1 : payload.explicit_edge_indices?.length;
    if (!count || unit && !incident) continue;
    groups.push({ id: domain + '-contract-evaluation', domain,
      domain_sha256: domain === 'pairs' ? payload.binding.domain_sha256 : payload.binding.explicit_edge_sha256,
      ...(unit ? { incident_unit: payload.unit_id } : { ranges: [[0, count]] }),
      disposition: 'resolved',
      rationale: 'Synthetic structural fixture: provider exports the accepted value, the consumer preserves that value without reordering, and the complete governing acceptance remains satisfied across every selected interaction. This narrative tests original response custody and grants no genuine semantic acceptance.',
      findings: [], limitations: [], required_context: [] });
  }
  Object.assign(result, { format: payload.format, binding: payload.binding, reviewed_identity: payload.reviewed_identity,
    conclusions: ['Synthetic fixture inspected the complete readable assigned context and every original contract obligation. Provider value propagation and consumer ordering agree across all selected interactions; no context was omitted from this structural test answer.'],
    limitations: [], required_context: [],
    evidence_markdown: 'Synthetic structural evidence only. The assigned provider and consumer contracts preserve value and ordering; complete source continuation and explicit completion obligations are included in the supplied readable context. No genuine model acceptance is asserted.' });
  if (unit) Object.assign(result, { schema: 'shipyard.integration-unit-result.v2', unit_id: payload.unit_id,
    coverage: payload.binding, seams: groups });
  else Object.assign(result, { coverage: { ...payload.coverage, limitations: [], seam_dispositions: groups } });
}
function addCompactPressure(f, members = 2, stress = false) {
  git(f.worktree, 'config', 'gc.auto', '0');
  const first = f.rows['T-49-01'];
  for (let i = 3; i <= members; i++) {
    const id = 'T-49-' + String(i).padStart(2, '0');
    f.rows[id] = { ...first, title: 'Complete integration contract ' + i, branch: 'ticket/' + id,
      plan: '.planning/phases/' + f.phase + '/49-' + String(i).padStart(2, '0') + '-PLAN.md' };
    f.state[id] = { status: 'merged', pr: 100 + i, branch: f.rows[id].branch };
  }
  for (const [id, row] of Object.entries(f.rows)) {
    const clauses = Array.from({ length: stress ? 13 : 1100 }, (_, i) =>
      '- ' + id + ' contract ' + i + (stress
        ? ': provider value must retain tenant identity, transaction ordering, cancellation ownership and exact consumer acceptance; missing source context requires an incomplete judgment.'
        : ': preserve tenant value, ordered delivery and cancellation owner; missing context is incomplete.')).join('\n');
    const design = Array.from({ length: stress ? 125 : 12 }, (_, i) =>
      id + ' governing obligation ' + i + ': continuation keeps every UTF8 source range readable; retry completion remains idempotent, cancellation propagates to the owner, and required consumer context must be retained before integration acceptance.').join('\n');
    write(f.worktree, row.plan, '---\nphase: 49\nplan: ' + id.slice(-2) + '\n---\nADR-014' + (stress ? '\nADR-015' : '') + '\n## Acceptance criteria\n' + clauses + '\n## Verification commands\n- node --check src/provider.cjs\n## Governing context\n' + design + '\n');
  }
  const count = stress ? 384 : 0, lines = 240;
  for (let i = 0; i < count; i++) {
    const body = Array.from({ length: lines }, (_, line) =>
      'exports.contract_' + i + '_' + line + ' = function(input) { if (!input || input.tenant !== "tenant-' + i + '") throw new Error("tenant identity required"); return { value: input.value, sequence: ' + line + ', owner: "contract-' + i + ' Ω" }; };').join('\n') + '\n';
    write(f.worktree, 'src/contract-' + i + '.cjs', body);
  }
  if (stress) {
    const code = fs.readFileSync(path.join(f.worktree, 'src/contract-0.cjs'), 'utf8');
    write(f.worktree, 'src/contract-alias.cjs', code);
    write(f.worktree, 'src/contract-long.cjs', 'exports.longContext = "' + 'Required Ω tenant identity preserves cancellation and retry ownership. '.repeat(1400) + '";\n');
    for (const [part, adr] of ['ADR-014', 'ADR-015'].entries())
      write(f.worktree, '.planning/architecture/' + adr + '-original.md', '# ' + adr + '\n' + Array.from({ length: 750 }, (_, i) =>
        'Governing contract ' + (part * 750 + i) + ': preserve complete source identity, tenant ownership, retry idempotency, consumer value ordering, and cancellation propagation; unresolved context requires incomplete integration.').join('\n'));
  }
  if (!stress) assert.ok(Object.values(f.rows).reduce((count, row) => count +
    (fs.readFileSync(path.join(f.worktree, row.plan), 'utf8').match(/^- T-49-\d+ contract /gm) || []).length, 0) >= 2000);
  const requiredContextPaths = [...Object.values(f.rows).map(row => row.plan),
    '.planning/architecture/ADR-014-original.md', ...(stress ? ['.planning/architecture/ADR-015-original.md'] : [])];
  for (const sourcePath of requiredContextPaths) {
    const bytes = fs.readFileSync(path.join(f.worktree, sourcePath)).length;
    assert.ok(bytes > 0 && bytes < 192 * 1024, sourcePath + ' must fit the real required-context file bound: ' + bytes);
  }
  write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
  write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
  const dependencies = count ? Array.from({ length: count }, (_, i) => "require('./contract-" + i + ".cjs');\n").join('') + (stress ? "require('./contract-alias.cjs');\nrequire('./contract-long.cjs');\n" : '') : '';
  write(f.worktree, 'src/provider.cjs', dependencies + 'exports.value = 1;\n');
  commit(f, 'complete compact structural fixture base');
  f.base = f.head; f.pr.baseRefOid = f.base;
  git(f.worktree, 'update-ref', 'refs/heads/main', f.base);
  git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
  if (stress) for (let i = 0; i < 48; i++) {
    const file = 'src/contract-' + i + '.cjs';
    write(f.worktree, file, fs.readFileSync(path.join(f.worktree, file), 'utf8').replaceAll('input.value', 'input.value ?? 0'));
  }
  write(f.worktree, 'src/provider.cjs', dependencies + 'exports.value = 2;\n');
  commit(f, 'complete compact structural fixture endpoints');
  f.memberHead = f.head;
  const inventoryPath = path.join(f.root, 'compact-roster.json');
  fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
  roleArtifact.registerPhaseArchiveRoster({ worktreePath: f.worktree, binding: phaseBinding(f), graphDir: f.graphDir,
    inventoryPath, expectedInventoryDigest: hash(fs.readFileSync(inventoryPath)) });
}
function substantiveFixtureNarrative(unit, budget) {
  let text = '', i = 0;
  while (true) {
    const next = 'Synthetic ' + unit + ' obligation ' + i++ + ': this original fixture conclusion retains tenant identity, cancellation ownership, retry completion ordering and consumer value propagation for its selected source range. ';
    if (Buffer.byteLength(text + next) > budget) return text;
    text += next;
  }
}
function expandCompactIdentity(table) {
  const expand = value => Array.isArray(value) ? value.map(expand) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : table.values[value];
  return expand(table.scalar_tree);
}
function independentTables(plan, tables, units, contentRequired) {
  const decodedSymbols = tables.symbols.map(([prefix, suffix]) => tables.symbol_prefixes[prefix] + suffix);
  assert.deepEqual(tables.segment_columns, ['segment_id_ref', 'source_id_ref', 'start_byte', 'end_byte', 'start_line', 'end_line', 'sha256_ref', 'content_index']);
  assert.deepEqual(tables.alias_columns, ['path_ref', 'pointer_ref', 'kind_ref', 'revision_ref', 'presence']);
  tables = { ...tables, sources: tables.sources.map(row => row.map((value, index) => index === 6 ? value.map(alias => Object.fromEntries(['path', 'pointer', 'kind', 'revision'].flatMap((key, i) => alias[4][i] === '0' ? [] : [[key, alias[i] === null ? null : decodedSymbols[alias[i]]]]))) : value)), segment_columns: tables.segment_columns.map(key => key.endsWith('_ref') ? key.slice(0, -4) : key),
    segments: tables.segments.map(row => row.map((value, index) => [0, 1, 6].includes(index) ? decodedSymbols[value] : value)) };
  const segmentId = segment => 'b-' + hash(stable(segment));
  const segmentMap = new Map(tables.segments.map(row => [row[0], Object.fromEntries(tables.segment_columns.slice(1, -1).map((key, i) => [key, row[i + 1]]))]));
  const sourceIds = new Set(units.flatMap(unit => [...unit.primary_segments, ...unit.support_segments]).map(segment => segment.source_id));
  const expandRows = (columns, rows) => rows.map(row => Object.fromEntries(columns.slice(0, -1)
    .flatMap((key, i) => row.at(-1)[i] === '1' ? [[key.endsWith('_ref') ? key.slice(0, -4) : key, key === 'value_ref' ? (Object.hasOwn(tables.values[row[i]], 'literal') ? tables.values[row[i]].literal : tables.values[row[i]].content_ranges.map(([index, left, right]) => tables.contents[index].slice(left, right)).join('')) : key.endsWith('_ref') && row[i] !== null ? decodedSymbols[row[i]] : row[i]]] : [])));
  assert.deepEqual(expandRows(tables.source_columns, tables.sources), plan.material.filter(source => sourceIds.has(source.source_id)).map(({ content, ...source }) => source));
  const ids = new Set(units.flatMap(unit => [...unit.primary_obligation_ids, ...unit.support_obligation_ids]));
  assert.deepEqual(expandRows(tables.obligation_columns, tables.obligations), plan.obligations.filter(item => ids.has(item.id)));
  assert.equal(new Set(tables.contents).size, tables.contents.length);
  const expandedValues = tables.values.map(value => {
    if (Object.hasOwn(value, 'literal')) return value.literal;
    assert.deepEqual(Object.keys(value), ['content_ranges']);
    assert.ok(value.content_ranges.length > 0);
    return value.content_ranges.map(([index, left, right]) => {
      assert.ok(Number.isSafeInteger(index) && index >= 0 && index < tables.contents.length);
      assert.ok(Number.isSafeInteger(left) && Number.isSafeInteger(right) && left >= 0 && right > left && right <= tables.contents[index].length);
      return tables.contents[index].slice(left, right);
    }).join('');
  });
  assert.equal(new Set(expandedValues.map(stable)).size, expandedValues.length);
  const selected = new Map();
  for (const unit of units) for (const item of [...unit.primary_segments, ...unit.support_segments]) selected.set(segmentId(item), item);
  assert.deepEqual([...segmentMap], [...selected].sort(([a], [b]) => a.localeCompare(b)));
  for (const row of tables.segments) {
    const source = plan.material.find(item => item.source_id === row[1]);
    const original = Buffer.from(source.content).subarray(row[2], row[3]);
    assert.equal(hash(original), row[6]);
    if (contentRequired(row[1])) assert.equal(tables.contents[row[7]], original.toString('utf8'));
    else assert.equal(row[7], null);
  }
  assert.equal(new Set(decodedSymbols).size, tables.symbols.length);
  const expandSet = index => tables.sets[index].map(reference => {
    assert.ok(Number.isSafeInteger(reference) && reference >= 0 && reference < tables.symbols.length);
    return decodedSymbols[reference];
  });
  assert.deepEqual(tables.assignments.map(row => ({ unit_id: row[0], primary_segments: expandSet(row[1]).map(id => segmentMap.get(id)),
    support_segments: expandSet(row[2]).map(id => segmentMap.get(id)), primary_obligation_ids: expandSet(row[3]),
    support_obligation_ids: expandSet(row[4]), governing_ids: expandSet(row[5]), seam_ids: expandSet(row[6]) })), units);
}
function independentEdges(table, expected) {
  assert.deepEqual(table.columns, ['id', 'from', 'to', 'obligation_ids_ref', 'rationale_ref', 'required_context_ref', 'uncertain']);
  const resolve = index => {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < table.values.length);
    return table.values[index];
  };
  const expanded = table.rows.map(row => ({ id: row[0], from: row[1], to: row[2],
    obligation_ids: resolve(row[3]), rationale: resolve(row[4]), required_context: resolve(row[5]), uncertain: row[6] }));
  assert.deepEqual(expanded, expected);
  assert.equal(table.count, expected.length);
  assert.equal(table.sha256, hash(stable(expected)));
  assert.equal(new Set(table.values.map(stable)).size, table.values.length);
}
function independentDomain(plan) {
  const explicit = new Map(), pairRecords = [];
  const edge = (from, to, obligation_ids, rationale) => {
    if (from === to) return;
    const id = 'e-' + hash([from, to, ...obligation_ids].join(':'));
    explicit.set(id, { id, from, to, obligation_ids, rationale, required_context: obligation_ids, uncertain: true });
  };
  for (const source of plan.material) {
    const owners = plan.units.filter(unit => unit.primary_segments.some(segment => segment.source_id === source.source_id)).map(unit => unit.unit_id);
    const obligations = plan.obligations.filter(item => item.source_id === source.source_id).map(item => item.id);
    owners.slice(1).forEach((owner, i) => edge(owners[i], owner, obligations, 'Exact original source continuation and logical completion'));
    for (const obligation of obligations) {
      const completion = plan.units.find(unit => unit.primary_obligation_ids.includes(obligation)).unit_id;
      for (const owner of owners) edge(owner, completion, [obligation], 'All original source segments required for logical completion');
    }
  }
  assert.deepEqual(plan.seams, [...explicit.values()].sort((a, b) => a.id.localeCompare(b.id)));
  for (let i = 0; i < plan.units.length; i++) for (let j = i + 1; j < plan.units.length; j++) {
    const from = plan.units[i].unit_id, to = plan.units[j].unit_id;
    pairRecords.push({ id: 'e-' + hash(from + ':' + to), from, to, obligation_ids: [],
      rationale: 'Cross-unit dependency or acceptance interaction is not statically disproven', required_context: [], uncertain: true });
  }
  assert.deepEqual(pairRecords.map((_, rank) => compactPair(plan, rank)), pairRecords);
  assert.equal(plan.interaction_domain.sha256, hash(stable(pairRecords)));
  assert.equal(plan.interaction_domain.count, pairRecords.length);
  assert.deepEqual(plan.interaction_domain.unit_ids, plan.units.map(unit => unit.unit_id));
  const primary = plan.units.flatMap(unit => unit.primary_segments);
  for (const source of plan.material) {
    const ranges = primary.filter(item => item.source_id === source.source_id).sort((a, b) => a.start_byte - b.start_byte);
    let offset = 0;
    for (const range of ranges) { assert.equal(range.start_byte, offset); offset = range.end_byte; }
    assert.equal(offset, source.bytes);
    assert.equal(Buffer.byteLength(source.content), source.bytes);
    assert.equal(hash(source.content), source.sha256);
  }
  assert.deepEqual(plan.units.flatMap(unit => unit.primary_obligation_ids).sort(), plan.obligations.map(item => item.id).sort());
}

async function assertCompactOriginalRefused(runtime, mutate, expected, extra = {}) {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    let reached = false;
    const controls = { observed: true, ...extra, result(result, payload) {
      assert.equal(payload.format, 'compact-domain.v1');
      reached = true;
      originalCompactFixtureAnswer(result, payload);
      mutate(result);
    } };
    const fixture = publicPartitionFixture(f, runtime, controls);
    await assert.rejects(supportedPartitionCaller(f, runtime, fixture.options), expected);
    assert.equal(reached, true);
    assert.ok(controls.launches.length > 0 && controls.launches.every(({ payload }) => payload.format === 'compact-domain.v1'));
  });
}

module.exports = { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, phaseBinding, projectOptions, write, git, commit, agent, claude, delivery, collector, roleArtifact, hash, stable, MiB, partitionSegments, partitionInputBytes, compactInteractionDomain, compactPair, compactStaticTables, compactDomainJudgments, compactBinding, compactReviewedIdentity, compactAggregatePayload, buildPartitionUnits, observedPartitionProfile, compactProfile, partitionUnitPayload, renderPartitionInput, partitionHash, partitionCoverage, assertPartitionCoverage, partitionPlanRecord, assertPartitionInputBound, partitionResult, endpoints, prepare, originalCompactFixtureAnswer, addCompactPressure, expandCompactIdentity, independentTables, independentEdges, independentDomain, substantiveFixtureNarrative, assertCompactOriginalRefused };
