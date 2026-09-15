import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Rnd } from "react-rnd";
import { Minus, Maximize2, Minimize2, X, Clipboard, Volume2, VolumeX, RefreshCw, Wifi, Share2, Copy, Trash2, Check, Zap, Shield, Pin } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import client from "@/api/client";
import type { App, Session } from "@/types";
import { useAuthStore } from "@/store/auth";
import { useDesktopStore, type AppWindow } from "@/store/desktop";
import { useSessionHealth } from "@/hooks/useSessionHealth";
import { VideoMode } from "./VideoMode";
import { attachActivity } from "@/lib/activity";
import { attachClipboardCapture, captureSnapshot, dropSnapshot, pushToVncSessions, registerFrame, unregisterFrame } from "@/lib/sessionFrames";
import { useVncDisplayMode, vncQueryString } from "@/lib/vncDisplay";
import { cn } from "@/lib/utils";

const TASKBAR_H = 48;
const SNAP_PX   = 18; // px from edge/top to trigger snap zone
const CORNER_PX = 40; // corners are a smaller target — give them more room, checked before the edges below

type SnapZone = "maximize" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | null;

function getSnapZone(mx: number, my: number): SnapZone {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Corners take priority — they'd otherwise also match the edge checks below.
  if (mx <= CORNER_PX && my <= CORNER_PX) return "top-left";
  if (mx >= vw - CORNER_PX && my <= CORNER_PX) return "top-right";
  if (mx <= CORNER_PX && my >= vh - CORNER_PX) return "bottom-left";
  if (mx >= vw - CORNER_PX && my >= vh - CORNER_PX) return "bottom-right";
  if (my <= SNAP_PX) return "maximize";
  if (mx <= SNAP_PX) return "left";
  if (mx >= vw - SNAP_PX) return "right";
  return null;
}

/** Translucent blue snap-target preview rendered at desktop level */
function SnapPreview({ zone }: { zone: NonNullable<SnapZone> }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight - TASKBAR_H;
  const halfW = vw / 2;
  const halfH = vh / 2;
  const style =
    zone === "maximize"    ? { left: 0,     top: 0,     width: vw,    height: vh }    :
    zone === "left"        ? { left: 0,     top: 0,     width: halfW, height: vh }    :
    zone === "right"       ? { left: halfW, top: 0,     width: halfW, height: vh }    :
    zone === "top-left"    ? { left: 0,     top: 0,     width: halfW, height: halfH } :
    zone === "top-right"   ? { left: halfW, top: 0,     width: halfW, height: halfH } :
    zone === "bottom-left" ? { left: 0,     top: halfH, width: halfW, height: halfH } :
                              { left: halfW, top: halfH, width: halfW, height: halfH };
  return (
    <div
      className="pointer-events-none fixed z-[9990] rounded-2xl border border-indigo-400/25 bg-indigo-500/10 backdrop-blur-[2px] transition-all duration-100"
      style={{ ...style, boxSizing: "border-box" }}
    />
  );
}

interface Props { win: AppWindow }

