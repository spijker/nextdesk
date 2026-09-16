import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** Poll for liveness after the iframe has loaded. Disable while suspended. */
  enabled?: boolean;
  /** Consecutive failed pings before declaring the connection lost. */
  failThreshold?: number;
  /** Give up on the app opening its port after this many seconds (failed=true). */
  startupTimeoutS?: number;
  /** Give up waiting for the backend to report status "running" after this many
   *  seconds — covers a first-launch image pull, which can take minutes. */
  provisioningTimeoutS?: number;
}

export interface SessionHealth {
  ready: boolean;       // container reachable — safe to mount the iframe
  lost: boolean;        // was ready, now unreachable (websocket/container dropped)
  failed: boolean;      // never became reachable within the startup/provisioning budget
  frameKey: number;     // bump forces the iframe to remount on reconnect
  elapsed: number;      // seconds spent waiting during initial startup
  reconnect(): void;    // user-triggered reconnect / retry
}

/**
 * Owns the lifecycle of a session iframe's connection:
 *  1. Provisioning — polls the session's backend status until it's "running"
 *     (covers a first-launch image pull deferred off the request path, see
 *     sessions.py create_session — the container may not exist yet).
 *  2. Startup — polls the session URL until the container answers (~10s cold).
 *  3. Liveness — once loaded, pings periodically; N failures ⇒ `lost`.
 *  4. Reconnect — re-verifies then remounts the iframe via `frameKey`.
 */
export function useSessionHealth(url: string, sessionId?: string, opts: Options = {}): SessionHealth {
  // 3 consecutive failures (~15s) before flagging lost — tolerates brief
  // upstream blips (container hiccups, resizes) without a false "Connection lost".
  const {
    enabled = true, failThreshold = 3,
    startupTimeoutS = 60, provisioningTimeoutS = 600,
  } = opts;
  const [ready, setReady]       = useState(false);
  const [lost, setLost]         = useState(false);
  const [failed, setFailed]     = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [elapsed, setElapsed]   = useState(0);

  // ── Startup poll: wait for the backend, then the container, to come up ───
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    (async () => {
      const start = Date.now();
      const tick = () => setElapsed(Math.round((Date.now() - start) / 1000));

      // Phase 1: wait for the session's DB status to flip to "running". Skips
      // straight through (one fast round trip) once a launch already finished
      // synchronously — only a deferred pull makes this phase take a while.
      // Skipped entirely without a sessionId (SessionViewer's shared/guest
      // links only ever point at an already-running session — there's no
      // owner-scoped GET /api/sessions/{id} a guest could call for it).
      if (sessionId) {
        const provisionDeadline = Date.now() + provisioningTimeoutS * 1000;
        while (Date.now() < provisionDeadline) {
          if (cancelled) return;
          try {
            const r = await fetch(`/api/sessions/${sessionId}`, { cache: "no-store" });
            if (r.ok) {
              const s = await r.json();
              if (s.status === "running") break;
              if (s.status === "error") { setFailed(true); return; }
            }
          } catch { /* not answering yet */ }
          tick();
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (Date.now() >= provisionDeadline) { if (!cancelled) setFailed(true); return; }
      }

      // Phase 2: container is up — poll fast (0.7s) so we mount the instant
      // the app itself opens its port.
      const startupDeadline = Date.now() + startupTimeoutS * 1000;
      while (Date.now() < startupDeadline) {
        if (cancelled) return;
        try {
          const r = await fetch(url, { cache: "no-store" });
          if (r.ok) { setReady(true); return; }
        } catch { /* not up yet */ }
        tick();
        await new Promise((r) => setTimeout(r, 700));
      }
      // The app never opened its port — surface a hard failure instead of an
      // endless spinner; the user chooses to retry or stop the session.
      if (!cancelled) setFailed(true);
    })();
    return () => { cancelled = true; };
  }, [url, sessionId, frameKey, startupTimeoutS, provisioningTimeoutS]);

  // ── Liveness poll: detect a dropped connection after load ────────────────
  const fails = useRef(0);
  useEffect(() => {
    if (!ready || !enabled || lost) return;
    fails.current = 0;
    const id = setInterval(async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) { fails.current = 0; return; }
        throw new Error(String(r.status));
      } catch {
        fails.current += 1;
        if (fails.current >= failThreshold) setLost(true);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [ready, enabled, lost, url, failThreshold]);

  const reconnect = useCallback(() => {
    fails.current = 0;
    setLost(false);
    setFailed(false);
    setElapsed(0);
    setFrameKey((k) => k + 1); // remount iframe + re-run startup poll
  }, []);

  return { ready, lost, failed, frameKey, elapsed, reconnect };
}
