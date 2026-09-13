import { registerFileAction, FileAction } from '@nextcloud/files'
import { loadState } from '@nextcloud/initial-state'
import { translate as t } from '@nextcloud/l10n'

// Set by LoadFilesActionListener only when an admin has configured a Nextdesk
// URL (Settings → Administration → Nextdesk) — if it's empty, Nextdesk isn't
// set up yet and this script isn't even enqueued, but guard anyway since
// initial state can be missing in edge cases (e.g. cached page).
const nextdeskUrl = loadState('nextdesk', 'url', '')

// Extensions Nextdesk's own File Manager already knows how to open — kept in
// sync by hand with frontend/src/lib/fileType.ts (OFFICE_EXTS ∪ TEXT_EXTS ∪
// image extensions ∪ pdf) on the Nextdesk side, since this bundle can't share
// that TypeScript module directly. Anything not in this set won't show the
// action at all, so Nextdesk never needs to handle an "unsupported file" deep
// link.
const OPENABLE_EXTENSIONS = new Set([
	// images
	'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg',
	// pdf
	'pdf',
	// office (opens in the LibreOffice VNC session)
	'doc', 'docx', 'odt', 'ott', 'xls', 'xlsx', 'ods', 'ots',
	'ppt', 'pptx', 'odp', 'otp', 'rtf',
	// text / code (opens in Nextdesk's built-in editor)
	'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
	'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
	'sh', 'bash', 'zsh', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'php',
	'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'css', 'html', 'xml', 'sql',
])

// Simple external-link glyph — kept inline so this bundle doesn't need an
// asset pipeline for a single icon.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
	<path fill="currentColor" d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h6v2H5v12h12v-6h2v6c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2z"/>
</svg>`

function extensionOf(name) {
	const i = name.lastIndexOf('.')
	return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

if (nextdeskUrl) {
	registerFileAction(new FileAction({
		id: 'nextdesk-open',
		displayName: () => t('nextdesk', 'Open in Nextdesk'),
		iconSvgInline: () => ICON_SVG,
		enabled(nodes) {
			return nodes.length === 1
				&& !nodes[0].isDirectory
				&& OPENABLE_EXTENSIONS.has(extensionOf(nodes[0].basename))
		},
		async exec(node) {
			// node.path is the NC-root-relative path (e.g. "/Documents/foo.docx"),
			// exactly what Nextdesk's own File Manager and POST /api/sessions
			// open_path already expect — see FileManagerWindow.tsx and
			// backend/app/routers/sessions.py.
			const url = `${nextdeskUrl.replace(/\/+$/, '')}/?open=${encodeURIComponent(node.path)}`
			// A new tab — not the existing embedded iframe — so Nextdesk's own
			// session cookie is always first-party. See the "Third-party cookie
			// caveat" section in docs/nextcloud-app.md for why the iframe can't
			// be relied on for this.
			window.open(url, '_blank', 'noopener')
			return null
		},
		order: 10,
	}))
}
