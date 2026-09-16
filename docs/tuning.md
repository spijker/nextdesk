# Tuning — Audio, Storage, Video, Performance

> Most desktop apps (`app_type=kasm`) now run on Selkies, not KasmVNC — see
> [architecture.md](architecture.md#volume-control) for how audio/volume
> actually works there (native, no separate stream). The Audio, Video and
> Clipboard sections below describe the **legacy `lwp-kasm-base` path**
> (currently only the `vpn` app), kept for reference until it's fully retired.

## Audio (legacy KasmVNC only)

### How it works

Each KasmVNC container runs a PulseAudio daemon with a **null sink** (virtual output). **KasmVNC 1.4's web client cannot play session audio standalone** (it delegates to a Kasm Workspaces parent frame), so LWP streams audio itself over an independent channel:

```
PulseAudio sink monitor
  → ffmpeg  (supervisord `lwp-audio`)  →  Opus/Ogg over HTTP on container :8081
    → backend  GET /api/sessions/{id}/audio  (relay)
      → browser hidden <audio> element  (per-window mute + volume slider)
```

- `lwp-audio.sh` waits for the PulseAudio socket, then `ffmpeg -f pulse -i default_sink.monitor -c:a libopus -f ogg -listen 1 http://0.0.0.0:8081/`.
- The k8s Service / Docker container exposes **8081** alongside the KasmVNC port; the backend relays it (dev: pod name, k8s: service DNS).
- Windows start **muted**; unmute or use the titlebar **volume slider**. Browsers may require a click (gesture) before audio plays.

**Startup sequence** (`lwp-start-kasm.sh`):
1. PulseAudio starts with `--daemon`, loads `module-native-protocol-unix` at the socket path
2. Script polls for `/run/user/1000/pulse/native`
3. Only after the socket exists does `vncserver :1` start; `lwp-audio` waits for the same socket

**PulseAudio config** (`/home/lwp/.config/pulse/default.pa`):
```
.fail
load-module module-null-sink sink_name=default_sink
set-default-sink default_sink
load-module module-null-source source_name=default_source
set-default-source default_source
load-module module-native-protocol-unix socket=/run/user/1000/pulse/native
```

The `.fail` directive means PulseAudio exits if any module fails to load, which causes supervisord to restart the whole stack cleanly rather than running silently without audio.

### Troubleshooting audio

**No sound in browser:**
- Windows start **muted** — unmute (titlebar Volume icon; amber = muted) or nudge the volume slider. Audio may need one click on the session first (browser autoplay policy).
- Confirm the browser tab isn't muted (browser-level).
- Check the audio stream is up: `docker logs <session> | grep lwp-audio`, or inside the desktop `pactl info` should show `default_sink`.
- Verify the relay: `GET /api/sessions/{id}/audio` should stream `application/ogg`.

**Audio latency:**
The independent Opus/Ogg HTTP stream buffers ~1–2 s — fine for notifications, music, and video sound, but not lip-synced or real-time voice.

---

## Storage — Nextcloud WebDAV (rclone)

### How it works

When a user has Nextcloud configured, `lwp-rclone` (supervisord service) mounts their Nextcloud at `$LWP_NC_MOUNT` (default `/home/lwp/Files`) using rclone FUSE.

**Mount command** (`containers/kasm-base/lwp-nc-mount.sh`):
```bash
rclone mount \
  --vfs-cache-mode full \
  --vfs-cache-max-size 1G \
  --vfs-cache-max-age 24h \
  --dir-cache-time 10m \
  --exclude ".cache/**" \
  --no-modtime \
  nc: /home/lwp/Files
```

### VFS cache mode: full

`--vfs-cache-mode full` means:
- On first access, each file is downloaded from Nextcloud to the container's local disk (rclone VFS cache)
- All reads and writes during the session run at **local disk speed**
- Files are uploaded back to Nextcloud when closed
- SQLite databases (browser history, cookies, bookmarks) work correctly — no random-seek over HTTP

This is the right mode for any use case that involves small-file access patterns or databases. The previous `writes` mode caused slow first-reads for uncached files.

### Cache limits

| Flag | Value | Effect |
|---|---|---|
| `--vfs-cache-max-size` | `1G` | Evict oldest cached files when cache exceeds 1 GB |
| `--vfs-cache-max-age` | `24h` | Evict cache entries not accessed for 24 h |
| `--dir-cache-time` | `10m` | Re-read directory listings every 10 min |

### What to store on Nextcloud vs. home volume

| Data | Where | Reason |
|---|---|---|
| Documents, downloads | Nextcloud (`/home/lwp/Files`) | Persists across containers, accessible from other devices |
| Browser profile (`~/.mozilla`, `~/.config/chromium`) | Home volume (`/home/lwp`) | Frequent SQLite writes; local disk speed essential |
| Browser cache (`~/.cache`) | Excluded from rclone | Thousands of tiny files; catastrophic on WebDAV |

The `.cache/**` exclude prevents rclone from attempting to sync the browser HTTP cache to Nextcloud.

### Standard XDG directories on Nextcloud

When the Nextcloud mount is live, `lwp-nc-mount.sh` automatically:

1. Creates the standard folders on Nextcloud if they don't exist:
   `Documents / Downloads / Music / Pictures / Templates / Videos`

2. Replaces `~/Documents`, `~/Downloads`, etc. inside the container with **symlinks** into the Nextcloud mount (`~/Files/Documents`, etc.). Any files that already existed locally are migrated before the symlink is created.

Result: apps save to standard paths (e.g. `~/Downloads/report.pdf`) and those paths transparently resolve to Nextcloud. File managers (Thunar, Nautilus) and the XDG sidebar show the correct folders. `xdg-user-dirs-update` (run at session start) sees the symlinks and doesn't recreate local copies.

If Nextcloud is not configured or the mount fails, the local dirs remain as real directories — no breakage.

### Configure Nextcloud for a user

Admin panel → Users → Edit → Nextcloud tab → enter:
- Nextcloud URL (e.g. `https://cloud.example.com/remote.php/dav/files/username/`)
- Username
- Password (stored Fernet-encrypted in the database)

The credentials are decrypted at session launch and passed as env vars to the container. They are **never logged** and are not returned by any API endpoint after creation.

---

## Persistent home directory

If `mount_home` is enabled on an app, LWP creates a Docker named volume and
mounts it into the container:
- `app_type=kasm`/`web` (Selkies): `lwp-config-{user_id}-{image-slug}` at
  `/config` — per-(user, image), following the LinuxServer.io convention
- everything else (legacy `stream`/kasm-base): `lwp-home-{user_id}` at `/home/lwp`

This volume:
- Persists across session restarts and container rebuilds
- Is **local to the Docker host** (dev) or requires `ReadWriteOnce` PVC (K8s)
- Is distinct from the Nextcloud mount

For multi-node K8s deployments, use a `ReadWriteMany` StorageClass (NFS, CephFS, Longhorn in RWX mode) so any node can attach the user's home.

---

## Video & Display (legacy KasmVNC only — Selkies apps use pixelflux, see [architecture.md](architecture.md))

### YouTube / video playback

KasmVNC re-encodes the X11 framebuffer as a video stream. High-motion video is CPU-intensive on the container node.

**Black screen on video:**
- Cause: insufficient `/dev/shm` — Chromium renderer crashes silently
- Fix: set `shm_size = "1Gi"` on the app definition (default for all LWP apps)
- Verify inside desktop: `df -h /dev/shm` should show ≥ 1 GB

**Choppy playback:**
- Lower resolution: set `kasmvnc.yaml` desktop resolution to `1280x720`
- Cap framerate: set `KASM_MAX_FRAME_RATE=30` in app env vars
- Enable GPU (see below)

### GPU acceleration

Requires a K8s node with GPU + device plugin installed.

**NVIDIA:**
1. Install [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin)
2. Add to app extra env vars: `DRINODE=/dev/dri/renderD128`
3. Add resource limit to app definition: `nvidia.com/gpu: 1`

**Intel integrated GPU (no extra plugin):**
```
DRINODE=/dev/dri/renderD128
```
Available on most bare-metal nodes. Verify: `ls /dev/dri/` inside the desktop.

### KasmVNC configuration

KasmVNC reads `/etc/xdg/kasmvnc/kasmvnc.yaml` inside the container:

```yaml
desktop:
  resolution:
    width: 1920
    height: 1080
  allow_resize: true        # browser auto-resize
network:
  protocol: http            # WebSocket sub-protocol (not HTTP mode)
  interface: "0.0.0.0"
  websocket_port: 8080
  use_ipv4: true
  use_ipv6: false
command_line:
  prompt: false
```

> **Note:** Do not add an `audio:` key — KasmVNC 1.4 does not recognise it and will fail to start. Audio is auto-detected via the PulseAudio socket.

---

## Clipboard (legacy KasmVNC only — Selkies has its own native clipboard integration)

Bidirectional clipboard works in **Chrome and Edge** (secure context / HTTPS required). Firefox may prompt for clipboard permission on first paste.

**Clipboard bridge (in-app):** every window has a clipboard button (📋) in the titlebar. Use this to manually copy text from the host and paste into the session, or vice versa — useful in Firefox or non-HTTPS dev setups.

KasmVNC ships with its own `isInsideKasmVDI()` check (`window.self !== window.top`)
that assumes it's embedded in the real Kasm Workspaces platform whenever it's
loaded inside an iframe — true for every LWP session, since we always embed
the client that way. When it fires, KasmVNC disables its own clipboard
entirely (`clipboard_up`/`clipboard_down` off), assuming the *host* platform
will bridge it instead — which for us is exactly what our own bridge does, so
`vncQueryString()` (`frontend/src/lib/vncDisplay.ts`) forces
`clipboard_up=true&clipboard_down=true&clipboard_seamless=false` on every
session URL to override it. `clipboard_seamless=false` additionally keeps
KasmVNC on the legacy textarea (`#noVNC_clipboard_text`) + RFB ServerCutText
path rather than its native-Clipboard-API "seamless" mode (Chrome/Edge
default) — seamless mode writes straight to the OS clipboard from an async
websocket callback, which needs user activation Chrome won't grant there, and
it never touches the textarea our bridge reads.

**If clipboard API doesn't work:**
- Confirm HTTPS (clipboard API requires secure context)
- Chrome: site settings → clipboard → allow
- Inside desktop: `xclip` or `xsel` must be installed (included in `lwp-vnc-base`)

---

## Session performance

### Idle suspend

Sessions automatically pause after **15 minutes** of browser inactivity (no mouse/keyboard events). The container is paused (`docker pause` in dev, K8s scale-to-zero in prod) and the window shows a suspended overlay. The first mouse move resumes all suspended sessions.

To adjust the timeout, edit `IDLE_MS` in `frontend/src/pages/Desktop.tsx`.

### Session watchdog

The ARQ background worker runs `expire_sessions` every 5 minutes. Sessions older than `SESSION_TIMEOUT_HOURS` (default: 8 h) are stopped automatically regardless of activity.

Override in `.env`:
```env
SESSION_TIMEOUT_HOURS=12
```

### Max concurrent sessions

Default: 2 sessions per user. Override in `.env`:
```env
MAX_SESSIONS_PER_USER=5
```

Or set per-user limits in Admin → Users.
