SHELL := /bin/bash

GSD_CORE_VERSION ?= latest

.PHONY: package-shipyard-codex install-shipyard-marketplace-codex install-shipyard-marketplace-claude
package-shipyard-codex:
	source scripts/ensure-gsd-core.sh --library && validate_isolated_node_options && node scripts/package-shipyard-codex.cjs

install-shipyard-marketplace-codex:
	bash scripts/ensure-gsd-core.sh --launch-marketplace codex

install-shipyard-marketplace-claude:
	bash scripts/ensure-gsd-core.sh --launch-marketplace claude

.PHONY: install-shipyard-codex install-shipyard-claude-hook remove-shipyard-claude-hook \
        install-shipyard-claude-statusline remove-shipyard-claude-statusline test-statusline \
        install-shipyard-capability ensure-gsd-core-claude ensure-gsd-core-codex \
        gsd-tune gsd-tune-apply doctor \
        test test-fast test-unit test-graph test-worktree test-worktree-gates \
        test-sentinel test-docs test-hooks test-comment-policy test-codex-shipyard test-releases

# Install or refresh the conveyor on a host OpenAI Codex CLI setup.
# Set SHIPYARD_CODEX_PHASE=1 for investigate/decompose only.
install-shipyard-codex: package-shipyard-codex
	bash scripts/ensure-gsd-core.sh --launch-marketplace codex --source "$(CURDIR)"

# Install or refresh the host Claude Code hooks that inject routing and enforce
# the delivery stop gate.
install-shipyard-claude-hook:
	./scripts/install-shipyard-claude-hook.sh

remove-shipyard-claude-hook:
	./scripts/install-shipyard-claude-hook.sh --remove

install-shipyard-claude-statusline:
	./scripts/install-shipyard-claude-statusline.sh

remove-shipyard-claude-statusline:
	./scripts/install-shipyard-claude-statusline.sh --remove

# Install the shared GSD capability for a host runtime. Codex installation
# already performs this step; this target is useful for Claude Code.
install-shipyard-capability:
	./scripts/install-shipyard-capability.sh claude

ensure-gsd-core-claude:
	GSD_CORE_VERSION="$(GSD_CORE_VERSION)" ./scripts/ensure-gsd-core.sh claude

ensure-gsd-core-codex:
	GSD_CORE_VERSION="$(GSD_CORE_VERSION)" ./scripts/ensure-gsd-core.sh codex

# Report (or apply) the GSD settings a conveyor project needs on this runtime.
# Run from the target project, not from this checkout.
gsd-tune:
	node plugins/delivery-pipeline/scripts/gsd-tune.cjs

gsd-tune-apply:
	node plugins/delivery-pipeline/scripts/gsd-tune.cjs --apply

doctor:
	node scripts/shipyard-doctor.cjs

# Fast, deterministic checks for every local edit and every pull request.
test-fast: test-unit test-graph test-worktree test-worktree-gates test-gsd-sync test-sentinel test-docs test-hooks test-comment-policy test-model-ladder-runtime test-statusline

# The complete host-side suite. The Codex smoke additionally exercises the
# network-backed gsd-core conversion and therefore stays out of test-fast.
test: test-fast test-codex-shipyard test-releases

test-unit:
	./tests/unit/run.sh

test-graph:
	./tests/smoke/graph-validator-smoke.sh

test-worktree:
	./tests/smoke/worktree-smoke.sh

test-worktree-gates:
	./tests/smoke/worktree-gates-smoke.sh

test-gsd-sync:
	node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json

test-model-ladder-runtime:
	./tests/smoke/model-ladder-runtime-smoke.sh

test-sentinel:
	./tests/smoke/sentinel-smoke.sh

test-docs:
	./tests/smoke/docs-smoke.sh

test-hooks:
	./tests/smoke/claude-hook-smoke.sh

test-statusline:
	./tests/smoke/claude-statusline-smoke.sh

test-comment-policy:
	node plugins/delivery-pipeline/scripts/publish-gate.cjs --base "$(or $(COMMENT_POLICY_BASE),origin/main)" --working-tree --json

test-codex-shipyard:
	./tests/smoke/codex-shipyard-smoke.sh

test-releases:
	./tests/smoke/release-notes-smoke.sh

.PHONY: capture-fixtures test-live release refresh-runtime-digests untrack-planning \
        install-shipyard-dogfood-claude install-shipyard-dogfood-codex

capture-fixtures:
	@test -n "$(BOUNDARY)" || { echo "capture-fixtures: set BOUNDARY (claude-stream or codex-agent-stream)" >&2; exit 1; }
	node scripts/capture-boundary-fixtures.cjs --boundary "$(BOUNDARY)"

test-live:
	bash tests/live/live-round.sh --runtime claude
	bash tests/live/live-round.sh --runtime codex

release:
	@test -n "$(VERSION)" || { echo "release: set VERSION (e.g. VERSION=1.2.3)" >&2; exit 1; }
	bash scripts/release.sh "$(VERSION)"

refresh-runtime-digests:
	node scripts/refresh-runtime-digests.cjs

dogfood_root = $(shell source scripts/ensure-gsd-core.sh --library && validate_isolated_node_options && SHIPYARD_DOGFOOD_RUNTIME=$(1) node -e "const c=require('node:crypto');const fs=require('node:fs');const os=require('node:os');const p=require('node:path');const r=fs.realpathSync(process.cwd());const d=c.createHash('sha256').update(r).digest('hex').slice(0,16);const b=process.env.XDG_STATE_HOME||p.join(os.homedir(),'.local','state');process.stdout.write(p.join(b,'shipyard','dogfood',process.env.SHIPYARD_DOGFOOD_RUNTIME,d));")

install-shipyard-dogfood-claude:
	./scripts/install-shipyard-claude-hook.sh --dogfood-root "$(or $(DOGFOOD_ROOT),$(call dogfood_root,claude))"

install-shipyard-dogfood-codex:
	./scripts/install-shipyard-codex.sh --dogfood-root "$(or $(DOGFOOD_ROOT),$(call dogfood_root,codex))"

untrack-planning:
ifeq ($(CONFIRM),untrack-planning)
	node plugins/delivery-pipeline/scripts/planning-untrack.cjs --project-root "$(CURDIR)" --apply --confirm untrack-planning
else
	node plugins/delivery-pipeline/scripts/planning-untrack.cjs --project-root "$(CURDIR)"
endif
