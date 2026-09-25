'use strict';

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const instructions = fs.readFileSync(path.join(__dirname, '..', '..', 'CLAUDE.md'), 'utf8');

suite('active Claude instructions — ADR-014 dispatch boundary');

test('states the current independent runtime grids and their native ladders', () => {
  for (const phrase of [
    'Active routed dispatch policy (ADR-014, accepted)',
    'ADR-014 supersedes ADR-005 and ADR-012 for model and effort selection',
    'two independent native grids',
    'Codex uses Luna/Sol (`gpt-6-luna`/`gpt-6-sol`)',
    'Claude uses Sonnet/Opus/Fable (`sonnet`/`claude-opus-5-5`/`fable`)',
    'Claude launches use the runtime-native model ID, including `claude-opus-5-5`',
    'Codex grid:',
    'executor Luna/max → Sol/high only for explicit `critical`/`checkpoint`',
    'Claude grid:',
    'research Opus/medium → Opus/high only for explicit `very-complex`',
    'decomposition Opus/medium → Opus/high only for explicit `critical`/`checkpoint`',
    'executor Sonnet/max → Opus/low only for explicit `critical`/`checkpoint`',
    'pr-sentinel Sonnet/high',
    'integrator Opus/medium → Opus/high only for `contested`, explicit `critical`/`checkpoint`, or a measured window',
    'drift-check Opus/high',
    'arch-review Opus/medium → Opus/high for `critical`/`checkpoint`/`contested` → Fable/medium for a measured window',
    'ci-fix and review-fix Opus/medium → Opus/high for verified `repeat` or `repeat_exhausted`',
  ]) {
    assert.ok(instructions.includes(phrase), `CLAUDE.md must state: ${phrase}`);
  }
});

test('requires an explicit, fail-closed launch receipt boundary', () => {
  for (const phrase of [
    'resolve → validate → launch → receipt',
    'application receipt',
    'inline or session-inherited selection, and missing receipts hard-refuse',
    'A successful process exit is not evidence that the runtime applied the selection',
    'Historical ADR reasoning stays in ADR-005 and ADR-012; it is not operating guidance',
  ]) {
    assert.ok(instructions.includes(phrase), `CLAUDE.md must state: ${phrase}`);
  }
});

test('does not revive ADR-012 floors, fallbacks, or cross-runtime authority', () => {
  for (const obsolete of [
    'Active ladder amendment (ADR-012',
    'delivery_pipeline.model_ladder: adaptive',
    'The FLOOR is `opus` for every role',
    'pipeline.codex_models',
    'the integrator takes the ceiling unconditionally',
    'The unset-runtime default is `opus`',
    'reports an explicit fallback when the ceiling entry is unavailable',
  ]) {
    assert.ok(!instructions.includes(obsolete), `obsolete active policy remains: ${obsolete}`);
  }
  assert.ok(instructions.includes('Do not alias either grid through the other'));
  assert.ok(instructions.includes('do not use a compatibility palette, generic GSD tier default, or per-role override as launch authority'));
});

done();
