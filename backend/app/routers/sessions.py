import asyncio
import base64
import ipaddress
import json
import logging
import os
import re
import urllib.parse
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

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

# Env vars users may set per app themselves (Profile → App preferences,
# stored in user.preferences["app_env"][app_id]). Whitelist only — users must
# never inject arbitrary env into containers (LD_PRELOAD & co).
# SELKIES_UI_SHOW_SIDEBAR passes straight through unchanged (it's the actual
# Selkies env var name, read once at container start — no live toggle exists,
# see the base image default in containers/selkies-base/Dockerfile).
USER_ENV_WHITELIST = ("LWP_VPN_DEFAULT", "LWP_VPN_EXEMPT", "SELKIES_UI_SHOW_SIDEBAR")

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
    # Raw value for LWP_OPEN_FILE, bypassing the NC-mount path join open_path
    # gets below — used by the kiosk link bridge, where the target is a URL
    # rather than a path under the user's Nextcloud mount.
    open_external = body.get("open_external")

    # Nextcloud mount env — needed up here so "Open with…" can target the real
    # mount path (admins may rename it from the default Files). Selkies-based
    # images keep the user's real home at /config, not /home/lwp — see the
    # matching container.py comment on the home volume.
    home_dir = "/config" if app.app_type in container_svc.SELKIES_APP_TYPES else "/home/lwp"
    nc_env = await nc_svc.get_user_nc_env(db, user, home_dir=home_dir)
    mount_base = nc_env.get("LWP_NC_MOUNT", f"{home_dir}/Files")

    # VNC desktop apps are single-instance per user: a second launch reuses the
    # running session (Firefox, LibreOffice, …). "Open with…" then hands the
    # file to that live session via the container opener agent instead of
    # spawning a duplicate. Checked before the concurrency limit so reusing an
    # open app never counts as a new session.
    is_vnc_desktop = app.app_type in ("stream", "kasm") and not app.web_native
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
                elif open_external:
                    await _enqueue_open_in_raw(existing.session_token, str(open_external))
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
    elif open_external:
        effective_env["LWP_OPEN_FILE"] = str(open_external)

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

    start_kwargs = dict(
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
    )

    # First launch of an image nginx hasn't pulled yet (a registry image, or a
    # fresh LinuxServer.io catalog pick) can take minutes — way past nginx's
    # proxy_read_timeout on /api/. Rather than block the request on the pull
    # (client sees a 502/504 while the launch actually keeps going server-side
    # and the browser never learns it succeeded), defer it to a background
    # task and return "starting" right away; the client polls GET
    # /api/sessions/{id} until it flips to "running" (or "error" — see
    # _finish_session_start). upstream_host is deterministic (== pod_name for
    # Docker; k8s never returns anything else either), so it's safe to set now.
    if app.app_type != "web" and not await container_svc.image_present(container_image):
        sess.upstream_host = pod_name
        await db.commit()
        await db.refresh(sess)
        asyncio.create_task(_finish_session_start(
            start_kwargs=start_kwargs,
            container_image=container_image,
            pod_name=pod_name,
            service_name=sess.service_name,
            app_name=app.name,
            user_id=user.id,
            is_admin=user.is_admin,
        ))
        return _session_out(sess, app)

    upstream_host = await container_svc.start(**start_kwargs)

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


