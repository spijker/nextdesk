import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.config import settings
from app.database import SessionLocal, engine
from app.metrics import init_metrics
from app.routers import apps, auth, nc_hub, sessions, storage, system
from app.routers.admin import apps as admin_apps
from app.routers.admin import audit as admin_audit
from app.routers.admin import builds as admin_builds
from app.routers.admin import groups as admin_groups
from app.routers.admin import nextcloud as admin_nextcloud
from app.routers.admin import sessions as admin_sessions
from app.routers.admin import settings as admin_settings
from app.routers.admin import stats as admin_stats
from app.routers.admin import users as admin_users

log = logging.getLogger(__name__)


def _run_migrations_sync() -> None:
    """Apply pending Alembic migrations. Safe to call on an already-migrated DB."""
    import os

    from alembic.config import Config
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.pool import NullPool

    from alembic import command

    ini_path = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")
    script_path = os.path.join(os.path.dirname(__file__), "..", "alembic")
    cfg = Config(ini_path)
    cfg.set_main_option("script_location", script_path)

    sync_url = settings.database_url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")
    engine = create_engine(sync_url, poolclass=NullPool)

    try:
        with engine.connect() as conn:
            insp = inspect(engine)
            tables = insp.get_table_names()
            has_version_table = "alembic_version" in tables

            if not has_version_table and "users" in tables:
                # Tables were created by create_all without Alembic tracking.
                # Determine which revision to stamp at by checking which columns exist.
                user_cols = {c["name"] for c in insp.get_columns("users")}
                if "auth_source" in user_cols and "password_hash" in user_cols:
                    stamp = "002"
                else:
                    stamp = "001"
                log.info("Detected untracked schema — stamping Alembic at %s", stamp)
                conn.execute(text(
                    "CREATE TABLE IF NOT EXISTS alembic_version "
                    "(version_num VARCHAR(32) NOT NULL, PRIMARY KEY (version_num))"
                ))
                conn.execute(text(
                    f"INSERT INTO alembic_version (version_num) VALUES ('{stamp}') "
                    "ON CONFLICT DO NOTHING"
                ))
                conn.commit()
    finally:
        engine.dispose()

    command.upgrade(cfg, "head")


async def _run_migrations() -> None:
    await asyncio.to_thread(_run_migrations_sync)


async def _refresh_active_sessions_gauge():
    """Keep lwp_active_sessions accurate (starting+running) for Prometheus."""
    import asyncio

    from sqlalchemy import func, select

    from app.database import SessionLocal
    from app.metrics import lwp_active_sessions
    from app.models.session import Session
    while True:
        try:
            async with SessionLocal() as db:
                n = await db.scalar(
                    select(func.count()).select_from(Session)
                    .where(Session.status.in_(["starting", "running"]))
                )
            lwp_active_sessions.set(n or 0)
        except Exception:
            pass
        await asyncio.sleep(15)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    await _run_migrations()
    # Top up catalog presets added since the last release (no-op if present)
    from app.services.seed import seed_apps
    async with SessionLocal() as db:
        await seed_apps(db)
    gauge_task = asyncio.create_task(_refresh_active_sessions_gauge())
    from app.services.container import ensure_metadata_egress_block
    egress_task = asyncio.create_task(ensure_metadata_egress_block())
    yield
    gauge_task.cancel()
    egress_task.cancel()
    await engine.dispose()


app = FastAPI(
    title="LWP API",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

init_metrics(app)

# Trust X-Forwarded-For / X-Forwarded-Proto from nginx
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

# Compress JSON responses (apps list, audit, analytics) over ~1 KB.
from fastapi.middleware.gzip import GZipMiddleware  # noqa: E402

app.add_middleware(GZipMiddleware, minimum_size=1024)

if settings.is_dev:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://localhost"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# User-facing routes
app.include_router(auth.router)
app.include_router(apps.router)
app.include_router(sessions.router)
app.include_router(storage.router)
app.include_router(system.router)
app.include_router(nc_hub.router)

# Admin routes
app.include_router(admin_users.router)
app.include_router(admin_groups.router)
app.include_router(admin_apps.router)
app.include_router(admin_builds.router)
app.include_router(admin_nextcloud.router)
app.include_router(admin_sessions.router)
app.include_router(admin_settings.router)
app.include_router(admin_stats.router)
app.include_router(admin_audit.router)


@app.get("/healthz", tags=["health"])
async def health():
    return {"status": "ok", "env": settings.lwp_env}
