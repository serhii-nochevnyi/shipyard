ARG BASE_IMAGE=claude-shipyard-base:test
FROM ${BASE_IMAGE}

ARG KARPATHY_SKILLS_DIR=.build/karpathy-skills
ARG GSD_CORE_VERSION=1.7.0

USER root

COPY scripts/install-claude-plugins.sh /usr/local/bin/install-claude-plugins.sh
COPY scripts/install-shipyard-claude-hook.sh /usr/local/bin/install-shipyard-claude-hook.sh
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/shipyard-trust.sh /usr/local/bin/shipyard-trust
COPY ${KARPATHY_SKILLS_DIR}/ /opt/karpathy-skills/
COPY plugins/delivery-pipeline/ /opt/delivery-pipeline/
COPY capabilities/delivery-pipeline/ /opt/delivery-capability/delivery-pipeline/

# The GSD capability bundles its own copy of the validator so the gate is
# self-contained after `gsd capability install` copies the folder away. The
# validator requires sibling modules (frontmatter.cjs, pipeline-config.cjs), so
# the whole script set travels with it — copying validate-graph.cjs alone would
# leave the gate unable to load its parser.
RUN cp /opt/delivery-pipeline/scripts/*.cjs \
       /opt/delivery-capability/delivery-pipeline/checks/ && \
    chmod +x /usr/local/bin/install-claude-plugins.sh \
      /usr/local/bin/install-shipyard-claude-hook.sh \
      /usr/local/bin/entrypoint.sh /usr/local/bin/shipyard-trust \
      /opt/delivery-pipeline/scripts/*.sh /opt/delivery-pipeline/scripts/*.cjs \
      /opt/delivery-capability/delivery-pipeline/checks/*.cjs && \
    chown -R dev:dev /opt/karpathy-skills /opt/delivery-pipeline /opt/delivery-capability

USER dev

# gsd-core: non-interactive, --claude --global writes under /home/dev/.claude
RUN npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --claude --global --profile=full </dev/null

RUN /usr/local/bin/install-claude-plugins.sh /opt/karpathy-skills

# Auto-route: bake the UserPromptSubmit hook into the image's own user settings.
# The Codex installer writes the equivalent policy into ~/.codex/AGENTS.md
# automatically, so leaving the Claude side host-only made the container — the
# actual product — the one place where "the user never invokes shipyard by hand"
# was not true.
# SHIPYARD_GSD_AUTO_INSTALL=0: gsd-core is installed PINNED above. The host
# installer pulls the latest by default — correct there, wrong in an image whose
# whole point is a reproducible toolchain.
RUN SHIPYARD_GSD_AUTO_INSTALL=0 /usr/local/bin/install-shipyard-claude-hook.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
