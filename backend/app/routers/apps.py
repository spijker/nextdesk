import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.app_catalog import App, AppPermission
from app.models.user import User, UserGroup

router = APIRouter(prefix="/api/apps", tags=["apps"])

# Personal web apps always run through the shared kiosk browser (app_type=web
# — see services/container.py, which ignores App.container_image entirely
# for this type) on the Selkies base — same fixed resource shape the admin
# UI defaults new web apps to.
PERSONAL_APP_DEFAULTS = dict(
    app_type="web", category="Web apps", proxy_port=3000,
    cpu_limit="2000m", mem_limit="2Gi", shm_size="1Gi", mount_home=False,
)


@router.get("")
async def list_apps(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Return apps the current user has access to.
    Admins see everything; regular users see apps whose groups they belong to
    or apps with no permission restrictions (open to all).
    """
    if user.is_admin:
        result = await db.execute(
            select(App).where(App.is_enabled == True, App.is_deleted == False)  # noqa: E712
            .order_by(App.category, App.name)
        )
        apps = result.scalars().all()
    else:
        # Collect user group ids
        group_result = await db.execute(
            select(UserGroup.group_id).where(UserGroup.user_id == user.id)
        )
        group_ids = [r for r in group_result.scalars().all()]

        # Apps the user's groups (or the user directly) can access, OR apps
        # with no permissions set at all (open to everyone).
        open_result = await db.execute(
            select(App)
            .where(App.is_enabled == True, App.is_deleted == False)  # noqa: E712
            .where(
                ~App.id.in_(select(AppPermission.app_id).distinct())
                | App.id.in_(
                    select(AppPermission.app_id).where(AppPermission.group_id.in_(group_ids))
                )
                | App.id.in_(
                    select(AppPermission.app_id).where(AppPermission.user_id == user.id)
                )
            )
            .order_by(App.category, App.name)
        )
        apps = open_result.scalars().all()

    return [_app_out(a) for a in apps]


def _app_out(a: App) -> dict:
    return {
        "id": str(a.id),
        "name": a.name,
        "description": a.description,
        "category": a.category,
        "icon_url": a.icon_url,
        "app_type": a.app_type,
        "web_native": a.web_native,
        "proxy_port": a.proxy_port,
        "cpu_limit": a.cpu_limit,
        "mem_limit": a.mem_limit,
        "container_image": a.container_image,
        "web_url": a.web_url,
        "mount_home": a.mount_home,
        "is_enabled": a.is_enabled,
        # VPN gateway app — drives the taskbar VPN indicator
        "is_vpn": (a.env_json or {}).get("LWP_VPN_ROLE") == "gateway",
        # Eligible for the user's "keep running in background" preference
        "bg_allowed": (a.env_json or {}).get("LWP_BG_ALLOWED") == "1",
        # Set only for a user's own self-service web app — lets the frontend
        # show edit/delete controls only for apps the viewer actually owns.
        "created_by": str(a.created_by) if a.created_by else None,
    }


def _clean_web_url(url: str) -> str:
    url = (url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=422, detail="URL must start with http:// or https://")
    if len(url) > 500:
        raise HTTPException(status_code=422, detail="URL is too long")
    return url


@router.post("/personal", status_code=201)
async def create_personal_app(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Self-service web app (Profile → My web apps) — just a name + URL,
    opened through the shared kiosk browser. Visible only to its creator
    (an AppPermission row scoping it to them, same mechanism admins use to
    restrict a catalog app to specific people)."""
    name = (body.get("name") or "").strip()
    if not name or len(name) > 200:
        raise HTTPException(status_code=422, detail="Name is required (max 200 chars)")
    web_url = _clean_web_url(body.get("web_url", ""))
    icon_url = (body.get("icon_url") or "").strip()[:500]

    app = App(
        name=name, web_url=web_url, icon_url=icon_url,
        created_by=user.id, **PERSONAL_APP_DEFAULTS,
    )
    db.add(app)
    await db.flush()
    db.add(AppPermission(app_id=app.id, user_id=user.id))
    await db.commit()
    await db.refresh(app)
    return _app_out(app)


async def _get_own_app(db: AsyncSession, app_id: uuid.UUID, user: User) -> App:
    app = await db.get(App, app_id)
    if not app or app.is_deleted or app.created_by != user.id:
        raise HTTPException(status_code=404, detail="App not found")
    return app


@router.put("/personal/{app_id}")
async def update_personal_app(
    app_id: uuid.UUID,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    app = await _get_own_app(db, app_id, user)
    if "name" in body:
        name = (body["name"] or "").strip()
        if not name or len(name) > 200:
            raise HTTPException(status_code=422, detail="Name is required (max 200 chars)")
        app.name = name
    if "web_url" in body:
        app.web_url = _clean_web_url(body["web_url"])
    if "icon_url" in body:
        app.icon_url = (body["icon_url"] or "").strip()[:500]
    await db.commit()
    await db.refresh(app)
    return _app_out(app)


@router.delete("/personal/{app_id}")
async def delete_personal_app(
    app_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    app = await _get_own_app(db, app_id, user)
    app.is_deleted = True
    await db.commit()
    return {"ok": True}
