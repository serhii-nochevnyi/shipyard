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

if [ "$runtime" = codex ]; then
  for name in $(env | grep -oE '^(CLAUDECODE|CLAUDE_CODE_[A-Z_]*)=' | tr -d '='); do unset "$name"; done
fi
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
    const fs = require("fs");
    const path = require("path");
    const raw = fs.readFileSync(0, "utf8").split("\n").filter((l) => l.trim());
    let r = null;
    for (const line of raw) { try { r = find(JSON.parse(line)) || r; } catch {} }
    if (!r) {
      const text = raw.join("\n");
      const ids = new Set(text.match(/dispatch-[a-z0-9]+-[0-9a-f-]{36}/g) || []);
      for (const ref of text.match(/"artifact_ref":"([^"]+)"/g) || []) {
        try { for (const id of fs.readFileSync(ref.slice(16, -1), "utf8").match(/dispatch-[a-z0-9]+-[0-9a-f-]{36}/g) || []) ids.add(id); } catch {}
      }
      const state = path.join(process.env.HOME || "", ".local", "state", "shipyard");
      for (const runtime of ["codex", "claude"]) {
        let stores = [];
        try { stores = fs.readdirSync(path.join(state, runtime)); } catch {}
        for (const store of stores) {
          for (const id of ids) {
            const dir = path.join(state, runtime, store, "receipts");
            let names = [];
            try { names = fs.readdirSync(dir).filter((n) => n.startsWith("record-")); } catch {}
            for (const name of names) {
              try {
                const body = fs.readFileSync(path.join(dir, name), "utf8");
                if (body.includes(id)) r = find(JSON.parse(body)) || r;
              } catch {}
            }
          }
        }
      }
    }
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
doctor_args=()
[ -n "${CODEX_HOME:-}" ] && doctor_args+=(--codex-home "$CODEX_HOME")
claude_profile="${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-}}"
[ -n "$claude_profile" ] && doctor_args+=(--claude-home "$claude_profile")
node "$ROOT/scripts/shipyard-doctor.cjs" ${doctor_args[@]+"${doctor_args[@]}"} >/dev/null 2>&1 || fail_stage preconditions "installed hosts are not the release layout (shipyard-doctor failed)"

for n in $(gh pr list --repo "$repo" --state open --json number -q '.[].number' 2>/dev/null); do
  gh pr close "$n" --repo "$repo" --delete-branch >/dev/null 2>&1 || true
done
live_default="$(gh repo view "$repo" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
for b in $(gh api "repos/$repo/branches" --paginate -q '.[].name' 2>/dev/null); do
  [ "$b" = "${live_default:-main}" ] || gh api -X DELETE "repos/$repo/git/refs/heads/$b" >/dev/null 2>&1 || true
done
cp -R "$FIXTURE" "$project"
mv "$project/planning" "$project/.planning"
printf '.planning/\n.shipyard/\n' >> "$project/.git-info-exclude"
(
  cd "$project"
  git init -q
  mkdir -p .git/info .planning/graph
  mv .git-info-exclude .git/info/exclude
  git add -A
  git commit -q -m "chore: initial import"
  default_branch="$(gh repo view "$repo" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
  git branch -M "${default_branch:-main}"
  git remote add origin "https://github.com/$repo.git"
  git push -q --force origin "HEAD:${default_branch:-main}"
) || fail_stage push "could not push the fixture to $repo"
stage_json push true "pushed fixture to $repo" "" "" null null

