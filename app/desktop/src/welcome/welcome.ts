/**
 * Welcome-page renderer script. Compiled to dist/welcome/welcome.js and loaded
 * via a plain <script src> — deliberately NO import/export statements, so the
 * emitted JS stays a browser-runnable script (no require/exports references).
 *
 * Remote flow: validate → `welcome:test-host` ping (main process) →
 * `welcome:add-host` (persist + set active; the display name auto-derives
 * from the ping's returned hostname when the optional Name field is blank —
 * post-add corrections live in the SPA dropdown's Edit Host dialog).
 * `?mode=add` shows a cancel link back to the active host.
 *
 * Hosts rung ("Your Hosts" section): a one-shot `servers:list` fetch renders
 * registered hosts above the This Mac section, with the SPA strip dropdown's
 * row anatomy (accent bar, ✓ marker, name, dimmed origin, ⌥⌘n/Alt+n hint).
 * Click/Enter switches via `servers:switch`. The page is already a
 * privileged `servers:*` sender, so no new IPC is added; an absent `servers`
 * bridge group or a failed list answer leaves the section hidden (graceful
 * degradation). ⇧⌘H (⇧Ctrl+H on win/linux) is handled locally: it focuses
 * the list, or the URL field when no hosts are listed.
 *
 * Local flow ("This Mac" section, darwin/linux only — suppressed on win32):
 * polls `daemon:status` every 3s while the page is visible and renders the
 * five states — running (green dot, Connect + Stop), stopped (grey dot,
 * single "Start & connect"), wedged (amber, Restart), starting/restarting…
 * (amber, buttons disabled), and not-installed (brew-install hint). Start,
 * Connect, and Restart each keep the main-side connect tail; Stop invokes
 * `daemon:stop` (main shows the tmux-sessions-survive confirm).
 *
 * The preload bridge is read via structural narrowing (no Window global
 * augmentation, no `as` casts) — the page degrades to an inline error when
 * opened outside the shell.
 */

const LOCAL_STATUS_POLL_MS = 3000;

interface WelcomeBridge {
  testHost(url: string): Promise<unknown>;
  addHost(name: string, url: string): Promise<unknown>;
  cancel(): Promise<unknown>;
}

interface DaemonBridge {
  status(): Promise<unknown>;
  start(): Promise<unknown>;
  restart(): Promise<unknown>;
  stop(): Promise<unknown>;
}

interface RemoteBridge {
  connect(target: string): Promise<unknown>;
  onProgress(handler: (line: string) => void): void;
}

interface ServersBridge {
  list(): Promise<unknown>;
  switch(id: string): Promise<unknown>;
}

interface WelcomeElements {
  form: HTMLFormElement;
  urlInput: HTMLInputElement;
  nameInput: HTMLInputElement;
  errorEl: HTMLElement;
  connectButton: HTMLButtonElement;
  cancelLink: HTMLAnchorElement;
  hostsSection: HTMLElement;
  hostsList: HTMLElement;
  localSection: HTMLElement;
  localHeading: HTMLElement;
  localStatusRow: HTMLElement;
  localDot: HTMLElement;
  localStatus: HTMLElement;
  localDetail: HTMLElement;
  localHint: HTMLElement;
  localConnect: HTMLButtonElement;
  localStop: HTMLButtonElement;
  localError: HTMLElement;
  sshSection: HTMLElement;
  sshTarget: HTMLInputElement;
  sshConnect: HTMLButtonElement;
  sshProgress: HTMLElement;
  sshError: HTMLElement;
}

interface PingOk {
  ok: true;
  origin: string;
  hostname: string;
}

/** One row of the Your Hosts list (the servers:list projection, narrowed). */
interface HostRow {
  id: string;
  name: string;
  origin: string;
  active: boolean;
  accentColor: string | null;
  hint: string | null;
}

/** Focus handle for the Your Hosts list — the ⇧⌘H chord's target. */
interface HostListHandle {
  /** Focus the roving seat (first row); false when the list is empty. */
  focusFirst(): boolean;
}

/** Mirror of the main process's DaemonStatus (structurally re-narrowed here). */
type LocalDaemonStatus =
  | { installed: false }
  | { installed: true; state: "stopped" | "wedged"; version: string | null; origin: string }
  | {
      installed: true;
      state: "running";
      version: string | null;
      origin: string;
      hostname: string;
      sessions: number | null;
    };

