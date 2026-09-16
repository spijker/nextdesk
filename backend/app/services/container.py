"""
Container lifecycle — per-session containers.

Dev (LWP_ENV=development): Docker SDK, joins DOCKER_NETWORK.
Prod (LWP_ENV=production): kubernetes-asyncio.

Returns upstream_host string used by Nginx session proxy.
"""
import asyncio
import logging
import re
from urllib.parse import urlparse

from app.config import settings

log = logging.getLogger(__name__)

# app_type values whose container is a Selkies-based image (LinuxServer.io
# pulls, our own selkies-base builds, and — now that lwp-kiosk is rebased —
# the shared web-app browser launcher too): plain HTTP behind per-session
# CUSTOM_USER/PASSWORD, real home at /config. Everything else (our
# kasm-base/ttyd images) terminates its own TLS with a fixed credential and
# keeps state at /home/lwp — see validate_session and _docker_start_sync.
SELKIES_APP_TYPES = ("kasm", "web")

# ── Per-user VPN gateway ──────────────────────────────────────────────────────
# An app whose env_json sets LWP_VPN_ROLE=gateway (the lwp-vpn image) acts as a
# userspace OpenConnect→SOCKS5 gateway for the user's other sessions:
#   Docker: gateway + clients join a per-user bridge network; the gateway holds
#           the fixed DNS alias "vpn", so every user's apps see socks5h://vpn:1080.
#   K8s:    a stable per-user Service (lwp-vpn-<uid8>) fronts the gateway pod,
#           GC'd with the pod via ownerReference.
# Sessions launched while the gateway is up get ALL_PROXY/LWP_VPN_PROXY injected,
# pointing at the in-container relay (lwp-vpn-relay.py, 127.0.0.1:1081) rather
# than the gateway itself. The relay dials DIRECT or chains to the gateway
# (LWP_VPN_UPSTREAM) per connection, driven by the per-window toggle — so apps
# that need plain internet work without relaunching.

VPN_ROLE_ENV = "LWP_VPN_ROLE"
VPN_EXEMPT_ENV = "LWP_VPN_EXEMPT"  # env_json opt-out: never inject proxy env
VPN_PROXY_PORT = 1080
VPN_RELAY_PORT = 1081  # local per-session relay all clients actually talk to


def _vpn_exempt(env: dict) -> bool:
    """Apps that must never see proxy env (some choke on its mere presence)."""
    return str(env.get(VPN_EXEMPT_ENV, "")).lower() in ("1", "on", "true")


def _vpn_network_name(user_id: str) -> str:
    return f"lwp-vpn-{user_id}"


def _vpn_service_name(user_id: str) -> str:
    return f"lwp-vpn-{user_id[:8]}"


def _vpn_proxy_env(proxy_url: str) -> dict:
    no_proxy = "localhost,127.0.0.1," + (
        urlparse(settings.backend_internal_url).hostname or "backend"
    )
    hostport = proxy_url.split("://", 1)[-1]
    return {
        "ALL_PROXY": proxy_url,
        "all_proxy": proxy_url,
        "NO_PROXY": no_proxy,
        "no_proxy": no_proxy,
        "LWP_VPN_PROXY": proxy_url,
        # Chromium doesn't understand socks5h:// in all_proxy — it reads these
        "SOCKS_SERVER": hostport,
        "SOCKS_VERSION": "5",
    }


async def start(
    *,
    session_id: str,
    session_token: str,
    pod_name: str,
    service_name: str,
    app_type: str,
    container_image: str,
    proxy_port: int,
    cpu_limit: str,
    mem_limit: str,
    shm_size: str,
    user_id: str,
    username: str,
    mount_home: bool,
    env_json: dict,
    needs_fuse: bool = False,
) -> str:
    """Launch a container for a session. Returns the upstream host:port string."""
    if settings.is_dev:
        return await _docker_start(
            pod_name=pod_name,
            session_token=session_token,
            app_type=app_type,
            container_image=container_image,
            proxy_port=proxy_port,
            shm_size=shm_size,
            username=username,
            user_id=user_id,
            env_json=env_json,
            mount_home=mount_home,
            needs_fuse=needs_fuse,
        )
    else:
        return await _k8s_start(
            session_id=session_id,
            session_token=session_token,
            pod_name=pod_name,
            service_name=service_name,
            app_type=app_type,
            container_image=container_image,
            proxy_port=proxy_port,
            cpu_limit=cpu_limit,
            mem_limit=mem_limit,
            shm_size=shm_size,
            user_id=user_id,
            username=username,
            mount_home=mount_home,
            env_json=env_json,
            needs_fuse=needs_fuse,
        )


