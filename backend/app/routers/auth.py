import logging
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from authlib.integrations.httpx_client import AsyncOAuth2Client
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_session
from app.dependencies import get_current_user
from app.metrics import lwp_auth_failed_total, lwp_auth_total
from app.models.session import Session
from app.models.settings import Setting
from app.models.user import Group, User, UserGroup
from app.security import (
    create_access_token,
    create_refresh_token,
    create_totp_pending_token,
    verify_token,
    verify_token_claims,
)
from app.services import audit as audit_svc
from app.services import policy as policy_svc
from app.services import quota as quota_svc
from app.services.auth_ldap import authenticate_ldap
from app.services.auth_local import hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# ── cookies ───────────────────────────────────────────────────────────────────
#
# "Secure" needs to follow the actual connection scheme, not just settings.is_dev:
# both nginx/dev.conf and prod.conf always terminate real TLS and forward
# X-Forwarded-Proto, so a "dev" deployment behind nginx is still genuinely
# HTTPS end-to-end — only a bare, unproxied `uvicorn` run (no nginx in front)
# is actually plain HTTP. Deriving it per-request instead of from a static
# flag gets both cases right automatically.

def _is_secure(request: Request) -> bool:
    if request.headers.get("x-forwarded-proto", "").lower() == "https":
        return True
    return request.url.scheme == "https"


def _cookie_opts(request: Request) -> dict:
    return dict(httponly=True, samesite="lax", secure=_is_secure(request))


# access_token/refresh_token also have to work when Nextdesk is loaded inside
# the Nextcloud embed iframe (nextcloud-app/nextdesk) — a third-party context
# from the browser's point of view. SameSite=Lax cookies are only sent on
# top-level navigations, never on third-party subrequests like an iframe's
# own fetch/XHR calls, so every request from inside the embed would look
# logged-out regardless of how the session was established (OIDC or local).
# SameSite=None opts back in, but browsers require Secure to go with it, so
# this only applies when the request actually arrived over HTTPS — plain
# HTTP doesn't support iframe embedding anyway. See "Third-party cookie
# caveat" in docs/nextcloud-app.md for the residual browsers (Safari ITP,
# hardened Firefox/Chrome) this still doesn't cover.
def _session_cookie_opts(request: Request) -> dict:
    secure = _is_secure(request)
    return dict(httponly=True, samesite="none" if secure else "lax", secure=secure)


# ── helpers ───────────────────────────────────────────────────────────────────

def _safe_next_path(next_: str | None) -> str | None:
    """Only allow same-origin relative paths (e.g. "/?open=/Docs/f.docx") as a
    post-login redirect target — anything else (absolute URL, protocol-relative
    "//host/...") is an open-redirect vector, so it's dropped."""
    if not next_ or not next_.startswith("/") or next_.startswith("//"):
        return None
    return next_


def _nextcloud_origin(configured_url: str) -> str:
    """Origin to send an "embed=1" OIDC login back to (see Login.tsx / the
    oidc_embed cookie below). Prefers the admin's storage-integration URL
    (nc.url in Settings — configured separately, for WebDAV mounting, and
    often left unset); when that's empty, falls back to OIDC_ISSUER, which
    is always configured whenever OIDC login works at all and, in the
    "Nextcloud is the OIDC provider" setup this feature targets, points at
    that same Nextcloud instance."""
    for candidate in (configured_url, settings.oidc_issuer):
        if not candidate:
            continue
        parts = urlsplit(candidate)
        if parts.scheme and parts.netloc:
            return f"{parts.scheme}://{parts.netloc}"
    return ""


def _oidc_client() -> AsyncOAuth2Client:
    return AsyncOAuth2Client(
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret,
        scope=settings.oidc_scopes,
        redirect_uri=settings.oidc_callback_url,
    )


# Cache the provider's discovery document per issuer (endpoints rarely change).
_OIDC_META: dict[str, dict] = {}


async def _oidc_metadata() -> dict:
    """Fetch the OIDC discovery document. AsyncOAuth2Client has no
    load_server_metadata, so resolve endpoints from .well-known ourselves."""
    issuer = settings.oidc_issuer.rstrip("/")
    if issuer in _OIDC_META:
        return _OIDC_META[issuer]
    url = f"{issuer}/.well-known/openid-configuration"
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(url)
            r.raise_for_status()
            meta = r.json()
    except Exception as exc:
        logging.getLogger(__name__).error("OIDC discovery failed for %s: %s", url, exc)
        raise HTTPException(status_code=502, detail=f"OIDC discovery failed: {exc}")
    _OIDC_META[issuer] = meta
    return meta


