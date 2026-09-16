# API Reference

## Interactive docs

| URL | Description |
|---|---|
| `/api/docs` | Swagger UI — try endpoints in the browser |
| `/api/redoc` | ReDoc — clean read-only reference |
| `/api/openapi.json` | Raw OpenAPI JSON schema |

## Auth

All endpoints except `/healthz` and `/api/auth/oidc/*` require an authenticated session. Authentication is via **HttpOnly JWT cookies** set after login. The Swagger UI uses your browser cookies automatically.

---

## Auth endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/methods` | Which auth methods are enabled (`oidc`, `local`, `ldap`) |
| `GET` | `/api/auth/oidc/login` | Redirect to OIDC provider |
| `GET` | `/api/auth/oidc/callback` | OIDC callback — exchanges code, sets cookies |
| `POST` | `/api/auth/login` | Local/LDAP login `{username, password}` — returns JWT cookies or `{requires_totp, totp_token}` |
| `POST` | `/api/auth/register` | First-user setup `{username, email, display_name, password}` — only works on empty system |
| `POST` | `/api/auth/refresh` | Refresh access token (uses refresh cookie) |
| `POST` | `/api/auth/logout` | Clear all auth cookies |
| `GET` | `/api/auth/me` | Current user info (id, email, username, is_admin, preferences, totp_enabled) |
| `GET` | `/api/auth/me/preferences` | User preferences object (JSONB) |
| `PATCH` | `/api/auth/me/preferences` | Merge-update preferences `{key: value, …}` |
| `GET` | `/api/auth/me/groups` | My groups |
| `PATCH` | `/api/auth/me/profile` | Update own display name `{display_name}` |
| `POST` | `/api/auth/me/password` | Change own password (local) `{current_password, new_password}` |
| `POST` | `/api/auth/me/sign-out-others` | Revoke other browsers, keep this one (bumps `token_version`) |
| `GET` | `/api/auth/me/quota` | `{limit, used, cpu_ceiling, mem_ceiling}` |
| `GET` | `/api/auth/me/activity` | My recent audit entries |

### TOTP 2FA (local/LDAP users only)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/2fa/setup` | Generate TOTP secret, returns `{secret, qr_url}` (pending, not yet active) |
| `POST` | `/api/auth/2fa/confirm` | Confirm setup with first code `{code}` — activates TOTP |
| `DELETE` | `/api/auth/2fa` | Disable TOTP `{code}` (requires current valid code) |
| `POST` | `/api/auth/2fa/verify` | Verify TOTP during login `{totp_token, code}` — returns JWT cookies |

---

## Apps (user-facing catalog)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/apps` | Apps visible to current user (filtered by group *and* per-user permissions) |
| `POST` | `/api/apps/personal` | Create a self-service web (kiosk) app owned by the current user — `{name, web_url, icon_url}` |
| `PUT` | `/api/apps/personal/{app_id}` | Update a self-service app (must be `created_by` the current user) |
| `DELETE` | `/api/apps/personal/{app_id}` | Delete a self-service app |

---

## Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions` | My active sessions (status: starting, running, suspended) |
| `GET` | `/api/sessions/{id}` | Single session's current status — polled by the frontend while a container is still starting/being pulled |
| `POST` | `/api/sessions` | Launch a session `{app_id}` — if the image isn't pulled locally yet, returns immediately and finishes starting it in the background |
| `DELETE` | `/api/sessions` | Stop ALL my running sessions (logout flow) |
| `DELETE` | `/api/sessions/{id}` | Stop a specific session |
| `POST` | `/api/sessions/{id}/pause` | Suspend session (docker pause / k8s scale 0) |
| `POST` | `/api/sessions/{id}/resume` | Resume suspended session |
| `PATCH` | `/api/sessions/{id}/window` | Save window position `{x, y, width, height, minimized, maximized}` |
| `POST` | `/api/sessions/{id}/heartbeat` | Keep-alive so the idle reaper doesn't stop an in-use session |
| `GET` | `/api/sessions/{id}/audio` | **Legacy KasmVNC apps only** — relays the desktop's Opus/Ogg audio stream (container `:8081`) to the browser. Selkies apps (`app_type=kasm`/`web`) handle audio natively client-side; the frontend controls volume/mute via `postMessage` into the session iframe instead, see [architecture.md](architecture.md#volume-control) |
| `POST` | `/api/sessions/self-stop` | **Container-internal** — called when the app exits; auth via `X-Session-Token` header; also stops the container in the background (not just the DB row) |
| `POST` | `/api/sessions/open-file` | **Container-internal** — called by the xdg-open bridge when user opens a file; auth via `X-Session-Token` header; body `{path, mime}` |
| `GET` | `/api/sessions/open-file/poll` | **Frontend** — poll for pending open-file events; returns `{events: [{path, mime}]}` |
| `GET` | `/api/sessions/validate` | **Nginx-internal** — auth_request endpoint; auth via `X-Session-Token` header; returns `X-Session-Upstream`/`X-Session-Scheme`/`X-Session-Auth` (scheme+auth depend on `app_type`, see [architecture.md](architecture.md)) |
| `GET` | `/api/sessions/{id}/launch` | Redirect page for opening a session in a new tab |
| `POST` | `/api/sessions/{id}/vpn` | Per-window VPN routing toggle `{enabled}` — 409 if the session was launched without a running gateway |
| `GET` | `/api/sessions/vpn/status` | Taskbar shield: `{running, connected}` for my VPN gateway session |
| `POST` | `/api/sessions/vpn/state` | **Container-internal** — gateway reports tunnel up/down `{connected}`; auth via `X-Session-Token` |
| `GET` | `/api/sessions/vpn/mode` | **Container-internal** — polled by the in-session SOCKS relay; returns `{enabled}`; auth via `X-Session-Token` |

