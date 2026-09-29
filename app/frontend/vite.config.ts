import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Go backend target for the dev proxy: the daemon default + 1 (the single
// source of truth is app/backend/internal/portpolicy/ports.env).
const backendPort = parseInt(process.env.RK_PORT ?? "6123") + 1;
const backendTarget = `http://127.0.0.1:${backendPort}`;
const backendWsTarget = `ws://127.0.0.1:${backendPort}`;

export default defineConfig({
  plugins: [
    react(),
  ],
  // Dep-optimizer cache. Unset means Vite's default node_modules/.vite; the
  // e2e harness's multi-rig lane runs several dev servers from this one
  // checkout at once and gives each its own dir so they never race on the
  // pre-bundle (scripts/test-e2e.sh).
  cacheDir: process.env.VITE_CACHE_DIR || undefined,
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@configs": resolve(__dirname, "../../configs"),
    },
  },
  build: {
    rollupOptions: {
      // Multi-entry: viewer.html is the /present document shell (served by the
      // Go backend from the embedded FS); its mermaid/excalidraw code stays in
      // lazy chunks loaded only for the formats that need it.
      input: {
        main: resolve(__dirname, "index.html"),
        viewer: resolve(__dirname, "viewer.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("@xterm/")) return "xterm";
          if (id.includes("@tanstack/react-router")) return "router";
        },
      },
    },
  },
  server: {
    host: process.env.RK_HOST ?? "127.0.0.1",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
      },
      // Muxed sockets (/ws/state, /ws/terminals). WebSocket, so `ws: true`
      // — without this the dev proxy would not forward the upgrade and the
      // SPA's sockets would fail to connect against `just dev` / `just test-e2e`.
      "/ws": {
        target: backendWsTarget,
        ws: true,
      },
      // NO changeOrigin here (deliberate asymmetry with /api): rk's proxy
      // derives X-Forwarded-Host from the INBOUND Host, and proxied apps
      // (code-server) compare it against the browser's Origin on WebSocket
      // handshakes. changeOrigin would rewrite Host to 127.0.0.1:{backend},
      // making every proxied WS 403 (close 1006) while plain GETs still pass
      // (same-origin GETs carry no Origin header). Preserving the original
      // Host keeps the forwarded-host chain truthful end to end.
      "/proxy": {
        target: backendTarget,
        ws: true,
      },
      // The stable code-server route (260811-a2bo) — forwarded to the Go
      // backend, which proxies to the resolved code-server port. Same rule as
      // /proxy: `ws: true`, NO changeOrigin (the Origin-vs-X-Forwarded-Host
      // WS-403 lesson).
      "/code": {
        target: backendTarget,
        ws: true,
      },
      // The `rk present` content route (/present/{server}/{roothash}/*, plus
      // the one-release legacy /present/{windowId}/* form) — forwarded to the
      // Go backend, which serves files from a declared @rk_win_web_<n>_root.
      // Plain GETs; without this the dev server answers the SPA fallback and
      // presented tiles render run-kit inside themselves. The header marks the
      // request as dev-proxied so the backend's viewer shell boots from this
      // dev server's module graph, never built assets (which may exist after
      // `just build` but are only servable by the Go origin).
      "/present": {
        target: backendTarget,
        headers: { "X-Rk-Dev-Proxy": "1" },
      },
      // PWA identity assets — served dynamically by the Go backend so the
      // instance accent can tint the manifest/icons in dev too. `server.proxy`
      // runs before Vite's public-dir middleware, so these shadow the static
      // copies in public/.
      "/manifest.json": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/generated-icons": {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
});
