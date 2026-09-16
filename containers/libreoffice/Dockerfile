FROM lwp-selkies-base

RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice \
      libreoffice-gtk3 \
      libreoffice-l10n-en-gb \
    && rm -rf /var/lib/apt/lists/*

# Openbox auto-maximizes; no need for wmctrl wrapper
ENV LWP_START_APP="libreoffice --norestore"
# Opener for file-manager "Open with…" (hands off to the running soffice)
ENV LWP_OPEN_CMD="libreoffice"
