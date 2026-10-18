#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$HERE/installed-launch"

command -v node >/dev/null 2>&1 || { echo "installed-launch-smoke: node is required on PATH" >&2; exit 2; }
[ -d "$DIR" ] || { echo "installed-launch-smoke: missing scenario directory $DIR" >&2; exit 2; }

NAMES=()
for file in "$DIR"/scenario-*.cjs; do
  [ -e "$file" ] || continue
  base="$(basename "$file" .cjs)"
  NAMES+=("$base")
done
[ "${#NAMES[@]}" -gt 0 ] || { echo "installed-launch-smoke: no scenario-*.cjs found in $DIR" >&2; exit 1; }

if [ "$#" -gt 1 ]; then
  echo "usage: installed-launch-smoke.sh [scenario-<name>]" >&2
  exit 2
fi

SELECTED=("${NAMES[@]}")
if [ "$#" -eq 1 ]; then
  want="$1"
  found=""
  if [[ "$want" =~ ^scenario-[a-z0-9-]+$ ]]; then
    for name in "${NAMES[@]}"; do
      if [ "$name" = "$want" ]; then found="$name"; fi
    done
  fi
  if [ -z "$found" ]; then
    echo "installed-launch-smoke: unknown scenario '$want'; available:" >&2
    for name in "${NAMES[@]}"; do echo "  $name" >&2; done
    exit 2
  fi
  SELECTED=("$found")
fi

failed=0
for name in "${SELECTED[@]}"; do
  set +e
  node "$DIR/$name.cjs"
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    echo "PASS $name"
  else
    echo "FAIL $name (exit $code)"
    failed=1
  fi
done
exit "$failed"