async def _issue_login(response: Response, user: User, session: AsyncSession, request: Request) -> None:
    """Establish a new browser session. Bumps token_version so any other
    browser logged in as this user is revoked (single-session takeover), then
    issues cookies carrying the new version."""
    user.token_version += 1
    await session.commit()
    await session.refresh(user)
    uid, ver = str(user.id), user.token_version
    opts = _session_cookie_opts(request)
    response.set_cookie("access_token", create_access_token(uid, ver), max_age=3600, **opts)
    response.set_cookie("refresh_token", create_refresh_token(uid, ver), max_age=86400 * 7, **opts)


async def _bootstrap_admin(session: AsyncSession, user: User) -> None:
    """First user ever created becomes admin."""
    count = await session.scalar(select(func.count()).select_from(User))
    if count == 0:
        user.is_admin = True


async def _sync_groups(session: AsyncSession, user: User, group_names: list[str]) -> None:
    for name in group_names:
        name = name.strip()
        if not name:
            continue
        result = await session.execute(select(Group).where(Group.name == name))
        group = result.scalar_one_or_none()
        if not group:
            group = Group(name=name)
            session.add(group)
            await session.flush()
        existing = await session.execute(
            select(UserGroup).where(UserGroup.user_id == user.id, UserGroup.group_id == group.id)
        )
        if not existing.scalar_one_or_none():
            session.add(UserGroup(user_id=user.id, group_id=group.id))


# ── auth methods ──────────────────────────────────────────────────────────────

@router.get("/methods")
async def auth_methods(session: AsyncSession = Depends(get_session)):
    """Return which login methods are enabled and whether first-time setup is needed."""
    methods = settings.enabled_auth_methods
    user_count = await session.scalar(select(func.count()).select_from(User))
    return {
        "oidc": "oidc" in methods,
        "oidc_label": settings.oidc_button_label,
        "local": "local" in methods,
        "ldap": "ldap" in methods,
        "needs_setup": user_count == 0,
    }


# ── local / LDAP credential login ─────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    email: str
    display_name: str = ""
    password: str


@router.post("/register")
async def register(body: RegisterRequest, request: Request, session: AsyncSession = Depends(get_session)):
    """Bootstrap: create the first admin account. Returns 403 once any user exists."""
    user_count = await session.scalar(select(func.count()).select_from(User))
    if user_count > 0:
        raise HTTPException(status_code=403, detail="Registration is closed — contact your administrator")
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")

    from app.services.auth_local import hash_password

    user = User(
        username=body.username.strip().lower(),
        email=body.email.strip().lower(),
        display_name=body.display_name or body.username,
        auth_source="local",
        password_hash=hash_password(body.password),
        is_admin=True,
        is_active=True,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)

    response = Response(content='{"ok": true}', media_type="application/json")
    await _issue_login(response, user, session, request)
    return response


