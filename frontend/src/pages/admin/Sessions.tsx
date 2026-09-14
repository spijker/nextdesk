import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Megaphone, MonitorOff, Send, Trash2, Video, ChevronDown, ChevronRight, Monitor } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import type { AdminSession } from "@/types";
import { formatDuration } from "@/lib/utils";

interface Recording {
  session_id: string;
  segments: number;
  size_bytes: number;
  last_modified: string;
  username?: string;
  app_name?: string;
  started_at?: string;
}

function fmtBytes(n: number) {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(n / 1024)} KiB`;
}

/** Live preview — best-effort, only present when the group's session-recording
 * policy is on and the window has been focused since it started. */
function SessionThumbnail({ sessionId }: { sessionId: string }) {
  const { data } = useQuery<{ data_url: string; updated_at: string | null }>({
    queryKey: ["admin", "session-thumbnail", sessionId],
    queryFn: () => client.get(`/api/admin/sessions/${sessionId}/thumbnail`).then((r) => r.data),
    retry: false,
    refetchInterval: 15_000,
  });
  if (!data?.data_url) {
    return (
      <div className="flex h-9 w-16 shrink-0 items-center justify-center rounded bg-gray-100 dark:bg-gray-800">
        <Monitor className="h-3.5 w-3.5 text-gray-300 dark:text-gray-600" />
      </div>
    );
  }
  return (
    <img
      src={data.data_url}
      alt=""
      title={data.updated_at ? `Captured ${new Date(data.updated_at).toLocaleTimeString()}` : undefined}
      className="h-9 w-16 shrink-0 rounded object-cover"
    />
  );
}

function Broadcast() {
  const [message, setMessage] = useState("");
  const [level, setLevel] = useState("info");
  const send = useMutation({
    mutationFn: () => client.post("/api/admin/settings/broadcast", { message, level }),
    onSuccess: () => { setMessage(""); toast.success("Broadcast sent to all active users"); },
    onError: () => toast.error("Broadcast failed"),
  });
  return (
    <div className="mb-6 flex items-center gap-2 rounded-2xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <Megaphone className="ml-1 h-4 w-4 shrink-0 text-gray-400" />
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && message.trim() && send.mutate()}
        placeholder="Message all active users… (e.g. maintenance in 10 minutes)"
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
      />
      <select
        value={level}
        onChange={(e) => setLevel(e.target.value)}
        className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800"
      >
        <option value="info">Info</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </select>
      <button
        onClick={() => send.mutate()}
        disabled={!message.trim() || send.isPending}
        className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <Send className="h-3.5 w-3.5" /> Send
      </button>
    </div>
  );
}

function Recordings() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const { data: recordings = [] } = useQuery<Recording[]>({
    queryKey: ["admin", "recordings"],
    queryFn: () => client.get("/api/admin/sessions/recordings").then((r) => r.data),
  });

  const { data: segments = [] } = useQuery<string[]>({
    queryKey: ["admin", "recordings", open, "segments"],
    queryFn: () => client.get(`/api/admin/sessions/recordings/${open}/segments`).then((r) => r.data),
    enabled: !!open,
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.delete(`/api/admin/sessions/recordings/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "recordings"] }),
  });

  if (recordings.length === 0) return null;

  return (
    <div className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Video className="h-5 w-5 text-gray-400" /> Session recordings
      </h2>
      <div className="space-y-2">
        {recordings.map((r) => (
          <div key={r.session_id} className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3 bg-white px-4 py-3 text-sm dark:bg-gray-900">
              <button
                className="flex items-center gap-2 font-medium"
                onClick={() => setOpen(open === r.session_id ? null : r.session_id)}
              >
                {open === r.session_id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {r.username ?? "unknown"} — {r.app_name ?? "app"}
              </button>
              <span className="text-xs text-gray-400">
                {r.started_at ? new Date(r.started_at).toLocaleString() : ""} · {r.segments} segment{r.segments === 1 ? "" : "s"} · {fmtBytes(r.size_bytes)}
              </span>
              <button
                onClick={() => { if (confirm("Delete this recording?")) remove.mutate(r.session_id); }}
                className="ml-auto rounded p-1 text-gray-400 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {open === r.session_id && (
              <div className="border-t border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  {segments.map((f) => (
                    <div key={f} className="rounded-lg bg-white p-2 dark:bg-gray-900">
                      <video
                        src={`/api/admin/sessions/recordings/${r.session_id}/segments/${f}`}
                        controls preload="metadata"
                        className="w-full rounded"
                      />
                      <div className="mt-1 flex items-center justify-between text-xs text-gray-400">
                        <span className="font-mono">{f}</span>
                        <a
                          href={`/api/admin/sessions/recordings/${r.session_id}/segments/${f}`}
                          download
                          className="text-brand-600 hover:underline"
                        >
                          download
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminSessions() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);

  const { data: sessions = [] } = useQuery<AdminSession[]>({
    queryKey: ["admin", "sessions"],
    queryFn: () => client.get("/api/admin/sessions").then((r) => r.data),
    refetchInterval: 10_000,
  });

  const kill = useMutation({
    mutationFn: (id: string) => client.delete(`/api/admin/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "sessions"] }),
  });

  const killSelected = async () => {
    if (!window.confirm(`Force-kill ${selected.size} session(s)?`)) return;
    const ids = [...selected];
    setBulkPending(true);
    const results = await Promise.allSettled(ids.map((id) => client.delete(`/api/admin/sessions/${id}`)));
    setBulkPending(false);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["admin", "sessions"] });
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      toast.error(`${ids.length - failed}/${ids.length} killed — ${failed} failed`);
    } else {
      toast.success(`Killed ${ids.length} session${ids.length === 1 ? "" : "s"}`);
    }
  };

  const bulkKill = useMutation({
    mutationFn: ({ status, user_id }: { status?: string; user_id?: string }) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (user_id) params.set("user_id", user_id);
      return client.delete(`/api/admin/sessions?${params}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "sessions"] }),
  });

  const startingSessions = sessions.filter((s) => s.status === "starting");
  const runningSessions = sessions.filter((s) => s.status === "running");

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Active Sessions</h1>

      <Broadcast />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <a
          href="/api/admin/sessions/export"
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <Download className="h-4 w-4" /> Export CSV
        </a>
        {startingSessions.length > 0 && (
          <button
            onClick={() => bulkKill.mutate({ status: "starting" })}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            <Trash2 className="h-4 w-4" /> Kill Stuck ({startingSessions.length})
          </button>
        )}
        {runningSessions.length > 0 && (
          <button
            onClick={() => bulkKill.mutate({ status: "running" })}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <MonitorOff className="h-4 w-4" /> Kill All Running ({runningSessions.length})
          </button>
        )}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm dark:border-red-800 dark:bg-red-950">
            <span className="font-medium text-red-700 dark:text-red-400">{selected.size} selected</span>
            <button
              disabled={bulkPending}
              onClick={killSelected}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              <MonitorOff className="h-3.5 w-3.5" /> Kill selected
            </button>
            <button onClick={() => setSelected(new Set())} className="text-xs text-gray-400 hover:text-gray-600">Clear</button>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={sessions.length > 0 && sessions.every((s) => selected.has(s.id))}
                  onChange={() => setSelected(
                    sessions.length > 0 && sessions.every((s) => selected.has(s.id))
                      ? new Set()
                      : new Set(sessions.map((s) => s.id))
                  )}
                  className="h-4 w-4"
                />
              </th>
              {["User", "Email", "Pod", "Preview", "App", "Type", "Status", "Duration", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {sessions.map((s) => (
              <tr key={s.id} className="bg-white dark:bg-gray-900">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => setSelected((cur) => {
                      const next = new Set(cur);
                      if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                      return next;
                    })}
                    className="h-4 w-4"
                  />
                </td>
                <td className="px-4 py-3 font-mono text-xs">{s.username ?? s.user_id.slice(0, 8)}</td>
                <td className="px-4 py-3 text-gray-500">{s.user_email ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs">{s.pod_name}</td>
                <td className="px-4 py-3">
                  <SessionThumbnail sessionId={s.id} />
                </td>
                <td className="px-4 py-3">{s.app_name ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.app_type === "stream" ? "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300" : "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"}`}>
                    {s.app_type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.status === "running" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                    {s.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{formatDuration(s.started_at)}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => { if (confirm("Force-kill this session?")) kill.mutate(s.id); }}
                    className="flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400"
                  >
                    <MonitorOff className="h-3 w-3" /> Kill
                  </button>
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-400">No active sessions</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Recordings />
    </div>
  );
}