async def stop(pod_name: str, service_name: str) -> None:
    if settings.is_dev:
        await asyncio.to_thread(_docker_stop_sync, pod_name)
    else:
        await _k8s_stop(pod_name, service_name)


async def pause(pod_name: str, service_name: str) -> None:
    if settings.is_dev:
        await asyncio.to_thread(_docker_pause_sync, pod_name)
    else:
        await _k8s_scale(service_name, replicas=0)


async def resume(pod_name: str, service_name: str) -> None:
    if settings.is_dev:
        await asyncio.to_thread(_docker_resume_sync, pod_name)
    else:
        await _k8s_scale(service_name, replicas=1)


async def image_present(container_image: str) -> bool:
    """Is the image already local? Docker only — a k8s node pulls as part of
    scheduling the pod, off the request path, so there's nothing to check
    (and nothing to defer: _k8s_start never blocks on a pull)."""
    if not settings.is_dev:
        return True
    return await asyncio.to_thread(_docker_image_present_sync, container_image)


def _docker_image_present_sync(container_image: str) -> bool:
    import docker
    client = docker.from_env()
    try:
        client.images.get(container_image)
        return True
    except docker.errors.ImageNotFound:
        return False


async def is_running(pod_name: str) -> bool:
    """Is the backing container/pod actually still alive?

    Single-instance reuse (VNC desktops, background Terminal) hands the same
    DB session back out on every relaunch — if the container died behind our
    back (host reap, OOM, node restart) with no self-stop callback, reuse
    would otherwise keep returning a dead pod forever, looking like the app
    "won't start" until the 48h background cap (or admin) cleans it up.
    """
    if settings.is_dev:
        return await asyncio.to_thread(_docker_is_running_sync, pod_name)
    return await _k8s_is_running(pod_name)


async def ensure_metadata_egress_block() -> None:
    """Block session containers from reaching the cloud metadata endpoint
    (169.254.169.254 — the same address on AWS, GCP, Azure and DigitalOcean)
    so a compromised or malicious session can't SSRF the host's instance
    credentials. Applies once, host/cluster-wide, at startup — best-effort,
    like the per-user VPN NetworkPolicy below; failures are logged, not fatal.
    """
    try:
        if settings.is_dev:
            await asyncio.to_thread(_docker_block_metadata_sync)
        else:
            await _k8s_block_metadata()
    except Exception as e:
        log.warning("Metadata-IP egress block not installed: %s", e)


# ── Docker (dev) ──────────────────────────────────────────────────────────────

async def _docker_start(
    *, pod_name, session_token, app_type, container_image, proxy_port, shm_size,
    username, user_id, env_json, mount_home, needs_fuse=False,
) -> str:
    return await asyncio.to_thread(
        _docker_start_sync,
        pod_name=pod_name,
        session_token=session_token,
        app_type=app_type,
        container_image=container_image,
        proxy_port=proxy_port,
        shm_size=shm_size,
        username=username,
        user_id=user_id,
        env_json=env_json,
        mount_home=mount_home,
        needs_fuse=needs_fuse,
    )


