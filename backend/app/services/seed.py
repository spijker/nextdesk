"""Seed default app definitions on first boot."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.app_catalog import App

PRESETS = [
    {
        "name": "Firefox",
        "container_image": "lwp-firefox:latest",
        "category": "Browsers",
        "description": "Firefox browser.",
        "icon_url": "/icons/firefox.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "2000m",
        "mem_limit": "2Gi",
        "shm_size": "1Gi",
        "mount_home": True,
    },
    {
        "name": "Vivaldi",
        "container_image": "lwp-vivaldi:latest",
        "category": "Browsers",
        "description": "Vivaldi browser.",
        "icon_url": "/icons/vivaldi.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "2000m",
        "mem_limit": "2Gi",
        "shm_size": "1Gi",
        "mount_home": True,
    },
    {
        "name": "Thunderbird",
        "container_image": "lwp-thunderbird:latest",
        "category": "Office",
        "description": "Thunderbird email client.",
        "icon_url": "/icons/thunderbird.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "1000m",
        "mem_limit": "1Gi",
        "shm_size": "512Mi",
        "mount_home": True,
    },
    {
        "name": "LibreOffice",
        "container_image": "lwp-libreoffice:latest",
        "category": "Office",
        "description": "LibreOffice suite.",
        "icon_url": "/icons/libreoffice.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "2000m",
        "mem_limit": "2Gi",
        "shm_size": "512Mi",
        "mount_home": True,
    },
    {
        "name": "Terminator",
        "container_image": "lwp-terminator:latest",
        "category": "Tools",
        "description": "Terminator terminal emulator (X11 desktop).",
        "icon_url": "/icons/terminal.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "500m",
        "mem_limit": "512Mi",
        "shm_size": "256Mi",
        "mount_home": True,
    },
    {
        "name": "Terminal",
        "container_image": "lwp-terminal:latest",
        "web_native": True,
        "category": "Tools",
        "description": "Lightweight web terminal (bash in a persistent screen session).",
        "icon_url": "/icons/terminal.svg",
        "app_type": "stream",
        "proxy_port": 7681,
        "cpu_limit": "200m",
        "mem_limit": "256Mi",
        "shm_size": "0",
        "mount_home": True,
        # Eligible for the per-user "keep running in background" preference
        # (screen keeps jobs alive; reaper caps background sessions at 48h).
        "env_json": {"LWP_BG_ALLOWED": "1"},
    },
    {
        "name": "SSHPilot",
        "container_image": "lwp-sshpilot:latest",
        "category": "Tools",
        "description": "SSHPilot — GUI SSH client for managing remote connections.",
        "icon_url": "/icons/sshpilot.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "500m",
        "mem_limit": "512Mi",
        "shm_size": "256Mi",
        "mount_home": True,
    },
    {
        "name": "VSCodium",
        "container_image": "lwp-vscodium:latest",
        "category": "Development",
        "description": "VSCodium — open-source build of VS Code.",
        "icon_url": "/icons/vscodium.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "1000m",
        "mem_limit": "1Gi",
        "shm_size": "256Mi",
        "mount_home": True,
    },
    {
        "name": "Headlamp",
        "container_image": "lwp-headlamp:latest",
        "category": "Development",
        "description": "Headlamp — Kubernetes web UI desktop app.",
        "icon_url": "/icons/headlamp.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "500m",
        "mem_limit": "512Mi",
        "shm_size": "256Mi",
        "mount_home": True,
    },
    {
        "name": "FileZilla",
        "container_image": "lwp-filezilla:latest",
        "category": "Tools",
        "description": "FileZilla — FTP/SFTP file transfer client.",
        "icon_url": "/icons/filezilla.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "500m",
        "mem_limit": "512Mi",
        "shm_size": "64Mi",
        "mount_home": True,
    },
    {
        "name": "Remmina",
        "container_image": "lwp-remmina:latest",
        "category": "Tools",
        "description": "Remmina — remote desktop client (RDP/VNC).",
        "icon_url": "/icons/remmina.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "500m",
        "mem_limit": "512Mi",
        "shm_size": "64Mi",
        "mount_home": True,
    },
    {
        "name": "Ferdium",
        "container_image": "lwp-ferdium:latest",
        "category": "Internet",
        "description": "Ferdium — all your messaging services in one app.",
        "icon_url": "/icons/ferdium.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "1000m",
        "mem_limit": "1Gi",
        "shm_size": "256Mi",
        "mount_home": True,
        # Messaging services must not ride the corporate VPN; Ferdium also
        # misbehaves with SOCKS env present, so it never gets proxy env.
        "env_json": {"LWP_VPN_EXEMPT": "1"},
    },
    # ── Web-native apps (no VNC — the app serves its own UI over HTTPS) ──────────
    {
        "name": "htop",
        "container_image": "lwp-htop:latest",
        "web_native": True,
        "category": "Tools",
        "description": "htop — system monitor in the browser.",
        "icon_url": "/icons/htop.svg",
        "app_type": "stream",
        "proxy_port": 7681,
        "cpu_limit": "200m",
        "mem_limit": "128Mi",
        "shm_size": "0",
        "mount_home": False,
    },
    {
        "name": "JupyterLab",
        "container_image": "lwp-jupyterlab:latest",
        "web_native": True,
        "category": "Development",
        "description": "JupyterLab notebooks in the browser (no desktop).",
        "icon_url": "/icons/jupyterlab.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "1000m",
        "mem_limit": "1Gi",
        "shm_size": "0",
        "mount_home": True,
    },
    {
        # Per-user VPN gateway: userspace OpenConnect (GlobalProtect) + ocproxy,
        # behind a GTK4/libadwaita desktop GUI (KasmVNC, same stack as SSHPilot)
        # — not a terminal. LWP_VPN_ROLE=gateway makes the orchestrator attach
        # it to the per-user network with the fixed "vpn" alias; other sessions
        # launched while it runs get a local relay (ALL_PROXY=socks5h://127.0.0.1:1081)
        # with a per-window VPN toggle. Admins can preset the portal via env_json:
        # LWP_VPN_SERVER / LWP_VPN_USER / LWP_VPN_PROTOCOL.
        "name": "VPN",
        "container_image": "lwp-vpn:latest",
        "category": "Tools",
        "description": "GlobalProtect VPN (OpenConnect) — log in with password + TOTP; toggle the shield on each app window to route it through the tunnel.",
        "icon_url": "/icons/vpn.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "500m",
        "mem_limit": "256Mi",
        "shm_size": "0",
        "mount_home": False,
        "env_json": {"LWP_VPN_ROLE": "gateway"},
    },
    {
        "name": "OpenCode",
        "container_image": "lwp-opencode:latest",
        "category": "Development",
        "description": "OpenCode — AI coding agent (desktop app).",
        "icon_url": "/icons/opencode.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "1000m",
        "mem_limit": "2Gi",
        "shm_size": "512Mi",
        "mount_home": True,
    },
    {
        "name": "pgweb",
        "container_image": "lwp-pgweb:latest",
        "web_native": True,
        "category": "Development",
        "description": "pgweb — PostgreSQL web client (connect via the UI).",
        "icon_url": "/icons/pgweb.svg",
        "app_type": "stream",
        "proxy_port": 8080,
        "cpu_limit": "300m",
        "mem_limit": "256Mi",
        "shm_size": "0",
        "mount_home": True,
    },
]


# Behaviour-flag env keys that newer releases add to preset apps. Synced into
# existing deployments' rows too — but only when the key is absent, so an admin
# who explicitly set (or zeroed) the flag keeps their value.
SYNC_ENV_KEYS = ("LWP_BG_ALLOWED", "LWP_VPN_EXEMPT")


async def seed_apps(session: AsyncSession) -> None:
    # Top up any preset that isn't present yet (matched by name), so new
    # defaults (e.g. Terminal, SSHPilot) get added to existing deployments
    # without touching apps the admin has already created or customised.
    preset_by_name = {p["name"]: p for p in PRESETS}
    rows = (await session.scalars(select(App))).all()
    existing_names = {a.name for a in rows}
    changed = 0
    for preset in PRESETS:
        if preset["name"] in existing_names:
            continue
        session.add(App(**preset))
        changed += 1
    for app in rows:
        preset_env = (preset_by_name.get(app.name) or {}).get("env_json") or {}
        missing = {
            k: preset_env[k]
            for k in SYNC_ENV_KEYS
            if k in preset_env and k not in (app.env_json or {})
        }
        if missing:
            app.env_json = {**(app.env_json or {}), **missing}
            changed += 1
    if changed:
        await session.commit()
