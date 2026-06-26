#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${LOCAL_SSH_DIR:-$HOME/.ssh}"
TARGET_DIR="${1:-.build/ssh-config}"
copied=0

[[ -d "$SOURCE_DIR" ]] || { echo "missing source directory: $SOURCE_DIR"; exit 1; }

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

for file in config known_hosts known_hosts2; do
  if [[ -f "$SOURCE_DIR/$file" ]]; then
    cp "$SOURCE_DIR/$file" "$TARGET_DIR/$file"
    chmod 600 "$TARGET_DIR/$file"
    copied=1
  fi
done

[[ "$copied" -eq 1 ]] || { echo "missing safe SSH client files in $SOURCE_DIR"; exit 1; }

rm -f \
  "$TARGET_DIR"/authorized_keys \
  "$TARGET_DIR"/id_* \
  "$TARGET_DIR"/*.pem \
  "$TARGET_DIR"/*.key 2>/dev/null || true
