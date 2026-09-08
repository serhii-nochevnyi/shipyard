#!/usr/bin/env bash
set -euo pipefail

# A contract on the documentation. Behaviour that is documented must stay
# documented: if you change MCP servers, LSP coverage, the OAuth flow, mount
# semantics or the command surface, update README.md or this fails.

[[ -f README.md ]] || { echo "missing README.md"; exit 1; }

# The repo is a plugin marketplace in its own right: `claude plugin marketplace
# add <owner>/shipyard` only works when the manifest sits at the REPO ROOT (the
# copy under plugins/delivery-pipeline/ serves the directory-source install and
# is not reachable by a remote add). Losing this file makes the documented public
# install silently impossible, so it is a contract.
[[ -f .claude-plugin/marketplace.json ]] || { echo "missing root .claude-plugin/marketplace.json — the public marketplace install would break"; exit 1; }
node - <<'NODE'
const m = require('./.claude-plugin/marketplace.json');
const entry = (m.plugins || []).find((p) => p.name === 'shipyard');
if (!entry) { console.error('root marketplace.json does not offer the "shipyard" plugin'); process.exit(1); }
const fs = require('fs');
const src = entry.source.replace(/^\.\//, '');
if (!fs.existsSync(`${src}/.claude-plugin/plugin.json`)) {
  console.error(`root marketplace.json points at "${entry.source}", which has no .claude-plugin/plugin.json`);
  process.exit(1);
}
NODE
[[ -f .env.example ]] || { echo "missing .env.example"; exit 1; }

need() { # need <pattern> <what is missing>
  grep -q "$1" README.md || { echo "README missing $2"; exit 1; }
}

need "make build-base"        "make build-base"
need "claude plugin marketplace add serhii-nochevnyi/shipyard" "the public marketplace install command"
need "make build-dev-image"   "make build-dev-image"
need "make deploy-k8s"        "make deploy-k8s"
need "make test-fast"         "the fast test entry point"
need "Claude Code"            "Claude Code"
need "gsd-core"               "gsd-core note"
need "@opengsd/gsd-core"      "gsd-core package"
need "Atlassian Rovo"         "Atlassian Rovo MCP note"
need "Context7"               "Context7 MCP note"
need "context7-mcp"           "baked context7-mcp note"
need "typescript-language-server" "typescript-language-server note"
need "andrej-karpathy-skills" "Karpathy plugin note"
need "delivery-pipeline"      "delivery-pipeline plugin note"
need "CLAUDE_CODE_OAUTH_TOKEN" "OAuth token note"
need "claude setup-token"     "setup-token note"
need "make bootstrap-atlassian-oauth" "bootstrap-atlassian-oauth flow"
need "ephemeral"              "ephemeral state note"
need "skill-creator"          "skill-creator plugin note"
need "code-simplifier"        "code-simplifier plugin note"
need "GitHub MCP server"      "github (GitHub MCP server) plugin note"
need '~/.config/gh'           "gh config mount note"
need "read-only"              "read-only note for the gh mount"
need 'host-services/ssh-auth.sock' "ssh-agent forwarding note"

# every shipyard command the plugin ships must be documented
for cmd in route investigate decompose deliver bench; do
  need "/shipyard:$cmd" "the /shipyard:$cmd command"
done
# ...and the README's list must not drift from plugin.json
node - <<'NODE'
const fs = require('fs');
const manifest = require('./plugins/delivery-pipeline/.claude-plugin/plugin.json');
const readme = fs.readFileSync('README.md', 'utf8');
const missing = (manifest.commands || [])
  .map((c) => c.replace(/^\.\/commands\//, '').replace(/\.md$/, ''))
  .filter((name) => !readme.includes(`/shipyard:${name}`));
if (missing.length) {
  console.error(`README does not mention: ${missing.map((m) => '/shipyard:' + m).join(', ')}`);
  process.exit(1);
}
if (/\*\*pipeline\*\*/.test(readme)) {
  console.error('README calls the plugin "pipeline"; its name is "shipyard"');
  process.exit(1);
}
NODE

# ── mount semantics (the security-relevant part) ─────────────────────────────
need '/home/dev/.ssh-host'    "the non-shadowing SSH mount path"
need 'SSH_DIR'                "the SSH_DIR opt-in for exposing private keys"
need 'CLAUDE_STATE_DIR'       "the CLAUDE_STATE_DIR persistence variable"
need 'repo checkout itself is deliberately not mounted' \
     "an explicit statement that the repo root is not mounted"

# The repo root must not be mounted (it holds .env with the OAuth token) and the
# credentials mount must be a directory, not a single file.
if grep -qE '^\s*-\s*\$\{PWD\}' docker-compose.yml; then
  echo "docker-compose.yml mounts \${PWD} — that exposes .env to the container"
  exit 1
fi
if grep -q '/home/dev/.claude/.credentials.json' docker-compose.yml; then
  echo "docker-compose.yml still bind-mounts the credentials FILE (rename(2) cannot replace a mount point)"
  exit 1
fi
if grep -qE ':/home/dev/\.ssh:' docker-compose.yml; then
  echo "docker-compose.yml mounts over /home/dev/.ssh — it shadows the baked config and makes it read-only"
  exit 1
fi

# ── .env.example ────────────────────────────────────────────────────────────
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env.example || { echo ".env.example missing CLAUDE_CODE_OAUTH_TOKEN"; exit 1; }
grep -q '^SSH_AUTH_SOCK_HOST=' .env.example || { echo ".env.example missing SSH_AUTH_SOCK_HOST"; exit 1; }
# CLAUDE_STATE_DIR replaced CLAUDE_CREDENTIALS_FILE; either satisfies this while
# the template catches up (the Makefile migrates the legacy file automatically).
grep -qE '^(CLAUDE_STATE_DIR|CLAUDE_CREDENTIALS_FILE)=' .env.example \
  || { echo ".env.example missing CLAUDE_STATE_DIR"; exit 1; }

if grep -q 'DEV_COPILOT' .env.example; then
  echo ".env.example should not contain DEV_COPILOT vars"
  exit 1
fi
# The image tag `claude-shipyard:test` may legitimately appear in a `docker run`
# example, so assert the removed artifacts are gone rather than the bare substring.
for pat in 'dev-copilot' 'copilot plugin' '\.copilot' 'COPILOT_'; do
  if grep -qE "$pat" README.md; then
    echo "README should not mention $pat anymore"
    exit 1
  fi
done

# ── the k8s flow the README documents must actually exist ───────────────────
for f in k8s/configmap.yaml k8s/pvc.yaml k8s/service.yaml k8s/statefulset.yaml k8s/secret.example.yaml; do
  [[ -f "$f" ]] || { echo "README documents the Kubernetes flow but $f is missing"; exit 1; }
done
grep -q "$(basename k8s/statefulset.yaml)" README.md || { echo "README should reference k8s/statefulset.yaml"; exit 1; }

# ── every Makefile target the README names must exist ───────────────────────
while read -r target; do
  grep -qE "^${target}:" Makefile || { echo "README references 'make $target' but the Makefile has no such target"; exit 1; }
done < <(grep -oE 'make [a-z][a-z0-9-]+' README.md | awk '{print $2}' | sort -u)

# ── the drift gate must be anchored to the CONFIGURED base ──────────────────
# Anchoring the staleness test to `main` by name is a gate that never opens on a
# project integrating into a long-lived branch: nothing merges into main for
# months, so every plan reads as fresh. That is how a whole phase came to run
# against a module layout reorganized underneath it. Pin both halves — the
# trigger's wording, and the fact that the judge is actually TOLD which ref.
node - <<'NODE'
const fs = require('fs');
const deliver = fs.readFileSync('plugins/delivery-pipeline/commands/deliver.md', 'utf8');
const gate = fs.readFileSync('plugins/delivery-pipeline/workflows/drift-gate.mjs', 'utf8');
const ref = fs.readFileSync('plugins/delivery-pipeline/references/drift-check.md', 'utf8');
const fail = (m) => { console.error(m); process.exit(1); };

if (/older than the last merge into main\b/.test(deliver)) {
  fail('deliver.md anchors the drift-gate staleness test to `main` by name — use the configured base (git.base_branch), or the gate never fires on a project that integrates elsewhere');
}
if (!/baseRef/.test(deliver)) {
  fail('deliver.md never passes `baseRef` to the drift gate — the judge would reason about whatever branch is checked out');
}
if (!/baseRef/.test(gate)) {
  fail('workflows/drift-gate.mjs does not accept `baseRef`, but deliver.md is told to pass it — args contract drift');
}
// The judge must be told, in its own brief, that the working tree is not the
// authority. The Workflow path builds prompts deterministically and never reads
// the reference, so BOTH surfaces have to carry it.
for (const [name, text] of [['references/drift-check.md', ref], ['workflows/drift-gate.mjs', gate]]) {
  if (!/working tree/.test(text)) {
    fail(`${name} does not warn that the working tree is not what "has landed" means — a checkout cut before the work makes every path absent, and absence there proves nothing`);
  }
  // A drift verdict that is not persisted dies with the run: the next state-sync
  // recomputes the front and re-offers the same stale plan. Two tickets judged
  // stale sat under `execute` for five days because recording them lived only in
  // prose someone had to remember. Both judge surfaces must carry the duty.
  if (!/drift-record/.test(text)) {
    fail(`${name} never tells the judge to persist a drifted verdict (drift-record) — a verdict left in the reply is re-derived, and re-ignored, on every later run`);
  }
}
if (!/drift-record\.cjs list/.test(deliver)) {
  fail('deliver.md does not verify that the judge actually recorded — self-recording without a check is the same promise that already went unkept once');
}
if (!/recordCmd/.test(deliver) || !/recordCmd/.test(gate)) {
  fail('the drift-gate `recordCmd` arg is not passed by deliver.md or not accepted by the script — args contract drift');
}

// Every actionable duty the guard can emit must be a role the ladder resolves,
// or a named mechanical step that needs no model. `finalize` was neither, and it
// reached the journal as a role `model <role>` declines to route.
const sentinel = fs.readFileSync('plugins/delivery-pipeline/scripts/sentinel.cjs', 'utf8');
const { ROLES } = require('./plugins/delivery-pipeline/scripts/pipeline-config.cjs');
const actionable = (sentinel.match(/const ACTIONABLE = new Set\(\[([^\]]*)\]/) || [])[1];
if (!actionable) fail('cannot find the sentinel ACTIONABLE set');
// Steps the guard performs ITSELF — no agent is dispatched, so no model is
// resolved: `undraft` is a bare `gh pr ready`; `merge` is `sentinel.cjs merge`,
// which re-verifies the gate against live GitHub in the script precisely so that
// no agent can be talked into it; and `base-merge` is `base-merge.cjs`, the
// remedy ci-fix.md and review-fix.md name for a moved base. That last one is
// mechanical for the same reason the other two are — the script does the merge,
// so there is no hypothesis to form and nothing for the ladder to route — and it
// journals itself as `base_merge`, which log-event.cjs accepts as its own event
// rather than as an attempt.
const MECHANICAL = new Set(['undraft', 'merge', 'base-merge']);

// The conflict remedy must not contradict the force-push ban sitting beside it.
// Rebasing a branch that already has a PR IS a force-push, and in a cascade the
// base moves once per parent that squashes into the epic — so the old "rebase
// the ticket branch" advice was one dismissed approval per landed parent, in
// service of a history `--squash` discards.
const dirty = (sentinel.match(/mergeStateStatus === 'DIRTY'[\s\S]{0,400}?\n  \}/) || [])[0] || '';
if (!dirty) fail('cannot find the DIRTY (merge-conflict) branch in sentinel.cjs');
if (/rebase the ticket branch|— rebase\b/.test(dirty)) {
  fail('sentinel tells a conflicted PR to rebase, which is a force-push — and the same file forbids force-pushing');
}
if (!/git merge origin/.test(dirty)) {
  fail('the DIRTY remedy does not name the merge that replaces the rebase — an operator left to improvise will reach for rebase');
}
for (const a of actionable.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)) {
  if (!ROLES.includes(a) && !MECHANICAL.has(a)) {
    fail(`sentinel duty can emit "${a}", which is neither a pipeline role nor a declared mechanical step — whoever serves it has no model to resolve`);
  }
}
NODE

# ── every home of the gsd-core pin must agree ────────────────────────────────
# The BUILD pin lives in five files and nothing made them agree: one ticket
# moved three of them and left `docker-compose.yml` and `.env.example` behind,
# so `cp .env.example .env && docker compose build` installed the release
# ADR-003 D1 moved off — a functional regression, not a doc nit. Compare the
# homes against EACH OTHER rather than against a literal: a spot-check would
# need editing on every bump and would rot exactly the same way.
#
# No `head -1` anywhere in the extraction. The first cut of this check took the
# FIRST match per file, so a duplicate `ARG GSD_CORE_VERSION=` in `Dockerfile`
# (or a trailing duplicate in `.env.example`) left the guard green while the
# EFFECTIVE value was the LATER one — the guard read a value the build does not
# use. More than one declaration in one file is now the error, and it names all
# of them.
pin_files=()
pin_values=()
add_pin() { # add_pin <file> <every extracted value, newline-separated>
  local file="$1" raw="${2:-}" line value="" all="" count=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    count=$((count + 1))
    value="$line"
    all="$all
    $file = $line"
  done <<< "$raw"
  if [[ "$count" == 0 ]]; then
    echo "docs smoke: cannot read GSD_CORE_VERSION out of $file — the pin-agreement check would be comparing nothing (two empty extractions are equal)"
    exit 1
  fi
  if [[ "$count" -gt 1 ]]; then
    echo "docs smoke: $file declares GSD_CORE_VERSION $count times — which one is effective depends on this file's own resolution rules (not every syntax lets the later line win: a Makefile '?=' keeps the FIRST, a Dockerfile ARG default follows the LAST), so a guard reading any single line cannot know which value the build actually uses:$all"
    echo "  leave exactly one declaration per file"
    exit 1
  fi
  pin_files+=("$file")
  pin_values+=("$value")
}
# Dockerfile FIRST: it is the reference the sweep below measures everything
# against, and `add_pin` has just proved it single-valued.
add_pin Dockerfile \
  "$(sed -n 's/^ARG GSD_CORE_VERSION=//p' Dockerfile)"
add_pin Makefile \
  "$(sed -n 's/^GSD_CORE_VERSION[[:space:]]*?=[[:space:]]*//p' Makefile)"
add_pin docker-compose.yml \
  "$(sed -n 's/.*GSD_CORE_VERSION:[[:space:]]*\${GSD_CORE_VERSION:-\([^}]*\)}.*/\1/p' docker-compose.yml)"
add_pin .env.example \
  "$(sed -n 's/^GSD_CORE_VERSION=//p' .env.example)"
add_pin tests/smoke/codex-shipyard-smoke.sh \
  "$(sed -n 's/^GSD_CORE_VERSION="\${GSD_CORE_VERSION:-\([^}]*\)}".*/\1/p' tests/smoke/codex-shipyard-smoke.sh)"

