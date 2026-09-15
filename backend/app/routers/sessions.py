import asyncio
import json
import os
import re
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_session
from app.dependencies import get_current_user
from app.metrics import lwp_sessions_created_total, lwp_sessions_stopped_total
from app.models.app_catalog import App
from app.models.session import Session, SessionShare
from app.models.settings import Setting
from app.models.user import User
from app.rate_limit import _session_limiter
from app.security import generate_session_token
from app.services import audit as audit_svc
from app.services import container as container_svc
from app.services import mounts as mount_svc
from app.services import nextcloud as nc_svc
from app.services import policy as policy_svc
from app.services import quota as quota_svc

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

# Env vars users may set per app themselves (Profile → App VPN defaults,
# stored in user.preferences["app_env"][app_id]). Whitelist only — users must
# never inject arbitrary env into containers (LD_PRELOAD & co).
USER_ENV_WHITELIST = ("LWP_VPN_DEFAULT", "LWP_VPN_EXEMPT")

# ttyd-based apps (Terminal, htop) — identified by their fixed ttyd port.
# The user's font preference (Profile → Terminal appearance) rides in as env;
# the container's entrypoint turns it into `ttyd -t fontFamily=…`.
TTYD_PROXY_PORT = 7681
TERM_FONT_FAMILY_RE = re.compile(r"^[A-Za-z0-9 ,'\-]{1,80}$")


@router.get("")
async def list_my_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Session)
        .where(Session.user_id == user.id, Session.status.in_(["starting", "running", "suspended"]))
        .order_by(Session.started_at.desc())
    )
    return [_session_out(s) for s in result.scalars().all()]


