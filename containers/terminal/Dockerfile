FROM ubuntu:24.04

# Editors + CLI utils from apt
RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        curl ca-certificates openssl bash-completion htop less \
        git jq joe vim \
        openssh-client netcat-openbsd oathtool screen \
        python3-minimal python3-pip \
        fuse3 unzip && \
    pip install --no-cache-dir --break-system-packages ruff yamllint && \
    ARCH=$(uname -m) && \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${ARCH}" \
        -o /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd && \
    curl -fsSL https://rclone.org/install.sh | bash && \
    rm -rf /var/lib/apt/lists/*

# Kubernetes tooling — pinned, bump ARGs to upgrade
ARG KUBECTX_VER=0.9.5
ARG STERN_VER=1.31.0
ARG YQ_VER=4.44.6
ARG K9S_VER=0.51.0
ARG OPENBAO_VER=2.5.5

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
    # OpenBao CLI (asset arch naming matches KCTX_ARCH: x86_64/arm64)
    curl -fsSL "https://github.com/openbao/openbao/releases/download/v${OPENBAO_VER}/bao_${OPENBAO_VER}_Linux_${KCTX_ARCH}.tar.gz" | tar -xz -C /usr/local/bin bao; \
    chmod +x /usr/local/bin/kubectl /usr/local/bin/kubens /usr/local/bin/kubectx \
             /usr/local/bin/stern /usr/local/bin/yq /usr/local/bin/bao

RUN userdel -r ubuntu 2>/dev/null || true && \
    useradd -m -s /bin/bash -u 1000 lwp

# Node via nvm (system-wide /opt/nvm — the home volume would hide ~/.nvm) +
# jsonlint. `nvm` itself is available in the shell (bash.bashrc); node/npm are
# on PATH directly via /opt/nvm/current.
# opencode lives in Terminator instead (containers/terminator/) — it's a rich
# TUI and the ttyd→xterm.js→screen chain here doesn't render it correctly;
# Terminator is a real X11 terminal (VNC), no translation layers to fight.
ARG NVM_VER=0.40.5
ENV NVM_DIR=/opt/nvm
RUN mkdir -p "$NVM_DIR" && \
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VER}/install.sh" \
        | PROFILE=/dev/null bash && \
    bash -c '. "$NVM_DIR/nvm.sh" && nvm install --lts && \
             ln -s "$NVM_DIR/versions/node/$(node -v)" "$NVM_DIR/current" && \
             npm install -g jsonlint' && \
    chown -R lwp:lwp "$NVM_DIR" && \
    printf 'export NVM_DIR=/opt/nvm\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' \
        > /etc/profile.d/nvm.sh && \
    echo '. /etc/profile.d/nvm.sh' >> /etc/bash.bashrc
ENV PATH="/opt/nvm/current/bin:$PATH"

# Self-signed cert so ttyd serves HTTPS — nginx proxies all session upstreams
# as https:// (like KasmVNC), with proxy_ssl_verify off. Plain HTTP here caused
# "SSL_do_handshake() failed: wrong version number" at the proxy.
RUN mkdir -p /etc/ttyd && \
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout /etc/ttyd/key.pem -out /etc/ttyd/cert.pem \
        -subj "/CN=lwp-terminal" && \
    chmod 644 /etc/ttyd/cert.pem /etc/ttyd/key.pem

# Nextcloud rclone mount (mounts when LWP_NC_URL is set; the orchestrator
# attaches /dev/fuse + SYS_ADMIN when the user has NC configured).
COPY screenrc              /etc/screenrc
COPY lwp-nc-mount.sh       /usr/local/bin/lwp-nc-mount.sh
COPY lwp-mounts.sh         /usr/local/bin/lwp-mounts.sh
COPY lwp-terminal-entry.sh /usr/local/bin/lwp-terminal-entry.sh
COPY lwp-vpn-relay.py      /usr/local/bin/lwp-vpn-relay.py
RUN chmod +x /usr/local/bin/lwp-nc-mount.sh /usr/local/bin/lwp-mounts.sh \
             /usr/local/bin/lwp-terminal-entry.sh /usr/local/bin/lwp-vpn-relay.py

# ssh rides the VPN SOCKS proxy automatically when the session runs behind it.
# openssh refuses to read a group/world-writable config file ("Bad owner or
# permissions") — the repo file is 664 (default umask), so force 644 here
# rather than relying on the checked-in mode.
COPY lwp-vpn-ssh.conf /etc/ssh/ssh_config.d/60-lwp-vpn.conf
RUN chmod 644 /etc/ssh/ssh_config.d/60-lwp-vpn.conf

USER lwp
WORKDIR /home/lwp

EXPOSE 7681
CMD ["/usr/local/bin/lwp-terminal-entry.sh"]
