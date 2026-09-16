FROM lwp-selkies-base

# Headlamp — Kubernetes UI desktop app (Electron), from the official .deb.
# Installs to /opt/Headlamp/headlamp (no /usr/bin symlink); apt resolves deps.
ARG HEADLAMP_DEB=https://github.com/kubernetes-sigs/headlamp/releases/download/v0.43.0/headlamp_0.43.0-1_amd64.deb
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fL "$HEADLAMP_DEB" -o /tmp/headlamp.deb && \
    apt-get install -y --no-install-recommends /tmp/headlamp.deb && \
    rm /tmp/headlamp.deb && \
    rm -rf /var/lib/apt/lists/*

ENV LWP_START_APP="/opt/Headlamp/headlamp --no-sandbox --disable-gpu"
