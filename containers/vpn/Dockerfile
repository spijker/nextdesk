FROM lwp-kasm-base

# OpenConnect (GlobalProtect/AnyConnect) + ocproxy: the tunnel runs entirely in
# userspace (lwIP) — no /dev/net/tun, no NET_ADMIN, container stays unprivileged.
# ocproxy exposes the tunnel as a SOCKS5 proxy on :1080 for the user's other
# session containers (reachable as socks5h://vpn:1080 on the per-user network).
#
# GTK4 + libadwaita give the login/status window a native desktop look,
# rendered inside the session's KasmVNC desktop like any other app image
# (same GUI stack as containers/sshpilot).
RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openconnect ocproxy \
        python3-gi python3-gi-cairo gir1.2-gtk-4.0 \
        libadwaita-1-0 gir1.2-adw-1 \
        curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY lwp-vpn-gui.py /usr/local/bin/lwp-vpn-gui.py
COPY lwp-vpn-up.sh  /usr/local/bin/lwp-vpn-up.sh
RUN chmod +x /usr/local/bin/lwp-vpn-gui.py /usr/local/bin/lwp-vpn-up.sh

# Override the base openbox config: every other app image gets maximized,
# but the VPN GUI is a small form that should just be centered.
COPY openbox.xml /etc/lwp/openbox.xml

ENV LWP_START_APP="/usr/local/bin/lwp-vpn-gui.py"
