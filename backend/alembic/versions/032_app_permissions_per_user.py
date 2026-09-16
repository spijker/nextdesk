"""App permissions: allow restricting an app to individual users, not just groups

Revision ID: 032
Revises: 031
Create Date: 2026-09-15
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "032"
down_revision = "031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Was a composite (app_id, group_id) primary key (which already enforced
    # uniqueness on its own — no separate unique constraint exists to drop)
    # — switch to a plain surrogate id so a row can target a user instead.
    op.drop_constraint("app_permissions_pkey", "app_permissions", type_="primary")

    op.add_column("app_permissions", sa.Column("id", postgresql.UUID(as_uuid=True), nullable=True))
    op.execute("UPDATE app_permissions SET id = gen_random_uuid()")
    op.alter_column("app_permissions", "id", nullable=False)
    op.create_primary_key("app_permissions_pkey", "app_permissions", ["id"])

    op.alter_column("app_permissions", "group_id", nullable=True)
    op.add_column("app_permissions", sa.Column(
        "user_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True,
    ))

    op.create_index(op.f("ix_app_permissions_app_id"), "app_permissions", ["app_id"])
    op.create_unique_constraint("app_permissions_app_id_group_id_key", "app_permissions", ["app_id", "group_id"])
    op.create_unique_constraint("app_permissions_app_id_user_id_key", "app_permissions", ["app_id", "user_id"])
    op.create_check_constraint(
        "ck_app_permission_one_target", "app_permissions",
        "(group_id IS NULL) != (user_id IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_app_permission_one_target", "app_permissions", type_="check")
    op.drop_constraint("app_permissions_app_id_user_id_key", "app_permissions", type_="unique")
    op.drop_constraint("app_permissions_app_id_group_id_key", "app_permissions", type_="unique")
    op.drop_index(op.f("ix_app_permissions_app_id"), "app_permissions")

    op.execute("DELETE FROM app_permissions WHERE group_id IS NULL")
    op.drop_column("app_permissions", "user_id")
    op.alter_column("app_permissions", "group_id", nullable=False)

    op.drop_constraint("app_permissions_pkey", "app_permissions", type_="primary")
    op.drop_column("app_permissions", "id")
    op.create_primary_key("app_permissions_pkey", "app_permissions", ["app_id", "group_id"])
