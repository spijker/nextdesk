import time
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import require_role
from app.models.app_catalog import App, AppPermission
from app.models.user import User

router = APIRouter(prefix="/api/admin/apps", tags=["admin-apps"])

LINUXSERVER_API = "https://api.linuxserver.io/api/v1/images?include_config=false"
LINUXSERVER_TIMEOUT = 10
# Single-process in-memory cache — the published catalog changes on the order
# of days, not per-request; swap for Redis in multi-replica prod (same caveat
# as the build-log progress dict in admin/builds.py).
_ls_catalog: list[dict] | None = None
_ls_catalog_at = 0.0
_LS_CATALOG_TTL = 6 * 3600


async def _linuxserver_catalog() -> list[dict]:
    global _ls_catalog, _ls_catalog_at
    if _ls_catalog is not None and (time.monotonic() - _ls_catalog_at) < _LS_CATALOG_TTL:
        return _ls_catalog

    async with httpx.AsyncClient(timeout=LINUXSERVER_TIMEOUT) as c:
        try:
            resp = await c.get(LINUXSERVER_API)
        except httpx.HTTPError:
            raise HTTPException(status_code=502, detail="Couldn't reach the LinuxServer.io catalog")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="LinuxServer.io catalog lookup failed")

    images = resp.json().get("data", {}).get("repositories", {}).get("linuxserver", [])
    _ls_catalog, _ls_catalog_at = images, time.monotonic()
    return images


# Categories that actually render a usable GUI over KasmVNC — most of the
# ~200 LinuxServer.io images are headless server apps (torrent clients, the
# *arr stack, etc.) that would just show an empty desktop. Only applied when
# browsing with no search term; an explicit search still matches the whole
# catalog since the admin might know better.
GUI_CATEGORIES = (
    "web browser", "remote desktop", "documents", "email",
    "multimedia", "productivity", "creative", "graphics",
)


@router.get("/linuxserver/lookup")
async def linuxserver_lookup(
    q: str = "",
    _: User = Depends(require_role(["admin"])),
):
    """Search — or with no query, browse — the public LinuxServer.io image
    catalog (their published fleet API) so an admin can add a maintained
    lscr.io/linuxserver/<name> image (app_type=kasm, KasmVNC on port 3000)
    without hand-typing the registry path and tag. Proxied server-side,
    cached in-process."""
    images = await _linuxserver_catalog()
    needle = q.strip().lower()
    if needle:
        matches = [
            img for img in images
            if needle in (img.get("name") or "").lower()
            or needle in (img.get("category") or "").lower()
        ]
    else:
        matches = [
            img for img in images
            if any(c in (img.get("category") or "").lower() for c in GUI_CATEGORIES)
        ]
    matches.sort(key=lambda img: (-(img.get("monthly_pulls") or 0), img.get("name") or ""))
    return [
        {
            "name": img.get("name"),
            "description": img.get("description", ""),
            "category": img.get("category", ""),
            "icon_url": img.get("project_logo") or "",
            "tags": [t.get("tag") for t in img.get("tags", []) if t.get("tag")] or ["latest"],
        }
        for img in matches[:40]
    ]


@router.get("")
async def list_apps(
    _: User = Depends(require_role(["admin"])),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(App).where(App.is_deleted == False).order_by(App.category, App.name)  # noqa: E712
    )
    return [_app_out(a) for a in result.scalars().all()]


@router.get("/staleness")
async def image_staleness(
    _: User = Depends(require_role(["admin"])),
    db: AsyncSession = Depends(get_session),
):
    """Last image-update check result (hourly cron; POST /staleness/check refreshes)."""
    import json

    from app.models.settings import Setting
    raw = await db.scalar(select(Setting.value).where(Setting.key == "images.staleness"))
    if not raw:
        return {"checked_at": None, "images": {}}
    try:
        return json.loads(raw)
    except ValueError:
        return {"checked_at": None, "images": {}}


@router.post("/staleness/check")
async def run_staleness_check(
    _: User = Depends(require_role(["admin"])),
):
    from app.tasks.worker import check_image_updates
    results = await check_image_updates({})
    return {"ok": True, "images": results}


@router.post("")
async def create_app(
    body: dict,
    _: User = Depends(require_role(["admin"])),
    db: AsyncSession = Depends(get_session),
):
    app = App(
        name=body["name"],
        description=body.get("description", ""),
        category=body.get("category", "General"),
        icon_url=body.get("icon_url", ""),
        app_type=body.get("app_type", "stream"),
        container_image=body.get("container_image"),
        web_url=body.get("web_url"),
        proxy_port=int(body.get("proxy_port", 8080)),
        cpu_limit=body.get("cpu_limit", "2000m"),
        mem_limit=body.get("mem_limit", "2Gi"),
        shm_size=body.get("shm_size", "1Gi"),
        env_json=body.get("env_json", {}),
        mount_home=bool(body.get("mount_home", True)),
        web_native=bool(body.get("web_native", False)),
        is_enabled=bool(body.get("is_enabled", True)),
    )
    db.add(app)
    await db.commit()
    await db.refresh(app)
    return _app_out(app)


@router.put("/{app_id}")
async def update_app(
    app_id: uuid.UUID,
    body: dict,
    _: User = Depends(require_role(["admin"])),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(select(App).where(App.id == app_id, App.is_deleted == False))  # noqa: E712
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="App not found")

    for field in ("name", "description", "category", "icon_url", "app_type",
                  "container_image", "web_url", "cpu_limit", "mem_limit", "shm_size",
                  "env_json", "mount_home", "web_native", "is_enabled"):
        if field in body:
            setattr(app, field, body[field])
    if "proxy_port" in body:
        app.proxy_port = int(body["proxy_port"])

    await db.commit()
    await db.refresh(app)
    return _app_out(app)


@router.delete("/{app_id}")
async def delete_app(
    app_id: uuid.UUID,
    _: User = Depends(require_role(["admin"])),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(select(App).where(App.id == app_id))
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="App not found")
    app.is_deleted = True
    await db.commit()
    return {"ok": True}


@router.get("/{app_id}/permissions")
async def get_permissions(
    app_id: uuid.UUID,
    _: User = Depends(require_role(["admin"])),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(AppPermission).where(AppPermission.app_id == app_id)
    )
    return [{"group_id": str(p.group_id)} for p in result.scalars().all()]


@router.put("/{app_id}/permissions")
async def set_permissions(
    app_id: uuid.UUID,
    body: dict,
    _: User = Depends(require_role(["admin"])),
    db: AsyncSession = Depends(get_session),
):
    """Replace permissions. body = {"group_ids": ["uuid", ...]}"""
    group_ids = [uuid.UUID(g) for g in body.get("group_ids", [])]

    existing = await db.execute(select(AppPermission).where(AppPermission.app_id == app_id))
    for p in existing.scalars().all():
        await db.delete(p)

    for gid in group_ids:
        db.add(AppPermission(app_id=app_id, group_id=gid))

    await db.commit()
    return {"ok": True}


def _app_out(a: App) -> dict:
    return {
        "id": str(a.id),
        "name": a.name,
        "description": a.description,
        "category": a.category,
        "icon_url": a.icon_url,
        "app_type": a.app_type,
        "container_image": a.container_image,
        "web_url": a.web_url,
        "proxy_port": a.proxy_port,
        "cpu_limit": a.cpu_limit,
        "mem_limit": a.mem_limit,
        "shm_size": a.shm_size,
        "env_json": a.env_json,
        "mount_home": a.mount_home,
        "web_native": a.web_native,
        "is_enabled": a.is_enabled,
        "is_deleted": a.is_deleted,
    }
