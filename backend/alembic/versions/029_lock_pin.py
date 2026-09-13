"""Idle lock screen PIN

Revision ID: 029
Revises: 028
Create Date: 2026-09-13
"""
from alembic import op
import sqlalchemy as sa

revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("lock_pin_hash", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("lock_pin_fail_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("lock_pin_locked_until", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "lock_pin_locked_until")
    op.drop_column("users", "lock_pin_fail_count")
    op.drop_column("users", "lock_pin_hash")
