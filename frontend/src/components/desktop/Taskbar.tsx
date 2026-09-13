import { useEffect, useState, useCallback, useRef } from "react";
import { LayoutGrid, Maximize, Minimize, LogOut, Layers, ClipboardCheck, ShieldCheck, LockKeyhole, Square } from "lucide-react";
import { ClipboardManager } from "./ClipboardManager";
import { NextcloudHub } from "./NextcloudHub";
import { NcAvatar } from "./NcAvatar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDesktopStore } from "@/store/desktop";
import { useAuthStore } from "@/store/auth";
import { getSnapshot } from "@/lib/sessionFrames";
import { ContextMenu } from "./ContextMenu";
import { cn } from "@/lib/utils";
import client from "@/api/client";
import type { App } from "@/types";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return (
    <div className="flex flex-col items-end leading-none cursor-default select-none" title={date}>
      <span className="text-xs text-white/80 tabular-nums">{time}</span>
      <span className="text-[10px] text-white/40 tabular-nums mt-0.5">{date}</span>
    </div>
  );
}

export function FullscreenButton() {
  const [full, setFull] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const h = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  const toggle = useCallback(() => {
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
  }, []);
  return (
    <button
      onClick={toggle}
      title={full ? "Exit fullscreen" : "Fullscreen"}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white transition-colors"
    >
      {full ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
    </button>
  );
}

// ── Logout dialog ─────────────────────────────────────────────────────────────

// Shown once, the first time the user's VPN tunnel comes up (then via
// right-click on the tray shield). Explains the per-window shield + env vars.
function VpnHelpDialog({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[99998] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[420px] max-w-[92vw] rounded-2xl border border-white/10 bg-gray-900/95 p-5 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">VPN connected — how routing works</h2>
        </div>
        <ul className="space-y-2.5 text-xs text-white/70">
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
            <span>Every app window you open from now on gets a <b className="text-white/90">shield button</b> in its titlebar.
            Grey = that app's traffic goes <b className="text-white/90">directly</b> to the internet (default).
            Green = it goes <b className="text-emerald-300">through the VPN tunnel</b>.</span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
            <span>Click the shield any time — the switch takes effect within a few seconds.
            Open connections in that window are cut on purpose so the app reconnects the new way.</span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
            <span>Apps that were <b className="text-white/90">already open</b> before the VPN started have no shield — relaunch them.</span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
            <span>Per-app defaults live in <b className="text-white/90">Profile → App VPN defaults</b>: start an app
            tunneled (<code className="rounded bg-white/10 px-1">LWP_VPN_DEFAULT=on</code>), direct, or keep proxy settings away
            from it entirely (<code className="rounded bg-white/10 px-1">LWP_VPN_EXEMPT=1</code>).</span>
          </li>
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
            <span>Manual proxy config inside an app: SOCKS5 host <code className="rounded bg-white/10 px-1">127.0.0.1</code> port <code className="rounded bg-white/10 px-1">1081</code> (enable proxy DNS).</span>
          </li>
        </ul>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[10px] text-white/30">Reopen this: right-click the taskbar shield</span>
          <button
            onClick={onClose}
            className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function NcHelpDialog({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[99998] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[420px] max-w-[92vw] rounded-2xl border border-white/10 bg-gray-900/95 p-5 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <img src="/icons/nextcloud.svg" alt="Nextcloud" className="h-5 w-5" />
          <h2 className="text-sm font-semibold text-white">Nextcloud Hub</h2>
        </div>
        <div className="space-y-3 text-xs text-white/70">
          <p>Nextcloud integration for your Linux workspace. Access your Nextcloud data directly from your desktop.</p>
          <div className="space-y-2">
            <h4 className="font-medium text-white/90">Features:</h4>
            <ul className="space-y-1.5 pl-4">
              <li className="flex gap-2">
                <span className="text-white/40">•</span>
                <span><strong>Calendar</strong>: View and manage your Nextcloud calendar events</span>
              </li>
              <li className="flex gap-2">
                <span className="text-white/40">•</span>
                <span><strong>Tasks</strong>: Track your to-dos and checklists</span>
              </li>
              <li className="flex gap-2">
                <span className="text-white/40">•</span>
                <span><strong>Deck</strong>: Kanban boards for project management</span>
              </li>
              <li className="flex gap-2">
                <span className="text-white/40">•</span>
                <span><strong>Talk</strong>: Chat with colleagues and start new conversations</span>
              </li>
              <li className="flex gap-2">
                <span className="text-white/40">•</span>
                <span><strong>Notes</strong>: Quick note-taking and organization</span>
              </li>
              <li className="flex gap-2">
                <span className="text-white/40">•</span>
                <span><strong>Notifications</strong>: View your Nextcloud notifications</span>
              </li>
            </ul>
          </div>
          <p>All data is securely synced with your Nextcloud server.</p>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[10px] text-white/30">Reopen this: right-click the Nextcloud icon</span>
          <button
            onClick={onClose}
            className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export function LogoutDialog({ onClose }: { onClose(): void }) {
  const windows = useDesktopStore((s) => s.windows);
  const activeSessions = windows.length;
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  // Close on Escape — click-away is handled by the transparent catcher below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function doLogout(stopSessions: boolean) {
    setBusy(true);
    try {
      if (remember) {
        await client.patch("/api/auth/me/preferences", {
          logout_sessions: stopSessions ? "stop" : "keep",
        }).catch(() => {});
      }
      if (stopSessions) {
        await client.delete("/api/sessions").catch(() => {});
      }
      await client.post("/api/auth/logout").catch(() => {});
      useAuthStore.getState().setUser(null);
      window.location.href = "/login";
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Transparent click-away catcher (no dimming — this is a menu, not a modal) */}
      <div className="fixed inset-0 z-[99998]" onClick={onClose} />

      {/* Anchored above the logout button, bottom-right */}
      <div className="fixed bottom-14 right-2 z-[99999] w-[280px] rounded-xl border border-white/10 bg-gray-900/95 p-2.5 shadow-2xl backdrop-blur-xl">
        <div className="mb-1 flex items-center gap-2 px-1">
          <LogOut className="h-4 w-4 text-red-400" />
          <h2 className="text-sm font-semibold text-white">Log out</h2>
        </div>

        <p className="mb-2.5 px-1 text-xs text-white/55">
          {activeSessions > 0
            ? `You have ${activeSessions} active session${activeSessions > 1 ? "s" : ""}. Keep them running?`
            : "No active sessions."}
        </p>

        <label className="mb-2.5 flex cursor-pointer items-center gap-2 px-1 text-xs text-white/50 select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-indigo-500 h-3.5 w-3.5"
          />
          Remember my choice
        </label>

        <div className="flex flex-col gap-1.5">
          {activeSessions > 0 && (
            <button
              onClick={() => doLogout(false)}
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Keep sessions running
            </button>
          )}
          <button
            onClick={() => doLogout(activeSessions > 0)}
            disabled={busy}
            className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            {activeSessions > 0 ? "Stop sessions & log out" : "Log out"}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-xs text-white/40 hover:text-white/70 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

// ── Quick-launch strip ────────────────────────────────────────────────────────

function QuickLaunch({
  apps,
  onContextMenu,
}: {
  apps: App[];
  onContextMenu(appId: string, x: number, y: number): void;
}) {
  const {
    quickLaunch, addToQuickLaunch,
    openWindow, setLaunching, windows,
  } = useDesktopStore();
  const [dropActive, setDropActive] = useState(false);

  const appMap = Object.fromEntries(apps.map((a) => [a.id, a]));
  const runningAppIds = new Set(windows.map((w) => w.appId));

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const appId = e.dataTransfer.getData("lwp/appId");
    if (appId) addToQuickLaunch(appId);
  };

  const handleLaunch = async (appId: string) => {
    const app = appMap[appId];
    if (!app) return;
    setLaunching({ appId: app.id, appName: app.name, appIcon: app.icon_url || "🖥️" });
    try {
      const res = await client.post("/api/sessions", { app_id: appId });
      openWindow(res.data, app);
    } catch {}
    setLaunching(null);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-lg px-1 transition-colors min-w-[2rem]",
        dropActive && "bg-indigo-500/20 ring-1 ring-indigo-400/40",
      )}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropActive(true); }}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
    >
      {quickLaunch.length === 0 && (
        <span className="px-2 text-[10px] text-white/20 whitespace-nowrap">
          drag app here
        </span>
      )}
      {quickLaunch.map((appId) => {
        const app = appMap[appId];
        const isRunning = runningAppIds.has(appId);
        return (
          <button
            key={appId}
            title={app?.name ?? appId}
            onClick={() => handleLaunch(appId)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(appId, e.clientX, e.clientY);
            }}
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
          >
            {isRunning && (
              <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-green-400" />
            )}
            {app?.icon_url ? (
              <img src={app.icon_url} alt="" className="h-5 w-5 object-contain" />
            ) : (
              <span className="text-sm">🖥️</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Taskbar ───────────────────────────────────────────────────────────────────

interface TaskbarProps {
  onExposeOpen(): void;
}

export function Taskbar({ onExposeOpen }: TaskbarProps) {
  const {
    windows, launcherOpen, setLauncherOpen,
    focusWindow, minimizeWindow, closeWindow,
    profileOpen, setProfileOpen,
    maxZ, setLocked,
    workspaces, activeWorkspace, switchWorkspace, moveWindowToWorkspace,
  } = useDesktopStore();
  const { user } = useAuthStore();

  const { data: apps = [] } = useQuery<App[]>({
    queryKey: ["apps"],
    queryFn: () => client.get("/api/apps").then((r) => r.data),
    staleTime: 60_000,
  });

  const [winCtx, setWinCtx] = useState<{
    windowId: string; x: number; y: number;
  } | null>(null);
  const [qlCtx, setQlCtx] = useState<{
    appId: string; x: number; y: number;
  } | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [ncOpen, setNcOpen] = useState(false);
  const [ncHelpOpen, setNcHelpOpen] = useState(false);
  // Hover preview over a running-window button
  const [preview, setPreview] = useState<{
    windowId: string; name: string; x: number; snap: string | null;
  } | null>(null);

  // Notification badge (Nextcloud); silent if NC isn't configured.
  const { data: ncNotifs = [] } = useQuery<any[]>({
    queryKey: ["nc-notifications"],
    queryFn: () => client.get("/api/nextcloud/notifications").then((r) => r.data),
    refetchInterval: 60_000,
    retry: false,
  });

  // Warm the Nextcloud hub on load so its tabs open instantly (no spinner on
  // first click). Best-effort — no-ops if NC isn't configured.
  const ncQc = useQueryClient();
  useEffect(() => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const warm = (key: unknown[], url: string) =>
      ncQc.prefetchQuery({ queryKey: key, queryFn: () => client.get(url).then((r) => r.data), staleTime: 60_000 });
    warm(["nc-calendar", month], `/api/nextcloud/calendar?month=${month}`);
    warm(["nc-tasks"], "/api/nextcloud/tasks");
    warm(["nc-deck"], "/api/nextcloud/deck");
    warm(["nc-talk"], "/api/nextcloud/talk");
    warm(["nc-notes"], "/api/nextcloud/notes");
  }, [ncQc]);

  const handleLogoutClick = useCallback(async () => {
    const { data: prefs } = await client.get("/api/auth/me/preferences").catch(() => ({ data: {} }));
    const savedChoice: string | undefined = prefs?.logout_sessions;
    if (savedChoice === "keep") {
      await client.post("/api/auth/logout").catch(() => {});
      useAuthStore.getState().setUser(null);
      window.location.href = "/login";
    } else if (savedChoice === "stop") {
      await client.delete("/api/sessions").catch(() => {});
      await client.post("/api/auth/logout").catch(() => {});
      useAuthStore.getState().setUser(null);
      window.location.href = "/login";
    } else {
      setLogoutOpen(true);
    }
  }, []);

  // Tray shield while the user's VPN gateway session is open: amber while
  // logging in, green once the tunnel reports connected. On the transition to
  // connected the VPN window minimizes itself out of the way.
  const vpnAppIds = new Set(apps.filter((a) => a.is_vpn).map((a) => a.id));
  const vpnWindow = windows.find((w) => vpnAppIds.has(w.appId));
  const { data: vpnStatus } = useQuery<{ running: boolean; connected: boolean }>({
    queryKey: ["vpn-status"],
    queryFn: () => client.get("/api/sessions/vpn/status").then((r) => r.data),
    refetchInterval: 5_000,
    enabled: !!vpnWindow,
  });
  const vpnConnected = !!vpnWindow && !!vpnStatus?.connected;
  const vpnWasConnected = useRef(false);
  const [vpnHelpOpen, setVpnHelpOpen] = useState(false);
  useEffect(() => {
    if (vpnConnected && !vpnWasConnected.current) {
      if (vpnWindow && !vpnWindow.minimized) minimizeWindow(vpnWindow.windowId);
      // First tunnel ever for this user → one-time "how routing works" help.
      const u = useAuthStore.getState().user;
      const prefs = (u?.preferences ?? {}) as Record<string, unknown>;
      if (!prefs.vpn_help_seen) {
        setVpnHelpOpen(true);
        client.patch("/api/auth/me/preferences", { vpn_help_seen: true }).catch(() => {});
        if (u) useAuthStore.getState().setUser({ ...u, preferences: { ...prefs, vpn_help_seen: true } });
      }
    }
    vpnWasConnected.current = vpnConnected;
  }, [vpnConnected, vpnWindow, minimizeWindow]);

  const handleWinRightClick = (e: React.MouseEvent, windowId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setWinCtx({ windowId, x: e.clientX, y: e.clientY });
  };

  return (
    <>
      <div
        className="fixed bottom-0 left-0 right-0 z-[9000] flex h-12 items-center gap-1 bg-black/65 px-2 backdrop-blur-md border-t border-white/[0.06]"
        data-no-ctx
      >
        {/* Launcher */}
        <button
          onClick={() => setLauncherOpen(!launcherOpen)}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
            launcherOpen
              ? "bg-white/20 text-white"
              : "text-white/60 hover:bg-white/10 hover:text-white",
          )}
          title="App launcher (Super)"
        >
          <LayoutGrid className="h-5 w-5" />
        </button>

        {/* Mission Control */}
        <button
          onClick={onExposeOpen}
          title="Mission Control (Super+Tab)"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white transition-colors"
        >
          <Layers className="h-4 w-4" />
        </button>

        {/* Show desktop — minimizes everything on this workspace, or restores it all */}
        <button
          onClick={() => useDesktopStore.getState().showDesktop()}
          title="Show desktop (Super+D)"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white transition-colors"
        >
          <Square className="h-3.5 w-3.5" />
        </button>

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Quick launch */}
        <QuickLaunch
          apps={apps}
          onContextMenu={(appId, x, y) => setQlCtx({ appId, x, y })}
        />

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Workspace switcher */}
        <div className="flex items-center gap-0.5">
          {workspaces.map((ws) => {
            const hasWindows = windows.some((w) => w.workspace === ws);
            return (
              <button
                key={ws}
                onClick={() => switchWorkspace(ws)}
                title={`Workspace ${ws}`}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold transition-colors",
                  ws === activeWorkspace
                    ? "bg-indigo-600 text-white"
                    : "text-white/40 hover:bg-white/10 hover:text-white",
                  hasWindows && ws !== activeWorkspace && "ring-1 ring-white/20",
                )}
              >
                {ws}
              </button>
            );
          })}
        </div>

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Running app buttons */}
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {windows.filter((w) => w.workspace === activeWorkspace).map((win) => {
            const isActive = !win.minimized && win.zIndex === maxZ;
            return (
              <button
                key={win.windowId}
                onClick={() =>
                  win.minimized ? focusWindow(win.windowId) : minimizeWindow(win.windowId)
                }
                onMouseEnter={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setPreview({ windowId: win.windowId, name: win.appName, x: r.left + r.width / 2, snap: getSnapshot(win.windowId) });
                }}
                onMouseLeave={() => setPreview(null)}
                onContextMenu={(e) => handleWinRightClick(e, win.windowId)}
                className={cn(
                  "relative flex h-9 max-w-[180px] shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors",
                  win.minimized
                    ? "text-white/35 hover:bg-white/10 hover:text-white/60"
                    : isActive
                    ? "bg-white/20 text-white"
                    : "bg-white/10 text-white/80 hover:bg-white/15",
                )}
                title={win.appName}
              >
                {/* Active indicator */}
                {!win.minimized && (
                  <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-white/70" />
                )}
                {win.appIcon ? (
                  <img src={win.appIcon} alt="" className="h-4 w-4 shrink-0 object-contain" />
                ) : (
                  <span className="text-xs">🖥️</span>
                )}
                <span className="truncate">{win.appName}</span>
              </button>
            );
          })}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1 pl-2">
          {vpnWindow && (
            <button
              onClick={() => focusWindow(vpnWindow.windowId)}
              onContextMenu={(e) => { e.preventDefault(); setVpnHelpOpen(true); }}
              title={
                vpnConnected
                  ? "VPN connected — toggle the shield on each window to route it through the tunnel (right-click for help)"
                  : "VPN not connected yet — click to open the login terminal"
              }
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-white/10 transition-colors",
                vpnConnected ? "text-emerald-400" : "text-amber-400 animate-pulse",
              )}
            >
              <ShieldCheck className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => setNcOpen((v) => !v)}
            onContextMenu={(e) => { e.preventDefault(); setNcHelpOpen(true); }}
            title="Nextcloud — calendar, notifications, notes (right-click for help)"
            className={cn(
              "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              ncOpen ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white",
            )}
          >
            <img src="/icons/nextcloud.svg" alt="Nextcloud" className="h-[18px] w-[18px]" />
            {ncNotifs.length > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                {ncNotifs.length}
              </span>
            )}
          </button>
          {user && (
            <button
              onClick={() => setProfileOpen(!profileOpen)}
              title="Profile & preferences"
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-white/40 hover:bg-white/10 hover:text-white transition-colors"
            >
              <NcAvatar name={user.display_name || user.username} size={22} />
              <span className="hidden sm:inline">{user.display_name || user.username}</span>
            </button>
          )}
          <div className="mx-1 h-5 w-px bg-white/10" />
          {!user?.policies?.disable_clipboard && (
          <button
            onClick={() => setClipOpen((v) => !v)}
            title="Shared clipboard"
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              clipOpen ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white",
            )}
          >
            <ClipboardCheck className="h-4 w-4" />
          </button>
          )}
          <Clock />
          <div className="mx-1 h-5 w-px bg-white/10" />
          <FullscreenButton />
          {user?.lock_pin_enabled && (
            <button
              onClick={() => setLocked(true)}
              title="Lock now"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white transition-colors"
            >
              <LockKeyhole className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={handleLogoutClick}
            title="Log out"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-red-500/20 hover:text-red-400 transition-colors"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Window hover preview */}
      {preview?.snap && (
        <div
          className="pointer-events-none fixed bottom-14 z-[9100] -translate-x-1/2 overflow-hidden rounded-lg border border-white/15 bg-black/90 shadow-2xl"
          style={{ left: preview.x }}
        >
          <img src={preview.snap} alt="" className="block h-32 w-auto max-w-[280px] object-cover" />
          <p className="truncate px-2 py-1 text-[10px] text-white/70">{preview.name}</p>
        </div>
      )}

      {/* Nextcloud hub */}
      {ncOpen && <NextcloudHub onClose={() => setNcOpen(false)} />}

      {/* Shared clipboard */}
      {clipOpen && !user?.policies?.disable_clipboard && <ClipboardManager onClose={() => setClipOpen(false)} />}

      {/* Logout dialog */}
      {logoutOpen && <LogoutDialog onClose={() => setLogoutOpen(false)} />}
      {vpnHelpOpen && <VpnHelpDialog onClose={() => setVpnHelpOpen(false)} />}
      {ncHelpOpen && <NcHelpDialog onClose={() => setNcHelpOpen(false)} />}

      {/* Right-click context menu on quick-launch icon */}
      {qlCtx && (
        <ContextMenu
          x={qlCtx.x}
          y={qlCtx.y - 4}
          items={[
            {
              label: "Remove from taskbar",
              icon: "✕",
              danger: true,
              onClick: () => {
                useDesktopStore.getState().removeFromQuickLaunch(qlCtx.appId);
                setQlCtx(null);
              },
            },
          ]}
          onClose={() => setQlCtx(null)}
        />
      )}

      {/* Right-click context menu on taskbar app button */}
      {winCtx && (() => {
        const win = windows.find((w) => w.windowId === winCtx.windowId);
        if (!win) return null;
        return (
          <ContextMenu
            x={winCtx.x}
            y={winCtx.y - 4}
            items={[
              win.minimized
                ? { label: "Restore", icon: "⬆️", onClick: () => focusWindow(win.windowId) }
                : { label: "Minimize", icon: "⬇️", onClick: () => minimizeWindow(win.windowId) },
              ...workspaces
                .filter((ws) => ws !== win.workspace)
                .map((ws) => ({
                  label: `Move to workspace ${ws}`,
                  icon: "🗔",
                  onClick: () => {
                    moveWindowToWorkspace(win.windowId, ws);
                    switchWorkspace(ws);
                    setWinCtx(null);
                  },
                })),
              {
                label: "Close session", icon: "✕", danger: true,
                onClick: () => {
                  setWinCtx(null);
                  client.delete(`/api/sessions/${win.sessionId}`).catch(() => {});
                  closeWindow(win.windowId);
                },
              },
            ]}
            onClose={() => setWinCtx(null)}
          />
        );
      })()}
    </>
  );
}
