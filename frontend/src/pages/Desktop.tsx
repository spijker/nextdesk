import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import client from "@/api/client";
import type { App, Session } from "@/types";
import { useAuthStore } from "@/store/auth";
import { useDesktopStore } from "@/store/desktop";
import { useIdleTimer } from "@/hooks/useIdleTimer";
import { Window } from "@/components/desktop/Window";
import { Taskbar } from "@/components/desktop/Taskbar";
import { SystemBanner } from "@/components/desktop/SystemBanner";
import { AppLauncher } from "@/components/desktop/AppLauncher";
import { DesktopIcon } from "@/components/desktop/DesktopIcon";
import { ContextMenu } from "@/components/desktop/ContextMenu";
import { WallpaperPicker } from "@/components/desktop/WallpaperPicker";
import { AdminWindow } from "@/components/desktop/AdminWindow";
import { LaunchPanel } from "@/components/desktop/LaunchPanel";
import { AltTabSwitcher } from "@/components/desktop/AltTabSwitcher";
import { Expose } from "@/components/desktop/Expose";
import { OnboardingModal } from "@/components/OnboardingModal";
import { DesktopTiles } from "@/components/desktop/DesktopTiles";
import { StorageWindow } from "@/components/desktop/StorageWindow";
import { ProfileWindow } from "@/components/desktop/ProfileWindow";
import { FileManagerWindow } from "@/components/desktop/FileManagerWindow";
import { CommandPalette } from "@/components/desktop/CommandPalette";
import { LockScreen } from "@/components/desktop/LockScreen";
import { SimpleModeMenu } from "@/components/desktop/SimpleModeMenu";
import { useOpenFilePoll } from "@/hooks/useOpenFilePoll";
import { useDeepLinkOpen } from "@/hooks/useDeepLinkOpen";
import { useClipboardCapture } from "@/hooks/useClipboardCapture";
import { useSessionHeartbeat } from "@/hooks/useSessionHeartbeat";

const DEFAULT_WALLPAPER =
  "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)";

