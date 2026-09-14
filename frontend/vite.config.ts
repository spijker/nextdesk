import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Hosts allowed to reach the dev/preview server (Vite blocks unknown Host
// headers). Behind a k8s ingress the hostname varies, so default to allowing
// all; pin specific hosts with VITE_ALLOWED_HOSTS="a.example,b.example".
const allowedHosts = process.env.VITE_ALLOWED_HOSTS
  ? process.env.VITE_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
  : true;

export default defineConfig({
  plugins: [react()],
  build: {
    // The TextEditor chunk (CodeMirror + @uiw/codemirror-extensions-langs,
    // which statically bundles every supported language grammar rather than
    // tree-shaking to just the ones used) is a deliberate ~570kB-gzipped
    // lazy chunk — see the lazy(() => import("./TextEditor")) comment in
    // FileManagerWindow.tsx. It's fetched once, only if a file is actually
    // opened, never part of the main bundle. Raised past that chunk's own
    // ~1.6MB size so this known, accepted tradeoff doesn't warn on every
    // build; a genuinely oversized *eager* chunk (main bundle is currently
    // ~730kB) would still be caught.
    chunkSizeWarningLimit: 1700,
  },
  // react-draggable (used by react-rnd) references process.env.NODE_ENV at runtime;
  // Vite doesn't polyfill process so we inject it manually.
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts,
    watch: { usePolling: true },
    proxy: {
      "/api": { target: "http://backend:8000", changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts,
  },
});
