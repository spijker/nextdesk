#!/bin/bash
# Kiosk launcher: Firefox --kiosk opens the URL full-screen with no toolbar,
# no address bar and no tabs. START_URL is injected by the backend.
URL="${START_URL:-about:blank}"

# Build the link/attachment bridge extension's xpi. It's force-installed via
# policies.json's ExtensionSettings, which only accepts a packed xpi (not an
# unpacked dir) at a fixed path. The extension itself has no access to
# process env, so session.js hands it LWP_BACKEND_URL/LWP_SESSION_TOKEN —
# generated fresh here since web-type sessions are ephemeral (no persistent
# home, nothing to reuse across launches).
_json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
EXT_BUILD=$(mktemp -d)
cp /opt/lwp-kiosk-bridge/manifest.json /opt/lwp-kiosk-bridge/background.js "$EXT_BUILD/"
cat > "$EXT_BUILD/session.js" <<JS
const LWP_BACKEND_URL = "$(_json_str "${LWP_BACKEND_URL:-http://backend:8000}")";
const LWP_SESSION_TOKEN = "$(_json_str "${LWP_SESSION_TOKEN:-}")";
JS
mkdir -p /opt/firefox/lwp-bridge
( cd "$EXT_BUILD" && zip -qr -FS /opt/firefox/lwp-bridge/lwp-kiosk-bridge.xpi . )
rm -rf "$EXT_BUILD"

exec firefox \
    --no-remote \
    --new-instance \
    --kiosk \
    "$URL"