### Session status values

| Status | Meaning |
|---|---|
| `starting` | Container starting, VNC not yet accepting connections |
| `running` | Active, VNC reachable |
| `suspended` | Container paused (idle suspend or manual pause) |
| `stopped` | Ended normally (app exit, user close, or watchdog) |
| `error` | Container failed to start |

---

## Storage (Nextcloud)

### Nextcloud config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/storage/mounts` | My extra storage mounts (SFTP/S3) — non-secret fields only |
| `POST` | `/api/storage/mounts` | Add a mount: SFTP `{name, host, port, user, private_key or password, path}` or S3 `{name, endpoint, region, bucket, access_key_id, secret_access_key}` |
| `DELETE` | `/api/storage/mounts/{id}` | Remove a mount |
| `GET` | `/api/storage/nextcloud` | Current user's Nextcloud config (URL + username, no password) |
| `PUT` | `/api/storage/nextcloud` | Set Nextcloud credentials `{url, username, password}` |
| `DELETE` | `/api/storage/nextcloud` | Remove Nextcloud config |
| `POST` | `/api/storage/nextcloud/test` | Test Nextcloud connection with current credentials |
| `POST` | `/api/storage/nextcloud/connect` | Start NC Login Flow v2 `{url}` — returns `{login_url, poll_endpoint, poll_token}` |
| `POST` | `/api/storage/nextcloud/connect/poll` | Poll NC Login Flow v2 `{poll_endpoint, poll_token, nc_url}` — returns `{done, username}` |

### File browser (WebDAV proxy)

All file endpoints proxy through the backend to Nextcloud WebDAV using the user's credentials. Paths are relative to the user's Nextcloud root (`/`).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/storage/files?path=/` | List directory (PROPFIND depth 1); returns `[{name, path, type, size, modified, mime}]` |
| `GET` | `/api/storage/files/download?path=…` | Download file (`Content-Disposition: attachment`) |
| `GET` | `/api/storage/files/preview?path=…` | Stream file inline (`Content-Disposition: inline`) — used for PDF/image browser rendering |
| `GET` | `/api/storage/files/thumbnail?path=…&size=256` | Proxy Nextcloud preview thumbnail (PNG, cached 5 min) |
| `POST` | `/api/storage/files/upload?path=/dir` | Upload file (`multipart/form-data`, field `file`) |
| `DELETE` | `/api/storage/files?path=…` | Delete file or directory |
| `POST` | `/api/storage/files/mkdir?path=/new/dir/` | Create directory (MKCOL) |
| `GET` | `/api/storage/quota` | Nextcloud usage `{used, available, total}` (bytes; `available=-3` = unlimited) |

---

## System

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/system/status` | Announcement + maintenance state for the current user |
| `GET` | `/metrics` | Prometheus metrics (HTTP + `lwp_sessions_*` / `lwp_auth_*` counters) |

## Nextcloud hub

