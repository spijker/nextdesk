# Selkies-based sibling of ../kasm-base — pilot for the app_type=kasm launch
# path (see docs/selkies-pilot.md... no such doc yet, see the chat scoping
# instead): swaps KasmVNC/Xvnc for LinuxServer.io's Selkies base while
# reusing the same LWP sidecars (Nextcloud/SFTP/S3 mounts, "open with…"
# bridge, VPN relay, file-list API) that kasm-base already ships.
#
# Base image is s6-overlay, not supervisord — LWP-specific extras are added
# through its custom-cont-init.d (one-shot setup) and custom-services.d
# (long-running) hooks instead of supervisor conf.d files. See
# docs.linuxserver.io/general/container-customization for the contract.
#
# Deliberately dropped vs kasm-base (see chat scoping notes):
#   - lwp-audio: Selkies has its own synced audio (pcmflux) — kasm-base's
#     Opus/Ogg sidecar existed specifically to route around KasmVNC's
#     audio, which doesn't apply here.
#   - lwp-video (WebCodecs beta stream) and lwp-record (session recording):
#     both shell out to `ffmpeg -f x11grab`, which needs a real X11 display —
#     this image runs Wayland (PIXELFLUX_WAYLAND below), so there isn't one.
#     Selkies exposes its own encoded stream via a Unix socket
#     (PIXELFLUX_RECORDING_SOCKET) for exactly this use case — recording
#     needs a rewrite onto that before this image can support the
#     record_sessions group policy; out of scope for the pilot.
FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates fuse3 unzip \
    && curl -fsSL https://rclone.org/install.sh | bash \
    && rm -rf /var/lib/apt/lists/*

COPY root/ /

RUN chmod +x /custom-cont-init.d/*.sh \
             /custom-services.d/* \
             /defaults/autostart /defaults/autostart_wayland \
             /usr/local/bin/lwp-*.sh /usr/local/bin/lwp-*.py && \
    if command -v xdg-open >/dev/null 2>&1; then mv /usr/bin/xdg-open /usr/bin/xdg-open.real; fi && \
    ln -sf /usr/local/bin/lwp-xdg-open.sh /usr/bin/xdg-open

# X11 mode's software screen capture is silently broken in this environment
# — the pipeline reports "capture started" but never actually produces a
# frame (confirmed: forced mouse/window/repaint events server-side inside
# the container produced zero encoder activity, while audio kept flowing the
# whole time). Wayland/labwc mode — what LinuxServer.io's own published
# images (chromium, kali-linux, webtop) actually run — works correctly.
ENV PIXELFLUX_WAYLAND=true

# Selkies' own sidebar UI (settings/stats/sharing panel) is meant for
# general-purpose desktop use — each LWP window is already one single app in
# our own window chrome, so Selkies' sidebar on top of that reads as a
# second, redundant title bar. Configured server-side, not via URL/query
# params — Selkies has no client-side URL config surface at all (confirmed
# against docs.selkies.io); the KasmVNC-style query string Window.tsx
# appends to every connect_url is simply ignored here, not the cause of
# anything.
ENV SELKIES_UI_SHOW_SIDEBAR=false

# Overridden by the app layer (e.g. containers/vscodium/Dockerfile).
ENV LWP_START_APP=""
ENV LWP_OPEN_CMD=""
