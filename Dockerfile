ARG BASE_IMAGE=remote-copilot-base:test
FROM ${BASE_IMAGE}

ARG DEV_COPILOT_DIR=.build/dev-copilot
ARG KARPATHY_SKILLS_DIR=.build/karpathy-skills
ARG DEV_COPILOT_INSTALL_CMD=
ARG DEV_COPILOT_SOURCE_REV=local-dev

USER root

COPY scripts/install-dev-copilot.sh /usr/local/bin/install-dev-copilot.sh
COPY scripts/install-karpathy-skills.sh /usr/local/bin/install-karpathy-skills.sh
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY ${DEV_COPILOT_DIR}/ /opt/dev-copilot/
COPY ${KARPATHY_SKILLS_DIR}/ /opt/karpathy-skills/

RUN chmod +x /usr/local/bin/install-dev-copilot.sh /usr/local/bin/install-karpathy-skills.sh /usr/local/bin/entrypoint.sh && \
    mkdir -p /usr/local/share/dev-copilot && \
    printf '%s\n' "$DEV_COPILOT_SOURCE_REV" > /usr/local/share/dev-copilot/source-rev && \
    chown -R dev:dev /opt/dev-copilot /opt/karpathy-skills /usr/local/share/dev-copilot

USER dev

RUN DEV_COPILOT_INSTALL_CMD="$DEV_COPILOT_INSTALL_CMD" /usr/local/bin/install-dev-copilot.sh /opt/dev-copilot
RUN /usr/local/bin/install-karpathy-skills.sh /opt/karpathy-skills

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
