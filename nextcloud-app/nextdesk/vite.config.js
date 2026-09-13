import { createAppConfig } from '@nextcloud/vite-config'

// Builds src/files-action.js -> js/nextdesk-files-action.mjs (createAppConfig's
// standard output convention: <appId>-<entry-name>.mjs in js/, outDir/prefix
// left at their defaults rather than overridden — fighting them produces
// double-nested paths). Enqueued server-side by
// lib/Listener/LoadFilesActionListener.php via
// Util::addScript('nextdesk', 'nextdesk-files-action'). Run `npm install &&
// npm run build` before packaging the app zip — see docs/nextcloud-app.md.
export default createAppConfig({
	'files-action': 'src/files-action.js',
}, {
	// js/ also holds the hand-written admin.js (loaded separately by
	// templates/admin.php via the plain `script()` helper, not part of this
	// build) — the default behaviour empties the whole js/ dir before every
	// build, which would delete it. Our one entry has a fixed (unhashed)
	// filename, so nothing goes stale by skipping that.
	emptyOutputDirectory: false,
})
