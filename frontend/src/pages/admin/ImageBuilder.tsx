import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Upload, Plus, Eye, EyeOff, ChevronDown, ChevronUp, X } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import { cn } from "@/lib/utils";

interface BuildJob {
  id: string;
  name: string;
  image_tag: string;
  registry_url: string | null;
  registry_username: string | null;
  has_registry_password: boolean;
  dockerfile: string;
  entrypoint: string | null;
  status: string;
  build_log: string;
  app_id: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending:    "bg-gray-400",
  building:   "bg-yellow-400 animate-pulse",
  success:    "bg-green-400",
  failed:     "bg-red-400",
  pushing:    "bg-blue-400 animate-pulse",
  pushed:     "bg-indigo-400",
  push_failed:"bg-red-400",
};

const DEFAULT_DOCKERFILE = `FROM lwp-kasm-base

RUN apt-get update && apt-get install -y --no-install-recommends \\
    your-app \\
    && rm -rf /var/lib/apt/lists/*

ENV LWP_START_APP="your-app --maximized"
`;

const DEFAULT_ENTRYPOINT = "";

// ── Build form ────────────────────────────────────────────────────────────────

function BuildForm({ onCreated }: { onCreated(job: BuildJob): void }) {
  const [name, setName] = useState("");
  const [tag, setTag] = useState("lwp-myapp:latest");
  const [dockerfile, setDockerfile] = useState(DEFAULT_DOCKERFILE);
  const [entrypoint, setEntrypoint] = useState(DEFAULT_ENTRYPOINT);
  const [showEntrypoint, setShowEntrypoint] = useState(false);
  const [regUrl, setRegUrl] = useState("");
  const [regUser, setRegUser] = useState("");
  const [regPass, setRegPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [showReg, setShowReg] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      client.post<BuildJob>("/api/admin/builds", {
        name,
        image_tag: tag,
        dockerfile,
        entrypoint: entrypoint || null,
        registry_url: regUrl || null,
        registry_username: regUser || null,
        registry_password: regPass || null,
      }),
    onSuccess: (res) => { onCreated(res.data); },
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Build failed to start"),
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-400">Image name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My App"
            className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-400">Image tag</label>
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="lwp-myapp:latest"
            className="w-full rounded-lg bg-gray-800 px-3 py-2 font-mono text-sm text-white outline-none ring-1 ring-white/10 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Dockerfile editor */}
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">Dockerfile</label>
        <textarea
          value={dockerfile}
          onChange={(e) => setDockerfile(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full rounded-lg bg-gray-950 px-3 py-2 font-mono text-xs text-green-300 outline-none ring-1 ring-white/10 focus:ring-indigo-500 resize-y"
        />
      </div>

      {/* Optional entrypoint.sh */}
      <div>
        <button
          type="button"
          onClick={() => setShowEntrypoint((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
        >
          {showEntrypoint ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Custom entrypoint.sh (optional — base image handles this for APP_CMD)
        </button>
        {showEntrypoint && (
          <textarea
            value={entrypoint}
            onChange={(e) => setEntrypoint(e.target.value)}
            rows={8}
            spellCheck={false}
            placeholder="#!/bin/bash&#10;set -e&#10;# custom startup logic here"
            className="mt-2 w-full rounded-lg bg-gray-950 px-3 py-2 font-mono text-xs text-green-300 outline-none ring-1 ring-white/10 focus:ring-indigo-500 resize-y"
          />
        )}
      </div>

      {/* Registry */}
      <div>
        <button
          type="button"
          onClick={() => setShowReg((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
        >
          {showReg ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Push to registry (optional)
        </button>
        {showReg && (
          <div className="mt-2 space-y-2 rounded-lg bg-gray-800/50 p-3">
            <input
              value={regUrl}
              onChange={(e) => setRegUrl(e.target.value)}
              placeholder="Registry URL (e.g. registry.example.com)"
              className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-indigo-500"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={regUser}
                onChange={(e) => setRegUser(e.target.value)}
                placeholder="Username"
                className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-indigo-500"
              />
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={regPass}
                  onChange={(e) => setRegPass(e.target.value)}
                  placeholder="Password / token"
                  className="w-full rounded-lg bg-gray-800 px-3 py-2 pr-9 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-2.5 top-2.5 text-gray-500 hover:text-gray-300"
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <button
        onClick={() => create.mutate()}
        disabled={!name || !tag || !dockerfile || create.isPending}
        className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        <Play className="h-4 w-4" />
        {create.isPending ? "Starting…" : "Build image"}
      </button>
    </div>
  );
}

// ── Build log viewer ──────────────────────────────────────────────────────────

function BuildLog({ job, onPublished }: { job: BuildJob; onPublished(): void }) {
  const [log, setLog] = useState(job.build_log || "");
  const [status, setStatus] = useState(job.status);
  const [publishing, setPublishing] = useState(false);
  const [appName, setAppName] = useState(job.name);
  const [appCat, setAppCat] = useState("General");
  const logRef = useRef<HTMLPreElement>(null);
  const qc = useQueryClient();

  // Stream SSE if build is live
  useEffect(() => {
    if (status === "success" || status === "failed" || status === "pushed") return;

    const es = new EventSource(`/api/admin/builds/${job.id}/stream`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.line) setLog((l) => l + data.line);
      if (data.status) setStatus(data.status);
      if (data.done) es.close();
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [job.id]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const push = async () => {
    await client.post(`/api/admin/builds/${job.id}/push`);
    toast.success("Push queued");
    setStatus("pushing");
    // Re-open stream for push logs
    const es = new EventSource(`/api/admin/builds/${job.id}/stream`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.line) setLog((l) => l + data.line);
      if (data.status) setStatus(data.status);
      if (data.done) es.close();
    };
    es.onerror = () => es.close();
  };

  const publish = async () => {
    setPublishing(true);
    try {
      await client.post(`/api/admin/builds/${job.id}/publish`, {
        name: appName, category: appCat,
      });
      qc.invalidateQueries({ queryKey: ["admin", "apps"] });
      qc.invalidateQueries({ queryKey: ["apps"] });
      toast.success("Added to app catalog");
      onPublished();
    } finally {
      setPublishing(false);
    }
  };

  const dot = STATUS_COLORS[status] ?? "bg-gray-400";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={cn("h-2.5 w-2.5 rounded-full", dot)} />
        <span className="text-sm font-medium text-white">{job.image_tag}</span>
        <span className="ml-auto text-xs text-gray-500">{status}</span>
      </div>

      <pre
        ref={logRef}
        className="h-64 overflow-y-auto rounded-lg bg-gray-950 p-3 font-mono text-xs text-green-300 whitespace-pre-wrap"
      >{log || "Starting build…"}</pre>

      {status === "success" && (
        <div className="space-y-2 rounded-lg bg-gray-800/50 p-3">
          <p className="text-xs font-medium text-gray-300">Add to app catalog</p>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder="Display name"
              className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-indigo-500"
            />
            <input
              value={appCat}
              onChange={(e) => setAppCat(e.target.value)}
              placeholder="Category"
              className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-indigo-500"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={publish}
              disabled={publishing}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-500 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {publishing ? "Adding…" : "Add to catalog"}
            </button>
            {job.has_registry_password && (
              <button
                onClick={push}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                <Upload className="h-3.5 w-3.5" />
                Push to registry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ImageBuilder() {
  const qc = useQueryClient();
  const [activeBuild, setActiveBuild] = useState<BuildJob | null>(null);
  const [showForm, setShowForm] = useState(true);

  const { data: builds = [] } = useQuery<BuildJob[]>({
    queryKey: ["admin", "builds"],
    queryFn: () => client.get("/api/admin/builds").then((r) => r.data),
    refetchInterval: 5_000,
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.delete(`/api/admin/builds/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "builds"] });
      if (activeBuild) setActiveBuild(null);
    },
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-white">Image Builder</h1>

      <div className="grid grid-cols-5 gap-4">
        {/* Left: build list */}
        <div className="col-span-2 space-y-2">
          <button
            onClick={() => { setShowForm(true); setActiveBuild(null); }}
            className="flex w-full items-center gap-2 rounded-xl border border-dashed border-white/10 p-3 text-sm text-gray-400 hover:border-indigo-500 hover:text-white transition-colors"
          >
            <Plus className="h-4 w-4" /> New build
          </button>

          {builds.map((b) => (
            <button
              key={b.id}
              onClick={() => { setActiveBuild(b); setShowForm(false); }}
              className={cn(
                "w-full rounded-xl border p-3 text-left transition-colors",
                activeBuild?.id === b.id
                  ? "border-indigo-500 bg-indigo-900/20"
                  : "border-white/10 hover:border-white/20"
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full shrink-0", STATUS_COLORS[b.status] ?? "bg-gray-400")} />
                <span className="truncate text-sm font-medium text-white">{b.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); remove.mutate(b.id); }}
                  className="ml-auto text-gray-600 hover:text-red-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-gray-500">{b.image_tag}</p>
              <p className="text-[11px] text-gray-600">
                {new Date(b.created_at).toLocaleDateString()}
              </p>
            </button>
          ))}
        </div>

        {/* Right: form or log */}
        <div className="col-span-3 rounded-xl bg-gray-800/40 p-4">
          {showForm || !activeBuild ? (
            <BuildForm
              onCreated={(job) => {
                qc.invalidateQueries({ queryKey: ["admin", "builds"] });
                setActiveBuild(job);
                setShowForm(false);
              }}
            />
          ) : (
            <BuildLog
              key={activeBuild.id}
              job={activeBuild}
              onPublished={() => qc.invalidateQueries({ queryKey: ["admin", "builds"] })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
