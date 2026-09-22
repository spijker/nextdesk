# Apps — catalog & adding your own

LWP apps are containers proxied per-session under `/session/<token>/`. There are
three kinds:

- **Desktop apps (`app_type=kasm`)** — a full GUI desktop streamed by
  [Selkies](https://github.com/selkies-project/selkies) (WebSocket mode).
  Base: `lwp-selkies-base` (or a pulled `lscr.io/linuxserver/*` image directly —
  see [architecture.md](architecture.md#linuxserver-catalog)). Heavy but runs
  any Linux GUI app. `app_type=kasm` is a historical DB value; the protocol
  underneath is Selkies, not KasmVNC — see [architecture.md](architecture.md).
- **Web-native apps (`app_type=web`)** — the app serves its own web UI; LWP
  proxies it directly. Covers both the ttyd/`lwp-web-base` tools below (own
  HTTPS) *and* the shared kiosk browser / self-service "My web apps" (Selkies
  kiosk container, plain HTTP — see [architecture.md](architecture.md)).
- **Legacy KasmVNC apps (`app_type=stream`)** — `lwp-kasm-base`, HTTPS + a
  fixed proxy credential. Being phased out; only kept for a handful of
  internal tools (see table below) and the VPN gateway.

The start menu badges apps **Web** vs **Desktop** (from the `web_native` flag)
and admins can toggle it per app in Admin → Apps.

## Built-in catalog

| App | Kind | Notes |
|---|---|---|
| Firefox, Vivaldi | Desktop (Selkies) | browsers (Chromium-based needs `--no-sandbox`) |
| Thunderbird | Desktop (Selkies) | Mozilla tarball (24.04 ships a snap) |
| LibreOffice | Desktop (Selkies) | office suite |
| Terminator | Desktop (Selkies) | GUI terminal + k8s CLI tooling, node via nvm, opencode (AI agent TUI — real X11 terminal, renders correctly unlike the ttyd web Terminal) |
| OpenCode | Desktop (Selkies) | AI coding agent desktop app (Electron) |
| SSHPilot | Desktop (Selkies) | GTK4 SSH client |
| VSCodium | Desktop (Selkies) | VS Code (OSS) desktop build |
| Headlamp | Desktop (Selkies) | Kubernetes desktop UI |
| FileZilla, Remmina | Desktop (Selkies) | FTP/SFTP, RDP/VNC client |
| Ferdium | Desktop (Selkies) | messaging aggregator |
| **Terminal** | web | ttyd → persistent tmux session (survives tab close/reload; Profile → "Keep Terminal running in the background" exempts it from idle suspend/reap, capped 48 h) + ssh/nc, kubectl/k9s/kubens/stern, bao (OpenBao), yq/jq/git/vim, node via nvm, ruff/yamllint/jsonlint |
| **JupyterLab** | web | notebooks |
| **pgweb** | web | Postgres web client |
| **htop** | web | ttyd-wrapped TUI |
| **VPN** | web | per-user OpenConnect gateway → SOCKS5 `vpn:1080`; per-window shield toggle routes each app direct or through the tunnel — see [vpn.md](vpn.md) |

Apps are seeded from `backend/app/services/seed.py` at backend startup
(idempotent by name — new presets are topped up on existing deployments
without touching admin-customised apps).

## Add a desktop (Selkies) app

Two ways to get a desktop app into the catalog — pick whichever is less work.

**Pull an existing LinuxServer.io image.** Admin → Apps → "Add from catalog"
browses `api.linuxserver.io`'s full list (200+ images, GUI-shaped categories
sorted first) and fills in `container_image: lscr.io/linuxserver/<name>:<tag>`,
`app_type: kasm`, `proxy_port: 3000` for you — no Dockerfile needed at all.
Use this whenever LinuxServer.io already maintains the app.

**Build your own**, when it isn't on LinuxServer.io or you need LWP's sidecars
(NC/SFTP mounts, VPN relay, etc. — pulled images don't get these):

```dockerfile
# containers/myapp/Dockerfile
FROM lwp-selkies-base
RUN apt-get update && apt-get install -y --no-install-recommends myapp \
    && rm -rf /var/lib/apt/lists/*
ENV LWP_START_APP="myapp"
```
- Selkies serves on `3000` (plain HTTP — nginx adds per-session Basic Auth
  dynamically, see [architecture.md](architecture.md)). `LWP_START_APP` is
  read by `/defaults/autostart`.
- Electron apps: run the real binary with `--no-sandbox` (not the CLI wrapper,
  which forks and would exit the session — that killed early VSCodium builds).
- Home persists at `/config` (LinuxServer.io convention), not `/home/lwp`.

## Add a web-native app

If the app **serves its own TLS** (e.g. code-server `--cert`, ttyd `--ssl`),
just base it on anything and expose HTTPS on its port.

Otherwise use **`lwp-web-base`** — a non-root nginx that terminates HTTPS on
`:8080` and proxies to your HTTP app:

```dockerfile
FROM lwp-web-base
RUN <install your web app>
ENV LWP_APP_PORT=8081
CMD ["your-app", "--host", "127.0.0.1", "--port", "8081"]
```

### The path-prefix gotcha
LWP strips the dynamic `/session/<token>/` prefix before it reaches the app.
Apps that emit **absolute** paths (Jupyter, pgweb) then break. `lwp-web-base`
solves it: set `LWP_BASE_PREFIX=1` and the wrapper **re-adds** `/session/$LWP_SESSION_TOKEN/`
before proxying, so you can run the app with that as its base path
(`LWP_SESSION_TOKEN` is injected into every container):

```dockerfile
FROM lwp-web-base
ENV LWP_APP_PORT=8081 LWP_BASE_PREFIX=1
CMD ["bash","-lc","exec myapp --base-url /session/${LWP_SESSION_TOKEN}/ --port 8081"]
```
Apps that use **relative** asset paths (ttyd, code-server, pgweb) don't need this.

## Register the app

Pulling from the LinuxServer.io catalog (Admin → Apps) skips all of this —
it's only for a custom build.

1. `containers/Makefile` — add a build target.
2. `backend/app/services/seed.py` — add a preset (`app_type: kasm`, `proxy_port: 3000`
   for Selkies apps; set `web_native: True` for web apps).
3. A new Alembic migration inserting the app row `WHERE NOT EXISTS (… name …)`.
4. An icon in `frontend/public/icons/`.

Build: `cd containers && make selkies-base web-base <yourapp>`.

## Self-service web apps

Any user can add their own personal kiosk web app without an admin, via
Profile → "My web apps" (`POST /api/apps/personal`) — just a name, URL and
icon. It's marked `created_by=<user>` so only they see edit/delete controls,
and it runs on the same shared `lwp-kiosk` (Selkies-based) container as the
admin-managed web apps.
