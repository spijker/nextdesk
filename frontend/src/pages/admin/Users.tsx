import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldCheck, UserCheck, UserX, KeyRound, UserPlus, X, LogOut, Power, Trash2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import type { User } from "@/types";
import { cn } from "@/lib/utils";

interface AdminUser extends User {
  is_active: boolean;
  auth_source: string;
}

// ── Create user modal ─────────────────────────────────────────────────────────

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ username: "", email: "", display_name: "", password: "", is_admin: false });
  const [err, setErr] = useState("");

  const create = useMutation({
    mutationFn: () => client.post("/api/admin/users", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("User created");
      onClose();
    },
    onError: (e: any) => setErr(e.response?.data?.detail ?? "Error"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Create local user</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-gray-400" /></button>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); setErr(""); create.mutate(); }}
          className="space-y-3"
        >
          {[
            { label: "Username", key: "username", type: "text" },
            { label: "Email", key: "email", type: "email" },
            { label: "Display name", key: "display_name", type: "text" },
            { label: "Password (min 8 chars)", key: "password", type: "password" },
          ].map(({ label, key, type }) => (
            <div key={key}>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</label>
              <input
                type={type}
                required={key !== "display_name"}
                value={(form as any)[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_admin}
              onChange={(e) => setForm((f) => ({ ...f, is_admin: e.target.checked }))}
            />
            Grant admin privileges
          </label>
          {err && <p className="text-sm text-red-500">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">Cancel</button>
            <button type="submit" disabled={create.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Set password modal ────────────────────────────────────────────────────────

function SetPasswordModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  const setPass = useMutation({
    mutationFn: () => client.post(`/api/admin/users/${user.id}/set-password`, { password }),
    onSuccess: () => { toast.success("Password updated"); onClose(); },
    onError: (e: any) => setErr(e.response?.data?.detail ?? "Error"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Set password — {user.username}</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-gray-400" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setErr(""); setPass.mutate(); }} className="space-y-3">
          <input
            type="password"
            required
            minLength={8}
            placeholder="New password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
          {err && <p className="text-sm text-red-500">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">Cancel</button>
            <button type="submit" disabled={setPass.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const SOURCE_BADGE: Record<string, string> = {
  oidc: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  local: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  ldap: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
};

export default function AdminUsers() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [setPassUser, setSetPassUser] = useState<AdminUser | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);

  const { data: users = [] } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: () => client.get("/api/admin/users").then((r) => r.data),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: object }) =>
      client.put(`/api/admin/users/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  const forceLogout = useMutation({
    mutationFn: (id: string) => client.post(`/api/admin/users/${id}/force-logout`),
    onSuccess: () => toast.success("User signed out of all browsers"),
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Failed"),
  });
  const stopSessions = useMutation({
    mutationFn: (id: string) => client.post(`/api/admin/users/${id}/stop-sessions`),
    onSuccess: (r: any) => toast.success(`Stopped ${r.data.stopped} desktop(s)`),
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Failed"),
  });
  const del = useMutation({
    mutationFn: (id: string) => client.delete(`/api/admin/users/${id}`),
    onSuccess: () => { toast.success("User deleted"); qc.invalidateQueries({ queryKey: ["admin", "users"] }); },
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Failed"),
  });
  const signOutAll = useMutation({
    mutationFn: () => client.post(`/api/admin/users/sign-out-all`),
    onSuccess: () => toast.success("All users signed out — you'll be redirected to login"),
    onError: (e: any) => toast.error(e.response?.data?.detail ?? "Failed"),
  });

  const filtered = users.filter(
    (u) =>
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.display_name.toLowerCase().includes(search.toLowerCase()) ||
      u.username.toLowerCase().includes(search.toLowerCase())
  );

  const toggleOne = (id: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allFilteredSelected = filtered.length > 0 && filtered.every((u) => selected.has(u.id));
  const toggleAll = () => setSelected(allFilteredSelected ? new Set() : new Set(filtered.map((u) => u.id)));

  const bulk = async (fn: (id: string) => Promise<any>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const ids = [...selected];
    setBulkPending(true);
    const results = await Promise.allSettled(ids.map(fn));
    setBulkPending(false);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      toast.error(`${ids.length - failed}/${ids.length} succeeded — ${failed} failed`);
    } else {
      toast.success(`Done for ${ids.length} user${ids.length === 1 ? "" : "s"}`);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Users</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (window.confirm("Sign ALL users out of every browser (including you)? Running desktops keep running.")) signOutAll.mutate(); }}
            className="flex items-center gap-2 rounded-xl border border-red-300 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:hover:bg-red-500/10"
            title="Revoke all browser sessions"
          >
            <ShieldAlert className="h-4 w-4" /> Sign everyone out
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <UserPlus className="h-4 w-4" /> Create local user
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users…"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-4 text-sm shadow-sm focus:border-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800"
          />
        </div>
        {selected.size > 0 && (
          <div className="flex flex-1 flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm dark:border-brand-500/30 dark:bg-brand-500/10">
            <span className="font-medium">{selected.size} selected</span>
            <button disabled={bulkPending} onClick={() => bulk((id) => client.put(`/api/admin/users/${id}`, { is_active: false }), `Disable ${selected.size} user(s)?`)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800">
              Disable
            </button>
            <button disabled={bulkPending} onClick={() => bulk((id) => client.put(`/api/admin/users/${id}`, { is_active: true }))}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800">
              Enable
            </button>
            <button disabled={bulkPending} onClick={() => bulk((id) => client.post(`/api/admin/users/${id}/force-logout`))}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800">
              Force logout
            </button>
            <button disabled={bulkPending} onClick={() => bulk((id) => client.post(`/api/admin/users/${id}/stop-sessions`), `Stop all running desktops for ${selected.size} user(s)?`)}
              className="rounded-lg border border-orange-300 px-2.5 py-1 text-xs text-orange-600 hover:bg-orange-50 disabled:opacity-50 dark:border-orange-500/40 dark:hover:bg-orange-500/10">
              Stop desktops
            </button>
            <button disabled={bulkPending} onClick={() => bulk((id) => client.delete(`/api/admin/users/${id}`), `Delete ${selected.size} user(s)? This stops their desktops and cannot be undone.`)}
              className="rounded-lg border border-red-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/40 dark:hover:bg-red-500/10">
              Delete
            </button>
            <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-gray-400 hover:text-gray-600">
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className="w-10 px-4 py-3">
                <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} className="h-4 w-4" />
              </th>
              {["Name", "Email", "Auth", "Status", "Admin", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {filtered.map((u) => (
              <tr key={u.id} className="bg-white dark:bg-gray-900">
                <td className="px-4 py-3">
                  <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} className="h-4 w-4" />
                </td>
                <td className="px-4 py-3 font-medium">{u.display_name || u.username}</td>
                <td className="px-4 py-3 text-gray-500">{u.email}</td>
                <td className="px-4 py-3">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", SOURCE_BADGE[u.auth_source] ?? "bg-gray-100 text-gray-600")}>
                    {u.auth_source}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium",
                    u.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  )}>
                    {u.is_active ? "Active" : "Disabled"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {u.is_admin && <ShieldCheck className="h-4 w-4 text-brand-500" />}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button
                      onClick={() => update.mutate({ id: u.id, patch: { is_admin: !u.is_admin } })}
                      className="rounded p-1 text-gray-400 hover:text-brand-500"
                      title={u.is_admin ? "Remove admin" : "Make admin"}
                    >
                      <ShieldCheck className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => update.mutate({ id: u.id, patch: { is_active: !u.is_active } })}
                      className="rounded p-1 text-gray-400 hover:text-red-500"
                      title={u.is_active ? "Disable user" : "Enable user"}
                    >
                      {u.is_active ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                    </button>
                    {u.auth_source === "local" && (
                      <button
                        onClick={() => setSetPassUser(u)}
                        className="rounded p-1 text-gray-400 hover:text-yellow-500"
                        title="Set password"
                      >
                        <KeyRound className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => forceLogout.mutate(u.id)}
                      className="rounded p-1 text-gray-400 hover:text-amber-500"
                      title="Force logout (kick from all browsers)"
                    >
                      <LogOut className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Stop all running desktops for ${u.username}?`)) stopSessions.mutate(u.id); }}
                      className="rounded p-1 text-gray-400 hover:text-orange-500"
                      title="Stop their desktops"
                    >
                      <Power className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Delete user ${u.username}? This stops their desktops and cannot be undone.`)) del.mutate(u.id); }}
                      className="rounded p-1 text-gray-400 hover:text-red-600"
                      title="Delete user"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} />}
      {setPassUser && <SetPasswordModal user={setPassUser} onClose={() => setSetPassUser(null)} />}
    </div>
  );
}
