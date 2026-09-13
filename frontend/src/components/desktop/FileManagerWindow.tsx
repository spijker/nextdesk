import { useRef, useState, useCallback, useEffect, lazy, Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Rnd } from "react-rnd";
import {
  X, Minus, Maximize2, Minimize2, FolderOpen, FileText, Upload, FolderPlus,
  Download, Trash2, ChevronLeft, ChevronRight, Grid3X3, List, ArrowLeft, RefreshCw,
  Image as ImageIcon, Film, Music, File, FileSpreadsheet, Presentation,
  FileArchive, FileCode,
} from "lucide-react";
import { toast } from "sonner";
import client from "@/api/client";
import { useAuthStore } from "@/store/auth";
import { useDesktopStore } from "@/store/desktop";
import { cn } from "@/lib/utils";
import { IMAGE_MIMES, isOffice, isEditable, isImage, isPdf } from "@/lib/fileType";
import type { App, Session } from "@/types";

interface FileItem {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  modified: string;
  mime: string;
}

// Heavy (CodeMirror) — split into its own chunk, loaded only when a file opens.
const TextEditor = lazy(() => import("./TextEditor"));

const QUICK_ACCESS = [
  { label: "Home", path: "/", icon: "🏠" },
  { label: "Documents", path: "/Documents/", icon: "📄" },
  { label: "Downloads", path: "/Downloads/", icon: "⬇️" },
  { label: "Music", path: "/Music/", icon: "🎵" },
  { label: "Pictures", path: "/Pictures/", icon: "🖼️" },
  { label: "Videos", path: "/Videos/", icon: "🎬" },
];

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(s: string): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return s;
  }
}

// Office / archive / code file groups, matched by extension (Nextcloud often
// reports a generic mime for these).
const WORD_EXTS = new Set(["doc", "docx", "odt", "ott", "rtf", "dot", "dotx"]);
const SHEET_EXTS = new Set(["xls", "xlsx", "ods", "ots", "csv", "tsv"]);
const SLIDE_EXTS = new Set(["ppt", "pptx", "odp", "otp"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"]);
const CODE_EXTS = new Set([
  "js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "html", "css", "json",
  "yaml", "yml", "toml", "xml", "sql",
]);

function FileIcon({ item, size = 20 }: { item: FileItem; size?: number }) {
  if (item.type === "dir")
    return <FolderOpen style={{ width: size, height: size }} className="text-amber-400 shrink-0" />;
  const m = item.mime;
  const s = { width: size, height: size };
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";

  if (IMAGE_MIMES.has(m) || isImage(item))
    return <ImageIcon style={s} className="text-blue-400 shrink-0" />;
  if (m === "application/pdf")
    return <FileText style={s} className="text-red-500 shrink-0" />;
  if (WORD_EXTS.has(ext))
    return <FileText style={s} className="text-blue-600 shrink-0" />;
  if (SHEET_EXTS.has(ext))
    return <FileSpreadsheet style={s} className="text-green-600 shrink-0" />;
  if (SLIDE_EXTS.has(ext))
    return <Presentation style={s} className="text-orange-500 shrink-0" />;
  if (ARCHIVE_EXTS.has(ext))
    return <FileArchive style={s} className="text-yellow-600 shrink-0" />;
  if (CODE_EXTS.has(ext))
    return <FileCode style={s} className="text-cyan-500 shrink-0" />;
  if (m.startsWith("text/"))
    return <FileText style={s} className="text-gray-500 shrink-0" />;
  if (m.startsWith("video/"))
    return <Film style={s} className="text-purple-400 shrink-0" />;
  if (m.startsWith("audio/"))
    return <Music style={s} className="text-green-400 shrink-0" />;
  return <File style={s} className="text-gray-400 shrink-0" />;
}

function ThumbnailCell({ item }: { item: FileItem }) {
  const [err, setErr] = useState(false);
  if (item.type === "dir" || !IMAGE_MIMES.has(item.mime) || err) {
    return (
      <div className="flex h-20 w-full items-center justify-center rounded-lg bg-gray-100 dark:bg-white/5">
        <FileIcon item={item} size={32} />
      </div>
    );
  }
  return (
    <div className="h-20 w-full overflow-hidden rounded-lg bg-gray-100 dark:bg-white/5">
      <img
        src={`/api/storage/files/thumbnail?path=${encodeURIComponent(item.path)}&size=160`}
        alt={item.name}
        className="h-full w-full object-cover"
        onError={() => setErr(true)}
      />
    </div>
  );
}

// ── Breadcrumb ─────────────────────────────────────────────────────────────────

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate(p: string): void }) {
  const segments = path.replace(/\/$/, "").split("/").filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-0.5 text-xs text-gray-500 overflow-x-auto dark:text-white/60">
      <button
        onClick={() => onNavigate("/")}
        className="shrink-0 rounded px-1 py-0.5 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"
      >
        Home
      </button>
      {segments.map((seg, i) => {
        const p = "/" + segments.slice(0, i + 1).join("/") + "/";
        return (
          <span key={p} className="flex items-center gap-0.5 shrink-0">
            <ChevronRight className="h-3 w-3 opacity-40" />
            <button
              onClick={() => onNavigate(p)}
              className="rounded px-1 py-0.5 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"
            >
              {seg}
            </button>
          </span>
        );
      })}
    </div>
  );
}

