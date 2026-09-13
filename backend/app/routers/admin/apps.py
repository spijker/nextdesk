import re
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

FLATHUB_TIMEOUT = 10
FLATPAK_APP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)+$")


@router.get("/flatpak/lookup")
async def flatpak_lookup(
    app_id: str,
    _: User = Depends(require_role(["admin"])),
):
    """Fetch name/summary/icon for a Flathub app id, so the admin only has to
    paste the id (e.g. org.videolan.VLC) when adding a Flatpak app. Proxied
    server-side so the admin's browser doesn't need to reach flathub.org."""
    app_id = app_id.strip()
    if not FLATPAK_APP_ID_RE.match(app_id):
        raise HTTPException(status_code=422, detail="That doesn't look like a Flatpak app ID (e.g. org.videolan.VLC)")

    async with httpx.AsyncClient(timeout=FLATHUB_TIMEOUT) as c:
        try:
            resp = await c.get(f"https://flathub.org/api/v2/appstream/{app_id}")
        except httpx.HTTPError:
            raise HTTPException(status_code=502, detail="Couldn't reach Flathub")

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=f"'{app_id}' isn't on Flathub")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Flathub lookup failed")

    data = resp.json()
    return {
        "app_id": app_id,
        "name": data.get("name") or app_id,
        "summary": data.get("summary") or "",
        "icon_url": data.get("icon") or "",
    }


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