(
  cd "$project"
  node "$SCRIPTS/adr-bootstrap.cjs" --adr .planning/architecture/ADR-001-greeting-formats.md --phase 1 --json
  node "$SCRIPTS/gsd-tune.cjs" --apply --runtime "$runtime"
) > "$work/bootstrap.log" 2>&1 || fail_stage bootstrap "adr-bootstrap or gsd-tune --apply failed (see $work/bootstrap.log)"
stage_json bootstrap true "GSD project bootstrapped with the delivery-rules projection" "" "" null null

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
    const plannerPrompt = "Decompose the accepted ADR " + adr + " into phase 1 plans in .planning/phases/01-greeting-formats/, following its CONTEXT.md."
      + " Write one PLAN.md per ticket (01-01-PLAN.md, 01-02-PLAN.md). Each has YAML frontmatter with phase: 1, plan, title, type: implementation, wave, depends_on, files_modified, requirements"
      + " and a delivery block (ticket: T-01-<MM>, risk: low, human_checkpoint: false), then these Markdown sections as ## headings with bullet lists:"
      + " Goal, Context (Reads), Scope, Out of scope, Acceptance criteria, Test strategy, Verification commands."
      + " Verification commands are scoped to files_modified and runnable offline. For the code ticket, use node --test tests/greeting.test.cjs"
      + ". Each verification command bullet must be an entire bare line containing only a dash, a space and the exact command in backticks: - `node --test tests/greeting.test.cjs`. Put explanations outside command bullets."
      + " Put all acceptance assertions in that owned test file. The fixture approves only node --test and node -e sandbox prefixes;"
      + " no git, npm, shell pipelines or shell expansion."
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
      request = { role: "gsd-planner", phase: 1, worktree: project, prompt: plannerPrompt, signals: {}, adr };
      require(path.join(scripts, "claude-decompose-host.cjs")).canonicalRequest(request);
    } else {
      request = { scope: codexScope, gsd_role: "gsd-planner", prompt: plannerPrompt, signals: {}, adr };
      require(path.join(scripts, "codex-decompose-host.cjs")).requestValue({ gsd_role: request.gsd_role, prompt: request.prompt, signals: request.signals, adr: request.adr });
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
(cd "$project" && node "$SCRIPTS/validate-graph.cjs") > "$work/validate-graph.log" 2>&1 \
  || fail_stage decompose "validate-graph refused the decomposed plans (see $work/validate-graph.log)" "" "decomposition"
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

(cd "$project" && node "$SCRIPTS/state-sync.cjs") > "$work/state-sync.log" 2>&1 \
  || fail_stage executor "state-sync failed (see $work/state-sync.log)" "" "executor"
epic_branch="$(node -e 'const e = Object.values(require(process.argv[1]).epics || {})[0]; process.stdout.write((e && e.branch) || "")' "$graph_dir/tickets.json")"
[ -n "$epic_branch" ] || fail_stage executor "tickets.json names no epic branch" "" "executor"
(cd "$project" && bash "$SCRIPTS/epic-branch.sh" ensure "$epic_branch") > "$work/epic.log" 2>&1 \
  || fail_stage executor "epic-branch ensure $epic_branch failed (see $work/epic.log)" "" "executor"
(cd "$project" && node "$SCRIPTS/state-sync.cjs") >> "$work/state-sync.log" 2>&1 \
  || fail_stage executor "state-sync failed (see $work/state-sync.log)" "" "executor"
read -r ticket_branch ticket_base < <(node -e 'const t = require(process.argv[1]).tickets[process.argv[2]]; process.stdout.write(t.branch + " " + t.pr_base + "\n")' "$graph_dir/tickets.json" "$ticket")
ticket_worktree="$(cd "$project" && bash "$SCRIPTS/ticket-worktree.sh" create "$ticket" "$ticket_branch" "$ticket_base" 2>"$work/worktree.log" | tail -1)" \
  || fail_stage executor "ticket-worktree create failed (see $work/worktree.log)" "" "executor"
[ -d "$ticket_worktree" ] || fail_stage executor "ticket-worktree create returned no worktree (see $work/worktree.log)" "" "executor"

verification_preflight() {
  node -e '
    const fs = require("fs"), path = require("path");
    const [scripts, project, graph, ticket, repo] = process.argv.slice(1);
    try {
      const row = JSON.parse(fs.readFileSync(path.join(graph, "tickets.json"), "utf8")).tickets[ticket];
      if (typeof row.plan !== "string" || !row.plan || path.isAbsolute(row.plan) || row.plan.split("/").includes("..")) {
        throw new Error("selected ticket has no safe relative PLAN path");
      }
      const plan = fs.readFileSync(path.resolve(project, row.plan), "utf8");
      const config = require(path.join(scripts, "pipeline-config.cjs"));
      const loaded = config.loadConfig(project);
      if (!loaded.valid) throw new Error("invalid verification configuration: " + loaded.error.message);
      const verification = require(path.join(scripts, "host-verification.cjs"));
      if (!verification.planCommands(plan).length) throw new Error("selected PLAN has no verification commands");
      const assigned = verification.assignPlan(plan, config.repoValue(loaded, "verification_commands", repo));
      if (!assigned || !assigned.length) throw new Error("selected PLAN has no approved verification commands");
      process.stdout.write(JSON.stringify({ plan: row.plan, commands: assigned }));
    } catch (error) { console.error(String(error.message).slice(0, 1000)); process.exit(1); }
  ' "$SCRIPTS" "$project" "$graph_dir" "$ticket" "$repo"
}

verification_preflight > "$work/verification-preflight.json" 2> "$work/verification-preflight.log" \
  || fail_stage executor "PLAN admission failed (see $work/verification-preflight.log)" "" "executor"

ticket_base="$(node "$SCRIPTS/ticket-base.cjs" resolve --graph-dir "$graph_dir" --ticket "$ticket" --requested-base "$ticket_base")" \
  || fail_stage executor "cannot resolve canonical ticket PR base" "" "executor"

executor_completion() {
  node -e '
    const fs = require("fs"), path = require("path");
    const { execFileSync } = require("child_process");
    const [scripts, file, runtime, ticket, branch, base, worktree, start, admitted] = process.argv.slice(1);
    const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const nonempty = v => typeof v === "string" && v.length > 0;
    const git = (...args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
    const identity = value => {
      requireValue(object(value), "missing native identity");
      for (const [key, expected] of [["runtime", runtime], ["role", "executor"], ["ticket", ticket]]) {
        requireValue(value[key] === undefined || value[key] === expected, "conflicting " + key);
      }
    };
    try {
      const wait = JSON.parse(fs.readFileSync(file, "utf8"));
      requireValue(object(wait) && wait.status === "exited-ok" && (wait.exit_code === undefined || wait.exit_code === 0), "executor transport failed");
      identity(wait);
      let result;
      if (runtime === "claude") {
        requireValue(Array.isArray(wait.result) && wait.result.length === 1, "expected one Claude ticket completion");
        result = wait.result[0];
        requireValue(object(result) && result.id === ticket && result.status === "committed", "Claude executor did not commit selected ticket");
        requireValue(result.branch === branch, "Claude completion branch mismatch");
        const artifact = result.artifact;
        requireValue(nonempty(result.artifact_ref) && nonempty(result.artifact_digest) && object(result.evidence_index)
          && object(artifact) && artifact.ref === result.artifact_ref && artifact.digest === result.artifact_digest
          && object(artifact.envelope) && artifact.envelope.outcome === "committed"
          && object(artifact.evidence_index), "Claude validated artifact references missing");
        identity(artifact.envelope);
      } else {
        result = wait.result;
        requireValue(object(result), "expected Codex dispatch completion");
        requireValue(result.status === undefined || result.status === "committed", "Codex executor failure status");
        const artifact = result.artifact;
        requireValue(object(artifact) && artifact.schema === "shipyard.codex-delivery-artifact.v1"
          && artifact.status === "committed" && artifact.ticket === ticket && nonempty(artifact.commit)
          && Array.isArray(artifact.changed) && artifact.changed.length > 0
          && artifact.changed.every(nonempty), "Codex committed artifact missing or conflicting");
      }
      identity(result);
      requireValue(object(result.receipt), "native executor receipt missing");
      identity(result.receipt);
      requireValue(result.branch === undefined || result.branch === branch, "completion branch mismatch");
      requireValue(git("symbolic-ref", "--short", "HEAD") === branch, "actual ticket branch mismatch");
      const head = git("rev-parse", "HEAD^{commit}");
      requireValue(head !== start, "executor HEAD is unchanged");
      git("merge-base", "--is-ancestor", start, head);
      let baseHead;
      try { baseHead = git("rev-parse", "--verify", "refs/remotes/origin/" + base + "^{commit}"); }
      catch { baseHead = git("rev-parse", "--verify", base + "^{commit}"); }
      requireValue(baseHead !== head, "ticket has no commits beyond PR base");
      git("merge-base", "--is-ancestor", baseHead, head);
      const { changedProductPaths } = require(path.join(scripts, "development-artifacts.cjs"));
      requireValue(changedProductPaths(start, head, worktree).length > 0
        && changedProductPaths(baseHead, head, worktree).length > 0, "executor has no new committed product delta");
      requireValue(result.commit === undefined || result.commit === head, "completion commit mismatch");
      if (runtime === "codex") requireValue(result.artifact.commit === head, "Codex artifact commit mismatch");
      if (admitted) {
        const prior = JSON.parse(fs.readFileSync(admitted, "utf8"));
        requireValue(prior.head === head && prior.branch === branch && prior.base === baseHead, "publication revision changed after admission");
      }
      process.stdout.write(JSON.stringify({ result, head, branch, base: baseHead }));
    } catch (error) { console.error(String(error.message).slice(0, 1000)); process.exit(1); }
  ' "$SCRIPTS" "$work/executor.wait.json" "$runtime" "$ticket" "$ticket_branch" "$ticket_base" "$ticket_worktree" "$executor_start" "${1:-}"
}

launch_and_wait() {
  local role="$1" launched dispatch
  local from="$project"
  [ "$role" = executor ] && from="$ticket_worktree"
  local smoke=""
  [ "$role" = pr-sentinel ] && [ "$runtime" = claude ] && smoke="read-only"
  launched="$(cd "$from" && SHIPYARD_CLAUDE_ROLE_SMOKE="$smoke" node "$SCRIPTS/deliver-dispatch.cjs" launch --runtime "$runtime" --ticket "$ticket" --role "$role" --graph-dir "$graph_dir")" || return 1
  dispatch="$(printf '%s' "$launched" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).dispatch_id)')"
  printf '%s\n' "$dispatch"
  node "$SCRIPTS/deliver-dispatch.cjs" wait --dispatch "$dispatch" --timeout-ms 3600000 > "$work/$role.wait.json" || return 1
}

executor_start="$(git -C "$ticket_worktree" rev-parse --verify 'HEAD^{commit}')" \
  || fail_stage executor "cannot capture executor start HEAD" "" "executor"
(git -C "$ticket_worktree" rev-parse --verify "refs/remotes/origin/$ticket_base^{commit}" 2>/dev/null \
  || git -C "$ticket_worktree" rev-parse --verify "$ticket_base^{commit}") > "$work/executor-base.txt" 2>&1 \
  || fail_stage executor "cannot resolve ticket PR base (see $work/executor-base.txt)" "" "executor"
executor_dispatch="$(launch_and_wait executor)" || fail_stage executor "executor dispatch failed" "${executor_dispatch:-}" "executor"
executor_completion > "$work/executor-admitted.json" 2> "$work/executor-admission.log" \
  || fail_stage executor "native completion or committed revision refused (see $work/executor-admission.log)" "$executor_dispatch" "executor"

head_branch="$ticket_branch"
body_file="$work/pr-body.md"
node -e '
  const fs = require("fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  const body = r.pr_body || r.body || (r.prBodyPath && fs.existsSync(r.prBodyPath) ? fs.readFileSync(r.prBodyPath, "utf8") : "");
  process.stdout.write(body);
' "$work/executor-admitted.json" > "$body_file"
if [ ! -s "$body_file" ]; then
  ticket_title="$(node -e 'process.stdout.write(String(require(process.argv[1]).tickets[process.argv[2]].title || ""))' "$graph_dir/tickets.json" "$ticket")"
  printf '## Summary\n\n%s\n\n## Test evidence\n\nThe repository CI runs `make test` on this pull request.\n' "$ticket_title" > "$body_file"
fi
title="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result;
  process.stdout.write(r.pr_title || r.title || "");
' "$work/executor-admitted.json")"
[ -n "$title" ] || title="$(node "$SCRIPTS/pr-hygiene.cjs" format --project-root "$project" --repo "$repo" --type feat --subject "add greeting styles")"
base_branch="$ticket_base"
executor_completion "$work/executor-admitted.json" > "$work/executor-publication.json" 2> "$work/executor-publication.log" \
  || fail_stage executor "publication revision recheck failed (see $work/executor-publication.log)" "$executor_dispatch" "executor"
record_rung_stage executor executor "$executor_dispatch" "$(cat "$work/executor.wait.json")"
git -C "$ticket_worktree" push -q -u origin "$head_branch" > "$work/push.log" 2>&1 \
  || fail_stage publish "git push of $head_branch failed (see $work/push.log)" "$executor_dispatch" "executor" null null
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

sleep 20
timeout_at=$((SECONDS + 900))
until gh pr checks "$pr_number" --repo "$repo" > "$work/checks.txt" 2>&1 && ! grep -qE $'\t(pending|queued|in_progress)\t' "$work/checks.txt"; do
  [ "$SECONDS" -lt "$timeout_at" ] || fail_stage sentinel "CI on PR #$pr_number did not finish in 15 minutes (see $work/checks.txt)" "" "pr-sentinel"
  grep -q "no checks reported" "$work/checks.txt" && [ "$SECONDS" -gt $((timeout_at - 780)) ] && fail_stage sentinel "no CI checks ran on PR #$pr_number" "" "pr-sentinel"
  sleep 20
done
grep -qE $'\tfail\t' "$work/checks.txt" && fail_stage sentinel "CI failed on PR #$pr_number (see $work/checks.txt)" "" "pr-sentinel"
(cd "$project" && node "$SCRIPTS/state-sync.cjs") >> "$work/state-sync.log" 2>&1 \
  || fail_stage sentinel "state-sync failed (see $work/state-sync.log)" "" "pr-sentinel"
sentinel_dispatch="$(launch_and_wait pr-sentinel)" || fail_stage sentinel "sentinel dispatch failed" "${sentinel_dispatch:-}" "pr-sentinel"
record_rung_stage sentinel pr-sentinel "$sentinel_dispatch" "$(cat "$work/pr-sentinel.wait.json")"
