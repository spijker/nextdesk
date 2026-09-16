"""
Nextcloud integration helpers.
- System config lives in the Setting table (nc.* keys).
- Per-user overrides are on User.nc_url / nc_username / nc_password_enc.
"""
import base64
import hashlib
import logging
import os
import re

import httpx

from app.config import settings

log = logging.getLogger(__name__)

NC_TIMEOUT = 10


def _fernet():
    from cryptography.fernet import Fernet
    key = base64.urlsafe_b64encode(
        hashlib.sha256(settings.secret_key.encode()).digest()
    )
    return Fernet(key)


def encrypt(text: str) -> str:
    return _fernet().encrypt(text.encode()).decode()


def decrypt(text: str) -> str:
    return _fernet().decrypt(text.encode()).decode()


# ── System config (from Setting rows) ────────────────────────────────────────

async def get_system_config(db) -> dict:
    """Return dict with nc.* settings. Safe — missing keys return ''."""
    from sqlalchemy import select

    from app.models.settings import Setting

    result = await db.execute(
        select(Setting).where(Setting.key.like("nc.%"))
    )
    rows = {s.key: s.value for s in result.scalars()}
    return {
        "url":            rows.get("nc.url", ""),
        "admin_user":     rows.get("nc.admin_user", ""),
        "admin_password": rows.get("nc.admin_password", ""),  # encrypted
        "auto_provision": rows.get("nc.auto_provision", "false") == "true",
        # Mint a per-user app password from the OIDC access token on first login
        # (no admin creds needed). Requires NC user_oidc to accept bearer tokens.
        "oidc_provision": rows.get("nc.oidc_provision", "false") == "true",
        "mount_path":     rows.get("nc.mount_path", "/home/appuser/Files"),
    }


async def save_system_config(db, url: str, admin_user: str,
                              admin_password: str | None,
                              auto_provision: bool,
                              mount_path: str,
                              oidc_provision: bool = False) -> None:
    from sqlalchemy import select

    from app.models.settings import Setting

    updates = {
        "nc.url":            url,
        "nc.admin_user":     admin_user,
        "nc.auto_provision": "true" if auto_provision else "false",
        "nc.oidc_provision": "true" if oidc_provision else "false",
        "nc.mount_path":     mount_path or "/home/appuser/Files",
    }
    if admin_password:
        updates["nc.admin_password"] = encrypt(admin_password)

    for key, value in updates.items():
        result = await db.execute(select(Setting).where(Setting.key == key))
        row = result.scalar_one_or_none()
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value, description=""))
    await db.commit()


# ── Connection helpers ────────────────────────────────────────────────────────

