import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.app_catalog import App
from app.models.session import Session as UserSession
from app.models.user import User
from app.security import create_access_token, generate_session_token


async def _setup(db: AsyncSession):
    # Unique per call — the SQLite test engine is session-scoped, so fixed
    # usernames collide across tests (users.username is UNIQUE).
    uid = uuid.uuid4().hex[:8]
    user = User(email=f"u-{uid}@test.com", username=f"u-{uid}", display_name="U", oidc_sub=str(uuid.uuid4()))
    app = App(
        name=f"Desktop-{uid}",
        container_image="lwp-firefox:latest",
        app_type="stream",
        proxy_port=8080,
        is_enabled=True,
    )
    db.add(user)
    db.add(app)
    await db.commit()
    await db.refresh(user)
    await db.refresh(app)
    return user, app


@pytest.mark.asyncio
async def test_list_sessions_empty(client: AsyncClient, db_session: AsyncSession):
    user, _ = await _setup(db_session)
    client.cookies.set("access_token", create_access_token(str(user.id)))
    r = await client.get("/api/sessions")
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_validate_invalid_token(client: AsyncClient):
    r = await client.get("/api/sessions/validate", headers={"X-Session-Token": "bogus"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_validate_valid_token(client: AsyncClient, db_session: AsyncSession):
    user, app = await _setup(db_session)
    token = generate_session_token()
    sess = UserSession(
        user_id=user.id,
        app_id=app.id,
        pod_name="pod-test",
        service_name="svc-test",
        session_token=token,
        status="running",
        app_type="stream",
        proxy_port=8080,
        upstream_host="pod-test",
    )
    db_session.add(sess)
    await db_session.commit()

    r = await client.get("/api/sessions/validate", headers={"X-Session-Token": token})
    assert r.status_code == 200
    assert "X-Session-Upstream" in r.headers
