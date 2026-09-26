'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pr-hygiene.cjs');
const {
  applies, conventionalType, CONVENTIONAL_TYPES, DEFAULT_TITLE_FORMAT,
  compileTitleFormat, titleFormat, formatTitle, check,
  NEUTRAL_PR_BODY_GUIDE, NEUTRAL_DELIVERY_RULES_HINT,
} = require(MOD);

const trash = [];
process.on('exit', () => {
  for (const dir of trash) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

function gitEnv(gitconfig) {
  return { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim();
}

function hermeticRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-hygiene-')));
  trash.push(dir);
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const env = gitEnv(gitconfig);
  git(dir, ['init', '-q', '-b', 'main'], env);
  git(dir, ['config', 'user.email', 'x@example.com'], env);
  git(dir, ['config', 'user.name', 'x'], env);
  git(dir, ['config', 'commit.gpgsign', 'false'], env);
  return { dir, env };
}

function baseCheckInput(overrides = {}) {
  return {
    title: 'feat: add batch replace',
    body: NEUTRAL_PR_BODY_GUIDE,
    head: 'feat/add-batch-replace',
    base: 'main',
    paths: [{ status: 'M', path: 'src/foo.js' }],
    commits: ['feat: add batch replace'],
    jiraKeys: [],
    ...overrides,
  };
}

function violationsFor(field, rule, input) {
  return check(input).violations.filter((v) => v.field === field && v.rule === rule);
}

suite('applies — the Shipyard exemption (D-26)');

test('no manifest at all -> hygiene applies', () => {
  const { dir } = hermeticRepo();
  assert.strictEqual(applies({ root: dir }), true);
});

test('committed shipyard manifest -> exempt, by root and by ref', () => {
  const { dir, env } = hermeticRepo();
  fs.mkdirSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'shipyard' }));
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'shipyard manifest'], env);
  const sha = git(dir, ['rev-parse', 'HEAD'], env);
  assert.strictEqual(applies({ root: dir }), false);
  assert.strictEqual(applies({ root: dir, ref: sha }), false);
});

test('a committed manifest naming a different project -> hygiene applies', () => {
  const { dir, env } = hermeticRepo();
  fs.mkdirSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'some-other-plugin' }));
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'manifest'], env);
  assert.strictEqual(applies({ root: dir }), true);
});

test('a corrupt manifest -> fail-closed, hygiene applies', () => {
  const { dir, env } = hermeticRepo();
  fs.mkdirSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'), '{ not json');
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'corrupt'], env);
  const sha = git(dir, ['rev-parse', 'HEAD'], env);
  assert.strictEqual(applies({ root: dir, ref: sha }), true);
  assert.strictEqual(applies({ root: dir }), true);
});

test('an uncommitted worktree-only manifest does not exempt a ref naming the base', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'base'], env);
  const base = git(dir, ['rev-parse', 'HEAD'], env);
  fs.mkdirSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'shipyard' }));
  assert.strictEqual(applies({ root: dir, ref: base }), true, 'the base commit has no manifest, so hygiene applies');
  assert.strictEqual(applies({ root: dir }), false, 'without ref the worktree file is read directly');
});

suite('conventionalType — D-27 ticket type to conventional type');

test('maps every declared GSD type to its conventional counterpart', () => {
  assert.strictEqual(conventionalType('implementation'), 'feat');
  assert.strictEqual(conventionalType('tdd'), 'feat');
  assert.strictEqual(conventionalType('execute'), 'feat');
  assert.strictEqual(conventionalType('fix'), 'fix');
  assert.strictEqual(conventionalType('bugfix'), 'fix');
  assert.strictEqual(conventionalType('gap_closure'), 'fix');
  assert.strictEqual(conventionalType('docs'), 'docs');
  assert.strictEqual(conventionalType('refactor'), 'refactor');
  assert.strictEqual(conventionalType('test'), 'test');
  assert.strictEqual(conventionalType('chore'), 'chore');
  assert.strictEqual(conventionalType('config'), 'chore');
});

