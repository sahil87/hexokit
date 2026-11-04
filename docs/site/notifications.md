# Notifications — Setup & Troubleshooting

> [← Back to the README](https://github.com/sahil87/hexokit/blob/main/README.md)

HexoKit can send **Web Push** notifications — real OS-level banners that reach you
even when the HexoKit tab is closed. They're delivered by the browser's push
service waking a service worker, so they work in the background. This page
covers turning them on and fixing the common "I enabled it but nothing shows up"
case.

## Quick start

1. Open HexoKit over a **secure context** — `https://…` or `http://localhost` /
   `http://127.0.0.1`. Web Push will not work over plain `http://` to a LAN IP
   (the browser blocks service workers + `PushManager` outside a secure context).
2. Click the **bell icon** in the top bar (next to the theme toggle) → **Enable
   notifications**, and accept the browser's permission prompt. The bell fills in
   when you're subscribed.
   - Equivalent: `Cmd+K` → **Notifications: Enable push**.
3. Click the bell again → **Send test notification**. A banner should appear.
   - Equivalent: `Cmd+K` → **Notifications: Send test notification**.
4. Fire one from any shell on the box:
   ```sh
   rk notify "hello from the box"
   ```

## "It says it sent, but I see nothing"

This is the most common case, and it is almost never a HexoKit bug — the message
reached the browser's push service but the **OS suppressed the notification**.
The **Send test notification** button is the fastest way to confirm this: it
fires a notification *locally from the service worker*, bypassing the server and
the push service entirely. If the test button shows nothing, the problem is the
OS / browser notification permission, not delivery.

### macOS

1. **System Settings → Notifications → your browser** (e.g. Google Chrome).
   - "Allow notifications" = **on**.
   - Alert style = **Banners** or **Alerts** (not "None").
2. **Turn off Focus / Do Not Disturb** — Control Center (menu bar, top right).
   A Focus mode silently swallows notifications and is the single most common
   culprit.
3. **In the browser**: Settings → Privacy & Security → Site Settings →
   Notifications → confirm the HexoKit site is **Allowed**.

### Windows

1. **Settings → System → Notifications** → your browser is **on**.
2. Turn off **Focus assist / Do not disturb**.
3. In the browser: Site Settings → Notifications → HexoKit site **Allowed**.

### Browser-level (all platforms)

If you previously clicked **Block** on the permission prompt, the site is stuck
denied and re-running "Enable" does nothing. Re-allow it: click the lock/tune
icon in the address bar → Site settings → set **Notifications** to **Allow**,
then reload and enable again.

## Requirements & caveats

- **Secure context required.** Service workers and `PushManager` only run over
  HTTPS or `localhost`/`127.0.0.1`. Hitting HexoKit at a plain `http://<lan-ip>`
  URL will silently fail to subscribe. Tailscale HTTPS (`https://*.ts.net`) and a
  TLS reverse proxy both qualify.
- **iOS** delivers Web Push only to a PWA **added to the Home Screen** — never a
  plain Safari tab.
- **Reverse proxies / subpaths.** The service worker registers at the origin
  root (`/sw.js`). If you serve HexoKit under a subpath (e.g. `/hexokit/`), make
  sure your proxy exposes `/sw.js` and `/api/*` at the origin root (the same host
  HexoKit is reached on) — otherwise registration or subscription can fail even
  though the page loads.
- **One feed per subscription.** Each browser that opts in is its own
  subscription; `rk notify` fans out to all of them. Subscriptions that have
  expired or been revoked are pruned automatically on the next send (you'll see
  `pruned` count in `/api/notify`'s response).

## How it works (for the curious)

```
rk notify "msg"
  → POST /api/notify              (local HexoKit server)
  → webpush-go signs with VAPID   (server-held private key)
  → browser push service (e.g. FCM)
  → wakes the service worker (public/sw.js)
  → showNotification()            (OS banner — tab can be closed)
```

The server reports `{"sent": N, "pruned": M}` — `sent` counts subscriptions the
push service accepted. `sent: 0` with no subscriptions means nobody has opted in
yet; a non-zero `sent` with no visible banner means the OS suppressed it (see
above). The whole chain is fail-silent: a notify failure never blocks the caller.
