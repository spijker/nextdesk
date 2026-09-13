// File-type classification shared between the in-app File Manager
// ("Open with…" / double-click) and the Nextcloud deep-link landing
// (Desktop.tsx `?open=` handling) — both need to agree on what Nextdesk
// knows how to open.

export const IMAGE_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/svg+xml", "image/bmp", "image/tiff",
]);

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);

// Extensions we open in the built-in text editor (NC often reports a generic
// mime for code files, so match on extension too).
export const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "properties",
  "sh", "bash", "zsh", "fish", "ps1", "bat",
  "js", "cjs", "mjs", "ts", "tsx", "jsx", "vue", "svelte",
  "py", "rb", "php", "pl", "lua", "r", "jl", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cc", "cs",
  "css", "scss", "less", "html", "htm", "xml", "svg", "sql", "graphql", "gql",
  "tf", "hcl", "dockerfile", "gitignore", "editorconfig",
]);
export const TEXT_NAMES = new Set(["Dockerfile", "Makefile", "Jenkinsfile", "LICENSE", "README"]);

// Office documents open in the LibreOffice VNC app (double-click or Open with)
export const OFFICE_EXTS = new Set([
  "doc", "docx", "odt", "ott", "xls", "xlsx", "ods", "ots",
  "ppt", "pptx", "odp", "otp", "rtf",
]);

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function isOffice(item: { name: string; type: string }): boolean {
  if (item.type === "dir") return false;
  return OFFICE_EXTS.has(extOf(item.name));
}

export function isImage(item: { name: string; mime?: string; type: string }): boolean {
  if (item.type === "dir") return false;
  if (item.mime && IMAGE_MIMES.has(item.mime)) return true;
  return IMAGE_EXTS.has(extOf(item.name));
}

export function isPdf(item: { name: string; mime?: string; type: string }): boolean {
  if (item.type === "dir") return false;
  if (item.mime === "application/pdf") return true;
  return extOf(item.name) === "pdf";
}

export function isEditable(item: { name: string; mime?: string; type: string }): boolean {
  if (item.type === "dir") return false;
  if (item.mime?.startsWith("text/")) return true;
  if (TEXT_NAMES.has(item.name)) return true;
  return TEXT_EXTS.has(extOf(item.name));
}

/** Extensions Nextdesk knows how to open at all — used to decide whether the
 * Nextcloud-side "Open in Nextdesk" file action should offer a given file. */
export function isOpenable(item: { name: string; mime?: string; type: string }): boolean {
  return isImage(item) || isPdf(item) || isOffice(item) || isEditable(item);
}