test('an unrecognized type falls back to feat', () => {
  assert.strictEqual(conventionalType('something-unheard-of'), 'feat');
  assert.strictEqual(conventionalType(undefined), 'feat');
});

suite('title formats — D-45 template grammar');

test('with no configuration, the default is Conventional Commits', () => {
  const format = compileTitleFormat(DEFAULT_TITLE_FORMAT);
  assert.ok(format.regex.test('feat(export): drop x'));
  assert.ok(!format.regex.test('[MYD-1] refactor: drop x'));
});

test('formatTitle with the default and no scope renders exactly, with no "!"', () => {
  const rendered = formatTitle({ type: 'feat', scope: 'x', subject: 'y' });
  assert.strictEqual(rendered, 'feat(x): y');
});

test('an optional segment without placeholders is match-only: check accepts "!", formatTitle never renders it', () => {
  const format = compileTitleFormat(DEFAULT_TITLE_FORMAT);
  assert.ok(format.regex.test('feat!: y'));
  const rendered = formatTitle({ type: 'feat', subject: 'y' }, format);
  assert.strictEqual(rendered, 'feat: y');
});

test('a per-repository map: pdffiller requires the Jira key, the frontend default makes it optional', () => {
  const map = {
    'pdffiller/pdffiller': '[{jira}] {type}: {subject}',
    default: '{type}{[({scope})]}: {[[{jira}] ]}{subject}',
  };
  const pdffiller = compileTitleFormat(map['pdffiller/pdffiller']);
  assert.ok(pdffiller.regex.test('[MYD-17864] refactor: delete x'));

  const frontend = compileTitleFormat(map.default);
  assert.ok(frontend.regex.test('feat(support-pages): [MYD-17873] bake in x'));
  assert.strictEqual(
    formatTitle({ type: 'feat', scope: 'support-pages', jira: 'MYD-17873', subject: 'bake in x' }, frontend),
    'feat(support-pages): [MYD-17873] bake in x'
  );
  assert.ok(!frontend.regex.test('fix[MYD-17872]: x'));
  assert.ok(!frontend.regex.test('T-02-09: x'));
  assert.ok(!frontend.regex.test('[MYD-17864] refactor: x (T-02-01)'));
});

test('the pdffiller format with no Jira key refuses TITLE_FORMAT_UNRENDERABLE', () => {
  const pdffiller = compileTitleFormat('[{jira}] {type}: {subject}');
  assert.throws(
    () => formatTitle({ type: 'refactor', subject: 'delete x' }, pdffiller),
    (error) => error.code === 'TITLE_FORMAT_UNRENDERABLE'
  );
});

test('an unknown placeholder refuses TITLE_FORMAT_INVALID, naming it', () => {
  assert.throws(
    () => compileTitleFormat('{bogus}: {subject}'),
    (error) => error.code === 'TITLE_FORMAT_INVALID' && /bogus/.test(error.message)
  );
});

test('a nested optional segment refuses TITLE_FORMAT_INVALID', () => {
  assert.throws(
    () => compileTitleFormat('{[({[{scope}]})]}{type}: {subject}'),
    (error) => error.code === 'TITLE_FORMAT_INVALID'
  );
});

test('a literal "]}" outside an optional segment refuses TITLE_FORMAT_INVALID', () => {
  assert.throws(
    () => compileTitleFormat('{type}]}: {subject}'),
    (error) => error.code === 'TITLE_FORMAT_INVALID'
  );
});

test('formatTitle output passes check for every configured format', () => {
  const formats = [
    DEFAULT_TITLE_FORMAT,
    '[{jira}] {type}: {subject}',
    '{type}{[({scope})]}: {[[{jira}] ]}{subject}',
  ];
  for (const pattern of formats) {
    const compiled = compileTitleFormat(pattern);
    const fields = { type: 'feat', scope: 'x', jira: 'MYD-1', subject: 'y' };
    const title = formatTitle(fields, compiled);
    const result = check(baseCheckInput({ title, titleFormat: compiled, jiraKeys: ['MYD-1'] }));
    assert.deepStrictEqual(result.violations.filter((v) => v.field === 'title'), [], `${pattern} -> "${title}"`);
  }
});

