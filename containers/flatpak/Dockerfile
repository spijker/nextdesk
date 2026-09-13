FROM lwp-kasm-base

# Generic Flatpak app runner — one image, many catalog entries. Which app
# launches is picked at container-run time via the LWP_FLATPAK_APP_ID env var
# (see lwp-flatpak-start.sh), so adding a new app is an admin catalog entry,
# not a new image build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      flatpak \
      xdg-desktop-portal \
      xdg-desktop-portal-gtk \
    && rm -rf /var/lib/apt/lists/*

# The Flathub remote is added per-user at first launch (lwp-flatpak-start.sh)
# since --user installs need a --user remote, and the user's own remote list
# lives in the persistent home volume, not the image.

COPY lwp-flatpak-start.sh /usr/local/bin/lwp-flatpak-start.sh
RUN chmod +x /usr/local/bin/lwp-flatpak-start.sh

# Root bootstrap: needs a system D-Bus bus running before it drops to the lwp
# user (see lwp-flatpak-start-kasm.sh) — every other app image's base script
# is untouched.
RUN mv /usr/local/bin/lwp-start-kasm.sh /usr/local/bin/lwp-start-kasm-base.sh
COPY lwp-flatpak-start-kasm.sh /usr/local/bin/lwp-start-kasm.sh
RUN chmod +x /usr/local/bin/lwp-start-kasm.sh

ENV LWP_START_APP="/usr/local/bin/lwp-flatpak-start.sh"