/** Narrow `window.runkitShell.__welcome` to the bridge shape. */
function getWelcomeBridge(): WelcomeBridge | null {
  const shell: unknown = Reflect.get(window, "runkitShell");
  if (typeof shell !== "object" || shell === null || !("__welcome" in shell)) return null;
  const candidate = shell.__welcome;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("testHost" in candidate) || !("addHost" in candidate) || !("cancel" in candidate)) {
    return null;
  }
  // Bind narrowed consts — const narrowing (unlike property narrowing) is
  // preserved inside the closures below.
  const { testHost, addHost, cancel } = candidate;
  if (
    typeof testHost !== "function" ||
    typeof addHost !== "function" ||
    typeof cancel !== "function"
  ) {
    return null;
  }
  return {
    testHost: (url: string): Promise<unknown> => Promise.resolve(testHost(url)),
    addHost: (name: string, url: string): Promise<unknown> =>
      Promise.resolve(addHost(name, url)),
    cancel: (): Promise<unknown> => Promise.resolve(cancel()),
  };
}

/** Narrow `window.runkitShell.__daemon` to the daemon-bridge shape. */
function getDaemonBridge(): DaemonBridge | null {
  const shell: unknown = Reflect.get(window, "runkitShell");
  if (typeof shell !== "object" || shell === null || !("__daemon" in shell)) return null;
  const candidate = shell.__daemon;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("status" in candidate) || !("start" in candidate) || !("restart" in candidate) || !("stop" in candidate)) return null;
  const { status, start, restart, stop } = candidate;
  if (typeof status !== "function" || typeof start !== "function" || typeof restart !== "function" || typeof stop !== "function") {
    return null;
  }
  return {
    status: (): Promise<unknown> => Promise.resolve(status()),
    start: (): Promise<unknown> => Promise.resolve(start()),
    restart: (): Promise<unknown> => Promise.resolve(restart()),
    stop: (): Promise<unknown> => Promise.resolve(stop()),
  };
}

/** Narrow `window.runkitShell.__remote` to the remote-bridge shape. */
function getRemoteBridge(): RemoteBridge | null {
  const shell: unknown = Reflect.get(window, "runkitShell");
  if (typeof shell !== "object" || shell === null || !("__remote" in shell)) return null;
  const candidate = shell.__remote;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("connect" in candidate) || !("onProgress" in candidate)) return null;
  const { connect, onProgress } = candidate;
  if (typeof connect !== "function" || typeof onProgress !== "function") return null;
  return {
    connect: (target: string): Promise<unknown> => Promise.resolve(connect(target)),
    onProgress: (handler: (line: string) => void): void => {
      onProgress(handler);
    },
  };
}

/** Narrow `window.runkitShell.servers` to the list/switch shape the hosts
 *  rung consumes (the SPA's switcher group — an older preload without it
 *  narrows to null and the section stays hidden). */
function getServersBridge(): ServersBridge | null {
  const shell: unknown = Reflect.get(window, "runkitShell");
  if (typeof shell !== "object" || shell === null || !("servers" in shell)) return null;
  const candidate = shell.servers;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("list" in candidate) || !("switch" in candidate)) return null;
  const { list, switch: switchHost } = candidate;
  if (typeof list !== "function" || typeof switchHost !== "function") return null;
  return {
    list: (): Promise<unknown> => Promise.resolve(list()),
    switch: (id: string): Promise<unknown> => Promise.resolve(switchHost(id)),
  };
}

/** Narrow `window.runkitShell.platform` (drives the local-section heading). */
function getShellPlatform(): string | null {
  const shell: unknown = Reflect.get(window, "runkitShell");
  if (typeof shell !== "object" || shell === null || !("platform" in shell)) return null;
  return typeof shell.platform === "string" ? shell.platform : null;
}

