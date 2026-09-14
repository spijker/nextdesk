import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { LogIn, Loader2, ShieldCheck, KeyRound, Eye, EyeOff } from "lucide-react";
import client from "@/api/client";
import { useAuthStore } from "@/store/auth";
import { useDesktopStore } from "@/store/desktop";

interface AuthMethods {
  oidc: boolean;
  oidc_label?: string;
  local: boolean;
  ldap: boolean;
  needs_setup: boolean;
  footer_text?: string;
}

function Field({
  label, type = "text", value, onChange, autoComplete, required, minLength, extra,
}: {
  label: string; type?: string; value: string;
  onChange(v: string): void;
  autoComplete?: string; required?: boolean; minLength?: number; extra?: React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  const isPassword = type === "password";
  const inputType = isPassword ? (show ? "text" : "password") : type;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-semibold uppercase tracking-wider text-white/50">{label}</label>
        {extra}
      </div>
      <div className="relative">
        <input
          type={inputType}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none transition focus:border-indigo-400/60 focus:bg-white/8 focus:ring-2 focus:ring-indigo-500/20"
        />
        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShow((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const loadFromServer = useDesktopStore((s) => s.loadFromServer);

  // Deep link to return to after login (e.g. "/?open=..." from Nextcloud's
  // "Open in Nextdesk" Files action) — only a same-origin relative path is
  // ever honoured, both here and server-side for the OIDC round trip.
  const [searchParams] = useSearchParams();
  const rawNext = searchParams.get("next");
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : null;

  // Running inside the Nextcloud embed iframe? OIDC has to break out to the
  // top level to complete (see the target="_top" link below) — once signed
  // in, the backend sends the user back to the Nextcloud page hosting
  // Nextdesk instead of stranding them on a bare Nextdesk tab.
  const embedded = typeof window !== "undefined" && window.self !== window.top;
  const oidcParams = new URLSearchParams();
  if (next) oidcParams.set("next", next);
  if (embedded) oidcParams.set("embed", "1");
  const oidcHref = oidcParams.toString()
    ? `/api/auth/oidc/login?${oidcParams.toString()}`
    : "/api/auth/oidc/login";

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");

  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  const { data: methods, isLoading: methodsLoading } = useQuery<AuthMethods>({
    queryKey: ["auth-methods"],
    queryFn: () => client.get("/api/auth/methods").then((r) => r.data),
    staleTime: 30_000,
  });

  const afterAuth = async () => {
    const { data } = await client.get("/api/auth/me");
    setUser(data);
    if (data.preferences) loadFromServer(data.preferences);
    navigate(next || "/");
  };

  const loginMutation = useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      client.post("/api/auth/login", body),
    onSuccess: async (res) => {
      if (res.data?.requires_totp) {
        setTotpToken(res.data.totp_token);
      } else {
        await afterAuth();
      }
    },
    onError: (err: any) => setFormError(err.response?.data?.detail ?? "Invalid credentials"),
  });

  const totpMutation = useMutation({
    mutationFn: (body: { totp_token: string; code: string }) =>
      client.post("/api/auth/2fa/verify", body),
    onSuccess: afterAuth,
    onError: (err: any) => setFormError(err.response?.data?.detail ?? "Invalid code"),
  });

  const setupMutation = useMutation({
    mutationFn: (body: { username: string; email: string; display_name: string; password: string }) =>
      client.post("/api/auth/register", body),
    onSuccess: afterAuth,
    onError: (err: any) => setFormError(err.response?.data?.detail ?? "Setup failed"),
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    loginMutation.mutate({ username: username.trim(), password });
  };

  const handleSetup = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setupMutation.mutate({ username: username.trim(), email: email.trim(), display_name: displayName.trim(), password });
  };

  const handleTotpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    totpMutation.mutate({ totp_token: totpToken!, code: totpCode.trim() });
  };

  // ── shared page shell ────────────────────────────────────────────────────────
  const shell = (card: React.ReactNode) => (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#0d0d1a]">
      {/* Background orbs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-56 -top-56 h-[600px] w-[600px] rounded-full bg-indigo-700/20 blur-[120px]" />
        <div className="absolute -bottom-32 -right-32 h-[500px] w-[500px] rounded-full bg-violet-700/15 blur-[100px]" />
        <div className="absolute left-1/2 top-1/3 h-[300px] w-[300px] -translate-x-1/2 rounded-full bg-cyan-700/10 blur-[80px]" />
        {/* Dot grid */}
        <svg className="absolute inset-0 h-full w-full opacity-[0.04]" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="white" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#dots)" />
        </svg>
      </div>

      {/* Center card */}
      <div className="relative flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm">
          {/* Logo mark */}
          <div className="mb-8 flex flex-col items-center gap-4">
            <div className="relative">
              <div className="absolute inset-0 rounded-2xl bg-indigo-500 blur-lg opacity-40" />
              <img src="/nextdesk-logo.png" alt="Nextdesk" className="relative h-16 w-16 rounded-2xl shadow-xl" />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-bold tracking-tight text-white">Nextdesk</h1>
              <p className="mt-1 text-sm text-white/40">Browser-based remote desktops</p>
            </div>
          </div>

          {/* Card */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-8 shadow-2xl backdrop-blur-xl ring-1 ring-inset ring-white/[0.05]">
            {card}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="relative py-4 text-center">
        <p className="text-xs text-white/20">{methods?.footer_text || "Nextdesk — Powered by VPE © 2026"}</p>
      </div>
    </div>
  );

  if (methodsLoading) {
    return shell(
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-7 w-7 animate-spin text-indigo-400" />
      </div>
    );
  }

  // ── TOTP step ────────────────────────────────────────────────────────────────
  if (totpToken) {
    return shell(
      <div>
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/20 ring-1 ring-indigo-400/30">
            <KeyRound className="h-5 w-5 text-indigo-300" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">Two-factor authentication</h2>
            <p className="mt-1 text-xs text-white/40">Enter the 6-digit code from your authenticator app</p>
          </div>
        </div>
        <form onSubmit={handleTotpSubmit} className="space-y-4">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoFocus
            autoComplete="one-time-code"
            required
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
            placeholder="000 000"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-2xl font-mono tracking-[0.4em] text-white placeholder-white/15 outline-none focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/20"
          />
          {formError && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-xs text-red-400">{formError}</p>
          )}
          <button
            type="submit"
            disabled={totpMutation.isPending || totpCode.length !== 6}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {totpMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Verify
          </button>
          <button type="button" onClick={() => setTotpToken(null)} className="w-full text-xs text-white/30 hover:text-white/60 transition">
            ← Back to login
          </button>
        </form>
      </div>
    );
  }

  // ── Main login / setup ───────────────────────────────────────────────────────
  const needsSetup = methods?.needs_setup;
  const showForm = needsSetup || methods?.local || methods?.ldap;
  const showOidc = !needsSetup && methods?.oidc;
  const isPending = loginMutation.isPending || setupMutation.isPending;

  const takenOver = new URLSearchParams(window.location.search).get("taken") === "1";

  return shell(
    <div>
      {takenOver ? (
        <div className="mb-6 flex items-start gap-2.5 rounded-xl bg-indigo-500/10 px-3.5 py-3 text-xs text-indigo-200 ring-1 ring-indigo-400/20">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You were signed out here because this account signed in from another browser. Sign in again to take the session back.</span>
        </div>
      ) : null}
      {needsSetup ? (
        <div className="mb-6 flex items-start gap-2.5 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs text-amber-300 ring-1 ring-amber-400/20">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>First-time setup — this account becomes the administrator. The form disappears after the first account is created.</span>
        </div>
      ) : null}

      {showForm && (
        <form onSubmit={needsSetup ? handleSetup : handleLogin} className="space-y-4">
          <Field
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            required
          />
          {needsSetup && (
            <>
              <Field
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                required
              />
              <Field
                label="Display name (optional)"
                value={displayName}
                onChange={setDisplayName}
              />
            </>
          )}
          <Field
            label={needsSetup ? "Password (min 8 chars)" : "Password"}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={needsSetup ? "new-password" : "current-password"}
            required
            minLength={needsSetup ? 8 : undefined}
          />

          {formError && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{formError}</p>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-transparent disabled:opacity-50"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : needsSetup ? (
              <ShieldCheck className="h-4 w-4" />
            ) : (
              <LogIn className="h-4 w-4" />
            )}
            {needsSetup ? "Create admin account" : "Sign in"}
          </button>
        </form>
      )}

      {showForm && showOidc && (
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-xs text-white/25">or</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>
      )}

      {showOidc && (
        <a
          href={oidcHref}
          // Break out to the top-level tab for the whole OIDC round trip. When
          // Nextcloud is also the IdP, its own login/consent page can refuse to
          // render nested (framebusting or X-Frame-Options) and forces the tab
          // back to plain Nextcloud mid-flow instead of completing the redirect
          // — target="_top" does that breakout deliberately, before the OIDC
          // dance starts, so it completes cleanly instead of getting stranded.
          // The "embed=1" param above tells the backend to send the user back
          // to the Nextcloud embed page afterward, not Nextdesk's bare "/".
          target={embedded ? "_top" : undefined}
          className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {methods?.oidc_label || "Sign in with your organisation"}
        </a>
      )}

      {!needsSetup && (
        <p className="mt-5 text-center text-xs text-white/20">
          Access is managed by your IT department
        </p>
      )}
    </div>
  );
}
