#!/bin/bash
# Wraps the base image's root bootstrap (lwp-start-kasm-base.sh, see Dockerfile)
# to start a system D-Bus bus first. flatpak's parental-controls check
# (libmalcontent, pulled in as a flatpak dependency) talks to accountsservice
# over the system bus during install and fails hard — "Could not connect: No
# such file or directory" — if that bus doesn't exist at all, which it doesn't
# in this otherwise system-bus-less container. Every other app image is
# unaffected — they still use the base script directly.
set -e
mkdir -p /run/dbus
dbus-daemon --system --fork
exec /usr/local/bin/lwp-start-kasm-base.sh