suite('titleFormat / format CLI — reading configuration and rendering titles');

function projectRoot(prTitleFormat) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-hygiene-cfg-')));
  trash.push(dir);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (prTitleFormat !== undefined) {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ delivery_pipeline: { pr_title_format: prTitleFormat } }));
  }
  return dir;
}

test('titleFormat reads delivery_pipeline.pr_title_format when both spellings are set', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-hygiene-cfg2-')));
  trash.push(dir);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({
    pipeline: { pr_title_format: 'legacy: {subject}' },
    delivery_pipeline: { pr_title_format: '{type}: {subject}' },
  }));
  const format = titleFormat({ root: dir });
  assert.ok(format.regex.test('feat: hello'));
  assert.ok(!format.regex.test('legacy: hello'));
});

test('the format CLI prints the same string as formatTitle', () => {
  const dir = projectRoot('{type}{[({scope})]}: {subject}');
  const cli = spawnSync('node', [MOD, 'format', '--project-root', dir, '--type', 'feat', '--scope', 'x', '--subject', 'y'],
    { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const format = titleFormat({ root: dir });
  assert.strictEqual(cli.stdout.trim(), formatTitle({ type: 'feat', scope: 'x', subject: 'y' }, format));
});

suite('check — internals rules (each rejects a positive example, accepts a neutral one)');

test('a clean conventional PR passes with no violations', () => {
  const result = check(baseCheckInput());
  assert.deepStrictEqual(result.violations, []);
  assert.strictEqual(result.ok, true);
});

test('ticket-id: T-NN-NN is rejected in the title and accepted without it', () => {
  assert.strictEqual(violationsFor('title', 'ticket-id', baseCheckInput({ title: 'feat(T-01-02): x' })).length, 1);
  assert.strictEqual(violationsFor('title', 'ticket-id', baseCheckInput()).length, 0);
});

test('ticket-marker: "Ticket:" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'ticket-marker', baseCheckInput({ body: 'Ticket: T-01-02' })).length, 1);
  assert.strictEqual(violationsFor('body', 'ticket-marker', baseCheckInput()).length, 0);
});

test('phase-number: "Phase N" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'phase-number', baseCheckInput({ body: 'see Phase 23 for context' })).length, 1);
  assert.strictEqual(violationsFor('body', 'phase-number', baseCheckInput()).length, 0);
});

test('adr-number: "ADR-NNN" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'adr-number', baseCheckInput({ body: 'per ADR-024' })).length, 1);
  assert.strictEqual(violationsFor('body', 'adr-number', baseCheckInput()).length, 0);
});

test('plan-file: "PLAN.md" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'plan-file', baseCheckInput({ body: 'see 40-17-PLAN.md' })).length, 1);
  assert.strictEqual(violationsFor('body', 'plan-file', baseCheckInput()).length, 0);
});

test('ticket-branch-prefix: "ticket/" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'ticket-branch-prefix', baseCheckInput({ body: 'cascades off ticket/T-01-02-x' })).length, 1);
  assert.strictEqual(violationsFor('body', 'ticket-branch-prefix', baseCheckInput()).length, 0);
});

test('epic-branch-prefix: "epic/" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'epic-branch-prefix', baseCheckInput({ body: 'stacks on epic/22-foo' })).length, 1);
  assert.strictEqual(violationsFor('body', 'epic-branch-prefix', baseCheckInput()).length, 0);
});

test('planning-path: ".planning/" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'planning-path', baseCheckInput({ body: 'see .planning/graph/x.json' })).length, 1);
  assert.strictEqual(violationsFor('body', 'planning-path', baseCheckInput()).length, 0);
});

test('shipyard-path: ".shipyard/" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'shipyard-path', baseCheckInput({ body: 'writes .shipyard/generated/x' })).length, 1);
  assert.strictEqual(violationsFor('body', 'shipyard-path', baseCheckInput()).length, 0);
});

test('gate-status-trailer: "gate_status:" is rejected in the body and accepted without it', () => {
  assert.strictEqual(violationsFor('body', 'gate-status-trailer', baseCheckInput({ body: 'gate_status: arch-review=conform' })).length, 1);
  assert.strictEqual(violationsFor('body', 'gate-status-trailer', baseCheckInput()).length, 0);
});