def _docker_start_sync(
    *, pod_name, session_token, app_type, container_image, proxy_port, shm_size,
    username, user_id, env_json, mount_home, needs_fuse=False,
) -> str:
    import docker
    client = docker.from_env()
    network = settings.docker_network

    # Remove stale container if exists
    try:
        old = client.containers.get(pod_name)
        old.remove(force=True)
    except docker.errors.NotFound:
        pass

    # create_container() (the low-level API used below, for host_config
    # control run() doesn't expose) does NOT auto-pull like `docker run`/
    # containers.run() do — it 404s if the image isn't already local. Our own
    # lwp-* images are always present (built via `make`); anything pointing
    # at a registry (a hand-typed registry.example.com/img:tag, or the
    # LinuxServer.io catalog picker) needs an explicit pull on first launch.
    try:
        client.images.get(container_image)
    except docker.errors.ImageNotFound:
        log.info("Pulling image %s (not present locally)", container_image)
        client.images.pull(container_image)

    # Base environment
    env = {
        "PUID": "1000",
        "PGID": "1000",
        "TZ": "UTC",
    }
    if app_type in SELKIES_APP_TYPES:
        # linuxserver/webtop: nginx strips /session/<token>/ prefix, so serve at /
        env.update({
            "CUSTOM_USER": username,
            "PASSWORD": user_id[:16],
            "SUBFOLDER": "/",
        })
    # xpra (stream/web) containers need no extra env — xpra manages its own display
    env.update({str(k): str(v) for k, v in env_json.items()})
    env["LWP_SESSION_TOKEN"] = session_token
    env["LWP_BACKEND_URL"] = settings.backend_internal_url

    # Per-user VPN network: the gateway creates it and takes the "vpn" alias;
    # other sessions join it (and get proxy env) only while a gateway is live.
    is_vpn_gateway = env.get(VPN_ROLE_ENV) == "gateway"
    vpn_net = None
    if is_vpn_gateway:
        try:
            vpn_net = client.networks.get(_vpn_network_name(user_id))
        except docker.errors.NotFound:
            vpn_net = client.networks.create(
                _vpn_network_name(user_id),
                driver="bridge",
                labels={"lwp.managed": "true", "lwp.user": user_id},
            )
    elif not _vpn_exempt(env):
        vpn_net = _live_vpn_network(client, user_id)
        if vpn_net is not None:
            env.setdefault("LWP_VPN_UPSTREAM", f"socks5h://vpn:{VPN_PROXY_PORT}")
            for k, v in _vpn_proxy_env(f"socks5h://127.0.0.1:{VPN_RELAY_PORT}").items():
                env.setdefault(k, v)

    # Volumes
    volumes: dict = {}
    tmpfs: dict = {}
    if mount_home:
        if app_type in SELKIES_APP_TYPES:
            # LinuxServer.io images keep all user state under /config
            # (Chromium's profile, Kali's home dir, …) — they never touch
            # /home/lwp. Keyed by image too, not just user: unlike our own
            # kasm-base apps (one shared home across all of a user's VNC
            # apps), unrelated LinuxServer.io images (Chromium vs Kali)
            # shouldn't share a /config. Without an explicit bind here,
            # Docker auto-creates a fresh anonymous volume for the image's
            # declared VOLUME /config on every single launch — silently
            # losing all data and leaking a volume every time.
            slug = re.sub(r"[^a-zA-Z0-9_.-]", "-", container_image)
            subdir = f"users/{user_id}/{slug}"
            vol_name = f"lwp-config-{user_id}-{slug}"[:200]
            bind_path = "/config"
        else:
            subdir = f"users/{user_id}/home"
            vol_name = f"lwp-home-{user_id}"
            bind_path = "/home/lwp"
        if settings.juicefs_enabled:
            # Distinct name prefix from the plain-local-driver volume above —
            # Docker refuses to create a volume with the same name but a
            # different driver than one that already exists, so reusing
            # vol_name here would break for anyone who launched before this
            # was turned on. Keeps the flag non-destructive to flip either way.
            vol_name = f"lwp-jfs-{vol_name}"[:200]
            _ensure_juicefs_volume(client, vol_name, subdir)
            # JuiceFS reserves .accesslog/.config/.stats as read-only special
            # files at the root of ANY subdir mount (confirmed: mkdir over
            # them fails EEXIST, and they can't be rm'd either) — collides
            # with real apps needing a writable ~/.config (Firefox and
            # basically every GTK/XDG app). So the volume goes one level to
            # the side instead of straight at bind_path, HOME points at a
            # real subdirectory inside it (nothing reserved below the mount
            # root), and bind_path itself becomes a tmpfs (see below) rather
            # than being left unbound — which would otherwise make Docker
            # auto-create (and leak) an anonymous volume for the image's
            # declared VOLUME bind_path.
            jfs_mount = "/mnt/lwp-jfs"
            _ensure_juicefs_home_dir(client, vol_name)
            volumes[vol_name] = {"bind": jfs_mount, "mode": "rw"}
            env["HOME"] = f"{jfs_mount}/data"
            # Browser/app caches are lots of small, frequently-rewritten
            # files — brutal on a FUSE/network-backed mount (same reasoning
            # as excluding .cache/** from the Nextcloud rclone mount, see
            # tuning.md). Caches are disposable by definition, so give them
            # real local disk instead: bind_path is already going to a
            # throwaway tmpfs stub below (to stop Docker auto-creating an
            # anonymous volume for the image's declared VOLUME there) — just
            # reuse that same tmpfs for the cache dir instead of wasting it.
            # Capped so a runaway cache can't eat host RAM; gone automatically
            # on container removal, no cleanup step needed.
            env["XDG_CACHE_HOME"] = f"{bind_path}/cache"
            tmpfs[bind_path] = "size=1g,uid=1000,gid=1000"
        else:
            try:
                client.volumes.get(vol_name)
            except docker.errors.NotFound:
                client.volumes.create(vol_name)
            volumes[vol_name] = {"bind": bind_path, "mode": "rw"}

    shm_bytes = _parse_size(shm_size)

    # FUSE device required for rclone WebDAV mount (Nextcloud)
    devices = []
    cap_add = []
    security_opt = []
    if needs_fuse:
        devices = ["/dev/fuse:/dev/fuse:rwm"]
        cap_add = ["SYS_ADMIN"]
        security_opt.append("apparmor:unconfined")

    # Built manually (create_host_config + create_container + api.start())
    # rather than the higher-level containers.run() for full control over
    # this combination of network/shm/devices/cap_add/security_opt/init.
    api = client.api
    host_config = api.create_host_config(
        network_mode=network,
        binds=volumes or None,
        tmpfs=tmpfs or None,
        shm_size=shm_bytes,
        devices=devices or None,
        cap_add=cap_add or None,
        security_opt=security_opt or None,
        # Session entrypoints exec straight into ttyd/supervisord as PID 1,
        # which never reaps orphaned children (e.g. ssh's `nc` ProxyCommand
        # child if ssh dies first) — they pile up as zombies for the life of
        # the container. --init attaches docker-init (tini) as a proper
        # subreaper. Not for Selkies-based apps though — they run s6-overlay,
        # whose suexec hard-refuses to start ("can only run as pid 1") once
        # tini takes PID 1 and execs it as PID 2 instead.
        init=(app_type not in SELKIES_APP_TYPES),
    )

    created = api.create_container(
        image=container_image,
        name=pod_name,
        environment=env,
        volumes=[v["bind"] for v in volumes.values()] if volumes else None,
        labels={
            "lwp.managed": "true",
            "lwp.session": pod_name,
            "lwp.user": user_id,
            **({"lwp.vpn": "gateway"} if is_vpn_gateway else {}),
        },
        host_config=host_config,
    )
    api.start(container=created["Id"])
    if vpn_net is not None:
        vpn_net.connect(pod_name, aliases=["vpn"] if is_vpn_gateway else None)
        if is_vpn_gateway:
            # Late join: sessions already running when the gateway starts can
            # reach vpn:1080 too (proxy env can't be injected retroactively —
            # those need manual proxy config or a relaunch).
            for c in client.containers.list(
                filters={"label": [f"lwp.user={user_id}", "lwp.managed=true"]}
            ):
                if c.name == pod_name:
                    continue
                try:
                    vpn_net.connect(c)
                except docker.errors.APIError:
                    pass  # already connected
    log.info("Started Docker container %s (image=%s)", pod_name, container_image)
    return pod_name  # Docker network resolves container by name


