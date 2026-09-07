'use strict';

// merge-codex-config.cjs writes the user's $CODEX_HOME/config.toml — the file
// Codex refuses to start without. Header detection used to be a regex over raw
// lines (`/^\s*\[agents\]\s*$/`), so `[agents] # my limits` was invisible and a
// SECOND `[agents]` table got appended: the merge exited 0 having made the
// config unparseable (audit F21 / ADR-004 D6).
//
// Every fixture below is a line shape that regex read wrong — a trailing
// comment, inner whitespace, a quoted key, an implicit parent, a `[`-leading
// line inside a multi-line string or a multi-line array — plus the mutation
// guards that keep a bad merge from ever replacing a good file: the duplicate
// check and the tomllib re-parse run BEFORE the rename, so a refusal leaves the
// original byte-identical.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const MERGE = path.join(__dirname, '..', '..', 'scripts', 'merge-codex-config.cjs');

// Shaped exactly like gen-codex-shipyard.cjs's config.fragment.toml.
const FRAGMENT = [
  '# shipyard-agents:begin — delivery-pipeline agents, managed by install-shipyard-codex.sh',
  '',
  '[agents.shipyard-drift-check]',
  'description = "drift judge"',
  'config_file = "/home/dev/.codex/agents/shipyard-drift-check.toml"',
  '',
  '# shipyard-agents:end',
  '',
].join('\n');

function scratch(existing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codexcfg-'));
  const config = path.join(dir, 'config.toml');
  const fragment = path.join(dir, 'config.fragment.toml');
  fs.writeFileSync(fragment, FRAGMENT);
  if (existing !== null && existing !== undefined) fs.writeFileSync(config, existing);
  return { dir, config, fragment };
}

function merge(s, opts = {}) {
  return spawnSync(process.execPath, [MERGE, '--config', s.config, '--fragment', s.fragment], {
    encoding: 'utf8', ...opts,
  });
}

const read = (p) => fs.readFileSync(p, 'utf8');

// Lines that DECLARE the `[agents]` table itself, in any spelling the grammar
// allows. Counting them is the F21 assertion: two means the file is dead.
const bareAgents = (s) => s.split('\n')
  .filter((l) => /^\s*\[\s*(agents|"agents"|'agents')\s*\]\s*(#.*)?$/.test(l));

const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));

