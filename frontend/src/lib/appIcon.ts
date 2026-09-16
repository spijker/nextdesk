import type { App } from "@/types";

// Our own mark — used whenever an app has no curated icon and no better
// guess is available. Always absolute so it also works as a plain string
// wherever icons are stored/rendered as raw strings (desktop pins, taskbar).
export const LWP_LOGO = `${window.location.origin}/nextdesk-logo.png`;

/**
 * Icon to show for an app. Self-service web apps (Profile → My web apps)
 * are just a name + URL with no curated icon_url — guess the target site's
 * favicon before falling back to our own logo, instead of a generic
 * placeholder glyph. Callers rendering an <img> should still set onError to
 * LWP_LOGO in case the favicon guess 404s.
 */
export function appIconUrl(app: Pick<App, "icon_url" | "created_by" | "web_url">): string {
  if (app.icon_url) return app.icon_url;
  if (app.created_by && app.web_url) {
    try {
      return new URL("/favicon.ico", app.web_url).toString();
    } catch {
      /* not a valid URL — fall through to the logo */
    }
  }
  return LWP_LOGO;
}
