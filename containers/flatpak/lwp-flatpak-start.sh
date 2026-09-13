#!/bin/bash
# Runs inside the KasmVNC X session (see kasm-base/xstartup). Installs (once —
# cached in the user's persistent home volume under $HOME/.local/share/flatpak)
# and launches the Flatpak app named by LWP_FLATPAK_APP_ID, set per-app in the
# admin App catalog's env_json. LWP_OPEN_FILE, when set, is forwarded as an
# argument (file manager "Open with…").
set -u

if [ -z "${LWP_FLATPAK_APP_ID:-}" ]; then
  echo "lwp-flatpak-start: LWP_FLATPAK_APP_ID not set" >&2
  exec xterm -e "echo 'No Flatpak app configured (LWP_FLATPAK_APP_ID missing) — press Enter to close'; read"
fi

APP_ID="$LWP_FLATPAK_APP_ID"

# The Flathub remote added at build time is a *system* remote (added by root
# during docker build); --user installs look at the user's own remote list,
# which starts out empty in a fresh home volume, so it has to be added here.
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

if ! flatpak info --user "$APP_ID" >/dev/null 2>&1; then
  if ! flatpak install --user --noninteractive -y flathub "$APP_ID"; then
    echo "lwp-flatpak-start: failed to install $APP_ID from Flathub" >&2
    exec xterm -e "echo 'Failed to install ${APP_ID} from Flathub — press Enter to close'; read"
  fi
fi

OPEN_FILE="${1:-${LWP_OPEN_FILE:-}}"
if [ -n "$OPEN_FILE" ]; then
  flatpak run --user "$APP_ID" -- "$OPEN_FILE"
else
  flatpak run --user "$APP_ID"
fi

# Some apps (e.g. Spotify) self-background: `flatpak run` returns almost
# immediately while the real process is still starting up under a separate,
# still-running sandbox instance (visible in `flatpak ps`). If this script
# returned right away, xstartup would treat that as "the app closed" and
# tear down the whole VNC session out from under it — so wait for the actual
# instance to end first.
while flatpak ps --columns=application 2>/dev/null | grep -qx "$APP_ID"; do
  sleep 1
done
