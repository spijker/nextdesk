#!/usr/bin/with-contenv bash
# One-shot setup before services start. The app's own persistent state lives
# in /config (the base image's normal home, bind-mounted per (user, image) by
# container.py) — this only prepares the *separate* Nextcloud mount point,
# which stays on the container's ephemeral layer since the real files live on
# Nextcloud itself, not locally.
mkdir -p /home/lwp
chown abc:abc /home/lwp
