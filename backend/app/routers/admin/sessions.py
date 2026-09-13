import os
import shutil
import uuid
from datetime import UTC, datetime
from io import StringIO

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.responses import Response as FastAPIResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_session
from app.dependencies import require_admin
from app.models.app_catalog import App
from app.models.session import Session
from app.models.user import User
from app.services import container as container_svc

router = APIRouter(prefix="/api/admin/sessions", tags=["admin"])


@router.get("")
async def list_all_sessions(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Session, User.email, User.username)
        .outerjoin(User, User.id == Session.user_id)
        .where(Session.status.in_(["starting", "running"]))
        .order_by(Session.started_at.desc())
    )
    sessions = []
    for sess, email, username in result.all():
        sessions.append({
            "id": str(sess.id),
            "user_id": str(sess.user_id),
            "user_email": email,
            "username": username,
            "app_id": str(sess.app_id) if sess.app_id else None,
            "pod_name": sess.pod_name,
            "status": sess.status,
            "app_type": sess.app_type,
            "app_name": None,
            "started_at": sess.started_at.isoformat(),
        })
    return sessions


@router.get("/export")
async def export_sessions(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Session, User.email, User.username)
        .outerjoin(User, User.id == Session.user_id)
        .where(Session.status.in_(["starting", "running"]))
        .order_by(Session.started_at.desc())
    )
    output = StringIO()
    output.write("Session ID,User Email,Username,User ID,Pod,Status,App Type,Started At\n")
    for sess, email, username in result.all():
        output.write(f"{sess.id},{email},{username},{sess.user_id},{sess.pod_name},{sess.status},{sess.app_type},{sess.started_at}\n")
    output.seek(0)
    return FastAPIResponse(
        content=output.read(),
        headers={"Content-Disposition": "attachment; filename=sessions.csv"},
    )


@router.delete("")
async def bulk_kill_sessions(
    _: User = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    user_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
):
    """Kill multiple sessions matching filters. Returns count of killed sessions."""
    q = select(Session).where(Session.status.in_(["starting", "running"]))
    if user_id:
        q = q.where(Session.user_id == uuid.UUID(user_id))
    if status:
        q = q.where(Session.status == status)
    result = await session.execute(q)
    sessions = result.scalars().all()
    killed = 0
    for sess in sessions:
        await container_svc.stop(sess.pod_name, sess.service_name)
        sess.status = "stopped"
        sess.ended_at = datetime.now(UTC)
        killed += 1
    if killed:
        await session.commit()
    return {"killed": killed, "sessions": killed}


# ── Session recordings ────────────────────────────────────────────────────────
# Segments uploaded by containers under the record_sessions group policy.
# Filesystem is the source of truth: recordings_dir/<session_id>/<seq>.mp4

@router.get("/recordings")
async def list_recordings(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
):
    root = settings.recordings_dir
    if not os.path.isdir(root):
        return []
    entries = []
    ids = []
    for d in os.listdir(root):
        path = os.path.join(root, d)
        if not os.path.isdir(path):
            continue
        try:
            sid = uuid.UUID(d)
        except ValueError:
            continue
        segs = sorted(f for f in os.listdir(path) if f.endswith(".mp4"))
        if not segs:
            continue
        size = sum(os.path.getsize(os.path.join(path, f)) for f in segs)
        ids.append(sid)
        entries.append({
            "session_id": d,
            "segments": len(segs),
            "size_bytes": size,
            "first_segment": segs[0],
            "last_modified": datetime.fromtimestamp(
                os.path.getmtime(path), tz=UTC).isoformat(),
        })
    if ids:
        rows = await db.execute(
            select(Session.id, User.username, App.name, Session.started_at, Session.ended_at)
            .outerjoin(User, User.id == Session.user_id)
            .outerjoin(App, App.id == Session.app_id)
            .where(Session.id.in_(ids))
        )
        meta = {str(r[0]): r for r in rows.all()}
        for e in entries:
            m = meta.get(e["session_id"])
            if m:
                e["username"] = m[1]
                e["app_name"] = m[2]
                e["started_at"] = m[3].isoformat() if m[3] else None
                e["ended_at"] = m[4].isoformat() if m[4] else None
    entries.sort(key=lambda e: e["last_modified"], reverse=True)
    return entries


@router.get("/recordings/{session_id}/segments")
async def list_recording_segments(
    session_id: uuid.UUID,
    _: User = Depends(require_admin),
):
    path = os.path.join(settings.recordings_dir, str(session_id))
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail="No recording for this session")
    return sorted(f for f in os.listdir(path) if f.endswith(".mp4"))


@router.get("/recordings/{session_id}/segments/{fname}")
async def get_recording_segment(
    session_id: uuid.UUID,
    fname: str,
    _: User = Depends(require_admin),
):
    if "/" in fname or ".." in fname or not fname.endswith(".mp4"):
        raise HTTPException(status_code=422, detail="Bad segment name")
    path = os.path.join(settings.recordings_dir, str(session_id), fname)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Segment not found")
    return FileResponse(path, media_type="video/mp4", filename=f"{session_id}-{fname}")


@router.delete("/recordings/{session_id}")
async def delete_recording(
    session_id: uuid.UUID,
    _: User = Depends(require_admin),
):
    path = os.path.join(settings.recordings_dir, str(session_id))
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail="No recording for this session")
    shutil.rmtree(path)
    return {"ok": True}


@router.get("/{session_id}/thumbnail")
async def get_session_thumbnail(
    session_id: uuid.UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
):
    """Best-effort live preview — see routers/sessions.py's uploader. 404 means
    none captured yet (session just started, or the window's never been focused)."""
    result = await db.execute(select(Session).where(Session.id == session_id))
    sess = result.scalar_one_or_none()
    if not sess or not sess.thumbnail:
        raise HTTPException(status_code=404, detail="No thumbnail yet")
    return {
        "data_url": sess.thumbnail,
        "updated_at": sess.thumbnail_updated_at.isoformat() if sess.thumbnail_updated_at else None,
    }


@router.delete("/{session_id}")
async def force_kill_session(
    session_id: uuid.UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(select(Session).where(Session.id == session_id))
    sess = result.scalar_one_or_none()
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    await container_svc.stop(sess.pod_name, sess.service_name)
    sess.status = "stopped"
    sess.ended_at = datetime.now(UTC)
    await db.commit()
    return {"ok": True}
