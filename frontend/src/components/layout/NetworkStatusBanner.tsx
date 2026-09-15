import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

// Purely cosmetic connectivity awareness for the installed-app shell — there
// is no real "offline mode" here (sessions are live VNC/websocket streams),
// this just replaces a silently-broken UI with an honest "you're offline"
// banner while the browser's online/offline events say the network is down.
export function NetworkStatusBanner() {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[99999] flex items-center justify-center gap-2 bg-amber-500/95 px-3 py-1.5 text-xs font-semibold text-black shadow-lg">
      <WifiOff className="h-3.5 w-3.5" />
      You're offline — reconnecting when the network comes back
    </div>
  );
}
