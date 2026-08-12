#!/usr/bin/env bash
set -euo pipefail

# Every published tag must carry a release entry.
#
# This repo has kept release notes since v0.4.0 — and then twelve tags in a row
# shipped without one, because the release step lived in whoever was cutting the
# version rather than in anything that checks. Tagging, pushing and installing
# all have their own feedback; a missing release announces itself to nobody. The
# result was a public repository whose entire recent history was legible only as
# a list of version numbers.
#
# Needs the network and an authenticated `gh`, so it is NOT part of `make
# test-fast`. Run it before or after cutting a release — `make test-releases`.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

command -v gh >/dev/null 2>&1 || { echo "gh not found on PATH — this check reads GitHub releases"; exit 1; }
git remote get-url origin >/dev/null 2>&1 || { echo "no 'origin' remote to compare against"; exit 1; }

# Tags as GitHub knows them, not as this checkout does: a tag that was never
# pushed cannot have a release, and demanding one would be noise.
if ! remote_tags="$(git ls-remote --tags origin 2>/dev/null | grep -v '\^{}' | awk '{print $2}' | sed 's|refs/tags/||' | sort)"; then
  echo "could not list remote tags (network? auth?)"; exit 1
fi
if [[ -z "$remote_tags" ]]; then
  echo "release notes smoke: no tags on origin — nothing to check"
  exit 0
fi

if ! releases="$(gh release list --limit 300 --json tagName --jq '.[].tagName' 2>/dev/null | sort)"; then
  echo "could not list GitHub releases (gh auth? repo access?)"; exit 1
fi

missing="$(comm -23 <(printf '%s\n' "$remote_tags") <(printf '%s\n' "$releases") || true)"

if [[ -n "$missing" ]]; then
  echo "tags on origin with no release entry:"
  printf '%s\n' "$missing" | sed 's/^/  - /'
  echo
  echo "Cut them with:"
  echo "  gh release create <tag> --verify-tag --title \"\$(git tag -l <tag> --format='%(contents:subject)')\" --notes-file <notes>"
  echo
  echo "Notes are worth assembling from the commits the tag actually covers —"
  echo "  git log --no-merges --reverse --format='## %s%n%n%b%n' <previous-tag>..<tag>"
  echo "because a release spanning several commits is otherwise announced by whichever"
  echo "one happened to land last."
  exit 1
fi

echo "release notes smoke passed ($(printf '%s\n' "$remote_tags" | wc -l | tr -d ' ') tag(s), each with a release)"