function getWelcomeElements(): WelcomeElements | null {
  const form = document.getElementById("connect-form");
  const urlInput = document.getElementById("url");
  const nameInput = document.getElementById("name");
  const errorEl = document.getElementById("error");
  const connectButton = document.getElementById("connect");
  const cancelLink = document.getElementById("cancel");
  const hostsSection = document.getElementById("hosts");
  const hostsList = document.getElementById("hosts-list");
  const localSection = document.getElementById("local");
  const localHeading = document.getElementById("local-heading");
  const localStatusRow = document.getElementById("local-status-row");
  const localDot = document.getElementById("local-dot");
  const localStatus = document.getElementById("local-status");
  const localDetail = document.getElementById("local-detail");
  const localHint = document.getElementById("local-hint");
  const localConnect = document.getElementById("local-connect");
  const localStop = document.getElementById("local-stop");
  const localError = document.getElementById("local-error");
  const sshSection = document.getElementById("ssh");
  const sshTarget = document.getElementById("ssh-target");
  const sshConnect = document.getElementById("ssh-connect");
  const sshProgress = document.getElementById("ssh-progress");
  const sshError = document.getElementById("ssh-error");
  if (
    !(form instanceof HTMLFormElement) ||
    !(urlInput instanceof HTMLInputElement) ||
    !(nameInput instanceof HTMLInputElement) ||
    !(errorEl instanceof HTMLElement) ||
    !(connectButton instanceof HTMLButtonElement) ||
    !(cancelLink instanceof HTMLAnchorElement) ||
    !(hostsSection instanceof HTMLElement) ||
    !(hostsList instanceof HTMLElement) ||
    !(localSection instanceof HTMLElement) ||
    !(localHeading instanceof HTMLElement) ||
    !(localStatusRow instanceof HTMLElement) ||
    !(localDot instanceof HTMLElement) ||
    !(localStatus instanceof HTMLElement) ||
    !(localDetail instanceof HTMLElement) ||
    !(localHint instanceof HTMLElement) ||
    !(localConnect instanceof HTMLButtonElement) ||
    !(localStop instanceof HTMLButtonElement) ||
    !(localError instanceof HTMLElement) ||
    !(sshSection instanceof HTMLElement) ||
    !(sshTarget instanceof HTMLInputElement) ||
    !(sshConnect instanceof HTMLButtonElement) ||
    !(sshProgress instanceof HTMLElement) ||
    !(sshError instanceof HTMLElement)
  ) {
    return null;
  }
  return {
    form,
    urlInput,
    nameInput,
    errorEl,
    connectButton,
    cancelLink,
    hostsSection,
    hostsList,
    localSection,
    localHeading,
    localStatusRow,
    localDot,
    localStatus,
    localDetail,
    localHint,
    localConnect,
    localStop,
    localError,
    sshSection,
    sshTarget,
    sshConnect,
    sshProgress,
    sshError,
  };
}

/** Narrow an IPC result to the ping success shape. */
function isPingOk(value: unknown): value is PingOk {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value) || value.ok !== true) return false;
  if (!("origin" in value) || typeof value.origin !== "string") return false;
  return "hostname" in value && typeof value.hostname === "string";
}

/** Narrow an IPC result to `{ ok: true }`. */
function isAckOk(value: unknown): value is { ok: true } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

type DaemonActionOutcome = "acted" | "declined" | "failed";

function daemonActionOutcome(value: unknown): DaemonActionOutcome {
  if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true) {
    return "failed";
  }
  if (!("outcome" in value)) return "acted";
  return value.outcome === "declined" ? "declined" : "failed";
}

/** Extract the error string from a failed IPC result, with a generic fallback. */
function errorOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "error" in value) {
    if (typeof value.error === "string") return value.error;
  }
  return "Something went wrong — check the URL and try again";
}

/** Narrow one daemon status object (the `status` field of a daemon:status ok-envelope). */
function narrowDaemonStatus(value: unknown): LocalDaemonStatus | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("installed" in value) || typeof value.installed !== "boolean") return null;
  if (!value.installed) return { installed: false };
  if (!("state" in value) || typeof value.state !== "string") return null;
  if (!("origin" in value) || typeof value.origin !== "string") return null;
  const version =
    "version" in value && typeof value.version === "string" ? value.version : null;
  if (value.state === "stopped" || value.state === "wedged") {
    return { installed: true, state: value.state, version, origin: value.origin };
  }
  if (value.state !== "running") return null;
  const hostname =
    "hostname" in value && typeof value.hostname === "string" ? value.hostname : "";
  const sessions =
    "sessions" in value && typeof value.sessions === "number" ? value.sessions : null;
  return { installed: true, state: "running", version, origin: value.origin, hostname, sessions };
}

/** Narrow a `daemon:status` result envelope to a status, else null. */
function daemonStatusOf(value: unknown): LocalDaemonStatus | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("ok" in value) || value.ok !== true || !("status" in value)) return null;
  return narrowDaemonStatus(value.status);
}

