import asyncio
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_session
from app.dependencies import require_admin
from app.models.app_catalog import App
from app.models.audit import AuditLog
from app.models.session import Session
from app.models.user import User

router = APIRouter(prefix="/api/admin/stats", tags=["admin"])


@router.get("/host")
async def host_stats(_: User = Depends(require_admin)):
    """Docker host snapshot for the admin dashboard: disk (same host path the
    predownload feature checks before pulling an image), CPU load, memory,
    and how many containers are up. Dev/Docker only — a k8s cluster doesn't
    have one "host" to report on."""
    if not settings.is_dev:
        return {"available": False}
    return await asyncio.to_thread(_host_stats_sync)


def _host_stats_sync() -> dict:
    import os
    import shutil

    import docker

    with open("/proc/loadavg") as f:
        load1, load5, load15 = (float(x) for x in f.read().split()[:3])

    mem: dict[str, int] = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, _, rest = line.partition(":")
            mem[key] = int(rest.strip().split()[0]) * 1024  # kB -> bytes
    mem_total = mem.get("MemTotal", 0)
    mem_available = mem.get("MemAvailable", 0)

    client = docker.from_env()
    root = client.info().get("DockerRootDir", "/var/lib/docker")
    total, used, free = shutil.disk_usage(root)
    df = client.api.df()
    images_bytes = sum(i.get("Size", 0) for i in (df.get("Images") or []))

    return {
        "available": True,
        "cpu": {"cores": os.cpu_count() or 1, "load1": load1, "load5": load5, "load15": load15},
        "mem": {"total_bytes": mem_total, "available_bytes": mem_available, "used_bytes": mem_total - mem_available},
        "disk": {"total_bytes": total, "used_bytes": used, "free_bytes": free, "images_bytes": images_bytes},
        "containers": {
            "running": len(client.containers.list()),
            "total": len(client.containers.list(all=True)),
        },
    }


@router.get("/traffic")
async def get_traffic(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    """Live traffic snapshot for the admin dashboard."""
    now = datetime.now(UTC)
    since = now - timedelta(hours=24)

    rows = (await session.execute(
        select(Session, User.display_name, App.name, App.web_native)
        .join(User, User.id == Session.user_id)
        .join(App, App.id == Session.app_id)
        .where(Session.status.in_(["starting", "running", "suspended"]))
        .order_by(Session.started_at.desc())
    )).all()
    active = [{
        "user": dn, "app": an, "web_native": bool(wn),
        "status": s.status,
        "started_at": s.started_at.isoformat() if s.started_at else None,
    } for s, dn, an, wn in rows]

    by_app: dict[str, int] = {}
    for a in active:
        if a["status"] in ("starting", "running"):
            by_app[a["app"]] = by_app.get(a["app"], 0) + 1

    auth_ok = await session.scalar(select(func.count()).select_from(AuditLog)
        .where(AuditLog.action == "auth.login", AuditLog.timestamp >= since))
    auth_failed = await session.scalar(select(func.count()).select_from(AuditLog)
        .where(AuditLog.action == "auth.login_failed", AuditLog.timestamp >= since))
    sessions_24h = await session.scalar(select(func.count()).select_from(Session)
        .where(Session.started_at >= since))
    users_online = await session.scalar(select(func.count(func.distinct(Session.user_id)))
        .where(Session.status.in_(["starting", "running"])))

    return {
        "active": active,
        "active_count": sum(1 for a in active if a["status"] in ("starting", "running")),
        "users_online": users_online or 0,
        "by_app": [{"app": k, "count": v} for k, v in sorted(by_app.items(), key=lambda x: -x[1])],
        "auth_ok": auth_ok or 0,
        "auth_failed": auth_failed or 0,
        "sessions_24h": sessions_24h or 0,
    }


@router.get("")
async def get_stats(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    active_sessions = await session.scalar(
        select(func.count()).select_from(Session).where(Session.status.in_(["starting", "running"]))
    )
    users_online = await session.scalar(
        select(func.count(func.distinct(Session.user_id))).where(Session.status.in_(["starting", "running"]))
    )
    total_users = await session.scalar(select(func.count()).select_from(User).where(User.is_active == True))  # noqa: E712
    total_apps = await session.scalar(
        select(func.count()).select_from(App)
        .where(App.is_enabled == True, App.is_deleted == False)  # noqa: E712
    )

    return {
        "active_sessions": active_sessions or 0,
        "users_online": users_online or 0,
        "total_users": total_users or 0,
        "total_apps": total_apps or 0,
    }


@router.get("/analytics")
async def get_analytics(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
):
    # Sessions per app with average duration in minutes
    app_rows = (await db.execute(
        select(
            App.name,
            App.icon_url,
            func.count(Session.id).label("total"),
            func.count(case((Session.status.in_(["starting", "running"]), Session.id))).label("active"),
            func.round(
                func.avg(
                    func.extract(
                        "epoch",
                        func.coalesce(Session.ended_at, func.now()) - Session.started_at,
                    )
                ) / 60,
                1,
            ).label("avg_duration_min"),
        )
        .join(App, App.id == Session.app_id, isouter=True)
        .group_by(App.id, App.name, App.icon_url)
        .order_by(func.count(Session.id).desc())
        .limit(20)
    )).all()

    # Top users by total sessions
    user_rows = (await db.execute(
        select(
            User.display_name,
            User.username,
            func.count(Session.id).label("total"),
            func.count(case((Session.status.in_(["starting", "running"]), Session.id))).label("active"),
        )
        .join(Session, Session.user_id == User.id)
        .group_by(User.id, User.display_name, User.username)
        .order_by(func.count(Session.id).desc())
        .limit(10)
    )).all()

    # Total session time (hours)
    total_hours = await db.scalar(
        select(
            func.round(
                func.coalesce(
                    func.sum(
                        func.extract(
                            "epoch",
                            func.coalesce(Session.ended_at, func.now()) - Session.started_at,
                        )
                    ) / 3600,
                    0,
                ),
                1,
            )
        ).select_from(Session)
    )

    return {
        "by_app": [
            {
                "name": r.name or "Unknown",
                "icon_url": r.icon_url,
                "total": r.total,
                "active": r.active,
                "avg_duration_min": float(r.avg_duration_min or 0),
            }
            for r in app_rows
        ],
        "by_user": [
            {
                "display_name": r.display_name or r.username,
                "username": r.username,
                "total": r.total,
                "active": r.active,
            }
            for r in user_rows
        ],
        "total_session_hours": float(total_hours or 0),
    }