export function Window({ win }: Props) {
  const {
    focusWindow, minimizeWindow, toggleMaximize, closeWindow, toggleMute,
    setVolume, updateBounds, maxZ, interacting, setInteracting, resumeWindow,
    dismissSession, toggleAlwaysOnTop,
  } = useDesktopStore();
  const qc          = useQueryClient();
  // WebCodecs beta: replace the VNC iframe with a low-latency H.264 canvas (view-only)
  const [videoMode, setVideoMode] = useState(false);
  const iframeRef   = useRef<HTMLIFrameElement>(null);
  const saveTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Interaction states — when true, a transparent overlay blocks the iframe
  const [dragging,  setDragging]  = useState(false);
  const [resizing,  setResizing]  = useState(false);
  const [snapZone,  setSnapZone]  = useState<SnapZone>(null);

  // Apply mute to iframe media whenever win.muted changes
  useEffect(() => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (!doc) return;
      doc.querySelectorAll<HTMLMediaElement>("audio, video").forEach((el) => {
        el.muted = win.muted;
      });
    } catch {}
  }, [win.muted]);

  // Startup poll + liveness/reconnect (paused while suspended — container is
  // intentionally down then, so don't flag it as a lost connection).
  const { ready, lost, failed, frameKey, reconnect } =
    useSessionHealth(win.connectUrl, { enabled: !win.suspended });

  // Resolution/zoom (Profile → Display): changing it re-navigates the
  // already-open iframe (same DOM node, new `resize=` query) — no relaunch.
  const vncMode = useVncDisplayMode();

  // "Move mouse to resume": the global idle timer only resumes sessions this
  // tab suspended itself — windows adopted as suspended (page reload, another
  // tab, the backend reaper) need the overlay to resume them directly.
  const resuming = useRef(false);
  const handleResume = useCallback(() => {
    if (resuming.current) return;
    resuming.current = true;
    client.post(`/api/sessions/${win.sessionId}/resume`)
      .catch(() => {})
      .finally(() => { resuming.current = false; });
    resumeWindow(win.windowId);
  }, [win.sessionId, win.windowId, resumeWindow]);

  // Feed activity from inside the session iframe (same-origin) so an actively
  // used session isn't wrongly suspended by the idle timer.
  const onIframeLoad = useCallback(() => {
    const w = iframeRef.current?.contentWindow;
    if (w) { try { attachActivity(w); } catch {} }
    if (iframeRef.current) {
      registerFrame(win.windowId, iframeRef.current);
      // Web-native apps (ttyd, Jupyter): selecting/copying text feeds the
      // shared clipboard and the open VNC sessions ("select = copy", like X11).
      attachClipboardCapture(win.windowId, iframeRef.current, (t) => {
        useDesktopStore.getState().addClip(t);
        pushToVncSessions(t, win.windowId);
      });
    }
    iframeRef.current?.focus();
  }, [win.windowId]);

  // Deregister the iframe from the shared-clipboard registry on unmount.
  useEffect(() => () => unregisterFrame(win.windowId), [win.windowId]);

  // Maximized size, as plain numbers rather than "100vw"/calc(100vh - Npx)
  // strings — react-rnd tracks size internally (for its own resize-handle
  // bounds math) by coercing the size prop, and a calc() expression there
  // comes out NaN, which is likely why maximize alone (unlike a manual drag,
  // which always hands Rnd plain measured pixel numbers) has been landing on
  // the wrong height. Recomputed on real browser-window resizes too.
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // KasmVNC's "resize=remote" mode re-requests the remote desktop size on
  // the iframe's own `resize` event — which only fires for a real change to
  // the OUTER browser window. The iframe is never unmounted across maximize/
  // restore/resize (see comment below), so its CSS size changes without the
  // browser window itself changing, and the remote stays locked at whatever
  // size it first connected at (looks "stuck" well under the window's actual
  // size). Nudge it after every size change with a synthetic resize event.
  useEffect(() => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    const id = requestAnimationFrame(() => {
      try { w.dispatchEvent(new Event("resize")); } catch {}
    });
    return () => cancelAnimationFrame(id);
  }, [win.maximized, win.width, win.height, viewport.w, viewport.h]);

  // Animate in on open; re-trigger on restore from minimized
  const [entering, setEntering] = useState(true);
  const prevMinimized = useRef(win.minimized);
  useLayoutEffect(() => {
    const t = setTimeout(() => setEntering(false), 220);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (prevMinimized.current && !win.minimized) {
      setEntering(true);
      const t = setTimeout(() => setEntering(false), 220);
      return () => clearTimeout(t);
    }
    prevMinimized.current = win.minimized;
  }, [win.minimized]);

  // Animate out on minimize — keep rendering until animation completes
  const [minimizing, setMinimizing] = useState(false);
  const handleMinimize = useCallback(() => {
    // Cache a thumbnail before the iframe unmounts (Alt-Tab/Exposé previews).
    captureSnapshot(win.windowId);
    setMinimizing(true);
    setTimeout(() => { setMinimizing(false); minimizeWindow(win.windowId); }, 200);
  }, [minimizeWindow, win.windowId]);

  const isActive = win.zIndex === maxZ;

  // Periodic live preview for admin support/moderation (Sessions admin page)
  // — same trust boundary as session recording, so gated on the same group
  // policy. Only while the window is actually visible; web-native apps have
  // no canvas to capture, so captureSnapshot silently no-ops for them.
  useEffect(() => {
    if (win.suspended || win.minimized) return;
    if (!useAuthStore.getState().user?.policies?.record_sessions) return;
    const upload = () => {
      const url = captureSnapshot(win.windowId);
      if (url) client.patch(`/api/sessions/${win.sessionId}/thumbnail`, { data_url: url }).catch(() => {});
    };
    upload();
    const t = setInterval(upload, 20_000);
    return () => clearInterval(t);
  }, [win.suspended, win.minimized, win.windowId, win.sessionId]);

  const saveBounds = useCallback(
    (x: number, y: number, w: number, h: number) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        client.patch(`/api/sessions/${win.sessionId}/window`, { x, y, width: w, height: h })
          .catch(() => {});
      }, 800);
    },
    [win.sessionId],
  );

  const stopSession = useMutation({
    mutationFn: () => client.delete(`/api/sessions/${win.sessionId}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });

  // Close the window immediately; the container is torn down in the background
  // (backend returns as soon as the session is marked stopped). Background-
  // eligible apps (Terminal) with the user's opt-in keep running instead:
  // the window is dismissed, the session survives, relaunching reattaches
  // (tmux). Explicit kill stays available via the taskbar "Close session".
  const handleClose = () => {
    dropSnapshot(win.windowId);
    closeWindow(win.windowId);
    const prefs = (useAuthStore.getState().user?.preferences ?? {}) as Record<string, unknown>;
    const bgApp = (qc.getQueryData<App[]>(["apps"]) ?? []).find((a) => a.id === win.appId)?.bg_allowed;
    if (bgApp && prefs.terminal_background) {
      dismissSession(win.sessionId);
      toast.info(`${win.appName} keeps running in the background — relaunch it to reattach`);
      return;
    }
    stopSession.mutate();
  };

  // ── Desktop audio ──────────────────────────────────────────────────────────
  // Plays the container's Opus/Ogg stream (relayed by the backend) in a hidden
  // <audio>. No-op for web-native apps (their container has no audio streamer).
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioKey, setAudioKey] = useState(0);
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = win.muted;
      audioRef.current.volume = win.volume;
    }
    audioRef.current?.play().catch(() => {});
  }, [win.muted, win.volume, audioKey]);
  const audioEl = (
    <audio
      key={audioKey}
      ref={audioRef}
      src={`/api/sessions/${win.sessionId}/audio`}
      autoPlay
      style={{ display: "none" }}
      // Reconnect if the stream ends or the container isn't ready yet.
      onEnded={() => setTimeout(() => setAudioKey((k) => k + 1), 2000)}
      onError={() => setTimeout(() => setAudioKey((k) => k + 1), 3000)}
    />
  );

  // One Rnd tree for windowed AND maximized AND minimized (hidden) states —
  // never unmount the iframe for a state change, or the KasmVNC client
  // reloads and flashes its connecting screen on every maximize/restore.
  const hidden = win.minimized && !minimizing;

  return (
    <>
      {audioEl}
      {snapZone && !win.maximized && <SnapPreview zone={snapZone} />}
      <Rnd
        position={win.maximized ? { x: 0, y: 0 } : { x: win.x, y: win.y }}
        size={win.maximized
          ? { width: viewport.w, height: viewport.h - TASKBAR_H }
          : { width: win.width, height: win.height }}
        minWidth={480}
        minHeight={320}
        bounds="window"
        dragHandleClassName="window-drag-handle"
        cancel="button"
        disableDragging={win.maximized}
        enableResizing={win.maximized ? false : undefined}
        // Always-on-top windows sit in their own tier, well above the normal
        // stack, regardless of focus order — offset is far larger than maxZ
        // could realistically reach in one session.
        style={{ zIndex: win.alwaysOnTop ? win.zIndex + 100000 : win.zIndex, position: "fixed", display: hidden ? "none" : undefined }}
        // ── focus on any click anywhere in the window ───────────────────────
        // Skip the store update when already on top — otherwise every
        // mousedown while selecting text in the active window (each click of
        // a multi-click select, drag-selecting) bumps maxZ/zIndex and
        // re-renders every window for no visible change.
        onMouseDown={() => { if (!isActive) focusWindow(win.windowId); }}
        // ── drag ───────────────────────────────────────────────────────────
        onDragStart={() => { setDragging(true); setInteracting(true); }}
        onDrag={(e) => {
          const me = e as MouseEvent;
          setSnapZone(getSnapZone(me.clientX, me.clientY));
        }}
        onDragStop={(_e, d) => {
          setDragging(false); setInteracting(false);
          const zone = snapZone;
          setSnapZone(null);

          if (zone === "maximize") {
            toggleMaximize(win.windowId);
            return;
          }
          if (zone === "left" || zone === "right") {
            const hw = Math.floor(window.innerWidth / 2);
            const fh = window.innerHeight - TASKBAR_H;
            const nx = zone === "left" ? 0 : hw;
            updateBounds(win.windowId, nx, 0, hw, fh);
            saveBounds(nx, 0, hw, fh);
            return;
          }
          if (zone === "top-left" || zone === "top-right" || zone === "bottom-left" || zone === "bottom-right") {
            const hw = Math.floor(window.innerWidth / 2);
            const hh = Math.floor((window.innerHeight - TASKBAR_H) / 2);
            const nx = zone.endsWith("right") ? hw : 0;
            const ny = zone.startsWith("bottom") ? hh : 0;
            updateBounds(win.windowId, nx, ny, hw, hh);
            saveBounds(nx, ny, hw, hh);
            return;
          }
          updateBounds(win.windowId, d.x, d.y, win.width, win.height);
          saveBounds(d.x, d.y, win.width, win.height);
        }}
        // ── resize ─────────────────────────────────────────────────────────
        onResizeStart={() => { setResizing(true); setInteracting(true); }}
        onResizeStop={(_, __, ref, ___, pos) => {
          setResizing(false); setInteracting(false);
          updateBounds(win.windowId, pos.x, pos.y, ref.offsetWidth, ref.offsetHeight);
          saveBounds(pos.x, pos.y, ref.offsetWidth, ref.offsetHeight);
        }}
        // Larger resize handle hit-area feels snappier
        resizeHandleStyles={{
          bottom:      { height:  10, cursor: "s-resize"  },
          top:         { height:  10, cursor: "n-resize"  },
          left:        { width:   10, cursor: "w-resize"  },
          right:       { width:   10, cursor: "e-resize"  },
          bottomLeft:  { width:   14, height: 14, cursor: "sw-resize" },
          bottomRight: { width:   14, height: 14, cursor: "se-resize" },
          topLeft:     { width:   14, height: 14, cursor: "nw-resize" },
          topRight:    { width:   14, height: 14, cursor: "ne-resize" },
        }}
      >
        {/* Window chrome */}
        <div
          className={cn(
            "flex h-full flex-col overflow-hidden transition-[box-shadow,border-color] duration-200",
            "bg-gray-50 dark:bg-[#131320]",
            win.maximized ? "rounded-none" : "rounded-xl border",
            minimizing && "animate-minimize-out pointer-events-none",
            entering   && "animate-window-open",
            !win.maximized && (isActive
              ? "border-gray-300 dark:border-white/[0.13] shadow-[0_24px_64px_rgba(0,0,0,0.25)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.75),0_0_0_0.5px_rgba(255,255,255,0.08)]"
              : "border-gray-200 dark:border-white/[0.07] shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.45)]"),
          )}
        >
          <TitleBar
            win={win} isMaximized={win.maximized} active={isActive}
            onMinimize={handleMinimize}
            onMaximize={() => toggleMaximize(win.windowId)}
            onClose={handleClose}
            onMute={() => toggleMute(win.windowId)}
            onVolume={(v) => setVolume(win.windowId, v)}
            videoOn={videoMode}
            onVideo={() => setVideoMode((v) => !v)}
            alwaysOnTop={win.alwaysOnTop}
            onToggleAlwaysOnTop={() => toggleAlwaysOnTop(win.windowId)}
          />

          {/* Content + iframe overlay */}
          <div className="relative flex-1 min-h-0">
            {videoMode && ready && !win.suspended ? (
              <VideoMode sessionId={win.sessionId} />
            ) : win.suspended ? (
              <div
                className="absolute inset-0 flex items-center justify-center bg-black/90"
                onMouseMove={handleResume}
                onClick={handleResume}
              >
                <div className="text-center text-white/60">
                  <div className="mx-auto mb-3 text-4xl">⏸</div>
                  <div className="text-xs font-semibold">Suspended — move mouse to resume</div>
                </div>
              </div>
            ) : failed ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/95">
                <div className="text-center text-white">
                  <Wifi className="mx-auto mb-3 h-8 w-8 text-red-400" />
                  <div className="text-xs font-semibold">{win.appName} didn't start</div>
                  <div className="mt-1 text-[11px] text-white/40">No response from the container within 60 seconds</div>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      onClick={reconnect}
                      className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </button>
                    <button
                      // Always a real stop — never "keep in background" a
                      // container that failed to start.
                      onClick={() => { dropSnapshot(win.windowId); closeWindow(win.windowId); stopSession.mutate(); }}
                      className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/10 hover:text-white"
                    >
                      Stop session
                    </button>
                  </div>
                </div>
              </div>
            ) : !ready ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black">
                <div className="text-center text-white">
                  <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-[3px] border-white/10 border-t-indigo-500" />
                  <div className="text-xs font-semibold opacity-60">Starting…</div>
                </div>
              </div>
            ) : (
              <iframe
                key={frameKey}
                ref={iframeRef}
                src={win.connectUrl + '?' + vncQueryString(vncMode)}
                className="absolute inset-0 w-full h-full border-0 bg-black"
                allow="clipboard-read; clipboard-write; autoplay; fullscreen; display-capture"
                title={win.appName}
                onLoad={onIframeLoad}
              />
            )}
            {lost && !win.suspended && <LostOverlay onReconnect={reconnect} />}
            {/* Transparent shield: blocks iframe from stealing pointer events during drag/resize */}
            {(dragging || resizing || interacting) && (
              <div className="absolute inset-0 z-10" style={{ cursor: resizing ? "se-resize" : "move" }} />
            )}
          </div>
        </div>
      </Rnd>
    </>
  );
}

// ── Connection-lost overlay ────────────────────────────────────────────────────

function LostOverlay({ onReconnect }: { onReconnect(): void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="text-center text-white">
        <Wifi className="mx-auto mb-3 h-8 w-8 text-red-400" />
        <div className="text-xs font-semibold">Connection lost</div>
        <button
          onClick={onReconnect}
          className="mx-auto mt-3 flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Reconnect
        </button>
      </div>
    </div>
  );
}

// ── Clipboard bridge panel ─────────────────────────────────────────────────────

function ClipboardPanel({ onClose }: { onClose(): void }) {
  const [text, setText] = useState("");
  return (
    <div
      className="absolute left-2 top-10 z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-2xl dark:border-white/10 dark:bg-gray-900"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 dark:text-white/60">Clipboard bridge</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:text-white/40 dark:hover:text-white text-xs">✕</button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste text here to send to session…"
        className="w-full resize-none rounded-lg bg-gray-100 px-2 py-1.5 text-xs text-gray-800 placeholder-gray-400 outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-black/40 dark:text-white dark:placeholder-white/30"
        rows={4}
      />
      <div className="mt-2 flex gap-2">
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(text).catch(() => {});
            toast.success("Copied — Ctrl+V to paste in session");
          }}
          className="flex-1 rounded-lg bg-indigo-600 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
        >
          Copy to clipboard
        </button>
        <button
          onClick={async () => {
            const t = await navigator.clipboard.readText().catch(() => "");
            setText(t);
          }}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-white/10 dark:text-white/60 dark:hover:bg-white/10"
        >
          Paste from host
        </button>
      </div>
    </div>
  );
}

// ── Title bar ─────────────────────────────────────────────────────────────────

function TitleBar({
  win, onMinimize, onMaximize, onClose, onMute, onVolume, isMaximized, active,
  videoOn, onVideo, alwaysOnTop, onToggleAlwaysOnTop,
}: {
  win: AppWindow;
  onVolume(v: number): void;
  onMinimize(): void;
  onMaximize(): void;
  onClose(): void;
  onMute(): void;
  isMaximized: boolean;
  active: boolean;
  videoOn: boolean;
  onVideo(): void;
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop(): void;
}) {
  const [clipOpen, setClipOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const clipboardAllowed = !useAuthStore((s) => s.user?.policies?.disable_clipboard);
  const qc = useQueryClient();

  // Per-window VPN routing toggle — only for sessions launched behind a live
  // gateway (vpn_enabled != null). The container relay applies the change to
  // new connections within ~2 s.
  const { data: sessions } = useQuery<Session[]>({
    queryKey: ["sessions"],
    queryFn: async () => (await client.get("/api/sessions")).data,
  });
  const vpnEnabled = sessions?.find((s) => s.id === win.sessionId)?.vpn_enabled;
  const toggleVpn = useMutation({
    mutationFn: async () =>
      (await client.post(`/api/sessions/${win.sessionId}/vpn`, { enabled: !vpnEnabled }))
        .data as { enabled: boolean },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(
        d.enabled
          ? "VPN on — new connections route through the tunnel (takes a few seconds)"
          : "VPN off — new connections go directly to the internet",
      );
    },
    onError: () => toast.error("Could not change VPN routing"),
  });
  return (
    <div className="relative">
    <div
      className={cn(
        "window-drag-handle group flex h-10 shrink-0 select-none items-center gap-2.5 px-3",
        "cursor-move transition-colors duration-150",
        active
          ? "bg-indigo-50 text-gray-800 border-b border-indigo-200 dark:bg-[#1e1e38] dark:text-gray-100 dark:border-white/[0.07]"
          : "bg-gray-100 text-gray-500 border-b border-gray-200 dark:bg-[#17172b] dark:text-gray-400 dark:border-white/[0.04]",
      )}
      onDoubleClick={onMaximize}
    >
      {/* App icon + name — left side */}
      <div className="flex flex-1 items-center gap-2 overflow-hidden">
        {win.appIcon ? (
          <img src={win.appIcon} alt="" className="h-4 w-4 shrink-0 object-contain opacity-80" />
        ) : (
          <span className="text-xs opacity-60">🖥️</span>
        )}
        <span className={cn(
          "truncate text-xs font-semibold tracking-wide",
          active ? "opacity-90" : "opacity-45",
        )}>
          {win.appName}
        </span>
      </div>

      {/* Window control buttons — right side: mute | clipboard | minimize | maximize | close */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          title={win.muted ? "Unmute" : "Mute"}
          onClick={(e) => { e.stopPropagation(); onMute(); }}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded transition-colors",
            win.muted
              ? "text-amber-500 hover:text-amber-400 dark:text-amber-400 dark:hover:text-amber-300"
              : "text-gray-400 hover:bg-black/10 hover:text-gray-600 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/70",
          )}
        >
          {win.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
        </button>
        {/* Volume slider (revealed on titlebar hover) */}
        <input
          type="range" min={0} max={1} step={0.05}
          value={win.muted ? 0 : win.volume}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { e.stopPropagation(); onVolume(Number(e.target.value)); }}
          title="Volume"
          className="h-1 w-0 cursor-pointer opacity-0 accent-indigo-500 transition-all duration-150 group-hover:w-14 group-hover:opacity-100"
        />
        {clipboardAllowed && (
        <button
          title="Clipboard bridge"
          onClick={(e) => { e.stopPropagation(); setClipOpen((v) => !v); }}
          className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-black/10 hover:text-gray-600 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/70 transition-colors"
        >
          <Clipboard className="h-3 w-3" />
        </button>
        )}
        {vpnEnabled !== null && vpnEnabled !== undefined && (
        <button
          title={vpnEnabled
            ? "VPN on — this app's traffic goes through the tunnel (click to go direct)"
            : "VPN off — this app's traffic goes directly to the internet (click to route through the VPN)"}
          onClick={(e) => { e.stopPropagation(); toggleVpn.mutate(); }}
          disabled={toggleVpn.isPending}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded transition-colors",
            vpnEnabled
              ? "text-emerald-500 hover:text-emerald-400 dark:text-emerald-400 dark:hover:text-emerald-300"
              : "text-gray-400 hover:bg-black/10 hover:text-gray-600 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/70",
          )}
        >
          <Shield className={cn("h-3 w-3", vpnEnabled && "fill-current")} />
        </button>
        )}
        <button
          title={videoOn ? "Back to interactive VNC" : "Video mode (beta) — low-latency H.264 view, input disabled"}
          onClick={(e) => { e.stopPropagation(); onVideo(); }}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded transition-colors",
            videoOn
              ? "text-amber-500 hover:text-amber-400 dark:text-amber-400"
              : "text-gray-400 hover:bg-black/10 hover:text-gray-600 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/70",
          )}
        >
          <Zap className="h-3 w-3" />
        </button>
        <button
          title="Share session"
          onClick={(e) => { e.stopPropagation(); setShareOpen((v) => !v); }}
          className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-black/10 hover:text-gray-600 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/70 transition-colors"
        >
          <Share2 className="h-3 w-3" />
        </button>
        <button
          title={alwaysOnTop ? "Always on top (click to unpin)" : "Keep on top of other windows"}
          onClick={(e) => { e.stopPropagation(); onToggleAlwaysOnTop(); }}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded transition-colors",
            alwaysOnTop
              ? "text-indigo-500 hover:text-indigo-400 dark:text-indigo-400 dark:hover:text-indigo-300"
              : "text-gray-400 hover:bg-black/10 hover:text-gray-600 dark:text-white/30 dark:hover:bg-white/10 dark:hover:text-white/70",
          )}
        >
          <Pin className={cn("h-3 w-3", alwaysOnTop && "fill-current")} />
        </button>
        <div className="mx-1 h-3 w-px bg-black/10 dark:bg-white/10" />
        <WinBtn
          color="#febc2e" hoverColor="#febc2e"
          icon={<Minus className="h-2 w-2" strokeWidth={3} />}
          title="Minimise"
          onClick={(e) => { e.stopPropagation(); onMinimize(); }}
        />
        <WinBtn
          color="#28c840" hoverColor="#28c840"
          icon={isMaximized
            ? <Minimize2 className="h-2 w-2" strokeWidth={3} />
            : <Maximize2 className="h-2 w-2" strokeWidth={3} />}
          title={isMaximized ? "Restore" : "Maximise"}
          onClick={(e) => { e.stopPropagation(); onMaximize(); }}
        />
        <WinBtn
          color="#ff5f57" hoverColor="#ff5f57"
          icon={<X className="h-2 w-2" strokeWidth={3} />}
          title="Close"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        />
      </div>
    </div>
    {clipOpen && clipboardAllowed && <ClipboardPanel onClose={() => setClipOpen(false)} />}
    {shareOpen && <SharePanel sessionId={win.sessionId} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

// ── Share panel ───────────────────────────────────────────────────────────────
// Mint/revoke invite links into this session. Links are for logged-in users;
// view-only is enforced by the guest viewer's input overlay.

interface Share {
  id: string;
  mode: "view" | "control";
  share_url: string;
  expires_at: string | null;
}

function SharePanel({ sessionId, onClose }: { sessionId: string; onClose(): void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"view" | "control">("view");
  const [ttl, setTtl] = useState<number>(60);
  const [copied, setCopied] = useState<string | null>(null);

  const { data: shares = [] } = useQuery<Share[]>({
    queryKey: ["shares", sessionId],
    queryFn: async () => (await client.get(`/api/sessions/${sessionId}/shares`)).data,
  });

  const createShare = useMutation({
    mutationFn: async () =>
      (await client.post(`/api/sessions/${sessionId}/share`, {
        mode, ttl_minutes: ttl || undefined,
      })).data as Share,
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["shares", sessionId] });
      copyLink(s);
    },
  });

  const revokeShare = useMutation({
    mutationFn: async (id: string) => client.delete(`/api/sessions/shares/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shares", sessionId] }),
  });

  const copyLink = (s: Share) => {
    navigator.clipboard.writeText(`${window.location.origin}${s.share_url}`).catch(() => {});
    setCopied(s.id);
    setTimeout(() => setCopied(null), 1500);
  };

  const selCls = "rounded bg-gray-100 border border-gray-200 px-2 py-1 text-xs text-gray-800 dark:bg-black/40 dark:border-white/10 dark:text-white";

  return (
    <div
      className="absolute right-2 top-11 z-50 w-80 rounded-lg border bg-white border-gray-200 p-3 shadow-2xl dark:bg-gray-900 dark:border-white/10"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">Share session</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <select value={mode} onChange={(e) => setMode(e.target.value as "view" | "control")} className={selCls}>
          <option value="view">View only</option>
          <option value="control">Full control</option>
        </select>
        <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className={selCls}>
          <option value={60}>1 hour</option>
          <option value={480}>8 hours</option>
          <option value={1440}>24 hours</option>
          <option value={0}>No expiry</option>
        </select>
        <button
          onClick={() => createShare.mutate()}
          disabled={createShare.isPending}
          className="ml-auto rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Create link
        </button>
      </div>

      {shares.length > 0 && (
        <ul className="space-y-1.5">
          {shares.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded bg-gray-50 px-2 py-1.5 text-xs dark:bg-white/5">
              <span className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                s.mode === "control"
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                  : "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
              )}>
                {s.mode}
              </span>
              <span className="flex-1 truncate text-gray-500 dark:text-white/50">
                {s.expires_at ? `until ${new Date(s.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "no expiry"}
              </span>
              <button title="Copy link" onClick={() => copyLink(s)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-white">
                {copied === s.id ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button title="Revoke" onClick={() => revokeShare.mutate(s.id)}
                className="text-gray-400 hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WinBtn({
  color, icon, title, onClick,
}: {
  color: string;
  hoverColor: string;
  icon: ReactNode;
  title: string;
  onClick(e: React.MouseEvent): void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90"
      style={{ background: color, opacity: hover ? 1 : 0.85 }}
    >
      <span
        className="transition-opacity duration-75"
        style={{ opacity: hover ? 1 : 0, color: "rgba(0,0,0,0.65)" }}
      >
        {icon}
      </span>
    </button>
  );
}