/** `http://127.0.0.1:6123` → `127.0.0.1:6123` (the mock's `{host}:{port}`). */
function hostPortOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Strict hex gate before style interpolation — the SPA row model's
 *  `HOST_ACCENT_HEX` (lib/shell-strip.ts), mirrored by value: this page is a
 *  global script and cannot import SPA modules. */
const HOST_ACCENT_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Accelerator-hint cap — mirrors the native Hosts menu's binding cap (hosts
 *  beyond the ninth get no binding, so they get no hint either). */
const MAX_SWITCHER_HINTS = 9;

/** Trailing accelerator hint for the host at `index` (list order — the
 *  native Hosts menu binds in the same order): `⌥⌘{n}` on darwin, `Alt+{n}`
 *  elsewhere; null past the cap. Mirrors the SPA's `hostAcceleratorHint`. */
function hostAcceleratorHint(platform: string, index: number): string | null {
  if (index >= MAX_SWITCHER_HINTS) return null;
  return platform === "darwin" ? `⌥⌘${index + 1}` : `Alt+${index + 1}`;
}

/** The entry's origin for display; a malformed url falls back to the raw
 *  string (the SPA's `hostOrigin`). */
function hostOriginOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Narrow one servers:list entry to a row, or null on a malformed projection. */
function hostRowOf(value: unknown, index: number, platform: string): HostRow | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || typeof value.id !== "string") return null;
  if (!("name" in value) || typeof value.name !== "string") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  if (!("active" in value) || typeof value.active !== "boolean") return null;
  const accent =
    "accentColor" in value && typeof value.accentColor === "string" ? value.accentColor : null;
  return {
    id: value.id,
    name: value.name,
    origin: hostOriginOf(value.url),
    active: value.active,
    accentColor: accent !== null && HOST_ACCENT_HEX.test(accent) ? accent : null,
    hint: hostAcceleratorHint(platform, index),
  };
}

/** Narrow a servers:list envelope to rows, or null on failure/garbage. */
function hostRowsOf(value: unknown, platform: string): HostRow[] | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("ok" in value) || value.ok !== true || !("servers" in value)) return null;
  if (!Array.isArray(value.servers)) return null;
  const rows: HostRow[] = [];
  for (const entry of value.servers) {
    const row = hostRowOf(entry, rows.length, platform);
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}

/** The host-menu chord — mirrors the SPA registry's `host-menu-open` binding
 *  (lib/keybindings.ts, shifted tier): `KeyH`, Shift + the platform primary
 *  modifier (meta on darwin, ctrl otherwise), no other modifiers. */
