import { useQuery } from "@tanstack/react-query";
import { Monitor, Users, LayoutGrid, Activity, HardDrive, Cpu, MemoryStick, Box } from "lucide-react";
import client from "@/api/client";
import type { AdminSession } from "@/types";
import { cn } from "@/lib/utils";

interface Stats {
  active_sessions: number;
  users_online: number;
  total_users: number;
  total_apps: number;
}

interface HostStats {
  available: boolean;
  cpu?: { cores: number; load1: number; load5: number; load15: number };
  mem?: { total_bytes: number; available_bytes: number; used_bytes: number };
  disk?: { total_bytes: number; used_bytes: number; free_bytes: number; images_bytes: number };
  containers?: { running: number; total: number };
}

function fmtBytes(n: number): string {
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`;
}

function MeterCard({
  icon: Icon, label, value, sub, pct, warn,
}: {
  icon: React.ElementType; label: string; value: string; sub: string; pct: number; warn?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center gap-2 text-gray-400">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className={cn("text-2xl font-bold", warn && "text-red-500")}>{value}</p>
      <p className="mb-2 text-xs text-gray-500">{sub}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        <div
          className={cn("h-full rounded-full", warn ? "bg-red-500" : "bg-indigo-500")}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { data: stats } = useQuery<Stats>({
    queryKey: ["admin", "stats"],
    queryFn: () => client.get("/api/admin/stats").then((r) => r.data),
    refetchInterval: 15_000,
  });

  const { data: host } = useQuery<HostStats>({
    queryKey: ["admin", "stats", "host"],
    queryFn: () => client.get("/api/admin/stats/host").then((r) => r.data),
    refetchInterval: 15_000,
  });

  const { data: sessions = [] } = useQuery<AdminSession[]>({
    queryKey: ["admin", "sessions"],
    queryFn: () => client.get("/api/admin/sessions").then((r) => r.data),
    refetchInterval: 15_000,
  });

  const statCards = [
    { label: "Active Sessions", value: stats?.active_sessions ?? "—", icon: Monitor, color: "text-blue-500 bg-blue-50 dark:bg-blue-900/20" },
    { label: "Users Online",    value: stats?.users_online ?? "—",    icon: Users,   color: "text-green-500 bg-green-50 dark:bg-green-900/20" },
    { label: "Total Users",     value: stats?.total_users ?? "—",     icon: Activity, color: "text-purple-500 bg-purple-50 dark:bg-purple-900/20" },
    { label: "Active Apps",      value: stats?.total_apps    ?? "—",    icon: LayoutGrid, color: "text-orange-500 bg-orange-50 dark:bg-orange-900/20" },
  ];

  const diskPct = host?.disk ? (host.disk.used_bytes / host.disk.total_bytes) * 100 : 0;
  const memPct = host?.mem ? (host.mem.used_bytes / host.mem.total_bytes) * 100 : 0;
  const loadPct = host?.cpu ? (host.cpu.load1 / host.cpu.cores) * 100 : 0;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Admin Dashboard</h1>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {statCards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <div className={`rounded-xl p-3 ${color}`}>
              <Icon className="h-6 w-6" />
            </div>
            <div>
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-sm text-gray-500">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {host?.available && (
        <>
          <h2 className="mb-3 text-lg font-semibold">Host</h2>
          <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MeterCard
              icon={HardDrive} label="Disk" pct={diskPct} warn={diskPct > 90}
              value={fmtBytes(host.disk!.free_bytes)}
              sub={`free of ${fmtBytes(host.disk!.total_bytes)} — images ${fmtBytes(host.disk!.images_bytes)}`}
            />
            <MeterCard
              icon={Cpu} label="CPU load" pct={loadPct} warn={loadPct > 90}
              value={host.cpu!.load1.toFixed(2)}
              sub={`${host.cpu!.cores}-core avg, ${host.cpu!.load5.toFixed(2)} / 5m`}
            />
            <MeterCard
              icon={MemoryStick} label="Memory" pct={memPct} warn={memPct > 90}
              value={fmtBytes(host.mem!.used_bytes)}
              sub={`of ${fmtBytes(host.mem!.total_bytes)} used`}
            />
            <MeterCard
              icon={Box} label="Containers" pct={(host.containers!.running / Math.max(1, host.containers!.total)) * 100}
              value={String(host.containers!.running)}
              sub={`running of ${host.containers!.total} total`}
            />
          </div>
        </>
      )}

      <h2 className="mb-3 text-lg font-semibold">Live Sessions</h2>
      <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              {["User", "Pod", "Status", "Started"].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {sessions.map((s) => (
              <tr key={s.id} className="bg-white dark:bg-gray-900">
                <td className="px-4 py-3 font-mono text-xs">{s.user_id.slice(0, 8)}…</td>
                <td className="px-4 py-3 font-mono text-xs">{s.pod_name}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.status === "running" ? "bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400" : "bg-yellow-100 text-yellow-700"}`}>
                    {s.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{new Date(s.started_at).toLocaleTimeString()}</td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No active sessions</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
