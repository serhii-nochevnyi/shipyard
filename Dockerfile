ARG BASE_IMAGE=remote-copilot-base:test
FROM ${BASE_IMAGE}

ARG KARPATHY_SKILLS_DIR=.build/karpathy-skills
ARG GSD_CORE_VERSION=1.6.0

USER root

COPY scripts/install-claude-plugins.sh /usr/local/bin/install-claude-plugins.sh
COPY scripts/install-karpathy-skills.sh /usr/local/bin/install-karpathy-skills.sh
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY ${KARPATHY_SKILLS_DIR}/ /opt/karpathy-skills/
COPY config/claude-lsp-plugin/ /opt/claude-lsp/

RUN chmod +x /usr/local/bin/install-claude-plugins.sh /usr/local/bin/install-karpathy-skills.sh /usr/local/bin/entrypoint.sh && \
    chown -R dev:dev /opt/karpathy-skills /opt/claude-lsp

USER dev

# gsd-core: non-interactive, --claude --global writes under /home/dev/.claude
RUN npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --claude --global --profile=full

RUN /usr/local/bin/install-claude-plugins.sh /opt/karpathy-skills /opt/claude-lsp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
