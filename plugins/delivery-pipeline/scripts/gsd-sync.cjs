#!/usr/bin/env node
'use strict';

// Publish the Shipyard execution graph as a native GSD read model.
//
// This is deliberately local-only. GitHub/Jira state is observed by the
// delivery loop and recorded in .planning/graph; this command never makes a
// network request and never treats a missing observation as a green result.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseFrontmatter } = require('./frontmatter.cjs');
const { withLock, writeAtomic, lockDirFor } = require('./lock.cjs');

const ROOT = process.cwd();
const SYNC_VERSION = '1';
const ROADMAP_BEGIN = '<!-- shipyard:gsd-sync:begin -->';
const ROADMAP_END = '<!-- shipyard:gsd-sync:end -->';
const FILE_MARKER = 'shipyard:gsd-sync generated';
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');
const PHASES_DIR = path.join(ROOT, '.planning', 'phases');
const ROADMAP = path.join(ROOT, '.planning', 'ROADMAP.md');
const PROJECT = path.join(ROOT, '.planning', 'PROJECT.md');
const CONFIG = path.join(ROOT, '.planning', 'config.json');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const DELIVERY_STATE = path.join(GRAPH_DIR, 'delivery-state.json');
const DELIVERY_FRONT = path.join(GRAPH_DIR, 'delivery-front.json');

function pad(n) {
  const raw = String(n ?? '').trim();
  if (!/^\d+$/.test(raw)) return raw;
  const s = String(Number(raw));
  return s.length >= 2 ? s : `0${s}`;
}

function phaseKey(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^(?:phase[-_ ]*)?(\d+)/i);
  return m ? String(Number(m[1])) : s;
}

function phaseNumber(value) {
  const key = phaseKey(value);
  return /^\d+$/.test(key) ? Number(key) : null;
}

function canonicalTicket(value, phase = null) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (/^t-/i.test(s)) s = s.slice(2);
  else if (/^\d+$/.test(s) && phase != null) s = `${phase}-${s}`;
  const parts = s.split('-').filter(Boolean).map((part) =>
    /^\d+$/.test(part) ? pad(Number(part)) : part.toUpperCase(),
  );
  return parts.length ? `T-${parts.join('-')}` : null;
}

function slugify(value, max = 64) {
  const translit = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh',
    з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
    о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
    ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e',
    ё: 'e', ъ: '',
  };
  return String(value || '').toLowerCase().split('')
    .map((c) => translit[c] || c).join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

function readText(file, { required = false } = {}) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (required) throw new Error(`cannot read ${path.relative(ROOT, file)}: ${error.message}`);
    return null;
  }
}

function readJson(file, { required = false, fallback = null } = {}) {
  const raw = readText(file, { required });
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

function posixRelative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function isoDate(value, fallback = new Date().toISOString()) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function dateOnly(value, fallback = new Date().toISOString()) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : fallback;
}

