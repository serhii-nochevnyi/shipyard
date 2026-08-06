# shellcheck shell=bash
#
# Resolve the container git identity the image build REQUIRES, for the test suite.
#
# Dockerfile.base refuses to build without GIT_USER_NAME/GIT_USER_EMAIL, on purpose:
# a baked-in default would author every in-container commit as whoever wrote that
# default down. The consequence is that EVERY smoke test which builds an image has
# to supply one, and forgetting is not a soft failure — with empty args the guard
# layer's cache key changes, the guard re-runs, and the target dies on a perfectly
# good tree. That is not hypothetical: the guard landed with only base-image-smoke.sh
# taught about it, which left `make test-overlay`, `test-runtime` and
# `test-mcp-runtime` red from that commit until this file existed.
#
# Source it, then either let `make` inherit the exported vars, or pass them on
# explicitly as --build-arg for a direct `docker build`.
GIT_USER_NAME="${GIT_USER_NAME:-$(git config --global user.name || true)}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-$(git config --global user.email || true)}"
GIT_USER_NAME="${GIT_USER_NAME:-shipyard test}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-shipyard-test@example.invalid}"
export GIT_USER_NAME GIT_USER_EMAIL
