import { useMemo, useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Calendar, Bell, StickyNote, X, ExternalLink, Trash2, Plus, Check, ListChecks, Trello, MessagesSquare, Send, Search, UserRound, Key, Eye, EyeOff, Copy } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import { cn } from "@/lib/utils";

interface Ev { summary: string; start: string; all_day: boolean; calendar: string; color: string; href: string; uid: string }
interface Cal { name: string; color: string; href: string }
interface Notif { id: number; app: string; subject: string; message: string; at: string; link: string }
interface Note { id: number; title: string; category: string; modified: number; content: string }

interface Task { summary: string; completed: boolean; href: string; uid: string; list: string; color: string }
interface TaskList { name: string; color: string; href: string }
interface Board { id: number; title: string; color: string }
interface Stack { id: number; title: string; cards: { id: number; title: string; done: boolean }[] }

interface Room { token: string; name: string; unread: number; last: string; last_at: number }
interface Msg { id: number; actor: string; message: string; at: number; mine: boolean; system: boolean }
interface Contact { id: string; label: string }

// Passwords types
interface Password { id: number; label: string; username: string; url: string; folder_id: number | null; favicon: string; updated: number }
interface PasswordFolder { id: number; label: string; color: string }
interface PasswordDetail extends Password { password: string; notes: string; custom_fields: any[]; expire_time: string | null }

type Tab = "calendar" | "notifications" | "notes" | "tasks" | "deck" | "talk" | "passwords";

