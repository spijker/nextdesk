"""Apps: track who created it, for user-owned self-service web apps

Revision ID: 033
Revises: 032
Create Date: 2026-09-16
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "033"
down_revision = "032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("apps", sa.Column(
        "created_by", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    ))
    op.create_index(op.f("ix_apps_created_by"), "apps", ["created_by"])


def downgrade() -> None:
    op.drop_index(op.f("ix_apps_created_by"), "apps")
    op.drop_column("apps", "created_by")
