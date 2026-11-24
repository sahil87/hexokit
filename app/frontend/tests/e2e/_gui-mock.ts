import { type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// The UNGATED gui-mock scaffolding (no tmux, no Xvnc) shared by
// gui-surface.spec.ts and gui-toolbar-fold.spec.ts: the state-socket mock
// carries a `gui` global slot (delivered on hello, flipped mid-test via
// `emitGui` from _state-socket-mock). The sessions payload's `dev` session
// has two windows — `@1` (a code-capable work window, default layout) and
// `@2` (code-capable, `layout: "split-h:tty,gui"`). `/ws/terminals` is
// accepted and held open; the window `/options` POST and `GET /api/gui/host`
// are route-stubbed; `/ws/gui/` is route-tracked so a test can assert NO
// relay socket is opened while the host is unreachable. The mocked /ws/gui/
// socket is held open without an RFB handshake, so the tile's RFB NEVER
// reaches `connected` in mocked specs.

export const GUI_OFF = [
  { id: "host", enabled: false, backend: "", reachable: false, display: "", width: 0, height: 0, viewers: 0, wm: "", locked: false },
];
export const GUI_ON_UNREACHABLE = [
  { id: "host", enabled: true, backend: "Xtigervnc", reachable: false, display: ":10", width: 0, height: 0, viewers: 0, wm: "", locked: false },
];
export const GUI_REASON = "no VNC backend: sudo apt install --no-install-recommends tigervnc-standalone-server icewm";
export const GUI_ON_BARE = [
  { id: "host", enabled: true, backend: "Xtigervnc", reachable: true, display: ":10", width: 1280, height: 800, viewers: 0, wm: "", locked: false, geometry: "1920x1080" },
];
export const GUI_ON_ICEWM = [{ ...GUI_ON_BARE[0], wm: "icewm-session" }];
// Geometry variants of the reachable icewm entry: a fixed desktop size vs the
// follow-the-tile `auto` value (the palette's Lock/Auto rows key off it).
export const GUI_ON_FIXED = [{ ...GUI_ON_ICEWM[0], geometry: "1600x900" }];
export const GUI_ON_AUTO = [{ ...GUI_ON_ICEWM[0], geometry: "auto" }];
// A 1080p variant for the stats overlay's size segment.
export const GUI_ON_1080P = [{ ...GUI_ON_ICEWM[0], width: 1920, height: 1080 }];
export const GUI_WM_HINT = "sudo apt install --no-install-recommends icewm";
export const GUI_STATUS_BARE = {
  id: "host",
  enabled: true,
  backend: "Xtigervnc",
  reachable: true,
  display: ":10",
  width: 1280,
  height: 800,
  viewers: 0,
  wm: "",
  wm_hint: GUI_WM_HINT,
  socket: "",
  session: "",
  reason: "",
  apps: [],
  uptime_seconds: 0,
};

export const WORK_WINDOW = {
  windowId: "@1",
  index: 0,
  name: "work",
  worktreePath: "/tmp/wt",
  activity: "idle",
  isActiveWindow: true,
  activityTimestamp: 0,
  gitRoot: "/repo",
  panes: [{ paneId: "%1", paneIndex: 0, cwd: "/repo", command: "zsh", isActive: true }],
};
export const GUI_LAYOUT_WINDOW = {
  ...WORK_WINDOW,
  windowId: "@2",
  index: 1,
  name: "gui-tab",
  layout: "split-h:tty,gui",
};

export function sessionsPayload() {
  return JSON.stringify([{ name: "dev", windows: [WORK_WINDOW, GUI_LAYOUT_WINDOW] }]);
}

/** The mocked backend for the ungated half; returns the /ws/gui/ dial count.
 *  `statusDoc` overrides the `GET /api/gui/host` document (the bare-WM strip
 *  tests pass one carrying `wm: ""` and the `wm_hint` install line). */
export async function mockGuiBackend(page: Page, gui: unknown, statusDoc?: unknown) {
  let guiDials = 0;
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.routeWebSocket(/\/ws\/gui\//, () => {
    guiDials += 1;
  });
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: "default", sessionCount: 1 }]),
    }),
  );
  await page.route("**/api/windows/*/options*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  // The mount-time tmux alignment POSTs select when the URL window is not the
  // payload's active one — unstubbed, the rejection ends the switch overlay
  // and the route follows the payload's active window (@1). Stubbed, the
  // static payload never confirms, so the overlay holds the URL for at most
  // the 5 s overlay deadline.
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/gui/host", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        statusDoc ?? {
          id: "host",
          enabled: true,
          backend: "Xtigervnc",
          reachable: false,
          display: ":10",
          width: 0,
          height: 0,
          viewers: 0,
          wm: "",
          socket: "",
          session: "",
          reason: GUI_REASON,
          apps: [],
          uptime_seconds: 0,
        },
      ),
    }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload(), gui });
  // noVNC's Websock.attach() probes the raw channel's properties via
  // Object.keys + prototype names and throws on a miss; Playwright's
  // routeWebSocket mock instance forwards gets through a proxy but exposes
  // nothing to that enumeration, so constructing an RFB against a mocked
  // /ws/gui/ URL would crash the page. Wrap the constructor so /ws/gui/
  // sockets get a prototype carrying the probed names; every other socket
  // keeps the plain mock. Registered AFTER the routeWebSocket calls: init
  // scripts run in registration order, and Playwright's mock injection must
  // install first for this wrapper to ride on top of it.
  await page.addInitScript(() => {
    const probed = ["send", "close", "binaryType", "onerror", "onmessage", "onopen", "protocol", "readyState"];
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        const inner = Reflect.construct(target, args);
        if (!String(args[0]).includes("/ws/gui/")) return inner;
        const patched = Object.create(Object.getPrototypeOf(inner));
        for (const name of probed) {
          Object.defineProperty(patched, name, {
            configurable: true,
            enumerable: true,
            get: () => Reflect.get(inner, name),
            set: (v) => Reflect.set(inner, name, v),
          });
        }
        // Methods bind to the inner socket: the mock extends EventTarget,
        // whose native methods (addEventListener, …) brand-check the receiver
        // and would throw "Illegal invocation" on the proxy.
        return new Proxy(inner, {
          getPrototypeOf: () => patched,
          get: (t, p) => {
            const v = Reflect.get(t, p);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      },
    });
  });
  return { guiDials: () => guiDials };
}

/** The surface-toggle buttons by accessible name, scoped to the banner (the
 *  off-screen measurement probe duplicates every testid — getByRole excludes
 *  it). */
export const toggleButton = (page: Page, name: string) =>
  page.getByRole("banner").getByRole("button", { name });
