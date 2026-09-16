import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AppWindow as WindowIcon, Search, Settings2 } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import type { App, Session } from "@/types";
import { useAuthStore } from "@/store/auth";
import { useDesktopStore } from "@/store/desktop";
import { cn } from "@/lib/utils";
import { appIconUrl } from "@/lib/appIcon";

interface Command {
  id: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
  keywords?: string;
  run(): void;
}

/**
 * Ctrl/Cmd+K command palette: launch apps, jump to open windows, open panels.
 */
export function CommandPalette({ apps, onClose }: { apps: App[]; onClose(): void }) {
  const { user } = useAuthStore();
  const {
    windows, focusWindow, openWindow,
    setLauncherOpen, setAdminOpen, setStorageOpen, setProfileOpen,
    setFileManagerOpen, setLaunching, setTheme, theme,
    workspaces, switchWorkspace,
  } = useDesktopStore();

  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const launch = useMutation({
    mutationFn: (app: App) =>
      client.post<Session>("/api/sessions", { app_id: app.id }).then((r) => ({ session: r.data, app })),
    onSuccess: ({ session, app }) => {
      setLaunching(null);
      openWindow(session, app);
    },
    onError: (e: any) => {
      setLaunching(null);
      toast.error(e?.response?.data?.detail ?? "Launch failed");
    },
  });

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    // Open windows first — switching beats launching
    for (const w of windows) {
      cmds.push({
        id: `win-${w.windowId}`,
        title: w.appName,
        hint: "Switch to window",
        icon: w.appIcon
          ? <img src={w.appIcon} alt="" className="h-4 w-4 object-contain" />
          : <WindowIcon className="h-4 w-4" />,
        run: () => focusWindow(w.windowId),
      });
    }

    for (const app of apps) {
      cmds.push({
        id: `app-${app.id}`,
        title: app.name,
        hint: "Launch app",
        keywords: app.category,
        icon: <img src={appIconUrl(app)} alt="" className="h-4 w-4 object-contain" />,
        run: () => {
          setLaunching({ appId: app.id, appName: app.name, appIcon: appIconUrl(app) });
          launch.mutate(app);
        },
      });
    }

    const gear = <Settings2 className="h-4 w-4" />;
    cmds.push(
      { id: "act-files", title: "File manager", hint: "Open panel", keywords: "files nextcloud storage browse", icon: gear, run: () => setFileManagerOpen(true) },
      { id: "act-launcher", title: "App launcher", hint: "Open panel", keywords: "apps menu start", icon: gear, run: () => setLauncherOpen(true) },
      { id: "act-storage", title: "Storage settings", hint: "Open panel", keywords: "nextcloud connect webdav", icon: gear, run: () => setStorageOpen(true) },
      { id: "act-profile", title: "Profile", hint: "Open panel", keywords: "account password totp", icon: gear, run: () => setProfileOpen(true) },
      { id: "act-theme", title: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", hint: "Appearance", keywords: "theme dark light mode", icon: gear, run: () => setTheme(theme === "dark" ? "light" : "dark") },
    );
    if (user?.is_admin) {
      cmds.push({ id: "act-admin", title: "Admin panel", hint: "Open panel", keywords: "users groups sessions settings", icon: gear, run: () => setAdminOpen(true) });
    }
    for (const ws of workspaces) {
      cmds.push({ id: `ws-${ws}`, title: `Workspace ${ws}`, hint: "Switch workspace", keywords: "desktop space", icon: gear, run: () => switchWorkspace(ws) });
    }
    return cmds;
  }, [windows, apps, user?.is_admin, theme, workspaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 12);
    return commands
      .filter((c) => (c.title + " " + (c.keywords ?? "") + " " + c.hint).toLowerCase().includes(q))
      .slice(0, 12);
  }, [commands, query]);

  useEffect(() => { setIdx(0); }, [query]);

  const exec = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); exec(filtered[idx]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    e.stopPropagation();
  };

  // Keep the active row in view
  useEffect(() => {
    listRef.current?.children[idx]?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  return (
    <div
      className="fixed inset-0 z-[9000] flex items-start justify-center bg-black/40 pt-[18vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#16162a]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-3 dark:border-white/[0.06]">
          <Search className="h-4 w-4 text-gray-400 dark:text-white/40" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Launch app, switch window, open panel…"
            className="flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-white dark:placeholder:text-white/30"
          />
          <kbd className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-400 dark:border-white/10 dark:text-white/30">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[340px] overflow-y-auto py-1.5">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              onClick={() => exec(c)}
              onMouseEnter={() => setIdx(i)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                i === idx
                  ? "bg-indigo-50 text-gray-900 dark:bg-indigo-600/20 dark:text-white"
                  : "text-gray-700 dark:text-white/70",
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center text-gray-400 dark:text-white/50">{c.icon}</span>
              <span className="flex-1 truncate">{c.title}</span>
              <span className="text-xs text-gray-400 dark:text-white/30">{c.hint}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-gray-400 dark:text-white/30">No matches</p>
          )}
        </div>
      </div>
    </div>
  );
}