async def test_connection(url: str, username: str, password: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=NC_TIMEOUT) as c:
            r = await c.get(
                f"{url.rstrip('/')}/ocs/v1.php/cloud/capabilities?format=json",
                headers={"OCS-APIRequest": "true"},
                auth=(username, password),
            )
        if r.status_code == 200:
            data = r.json().get("ocs", {}).get("data", {})
            version = data.get("version", {}).get("string", "?")
            return {"ok": True, "version": version}
        return {"ok": False, "error": f"HTTP {r.status_code}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


async def provision_user(nc_url: str, admin_user: str, admin_pass_enc: str,
                          username: str, email: str) -> dict:
    """Create NC user. Password is derived deterministically so we can inject it later."""
    password = _derive_user_password(username)
    admin_pass = decrypt(admin_pass_enc)

    try:
        async with httpx.AsyncClient(timeout=NC_TIMEOUT) as c:
            r = await c.post(
                f"{nc_url.rstrip('/')}/ocs/v2.php/cloud/users?format=json",
                headers={"OCS-APIRequest": "true", "Content-Type": "application/json"},
                auth=(admin_user, admin_pass),
                json={"userid": username, "password": password, "email": email},
            )
        if r.status_code in (200, 201):
            return {"ok": True, "nc_password": password}
        # 102 = "user already exists" in NC OCS
        body = r.json()
        statuscode = body.get("ocs", {}).get("meta", {}).get("statuscode", r.status_code)
        if statuscode == 102:
            return {"ok": True, "nc_password": password, "note": "already exists"}
        return {"ok": False, "error": body.get("ocs", {}).get("meta", {}).get("message", str(r.status_code))}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


async def get_user_creds(db, user) -> tuple[str, str, str] | None:
    """(nc_root_url, nc_username, password) for the user, or None if unconfigured.
    nc_root_url is the Nextcloud base (avatar/OCS/DAV all hang off it)."""
    sys_cfg = await get_system_config(db)
    nc_url = (user.nc_url or sys_cfg["url"] or "").rstrip("/")
    if not nc_url:
        return None
    nc_user = user.nc_username or user.username
    if user.nc_password_enc:
        pw = decrypt(user.nc_password_enc)
    elif sys_cfg.get("admin_password"):
        pw = _derive_user_password(user.username)
    else:
        return None
    return nc_url, nc_user, pw


async def provision_via_oidc(nc_url: str, access_token: str) -> dict:
    """Approach B: use the user's OIDC access token as a Bearer against Nextcloud
    to resolve their NC user id and mint a long-lived app password — no admin
    credentials, no first-startup provisioning.

    Requires NC's `user_oidc` app to accept the bearer token for OCS calls.
    Returns {"ok": True, "nc_user", "app_password"} or {"ok": False, "error"}.
    """
    base = nc_url.rstrip("/")
    headers = {
        "OCS-APIRequest": "true",
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=NC_TIMEOUT) as c:
            # Resolve the real NC username (used in the WebDAV path).
            who = await c.get(f"{base}/ocs/v2.php/cloud/user?format=json", headers=headers)
            if who.status_code != 200:
                return {"ok": False, "error": f"whoami HTTP {who.status_code}"}
            nc_user = who.json().get("ocs", {}).get("data", {}).get("id")
            if not nc_user:
                return {"ok": False, "error": "no user id in NC response"}

            # Mint a device/app password bound to this user.
            ap = await c.get(f"{base}/ocs/v2.php/core/getapppassword?format=json", headers=headers)
            if ap.status_code != 200:
                return {"ok": False, "error": f"getapppassword HTTP {ap.status_code}"}
            app_password = ap.json().get("ocs", {}).get("data", {}).get("apppassword")
            if not app_password:
                return {"ok": False, "error": "no apppassword in NC response"}

        return {"ok": True, "nc_user": nc_user, "app_password": app_password}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _derive_user_password(username: str) -> str:
    """Deterministic per-user NC password (24 hex chars). Stable unless SECRET_KEY changes."""
    h = hashlib.sha256(f"{settings.secret_key}:nc:{username}".encode()).hexdigest()
    return h[:24]


# ── Per-session env injection ─────────────────────────────────────────────────

def build_webdav_url(url: str, nc_user: str) -> str:
    """Canonical Nextcloud WebDAV endpoint for a user.

    rclone >= 1.74 hard-rejects Nextcloud URLs that don't end in
    /remote.php/dav/files/USER (e.g. a bare root URL, the legacy /webdav
    endpoint, or a double-appended path). Strip any dav/webdav suffix the stored
    URL may already carry, then rebuild the canonical path.
    """
    base = (url or "").strip().rstrip("/")
    base = re.sub(r"/remote\.php/dav/files/[^/]*/?$", "", base)
    base = re.sub(r"/remote\.php/(web)?dav/?$", "", base)
    base = base.rstrip("/")
    return f"{base}/remote.php/dav/files/{nc_user}"


async def get_user_nc_env(db, user, home_dir: str = "/home/lwp") -> dict:
    """
    Return env vars to inject into a session container for Nextcloud WebDAV mount.
    Returns {} if NC is not configured for the user.
    """
    sys_cfg = await get_system_config(db)

    # Determine effective URL and credentials
    url = user.nc_url or sys_cfg["url"]
    if not url:
        log.info("NC mount skipped for %s: no personal nc_url and no system nc.url configured", user.username)
        return {}

    nc_user = user.nc_username or user.username

    if user.nc_password_enc:
        nc_pass = decrypt(user.nc_password_enc)
    elif sys_cfg["url"] and sys_cfg["admin_password"]:
        # Use derived password (only works if user was provisioned this way)
        nc_pass = _derive_user_password(user.username)
    else:
        log.info("NC mount skipped for %s: no personal app-password and no system nc.admin_password "
                 "(connect Nextcloud in Profile, or set it in Admin - Settings)", user.username)
        return {}

    webdav_url = build_webdav_url(url, nc_user)

    return {
        "LWP_NC_URL":   webdav_url,
        "LWP_NC_USER":  nc_user,
        "LWP_NC_PASS":  nc_pass,
        # Strip any stale prefix from the admin-configured path and always
        # mount directly under the session's real home (/home/lwp for our
        # own images, /config for LinuxServer.io's — see the call site).
        "LWP_NC_MOUNT": home_dir.rstrip("/") + "/" + (
            os.path.basename((sys_cfg.get("mount_path") or "Files").rstrip("/")) or "Files"
        ),
    }
