import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, ToggleLeft, ToggleRight, X, ChevronDown, ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import type { App } from "@/types";
import { cn } from "@/lib/utils";

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

const FLATPAK_IMAGE = "lwp-flatpak";

interface FlatpakPreset {
  label: string;
  icon: string;
  flatpakId: string;
}

const FLATPAK_PRESETS: FlatpakPreset[] = [
  { label: "VLC", icon: "🎬", flatpakId: "org.videolan.VLC" },
  { label: "GIMP", icon: "🎨", flatpakId: "org.gimp.GIMP" },
  { label: "Inkscape", icon: "✏️", flatpakId: "org.inkscape.Inkscape" },
  { label: "OBS Studio", icon: "🎥", flatpakId: "com.obsproject.Studio" },
  { label: "Blender", icon: "🧊", flatpakId: "org.blender.Blender" },
  { label: "Spotify", icon: "🎧", flatpakId: "com.spotify.Client" },
];

// ── Form types ────────────────────────────────────────────────────────────────

interface AppForm {
  name: string;
  description: string;
  category: string;
  icon_url: string;
  app_type: "web" | "stream";
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

// ── Label chip ────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  stream: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  web:    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
};
const TYPE_LABELS: Record<string, string> = { stream: "VNC app", web: "Web app" };

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

type Mode = "web" | "stream" | "flatpak";