async def _finish_session_start(
    *, start_kwargs: dict, container_image: str, pod_name: str, service_name: str,
    app_name: str, user_id: uuid.UUID, is_admin: bool,
) -> None:
    """Runs the deferred pull+create kicked off above, off its own DB session
    (the request that spawned this has already responded and torn its own
    down). Mirrors the synchronous path's status/audit/metric bookkeeping."""
    from app.database import SessionLocal

    session_id = uuid.UUID(start_kwargs["session_id"])
    async with SessionLocal() as db:
        sess = await db.get(Session, session_id)
        if not sess:
            return
        try:
            upstream_host = await container_svc.start(**start_kwargs)
        except Exception:
            log.exception("Deferred launch failed for session %s (image=%s)", session_id, container_image)
            sess.status = "error"
            await db.commit()
            try:
                await container_svc.stop(pod_name, service_name)
            except Exception:
                pass
            return

        sess.upstream_host = upstream_host
        sess.status = "running"
        user = await db.get(User, user_id)
        await audit_svc.audit(
            db, action="session.start", user=user,
            resource=f"app:{app_name}",
            detail=f"container={container_image} pod={pod_name}",
        )
        await db.commit()
    lwp_sessions_created_total.labels(user_type="admin" if is_admin else "user").inc()


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
    # Every app_type gets its own real per-session container (including web —
    # kiosk launches a fresh one per session, it was never actually shared).
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
    background: BackgroundTasks,
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Called by the container itself when the app exits — marks the session
    stopped and tears the container down. Without the latter, the container
    (app aside) just sits there forever: not orphaned exactly, but leaked —
    docker stop on a container that's already mid-exit is a harmless no-op,
    so this is safe to call unconditionally."""
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
    background.add_task(container_svc.stop, sess.pod_name, sess.service_name)
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
    if sess.app_type in container_svc.SELKIES_APP_TYPES:
        # Selkies-based images (LinuxServer.io pulls, our own selkies-base
        # builds, and the shared kiosk browser for app_type=web) serve plain
        # HTTP and gate their own nginx behind HTTP Basic Auth using exactly
        # the CUSTOM_USER/PASSWORD env vars container.py launched them with
        # — not the fixed proxy-tier credential below — so it's recomputed
        # per session here and forwarded, the same way X-Session-Upstream is.
        resp.headers["X-Session-Scheme"] = "http"
        owner = await db.get(User, sess.user_id)
        if owner:
            creds = f"{owner.username}:{str(sess.user_id)[:16]}"
            resp.headers["X-Session-Auth"] = "Basic " + base64.b64encode(creds.encode()).decode()
    else:
        # Our own images (lwp-kasm-base's real KasmVNC on :8080, and ttyd's
        # self-signed HTTPS for stream/web apps) all terminate TLS
        # themselves and take this same fixed credential — unrelated to any
        # per-session login, just the proxy tier's fixed default.
        resp.headers["X-Session-Scheme"] = "https"
        resp.headers["X-Session-Auth"] = "Basic bHdwOmx3cHZuYw=="
    return resp


@router.get("/{session_id}")
async def get_my_session(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Single-session lookup — the client polls this while status is
    "starting" (deferred image pull, see create_session) instead of
    re-fetching the whole list every ~1s."""
    result = await db.execute(
        select(Session, App).join(App, Session.app_id == App.id, isouter=True)
        .where(Session.id == session_id, Session.user_id == user.id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    sess, app = row
    return _session_out(sess, app)


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


async def _enqueue_open_in_raw(session_token: str, value: str) -> None:
    """Same queue as _enqueue_open_in, but for a value that's already final
    (a URL) — no NC-mount path join. See the kiosk bridge below."""
    async with _open_file_lock:
        _open_in_events[session_token].append(value)


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


# ── Kiosk link/attachment bridge (kiosk browser extension → real app) ─────────
# The kiosk's Firefox instance runs --kiosk (chromeless) — it can't offer a
# usable "open in new window" (any window it opens is kiosked too, with no
# way back) or a usable downloads UI. A bundled extension (containers/kiosk/
# extension/) intercepts explicit new-window navigations and Office-document
# downloads and hands them here instead, authenticated by the kiosk session's
# own token — same trust model as the open-in/open-file endpoints above.
# Which app each goes to is an admin-wide default (Setting), not per-kiosk:
# there's no canonical "the Firefox app" in the catalog otherwise.

_BLOCKED_IP_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
    "198.18.0.0/15", "224.0.0.0/4", "::1/128", "fc00::/7", "fe80::/10",
)]
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9 ._-]+")


