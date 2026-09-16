FROM lwp-selkies-base

# VSCodium — open-source VS Code build, installed from the official .deb.
# apt-get install of the local .deb pulls the Electron runtime deps.
ARG VSCODIUM_DEB=https://github.com/VSCodium/vscodium/releases/download/1.121.03429/codium_1.121.03429_amd64.deb
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fL "$VSCODIUM_DEB" -o /tmp/codium.deb && \
    apt-get install -y --no-install-recommends /tmp/codium.deb && \
    rm /tmp/codium.deb && \
    rm -rf /var/lib/apt/lists/*

# Run the Electron binary directly, NOT the `codium` CLI wrapper — the wrapper
# forks and returns immediately, which would make LWP tear the session down.
# --no-sandbox: no SUID sandbox in the container; --disable-gpu: software render.
ENV LWP_START_APP="/usr/share/codium/codium --no-sandbox --disable-gpu --disable-dev-shm-usage"
ENV LWP_OPEN_CMD="/usr/share/codium/codium --reuse-window"