function isHostMenuChord(event: KeyboardEvent, platform: string): boolean {
  if (event.code !== "KeyH" || !event.shiftKey || event.altKey) return false;
  return platform === "darwin"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * The "Your Hosts" top rung — a one-shot `servers:list` fetch at wire-up (no
 * poll: the page is short-lived and list mutations from this page navigate
 * away — the SPA dropdown's open-time-snapshot precedent). Click/Enter on a
 * row invokes `servers:switch`; main's switchToHost attaches the view and
 * navigates this window away, so a resolved switch needs no cleanup here.
 * Empty list, absent bridge, or a failed/malformed answer leaves the section
 * hidden (graceful degradation, no error).
 */
function wireHostsSection(
  els: WelcomeElements,
  servers: ServersBridge | null,
  platform: string,
): HostListHandle {
  const rows: HostRow[] = [];
  const buttons: HTMLButtonElement[] = [];
  let seat = 0;

  const setSeat = (index: number): void => {
    seat = index;
    buttons.forEach((button, i) => {
      button.tabIndex = i === seat ? 0 : -1;
    });
  };

  const switchTo = (id: string): void => {
    if (servers === null) return;
    void servers.switch(id);
  };

  const buildRow = (row: HostRow): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "host-row";
    button.tabIndex = -1;
    if (row.accentColor !== null) {
      // The accentColor passed the strict hex gate in the row model — safe
      // to interpolate into a style.
      const accent = document.createElement("span");
      accent.className = "host-accent";
      accent.setAttribute("aria-hidden", "true");
      accent.style.backgroundColor = row.accentColor;
      button.appendChild(accent);
    }
    const marker = document.createElement("span");
    marker.className = "host-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = row.active ? "✓" : "";
    button.appendChild(marker);
    const name = document.createElement("span");
    name.className = "host-name";
    name.textContent = row.name;
    button.appendChild(name);
    const origin = document.createElement("span");
    origin.className = "host-origin";
    origin.textContent = row.origin;
    button.appendChild(origin);
    if (row.hint !== null) {
      const hint = document.createElement("span");
      hint.className = "host-hint";
      hint.textContent = row.hint;
      button.appendChild(hint);
    }
    button.addEventListener("click", () => {
      switchTo(row.id);
    });
    return button;
  };

  // Roving focus over the rows: ↓/↑ move the seat without wrapping, Enter
  // selects the focused row (native button activation → click), and
  // unmodified digits 1–9 select the Nth row. The listener lives on the list
  // container, so digits only fire while focus is inside the list — never
  // while typing in the form inputs.
  els.hostsList.addEventListener("keydown", (event) => {
    if (buttons.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(buttons.length - 1, Math.max(0, seat + delta));
      setSeat(next);
      buttons[next].focus();
      return;
    }
    if (
      /^Digit[1-9]$/.test(event.code) &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const n = Number(event.code.slice("Digit".length));
      if (n <= rows.length) {
        event.preventDefault();
        switchTo(rows[n - 1].id);
      }
    }
  });

  const populate = async (): Promise<void> => {
    if (servers === null) return;
    let result: unknown = null;
    try {
      result = await servers.list();
    } catch {
      return; // a rejected invoke degrades to a hidden section
    }
    const hostRows = hostRowsOf(result, platform);
    if (hostRows === null || hostRows.length === 0) return;
    for (const row of hostRows) {
      rows.push(row);
      buttons.push(buildRow(row));
    }
    setSeat(0);
    els.hostsList.replaceChildren(...buttons);
    els.hostsSection.hidden = false;
  };

  void populate();

  return {
    focusFirst: () => {
      if (buttons.length === 0) return false;
      setSeat(0);
      buttons[0].focus();
      return true;
    },
  };
}

/**
 * The "This Mac" local-daemon section — detection-driven state machine.
 * Polls `daemon:status` every 3s while the page is visible (the interval
 * dies with the page); a start/stop flow in flight suspends repainting so
 * the transient starting… state is never clobbered by a poll.
 */
function wireLocalSection(els: WelcomeElements, daemon: DaemonBridge, heading: string): void {
  els.localHeading.textContent = heading;
  els.localSection.hidden = false;

  let lastStatus: LocalDaemonStatus | null = null;
  let busy = false; // a start/stop flow is in flight — polls must not repaint
  let inFlight = false; // a status request is in flight — no request pileup

  const showLocalError = (message: string): void => {
    els.localError.textContent = message;
    els.localError.hidden = false;
  };

  const render = (status: LocalDaemonStatus): void => {
    if (!status.installed) {
      // Not installed: the section collapses to the brew-install hint.
      els.localStatusRow.hidden = true;
      els.localDetail.hidden = true;
      els.localConnect.hidden = true;
      els.localStop.hidden = true;
      els.localHint.hidden = false;
      return;
    }
    els.localHint.hidden = true;
    els.localStatusRow.hidden = false;
    els.localDetail.hidden = false;
    els.localConnect.hidden = false;
    els.localConnect.disabled = false;
    const versionSuffix = status.version !== null ? ` · v${status.version}` : "";
    if (status.state === "running") {
      els.localDot.className = "dot running";
      els.localStatus.textContent = `running${versionSuffix}`;
      const sessionsSuffix =
        status.sessions !== null
          ? ` · ${status.sessions} session${status.sessions === 1 ? "" : "s"}`
          : "";
      els.localDetail.textContent = `${hostPortOf(status.origin)}${sessionsSuffix}`;
      els.localConnect.textContent = "Connect";
      els.localStop.hidden = false;
      els.localStop.disabled = false;
    } else if (status.state === "wedged") {
      els.localDot.className = "dot wedged";
      els.localStatus.textContent = `not responding${versionSuffix}`;
      els.localDetail.textContent = `HexoKit is running but isn't answering on ${status.origin}`;
      els.localConnect.textContent = "Restart HexoKit";
      els.localStop.hidden = true;
    } else {
      els.localDot.className = "dot";
      els.localStatus.textContent = "stopped";
      const installedAs = status.version !== null ? `rk v${status.version}` : "rk";
      els.localDetail.textContent = `${installedAs} installed · runs \`rk daemon start\``;
      els.localConnect.textContent = "Start & connect";
      els.localStop.hidden = true;
    }
  };

  const renderStarting = (origin: string | null, restarting: boolean): void => {
    els.localDot.className = "dot starting";
    els.localStatus.textContent = restarting ? "restarting…" : "starting…";
    els.localDetail.textContent =
      origin !== null
        ? `waiting for ${hostPortOf(origin)} to answer`
        : "waiting for the daemon to answer";
    els.localConnect.disabled = true;
    els.localStop.disabled = true;
  };

  const refresh = async (): Promise<void> => {
    if (busy || inFlight) return;
    inFlight = true;
    let result: unknown = null;
    try {
      result = await daemon.status();
    } catch {
      // A rejected invoke is transient — fall through to the null-status path.
    } finally {
      inFlight = false; // never leave the flag stuck (polling would stop for good)
    }
    if (busy) return; // a flow started while the request was out
    const status = daemonStatusOf(result);
    // A failed/malformed probe keeps the previous rendering (transient).
    if (status !== null) {
      lastStatus = status;
      render(status);
    }
  };

  // ONE get-in flow for both button states: main starts the daemon when
  // stopped (already-running errors count as started), waits for health,
  // then activates-or-adds the local entry and navigates this window away.
  const connectLocal = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    els.localError.hidden = true;
    const wasRunning = lastStatus !== null && lastStatus.installed && lastStatus.state === "running";
    const restarting = lastStatus !== null && lastStatus.installed && lastStatus.state === "wedged";
    if (wasRunning) {
      els.localConnect.disabled = true;
      els.localConnect.textContent = "Connecting…";
      els.localStop.disabled = true;
    } else {
      renderStarting(lastStatus !== null && lastStatus.installed ? lastStatus.origin : null, restarting);
    }
    let result: unknown = null;
    try {
      result = restarting ? await daemon.restart() : await daemon.start();
    } catch {
      // A rejected invoke surfaces the generic error below — never stay stuck busy.
    }
    const outcome = daemonActionOutcome(result);
    if (outcome === "acted") return;
    busy = false;
    if (lastStatus !== null) render(lastStatus);
    if (outcome === "failed") showLocalError(errorOf(result));
    void refresh();
  };

  const stopLocal = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    els.localError.hidden = true;
    els.localStop.disabled = true;
    let result: unknown = null;
    try {
      result = await daemon.stop(); // main confirms (tmux sessions survive)
    } catch {
      // A rejected invoke surfaces the generic error below — never stay stuck busy.
    }
    const outcome = daemonActionOutcome(result);
    busy = false;
    if (lastStatus !== null) render(lastStatus);
    if (outcome === "failed") showLocalError(errorOf(result));
    void refresh();
  };

  els.localConnect.addEventListener("click", () => {
    void connectLocal();
  });
  els.localStop.addEventListener("click", () => {
    void stopLocal();
  });

  void refresh();
  window.setInterval(() => {
    void refresh();
  }, LOCAL_STATUS_POLL_MS);
}