async def _bridge_user(x_session_token: str | None, db: AsyncSession) -> User:
    """Resolve the user behind a live kiosk session token."""
    if not x_session_token:
        raise HTTPException(status_code=401)
    sess = await db.scalar(
        select(Session).where(
            Session.session_token == x_session_token,
            Session.status.in_(["running", "starting"]),
        )
    )
    if not sess:
        raise HTTPException(status_code=404)
    user = await db.get(User, sess.user_id)
    if not user:
        raise HTTPException(status_code=404)
    return user


async def _bridge_target_app(db: AsyncSession, setting_key: str) -> App:
    app_id = await db.scalar(select(Setting.value).where(Setting.key == setting_key))
    if not app_id:
        raise HTTPException(status_code=503, detail=f"No target app configured ({setting_key})")
    try:
        app_uuid = uuid.UUID(app_id)
    except ValueError:
        raise HTTPException(status_code=503, detail="Configured target app id is invalid")
    app = await db.scalar(
        select(App).where(App.id == app_uuid, App.is_enabled == True, App.is_deleted == False)  # noqa: E712
    )
    if not app:
        raise HTTPException(status_code=503, detail="Configured target app not found or disabled")
    return app


def _is_blocked_ip(ip_str: str) -> bool:
    ip = ipaddress.ip_address(ip_str)
    return ip.is_multicast or ip.is_reserved or ip.is_unspecified or any(ip in net for net in _BLOCKED_IP_NETS)


async def _fetch_attachment(url: str) -> bytes:
    """Server-side fetch for the attachment bridge. Basic SSRF guards — http(s)
    only, resolved target can't be a private/loopback/link-local address, no
    redirects, size capped. The URL comes from a page the admin already
    pointed the kiosk at, not arbitrary internet input, so this is a
    pragmatic check rather than a hardened egress proxy (a DNS answer could
    still change between this check and the connect below)."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=422, detail="Unsupported URL")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(parsed.hostname, None)
    except OSError:
        raise HTTPException(status_code=422, detail="Could not resolve host")
    if not infos or any(_is_blocked_ip(i[4][0]) for i in infos):
        raise HTTPException(status_code=422, detail="URL host not allowed")
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            data = bytearray()
            async for chunk in resp.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_ATTACHMENT_BYTES:
                    raise HTTPException(status_code=413, detail="Attachment too large")
    return bytes(data)


def _safe_filename(name: str) -> str:
    name = _SAFE_FILENAME_RE.sub("_", os.path.basename(name or "")).strip(" .")
    return name[:180] or "attachment"


@router.post("/bridge/open")
async def bridge_open_link(
    body: dict,
    request: Request,
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Kiosk extension → open a URL (explicit new-window link, or a PDF
    download) in the admin-configured Firefox app, reusing a running
    instance for this user if there is one."""
    user = await _bridge_user(x_session_token, db)
    url = (body.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="url required")
    app = await _bridge_target_app(db, "kiosk.link_target_app_id")
    return await create_session(
        body={"app_id": str(app.id), "open_external": url},
        request=request, user=user, db=db,
    )


@router.post("/bridge/attachment")
async def bridge_open_attachment(
    body: dict,
    request: Request,
    x_session_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """Kiosk extension → fetch an Office-document download server-side, stash
    it in the user's Nextcloud, and open it in the admin-configured
    LibreOffice app. Going via Nextcloud (rather than some new inter-
    container file path) is what makes it land somewhere the target app's
    own rclone mount already exposes — see nc_svc.upload_bytes."""
    user = await _bridge_user(x_session_token, db)
    url = (body.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="url required")
    app = await _bridge_target_app(db, "kiosk.attachment_target_app_id")

    data = await _fetch_attachment(url)
    filename = _safe_filename(
        body.get("filename") or urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1]
    )
    sys_cfg = await nc_svc.get_system_config(db)
    mount_name = nc_svc.nc_mount_name(sys_cfg)
    rel_path = f"Kiosk Downloads/{filename}"
    if not await nc_svc.upload_bytes(db, user, f"{mount_name}/{rel_path}", data):
        raise HTTPException(status_code=503, detail="Nextcloud not configured for this user")

    return await create_session(
        body={"app_id": str(app.id), "open_path": rel_path},
        request=request, user=user, db=db,
    )


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
