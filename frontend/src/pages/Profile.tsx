import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  ShieldCheck, Users, Cloud, CheckCircle, XCircle,
  ExternalLink, Loader2, Palette, LayoutGrid, Moon, Sun, Monitor, Trash2, KeyRound,
  Lock, LockKeyhole, LogOut, HardDrive, History, Pencil, Plus, Server, Database, Type, Maximize2,
  UserCircle, SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import { useAuthStore } from "@/store/auth";
import { useDesktopStore } from "@/store/desktop";
import { cn } from "@/lib/utils";
import { NcAvatar } from "@/components/desktop/NcAvatar";
import { VNC_DISPLAY_MODES, type VncDisplayMode } from "@/lib/vncDisplay";

const PRESETS = [
  { label: "Night blue",  value: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)" },
  { label: "Twilight",    value: "linear-gradient(135deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%)" },
  { label: "Forest",      value: "linear-gradient(135deg, #0a3d2b 0%, #1a5c3e 50%, #0d2b1f 100%)" },
  { label: "Ember",       value: "linear-gradient(135deg, #1a0000 0%, #3d0000 40%, #7b2000 100%)" },
  { label: "Slate",       value: "linear-gradient(135deg, #1c1c1e 0%, #2c2c2e 50%, #3a3a3c 100%)" },
  { label: "Aurora",      value: "linear-gradient(135deg, #0d1b2a 0%, #1b4332 35%, #1d3557 70%, #0d1b2a 100%)" },
  { label: "Minimal",     value: "#111113" },
  { label: "Deep sea",    value: "linear-gradient(180deg, #020b18 0%, #0a2040 50%, #0d3060 100%)" },
];

const LAYOUTS = [
  { id: "icons",  label: "Desktop icons", desc: "Shortcuts on desktop", icon: "🖥️" },
  { id: "tiles",  label: "Tiles",         desc: "App grid on desktop",  icon: "⊞" },
  { id: "clean",  label: "Clean",         desc: "Launcher only",        icon: "✦" },
] as const;

const THEMES = [
  { id: "dark",   label: "Dark",   icon: Moon },
  { id: "light",  label: "Light",  icon: Sun },
  { id: "system", label: "System", icon: Monitor },
] as const;

type FlowState = "idle" | "starting" | "waiting" | "success" | "error";

interface NcUserConfig {
  system_url: string; system_configured: boolean;
  personal_url: string; personal_username: string;
  has_personal_password: boolean; effective_username: string;
}

