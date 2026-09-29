/**
 * Dead-host renderer. The IIFE is load-bearing: import-free page scripts are
 * global scripts under this package's TypeScript configuration, so the
 * wrapper prevents identifiers shared with welcome.ts from colliding.
 */
(() => {
  const LOCAL_STATUS_POLL_MS = 3000;

  type InterstitialKind = "local" | "remote" | "url";
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

  interface DaemonBridge {
    status(): Promise<unknown>;
    start(): Promise<unknown>;
    restart(): Promise<unknown>;
  }

  interface InterstitialBridge {
    retry(): Promise<unknown>;
  }

  interface PageElements {
    dot: HTMLElement;
    headline: HTMLElement;
    detail: HTMLElement;
    hint: HTMLElement;
    action: HTMLButtonElement;
    error: HTMLElement;
  }

  function elements(kind: InterstitialKind): PageElements | null {
    const section = document.getElementById(`${kind}-state`);
    if (!(section instanceof HTMLElement)) return null;
    const dot = section.querySelector('[data-role="dot"]');
    const headline = section.querySelector('[data-role="headline"]');
    const detail = section.querySelector('[data-role="detail"]');
    const hint = section.querySelector('[data-role="hint"]');
    const action = section.querySelector('[data-role="action"]');
    const error = section.querySelector('[data-role="error"]');
    if (
      !(dot instanceof HTMLElement) ||
      !(headline instanceof HTMLElement) ||
      !(detail instanceof HTMLElement) ||
      !(hint instanceof HTMLElement) ||
      !(action instanceof HTMLButtonElement) ||
      !(error instanceof HTMLElement)
    ) return null;
    section.hidden = false;
    return { dot, headline, detail, hint, action, error };
  }

  function daemonBridge(): DaemonBridge | null {
    const shell: unknown = Reflect.get(window, "runkitShell");
    if (typeof shell !== "object" || shell === null || !("__daemon" in shell)) return null;
    const candidate = shell.__daemon;
    if (typeof candidate !== "object" || candidate === null) return null;
    if (!("status" in candidate) || !("start" in candidate) || !("restart" in candidate)) return null;
    const { status, start, restart } = candidate;
    if (typeof status !== "function" || typeof start !== "function" || typeof restart !== "function") return null;
    return {
      status: (): Promise<unknown> => Promise.resolve(status()),
      start: (): Promise<unknown> => Promise.resolve(start()),
      restart: (): Promise<unknown> => Promise.resolve(restart()),
    };
  }

  function retryBridge(): InterstitialBridge | null {
    const shell: unknown = Reflect.get(window, "runkitShell");
    if (typeof shell !== "object" || shell === null || !("__interstitial" in shell)) return null;
    const candidate = shell.__interstitial;
    if (typeof candidate !== "object" || candidate === null || !("retry" in candidate)) return null;
    const { retry } = candidate;
    if (typeof retry !== "function") return null;
    return { retry: (): Promise<unknown> => Promise.resolve(retry()) };
  }

  function daemonStatus(value: unknown): LocalDaemonStatus | null {
    if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true) return null;
    if (!("status" in value)) return null;
    const status = value.status;
    if (typeof status !== "object" || status === null || !("installed" in status)) return null;
    if (status.installed === false) return { installed: false };
    if (status.installed !== true || !("state" in status) || typeof status.state !== "string") return null;
    if (!("origin" in status) || typeof status.origin !== "string") return null;
    const version = "version" in status && typeof status.version === "string" ? status.version : null;
    if (status.state === "stopped" || status.state === "wedged") {
      return { installed: true, state: status.state, version, origin: status.origin };
    }
    if (status.state !== "running") return null;
    const hostname = "hostname" in status && typeof status.hostname === "string" ? status.hostname : "";
    const sessions = "sessions" in status && typeof status.sessions === "number" ? status.sessions : null;
    return { installed: true, state: "running", version, origin: status.origin, hostname, sessions };
  }

  function ack(value: unknown): boolean {
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

  function errorMessage(value: unknown): string {
    if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") {
      return value.error;
    }
    return "The action failed — try again";
  }

  function hostPort(origin: string): string {
    try { return new URL(origin).host; } catch { return origin; }
  }

  const params = new URLSearchParams(location.search);
  const hostId = params.get("host") ?? "";
  const rawKind = params.get("kind");
  const kind: InterstitialKind = rawKind === "local" || rawKind === "remote" ? rawKind : "url";
  const els = elements(kind);
  if (!els) return;
  const name = params.get("name") ?? hostId;
  const origin = params.get("origin") ?? name;

  const showError = (message: string): void => {
    els.error.textContent = message;
    els.error.hidden = false;
  };

  if (kind === "local") {
    const daemon = daemonBridge();
    if (!daemon) {
      showError("Shell bridge unavailable");
      return;
    }
    let last: LocalDaemonStatus | null = null;
    let inFlight = false;
    let busy = false;

    const render = (status: LocalDaemonStatus): void => {
      els.error.hidden = true;
      els.hint.hidden = true;
      els.action.hidden = true;
      els.action.disabled = false;
      els.dot.className = "dot";
      if (!status.installed) {
        els.headline.textContent = "HexoKit is not installed";
        els.detail.textContent = "Install it on this machine, then retry.";
        els.hint.textContent = "brew install sahil87/tap/hexokit";
        els.hint.hidden = false;
        return;
      }
      if (status.state === "running") {
        els.headline.textContent = "HexoKit is answering again";
        els.detail.textContent = `waiting for ${hostPort(status.origin)} to reload`;
        return;
      }
      els.action.hidden = false;
      if (status.state === "wedged") {
        els.dot.className = "dot wedged";
        els.headline.textContent = "HexoKit is not responding";
        els.detail.textContent = `HexoKit is running but isn't answering on ${status.origin}`;
        els.action.textContent = "Restart HexoKit";
      } else {
        els.headline.textContent = "HexoKit isn't running on this Mac";
        els.detail.textContent = `Start it and wait for ${hostPort(status.origin)} to answer.`;
        els.action.textContent = "Start HexoKit";
      }
    };

    const renderBusy = (action: "start" | "restart"): void => {
      els.dot.className = "dot busy";
      els.headline.textContent = action === "restart" ? "restarting…" : "starting…";
      const target = last !== null && last.installed ? hostPort(last.origin) : hostPort(origin);
      els.detail.textContent = `waiting for ${target} to answer`;
      els.action.hidden = false;
      els.action.disabled = true;
      els.error.hidden = true;
    };

    const refresh = async (): Promise<void> => {
      if (busy || inFlight) return;
      inFlight = true;
      let result: unknown = null;
      try { result = await daemon.status(); } catch { /* keep the last rendering */ }
      finally { inFlight = false; }
      if (busy) return;
      const status = daemonStatus(result);
      if (status !== null) { last = status; render(status); }
    };

    els.action.addEventListener("click", () => {
      if (busy || last === null || !last.installed || last.state === "running") return;
      const action = last.state === "wedged" ? "restart" : "start";
      busy = true;
      renderBusy(action);
      void (async () => {
        let result: unknown = null;
        try { result = action === "restart" ? await daemon.restart() : await daemon.start(); }
        catch { /* the generic error below keeps the page recoverable */ }
        const outcome = daemonActionOutcome(result);
        if (outcome === "acted") return;
        busy = false;
        if (last !== null) render(last);
        if (outcome === "failed") showError(errorMessage(result));
        void refresh();
      })();
    });

    void refresh();
    window.setInterval(() => { void refresh(); }, LOCAL_STATUS_POLL_MS);
    return;
  }

  const retry = retryBridge();
  els.action.hidden = false;
  els.action.textContent = "Retry";
  if (kind === "remote") {
    els.dot.className = "dot busy";
    els.headline.textContent = `reconnecting to ${name}…`;
    els.detail.textContent = "The SSH tunnel is unavailable.";
  } else {
    els.headline.textContent = `can't reach ${origin}`;
    els.detail.textContent = "Check that the host is running, then retry.";
    els.hint.textContent = "If the address changed, use Edit Host in the titlebar host switcher.";
    els.hint.hidden = false;
  }
  if (!retry) {
    els.action.disabled = true;
    showError("Shell bridge unavailable");
    return;
  }
  let busy = false;
  els.action.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    els.action.disabled = true;
    els.error.hidden = true;
    void (async () => {
      let result: unknown = null;
      try { result = await retry.retry(); } catch { /* render below */ }
      if (!ack(result)) showError(errorMessage(result));
      busy = false;
      els.action.disabled = false;
    })();
  });
})();
