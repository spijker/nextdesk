import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import client from "@/api/client";
import type { App, Session } from "@/types";
import { useDesktopStore, type PinnedItem } from "@/store/desktop";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { cn } from "@/lib/utils";
import { appIconUrl, LWP_LOGO } from "@/lib/appIcon";

interface Props {
  item: PinnedItem;
  apps: App[];
  selected?: boolean;
}

export function DesktopIcon({ item, apps, selected }: Props) {
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [pressed, setPressed] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { openWindow, removePinned, setAdminOpen, profileOpen, setProfileOpen, setFileManagerOpen, setLaunching } = useDesktopStore();

  const launch = useMutation({
    mutationFn: (appId: string) =>
      client.post<Session>("/api/sessions", { app_id: appId }),
    onSuccess: (res) => {
      const app = apps.find((a) => a.id === item.appId);
      setLaunching(null);
      if (app) openWindow(res.data, app);
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (e: any) => {
      setLaunching(null);
      toast.error(e.response?.data?.detail ?? "Launch failed");
    },
  });

  const activate = () => {
    if (item.id === "__admin__")   { setAdminOpen(true);   return; }
    if (item.id === "__files__")   { setFileManagerOpen(true); return; }
    if (item.id === "__profile__") { setProfileOpen(!profileOpen); return; }
    if (item.type === "link" && item.href) {
      navigate(item.href);
    } else if (item.type === "app" && item.appId && !launch.isPending) {
      const app = apps.find((a) => a.id === item.appId);
      if (app) {
        setLaunching({
          appId: app.id,
          appName: app.name,
          appIcon: appIconUrl(app),
        });
      }
      launch.mutate(item.appId);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY });
  };

  const menuItems: MenuItem[] = [
    {
      label: item.type === "link" ? "Open" : "Launch",
      icon: item.type === "link" ? "🔗" : "▶️",
      onClick: activate,
    },
  ];
  if (!item.isSystem) {
    menuItems.push({ label: "", onClick: () => {}, divider: true } as any);
    menuItems.push({
      label: "Remove from desktop",
      icon: "🗑️",
      danger: true,
      onClick: () => removePinned(item.id),
    });
  }

  const pending = launch.isPending;

  return (
    <>
      <button
        data-desktop-icon={item.id}
        onClick={activate}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        onMouseLeave={() => setPressed(false)}
        onContextMenu={handleContextMenu}
        disabled={pending}
        style={{ width: 80 }}
        className={cn(
          "group flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-white/10 active:bg-white/20 disabled:cursor-default",
          selected && "bg-indigo-500/25 ring-1 ring-indigo-400/60",
        )}
      >
        <div
          className="relative flex h-14 w-14 items-center justify-center rounded-xl text-4xl shadow-lg transition-transform duration-100"
          style={{ transform: pressed && !pending ? "scale(0.88)" : pending ? "scale(0.93)" : "scale(1)" }}
        >
          {/* Pending ring */}
          {pending && (
            <span className="absolute inset-0 rounded-xl border-2 border-white/40 animate-ping" />
          )}

          {item.icon && item.icon.startsWith("http") ? (
            <img
              src={item.icon}
              alt=""
              className={`h-10 w-10 object-contain drop-shadow transition-opacity ${pending ? "opacity-60" : ""}`}
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                if (img.src !== LWP_LOGO) img.src = LWP_LOGO;
              }}
            />
          ) : (
            <span className={`drop-shadow transition-opacity ${pending ? "opacity-60" : ""}`}>
              {item.icon || "🖥️"}
            </span>
          )}
        </div>

        <span
          className="w-full truncate text-center text-xs font-medium text-white drop-shadow"
          style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}
        >
          {item.label}
        </span>
      </button>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={menuItems}
          onClose={() => setCtx(null)}
        />
      )}
    </>
  );
}
