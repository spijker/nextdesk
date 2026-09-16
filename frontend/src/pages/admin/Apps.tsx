import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, ToggleLeft, ToggleRight, X, ChevronDown, ChevronUp,
  Download, HardDrive, Loader2, Check,
} from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import type { App } from "@/types";
import { cn } from "@/lib/utils";

// ── Access control (restrict an app to groups/people) ───────────────────────

interface AdminGroup { id: string; name: string }
interface AdminUser { id: string; email: string; display_name: string; username: string }

function MultiPicker({
  label, options, selected, onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  selected: string[];
  onChange(ids: string[]): void;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      {options.length === 0 ? (
        <p className="text-xs text-gray-400">None yet.</p>
      ) : (
        <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 p-1.5 dark:border-gray-700">
          {options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggle(o.id)}
                className="rounded"
              />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Local storage (Docker host disk) — full host stats live on the ─────────
// Dashboard; this is just the compact "is there room to pull?" read-out,
// pulled from the same endpoint so there's one place computing it.

interface HostStats {
  available: boolean;
  disk?: { total_bytes: number; used_bytes: number; free_bytes: number; images_bytes: number };
}

function fmtBytes(n: number): string {
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`;
}

function StorageIndicator() {
  const { data } = useQuery<HostStats>({
    queryKey: ["admin", "stats", "host"],
    queryFn: () => client.get("/api/admin/stats/host").then((r) => r.data),
    refetchInterval: 30_000,
  });
  const disk = data?.disk;
  if (!data?.available || !disk) return null;
  const usedPct = Math.min(100, (disk.used_bytes / disk.total_bytes) * 100);
  const low = disk.free_bytes < 10e9; // under 10 GB free
  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-900"
      title={`Images: ${fmtBytes(disk.images_bytes)}`}
    >
      <HardDrive className={cn("h-4 w-4", low ? "text-red-500" : "text-gray-400")} />
      <div className="w-28">
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
          <div
            className={cn("h-full rounded-full", low ? "bg-red-500" : "bg-indigo-500")}
            style={{ width: `${usedPct}%` }}
          />
        </div>
      </div>
      <span className={cn("text-gray-500 dark:text-gray-400", low && "font-semibold text-red-500")}>
        {fmtBytes(disk.free_bytes)} free of {fmtBytes(disk.total_bytes)}
      </span>
    </div>
  );
}

// ── Predownload (warm an app's image so a user's first launch is instant) ───

interface PullStatus { status: "pending" | "pulling" | "done" | "error"; detail?: string }

function PredownloadButton({ app, missing }: { app: App; missing: boolean }) {
  const qc = useQueryClient();
  const { data: pull } = useQuery<PullStatus>({
    queryKey: ["admin", "apps", app.id, "pull"],
    queryFn: () => client.get(`/api/admin/apps/${app.id}/pull`).then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.status === "pulling" ? 2000 : false),
  });

  const start = useMutation({
    mutationFn: () => client.post(`/api/admin/apps/${app.id}/pull`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "apps", app.id, "pull"] }),
    onError: () => toast.error("Couldn't start the pull"),
  });

  useEffect(() => {
    if (pull?.status === "done") {
      qc.invalidateQueries({ queryKey: ["admin", "apps", "staleness"] });
      toast.success(`${app.name} image ready locally`);
    } else if (pull?.status === "error") {
      toast.error(`Pull failed: ${pull.detail?.slice(0, 120) ?? "unknown error"}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull?.status]);

  if (pull?.status === "pulling") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-gray-400" title={pull.detail}>
        <Loader2 className="h-3 w-3 animate-spin" /> pulling…
      </span>
    );
  }
  if (pull?.status === "done" && !missing) {
    return <Check className="h-3.5 w-3.5 text-green-500" />;
  }
  return (
    <button
      onClick={() => start.mutate()}
      disabled={start.isPending}
      title="Predownload image now"
      className="text-gray-400 hover:text-indigo-500 disabled:opacity-50"
    >
      <Download className="h-3.5 w-3.5" />
    </button>
  );
}

