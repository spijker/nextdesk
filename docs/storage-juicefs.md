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

## Explicitly out of scope (for now)

- **Migrating existing users.** This only affects volumes created for new
  sessions from here on. Moving an existing user's `lwp-home-*` /
  `lwp-config-*` data into a JuiceFS subdir is a one-off copy job, not yet
  written.
- **Nextcloud storage.** The Nextcloud WebDAV/rclone mount (`Files`) is
  unrelated and unaffected — this only covers the app's own persistent
  home/config directory.

## Known tradeoff

FUSE overhead on small-file/random-write workloads (browser profile
SQLite, caches) — the same class of problem that pushed the Nextcloud
mount to `--vfs-cache-mode full`. Lean on JuiceFS's local client cache, and
keep genuinely hot scratch data (`.cache/**`-style dirs) off it if it turns
out to matter in practice — nothing here does that automatically yet.
