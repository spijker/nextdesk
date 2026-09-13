import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    oidc_sub: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True, index=True)
    # auth_source: oidc | local | ldap
    auth_source: Mapped[str] = mapped_column(String(20), nullable=False, default="oidc")
    # bcrypt hash — only set for auth_source='local'
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Bumped on every successful login. Tokens carry the value they were issued
    # with; a mismatch means a newer login elsewhere revoked this browser
    # (single-session takeover). See auth._issue_login / dependencies.
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    # Desktop preferences (wallpaper, theme, layout, pinned icons, logout behaviour)
    preferences: Mapped[dict] = mapped_column(JSONB().with_variant(JSON(), "sqlite"), nullable=False, default=dict)

    # TOTP 2FA — Fernet-encrypted TOTP secrets (local/ldap auth only)
    totp_secret_enc: Mapped[str | None] = mapped_column(String(500), nullable=True)
    totp_pending_enc: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Idle lock screen PIN (bcrypt hash) — independent of the account password/
    # OIDC login, since the lock screen just re-gates an already-authenticated
    # browser tab rather than a full re-auth. Null = idle lock disabled.
    lock_pin_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lock_pin_fail_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    lock_pin_locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Per-user Nextcloud override (null = use system default from settings)
    nc_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    nc_username: Mapped[str | None] = mapped_column(String(200), nullable=True)
    nc_password_enc: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    groups: Mapped[list["UserGroup"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    roles: Mapped[list["UserRole"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    sessions: Mapped[list["Session"]] = relationship(back_populates="user")  # type: ignore[name-defined]


class Group(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "groups"

    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String(500), default="", nullable=False)

    # Per-group quotas (null = no group-specific limit). A user gets the most
    # generous value across their groups; cpu/mem act as ceilings on app requests.
    max_sessions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cpu_limit: Mapped[str | None] = mapped_column(String(20), nullable=True)
    mem_limit: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Security/compliance policy flags — most restrictive across a user's
    # groups wins (any group setting a flag applies it). Known keys:
    # record_sessions, disable_download, disable_upload, disable_clipboard,
    # force_simple_layout. See services/policy.py.
    policies: Mapped[dict] = mapped_column(JSONB().with_variant(JSON(), "sqlite"), nullable=False, default=dict, server_default="{}")

    members: Mapped[list["UserGroup"]] = relationship(back_populates="group", cascade="all, delete-orphan")
    app_permissions: Mapped[list["AppPermission"]] = relationship(back_populates="group")  # type: ignore[name-defined]


class Role(Base, UUIDMixin):
    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)


class UserGroup(Base):
    __tablename__ = "user_groups"
    __table_args__ = (UniqueConstraint("user_id", "group_id"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True)

    user: Mapped[User] = relationship(back_populates="groups")
    group: Mapped[Group] = relationship(back_populates="members")


class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role_id"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)

    user: Mapped[User] = relationship(back_populates="roles")
    role: Mapped[Role] = relationship()
