#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="$ROOT/plugins/delivery-pipeline/scripts"
FIXTURE="$ROOT/tests/fixtures/live-project"

runtime=""
repo="${SHIPYARD_LIVE_REPO:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime) runtime="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    *) echo "usage: tests/live/live-round.sh --runtime <claude|codex> [--repo owner/name]" >&2; exit 2 ;;
  esac
done
case "$runtime" in
  claude|codex) ;;
  *) echo "live-round: --runtime must be claude or codex" >&2; exit 2 ;;
esac

version="$(node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$ROOT/plugins/delivery-pipeline/.claude-plugin/plugin.json")"
tree_sha="$(git -C "$ROOT" rev-parse 'HEAD^{tree}')"
head_sha="$(git -C "$ROOT" rev-parse HEAD)"
work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/shipyard-live.XXXXXX")" && pwd -P)"
stages_file="$work/stages.jsonl"
project="$work/project"
: > "$stages_file"
cli_version="unknown"

stage_json() {
  STAGE="$1" OK="$2" DETAIL="$3" DISPATCH="${4:-}" ROLE="${5:-}" REQUESTED="${6:-null}" APPLIED="${7:-null}" node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({
      stage: e.STAGE, ok: e.OK === "true", detail: e.DETAIL, dispatch_id: e.DISPATCH || null, role: e.ROLE || null,
      requested: JSON.parse(e.REQUESTED), applied: JSON.parse(e.APPLIED),
    }) + "\n");
  ' >> "$stages_file"
}

finish() {
  local status=$?
  set +e
  local out
  out="$(node "$SCRIPTS/live-receipt.cjs" write --version "$version" --tree-sha "$tree_sha" --head-sha "$head_sha" \
    --runtime "$runtime" --cli-version "$cli_version" --stages-file "$stages_file")"
  local receipt_status=$?
  echo "$out"
  printf '%s' "$out" | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log("live receipt: " + r.path + (r.ok ? " (pass)" : " (FAIL)"));'
  if [ "$status" -eq 0 ] && [ "$receipt_status" -ne 0 ]; then status=1; fi
  exit "$status"
}
trap finish EXIT

fail_stage() {
  stage_json "$1" false "$2" "${3:-}" "${4:-}" "${5:-null}" "${6:-null}"
  echo "live-round: stage $1 failed: $2" >&2
  exit 1
}

base_rung() {
  node "$SCRIPTS/model-policy.cjs" resolve "{\"runtime\":\"$runtime\",\"role\":\"$1\",\"signals\":{}}" \
    | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify({ model: r.model, effort: r.effort ?? null }));'
}

receipt_rungs() {
  node -e '
    const seen = new Set();
    function find(v) {
      if (!v || typeof v !== "object" || seen.has(v)) return null;
      seen.add(v);
      if (typeof v.requested_model === "string" && typeof v.applied_model === "string") return v;
      for (const k of Object.keys(v)) { const hit = find(v[k]); if (hit) return hit; }
      return null;
    }
    const raw = require("fs").readFileSync(0, "utf8").split("\n").filter((l) => l.trim());
    let r = null;
    for (const line of raw) { try { r = find(JSON.parse(line)) || r; } catch {} }
    if (!r) { process.stdout.write("null\tnull"); process.exit(0); }
    process.stdout.write(JSON.stringify({ model: r.requested_model, effort: r.requested_effort ?? null }) + "\t"
      + JSON.stringify({ model: r.applied_model, effort: r.applied_effort ?? null }));
  '
}

record_rung_stage() {
  local stage="$1" role="$2" dispatch="$3" output="$4"
  local expected rungs requested applied
  expected="$(base_rung "$role")" || fail_stage "$stage" "model-policy resolve failed for $role" "$dispatch" "$role"
  rungs="$(printf '%s' "$output" | receipt_rungs)"
  requested="${rungs%%	*}"
  applied="${rungs#*	}"
  if [ "$requested" = "null" ]; then fail_stage "$stage" "no ADR-014 application receipt in output" "$dispatch" "$role"; fi
  if [ "$requested" != "$expected" ] || [ "$applied" != "$expected" ]; then
    fail_stage "$stage" "rung is not base rung $expected" "$dispatch" "$role" "$requested" "$applied"
  fi
  stage_json "$stage" true "base rung $expected" "$dispatch" "$role" "$requested" "$applied"
}

