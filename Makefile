SHELL := /bin/bash

BASE_IMAGE ?= remote-copilot-base:test
DEV_IMAGE ?= remote-copilot:test
DEV_COPILOT_SOURCE ?= /Volumes/KINGSTON/PhpstormProjects/dev-copilot
DEV_COPILOT_STAGING ?= .build/dev-copilot
DEV_COPILOT_INSTALL_CMD ?=
DEV_COPILOT_SOURCE_REV ?= $(shell git -C "$(DEV_COPILOT_SOURCE)" rev-parse --short HEAD 2>/dev/null || echo local-dev)
KARPATHY_SKILLS_REPO ?= https://github.com/multica-ai/andrej-karpathy-skills
KARPATHY_SKILLS_REF ?= 2c606141936f1eeef17fa3043a72095b4765b9c2
KARPATHY_SKILLS_STAGING ?= .build/karpathy-skills
CONTEXT7_MCP_VERSION ?= 2.2.5
TYPESCRIPT_LANGUAGE_SERVER_VERSION ?= 5.2.0
TYPESCRIPT_VERSION ?= 6.0.3
LOCAL_SSH_DIR ?= $(HOME)/.ssh
SSH_STAGING_DIR ?= .build/ssh-config
GIT_USER_NAME ?= Nochevnyi Serhii
GIT_USER_EMAIL ?= nochevnyi.serhii@airslate.com
WORKSPACE_DIR ?= $(CURDIR)/workspace
HOME_CACHE_DIR ?= $(CURDIR)/.cache-home

.PHONY: build-base sync-ssh-config sync-plugin sync-karpathy-skills build-dev-image bootstrap-atlassian-oauth run-docker deploy-k8s test-base test-overlay test-runtime test-k8s test-docs test-ssh-sync test-mcp-runtime

build-base: sync-ssh-config
	docker build -f Dockerfile.base -t $(BASE_IMAGE) \
	  --build-arg GIT_USER_NAME='$(GIT_USER_NAME)' \
	  --build-arg GIT_USER_EMAIL='$(GIT_USER_EMAIL)' \
	  --build-arg CONTEXT7_MCP_VERSION='$(CONTEXT7_MCP_VERSION)' \
	  --build-arg TYPESCRIPT_LANGUAGE_SERVER_VERSION='$(TYPESCRIPT_LANGUAGE_SERVER_VERSION)' \
	  --build-arg TYPESCRIPT_VERSION='$(TYPESCRIPT_VERSION)' \
	  .

sync-ssh-config:
	mkdir -p .build
	LOCAL_SSH_DIR="$(LOCAL_SSH_DIR)" ./scripts/sync-local-ssh-config.sh "$(SSH_STAGING_DIR)"

sync-plugin:
	mkdir -p .build
	DEV_COPILOT_SOURCE="$(DEV_COPILOT_SOURCE)" ./scripts/sync-dev-copilot.sh "$(DEV_COPILOT_STAGING)"

sync-karpathy-skills:
	mkdir -p .build
	KARPATHY_SKILLS_REPO="$(KARPATHY_SKILLS_REPO)" \
	KARPATHY_SKILLS_REF="$(KARPATHY_SKILLS_REF)" \
	./scripts/sync-karpathy-skills.sh "$(KARPATHY_SKILLS_STAGING)"

build-dev-image: sync-plugin sync-karpathy-skills
	docker build -f Dockerfile -t $(DEV_IMAGE) \
	  --build-arg BASE_IMAGE=$(BASE_IMAGE) \
	  --build-arg DEV_COPILOT_DIR=$(DEV_COPILOT_STAGING) \
	  --build-arg DEV_COPILOT_INSTALL_CMD='$(DEV_COPILOT_INSTALL_CMD)' \
	  --build-arg DEV_COPILOT_SOURCE_REV=$(DEV_COPILOT_SOURCE_REV) \
	  --build-arg KARPATHY_SKILLS_DIR=$(KARPATHY_SKILLS_STAGING) \
	  .

bootstrap-atlassian-oauth:
	./scripts/bootstrap-atlassian-rovo-oauth.sh

run-docker:
	mkdir -p "$(WORKSPACE_DIR)" "$(HOME_CACHE_DIR)"
	BASE_IMAGE=$(BASE_IMAGE) \
	DEV_IMAGE=$(DEV_IMAGE) \
	DEV_COPILOT_DIR=$(DEV_COPILOT_STAGING) \
	DEV_COPILOT_INSTALL_CMD='$(DEV_COPILOT_INSTALL_CMD)' \
	DEV_COPILOT_SOURCE_REV=$(DEV_COPILOT_SOURCE_REV) \
	WORKSPACE_DIR="$(WORKSPACE_DIR)" \
	HOME_CACHE_DIR="$(HOME_CACHE_DIR)" \
	docker compose run --rm dev

deploy-k8s:
	kubectl apply -f k8s/configmap.yaml
	kubectl apply -f k8s/pvc.yaml
	kubectl apply -f k8s/service.yaml
	kubectl apply -f k8s/statefulset.yaml

test-base:
	./tests/smoke/base-image-smoke.sh

test-overlay:
	DEV_COPILOT_INSTALL_CMD='$(DEV_COPILOT_INSTALL_CMD)' ./tests/smoke/overlay-image-smoke.sh

test-runtime:
	DEV_COPILOT_INSTALL_CMD='$(DEV_COPILOT_INSTALL_CMD)' ./tests/smoke/runtime-smoke.sh

test-k8s:
	./tests/smoke/k8s-manifest-smoke.sh

test-docs:
	./tests/smoke/docs-smoke.sh

test-ssh-sync:
	./tests/smoke/ssh-sync-smoke.sh

test-mcp-runtime:
	./tests/smoke/mcp-runtime-smoke.sh
