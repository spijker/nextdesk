#!/bin/bash
# Mount the user's extra rclone storages (SFTP / S3) under ~/Mount/<name>.
# LWP_MOUNTS is base64(JSON array of {name, provider, mount_path, params}).
# Each mount runs independently — a bad SFTP config must not take down the
# others (or the separate Nextcloud mount).
set -u

if [ -z "${LWP_MOUNTS:-}" ]; then
    echo "lwp-mounts: no extra mounts configured." >&2
    exec sleep infinity
fi

# Selkies-base variant of kasm-base's script: the real home here is $HOME
# (/config, set by the base image), not /home/lwp.
HOME_DIR="${HOME:-/config}"
CONFDIR="${HOME_DIR}/.config/lwp-mounts"
mkdir -p "$CONFDIR"; chmod 700 "$CONFDIR"
RCONF="$CONFDIR/rclone.conf"

# Build the rclone config + SSH key files (0600) and emit one TSV line per
# mount: <section>\t<mountpoint>\t<remote-suffix>. Keys/secrets live in the
# 0600 config/key files, never on a command line.
MOUNTS_TSV=$(python3 - "$LWP_MOUNTS" "$CONFDIR" "$RCONF" "$HOME_DIR" <<'PY'
import base64, json, os, re, subprocess, sys

blob, confdir, rconf, home_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
mounts = json.loads(base64.b64decode(blob))
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")

out = []
fd = os.open(rconf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
cfg = os.fdopen(fd, "w")
for m in mounts:
    name = m.get("name", "")
    if not NAME.match(name):
        continue
    sec = f"m_{name}"
    p = m.get("params", {})
    mountpoint = m.get("mount_path") or f"{home_dir}/Mount/{name}"
    if m["provider"] == "sftp":
        cfg.write(f"[{sec}]\ntype = sftp\nhost = {p.get('host','')}\n"
                  f"user = {p.get('user','')}\nport = {p.get('port',22)}\n"
                  f"shell_type = unix\n")
        if p.get("private_key"):
            keypath = os.path.join(confdir, f"{name}.key")
            kfd = os.open(keypath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            key = p["private_key"]
            if not key.endswith("\n"):
                key += "\n"
            os.write(kfd, key.encode()); os.close(kfd)
            cfg.write(f"key_file = {keypath}\n")
        else:
            # rclone.conf wants the password rclone-obscured, not plaintext;
            # "-" reads it from stdin so it never appears on a command line
            obscured = subprocess.run(
                ["rclone", "obscure", "-"],
                input=p.get("password", ""),
                capture_output=True, text=True,
            ).stdout.strip()
            cfg.write(f"pass = {obscured}\n")
        cfg.write("\n")
        remote = p.get("path", "").strip("/")
    else:  # s3
        cfg.write(f"[{sec}]\ntype = s3\nprovider = Other\n"
                  f"access_key_id = {p.get('access_key_id','')}\n"
                  f"secret_access_key = {p.get('secret_access_key','')}\n"
                  f"endpoint = {p.get('endpoint','')}\nregion = {p.get('region','')}\n\n")
        remote = p.get("bucket", "")
    out.append(f"{sec}\t{mountpoint}\t{remote}")
cfg.close()
print("\n".join(out))
PY
)

# Mount each remote in the background; supervisord keeps this script alive.
declare -a PIDS=()
while IFS=$'\t' read -r sec mountpoint remote; do
    [ -z "$sec" ] && continue
    mkdir -p "$mountpoint"
    # Persistent home can hold a stale FUSE state or leftover files from a
    # previous session — clear it, or rclone refuses ("mountpoint not empty").
    fusermount3 -uz "$mountpoint" 2>/dev/null
    if [ -n "$(ls -A "$mountpoint" 2>/dev/null)" ]; then
        echo "lwp-mounts: WARNING ${mountpoint} not empty — skipping (move the files away and relaunch)" >&2
        continue
    fi
    echo "lwp-mounts: mounting ${sec}:${remote} at ${mountpoint}" >&2
    (
        rclone mount \
            --config "$RCONF" \
            --vfs-cache-mode writes \
            --dir-cache-time 30s \
            --no-modtime \
            --skip-links \
            "${sec}:${remote}" "$mountpoint"
        echo "lwp-mounts: ${sec} exited rc=$?" >&2
    ) &
    PIDS+=($!)
done <<< "$MOUNTS_TSV"

# Keep the script alive while any mount runs; log individual exits.
if [ "${#PIDS[@]}" -eq 0 ]; then
    echo "lwp-mounts: nothing valid to mount." >&2
    exec sleep infinity
fi
wait