export function NextcloudHub({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("calendar");

  const notif = useQuery<Notif[]>({ queryKey: ["nc-notifications"], queryFn: () => client.get("/api/nextcloud/notifications").then(r => r.data), retry: false });
  const notes = useQuery<Note[]>({ queryKey: ["nc-notes"], queryFn: () => client.get("/api/nextcloud/notes").then(r => r.data), retry: false });

  const tabs: { id: Tab; icon: any; n?: number }[] = [
    { id: "calendar", icon: Calendar },
    { id: "tasks", icon: ListChecks },
    { id: "deck", icon: Trello },
    { id: "talk", icon: MessagesSquare },
    { id: "notes", icon: StickyNote },
    { id: "passwords", icon: Key },
    { id: "notifications", icon: Bell, n: notif.data?.length },
  ];

  return (
    <>
      <div className="fixed inset-0 z-[99998]" onClick={onClose} />
      <div className="fixed bottom-14 right-2 z-[99999] flex h-[480px] w-[350px] flex-col rounded-xl border border-white/10 bg-gray-900/95 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-1 border-b border-white/10 p-2">
          {tabs.map(({ id, icon: Icon, n }) => (
            <button key={id} onClick={() => setTab(id)} title={id}
              className={cn("relative flex flex-1 items-center justify-center rounded-lg py-1.5 transition-colors",
                tab === id ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/5 hover:text-white/80")}>
              <Icon className="h-4 w-4" />
              {!!n && <span className="absolute right-1 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] text-white">{n}</span>}
            </button>
          ))}
          <button onClick={onClose} className="rounded p-1 text-white/40 hover:text-white"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "calendar" && <CalendarTab qc={qc} />}
          {tab === "tasks" && <TasksTab qc={qc} />}
          {tab === "deck" && <DeckTab qc={qc} />}
          {tab === "talk" && <TalkTab qc={qc} />}
          {tab === "notifications" && <NotificationsTab q={notif} qc={qc} />}
          {tab === "notes" && <NotesTab q={notes} qc={qc} />}
          {tab === "passwords" && <PasswordsTab qc={qc} />}
        </div>
      </div>
    </>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-10 text-center text-xs text-white/30">{text}</p>;
}

// ── Calendar (month grid + create / delete) ─────────────────────────────────────
function ymd(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

function CalendarTab({ qc }: { qc: any }) {
  const today = new Date();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() }); // m: 0-11
  const [sel, setSel] = useState<string>(ymd(today));
  const [adding, setAdding] = useState(false);
  const monthParam = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}`;

  const q = useQuery<{ calendars: Cal[]; events: Ev[] }>({
    queryKey: ["nc-calendar", monthParam],
    queryFn: () => client.get(`/api/nextcloud/calendar?month=${monthParam}`).then((r) => r.data),
    retry: false,
  });
  const events = q.data?.events ?? [];
  const calendars = q.data?.calendars ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["nc-calendar"] });

  const byDay = useMemo(() => {
    const map = new Map<string, Ev[]>();
    events.forEach((e) => { const d = e.start.slice(0, 10); (map.get(d) ?? map.set(d, []).get(d)!).push(e); });
    return map;
  }, [events]);

  const del = useMutation({
    mutationFn: (href: string) => client.delete(`/api/nextcloud/calendar/event?href=${encodeURIComponent(href)}`),
    onSuccess: () => { invalidate(); toast.success("Event deleted"); },
    onError: () => toast.error("Delete failed"),
  });

  // Build the month grid (leading blanks from Monday).
  const first = new Date(cursor.y, cursor.m, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(new Date(cursor.y, cursor.m, d)));

  const move = (delta: number) => {
    const d = new Date(cursor.y, cursor.m + delta, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };
  const selEvents = byDay.get(sel) ?? [];
  const time = (e: Ev) => e.all_day ? "All day" : new Date(e.start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 p-2">
        <button onClick={() => move(-1)} className="rounded px-2 py-0.5 text-white/60 hover:bg-white/10">‹</button>
        <span className="text-sm font-medium text-white/90">{first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <button onClick={() => move(1)} className="rounded px-2 py-0.5 text-white/60 hover:bg-white/10">›</button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 px-2 pt-1 text-center text-[10px] text-white/30">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5 px-2 pb-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const evs = byDay.get(d) ?? [];
          const isToday = d === ymd(today);
          const isSel = d === sel;
          return (
            <button key={i} onClick={() => { setSel(d); setAdding(false); }}
              className={cn("relative flex h-9 flex-col items-center justify-center rounded text-xs",
                isSel ? "bg-indigo-600 text-white" : isToday ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5")}>
              {Number(d.slice(8))}
              {evs.length > 0 && (
                <span className="absolute bottom-1 flex gap-0.5">
                  {evs.slice(0, 3).map((e, j) => <span key={j} className="h-1 w-1 rounded-full" style={{ background: isSel ? "#fff" : e.color }} />)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/10 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
            {new Date(sel + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
          </span>
          {calendars.length > 0 && !adding && (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          )}
        </div>

        {adding && <AddEvent day={sel} calendars={calendars} onDone={() => { setAdding(false); invalidate(); }} onCancel={() => setAdding(false)} />}

        {selEvents.length === 0 && !adding
          ? <p className="py-4 text-center text-xs text-white/30">No events.</p>
          : <ul className="space-y-0.5">
              {selEvents.map((e, i) => (
                <li key={i} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-white/90">{e.summary}</div>
                    <div className="text-[11px] text-white/40">{time(e)} · {e.calendar}</div>
                  </div>
                  <button onClick={() => { if (confirm("Delete this event?")) del.mutate(e.href); }}
                    className="rounded p-1 text-white/25 opacity-0 hover:text-red-400 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>}
      </div>
    </div>
  );
}

function AddEvent({ day, calendars, onDone, onCancel }: { day: string; calendars: Cal[]; onDone(): void; onCancel(): void }) {
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("10:00");
  const [calHref, setCalHref] = useState(calendars[0]?.href ?? "");

  const create = useMutation({
    mutationFn: () => {
      const dd = day.replace(/-/g, "");
      const body = allDay
        ? { calendar_href: calHref, summary: title, all_day: true, start: dd, end: dd }
        : { calendar_href: calHref, summary: title, all_day: false,
            start: `${dd}T${from.replace(":", "")}00`, end: `${dd}T${to.replace(":", "")}00` };
      return client.post("/api/nextcloud/calendar/event", body);
    },
    onSuccess: () => { toast.success("Event created"); onDone(); },
    onError: () => toast.error("Create failed"),
  });

  const INP = "rounded bg-black/40 px-2 py-1 text-xs text-white/90 outline-none focus:ring-1 focus:ring-indigo-500";
  return (
    <div className="mb-2 space-y-2 rounded-lg bg-white/5 p-2">
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title" className={INP + " w-full"} />
      <label className="flex items-center gap-2 text-xs text-white/70">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-3.5 w-3.5 accent-indigo-600" /> All day
      </label>
      {!allDay && (
        <div className="flex items-center gap-1 text-xs text-white/60">
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={INP} /> →
          <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={INP} />
        </div>
      )}
      {calendars.length > 1 && (
        <select value={calHref} onChange={(e) => setCalHref(e.target.value)} className={INP + " w-full"}>
          {calendars.map((c) => <option key={c.href} value={c.href}>{c.name}</option>)}
        </select>
      )}
      <div className="flex gap-2">
        <button onClick={() => title.trim() && create.mutate()} disabled={create.isPending || !title.trim()}
          className="flex-1 rounded bg-indigo-600 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Create</button>
        <button onClick={onCancel} className="rounded border border-white/10 px-3 py-1 text-xs text-white/60 hover:text-white">Cancel</button>
      </div>
    </div>
  );
}

// ── Notifications (dismiss + clear all) ─────────────────────────────────────────
function NotificationsTab({ q, qc }: { q: any; qc: any }) {
  const items: Notif[] = q.data ?? [];
  const dismiss = useMutation({
    mutationFn: (id: number) => client.delete(`/api/nextcloud/notifications/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nc-notifications"] }),
  });
  const clearAll = useMutation({
    mutationFn: () => client.delete("/api/nextcloud/notifications"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nc-notifications"] }),
  });

  if (q.isError || items.length === 0) return <Empty text="No notifications." />;
  return (
    <div>
      <div className="flex justify-end border-b border-white/10 p-2">
        <button onClick={() => clearAll.mutate()} className="text-xs text-white/50 hover:text-white">Clear all</button>
      </div>
      <ul className="space-y-0.5 p-1.5">
        {items.map((n) => (
          <li key={n.id} className="group flex items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-white/5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-sm text-white/90">
                {n.link ? <a href={n.link} target="_blank" rel="noreferrer" className="truncate hover:underline">{n.subject}</a> : <span className="truncate">{n.subject}</span>}
                {n.link && <ExternalLink className="h-3 w-3 shrink-0 text-white/30" />}
              </div>
              {n.message && <div className="truncate text-xs text-white/50">{n.message}</div>}
              <div className="text-[11px] text-white/30">{n.app}{n.at ? ` · ${new Date(n.at).toLocaleString()}` : ""}</div>
            </div>
            <button onClick={() => dismiss.mutate(n.id)} title="Dismiss" className="rounded p-1 text-white/25 opacity-0 hover:text-white group-hover:opacity-100">
              <Check className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Notes (create / edit / delete) ──────────────────────────────────────────────
function NotesTab({ q, qc }: { q: any; qc: any }) {
  const items: Note[] = q.data ?? [];
  const [editing, setEditing] = useState<Note | "new" | null>(null);
  const [content, setContent] = useState("");

  const open = (n: Note | "new") => { setEditing(n); setContent(n === "new" ? "" : n.content); };
  const invalidate = () => qc.invalidateQueries({ queryKey: ["nc-notes"] });

  const save = useMutation({
    mutationFn: () => editing === "new"
      ? client.post("/api/nextcloud/notes", { content })
      : client.put(`/api/nextcloud/notes/${(editing as Note).id}`, { content }),
    onSuccess: () => { invalidate(); setEditing(null); toast.success("Note saved"); },
    onError: () => toast.error("Save failed — is the Notes app installed?"),
  });
  const del = useMutation({
    mutationFn: (id: number) => client.delete(`/api/nextcloud/notes/${id}`),
    onSuccess: () => { invalidate(); setEditing(null); toast.success("Note deleted"); },
  });

  if (editing !== null) {
    return (
      <div className="flex h-full flex-col p-2">
        <div className="mb-2 flex items-center gap-2">
          <button onClick={() => setEditing(null)} className="text-xs text-white/50 hover:text-white">← Back</button>
          <div className="flex-1" />
          {editing !== "new" && (
            <button onClick={() => { if (confirm("Delete this note?")) del.mutate((editing as Note).id); }}
              className="rounded p-1 text-white/40 hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
          )}
          <button onClick={() => save.mutate()} disabled={save.isPending || !content.trim()}
            className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Save</button>
        </div>
        <textarea autoFocus value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="Write your note… (first line becomes the title)"
          className="min-h-0 flex-1 resize-none rounded-lg bg-black/40 p-3 font-mono text-xs text-white/90 outline-none focus:ring-1 focus:ring-indigo-500" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end border-b border-white/10 p-2">
        <button onClick={() => open("new")} className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
          <Plus className="h-3.5 w-3.5" /> New note
        </button>
      </div>
      {q.isError || items.length === 0 ? (
        <Empty text="No notes yet. Create one, or install the Notes app in Nextcloud." />
      ) : (
        <ul className="space-y-0.5 p-1.5">
          {items.map((n) => (
            <li key={n.id}>
              <button onClick={() => open(n)} className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-white/5">
                <div className="truncate text-sm font-medium text-white/90">{n.title}</div>
                {n.content && <div className="line-clamp-2 whitespace-pre-wrap text-xs text-white/50">{n.content.split("\n").slice(1).join("\n").trim() || n.content}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Tasks (VTODO) ───────────────────────────────────────────────────────────────
function TasksTab({ qc }: { qc: any }) {
  const q = useQuery<{ lists: TaskList[]; tasks: Task[] }>({
    queryKey: ["nc-tasks"], queryFn: () => client.get("/api/nextcloud/tasks").then((r) => r.data), retry: false,
  });
  const lists = q.data?.lists ?? [];
  const tasks = q.data?.tasks ?? [];
  const [title, setTitle] = useState("");
  const [listHref, setListHref] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["nc-tasks"] });
  if (listHref === "" && lists[0]) setListHref(lists[0].href);

  const add = useMutation({
    mutationFn: () => client.post("/api/nextcloud/tasks", { list_href: listHref, summary: title }),
    onSuccess: () => { setTitle(""); invalidate(); },
    onError: () => toast.error("Add failed"),
  });
  const toggle = useMutation({
    mutationFn: (t: Task) => client.patch("/api/nextcloud/tasks", { href: t.href, uid: t.uid, summary: t.summary, completed: !t.completed }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: (href: string) => client.delete(`/api/nextcloud/tasks?href=${encodeURIComponent(href)}`),
    onSuccess: invalidate,
  });

  if (q.isError) return <Empty text="Tasks not available (install the Tasks app in Nextcloud)." />;
  return (
    <div className="flex h-full flex-col">
      {lists.length > 0 && (
        <div className="flex gap-1 border-b border-white/10 p-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && add.mutate()}
            placeholder="Add a task…" className="flex-1 rounded bg-black/40 px-2 py-1 text-xs text-white/90 outline-none focus:ring-1 focus:ring-indigo-500" />
          {lists.length > 1 && (
            <select value={listHref} onChange={(e) => setListHref(e.target.value)} className="rounded bg-black/40 px-1 text-xs text-white/70">
              {lists.map((l) => <option key={l.href} value={l.href}>{l.name}</option>)}
            </select>
          )}
          <button onClick={() => title.trim() && add.mutate()} className="rounded bg-indigo-600 px-2 text-xs text-white hover:bg-indigo-500"><Plus className="h-3.5 w-3.5" /></button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tasks.length === 0 ? <Empty text="No tasks." /> : (
          <ul className="space-y-0.5">
            {tasks.map((t) => (
              <li key={t.href} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
                <input type="checkbox" checked={t.completed} onChange={() => toggle.mutate(t)} className="h-4 w-4 accent-indigo-600" />
                <span className={cn("min-w-0 flex-1 truncate text-sm", t.completed ? "text-white/35 line-through" : "text-white/90")}>{t.summary}</span>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.color }} />
                <button onClick={() => del.mutate(t.href)} className="rounded p-1 text-white/25 opacity-0 hover:text-red-400 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Deck (kanban) ────────────────────────────────────────────────────────────────
function DeckTab({ qc }: { qc: any }) {
  const boards = useQuery<Board[]>({ queryKey: ["nc-deck"], queryFn: () => client.get("/api/nextcloud/deck").then((r) => r.data), retry: false });
  const [boardId, setBoardId] = useState<number | null>(null);
  const bid = boardId ?? boards.data?.[0]?.id ?? null;
  const stacks = useQuery<Stack[]>({
    queryKey: ["nc-deck", bid], queryFn: () => client.get(`/api/nextcloud/deck/${bid}`).then((r) => r.data),
    enabled: bid != null, retry: false,
  });
  const [adding, setAdding] = useState<number | null>(null); // stack id
  const [title, setTitle] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["nc-deck"] });

  const addCard = useMutation({
    mutationFn: (stackId: number) => client.post("/api/nextcloud/deck/card", { board_id: bid, stack_id: stackId, title }),
    onSuccess: () => { setTitle(""); setAdding(null); invalidate(); },
    onError: () => toast.error("Add failed"),
  });
  const archive = useMutation({
    mutationFn: (v: { stack_id: number; card_id: number }) => client.post("/api/nextcloud/deck/card/archive", { board_id: bid, ...v }),
    onSuccess: () => { invalidate(); toast.success("Card archived"); },
  });

  if (boards.isError || (boards.data && boards.data.length === 0)) return <Empty text="No Deck boards (install the Deck app in Nextcloud)." />;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/10 p-2">
        <select value={bid ?? ""} onChange={(e) => setBoardId(Number(e.target.value))}
          className="w-full rounded bg-black/40 px-2 py-1 text-xs text-white/90">
          {(boards.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {(stacks.data ?? []).map((s) => (
          <div key={s.id} className="mb-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">{s.title} · {s.cards.length}</span>
              <button onClick={() => { setAdding(s.id); setTitle(""); }} className="text-indigo-400 hover:text-indigo-300"><Plus className="h-3.5 w-3.5" /></button>
            </div>
            {adding === s.id && (
              <div className="mb-1 flex gap-1">
                <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && addCard.mutate(s.id)}
                  placeholder="Card title…" className="flex-1 rounded bg-black/40 px-2 py-1 text-xs text-white/90 outline-none focus:ring-1 focus:ring-indigo-500" />
                <button onClick={() => title.trim() && addCard.mutate(s.id)} className="rounded bg-indigo-600 px-2 text-xs text-white">Add</button>
              </div>
            )}
            <ul className="space-y-1">
              {s.cards.map((c) => (
                <li key={c.id} className="group flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-white/90">{c.title}</span>
                  <button onClick={() => archive.mutate({ stack_id: s.id, card_id: c.id })} title="Archive" className="rounded p-0.5 text-white/25 opacity-0 hover:text-green-400 group-hover:opacity-100"><Check className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {stacks.data && stacks.data.length === 0 && <Empty text="This board has no lists." />}
      </div>
    </div>
  );
}

// ── Talk (chat) ─────────────────────────────────────────────────────────────────
function TalkTab({ qc }: { qc: any }) {
  const [active, setActive] = useState<Room | null>(null);
  const [searching, setSearching] = useState(false);
  const rooms = useQuery<Room[]>({ queryKey: ["nc-talk"], queryFn: () => client.get("/api/nextcloud/talk").then((r) => r.data), retry: false, refetchInterval: 15_000 });

  const start = useMutation({
    mutationFn: (userId: string) => client.post("/api/nextcloud/talk/contacts/start", { user_id: userId }).then((r) => r.data as Room),
    onSuccess: (room) => { setSearching(false); setActive(room); qc.invalidateQueries({ queryKey: ["nc-talk"] }); },
    onError: () => toast.error("Could not start chat"),
  });
  
  const list = rooms.data ?? [];
  const del = useMutation({
    mutationFn: (token: string) => client.delete(`/api/nextcloud/talk/${token}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["nc-talk"] }); toast.success("Chat deleted"); },
    onError: () => toast.error("Delete failed"),
  });

  if (active) return <TalkRoom room={active} onBack={() => { setActive(null); qc.invalidateQueries({ queryKey: ["nc-talk"] }); }} />;
  if (searching) return <ContactSearch onPick={(id) => start.mutate(id)} onCancel={() => setSearching(false)} pending={start.isPending} />;
  
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 p-2">
        <span className="text-sm font-medium text-white/90">Conversations</span>
        <button onClick={() => setSearching(true)} className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
          <Plus className="h-3.5 w-3.5" /> New chat
        </button>
      </div>
      {rooms.isError || list.length === 0 ? (
        <Empty text="No conversations yet. Start one, or install Talk in Nextcloud." />
      ) : (
        <ul className="space-y-0.5 p-1.5">
          {list.map((r) => (
            <li key={r.token} className="group">
              <div className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                <button onClick={() => setActive(r)} className="flex w-full items-center gap-2 text-left hover:bg-white/5">
                  <MessagesSquare className="h-4 w-4 shrink-0 text-white/40" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-white/90">{r.name}</div>
                    {r.last && <div className="truncate text-xs text-white/40">{r.last}</div>}
                  </div>
                  {r.unread > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] text-white">{r.unread}</span>}
                </button>
                <button onClick={() => { if (confirm("Delete this chat?")) del.mutate(r.token); }}
                  className="rounded p-1 text-white/25 opacity-0 hover:text-red-400 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Passwords ─────────────────────────────────────────────────────────────────
function PasswordsTab({ qc }: { qc: any }) {
  const passwords = useQuery<Password[]>({ queryKey: ["nc-passwords"], queryFn: () => client.get("/api/nextcloud/passwords").then((r) => r.data), retry: false });
  const folders = useQuery<PasswordFolder[]>({ queryKey: ["nc-passwords-folders"], queryFn: () => client.get("/api/nextcloud/passwords/folders").then((r) => r.data), retry: false });
  const [selected, setSelected] = useState<PasswordDetail | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["nc-passwords"] }); qc.invalidateQueries({ queryKey: ["nc-passwords-folders"] }); };

  const del = useMutation({
    mutationFn: (id: number) => client.delete(`/api/nextcloud/passwords/${id}`),
    onSuccess: () => { setSelected(null); invalidate(); toast.success("Password deleted"); },
    onError: () => toast.error("Delete failed"),
  });

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`Copied ${label} to clipboard`);
  };

  if (passwords.isError) return <Empty text="Passwords not available (install the Passwords app in Nextcloud)." />;
  
  if (selected) {
    return (
      <div className="flex h-full flex-col p-2">
        <div className="mb-2 flex items-center gap-2">
          <button onClick={() => setSelected(null)} className="text-xs text-white/50 hover:text-white">← Back</button>
          <div className="flex-1" />
          <button onClick={() => { if (confirm("Delete this password?")) del.mutate(selected.id); }}
            className="rounded p-1 text-white/40 hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-white/40">Label</label>
            <div className="text-sm text-white/90">{selected.label}</div>
          </div>
          {selected.username && (
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wide text-white/40">Username</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-white/90">{selected.username}</span>
                <button onClick={() => copyToClipboard(selected.username, "username")} className="rounded p-1 text-white/40 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          )}
          {selected.password && (
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wide text-white/40">Password</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-white/90">{showPassword ? selected.password : "••••••••"}</span>
                <button onClick={() => setShowPassword(!showPassword)} className="rounded p-1 text-white/40 hover:text-white">
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => copyToClipboard(selected.password, "password")} className="rounded p-1 text-white/40 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          )}
          {selected.url && (
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wide text-white/40">URL</label>
              <div className="flex items-center gap-2">
                <a href={selected.url} target="_blank" rel="noreferrer" className="text-sm text-indigo-400 hover:underline">{selected.url}</a>
                <button onClick={() => copyToClipboard(selected.url, "URL")} className="rounded p-1 text-white/40 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          )}
          {selected.notes && (
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wide text-white/40">Notes</label>
              <div className="text-sm text-white/70 whitespace-pre-wrap">{selected.notes}</div>
            </div>
          )}
          {selected.expire_time && (
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wide text-white/40">Expires</label>
              <div className="text-sm text-white/70">{selected.expire_time}</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const items = passwords.data ?? [];
  const folderMap = useMemo(() => {
    const map = new Map<number, string>();
    (folders.data ?? []).forEach(f => map.set(f.id, f.label));
    return map;
  }, [folders.data]);

  return (
    <div>
      <div className="flex justify-end border-b border-white/10 p-2">
        <button onClick={() => toast.info("Password generator coming soon!")} className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
          <Plus className="h-3.5 w-3.5" /> New password
        </button>
      </div>
      {items.length === 0 ? (
        <Empty text="No passwords yet. Add one in Nextcloud, or install the Passwords app." />
      ) : (
        <ul className="space-y-0.5 p-1.5">
          {items.map((p) => (
            <li key={p.id}>
              <button onClick={async () => {
                const detail = await client.get(`/api/nextcloud/passwords/${p.id}`).then(r => r.data);
                setSelected(detail);
              }} className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-white/5">
                <div className="flex items-center gap-2">
                  {p.favicon ? <img src={p.favicon} alt="" className="h-4 w-4 rounded" /> : <Key className="h-4 w-4 text-white/40" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white/90">{p.label}</div>
                    {p.username && <div className="truncate text-xs text-white/50">{p.username}</div>}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Talk contact search (new 1:1 chat) ──────────────────────────────────────────
function ContactSearch({ onPick, onCancel, pending }: { onPick(userId: string): void; onCancel(): void; pending: boolean }) {
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  const q = useQuery<Contact[]>({
    queryKey: ["nc-talk-contacts", debounced],
    queryFn: () => client.get(`/api/nextcloud/talk/contacts/search?q=${encodeURIComponent(debounced)}`).then((r) => r.data),
    enabled: debounced.trim().length >= 2,
    retry: false,
  });
  const results = q.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 p-2">
        <button onClick={onCancel} className="text-xs text-white/50 hover:text-white">← Back</button>
      </div>
      <div className="flex items-center gap-2 border-b border-white/10 p-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-white/40" />
        <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search people…"
          className="w-full flex-1 bg-transparent text-sm text-white/90 outline-none placeholder:text-white/30" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {debounced.trim().length < 2 ? (
          <Empty text="Type at least 2 characters to search." />
        ) : results.length === 0 ? (
          <Empty text={q.isFetching ? "Searching…" : "No matches."} />
        ) : (
          <ul className="space-y-0.5">
            {results.map((c) => (
              <li key={c.id}>
                <button disabled={pending} onClick={() => onPick(c.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-white/5 disabled:opacity-40">
                  <UserRound className="h-4 w-4 shrink-0 text-white/40" />
                  <span className="min-w-0 flex-1 truncate text-sm text-white/90">{c.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TalkRoom({ room, onBack }: { room: Room; onBack(): void }) {
  const [text, setText] = useState("");
  const msgs = useQuery<Msg[]>({
    queryKey: ["nc-talk", room.token], queryFn: () => client.get(`/api/nextcloud/talk/${room.token}`).then((r) => r.data),
    retry: false, refetchInterval: 5_000,
  });
  const send = useMutation({
    mutationFn: () => client.post(`/api/nextcloud/talk/${room.token}`, { message: text }),
    onSuccess: () => { setText(""); msgs.refetch(); },
    onError: () => toast.error("Send failed"),
  });
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [msgs.data?.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 p-2">
        <button onClick={onBack} className="text-xs text-white/50 hover:text-white">←</button>
        <span className="truncate text-sm font-medium text-white/90">{room.name}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {(msgs.data ?? []).filter((m) => !m.system).map((m) => (
          <div key={m.id} className={cn("flex flex-col", m.mine ? "items-end" : "items-start")}>
            <div className={cn("max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm", m.mine ? "bg-indigo-600 text-white" : "bg-white/10 text-white/90")}>
              {!m.mine && <div className="text-[10px] font-semibold text-white/50">{m.actor}</div>}
              <div className="whitespace-pre-wrap break-words">{m.message}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-1 border-t border-white/10 p-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && send.mutate()}
          placeholder="Message…" className="flex-1 rounded bg-black/40 px-2.5 py-1.5 text-sm text-white/90 outline-none focus:ring-1 focus:ring-indigo-500" />
        <button onClick={() => text.trim() && send.mutate()} disabled={send.isPending || !text.trim()}
          className="rounded bg-indigo-600 px-3 text-white hover:bg-indigo-500 disabled:opacity-40"><Send className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
