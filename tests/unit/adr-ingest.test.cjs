'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const { normalizeAdr, validateAdr } = require(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'adr-ingest.cjs'));

const NESTED = `# ADR-999 — nested decisions

## Status

Accepted

## Context

The parser must preserve the architecture contract.

## Decision

### 1. Keep the source format readable

The source ADR may use a heading per decision.

### 2. Refuse empty decisions

An accepted ADR without decisions must stop ingestion.

## Consequences

### Positive

The planner receives both decisions.

### Negative

The ingest step writes a derived copy.

## Scope fences

### This ADR covers

The Shipyard ingest path.

## Supersession

None.

## Rollout and rollback

Deploy the change in one controlled step.
`;

const FLAT = `# ADR-998 — flat decisions

## Status

Accepted

## Decision

- **D1 — Keep the list:** the parser already reads this shape.
`;

suite('ADR ingest compatibility');

test('flattens nested decisions and preserves consequence and scope content', () => {
  const result = normalizeAdr(NESTED);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.decisions, 2);
  assert.ok(result.content.includes('- **1. Keep the source format readable**: The source ADR may use a heading per decision.'));
  assert.ok(result.content.includes('- **Positive**: The planner receives both decisions.'));
  assert.ok(result.content.includes('- **Negative**: The ingest step writes a derived copy.'));
  assert.ok(result.content.includes('## Out of scope'));
  assert.ok(result.content.includes('- **This ADR covers**: The Shipyard ingest path.'));
  assert.ok(result.content.includes('## Plan'));
  assert.ok(!result.content.includes('\n### 1.'));
});

test('keeps an already parser-compatible ADR stable', () => {
  const result = normalizeAdr(FLAT);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.decisions, 1);
  assert.strictEqual(result.content, FLAT);
});

test('refuses an ADR with no decision entries', () => {
  const result = normalizeAdr('# ADR-997\n\n## Status\n\nAccepted\n');
  assert.throws(() => validateAdr(result, 'ADR-997.md'), /no decisions/);
});

test('writes normalized copies for the decompose command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-adr-ingest-'));
  const input = path.join(dir, 'ADR-999.md');
  const outputDir = path.join(dir, 'normalized');
  fs.writeFileSync(input, NESTED);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'stale.ingest.md'), 'stale');
  const run = spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'adr-ingest.cjs'),
    '--input', input,
    '--output-dir', outputDir,
    '--json',
  ], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.strictEqual(result[0].decisions, 2);
  assert.ok(fs.existsSync(path.join(outputDir, 'ADR-999.ingest.md')));
  assert.ok(!fs.existsSync(path.join(outputDir, 'stale.ingest.md')));
});

done();
