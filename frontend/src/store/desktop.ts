import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { App, Session } from "@/types";
import client from "@/api/client";
import { useAuthStore } from "@/store/auth";

// Clipboard server sync is a privacy opt-in (Profile → Preferences).
function clipboardSyncEnabled(): boolean {
  const prefs = useAuthStore.getState().user?.preferences as Record<string, unknown> | undefined;
  return !!prefs?.clipboard_sync;
}

// Debounce helper — accumulates patches so rapid consecutive pref changes
// (e.g. wallpaper then theme in onboarding) are all persisted, not clobbered.
let _prefTimer: ReturnType<typeof setTimeout> | null = null;
let _prefPending: Record<string, unknown> = {};
function savePrefDebounced(patch: Record<string, unknown>) {
  _prefPending = { ..._prefPending, ...patch };
  if (_prefTimer) clearTimeout(_prefTimer);
  _prefTimer = setTimeout(() => {
    const body = _prefPending;
    _prefPending = {};
    client.patch("/api/auth/me/preferences", body).catch(() => {});
  }, 600);
}

export interface AppWindow {
  windowId: string;
  sessionId: string;
  sessionToken: string;
  appId: string;
  appName: string;
  appIcon: string;
  appType: "stream" | "web" | "kasm";
  connectUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  alwaysOnTop: boolean;
  workspace: string;
  suspended: boolean;
  muted: boolean;
  volume: number; // 0..1
}

export interface PinnedItem {
  id: string;
  type: "app" | "link";
  label: string;
  icon: string;       // URL or emoji
  appId?: string;     // type="app"
  href?: string;      // type="link"
  isSystem?: boolean; // system icons can't be removed
}

export interface LaunchInfo {
  appId: string;
  appName: string;
  appIcon: string;
}

interface DesktopStore {
  // Windows
  windows: AppWindow[];
  maxZ: number;
  // True when another tab claimed the desktop (session transfer) — this tab
  // drops its windows (sessions keep running) and shows a takeover overlay.
  detached: boolean;
  detachAll(): void;
  setDetached(v: boolean): void;
  // True while any window is being dragged/resized — all windows then block
  // their iframe so a session frame can't swallow the mouse mid-interaction.
  interacting: boolean;
  setInteracting(v: boolean): void;
  // Idle lock screen (Profile → Security). Only ever set true when the user
  // has a PIN configured — see Desktop.tsx's onIdle.
  locked: boolean;
  setLocked(v: boolean): void;
  launcherOpen: boolean;
  adminOpen: boolean;
  storageOpen: boolean;
  profileOpen: boolean;
  fileManagerOpen: boolean;
  fileManagerPath: string;
  fileManagerZ: number;
  fileManagerViewMode: "grid" | "list";
  // Launch in-progress overlay
  launching: LaunchInfo | null;
  // Desktop icons
  pinned: PinnedItem[];
  // Taskbar quick-launch (ordered app IDs)
  quickLaunch: string[];
  // Launcher favourites (app IDs) + recently launched (most-recent first)
  favorites: string[];
  recentApps: string[];
  // Wallpaper (CSS gradient or image URL)
  wallpaper: string;
  // Appearance
  theme: "dark" | "light" | "system";
  desktopLayout: "icons" | "tiles" | "clean";
  // Self-service choice — "simple" hides the taskbar/launcher/window-mgmt
  // chrome (Files + app tiles only). A group's force_simple_layout policy
  // (see Desktop.tsx) overrides this regardless of what's stored here.
  layoutMode: "desktop" | "simple";
  // Shared clipboard history (most-recent first) — bridges copy/paste between
  // session apps. Persisted to localStorage only, never synced to the server.
  clipboardHistory: string[];
  // Workspaces
  workspaces: string[];
  activeWorkspace: string;

  // Sessions closed as a window but intentionally left running (background
  // Terminal) — the continuous session adoption must not reopen them.
  dismissedSessions: string[];
  dismissSession(sessionId: string): void;