function hasTomllib() {
  const r = spawnSync('python3', ['-c', 'import tomllib'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

// A PATH with nothing on it. `python3` cannot be found, so the re-parse must say
// it skipped instead of silently claiming it verified anything.
function emptyPathEnv() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-nopath-'));
  return { ...process.env, PATH: bin };
}

suite('merge-codex-config — an [agents] header is TOML grammar, not a regex');

test('F21: `[agents] # my limits` gets no second [agents] table', () => {
  const s = scratch('[agents] # my limits\nmax_depth = 1\n');
  const r = merge(s);
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const out = read(s.config);
  assert.deepStrictEqual(bareAgents(out), ['[agents] # my limits'],
    `expected exactly one [agents] declaration, got:\n${out}`);
});

test('a spaced header `[ agents ]` is the same table', () => {
  const s = scratch('[ agents ]\nmax_depth = 1\n');
  assert.strictEqual(merge(s).status, 0);
  assert.strictEqual(bareAgents(read(s.config)).length, 1);
});

test('a quoted header `["agents"]` is the same table', () => {
  const s = scratch('["agents"]\nmax_depth = 1\n');
  assert.strictEqual(merge(s).status, 0);
  assert.strictEqual(bareAgents(read(s.config)).length, 1);
});

test('a sub-table means the parent may be implicit — no bare [agents] is appended', () => {
  const s = scratch('[agents.gsd-planner]\ndescription = "planner"\n');
  assert.strictEqual(merge(s).status, 0);
  const out = read(s.config);
  assert.strictEqual(bareAgents(out).length, 0, `no [agents] should be appended:\n${out}`);
  assert.ok(out.includes('[agents.gsd-planner]'), 'gsd-core table must survive verbatim');
});

test('with no [agents…] header at all the parent IS created', () => {
  const s = scratch('[mcp_servers.canary]\ncommand = "true"\n');
  assert.strictEqual(merge(s).status, 0);
  const out = read(s.config);
  assert.strictEqual(bareAgents(out).length, 1);
  assert.ok(out.includes('max_depth = 1'));
  assert.ok(out.includes('[mcp_servers.canary]'), 'the user\'s own table must survive');
});

test('a `[`-leading line inside a multi-line ARRAY is not a header', () => {
  const s = scratch('x = [\n  ["agents"]\n]\n');
  assert.strictEqual(merge(s).status, 0);
  const out = read(s.config);
  assert.ok(/^\[agents\]$/m.test(out), `the parent must still be appended:\n${out}`);
  assert.ok(out.includes('x = [\n  ["agents"]\n]'), 'the array must survive verbatim');
});

suite('merge-codex-config — markers are only markers outside a string');

test('a GSD marker inside a multi-line string is not the GSD marker', () => {
  const existing = [
    '[profiles.x]',
    'instructions = """',
    '# GSD Agent Configuration',
    '[agents]',
    '"""',
    '',
  ].join('\n');
  const s = scratch(existing);
  assert.strictEqual(merge(s).status, 0);
  const out = read(s.config);
  assert.ok(out.includes('instructions = """\n# GSD Agent Configuration\n[agents]\n"""'),
    `the string body must be untouched:\n${out}`);
  assert.ok(out.indexOf('shipyard-agents:begin') > out.indexOf('"""\n', out.indexOf('[agents]')),
    'the fragment must land after the string, not inside it');
});

test('blank lines inside a multi-line string are not collapsed', () => {
  const s = scratch('[profiles.x]\ninstructions = """\na\n\n\nb\n"""\n');
  assert.strictEqual(merge(s).status, 0);
  const out = read(s.config);
  assert.ok(out.includes('a\n\n\nb'), `the string body must keep its blank lines:\n${out}`);
});

test('an unterminated fence drops only the marker line', () => {
  const s = scratch('# shipyard-agents:begin\n\n[mcp_servers.canary]\ncommand = "true"\n');
  assert.strictEqual(merge(s).status, 0);
  const out = read(s.config);
  assert.ok(out.includes('[mcp_servers.canary]'), `the canary must survive:\n${out}`);
});

test('the fragment lands above a real gsd-core marker', () => {
  const s = scratch('[agents]\nmax_depth = 1\n\n# GSD Agent Configuration\n[agents.gsd-planner]\ndescription = "p"\n');
  const r = merge(s);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = read(s.config);
  assert.ok(out.indexOf('shipyard-agents:end') < out.indexOf('# GSD Agent Configuration'),
    `fragment must precede the marker:\n${out}`);
  assert.strictEqual(bareAgents(out).length, 1);
});

suite('merge-codex-config — idempotence and empty inputs');

test('running the merge twice is byte-identical', () => {
  const s = scratch('[agents] # my limits\nmax_depth = 1\n\n[mcp_servers.canary]\ncommand = "true"\n');
  assert.strictEqual(merge(s).status, 0);
  const once = read(s.config);
  assert.strictEqual(merge(s).status, 0);
  assert.strictEqual(read(s.config), once, 'the second merge changed the file');
  assert.strictEqual(bareAgents(once).length, 1);
});

test('an empty config file is merged into', () => {
  const s = scratch('');
  assert.strictEqual(merge(s).status, 0);
  const out = read(s.config);
  assert.strictEqual(bareAgents(out).length, 1);
  assert.ok(out.includes('[agents.shipyard-drift-check]'));
});

test('an absent config file is created', () => {
  const s = scratch(null);
  assert.strictEqual(fs.existsSync(s.config), false);
  const r = merge(s);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(read(s.config).includes('[agents.shipyard-drift-check]'));
});

suite('merge-codex-config — positive evidence before the rename');

test('a config already carrying two [agents] tables is REFUSED, original intact', () => {
  const existing = '[agents]\nmax_depth = 1\n\n[agents] # my limits\n';
  const s = scratch(existing);
  const r = merge(s);
  assert.notStrictEqual(r.status, 0, `the merge must refuse, got exit 0:\n${read(s.config)}`);
  assert.strictEqual(read(s.config), existing, 'the original file must be byte-identical');
  assert.ok(/agents/.test(r.stderr) && /duplicat/i.test(r.stderr),
    `stderr must name the duplicated table, got: ${r.stderr}`);
  assert.deepStrictEqual(tmpLeftovers(s.dir), [], 'no temp file may be left behind');
});

test('a successful merge leaves no temp file behind', () => {
  const s = scratch('[agents]\nmax_depth = 1\n');
  assert.strictEqual(merge(s).status, 0);
  assert.deepStrictEqual(tmpLeftovers(s.dir), []);
});

test('the tomllib re-parse refuses a config it cannot parse', () => {
  const existing = '[agents]\nmax_depth = 1\n\nbroken = = 1\n';
  const s = scratch(existing);
  const r = merge(s);
  if (!hasTomllib()) {
    // No deep checker on this host: the merge must SAY so rather than imply it
    // verified anything. The refusal itself is covered by the duplicate case.
    assert.ok(/re-parse: skipped/.test(r.stdout), `expected a skip note, got: ${r.stdout}`);
    return;
  }
  assert.notStrictEqual(r.status, 0, `expected a refusal, got exit 0:\n${read(s.config)}`);
  assert.strictEqual(read(s.config), existing, 'the original file must be byte-identical');
  assert.deepStrictEqual(tmpLeftovers(s.dir), []);
});

test('the re-parse says "verified" when python3 tomllib is present', () => {
  if (!hasTomllib()) return;
  const s = scratch('[agents]\nmax_depth = 1\n');
  const r = merge(s);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/re-parse: verified/.test(r.stdout), `expected a verified note, got: ${r.stdout}`);
});

test('with no python3 on PATH the re-parse is skipped, not faked', () => {
  const s = scratch('[agents]\nmax_depth = 1\n');
  const r = merge(s, { env: emptyPathEnv() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/re-parse: skipped/.test(r.stdout), `expected a skip note, got: ${r.stdout}`);
  assert.ok(read(s.config).includes('[agents.shipyard-drift-check]'), 'the merge must still happen');
});

suite('merge-codex-config — the rename must not change what the file IS');

test('an existing config keeps its permissions', () => {
  const s = scratch('[agents]\nmax_depth = 1\n');
  fs.chmodSync(s.config, 0o600);
  assert.strictEqual(merge(s).status, 0);
  assert.strictEqual(fs.statSync(s.config).mode & 0o777, 0o600,
    'a config that may hold MCP secrets must not widen to the umask');
});

test('a symlinked config stays a symlink', () => {
  const s = scratch(null);
  const real = path.join(s.dir, 'real.toml');
  fs.writeFileSync(real, '[agents]\nmax_depth = 1\n');
  fs.symlinkSync(real, s.config);
  const r = merge(s);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(s.config).isSymbolicLink(), 'the symlink was replaced by a regular file');
  assert.ok(read(real).includes('[agents.shipyard-drift-check]'), 'the merge must reach the target');
});

// A DANGLING link is the same invariant over a link `realpathSync` refuses.
// `~/.codex/config.toml` is a path dotfile managers symlink into a repo, and the
// link dangles whenever that target is not there yet — a fresh checkout, a
// volume not mounted. The old fallback returned the link's OWN path, so rename
// replaced the link with a regular file, exit 0, and the config never reached
// the target the link named.

test('a dangling symlink is written THROUGH, not replaced', () => {
  const s = scratch(null);
  fs.mkdirSync(path.join(s.dir, 'dotfiles'));
  const real = path.join(s.dir, 'dotfiles', 'config.toml');
  // Relative, the way `stow` writes one: the target resolves against the LINK's
  // directory, not the process cwd.
  fs.symlinkSync(path.join('dotfiles', 'config.toml'), s.config);
  assert.strictEqual(fs.existsSync(real), false, 'the fixture must start dangling');
  const r = merge(s);
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(fs.lstatSync(s.config).isSymbolicLink(),
    'the dangling symlink was replaced by a regular file');
  assert.ok(read(real).includes('[agents.shipyard-drift-check]'),
    'the merge must land on the file the link names');
  assert.deepStrictEqual(tmpLeftovers(s.dir), []);
});

test('a chain of symlinks is followed to its end', () => {
  const s = scratch(null);
  fs.mkdirSync(path.join(s.dir, 'dotfiles'));
  const real = path.join(s.dir, 'dotfiles', 'config.toml');
  const middle = path.join(s.dir, 'middle.toml');
  fs.symlinkSync(real, middle);
  fs.symlinkSync(middle, s.config);
  const r = merge(s);
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(fs.lstatSync(s.config).isSymbolicLink(), 'the first link must survive');
  assert.ok(fs.lstatSync(middle).isSymbolicLink(), 'the second link must survive');
  assert.ok(read(real).includes('[agents.shipyard-drift-check]'), 'the merge must reach the end of the chain');
});

test('a symlink whose target directory is missing is REFUSED', () => {
  const s = scratch(null);
  const real = path.join(s.dir, 'missing', 'config.toml');
  fs.symlinkSync(real, s.config);
  const r = merge(s);
  assert.notStrictEqual(r.status, 0, `the merge must refuse, got exit 0: ${r.stdout}`);
  assert.ok(/symlink/.test(r.stderr), `stderr must name the symlink, got: ${r.stderr}`);
  assert.ok(fs.lstatSync(s.config).isSymbolicLink(), 'the symlink must be untouched');
  assert.strictEqual(fs.existsSync(real), false, 'nothing may be created under a missing directory');
  assert.deepStrictEqual(tmpLeftovers(s.dir), [], 'no temp file may be left behind');
});

test('a symlink loop is refused, not walked forever', () => {
  const s = scratch(null);
  const other = path.join(s.dir, 'loop.toml');
  fs.symlinkSync(other, s.config);
  fs.symlinkSync(s.config, other);
  const r = merge(s, { timeout: 20000 });
  assert.strictEqual(r.signal, null, 'the merge hung on the loop instead of refusing');
  assert.notStrictEqual(r.status, 0, `the merge must refuse, got exit 0: ${r.stdout}`);
  assert.ok(/symlink/.test(r.stderr), `stderr must name the symlink, got: ${r.stderr}`);
  assert.ok(fs.lstatSync(s.config).isSymbolicLink(), 'the symlink must be untouched');
});

suite('merge-codex-config — an unhealthy checker is not evidence');

// A `python3` that exists but cannot answer. On a fresh macOS `/usr/bin/python3`
// is a stub that exits 1 with an xcode-select note, and on one with the command
// line tools it is 3.9 — no `tomllib`. Neither is evidence of anything about the
// file, so neither may fail an install.
function stubPython(body) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stubpy-'));
  const exe = path.join(bin, 'python3');
  fs.writeFileSync(exe, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(exe, 0o755);
  return { ...process.env, PATH: bin };
}

test('a python3 that exits 1 without parsing anything is skipped, not a refusal', () => {
  const s = scratch('[agents]\nmax_depth = 1\n');
  const env = stubPython('echo "xcode-select: note: no developer tools were found" >&2\nexit 1');
  const r = merge(s, { env });
  assert.strictEqual(r.status, 0, `an unhealthy checker must not fail the install: ${r.stderr}`);
  assert.ok(/re-parse: skipped/.test(r.stdout), `expected a skip note, got: ${r.stdout}`);
  assert.ok(read(s.config).includes('[agents.shipyard-drift-check]'), 'the merge must still happen');
});

test('a python3 without tomllib is skipped, not a refusal', () => {
  const s = scratch('[agents]\nmax_depth = 1\n');
  // Exit 2 is the sentinel the merge\'s own -c script uses for "no tomllib".
  const r = merge(s, { env: stubPython('exit 2') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/re-parse: skipped/.test(r.stdout), `expected a skip note, got: ${r.stdout}`);
});

suite('merge-codex-config — the duplicate guard must not fire on valid TOML');

test('an array-of-tables repeat is not a duplicate table', () => {
  // Valid TOML: each [[fruits]] element carries its own [fruits.physical], so the
  // same plain header appears twice on purpose. A duplicate check that flagged it
  // would abort the installer on a correct config — the false-positive class that
  // gets a gate switched off.
  const s = scratch([
    '[[fruits]]', 'name = "apple"', '', '[fruits.physical]', 'color = "red"', '',
    '[[fruits]]', 'name = "banana"', '', '[fruits.physical]', 'color = "yellow"', '',
    '[agents]', 'max_depth = 1', '',
  ].join('\n'));
  const r = merge(s);
  assert.strictEqual(r.status, 0, `a valid config was refused: ${r.stderr}`);
  const out = read(s.config);
  assert.strictEqual((out.match(/^\[\[fruits\]\]$/gm) || []).length, 2, `both elements must survive:\n${out}`);
  assert.ok(out.includes('[agents.shipyard-drift-check]'));
});

suite('merge-codex-config — re-merging every shape is byte-identical');

// Idempotence over the shapes the scanner is new logic for. The second run must
// not merely keep the table count — it must reproduce the file byte for byte,
// because the blank-line collapse and the strip both rewrite line positions.
for (const [name, existing] of [
  ['a commented header', '[agents] # my limits\nmax_depth = 1\n'],
  ['only sub-tables', '[agents.gsd-planner]\ndescription = "planner"\n'],
  ['a multi-line string holding a marker', '[profiles.x]\ninstructions = """\n# GSD Agent Configuration\n[agents]\n\n"""\n'],
  ['a multi-line array', 'x = [\n  ["agents"]\n]\n'],
  ['a real gsd-core marker', '[agents]\nmax_depth = 1\n\n# GSD Agent Configuration\n[agents.gsd-planner]\ndescription = "p"\n'],
  ['no file at all', null],
]) {
  test(`re-merging ${name} is byte-identical`, () => {
    const s = scratch(existing);
    assert.strictEqual(merge(s).status, 0);
    const once = read(s.config);
    assert.strictEqual(merge(s).status, 0);
    assert.strictEqual(read(s.config), once, 'the second merge changed the file');
    // Deliberately no `bareAgents` count here: two of these fixtures put the
    // literal text `[agents]` inside a string or an array, which the line grep
    // cannot tell from a declaration. That property is asserted by the fixtures
    // above, where the grep means what it says; this loop asserts stability.
  });
}

done();
