'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { HINTS, LAUNCH_CODES, hintFor, formatHint, hintForError } = require('../../plugins/delivery-pipeline/scripts/refusal-hints.cjs');

const REQUIRED_CODES = [
  'REFERENCE_UNAVAILABLE', 'INVALID_INPUT', 'UNSUPPORTED_ROLE', 'SCOPE_MISMATCH',
  'INVALID_SIGNAL', 'CONFLICTING_OVERRIDE', 'NONCOMPLIANT_RECEIPT', 'MISSING_RECEIPT',
  'INVALID_HOST', 'INVALID_ARTIFACT', 'INVALID_RESULT', 'RUNTIME_UNAVAILABLE',
  'STALE_GENERATED_AGENT', 'UNSUPPORTED_SELECTION',
];

const HOST_FILES = [
  'claude-decompose-host.cjs',
  'claude-investigation-host.cjs',
  'codex-decompose-host.cjs',
  'codex-delivery-host.cjs',
];

const SCRIPTS_DIR = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const BYPASS_TOKENS = /\b(bypass|skip|directly|other runtime|switch runtime)\b|SHIPYARD_STOP_GATE/i;

test('maps at least every required refusal code to a non-empty hint and remedy', () => {
  for (const code of REQUIRED_CODES) {
    assert.ok(Object.hasOwn(HINTS, code), `HINTS is missing ${code}`);
    const entry = HINTS[code];
    assert.equal(typeof entry.hint, 'string');
    assert.ok(entry.hint.trim().length > 0, `${code} hint must be non-empty`);
    assert.equal(typeof entry.remedy, 'string');
    assert.ok(entry.remedy.trim().length > 0, `${code} remedy must be non-empty`);
  }
});

test('HINTS and its entries are frozen', () => {
  assert.ok(Object.isFrozen(HINTS));
  for (const code of Object.keys(HINTS)) assert.ok(Object.isFrozen(HINTS[code]));
});

test('hintFor returns the same non-empty default entry for undefined, empty, and unknown codes', () => {
  const mappedEntries = new Set(Object.values(HINTS));
  for (const code of [undefined, '', 'NO_SUCH_CODE', null, 42]) {
    const entry = hintFor(code);
    assert.ok(entry, `hintFor(${JSON.stringify(code)}) must never be undefined`);
    assert.ok(entry.hint.trim().length > 0);
    assert.ok(entry.remedy.trim().length > 0);
    assert.equal(mappedEntries.has(entry), false, `hintFor(${JSON.stringify(code)}) must not reuse a mapped entry`);
  }
  assert.equal(hintFor(undefined), hintFor(''));
  assert.equal(hintFor(''), hintFor('NO_SUCH_CODE'));
});

test('hintFor returns the exact mapped entry for a known code', () => {
  assert.equal(hintFor('UNSUPPORTED_ROLE'), HINTS.UNSUPPORTED_ROLE);
});

test('formatHint renders hint[<CODE>]: <hint> — remedy: <remedy>', () => {
  const entry = HINTS.UNSUPPORTED_ROLE;
  assert.equal(
    formatHint('UNSUPPORTED_ROLE'),
    `hint[UNSUPPORTED_ROLE]: ${entry.hint} — remedy: ${entry.remedy}`
  );
  assert.match(formatHint('UNSUPPORTED_ROLE'), /^hint\[UNSUPPORTED_ROLE\]: .+ — remedy: .+$/);
});

test('formatHint uses UNKNOWN only when no code is present, and the real code otherwise', () => {
  assert.match(formatHint(undefined), /^hint\[UNKNOWN\]: /);
  assert.match(formatHint(''), /^hint\[UNKNOWN\]: /);
  assert.match(formatHint(null), /^hint\[UNKNOWN\]: /);
  assert.match(formatHint('NO_SUCH_CODE'), /^hint\[NO_SUCH_CODE\]: /);
});

test('no hint or remedy text ever proposes a bypass, a skip, a direct run, a runtime switch, or the stop-gate kill switch', () => {
  const entries = [...Object.values(HINTS), hintFor(undefined)];
  for (const entry of entries) {
    assert.doesNotMatch(entry.hint, BYPASS_TOKENS);
    assert.doesNotMatch(entry.remedy, BYPASS_TOKENS);
  }
});

test('all four hosts share this one map by requiring it directly', () => {
  for (const file of HOST_FILES) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    assert.ok(
      source.includes("require('./refusal-hints.cjs')"),
      `${file} must require('./refusal-hints.cjs') instead of keeping its own hint text`
    );
  }
});

