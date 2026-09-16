FROM lwp-selkies-base

# Remmina — remote desktop client (RDP + VNC plugins).
RUN apt-get update && apt-get install -y --no-install-recommends \
      remmina remmina-plugin-rdp remmina-plugin-vnc \
    && rm -rf /var/lib/apt/lists/*

ENV LWP_START_APP="remmina"
