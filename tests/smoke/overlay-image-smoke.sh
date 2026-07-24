#!/usr/bin/env bash
set -euo pipefail

[[ -f Dockerfile ]] || { echo "missing Dockerfile"; exit 1; }
[[ -f scripts/sync-karpathy-skills.sh ]] || { echo "missing scripts/sync-karpathy-skills.sh"; exit 1; }
[[ -f scripts/install-claude-plugins.sh ]] || { echo "missing scripts/install-claude-plugins.sh"; exit 1; }
[[ -f scripts/entrypoint.sh ]] || { echo "missing scripts/entrypoint.sh"; exit 1; }
[[ -f plugins/delivery-pipeline/.claude-plugin/plugin.json ]] || { echo "missing delivery-pipeline plugin.json"; exit 1; }
[[ -f plugins/delivery-pipeline/.claude-plugin/marketplace.json ]] || { echo "missing delivery-pipeline marketplace.json"; exit 1; }
for f in commands/route.md commands/investigate.md commands/decompose.md commands/deliver.md commands/bench.md \
         scripts/validate-graph.cjs scripts/state-sync.cjs scripts/reviewers.cjs \
         scripts/validate-inv.cjs scripts/ticket-worktree.sh scripts/epic-branch.sh \
         scripts/ticket-pr-match.cjs scripts/log-event.cjs scripts/pipeline-stats.cjs \
         workflows/drift-gate.mjs workflows/executors.mjs workflows/fix-round.mjs; do
  [[ -f "plugins/delivery-pipeline/$f" ]] || { echo "missing delivery-pipeline $f"; exit 1; }
done
bash -n plugins/delivery-pipeline/scripts/epic-branch.sh || { echo "epic-branch.sh syntax error"; exit 1; }
# telemetry layer is plain node — a bare syntax check must pass
for f in scripts/ticket-pr-match.cjs scripts/log-event.cjs scripts/pipeline-stats.cjs scripts/state-sync.cjs; do
  node --check "plugins/delivery-pipeline/$f" || { echo "delivery-pipeline $f fails node --check"; exit 1; }
done

# Workflow scripts use the DSL's top-level await/return, so a BARE `node --check`
# is expected to fail with "Illegal return statement". The runtime wraps the body
# in an async function — replicate that wrap, THEN check, to catch real syntax
# errors (typos) without false-failing on the intended top-level return.
for wf in drift-gate executors fix-round; do
  f="plugins/delivery-pipeline/workflows/$wf.mjs"
  {
    echo "let agent,parallel,phase,log,args;"
    echo "async function __wf(){"
    sed 's/^export const meta/const meta/' "$f"
    echo "}; void __wf;"
  } | node --check - || { echo "workflow $wf.mjs is not valid JS when wrapped as the runtime wraps it"; exit 1; }
done
[[ -f capabilities/delivery-pipeline/capability.json ]] || { echo "missing delivery-pipeline capability.json"; exit 1; }
# The plugin and its GSD capability ship as one product — keep them on a single
# version so a release can never half-update one and leave the other behind.
PLUGIN_VER="$(node -p 'require("./plugins/delivery-pipeline/.claude-plugin/plugin.json").version')"
CAP_VER="$(node -p 'require("./capabilities/delivery-pipeline/capability.json").version')"
[[ "$PLUGIN_VER" == "$CAP_VER" ]] || { echo "delivery-pipeline version drift: plugin $PLUGIN_VER != capability $CAP_VER"; exit 1; }
[[ -f capabilities/delivery-pipeline/checks/graph-gate.cjs ]] || { echo "missing capability graph-gate.cjs"; exit 1; }
[[ ! -d config/claude-lsp-plugin ]] || { echo "config/claude-lsp-plugin should be gone"; exit 1; }
[[ ! -f scripts/sync-dev-copilot.sh ]] || { echo "sync-dev-copilot.sh should be gone"; exit 1; }
[[ ! -f scripts/install-dev-copilot.sh ]] || { echo "install-dev-copilot.sh should be gone"; exit 1; }

rm -rf .build/karpathy-skills
KARPATHY_SKILLS_REPO="${KARPATHY_SKILLS_REPO:-https://github.com/multica-ai/andrej-karpathy-skills}" \
KARPATHY_SKILLS_REF="${KARPATHY_SKILLS_REF:-2c606141936f1eeef17fa3043a72095b4765b9c2}" \
./scripts/sync-karpathy-skills.sh .build/karpathy-skills

docker build -f Dockerfile.base -t claude-shipyard-base:test .
docker build -f Dockerfile -t claude-shipyard:test \
  --build-arg BASE_IMAGE=claude-shipyard-base:test \
  --build-arg KARPATHY_SKILLS_DIR=.build/karpathy-skills \
  .

docker run --rm claude-shipyard:test bash -lc '
  set -euo pipefail
  test -d /opt/karpathy-skills
  test -d /opt/delivery-pipeline
  test -x /opt/delivery-pipeline/scripts/validate-graph.cjs
  test -x /opt/delivery-pipeline/scripts/ticket-worktree.sh
  test -x /opt/delivery-pipeline/scripts/epic-branch.sh
  test -f /opt/delivery-pipeline/scripts/pipeline-stats.cjs
  test -f /opt/delivery-pipeline/workflows/executors.mjs
  test -f /opt/delivery-pipeline/workflows/drift-gate.mjs
  test -f /opt/delivery-pipeline/workflows/fix-round.mjs
  test -x /usr/local/bin/install-claude-plugins.sh
  command -v claude >/dev/null
  # gsd-core landed under ~/.claude
  test -d "$HOME/.claude"
  ls -A "$HOME/.claude" | grep -q .
  # official marketplace is registered
  jq -e ".\"claude-plugins-official\"" "$HOME/.claude/plugins/known_marketplaces.json" >/dev/null
  # all six plugins appear in installed_plugins.json
  for p in andrej-karpathy-skills@karpathy-skills shipyard@delivery-pipeline skill-creator@claude-plugins-official code-simplifier@claude-plugins-official github@claude-plugins-official typescript-lsp@claude-plugins-official; do
    jq -e --arg p "$p" ".plugins[\$p]" "$HOME/.claude/plugins/installed_plugins.json" >/dev/null
  done
  # the delivery-pipeline GSD capability is installed and its gate check is runnable
  node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" capability list --json \
    | jq -e ".[] | select(.id == \"delivery-pipeline\")" >/dev/null
'

echo "overlay image smoke passed"
