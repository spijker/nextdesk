# TODO — possible next steps

- [x] **Per-user VPN gateway** — "VPN" catalog app (userspace OpenConnect GP + ocproxy, unprivileged); other sessions reach it at `socks5h://vpn:1080`, ALL_PROXY auto-injected ✅
- [x] **VPN follow-ups** — k8s NetworkPolicy scoping the SOCKS port per user (needs a CNI that enforces it); taskbar VPN shield indicator; Firefox proxy auto-config via policies.json ✅

- [ ] **File manager app** — register a Thunar or Nautilus container image so users can browse `~/Files` from the launcher
- [x] **Session transfer** — continuous adoption of sessions started elsewhere + tab-to-tab handoff (BroadcastChannel claim/detach overlay); device transfer via login takeover + restore ✅
- [x] **Wallpaper from Nextcloud** — browse NC files in the wallpaper picker (thumbnails, folder nav), wallpaper served via `/api/storage/files/preview` ✅
- [x] **Admin audit log UI** — full page: action chips + free-text search, date range, CSV export (filters applied, 10k cap) ✅
- [ ] **LDAP group → admin role mapping** — e.g. `ldap-group:admins` → `is_admin=true`
- [ ] **Session recording** — optional screen capture stored to object storage
- [ ] **Mobile layout** — taskbar + launcher usable on tablet screens
- [x] **WebCodecs stream (beta)** — per-window ⚡ toggle: raw H.264 (x264 zerolatency) from the container on :8082, relayed by the backend, decoded with VideoDecoder onto a canvas. View-only for now; input path + GPU encode (nvenc) are the follow-ups
- [x] **Clipboard history** — opt-in server-side sync (Profile → Preferences); off by default, opting out wipes the server copy ✅
- [x] **CI/CD pipeline** — .gitlab-ci.yml: ruff, pytest (green), tsc+vite build, manual session-image build (dind), Trivy scan ✅
- [ ] **Helm chart** — for GitOps deployment (ArgoCD/Flux)
- [x] **Trivy scanning** — fs scan in CI (HIGH/CRITICAL, allow_failure during baseline burn-down); image scanning still TODO ✅
- [ ] **Multi-monitor support** — KasmVNC supports it but frontend only handles single display
- [ ] **User-initiated password change** — currently only admin can reset passwords
- [ ] **Launch options dialog** — override resolution, env vars, resource limits per-session
- [x] **Nextcloud embedding** — custom Nextcloud app (`nextcloud-app/nextdesk/`) puts Nextdesk in Nextcloud's own nav bar via iframe; OIDC login breaks out to the top level and back (Nextcloud's own login page can't complete nested) ✅
- [x] **Open in Nextdesk (Files deep link)** — right-click a file in Nextcloud's Files list → opens/reuses the right Nextdesk session with it already open, via a Vite-built Nextcloud Files action ✅
- [ ] **Same-parent-domain embedding** — the OIDC-return-to-embed flow only reliably stays logged in when Nextcloud and Nextdesk share a parent domain (browser storage partitioning otherwise isolates the session cookie between direct and iframe-embedded contexts) — works today across different domains for the login itself, just not for staying embedded afterward
- [x] **Frontend lint** — `npm run lint` was broken (ESLint 9 needs a flat config, none existed); added `eslint.config.js` + the usual React/TS plugin set, wired into CI
