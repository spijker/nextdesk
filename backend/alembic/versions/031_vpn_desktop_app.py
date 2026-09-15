"""VPN gateway: ttyd/whiptail terminal -> GTK4/libadwaita desktop app

Revision ID: 031
Revises: 030
Create Date: 2026-09-14
"""
from alembic import op
import sqlalchemy as sa

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE apps SET proxy_port = 8080, web_native = false "
        "WHERE name = 'VPN' AND container_image = 'lwp-vpn:latest'"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE apps SET proxy_port = 7681, web_native = true "
        "WHERE name = 'VPN' AND container_image = 'lwp-vpn:latest'"
    ))
