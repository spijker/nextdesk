FROM lwp-selkies-base

# Vivaldi — Chromium-based browser, snap-free, works in containers
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg && \
    curl -fsSL https://repo.vivaldi.com/archive/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/vivaldi.gpg && \
    echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/vivaldi.gpg] https://repo.vivaldi.com/archive/deb/ stable main' \
        > /etc/apt/sources.list.d/vivaldi.list && \
    apt-get update && apt-get install -y --no-install-recommends vivaldi-stable && \
    rm -rf /var/lib/apt/lists/*

# Launcher clears stale Chromium Singleton locks before starting.
COPY lwp-vivaldi.sh /usr/local/bin/lwp-vivaldi.sh
RUN chmod +x /usr/local/bin/lwp-vivaldi.sh

ENV LWP_START_APP="/usr/local/bin/lwp-vivaldi.sh"
ENV LWP_OPEN_CMD="vivaldi-stable"