function stripRoadmapProjection(text) {
  return String(text).replace(
    new RegExp(`${escapeRegExp(ROADMAP_BEGIN)}[\\s\\S]*?${escapeRegExp(ROADMAP_END)}\\n?`, 'g'),
    '',
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function marker(fingerprint) {
  return `<!-- ${FILE_MARKER}; sync-version: ${SYNC_VERSION}; source fingerprint: ${fingerprint} -->`;
}

function hasMarker(text) {
  return String(text).includes(FILE_MARKER);
}

function normalizeForHash(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sourceFileEntries(files) {
  return files
    .filter((file) => fs.existsSync(file))
    .map((file) => [posixRelative(file), normalizeForHash(fs.readFileSync(file, 'utf8'))])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function sourceFingerprint(entries) {
  const hash = crypto.createHash('sha256');
  hash.update(`gsd-sync:${SYNC_VERSION}\n`);
  for (const [name, content] of entries) hash.update(`${name}\0${content}\0`);
  return hash.digest('hex');
}

function parseArgs(argv) {
  const args = { check: false, json: false, phase: null, help: false, adoptNative: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--check') args.check = true;
    else if (token === '--json') args.json = true;
    else if (token === '--adopt-native') args.adoptNative = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--phase') {
      const value = argv[++i];
      if (!/^\d+$/.test(String(value || ''))) throw new CliError('--phase requires a numeric phase');
      args.phase = String(Number(value));
    } else if (token.startsWith('--phase=')) {
      const value = token.slice('--phase='.length);
      if (!/^\d+$/.test(value)) throw new CliError('--phase requires a numeric phase');
      args.phase = String(Number(value));
    } else {
      throw new CliError(`unknown argument: ${token}`);
    }
  }
  return args;
}

class CliError extends Error {}

function parseRoadmap(text) {
  const clean = stripRoadmapProjection(text);
  const requirements = [];
  const requirementRe = /^\s*-\s+\*\*([A-Z][A-Z0-9]+-\d+)\*\*\s+[—-]\s+(.+)$/gm;
  let match;
  while ((match = requirementRe.exec(clean))) {
    requirements.push({ id: match[1], description: match[2].trim() });
  }

  const phases = [];
  const phaseRe = /^###\s+Phase\s+(\d+)\s*:\s*(.+)$/gm;
  while ((match = phaseRe.exec(clean))) {
    phases.push({ number: Number(match[1]), title: match[2].trim() });
  }
  return { clean, requirements, phases };
}

function parsePhaseRequirements(cleanRoadmap, phaseNumberValue) {
  const start = cleanRoadmap.search(new RegExp(`^###\\s+Phase\\s+${phaseNumberValue}\\s*:`, 'm'));
  if (start < 0) return [];
  const rest = cleanRoadmap.slice(start);
  const next = rest.search(/^###\s+Phase\s+\d+\s*:/m);
  const section = next > 0 ? rest.slice(0, next) : rest;
  const m = section.match(/\*\*Requirements\*\*\s*:\s*([^\n]+)/i);
  return m ? [...m[1].matchAll(/[A-Z][A-Z0-9]+-\d+/g)].map((x) => x[0]) : [];
}

function parseProjectCore(projectText) {
  const lines = String(projectText || '').split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+Core Value\s*$/i.test(line));
  if (heading >= 0) {
    const value = [];
    for (let i = heading + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) {
      value.push(lines[i]);
    }
    const coreValue = value.join(' ').replace(/\s+/g, ' ').trim();
    if (coreValue) return coreValue;
  }
  return 'Maintain a truthful, resumable synchronization between Shipyard delivery and GSD.';
}

function listPhaseDirs() {
  if (!fs.existsSync(PHASES_DIR)) return [];
  return fs.readdirSync(PHASES_DIR).filter((name) => {
    try { return fs.statSync(path.join(PHASES_DIR, name)).isDirectory(); } catch { return false; }
  }).sort();
}

function phaseDirFor(number, title, existingDirs) {
  const prefix = `${pad(number)}-`;
  const found = existingDirs.find((name) => name === String(number) || name.startsWith(prefix));
  return found || `${prefix}${slugify(title) || 'phase'}`;
}

function collectPlans(existingDirs) {
  const plans = [];
  const errors = [];
  let planFileCount = 0;
  let deliveryPlanFileCount = 0;
  for (const dirName of existingDirs) {
    const dir = path.join(PHASES_DIR, dirName);
    const planFiles = fs.readdirSync(dir).filter((name) => /-PLAN\.md$/.test(name)).sort();
    planFileCount += planFiles.length;
    for (const fileName of planFiles) {
      const file = path.join(dir, fileName);
      const raw = readText(file, { required: true });
      const parsed = parseFrontmatter(raw);
      if (!parsed.data || parsed.errors.length) {
        errors.push(`${posixRelative(file)}: malformed frontmatter`);
        continue;
      }
      const fm = parsed.data;
      const phase = phaseNumber(fm.phase) ?? phaseNumber(dirName);
      const base = fileName.replace(/-PLAN\.md$/, '');
      const plan = String(fm.plan ?? base.split('-').slice(-1)[0]).trim();
      const delivery = fm.delivery && typeof fm.delivery === 'object' ? fm.delivery : {};
      if (Object.keys(delivery).length) deliveryPlanFileCount += 1;
      const ticket = canonicalTicket(delivery.ticket, phase);
      if (phase == null || !ticket) {
        errors.push(`${posixRelative(file)}: missing phase or delivery.ticket`);
        continue;
      }
      plans.push({
        file,
        dirName,
        fileName,
        phase,
        plan: pad(plan),
        title: String(fm.title || base),
        ticket,
        requirements: Array.isArray(fm.requirements) ? fm.requirements.map(String) : [],
        files: Array.isArray(fm.files_modified) ? fm.files_modified.map(String) : [],
        raw,
        delivery,
      });
    }
  }
  return {
    plans: plans.sort((a, b) => a.phase - b.phase || a.plan.localeCompare(b.plan)),
    errors,
    planFileCount,
    deliveryPlanFileCount,
  };
}

function integrationStatus(text) {
  if (!text) return { status: 'pending', reason: 'INTEGRATION.md is missing' };
  const lower = text.toLowerCase();
  // Historical integration reports may mention an earlier needs-fix round in
  // the body of a final passed review. Use the last explicit Verdict line as
  // the authority and only inspect the document preamble when no such line
  // exists; never downgrade a final pass because of retrospective prose.
  const verdictLines = String(text).split(/\r?\n/).filter((line) => /verdict/i.test(line));
  const explicit = verdictLines.length ? verdictLines[verdictLines.length - 1].toLowerCase() : '';
  if (/passed/.test(explicit)) return { status: 'passed', reason: 'integration evidence records passed' };
  if (/needs[- ]fix|gaps_found|failed/.test(explicit)) {
    return { status: 'needs-fix', reason: 'integration evidence records a finding or failed verdict' };
  }
  const preamble = lower.split(/\r?\n/).slice(0, 18).join('\n');
  if (/\bneeds[- ]fix\b|\bgaps_found\b|\bfailed\b/.test(preamble)) {
    return { status: 'needs-fix', reason: 'integration evidence records a finding or failed verdict' };
  }
  if (/\bpassed\b/.test(preamble)) {
    return { status: 'passed', reason: 'integration evidence records passed' };
  }
  return { status: 'pending', reason: 'integration evidence has no explicit passed verdict' };
}

function deliveryStatus(entry) {
  const status = entry && typeof entry.status === 'string' ? entry.status : 'pending';
  return ['pending', 'branched', 'pr-open', 'merged'].includes(status) ? status : 'unknown';
}

function phaseEvidence(phase, planRecords, integration) {
  const plans = planRecords.filter((record) => record.phase === phase.number);
  const merged = plans.filter((record) => record.delivery_status === 'merged').length;
  const incomplete = plans.filter((record) => record.delivery_status !== 'merged');
  const allMerged = plans.length > 0 && incomplete.length === 0;
  let status = 'pending';
  let reason = 'phase has no complete integration evidence';
  if (incomplete.length) {
    reason = `${incomplete.length} plan(s) are not merged`;
  } else if (integration.status === 'needs-fix') {
    status = 'gaps_found';
    reason = integration.reason;
  } else if (allMerged && integration.status === 'passed') {
    status = 'passed';
    reason = 'all plans are merged and integration evidence passed';
  } else if (!plans.length) {
    reason = 'phase has no PLAN files yet';
  } else {
    reason = integration.reason;
  }
  return { plans, merged, allMerged, status, reason, integration };
}

function checkSource({ roadmapText, roadmapInfo, projectText, plans, planErrors, graph, state, front }) {
  const blockers = [...planErrors];
  if (!graph || typeof graph !== 'object' || !graph.tickets || typeof graph.tickets !== 'object') {
    blockers.push('tickets.json is missing a tickets mapping');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) blockers.push('delivery-state.json must be an object');
  if (!roadmapText) blockers.push('ROADMAP.md is missing');
  if (!projectText) blockers.push('PROJECT.md is missing');
  if (!roadmapInfo.phases.length) blockers.push('ROADMAP.md has no ### Phase declarations');
  if (!plans.length) blockers.push('no *-PLAN.md files found under .planning/phases');
  if (front != null && typeof front !== 'object') blockers.push('delivery-front.json must be an object');

  const graphTickets = graph && graph.tickets && typeof graph.tickets === 'object' ? graph.tickets : {};
  const seen = new Set();
  for (const plan of plans) {
    if (seen.has(plan.ticket)) blockers.push(`${posixRelative(plan.file)}: duplicate ticket ${plan.ticket}`);
    seen.add(plan.ticket);
    if (!graphTickets[plan.ticket]) blockers.push(`${plan.ticket}: PLAN is absent from tickets.json`);
  }
  for (const id of Object.keys(graphTickets)) {
    if (!seen.has(id) && /^T-\d{2}-\d{2}/.test(id)) blockers.push(`${id}: graph ticket has no matching PLAN.md`);
  }
  return blockers;
}

function makePlanRecords(plans, state) {
  return plans.map((plan) => {
    const entry = state[plan.ticket] || { status: 'pending' };
    return {
      ...plan,
      delivery_status: deliveryStatus(entry),
      delivery: entry,
      merged_at: entry.mergedAt || entry.merged_at || (entry.status === 'merged' ? entry.since : null),
    };
  });
}

function generatedPathList(phases, planRecords) {
  const files = [path.join(ROOT, '.planning', 'STATE.md'), path.join(ROOT, '.planning', 'REQUIREMENTS.md'), ROADMAP];
  for (const plan of planRecords) files.push(path.join(path.dirname(plan.file), plan.fileName.replace(/-PLAN\.md$/, '-SUMMARY.md')));
  for (const phase of phases) {
    const dir = path.join(PHASES_DIR, phase.dirName);
    files.push(path.join(dir, `${phase.dirName}-UAT.md`));
    files.push(path.join(dir, `${phase.dirName}-VERIFICATION.md`));
  }
  return files;
}

function phaseNameMap(roadmapInfo, existingDirs) {
  return roadmapInfo.phases.map((entry) => ({
    ...entry,
    dirName: phaseDirFor(entry.number, entry.title, existingDirs),
  }));
}

function projectRequirements(roadmapInfo, phases, evidenceByPhase, fingerprint, coreValue) {
  const phaseForRequirement = new Map();
  for (const phase of phases) {
    for (const req of parsePhaseRequirements(roadmapInfo.clean, phase.number)) phaseForRequirement.set(req, phase.number);
  }
  const lines = [
    '# Requirements: shipyard',
    '',
    `<!-- ${marker(fingerprint).slice(5, -4)} -->`,
    '',
    '**Defined:** 2026-09-10',
    `**Core Value:** ${coreValue}`,
    '',
    '## v1 Requirements',
    '',
    '### Delivery and workflow integrity',
  ];
  const requirements = roadmapInfo.requirements;
  for (const req of requirements) {
    const phaseNumberValue = phaseForRequirement.get(req.id);
    const evidence = phaseNumberValue == null ? null : evidenceByPhase.get(phaseNumberValue);
    const complete = evidence && evidence.status === 'passed';
    lines.push(`- [${complete ? 'x' : ' '}] **${req.id}**: ${req.description}`);
  }
  lines.push('', '## Out of Scope', '', '| Feature | Reason |', '|---|---|',
    '| External tracker or GitHub mutation | The projection is local-only. |',
    '| Historical evidence fabrication | Missing or failed integration remains visible. |',
    '', '## Traceability', '', '| Requirement | Phase | Status |', '|---|---|---|');
  for (const req of requirements) {
    const phaseNumberValue = phaseForRequirement.get(req.id);
    const evidence = phaseNumberValue == null ? null : evidenceByPhase.get(phaseNumberValue);
    const status = evidence ? (evidence.status === 'passed' ? 'Complete' : evidence.status === 'gaps_found' ? 'Blocked' : 'In Progress') : 'Pending';
    lines.push(`| ${req.id} | ${phaseNumberValue == null ? 'Unmapped' : `Phase ${phaseNumberValue}`} | ${status} |`);
  }
  const mapped = requirements.filter((req) => phaseForRequirement.has(req.id)).length;
  lines.push('', '**Coverage:**', `- v1 requirements: ${requirements.length} total`, `- Mapped to phases: ${mapped}`, `- Unmapped: ${requirements.length - mapped} ${requirements.length === mapped ? '✓' : '⚠️'}`, '',
    '---', '*Requirements generated by Shipyard GSD synchronization.*', '');
  return lines.join('\n');
}

function latestActivity(planRecords) {
  const dates = planRecords.map((plan) => plan.merged_at || plan.delivery.since)
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return dates.length ? new Date(Math.max(...dates)).toISOString() : '2000-01-01T00:00:00.000Z';
}

function renderState({ phases, planRecords, evidenceByPhase, fingerprint, coreValue, blockers, lastActivity }) {
  const completedPlans = planRecords.filter((plan) => plan.delivery_status === 'merged').length;
  const completedPhases = [...evidenceByPhase.values()].filter((e) => e.status === 'passed').length;
  const totalPlans = planRecords.length;
  const percent = totalPlans ? Math.floor((completedPlans / totalPlans) * 100) : 0;
  const firstIncomplete = phases.findIndex((phase) => evidenceByPhase.get(phase.number).status !== 'passed');
  const currentIndex = firstIncomplete >= 0 ? firstIncomplete : phases.length - 1;
  const current = currentIndex >= 0 ? phases[currentIndex] : null;
  const currentEvidence = current ? evidenceByPhase.get(current.number) : null;
  const bar = `${'█'.repeat(Math.floor(percent / 10))}${'░'.repeat(10 - Math.floor(percent / 10))}`;
  const phaseRows = phases.map((phase) => {
    const evidence = evidenceByPhase.get(phase.number);
    return `| ${phase.number} | ${evidence.plans.length} | ${evidence.merged} | ${evidence.status} |`;
  });
  const blockerLines = blockers.length ? blockers.slice(0, 8).map((item) => `- ${item}`) : ['- None.'];
  return [
    '---',
    `# ${marker(fingerprint).slice(5, -4)}`,
    "gsd_state_version: '1.0'",
    'status: planning',
    'progress:',
    `  total_phases: ${phases.length}`,
    `  completed_phases: ${completedPhases}`,
    `  total_plans: ${totalPlans}`,
    `  completed_plans: ${completedPlans}`,
    `  percent: ${percent}`,
    '---',
    '',
    '# Project State',
    '',
    '## Project Reference',
    '',
    'See: .planning/PROJECT.md (updated by Shipyard GSD synchronization)',
    '',
    `**Core value:** ${coreValue}`,
    `**Current focus:** ${current ? `Phase ${current.number}: ${current.title}` : 'No phase declared'}`,
    '',
    '## Current Position',
    '',
    `Phase: ${current ? `${currentIndex + 1} of ${phases.length} (Phase ${current.number}: ${current.title})` : 'None'}`,
    `Plan: ${currentEvidence ? `${currentEvidence.merged} of ${currentEvidence.plans.length} merged` : 'None'}`,
    `Status: ${currentEvidence ? currentEvidence.status : 'Planning'}`,
    `Last activity: ${dateOnly(lastActivity)} — Shipyard projection synchronized`,
    '',
    `Progress: [${bar}] ${percent}%`,
    '',
    '## Performance Metrics',
    '',
    `- Total plans completed: ${completedPlans}`,
    '- Average duration: not measured by the projection',
    '- Total execution time: not measured by the projection',
    '',
    '**By Phase:**',
    '',
    '| Phase | Plans | Merged | Verification |',
    '|---|---:|---:|---|',
    ...phaseRows,
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Shipyard delivery state is authoritative for execution; this file is a native GSD projection.',
    '- A merged ticket does not imply a verified phase.',
    '',
    '### Pending Todos',
    '',
    'Review and resolve phase integration findings shown in the phase artifacts.',
    '',
    '### Blockers/Concerns',
    '',
    ...blockerLines,
    '',
    '## Deferred Items',
    '',
    '| Category | Item | Status | Deferred At | Milestone |',
    '|---|---|---|---|---|',
    '| Evidence | Historical phases without integration proof | Visible, not fabricated | 2026-09-10 | ADR-013 |',
    '',
    '## Session Continuity',
    '',
    `Last session: ${isoDate(lastActivity).slice(0, 16).replace('T', ' ')}`,
    'Stopped at: Shipyard GSD projection synchronized from the delivery graph.',
    'Resume file: None',
    '',
  ].join('\n');
}

function renderSummary(plan, fingerprint) {
  const complete = plan.delivery_status === 'merged';
  const status = complete ? 'complete' : 'halted';
  const completionDate = complete ? dateOnly(plan.merged_at, null) : null;
  const provides = complete ? `Delivery evidence for ${plan.ticket}` : `Tracked delivery state for ${plan.ticket}`;
  return [
    '---',
    `# ${marker(fingerprint).slice(5, -4)}`,
    `phase: ${pad(plan.phase)}-${slugify(plan.dirName.replace(/^\d+-/, ''))}`,
    `plan: ${plan.plan}`,
    'subsystem: shipyard delivery',
    'tags: [shipyard, gsd, delivery-projection]',
    'provides:',
    `  - ${provides}`,
    'affects: [GSD progress, Shipyard delivery]',
    'actuals:',
    '  tokens: 0',
    '  tasks: 0',
    '  commits: 0',
    'tech-stack:',
    '  added: []',
    '  patterns: [evidence-based projection]',
    'key-files:',
    '  created: []',
    '  modified: []',
    'key-decisions:',
    '  - "Shipyard delivery state is projected; no native executor claim is invented."',
    'duration: 0min',
    ...(completionDate ? [`completed: ${completionDate}`] : []),
    `status: ${status}`,
    'shipyard_sync: delivery-projection',
    `shipyard_source_fingerprint: ${fingerprint}`,
    '---',
    '',
    `# Phase ${plan.phase}: ${plan.title} — Delivery Projection`,
    '',
    `**${complete ? 'Plan delivery is evidenced by a merged ticket.' : 'Plan delivery is not complete; the projection preserves the current state.'}**`,
    '',
    '## Delivery Evidence',
    '',
    `- Ticket: ${plan.ticket}`,
    `- Delivery status: ${plan.delivery_status}`,
    `- PR: ${plan.delivery.pr ? `#${plan.delivery.pr}` : 'not observed'}`,
    `- Source plan: ${posixRelative(plan.file)}`,
    complete ? '- This summary is complete because the delivery state observes `merged`.' : '- This summary is halted until the delivery state observes `merged`.',
    '',
    '## Decisions & Deviations',
    '',
    'Generated by Shipyard; this is not a native GSD executor transcript.',
    '',
    '## Next Phase Readiness',
    '',
    complete ? 'The ticket-level delivery record is complete; phase verification remains represented by the phase UAT/VERIFICATION artifacts.' : 'Resume the delivery loop from the current ticket state.',
    '',
  ].join('\n');
}

function renderUat(phase, evidence, fingerprint) {
  const phaseStatus = evidence.status;
  const hasPlans = evidence.plans.length > 0;
  const planResult = hasPlans && evidence.allMerged ? 'passed' : 'pending';
  const integrationResult = phaseStatus === 'passed' ? 'passed' : phaseStatus === 'gaps_found' ? 'failed' : 'pending';
  const verificationResult = phaseStatus === 'passed' ? 'passed' : phaseStatus === 'gaps_found' ? 'failed' : 'pending';
  return [
    '---',
    `# ${marker(fingerprint).slice(5, -4)}`,
    `phase: ${phase.number}`,
    `status: ${phaseStatus === 'passed' ? 'passed' : phaseStatus === 'gaps_found' ? 'failed' : 'pending'}`,
    `result: ${phaseStatus === 'passed' ? 'passed' : phaseStatus === 'gaps_found' ? 'failed' : 'pending'}`,
    'shipyard_sync: evidence-projection',
    `shipyard_source_fingerprint: ${fingerprint}`,
    '---',
    '',
    `# Phase ${phase.number}: ${phase.title} — UAT Projection`,
    '',
    'This file is generated from the delivery graph and phase integration evidence.',
    '',
    '### 1. Delivery plans are accounted for',
    `result: ${planResult}`,
    `expected: ${hasPlans ? `all ${evidence.plans.length} phase plan(s) are merged` : 'at least one delivery PLAN.md is present'}`,
    `actual: ${hasPlans ? `${evidence.merged} merged` : 'no delivery PLAN.md files; evidence is missing'}`,
    '',
    '### 2. Integration evidence is explicit',
    `result: ${integrationResult}`,
    `expected: an explicit passed verdict in ${posixRelative(path.join(PHASES_DIR, phase.dirName, 'INTEGRATION.md'))}`,
    `actual: ${evidence.integration.status} — ${evidence.integration.reason}`,
    '',
    '### 3. Phase verification is evidence-backed',
    `result: ${verificationResult}`,
    `expected: the phase verification projection is ${phaseStatus === 'passed' ? 'passed' : 'not green without evidence'}`,
    `actual: ${phaseStatus}`,
    '',
  ].join('\n');
}

function renderVerification(phase, evidence, fingerprint, lastActivity) {
  const status = evidence.status === 'passed' ? 'passed' : evidence.status === 'gaps_found' ? 'gaps_found' : 'human_needed';
  const rows = evidence.plans.length
    ? evidence.plans.map((plan) => `| ${plan.ticket} | ${plan.delivery_status} | ${plan.delivery_status === 'merged' ? '✓ VERIFIED' : '✗ FAILED'} |`).join('\n')
    : '| — | no plans | ? UNCERTAIN |';
  const planEvidence = evidence.plans.length
    ? `${evidence.merged}/${evidence.plans.length} delivery records are merged`
    : 'No PLAN files are present; delivery evidence is missing';
  const planStatus = evidence.plans.length
    ? (evidence.allMerged ? '✓ VERIFIED' : '✗ FAILED')
    : '? UNCERTAIN';
  return [
    '---',
    `# ${marker(fingerprint).slice(5, -4)}`,
    `phase: ${phase.number}`,
    `verified: ${isoDate(lastActivity)}`,
    `status: ${status}`,
    `shipyard_source_fingerprint: ${fingerprint}`,
    '---',
    '',
    `# Phase ${phase.number}: ${phase.title} — Verification Projection`,
    '',
    `**Status:** ${status}`,
    '',
    '## Observable Truths',
    '',
    '| Truth | Evidence | Status |',
    '|---|---|---|',
    `| Every phase plan is accounted for | ${planEvidence} | ${planStatus} |`,
    `| Integration is coherent | ${evidence.integration.reason} | ${evidence.integration.status === 'passed' ? '✓ VERIFIED' : evidence.integration.status === 'needs-fix' ? '✗ FAILED' : '? UNCERTAIN'} |`,
    '',
    '## Plan Evidence',
    '',
    '| Ticket | Delivery | Plan status |',
    '|---|---|---|',
    rows,
    '',
    '## Verification Commands',
    '',
    '- `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json`',
    '- `gsd-tools phase uat-passed ' + phase.number + ' --raw`',
    '',
    '## Gaps Summary',
    '',
    evidence.status === 'passed' ? '**No gaps found in the available repository evidence.**' : `**Not green:** ${evidence.reason}.`,
    '',
  ].join('\n');
}

function renderRoadmapBlock({ phases, evidenceByPhase, planRecords, fingerprint }) {
  const completedPlans = planRecords.filter((plan) => plan.delivery_status === 'merged').length;
  const completePhases = phases.filter((phase) => evidenceByPhase.get(phase.number).status === 'passed').length;
  const lines = [
    ROADMAP_BEGIN,
    '## Shipyard synchronization (generated)',
    '',
    `- Source fingerprint: \`${fingerprint}\``,
    `- Plans merged: ${completedPlans}/${planRecords.length}`,
    `- Phases verified: ${completePhases}/${phases.length}`,
    `- Current phase: ${phases.find((phase) => evidenceByPhase.get(phase.number).status !== 'passed')?.number || 'none'}`,
    '',
    '| Phase | Plans | Merged | Verification |',
    '|---|---:|---:|---|',
    ...phases.map((phase) => {
      const evidence = evidenceByPhase.get(phase.number);
      return `| ${phase.number} — ${phase.title} | ${evidence.plans.length} | ${evidence.merged} | ${evidence.status} |`;
    }),
    '',
    ROADMAP_END,
  ];
  return lines.join('\n');
}

function replaceRoadmapBlock(original, block) {
  const hasBegin = original.includes(ROADMAP_BEGIN);
  const hasEnd = original.includes(ROADMAP_END);
  if (hasBegin !== hasEnd) throw new Error('ROADMAP.md has an incomplete Shipyard synchronization block');
  if (!hasBegin) return `${String(original).trimEnd()}\n\n${block}\n`;
  return String(original).replace(
    new RegExp(`${escapeRegExp(ROADMAP_BEGIN)}[\\s\\S]*?${escapeRegExp(ROADMAP_END)}`),
    block,
  );
}

function generatedFileContent(file, expected, { adoptNative = false } = {}) {
  const existing = readText(file);
  // ROADMAP is human-authored outside its marked block; all other projection
  // files are wholly owned and must carry our marker before they are replaced.
  // A lifecycle gate may explicitly adopt the native GSD files once the project
  // has opted into Shipyard delivery. Direct syncs remain fail-closed.
  if (existing != null && file !== ROADMAP && !hasMarker(existing) && !adoptNative) {
    throw new Error(`${posixRelative(file)} exists but is not owned by ${FILE_MARKER}`);
  }
  return { file, existing, expected };
}

function findObsoleteGeneratedFiles(expected, { prune = true } = {}) {
  if (!prune) return [];
  const expectedSet = new Set(expected.map((file) => path.resolve(file)));
  const obsolete = [];
  const candidates = [];
  if (fs.existsSync(PHASES_DIR)) {
    for (const dirName of listPhaseDirs()) {
      const dir = path.join(PHASES_DIR, dirName);
      for (const name of fs.readdirSync(dir)) {
        if (!/-SUMMARY\.md$|-UAT\.md$|-VERIFICATION\.md$/.test(name)) continue;
        candidates.push(path.join(dir, name));
      }
    }
  }
  for (const file of candidates) {
    if (!expectedSet.has(path.resolve(file)) && hasMarker(readText(file) || '')) obsolete.push(file);
  }
  return obsolete;
}

function buildSnapshot({ phase: focusPhase = null, adoptNative = false } = {}) {
  const roadmapText = readText(ROADMAP);
  const projectText = readText(PROJECT);
  const graph = readJson(TICKETS, { fallback: null });
  const state = readJson(DELIVERY_STATE, { fallback: {} });
  const front = readJson(DELIVERY_FRONT, { fallback: null });
  const roadmapInfo = parseRoadmap(roadmapText || '');
  const existingDirs = listPhaseDirs();
  const phaseList = phaseNameMap(roadmapInfo, existingDirs);
  const collected = collectPlans(existingDirs);
  if (collected.deliveryPlanFileCount === 0) {
    return {
      applicable: false,
      ok: true,
      blockers: [],
      source_fingerprint: null,
      generated: [],
      obsolete: [],
      phases: [],
      counts: { phases: 0, plans: 0, merged_plans: 0, verified_phases: 0, generated_files: 0, obsolete_files: 0 },
    };
  }
  const blockers = checkSource({ roadmapText, roadmapInfo, projectText, plans: collected.plans, planErrors: collected.errors, graph, state, front });
  if (focusPhase != null && !phaseList.some((phase) => phase.number === Number(focusPhase))) {
    blockers.push(`requested phase ${focusPhase} is not declared in ROADMAP.md`);
  }
  const planRecords = makePlanRecords(collected.plans, state || {});
  const evidenceByPhase = new Map();
  for (const phase of phaseList) {
    const integration = integrationStatus(readText(path.join(PHASES_DIR, phase.dirName, 'INTEGRATION.md')));
    evidenceByPhase.set(phase.number, phaseEvidence(phase, planRecords, integration));
  }
  const sourceFiles = [ROADMAP, PROJECT, CONFIG, TICKETS, DELIVERY_STATE, DELIVERY_FRONT];
  for (const plan of planRecords) sourceFiles.push(plan.file);
  for (const phase of phaseList) {
    const integration = path.join(PHASES_DIR, phase.dirName, 'INTEGRATION.md');
    if (fs.existsSync(integration)) sourceFiles.push(integration);
  }
  const sourceEntries = sourceFileEntries(sourceFiles.filter((file) => file !== ROADMAP));
  // The first publication appends the marked block after the human prose; the
  // block remover must not make the source fingerprint depend on whether that
  // block has already existed (one extra trailing blank line was enough to make
  // the second run rewrite every generated artifact).
  sourceEntries.push([posixRelative(ROADMAP), `${normalizeForHash(roadmapInfo.clean).trimEnd()}\n`]);
  sourceEntries.sort((a, b) => a[0].localeCompare(b[0]));
  const fingerprint = sourceFingerprint(sourceEntries);
  const coreValue = parseProjectCore(projectText);
  const lastActivity = latestActivity(planRecords);
  const expected = new Map();
  expected.set(path.join(ROOT, '.planning', 'STATE.md'), renderState({ phases: phaseList, planRecords, evidenceByPhase, fingerprint, coreValue, blockers, lastActivity }));
  expected.set(path.join(ROOT, '.planning', 'REQUIREMENTS.md'), projectRequirements(roadmapInfo, phaseList, evidenceByPhase, fingerprint, coreValue));
  expected.set(ROADMAP, replaceRoadmapBlock(roadmapText || '', renderRoadmapBlock({ phases: phaseList, evidenceByPhase, planRecords, fingerprint })));
  for (const plan of planRecords.filter((record) => focusPhase == null || record.phase === Number(focusPhase))) {
    expected.set(path.join(path.dirname(plan.file), plan.fileName.replace(/-PLAN\.md$/, '-SUMMARY.md')), renderSummary(plan, fingerprint));
  }
  for (const phase of phaseList) {
    if (focusPhase != null && phase.number !== Number(focusPhase)) continue;
    const evidence = evidenceByPhase.get(phase.number);
    const dir = path.join(PHASES_DIR, phase.dirName);
    expected.set(path.join(dir, `${phase.dirName}-UAT.md`), renderUat(phase, evidence, fingerprint));
    expected.set(path.join(dir, `${phase.dirName}-VERIFICATION.md`), renderVerification(phase, evidence, fingerprint, lastActivity));
  }
  const generated = [...expected.entries()].map(([file, content]) => generatedFileContent(file, content, { adoptNative }));
  const obsolete = findObsoleteGeneratedFiles([...expected.keys()], { prune: focusPhase == null });
  const counts = {
    phases: phaseList.length,
    plans: planRecords.length,
    merged_plans: planRecords.filter((plan) => plan.delivery_status === 'merged').length,
    verified_phases: [...evidenceByPhase.values()].filter((evidence) => evidence.status === 'passed').length,
    generated_files: generated.length,
    obsolete_files: obsolete.length,
  };
  return {
    applicable: true,
    ok: blockers.length === 0,
    blockers,
    source_fingerprint: fingerprint,
    generated,
    obsolete,
    phases: phaseList.map((phase) => ({
      phase: phase.number,
      title: phase.title,
      directory: phase.dirName,
      status: evidenceByPhase.get(phase.number).status,
      reason: evidenceByPhase.get(phase.number).reason,
    })),
    counts,
  };
}

function isSame(file, expected) {
  return readText(file) === expected;
}

function checkSnapshot(snapshot) {
  const drift = [];
  for (const item of snapshot.generated) {
    if (!isSame(item.file, item.expected)) drift.push(`${posixRelative(item.file)} is missing or stale`);
  }
  for (const file of snapshot.obsolete) drift.push(`${posixRelative(file)} is obsolete generated output`);
  return drift;
}

function publishSnapshot(snapshot) {
  if (snapshot.blockers.length) throw new Error(snapshot.blockers.join('; '));
  for (const item of snapshot.generated) {
    fs.mkdirSync(path.dirname(item.file), { recursive: true });
    writeAtomic(item.file, item.expected);
  }
  for (const file of snapshot.obsolete) {
    // Only delete files that were positively identified as ours in the snapshot.
    // No glob or recursive deletion is used here.
    if (hasMarker(readText(file) || '')) fs.unlinkSync(file);
  }
}

function resultFor(snapshot, args, drift = []) {
  return {
    ok: snapshot.blockers.length === 0 && drift.length === 0,
    mode: args.check ? 'check' : 'write',
    applicable: snapshot.applicable,
    phase: args.phase,
    source_fingerprint: snapshot.source_fingerprint,
    generated_files: snapshot.generated.map((item) => posixRelative(item.file)),
    obsolete_files: snapshot.obsolete.map(posixRelative),
    phases: snapshot.phases,
    counts: snapshot.counts,
    blockers: [...snapshot.blockers, ...drift],
  };
}

function help() {
  return [
    'usage: gsd-sync.cjs [--check] [--json] [--adopt-native] [--phase <number>]',
    '',
    'Project Shipyard delivery evidence into native GSD artifacts.',
    'The command is local-only and inert only when no Shipyard delivery plans exist.',
    '--adopt-native explicitly adopts existing native GSD projection files; lifecycle gates use this only after delivery applicability is proven.',
    '--phase performs a targeted projection of one phase while keeping global state coherent; run a full sync before ship.',
  ].join('\n');
}

function run(args) {
  if (args.help) return { help: help(), code: 0 };
  const snapshot = buildSnapshot({ phase: args.phase, adoptNative: args.adoptNative });
  if (!snapshot.applicable) return { result: { ok: true, applicable: false }, code: 0 };
  if (args.check) {
    const drift = checkSnapshot(snapshot);
    return { result: resultFor(snapshot, args, drift), code: snapshot.blockers.length || drift.length ? 1 : 0 };
  }
  const published = withLock(lockDirFor(ROOT), 'gsd-sync', () => {
    // Rebuild inside the lock. A planning/delivery writer may have changed the
    // source while the first read was in progress; publishing an old projection
    // is worse than waiting for the next run.
    const locked = buildSnapshot({ phase: args.phase, adoptNative: args.adoptNative });
    publishSnapshot(locked);
    return locked;
  }, { label: 'gsd-sync' });
  return { result: resultFor(published, args), code: published.blockers.length ? 1 : 0 };
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(help());
      return 0;
    }
    const output = run(args);
    if (args.json) console.log(JSON.stringify(output.result));
    else if (output.result && output.result.applicable === false) console.log('gsd-sync: not applicable — no Shipyard delivery plans');
    else if (output.result && output.result.ok) console.log(`gsd-sync: ${args.check ? 'projection is synchronized' : 'projection published'} (${output.result.counts.generated_files} generated files)`);
    else console.error(`gsd-sync: blocked — ${(output.result.blockers || []).join('; ')}`);
    return output.code;
  } catch (error) {
    const code = error instanceof CliError ? 2 : 1;
    if (args && args.json) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(`gsd-sync: ${error.message}`);
    return code;
  }
}

module.exports = {
  parseArgs,
  parseRoadmap,
  integrationStatus,
  canonicalTicket,
  sourceFingerprint,
  buildSnapshot,
  checkSnapshot,
  run,
  FILE_MARKER,
  ROADMAP_BEGIN,
  ROADMAP_END,
};

if (require.main === module) process.exitCode = main();