def _ensure_juicefs_volume(client, vol_name: str, subdir: str) -> None:
    """Idempotently create a Docker volume backed by one subdirectory of the
    existing shared JuiceFS filesystem, via the juicedata/juicefs Docker
    volume plugin. One filesystem, one subdir per (user, app) — not one
    JuiceFS filesystem per user. The plugin itself must already be
    installed on the host (`docker plugin install juicedata/juicefs
    --alias <juicefs_volume_driver> --grant-all-permissions`) — an
    operator step outside this app, see docs/storage-juicefs.md."""
    import docker
    try:
        client.volumes.get(vol_name)
        return
    except docker.errors.NotFound:
        pass
    client.volumes.create(
        vol_name,
        driver=settings.juicefs_volume_driver,
        driver_opts={
            "name": settings.juicefs_name,
            "metaurl": settings.juicefs_meta_url,
            "subdir": subdir,
        },
    )


_JFS_HOME_HELPER_IMAGE = "alpine:3.20"


def _ensure_juicefs_home_dir(client, vol_name: str) -> None:
    """Pre-create the real 'data' subdirectory HOME gets pointed at (see
    _docker_start_sync) inside a freshly-created JuiceFS volume, owned by
    the PUID/PGID (1000:1000) every session container runs its app as —
    some apps assume $HOME already exists (rather than mkdir -p'ing it
    themselves), and it has to be writable by that uid, not root (this
    helper itself runs as root). One-off throwaway container; cheap and
    idempotent."""
    import docker
    try:
        client.images.get(_JFS_HOME_HELPER_IMAGE)
    except docker.errors.ImageNotFound:
        client.images.pull(_JFS_HOME_HELPER_IMAGE)
    client.containers.run(
        _JFS_HOME_HELPER_IMAGE,
        ["sh", "-c", "mkdir -p /mnt/data && chown 1000:1000 /mnt/data"],
        volumes={vol_name: {"bind": "/mnt", "mode": "rw"}},
        remove=True,
    )


