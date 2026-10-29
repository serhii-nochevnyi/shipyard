'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function assertNestedInstructions(text) {
  assert.ok(text.includes('coverage.seam_dispositions'));
  assert.ok(text.includes('coverage.limitations'));
  const template = text.slice(text.indexOf('The following shape is scoped to the v3 phase final')).match(/```json\n(\{[\s\S]*?\})\n```/);
  assert.ok(template, 'explicit v3 template');
  const result = JSON.parse(template[1]);
  assert.equal(result.review_contract, 'shipyard.integration-review.v3');
  for (const key of ['schema', 'plan_sha256', 'coverage_sha256', 'unit_artifacts',
    'primary_segment_ids', 'primary_obligation_ids', 'seam_dispositions', 'limitations'])
    assert.ok(Object.hasOwn(result.coverage, key), key);
  assert.equal(Object.hasOwn(result, 'seam_dispositions'), false);
  assert.equal(Object.hasOwn(result, 'limitations'), false);
}

test('the Claude loader and all generated Codex integrator rungs carry the nested v3 contract', () => {
  const root = path.resolve(__dirname, '../..');
  const plugin = path.join(root, 'plugins/delivery-pipeline');
  const loader = require(path.join(plugin, 'scripts/claude-reference-content.cjs'));
  const canonical = fs.readFileSync(path.join(plugin, 'references/integrator.md'), 'utf8');
  assert.equal(loader.loadClaudeReferenceContent('integrator'), canonical);
  assertNestedInstructions(canonical);
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't38-instructions-'));
  try {
    const codexHome = path.join(dir, 'codex');
    const converter = path.join(codexHome, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs');
    fs.mkdirSync(path.dirname(converter), { recursive: true });
    fs.writeFileSync(converter, 'module.exports = { convertClaudeCommandToCodexSkill: x => x, convertClaudeToCodexMarkdown: x => x };\n');
    const policy = require(path.join(plugin, 'scripts/model-policy.cjs'));
    const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat().map(rung => ({
      model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort }));
    const capabilities = path.join(dir, 'capabilities.json');
    fs.writeFileSync(capabilities, JSON.stringify({ supportedModels: [...new Set(selections.map(s => s.model))],
      supportedEfforts: [...new Set(selections.map(s => s.effort))], supportedSelections: selections }));
    const out = path.join(dir, 'out'), project = path.join(dir, 'project');
    fs.mkdirSync(project);
    const generated = spawnSync(process.execPath, [path.join(root, 'scripts/gen-codex-shipyard.cjs'),
      '--plugin', plugin, '--out', out, '--codex-home', codexHome, '--phase', '2',
      '--project-dir', project, '--capabilities', capabilities], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: dir, GSD_HOME: dir, CODEX_HOME: codexHome, SHIPYARD_GSD_AUTO_INSTALL: '0' },
    });
    assert.equal(generated.status, 0, generated.stderr);
    const files = fs.readdirSync(path.join(out, 'agents')).filter(name => name.includes('integrator'));
    const variants = require(path.join(root, 'scripts/gen-codex-shipyard.cjs')).codexStaticVariants(2);
    assert.deepEqual(files.sort(), variants.filter(v => v.reference === 'integrator').map(v => v.file).sort());
    assert.ok(files.length > 0);
    for (const file of files) {
      const text = fs.readFileSync(path.join(out, 'agents', file), 'utf8');
      const body = text.slice(text.indexOf('developer_instructions = ')).replace(/\\"/g, '"');
      assertNestedInstructions(body);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