command -v "$runtime" >/dev/null 2>&1 || fail_stage preconditions "$runtime CLI not on PATH"
cli_version="$("$runtime" --version 2>/dev/null | head -1 || echo unknown)"
command -v gh >/dev/null 2>&1 || fail_stage preconditions "gh not on PATH"
gh auth status >/dev/null 2>&1 || fail_stage preconditions "gh auth status failed"
[ -n "$repo" ] || fail_stage preconditions "set SHIPYARD_LIVE_REPO or --repo to a throwaway owner/name repository"
case "$repo" in
  */*) ;;
  *) fail_stage preconditions "repository must be owner/name: $repo" ;;
esac
gh repo view "$repo" >/dev/null 2>&1 || fail_stage preconditions "repository $repo is not reachable"
node "$ROOT/scripts/shipyard-doctor.cjs" >/dev/null 2>&1 || fail_stage preconditions "installed hosts are not the release layout (shipyard-doctor failed)"

cp -R "$FIXTURE" "$project"
mv "$project/planning" "$project/.planning"
printf '.planning/\n' >> "$project/.git-info-exclude"
(
  cd "$project"
  git init -q
  mv .git-info-exclude .git/info/exclude
  git add -A
  git commit -q -m "chore: initial import"
  default_branch="$(gh repo view "$repo" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
  git branch -M "${default_branch:-main}"
  git remote add origin "https://github.com/$repo.git"
  git push -q --force origin "HEAD:${default_branch:-main}"
) || fail_stage push "could not push the fixture to $repo"
stage_json push true "pushed fixture to $repo" "" "" null null

host_request() {
  KIND="$1" RUNTIME="$runtime" PROJECT="$project" node -e '
    const path = require("path");
    const crypto = require("crypto");
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const scripts = process.argv[1];
    const { KIND: kind, RUNTIME: runtime, PROJECT: project } = process.env;
    const policy = require(path.join(scripts, "model-policy.cjs"));
    const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
    const adr = ".planning/architecture/ADR-001-greeting-formats.md";
    const invId = "INV-001-greeting-formats";
    const invPath = path.join(project, ".planning", "investigations", invId);
    const artifactRoot = path.join(invPath, "research");
    const lines = ["system-state", "alternatives", "constraints", "risks"];
    const labels = { "system-state": "system state", alternatives: "alternatives", constraints: "constraints", risks: "risks and unknowns" };
    const problem = "Research how to implement the accepted ADR " + adr + " in this project.";
    const plannerPrompt = "Decompose the accepted ADR " + adr + " into phase 1 plans under .planning/phases/."
      + " Research findings: " + path.relative(project, artifactRoot) + "/*.md.";
    const sourceRevision = git("rev-parse", "HEAD");
    const repository = fs.realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
    const codexScope = { run_id: "live-" + crypto.randomUUID(), ticket: "T-01-00", phase: 1, worktree: project, runtime: "codex", provider: "openai" };
    let request;
    if (kind === "research" && runtime === "claude") {
      const claudeHost = require(path.join(scripts, "claude-delivery-host.cjs"));
      const pipelineConfig = require(path.join(scripts, "pipeline-config.cjs"));
      fs.mkdirSync(artifactRoot, { recursive: true });
      request = {
        schema: claudeHost.REQUEST_SCHEMA,
        scope: { run_id: "live-" + crypto.randomUUID(), ticket: invId, phase: 1, worktree: project },
        args: {
          invId, invPath, problemStatement: problem, referencePath: "inv-research",
          artifactContract: "planning.v1", worktreePath: project, artifactRoot, sourceRevision, repository,
          policyHash: policy.POLICY_HASH,
          artifactPaths: Object.fromEntries(lines.map((id) => [id, path.join(artifactRoot, id + ".md")])),
          lines: lines.map((id) => {
            const r = pipelineConfig.resolveDispatch({ root: project, runtime: "claude", role: "research", signals: {}, dispatch_id: "live-" + id });
            return { id, label: labels[id], model: r.model, effort: r.effort, signals: {} };
          }),
        },
      };
      claudeHost.validateRequest("investigation-research", request);
    } else if (kind === "research") {
      const codexHost = require(path.join(scripts, "codex-delivery-host.cjs"));
      request = {
        scope: codexScope,
        role: "research",
        signals: {},
        context: {
          prompt: problem,
          investigation: { invId, sourceRevision, repository, policyHash: policy.POLICY_HASH, lines: lines.map((id) => ({ id })) },
        },
      };
      codexHost.validateArgs({ role: request.role, signals: request.signals, context: request.context });
    } else if (runtime === "claude") {
      request = { role: "gsd-planner", phase: 1, worktree: project, prompt: plannerPrompt, signals: {} };
      require(path.join(scripts, "claude-decompose-host.cjs")).canonicalRequest(request);
    } else {
      request = { scope: codexScope, gsd_role: "gsd-planner", prompt: plannerPrompt, signals: {} };
      require(path.join(scripts, "codex-decompose-host.cjs")).requestValue({ gsd_role: request.gsd_role, prompt: request.prompt, signals: request.signals });
    }
    process.stdout.write(JSON.stringify(request));
  ' "$SCRIPTS" > "$work/$1.request.json"
}

research_out="$work/research.jsonl"
host_request research 2>"$work/research.log" || fail_stage research "research request rejected by the host contract (see $work/research.log)" "" "research"
(
  cd "$project"
  if [ "$runtime" = "claude" ]; then
    node "$SCRIPTS/claude-investigation-host.cjs" --request-file "$work/research.request.json"
  else
    node "$SCRIPTS/codex-delivery-host.cjs" --args-file "$work/research.request.json"
  fi
) > "$research_out" 2>"$work/research.log" || fail_stage research "research host failed (see $work/research.log)" "" "research"
record_rung_stage research research "" "$(cat "$research_out")"

decompose_out="$work/decompose.jsonl"
host_request decompose 2>"$work/decompose.log" || fail_stage decompose "decompose request rejected by the host contract (see $work/decompose.log)" "" "decomposition"
(
  cd "$project"
  if [ "$runtime" = "claude" ]; then
    node "$SCRIPTS/claude-decompose-host.cjs" --request-file "$work/decompose.request.json"
  else
    node "$SCRIPTS/codex-decompose-host.cjs" --args-file "$work/decompose.request.json"
  fi
) > "$decompose_out" 2>"$work/decompose.log" || fail_stage decompose "decompose host failed (see $work/decompose.log)" "" "decomposition"
record_rung_stage decompose decomposition "" "$(cat "$decompose_out")"

graph_dir="$project/.planning/graph"
ticket="$(node -e '
  const g = require(process.argv[1]).tickets || {};
  const ids = Object.keys(g).sort();
  process.stdout.write(ids[0] || "");
' "$graph_dir/tickets.json" 2>/dev/null || true)"
[ -n "$ticket" ] || fail_stage executor "decompose produced no ticket in $graph_dir/tickets.json" "" "executor"
promoting="$(node -e '
  const t = require(process.argv[1]).tickets[process.argv[2]];
  const d = t.delivery || t;
  const why = [];
  if (d.human_checkpoint) why.push("human_checkpoint");
  if (d.critical) why.push("critical");
  if (d.risk === "high") why.push("risk: high");
  process.stdout.write(why.join(", "));
' "$graph_dir/tickets.json" "$ticket")"
[ -z "$promoting" ] || fail_stage executor "ticket $ticket carries $promoting, which promotes the executor rung" "" "executor"

launch_and_wait() {
  local role="$1" launched dispatch
  launched="$(cd "$project" && node "$SCRIPTS/deliver-dispatch.cjs" launch --runtime "$runtime" --ticket "$ticket" --role "$role" --graph-dir "$graph_dir")" || return 1
  dispatch="$(printf '%s' "$launched" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).dispatch_id)')"
  printf '%s\n' "$dispatch"
  node "$SCRIPTS/deliver-dispatch.cjs" wait --dispatch "$dispatch" --timeout-ms 3600000 > "$work/$role.wait.json" || return 1
}

executor_dispatch="$(launch_and_wait executor)" || fail_stage executor "executor dispatch failed" "${executor_dispatch:-}" "executor"
record_rung_stage executor executor "$executor_dispatch" "$(cat "$work/executor.wait.json")"

head_branch="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result || {};
  process.stdout.write(r.branch || r.head || "");
' "$work/executor.wait.json")"
[ -n "$head_branch" ] || fail_stage publish "executor result names no branch" "$executor_dispatch" "executor" null null
body_file="$work/pr-body.md"
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result || {};
  process.stdout.write(r.pr_body || r.body || "");
' "$work/executor.wait.json" > "$body_file"
title="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result || {};
  process.stdout.write(r.pr_title || r.title || "");
' "$work/executor.wait.json")"
[ -n "$title" ] || title="$(node "$SCRIPTS/pr-hygiene.cjs" format --project-root "$project" --repo "$repo" --type feat --subject "add greeting styles")"
base_branch="$(git -C "$project" rev-parse --abbrev-ref HEAD)"
node "$SCRIPTS/pr-hygiene.cjs" check --project-root "$project" --repo "$repo" --base "$base_branch" --head "$head_branch" \
  --title "$title" --body-file "$body_file" --json > "$work/hygiene.json" \
  || fail_stage publish "pr-hygiene check failed: $(cat "$work/hygiene.json")" "$executor_dispatch" "executor" null null
pr_url="$(cd "$project" && gh pr create --repo "$repo" --base "$base_branch" --head "$head_branch" --title "$title" --body-file "$body_file")" \
  || fail_stage publish "gh pr create failed" "$executor_dispatch" "executor" null null
pr_number="${pr_url##*/}"
node "$SCRIPTS/pr-ledger.cjs" record --ticket "$ticket" --number "$pr_number" --head "$head_branch" --repo "$repo" --graph-dir "$graph_dir" >/dev/null \
  || fail_stage publish "pr-ledger record failed for PR #$pr_number" "$executor_dispatch" "executor" null null
publish_rung="$(printf '%s' "$(cat "$work/executor.wait.json")" | receipt_rungs)"
stage_json publish true "PR #$pr_number recorded" "$executor_dispatch" executor "${publish_rung%%	*}" "${publish_rung#*	}"

sentinel_dispatch="$(launch_and_wait pr-sentinel)" || fail_stage sentinel "sentinel dispatch failed" "${sentinel_dispatch:-}" "pr-sentinel"
record_rung_stage sentinel pr-sentinel "$sentinel_dispatch" "$(cat "$work/pr-sentinel.wait.json")"
