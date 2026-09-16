# Persistent home storage via JuiceFS (experimental, unreleased)

> **Status:** off by default, Docker/dev path only, new sessions only — not
> wired into K8s and not part of any tagged release yet. Lives on the
> `local/juicefs-storage` branch (not pushed) until it's actually needed.

## Why

Today a user's persistent home/config directory (`mount_home` on an app) is
a plain Docker named volume (dev) or a `ReadWriteOnce` PVC (K8s) — see
[tuning.md](tuning.md#persistent-home-directory). That's fine on a single
Docker host, but multi-node K8s needs an RWX StorageClass (NFS, CephFS,
Longhorn) to let any node attach a user's home.

If you already run a JuiceFS filesystem elsewhere, it's a good fit for this:
it's POSIX-ish, backed by shared object storage + a metadata engine, with
local client-side caching — so it solves the RWX-across-nodes problem
without standing up NFS/CephFS.

**One JuiceFS filesystem, not one per user.** Each user (and, for
Selkies/LinuxServer.io apps, each user+image pair — mirroring the existing
per-image `/config` volume split, see `services/container.py`) just gets its
own subdirectory of the same filesystem: `users/<user_id>/<app-slug>`.

## K8s (prod): no code change

Deploy the [JuiceFS CSI driver](https://juicefs.com/docs/csi/introduction)
and its StorageClass, then point the existing `HOME_STORAGE_CLASS` env var
at it. `_k8s_start` in `services/container.py` already creates a generic
PVC against whatever `home_storage_class` names — nothing JuiceFS-specific
to add there.

## Docker (dev): what's implemented

`_docker_start_sync` in `services/container.py` normally does an implicit
`client.volumes.create(vol_name)` (plain `local` driver) for a mount_home
app. When `JUICEFS_ENABLED=true`, it instead calls `_ensure_juicefs_volume`,
which creates the volume against the `juicedata/juicefs` Docker volume
plugin with `subdir` set to the user's (+ image's) path — same idempotent
"get, then create if missing" pattern as everywhere else in this file.

The resulting volume name is prefixed (`lwp-jfs-...`) rather than reusing
the plain volume's name — Docker refuses to create a volume with the same
name but a different driver than one that already exists, so this keeps
`JUICEFS_ENABLED` safe to flip on/off: existing local volumes are untouched
either way.

**One-time operator setup** (not something the app does — installing a
Docker plugin is a privileged host action):
```bash
docker plugin install juicedata/juicefs --alias juicefs --grant-all-permissions
```
Then set in `.env`:
```env
JUICEFS_ENABLED=true
JUICEFS_NAME=<your existing `juicefs format` filesystem name>
JUICEFS_META_URL=<your metadata engine URL, e.g. redis://host:6379/1>
```

`JUICEFS_NAME` is the filesystem's name, not its storage backend type (e.g.
`s3`/`minio`) — easy to mix up. If unsure, `juicefs status "$JUICEFS_META_URL"`
prints it as `.Setting.Name`. Getting this wrong makes the Docker volume
plugin fail to mount at all (it'll try to treat metaurl as backing a
*different*, not-yet-formatted filesystem by that name).

### The `.config` collision (why HOME gets redirected)

JuiceFS reserves `.accesslog`, `.config`, and `.stats` as special read-only,
root-owned files at the root of **every** mount — including a `--subdir`
mount, not just the true filesystem root. Verified directly: `mkdir
$HOME/.config` fails with `EEXIST` there, and the existing `.config` can't
be `rm`'d either. That's fatal for Firefox (and virtually every GTK/XDG
app) since `~/.config` needs to be a real, writable directory.

So the per-user volume is **not** bind-mounted straight at `bind_path`
(`/config`/`/home/lwp`) — instead:
- it's mounted at `/mnt/lwp-jfs` inside the container,
- `HOME` is overridden to `/mnt/lwp-jfs/data` — a real subdirectory *inside*
  that mount, one level below the reserved names, pre-created (and
  `chown 1000:1000`'d — the PUID/PGID every app runs as) by
  `_ensure_juicefs_home_dir` so apps that assume `$HOME` already exists
  don't fail on first boot,
- `bind_path` itself gets an empty `tmpfs` mount — just enough to stop
  Docker auto-creating (and leaking) an anonymous volume for the image's
  declared `VOLUME bind_path`; nothing actually uses that path anymore.

Verified end-to-end against a real `lwp-firefox` container (called
`_docker_start_sync` directly, not just the plugin in isolation): Selkies
came up clean and Firefox launched with a full, healthy process tree —
no permission errors, `.config` a normal writable directory owned by `abc`.

### Caches skip JuiceFS entirely

Browser/app caches are lots of small, frequently-rewritten files — the
exact workload that's brutal on a FUSE mount (same reasoning as excluding
`.cache/**` from the Nextcloud rclone mount, see
[tuning.md](tuning.md#what-to-store-on-nextcloud-vs-home-volume)). Since
`bind_path` is already a throwaway tmpfs stub (see above), `XDG_CACHE_HOME`
is pointed at a subdirectory of that same tmpfs (`size=1g,uid=1000,gid=1000`)
instead of wasting it — caches get real local (RAM-backed) storage, capped
so a runaway cache can't eat host memory, and vanish automatically on
container removal, no cleanup step needed.

Verified: Firefox/Mesa/fontconfig all created their cache dirs under
`$XDG_CACHE_HOME` on the tmpfs (`fontconfig/`, `mesa_shader_cache/`,
`mozilla/`), and `$HOME/.cache` on the actual JuiceFS-backed volume never
got created at all.

## Explicitly out of scope (for now)

- **Migrating existing users.** This only affects volumes created for new
  sessions from here on. Moving an existing user's `lwp-home-*` /
  `lwp-config-*` data into a JuiceFS subdir is a one-off copy job, not yet
  written.
- **Nextcloud storage.** The Nextcloud WebDAV/rclone mount (`Files`) is
  unrelated and unaffected — this only covers the app's own persistent
  home/config directory.

## Known tradeoff

FUSE overhead on small-file/random-write workloads — the same class of
problem that pushed the Nextcloud mount to `--vfs-cache-mode full`.
`XDG_CACHE_HOME` already routes caches around it (see above); the
remaining risk is anything with a SQLite-heavy write pattern that lands
directly under `$HOME` rather than `$XDG_CACHE_HOME` (e.g. a browser
profile's places.sqlite) — lean on JuiceFS's local client cache for that,
and revisit if it turns out to matter in practice.