# Both halves report before either exits. The sweep is the half that names
# README.md and the spec document, and a `Dockerfile`-only bump fails the
# agreement check too — exiting there would hide exactly the finding the sweep
# exists to make.
pin_failed=0
if [[ "$(printf '%s\n' "${pin_values[@]}" | sort -u | wc -l | tr -d ' ')" != "1" ]]; then
  echo "docs smoke: GSD_CORE_VERSION disagrees across its homes — a bare 'cp .env.example .env && docker compose build' would install a version the pin was moved off:"
  for i in "${!pin_files[@]}"; do
    echo "    ${pin_files[$i]} = ${pin_values[$i]}"
  done
  echo "  bring every home to one value (or teach this check about a home that is deliberately different)"
  pin_failed=1
fi

# ── …and every OTHER tracked mention of it, swept rather than listed ─────────
# The five homes above are a LIST, which is the failure the pin itself had: an
# inventory of the literal found eleven sites across eight files, and a guard
# that must be edited whenever a ninth appears is one revision behind the tree
# by construction. So the build pin — already proved single-valued — becomes the
# reference value and every TRACKED file is swept for a mention of it.
#
# `git ls-files`, not the working tree: a sweep over the tree would judge
# untracked scratch files and worktree debris, which nobody ships.
PIN="${pin_values[0]}" node - <<'NODE' || pin_failed=1
const fs = require('fs');
const { execFileSync } = require('child_process');