test('internal-tool-word: shipyard/gsd/conveyor are rejected and accepted without them', () => {
  assert.strictEqual(violationsFor('body', 'internal-tool-word', baseCheckInput({ body: 'built by the shipyard conveyor' })).length, 1);
  assert.strictEqual(violationsFor('body', 'internal-tool-word', baseCheckInput({ body: 'tuned by gsd-tune' })).length, 1);
  assert.strictEqual(violationsFor('body', 'internal-tool-word', baseCheckInput()).length, 0);
});

test('commit subjects are held to the internals rules too', () => {
  const result = check(baseCheckInput({ commits: ['feat(T-40-03): x'] }));
  assert.ok(result.violations.some((v) => v.field === 'commits[0]' && v.rule === 'ticket-id'));
});

test('head-format: a conventional head passes, a ticket/-style head fails', () => {
  assert.deepStrictEqual(violationsFor('head', 'head-format', baseCheckInput()), []);
  assert.strictEqual(violationsFor('head', 'head-format', baseCheckInput({ head: 'ticket/T-22-03-x' })).length, 1);
});

test('a head with a Jira-key slug passes: <type>/<JIRA-KEY>-<slug>', () => {
  assert.deepStrictEqual(violationsFor('head', 'head-format', baseCheckInput({ head: 'feat/MYD-17864-fix-thing' })), []);
});

test('path rule: an added .planning/ path is rejected, a deleted one is allowed', () => {
  const added = check(baseCheckInput({ paths: [{ status: 'A', path: '.planning/graph/tickets.json' }] }));
  assert.ok(added.violations.some((v) => v.field === 'paths' && v.rule === 'internal-path'));
  const deleted = check(baseCheckInput({ paths: [{ status: 'D', path: '.planning/graph/tickets.json' }] }));
  assert.deepStrictEqual(deleted.violations.filter((v) => v.field === 'paths'), []);
  const modifiedShipyard = check(baseCheckInput({ paths: [{ status: 'M', path: '.shipyard/generated/x.md' }] }));
  assert.ok(modifiedShipyard.violations.some((v) => v.field === 'paths' && v.rule === 'internal-path'));
});

suite('check — the proving-ground shape (acceptance criterion 1)');

test('T-22-03 title, Ticket: body, ticket/ head, .planning/ path produce one violation per leak', () => {
  const result = check({
    title: 'T-22-03: one resolved payload selects a target',
    body: 'Ticket: T-22-03\nJira: MYD-18127 · Phase 23 (ADR-024) · cascades off `ticket/T-22-02-…`',
    head: 'ticket/T-22-03-x',
    base: 'main',
    paths: [{ status: 'A', path: '.planning/phases/22-x/22-06-DEVIATIONS.md' }],
    commits: ['feat(T-40-03): x'],
    jiraKeys: [],
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.violations.some((v) => v.field === 'title' && v.rule === 'title-format'));
  assert.ok(result.violations.some((v) => v.field === 'body' && v.rule === 'ticket-marker'));
  assert.ok(result.violations.some((v) => v.field === 'head' && v.rule === 'head-format'));
  assert.ok(result.violations.some((v) => v.field === 'paths' && v.rule === 'internal-path'));
  assert.ok(result.violations.some((v) => v.field.startsWith('commits[')));
});

test('acceptance criterion 2: a clean feat/add-batch-replace PR with a conventional title passes', () => {
  const result = check(baseCheckInput());
  assert.strictEqual(result.ok, true);
});

test('acceptance criterion 4: the Shipyard repository is always exempt', () => {
  const { dir, env } = hermeticRepo();
  fs.mkdirSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'shipyard' }));
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'shipyard manifest'], env);
  assert.strictEqual(applies({ root: dir }), false);
});

suite('check — the Jira key rule');