// ── Image Lightbox ─────────────────────────────────────────────────────────────

function Lightbox({ images, startPath, onClose }: { images: string[]; startPath: string; onClose(): void }) {
  const start = Math.max(0, images.indexOf(startPath));
  const [idx, setIdx] = useState(start);
  const path = images[idx] ?? startPath;
  const many = images.length > 1;

  const go = useCallback((d: number) => {
    setIdx((i) => (i + d + images.length) % images.length);
  }, [images.length]);

  // Arrow keys navigate, Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  const name = path.split("/").filter(Boolean).pop() ?? "";

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-3 top-3 rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
      >
        <X className="h-5 w-5" />
      </button>

      {many && (
        <button
          onClick={(e) => { e.stopPropagation(); go(-1); }}
          className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/70 hover:bg-white/10 hover:text-white"
          title="Previous (←)"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      <img
        key={path}
        src={`/api/storage/files/preview?path=${encodeURIComponent(path)}`}
        alt={name}
        className="max-h-full max-w-full object-contain rounded"
        onClick={(e) => e.stopPropagation()}
      />

      {many && (
        <button
          onClick={(e) => { e.stopPropagation(); go(1); }}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/70 hover:bg-white/10 hover:text-white"
          title="Next (→)"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}

      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/70"
        onClick={(e) => e.stopPropagation()}
      >
        {name}{many && <span className="ml-2 text-white/40">{idx + 1} / {images.length}</span>}
      </div>
    </div>
  );
}

// ── PDF Viewer ─────────────────────────────────────────────────────────────────

function PdfViewer({ path, onClose }: { path: string; onClose(): void }) {
  const name = path.split("/").filter(Boolean).pop() ?? "document.pdf";
  const canDownload = !useAuthStore((s) => s.user?.policies?.disable_download);
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-gray-50 dark:bg-[#131320]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-gray-200 px-3 dark:border-white/10">
        <FileText className="h-4 w-4 text-red-400" />
        <span className="flex-1 truncate text-xs font-semibold text-gray-700 dark:text-white/80">{name}</span>
        {canDownload && (
        <a
          href={`/api/storage/files/download?path=${encodeURIComponent(path)}`}
          download={name}
          className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
          title="Download"
        >
          <Download className="h-4 w-4" />
        </a>
        )}
        <button
          onClick={onClose}
          className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <iframe
        src={`/api/storage/files/preview?path=${encodeURIComponent(path)}`}
        className="flex-1 border-0 bg-white"
        title={name}
      />
    </div>
  );
}

// ── Context menu ───────────────────────────────────────────────────────────────

function ItemContextMenu({
  item, x, y, onClose, onDelete, onDownload, onWallpaper, openWithApps, onOpenWith,
}: {
  item: FileItem;
  x: number; y: number;
  onClose(): void;
  onDelete(): void;
  onDownload(): void;
  onWallpaper(): void;
  openWithApps: App[];
  onOpenWith(appId: string): void;
}) {
  const canDownload = !useAuthStore((s) => s.user?.policies?.disable_download);
  const itemCls = "flex w-full items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-100 dark:text-white/80 dark:hover:bg-white/10";
  return (
    <>
      <div className="fixed inset-0 z-[100]" onClick={onClose} />
      <div
        className="fixed z-[101] min-w-[180px] rounded-xl border border-gray-200 bg-white py-1 shadow-2xl text-sm dark:border-white/10 dark:bg-gray-900"
        style={{ left: x, top: y }}
      >
        {isImage(item) && (
          <button onClick={() => { onWallpaper(); onClose(); }} className={itemCls}>
            <ImageIcon className="h-3.5 w-3.5" /> Set as wallpaper
          </button>
        )}
        {item.type === "file" && canDownload && (
          <button onClick={() => { onDownload(); onClose(); }} className={itemCls}>
            <Download className="h-3.5 w-3.5" /> Download
          </button>
        )}
        {item.type === "file" && openWithApps.length > 0 && (
          <>
            <div className="my-1 border-t border-gray-100 dark:border-white/10" />
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Open with
            </div>
            <div className="max-h-48 overflow-y-auto">
              {openWithApps.map((a) => (
                <button key={a.id} onClick={() => { onOpenWith(a.id); onClose(); }} className={itemCls}>
                  {a.icon_url
                    ? <img src={a.icon_url} alt="" className="h-3.5 w-3.5 object-contain" />
                    : <File className="h-3.5 w-3.5" />}
                  {a.name}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="my-1 border-t border-gray-100 dark:border-white/10" />
        <button
          onClick={() => { onDelete(); onClose(); }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-red-500 hover:bg-gray-100 dark:text-red-400 dark:hover:bg-white/10"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

const TASKBAR_H = 48;

export function FileManagerWindow() {
  const { setFileManagerOpen, fileManagerPath, fileManagerZ, focusFileManager, fileManagerViewMode, setFileManagerViewMode } = useDesktopStore();
  const policies = useAuthStore((s) => s.user?.policies);
  const canUpload = !policies?.disable_upload;
  const [path, setPath] = useState(fileManagerPath || "/");
  const [history, setHistory] = useState<string[]>([]);
  const [maximized, setMaximized] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const viewMode = fileManagerViewMode;
  const setViewMode = setFileManagerViewMode;
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; item: FileItem } | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  // Determine if we're accessing local container filesystem or Nextcloud
  const isLocalPath = path.startsWith("/home/lwp/Mount/") || path.startsWith("/home/lwp/");
  
  const { data: files = [], isLoading, refetch } = useQuery<FileItem[]>({
    queryKey: ["storage-files", path],
    queryFn: () => {
      if (isLocalPath) {
        return client.get("/api/storage/local/files", { params: { path } }).then((r) => r.data);
      }
      return client.get("/api/storage/files", { params: { path } }).then((r) => r.data);
    },
    retry: false,
  });

  // "Open with…" — launch a desktop app session with the file (NC mount path)
  const { data: apps = [] } = useQuery<App[]>({
    queryKey: ["apps"],
    queryFn: () => client.get("/api/apps").then((r) => r.data),
    staleTime: 60_000,
  });
  const desktopApps = apps.filter((a) => a.app_type !== "web" && !a.web_native && !a.is_vpn);
  
  // Load mounted drives (SFTP, S3, etc.)
  const { data: mounts = [] } = useQuery<{ id: string; name: string; provider: string; mount_path: string }[]>({
    queryKey: ["storage-mounts"],
    queryFn: () => client.get("/api/storage/mounts").then((r) => r.data),
    retry: false,
  });

  const openWithMut = useMutation({
    mutationFn: ({ appId, filePath }: { appId: string; filePath: string }) =>
      client.post<Session>("/api/sessions", { app_id: appId, open_path: filePath }),
    onSuccess: (res) => {
      const app = apps.find((a) => a.id === res.data.app_id);
      if (app) useDesktopStore.getState().openWindow(res.data, app);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(`Opening in ${app?.name ?? "app"}…`);
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { detail?: string } } };
      toast.error(err.response?.data?.detail ?? "Launch failed");
    },
  });

  const setAsWallpaper = (item: FileItem) => {
    // Thumbnail endpoint returns a rendered, sized image (works for any source
    // format and always displays), unlike the raw file stream.
    const endpoint = isLocalPath ? "/api/storage/local/files/thumbnail" : "/api/storage/files/thumbnail";
    useDesktopStore.getState().setWallpaper(
      `${endpoint}?path=${encodeURIComponent(item.path)}&size=1920`
    );
    toast.success("Wallpaper set");
  };

  // Helper to determine the correct API endpoint based on path
  const getApiEndpoint = (_path: string) => {
    return isLocalPath ? "/api/storage/local" : "/api/storage";
  };

  const deleteMut = useMutation({
    mutationFn: (p: string) => client.delete(`${getApiEndpoint(p)}/files`, { params: { path: p } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["storage-files", path] }); toast.success("Deleted"); },
    onError: () => toast.error("Delete failed"),
  });

  const mkdirMut = useMutation({
    mutationFn: (p: string) => client.post(`${getApiEndpoint(p)}/files/mkdir`, null, { params: { path: p } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["storage-files", path] }); toast.success("Folder created"); },
    onError: () => toast.error("Failed to create folder"),
  });

  const uploadMut = useMutation({
    mutationFn: ({ file, dir }: { file: File; dir: string }) => {
      const form = new FormData();
      form.append("file", file);
      return client.post(`${getApiEndpoint(dir)}/files/upload`, form, { params: { path: dir } });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["storage-files", path] }); toast.success("Upload complete"); },
    onError: () => toast.error("Upload failed"),
  });

  const navigate = useCallback((p: string) => {
    setHistory((h) => [...h, path]);
    setPath(p);
    setLightbox(null);
    setPdfPath(null);
    setEditorPath(null);
  }, [path]);

  const goBack = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setPath(prev);
    setLightbox(null);
    setPdfPath(null);
    setEditorPath(null);
  };

  const openItem = (item: FileItem) => {
    if (item.type === "dir") { navigate(item.path); return; }
    if (IMAGE_MIMES.has(item.mime)) { setLightbox(item.path); return; }
    if (isPdf(item)) { setPdfPath(item.path); return; }
    // Office documents → LibreOffice VNC session with the file open
    if (isOffice(item)) {
      const lo = apps.find((a) => a.name === "LibreOffice");
      if (lo) { openWithMut.mutate({ appId: lo.id, filePath: item.path }); return; }
    }
    if (isEditable(item)) { setEditorPath(item.path); return; }
    window.open(`/api/storage/files/download?path=${encodeURIComponent(item.path)}`, "_blank");
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach((file) =>
      uploadMut.mutate({ file, dir: path })
    );
    e.target.value = "";
  };

  const handleNewFolder = () => {
    const name = window.prompt("Folder name:");
    if (!name?.trim()) return;
    mkdirMut.mutate(path.replace(/\/$/, "") + "/" + name.trim() + "/");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!canUpload) { toast.error("Uploads are disabled by policy"); return; }
    Array.from(e.dataTransfer.files).forEach((file) =>
      uploadMut.mutate({ file, dir: path })
    );
  };

  if (minimized) return null;

  const content = (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-xl border transition-[box-shadow,border-color]",
        "bg-gray-50 border-gray-300 shadow-[0_24px_64px_rgba(0,0,0,0.2)]",
        "dark:bg-[#131320] dark:border-white/[0.13] dark:shadow-[0_24px_64px_rgba(0,0,0,0.75),0_0_0_0.5px_rgba(255,255,255,0.08)]",
      )}
      onMouseDown={focusFileManager}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {/* ── Title bar ── */}
      <div
        className="fm-drag flex h-10 shrink-0 cursor-move select-none items-center gap-2 px-3 border-b bg-indigo-50 border-indigo-200 dark:bg-[#1e1e38] dark:border-white/[0.07]"
        onDoubleClick={() => setMaximized((v) => !v)}
      >
        <FolderOpen className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0" />
        <span className="flex-1 text-xs font-semibold text-gray-800 dark:text-gray-100 truncate">
          Files — {path === "/" ? "Home" : path.replace(/\/$/, "").split("/").pop()}
        </span>
        <div className="flex items-center gap-1.5">
          <WinBtn color="#febc2e" title="Minimise" onClick={() => setMinimized(true)}>
            <Minus className="h-2 w-2" strokeWidth={3} />
          </WinBtn>
          <WinBtn color="#28c840" title={maximized ? "Restore" : "Maximise"} onClick={() => setMaximized((v) => !v)}>
            {maximized ? <Minimize2 className="h-2 w-2" strokeWidth={3} /> : <Maximize2 className="h-2 w-2" strokeWidth={3} />}
          </WinBtn>
          <WinBtn color="#ff5f57" title="Close" onClick={() => setFileManagerOpen(false)}>
            <X className="h-2 w-2" strokeWidth={3} />
          </WinBtn>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 relative">
        {/* ── Sidebar ── */}
        <aside className="w-36 shrink-0 border-r border-gray-200 bg-gray-100 overflow-y-auto dark:border-white/[0.06] dark:bg-[#111128]">
          <div className="py-2">
            {QUICK_ACCESS.map((qa) => (
              <button
                key={qa.path}
                onClick={() => navigate(qa.path)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                  path === qa.path
                    ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-600/20 dark:text-white"
                    : "text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-white/60 dark:hover:bg-white/5 dark:hover:text-white",
                )}
              >
                <span className="shrink-0">{qa.icon}</span>
                {qa.label}
              </button>
            ))}
            {mounts.length > 0 && (
              <>
                <div className="my-2 h-px bg-gray-200 dark:bg-white/10" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-white/40">
                  Drives
                </div>
                {mounts.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => navigate(m.mount_path)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                      path.startsWith(m.mount_path)
                        ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-600/20 dark:text-white"
                        : "text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-white/60 dark:hover:bg-white/5 dark:hover:text-white",
                    )}
                  >
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
                    <span className="truncate flex-1">{m.name}</span>
                    <span className="text-[10px] text-gray-400 dark:text-white/40">{m.provider}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </aside>

        {/* ── Main pane ── */}
        <div className="flex flex-1 min-w-0 flex-col bg-white dark:bg-[#131320]">
          {/* Toolbar */}
          <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-white/[0.06]">
            <button
              onClick={goBack}
              disabled={!history.length}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
              title="Back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => refetch()}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
              title="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
            </button>
            <div className="flex-1 min-w-0">
              <Breadcrumb path={path} onNavigate={navigate} />
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleNewFolder}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
                title="New folder"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
              {canUpload && (
              <button
                onClick={() => uploadRef.current?.click()}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
                title="Upload file"
              >
                <Upload className="h-3.5 w-3.5" />
              </button>
              )}
              <div className="mx-1 h-3 w-px bg-gray-200 dark:bg-white/10" />
              <button
                onClick={() => setViewMode("grid")}
                className={cn("rounded p-1", viewMode === "grid" ? "text-indigo-600 dark:text-white" : "text-gray-400 hover:text-gray-700 dark:text-white/30 dark:hover:text-white")}
                title="Grid view"
              >
                <Grid3X3 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setViewMode("list")}
                className={cn("rounded p-1", viewMode === "list" ? "text-indigo-600 dark:text-white" : "text-gray-400 hover:text-gray-700 dark:text-white/30 dark:hover:text-white")}
                title="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
            <input ref={uploadRef} type="file" multiple className="hidden" onChange={handleUpload} />
          </div>

          {/* File area */}
          <div
            className={cn(
              "relative flex-1 min-h-0 overflow-y-auto p-3",
              dragging && "ring-2 ring-inset ring-indigo-500",
            )}
          >
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-gray-400 dark:text-white/30 text-sm">
                <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading…
              </div>
            ) : files.length === 0 ? (
              <div className="flex h-full items-center justify-center text-gray-300 dark:text-white/20 text-sm">
                Empty folder
              </div>
            ) : viewMode === "grid" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
                {files.map((item) => (
                  <button
                    key={item.path}
                    onDoubleClick={() => openItem(item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtx({ x: e.clientX, y: e.clientY, item });
                    }}
                    className="group flex flex-col items-center gap-1.5 rounded-lg p-2 text-center transition-colors hover:bg-gray-100 active:bg-gray-200 focus:outline-none dark:hover:bg-white/10 dark:active:bg-white/20"
                  >
                    <ThumbnailCell item={item} />
                    <span className="w-full truncate text-xs text-gray-700 group-hover:text-gray-900 dark:text-white/80 dark:group-hover:text-white">
                      {item.name}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <table className="w-full text-xs text-gray-600 dark:text-white/70">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-400 dark:border-white/[0.06] dark:text-white/30">
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium text-right">Size</th>
                    <th className="pb-2 pl-4 font-medium">Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((item) => (
                    <tr
                      key={item.path}
                      onDoubleClick={() => openItem(item)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtx({ x: e.clientX, y: e.clientY, item });
                      }}
                      className="cursor-default border-b border-gray-100 hover:bg-gray-50 dark:border-white/[0.04] dark:hover:bg-white/5"
                    >
                      <td className="py-1.5">
                        <div className="flex items-center gap-2">
                          <FileIcon item={item} size={14} />
                          <span className="truncate max-w-[200px] text-gray-800 dark:text-white/80">{item.name}</span>
                        </div>
                      </td>
                      <td className="py-1.5 text-right text-gray-400 dark:text-white/40">
                        {item.type === "file" ? formatSize(item.size) : "—"}
                      </td>
                      <td className="py-1.5 pl-4 text-gray-400 dark:text-white/40">{formatDate(item.modified)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Drop hint */}
            {dragging && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-indigo-500/10 text-sm font-semibold text-indigo-600 dark:text-indigo-300">
                Drop files to upload
              </div>
            )}

            {/* Upload progress */}
            {uploadMut.isPending && (
              <div className="absolute bottom-3 right-3 rounded-xl bg-white border border-gray-200 px-3 py-2 text-xs text-gray-600 shadow-xl dark:bg-gray-800 dark:border-transparent dark:text-white/70">
                <RefreshCw className="mr-1.5 inline h-3 w-3 animate-spin" /> Uploading…
              </div>
            )}
          </div>
        </div>

        {/* Native viewers — overlay inside the window */}
        {lightbox && (
          <Lightbox
            images={files.filter((f) => IMAGE_MIMES.has(f.mime)).map((f) => f.path)}
            startPath={lightbox}
            onClose={() => setLightbox(null)}
          />
        )}
        {pdfPath && <PdfViewer path={pdfPath} onClose={() => setPdfPath(null)} />}
        {editorPath && (
          <Suspense fallback={<div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-50 text-xs text-gray-400 dark:bg-[#131320]">Loading editor…</div>}>
            <TextEditor
              path={editorPath}
              onClose={() => setEditorPath(null)}
              onSaved={() => refetch()}
            />
          </Suspense>
        )}
      </div>
    </div>
  );

  if (maximized) {
    return (
      <div
        className="fixed left-0 top-0"
        style={{ width: "100vw", height: `calc(100vh - ${TASKBAR_H}px)`, zIndex: fileManagerZ }}
      >
        {content}
        {ctx && (
          <ItemContextMenu
            item={ctx.item}
            x={ctx.x} y={ctx.y}
            onClose={() => setCtx(null)}
            onDelete={() => deleteMut.mutate(ctx.item.path)}
            onDownload={() => window.open(`/api/storage/files/download?path=${encodeURIComponent(ctx.item.path)}`, "_blank")}
            onWallpaper={() => setAsWallpaper(ctx.item)}
            openWithApps={desktopApps}
            onOpenWith={(appId) => openWithMut.mutate({ appId, filePath: ctx.item.path })}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <Rnd
        default={{
          x: 100,
          y: 50,
          width: Math.min(960, window.innerWidth - 120),
          height: Math.min(640, window.innerHeight - TASKBAR_H - 80),
        }}
        minWidth={600}
        minHeight={400}
        bounds="window"
        dragHandleClassName="fm-drag"
        cancel="button"
        style={{ zIndex: fileManagerZ, position: "fixed" }}
      >
        {content}
      </Rnd>
      {ctx && (
        <ItemContextMenu
          item={ctx.item}
          x={ctx.x} y={ctx.y}
          onClose={() => setCtx(null)}
          onDelete={() => deleteMut.mutate(ctx.item.path)}
          onDownload={() => window.open(`/api/storage/files/download?path=${encodeURIComponent(ctx.item.path)}`, "_blank")}
          onWallpaper={() => setAsWallpaper(ctx.item)}
          openWithApps={desktopApps}
          onOpenWith={(appId) => openWithMut.mutate({ appId, filePath: ctx.item.path })}
        />
      )}
    </>
  );
}

// ── Window control button ──────────────────────────────────────────────────────

function WinBtn({
  color, title, onClick, children,
}: {
  color: string;
  title: string;
  onClick(): void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90"
      style={{ background: color, opacity: hover ? 1 : 0.85 }}
    >
      <span style={{ opacity: hover ? 1 : 0, color: "rgba(0,0,0,0.65)" }}>{children}</span>
    </button>
  );
}
