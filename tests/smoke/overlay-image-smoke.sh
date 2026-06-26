#!/usr/bin/env bash
set -euo pipefail

[[ -f Dockerfile ]] || { echo "missing Dockerfile"; exit 1; }
[[ -f scripts/sync-dev-copilot.sh ]] || { echo "missing scripts/sync-dev-copilot.sh"; exit 1; }
[[ -f scripts/install-dev-copilot.sh ]] || { echo "missing scripts/install-dev-copilot.sh"; exit 1; }
[[ -f scripts/sync-karpathy-skills.sh ]] || { echo "missing scripts/sync-karpathy-skills.sh"; exit 1; }
[[ -f scripts/install-karpathy-skills.sh ]] || { echo "missing scripts/install-karpathy-skills.sh"; exit 1; }
[[ -f scripts/entrypoint.sh ]] || { echo "missing scripts/entrypoint.sh"; exit 1; }

rm -rf .build/dev-copilot .build/karpathy-skills
DEV_COPILOT_SOURCE="${DEV_COPILOT_SOURCE:-/Volumes/KINGSTON/PhpstormProjects/dev-copilot}" ./scripts/sync-dev-copilot.sh .build/dev-copilot
KARPATHY_SKILLS_REPO="${KARPATHY_SKILLS_REPO:-https://github.com/multica-ai/andrej-karpathy-skills}" \
KARPATHY_SKILLS_REF="${KARPATHY_SKILLS_REF:-2c606141936f1eeef17fa3043a72095b4765b9c2}" \
./scripts/sync-karpathy-skills.sh .build/karpathy-skills

docker build -f Dockerfile.base -t remote-copilot-base:test \
  --build-arg CONTEXT7_MCP_VERSION="${CONTEXT7_MCP_VERSION:-2.2.5}" \
  .
docker build \
  -f Dockerfile \
  -t remote-copilot:test \
  --build-arg BASE_IMAGE=remote-copilot-base:test \
  --build-arg DEV_COPILOT_DIR=.build/dev-copilot \
  --build-arg DEV_COPILOT_INSTALL_CMD="${DEV_COPILOT_INSTALL_CMD:-}" \
  --build-arg DEV_COPILOT_SOURCE_REV="${DEV_COPILOT_SOURCE_REV:-local-dev}" \
  --build-arg KARPATHY_SKILLS_DIR=.build/karpathy-skills \
  .

docker run --rm remote-copilot:test bash -lc '
  set -euo pipefail
  test -d /opt/dev-copilot
  test -d /opt/karpathy-skills
  test -f /usr/local/share/dev-copilot/source-rev
  test -x /usr/local/bin/install-karpathy-skills.sh
  plugin_list="$(copilot plugin list)"
  grep -q "dev-copilot" <<<"$plugin_list"
  grep -q "andrej-karpathy-skills" <<<"$plugin_list"
'

echo "overlay image smoke passed"