test('a Jira key allowed by the graph, at the format\'s {jira} slot, passes', () => {
  const format = compileTitleFormat('[{jira}] {type}: {subject}');
  const result = check(baseCheckInput({
    title: '[MYD-1] feat: x', titleFormat: format, jiraKeys: ['MYD-1'],
  }));
  assert.deepStrictEqual(result.violations.filter((v) => v.field === 'title' && v.rule.startsWith('jira')), []);
});

test('a Jira key not listed in jiraKeys is rejected even at the {jira} slot', () => {
  const format = compileTitleFormat('[{jira}] {type}: {subject}');
  const result = check(baseCheckInput({
    title: '[MYD-1] feat: x', titleFormat: format, jiraKeys: ['MYD-2'],
  }));
  assert.ok(result.violations.some((v) => v.field === 'title' && v.rule === 'jira-key-not-listed'));
});

test('a Jira key present but not at the format\'s {jira} slot is rejected as misplaced', () => {
  const result = check(baseCheckInput({
    title: 'feat: x (MYD-1)', jiraKeys: ['MYD-1'],
  }));
  assert.ok(result.violations.some((v) => v.field === 'title' && v.rule === 'jira-key-misplaced'));
});

test('a Jira key in the body is allowed only when listed', () => {
  const allowed = check(baseCheckInput({ body: 'Jira: MYD-1', jiraKeys: ['MYD-1'] }));
  assert.deepStrictEqual(allowed.violations.filter((v) => v.field === 'body' && v.rule.startsWith('jira')), []);
  const notAllowed = check(baseCheckInput({ body: 'Jira: MYD-1', jiraKeys: [] }));
  assert.ok(notAllowed.violations.some((v) => v.field === 'body' && v.rule === 'jira-key-not-listed'));
});

suite('check — the CLI over a hermetic git fixture');

test('reports a commit subject T-40-03 and a .planning/ path', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], env);
  fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'tickets.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'feat: init'], env);
  const base = 'main';
  git(dir, ['checkout', '-q', '-b', 'ticket/T-40-03-x'], env);
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'tickets.json'), '{"changed":true}\n');
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'feat(T-40-03): x'], env);
  const head = 'ticket/T-40-03-x';
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, NEUTRAL_PR_BODY_GUIDE);

  const cli = spawnSync('node', [MOD, 'check', '--project-root', dir, '--base', base, '--head', head,
    '--title', 'T-40-03: x', '--body-file', bodyFile, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(cli.status, 2, cli.stdout + cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.strictEqual(result.ok, false);
  assert.ok(result.violations.some((v) => v.field.startsWith('commits[') && v.rule === 'ticket-id'));
  assert.ok(result.violations.some((v) => v.field === 'paths' && v.rule === 'internal-path'));
});

test('the check CLI exits 0 and prints exempt for the Shipyard repository', () => {
  const { dir, env } = hermeticRepo();
  fs.mkdirSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'shipyard' }));
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'shipyard manifest'], env);
  const cli = spawnSync('node', [MOD, 'check', '--project-root', dir, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.deepStrictEqual(JSON.parse(cli.stdout), { exempt: true });
});

suite('NEUTRAL_PR_BODY_GUIDE / NEUTRAL_DELIVERY_RULES_HINT pass check() themselves');

test('both strings carry no internals leak when used as a PR body', () => {
  assert.deepStrictEqual(violationsFor('body', 'internal-tool-word', baseCheckInput({ body: NEUTRAL_PR_BODY_GUIDE })), []);
  const guideResult = check(baseCheckInput({ body: NEUTRAL_PR_BODY_GUIDE }));
  assert.deepStrictEqual(guideResult.violations.filter((v) => v.field === 'body'), []);
  const hintResult = check(baseCheckInput({ body: NEUTRAL_DELIVERY_RULES_HINT }));
  assert.deepStrictEqual(hintResult.violations.filter((v) => v.field === 'body'), []);
});

test('CONVENTIONAL_TYPES is the shared nine-member vocabulary', () => {
  assert.deepStrictEqual(CONVENTIONAL_TYPES, [
    'feat', 'fix', 'docs', 'refactor', 'test', 'perf', 'build', 'ci', 'chore', 'revert',
  ]);
});

done();
