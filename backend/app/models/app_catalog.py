import uuid

from sqlalchemy import (
    JSON, Boolean, CheckConstraint, ForeignKey, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class App(Base, UUIDMixin, TimestampMixin):
    """Catalog entry for a launchable application."""
    __tablename__ = "apps"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    category: Mapped[str] = mapped_column(String(100), default="General", nullable=False)
    icon_url: Mapped[str] = mapped_column(String(500), default="", nullable=False)

    # stream = our own lwp-kasm-base (legacy KasmVNC) or lwp-selkies-base
    # image, web = always-on URL via the shared kiosk browser, kasm = a
    # Selkies-based image (LinuxServer.io pull or our own selkies-base build)
    app_type: Mapped[str] = mapped_column(String(20), default="stream", nullable=False)
    # True = web-native app (serves its own browser UI, no VNC/desktop). Purely
    # a catalog classification for grouping/badging in the UI.
    web_native: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # OCI image to run (stream / kasm). Empty for web apps with a static URL.
    container_image: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Static web URL — for web-type apps that are always-on (no container per session).
    # Supports {username} and {token} template vars.
    web_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Container port to proxy (8080 for Selkies, 3000 for KasmVNC, varies for web)
    proxy_port: Mapped[int] = mapped_column(Integer, default=8080, nullable=False)

    cpu_limit: Mapped[str] = mapped_column(String(20), default="2000m", nullable=False)
    mem_limit: Mapped[str] = mapped_column(String(20), default="2Gi", nullable=False)
    shm_size: Mapped[str] = mapped_column(String(20), default="1Gi", nullable=False)

    # Extra env vars as JSON dict
    env_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    # Mount user home PVC / named volume into the container
    mount_home: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Set only for a user's own self-service web app (Profile → My web apps);
    # null for everything admin-created. Distinct from AppPermission — an
    # admin can grant a user *access* to a catalog app without that user
    # being able to edit/delete it, which is gated on this field instead.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    permissions: Mapped[list["AppPermission"]] = relationship(
        back_populates="app", cascade="all, delete-orphan"
    )
    sessions: Mapped[list["Session"]] = relationship(back_populates="app")  # type: ignore[name-defined]


class AppPermission(Base, UUIDMixin):
    """Restricts an app to specific groups and/or individual users. An app
    with no rows here is open to everyone (see routers/apps.py list_apps) —
    a row only ever narrows access, never an allow-only admin gate."""
    __tablename__ = "app_permissions"
    __table_args__ = (
        UniqueConstraint("app_id", "group_id"),
        UniqueConstraint("app_id", "user_id"),
        CheckConstraint(
            "(group_id IS NULL) != (user_id IS NULL)", name="ck_app_permission_one_target"
        ),
    )

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    group_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )

    app: Mapped[App] = relationship(back_populates="permissions")
    group: Mapped["Group | None"] = relationship(back_populates="app_permissions")  # type: ignore[name-defined]
    user: Mapped["User | None"] = relationship()  # type: ignore[name-defined]
