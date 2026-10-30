'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function assertPartInstructions(text) {
  assert.ok(text.includes('## Git-read parts and independent final'));
  assert.ok(text.includes('role_context.parts'));
  assert.ok(text.includes('evidence_markdown'));
  assert.ok(!text.includes('integration-review.v3') && !text.includes('integration-partition'));
}

test('the Claude loader and all generated Codex integrator rungs carry the part-runner reference', () => {
  const root = path.resolve(__dirname, '../..');
  const plugin = path.join(root, 'plugins/delivery-pipeline');
  const loader = require(path.join(plugin, 'scripts/claude-reference-content.cjs'));
  const canonical = fs.readFileSync(path.join(plugin, 'references/integrator.md'), 'utf8');
  assert.equal(loader.loadClaudeReferenceContent('integrator'), canonical);
  assertPartInstructions(canonical);
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
      assertPartInstructions(body);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
