#!/bin/bash
# Selkies-base variant of kasm-base's script: the real home here is $HOME
# (/config, set by the base image), not /home/lwp — the backend already
# points LWP_NC_MOUNT at the right place (see nextcloud.py get_user_nc_env),
# this just needs to symlink into $HOME instead of a hardcoded path.
if [ -z "${LWP_NC_URL}" ]; then
    echo "lwp-rclone: LWP_NC_URL not set — no Nextcloud mount for this session." >&2
    exec sleep infinity
fi

HOME_DIR="${HOME:-/config}"
echo "lwp-rclone: mounting ${LWP_NC_URL} (user ${LWP_NC_USER}) at ${LWP_NC_MOUNT:-$HOME_DIR/Files}" >&2

MOUNT="${LWP_NC_MOUNT:-$HOME_DIR/Files}"
mkdir -p "${MOUNT}"

RCLONE_CONF=$(mktemp /tmp/rclone-nc-XXXXXX.conf)
cat > "${RCLONE_CONF}" <<EOF
[nc]
type = webdav
url = ${LWP_NC_URL}
vendor = nextcloud
user = ${LWP_NC_USER}
pass = $(rclone obscure "${LWP_NC_PASS}")
EOF

# Background rclone so we can set up XDG symlinks once the mount is live
rclone mount \
    --config "${RCLONE_CONF}" \
    --no-modtime \
    --vfs-cache-mode full \
    --vfs-cache-max-size 1G \
    --vfs-cache-max-age 24h \
    --dir-cache-time 10m \
    --exclude ".cache/**" \
    nc: \
    "${MOUNT}" &
RCLONE_PID=$!

# Wait for mount to become live (up to 30 s)
for _i in $(seq 1 60); do
    mountpoint -q "${MOUNT}" 2>/dev/null && break
    # rclone died early (bad URL / auth / no FUSE) — surface it
    kill -0 "${RCLONE_PID}" 2>/dev/null || { echo "lwp-rclone: rclone exited before mount became live — check URL/creds/FUSE" >&2; break; }
    sleep 0.5
done

if mountpoint -q "${MOUNT}" 2>/dev/null; then
    echo "lwp-rclone: mount live at ${MOUNT}" >&2
    # Ensure standard XDG dirs exist on Nextcloud
    for _dir in Documents Downloads Music Pictures Templates Videos; do
        mkdir -p "${MOUNT}/${_dir}"
    done

    # Replace local home dirs with symlinks into the Nextcloud mount
    for _dir in Documents Downloads Music Pictures Templates Videos; do
        _local="${HOME_DIR}/${_dir}"
        _nc="${MOUNT}/${_dir}"
        if [ -L "${_local}" ]; then
            : # already a symlink — nothing to do
        elif [ -d "${_local}" ]; then
            # Migrate any pre-existing files into Nextcloud, then symlink
            find "${_local}" -mindepth 1 -maxdepth 1 -exec mv -n {} "${_nc}/" \; 2>/dev/null || true
            rm -rf "${_local}"
            ln -s "${_nc}" "${_local}"
        else
            ln -s "${_nc}" "${_local}"
        fi
    done
fi

# Stay alive — supervisord monitors this PID and gets rclone's exit code
wait "${RCLONE_PID}"
