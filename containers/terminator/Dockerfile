FROM lwp-selkies-base

# GUI terminal + the same CLI tooling as the ttyd terminal image
RUN apt-get update && apt-get install -y --no-install-recommends \
      terminator \
      git jq joe vim less htop bash-completion \
    && rm -rf /var/lib/apt/lists/*

# Kubernetes tooling — pinned, bump ARGs to upgrade (kept in sync with terminal/)
ARG KUBECTX_VER=0.9.5
ARG STERN_VER=1.31.0
ARG YQ_VER=4.44.6
ARG K9S_VER=0.51.0

RUN set -eux; \
    DEB_ARCH="$(dpkg --print-architecture)"; \
    case "$DEB_ARCH" in \
        amd64) KCTX_ARCH=x86_64 ;; \
        arm64) KCTX_ARCH=arm64 ;; \
        *) echo "unsupported arch: $DEB_ARCH" >&2; exit 1 ;; \
    esac; \
    # kubectl (latest stable)
    KVER="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"; \
    curl -fsSL "https://dl.k8s.io/release/${KVER}/bin/linux/${DEB_ARCH}/kubectl" -o /usr/local/bin/kubectl; \
    # kubectx + kubens
    curl -fsSL "https://github.com/ahmetb/kubectx/releases/download/v${KUBECTX_VER}/kubectx_v${KUBECTX_VER}_linux_${KCTX_ARCH}.tar.gz" | tar -xz -C /usr/local/bin kubectx; \
    curl -fsSL "https://github.com/ahmetb/kubectx/releases/download/v${KUBECTX_VER}/kubens_v${KUBECTX_VER}_linux_${KCTX_ARCH}.tar.gz" | tar -xz -C /usr/local/bin kubens; \
    # stern (multi-pod log tailing)
    curl -fsSL "https://github.com/stern/stern/releases/download/v${STERN_VER}/stern_${STERN_VER}_linux_${DEB_ARCH}.tar.gz" | tar -xz -C /usr/local/bin stern; \
    # yq
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VER}/yq_linux_${DEB_ARCH}" -o /usr/local/bin/yq; \
    # k9s (.deb -> installs /usr/bin/k9s)
    curl -fsSL "https://github.com/derailed/k9s/releases/download/v${K9S_VER}/k9s_linux_${DEB_ARCH}.deb" -o /tmp/k9s.deb; \
    dpkg -i /tmp/k9s.deb; \
    rm -f /tmp/k9s.deb; \
    chmod +x /usr/local/bin/kubectl /usr/local/bin/kubens /usr/local/bin/kubectx \
             /usr/local/bin/stern /usr/local/bin/yq

# opencode — AI coding agent (TUI). Runs here rather than in the ttyd web
# Terminal: Terminator is a real X11 terminal over VNC, no ttyd/xterm.js/screen
# translation chain to break its rendering (see containers/terminal/Dockerfile).
# Node via nvm, system-wide /opt/nvm (the home volume would hide ~/.nvm).
ARG NVM_VER=0.40.5
ENV NVM_DIR=/opt/nvm
RUN mkdir -p "$NVM_DIR" && \
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VER}/install.sh" \
        | PROFILE=/dev/null bash && \
    bash -c '. "$NVM_DIR/nvm.sh" && nvm install --lts && \
             ln -s "$NVM_DIR/versions/node/$(node -v)" "$NVM_DIR/current" && \
             npm install -g opencode-ai' && \
    chown -R abc:abc "$NVM_DIR" && \
    printf 'export NVM_DIR=/opt/nvm\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' \
        > /etc/profile.d/nvm.sh && \
    echo '. /etc/profile.d/nvm.sh' >> /etc/bash.bashrc
ENV PATH="/opt/nvm/current/bin:$PATH"

ENV LWP_START_APP="terminator"
