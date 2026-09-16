import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, X, UserCircle, Star } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import type { App, Session } from "@/types";
import { useDesktopStore } from "@/store/desktop";
import { useAuthStore } from "@/store/auth";
import { ContextMenu } from "./ContextMenu";
import { cn } from "@/lib/utils";
import { appIconUrl, LWP_LOGO } from "@/lib/appIcon";

// Badge distinguishing web-native apps from VNC desktop apps.
function appBadge(app: App): { label: string; cls: string } {
  if (app.web_native) return { label: "Web", cls: "bg-teal-500/20 text-teal-300" };
  if (app.app_type === "web") return { label: "Web app", cls: "bg-blue-500/20 text-blue-300" };
  return { label: "Desktop", cls: "bg-purple-500/20 text-purple-300" };
}

function AppRow({
  app, isRunning, isPinned, isInQuickLaunch, isLaunching, isFavorite, onLaunch, onContext,
}: {
  app: App;
  isRunning: boolean;
  isPinned: boolean;
  isInQuickLaunch: boolean;
  isLaunching: boolean;
  isFavorite: boolean;
  onLaunch(): void;
  onContext(e: React.MouseEvent): void;
}) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("lwp/appId", app.id);
    e.dataTransfer.setData("lwp/appName", app.name);
    e.dataTransfer.setData("lwp/appIcon", appIconUrl(app));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <button
      draggable
      onDragStart={handleDragStart}
      onClick={onLaunch}
      onContextMenu={onContext}
      disabled={isLaunching}
      className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors select-none hover:bg-white/10 active:bg-white/15 disabled:opacity-60"
    >
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10">
        {isLaunching && <span className="absolute inset-0 rounded-lg border-2 border-white/40 animate-ping" />}
        <img
          src={appIconUrl(app)}
          alt=""
          className="h-7 w-7 object-contain"
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            if (img.src !== LWP_LOGO) img.src = LWP_LOGO;
          }}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-white/90 group-hover:text-white">{app.name}</span>
          {isFavorite && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
          {isRunning && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" title="Running" />}
          {isPinned && !isRunning && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" title="On desktop" />}
          {isInQuickLaunch && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="In taskbar" />}
        </div>
        {app.description && (
          <div className="truncate text-xs text-white/40">{app.description}</div>
        )}
      </div>

      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px]", appBadge(app).cls)}>
        {appBadge(app).label}
      </span>
    </button>
  );
}

