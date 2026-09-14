import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Rocket, HardDrive, CheckSquare, Square } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import client from "@/api/client";
import type { App, StorageConfig } from "@/types";
import { cn } from "@/lib/utils";

interface Props {
  image: App;
  onClose: () => void;
}

export function LaunchDialog({ image, onClose }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [selectedStorage, setSelectedStorage] = useState<Set<string>>(new Set());

  const { data: storageConfigs = [] } = useQuery<StorageConfig[]>({
    queryKey: ["storage"],
    queryFn: () => client.get("/api/storage").then((r) => r.data),
  });

  const launch = useMutation({
    mutationFn: () =>
      client.post("/api/sessions", {
        image_id: image.id,
        storage_ids: Array.from(selectedStorage),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(`Launched ${image.name}`, {
        action: {
          label: "Open",
          onClick: () => navigate(`/session/${res.data.session_token}`),
        },
      });
      onClose();
    },
    onError: (e: any) => {
      toast.error(e.response?.data?.detail ?? "Launch failed");
    },
  });

  const toggle = (id: string) => {
    setSelectedStorage((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const PROVIDER_ICONS: Record<string, string> = {
    sftp: "🔑", s3: "🪣", webdav: "🌐", gdrive: "📂", onedrive: "☁️",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl dark:bg-gray-900">
        <div className="flex items-center justify-between p-6 pb-4">
          <div>
            <h2 className="text-lg font-bold">Launch {image.name}</h2>
            <p className="mt-0.5 text-sm text-gray-500">{image.description}</p>
          </div>
          <button onClick={onClose}><X className="h-5 w-5 text-gray-400" /></button>
        </div>

        {/* Storage selector */}
        <div className="px-6 pb-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            <HardDrive className="h-4 w-4" />
            Storage mounts
          </div>

          {storageConfigs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-200 p-4 text-center text-xs text-gray-400 dark:border-gray-700">
              No storage configured.{" "}
              <a href="/storage" className="text-brand-500 hover:underline">Add connections</a>{" "}
              to mount SFTP, S3, or WebDAV inside your desktop.
            </p>
          ) : (
            <div className="space-y-2">
              {storageConfigs.map((sc) => {
                const selected = selectedStorage.has(sc.id);
                return (
                  <button
                    key={sc.id}
                    onClick={() => toggle(sc.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                      selected
                        ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20"
                        : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
                    )}
                  >
                    {selected
                      ? <CheckSquare className="h-4 w-4 shrink-0 text-brand-500" />
                      : <Square className="h-4 w-4 shrink-0 text-gray-400" />}
                    <span className="text-lg">{PROVIDER_ICONS[sc.provider] ?? "💾"}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{sc.name}</p>
                      <p className="truncate text-xs text-gray-400">{sc.mount_path}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedStorage.size > 0 && (
          <p className="mx-6 mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            Storage mounts appear in the desktop within ~15 seconds after launch (rclone installs on first use).
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-gray-100 p-4 dark:border-gray-800">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button
            onClick={() => launch.mutate()}
            disabled={launch.isPending}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            <Rocket className="h-4 w-4" />
            {launch.isPending ? "Launching…" : "Launch"}
          </button>
        </div>
      </div>
    </div>
  );
}
