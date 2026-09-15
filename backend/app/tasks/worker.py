"""
ARQ background worker.

Tasks:
  - expire_sessions: runs every 5 minutes (see WorkerSettings.cron_jobs), kills pods past their time limit
  - pull_image: fires when admin triggers image pull

Run standalone:
  arq app.tasks.worker.WorkerSettings
"""
import asyncio
import logging
from datetime import UTC, datetime, timedelta

from arq import cron
from sqlalchemy import select

from app.config import settings
from app.database import SessionLocal
from app.models.session import Session
from app.services import container as container_svc

log = logging.getLogger(__name__)


async def _setting_int(db, key: str, default: int) -> int:
    from app.models.settings import Setting
    val = await db.scalar(select(Setting.value).where(Setting.key == key))
    try:
        return int(val) if val is not None else default
    except (TypeError, ValueError):
        return default


BACKGROUND_CAP_HOURS = 48


async def expire_sessions(ctx: dict) -> int:
    """Reap sessions that exceed their max lifetime or have been idle too long.

    Admin-configurable via settings (0 = disabled):
      session.max_lifetime_hours  — hard cap on total age (default: env fallback)
      session.idle_timeout_min    — stop after this long with no client heartbeat

    Background sessions — app has LWP_BG_ALLOWED=1 in env_json (Terminal) AND
    the user opted in (preferences.terminal_background) — are exempt from both
    limits but hard-capped at BACKGROUND_CAP_HOURS.
    """
    from app.models.app_catalog import App
    from app.models.user import User

    now = datetime.now(UTC)
    async with SessionLocal() as db:
        max_hours = await _setting_int(db, "session.max_lifetime_hours", settings.session_timeout_hours)
        idle_min = await _setting_int(db, "session.idle_timeout_min", 0)

        result = await db.execute(
            select(Session, App.env_json, User.preferences)
            .join(App, Session.app_id == App.id, isouter=True)
            .join(User, Session.user_id == User.id)
            .where(Session.status.in_(["starting", "running", "suspended"]))
        )
        killed = 0
        for sess, app_env, prefs in result.all():
            background = (
                (app_env or {}).get("LWP_BG_ALLOWED") == "1"
                and bool((prefs or {}).get("terminal_background"))
            )
            reason = None
            if background:
                if sess.started_at < now - timedelta(hours=BACKGROUND_CAP_HOURS):
                    reason = f"background cap {BACKGROUND_CAP_HOURS}h"
            elif max_hours > 0 and sess.started_at < now - timedelta(hours=max_hours):
                reason = f"max lifetime {max_hours}h"
            elif idle_min > 0 and sess.last_active < now - timedelta(minutes=idle_min):
                reason = f"idle {idle_min}m"
            if not reason:
                continue
            try:
                if sess.app_type != "web":
                    await container_svc.stop(sess.pod_name, sess.service_name)
                sess.status = "stopped"
                sess.ended_at = now
                killed += 1
                log.info("Reaped session %s (%s)", sess.id, reason)
            except Exception as e:
                log.warning("Failed to stop session %s: %s", sess.id, e)
        if killed:
            await db.commit()
    return killed


async def pull_image(ctx: dict, registry_tag: str) -> str:
    """Pull a container image on the current node (dev: docker pull, prod: k8s job)."""
    if settings.is_dev:
        proc = await asyncio.create_subprocess_exec(
            "docker", "pull", registry_tag,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"docker pull failed: {stdout.decode()}")
        log.info("Pulled image %s", registry_tag)
        return f"pulled:{registry_tag}"
    else:
        # In k8s: create a Job that runs `ctr image pull` on each node
        # Simplified: trigger a DaemonSet rollout is not ideal; use a Job instead.
        from kubernetes_asyncio import client as k8s
        from kubernetes_asyncio import config as k8s_config
        await k8s_config.load_incluster_config()
        batch = k8s.BatchV1Api()
        job_name = f"pull-{registry_tag.replace('/', '-').replace(':', '-')[:50]}"
        job = k8s.V1Job(
            metadata=k8s.V1ObjectMeta(name=job_name, namespace="lwp"),
            spec=k8s.V1JobSpec(
                template=k8s.V1PodTemplateSpec(
                    spec=k8s.V1PodSpec(
                        restart_policy="Never",
                        containers=[k8s.V1Container(
                            name="puller",
                            image=registry_tag,
                            command=["/bin/true"],
                        )],
                    )
                ),
                ttl_seconds_after_finished=300,
            ),
        )
        await batch.create_namespaced_job(namespace="lwp", body=job)
        log.info("Created pull job for %s", registry_tag)
        return f"job_created:{registry_tag}"


async def check_image_updates(ctx: dict) -> dict:
    """Compare local image digests against their registry (dev/Docker path;
    K8s nodes pull on schedule, so prod reports unknown). Result JSON stored
    in the images.staleness setting for the admin Apps page."""
    import json

    from app.models.app_catalog import App
    from app.models.settings import Setting

    async with SessionLocal() as db:
        rows = await db.execute(
            select(App.container_image).where(
                App.is_enabled == True,   # noqa: E712
                App.is_deleted == False,  # noqa: E712
                App.container_image.is_not(None),
            )
        )
        images = sorted({r for (r,) in rows.all() if r})
        if settings.is_dev:
            results = await asyncio.to_thread(_docker_staleness_sync, images)
        else:
            results = {img: {"status": "unknown"} for img in images}

        payload = json.dumps({
            "checked_at": datetime.now(UTC).isoformat(),
            "images": results,
        })
        row = await db.scalar(select(Setting).where(Setting.key == "images.staleness"))
        if row:
            row.value = payload
        else:
            db.add(Setting(key="images.staleness", value=payload))
        await db.commit()
    return results


def _docker_staleness_sync(images: list[str]) -> dict:
    import docker
    client = docker.from_env()
    out: dict = {}
    for img in images:
        try:
            local = client.images.get(img)
        except Exception:
            out[img] = {"status": "missing"}
            continue
        # Local-only tags (no registry host in the repo path) can't be compared
        repo = img.rsplit(":", 1)[0]
        if "/" not in repo:
            out[img] = {"status": "local"}
            continue
        try:
            remote = client.images.get_registry_data(img)
            local_digests = {d.split("@")[-1] for d in (local.attrs.get("RepoDigests") or [])}
            out[img] = (
                {"status": "current"}
                if remote.id in local_digests
                else {"status": "stale", "remote_digest": remote.id}
            )
        except Exception as e:
            out[img] = {"status": "error", "detail": str(e)[:200]}
    return out


async def startup(ctx: dict) -> None:
    log.info("ARQ worker started")


async def shutdown(ctx: dict) -> None:
    log.info("ARQ worker stopped")


from arq.connections import RedisSettings  # noqa: E402 — after task defs by design


class WorkerSettings:
    functions = [expire_sessions, pull_image, check_image_updates]
    cron_jobs = [
        cron(expire_sessions, minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}),
        cron(check_image_updates, minute={17}),  # hourly
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
