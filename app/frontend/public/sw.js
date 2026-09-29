// HexoKit service worker — Web Push delivery.
//
// Served at the origin root (/sw.js) so its scope covers the whole app. It is
// registered on app load (see src/lib/push.ts). Web Push requires a secure
// context (HTTPS or localhost); registration is skipped silently otherwise.

const DEFAULT_ICON = "/generated-icons/icon-192.png";
const DEFAULT_TITLE = "HexoKit";

// Normalize an untrusted deep-link value to a same-origin path, else "/".
// Accepts only strings starting with "/" but not "//" (a protocol-relative
// "//evil.example" resolves to an EXTERNAL origin), and belt-and-braces
// verifies the resolved URL's origin matches the SW's own.
function sameOriginPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  try {
    const resolved = new URL(value, self.location.origin);
    if (resolved.origin !== self.location.origin) return "/";
  } catch (_e) {
    return "/";
  }
  return value;
}

// `push`: the browser's push service wakes the SW even when the PWA tab is
// closed, delivering the payload POSTed via `rk notify` → /api/notify.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (_e) {
    // Non-JSON or empty payload — fall back to a plain-text body if present.
    try {
      data = { body: event.data ? event.data.text() : "" };
    } catch (_e2) {
      data = {};
    }
  }

  const title = (data && data.title) || DEFAULT_TITLE;
  const body = (data && data.body) || "";
  const icon = (data && data.icon) || DEFAULT_ICON;
  // Optional deep-link target (260714-r7rq) — carried through to
  // `notificationclick` via the notification's `data`. Only accept a
  // same-origin relative path: it must start with "/" but NOT "//" — a
  // protocol-relative "//evil.example" would resolve to an external origin —
  // so a malformed/hostile payload can never redirect elsewhere.
  const url = sameOriginPath(data && data.url);

  event.waitUntil(
    self.registration.showNotification(title, { body, icon, data: { url } }),
  );
});

// `notificationclick`: focus an already-open HexoKit tab and navigate it to the
// notification's deep-link target if one exists; otherwise open a new window at
// that target (falling back to the app root when no target was carried).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = sameOriginPath(data.url);
  // Resolve to an absolute URL against the SW's origin for `client.navigate`
  // (which requires a full URL).
  const absolute = new URL(target, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            // Focus the existing tab and navigate it to the target when we can.
            // `client.navigate()` REJECTS for uncontrolled clients (matchAll
            // above includes them) and may be unavailable in some browsers —
            // in both cases fall back to a plain focus, which at least
            // surfaces the app; a rejection must never propagate into
            // waitUntil (it would surface as an unhandled SW error).
            if ("navigate" in client) {
              return client
                .navigate(absolute)
                .then((c) => (c || client).focus())
                .catch(() => client.focus());
            }
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(absolute);
        return undefined;
      }),
  );
});
