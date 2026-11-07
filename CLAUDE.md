# Nextcloud Linux Workspace (internal shortname: LWP)

Kasm-alternative browser-based remote desktop. VNC + linuxserver.io webtop images. Enterprise-ready.

## Stack
- **Backend**: FastAPI (Python 3.12), SQLAlchemy 2 async, Alembic, ARQ, asyncpg
- **Frontend**: React 18, Vite, TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand
- **DB**: PostgreSQL 16 (asyncpg driver)
- **Cache/queue**: Redis 7 (via ARQ for tasks, direct for session tokens)
- **Proxy**: Nginx (auth_request session routing, strips `/session/<token>/` prefix before proxying to container)
- **Auth**: External OIDC only — no local Keycloak/LDAP
- **Desktop protocol**: Selkies (WebSocket mode — no TURN server needed, same reasoning that originally ruled out WebRTC). Base image: `lwp-selkies-base` (`ghcr.io/linuxserver/baseimage-selkies:debiantrixie` + LWP sidecars as s6 `custom-services.d`). Custom apps: `lwp-selkies-base` → per-app image, port 3000. `app_type=kasm` in the DB covers both these custom builds and pulled `lscr.io/linuxserver/*` images — same proxy/auth path either way (see `sessions.py` `validate_session`).
- **Legacy KasmVNC base**: `lwp-kasm-base` (`app_type=stream`, port 8080) is being phased out — only `vpn` (network-critical, higher blast radius) still builds on it. Flatpak app support was dropped entirely (needed userns/seccomp sandboxing exceptions that never got ported to selkies-base).
- **Deploy**: Kubernetes (prod), Docker Compose (dev/test)

## Conventions

### Backend
- Async everywhere — `async def` routes, `await` DB calls, no sync I/O in request path
- `app/config.py` — all settings via `pydantic-settings`, read from env
- `app/database.py` — single `AsyncSession` factory, used via `Depends(get_session)`
- Routers: `app/routers/{auth,images,sessions}.py` + `app/routers/admin/{users,images,sessions,nextcloud}.py`
- Permission guard: `Depends(require_role(["admin"]))` — never inline role checks
- Migrations: always via Alembic — `cd backend && alembic revision --autogenerate -m "description"`
- Tests: `backend/tests/` — pytest-asyncio, testcontainers for DB
- App visibility: `AppPermission` rows restrict an app to specific groups *and/or* individual users (`group_id`/`user_id`, exactly one set — `ck_app_permission_one_target`). No rows at all = open to everyone; a row only ever narrows access.
- Self-service apps: a user can create their own private web (kiosk) app via `POST /api/apps/personal` (Profile → My web apps) — `App.created_by` marks it as theirs (distinct from `AppPermission`, which is about *access* not *ownership*: an admin can grant a user access to a catalog app without them being able to edit/delete it).

### Frontend
- `src/api/client.ts` — single Axios instance with refresh interceptor
- `src/store/auth.ts` — Zustand store for current user + token state
- `src/types/index.ts` — all shared TypeScript types
- shadcn/ui for all UI primitives — don't roll custom buttons/inputs/dialogs
- TanStack Query for all server state — no local state for fetched data

### Containers
- Base: `containers/selkies-base/` — `ghcr.io/linuxserver/baseimage-selkies:debiantrixie` (s6-overlay, user `abc`, home `/config`) + LWP sidecars (NC/SFTP/S3 mounts, VPN relay, "open with…" bridge, file-list API) dropped in via `/custom-cont-init.d` and `/custom-services.d` — see `docs.linuxserver.io/general/container-customization`. Dropped vs the old base: the audio/video sidecars (Selkies has native synced audio; the video one needed X11, which Wayland mode doesn't have). Session recording (`record_sessions` policy) doesn't work on this base yet — needs a rewrite onto Selkies' `PIXELFLUX_RECORDING_SOCKET` instead of `ffmpeg -f x11grab`.
- App images: `containers/{firefox,thunderbird,libreoffice,vscodium,...}/` — FROM `lwp-selkies-base`, install app, set `ENV LWP_START_APP="..."` (read by `/defaults/autostart`, which also handles `LWP_OPEN_FILE` and self-stop-on-exit — kasm-base's `xstartup` equivalent).
- Legacy base: `containers/kasm-base/` (KasmVNC on :8080, real HTTPS + a fixed proxy-tier credential) — only `vpn` still builds on it.
- `mount_home`'s persistent volume binds at `/config` for `app_type=kasm` apps, `/home/lwp` for everything else — see the comment in `services/container.py` (`_docker_start_sync`). Get this wrong and the app silently loses all data on every launch (and leaks an anonymous volume) instead of erroring.
- Build all: `cd containers && make all` (or `make REGISTRY=registry.example.com TAG=v1.0`).
- kasm type: `SUBFOLDER=/` — nginx strips the prefix. Session proxy scheme/auth are picked per session by `validate_session` (`X-Session-Scheme`/`X-Session-Auth` response headers) — plain HTTP + per-session Basic Auth (`CUSTOM_USER`/`PASSWORD`) for `app_type=kasm`, HTTPS + a fixed credential for everything else (our own images terminate their own TLS).
- VPN gateway: `containers/vpn/` — userspace OpenConnect + ocproxy SOCKS5 on :1080, unprivileged, GTK4/libadwaita desktop login GUI (`lwp-vpn-gui.py`, `FROM lwp-kasm-base` — `containers/sshpilot` used to share this stack but has since moved to `lwp-selkies-base`). Apps with `LWP_VPN_ROLE=gateway` in env_json get the per-user network + `vpn` DNS alias from `services/container.py`. Client sessions launched while it runs get proxy env (`ALL_PROXY`/`SOCKS_SERVER`/`LWP_VPN_PROXY`) pointing at an in-container relay (`lwp-vpn-relay.py`, 127.0.0.1:1081) that dials direct or chains to the gateway per the window's shield toggle (`sessions.vpn_enabled`; relay polls `/api/sessions/vpn/mode`, drops open connections on flip). `LWP_VPN_DEFAULT=on` starts a window tunneled; `LWP_VPN_EXEMPT=1` = never inject proxy env (Ferdium). See docs/vpn.md.

### Secrets
- Never commit `.env` files or certs
- `compose/.env.example` is the source of truth for required env vars
- Credentials (NC passwords, registry tokens) encrypted with Fernet derived from `SECRET_KEY`

## Dev quick start
```bash
cp compose/.env.example compose/.env
# edit compose/.env — set OIDC_* vars
make dev
# open http://localhost
```

## Key env vars
| Var | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | DB password |
| `SECRET_KEY` | JWT signing key (32+ random bytes) |
| `OIDC_ISSUER` | e.g. `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | from your IdP |
| `OIDC_CLIENT_SECRET` | from your IdP |
| `OIDC_GROUPS_CLAIM` | claim name containing group list (default: `groups`) |