@router.post("/login")
async def login(body: LoginRequest, request: Request, session: AsyncSession = Depends(get_session)):
    """Authenticate with username+password. Tries local then LDAP in that order."""
    from app.services import security_gate
    methods = settings.enabled_auth_methods
    username = body.username.strip()
    user: User | None = None

    client_ip = request.client.host if request.client else ""
    gate = await security_gate.get_cfg(session)
    if not security_gate.ip_allowed(client_ip, gate["ip_allow"], gate["ip_deny"]):
        await audit_svc.audit(session, action="auth.ip_blocked", resource=f"ip:{client_ip}", detail=f"user={username}")
        await session.commit()
        raise HTTPException(status_code=403, detail="Access from your network is not permitted")

    lock_key = f"{username.lower()}|{client_ip}"
    if gate["enabled"] and security_gate.failure_count(lock_key, gate["window"]) >= gate["max"]:
        await audit_svc.audit(session, action="auth.locked", resource=f"user:{username}", detail=f"ip={client_ip}")
        await session.commit()
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")

    # ── local ──────────────────────────────────────────────────────────────
    if "local" in methods:
        result = await session.execute(
            select(User).where(
                or_(User.username == username.lower(), User.email == username.lower()),
                User.auth_source == "local",
                User.is_active == True,  # noqa: E712
            )
        )
        candidate = result.scalar_one_or_none()
        if candidate and candidate.password_hash and verify_password(body.password, candidate.password_hash):
            user = candidate

    # ── LDAP ───────────────────────────────────────────────────────────────
    if user is None and "ldap" in methods and settings.ldap_host:
        ldap_info = await authenticate_ldap(username, body.password)
        if ldap_info:
            result = await session.execute(
                select(User).where(
                    or_(
                        User.username == ldap_info["username"],
                        User.email == ldap_info["email"],
                    ),
                    User.auth_source == "ldap",
                )
            )
            user = result.scalar_one_or_none()
            if not user:
                await _bootstrap_admin_check(session)
                user = User(
                    username=ldap_info["username"],
                    email=ldap_info["email"],
                    display_name=ldap_info["display_name"],
                    auth_source="ldap",
                )
                session.add(user)
                await session.flush()
                user_count = await session.scalar(select(func.count()).select_from(User))
                if user_count == 1:
                    user.is_admin = True
            else:
                user.email = ldap_info["email"]
                if not (user.preferences or {}).get("display_name_custom"):
                    user.display_name = ldap_info["display_name"]

            await session.flush()
            if ldap_info.get("groups"):
                await _sync_groups(session, user, ldap_info["groups"])

    if user is None:
        lwp_auth_failed_total.labels(method="password").inc()
        security_gate.record_failure(lock_key, gate["window"])
        await audit_svc.audit(session, action="auth.login_failed", resource=f"user:{body.username}", detail=f"ip={client_ip}")
        await session.commit()
        raise HTTPException(status_code=401, detail="Invalid credentials")

    security_gate.clear(lock_key)  # successful auth resets the counter

    lwp_auth_total.labels(method="password").inc()
    await audit_svc.audit(session, action="auth.login", user=user, resource=f"user:{username}")
    await session.commit()
    await session.refresh(user)

    # If TOTP is enabled, issue a short-lived pending token instead of full auth
    if user.totp_secret_enc:
        totp_token = create_totp_pending_token(str(user.id))
        return {"requires_totp": True, "totp_token": totp_token}

    response = Response(content='{"ok": true}', media_type="application/json")
    await _issue_login(response, user, session, request)
    return response


async def _bootstrap_admin_check(session: AsyncSession) -> None:
    count = await session.scalar(select(func.count()).select_from(User))
    return count  # type: ignore[return-value]  — caller handles


# ── OIDC ──────────────────────────────────────────────────────────────────────

@router.get("/oidc/login")
async def oidc_login(request: Request, next: str | None = None, embed: int = 0):
    if not settings.oidc_issuer:
        raise HTTPException(status_code=503, detail="OIDC not configured")
    metadata = await _oidc_metadata()
    async with _oidc_client() as client:
        url, state = client.create_authorization_url(metadata["authorization_endpoint"])
    response = RedirectResponse(url)
    opts = _cookie_opts(request)
    response.set_cookie("oidc_state", state, max_age=300, **opts)
    # Deep-link redirect target (e.g. "Open in Nextdesk" from Nextcloud Files) —
    # survives the round trip to the IdP and back via this cookie.
    safe_next = _safe_next_path(next)
    if safe_next:
        response.set_cookie("oidc_next", safe_next, max_age=300, **opts)
    # Login.tsx sets this when it broke out of the Nextcloud embed iframe
    # (target="_top") to run OIDC at the top level — the callback below uses
    # it to send the user back to the Nextcloud embed page instead of
    # Nextdesk's own bare "/".
    if embed:
        response.set_cookie("oidc_embed", "1", max_age=300, **opts)
    return response


