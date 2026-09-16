import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import type { App, Session } from "@/types";
import { useDesktopStore } from "@/store/desktop";
import { cn } from "@/lib/utils";
import { appIconUrl, LWP_LOGO } from "@/lib/appIcon";

interface Props { apps: App[] }

export function DesktopTiles({ apps }: Props) {
  const { windows, setLaunching, openWindow, focusWindow, setFileManagerOpen } = useDesktopStore();

  const launch = useMutation({
    mutationFn: (appId: string) => client.post<Session>(`/api/sessions`, { app_id: appId }),
    onMutate: (appId) => {
      const app = apps.find((a) => a.id === appId);
      if (app) setLaunching({ appId, appName: app.name, appIcon: appIconUrl(app) });
    },
    onSuccess: (res) => {
      setLaunching(null);
      const app = apps.find((a) => a.id === res.data.app_id);
      if (app) openWindow(res.data, app);
    },
    onError: (e: any) => {
      setLaunching(null);
      toast.error(e.response?.data?.detail ?? "Launch failed");
    },
  });

  const handleClick = (app: App) => {
    const running = windows.find((w) => w.appId === app.id);
    if (running) { focusWindow(running.windowId); return; }
    launch.mutate(app.id);
  };

  if (!apps.length) return null;

  return (
    <div className="absolute inset-x-0 top-0 bottom-12 overflow-y-auto p-6 pb-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
        {/* Files system tile */}
        <button
          onClick={() => setFileManagerOpen(true)}
          className="group flex flex-col items-center gap-2 rounded-2xl px-2 py-4 text-center transition-all bg-white/8 hover:bg-white/15 active:scale-95"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-xl">
            🗂️
          </div>
          <span className="text-xs font-medium text-white/80 leading-tight">Files</span>
        </button>

        {apps.map((app) => {
          const running = windows.some((w) => w.appId === app.id);
          const isLaunching = launch.isPending && (launch.variables as string) === app.id;
          return (
            <button
              key={app.id}
              onClick={() => handleClick(app)}
              disabled={isLaunching}
              className={cn(
                "group flex flex-col items-center gap-2 rounded-2xl px-2 py-4 text-center transition-all",
                "bg-white/8 hover:bg-white/15 active:scale-95",
                running && "ring-1 ring-white/20",
              )}
            >
              {isLaunching ? (
                <Loader2 className="h-10 w-10 animate-spin text-white/40" />
              ) : (
                <img
                  src={appIconUrl(app)}
                  alt=""
                  className="h-10 w-10 rounded-xl object-contain"
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    if (img.src !== LWP_LOGO) img.src = LWP_LOGO;
                  }}
                />
              )}
              <span className="text-xs font-medium text-white/80 leading-tight line-clamp-2">
                {app.name}
              </span>
              {running && (
                <span className="h-1 w-1 rounded-full bg-white/60" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
