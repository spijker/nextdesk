"""
Container lifecycle — per-session containers.

Dev (LWP_ENV=development): Docker SDK, joins DOCKER_NETWORK.
Prod (LWP_ENV=production): kubernetes-asyncio.

Returns upstream_host string used by Nginx session proxy.
"""
import asyncio
import logging
from urllib.parse import urlparse

from app.config import settings

log = logging.getLogger(__name__)

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
    needs_userns: bool = False,
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
            needs_userns=needs_userns,
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
            needs_userns=needs_userns,
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


# ── Docker (dev) ──────────────────────────────────────────────────────────────

async def _docker_start(
    *, pod_name, session_token, app_type, container_image, proxy_port, shm_size,
    username, user_id, env_json, mount_home, needs_fuse=False, needs_userns=False,
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
        needs_userns=needs_userns,
    )


def _docker_start_sync(
    *, pod_name, session_token, app_type, container_image, proxy_port, shm_size,
    username, user_id, env_json, mount_home, needs_fuse=False, needs_userns=False,
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

    # Base environment
    env = {
        "PUID": "1000",
        "PGID": "1000",
        "TZ": "UTC",
    }
    if app_type == "kasm":
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
    if mount_home:
        vol_name = f"lwp-home-{user_id}"
        try:
            client.volumes.get(vol_name)
        except docker.errors.NotFound:
            client.volumes.create(vol_name)
        volumes[vol_name] = {"bind": "/home/lwp", "mode": "rw"}

    shm_bytes = _parse_size(shm_size)

    # FUSE device required for rclone WebDAV mount (Nextcloud)
    devices = []
    cap_add = []
    security_opt = []
    unmask_proc = False
    if needs_fuse:
        devices = ["/dev/fuse:/dev/fuse:rwm"]
        cap_add = ["SYS_ADMIN"]
        security_opt.append("apparmor:unconfined")
    if needs_userns:
        # Flatpak's bwrap sandbox creates its own user+pid+mount namespace and
        # mounts a fresh /proc inside it. Unlike the FUSE case above this needs
        # no extra capability (bwrap is root within its own namespace), but it
        # does need syscalls Docker's default seccomp profile blocks (mount/
        # unshare), and Docker's default-masked /proc paths unmasked —
        # verified empirically: cap_add alone 403s on "pivot_root", seccomp+
        # apparmor unconfined gets bwrap started but "flatpak run" still 403s
        # mounting /proc until MaskedPaths/ReadonlyPaths are cleared too.
        security_opt.append("seccomp=unconfined")
        if "apparmor:unconfined" not in security_opt:
            security_opt.append("apparmor:unconfined")
        unmask_proc = True

    # containers.run()'s security_opt has no way to unmask /proc — the CLI's
    # `--security-opt systempaths=unconfined` isn't a real SecurityOpt value,
    # it's a client-side shorthand the `docker` CLI expands into the
    # HostConfig fields below before sending; passed straight through the SDK
    # the daemon rejects the whole create-container call. So build the host
    # config ourselves instead of going through containers.run().
    api = client.api
    host_config = api.create_host_config(
        network_mode=network,
        binds=volumes or None,
        shm_size=shm_bytes,
        devices=devices or None,
        cap_add=cap_add or None,
        security_opt=security_opt or None,
    )
    if unmask_proc:
        host_config["MaskedPaths"] = []
        host_config["ReadonlyPaths"] = []

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


# ── Kubernetes (prod) ─────────────────────────────────────────────────────────

async def _k8s_start(
    *, session_id, session_token, pod_name, service_name, app_type,
    container_image, proxy_port, cpu_limit, mem_limit, shm_size,
    user_id, username, mount_home, env_json, needs_fuse=False, needs_userns=False,
) -> str:
    from kubernetes_asyncio import client as k8s
    from kubernetes_asyncio import config as k8s_config
    await k8s_config.load_incluster_config()

    base = {"PUID": "1000", "PGID": "1000", "TZ": "UTC"}
    if app_type == "kasm":
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
        pvc_name = f"lwp-home-{user_id}"
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
            k8s.V1VolumeMount(name="home", mount_path="/home/lwp")
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
        # K8s security contexts don't expose Docker's per-flag seccomp/apparmor/
        # systempaths knobs without a custom SCC/seccomp profile, so flatpak's
        # bwrap sandbox (needs_userns) gets the same full-privileged grant as
        # the FUSE mount case for now.
        security_context=k8s.V1SecurityContext(privileged=True) if (needs_fuse or needs_userns) else None,
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
