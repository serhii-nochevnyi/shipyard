#!/usr/bin/env bash
set -euo pipefail

[[ -f README.md ]] || { echo "missing README.md"; exit 1; }
[[ -f .env.example ]] || { echo "missing .env.example"; exit 1; }

grep -q "make build-base" README.md || { echo "README missing make build-base"; exit 1; }
grep -q "make build-dev-image" README.md || { echo "README missing make build-dev-image"; exit 1; }
grep -q "make deploy-k8s" README.md || { echo "README missing make deploy-k8s"; exit 1; }
grep -q "Claude Code" README.md || { echo "README missing Claude Code"; exit 1; }
grep -q "gsd-core" README.md || { echo "README missing gsd-core note"; exit 1; }
grep -q "@opengsd/gsd-core" README.md || { echo "README missing gsd-core package"; exit 1; }
grep -q "Atlassian Rovo" README.md || { echo "README missing Atlassian Rovo MCP note"; exit 1; }
grep -q "Context7" README.md || { echo "README missing Context7 MCP note"; exit 1; }
grep -q "context7-mcp" README.md || { echo "README missing baked context7-mcp note"; exit 1; }
grep -q "typescript-language-server" README.md || { echo "README missing typescript-language-server note"; exit 1; }
grep -q "andrej-karpathy-skills" README.md || { echo "README missing Karpathy plugin note"; exit 1; }
grep -q "delivery-pipeline" README.md || { echo "README missing delivery-pipeline plugin note"; exit 1; }
grep -q "/pipeline:deliver" README.md || { echo "README missing /pipeline:deliver command note"; exit 1; }
grep -q "CLAUDE_CODE_OAUTH_TOKEN" README.md || { echo "README missing OAuth token note"; exit 1; }
grep -q "claude setup-token" README.md || { echo "README missing setup-token note"; exit 1; }
grep -q "host user's \`~/.ssh\` directory read-only" README.md || { echo "README missing compose SSH mount note"; exit 1; }
grep -q "make bootstrap-atlassian-oauth" README.md || { echo "README missing bootstrap-atlassian-oauth flow"; exit 1; }
grep -q ".claude-credentials.json" README.md || { echo "README missing credentials persistence note"; exit 1; }
grep -q "ephemeral" README.md || { echo "README missing ephemeral state note"; exit 1; }
grep -q "skill-creator" README.md || { echo "README missing skill-creator plugin note"; exit 1; }
grep -q "code-simplifier" README.md || { echo "README missing code-simplifier plugin note"; exit 1; }
grep -q "GitHub MCP server" README.md || { echo "README missing github (GitHub MCP server) plugin note"; exit 1; }
grep -q '~/.config/gh' README.md || { echo "README missing gh config mount note"; exit 1; }
grep -q "read-only" README.md || { echo "README missing read-only note for gh mount"; exit 1; }

grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env.example || { echo ".env.example missing CLAUDE_CODE_OAUTH_TOKEN"; exit 1; }
grep -q '^CLAUDE_CREDENTIALS_FILE=' .env.example || { echo ".env.example missing CLAUDE_CREDENTIALS_FILE"; exit 1; }
grep -q '^SSH_AUTH_SOCK=' .env.example || { echo ".env.example missing SSH_AUTH_SOCK"; exit 1; }

if grep -q 'DEV_COPILOT' .env.example; then
  echo ".env.example should not contain DEV_COPILOT vars"
  exit 1
fi
# The image tag `remote-copilot:test` may legitimately appear in a `docker run`
# example, so assert the removed artifacts are gone rather than the bare substring.
for pat in 'dev-copilot' 'copilot plugin' '\.copilot' 'COPILOT_'; do
  if grep -qE "$pat" README.md; then
    echo "README should not mention $pat anymore"
    exit 1
  fi
done

echo "docs smoke passed"