/**
 * The "or over SSH" middle rung — one input, one button, one amber progress
 * line. The renderer only renders: main runs `rk remote add` + `rk remote
 * connect` (execFile) and streams connect's chatter lines back over the
 * `remote:progress` subscription; each line extends the arrow chain
 * (`connecting to buildbox… → opening tunnel on :3100…`). Success means main
 * is navigating this window away (switchToHost) — the rung stays busy.
 */
function wireSshSection(els: WelcomeElements, remote: RemoteBridge): void {
  els.sshSection.hidden = false;

  let busy = false;
  const chain: string[] = [];
  remote.onProgress((line) => {
    if (!busy) return;
    chain.push(line);
    els.sshProgress.textContent = chain.join(" → ");
  });

  const showSshError = (message: string): void => {
    els.sshError.textContent = message;
    els.sshError.hidden = false;
  };

  const connectSsh = async (): Promise<void> => {
    if (busy) return;
    const target = els.sshTarget.value.trim();
    if (target === "") {
      showSshError("Enter an SSH target — user@host or a ~/.ssh/config alias");
      return;
    }
    busy = true;
    els.sshError.hidden = true;
    chain.length = 0;
    els.sshProgress.textContent = `connecting to ${target}…`;
    els.sshProgress.hidden = false;
    els.sshConnect.disabled = true;
    els.sshConnect.textContent = "Connecting…";
    let result: unknown = null;
    try {
      result = await remote.connect(target);
    } catch {
      // A rejected invoke surfaces the generic error below — never stay stuck busy.
    }
    if (isAckOk(result)) return; // success: main is navigating away — stay busy
    showSshError(errorOf(result));
    els.sshProgress.hidden = true;
    els.sshConnect.disabled = false;
    els.sshConnect.textContent = "Connect via SSH";
    busy = false;
  };

  els.sshConnect.addEventListener("click", () => {
    void connectSsh();
  });
  // The input sits outside the URL form — Enter should still connect.
  els.sshTarget.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void connectSsh();
    }
  });
}