  // Window actions
  openWindow(session: Session, app: App): void;
  closeWindow(windowId: string): void;
  focusWindow(windowId: string): void;
  minimizeWindow(windowId: string): void;
  toggleMaximize(windowId: string): void;
  // Minimizes every window on the active workspace, or restores them all if
  // they're already all minimized (classic taskbar-corner "show desktop").
  showDesktop(): void;
  toggleAlwaysOnTop(windowId: string): void;
  toggleMute(windowId: string): void;
  setVolume(windowId: string, volume: number): void;
  updateBounds(windowId: string, x: number, y: number, w: number, h: number): void;
  setLauncherOpen(open: boolean): void;
  setAdminOpen(open: boolean): void;
  setStorageOpen(open: boolean): void;
  setProfileOpen(open: boolean): void;
  setFileManagerOpen(open: boolean, path?: string): void;
  focusFileManager(): void;
  setFileManagerViewMode(mode: "grid" | "list"): void;
  setLaunching(info: LaunchInfo | null): void;
  restoreFromSessions(sessions: Session[], apps: App[]): void;

  // Icon actions
  addPinned(item: PinnedItem): void;
  removePinned(id: string): void;
  ensureSystemIcons(isAdmin: boolean, ncConfigured?: boolean): void;

  // Quick launch actions
  addToQuickLaunch(appId: string): void;
  removeFromQuickLaunch(appId: string): void;

  // Favourites + recents
  toggleFavorite(appId: string): void;

  // Wallpaper + appearance
  setWallpaper(value: string): void;
  setTheme(t: "dark" | "light" | "system"): void;
  setDesktopLayout(l: "icons" | "tiles" | "clean"): void;
  setLayoutMode(m: "desktop" | "simple"): void;
  addClip(text: string): void;
  clearClips(): void;
  mergeClips(list: string[]): void;
  loadFromServer(prefs: Record<string, unknown>): void;
  // Workspaces
  switchWorkspace(id: string): void;
  moveWindowToWorkspace(windowId: string, ws: string): void;
  // Idle suspend
  suspendWindow(windowId: string): void;
  resumeWindow(windowId: string): void;
}

const DEFAULT_W = 1024;
const DEFAULT_H = 720;
const STEP = 30;