@router.get("/oidc/callback")
async def oidc_callback(
    code: str,
    state: str,
    request: Request,
    oidc_state: str | None = Cookie(default=None),
    oidc_next: str | None = Cookie(default=None),
    oidc_embed: str | None = Cookie(default=None),
    session: AsyncSession = Depends(get_session),
):
    if not oidc_state or state != oidc_state:
        raise HTTPException(status_code=400, detail="Invalid state")

    metadata = await _oidc_metadata()
    async with _oidc_client() as client:
        token = await client.fetch_token(metadata["token_endpoint"], code=code)
        resp = await client.get(metadata["userinfo_endpoint"])
        resp.raise_for_status()
        userinfo = resp.json()

    sub = userinfo.get("sub")
    email = userinfo.get("email", "")
    name = userinfo.get("name") or userinfo.get("preferred_username") or email.split("@")[0]
    username = (userinfo.get("preferred_username") or email.split("@")[0]).lower().replace(" ", "_")

    lwp_auth_total.labels(method="oidc").inc()
    result = await session.execute(select(User).where(User.oidc_sub == sub))
    user = result.scalar_one_or_none()
    if not user:
        user_count = await session.scalar(select(func.count()).select_from(User))
        user = User(
            oidc_sub=sub,
            email=email,
            username=username,
            display_name=name,
            auth_source="oidc",
            is_admin=(user_count == 0),
        )
        session.add(user)
    else:
        user.email = email
        if not (user.preferences or {}).get("display_name_custom"):
            user.display_name = name

    # Remember the IdP's avatar URL (Nextcloud sends `picture`) so the avatar
    # endpoint can serve it even when no NC app password is provisioned.
    picture = userinfo.get("picture")
    if picture and (user.preferences or {}).get("avatar_url") != picture:
        user.preferences = {**(user.preferences or {}), "avatar_url": picture}

    await session.flush()

    oidc_groups: list[str] = userinfo.get(settings.oidc_groups_claim, []) or []
    if oidc_groups:
        await _sync_groups(session, user, oidc_groups)

    await session.commit()
    await session.refresh(user)

    # Auto-provision the Nextcloud mount from the OIDC access token (approach B):
    # mint a per-user app password on first login so no admin provisioning /
    # first-startup config is needed. Best-effort — never blocks login.
    access_token = token.get("access_token")
    if access_token and not user.nc_password_enc:
        try:
            from app.services import nextcloud as nc_svc
            sys_cfg = await nc_svc.get_system_config(session)
            if sys_cfg.get("oidc_provision") and sys_cfg.get("url"):
                res = await nc_svc.provision_via_oidc(sys_cfg["url"], access_token)
                if res.get("ok"):
                    user.nc_username = res["nc_user"]
                    user.nc_password_enc = nc_svc.encrypt(res["app_password"])
                    # Provisioned users are set up — don't show first-run onboarding.
                    user.preferences = {**(user.preferences or {}), "onboarded": True}
                    await session.commit()
                    await session.refresh(user)
                else:
                    import logging
                    logging.getLogger(__name__).warning(
                        "OIDC Nextcloud provisioning failed: %s", res.get("error"))
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "OIDC Nextcloud provisioning error", exc_info=True)

    # Broke out of the Nextcloud embed for this login (see Login.tsx) — send
    # the user back to the Nextcloud page hosting Nextdesk, not Nextdesk's
    # own bare "/", so it doesn't just strand them on a full-page Nextdesk.
    # The target always comes from server-side config (nc.url or
    # OIDC_ISSUER), never the client, so there's no open-redirect risk.
    target = _safe_next_path(oidc_next) or "/"
    if oidc_embed == "1":
        from app.services import nextcloud as nc_svc
        configured_url = (await nc_svc.get_system_config(session)).get("url", "")
        origin = _nextcloud_origin(configured_url)
        if origin:
            # index.php/apps/... works whether or not the Nextcloud instance
            # has "pretty URLs" (mod_rewrite) set up — bare apps/... 404s on
            # instances that don't, since that rewrite is what maps it to
            # index.php/apps/... in the first place.
            target = f"{origin}/index.php/apps/nextdesk/"

    response = RedirectResponse(target)
    response.delete_cookie("oidc_state")
    response.delete_cookie("oidc_next")
    response.delete_cookie("oidc_embed")
    await _issue_login(response, user, session, request)
    return response


# ── token management ──────────────────────────────────────────────────────────

@router.post("/refresh")
async def refresh(
    request: Request,
    refresh_token: str | None = Cookie(default=None),
    session: AsyncSession = Depends(get_session),
):
    if not refresh_token:
        raise HTTPException(status_code=401, detail="No refresh token")
    payload = verify_token_claims(refresh_token, expected_type="refresh")
    if not payload or not payload.get("sub"):
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    result = await session.execute(select(User).where(User.id == payload["sub"], User.is_active == True))  # noqa: E712
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    # A newer login elsewhere revoked this refresh token.
    if user.token_version != payload.get("ver", 0):
        raise HTTPException(status_code=401, detail="Signed in on another device")
    response = Response()
    response.set_cookie("access_token", create_access_token(str(user.id), user.token_version), max_age=3600, **_session_cookie_opts(request))
    return response