@router.post("")
async def create_session(
    body: dict,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    client_ip = request.client.host if request.client else "unknown"
    _session_limiter.check(client_ip)

    app_id = body.get("app_id")
    if not app_id:
        raise HTTPException(status_code=422, detail="app_id required")

    # Maintenance mode blocks new launches for non-admins (existing keep running).
    if not user.is_admin:
        maint = await db.scalar(select(Setting.value).where(Setting.key == "maintenance.enabled"))
        if maint == "true":
            msg = await db.scalar(select(Setting.value).where(Setting.key == "maintenance.message"))
            raise HTTPException(status_code=503, detail=msg or "The system is under maintenance. Please try again shortly.")

    app_result = await db.execute(
        select(App).where(
            App.id == uuid.UUID(app_id),
            App.is_enabled == True,  # noqa: E712
            App.is_deleted == False,  # noqa: E712
        )
    )
    app = app_result.scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="App not found or disabled")

    open_path = body.get("open_path")

    # Nextcloud mount env — needed up here so "Open with…" can target the real
    # mount path (admins may rename it from the default /home/lwp/Files).
    nc_env = await nc_svc.get_user_nc_env(db, user)
    mount_base = nc_env.get("LWP_NC_MOUNT", "/home/lwp/Files")

    # VNC desktop apps are single-instance per user: a second launch reuses the
    # running session (Firefox, LibreOffice, …). "Open with…" then hands the
    # file to that live session via the container opener agent instead of
    # spawning a duplicate. Checked before the concurrency limit so reusing an
    # open app never counts as a new session.
    is_vnc_desktop = app.app_type == "stream" and not app.web_native
    # Background-eligible apps (Terminal) with the user's background preference
    # are single-instance too: relaunching reattaches the running session
    # (tmux picks up where it left off) instead of spawning a second container.
    bg_reuse = (
        (app.env_json or {}).get("LWP_BG_ALLOWED") == "1"
        and bool((user.preferences or {}).get("terminal_background"))
    )
    if is_vnc_desktop or bg_reuse:
        existing = await db.scalar(
            select(Session).where(
                Session.user_id == user.id,
                Session.app_id == app.id,
                Session.status.in_(["starting", "running", "suspended"]),
            ).order_by(Session.started_at.desc())
        )
        if existing:
            # The backing container can die without going through our own
            # stop path (host reap, OOM, node restart) — background/VNC
            # sessions are exempt from the idle/lifetime reaper, so a dead
            # one would otherwise be handed back as "running" forever and
            # the app would look permanently broken to the user.
            if await container_svc.is_running(existing.pod_name):
                if existing.status == "suspended":
                    await container_svc.resume(existing.pod_name, existing.service_name)
                    existing.status = "running"
                    await db.commit()
                if open_path and nc_env:
                    await _enqueue_open_in(existing.session_token, mount_base, str(open_path))
                return _session_out(existing, app)
            existing.status = "stopped"
            existing.ended_at = datetime.now(UTC)
            await db.commit()

    # VPN gateway apps are singletons per user — the gateway owns the user's
    # "vpn" network alias, and SSO portals allow one concurrent login anyway.
    if (app.env_json or {}).get("LWP_VPN_ROLE") == "gateway":
        vpn_running = await db.scalar(
            select(func.count()).select_from(Session).where(
                Session.user_id == user.id,
                Session.app_id == app.id,
                Session.status.in_(["starting", "running"]),
            )
        )
        if vpn_running:
            raise HTTPException(
                status_code=409,
                detail="A VPN session is already running — reconnect to it, or stop it first.",
            )

    # Effective limits: per-group quota (most generous) overrides the global
    # default for non-admins; cpu/mem ceilings clamp the app request below.
    grp_max, grp_cpu, grp_mem = await quota_svc.effective_quota(db, user.id)
    limit_key = "session_limit.admin" if user.is_admin else "session_limit.user"
    limit_val = await db.scalar(select(Setting.value).where(Setting.key == limit_key))
    limit = int(limit_val) if limit_val else (10 if user.is_admin else 3)
    if grp_max is not None and not user.is_admin:
        limit = grp_max

    count = await db.scalar(
        select(func.count()).select_from(Session).where(
            Session.user_id == user.id,
            Session.status.in_(["starting", "running"]),
        )
    )
    if count >= limit:
        raise HTTPException(
            status_code=409,
            detail=f"Max {limit} concurrent sessions reached",
        )

    # Web-type apps launch the kiosk browser with START_URL injected
    if app.app_type == "web":
        if not settings.kiosk_image:
            raise HTTPException(
                status_code=503,
                detail="No kiosk image configured (set KIOSK_IMAGE env var)",
            )
        container_image = settings.kiosk_image
        effective_env = {"START_URL": app.web_url or "about:blank"}
        effective_env.update(app.env_json or {})
    else:
        if not app.container_image:
            raise HTTPException(
                status_code=422,
                detail="App has no container image configured",
            )
        container_image = app.container_image
        effective_env = app.env_json or {}

    token = generate_session_token()
    pod_name = f"lwp-{token[:8]}-{str(user.id)[:8]}"
    sess = Session(
        user_id=user.id,
        app_id=app.id,
        pod_name=pod_name,
        service_name=f"svc-{token[:8]}",
        session_token=token,
        status="starting",
        app_type=app.app_type,
        proxy_port=app.proxy_port,
    )
    db.add(sess)
    await db.flush()

    # Inject Nextcloud WebDAV env + the user's extra rclone mounts (SFTP/S3).
    # Both need FUSE. Not applied to running containers — launch-time only.
    mount_env = await mount_svc.get_user_mount_env(db, user.id)
    effective_env = {**nc_env, **mount_env, **effective_env}  # app env takes precedence

    # The user's own per-app overrides beat the app defaults (whitelisted keys).
    user_env = ((user.preferences or {}).get("app_env") or {}).get(str(app.id)) or {}
    for k in USER_ENV_WHITELIST:
        v = str(user_env.get(k, "")).strip()
        if v:
            effective_env[k] = v[:64]

    # Terminal appearance (Profile): only meaningful for ttyd-based apps —
    # xterm.js runs in the browser, so the font just needs to exist on the
    # user's own machine, nothing to install in the container.
    if app.proxy_port == TTYD_PROXY_PORT:
        prefs = user.preferences or {}
        font_family = str(prefs.get("terminal_font_family", "")).strip()
        if font_family and TERM_FONT_FAMILY_RE.match(font_family):
            effective_env["LWP_TERM_FONT_FAMILY"] = font_family
        try:
            font_size = int(prefs.get("terminal_font_size", 0))
        except (TypeError, ValueError):
            font_size = 0
        if 8 <= font_size <= 32:
            effective_env["LWP_TERM_FONT_SIZE"] = str(font_size)

    # File manager "Open with…" on a fresh session: xstartup passes
    # LWP_OPEN_FILE as the app's first argument (waiting for the rclone mount).
    if open_path and nc_env:
        safe = os.path.normpath("/" + str(open_path)).lstrip("/")
        effective_env["LWP_OPEN_FILE"] = f"{mount_base.rstrip('/')}/{safe}"

    # Group policy: recording flag → container records its X display and
    # uploads segments back to us (see lwp-record.sh in kasm-base).
    user_policy = await policy_svc.effective_policy(db, user.id)
    if user_policy["record_sessions"] and app.app_type != "web" and not app.web_native:
        effective_env["LWP_RECORD"] = "1"

    # Launched behind a live VPN gateway → the container gets the local relay
    # (see services/container.py) and the window shows a per-session VPN toggle.
    # Routing starts DIRECT unless the app opts in via env LWP_VPN_DEFAULT=on.
    # LWP_VPN_EXEMPT=1 apps never get proxy env — and no toggle.
    if (
        (app.env_json or {}).get("LWP_VPN_ROLE") != "gateway"
        and str(effective_env.get("LWP_VPN_EXEMPT", "")).lower() not in ("1", "on", "true")
    ):
        gw_envs = await db.execute(
            select(App.env_json)
            .join(Session, Session.app_id == App.id)
            .where(
                Session.user_id == user.id,
                Session.status.in_(["starting", "running"]),
            )
        )
        if any((e or {}).get("LWP_VPN_ROLE") == "gateway" for (e,) in gw_envs.all()):
            sess.vpn_enabled = str(
                effective_env.get("LWP_VPN_DEFAULT", "")
            ).lower() in ("1", "on", "true")

    # Clamp resources to the group ceiling (non-admins) if the app asks for more.
    eff_cpu, eff_mem = app.cpu_limit, app.mem_limit
    if not user.is_admin:
        if grp_cpu and quota_svc.cpu_to_millis(eff_cpu) > quota_svc.cpu_to_millis(grp_cpu):
            eff_cpu = grp_cpu
        if grp_mem and quota_svc.mem_to_bytes(eff_mem) > quota_svc.mem_to_bytes(grp_mem):
            eff_mem = grp_mem

    upstream_host = await container_svc.start(
        session_id=str(sess.id),
        session_token=token,
        pod_name=pod_name,
        service_name=sess.service_name,
        app_type=app.app_type,
        container_image=container_image,
        proxy_port=app.proxy_port,
        cpu_limit=eff_cpu,
        mem_limit=eff_mem,
        shm_size=app.shm_size,
        user_id=str(user.id),
        username=user.username,
        mount_home=app.mount_home,
        env_json=effective_env,
        needs_fuse=bool(nc_env) or bool(mount_env),
        needs_userns=bool(effective_env.get("LWP_FLATPAK_APP_ID")),
    )

    sess.upstream_host = upstream_host
    sess.status = "running"
    await audit_svc.audit(
        db, action="session.start", user=user,
        resource=f"app:{app.name}",
        detail=f"container={container_image} pod={pod_name}",
    )
    await db.commit()
    await db.refresh(sess)
    lwp_sessions_created_total.labels(user_type="admin" if user.is_admin else "user").inc()
    return _session_out(sess, app)


