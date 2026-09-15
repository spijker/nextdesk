# Per-user VPN gateway

The **VPN** catalog app gives each user their own corporate VPN tunnel that all
of their other sessions can share — an overlay network per user, without any
privileged containers.

## How it works

```
┌────────────────────── per-user Docker network lwp-vpn-<uid> ────────────────┐
│                                                                             │
│  ┌ VPN gateway (alias: vpn) ─────────┐      ┌ Firefox session ┐             │
│  │ GTK4/libadwaita GUI ── openconnect│◄─────│ SOCKS5 vpn:1080 │             │
│  │            └── ocproxy :1080      │      └─────────────────┘             │
│  │        (userspace lwIP, no tun,   │      ┌ Terminal session ┐            │
│  │         no NET_ADMIN, no root)    │◄─────│ ALL_PROXY / ssh  │            │
│  └───────────────────────────────────┘      └──────────────────┘            │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **`containers/vpn/`** runs OpenConnect entirely in userspace: the tunnel is
  handed to [`ocproxy`](https://github.com/cernekee/ocproxy) (`--script-tun`),
  which exposes it as a **SOCKS5 proxy on `:1080`**. No `/dev/net/tun`, no
  `NET_ADMIN` — the gateway is an ordinary unprivileged container.
- The orchestrator recognises the app by `LWP_VPN_ROLE=gateway` in its
  `env_json` and attaches it to a per-user network with the fixed DNS alias
  **`vpn`** — every user's apps reach *their own* tunnel at the same address,
  `socks5h://vpn:1080`, with no possibility of cross-user access (Docker DNS
  aliases are scoped per network).
- The login is a **native desktop app** (`lwp-vpn-gui.py`, GTK4 + libadwaita,
  `FROM lwp-kasm-base` — same stack as `containers/sshpilot`), not a terminal:
  a form for portal/username/password/OTP/protocol, a status pill, and a
  collapsible connection log. It spawns `openconnect` itself and feeds it
  credentials over stdin. No VPN credentials are ever stored server-side.
- Like every other KasmVNC-based app image in this repo, the session persists
  server-side independent of the browser connection — reloading the page or
  losing the connection does *not* drop the tunnel. Only closing the app
  window (or clicking Disconnect inside it) ends the session; closing while
  connected prompts for confirmation first.

## User flow

1. Launch **VPN** from the catalog and log in (password + TOTP).
2. On connect the window minimises itself; the taskbar shows a **shield**:
   pulsing amber = gateway open but not connected, green = tunnel up.
   Click the shield to bring the window back (status, reconnect, or click
   Disconnect).
3. Launch your apps. Sessions started **while the VPN is up** get a local
   SOCKS5 relay (`lwp-vpn-relay.py`, `127.0.0.1:1081`) and are wired to it
   automatically:

   | Client | Mechanism |
   |---|---|
   | curl, git, most CLIs | `ALL_PROXY=socks5h://127.0.0.1:1081` (+ `NO_PROXY` for LWP internals) |
   | Chromium-based (Vivaldi, …) | `SOCKS_SERVER` / `SOCKS_VERSION` env (Chromium ignores `socks5h://` in `all_proxy`) |
   | Firefox | start wrapper writes `distribution/policies.json` (SOCKS5 + proxy-DNS, not locked) |
   | ssh (Terminal app) | `ssh_config.d` drop-in: `ProxyCommand nc -X 5 -x 127.0.0.1:1081 %h %p`, active only when `LWP_VPN_PROXY` is set. Bypass per host: `ssh -o ProxyCommand=none <host>` |

   Anything else: configure SOCKS5 host `127.0.0.1`, port `1081` manually, and
   enable *proxy DNS* so hostnames resolve wherever the relay dials.

