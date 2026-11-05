#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
runtime="${1:?usage: ci-fix-round.sh codex|claude owner/name}"
repo="${2:?dedicated empty GitHub repository required}"
case "$runtime" in codex|claude) ;; *) exit 2;; esac
work="$(mktemp -d /tmp/shipyard-ci-live.XXXXXX)"
project="$work/project"
mkdir -p "$project/src" "$project/tests" "$project/.github/workflows" "$project/.planning/graph" "$project/dist"
cp "$ROOT/tests/fixtures/live-project/.github/workflows/test.yml" "$project/.github/workflows/test.yml"
printf 'test:\n\tnode --test tests/value.test.cjs\n' > "$project/Makefile"
printf "module.exports = value => value + 1;\n" > "$project/src/value.cjs"
printf "const assert = require('node:assert/strict');\nconst value = require('../src/value.cjs');\nassert.equal(value(2), 3);\n" > "$project/tests/value.test.cjs"
printf '.planning/\ndist/\n.shipyard*\n' > "$project/.gitignore"
cp "$ROOT/tests/fixtures/live-project/planning/config.json" "$project/.planning/config.json"
printf '%s\n' '# Repair increment regression' \
 'Restore increment(value) returning value + 1. Only src/value.cjs may change.' \
 'Reproduce the actual assertion failure and restore the function. Leave tests intact.' '' \
 '## Verification commands' '- `node --test tests/value.test.cjs`' > "$project/.planning/PLAN.md"

(
 cd "$project"
 git init -q -b main
 git add .
 git commit -qm 'test: seed CI repair acceptance fixture'
 git remote add origin "https://github.com/$repo.git"
 git push -qu origin main
 git switch -qc ticket/T-01-01
 printf 'module.exports = value => value - 1;\n' > src/value.cjs
 git add src/value.cjs
 git commit -qm 'test: introduce increment regression'
 git push -qu origin HEAD
 gh pr create --repo "$repo" --base main --head ticket/T-01-01 --title 'CI repair acceptance fixture' --body 'Intentional failing increment regression for native host acceptance.' > "$work/pr.url"
)
pr="$(gh pr view --repo "$repo" "$(cat "$work/pr.url")" --json number -q .number)"
PROJECT="$project" REPO="$repo" PR="$pr" node - <<'NODE'
const fs=require('fs'),path=require('path'); const {PROJECT:p,REPO:repo,PR:pr}=process.env;
fs.writeFileSync(path.join(p,'.planning/graph/tickets.json'), JSON.stringify({tickets:{'T-01-01':{
 phase:1, title:'Repair increment regression', branch:'ticket/T-01-01',pr_base:'main',plan:'.planning/PLAN.md',files:['src/value.cjs'],repo}}}));
fs.writeFileSync(path.join(p,'.planning/graph/delivery-state.json'),JSON.stringify({'T-01-01':{
 branch:'ticket/T-01-01',base:'main',pr:Number(pr),status:'pr-open'}}));
NODE
run=""
for _ in $(seq 1 90); do
 run="$(gh run list --repo "$repo" --branch ticket/T-01-01 --json databaseId,status,conclusion --jq '.[] | select(.status=="completed" and .conclusion=="failure") | .databaseId' | head -1)"
 [ -z "$run" ] || break
 sleep 5
done
[ -n "$run" ] || { echo "CI failure not observed: $work" >&2; exit 1; }
gh run view "$run" --repo "$repo" --log-failed > "$project/dist/.shipyard-ci-failure.log"
(
 cd "$project"
 node "$ROOT/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs" build ci-fix T-01-01 --runtime "$runtime" --pr "$pr" --failure-file "$project/dist/.shipyard-ci-failure.log" --graph "$project/.planning/graph" > "$work/request.json"
 if [ "$runtime" = codex ]; then
   node "$ROOT/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs" --args-file "$work/request.json" > "$work/result.json" 2> "$work/host.log"
 else
   node "$ROOT/plugins/delivery-pipeline/scripts/claude-delivery-host.cjs" --workflow fix-round --request-file "$work/request.json" > "$work/result.json" 2> "$work/host.log"
 fi
 node --test tests/value.test.cjs > "$work/verification.log"
 git verify-commit HEAD > "$work/signature.log" 2>&1
)
for _ in $(seq 1 90); do
 if gh pr checks "$pr" --repo "$repo" > "$work/checks.log" 2>&1; then
   grep -q 'pass' "$work/checks.log" && break
 fi
 sleep 5
done
grep -q 'pass' "$work/checks.log"
echo "CI repair passed: runtime=$runtime repo=$repo PR=$pr failure_run=$run artifacts=$work"
