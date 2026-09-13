import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ChevronDown, ChevronRight, UserMinus } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";

interface Group {
  id: string; name: string; description: string;
  max_sessions: number | null; cpu_limit: string | null; mem_limit: string | null;
  policies: Record<string, boolean>;
}
interface Member { id: string; email: string; display_name: string }

const POLICY_FLAGS: { key: string; label: string; hint: string }[] = [
  { key: "record_sessions", label: "Record sessions", hint: "Capture desktop video of every session (compliance)" },
  { key: "disable_download", label: "Block downloads", hint: "No file downloads out of the workspace" },
  { key: "disable_upload", label: "Block uploads", hint: "No file uploads into the workspace" },
  { key: "disable_clipboard", label: "Block clipboard", hint: "Disable the clipboard bridge" },
  { key: "force_simple_layout", label: "Force simple layout", hint: "No taskbar/launcher — just Files and app tiles. Overrides the user's own layout choice." },
];

function GroupPolicies({ group }: { group: Group }) {
  const qc = useQueryClient();
  const [pol, setPol] = useState<Record<string, boolean>>(group.policies ?? {});
  const save = useMutation({
    mutationFn: (next: Record<string, boolean>) => client.put(`/api/admin/groups/${group.id}`, {
      name: group.name, description: group.description,
      max_sessions: group.max_sessions, cpu_limit: group.cpu_limit, mem_limit: group.mem_limit,
      policies: next,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "groups"] }); toast.success("Policy saved"); },
    onError: () => toast.error("Save failed"),
  });
  const toggle = (key: string) => {
    const next = { ...pol, [key]: !pol[key] };
    setPol(next);
    save.mutate(next);
  };
  return (
    <div className="mb-4 grid grid-cols-2 gap-2">
      {POLICY_FLAGS.map((f) => (
        <label key={f.key} title={f.hint}
          className="flex cursor-pointer items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm dark:bg-gray-900">
          <input type="checkbox" checked={!!pol[f.key]} onChange={() => toggle(f.key)}
            className="h-4 w-4 accent-brand-600" />
          {f.label}
        </label>
      ))}
    </div>
  );
}

function GroupQuota({ group }: { group: Group }) {
  const qc = useQueryClient();
  const [maxS, setMaxS] = useState(group.max_sessions?.toString() ?? "");
  const [cpu, setCpu] = useState(group.cpu_limit ?? "");
  const [mem, setMem] = useState(group.mem_limit ?? "");
  const save = useMutation({
    mutationFn: () => client.put(`/api/admin/groups/${group.id}`, {
      name: group.name, description: group.description,
      max_sessions: maxS.trim() ? parseInt(maxS, 10) : null,
      cpu_limit: cpu.trim() || null, mem_limit: mem.trim() || null,
      policies: group.policies ?? {},
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "groups"] }); toast.success("Quota saved"); },
    onError: () => toast.error("Save failed"),
  });
  const inp = "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900";
  return (
    <div className="mb-4 grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
      <div>
        <label className="mb-1 block text-[11px] text-gray-400">Max sessions</label>
        <input type="number" min={1} value={maxS} onChange={(e) => setMaxS(e.target.value)} placeholder="—" className={inp} />
      </div>
      <div>
        <label className="mb-1 block text-[11px] text-gray-400">CPU ceiling</label>
        <input value={cpu} onChange={(e) => setCpu(e.target.value)} placeholder="e.g. 2000m" className={inp} />
      </div>
      <div>
        <label className="mb-1 block text-[11px] text-gray-400">Mem ceiling</label>
        <input value={mem} onChange={(e) => setMem(e.target.value)} placeholder="e.g. 2Gi" className={inp} />
      </div>
      <button onClick={() => save.mutate()} disabled={save.isPending}
        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
        Save
      </button>
    </div>
  );
}

export default function AdminGroups() {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: groups = [] } = useQuery<Group[]>({
    queryKey: ["admin", "groups"],
    queryFn: () => client.get("/api/admin/groups").then((r) => r.data),
  });

  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ["admin", "groups", expanded, "members"],
    queryFn: () => client.get(`/api/admin/groups/${expanded}/members`).then((r) => r.data),
    enabled: !!expanded,
  });

  const create = useMutation({
    mutationFn: () => client.post("/api/admin/groups", { name: newName }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "groups"] }); setNewName(""); toast.success("Group created"); },
    onError: () => toast.error("Failed to create group"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.delete(`/api/admin/groups/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "groups"] }); toast.success("Group deleted"); },
  });

  const removeMember = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      client.delete(`/api/admin/groups/${groupId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "groups", expanded, "members"] }),
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Groups</h1>

      {/* Create */}
      <div className="mb-6 flex gap-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newName.trim() && create.mutate()}
          placeholder="New group name…"
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800"
        />
        <button
          disabled={!newName.trim()}
          onClick={() => create.mutate()}
          className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> Create
        </button>
      </div>

      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.id} className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between bg-white px-4 py-3 dark:bg-gray-900">
              <button
                className="flex items-center gap-2 font-medium"
                onClick={() => setExpanded(expanded === g.id ? null : g.id)}
              >
                {expanded === g.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {g.name}
              </button>
              <button
                onClick={() => { if (confirm(`Delete group "${g.name}"?`)) remove.mutate(g.id); }}
                className="rounded p-1 text-gray-400 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {expanded === g.id && (
              <div className="border-t border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Quota (blank = no group limit; most generous group wins)</p>
                <GroupQuota group={g} />
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Security policies (any group setting a flag applies it to its members)</p>
                <GroupPolicies group={g} />
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Members</p>
                {members.length === 0 ? (
                  <p className="text-sm text-gray-400">No members. Members are added automatically via OIDC group claims on login.</p>
                ) : (
                  <div className="space-y-2">
                    {members.map((m) => (
                      <div key={m.id} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm dark:bg-gray-900">
                        <span>{m.display_name} <span className="text-gray-400">({m.email})</span></span>
                        <button
                          onClick={() => removeMember.mutate({ groupId: g.id, userId: m.id })}
                          className="rounded p-1 text-gray-400 hover:text-red-500"
                        >
                          <UserMinus className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
