#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec node -e '
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SCRIPT_DIR = process.argv[1];
const PUBLISH_GATE = process.env.SHIPYARD_PUBLISH_GATE
  || path.join(SCRIPT_DIR, "shipyard-stop-gate", "publish-gate.cjs");

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const command = String(payload.tool_input?.command || "");
  const cwd = String(payload.cwd || process.cwd());

  const hasPush = /(?:^|[;&|]\s*)git(?:\s+-C\s+(?:"[^"]+"|\x27[^\x27]+\x27|\S+))?\s+push(?:\s|$)/.test(command);
  if (!hasPush) process.exit(0);

  // @invariant: strip trailing ;/&/| — a bare path capture runs up to whitespace and can swallow one
  const stripSeparators = (value) => value.replace(/[;&|]+$/, "");
  const namedCandidate = (re) => {
    const m = re.exec(command);
    if (!m) return null;
    const value = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : stripSeparators(m[3]));
    return { index: m.index, value };
  };
  const cFlag = namedCandidate(/(?:^|[;&|]\s*)git\s+-C\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|(\S+))/);
  const cdTo = namedCandidate(/(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|(\S+))/);
  const named = [cFlag, cdTo].filter(Boolean).sort((a, b) => a.index - b.index)[0] || null;

  const target = named ? named.value : cwd;
  const absoluteTarget = path.isAbsolute(target) ? target : path.resolve(cwd, target);

  let toplevel = null;
  try {
    toplevel = execFileSync("git", ["-C", absoluteTarget, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}

  if (!toplevel) {
    process.stderr.write(
      "shipyard pre-push: cannot resolve \"" + target + "\" to a git worktree" +
      (named ? " (the command names a target git cannot follow — no expansion, no such path, or not a worktree)" : "") +
      " — retry the push as: git -C <absolute worktree> push\n"
    );
    process.exit(2);
  }

  if (!fs.existsSync(PUBLISH_GATE)) {
    process.stderr.write("shipyard pre-push: publish gate is not installed\n");
    process.exit(2);
  }

  let ticket = "publish";
  try {
    const branch = execFileSync("git", ["-C", toplevel, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = /^ticket\/(T-\d{2}-\d{2})(?:-.*)?$/.exec(branch);
    if (m) ticket = m[1];
  } catch {}

  const gate = spawnSync(process.execPath, [PUBLISH_GATE, "--worktree", toplevel, "--working-tree", "--ticket", ticket], {
    stdio: "inherit",
  });
  if (gate.status !== 0) {
    process.stderr.write("shipyard pre-push: push blocked until publish-gate passes\n");
    process.exit(2);
  }
});
' -- "$SCRIPT_DIR"
