import { useEffect, useState } from "react";
import { UserCircle, LogOut, Settings } from "lucide-react";
import client from "@/api/client";
import { useAuthStore } from "@/store/auth";
import { useDesktopStore } from "@/store/desktop";
import { LogoutDialog, FullscreenButton } from "./Taskbar";

/** Simple mode's entire menu chrome: one small corner button. Everything
 * else (launcher, taskbar, window switcher, command palette) is deliberately
 * absent — see Desktop.tsx. Profile/logout still need *some* way in. */
export function SimpleModeMenu() {
  const [open, setOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const setProfileOpen = useDesktopStore((s) => s.setProfileOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const handleLogout = async () => {
    setOpen(false);
    const { data: prefs } = await client.get("/api/auth/me/preferences").catch(() => ({ data: {} }));
    const saved: string | undefined = prefs?.logout_sessions;
    if (saved === "keep" || saved === "stop") {
      if (saved === "stop") await client.delete("/api/sessions").catch(() => {});
      await client.post("/api/auth/logout").catch(() => {});
      useAuthStore.getState().setUser(null);
      window.location.href = "/login";
    } else {
      setLogoutOpen(true);
    }
  };

  return (
    <div data-no-ctx className="fixed right-3 top-3 z-[9500] flex items-center gap-2 rounded-full bg-black/30 p-0.5 backdrop-blur-md">
      <FullscreenButton />

      <button
        onClick={() => setOpen((v) => !v)}
        title="Profile & log out"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white/70 backdrop-blur-md transition-colors hover:bg-black/50 hover:text-white"
      >
        <UserCircle className="h-5 w-5" />
      </button>

      {open && (
        <>
          {/* Transparent click-away catcher — MUST have a lower z-index than
              the menu panel below, or (per CSS stacking rules) this explicit
              z-index paints over the panel's implicit "auto" one regardless
              of DOM order, silently swallowing every click on it. */}
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-[9999] w-48 rounded-xl border border-white/10 bg-gray-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
            <button
              onClick={() => { setOpen(false); setProfileOpen(true); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Settings className="h-3.5 w-3.5" /> Profile & settings
            </button>
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-white/10 hover:text-red-300"
            >
              <LogOut className="h-3.5 w-3.5" /> Log out
            </button>
          </div>
        </>
      )}

      {logoutOpen && <LogoutDialog onClose={() => setLogoutOpen(false)} />}
    </div>
  );
}
