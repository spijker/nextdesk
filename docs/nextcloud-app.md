# Nextcloud custom app

`nextcloud-app/nextdesk/` is a real Nextcloud app (PHP, follows the standard
`info.xml` / `IBootstrap` app framework) that adds a **Nextdesk** entry to
Nextcloud's top navigation bar. Clicking it opens a Nextcloud page with an
iframe embedding your Nextdesk instance — so users can reach their desktop
sessions without leaving Nextcloud.

This is separate from [OIDC auth](auth-setup.md#nextcloud-recommended--same-instance-as-your-storage):
the app is about *navigation and embedding*, not identity. You'll typically
want both — Nextcloud as the OIDC provider so login is seamless, and this app
so users never have to know Nextdesk's URL.

---

## How it works

- The app adds one nav entry (`appinfo/info.xml` → `<navigations>`) that
  routes to `PageController::index()`.
- That controller reads an admin-configured URL from Nextcloud's app config
  (`IConfig::getAppValue`) and renders `templates/index.php`, which puts that
  URL in an `<iframe>`.
- It also adds a `ContentSecurityPolicy::addAllowedFrameDomain()` entry for
  the configured origin, so Nextcloud's own CSP doesn't block the iframe.
- An admin settings page (Settings → Administration → Nextdesk) lets an admin
  set/change the URL without touching config files, via
  `lib/Settings/Admin.php` + `lib/Controller/SettingsController.php`
  (`IGroupManager::isAdmin()` gated).

The app also adds an **Open in Nextdesk** action to Nextcloud's own Files list
— see [Open in Nextdesk: Files deep link](#open-in-nextdesk-files-deep-link)
below.

No Nextdesk-side code depends on this app existing — it's a pure Nextcloud-side
add-on. If you don't install it, users just bookmark/navigate to Nextdesk directly.

---

## Installing

1. Copy `nextcloud-app/nextdesk/` into your Nextcloud's `custom_apps/`
   directory (or `apps/` — either is a valid Nextcloud app location) as
   `custom_apps/nextdesk/`. Make sure it's readable by the web server user
   (`www-data` in most Nextcloud deployments).

   The repo root's `nextdesk-nextcloud-app.zip` is a prebuilt copy of this
   folder — extract it if you don't want to clone the whole repo. If you're
   building from source instead, run `make package-nc-app` first (or `cd
   nextcloud-app/nextdesk && npm install && npm run build`) — the Files
   action (below) is a compiled JS bundle and won't appear without it.
2. Settings → Administration → Apps → enable **Nextdesk** (or
   `occ app:enable nextdesk`).
3. Settings → Administration → **Nextdesk** → set the **Nextdesk URL** to
   your instance's public URL (e.g. `https://desk.example.com`) → Save.
4. See [nginx: allow framing](#nginx-allow-framing-from-nextcloud) below —
   without it the iframe loads a blank page.

A **Nextdesk** icon now appears in Nextcloud's app navigation for all users.

---

## nginx: allow framing from Nextcloud

Nextdesk's nginx config blocks being framed by other origins by default
(`X-Frame-Options` / CSP `frame-ancestors`, both set to `'self'`). Since
Nextcloud is a different origin, embedding it in an iframe needs that opened
up explicitly. In `nginx/prod.conf` (and `nginx/dev.conf` for local testing),
find the `frame-ancestors` directive in the `Content-Security-Policy` header
and add your Nextcloud origin:

```nginx
add_header Content-Security-Policy "... frame-ancestors 'self' https://cloud.example.com;" always;
```

`X-Frame-Options` isn't used for this because it can't express "allow this
one other origin" — only `DENY`, `SAMEORIGIN`, or the deprecated/unreliable
`ALLOW-FROM`. `frame-ancestors` is the modern CSP replacement and is what all
current browsers actually enforce for this case.

---

## Fullscreen

The iframe already has `allow="fullscreen"` and `allowfullscreen` set, but
that alone isn't enough: Nextcloud sends its own `Feature-Policy` header on
every page, restricting `fullscreen` to `'self'` by default. A
`Feature-Policy`/`Permissions-Policy` header from an ancestor document can
only ever *restrict* what a descendant frame may do — a child iframe's own
`allow` attribute can't re-grant a feature the parent's policy header has
already disallowed for that origin. Since Nextdesk's iframe `src` is a
different origin than Nextcloud, `'self'` doesn't cover it, and the
Fullscreen API would silently fail from inside the iframe.

`PageController::index()` fixes this by setting a `FeaturePolicy` on the
response with `addAllowedFullScreenDomain()` for the configured Nextdesk
origin — no admin configuration needed, it's derived from the same URL
already set in Settings → Administration → Nextdesk. Once fullscreen is
requested inside the iframe (e.g. Nextdesk's own fullscreen button), it
behaves like normal browser fullscreen — covering the whole screen, not
just the iframe's box on the Nextcloud page.

---

## Third-party cookie caveat

The iframe puts Nextdesk's origin inside a page served from Nextcloud's
origin — from the browser's point of view, Nextdesk is now a **third-party
context**. If Nextdesk's own session cookie is not marked in a way browsers
treat as embeddable (`SameSite=None; Secure`), some browsers will block it
inside the iframe:

- **Safari (ITP)** and **Firefox (ETP strict)** block third-party cookies by
  default in many configurations.
- **Chrome** is phasing out third-party cookies entirely.

Practical effect: a user might load the Nextdesk iframe and be asked to log
in every time, even though they're already logged into Nextdesk in a normal
tab, because the embedded context can't see that session's cookie.

**Mitigations, in order of how much they actually fix vs. paper over the problem:**

1. Serve Nextcloud and Nextdesk from the same **parent domain** (e.g.
   `cloud.example.com` and `desk.example.com` both under `example.com`).
   This doesn't make them the same origin, but some browsers' third-party
   cookie heuristics are more lenient for same-site (registrable-domain)
   embeds than fully cross-site ones — it is not a guarantee, only an
   improvement.
2. Set Nextdesk's session cookie with `SameSite=None; Secure` when serving
   inside the iframe context, so browsers that *do* allow opted-in
   third-party cookies accept it.
3. If your users are on Safari or a hardened Firefox/Chrome profile, expect
   the iframe to sometimes require a fresh login even with the above — this
   is a browser policy, not a bug in this app. There is no fully reliable
   fix that keeps the iframe approach; the alternative is a full-page
   redirect into Nextdesk (same-origin navigation, no iframe, no
   third-party-cookie exposure at all) if this becomes a real problem for
   your users.

Nextdesk already does that full-page breakout automatically for the "Sign in
with your organisation" (OIDC) button specifically: `Login.tsx` sets
`target="_top"` on that link whenever `window.self !== window.top` (i.e. it's
running inside the embed iframe), so clicking it navigates the whole browser
tab, not just the iframe. This matters even beyond cookies — when Nextcloud
is also the OIDC provider, *its own* login/consent page can refuse to render
nested (framebusting or `X-Frame-Options`) and will otherwise yank the tab
back to a bare Nextcloud page mid-flow instead of completing the redirect
back to Nextdesk. Breaking out before starting the OIDC round trip avoids
that entirely. The link also passes `embed=1` through `/api/auth/oidc/login`
(stored server-side in a short-lived `oidc_embed` cookie alongside the
existing `oidc_state`/`oidc_next` ones), so once the OIDC round trip
completes, `oidc_callback` sends the top-level tab back to
`<your Nextcloud URL>/index.php/apps/nextdesk/` instead of Nextdesk's own
bare `/` — landing the user back inside the Nextcloud embed, now logged in,
rather than stranding them on a full-page Nextdesk tab. The `index.php/`
prefix is deliberate: it works whether or not the Nextcloud instance has
"pretty URLs" (mod_rewrite) configured, whereas the bare `apps/nextdesk/`
form 404s on instances that don't have that rewrite set up. That target
always comes from server-side config, never the client, so there's no
open-redirect risk in trusting it: it prefers the admin's storage-integration
Nextcloud URL
(Admin → Storage → Nextcloud, stored as `nc.url`) and, if that isn't
configured, falls back to deriving the origin from `OIDC_ISSUER` — which is
always set whenever OIDC login works at all, and in the "Nextcloud is the
OIDC provider" setup this targets, already points at that same instance. If
neither yields a usable origin, it falls back to Nextdesk's own `/` (the
old, pre-embed-aware behaviour).

Since Nextdesk itself is typically configured to use Nextcloud as its OIDC
provider ([auth setup](auth-setup.md#nextcloud-recommended--same-instance-as-your-storage)),
a blocked cookie shows up as: the iframe loads Nextdesk's login page, the
user clicks "Sign in", completes OIDC against Nextcloud (already logged in
there, so this is instant), and lands back in a working session — an extra
click, not a broken flow, in the common case.

---

## Open in Nextdesk: Files deep link

Once a Nextdesk URL is configured, right-clicking a file Nextdesk knows how to
open (images, PDFs, Office documents, text/code files — the same set its own
File Manager handles) shows an **Open in Nextdesk** entry in Nextcloud's Files
context menu. Clicking it:

- Opens a **new browser tab** pointed directly at Nextdesk (`<url>/?open=
  <path>`) — deliberately *not* through the existing embedded iframe. This
  sidesteps the [third-party cookie caveat](#third-party-cookie-caveat) above
  entirely: the new tab is a first-party context for Nextdesk, so its session
  cookie always works, whereas the iframe's might not.
- Nextdesk launches (or reaches into an already-running) LibreOffice session
  with the document open, for Office files; for everything else it opens its
  File Manager at the file's folder. This is exactly what double-clicking the
  same file inside Nextdesk's own File Manager already does — the deep link
  just gets you there from Nextcloud.
- If you weren't already logged into Nextdesk in that tab, it sends you
  through login (OIDC or local) and lands back on the same file afterward —
  the target survives the redirect round trip. With Nextcloud configured as
  Nextdesk's OIDC provider (the recommended setup — see
  [auth setup](auth-setup.md#nextcloud-recommended--same-instance-as-your-storage)),
  already being logged into Nextcloud makes this instant.

**Implementation**: `src/files-action.js` registers the action via
`@nextcloud/files`' `registerFileAction()`, built with Vite
(`package.json`/`vite.config.js`) into `js/nextdesk-files-action.mjs` (not
committed — a build artifact, regenerated by `make package-nc-app` / `npm run
build`).
`lib/Listener/LoadFilesActionListener.php` enqueues that bundle on the Files
page — but only once an admin has set a Nextdesk URL, via
`OCP\Files\Events\LoadAdditionalScriptsEvent` — and hands it the configured
URL through Nextcloud's initial-state mechanism. The extension allow-list in
`files-action.js` is kept in sync by hand with
`frontend/src/lib/fileType.ts` on the Nextdesk side, since the two apps don't
share code.

---

## Uninstalling

Settings → Administration → Apps → disable **Nextdesk** (or
`occ app:disable nextdesk`), then delete `custom_apps/nextdesk/`. This only
removes the nav entry and embed page — it has no effect on Nextdesk itself or
on any OIDC configuration between the two.
