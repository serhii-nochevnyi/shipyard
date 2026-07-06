ARG BASE_IMAGE=claude-shipyard-base:test
FROM ${BASE_IMAGE}

ARG KARPATHY_SKILLS_DIR=.build/karpathy-skills
ARG GSD_CORE_VERSION=1.6.0

USER root

COPY scripts/install-claude-plugins.sh /usr/local/bin/install-claude-plugins.sh
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY ${KARPATHY_SKILLS_DIR}/ /opt/karpathy-skills/
COPY plugins/delivery-pipeline/ /opt/delivery-pipeline/

RUN chmod +x /usr/local/bin/install-claude-plugins.sh /usr/local/bin/entrypoint.sh \
      /opt/delivery-pipeline/scripts/*.sh /opt/delivery-pipeline/scripts/*.cjs && \
    chown -R dev:dev /opt/karpathy-skills /opt/delivery-pipeline

USER dev

# gsd-core: non-interactive, --claude --global writes under /home/dev/.claude
RUN npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --claude --global --profile=full </dev/null

RUN /usr/local/bin/install-claude-plugins.sh /opt/karpathy-skills

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