test('the Codex config-fix and generated-agent-fix causes are registered and formatted', () => {
  for (const code of ['CODEX_CONFIG_FIX', 'CODEX_GENERATED_AGENT_FIX']) {
    assert.ok(Object.hasOwn(HINTS, code), `HINTS is missing ${code}`);
    assert.ok(Object.isFrozen(HINTS[code]));
    assert.equal(typeof HINTS[code].hint, 'string');
    assert.ok(HINTS[code].hint.trim().length > 0);
    assert.equal(typeof HINTS[code].remedy, 'string');
    assert.ok(HINTS[code].remedy.trim().length > 0);
    assert.match(formatHint(code), new RegExp(`^hint\\[${code}\\]: .+ — remedy: .+$`));
  }
  assert.match(HINTS.CODEX_CONFIG_FIX.remedy, /\.planning\/config\.json/);
  assert.match(HINTS.CODEX_CONFIG_FIX.remedy, /gsd-tune\.cjs --runtime codex/);
  assert.doesNotMatch(HINTS.CODEX_CONFIG_FIX.remedy, /install-shipyard-codex/);
  assert.match(HINTS.CODEX_GENERATED_AGENT_FIX.remedy, /codex plugin marketplace upgrade shipyard/);
  assert.doesNotMatch(HINTS.CODEX_GENERATED_AGENT_FIX.remedy, /gsd-tune\.cjs/);
});

test('every launch code has a frozen entry, including the warning-only codes', () => {
  for (const code of [...LAUNCH_CODES, 'CAPABILITY_SNAPSHOT_AGED', 'LEGACY_HISTORY_MISSING']) {
    assert.ok(LAUNCH_CODES.includes(code), `LAUNCH_CODES missing ${code}`);
    assert.ok(Object.hasOwn(HINTS, code), `HINTS missing ${code}`);
    assert.ok(Object.isFrozen(HINTS[code]));
    assert.ok(HINTS[code].hint.trim() && HINTS[code].remedy.trim());
  }
});

test('formatHint substitutes supplied tokens, defaults {bundle}, and never leaves a raw token', () => {
  assert.match(formatHint('ENV_CONFLICT', { explicit: 'A', bundle_value: 'B' }), /names A but the installed bundle is B/);
  const bundle = path.resolve(SCRIPTS_DIR, '..');
  assert.ok(formatHint('CODEX_CONFIG_FIX').includes(`node ${bundle}/scripts/gsd-tune.cjs`));
  assert.ok(!formatHint('CODEX_CONFIG_FIX').includes('{key}'));
  assert.ok(formatHint('CODEX_CONFIG_FIX').includes('Fix the refused key in'));
  assert.ok(formatHint('CODEX_CONFIG_FIX', { bundle: '/x', key: 'k' }).includes('Fix k in .planning/config.json, then run: node /x/scripts/gsd-tune.cjs'));
});

test('no remedy in the whole map is checkout-relative or a bypass', () => {
  for (const entry of [...Object.values(HINTS), hintFor(undefined)]) {
    const r = entry.remedy;
    assert.doesNotMatch(r, /make |plugins\/delivery-pipeline\/|install-shipyard-|ensure-gsd-core/);
    assert.doesNotMatch(r, /(?<!\{bundle\}\/)scripts[/]/);
    assert.doesNotMatch(r, BYPASS_TOKENS);
  }
});

test('remedies touching history or authority never suggest deleting or moving it', () => {
  for (const entry of Object.values(HINTS)) {
    if (/provenance|history|sidecar|catalogue|authority/i.test(entry.remedy)) {
      assert.doesNotMatch(entry.remedy, /\b(delete|remove|archive|move|rename|purge|clean)/i);
    }
  }
});

test('a CONFLICTING_OVERRIDE refusal from the Codex remap renders every placeholder', () => {
  const remap = require('../../plugins/delivery-pipeline/scripts/codex-model-remap.cjs');
  const rendered = remap.repairFor('CONFLICTING_OVERRIDE', { key: 'model_policy.runtime_tiers.codex.sol' });
  assert.doesNotMatch(rendered, /[{}]/);
  assert.ok(rendered.includes('Fix model_policy.runtime_tiers.codex.sol in .planning/config.json'));
  assert.ok(rendered.includes(`node ${path.resolve(SCRIPTS_DIR, '..')}/scripts/gsd-tune.cjs --runtime codex --apply`));
  assert.throws(
    () => remap.loadCodexRemap({ config: { model_profile_overrides: { codex: { sol: 'not-a-model' } } } }),
    (error) => error.code === 'CONFLICTING_OVERRIDE' && !/[{}]/.test(error.message) && /Fix model_profile_overrides\.codex\.sol in/.test(error.message),
  );
});

