SHELL := /bin/bash

BASE_IMAGE ?= claude-shipyard-base:test
DEV_IMAGE ?= claude-shipyard:test
GSD_CORE_VERSION ?= 1.7.0
KARPATHY_SKILLS_REPO ?= https://github.com/multica-ai/andrej-karpathy-skills
KARPATHY_SKILLS_REF ?= 2c606141936f1eeef17fa3043a72095b4765b9c2
KARPATHY_SKILLS_STAGING ?= .build/karpathy-skills
CLAUDE_CODE_VERSION ?= 2.1.200
CONTEXT7_MCP_VERSION ?= 2.2.5
TYPESCRIPT_LANGUAGE_SERVER_VERSION ?= 5.2.0
TYPESCRIPT_VERSION ?= 6.0.3
LOCAL_SSH_DIR ?= $(HOME)/.ssh
SSH_STAGING_DIR ?= .build/ssh-config
# Git identity baked into the image's /home/dev/.gitconfig. REQUIRED, with no
# default on purpose: a default here ends up authoring every commit made inside
# every container built from this repo as whoever happened to write it down.
GIT_USER_NAME ?=
GIT_USER_EMAIL ?=
WORKSPACE_DIR ?= $(CURDIR)/workspace
HOME_CACHE_DIR ?= $(CURDIR)/.cache-home
CLAUDE_STATE_DIR ?= $(CURDIR)/.claude-state
# Legacy single-file credentials location, migrated into CLAUDE_STATE_DIR once.
# Honours a CLAUDE_CREDENTIALS_FILE left over in an existing .env so upgrading
# does not lose an already-authenticated Atlassian session.
LEGACY_CRED_FILE ?= $(if $(CLAUDE_CREDENTIALS_FILE),$(CLAUDE_CREDENTIALS_FILE),$(CURDIR)/.claude-credentials.json)

REPO ?=
WORKSPACE_SUBDIR ?=
DIR ?=

COMPOSE_ENV = \
  BASE_IMAGE=$(BASE_IMAGE) \
  DEV_IMAGE=$(DEV_IMAGE) \
  WORKSPACE_DIR="$(WORKSPACE_DIR)" \
  HOME_CACHE_DIR="$(HOME_CACHE_DIR)" \
  CLAUDE_STATE_DIR="$(CLAUDE_STATE_DIR)"

.PHONY: build-base require-git-identity sync-ssh-config sync-karpathy-skills build-dev-image ensure-image runtime-dirs \
        bootstrap-atlassian-oauth run-docker up dev claude shell clone deploy-k8s \
        install-shipyard-codex install-shipyard-claude-hook remove-shipyard-claude-hook \
        install-shipyard-capability clean-cache \
        test test-base test-overlay test-runtime test-k8s test-docs test-ssh-sync test-mcp-runtime \
        test-codex-shipyard test-unit test-graph test-worktree test-fast

require-git-identity:
	@if [ -z "$(GIT_USER_NAME)" ] || [ -z "$(GIT_USER_EMAIL)" ]; then \
	  echo "GIT_USER_NAME and GIT_USER_EMAIL are required — they become the git identity of every commit made inside the container." >&2; \
	  echo "" >&2; \
	  echo "  make build-base GIT_USER_NAME=\"Your Name\" GIT_USER_EMAIL=you@example.com" >&2; \
	  echo "" >&2; \
	  echo "Or take them from your host git config:" >&2; \
	  echo "  make build-base GIT_USER_NAME=\"\$$(git config --global user.name)\" GIT_USER_EMAIL=\"\$$(git config --global user.email)\"" >&2; \
	  echo "" >&2; \
	  echo "Or set them once in .env (the Makefile does NOT read .env — export them, or put them in your shell profile)." >&2; \
	  exit 1; \
	fi

build-base: require-git-identity sync-ssh-config
	docker build -f Dockerfile.base -t $(BASE_IMAGE) \
	  --build-arg GIT_USER_NAME='$(GIT_USER_NAME)' \
	  --build-arg GIT_USER_EMAIL='$(GIT_USER_EMAIL)' \
	  --build-arg CLAUDE_CODE_VERSION='$(CLAUDE_CODE_VERSION)' \
	  --build-arg CONTEXT7_MCP_VERSION='$(CONTEXT7_MCP_VERSION)' \
	  --build-arg TYPESCRIPT_LANGUAGE_SERVER_VERSION='$(TYPESCRIPT_LANGUAGE_SERVER_VERSION)' \
	  --build-arg TYPESCRIPT_VERSION='$(TYPESCRIPT_VERSION)' \
	  .

sync-ssh-config:
	mkdir -p .build
	LOCAL_SSH_DIR="$(LOCAL_SSH_DIR)" ./scripts/sync-local-ssh-config.sh "$(SSH_STAGING_DIR)"

sync-karpathy-skills:
	mkdir -p .build
	KARPATHY_SKILLS_REPO="$(KARPATHY_SKILLS_REPO)" \
	KARPATHY_SKILLS_REF="$(KARPATHY_SKILLS_REF)" \
	./scripts/sync-karpathy-skills.sh "$(KARPATHY_SKILLS_STAGING)"

build-dev-image: sync-karpathy-skills
	docker build -f Dockerfile -t $(DEV_IMAGE) \
	  --build-arg BASE_IMAGE=$(BASE_IMAGE) \
	  --build-arg KARPATHY_SKILLS_DIR=$(KARPATHY_SKILLS_STAGING) \
	  --build-arg GSD_CORE_VERSION=$(GSD_CORE_VERSION) \
	  .