Per-user integrations (reuse the user's NC creds; best-effort — empty if the app isn't installed).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/nextcloud/avatar?size=64` | Proxied NC avatar image |
| `GET` | `/api/nextcloud/calendar?month=YYYY-MM` | `{calendars, events}` (events carry `href`/`uid`) |
| `POST` | `/api/nextcloud/calendar/event` | Create event `{calendar_href, summary, all_day, start, end}` |
| `DELETE` | `/api/nextcloud/calendar/event?href=…` | Delete event |
| `GET` | `/api/nextcloud/tasks` | `{lists, tasks}` (VTODO) |
| `POST` | `/api/nextcloud/tasks` | Create task `{list_href, summary}` |
| `PATCH` | `/api/nextcloud/tasks` | Toggle complete `{href, uid, summary, completed}` |
| `DELETE` | `/api/nextcloud/tasks?href=…` | Delete task |
| `GET` | `/api/nextcloud/deck` | Kanban boards |
| `GET` | `/api/nextcloud/deck/{board_id}` | Stacks + cards |
| `POST` | `/api/nextcloud/deck/card` | Create card `{board_id, stack_id, title}` |
| `POST` | `/api/nextcloud/deck/card/archive` | Archive card `{board_id, stack_id, card_id}` |
| `GET` | `/api/nextcloud/talk` | Talk conversations |
| `GET` | `/api/nextcloud/talk/{token}` | Recent messages (text chat) |
| `POST` | `/api/nextcloud/talk/{token}` | Send message `{message}` |
| `GET` | `/api/nextcloud/notifications` | NC notifications |
| `DELETE` | `/api/nextcloud/notifications` / `/{id}` | Clear all / dismiss one |
| `GET` `POST` `PUT` `DELETE` | `/api/nextcloud/notes[/{id}]` | List / create / update / delete notes |

---

## Admin — Users

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/users` | List all users |
| `GET` | `/api/admin/users/{id}` | User detail |
| `PUT` | `/api/admin/users/{id}` | Update user (is_active, is_admin, display_name) |
| `POST` | `/api/admin/users` | Create local user `{username, email, display_name, password}` |
| `POST` | `/api/admin/users/{id}/set-password` | Reset local user password `{password}` |
| `DELETE` | `/api/admin/users/{id}` | Delete user (stops desktops; blocks self / last admin) |
| `POST` | `/api/admin/users/{id}/force-logout` | Revoke all their browsers (`token_version`) |
| `POST` | `/api/admin/users/{id}/stop-sessions` | Stop all their running desktops |
| `POST` | `/api/admin/users/sign-out-all` | Revoke every user's browser session |

## Admin — Groups

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/groups` | List groups |
| `POST` | `/api/admin/groups` | Create group `{name}` |
| `PUT` | `/api/admin/groups/{id}` | Update group |
| `DELETE` | `/api/admin/groups/{id}` | Delete group |
| `GET` | `/api/admin/groups/{id}/members` | List members |
| `POST` | `/api/admin/groups/{id}/members` | Add member `{user_id}` |
| `DELETE` | `/api/admin/groups/{id}/members/{user_id}` | Remove member |

## Admin — Apps

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/apps` | All apps |
| `GET` | `/api/admin/apps/linuxserver/lookup?q=` | Browse/search the full LinuxServer.io image catalog (200+ images, proxied + cached server-side) for "Add from catalog" |
| `POST` | `/api/admin/apps` | Create app |
| `PUT` | `/api/admin/apps/{id}` | Update app |
| `DELETE` | `/api/admin/apps/{id}` | Soft-delete app |
| `GET` | `/api/admin/apps/staleness` | Last image-update check result (hourly cron) |
| `POST` | `/api/admin/apps/staleness/check` | Run the image-update check now |
| `POST` | `/api/admin/apps/{id}/pull` | Predownload the app's image in the background (dev/Docker only — k8s nodes pull on schedule) |
| `GET` | `/api/admin/apps/{id}/pull` | Predownload status: `pending`/`pulling`/`done`/`error` |
| `GET` | `/api/admin/apps/{id}/permissions` | Get `{group_ids: […], user_ids: […]}` |
| `PUT` | `/api/admin/apps/{id}/permissions` | Replace permissions `{group_ids: […], user_ids: […]}` — both empty = open to everyone |

## Admin — Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/sessions` | All active sessions across all users |
| `DELETE` | `/api/admin/sessions/{id}` | Force-stop any session |

## Admin — Stats & Audit

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/stats` | Overview: active sessions, online users, totals |
| `GET` | `/api/admin/stats/traffic` | Live traffic: active sessions, users online, active-by-app, 24h logins/failures/sessions |
| `GET` | `/api/admin/stats/analytics` | Per-app and per-user usage (session counts, avg duration, total hours) |
| `GET` | `/api/admin/stats/host` | Host disk/CPU/memory + Docker container counts (dev/Docker only — reads `/proc` + `docker.api.df()`) |
| `POST` | `/api/admin/settings/siem/test` | Send a test event to the configured SIEM/syslog target |
| `GET` | `/api/admin/audit` | Audit log (`?action=`, `?user_id=`, `?limit=`, `?offset=`) |
| `GET` | `/api/admin/settings` | Key/value settings |
| `PUT` | `/api/admin/settings` | Update settings (JSON object) |

---

## Common response shapes

### Session object
```json
{
  "id": "uuid",
  "app_id": "uuid",
  "session_token": "…",
  "status": "running",
  "app_type": "stream",
  "started_at": "2025-01-01T12:00:00Z",
  "connect_url": "/session/{token}/",
  "app_name": "Firefox",
  "app_icon": "/icons/firefox.png",
  "window_state": { "x": 100, "y": 50, "width": 1024, "height": 720 }
}
```

### User preferences object
```json
{
  "wallpaper": "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)",
  "theme": "dark",
  "desktopLayout": "icons",
  "pinned": [ { "id": "app-uuid", "type": "app", "label": "Firefox", "icon": "…", "appId": "uuid" } ],
  "quickLaunch": ["app-uuid-1", "app-uuid-2"],
  "logout_sessions": "ask"
}
```
