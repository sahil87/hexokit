// Web Push client helpers: service-worker registration and the opt-in
// subscription flow. Every path is fail-silent / throw-free at the call sites
// the app uses — a missing prerequisite (no SW support, insecure context,
// denied permission) results in a no-op, never a thrown error that could break
// app bootstrap or the command palette.

import { getVapidPublicKey, subscribePush } from "@/api/client";

/** Subscription state for the terminal-themed palette indicator. */
export type PushState = "unsupported" | "denied" | "default" | "subscribed";

/**
 * True when the browser supports the APIs Web Push needs AND the page is a
 * secure context. Service-worker registration and push subscription require a
 * secure context (HTTPS or localhost); over plain HTTP on a remote host the
 * APIs may be present yet registration/subscription will fail, so we gate on
 * `window.isSecureContext` to surface the requirement up front rather than
 * failing silently mid-flow.
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * Register the service worker at the origin root. Guarded by feature
 * detection; resolves to the registration or null (never throws). Safe to call
 * unconditionally on app load.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/**
 * Convert a base64url VAPID key to the byte buffer `applicationServerKey`
 * wants. Backed by an explicit ArrayBuffer (not ArrayBufferLike) so it
 * satisfies the BufferSource type the Push API expects.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Resolve to the ready (active) service-worker registration, or null if no
 * worker activates within `timeoutMs`. `navigator.serviceWorker.ready` never
 * rejects and never resolves until a worker is active — so on a page where the
 * worker never registers/activates (e.g. a subpath where `/sw.js` isn't
 * reachable) it would hang forever. The timeout guards every caller that only
 * needs a best-effort read of the current state.
 */
async function readyRegistration(
  timeoutMs = 3000,
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([
      navigator.serviceWorker.ready.catch(() => null),
      timeout,
    ]);
  } finally {
    // Clear the timer when readiness wins so the common (fast) path doesn't
    // leave a dangling 3s timeout on every call (e.g. mount-time polling).
    clearTimeout(timer);
  }
}

/**
 * Report the current push subscription state without prompting the user. The
 * `serviceWorker.ready` wait is timeout-guarded so this can never hang the
 * caller (e.g. a top-bar indicator querying state on mount).
 */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "default";
  const reg = await readyRegistration();
  if (!reg) return "default";
  try {
    const sub = await reg.pushManager.getSubscription();
    return sub ? "subscribed" : "default";
  } catch {
    return "default";
  }
}

/**
 * Show a local test notification straight from the active service worker,
 * bypassing the server and the browser's push service entirely. This isolates
 * the OS-delivery leg: if a real `rk notify` reports `sent:N` but nothing
 * appears, a successful test here proves the SW + OS path works and the gap is
 * push-delivery-specific; a failing test points at an OS-level notification
 * block (macOS Focus / blocked site permission) instead.
 *
 * Returns true if `showNotification` was invoked, false if a prerequisite was
 * missing (unsupported, permission not granted, no active worker). Never throws.
 */
export async function sendTestNotification(): Promise<boolean> {
  if (!isPushSupported()) return false;
  if (Notification.permission !== "granted") return false;
  const reg = await readyRegistration();
  if (!reg) return false;
  try {
    await reg.showNotification("HexoKit", {
      body: "Test notification — if you can see this, delivery works.",
      icon: "/generated-icons/icon-192.png",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the opt-in flow: request notification permission, fetch the VAPID public
 * key, subscribe via PushManager, and POST the subscription to the server.
 * Returns the resulting state. Aborts silently (returning a non-"subscribed"
 * state) on denial, an insecure/unsupported context, or any error — it never
 * throws, so a palette handler can call it directly.
 */
export async function enablePushSubscription(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";

  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return "default";
  }
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "default";
  }

  try {
    // Register first so a service worker exists to activate — awaiting
    // `navigator.serviceWorker.ready` before any registration can hang forever
    // (it only resolves once a worker is active). `register()` resolves with a
    // usable registration immediately; `ready` then guarantees it has activated
    // before we touch pushManager.
    const reg = await registerServiceWorker();
    if (!reg) return "default";
    // Guard the activation wait — a worker that never activates would otherwise
    // hang the opt-in flow indefinitely. `reg` is still usable for subscribe.
    await readyRegistration();

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = await getVapidPublicKey();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await subscribePush(sub.toJSON());
    return "subscribed";
  } catch {
    // Insecure context, fetch failure, or subscribe rejection — fail silent.
    return "default";
  }
}