def _live_vpn_network(client, user_id: str):
    """The user's VPN network, but only if a running gateway is attached."""
    import docker
    try:
        net = client.networks.get(_vpn_network_name(user_id))
    except docker.errors.NotFound:
        return None
    net.reload()
    for c in net.containers:
        if c.labels.get("lwp.vpn") == "gateway" and c.status == "running":
            return net
    return None


def _docker_stop_sync(pod_name: str) -> None:
    import docker
    client = docker.from_env()
    try:
        c = client.containers.get(pod_name)
        c.stop(timeout=10)
        c.remove(force=True)
        log.info("Removed Docker container %s", pod_name)
    except Exception as e:
        log.warning("Docker stop error for %s: %s", pod_name, e)


def _docker_pause_sync(pod_name: str) -> None:
    import docker
    client = docker.from_env()
    try:
        client.containers.get(pod_name).pause()
        log.info("Paused Docker container %s", pod_name)
    except Exception as e:
        log.warning("Docker pause error for %s: %s", pod_name, e)


def _docker_resume_sync(pod_name: str) -> None:
    import docker
    client = docker.from_env()
    try:
        client.containers.get(pod_name).unpause()
        log.info("Unpaused Docker container %s", pod_name)
    except Exception as e:
        log.warning("Docker unpause error for %s: %s", pod_name, e)


def _docker_is_running_sync(pod_name: str) -> bool:
    import docker
    client = docker.from_env()
    try:
        c = client.containers.get(pod_name)
        return c.status in ("running", "paused")
    except docker.errors.NotFound:
        return False
    except Exception as e:
        # Can't tell — assume alive rather than yanking a live session out
        # from under the user over a transient Docker API hiccup.
        log.warning("Docker status check error for %s: %s", pod_name, e)
        return True


def _docker_block_metadata_sync() -> None:
    """Insert a DROP rule for 169.254.169.254 into the DOCKER-USER chain —
    the hook point Docker leaves alone on restart (unlike the FORWARD chain,
    which it rewrites), so this survives `docker compose restart`. Applies to
    every container on the host, including the per-user VPN networks, since
    a container's own traffic always traverses its veth into this chain
    regardless of whether it's going direct or through the in-container VPN
    relay. Runs via a throwaway --net=host helper container so it works
    whether the backend itself is containerized or not.
    """
    import docker
    client = docker.from_env()
    client.containers.run(
        "alpine:3.20",
        command=[
            "sh", "-c",
            "apk add --no-cache iptables >/dev/null 2>&1 && "
            "(iptables -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null || "
            "iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP)",
        ],
        network_mode="host",
        cap_add=["NET_ADMIN"],
        remove=True,
    )
    log.info("Metadata-IP egress block installed (DOCKER-USER chain)")


# ── Kubernetes (prod) ─────────────────────────────────────────────────────────

