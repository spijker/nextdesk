#!/bin/bash
# Opener agent: polls the backend for files the user asked to "Open with…" this
# already-running session, and opens each in the running app instance.
#
# LWP_OPEN_CMD is the app's file-open command (e.g. "libreoffice", "firefox").
# Most GUI apps hand a file off to their existing instance when re-invoked, so
# the document opens in the running window rather than a second copy.
# No LWP_OPEN_CMD → nothing to do (app can't receive files); idle quietly.
#
# Unlike kasm-base's version, this doesn't wait on an X11 DISPLAY — Selkies
# custom-services.d scripts only start after the base image's own services
# (which launch the app) are already up, and Wayland mode has no X11 display
# to poll for in the first place.
set -u

: "${LWP_OPEN_CMD:=}"
if [ -z "${LWP_OPEN_CMD}" ]; then
    echo "lwp-opener: LWP_OPEN_CMD unset — open-in-running disabled for this app." >&2
    exec sleep infinity
fi

BACKEND="${LWP_BACKEND_URL:-http://backend:8000}"
TOKEN="${LWP_SESSION_TOKEN:-}"

# Open one file: wait for the rclone mount to expose it (up to 60s), then hand
# it to the running app. Runs in the background so a slow file can't stall the
# poll loop.
open_file() {
    local file="$1"
    for _j in $(seq 1 300); do
        [ -e "$file" ] && break
        sleep 0.2
    done
    if [ -e "$file" ]; then
        echo "lwp-opener: opening $file with ${LWP_OPEN_CMD}" >&2
        setsid ${LWP_OPEN_CMD} "$file" >/dev/null 2>&1 &
    else
        echo "lwp-opener: file never appeared: $file" >&2
    fi
}

while true; do
    resp=$(curl -s -m 10 "${BACKEND}/api/sessions/open-in/poll" \
                -H "X-Session-Token: ${TOKEN}" 2>/dev/null)
    # Each queued path is a JSON string under the user's mount (/home/lwp/…)
    printf '%s' "$resp" \
        | grep -o '"/home/lwp/[^"]*"' \
        | sed 's/^"//; s/"$//' \
        | while IFS= read -r file; do
            open_file "$file"
        done
    sleep 2
done
