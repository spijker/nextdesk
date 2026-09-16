FROM lwp-selkies-base

# OpenCode desktop (Electron) — AI coding agent, from the official .deb.
# apt-get install of the local .deb pulls the Electron runtime deps.
ARG OPENCODE_DEB=https://opencode.ai/download/stable/linux-x64-deb
RUN apt-get update && \
    curl -fL "$OPENCODE_DEB" -o /tmp/opencode.deb && \
    apt-get install -y --no-install-recommends /tmp/opencode.deb && \
    rm /tmp/opencode.deb && \
    rm -rf /var/lib/apt/lists/*

# Run the Electron binary directly (see ferdium). --no-sandbox: no SUID
# sandbox in the container; --disable-gpu: SW render.
ENV LWP_START_APP="/opt/OpenCode/ai.opencode.desktop --no-sandbox --disable-gpu --disable-dev-shm-usage"