async def _k8s_start(
    *, session_id, session_token, pod_name, service_name, app_type,
    container_image, proxy_port, cpu_limit, mem_limit, shm_size,
    user_id, username, mount_home, env_json, needs_fuse=False,
) -> str:
    from kubernetes_asyncio import client as k8s
    from kubernetes_asyncio import config as k8s_config
    await k8s_config.load_incluster_config()

    base = {"PUID": "1000", "PGID": "1000", "TZ": "UTC"}
    if app_type in SELKIES_APP_TYPES:
        base.update({
            "CUSTOM_USER": username,
            "PASSWORD":    session_id[:16],
            "SUBFOLDER":   "/",
        })
    base.update({str(k): str(v) for k, v in env_json.items()})
    base["LWP_SESSION_TOKEN"] = session_token
    base["LWP_BACKEND_URL"] = settings.backend_internal_url

    core = k8s.CoreV1Api()

    # Per-user VPN: clients get proxy env only while the gateway Service exists
    # (it is owner-referenced to the gateway pod, so it dies with it).
    # TODO: NetworkPolicy to scope the SOCKS port to the owning user's pods.
    is_vpn_gateway = base.get(VPN_ROLE_ENV) == "gateway"
    vpn_svc_name = _vpn_service_name(user_id)
    if not is_vpn_gateway and not _vpn_exempt(base):
        try:
            await core.read_namespaced_service(name=vpn_svc_name, namespace="lwp")
            base.setdefault(
                "LWP_VPN_UPSTREAM", f"socks5h://{vpn_svc_name}:{VPN_PROXY_PORT}"
            )
            for k, v in _vpn_proxy_env(f"socks5h://127.0.0.1:{VPN_RELAY_PORT}").items():
                base.setdefault(k, v)
        except Exception:
            pass

    env_vars = [k8s.V1EnvVar(name=k, value=v) for k, v in base.items()]

    volumes = [
        k8s.V1Volume(
            name="shm",
            empty_dir=k8s.V1EmptyDirVolumeSource(medium="Memory", size_limit=shm_size),
        )
    ]
    volume_mounts = [k8s.V1VolumeMount(name="shm", mount_path="/dev/shm")]

    if mount_home:
        if app_type in SELKIES_APP_TYPES:
            # See the matching comment in _docker_start_sync — LinuxServer.io
            # images store all user state under /config, keyed per (user,
            # image) since unrelated images shouldn't share one /config.
            slug = re.sub(r"[^a-z0-9-]", "-", container_image.lower()).strip("-")[:40]
            pvc_name = f"lwp-config-{user_id[:8]}-{slug}"
            home_mount_path = "/config"
        else:
            pvc_name = f"lwp-home-{user_id}"
            home_mount_path = "/home/lwp"
        try:
            await core.read_namespaced_persistent_volume_claim(
                name=pvc_name, namespace="lwp"
            )
        except Exception:
            pvc = k8s.V1PersistentVolumeClaim(
                metadata=k8s.V1ObjectMeta(
                    name=pvc_name,
                    namespace="lwp",
                    labels={"lwp.managed": "true", "lwp.user": user_id},
                ),
                spec=k8s.V1PersistentVolumeClaimSpec(
                    access_modes=["ReadWriteOnce"],
                    storage_class_name=settings.home_storage_class,
                    resources=k8s.V1ResourceRequirements(
                        requests={"storage": settings.home_pvc_size}
                    ),
                ),
            )
            await core.create_namespaced_persistent_volume_claim(
                namespace="lwp", body=pvc
            )
            log.info("Created PVC %s (%s)", pvc_name, settings.home_pvc_size)
        volumes.append(k8s.V1Volume(
            name="home",
            persistent_volume_claim=k8s.V1PersistentVolumeClaimVolumeSource(
                claim_name=pvc_name
            ),
        ))
        volume_mounts.append(
            k8s.V1VolumeMount(name="home", mount_path=home_mount_path)
        )

    container_spec = k8s.V1Container(
        name="app",
        image=container_image,
        env=env_vars,
        ports=[
            k8s.V1ContainerPort(container_port=proxy_port, name="app"),
            k8s.V1ContainerPort(container_port=8081, name="audio"),
            k8s.V1ContainerPort(container_port=8082, name="video"),
        ],
        resources=k8s.V1ResourceRequirements(
            limits={"cpu": cpu_limit, "memory": mem_limit},
            requests={"cpu": "100m", "memory": "256Mi"},
        ),
        volume_mounts=volume_mounts,
        # K8s security contexts don't expose Docker's per-flag seccomp/apparmor
        # knobs without a custom SCC/seccomp profile, so the FUSE mount case
        # gets a full-privileged grant for now.
        security_context=k8s.V1SecurityContext(privileged=True) if needs_fuse else None,
        # startup probe polls every 1s so the pod goes Ready the moment the port
        # opens (instead of waiting for readiness' 5s initial delay); 60s grace.
        startup_probe=k8s.V1Probe(
            tcp_socket=k8s.V1TCPSocketAction(port=proxy_port),
            period_seconds=1,
            failure_threshold=60,
        ),
        readiness_probe=k8s.V1Probe(
            tcp_socket=k8s.V1TCPSocketAction(port=proxy_port),
            period_seconds=2,
        ),
        liveness_probe=k8s.V1Probe(
            tcp_socket=k8s.V1TCPSocketAction(port=proxy_port),
            period_seconds=10,
        ),
    )

    pod = k8s.V1Pod(
        metadata=k8s.V1ObjectMeta(
            name=pod_name,
            namespace="lwp",
            labels={
                "lwp.managed": "true",
                "lwp.session": session_id,
                "lwp.user": user_id,
                **({"lwp.vpn": "gateway"} if is_vpn_gateway else {}),
            },
        ),
        spec=k8s.V1PodSpec(
            restart_policy="Never",
            containers=[container_spec],
            volumes=volumes,
        ),
    )

    svc = k8s.V1Service(
        metadata=k8s.V1ObjectMeta(name=service_name, namespace="lwp"),
        spec=k8s.V1ServiceSpec(
            selector={"lwp.session": session_id},
            ports=[
                k8s.V1ServicePort(name="app", port=proxy_port, target_port=proxy_port),
                k8s.V1ServicePort(name="audio", port=8081, target_port=8081),
                k8s.V1ServicePort(name="video", port=8082, target_port=8082),
            ],
        ),
    )

    created_pod = await core.create_namespaced_pod(namespace="lwp", body=pod)
    await core.create_namespaced_service(namespace="lwp", body=svc)

    if is_vpn_gateway:
        vpn_svc = k8s.V1Service(
            metadata=k8s.V1ObjectMeta(
                name=vpn_svc_name,
                namespace="lwp",
                labels={"lwp.managed": "true", "lwp.user": user_id},
                owner_references=[k8s.V1OwnerReference(
                    api_version="v1", kind="Pod",
                    name=pod_name, uid=created_pod.metadata.uid,
                )],
            ),
            spec=k8s.V1ServiceSpec(
                selector={"lwp.session": session_id},
                ports=[k8s.V1ServicePort(
                    name="socks", port=VPN_PROXY_PORT, target_port=VPN_PROXY_PORT
                )],
            ),
        )
        try:
            await core.create_namespaced_service(namespace="lwp", body=vpn_svc)
        except Exception:
            # Stale service from a dead gateway — replace it
            await core.delete_namespaced_service(name=vpn_svc_name, namespace="lwp")
            await core.create_namespaced_service(namespace="lwp", body=vpn_svc)
        log.info("Created VPN gateway svc %s for user %s", vpn_svc_name, user_id)

        # Scope the SOCKS port to the owning user's pods (the GUI's display
        # port stays open so nginx can proxy the app). Enforcement requires a
        # CNI with NetworkPolicy support; creation is best-effort.
        netpol = k8s.V1NetworkPolicy(
            metadata=k8s.V1ObjectMeta(
                name=vpn_svc_name,
                namespace="lwp",
                labels={"lwp.managed": "true", "lwp.user": user_id},
                owner_references=vpn_svc.metadata.owner_references,
            ),
            spec=k8s.V1NetworkPolicySpec(
                pod_selector=k8s.V1LabelSelector(
                    match_labels={"lwp.session": session_id}
                ),
                policy_types=["Ingress"],
                ingress=[
                    k8s.V1NetworkPolicyIngressRule(
                        ports=[k8s.V1NetworkPolicyPort(port=proxy_port)],
                    ),
                    k8s.V1NetworkPolicyIngressRule(
                        _from=[k8s.V1NetworkPolicyPeer(
                            pod_selector=k8s.V1LabelSelector(
                                match_labels={"lwp.user": user_id}
                            )
                        )],
                        ports=[k8s.V1NetworkPolicyPort(port=VPN_PROXY_PORT)],
                    ),
                ],
            ),
        )
        networking = k8s.NetworkingV1Api()
        try:
            await networking.create_namespaced_network_policy(namespace="lwp", body=netpol)
        except Exception as e:
            try:
                await networking.delete_namespaced_network_policy(name=vpn_svc_name, namespace="lwp")
                await networking.create_namespaced_network_policy(namespace="lwp", body=netpol)
            except Exception:
                log.warning("VPN NetworkPolicy %s not created: %s", vpn_svc_name, e)

    log.info("Started K8s pod %s + svc %s", pod_name, service_name)
    return f"{service_name}.lwp.svc.cluster.local"


