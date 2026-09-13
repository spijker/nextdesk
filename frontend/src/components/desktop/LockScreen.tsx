import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import client from "@/api/client";
import { useAuthStore } from "@/store/auth";
import { NcAvatar } from "./NcAvatar";

/** Idle privacy screen — re-gates an already-authenticated tab, not a real
 * sign-out. Sessions keep running behind it; see Desktop.tsx's onIdle. */
export function LockScreen({ onUnlock }: { onUnlock(): void }) {
  const user = useAuthStore((s) => s.user);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const verify = useMutation({
    mutationFn: () => client.post("/api/auth/lock-pin/verify", { pin }),
    onSuccess: () => onUnlock(),
    onError: (e: any) => {
      setError(e.response?.data?.detail ?? "Incorrect PIN");
      setPin("");
      inputRef.current?.focus();
    },
  });

  const submit = () => {
    if (pin.length < 4 || verify.isPending) return;
    verify.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-[999999] flex flex-col items-center justify-center gap-6 bg-black/80 backdrop-blur-xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="text-center text-white/90">
        <div className="text-5xl font-light tabular-nums">
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="mt-1 text-sm text-white/50">
          {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        </div>
      </div>

      <NcAvatar name={user?.display_name || user?.username} size={72} />
      <p className="-mt-4 text-sm font-medium text-white/80">{user?.display_name || user?.username}</p>

      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2 text-white/40">
          <LockKeyhole className="h-3.5 w-3.5" />
          <span className="text-xs">Locked — enter your PIN to continue</span>
        </div>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          autoFocus
          value={pin}
          onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          className="w-48 rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-center font-mono text-2xl tracking-[0.5em] text-white outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/50"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          onClick={submit}
          disabled={pin.length < 4 || verify.isPending}
          className="mt-2 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {verify.isPending ? "Checking…" : "Unlock"}
        </button>
      </div>
    </div>
  );
}