function AppModal({ app, onClose }: { app: App | "new"; onClose(): void }) {
  const qc = useQueryClient();
  const isNew = app === "new";

  const [form, setForm] = useState<AppForm>(() => {
    if (!isNew) {
      const a = app as App;
      // Existing kasm apps editable as stream (same fields)
      const type: "web" | "stream" = a.app_type === "web" ? "web" : "stream";
      // LWP_FLATPAK_APP_ID is driven by its own field below, not the advanced
      // env editor — keep it out of there to avoid two sources of truth.
      const restEnv = { ...(a.env_json ?? {}) };
      delete restEnv.LWP_FLATPAK_APP_ID;
      return { ...(a as unknown as AppForm), app_type: type, env_json: restEnv };
    }
    return DEFAULTS_WEB;
  });

  const [mode, setMode] = useState<Mode>(() => {
    if (isNew) return "web";
    const a = app as App;
    if (a.app_type === "web") return "web";
    return a.container_image === FLATPAK_IMAGE ? "flatpak" : "stream";
  });
  const [flatpakId, setFlatpakId] = useState<string>(() => {
    if (isNew) return "";
    return (app as App).env_json?.LWP_FLATPAK_APP_ID ?? "";
  });
  const [lookupErr, setLookupErr] = useState("");

  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState("");

  const set = <K extends keyof AppForm>(k: K, v: AppForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const switchMode = (m: Mode) => {
    setMode(m);
    setSelectedPreset(null);
    setLookupErr("");
    if (m !== "flatpak") setFlatpakId("");
    setForm((f) => {
      const base = m === "web" ? DEFAULTS_WEB : DEFAULTS_STREAM;
      return {
        ...base,
        name: f.name,
        description: f.description,
        category: m === "flatpak" ? (f.category === "General" ? "Flatpak" : f.category) : f.category,
        icon_url: f.icon_url,
        is_enabled: f.is_enabled,
        container_image: m === "flatpak" ? FLATPAK_IMAGE : base.container_image,
      };
    });
  };

  const applyPreset = (preset: Preset) => {
    setSelectedPreset(preset.label);
    setForm((f) => ({ ...f, ...preset.defaults }));
  };

  const lookup = useMutation({
    mutationFn: (id: string) =>
      client.get("/api/admin/apps/flatpak/lookup", { params: { app_id: id } }).then((r) => r.data),
    onSuccess: (data: { name: string; summary: string; icon_url: string }) => {
      setLookupErr("");
      // Always overwrite — this only runs on an explicit "Look up" click (or a
      // preset pick), so a stale name/icon from a previously-looked-up id
      // never lingers after the admin switches to a different app.
      setForm((f) => ({
        ...f,
        name: data.name,
        description: data.summary,
        icon_url: data.icon_url,
      }));
    },
    onError: (e: any) => setLookupErr(e.response?.data?.detail ?? "Lookup failed"),
  });

  const applyFlatpakPreset = (preset: FlatpakPreset) => {
    setSelectedPreset(preset.label);
    setFlatpakId(preset.flatpakId);
    lookup.mutate(preset.flatpakId);
  };

  const save = useMutation({
    mutationFn: () => {
      const payload =
        mode === "flatpak"
          ? { ...form, container_image: FLATPAK_IMAGE, env_json: { ...form.env_json, LWP_FLATPAK_APP_ID: flatpakId.trim() } }
          : form;
      return isNew
        ? client.post("/api/admin/apps", payload)
        : client.put(`/api/admin/apps/${(app as App).id}`, payload);
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
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-bold">{isNew ? "Add app" : `Edit — ${(app as App).name}`}</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-gray-400" /></button>
        </div>

        <div className="overflow-y-auto p-6 space-y-5">

          {/* Type switcher */}
          <div>
            <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Type</p>
            <div className="grid grid-cols-3 gap-2">
              {(["web", "stream", "flatpak"] as const).map((t) => (
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
                    {t === "flatpak" && "📦 Flatpak"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-400">
                    {t === "web" && "Opens a URL in a browser container"}
                    {t === "stream" && "Streamed via KasmVNC — audio included"}
                    {t === "flatpak" && "Any Flathub app — no image build"}
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

          {/* Flatpak app fields */}
          {mode === "flatpak" && (
            <>
              {isNew && (
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Popular on Flathub</p>
                  <div className="grid grid-cols-4 gap-2">
                    {FLATPAK_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => applyFlatpakPreset(p)}
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
                  Flathub app ID<span className="ml-0.5 text-red-400">*</span>
                </label>
                <div className="flex gap-1.5">
                  <input
                    value={flatpakId}
                    onChange={(e) => { setFlatpakId(e.target.value); setSelectedPreset(null); }}
                    placeholder="e.g. org.videolan.VLC"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-800"
                  />
                  <button
                    type="button"
                    onClick={() => lookup.mutate(flatpakId.trim())}
                    disabled={!flatpakId.trim() || lookup.isPending}
                    className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    {lookup.isPending ? "Looking up…" : "Look up"}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-gray-400">
                  The exact app ID from flathub.org — fills in the name, description and icon below.
                </p>
                {lookupErr && <p className="mt-1 text-xs text-red-500">{lookupErr}</p>}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <AppField label="Name" {...f("name")} required />
                <AppField label="Category" {...f("category")} placeholder="Flatpak" />
              </div>
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

          {/* Advanced (stream / flatpak only) */}
          {(mode === "stream" || mode === "flatpak") && (
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
              (mode === "flatpak" && !flatpakId.trim()) ||
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
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">App Catalog</h1>
        <div className="flex items-center gap-2">
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
              const isFlatpak = a.container_image === FLATPAK_IMAGE;
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
                        : <span>{isFlatpak ? "📦" : a.app_type === "web" ? "🌐" : "🖥️"}</span>}
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
                    isFlatpak ? "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300" : (TYPE_COLORS[a.app_type] ?? TYPE_COLORS.stream)
                  )}>
                    {isFlatpak ? "Flatpak" : (TYPE_LABELS[a.app_type] ?? a.app_type)}
                  </span>
                  {!a.is_enabled && (
                    <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-400 dark:bg-gray-800">
                      disabled
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 max-w-[220px] font-mono text-xs text-gray-400">
                  <span className="block truncate">
                    {isFlatpak ? (a.env_json?.LWP_FLATPAK_APP_ID || FLATPAK_IMAGE) : (a.container_image || a.web_url || "—")}
                  </span>
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