const pin = process.env.PIN;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// Two spellings, because the pin is written two ways in this tree: the runnable
// one (`npx --yes @opengsd/gsd-core@<semver>`) and the spec document's prose
// heading form (a section title ending `(pin: <semver>)`). The prose form must
// name GSD on the same line — a bare `pin:` plus a version is some other
// tool's, and a sweep claiming it disagreed about gsd-core would be lying.
// Neither example above may be written out as a real version: this file is
// swept like every other, so a literal in a comment here would fail the guard
// it belongs to.
const SPELLINGS = [
  /gsd-core@(\d+\.\d+\.\d+)/gi,
  /pin:\s*(\d+\.\d+\.\d+)/gi,
];
const disagree = [];
for (const file of files) {
  // `.planning/` quotes historical values ON PURPOSE: a plan that says the
  // pins were moved off some earlier release is correct precisely because it
  // names the value we no longer install, and rewriting it would falsify the
  // record.
  if (file.startsWith('.planning/')) continue;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    continue; // a submodule, or a tracked path this checkout does not materialise
  }
  if (buf.includes(0)) continue; // binary: no prose pin to read
  buf.toString('utf8').split('\n').forEach((text, i) => {
    // A version on a line that never names GSD is some other tool's, and a
    // sweep claiming it disagreed about gsd-core would be lying. The runnable
    // spelling satisfies this by containing the package name; the prose one
    // needs it.
    if (!/gsd/i.test(text)) return;
    // The spec document's §10.5 is DATED BY ITS OWN TITLE: it records the
    // reorientation from one GSD minor to the next, so the version in it is a
    // fact about that reorientation and not a claim about what the image
    // installs today.
    if (/^##\s*10\.5\./.test(text)) return;
    for (const re of SPELLINGS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m[1] !== pin) disagree.push(`    ${file}:${i + 1} = ${m[1]}\n        ${text.trim()}`);
      }
    }
  });
}

