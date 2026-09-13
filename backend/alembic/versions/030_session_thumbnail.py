"""Live session thumbnail (admin support/moderation preview)

Revision ID: 030
Revises: 029
Create Date: 2026-09-13
"""
from alembic import op
import sqlalchemy as sa

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("thumbnail", sa.Text(), nullable=True))
    op.add_column("sessions", sa.Column("thumbnail_updated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("sessions", "thumbnail_updated_at")
    op.drop_column("sessions", "thumbnail")