// ── Preset catalogue ──────────────────────────────────────────────────────────

interface Preset {
  label: string;
  icon: string;
  description: string;
  defaults: Partial<AppForm>;
}

const STREAM_PRESETS: Preset[] = [
  {
    label: "Firefox",
    icon: "🦊",
    description: "Full web browser",
    defaults: { name: "Firefox", category: "Browser", container_image: "lwp-firefox", icon_url: "/icons/firefox.svg" },
  },
  {
    label: "Chromium",
    icon: "🌐",
    description: "Chromium browser",
    defaults: { name: "Chromium", category: "Browser", container_image: "lwp-chromium", icon_url: "/icons/chrome.svg" },
  },
  {
    label: "LibreOffice",
    icon: "📝",
    description: "Office suite",
    defaults: { name: "LibreOffice", category: "Office", container_image: "lwp-libreoffice", icon_url: "/icons/libreoffice.svg" },
  },
  {
    label: "Thunderbird",
    icon: "📧",
    description: "Email client",
    defaults: { name: "Thunderbird", category: "Email", container_image: "lwp-thunderbird", icon_url: "/icons/thunderbird.svg" },
  },
  {
    label: "Terminator",
    icon: "🖥️",
    description: "Terminal emulator",
    defaults: { name: "Terminator", category: "Developer", container_image: "lwp-terminator", icon_url: "/icons/terminator.svg" },
  },
  {
    label: "GIMP",
    icon: "🎨",
    description: "Image editor",
    defaults: { name: "GIMP", category: "Creative", container_image: "lwp-gimp" },
  },
  {
    label: "VS Code",
    icon: "💻",
    description: "Code editor",
    defaults: { name: "VS Code", category: "Development", container_image: "lwp-vscode" },
  },
  {
    label: "Custom",
    icon: "📦",
    description: "Your own image",
    defaults: { name: "", category: "General", container_image: "" },
  },
];

// ── LinuxServer.io catalog (app_type: "kasm" — KasmVNC, port 3000) ────────────

interface LsImage {
  name: string;
  description: string;
  category: string;
  icon_url: string;
  tags: string[];
}

interface LsPreset { label: string; icon: string; name: string; tag?: string }

const LINUXSERVER_PRESETS: LsPreset[] = [
  { label: "Firefox", icon: "🦊", name: "firefox" },
  { label: "Chromium", icon: "🌐", name: "chromium" },
  { label: "Vivaldi", icon: "🅅", name: "vivaldi" },
  { label: "LibreOffice", icon: "📝", name: "libreoffice" },
  { label: "Thunderbird", icon: "📧", name: "thunderbird" },
  { label: "Webtop (Ubuntu XFCE)", icon: "🖥️", name: "webtop", tag: "ubuntu-xfce" },
];