export function AppLauncher({ onClose }: { onClose(): void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [appCtx, setAppCtx] = useState<{ app: App; x: number; y: number } | null>(null);
  // Dragging an app row out to the taskbar crosses the panel's own edge
  // mid-drag — without this guard that would close the launcher and cancel
  // the drop. dragstart/dragend bubble up from AppRow, no prop drilling needed.
  const [dragging, setDragging] = useState(false);
  const {
    openWindow, windows, addPinned, removePinned, pinned,
    setLaunching, setFileManagerOpen,
    quickLaunch, addToQuickLaunch, removeFromQuickLaunch,
    favorites, recentApps, toggleFavorite,
  } = useDesktopStore();
  const { user } = useAuthStore();
  const qc = useQueryClient();
  const [launchingId, setLaunchingId] = useState<string | null>(null);

  const { data: apps = [], isLoading } = useQuery<App[]>({
    queryKey: ["apps"],
    queryFn: () => client.get("/api/apps").then((r) => r.data),
  });

  // Virtual categories (favourites/recent) precede the catalog ones
  const appIds = new Set(apps.map((a) => a.id));
  const favIds = favorites.filter((id) => appIds.has(id));
  const recentIds = recentApps.filter((id) => appIds.has(id));
  const categories = [
    ...(favIds.length ? ["★ Favorites"] : []),
    ...(recentIds.length ? ["Recent"] : []),
    ...Array.from(new Set(apps.map((a) => a.category))).sort(),
    "System",
  ];
  useEffect(() => {
    if (!category && categories.length) setCategory(categories[0]);
  }, [categories.length]);

  const launch = useMutation({
    mutationFn: (appId: string) =>
      client.post<Session>("/api/sessions", { app_id: appId }),
    onSuccess: (res, appId) => {
      const app = apps.find((a) => a.id === appId)!;
      setLaunchingId(null);
      setLaunching(null);
      openWindow(res.data, app);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      onClose();
    },
    onError: (e: any) => {
      setLaunchingId(null);
      setLaunching(null);
      toast.error(e.response?.data?.detail ?? "Launch failed");
    },
  });

  const handleLaunch = (app: App) => {
    if (launchingId) return;
    setLaunchingId(app.id);
    setLaunching({ appId: app.id, appName: app.name, appIcon: appIconUrl(app) });
    launch.mutate(app.id);
  };

  const runningAppIds = new Set(windows.map((w) => w.appId));
  const pinnedAppIds = new Set(pinned.map((p) => p.appId).filter(Boolean));
  const quickLaunchSet = new Set(quickLaunch);

  // When searching, show all apps regardless of category
  const filtered = search
    ? apps.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.description.toLowerCase().includes(search.toLowerCase())
      ).sort((a, b) =>
        (Number(!!a.web_native) - Number(!!b.web_native)) || a.name.localeCompare(b.name)
      )
    : category === "★ Favorites"
    ? favIds.map((id) => apps.find((a) => a.id === id)!).filter(Boolean)
    : category === "Recent"
    ? recentIds.map((id) => apps.find((a) => a.id === id)!).filter(Boolean)
    : apps.filter((a) => a.category === category).sort((a, b) =>
        // Group desktop (VNC) apps first, then web-native, then alphabetical.
        (Number(!!a.web_native) - Number(!!b.web_native)) || a.name.localeCompare(b.name)
      );

  const showSystemTile =
    search
      ? "files".includes(search.toLowerCase())
      : category === "System";

  const togglePin = (app: App) => {
    if (pinnedAppIds.has(app.id)) {
      const item = pinned.find((p) => p.appId === app.id);
      if (item) removePinned(item.id);
    } else {
      addPinned({
        id: `app-${app.id}`,
        type: "app",
        label: app.name,
        icon: appIconUrl(app),
        appId: app.id,
      });
    }
  };

  const toggleQuickLaunch = (app: App) => {
    if (quickLaunchSet.has(app.id)) {
      removeFromQuickLaunch(app.id);
    } else {
      addToQuickLaunch(app.id);
    }
  };

  return (
    <>
      <div
        className="fixed bottom-14 left-2 z-[8999] w-[min(560px,calc(100vw-1rem))]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        onMouseLeave={() => { if (!dragging) onClose(); }}
      >
        <div className="flex h-[520px] max-h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-2xl bg-black/85 shadow-2xl backdrop-blur-xl ring-1 ring-white/10">
          {/* Search */}
          <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-white/40" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search applications…"
              className="flex-1 bg-transparent text-sm text-white placeholder-white/30 outline-none"
            />
            <button onClick={onClose} className="text-white/40 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body: category sidebar + app list (KDE Kickoff style) */}
          <div className="flex min-h-0 flex-1">
            {/* Categories — hidden while searching */}
            {!search && (
              <div className="w-40 shrink-0 overflow-y-auto border-r border-white/10 p-2">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onMouseEnter={() => setCategory(cat)}
                    onClick={() => setCategory(cat)}
                    className={cn(
                      "mb-0.5 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      category === cat
                        ? "bg-white/15 font-medium text-white"
                        : "text-white/50 hover:bg-white/5 hover:text-white/80",
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}

            {/* App list */}
            <div className="flex-1 overflow-y-auto p-2">
              {isLoading ? (
                <div className="space-y-1">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-14 animate-pulse rounded-lg bg-white/5" />
                  ))}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {/* System — Files */}
                  {showSystemTile && (
                    <button
                      onClick={() => { setFileManagerOpen(true); onClose(); }}
                      className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors select-none hover:bg-white/10 active:bg-white/15"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10">
                        <span className="text-xl">🗂️</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white/90 group-hover:text-white">Files</div>
                        <div className="truncate text-xs text-white/40">Browse and manage your files</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] text-green-300">System</span>
                    </button>
                  )}

                  {filtered.length === 0 && !showSystemTile && (
                    <p className="py-12 text-center text-sm text-white/30">No applications found</p>
                  )}

                  {filtered.map((app) => (
                    <AppRow
                      key={app.id}
                      app={app}
                      isRunning={runningAppIds.has(app.id)}
                      isPinned={pinnedAppIds.has(app.id)}
                      isInQuickLaunch={quickLaunchSet.has(app.id)}
                      isLaunching={launchingId === app.id}
                      isFavorite={favorites.includes(app.id)}
                      onLaunch={() => handleLaunch(app)}
                      onContext={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setAppCtx({ app, x: e.clientX, y: e.clientY });
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* User footer */}
          <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
            <UserCircle className="h-5 w-5 shrink-0 text-white/40" />
            <span className="truncate text-xs text-white/60">{user?.display_name || user?.username}</span>
          </div>
        </div>
      </div>

      {/* Right-click menu on app row */}
      {appCtx && (
        <ContextMenu
          x={appCtx.x}
          y={appCtx.y}
          items={[
            { label: "Launch", icon: "▶️", onClick: () => handleLaunch(appCtx.app) },
            {
              label: favorites.includes(appCtx.app.id) ? "Remove from favorites" : "Add to favorites",
              icon: "⭐",
              onClick: () => toggleFavorite(appCtx.app.id),
            },
            {
              label: pinnedAppIds.has(appCtx.app.id) ? "Unpin from desktop" : "Pin to desktop",
              icon: "📌",
              onClick: () => togglePin(appCtx.app),
            },
            {
              label: quickLaunchSet.has(appCtx.app.id) ? "Remove from taskbar" : "Pin to taskbar",
              icon: "⊞",
              onClick: () => toggleQuickLaunch(appCtx.app),
            },
          ]}
          onClose={() => setAppCtx(null)}
        />
      )}
    </>
  );
}
