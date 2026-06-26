#!/usr/bin/env bash
set -euo pipefail

[[ -f README.md ]] || { echo "missing README.md"; exit 1; }
[[ -f .env.example ]] || { echo "missing .env.example"; exit 1; }

grep -q "make build-base" README.md || { echo "README missing make build-base"; exit 1; }
grep -q "make build-dev-image" README.md || { echo "README missing make build-dev-image"; exit 1; }
grep -q "make deploy-k8s" README.md || { echo "README missing make deploy-k8s"; exit 1; }
grep -q "Atlassian Rovo" README.md || { echo "README missing Atlassian Rovo MCP note"; exit 1; }
grep -q "Context7" README.md || { echo "README missing Context7 MCP note"; exit 1; }
grep -q "context7-mcp" README.md || { echo "README missing baked context7-mcp note"; exit 1; }
grep -q "TypeScript/JavaScript LSP" README.md || { echo "README missing TypeScript LSP note"; exit 1; }
grep -q "typescript-language-server" README.md || { echo "README missing typescript-language-server note"; exit 1; }
grep -q "lsp-config.json" README.md || { echo "README missing lsp-config.json note"; exit 1; }
grep -q '`.ts`, `.tsx`, `.js`, and `.jsx`' README.md || { echo "README missing TS/JS file coverage note"; exit 1; }
grep -q "andrej-karpathy-skills" README.md || { echo "README missing Karpathy plugin note"; exit 1; }
grep -q "host user's \`~/.ssh\` directory read-only" README.md || { echo "README missing compose SSH mount note"; exit 1; }
grep -q "interactive OAuth" README.md || { echo "README missing interactive OAuth guidance"; exit 1; }
grep -q "ephemeral" README.md || { echo "README missing ephemeral state note"; exit 1; }
grep -q "does not mount the host" README.md || { echo "README missing no host profile note"; exit 1; }
grep -q "mcp-oauth-config" README.md || { echo "README missing MCP OAuth persistence note"; exit 1; }
grep -q "persist only Atlassian OAuth state" README.md || { echo "README missing selective OAuth persistence guidance"; exit 1; }
grep -q "make bootstrap-atlassian-oauth" README.md || { echo "README missing bootstrap-atlassian-oauth flow"; exit 1; }
grep -q "host-side" README.md || { echo "README missing host-side OAuth note"; exit 1; }
grep -q "\.copilot-mcp-oauth" README.md || { echo "README missing project-local OAuth cache note"; exit 1; }
grep -q '^DEV_COPILOT_SOURCE=' .env.example || { echo ".env.example missing DEV_COPILOT_SOURCE"; exit 1; }
grep -q '^DEV_COPILOT_INSTALL_CMD=' .env.example || { echo ".env.example missing DEV_COPILOT_INSTALL_CMD"; exit 1; }
grep -q '^MCP_OAUTH_DIR=' .env.example || { echo ".env.example missing MCP_OAUTH_DIR"; exit 1; }
grep -q '^SSH_AUTH_SOCK=' .env.example || { echo ".env.example missing SSH_AUTH_SOCK"; exit 1; }

if grep -q '^COPILOT_PROFILE_DIR=' .env.example; then
  echo ".env.example should not contain COPILOT_PROFILE_DIR"
  exit 1
fi

if grep -q '^CONTEXT7_API_KEY=' .env.example; then
  echo ".env.example should not contain CONTEXT7_API_KEY"
  exit 1
fi

echo "docs smoke passed"
