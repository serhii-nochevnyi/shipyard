'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const schema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'issues_found', 'blocked'] },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    findings: { type: 'array', maxItems: 128, items: {
      type: 'object', additionalProperties: false, required: ['severity', 'message'],
      properties: { severity: { type: 'string', enum: ['blocker', 'warning', 'info'] },
        message: { type: 'string', minLength: 1, maxLength: 2000 } },
    } },
  },
});
const instructions = '\nReturn your checker conclusion as a single JSON object, without Markdown or surrounding prose: '
  + '{"verdict":"pass|issues_found|blocked","summary":"short explanation","findings":[{"severity":"blocker|warning|info","message":"finding"}]}. '
  + 'Use an empty findings array when there are no findings. A launch/evidence binding failure means blocked, even if the plans look correct. '
  + 'Never infer pass from successful process completion or a verified application receipt.';

function refuse(message) {
  const error = new Error('checker-result: ' + message);
  error.code = 'CHECKER_VERDICT_UNVERIFIED';
  throw error;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parseCheckerResult(raw) {
  const bytes = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 64 * 1024) refuse('missing or oversized semantic result');
  let value;
  try { value = JSON.parse(bytes); } catch { refuse('checker must return the explicit JSON verdict'); }
  if (!object(value) || Object.keys(value).some(key => !['verdict', 'summary', 'findings'].includes(key))
      || !['pass', 'issues_found', 'blocked'].includes(value.verdict)
      || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 500
      || !Array.isArray(value.findings) || value.findings.length > 128
      || value.findings.some(finding => !object(finding)
        || Object.keys(finding).some(key => !['severity', 'message'].includes(key))
        || !['blocker', 'warning', 'info'].includes(finding.severity)
        || typeof finding.message !== 'string' || !finding.message.trim() || finding.message.length > 2000)
      || (value.verdict === 'pass' && value.findings.some(finding => finding.severity !== 'info'))
      || (value.verdict === 'issues_found' && !value.findings.length)) {
    refuse('missing, invalid or contradictory semantic verdict');
  }
  return value;
}

function sealCheckerResult({ raw, receipt, root, sourceRevision, phaseDir }) {
  const semantic = parseCheckerResult(raw);
  if (!receipt || receipt.compliance !== 'verified' || receipt.gsd_role !== 'gsd-plan-checker') {
    refuse('checker semantic result requires its independently verified application receipt');
  }
  const names = fs.readdirSync(phaseDir).filter(name => /-PLAN\.md$/.test(name)).sort();
  if (names.length > 128) refuse('too many checked plans');
  const plans = names.map(name => {
    const file = path.join(phaseDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) refuse('invalid checked plan');
    const bytes = fs.readFileSync(file);
    return { path: file, sha256: digest(bytes) };
  });
  const report = Buffer.from(JSON.stringify({ ...semantic, receipt, source_revision: sourceRevision,
    plans, original_output: raw }) + '\n');
  if (report.length > 256 * 1024) refuse('oversized archived checker result');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const sha256 = digest(report);
  const file = path.join(root, digest(receipt.dispatch_id) + '-' + sha256 + '.json');
  try { fs.writeFileSync(file, report, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !fs.readFileSync(file).equals(report)) throw error;
  }
  return Object.freeze({ schema: 'shipyard.checker-result.v1',
    status: semantic.verdict === 'pass' ? 'completed' : semantic.verdict, ...semantic,
    receipt, artifact_index: { path: file, bytes: report.length, sha256 } });
}

module.exports = Object.freeze({ schema, instructions, parseCheckerResult, sealCheckerResult });