export const useDesktopStore = create<DesktopStore>()(
  persist(
    (set, get) => ({
      windows: [],
      maxZ: 10,
      dismissedSessions: [],
      dismissSession: (sessionId) => set((s) => ({
        dismissedSessions: [...s.dismissedSessions.filter((id) => id !== sessionId), sessionId].slice(-50),
      })),
      detached: false,
      detachAll: () => set({ windows: [], detached: true }),
      setDetached: (v) => set({ detached: v }),
      interacting: false,
      setInteracting: (v) => set({ interacting: v }),
      locked: false,
      setLocked: (v) => set({ locked: v }),
      launcherOpen: false,
      adminOpen: false,
      storageOpen: false,
      profileOpen: false,
      fileManagerOpen: false,
      fileManagerPath: "/",
      fileManagerZ: 10,
      fileManagerViewMode: "grid",
      launching: null,
      pinned: [],
      quickLaunch: [],
      favorites: [],
      recentApps: [],
      wallpaper: "",
      theme: "dark",
      desktopLayout: "icons",
      layoutMode: "desktop",
      clipboardHistory: [],
      workspaces: ["1", "2", "3", "4"],
      activeWorkspace: "1",

      openWindow(session, app) {
        const existing = get().windows.find((w) => w.sessionId === session.id);
        if (existing) { get().focusWindow(existing.windowId); return; }
        // Explicit relaunch of a background session un-dismisses it
        if (get().dismissedSessions.includes(session.id)) {
          set((s) => ({ dismissedSessions: s.dismissedSessions.filter((id) => id !== session.id) }));
        }

        // Track launcher recents (most-recent first, capped)
        if (app.id) {
          const recentApps = [app.id, ...get().recentApps.filter((id) => id !== app.id)].slice(0, 8);
          set({ recentApps });
          savePrefDebounced({ recentApps });
        }

        const count = get().windows.length;
        const vw = window.innerWidth;
        const vh = window.innerHeight - 48; // subtract taskbar
        // New sessions open windowed, never maximized, fitted to available space
        const w = Math.min(session.window_state?.width ?? DEFAULT_W, vw - 40);
        const h = Math.min(session.window_state?.height ?? DEFAULT_H, vh - 40);
        // Cascade: centre on first window, step for subsequent
        const baseX = Math.max(0, Math.floor((vw - w) / 2));
        const baseY = Math.max(0, Math.floor((vh - h) / 2));
        const x = session.window_state?.x ?? Math.min(baseX + count * STEP, vw - w - 20);
        const y = session.window_state?.y ?? Math.min(baseY + count * STEP, vh - h - 20);
        const nextZ = get().maxZ + 1;

        set((s) => ({
          maxZ: nextZ,
          windows: [...s.windows, {
            windowId: session.id,
            sessionId: session.id,
            sessionToken: session.session_token,
            appId: session.app_id ?? "",
            appName: session.app_name ?? app.name,
            appIcon: session.app_icon ?? app.icon_url,
            appType: session.app_type,
            connectUrl: session.connect_url,
            x, y, width: w, height: h,
            zIndex: nextZ,
            minimized: false,
            maximized: false,
            alwaysOnTop: false,
            workspace: s.activeWorkspace,
            suspended: false,
            muted: true,
            volume: 1,
          }],
        }));
      },

      closeWindow(windowId) {
        set((s) => ({ windows: s.windows.filter((w) => w.windowId !== windowId) }));
      },

      focusWindow(windowId) {
        const nextZ = get().maxZ + 1;
        set((s) => ({
          maxZ: nextZ,
          windows: s.windows.map((w) =>
            w.windowId === windowId ? { ...w, zIndex: nextZ, minimized: false } : w
          ),
        }));
      },

      minimizeWindow(windowId) {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.windowId === windowId ? { ...w, minimized: true } : w
          ),
        }));
      },

      showDesktop() {
        set((s) => {
          const onWorkspace = s.windows.filter((w) => w.workspace === s.activeWorkspace);
          const anyVisible = onWorkspace.some((w) => !w.minimized);
          return {
            windows: s.windows.map((w) =>
              w.workspace === s.activeWorkspace ? { ...w, minimized: anyVisible } : w
            ),
          };
        });
      },

      toggleAlwaysOnTop(windowId) {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.windowId === windowId ? { ...w, alwaysOnTop: !w.alwaysOnTop } : w
          ),
        }));
      },

      toggleMaximize(windowId) {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.windowId === windowId ? { ...w, maximized: !w.maximized, minimized: false } : w
          ),
        }));
      },

      toggleMute(windowId) {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.windowId === windowId ? { ...w, muted: !w.muted } : w
          ),
        }));
      },

      setVolume(windowId, volume) {
        const v = Math.max(0, Math.min(1, volume));
        set((s) => ({
          windows: s.windows.map((w) =>
            // Adjusting volume also unmutes (unless dragged to 0).
            w.windowId === windowId ? { ...w, volume: v, muted: v === 0 } : w
          ),
        }));
      },

      updateBounds(windowId, x, y, width, height) {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.windowId === windowId ? { ...w, x, y, width, height } : w
          ),
        }));
      },

      setLauncherOpen(open) { set({ launcherOpen: open }); },
      setAdminOpen(open) { set({ adminOpen: open }); },
      setStorageOpen(open) { set({ storageOpen: open }); },
      setProfileOpen(open) { set({ profileOpen: open }); },
      setFileManagerOpen(open, path) {
        const nextZ = get().maxZ + 1;
        set({ fileManagerOpen: open, fileManagerPath: path ?? "/", fileManagerZ: nextZ, maxZ: nextZ });
      },
      focusFileManager() {
        const nextZ = get().maxZ + 1;
        set({ fileManagerZ: nextZ, maxZ: nextZ });
      },
      setFileManagerViewMode(mode) {
        set({ fileManagerViewMode: mode });
        savePrefDebounced({ fileManagerViewMode: mode });
      },
      setLaunching(info) { set({ launching: info }); },

      restoreFromSessions(sessions, apps) {
        const appMap = Object.fromEntries(apps.map((a) => [a.id, a]));
        // Append to existing windows (continuous adoption) — never clobber
        const wins: AppWindow[] = [...get().windows];
        const open = new Set(wins.map((w) => w.sessionId));
        let maxZ = get().maxZ;

        const dismissed = new Set(get().dismissedSessions);
        for (const sess of sessions) {
          if (open.has(sess.id)) continue;
          if (dismissed.has(sess.id)) continue;  // running in background on purpose
          if (!sess.app_id || !appMap[sess.app_id]) continue;
          const app = appMap[sess.app_id];
          const vw = window.innerWidth;
          const vh = window.innerHeight - 48;
          const w = sess.window_state?.width ?? Math.min(DEFAULT_W, vw - 80);
          const h = sess.window_state?.height ?? Math.min(DEFAULT_H, vh - 80);
          wins.push({
            windowId: sess.id,
            sessionId: sess.id,
            sessionToken: sess.session_token,
            appId: sess.app_id,
            appName: sess.app_name ?? app.name,
            appIcon: sess.app_icon ?? app.icon_url,
            appType: sess.app_type,
            connectUrl: sess.connect_url,
            x: sess.window_state?.x ?? 60 + wins.length * STEP,
            y: sess.window_state?.y ?? 60 + wins.length * STEP,
            width: w, height: h,
            zIndex: ++maxZ,
            minimized: sess.window_state?.minimized ?? false,
            maximized: sess.window_state?.maximized ?? false,
            alwaysOnTop: false,
            workspace: "1",
            suspended: sess.status === "suspended",
            muted: true,
            volume: 1,
          });
        }
        set({ windows: wins, maxZ });
      },

      addPinned(item) {
        const exists = get().pinned.some((p) => p.id === item.id);
        if (!exists) {
          set((s) => {
            const pinned = [...s.pinned, item];
            savePrefDebounced({ pinned });
            return { pinned };
          });
        }
      },

      removePinned(id) {
        set((s) => {
          const pinned = s.pinned.filter((p) => p.id !== id || p.isSystem);
          savePrefDebounced({ pinned });
          return { pinned };
        });
      },

      ensureSystemIcons(isAdmin, ncConfigured = false) {
        const adminIcon: PinnedItem = {
          id: "__admin__",
          type: "link",
          label: "Admin",
          icon: "🛡️",
          href: "/admin",
          isSystem: true,
        };
        const filesIcon: PinnedItem = {
          id: "__files__",
          type: "link",
          label: "Files",
          icon: "🗂️",
          href: "/storage",
          isSystem: true,
        };
        set((s) => {
          let pinned = [...s.pinned];

          const hasAdmin = pinned.some((p) => p.id === "__admin__");
          if (isAdmin && !hasAdmin) pinned = [adminIcon, ...pinned];
          if (!isAdmin && hasAdmin) pinned = pinned.filter((p) => p.id !== "__admin__");
          // Always sync icon in case it changed
          if (isAdmin && hasAdmin) pinned = pinned.map((p) => p.id === "__admin__" ? { ...p, icon: adminIcon.icon } : p);

          const hasFiles = pinned.some((p) => p.id === "__files__");
          if (ncConfigured && !hasFiles) pinned = [...pinned, filesIcon];
          if (!ncConfigured && hasFiles) pinned = pinned.filter((p) => p.id !== "__files__");

          return { pinned };
        });
      },

      addToQuickLaunch(appId) {
        set((s) => {
          if (s.quickLaunch.includes(appId)) return s;
          const quickLaunch = [...s.quickLaunch, appId];
          savePrefDebounced({ quickLaunch });
          return { quickLaunch };
        });
      },

      removeFromQuickLaunch(appId) {
        set((s) => {
          const quickLaunch = s.quickLaunch.filter((id) => id !== appId);
          savePrefDebounced({ quickLaunch });
          return { quickLaunch };
        });
      },

      toggleFavorite(appId) {
        set((s) => {
          const favorites = s.favorites.includes(appId)
            ? s.favorites.filter((id) => id !== appId)
            : [...s.favorites, appId];
          savePrefDebounced({ favorites });
          return { favorites };
        });
      },

      setWallpaper(value) {
        set({ wallpaper: value });
        savePrefDebounced({ wallpaper: value });
      },
      setTheme(t) {
        set({ theme: t });
        savePrefDebounced({ theme: t });
      },
      setDesktopLayout(l) {
        set({ desktopLayout: l });
        savePrefDebounced({ desktopLayout: l });
      },
      setLayoutMode(m) {
        set({ layoutMode: m });
        savePrefDebounced({ layoutMode: m });
      },

      addClip(text) {
        const t = text.replace(/\r/g, "");
        if (!t.trim()) return;
        set((s) => ({
          clipboardHistory: [t, ...s.clipboardHistory.filter((c) => c !== t)].slice(0, 25),
        }));
        if (clipboardSyncEnabled()) savePrefDebounced({ clipboard_history: get().clipboardHistory });
      },
      clearClips() {
        set({ clipboardHistory: [] });
        if (clipboardSyncEnabled()) savePrefDebounced({ clipboard_history: [] });
      },
      mergeClips(list) {
        if (!list?.length) return;
        set((s) => ({
          clipboardHistory: [...new Set([...s.clipboardHistory, ...list])].slice(0, 25),
        }));
      },

      switchWorkspace(id) { set({ activeWorkspace: id }); },

      moveWindowToWorkspace(windowId, ws) {
        set((s) => ({
          windows: s.windows.map((w) => w.windowId === windowId ? { ...w, workspace: ws } : w),
        }));
      },

      suspendWindow(windowId) {
        set((s) => ({
          windows: s.windows.map((w) => w.windowId === windowId ? { ...w, suspended: true } : w),
        }));
      },

      resumeWindow(windowId) {
        set((s) => ({
          windows: s.windows.map((w) => w.windowId === windowId ? { ...w, suspended: false } : w),
        }));
      },

      loadFromServer(prefs) {
        const patch: Partial<DesktopStore> = {};
        if (prefs.wallpaper          !== undefined) patch.wallpaper          = prefs.wallpaper          as string;
        if (prefs.theme              !== undefined) patch.theme              = prefs.theme              as "dark" | "light" | "system";
        if (prefs.desktopLayout      !== undefined) patch.desktopLayout      = prefs.desktopLayout      as "icons" | "tiles" | "clean";
        if (prefs.layoutMode         !== undefined) patch.layoutMode         = prefs.layoutMode         as "desktop" | "simple";
        if (prefs.fileManagerViewMode !== undefined) patch.fileManagerViewMode = prefs.fileManagerViewMode as "grid" | "list";
        if (Array.isArray(prefs.pinned))       patch.pinned        = prefs.pinned        as PinnedItem[];
        if (Array.isArray(prefs.quickLaunch))  patch.quickLaunch   = prefs.quickLaunch   as string[];
        if (Array.isArray(prefs.favorites))    patch.favorites     = prefs.favorites     as string[];
        if (Array.isArray(prefs.recentApps))   patch.recentApps    = prefs.recentApps    as string[];
        if (Object.keys(patch).length) set(patch);
      },
    }),
    {
      name: "lwp-desktop",
      // Only persist non-volatile UI state
      partialize: (s) => ({
        pinned: s.pinned, quickLaunch: s.quickLaunch,
        favorites: s.favorites, recentApps: s.recentApps,
        wallpaper: s.wallpaper, theme: s.theme, desktopLayout: s.desktopLayout, layoutMode: s.layoutMode,
        fileManagerViewMode: s.fileManagerViewMode,
        clipboardHistory: s.clipboardHistory,
        workspaces: s.workspaces, activeWorkspace: s.activeWorkspace,
        dismissedSessions: s.dismissedSessions,
      }),
    }
  )
);
