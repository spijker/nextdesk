#!/bin/bash
# Spawned by openconnect (--script-tun) once the tunnel is established.
# Report "connected" to the backend (drives the taskbar shield + auto-minimize),
# drop a sentinel file the GUI (lwp-vpn-gui.py) polls for to flip its own
# status pill, then become the tun handler serving SOCKS5 on :1080.
curl -s -m 5 -X POST "${LWP_BACKEND_URL:-http://backend:8000}/api/sessions/vpn/state" \
     -H "Content-Type: application/json" \
     -H "X-Session-Token: ${LWP_SESSION_TOKEN:-}" \
     -d '{"connected": true}' >/dev/null 2>&1 &

touch /tmp/.lwp-vpn-connected

exec ocproxy -g -k 30 -D 1080
