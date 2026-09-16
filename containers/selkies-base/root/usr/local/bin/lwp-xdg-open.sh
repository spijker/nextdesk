#!/bin/bash
# LWP xdg-open replacement: signals the LWP frontend to open the file natively.
# Falls back to system xdg-open (renamed to xdg-open.real) if the call fails.

FILE="$1"
if [ -z "$FILE" ]; then
    echo "Usage: xdg-open <file>" >&2
    exit 1
fi

# Resolve to absolute path if local file
if [[ "$FILE" != http* ]] && [ -e "$FILE" ]; then
    FILE="$(readlink -f "$FILE")"
fi

MIME=$(file --mime-type -b "$FILE" 2>/dev/null || echo "application/octet-stream")
BACKEND="${LWP_BACKEND_URL:-http://backend:8000}"
TOKEN="${LWP_SESSION_TOKEN:-}"

if [ -n "$TOKEN" ]; then
    curl -sf -X POST "${BACKEND}/api/sessions/open-file" \
        -H "Content-Type: application/json" \
        -H "X-Session-Token: ${TOKEN}" \
        -d "{\"path\": \"${FILE}\", \"mime\": \"${MIME}\"}" \
        --max-time 3 \
        && exit 0
fi

# Fallback: launch with the real xdg-open (if installed)
if command -v xdg-open.real &>/dev/null; then
    exec xdg-open.real "$@"
fi