export default function Desktop() {
  const { user } = useAuthStore();
  const {
    windows, launcherOpen, setLauncherOpen,
    adminOpen,
    storageOpen, profileOpen, setProfileOpen, fileManagerOpen,
    launching,
    wallpaper, pinned, restoreFromSessions, ensureSystemIcons,
    focusWindow, closeWindow,
    theme, desktopLayout, layoutMode,
    activeWorkspace,
    suspendWindow, resumeWindow,
    detached, detachAll, setDetached,
    locked, setLocked,
  } = useDesktopStore();

  // Simple mode (Profile → Appearance, or forced by a group's
  // force_simple_layout policy): no taskbar/launcher/window-management
  // chrome — just Files + app tiles (DesktopTiles) and a single corner menu
  // for profile/logout (SimpleModeMenu). Policy always wins over the user's
  // own preference.
  const simpleMode = !!user?.policies?.force_simple_layout || layoutMode === "simple";

  // Session transfer between tabs: the most recently opened desktop tab claims
  // the sessions; other tabs detach their windows (containers keep running)
  // and show a takeover overlay until the user claims them back.
  const tabId = useRef(crypto.randomUUID());
  const bcRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const bc = new BroadcastChannel("lwp-desktop");
    bcRef.current = bc;
    bc.onmessage = (e) => {
      if (e.data?.type === "claim" && e.data.tabId !== tabId.current) detachAll();
    };
    bc.postMessage({ type: "claim", tabId: tabId.current });
    return () => bc.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const claimDesktop = useCallback(() => {
    bcRef.current?.postMessage({ type: "claim", tabId: tabId.current });
    setDetached(false);
  }, [setDetached]);

  // Idle timer — suspend sessions after 15 min inactivity
  const IDLE_MS = 15 * 60 * 1000;
  const IDLE_WARNING_MS = 60 * 1000; // heads-up this long before the real idle timeout
  const warnToastId = useRef<string | number | null>(null);
  const qc = useQueryClient();

  const onIdleWarning = useCallback(() => {
    // Only worth warning about if something is actually about to happen.
    const hasPin = !!useAuthStore.getState().user?.lock_pin_enabled;
    const hasRunning = useDesktopStore.getState().windows.some((w) => !w.suspended);
    if (!hasPin && !hasRunning) return;
    warnToastId.current = toast.warning(
      `Going idle in ${IDLE_WARNING_MS / 1000}s — ${hasPin ? "your desktop will lock" : "sessions will be suspended"}`,
      { duration: IDLE_WARNING_MS }
    );
  }, []);
  const onActiveAfterWarning = useCallback(() => {
    if (warnToastId.current != null) { toast.dismiss(warnToastId.current); warnToastId.current = null; }
  }, []);
  useIdleTimer({ idleMs: IDLE_MS - IDLE_WARNING_MS, onIdle: onIdleWarning, onActive: onActiveAfterWarning });

  const onIdle = useCallback(() => {
    // Background-eligible apps (Terminal) stay running when the user opted in —
    // pausing would freeze their tmux jobs. The backend reaper caps them at 48h.
    const prefs = (useAuthStore.getState().user?.preferences ?? {}) as Record<string, unknown>;
    const bgIds = prefs.terminal_background
      ? new Set((qc.getQueryData<App[]>(["apps"]) ?? []).filter((a) => a.bg_allowed).map((a) => a.id))
      : new Set<string>();
    const running = useDesktopStore.getState().windows.filter(
      (w) => !w.suspended && w.workspace !== undefined && !bgIds.has(w.appId)
    );
    if (running.length) {
      running.forEach((w) => {
        client.post(`/api/sessions/${w.sessionId}/pause`).catch(() => {});
        suspendWindow(w.windowId);
      });
      toast.info(`${running.length} session${running.length > 1 ? "s" : ""} suspended due to inactivity`);
    }
    // Privacy screen (Profile → Security) — only if the user set a PIN.
    if (useAuthStore.getState().user?.lock_pin_enabled) setLocked(true);
  }, [suspendWindow, qc, setLocked]);

  const resumeSuspended = useCallback(() => {
    const suspended = useDesktopStore.getState().windows.filter((w) => w.suspended);
    if (!suspended.length) return;
    suspended.forEach((w) => {
      client.post(`/api/sessions/${w.sessionId}/resume`).catch(() => {});
      resumeWindow(w.windowId);
    });
    toast.success("Sessions resumed");
  }, [resumeWindow]);

  const onActive = useCallback(() => {
    // Locked desktop waits for the PIN (LockScreen.onUnlock), not mere activity.
    if (useDesktopStore.getState().locked) return;
    resumeSuspended();
  }, [resumeSuspended]);

  const handleUnlock = useCallback(() => {
    setLocked(false);
    resumeSuspended();
  }, [setLocked, resumeSuspended]);

  useIdleTimer({ idleMs: IDLE_MS, onIdle, onActive });
  useOpenFilePoll();
  useClipboardCapture();
  useSessionHeartbeat();

  // Apply theme to document root
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark")   { root.classList.add("dark"); return; }
    if (theme === "light")  { root.classList.remove("dark"); return; }
    // system
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.matches) root.classList.add("dark"); else root.classList.remove("dark");
    const onChange = (e: MediaQueryListEvent) =>
      e.matches ? root.classList.add("dark") : root.classList.remove("dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // Onboarding — show once per user. Server preference is the source of truth
  // so it stays dismissed across browsers / private windows; localStorage is a
  // fast-path fallback for accounts onboarded before the server flag existed.
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (!user) return;
    // Already provisioned (NC connected) or previously onboarded ⇒ never ask again.
    const onboarded = (user.preferences as any)?.onboarded === true
      || (user as any)?.nc_connected === true
      || !!localStorage.getItem(`lwp_setup_${user.id}`);
    if (!onboarded) setShowOnboarding(true);
  }, [user?.id]);

  const [desktopCtx, setDesktopCtx] = useState<{ x: number; y: number } | null>(null);
  const [showWallpaper, setShowWallpaper] = useState(false);
  const [exposeOpen, setExposeOpen] = useState(false);
  const [altTabOpen, setAltTabOpen] = useState(false);
  const [altTabIdx, setAltTabIdx] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Keyboard shortcuts
  const altHeld = useRef(false);
  const windowsRef = useRef(windows);
  useEffect(() => { windowsRef.current = windows; }, [windows]);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") { altHeld.current = true; return; }

      // Simple mode has no launcher/palette/switcher/Exposé to toggle — the
      // chrome those overlays belong to isn't rendered at all (see
      // simpleMode below), only the escape hatches (lock, show desktop) stay.
      if (!simpleMode) {
        // Ctrl/Cmd+K — command palette
        if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          setPaletteOpen((v) => !v);
          return;
        }

        // Alt+Tab — window switcher
        if (e.key === "Tab" && altHeld.current) {
          e.preventDefault();
          const wins = windowsRef.current;
          if (!wins.length) return;
          setAltTabOpen(true);
          setAltTabIdx((prev) => {
            const next = e.shiftKey ? prev - 1 : prev + 1;
            return ((next % wins.length) + wins.length) % wins.length;
          });
          return;
        }

        // Super/Meta — toggle launcher; Super+Tab — Exposé
        if (e.key === "Meta" && !e.repeat) {
          if (e.shiftKey) { setExposeOpen((v) => !v); return; }
          setLauncherOpen(!launcherOpen);
          return;
        }
      }

      // Super+L — lock now (only if a PIN is configured). The bare Meta
      // keydown above already fired and toggled the launcher open; close it
      // back since the lock screen is about to cover everything anyway.
      if (e.key.toLowerCase() === "l" && e.metaKey) {
        e.preventDefault();
        if (useAuthStore.getState().user?.lock_pin_enabled) {
          setLauncherOpen(false);
          setLocked(true);
        }
        return;
      }

      // Super+D — show desktop (minimize/restore all). Same launcher-closing
      // cleanup as Super+L, for the same reason.
      if (e.key.toLowerCase() === "d" && e.metaKey) {
        e.preventDefault();
        setLauncherOpen(false);
        useDesktopStore.getState().showDesktop();
        return;
      }

      // Escape — close overlays in priority order
      if (e.key === "Escape") {
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (altTabOpen) { setAltTabOpen(false); return; }
        if (exposeOpen) { setExposeOpen(false); return; }
        if (launcherOpen) { setLauncherOpen(false); return; }
      }
    };

    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      altHeld.current = false;
      if (altTabOpen) {
        const win = windowsRef.current[altTabIdx];
        if (win) focusWindow(win.windowId);
        setAltTabOpen(false);
      }
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [altTabOpen, altTabIdx, exposeOpen, launcherOpen, paletteOpen, simpleMode]);

  const { data: sessions = [], isSuccess: sessionsLoaded } = useQuery<Session[]>({
    queryKey: ["sessions"],
    queryFn: () => client.get("/api/sessions").then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: apps = [] } = useQuery<App[]>({
    queryKey: ["apps"],
    queryFn: () => client.get("/api/apps").then((r) => r.data),
  });
  useDeepLinkOpen(apps);

  const { data: ncCfg } = useQuery({
    queryKey: ["storage", "nextcloud"],
    queryFn: () => client.get("/api/storage/nextcloud").then((r) => r.data),
    staleTime: 60_000,
  });

  // Clipboard sync (privacy opt-in): hydrate server-side history once on login
  useEffect(() => {
    const prefs = user?.preferences as Record<string, unknown> | undefined;
    if (prefs?.clipboard_sync && Array.isArray(prefs.clipboard_history)) {
      useDesktopStore.getState().mergeClips(prefs.clipboard_history as string[]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Sync system icons whenever role or NC config changes
  useEffect(() => {
    if (user) ensureSystemIcons(user.is_admin, !!(ncCfg?.system_configured || ncCfg?.personal_url));
  }, [user?.is_admin, ncCfg?.system_configured, ncCfg?.personal_url]);

  // Adopt running sessions as windows — on load and continuously, so sessions
  // started in another tab/device appear here (session transfer) as the
  // sessions poll picks them up. Skipped while detached (another tab owns them).
  useEffect(() => {
    if (detached || !sessions.length || !apps.length) return;
    const alreadyOpen = new Set(windows.map((w) => w.sessionId));
    const fresh = sessions.filter((s) => !alreadyOpen.has(s.id));
    if (fresh.length) restoreFromSessions(fresh, apps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, apps, detached]);

  // Auto-close windows whose session stopped (app exited inside VNC or container died)
  useEffect(() => {
    if (!sessionsLoaded || detached) return;
    const live = new Set(sessions.map((s) => s.id));
    useDesktopStore.getState().windows.forEach((w) => {
      if (w.sessionId && !live.has(w.sessionId)) closeWindow(w.windowId);
    });
  }, [sessions, sessionsLoaded, closeWindow]);

  const handleDesktopRightClick = (e: React.MouseEvent) => {
    if (simpleMode) return; // no desktop menu in Simple mode
    // Only fire if click is on the desktop canvas itself
    if ((e.target as HTMLElement).closest("[data-no-ctx]")) return;
    e.preventDefault();
    setDesktopCtx({ x: e.clientX, y: e.clientY });
  };

  // Marquee (drag-select) for desktop icons — click-drag empty desktop space
  // to lasso multiple icons, then Delete/Backspace to bulk-remove them.
  const [selectedIcons, setSelectedIcons] = useState<Set<string>>(new Set());
  const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number } | null>(null);
  const [marqueeNow, setMarqueeNow] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!marqueeStart) return;
    const onMove = (e: MouseEvent) => {
      setMarqueeNow({ x: e.clientX, y: e.clientY });
      const x0 = Math.min(marqueeStart.x, e.clientX), x1 = Math.max(marqueeStart.x, e.clientX);
      const y0 = Math.min(marqueeStart.y, e.clientY), y1 = Math.max(marqueeStart.y, e.clientY);
      const next = new Set<string>();
      document.querySelectorAll("[data-desktop-icon]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.left < x1 && r.right > x0 && r.top < y1 && r.bottom > y0) {
          next.add(el.getAttribute("data-desktop-icon")!);
        }
      });
      setSelectedIcons(next);
    };
    const onUp = () => { setMarqueeStart(null); setMarqueeNow(null); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marqueeStart]);

  // Delete/Backspace removes the selected (non-system) icons from the desktop.
  useEffect(() => {
    if (!selectedIcons.size) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      const removable = pinned.filter((p) => selectedIcons.has(p.id) && !p.isSystem);
      if (!removable.length) return;
      removable.forEach((p) => useDesktopStore.getState().removePinned(p.id));
      setSelectedIcons(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIcons, pinned]);

  const bg = wallpaper || DEFAULT_WALLPAPER;
  const isGradient = bg.startsWith("linear-gradient") || bg.startsWith("radial-gradient") || bg.startsWith("#");

  return (
    <div
      className="relative h-screen w-screen overflow-hidden select-none"
      style={
        isGradient
          ? { background: bg }
          : { backgroundImage: `url("${bg}")`, backgroundSize: "cover", backgroundPosition: "center" }
      }
      onContextMenu={handleDesktopRightClick}
      onMouseDown={(e) => {
        if (launcherOpen) setLauncherOpen(false);
        if (desktopCtx) setDesktopCtx(null);
        // Marquee select — only starts on a genuine click on the bare
        // desktop (not an icon/window/taskbar), left button only.
        if (e.target === e.currentTarget && e.button === 0) {
          setSelectedIcons(new Set());
          setMarqueeStart({ x: e.clientX, y: e.clientY });
          setMarqueeNow({ x: e.clientX, y: e.clientY });
        } else if (selectedIcons.size) {
          setSelectedIcons(new Set());
        }
      }}
    >
      {/* Session-transfer overlay: another tab claimed the desktop */}
      {detached && (
        <div className="fixed inset-0 z-[9900] flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm">
          <p className="text-lg font-medium text-white">
            Your desktop moved to another tab
          </p>
          <p className="max-w-sm text-center text-sm text-white/60">
            Sessions keep running there. Take them back to continue in this tab —
            the other tab will hand them over.
          </p>
          <button
            onClick={claimDesktop}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Use desktop here
          </button>
        </div>
      )}

      {/* Desktop icons / tiles — layout controlled by desktopLayout, except
          Simple mode always forces the tile grid regardless of that pref. */}
      {!simpleMode && desktopLayout === "icons" && pinned.length > 0 && (
        <div className="absolute left-3 top-3 flex flex-col gap-1 pb-14" data-no-ctx>
          {pinned.map((item) => (
            <DesktopIcon key={item.id} item={item} apps={apps} selected={selectedIcons.has(item.id)} />
          ))}
        </div>
      )}
      {(simpleMode || desktopLayout === "tiles") && (
        <div data-no-ctx>
          <DesktopTiles apps={apps} />
        </div>
      )}

      {/* Marquee drag-select rectangle */}
      {marqueeStart && marqueeNow && (
        <div
          className="pointer-events-none fixed z-[9990] rounded-sm border border-indigo-400/60 bg-indigo-400/10"
          style={{
            left: Math.min(marqueeStart.x, marqueeNow.x),
            top: Math.min(marqueeStart.y, marqueeNow.y),
            width: Math.abs(marqueeNow.x - marqueeStart.x),
            height: Math.abs(marqueeNow.y - marqueeStart.y),
          }}
        />
      )}

      {/* App windows — only show windows belonging to the active workspace */}
      {windows.map((win) => (
        <div key={win.windowId} data-no-ctx style={{ display: win.workspace === activeWorkspace ? undefined : "none" }}>
          <Window win={win} />
        </div>
      ))}

      {/* App launcher overlay */}
      {!simpleMode && launcherOpen && (
        <div data-no-ctx>
          <AppLauncher onClose={() => setLauncherOpen(false)} />
        </div>
      )}

      {/* Right-click context menu on wallpaper */}
      {desktopCtx && (
        <ContextMenu
          x={desktopCtx.x}
          y={desktopCtx.y}
          items={[
            {
              label: "Set wallpaper",
              icon: "🖼️",
              onClick: () => setShowWallpaper(true),
            },
            {
              label: "Settings",
              icon: "⚙️",
              onClick: () => setProfileOpen(true),
            },
            { label: "", onClick: () => {}, divider: true },
            {
              label: "App launcher",
              icon: "⊞",
              onClick: () => setLauncherOpen(true),
            },
          ]}
          onClose={() => setDesktopCtx(null)}
        />
      )}

      {/* Wallpaper picker modal */}
      {showWallpaper && (
        <div data-no-ctx>
          <WallpaperPicker onClose={() => setShowWallpaper(false)} />
        </div>
      )}

      {/* Admin window */}
      {adminOpen && (
        <div data-no-ctx>
          <AdminWindow />
        </div>
      )}

      {/* Storage window */}
      {storageOpen && (
        <div data-no-ctx>
          <StorageWindow />
        </div>
      )}

      {/* Profile window */}
      {profileOpen && (
        <div data-no-ctx>
          <ProfileWindow />
        </div>
      )}

      {/* File manager native window */}
      {fileManagerOpen && (
        <div data-no-ctx>
          <FileManagerWindow />
        </div>
      )}

      {/* Announcements stay visible even in Simple mode — only the taskbar
          chrome itself is Simple mode's business. */}
      <div data-no-ctx>
        <SystemBanner />
      </div>

      {/* Taskbar — always on top */}
      {!simpleMode && (
        <div data-no-ctx>
          <Taskbar onExposeOpen={() => setExposeOpen(true)} />
        </div>
      )}
      {simpleMode && <SimpleModeMenu />}

      {/* Alt+Tab window switcher */}
      {!simpleMode && altTabOpen && (
        <div data-no-ctx>
          <AltTabSwitcher
            selectedIdx={altTabIdx}
            onSelect={(windowId) => { focusWindow(windowId); setAltTabOpen(false); }}
          />
        </div>
      )}

      {/* Exposé / Mission Control */}
      {!simpleMode && exposeOpen && (
        <div data-no-ctx>
          <Expose
            onClose={() => setExposeOpen(false)}
            onSelect={(windowId) => { focusWindow(windowId); setExposeOpen(false); }}
          />
        </div>
      )}

      {/* Launch overlay — shown while container starts */}
      {!simpleMode && paletteOpen && <CommandPalette apps={apps} onClose={() => setPaletteOpen(false)} />}

      {launching && <LaunchPanel info={launching} />}

      {/* First-run onboarding */}
      {showOnboarding && user && (
        <OnboardingModal userId={String(user.id)} onDone={() => setShowOnboarding(false)} />
      )}

      {/* Idle privacy screen — last, so it covers everything else */}
      {locked && <LockScreen onUnlock={handleUnlock} />}
    </div>
  );
}