function NcConnect() {
  const qc = useQueryClient();
  const [ncUrl, setNcUrl]       = useState("");
  const [flowState, setFlow]    = useState<FlowState>("idle");
  const [flowErr, setFlowErr]   = useState("");
  const [flowUser, setFlowUser] = useState("");
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);

  const { data: cfg, isLoading } = useQuery<NcUserConfig>({
    queryKey: ["storage", "nextcloud"],
    queryFn: () => client.get("/api/storage/nextcloud").then((r) => r.data),
  });

  useEffect(() => {
    if (cfg?.personal_url) setNcUrl(cfg.personal_url);
  }, [cfg?.personal_url]);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => () => stopPoll(), []);

  const startFlow = useCallback(async () => {
    const url = ncUrl.trim() || cfg?.system_url || "";
    if (!url) return;
    setFlow("starting"); setFlowErr("");
    try {
      const r = await client.post("/api/storage/nextcloud/connect", { url });
      const { login_url, poll_endpoint, poll_token, nc_url: resolvedUrl } = r.data;
      popupRef.current = window.open(login_url, "nc_login", "width=600,height=700,noopener");
      setFlow("waiting");
      pollRef.current = setInterval(async () => {
        try {
          const pr = await client.post("/api/storage/nextcloud/connect/poll", {
            poll_endpoint, poll_token, nc_url: resolvedUrl,
          });
          if (pr.data.done) {
            stopPoll();
            popupRef.current?.close();
            setFlow("success");
            setFlowUser(pr.data.username);
            qc.invalidateQueries({ queryKey: ["storage", "nextcloud"] });
            toast.success("Nextcloud connected");
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e: any) {
      setFlow("error");
      setFlowErr(e.response?.data?.detail ?? "Could not reach Nextcloud");
    }
  }, [ncUrl, cfg?.system_url, qc]);

  const disconnect = async () => {
    await client.delete("/api/storage/nextcloud");
    qc.invalidateQueries({ queryKey: ["storage", "nextcloud"] });
    setFlow("idle"); setFlowUser("");
    toast.success("Disconnected");
  };

  if (isLoading) return <div className="py-4 text-sm text-gray-400">Loading…</div>;

  const connected = flowState === "success" || cfg?.has_personal_password;
  const connUser  = flowUser || cfg?.personal_username || cfg?.effective_username;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900 space-y-4">
      <div className="flex items-center gap-2">
        <Cloud className="h-5 w-5 text-indigo-500" />
        <h2 className="font-semibold">Nextcloud</h2>
        {cfg?.system_configured && (
          <span className="ml-auto text-xs text-gray-400">Organisation server configured</span>
        )}
      </div>

      {connected ? (
        <div className="flex items-center gap-3 rounded-xl bg-green-50 px-4 py-3 dark:bg-green-900/20">
          <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-green-700 dark:text-green-400">Connected</p>
            <p className="text-xs text-green-600 dark:text-green-500 truncate">
              {connUser}
              {cfg?.personal_url && <span className="ml-1 opacity-60">@ {cfg.personal_url}</span>}
            </p>
          </div>
          <button onClick={startFlow}
            className="shrink-0 text-xs text-green-700 hover:text-green-900 dark:text-green-400 underline">
            Reconnect
          </button>
          {cfg?.has_personal_password && (
            <button onClick={disconnect}
              className="shrink-0 p-1 text-red-400 hover:text-red-600" title="Disconnect">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            A secure app-password is generated on your Nextcloud instance — your real password never touches LWP.
          </p>
          {!cfg?.system_configured && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Nextcloud URL</label>
              <input value={ncUrl} onChange={(e) => setNcUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startFlow()}
                placeholder="https://cloud.example.com"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800" />
            </div>
          )}
          {flowState === "error" && (
            <p className="flex items-center gap-1.5 text-sm text-red-500">
              <XCircle className="h-4 w-4" /> {flowErr}
            </p>
          )}
          {flowState === "waiting" ? (
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-500 shrink-0" />
              <p className="text-sm text-gray-500 flex-1">Waiting for login in popup…</p>
              <button onClick={() => { stopPoll(); setFlow("idle"); }}
                className="text-xs text-gray-400 hover:text-gray-600 underline">Cancel</button>
            </div>
          ) : (
            <button onClick={startFlow}
              disabled={(!ncUrl.trim() && !cfg?.system_configured) || flowState === "starting"}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40">
              {flowState === "starting"
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</>
                : <><ExternalLink className="h-4 w-4" /> Sign in with Nextcloud</>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const LAYOUT_MODES: { id: "desktop" | "simple"; icon: string; label: string; desc: string }[] = [
  { id: "desktop", icon: "🖥️", label: "Desktop", desc: "Taskbar, launcher, window management" },
  { id: "simple",  icon: "🔲", label: "Simple",  desc: "Just Files and app tiles, nothing else" },
];

function Appearance() {
  const { wallpaper, setWallpaper, theme, setTheme, desktopLayout, setDesktopLayout, layoutMode, setLayoutMode } = useDesktopStore();
  const { user } = useAuthStore();
  const forcedSimple = !!user?.policies?.force_simple_layout;
  const [custom, setCustom] = useState("");

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900 space-y-5">
      <div className="flex items-center gap-2">
        <Palette className="h-5 w-5 text-indigo-500" />
        <h2 className="font-semibold">Appearance</h2>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Theme</p>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTheme(id as "dark" | "light" | "system")}
              className={cn("flex flex-col items-center gap-1.5 rounded-xl border py-3 text-xs transition-all",
                theme === id
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                  : "border-gray-200 text-gray-400 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
              )}>
              <Icon className="h-5 w-5" />{label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Desktop layout</p>
        <div className="grid grid-cols-3 gap-2">
          {LAYOUTS.map((l) => (
            <button key={l.id} onClick={() => setDesktopLayout(l.id)}
              className={cn("flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs transition-all",
                desktopLayout === l.id
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                  : "border-gray-200 text-gray-400 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
              )}>
              <span className="text-xl mb-0.5">{l.icon}</span>
              <span className="font-medium">{l.label}</span>
              <span className="text-center leading-tight opacity-60">{l.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Window management</p>
        {forcedSimple ? (
          <p className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800/50">
            Your group's policy locks this to Simple mode.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {LAYOUT_MODES.map((l) => (
              <button key={l.id} onClick={() => setLayoutMode(l.id)}
                className={cn("flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs transition-all",
                  layoutMode === l.id
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                    : "border-gray-200 text-gray-400 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
                )}>
                <span className="text-xl mb-0.5">{l.icon}</span>
                <span className="font-medium">{l.label}</span>
                <span className="text-center leading-tight opacity-60">{l.desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Wallpaper</p>
        <div className="grid grid-cols-4 gap-2">
          {PRESETS.map((p) => (
            <button key={p.value} onClick={() => setWallpaper(p.value)} title={p.label}
              className={cn("group relative h-14 rounded-xl ring-2 transition-all overflow-hidden",
                (wallpaper || PRESETS[0].value) === p.value
                  ? "ring-indigo-500 scale-95"
                  : "ring-transparent hover:ring-gray-300 dark:hover:ring-white/20"
              )}
              style={p.value.startsWith("#") ? { background: p.value } : { backgroundImage: p.value }}
            >
              <span className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[9px] text-white opacity-0 group-hover:opacity-100 transition-opacity">
                {p.label}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input value={custom} onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && custom && setWallpaper(custom)}
            placeholder="Custom image URL"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800" />
          <button onClick={() => custom && setWallpaper(custom)} disabled={!custom}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-40">
            Apply
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400 border-t border-gray-100 dark:border-gray-800 pt-3">
        <LayoutGrid className="inline h-3.5 w-3.5 mr-1" />
        Right-click the desktop to change wallpaper anytime.
      </p>
    </div>
  );
}

const CARD = "rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900";
const INP = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800";

// ── Extra storage mounts (SFTP / S3) ──────────────────────────────────────────
interface StorageMount {
  id: string;
  name: string;
  provider: "sftp" | "s3";
  mount_path: string;
  host?: string; user?: string; port?: number; path?: string;
  endpoint?: string; bucket?: string; region?: string; access_key_id?: string;
}

function MountsSection() {
  const qc = useQueryClient();
  const { data: mounts = [] } = useQuery<StorageMount[]>({
    queryKey: ["storage", "mounts"],
    queryFn: () => client.get("/api/storage/mounts").then((r) => r.data),
  });

  const [adding, setAdding] = useState<null | "sftp" | "s3">(null);
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => client.post("/api/storage/mounts", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storage", "mounts"] });
      toast.success("Mount added — it will appear in sessions you start from now on");
      setAdding(null); setF({});
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { detail?: string } } };
      toast.error(err.response?.data?.detail ?? "Could not add mount");
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => client.delete(`/api/storage/mounts/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["storage", "mounts"] }); toast.success("Mount removed"); },
  });

  const submit = () => {
    if (adding === "sftp") {
      create.mutate({
        name: f.name, provider: "sftp", host: f.host, port: Number(f.port) || 22,
        user: f.user, path: f.path || "",
        private_key: f.private_key || undefined, password: f.password || undefined,
      });
    } else {
      create.mutate({
        name: f.name, provider: "s3", endpoint: f.endpoint, region: f.region || "",
        bucket: f.bucket, access_key_id: f.access_key_id, secret_access_key: f.secret_access_key,
      });
    }
  };

  return (
    <div className={CARD + " space-y-4"}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold flex items-center gap-2"><HardDrive className="h-4 w-4" /> Extra storage mounts</h2>
        {!adding && (
          <div className="flex gap-2">
            <button onClick={() => { setAdding("sftp"); setF({ port: "22" }); }}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
              <Server className="h-3.5 w-3.5" /> SFTP
            </button>
            <button onClick={() => { setAdding("s3"); setF({}); }}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
              <Database className="h-3.5 w-3.5" /> S3
            </button>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400">
        Mounted via rclone under <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">~/Mount/&lt;name&gt;</code> in
        desktop sessions. Applied when a session <em>starts</em> — relaunch to pick up changes.
        Anyone you share a session with can read these mounts.
      </p>

      {mounts.length > 0 && (
        <ul className="space-y-2">
          {mounts.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
              {m.provider === "sftp" ? <Server className="h-4 w-4 text-indigo-500" /> : <Database className="h-4 w-4 text-amber-500" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{m.name} <span className="text-xs text-gray-400">→ ~/Mount/{m.name}</span></div>
                <div className="truncate text-xs text-gray-400">
                  {m.provider === "sftp" ? `${m.user}@${m.host}:${m.port}${m.path ? "/" + m.path : ""}` : `${m.bucket} @ ${m.endpoint || "AWS"}`}
                </div>
              </div>
              <button onClick={() => del.mutate(m.id)} className="text-gray-400 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}

      {adding === "sftp" && (
        <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div className="grid grid-cols-2 gap-2">
            <input className={INP} placeholder="Name (a-z, 0-9)" value={f.name || ""} onChange={(e) => set("name", e.target.value)} />
            <input className={INP} placeholder="Remote subpath (optional)" value={f.path || ""} onChange={(e) => set("path", e.target.value)} />
            <input className={INP} placeholder="Host" value={f.host || ""} onChange={(e) => set("host", e.target.value)} />
            <input className={INP} placeholder="Port" value={f.port || "22"} onChange={(e) => set("port", e.target.value)} />
            <input className={INP} placeholder="Username" value={f.user || ""} onChange={(e) => set("user", e.target.value)} />
            <input className={INP} type="password" placeholder="Password (or paste a key below)" value={f.password || ""} onChange={(e) => set("password", e.target.value)} />
          </div>
          <textarea className={INP + " font-mono text-xs h-28"} placeholder="Private SSH key (optional — used instead of the password)"
            value={f.private_key || ""} onChange={(e) => set("private_key", e.target.value)} />
          <p className="text-xs text-gray-400 flex items-center gap-1"><KeyRound className="h-3 w-3" /> Credentials are stored encrypted and only written into your own sessions.</p>
          <div className="flex gap-2">
            <button onClick={submit} disabled={create.isPending} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50">
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add mount
            </button>
            <button onClick={() => { setAdding(null); setF({}); }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">Cancel</button>
          </div>
        </div>
      )}

      {adding === "s3" && (
        <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div className="grid grid-cols-2 gap-2">
            <input className={INP} placeholder="Name (a-z, 0-9)" value={f.name || ""} onChange={(e) => set("name", e.target.value)} />
            <input className={INP} placeholder="Bucket" value={f.bucket || ""} onChange={(e) => set("bucket", e.target.value)} />
            <input className={INP} placeholder="Endpoint (blank = AWS)" value={f.endpoint || ""} onChange={(e) => set("endpoint", e.target.value)} />
            <input className={INP} placeholder="Region (optional)" value={f.region || ""} onChange={(e) => set("region", e.target.value)} />
            <input className={INP} placeholder="Access key ID" value={f.access_key_id || ""} onChange={(e) => set("access_key_id", e.target.value)} />
            <input className={INP} type="password" placeholder="Secret access key" value={f.secret_access_key || ""} onChange={(e) => set("secret_access_key", e.target.value)} />
          </div>
          <div className="flex gap-2">
            <button onClick={submit} disabled={create.isPending} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50">
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add mount
            </button>
            <button onClick={() => { setAdding(null); setF({}); }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 0) return "∞";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ── Security ──────────────────────────────────────────────────────────────────
// ── Per-app VPN defaults ──────────────────────────────────────────────────────
// Users set a small whitelist of env vars per app (LWP_VPN_DEFAULT /
// LWP_VPN_EXEMPT) via preferences["app_env"]; the backend merges them at
// session launch, on top of the admin's app env.
type VpnMode = "inherit" | "on" | "off" | "exempt";

function vpnModeOf(env: Record<string, string> | undefined): VpnMode {
  if (!env) return "inherit";
  if ((env.LWP_VPN_EXEMPT || "").match(/^(1|on|true)$/i)) return "exempt";
  const d = (env.LWP_VPN_DEFAULT || "").toLowerCase();
  if (["1", "on", "true"].includes(d)) return "on";
  if (d) return "off";
  return "inherit";
}

function envOfVpnMode(mode: VpnMode): Record<string, string> | null {
  switch (mode) {
    case "on":     return { LWP_VPN_DEFAULT: "on" };
    case "off":    return { LWP_VPN_DEFAULT: "off" };
    case "exempt": return { LWP_VPN_EXEMPT: "1" };
    default:       return null;
  }
}

function AppVpnDefaults() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const { data: apps = [] } = useQuery<{ id: string; name: string; icon_url: string; is_vpn?: boolean }[]>({
    queryKey: ["apps"],
    queryFn: () => client.get("/api/apps").then((r) => r.data),
  });

  const appEnv = ((user?.preferences as Record<string, unknown> | undefined)?.app_env ??
    {}) as Record<string, Record<string, string>>;

  const save = (appId: string, mode: VpnMode) => {
    const next = { ...appEnv };
    const env = envOfVpnMode(mode);
    if (env) next[appId] = env; else delete next[appId];
    client.patch("/api/auth/me/preferences", { app_env: next }).catch(() => {});
    if (user) setUser({ ...user, preferences: { ...(user.preferences || {}), app_env: next } });
  };

  const rows = apps.filter((a) => !a.is_vpn);
  if (!rows.length) return null;

  return (
    <div className={CARD + " space-y-4"}>
      <h2 className="font-semibold flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> App VPN defaults</h2>
      <p className="text-xs text-gray-400">
        How each app starts when your VPN gateway is running. You can still flip the
        shield on the window afterwards — except for <em>never proxied</em> apps, which
        get no proxy settings at all (for apps that misbehave when a proxy is configured).
        Applied when a session <em>starts</em> — relaunch to pick up changes.
      </p>
      <ul className="space-y-1.5">
        {rows.map((a) => (
          <li key={a.id} className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
            {a.icon_url
              ? <img src={a.icon_url} alt="" className="h-5 w-5 shrink-0 object-contain" />
              : <Monitor className="h-4 w-4 shrink-0 text-gray-400" />}
            <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
            <select
              value={vpnModeOf(appEnv[a.id])}
              onChange={(e) => save(a.id, e.target.value as VpnMode)}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
            >
              <option value="inherit">Default</option>
              <option value="off">Start direct</option>
              <option value="on">Start through VPN</option>
              <option value="exempt">Never proxied</option>
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Display & terminal appearance ─────────────────────────────────────────────
// Terminal font: only meaningful for ttyd-based apps (Terminal, htop, VPN
// login) — xterm.js runs in the browser, so any font just needs to exist on
// the user's own machine. Applied at session launch; relaunch to pick up.
// VNC display mode: applies live to already-open windows (query-string only,
// see lib/vncDisplay.ts) — no relaunch needed.
const FONT_PRESETS: { value: string; label: string; stack: string }[] = [
  { value: "",                          label: "System default (ttyd)",      stack: "" },
  { value: "Menlo, Monaco, 'Courier New', monospace", label: "Menlo / Monaco", stack: "" },
  { value: "Consolas, 'Courier New', monospace",      label: "Consolas",      stack: "" },
  { value: "'JetBrains Mono', Menlo, monospace",      label: "JetBrains Mono", stack: "" },
  { value: "'Fira Code', Menlo, monospace",           label: "Fira Code",     stack: "" },
];

function DisplaySettings() {
  const { user, setUser } = useAuthStore();
  const p = (user?.preferences ?? {}) as Record<string, unknown>;

  const savedFamily = (p.terminal_font_family as string) ?? "";
  const isPreset = FONT_PRESETS.some((f) => f.value === savedFamily);
  const [fontChoice, setFontChoice] = useState<string>(isPreset ? savedFamily : "custom");
  const [customFont, setCustomFont] = useState<string>(isPreset ? "" : savedFamily);
  const [fontSize, setFontSize] = useState<string>(
    p.terminal_font_size ? String(p.terminal_font_size) : ""
  );
  const [vncMode, setVncMode] = useState<VncDisplayMode>(
    (p.vnc_display_mode as VncDisplayMode) ?? "remote"
  );

  const save = (patch: Record<string, unknown>) => {
    client.patch("/api/auth/me/preferences", patch).then(() => toast.success("Saved")).catch(() => toast.error("Failed"));
    if (user) setUser({ ...user, preferences: { ...p, ...patch } } as typeof user);
  };

  const saveFontFamily = (family: string) => save({ terminal_font_family: family });
  const saveFontSize = (size: string) => {
    const n = Number(size);
    save({ terminal_font_size: size && n >= 8 && n <= 32 ? n : "" });
  };

  return (
    <div className={CARD + " space-y-5"}>
      <h2 className="font-semibold flex items-center gap-2"><Monitor className="h-4 w-4" /> Display &amp; terminal</h2>

      <div>
        <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
          <Type className="h-3.5 w-3.5" /> Terminal font
        </label>
        <div className="flex gap-2">
          <select
            value={fontChoice}
            onChange={(e) => {
              const v = e.target.value;
              setFontChoice(v);
              if (v !== "custom") saveFontFamily(v);
            }}
            className={INP + " flex-1"}
          >
            {FONT_PRESETS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
          <input
            type="number" min={8} max={32} placeholder="size"
            value={fontSize}
            onChange={(e) => { setFontSize(e.target.value); saveFontSize(e.target.value); }}
            className={INP + " w-20"}
          />
        </div>
        {fontChoice === "custom" && (
          <input
            className={INP + " mt-2"}
            placeholder="Font family (as CSS, e.g. 'Cascadia Code', monospace)"
            value={customFont}
            onChange={(e) => setCustomFont(e.target.value)}
            onBlur={() => saveFontFamily(customFont)}
          />
        )}
        <p className="mt-1 text-xs text-gray-400">
          Applies to Terminal, htop and the VPN login screen. The font just needs
          to be installed on <em>your</em> device — nothing to install here.
          Applied when a session starts — relaunch Terminal to pick it up.
        </p>
      </div>

      <div>
        <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
          <Maximize2 className="h-3.5 w-3.5" /> Desktop app resolution / zoom
        </label>
        <select
          value={vncMode}
          onChange={(e) => { const v = e.target.value as VncDisplayMode; setVncMode(v); save({ vnc_display_mode: v }); }}
          className={INP}
        >
          {VNC_DISPLAY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <p className="mt-1 text-xs text-gray-400">
          {VNC_DISPLAY_MODES.find((m) => m.value === vncMode)?.hint}{" "}
          Takes effect immediately in windows already open.
        </p>
      </div>
    </div>
  );
}

function SecuritySection() {
  const { user, setUser } = useAuthStore();
  const [name, setName] = useState(user?.display_name ?? "");
  const [cur, setCur] = useState(""); const [nw, setNw] = useState("");

  const saveName = useMutation({
    mutationFn: () => client.patch("/api/auth/me/profile", { display_name: name }),
    onSuccess: (r: any) => { if (user) setUser({ ...user, display_name: r.data.display_name }); toast.success("Name updated"); },
    onError: () => toast.error("Failed"),
  });
  const changePw = useMutation({
    mutationFn: () => client.post("/api/auth/me/password", { current_password: cur, new_password: nw }),
    onSuccess: () => { setCur(""); setNw(""); toast.success("Password changed"); },
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Failed"),
  });
  const signOutOthers = useMutation({
    mutationFn: () => client.post("/api/auth/me/sign-out-others"),
    onSuccess: () => toast.success("Signed out of all other browsers"),
    onError: () => toast.error("Failed"),
  });

  return (
    <div className={CARD + " space-y-5"}>
      <h2 className="flex items-center gap-2 font-semibold"><Lock className="h-4 w-4 text-indigo-500" /> Security</h2>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Display name</label>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className={INP} />
          <button onClick={() => name.trim() && saveName.mutate()} disabled={saveName.isPending || name === user?.display_name}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {user?.auth_source === "local" && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">Change password</label>
          <input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} className={INP} />
          <div className="flex gap-2">
            <input type="password" placeholder="New password (min 8)" value={nw} onChange={(e) => setNw(e.target.value)} className={INP} />
            <button onClick={() => changePw.mutate()} disabled={changePw.isPending || !cur || nw.length < 8}
              className="rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Save</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-gray-100 pt-4 dark:border-gray-800">
        <div className="text-sm">
          <p className="font-medium">Other browsers</p>
          <p className="text-xs text-gray-400">Sign out everywhere except here.</p>
        </div>
        <button onClick={() => signOutOthers.mutate()} disabled={signOutOthers.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
          <LogOut className="h-3.5 w-3.5" /> Sign out others
        </button>
      </div>
    </div>
  );
}

// ── About you (quota + storage) ───────────────────────────────────────────────
function AboutYou() {
  const { data: quota } = useQuery<{ limit: number; used: number; cpu_ceiling: string | null; mem_ceiling: string | null }>({
    queryKey: ["my-quota"], queryFn: () => client.get("/api/auth/me/quota").then((r) => r.data),
  });
  const { data: storage } = useQuery<{ used: number; available: number; total: number | null }>({
    queryKey: ["my-storage"], queryFn: () => client.get("/api/storage/quota").then((r) => r.data),
    retry: false,
  });

  return (
    <div className={CARD + " space-y-4"}>
      <h2 className="flex items-center gap-2 font-semibold"><HardDrive className="h-4 w-4 text-indigo-500" /> About you</h2>
      {quota && (
        <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2 text-sm dark:bg-gray-800">
          <span className="text-gray-500">Sessions</span>
          <span className="font-medium">{quota.used} / {quota.limit}
            {(quota.cpu_ceiling || quota.mem_ceiling) && (
              <span className="ml-2 text-xs text-gray-400">ceiling {quota.cpu_ceiling ?? "—"} · {quota.mem_ceiling ?? "—"}</span>
            )}
          </span>
        </div>
      )}
      {storage && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-gray-500">
            <span>Nextcloud storage</span>
            <span>{fmtBytes(storage.used)}{storage.total ? ` / ${fmtBytes(storage.total)}` : ""}</span>
          </div>
          {storage.total ? (
            <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-800">
              <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.min(100, (storage.used / storage.total) * 100)}%` }} />
            </div>
          ) : <p className="text-xs text-gray-400">Unlimited</p>}
        </div>
      )}
    </div>
  );
}

// ── Recent activity ───────────────────────────────────────────────────────────
function RecentActivity() {
  const { data: acts = [] } = useQuery<{ action: string; resource: string; detail: string; at: string }[]>({
    queryKey: ["my-activity"], queryFn: () => client.get("/api/auth/me/activity").then((r) => r.data),
  });
  if (acts.length === 0) {
    return (
      <div className={CARD}>
        <h2 className="mb-3 flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-indigo-500" /> Recent activity</h2>
        <p className="text-sm text-gray-400">Nothing yet.</p>
      </div>
    );
  }
  return (
    <div className={CARD}>
      <h2 className="mb-3 flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-indigo-500" /> Recent activity</h2>
      <ul className="space-y-1 text-sm">
        {acts.map((a, i) => (
          <li key={i} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800/50">
            <span className="font-mono text-xs text-indigo-600 dark:text-indigo-400">{a.action}</span>
            <span className="truncate px-2 text-xs text-gray-400 flex-1">{a.resource}</span>
            <span className="shrink-0 text-xs text-gray-400">{new Date(a.at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Preferences ───────────────────────────────────────────────────────────────
function PreferencesSection() {
  const { user, setUser } = useAuthStore();
  const p = (user?.preferences ?? {}) as Record<string, unknown>;
  const [logout, setLogout] = useState<string>((p.logout_sessions as string) ?? "ask");
  const [reduce, setReduce] = useState<boolean>(!!p.reduced_motion);
  const [clipSync, setClipSync] = useState<boolean>(!!p.clipboard_sync);
  const [termBg, setTermBg] = useState<boolean>(!!p.terminal_background);

  const save = (patch: Record<string, unknown>) =>
    client.patch("/api/auth/me/preferences", patch).then(() => toast.success("Saved")).catch(() => toast.error("Failed"));

  const toggleClipSync = (on: boolean) => {
    setClipSync(on);
    // Opting out also wipes the server-side copy (privacy)
    save(on ? { clipboard_sync: true } : { clipboard_sync: false, clipboard_history: [] });
    // Keep the in-memory user fresh so the desktop store sees the flag now
    if (user) setUser({ ...user, preferences: { ...p, clipboard_sync: on } } as typeof user);
  };

  return (
    <div className={CARD + " space-y-4"}>
      <h2 className="font-semibold">Preferences</h2>
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">On logout</label>
        <select value={logout} onChange={(e) => { setLogout(e.target.value); save({ logout_sessions: e.target.value }); }} className={INP}>
          <option value="ask">Ask each time</option>
          <option value="keep">Keep my desktops running</option>
          <option value="stop">Stop my desktops</option>
        </select>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={reduce} onChange={(e) => { setReduce(e.target.checked); save({ reduced_motion: e.target.checked }); }} className="h-4 w-4 accent-indigo-600" />
        Reduce motion / animations
      </label>
      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={termBg} onChange={(e) => {
            setTermBg(e.target.checked);
            save({ terminal_background: e.target.checked });
            if (user) setUser({ ...user, preferences: { ...p, terminal_background: e.target.checked } } as typeof user);
          }} className="h-4 w-4 accent-indigo-600" />
          Keep Terminal running in the background
        </label>
        <p className="mt-1 pl-6 text-xs text-gray-400">
          Terminal sessions are not suspended or stopped when idle — long jobs in
          tmux keep running even with the tab closed, for at most 48 hours.
        </p>
      </div>
      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={clipSync} onChange={(e) => toggleClipSync(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
          Sync clipboard history across devices
        </label>
        <p className="mt-1 pl-6 text-xs text-gray-400">
          Stores your shared-clipboard entries in your account so they survive
          logouts and follow you to other devices. Off by default for privacy;
          turning it off deletes the server-side copy.
        </p>
      </div>
    </div>
  );
}

// ── Account overview card ─────────────────────────────────────────────────────
function AccountCard() {
  const { user } = useAuthStore();

  const { data: groups = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["my-groups"],
    queryFn: () => client.get("/api/auth/me/groups").then((r) => r.data),
  });

  return (
    <div className={CARD}>
      <div className="mb-4 flex items-center gap-4">
        <NcAvatar name={user?.display_name || user?.username} size={56} />
        <div className="flex-1 min-w-0">
          <p className="text-lg font-semibold truncate">{user?.display_name}</p>
          <p className="text-sm text-gray-500 truncate">{user?.email}</p>
        </div>
        {user?.is_admin && (
          <span className="shrink-0 flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
            <ShieldCheck className="h-3.5 w-3.5" /> Admin
          </span>
        )}
      </div>

      <div className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2 dark:bg-gray-800">
          <span className="text-gray-500">Username</span>
          <span className="font-mono">{user?.username}</span>
        </div>
        {groups.length > 0 && (
          <div className="flex items-start justify-between rounded-lg bg-gray-50 px-4 py-2 dark:bg-gray-800">
            <span className="flex items-center gap-1 text-gray-500 shrink-0 mr-2">
              <Users className="h-3.5 w-3.5" /> Groups
            </span>
            <div className="flex flex-wrap gap-1 justify-end">
              {groups.map((g) => (
                <span key={g.id} className="rounded-full bg-gray-200 px-2 py-0.5 text-xs dark:bg-gray-700">{g.name}</span>
              ))}
            </div>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-gray-400">Account managed via your organisation's identity provider.</p>
    </div>
  );
}

// ── Page shell: sidebar nav (same layout pattern as AdminWindow) ─────────────
type ProfilePage = "account" | "storage" | "appearance" | "display" | "preferences" | "activity";

const PROFILE_NAV: { id: ProfilePage; label: string; icon: React.ElementType }[] = [
  { id: "account",     label: "Account",     icon: UserCircle },
  { id: "storage",     label: "Storage",     icon: Cloud },
  { id: "appearance",  label: "Appearance",  icon: Palette },
  { id: "display",     label: "Display",     icon: Monitor },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "activity",    label: "Activity",    icon: History },
];

export default function Profile() {
  const { user } = useAuthStore();
  const [page, setPage] = useState<ProfilePage>("account");

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Sidebar */}
      <div className="flex w-44 shrink-0 flex-col border-r border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-gray-950">
        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {PROFILE_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                page === id
                  ? "bg-indigo-600 text-white"
                  : "text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl space-y-5">
          {page === "account" && (
            <>
              <AccountCard />
              <AboutYou />
              <SecuritySection />
              {(user?.auth_source === "local" || user?.auth_source === "ldap") && <TwoFactorAuth />}
              <LockPinSection />
            </>
          )}
          {page === "storage" && (
            <>
              <NcConnect />
              <MountsSection />
            </>
          )}
          {page === "appearance" && <Appearance />}
          {page === "display" && <DisplaySettings />}
          {page === "preferences" && (
            <>
              <PreferencesSection />
              <AppVpnDefaults />
            </>
          )}
          {page === "activity" && <RecentActivity />}
        </div>
      </div>
    </div>
  );
}

// ── 2FA section ───────────────────────────────────────────────────────────────

function TwoFactorAuth() {
  const { user, setUser } = useAuthStore();
  const [phase, setPhase] = useState<"idle" | "setup" | "confirm">("idle");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const isEnabled = (user as any)?.totp_enabled ?? false;

  const setup = useMutation({
    mutationFn: () => client.post("/api/auth/2fa/setup").then((r) => r.data),
    onSuccess: (data) => { setSecret(data.secret); setUri(data.uri); setPhase("setup"); },
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Setup failed"),
  });

  const confirm = useMutation({
    mutationFn: (c: string) => client.post("/api/auth/2fa/confirm", { code: c }),
    onSuccess: async () => {
      const { data } = await client.get("/api/auth/me");
      setUser(data);
      setPhase("idle");
      setCode("");
      toast.success("Two-factor authentication enabled");
    },
    onError: (e: any) => setError(e.response?.data?.detail ?? "Invalid code"),
  });

  const disable = useMutation({
    mutationFn: () => client.delete("/api/auth/2fa"),
    onSuccess: async () => {
      const { data } = await client.get("/api/auth/me");
      setUser(data);
      toast.success("Two-factor authentication disabled");
    },
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Failed"),
  });

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-indigo-500" />
        <h2 className="font-semibold">Two-factor authentication</h2>
        {isEnabled && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle className="h-3 w-3" /> Enabled
          </span>
        )}
      </div>

      {!isEnabled && phase === "idle" && (
        <div>
          <p className="mb-4 text-sm text-gray-500">Add an extra layer of security. You'll need an authenticator app (e.g. Aegis, Bitwarden, Google Authenticator).</p>
          <button
            onClick={() => setup.mutate()}
            disabled={setup.isPending}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {setup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Set up 2FA
          </button>
        </div>
      )}

      {phase === "setup" && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">Scan the code in your authenticator app or enter the secret manually, then enter a code to confirm.</p>
          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
            <div className="mb-1 text-xs font-semibold text-gray-500">Secret key</div>
            <code className="block break-all font-mono text-sm">{secret}</code>
            <a href={uri} className="mt-2 flex items-center gap-1 text-xs text-indigo-500 hover:underline">
              <ExternalLink className="h-3 w-3" /> Open in authenticator app
            </a>
          </div>
          <div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, "")); setError(""); }}
              placeholder="6-digit code"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-center font-mono tracking-widest text-lg dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => confirm.mutate(code)}
              disabled={confirm.isPending || code.length !== 6}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {confirm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              Confirm
            </button>
            <button onClick={() => setPhase("idle")} className="rounded-xl border px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
              Cancel
            </button>
          </div>
        </div>
      )}

      {isEnabled && phase === "idle" && (
        <div>
          <p className="mb-4 text-sm text-gray-500">2FA is active. You'll need your authenticator app on next login.</p>
          <button
            onClick={() => disable.mutate()}
            disabled={disable.isPending}
            className="flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-900/20"
          >
            {disable.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Disable 2FA
          </button>
        </div>
      )}
    </div>
  );
}

// ── Idle lock screen PIN ───────────────────────────────────────────────────────
// Separate from the account password/OIDC login — it just re-gates an
// already-authenticated tab after the idle timer locks it, so any user
// (regardless of auth_source) can set one.

function LockPinSection() {
  const { user, setUser } = useAuthStore();
  const isEnabled = user?.lock_pin_enabled ?? false;
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");

  const refreshUser = async () => {
    const { data } = await client.get("/api/auth/me");
    setUser(data);
  };

  const setPinMutation = useMutation({
    mutationFn: () => client.post("/api/auth/lock-pin", { pin }),
    onSuccess: async () => {
      await refreshUser();
      setPin(""); setConfirmPin(""); setError("");
      toast.success("Lock PIN set");
    },
    onError: (e: any) => setError(e.response?.data?.detail ?? "Failed"),
  });

  const disable = useMutation({
    mutationFn: () => client.delete("/api/auth/lock-pin"),
    onSuccess: async () => { await refreshUser(); toast.success("Idle lock disabled"); },
    onError: () => toast.error("Failed"),
  });

  const digitsOk = /^\d{4,8}$/.test(pin);
  const canSave = digitsOk && pin === confirmPin;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-4 flex items-center gap-2">
        <LockKeyhole className="h-4 w-4 text-indigo-500" />
        <h2 className="font-semibold">Idle lock screen</h2>
        {isEnabled && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle className="h-3 w-3" /> Enabled
          </span>
        )}
      </div>

      <p className="mb-4 text-sm text-gray-500">
        Set a PIN and your desktop locks itself after 15 minutes idle — a quick
        privacy screen, not a full sign-out. Your open apps and sessions keep
        running behind it.
      </p>

      <div className="space-y-2">
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          value={pin}
          onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }}
          placeholder={isEnabled ? "New PIN (4-8 digits)" : "PIN (4-8 digits)"}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-center font-mono tracking-widest text-lg dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          value={confirmPin}
          onChange={(e) => { setConfirmPin(e.target.value.replace(/\D/g, "")); setError(""); }}
          placeholder="Confirm PIN"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-center font-mono tracking-widest text-lg dark:border-gray-600 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {pin && confirmPin && pin !== confirmPin && (
          <p className="text-xs text-red-500">PINs don't match</p>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => setPinMutation.mutate()}
          disabled={!canSave || setPinMutation.isPending}
          className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {setPinMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
          {isEnabled ? "Change PIN" : "Set PIN"}
        </button>
        {isEnabled && (
          <button
            onClick={() => disable.mutate()}
            disabled={disable.isPending}
            className="flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-900/20"
          >
            {disable.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Disable
          </button>
        )}
      </div>
    </div>
  );
}
