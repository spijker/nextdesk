FROM lwp-selkies-base

# Ferdium — all-in-one messaging aggregator (Electron), from the official .deb.
# apt-get install of the local .deb pulls the Electron runtime deps.
ARG FERDIUM_DEB=https://github.com/ferdium/ferdium-app/releases/download/v7.1.2/Ferdium-linux-7.1.2-amd64.deb
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fL "$FERDIUM_DEB" -o /tmp/ferdium.deb && \
    apt-get install -y --no-install-recommends /tmp/ferdium.deb && \
    rm /tmp/ferdium.deb && \
    rm -rf /var/lib/apt/lists/*

# Run the Electron binary directly (the CLI wrapper forks and would exit the
# session). --no-sandbox: no SUID sandbox in the container; --disable-gpu: SW render.
ENV LWP_START_APP="/opt/Ferdium/ferdium --no-sandbox --disable-gpu --disable-dev-shm-usage"
