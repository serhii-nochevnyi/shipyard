SHELL := /bin/bash

GSD_CORE_VERSION ?= latest

.PHONY: install-shipyard-codex install-shipyard-claude-hook remove-shipyard-claude-hook \
        install-shipyard-capability ensure-gsd-core-claude ensure-gsd-core-codex \
        gsd-tune gsd-tune-apply doctor \
        test test-fast test-unit test-graph test-worktree test-worktree-gates \
        test-sentinel test-docs test-hooks test-codex-shipyard test-releases

# Install or refresh the conveyor on a host OpenAI Codex CLI setup.
# Set SHIPYARD_CODEX_PHASE=1 for investigate/decompose only.
install-shipyard-codex:
	./scripts/install-shipyard-codex.sh

# Install or refresh the host Claude Code hooks that inject routing and enforce
# the delivery stop gate.
install-shipyard-claude-hook:
	./scripts/install-shipyard-claude-hook.sh

remove-shipyard-claude-hook:
	./scripts/install-shipyard-claude-hook.sh --remove

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
test-fast: test-unit test-graph test-worktree test-worktree-gates test-sentinel test-docs test-hooks

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

test-sentinel:
	./tests/smoke/sentinel-smoke.sh

test-docs:
	./tests/smoke/docs-smoke.sh

test-hooks:
	./tests/smoke/claude-hook-smoke.sh

test-codex-shipyard:
	./tests/smoke/codex-shipyard-smoke.sh

test-releases:
	./tests/smoke/release-notes-smoke.sh