# Compose declares a `build:` section, so a bare `docker compose up` would try to
# build — and fail on the un-staged .build/ context. Guard the run targets: build
# the images when the overlay is missing rather than surfacing a COPY error.
ensure-image:
	@if ! docker image inspect $(DEV_IMAGE) >/dev/null 2>&1; then \
	  echo "image $(DEV_IMAGE) is missing — building it first (this is slow)"; \
	  $(MAKE) build-base build-dev-image; \
	fi

# Everything the compose mounts need to exist BEFORE the container starts, or
# Docker creates root-owned directories in their place.
runtime-dirs: sync-ssh-config
	mkdir -p "$(WORKSPACE_DIR)" "$(HOME_CACHE_DIR)" "$(CLAUDE_STATE_DIR)"
	mkdir -p "$(HOME)/.config/gh"
	@if [ -s "$(LEGACY_CRED_FILE)" ] && [ ! -s "$(CLAUDE_STATE_DIR)/credentials.json" ]; then \
	  echo "migrating $(LEGACY_CRED_FILE) -> $(CLAUDE_STATE_DIR)/credentials.json"; \
	  cp "$(LEGACY_CRED_FILE)" "$(CLAUDE_STATE_DIR)/credentials.json"; \
	  chmod 600 "$(CLAUDE_STATE_DIR)/credentials.json"; \
	fi

bootstrap-atlassian-oauth:
	./scripts/bootstrap-atlassian-rovo-oauth.sh

run-docker: ensure-image runtime-dirs
	$(COMPOSE_ENV) docker compose run --rm dev

up: ensure-image runtime-dirs
	$(COMPOSE_ENV) docker compose up -d

dev:
	./scripts/dev.sh

claude: up
	docker compose exec dev bash -lc 'target="/workspace/$(DIR)"; cd "$$target" 2>/dev/null || target=/workspace; cd "$$target"; shipyard-trust "$$target" >/dev/null 2>&1 || true; exec claude --dangerously-skip-permissions'

shell: up
	docker compose exec dev bash -lc 'target="/workspace/$(DIR)"; cd "$$target" 2>/dev/null || target=/workspace; cd "$$target"; shipyard-trust "$$target" >/dev/null 2>&1 || true; exec bash'

clone: up
	@test -n "$(REPO)" || { echo "usage: make clone REPO=<git-url> [WORKSPACE_SUBDIR=name]"; exit 1; }
	docker compose exec dev bash -lc 'set -e; cd /workspace; git clone "$(REPO)" $(WORKSPACE_SUBDIR); \
	  name="$(WORKSPACE_SUBDIR)"; [ -n "$$name" ] || name="$$(basename "$(REPO)" .git)"; \
	  shipyard-trust "/workspace/$$name" >/dev/null 2>&1 || true'

# MCP server logs under .cache-home grow without bound (they are per-session).
clean-cache:
	find "$(HOME_CACHE_DIR)" -name '*.jsonl' -mtime +7 -delete 2>/dev/null || true
	@echo "pruned MCP logs older than 7 days from $(HOME_CACHE_DIR)"

deploy-k8s:
	kubectl apply -f k8s/configmap.yaml
	kubectl apply -f k8s/pvc.yaml
	kubectl apply -f k8s/service.yaml
	kubectl apply -f k8s/statefulset.yaml

# Install the shipyard delivery conveyor onto a host OpenAI Codex CLI setup
# (generates Codex-native artifacts from the canonical Claude plugin, registers
# the runtime-agnostic GSD capability). Requires gsd-core installed for Codex.
# Override phase with SHIPYARD_CODEX_PHASE=1 for investigate+decompose only.
install-shipyard-codex:
	./scripts/install-shipyard-codex.sh

# The Claude-side counterpart: a UserPromptSubmit hook in the HOST's user
# settings. (Inside the container the same hook is baked in at build time.)
install-shipyard-claude-hook:
	./scripts/install-shipyard-claude-hook.sh

# Install/refresh the GSD capability (Gate 2 + UAT gates) for a host runtime.
# `install-shipyard-codex` already does this for Codex; host Claude Code had no
# installer at all, which is how a half-installed gate (validator without its
# frontmatter.cjs sibling) could sit there unnoticed.
install-shipyard-capability:
	./scripts/install-shipyard-capability.sh claude

remove-shipyard-claude-hook:
	./scripts/install-shipyard-claude-hook.sh --remove

# Everything that needs neither Docker nor the network — run this constantly.
test-fast: test-unit test-graph test-worktree test-sentinel test-docs test-ssh-sync

# The full suite (slow: builds images, needs Docker + network + kubectl).
test: test-fast test-k8s test-base test-overlay test-runtime test-mcp-runtime test-codex-shipyard

test-unit:
	./tests/unit/run.sh

test-graph:
	./tests/smoke/graph-validator-smoke.sh

test-worktree:
	./tests/smoke/worktree-smoke.sh

test-sentinel:
	./tests/smoke/sentinel-smoke.sh

test-base:
	./tests/smoke/base-image-smoke.sh

test-overlay:
	./tests/smoke/overlay-image-smoke.sh

test-runtime:
	./tests/smoke/runtime-smoke.sh

test-k8s:
	./tests/smoke/k8s-manifest-smoke.sh

test-docs:
	./tests/smoke/docs-smoke.sh

test-ssh-sync:
	./tests/smoke/ssh-sync-smoke.sh

test-mcp-runtime:
	./tests/smoke/mcp-runtime-smoke.sh

test-codex-shipyard:
	./tests/smoke/codex-shipyard-smoke.sh
