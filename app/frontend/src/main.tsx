// MUST stay the first import: its body copies legacy `runkit-*`/`runkit:`
// localStorage keys to their `hexokit` counterparts before any app module
// evaluates (see legacy-storage-boot.ts). A static import keeps the first
// render synchronous with module evaluation.
import "@/lib/legacy-storage-boot";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { registerServiceWorker } from "@/lib/push";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

// Register the Web Push service worker on app load. Guarded + fail-silent: a
// browser without service-worker support (or an insecure context) is a no-op.
void registerServiceWorker();
