# Nextcloud Linux Workspace (internal shortname: LWP)

Kasm-alternative browser-based remote desktop. VNC + linuxserver.io webtop images. Enterprise-ready.

## Stack
- **Backend**: FastAPI (Python 3.12), SQLAlchemy 2 async, Alembic, ARQ, asyncpg
- **Frontend**: React 18, Vite, TypeScript, Tailwind, shadcn/ui, TanStack Query, Zustand
- **DB**: PostgreSQL 16 (asyncpg driver)
- **Cache/queue**: Redis 7 (via ARQ for tasks, direct for session tokens)
- **Proxy**: Nginx (auth_request session routing, strips `/session/<token>/` prefix before proxying to container)
- **Auth**: External OIDC only — no local Keycloak/LDAP
- **Desktop protocol**: VNC — WebSocket + HTML5 client, lower latency than WebRTC, no TURN server needed. Base image: `lwp-vnc-base` (Ubuntu 22.04 + VNC official repo). Custom apps: `lwp-vnc-base` → per-app image. VNC binds port 8080; HTML5 client at `/` auto-connects.
- **Webtop (legacy kasm type)**: linuxserver/webtop images with KasmVNC on port 3000.
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

### Frontend
- `src/api/client.ts` — single Axios instance with refresh interceptor
- `src/store/auth.ts` — Zustand store for current user + token state
- `src/types/index.ts` — all shared TypeScript types
- shadcn/ui for all UI primitives — don't roll custom buttons/inputs/dialogs
- TanStack Query for all server state — no local state for fetched data

### Containers
- Base: `containers/vnc-base/` — Ubuntu 22.04 + VNC official repo + supervisord + rclone. Runs as user `lwp` (uid 1000).
- App images: `containers/{chromium,firefox,thunderbird,libreoffice}/` — FROM `lwp-vnc-base`, install app, set `ENV LWP_START_APP="..."`.
- supervisord manages: `lwp-VNC` (VNC server, runs `LWP_START_APP`) + `lwp-rclone` (NC mount, optional).
- VNC binds `0.0.0.0:8080,auth=none` — nginx handles auth upstream. HTML5 client at `/` auto-connects.
- Build all: `cd containers && make all` (or `make REGISTRY=registry.example.com TAG=v1.0`).
- kasm type: `SUBFOLDER=/` — nginx strips the prefix, KasmVNC serves at `/`.
- VPN gateway: `containers/vpn/` — userspace OpenConnect + ocproxy SOCKS5 on :1080, unprivileged, GTK4/libadwaita desktop login GUI (`lwp-vpn-gui.py`, `FROM lwp-kasm-base`, same stack as `containers/sshpilot`). Apps with `LWP_VPN_ROLE=gateway` in env_json get the per-user network + `vpn` DNS alias from `services/container.py`. Client sessions launched while it runs get proxy env (`ALL_PROXY`/`SOCKS_SERVER`/`LWP_VPN_PROXY`) pointing at an in-container relay (`lwp-vpn-relay.py`, 127.0.0.1:1081) that dials direct or chains to the gateway per the window's shield toggle (`sessions.vpn_enabled`; relay polls `/api/sessions/vpn/mode`, drops open connections on flip). `LWP_VPN_DEFAULT=on` starts a window tunneled; `LWP_VPN_EXEMPT=1` = never inject proxy env (Ferdium). See docs/vpn.md.

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
