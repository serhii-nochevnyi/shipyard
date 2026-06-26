#!/usr/bin/env bash
set -euo pipefail

[[ -f Dockerfile ]] || { echo "missing Dockerfile"; exit 1; }
[[ -f scripts/sync-karpathy-skills.sh ]] || { echo "missing scripts/sync-karpathy-skills.sh"; exit 1; }
[[ -f scripts/install-claude-plugins.sh ]] || { echo "missing scripts/install-claude-plugins.sh"; exit 1; }
[[ -f scripts/entrypoint.sh ]] || { echo "missing scripts/entrypoint.sh"; exit 1; }
[[ ! -d config/claude-lsp-plugin ]] || { echo "config/claude-lsp-plugin should be gone"; exit 1; }
[[ ! -f scripts/sync-dev-copilot.sh ]] || { echo "sync-dev-copilot.sh should be gone"; exit 1; }
[[ ! -f scripts/install-dev-copilot.sh ]] || { echo "install-dev-copilot.sh should be gone"; exit 1; }

rm -rf .build/karpathy-skills
KARPATHY_SKILLS_REPO="${KARPATHY_SKILLS_REPO:-https://github.com/multica-ai/andrej-karpathy-skills}" \
KARPATHY_SKILLS_REF="${KARPATHY_SKILLS_REF:-2c606141936f1eeef17fa3043a72095b4765b9c2}" \
./scripts/sync-karpathy-skills.sh .build/karpathy-skills

docker build -f Dockerfile.base -t remote-copilot-base:test .
docker build -f Dockerfile -t remote-copilot:test \
  --build-arg BASE_IMAGE=remote-copilot-base:test \
  --build-arg KARPATHY_SKILLS_DIR=.build/karpathy-skills \
  .

docker run --rm remote-copilot:test bash -lc '
  set -euo pipefail
  test -d /opt/karpathy-skills
  test -x /usr/local/bin/install-claude-plugins.sh
  command -v claude >/dev/null
  # gsd-core landed under ~/.claude
  test -d "$HOME/.claude"
  ls -A "$HOME/.claude" | grep -q .
  # official marketplace is registered
  jq -e ".\"claude-plugins-official\"" "$HOME/.claude/plugins/known_marketplaces.json" >/dev/null
  # all five plugins appear in installed_plugins.json
  for p in andrej-karpathy-skills@karpathy-skills skill-creator@claude-plugins-official code-simplifier@claude-plugins-official github@claude-plugins-official typescript-lsp@claude-plugins-official; do
    jq -e --arg p "$p" ".plugins[\$p]" "$HOME/.claude/plugins/installed_plugins.json" >/dev/null
  done
'

echo "overlay image smoke passed"
