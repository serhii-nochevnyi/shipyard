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
// resolved: `undraft` is a bare `gh pr ready`, and `merge` is `sentinel.cjs
// merge`, which re-verifies the gate against live GitHub in the script precisely
// so that no agent can be talked into it.
const MECHANICAL = new Set(['undraft', 'merge']);

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