async def _k8s_stop(pod_name: str, service_name: str) -> None:
    from kubernetes_asyncio import client as k8s
    from kubernetes_asyncio import config as k8s_config
    await k8s_config.load_incluster_config()
    core = k8s.CoreV1Api()
    for fn, name in [(core.delete_namespaced_pod, pod_name),
                     (core.delete_namespaced_service, service_name)]:
        try:
            await fn(name=name, namespace="lwp")
        except Exception as e:
            log.warning("K8s cleanup %s: %s", name, e)



async def _k8s_is_running(pod_name: str) -> bool:
    from kubernetes_asyncio import client as k8s
    from kubernetes_asyncio import config as k8s_config
    await k8s_config.load_incluster_config()
    core = k8s.CoreV1Api()
    try:
        pod = await core.read_namespaced_pod(name=pod_name, namespace="lwp")
        return pod.status.phase in ("Running", "Pending")
    except k8s.exceptions.ApiException as e:
        if e.status == 404:
            return False
        log.warning("K8s status check error for %s: %s", pod_name, e)
        return True
    except Exception as e:
        log.warning("K8s status check error for %s: %s", pod_name, e)
        return True


async def _k8s_scale(service_name: str, replicas: int) -> None:
    """Scale a K8s deployment to pause (0) or resume (1) a session."""
    from kubernetes_asyncio import client as k8s
    from kubernetes_asyncio import config as k8s_config
    await k8s_config.load_incluster_config()
    apps = k8s.AppsV1Api()
    try:
        await apps.patch_namespaced_deployment_scale(
            name=service_name,
            namespace="lwp",
            body={"spec": {"replicas": replicas}},
        )
        log.info("K8s scale %s → %d replicas", service_name, replicas)
    except Exception as e:
        log.warning("K8s scale error for %s: %s", service_name, e)