function titleCaseName(name: string): string {
  return name.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Form types ────────────────────────────────────────────────────────────────

interface AppForm {
  name: string;
  description: string;
  category: string;
  icon_url: string;
  app_type: "web" | "stream" | "kasm";
  web_url: string;
  container_image: string;
  proxy_port: number;
  cpu_limit: string;
  mem_limit: string;
  shm_size: string;
  env_json: Record<string, string>;
  mount_home: boolean;
  is_enabled: boolean;
}

const DEFAULTS_WEB: AppForm = {
  name: "", description: "", category: "General", icon_url: "",
  app_type: "web", web_url: "", container_image: "",
  proxy_port: 8080, cpu_limit: "2000m", mem_limit: "2Gi", shm_size: "1Gi",
  env_json: {}, mount_home: false, is_enabled: true,
};

const DEFAULTS_STREAM: AppForm = {
  name: "", description: "", category: "General", icon_url: "",
  app_type: "stream", web_url: "", container_image: "",
  proxy_port: 8080, cpu_limit: "2000m", mem_limit: "2Gi", shm_size: "1Gi",
  env_json: {}, mount_home: true, is_enabled: true,
};

const DEFAULTS_KASM: AppForm = {
  name: "", description: "", category: "General", icon_url: "",
  app_type: "kasm", web_url: "", container_image: "",
  proxy_port: 3000, cpu_limit: "2000m", mem_limit: "2Gi", shm_size: "1Gi",
  env_json: {}, mount_home: true, is_enabled: true,
};

// ── Label chip ────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  stream: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  web:    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  kasm:   "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};
const TYPE_LABELS: Record<string, string> = { stream: "VNC app", web: "Web app", kasm: "Selkies" };

// ── AppField — defined outside AppModal so React never remounts it on re-render ──

function AppField({
  label, value, onChange, placeholder, required, mono,
}: {
  label: string; value: string; onChange(v: string): void;
  placeholder?: string; required?: boolean; mono?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
        {label}{required && <span className="ml-0.5 text-red-400">*</span>}
      </label>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800",
          mono && "font-mono",
        )}
      />
    </div>
  );
}

// ── EnvEditor ─────────────────────────────────────────────────────────────────

