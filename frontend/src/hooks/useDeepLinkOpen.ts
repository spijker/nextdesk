import { useEffect } from "react";
import { toast } from "sonner";
import client from "@/api/client";
import { useDesktopStore } from "@/store/desktop";
import { isOffice } from "@/lib/fileType";
import type { App, Session } from "@/types";

function parentDirOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function stripOpenParam() {
  const url = new URL(window.location.href);
  url.searchParams.delete("open");
  const qs = url.searchParams.toString();
  window.history.replaceState(null, "", url.pathname + (qs ? `?${qs}` : ""));
}

/**
 * Lands a "?open=<nc-path>" deep link (from Nextcloud's "Open in Nextdesk"
 * Files action) on the right thing: Office docs launch/reuse a LibreOffice
 * session with the file open (the same flow as the File Manager's "Open
 * with…" — see FileManagerWindow.tsx), everything else opens the File
 * Manager at the file's folder. Nextcloud only offers the action for
 * extensions Nextdesk can already handle, so there's no "unsupported type"
 * case to design for here.
 */
export function useDeepLinkOpen(apps: App[]) {
  useEffect(() => {
    if (!apps.length) return;
    const openPath = new URLSearchParams(window.location.search).get("open");
    if (!openPath) return;

    const name = openPath.split("/").pop() ?? openPath;
    if (isOffice({ name, type: "file" })) {
      const app = apps.find((a) => a.name === "LibreOffice");
      if (!app) {
        toast.error("LibreOffice isn't available to open this file");
        stripOpenParam();
        return;
      }
      client
        .post<Session>("/api/sessions", { app_id: app.id, open_path: openPath })
        .then((res) => {
          useDesktopStore.getState().openWindow(res.data, app);
          toast.success(`Opening in ${app.name}…`);
        })
        .catch((e: unknown) => {
          const err = e as { response?: { data?: { detail?: string } } };
          toast.error(err.response?.data?.detail ?? "Launch failed");
        })
        .finally(stripOpenParam);
      return;
    }

    useDesktopStore.getState().setFileManagerOpen(true, parentDirOf(openPath));
    stripOpenParam();
  }, [apps]);
}