function wireWelcomePage(els: WelcomeElements, bridge: WelcomeBridge): void {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");

  const showError = (message: string): void => {
    els.errorEl.textContent = message;
    els.errorEl.hidden = false;
  };
  const setBusy = (label: string | null): void => {
    els.connectButton.disabled = label !== null;
    els.connectButton.textContent = label ?? "Connect";
  };

  // ?mode=add (menu "Add Host…"): a cancel link returns to the active host.
  if (mode === "add") {
    els.cancelLink.hidden = false;
    els.cancelLink.addEventListener("click", (event) => {
      event.preventDefault();
      void bridge.cancel();
    });
  }

  const connect = async (): Promise<void> => {
    els.errorEl.hidden = true;

    // Client-side URL pre-check (the shared host-form contract's copy),
    // before any `welcome:test-host` ping.
    const rawUrl = els.urlInput.value.trim();
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      showError("Enter a full http(s) URL, e.g. http://host:6123");
      return;
    }

    setBusy("Testing…");
    const ping = await bridge.testHost(rawUrl);
    if (!isPingOk(ping)) {
      showError(errorOf(ping));
      setBusy(null);
      return;
    }

    // A blank Name falls back to the ping's hostname (store falls back to
    // the origin when both are empty).
    setBusy("Connecting…");
    const added = await bridge.addHost(
      els.nameInput.value.trim() || ping.hostname,
      ping.origin,
    );
    if (!isAckOk(added)) {
      showError(errorOf(added));
      setBusy(null);
      return;
    }
    // Success: main persists, sets active, and navigates this window away.
  };

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void connect();
  });
}

(() => {
  const els = getWelcomeElements();
  if (!els) return;
  const bridge = getWelcomeBridge();
  if (!bridge) {
    els.errorEl.textContent =
      "Shell bridge unavailable — this page only works inside the HexoKit desktop app";
    els.errorEl.hidden = false;
    els.connectButton.disabled = true;
    return;
  }
  wireWelcomePage(els, bridge);

  const platform = getShellPlatform() ?? "";

  // "Your Hosts" top rung: the page is already a privileged servers:* sender,
  // so the existing SPA switcher group covers list + switch. An absent group
  // (older preload) or a failed/empty list leaves the section hidden.
  const hostsHandle = wireHostsSection(els, getServersBridge(), platform);

  // The host-menu chord, handled locally: focuses the Your Hosts list, or
  // the add form's URL field when no hosts are listed. Shell-owned — no IPC,
  // no accelerator, no coordination with the SPA's binding (the two surfaces
  // never coexist on screen).
  document.addEventListener("keydown", (event) => {
    if (!isHostMenuChord(event, platform)) return;
    event.preventDefault();
    if (!hostsHandle.focusFirst()) els.urlInput.focus();
  });

  // "This Mac" section: darwin and linux only — rk daemon/tmux is not a
  // Windows concept, so the section (and its brew hint) is suppressed
  // entirely on win32.
  const heading =
    platform === "darwin" ? "This Mac" : platform === "linux" ? "This Machine" : null;
  const daemonBridge = getDaemonBridge();
  if (heading !== null && daemonBridge !== null) {
    wireLocalSection(els, daemonBridge, heading);
  }

  // "or over SSH" rung: same platform gate — the tunnel runs through the
  // LOCAL rk + tmux, which do not exist on win32 (the URL form then stands
  // alone, both dividers hidden with the section).
  const remoteBridge = getRemoteBridge();
  if (heading !== null && remoteBridge !== null) {
    wireSshSection(els, remoteBridge);
  }
})();