test('a path substituted into a command remedy is shell-quoted only when it is not plainly safe', () => {
  const { execFileSync } = require('node:child_process');
  const safe = formatHint('RUNTIME_UNAVAILABLE', { bundle: '/opt/shipyard/bundle', host: 'codex-delivery-host.cjs' });
  assert.ok(safe.includes('node /opt/shipyard/bundle/scripts/codex-delivery-host.cjs --preflight'), safe);
  assert.doesNotMatch(safe, /'/);
  const spaced = formatHint('RUNTIME_UNAVAILABLE', { bundle: '/tmp/my bundle', host: 'h.cjs' });
  assert.ok(spaced.includes("node '/tmp/my bundle'/scripts/h.cjs --preflight"), spaced);
  const hostile = '/tmp/a;touch /tmp/pwned-$(id)`x`\'y';
  const remedy = require('../../plugins/delivery-pipeline/scripts/refusal-hints.cjs').renderRemedy('CODEX_CONFIG_FIX', { bundle: hostile, key: 'k' });
  const command = remedy.slice(remedy.indexOf('node '), remedy.indexOf(' --runtime'));
  const argv = JSON.parse(execFileSync('sh', ['-c', `set -- ${command.slice('node '.length)}; node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"`], { encoding: 'utf8' }));
  assert.deepEqual(argv, [`${hostile}/scripts/gsd-tune.cjs`]);
  assert.ok(formatHint('CODEX_CONFIG_FIX', { bundle: '/x y;z', key: 'a b' }).includes("Fix a b in .planning/config.json, then run: node '/x y;z'/scripts/gsd-tune.cjs"));
});

test('prose placeholders are not shell-quoted', () => {
  assert.ok(formatHint('LEGACY_HISTORY_UNSAFE', { path: '.planning/graph/a b;c.json' }).includes('history at .planning/graph/a b;c.json cannot'));
  assert.ok(formatHint('ENV_CONFLICT', { explicit: 'CODEX_HOME=/a b', bundle_value: '/c d' }).includes('names CODEX_HOME=/a b but the installed bundle is /c d'));
});

test('capability, runtime-ambiguity and repository-identity remedies name the real cause and fix', () => {
  const missing = formatHint('RUNTIME_CAPABILITY_MISSING', { bundle: '/b', host: 'codex-delivery-host.cjs' });
  assert.doesNotMatch(missing, /--preflight/);
  assert.match(missing, /SHIPYARD_CODEX_CAPABILITIES_FILE/);
  assert.match(missing, /Launch and upgrade/);
  assert.match(missing, /codex plugin marketplace upgrade shipyard/);
  const ambiguous = formatHint('AMBIGUOUS_RUNTIME');
  assert.doesNotMatch(ambiguous, /Pass the runtime explicitly/);
  assert.match(ambiguous, /matching runtime's session/);
  assert.match(ambiguous, /unset the conflicting runtime marker named in the finding detail/);
  const identity = formatHint('REPOSITORY_IDENTITY_INVALID');
  assert.doesNotMatch(identity, /origin remote|unknown/);
  assert.match(identity, /common directory/);
  assert.match(identity, /";" or control character/);
});

test('hintForError carries the pid, the path and the supplied host and never prose placeholders', () => {
  const busy = hintForError(Object.assign(new Error('held'), { code: 'ARCHIVE_AUTHORITY_BUSY', details: { pid: 4242 } }));
  assert.match(busy, /\(owner pid 4242\)/);
  const viaVars = hintForError(Object.assign(new Error('x'), { code: 'LEGACY_HISTORY_CHANGED', vars: { path: '.planning/a b.json' } }));
  assert.match(viaVars, /history at \.planning\/a b\.json changed/);
  const fromMessage = hintForError(Object.assign(new Error('legacy provenance history is not safe before trusted mutation '
    + '.planning/graph/provenance/m n.json: member is a symlink'), { code: 'LEGACY_HISTORY_UNSAFE' }));
  assert.match(fromMessage, /history at \.planning\/graph\/provenance\/m n\.json cannot/);
  assert.equal(hintForError(Object.assign(new Error('x'), { code: 'LEGACY_HISTORY_UNSAFE', details: { path: 'p' } }))
    .includes('history at p cannot'), true);
  const hosted = hintForError({ code: 'RUNTIME_UNAVAILABLE' }, 'codex-delivery-host.cjs');
  assert.ok(hosted.includes('/scripts/codex-delivery-host.cjs --preflight'), hosted);
  assert.equal(hintForError({ code: 'RUNTIME_UNAVAILABLE' }, '/x/y/claude-role-host.cjs').includes('/scripts/claude-role-host.cjs --preflight'), true);
  assert.equal(hintForError(null), formatHint(undefined));
});

test('hintForError names a script only when it implements --preflight', () => {
  const hosts = ['codex-delivery-host', 'codex-decompose-host', 'codex-planning-context-host', 'claude-delivery-host',
    'claude-role-host', 'claude-decompose-host', 'claude-investigation-host'];
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hint-for-error-scripts-'));
  const probe = (name) => require('node:child_process').spawnSync(process.execPath, [name], { encoding: 'utf8', cwd: dir });
  try {
    const render = (file, host) => {
      const script = path.join(dir, file);
      fs.writeFileSync(script, `const { hintForError } = require(${JSON.stringify(path.join(SCRIPTS_DIR, 'refusal-hints.cjs'))});\n`
        + `process.stdout.write(hintForError({ code: 'INVALID_STORE' }${host === undefined ? '' : `, ${JSON.stringify(host)}`}));\n`);
      return probe(script).stdout;
    };
    for (const host of hosts) {
      const text = render(`${host}.cjs`);
      assert.ok(text.includes(`/scripts/${host}.cjs --preflight`), text);
    }
    for (const file of ['deliver-dispatch.cjs', 'gsd-tune.cjs', 'unrelated.cjs']) {
      const text = render(file);
      assert.equal(text.includes(`${file} --preflight`), false, text);
      assert.equal(text.includes('the host script'), false, text);
      assert.match(text, /claude-delivery-host\.cjs or codex-delivery-host\.cjs/);
    }
    assert.ok(render('deliver-dispatch.cjs', 'codex-delivery-host.cjs').includes('/scripts/codex-delivery-host.cjs --preflight'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('formatHint and renderRemedy with no host never print a placeholder script or a command naming one', () => {
  const { renderRemedy } = require('../../plugins/delivery-pipeline/scripts/refusal-hints.cjs');
  let preflightCodes = 0;
  for (const code of Object.keys(HINTS)) {
    for (const rendered of [formatHint(code), formatHint(code, {}), formatHint(code, { bundle: '/b' }), renderRemedy(code)]) {
      assert.doesNotMatch(rendered, /the host script/, code);
      for (const found of rendered.matchAll(/\bnode (\S+)/g)) assert.match(found[1], /\.cjs$/, `${code}: ${rendered}`);
    }
    if (HINTS[code].remedy.includes('{host}')) {
      preflightCodes += 1;
      assert.match(formatHint(code), /the host you launched with --preflight/, code);
      assert.ok(formatHint(code, { host: 'h.cjs', bundle: '/b' }).includes('node /b/scripts/h.cjs --preflight'), code);
    }
  }
  assert.ok(preflightCodes >= 5);
});

test('hintForError honours a refined remedy entry and keeps the error code as the label', () => {
  for (const refined of ['CLAUDE_GSD_AGENT_UNAVAILABLE', 'CLAUDE_SELECTION_UNSUPPORTED']) {
    assert.ok(Object.isFrozen(HINTS[refined]));
    const text = hintForError({ code: 'RUNTIME_CAPABILITY_MISSING', details: { hint_code: refined } });
    assert.match(text, /^hint\[RUNTIME_CAPABILITY_MISSING\]: .+ — remedy: .+$/);
    assert.ok(text.includes(HINTS[refined].remedy.replace(/\$\{.*\}/, '')) || text.includes('Claude Code'), text);
    assert.doesNotMatch(text, /SHIPYARD_CODEX_CAPABILITIES_FILE|codex plugin|the host script/);
  }
  assert.equal(hintForError({ code: 'RUNTIME_CAPABILITY_MISSING', details: { hint_code: 'NO_SUCH' } }),
    hintForError({ code: 'RUNTIME_CAPABILITY_MISSING' }));
  assert.equal(hintForError({ code: 'RUNTIME_CAPABILITY_MISSING', details: { hint_code: '__proto__' } }),
    hintForError({ code: 'RUNTIME_CAPABILITY_MISSING' }));
});