async def _k8s_block_metadata() -> None:
    """Namespace-wide NetworkPolicy: allow all pod egress except the cloud
    metadata IP. Standard NetworkPolicy has no explicit-deny rule, so this is
    expressed as the only allowed egress peer being 0.0.0.0/0 minus that one
    /32 — once a NetworkPolicy selects a pod for a given direction (Egress
    here), unlisted destinations are denied by default. Requires a CNI with
    NetworkPolicy support (Calico/Cilium/etc.) — same caveat as the per-user
    VPN policy above.
    """
    from kubernetes_asyncio import client as k8s
    from kubernetes_asyncio import config as k8s_config
    await k8s_config.load_incluster_config()

    netpol = k8s.V1NetworkPolicy(
        metadata=k8s.V1ObjectMeta(
            name="lwp-block-metadata", namespace="lwp", labels={"lwp.managed": "true"},
        ),
        spec=k8s.V1NetworkPolicySpec(
            pod_selector=k8s.V1LabelSelector(match_labels={"lwp.managed": "true"}),
            policy_types=["Egress"],
            egress=[
                k8s.V1NetworkPolicyEgressRule(
                    to=[k8s.V1NetworkPolicyPeer(
                        ip_block=k8s.V1IPBlock(cidr="0.0.0.0/0", _except=["169.254.169.254/32"])
                    )],
                ),
            ],
        ),
    )
    networking = k8s.NetworkingV1Api()
    try:
        await networking.create_namespaced_network_policy(namespace="lwp", body=netpol)
    except Exception:
        await networking.replace_namespaced_network_policy(
            name="lwp-block-metadata", namespace="lwp", body=netpol
        )
    log.info("Metadata-IP egress block installed (NetworkPolicy lwp-block-metadata)")


def _parse_size(s: str) -> int:
    s = s.strip()
    if s.endswith("Gi"):
        return int(s[:-2]) * 1024 ** 3
    if s.endswith("Mi"):
        return int(s[:-2]) * 1024 ** 2
    if s.endswith("g"):
        return int(s[:-1]) * 1024 ** 3
    if s.endswith("m"):
        return int(s[:-1]) * 1024 ** 2
    return int(s)