if (disagree.length) {
  console.error(`docs smoke: the build pin is ${pin}, but tracked files still name another gsd-core version:`);
  console.error(disagree.join('\n'));
  console.error('  bring every mention to the build pin (or, when a mention is deliberately historical, exclude it HERE with its reason)');
  process.exit(1);
}
NODE

[[ "$pin_failed" == 0 ]] || exit 1

# ── the documented model ladder must match the resolver ──────────────────────
# `docs/gsd_multilevel_delivery_pipeline.md` is what README.md calls the FULL
# SPECIFICATION, so its §7.5 table outranks the README for anyone who follows
# the pointer — and it went three reviews stale while every ticket that changed
# the ladder was `conform` on its own diff. The fix is a doc test that READS THE
# CODE: one row per role, compared against `model <role> --json`.
node - <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fail = (m) => { console.error(`docs smoke: ${m}`); process.exit(1); };

const doc = 'docs/gsd_multilevel_delivery_pipeline.md';
const text = fs.readFileSync(doc, 'utf8');
// Bound the parse to §7.5 so a role name mentioned anywhere else in a 900-line
// document cannot stand in for the row this test is looking for.
const section = (text.split(/^## 7\.5\./m)[1] || '').split(/^## 8\./m)[0];
if (!section) fail(`${doc} has no §7.5 model-policy section — the table this check compares against is gone`);
const fence = (section.match(/```text\n([\s\S]*?)\n```/) || [])[1];
if (!fence) fail(`${doc} §7.5 has no \`\`\`text block of roles — the ladder is documented as prose no test can check`);
const rows = fence.split('\n');

const script = path.resolve('plugins/delivery-pipeline/scripts/pipeline-config.cjs');
const { ROLES } = require('./plugins/delivery-pipeline/scripts/pipeline-config.cjs');

// The resolver reads `<cwd>/.planning/config.json`, and this project itself
// legitimately carries `pipeline.models` overrides. The table documents SHIPPED
// policy, so resolve from a config-free directory — otherwise the doc would be
// measured against whatever this one checkout happens to be tuned to.
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-docs-ladder-'));
try {
  for (const role of ROLES) {
    const row = rows.find((l) => new RegExp(`^${role}\\s`).test(l));
    if (!row) fail(`${doc} §7.5 has no row for the role "${role}" — every role the resolver routes must be in the table`);
    const [, tier, effort] = row.trim().split(/\s+/);
    const out = execFileSync(process.execPath, [script, 'model', role, '--json'],
      { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const got = JSON.parse(out);
    if (got.model !== tier || got.effort !== effort) {
      fail(`${doc} §7.5 says ${role} is ${tier}/${effort}, but \`pipeline-config.cjs model ${role} --json\` returns ${got.model}/${got.effort} — the code is the policy, so update the table`);
    }
  }
  // A row for something the resolver does not route is the other half of the
  // drift: a renamed or retired role left standing in the specification.
  for (const row of rows) {
    if (!/^\S/.test(row)) continue;             // continuation lines of the "why" column
    const first = row.trim().split(/\s+/)[0];
    if (first === 'role' || !first) continue;   // the header
    if (!ROLES.includes(first)) {
      fail(`${doc} §7.5 has a row for "${first}", which is not a pipeline role (roles: ${ROLES.join(', ')})`);
    }
  }
} finally {
  fs.rmSync(bare, { recursive: true, force: true });
}
NODE

# ── CI runs the same Node the image ships ────────────────────────────────────
# .github/workflows/test.yml duplicates Dockerfile.base's NODE_VERSION, because
# a workflow cannot read a Dockerfile ARG. A duplicated constant drifts
# silently, and the drift is invisible in the worst direction: a suite that
# passes on a major the container never runs is measuring the wrong runtime.
wf=".github/workflows/test.yml"
if [[ -f "$wf" ]]; then
  df_node="$(sed -n 's/^ARG NODE_VERSION=//p' Dockerfile.base | head -1)"
  wf_node="$(sed -n "s/.*node-version: *'\([^']*\)'.*/\1/p" "$wf" | head -1)"
  [[ -n "$df_node" ]] || { echo "docs smoke: cannot read NODE_VERSION from Dockerfile.base"; exit 1; }
  [[ -n "$wf_node" ]] || { echo "docs smoke: cannot read node-version from $wf"; exit 1; }
  [[ "$df_node" == "$wf_node" ]] || {
    echo "docs smoke: CI runs Node $wf_node but the image ships $df_node — bump both or the suite tests a runtime nobody deploys"
    exit 1
  }
  # The fast suite is the whole point of this workflow: it is the only target
  # that needs neither Docker nor the network, so it is the only one that can
  # run here. A job that reached for `make test` would hang on Docker.
  grep -q 'make test-fast' "$wf" || {
    echo "docs smoke: $wf does not run make test-fast"; exit 1;
  }
  for slow in test-base test-overlay test-runtime test-mcp-runtime test-k8s; do
    grep -qE "run:.*\b$slow\b" "$wf" && {
      echo "docs smoke: $wf runs $slow, which needs Docker/kubectl — it belongs in a separate optional workflow"; exit 1;
    }
  done
fi

echo "docs smoke passed"
