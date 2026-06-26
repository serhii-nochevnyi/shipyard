#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${KARPATHY_SKILLS_REPO:-https://github.com/multica-ai/andrej-karpathy-skills}"
REF="${KARPATHY_SKILLS_REF:-2c606141936f1eeef17fa3043a72095b4765b9c2}"
TARGET_DIR="${1:-.build/karpathy-skills}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

git clone --no-checkout "$REPO_URL" "$tmpdir/repo"
git -C "$tmpdir/repo" checkout --detach "$REF"

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

rsync -a --delete \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.idea' \
  "$tmpdir/repo"/ "$TARGET_DIR"/

[[ -f "$TARGET_DIR/.claude-plugin/plugin.json" ]] || { echo "missing Karpathy plugin definition"; exit 1; }
[[ -f "$TARGET_DIR/.claude-plugin/marketplace.json" ]] || { echo "missing Karpathy marketplace metadata"; exit 1; }