4. **Per-window VPN toggle.** Each such window shows a **shield button** in
   its titlebar. Per connection the relay either dials **direct** (shield
   grey/off — the default, so apps that need plain internet keep working) or
   **chains to the gateway** at `vpn:1080` with tunnel DNS (shield green/on).
   Flip it any time — the relay polls `GET /api/sessions/vpn/mode` with its
   session token every 2 s, and on a change it **drops all open connections**
   (browsers hold keep-alive/HTTP2 pools for minutes and would otherwise stay
   on the old path), so everything reconnects the new way within seconds.

   The first time a user's tunnel comes up, a one-time **help dialog** explains
   the shield and the env vars (reopen it: right-click the taskbar shield).

5. **Per-app defaults, set by the user.** Profile → *App VPN defaults* lets
   each user choose per app: start direct (default), start through the VPN,
   or *never proxied*. This writes `LWP_VPN_DEFAULT` / `LWP_VPN_EXEMPT` into
   `preferences.app_env[app_id]`; the backend merges these **whitelisted**
   keys over the admin's app env at session launch (users cannot set other
   env vars). Apps that should start tunneled can set
   `LWP_VPN_DEFAULT=on` in their `env_json` (Admin → Apps).

Sessions that were already running when the VPN came up are **late-joined** to
the network (they can reach `vpn:1080` for manual proxy config), but env-based
auto-proxying requires relaunching the app — environment variables cannot be
injected into a running container.

## Admin configuration

Preset the portal in Admin → Apps → VPN → env vars (`env_json`):

| Var | Purpose | Default |
|---|---|---|
| `LWP_VPN_ROLE` | `gateway` — marks the app for the orchestrator (don't change) | `gateway` |
| `LWP_VPN_DEFAULT` | on *client* apps' `env_json`: `on` starts their window with VPN routing enabled | `off` (direct) |
| `LWP_VPN_EXEMPT` | on *client* apps' `env_json`: `1` — never inject proxy env into this app (for apps that misbehave when SOCKS env is merely present, e.g. Ferdium); no shield toggle | unset |

Users can override `LWP_VPN_DEFAULT` / `LWP_VPN_EXEMPT` per app for themselves
in Profile → App VPN defaults (whitelisted keys only).
| `LWP_VPN_SERVER` | portal/gateway hostname users connect to | prompt |
| `LWP_VPN_USER` | username preset (users can override at the prompt) | prompt |
| `LWP_VPN_PROTOCOL` | any `openconnect --protocol` value: `gp`, `anyconnect`, `pulse`, `fortinet`, … | `gp` |

One VPN session per user is enforced (409 on a second launch) — SSO portals
typically allow a single concurrent login anyway.

## Tunnel state / taskbar indicator

The gateway reports state to the backend with its session token (same pattern
as the session recorder):

- `POST /api/sessions/vpn/state` — called by the container on tunnel up/down
  (`X-Session-Token` auth), stored in `sessions.vpn_connected`.
- `GET /api/sessions/vpn/status` — `{running, connected}` for the current
  user; the taskbar polls this every 5 s while the VPN window is open and
  auto-minimises the window on the transition to connected.

## Kubernetes

- The gateway pod gets a stable per-user Service **`lwp-vpn-<uid8>`**
  (owner-referenced to the pod, so it is garbage-collected with it); clients
  get the same proxy env pointing at that Service.
- A **NetworkPolicy** restricts the SOCKS port to pods with the owning user's
  `lwp.user` label (the GUI's display port stays open for nginx). Enforcement
  requires a NetworkPolicy-capable CNI (Calico, Cilium, …) — on plain flannel
  the policy is created but not enforced.

## Limitations

- **TCP only** — SOCKS5 via ocproxy carries no UDP (no VoIP etc.).
- GlobalProtect over `--script-tun` uses the TLS tunnel (no ESP) — fine for
  interactive use, slightly slower than kernel ESP.
- SAML-only portals (no password+TOTP fallback) are not yet supported; the
  planned approach is a browser-assisted login inside the session.
- With the window toggle **on**, traffic fails **closed**: if the gateway
  dies, tunneled connections lose egress rather than leaking outside it.
  With the toggle **off**, traffic intentionally goes direct — the shield
  shows which mode each window is in.
- Flipping the toggle kills the window's open connections on purpose (so
  browser pools re-route immediately) — a live ssh session or download in
  that window dies with them and must be restarted.
