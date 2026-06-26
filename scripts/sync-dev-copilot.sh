#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${DEV_COPILOT_SOURCE:-/Volumes/KINGSTON/PhpstormProjects/dev-copilot}"
TARGET_DIR="${1:-.build/dev-copilot}"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "missing source directory: $SOURCE_DIR"
  exit 1
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

rsync -a --delete \
  --exclude '.git' \
  --exclude '.idea' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude '.venv' \
  "$SOURCE_DIR"/ "$TARGET_DIR"/

if [[ ! -f "$TARGET_DIR/.claude-plugin/marketplace.json" ]]; then
  echo "missing plugin marketplace metadata"
  exit 1
fi

if [[ ! -f "$TARGET_DIR/.claude-plugin/plugin.json" ]]; then
  echo "missing plugin definition"
  exit 1
fi