function EnvEditor({ value, onChange }: { value: Record<string, string>; onChange(v: Record<string, string>): void }) {
  const pairs = Object.entries(value);
  const add = () => onChange({ ...value, "": "" });
  const remove = (k: string) => { const copy = { ...value }; delete copy[k]; onChange(copy); };
  const updateKey = (old: string, newKey: string) => {
    const copy: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) copy[k === old ? newKey : k] = v;
    onChange(copy);
  };
  const updateVal = (k: string, v: string) => onChange({ ...value, [k]: v });

  return (
    <div className="space-y-1.5">
      {pairs.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <input
            value={k}
            onChange={(e) => updateKey(k, e.target.value)}
            placeholder="KEY"
            className="w-36 rounded border border-gray-300 px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-800"
          />
          <span className="pt-1 text-gray-400">=</span>
          <input
            value={v}
            onChange={(e) => updateVal(k, e.target.value)}
            placeholder="value"
            className="flex-1 rounded border border-gray-300 px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-800"
          />
          <button onClick={() => remove(k)} className="text-gray-400 hover:text-red-500">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button onClick={add} className="text-xs text-indigo-500 hover:text-indigo-400">
        + Add variable
      </button>
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

type Mode = "web" | "stream" | "kasm";

function AppModal({ app, onClose }: { app: App | "new"; onClose(): void }) {
  const qc = useQueryClient();
  const isNew = app === "new";

  const [form, setForm] = useState<AppForm>(() => {
    if (!isNew) {
      const a = app as App;
      const type: "web" | "stream" | "kasm" =
        a.app_type === "web" ? "web" : a.app_type === "kasm" ? "kasm" : "stream";
      return { ...(a as unknown as AppForm), app_type: type };
    }
    return DEFAULTS_WEB;
  });

  const [mode, setMode] = useState<Mode>(() => {
    if (isNew) return "web";
    const a = app as App;
    if (a.app_type === "web") return "web";
    if (a.app_type === "kasm") return "kasm";
    return "stream";
  });

  const [lsQuery, setLsQuery] = useState("");
  const [lsResults, setLsResults] = useState<LsImage[] | null>(null);
  const [lsErr, setLsErr] = useState("");
  const [lsPicked, setLsPicked] = useState<LsImage | null>(null);
  const [lsTag, setLsTag] = useState("latest");

  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState("");

  const set = <K extends keyof AppForm>(k: K, v: AppForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const switchMode = (m: Mode) => {
    setMode(m);
    setSelectedPreset(null);
    if (m !== "kasm") { setLsResults(null); setLsPicked(null); setLsQuery(""); setLsErr(""); }
    setForm((f) => {
      const base = m === "web" ? DEFAULTS_WEB : m === "kasm" ? DEFAULTS_KASM : DEFAULTS_STREAM;
      return {
        ...base,
        name: f.name,
        description: f.description,
        category: f.category,
        icon_url: f.icon_url,
        is_enabled: f.is_enabled,
      };
    });
    // Browse mode: show popular GUI-capable images right away, no typing needed.
    if (m === "kasm") lsSearch.mutate("");
  };

  const applyPreset = (preset: Preset) => {
    setSelectedPreset(preset.label);
    setForm((f) => ({ ...f, ...preset.defaults }));
  };

  const lsSearch = useMutation({
    mutationFn: (q: string) =>
      client.get("/api/admin/apps/linuxserver/lookup", { params: { q } }).then((r) => r.data as LsImage[]),
    onSuccess: (data) => { setLsErr(""); setLsResults(data); },
    onError: (e: any) => setLsErr(e.response?.data?.detail ?? "Search failed"),
  });

  const pickLsImage = (img: LsImage, tag?: string) => {
    const chosenTag = tag ?? img.tags[0] ?? "latest";
    setLsPicked(img);
    setLsTag(chosenTag);
    setForm((f) => ({
      ...f,
      name: f.name || titleCaseName(img.name),
      description: img.description,
      icon_url: img.icon_url,
      category: (img.category || "General").split(",")[0].trim() || "General",
      container_image: `lscr.io/linuxserver/${img.name}:${chosenTag}`,
    }));
  };

  const changeLsTag = (tag: string) => {
    setLsTag(tag);
    if (lsPicked) set("container_image", `lscr.io/linuxserver/${lsPicked.name}:${tag}`);
  };

  const applyLsPreset = (preset: LsPreset) => {
    setSelectedPreset(preset.label);
    setLsQuery(preset.name);
    lsSearch.mutate(preset.name, {
      onSuccess: (data) => {
        setLsErr(""); setLsResults(data);
        const exact = data.find((d) => d.name === preset.name);
        if (exact) pickLsImage(exact, preset.tag);
      },
    });
  };

  // ── Access — restrict to specific groups/people (empty = everyone) ───────
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);

  const { data: groups = [] } = useQuery<AdminGroup[]>({
    queryKey: ["admin", "groups"],
    queryFn: () => client.get("/api/admin/groups").then((r) => r.data),
  });
  const { data: adminUsers = [] } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: () => client.get("/api/admin/users").then((r) => r.data),
  });
  const { data: currentPerms } = useQuery<{ group_ids: string[]; user_ids: string[] }>({
    queryKey: ["admin", "apps", !isNew && (app as App).id, "permissions"],
    queryFn: () => client.get(`/api/admin/apps/${(app as App).id}/permissions`).then((r) => r.data),
    enabled: !isNew,
  });
  useEffect(() => {
    if (currentPerms) { setGroupIds(currentPerms.group_ids); setUserIds(currentPerms.user_ids); }
  }, [currentPerms]);

  const save = useMutation({
    mutationFn: async () => {
      const res = isNew
        ? await client.post("/api/admin/apps", form)
        : await client.put(`/api/admin/apps/${(app as App).id}`, form);
      await client.put(`/api/admin/apps/${res.data.id}/permissions`, {
        group_ids: groupIds, user_ids: userIds,
      });
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "apps"] });
      toast.success(isNew ? "App created" : "App updated");
      onClose();
    },
    onError: (e: any) => setErr(e.response?.data?.detail ?? "Save failed"),
  });

  const f = <K extends keyof AppForm>(k: K) => ({
    value: (form[k] as string) ?? "",
    onChange: (v: string) => set(k, v as AppForm[K]),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="relative flex max-h-[90vh] min-h-[420px] w-full max-w-xl min-w-[380px] resize flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-bold pr-8">{isNew ? "Add app" : `Edit — ${(app as App).name}`}</h2>
        </div>

        {/* Close — pinned to the card's corner like a window titlebar, not
            inline with the header text (which truncates/wraps independently
            as the card is resized). */}
        <button
          onClick={onClose}
          title="Close"
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* Type switcher */}
          <div>
            <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Type</p>
            <div className="grid grid-cols-3 gap-2">
              {(["web", "stream", "kasm"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => switchMode(t)}
                  className={cn(
                    "rounded-xl border p-3 text-left text-sm transition-colors",
                    mode === t
                      ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20"
                      : "border-gray-200 hover:border-gray-300 dark:border-gray-700"
                  )}
                >
                  <div className="font-semibold text-sm">
                    {t === "web" && "🌐 Web app"}
                    {t === "stream" && "🖥️ VNC app"}
                    {t === "kasm" && "📥 LinuxServer.io"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-400">
                    {t === "web" && "Opens a URL in a browser container"}
                    {t === "stream" && "Streamed via KasmVNC — audio included"}
                    {t === "kasm" && "Maintained lscr.io image — no build"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Web app fields */}
          {mode === "web" && (
            <>
              <AppField label="App name" {...f("name")} required placeholder="e.g. Nextcloud" />
              <AppField label="URL" {...f("web_url")} required placeholder="https://cloud.example.com" />
              <div className="grid grid-cols-2 gap-4">
                <AppField label="Category" {...f("category")} placeholder="General" />
                <AppField label="Icon URL" {...f("icon_url")} placeholder="https://…/icon.png" />
              </div>
            </>
          )}

          {/* LinuxServer.io catalog fields */}
          {mode === "kasm" && (
            <>
              {isNew && (
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Popular on LinuxServer.io</p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {LINUXSERVER_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => applyLsPreset(p)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-xl border p-2.5 text-center text-xs transition-colors",
                          selectedPreset === p.label
                            ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20"
                            : "border-gray-200 hover:border-gray-300 dark:border-gray-700"
                        )}
                      >
                        <span className="text-xl">{p.icon}</span>
                        <span className="font-medium">{p.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  Search the LinuxServer.io catalog
                </label>
                <div className="flex gap-1.5">
                  <input
                    value={lsQuery}
                    onChange={(e) => { setLsQuery(e.target.value); setSelectedPreset(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); lsSearch.mutate(lsQuery.trim()); } }}
                    placeholder="e.g. firefox, webtop, jellyfin"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                  />
                  <button
                    type="button"
                    onClick={() => lsSearch.mutate(lsQuery.trim())}
                    disabled={lsSearch.isPending}
                    className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    {lsSearch.isPending ? "Searching…" : "Search"}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-gray-400">
                  Pulls a maintained lscr.io/linuxserver image — no build step. Leave it blank and hit Search
                  to browse popular browser/desktop-style images instead of the whole (mostly headless) catalog.
                </p>
                {lsErr && <p className="mt-1 text-xs text-red-500">{lsErr}</p>}
              </div>

              {lsResults && lsResults.length > 0 && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-gray-200 p-1.5 dark:border-gray-700">
                  {lsResults.map((img) => (
                    <button
                      key={img.name}
                      type="button"
                      onClick={() => pickLsImage(img)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-xs transition-colors",
                        lsPicked?.name === img.name
                          ? "bg-indigo-50 dark:bg-indigo-900/20"
                          : "hover:bg-gray-50 dark:hover:bg-gray-800"
                      )}
                    >
                      {img.icon_url
                        ? <img src={img.icon_url} alt="" className="h-6 w-6 shrink-0 rounded object-contain" />
                        : <span className="text-lg">🐳</span>}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{img.name}</p>
                        <p className="truncate text-gray-400">{img.category}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {lsResults && lsResults.length === 0 && (
                <p className="text-xs text-gray-400">No matches.</p>
              )}

              {lsPicked && lsPicked.tags.length > 1 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Variant</label>
                  <select
                    value={lsTag}
                    onChange={(e) => changeLsTag(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                  >
                    {lsPicked.tags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <AppField label="Name" {...f("name")} required />
                <AppField label="Category" {...f("category")} placeholder="General" />
              </div>
              <AppField label="Container image" {...f("container_image")} required mono
                placeholder="lscr.io/linuxserver/firefox:latest" />
              <AppField label="Icon URL" {...f("icon_url")} placeholder="https://…/icon.png" />
            </>
          )}

          {/* VNC stream app fields */}
          {mode === "stream" && (
            <>
              {/* Preset picker */}
              {isNew && (
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Quick start</p>
                  <div className="grid grid-cols-4 gap-2">
                    {STREAM_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-xl border p-2.5 text-center text-xs transition-colors",
                          selectedPreset === p.label
                            ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20"
                            : "border-gray-200 hover:border-gray-300 dark:border-gray-700"
                        )}
                      >
                        <span className="text-xl">{p.icon}</span>
                        <span className="font-medium">{p.label}</span>
                        <span className="text-gray-400">{p.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <AppField label="Name" {...f("name")} required />
                <AppField label="Category" {...f("category")} placeholder="General" />
              </div>
              <AppField label="Container image" {...f("container_image")} required mono
                placeholder="lwp-firefox or registry.example.com/img:tag" />
              <div className="grid grid-cols-2 gap-4">
                <AppField label="Icon URL" {...f("icon_url")} placeholder="https://…/icon.png" />
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                    Port
                  </label>
                  <input
                    type="number"
                    value={form.proxy_port}
                    onChange={(e) => set("proxy_port", parseInt(e.target.value))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                  />
                </div>
              </div>
            </>
          )}

          {/* Description (all types) */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Description
            </label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>

          {/* Advanced (stream / kasm only) */}
          {(mode === "stream" || mode === "kasm") && (
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Advanced settings
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-4 rounded-xl bg-gray-50 p-4 dark:bg-gray-800/50">
                  <div className="grid grid-cols-2 gap-4">
                    <AppField label="CPU limit" {...f("cpu_limit")} placeholder="2000m" />
                    <AppField label="Memory limit" {...f("mem_limit")} placeholder="2Gi" />
                  </div>
                  <AppField label="Shared memory (/dev/shm)" {...f("shm_size")} placeholder="1Gi" />

                  <div>
                    <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                      Environment variables
                    </p>
                    <EnvEditor
                      value={form.env_json}
                      onChange={(v) => set("env_json", v)}
                    />
                  </div>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!form.mount_home}
                      onChange={(e) => set("mount_home", e.target.checked)}
                      className="rounded"
                    />
                    Mount persistent home volume
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Access — restrict to specific groups/people (empty = everyone) */}
          <div>
            <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">
              Access {groupIds.length + userIds.length === 0 && <span className="font-normal text-gray-400">— everyone</span>}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <MultiPicker
                label="Groups"
                options={groups.map((g) => ({ id: g.id, label: g.name }))}
                selected={groupIds}
                onChange={setGroupIds}
              />
              <MultiPicker
                label="People"
                options={adminUsers.map((u) => ({ id: u.id, label: u.display_name || u.username }))}
                selected={userIds}
                onChange={setUserIds}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.is_enabled}
              onChange={(e) => set("is_enabled", e.target.checked)}
              className="rounded"
            />
            Enabled (visible to users)
          </label>

          {err && <p className="text-sm text-red-500">{err}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-gray-100 p-4 dark:border-gray-800">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={() => { setErr(""); save.mutate(); }}
            disabled={
              !form.name ||
              (mode === "web" && !form.web_url) ||
              (mode === "kasm" && !form.container_image.trim()) ||
              save.isPending
            }
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main list ─────────────────────────────────────────────────────────────────

export default function AdminApps() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<App | "new" | null>(null);

  const { data: apps = [] } = useQuery<App[]>({
    queryKey: ["admin", "apps"],
    queryFn: () => client.get("/api/admin/apps").then((r) => r.data),
  });

  // Hourly image-update check (registry digest vs local); manual refresh below.
  const { data: staleness } = useQuery<{ checked_at: string | null; images: Record<string, { status: string }> }>({
    queryKey: ["admin", "apps", "staleness"],
    queryFn: () => client.get("/api/admin/apps/staleness").then((r) => r.data),
  });

  const checkNow = useMutation({
    mutationFn: () => client.post("/api/admin/apps/staleness/check"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "apps", "staleness"] });
      toast.success("Image check complete");
    },
    onError: () => toast.error("Image check failed"),
  });

  const toggle = useMutation({
    mutationFn: (a: App) => client.put(`/api/admin/apps/${a.id}`, { ...a, is_enabled: !a.is_enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "apps"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.delete(`/api/admin/apps/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "apps"] });
      toast.success("App removed");
    },
  });

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">App Catalog</h1>
          <p className="text-sm text-gray-500">
            {apps.length} app{apps.length === 1 ? "" : "s"} configured
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StorageIndicator />
          <button
            onClick={() => checkNow.mutate()}
            disabled={checkNow.isPending}
            title={staleness?.checked_at ? `Last check: ${new Date(staleness.checked_at).toLocaleString()}` : "Never checked"}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {checkNow.isPending ? "Checking…" : "Check for image updates"}
          </button>
          <button
            onClick={() => setEditing("new")}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" /> Add app
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-xs text-gray-400">
              <th className="px-4 py-3">App</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Image / URL</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => {
              return (
              <tr
                key={a.id}
                className="border-b border-gray-50 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg dark:bg-gray-800">
                      {a.icon_url
                        ? <img src={a.icon_url} alt="" className="h-5 w-5 object-contain" />
                        : <span>{a.app_type === "web" ? "🌐" : "🖥️"}</span>}
                    </div>
                    <div>
                      <p className="font-medium">{a.name}</p>
                      <p className="text-xs text-gray-400 max-w-[180px] truncate">{a.description || a.category}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    TYPE_COLORS[a.app_type] ?? TYPE_COLORS.stream
                  )}>
                    {TYPE_LABELS[a.app_type] ?? a.app_type}
                  </span>
                  {!a.is_enabled && (
                    <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-400 dark:bg-gray-800">
                      disabled
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 max-w-[220px] font-mono text-xs text-gray-400">
                  <div className="flex items-center gap-1.5">
                    <span className="block flex-1 truncate">
                      {a.container_image || a.web_url || "—"}
                    </span>
                    {a.container_image && a.app_type !== "web" && (
                      <PredownloadButton
                        app={a}
                        missing={staleness?.images?.[a.container_image]?.status === "missing"}
                      />
                    )}
                  </div>
                  {a.container_image && staleness?.images?.[a.container_image]?.status === "stale" && (
                    <span className="mt-0.5 inline-block rounded-full bg-amber-100 px-2 py-0.5 font-sans text-[10px] font-medium text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                      update available
                    </span>
                  )}
                  {a.container_image && staleness?.images?.[a.container_image]?.status === "missing" && (
                    <span className="mt-0.5 inline-block rounded-full bg-red-100 px-2 py-0.5 font-sans text-[10px] font-medium text-red-700 dark:bg-red-500/20 dark:text-red-300">
                      image missing
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => toggle.mutate(a)}
                      title={a.is_enabled ? "Disable" : "Enable"}
                    >
                      {a.is_enabled
                        ? <ToggleRight className="h-5 w-5 text-green-500" />
                        : <ToggleLeft className="h-5 w-5 text-gray-400" />}
                    </button>
                    <button onClick={() => setEditing(a)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => window.confirm(`Delete "${a.name}"?`) && remove.mutate(a.id)}
                      className="text-gray-400 hover:text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {apps.length === 0 && (
          <p className="py-16 text-center text-sm text-gray-400">
            No apps yet — click "Add app" to get started.
          </p>
        )}
      </div>

      {editing && <AppModal app={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