@router.post("/{session_id}/heartbeat")
async def heartbeat(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Keep-alive from the client so the idle reaper doesn't stop an in-use
    session. Returns expiry info so the desktop can warn before the reaper
    hits: lifetime_remaining_s (None = no lifetime cap) and idle_timeout_min
    (0 = idle reaping disabled)."""
    now = datetime.now(UTC)
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    sess.last_active = now
    await db.commit()

    max_hours_val = await db.scalar(
        select(Setting.value).where(Setting.key == "session.max_lifetime_hours"))
    idle_min_val = await db.scalar(
        select(Setting.value).where(Setting.key == "session.idle_timeout_min"))
    try:
        max_hours = int(max_hours_val) if max_hours_val is not None else settings.session_timeout_hours
    except ValueError:
        max_hours = settings.session_timeout_hours
    try:
        idle_min = int(idle_min_val) if idle_min_val is not None else 0
    except ValueError:
        idle_min = 0

    remaining = None
    if max_hours > 0:
        started = sess.started_at if sess.started_at.tzinfo else sess.started_at.replace(tzinfo=UTC)
        remaining = max(0, int((started + timedelta(hours=max_hours) - now).total_seconds()))
    return {"ok": True, "lifetime_remaining_s": remaining, "idle_timeout_min": idle_min}


@router.patch("/{session_id}/window")
async def update_window_state(
    session_id: uuid.UUID,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Persist window position/size from the desktop."""
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    sess.window_state = body
    await db.commit()
    return {"ok": True}


# Small JPEG at 480px wide / 0.55 quality (see sessionFrames.ts) — a generous
# ceiling well above that, just to bound what a client can push into the row.
THUMBNAIL_MAX_BYTES = 300_000


@router.patch("/{session_id}/thumbnail")
async def update_thumbnail(
    session_id: uuid.UUID,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Periodic live preview for admin support/moderation — see
    lib/sessionFrames.ts's client-side capture and Window.tsx's uploader."""
    data_url = str(body.get("data_url", ""))
    if not data_url.startswith("data:image/") or len(data_url) > THUMBNAIL_MAX_BYTES:
        raise HTTPException(status_code=422, detail="Invalid thumbnail")
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    sess.thumbnail = data_url
    sess.thumbnail_updated_at = datetime.now(UTC)
    await db.commit()
    return {"ok": True}


@router.delete("")
async def stop_all_sessions(
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Stop all running sessions for the current user (called on logout)."""
    result = await db.execute(
        select(Session).where(
            Session.user_id == user.id,
            Session.status.in_(["starting", "running"]),
        )
    )
    sessions = result.scalars().all()
    for sess in sessions:
        if sess.app_type != "web":
            background.add_task(container_svc.stop, sess.pod_name, sess.service_name)
        sess.status = "stopped"
        sess.ended_at = datetime.now(UTC)
    if sessions:
        await audit_svc.audit(
            db, action="session.stop_all", user=user,
            resource=f"user:{user.id}",
            detail=f"stopped {len(sessions)} session(s) on logout",
        )
    await db.commit()
    lwp_sessions_stopped_total.labels(reason="logout").inc(len(sessions))
    return {"stopped": len(sessions)}


@router.post("/{session_id}/pause")
async def pause_session(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess or sess.status not in ("running", "starting"):
        raise HTTPException(status_code=404, detail="Session not found or not running")
    if sess.app_type != "web":
        await container_svc.pause(sess.pod_name, sess.service_name)
    sess.status = "suspended"
    await db.commit()
    return {"ok": True}


@router.post("/{session_id}/resume")
async def resume_session(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess or sess.status != "suspended":
        raise HTTPException(status_code=404, detail="Session not found or not suspended")
    if sess.app_type != "web":
        await container_svc.resume(sess.pod_name, sess.service_name)
    sess.status = "running"
    await db.commit()
    return {"ok": True}


@router.delete("/{session_id}")
async def delete_session(
    session_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    # Mark stopped + commit immediately so the client can close the window at once;
    # the container is torn down in the background (docker/k8s stop can be slow).
    if sess.app_type != "web":
        background.add_task(container_svc.stop, sess.pod_name, sess.service_name)

    sess.status = "stopped"
    sess.ended_at = datetime.now(UTC)
    await audit_svc.audit(
        db, action="session.stop", user=user,
        resource=f"session:{sess.id}",
        detail=f"pod={sess.pod_name}",
    )
    await db.commit()
    lwp_sessions_stopped_total.labels(reason="user").inc()
    return {"ok": True}


@router.post("/self-stop")
async def self_stop(
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Called by the container when the app exits — marks the session stopped."""
    if not x_session_token:
        return Response(status_code=401)
    result = await db.execute(
        select(Session).where(
            Session.session_token == x_session_token,
            Session.status.in_(["starting", "running", "suspended"]),
        )
    )
    sess = result.scalar_one_or_none()
    if not sess:
        return Response(status_code=404)
    sess.status = "stopped"
    sess.ended_at = datetime.now(UTC)
    await db.commit()
    return {"ok": True}


@router.post("/vpn/state")
async def vpn_state_callback(
    body: dict,
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Called by the VPN gateway container when the tunnel comes up or down."""
    if not x_session_token:
        return Response(status_code=401)
    result = await db.execute(
        select(Session).where(
            Session.session_token == x_session_token,
            Session.status.in_(["starting", "running"]),
        )
    )
    sess = result.scalar_one_or_none()
    if not sess:
        return Response(status_code=404)
    sess.vpn_connected = bool(body.get("connected"))
    await db.commit()
    return {"ok": True}


@router.get("/vpn/mode")
async def vpn_mode(
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Polled by the in-container SOCKS relay (lwp-vpn-relay.py): should this
    session's traffic go through the VPN tunnel right now?"""
    if not x_session_token:
        return Response(status_code=401)
    sess = await db.scalar(
        select(Session).where(
            Session.session_token == x_session_token,
            Session.status.in_(["starting", "running"]),
        )
    )
    if not sess:
        return Response(status_code=404)
    return {"enabled": bool(sess.vpn_enabled)}


@router.post("/{session_id}/vpn")
async def toggle_session_vpn(
    session_id: uuid.UUID,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Window titlebar shield: route this session's traffic through the VPN
    (or straight out). The container relay picks the change up within ~2 s."""
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess or sess.status not in ("running", "starting"):
        raise HTTPException(status_code=404, detail="Session not found or not running")
    if sess.vpn_enabled is None:
        raise HTTPException(
            status_code=409,
            detail="Session was launched without a running VPN gateway — relaunch it to enable VPN routing.",
        )
    sess.vpn_enabled = bool(body.get("enabled"))
    await db.commit()
    return {"ok": True, "enabled": sess.vpn_enabled}


@router.get("/vpn/status")
async def vpn_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Taskbar indicator: is my VPN gateway session up, and is the tunnel live?"""
    result = await db.execute(
        select(Session, App.env_json)
        .join(App, Session.app_id == App.id)
        .where(
            Session.user_id == user.id,
            Session.status.in_(["starting", "running"]),
        )
    )
    for sess, env_json in result.all():
        if (env_json or {}).get("LWP_VPN_ROLE") == "gateway":
            return {"running": True, "connected": sess.vpn_connected}
    return {"running": False, "connected": False}


@router.post("/recording")
async def upload_recording_segment(
    request: Request,
    seq: str = "",
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Called by the container's recorder (lwp-record.sh): raw mp4 segment body.
    Stored under recordings_dir/<session_id>/<seq>.mp4."""
    if not x_session_token:
        return Response(status_code=401)
    result = await db.execute(
        select(Session).where(
            Session.session_token == x_session_token,
            Session.status.in_(["running", "starting"]),
        )
    )
    sess = result.scalar_one_or_none()
    if not sess:
        return Response(status_code=404)

    # Sanitise segment name — digits only, capped length
    seq = "".join(c for c in seq if c.isdigit())[:10] or "0"
    if int(request.headers.get("content-length") or 0) > 200 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Segment too large")

    dest_dir = os.path.join(settings.recordings_dir, str(sess.id))
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, f"{seq}.mp4")
    with open(dest, "wb") as f:
        async for chunk in request.stream():
            f.write(chunk)
    return {"ok": True}


@router.get("/validate")
async def validate_session(
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Called by Nginx auth_request for the session proxy."""
    if not x_session_token:
        return Response(status_code=401)

    result = await db.execute(
        select(Session).where(
            Session.session_token == x_session_token,
            Session.status == "running",
        )
    )
    sess = result.scalar_one_or_none()
    if not sess:
        # Not an owner token — maybe a share token pointing at someone's session.
        _share, sess = await _resolve_share(db, x_session_token)
        if not sess:
            return Response(status_code=401)

    if settings.is_dev:
        upstream = f"{sess.upstream_host or sess.pod_name}:{sess.proxy_port}"
    else:
        upstream = f"{sess.service_name}.lwp.svc.cluster.local:{sess.proxy_port}"

    resp = Response(status_code=200)
    resp.headers["X-Session-Upstream"] = upstream
    return resp


# ── Session sharing ──────────────────────────────────────────────────────────
# Owner mints a share token; guests (logged-in users) open /shared/<token>,
# which iframes /session/<share_token>/ — nginx validates it like an owner
# token. mode=view is enforced client-side with an input-blocking overlay.

@router.post("/{session_id}/share")
async def create_share(
    session_id: uuid.UUID,
    body: dict,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess or sess.status not in ("running", "starting"):
        raise HTTPException(status_code=404, detail="Session not found or not running")

    mode = body.get("mode", "view")
    if mode not in ("view", "control"):
        raise HTTPException(status_code=422, detail="mode must be view or control")
    ttl_min = body.get("ttl_minutes")
    expires_at = None
    if ttl_min:
        expires_at = datetime.now(UTC) + timedelta(minutes=int(ttl_min))

    share = SessionShare(
        session_id=sess.id,
        token=generate_session_token(),
        mode=mode,
        created_by=user.id,
        expires_at=expires_at,
    )
    db.add(share)
    await audit_svc.audit(
        db, action="session.share", user=user,
        resource=f"session:{sess.id}",
        detail=f"mode={mode} ttl={ttl_min or 'none'}",
    )
    await db.commit()
    await db.refresh(share)
    return _share_out(share)


@router.get("/{session_id}/shares")
async def list_shares(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(SessionShare)
        .join(Session, SessionShare.session_id == Session.id)
        .where(
            Session.id == session_id,
            Session.user_id == user.id,
            SessionShare.revoked == False,  # noqa: E712
        )
        .order_by(SessionShare.created_at.desc())
    )
    now = datetime.now(UTC)
    return [
        _share_out(s) for s in result.scalars().all()
        if not (s.expires_at and s.expires_at < now)
    ]


@router.delete("/shares/{share_id}")
async def revoke_share(
    share_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(SessionShare)
        .join(Session, SessionShare.session_id == Session.id)
        .where(SessionShare.id == share_id, Session.user_id == user.id)
    )
    share = result.scalar_one_or_none()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    share.revoked = True
    await audit_svc.audit(
        db, action="session.share_revoke", user=user,
        resource=f"session:{share.session_id}",
        detail=f"share={share.id}",
    )
    await db.commit()
    return {"ok": True}


@router.get("/shared/{token}/info")
async def shared_info(
    token: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Guest viewer bootstrap: resolves a share token to app name + mode.
    Requires login — share links are for authenticated users only."""
    share, sess, app_name, owner = await _resolve_share(db, token, with_meta=True)
    if not share:
        raise HTTPException(status_code=404, detail="Share link invalid or expired")
    return {
        "connect_url": f"/session/{share.token}/",
        "mode": share.mode,
        "app_name": app_name,
        "owner": owner,
    }


async def _resolve_share(db: AsyncSession, token: str, with_meta: bool = False):
    """Share token → (share, session[, app_name, owner_username]) if valid."""
    result = await db.execute(
        select(SessionShare, Session)
        .join(Session, SessionShare.session_id == Session.id)
        .where(
            SessionShare.token == token,
            SessionShare.revoked == False,  # noqa: E712
            Session.status == "running",
        )
    )
    row = result.first()
    if not row:
        return (None, None, None, None) if with_meta else (None, None)
    share, sess = row
    if share.expires_at and share.expires_at < datetime.now(UTC):
        return (None, None, None, None) if with_meta else (None, None)
    if not with_meta:
        return share, sess
    app_name = await db.scalar(select(App.name).where(App.id == sess.app_id)) if sess.app_id else None
    owner = await db.scalar(select(User.username).where(User.id == sess.user_id))
    return share, sess, app_name or "App", owner or ""


def _share_out(s: SessionShare) -> dict:
    return {
        "id": str(s.id),
        "token": s.token,
        "mode": s.mode,
        "share_url": f"/shared/{s.token}",
        "created_at": s.created_at.isoformat(),
        "expires_at": s.expires_at.isoformat() if s.expires_at else None,
    }


@router.get("/{session_id}/audio")
async def session_audio(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Relay the desktop's Opus/Ogg audio stream (container :8081) to the browser.
    Only VNC/desktop sessions run the audio streamer."""
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess or sess.status != "running":
        raise HTTPException(status_code=404, detail="Session not running")

    host = (sess.upstream_host or sess.pod_name) if settings.is_dev \
        else f"{sess.service_name}.lwp.svc.cluster.local"
    url = f"http://{host}:8081/"

    async def gen():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None)) as c:
                async with c.stream("GET", url) as r:
                    async for chunk in r.aiter_raw():
                        yield chunk
        except Exception:
            return

    return StreamingResponse(
        gen(),
        media_type="application/ogg",
        headers={
            # Disable nginx/proxy buffering so the live stream reaches the browser.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-store",
        },
    )


@router.get("/{session_id}/video")
async def session_video(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Relay the desktop's raw H.264 stream (container :8082) for the WebCodecs
    beta viewer. One encoder client at a time (ffmpeg -listen)."""
    result = await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )
    sess = result.scalar_one_or_none()
    if not sess or sess.status != "running":
        raise HTTPException(status_code=404, detail="Session not running")

    host = (sess.upstream_host or sess.pod_name) if settings.is_dev \
        else f"{sess.service_name}.lwp.svc.cluster.local"
    url = f"http://{host}:8082/"

    async def gen():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None)) as c:
                async with c.stream("GET", url) as r:
                    async for chunk in r.aiter_raw():
                        yield chunk
        except Exception:
            return

    return StreamingResponse(
        gen(),
        media_type="video/h264",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-store",
        },
    )


@router.get("/{session_id}/launch", response_class=HTMLResponse)
async def launch_session(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """
    Launcher page loaded inside the desktop window iframe.
    Shows a loading spinner while the VNC container starts,
    then loads the noVNC HTML5 client which auto-connects via WebSocket.
    """
    result = await db.execute(
        select(Session, App)
        .join(App, Session.app_id == App.id, isouter=True)
        .where(Session.id == session_id, Session.user_id == user.id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404)
    sess, app = row

    vnc_url = f"/session/{sess.session_token}/"
    app_name  = (app.name if app else "App").replace('"', '\\"')
    sid       = str(sess.id)

    # DLP: drop the allow-downloads sandbox grant so files can't be saved
    # out of the session iframe when the group policy forbids it.
    pol = await policy_svc.effective_policy(db, user.id)
    sandbox = "allow-same-origin allow-scripts allow-forms allow-modals allow-popups"
    if not pol["disable_download"]:
        sandbox += " allow-downloads"

    html = (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
        '*{box-sizing:border-box;margin:0;padding:0}'
        'body{background:#0f0c29;overflow:hidden;font-family:system-ui,sans-serif;color:#fff}'
        '#loading{display:flex;align-items:center;justify-content:center;height:100vh}'
        '.spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.12);'
        'border-top-color:#6366f1;border-radius:50%;'
        'animation:spin .7s linear infinite;margin:0 auto 1rem}'
        '@keyframes spin{to{transform:rotate(360deg)}}'
        '#app{display:none;position:fixed;inset:0;width:100%;height:100%;border:0;background:#000}'
        '</style></head><body>'
        '<div id="loading"><div style="text-align:center">'
        '<div class="spinner"></div>'
        '<div style="font-weight:600;margin-bottom:.5rem">' + app_name + '</div>'
        '<div style="color:#9ca3af;font-size:.875rem" id="st">Starting…</div>'
        '</div></div>'
        '<iframe id="app"'
        ' allow="clipboard-read; clipboard-write; autoplay; fullscreen; display-capture"'
        ' sandbox="' + sandbox + '">'
        '</iframe>'
        '<script>(async()=>{'
        'const SID=' + json.dumps(sid) + ';'
        'const url=' + json.dumps(vnc_url) + ';'
        'const st=document.getElementById("st");'
        'const loading=document.getElementById("loading");'
        'const fr=document.getElementById("app");'
        'for(let i=0;i<120;i++){'
        'try{'
        'const r=await fetch("/api/sessions",{credentials:"include",cache:"no-store"});'
        'if(r.ok){'
        'const s=(await r.json()).find(s=>s.id===SID);'
        'if(s?.status==="running")break;'
        'if(s?.status==="error"){st.textContent="Container failed to start.";return;}'
        '}'
        '}catch(_){}'
        'st.textContent="Starting… ("+(i+1)+"s)";'
        'await new Promise(r=>setTimeout(r,1000));'
        '}'
        'st.textContent="Waiting for app…";'
        'for(let i=0;i<60;i++){'
        'try{const r=await fetch(url,{cache:"no-store"});if(r.ok)break;}catch(_){}'
        'await new Promise(r=>setTimeout(r,1500));'
        '}'
        'fr.src=url;'
        'fr.addEventListener("load",()=>{loading.style.display="none";fr.style.display="block";});'
        '})();</script></body></html>'
    )
    return HTMLResponse(content=html)


# ── xdg-open bridge ──────────────────────────────────────────────────────────
# Containers call POST /open-file with their session token; the frontend polls
# GET /open-file/poll to receive events and open files natively in the browser.

_open_file_events: dict[str, list[dict]] = defaultdict(list)
_open_file_lock = asyncio.Lock()


@router.post("/open-file")
async def container_open_file(
    body: dict,
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Called by container xdg-open when user opens a file."""
    token = x_session_token or body.get("session_token", "")
    if not token:
        return Response(status_code=401)
    result = await db.execute(
        select(Session).where(
            Session.session_token == token,
            Session.status.in_(["running", "starting"]),
        )
    )
    sess = result.scalar_one_or_none()
    if not sess:
        return Response(status_code=404)
    event = {"path": body.get("path", ""), "mime": body.get("mime", "")}
    async with _open_file_lock:
        _open_file_events[str(sess.user_id)].append(event)
    return {"ok": True}


@router.get("/open-file/poll")
async def poll_open_file(user: User = Depends(get_current_user)):
    """Frontend polls this to receive pending open-file events from containers."""
    async with _open_file_lock:
        events = _open_file_events.pop(str(user.id), [])
    return {"events": events}


# ── Open-in-running-session bridge (frontend "Open with…" → container) ────────
# The file manager sends a Nextcloud-relative path here for a running session;
# the session's opener agent polls and opens it in the already-running app.

_open_in_events: dict[str, list[str]] = defaultdict(list)


async def _enqueue_open_in(session_token: str, mount_base: str, nc_path: str) -> None:
    safe = os.path.normpath("/" + nc_path).lstrip("/")
    async with _open_file_lock:
        _open_in_events[session_token].append(f"{mount_base.rstrip('/')}/{safe}")


@router.get("/open-in/poll")
async def poll_open_in(
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Container opener agent polls this with its session token to receive files
    the user asked to open in this already-running session."""
    if not x_session_token:
        return Response(status_code=401)
    sess = await db.scalar(
        select(Session).where(
            Session.session_token == x_session_token,
            Session.status.in_(["running", "starting"]),
        )
    )
    if not sess:
        return Response(status_code=404)
    async with _open_file_lock:
        paths = _open_in_events.pop(x_session_token, [])
    return {"paths": paths}


def _session_out(s: Session, app: App | None = None) -> dict:
    base: dict = {
        "id": str(s.id),
        "app_id": str(s.app_id) if s.app_id else None,
        "session_token": s.session_token,
        "status": s.status,
        "app_type": s.app_type,
        "started_at": s.started_at.isoformat(),
        "window_state": s.window_state or {},
        # None = no VPN plumbing (toggle hidden); bool = per-window VPN routing
        "vpn_enabled": s.vpn_enabled,
    }
    # All app types stream through the session proxy — direct URL, no launch page
    base["connect_url"] = f"/session/{s.session_token}/"
    if app:
        base["app_name"] = app.name
        base["app_icon"] = app.icon_url
        if app.app_type == "web":
            base["web_url"] = app.web_url  # informational only (shown in taskbar)
    return base