@router.post("/logout")
async def logout(request: Request):
    response = Response()
    samesite = _session_cookie_opts(request)["samesite"]
    response.delete_cookie("access_token", samesite=samesite)
    response.delete_cookie("refresh_token", samesite=samesite)
    return response


@router.get("/me")
async def me(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    return {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "display_name": user.display_name,
        "is_admin": user.is_admin,
        "auth_source": user.auth_source,
        "preferences": user.preferences or {},
        "totp_enabled": bool(user.totp_secret_enc),
        "lock_pin_enabled": bool(user.lock_pin_hash),
        "nc_connected": bool(user.nc_password_enc),
        # DLP/security flags from group policy — the UI hides the affected
        # controls; the API endpoints enforce them server-side too.
        "policies": await policy_svc.effective_policy(db, user.id),
    }


@router.get("/me/preferences")
async def get_preferences(user: User = Depends(get_current_user)):
    return user.preferences or {}


@router.patch("/me/preferences")
async def update_preferences(
    body: dict,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one()
    db_user.preferences = {**(db_user.preferences or {}), **body}
    await session.commit()
    return db_user.preferences


@router.get("/me/groups")
async def my_groups(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Group)
        .join(UserGroup, Group.id == UserGroup.group_id)
        .where(UserGroup.user_id == user.id)
        .order_by(Group.name)
    )
    return [{"id": str(g.id), "name": g.name} for g in result.scalars()]


class ProfileUpdate(BaseModel):
    display_name: str


@router.patch("/me/profile")
async def update_my_profile(
    body: ProfileUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    dn = body.display_name.strip()
    if dn:
        user.display_name = dn
        # Mark as user-set so IdP (OIDC/LDAP) logins don't overwrite it.
        user.preferences = {**(user.preferences or {}), "display_name_custom": True}
        await session.commit()
    return {"display_name": user.display_name}


class ChangePassword(BaseModel):
    current_password: str
    new_password: str


@router.post("/me/password")
async def change_my_password(
    body: ChangePassword,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if user.auth_source != "local":
        raise HTTPException(status_code=400, detail="Password is managed by your identity provider")
    if not user.password_hash or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=422, detail="New password must be at least 8 characters")
    user.password_hash = hash_password(body.new_password)
    await session.commit()
    return {"ok": True}


@router.post("/me/sign-out-others")
async def sign_out_others(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Revoke every OTHER browser (bumps token_version) while keeping this one:
    _issue_login bumps the version (invalidating old tokens) and re-issues fresh
    cookies for the current browser."""
    response = Response(content='{"ok": true}', media_type="application/json")
    await _issue_login(response, user, session, request)
    return response


@router.get("/me/quota")
async def my_quota(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    grp_max, grp_cpu, grp_mem = await quota_svc.effective_quota(session, user.id)
    limit_key = "session_limit.admin" if user.is_admin else "session_limit.user"
    limit_val = await session.scalar(select(Setting.value).where(Setting.key == limit_key))
    limit = int(limit_val) if limit_val else (10 if user.is_admin else 3)
    if grp_max is not None and not user.is_admin:
        limit = grp_max
    used = await session.scalar(
        select(func.count()).select_from(Session).where(
            Session.user_id == user.id, Session.status.in_(["starting", "running"])
        )
    )
    return {"limit": limit, "used": used or 0, "cpu_ceiling": grp_cpu, "mem_ceiling": grp_mem}


@router.get("/me/activity")
async def my_activity(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    from app.models.audit import AuditLog
    rows = (await session.execute(
        select(AuditLog).where(AuditLog.user_id == user.id)
        .order_by(AuditLog.timestamp.desc()).limit(25)
    )).scalars().all()
    return [{
        "action": r.action, "resource": r.resource, "detail": r.detail,
        "at": r.timestamp.isoformat(),
    } for r in rows]


# ── TOTP 2FA ──────────────────────────────────────────────────────────────────

def _totp_encrypt(secret: str) -> str:
    from app.services.nextcloud import encrypt
    return encrypt(secret)


def _totp_decrypt(enc: str) -> str:
    from app.services.nextcloud import decrypt
    return decrypt(enc)


def _verify_totp(secret: str, code: str) -> bool:
    import pyotp
    totp = pyotp.TOTP(secret)
    return totp.verify(code, valid_window=1)


@router.post("/2fa/setup")
async def totp_setup(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Generate a new TOTP secret and store it as pending (needs confirmation)."""
    import pyotp
    if user.auth_source not in ("local", "ldap"):
        raise HTTPException(status_code=400, detail="2FA only available for local/LDAP accounts")
    if user.totp_secret_enc:
        raise HTTPException(status_code=400, detail="2FA already enabled; disable it first")

    secret = pyotp.random_base32()
    enc = _totp_encrypt(secret)

    result = await session.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one()
    db_user.totp_pending_enc = enc
    await session.commit()

    uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=user.email,
        issuer_name="LWP",
    )
    return {"secret": secret, "uri": uri}


class _TotpConfirmBody(BaseModel):
    code: str


@router.post("/2fa/confirm")
async def totp_confirm(
    body: _TotpConfirmBody,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one()
    if not db_user.totp_pending_enc:
        raise HTTPException(status_code=400, detail="No pending 2FA setup")

    secret = _totp_decrypt(db_user.totp_pending_enc)
    if not _verify_totp(secret, body.code):
        raise HTTPException(status_code=400, detail="Invalid code")

    db_user.totp_secret_enc = db_user.totp_pending_enc
    db_user.totp_pending_enc = None
    await session.commit()
    return {"ok": True}


@router.delete("/2fa")
async def totp_disable(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one()
    db_user.totp_secret_enc = None
    db_user.totp_pending_enc = None
    await session.commit()
    return {"ok": True}


@router.post("/2fa/verify")
async def totp_verify_login(
    body: dict,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Verify TOTP code during login (called with a totp_pending JWT)."""
    totp_token = body.get("totp_token", "")
    code = body.get("code", "")
    user_id = verify_token(totp_token, expected_type="totp_pending")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    result = await session.execute(select(User).where(User.id == user_id, User.is_active == True))  # noqa: E712
    user = result.scalar_one_or_none()
    if not user or not user.totp_secret_enc:
        raise HTTPException(status_code=401, detail="User not found")

    secret = _totp_decrypt(user.totp_secret_enc)
    if not _verify_totp(secret, code):
        raise HTTPException(status_code=400, detail="Invalid code")

    response = Response()
    await _issue_login(response, user, session, request)
    return response


# ── Idle lock screen PIN ────────────────────────────────────────────────────────
# A short PIN that re-gates an already-authenticated browser tab after the
# idle timer locks it — not a full re-auth (the session/JWT stays valid the
# whole time), so it's independent of the account password/OIDC login.

PIN_RE = re.compile(r"^\d{4,8}$")
PIN_MAX_FAILS = 5
PIN_LOCKOUT_SECONDS = 30


class _LockPinBody(BaseModel):
    pin: str


@router.post("/lock-pin")
async def set_lock_pin(
    body: _LockPinBody,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if not PIN_RE.match(body.pin):
        raise HTTPException(status_code=422, detail="PIN must be 4-8 digits")
    result = await session.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one()
    db_user.lock_pin_hash = hash_password(body.pin)
    db_user.lock_pin_fail_count = 0
    db_user.lock_pin_locked_until = None
    await session.commit()
    return {"ok": True}


@router.delete("/lock-pin")
async def disable_lock_pin(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one()
    db_user.lock_pin_hash = None
    db_user.lock_pin_fail_count = 0
    db_user.lock_pin_locked_until = None
    await session.commit()
    return {"ok": True}


@router.post("/lock-pin/verify")
async def verify_lock_pin(
    body: _LockPinBody,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).where(User.id == user.id))
    db_user = result.scalar_one()
    if not db_user.lock_pin_hash:
        raise HTTPException(status_code=400, detail="No lock PIN set")

    now = datetime.now(UTC)
    if db_user.lock_pin_locked_until and db_user.lock_pin_locked_until > now:
        wait_s = int((db_user.lock_pin_locked_until - now).total_seconds())
        raise HTTPException(status_code=429, detail=f"Too many attempts — try again in {wait_s}s")

    if not verify_password(body.pin, db_user.lock_pin_hash):
        db_user.lock_pin_fail_count += 1
        if db_user.lock_pin_fail_count >= PIN_MAX_FAILS:
            db_user.lock_pin_locked_until = now + timedelta(seconds=PIN_LOCKOUT_SECONDS)
            db_user.lock_pin_fail_count = 0
        await session.commit()
        raise HTTPException(status_code=401, detail="Incorrect PIN")

    db_user.lock_pin_fail_count = 0
    db_user.lock_pin_locked_until = None
    await session.commit()
    return {"ok": True}
