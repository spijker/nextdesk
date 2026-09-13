import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, UUIDMixin


class Session(Base, UUIDMixin):
    __tablename__ = "sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    app_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apps.id"), nullable=True
    )
    pod_name: Mapped[str] = mapped_column(String(253), nullable=False)
    service_name: Mapped[str] = mapped_column(String(253), nullable=False)
    # Opaque token in URL — Nginx validates via auth_request
    session_token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    # starting | running | stopping | stopped | error
    status: Mapped[str] = mapped_column(String(20), default="starting", nullable=False)
    # Denormalized from App so validate endpoint doesn't need a join
    app_type: Mapped[str] = mapped_column(String(20), default="stream", nullable=False)
    proxy_port: Mapped[int] = mapped_column(Integer, default=8080, nullable=False)
    # Container hostname (Docker: container name, K8s: service DNS)
    upstream_host: Mapped[str] = mapped_column(String(253), default="", nullable=False)
    # VPN gateway sessions: true while the openconnect tunnel is up
    vpn_connected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Client sessions launched behind a live gateway: per-window VPN routing
    # toggle (the in-container relay polls this). None = session has no VPN
    # plumbing (no gateway was running at launch) — toggle hidden in the UI.
    vpn_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Window position persisted to backend (x, y, w, h, minimized, maximized)
    window_state: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    # Periodic JPEG data URL from the client (admin support/moderation preview
    # — see routers/sessions.py's thumbnail endpoint). Never captured for
    # view-only shares; best-effort, may be stale or absent.
    thumbnail: Mapped[str | None] = mapped_column(Text, nullable=True)
    thumbnail_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Bumped by the client heartbeat while a session is open + active; the idle
    # reaper stops sessions whose last_active is older than the configured timeout.
    last_active: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="sessions")  # type: ignore[name-defined]
    app: Mapped["App"] = relationship(back_populates="sessions")  # type: ignore[name-defined]
    shares: Mapped[list["SessionShare"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class SessionShare(Base, UUIDMixin):
    """Invite link into a running session. The share token lives in the same
    /session/<token>/ URL space as the owner's token — nginx auth_request
    resolves either. mode=view is enforced client-side (input overlay)."""
    __tablename__ = "session_shares"

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    # view | control
    mode: Mapped[str] = mapped_column(String(10), default="view", nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    session: Mapped[Session] = relationship(back_populates="shares")
