import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  startTransition,
} from "react";
import { useMatches } from "@tanstack/react-router";
import { useChromeDispatch } from "./chrome-context";
import { listServers, compareServersRanked, triggerUpdate, triggerForceUpdate, triggerRestart, type ServerInfo, type UpdateTriggerResult } from "@/api/client";
import { StateSocket } from "@/lib/state-socket";
import { computeUpdateKey } from "@/lib/palette/update";
import type { MetricsSnapshot, ProjectSession, Service, ServicesSnapshot } from "@/types";

const SERVER_STORAGE_KEY = "hexokit-server";
// localStorage key for composite update-notice dismissal. The value is the
// dismissed composite `key` — the sorted `tool@latest` pairs (e.g.
// "fab-kit@2.17.0,run-kit@3.9.0"); any change to the matched set (a newer latest
// or a newly-matching tool) changes the key and re-shows the chip. No server
// state (Constitution II).
const UPDATE_DISMISSED_KEY = "hexokit-update-dismissed";
// Sentinel running version for local (non-ldflags) builds — the update chip and
// palette actions are suppressed for it.
const DEV_VERSION = "dev";

/** Pure reload-guard predicate: given the FIRST {version, boot} this tab observed
 *  and the NEXT `version` event, decide whether to reload. Reloads when a version
 *  was already seen AND EITHER the version OR the boot id differs — a version
 *  change means new assets; a same-version boot change means a plain daemon
 *  restart (config change, wedge recovery, restart from SSH) that reconnected
 *  this tab to a new process holding possibly-stale in-memory state. Never
 *  reloads on the first connect (firstVersion === null), so there is no reload
 *  loop.
 *
 *  DEV SUPPRESSION: when the running version is `"dev"`, a boot change is IGNORED
 *  — under `just dev`, air recompiles the backend on every save, minting a new
 *  boot id each time; reloading every dev tab on every recompile would be a
 *  reload storm. A version change is still honored (moot in practice — a dev
 *  version never changes — but keeps the predicate honest). `nextBoot` may be
 *  null when an older daemon sends a boot-less payload (mixed-version window):
 *  a null boot never triggers the boot branch.
 *
 *  Exported for unit testing; the provider wraps it with refs + `location.reload()`. */
export function shouldReloadOnVersion(
  firstVersion: string | null,
  firstBoot: string | null,
  nextVersion: string,
  nextBoot: string | null,
): boolean {
  if (firstVersion === null) return false; // never reload on first connect
  if (nextVersion !== firstVersion) return true; // new binary/assets
  // Same version: a boot change means a plain restart — reload UNLESS this is a
  // dev build (air recompile storm guard). A null nextBoot (older daemon) or an
  // unchanged boot never triggers.
  if (nextVersion === DEV_VERSION) return false;
  return nextBoot !== null && nextBoot !== firstBoot;
}

/** Multi-server SessionContext shape. State is keyed by server name. A single
 *  `/ws/state` WebSocket (the StateSocket) carries every stream for the tab; a
 *  per-server *subscription* on that socket is opened lazily per *attached*
 *  server (current server is always attached automatically; non-current servers
 *  attach when a consumer calls `attachServer(name)` — typically when a sidebar
 *  group is expanded). Muxing onto one established WebSocket is what clears the
 *  browser's 6-per-origin HTTP/1.1 pool that the old per-server + metrics
 *  EventSources saturated (an established WS holds no pool slot — change
 *  260716-qf3j-state-socket). Other hooks (`useBoards`, `useWindowPins`)
 *  subscribe to this provider's `subscribeBoardChange` API rather than opening
 *  their own streams. `currentServer` is dispatched by the matched route —
 *  `params.server` for `/$server/...`, `null` for `/board/$name` and `/`. */

/** One toolkit tool in the update-available payload: `tool` is the roster name
 *  (e.g. "run-kit", "fab-kit"), `current` its installed version, `latest` the
 *  newest release. The payload carries the FULL per-tool verdict list — every
 *  tool with a pending update, including sub-threshold rows — so each entry
 *  also carries the two verdict flags. A missing flag (an old daemon's payload,
 *  which listed only matched tools) is treated as `true`. */
export type UpdateTool = {
  tool: string;
  current: string;
  latest: string;
  /** installed < latest. Missing (old-daemon payload) ⇒ treated as true. */
  updateAvailable?: boolean;
  /** The bump crosses the tool's notify threshold — the set that lights the
   *  chip. Missing (old-daemon payload) ⇒ treated as true. */
  notable?: boolean;
};

/** A pending toolkit update, from the server-global `event: update-available`.
 *  `tools` is the full per-tool verdict list (chip/palette consumers filter the
 *  notable subset via `useUpdateNotification`); `key` is the composite
 *  dismissal key over the NOTABLE set (sorted `tool@latest`, comma-joined).
 *  `current`/`latest` are the legacy run-kit-row fields, retained for
 *  transitional compat (populated only when run-kit is in the notable set). */
export type UpdateAvailable = {
  tools: UpdateTool[];
  key: string;
  current: string;
  latest: string;
};

/** The latest MANUAL update-check result held for this tab — the updatable tool
 *  subset the check reported plus the echoed report `source` (`"released"`/
 *  `"github"`). The manual check is a deliberate SIDE CHANNEL the daemon never
 *  caches (it carries no notify policy, and caching it would starve the scoped
 *  `shll update` argv), so its verdict has no SSE feed and no server-computed
 *  key — this state is the frontend's only home for it, and the chip's key is
 *  composed client-side by `computeUpdateKey`. Deliberately NOT persisted: a
 *  page reload before updating forgets it (the accepted tab-local tradeoff —
 *  the user re-clicks ⟳). `null` when no manual result is held. */
export type ManualCheckResult = {
  tools: UpdateTool[];
  source: string;
};

/** The host-global `event: notify` payload. All fields are optional — the
 *  shape is the daemon's broadcast contract, and older daemons may omit any
 *  of them. `tag` marks a daemon-broadcast operational notice a specific
 *  surface claims (e.g. "operator-kickoff"); untagged payloads are ordinary
 *  user notifications for the shell-level consumer. */
export type NotifyPayload = {
  id?: string;
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
};

/** The notify broadcast always carries a JSON object; anything else on the
 *  wire is a protocol violation and must not reach subscribers. */
function isNotifyPayload(data: unknown): data is NotifyPayload {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

export type SessionContextType = {
  sessionsByServer: Map<string, ProjectSession[]>;
  sessionOrderByServer: Map<string, string[]>;
  isConnectedByServer: Map<string, boolean>;
  metricsByServer: Map<string, MetricsSnapshot | null>;
  /** Per-server map of `windowId → pane-text preview` for the tile grid. Only
   *  windows in sessions the client declared expanded (via `setPreviewScope`)
   *  are populated; delivered over the state socket's `preview` event. */
  previewsByServer: Map<string, Record<string, string>>;
  /** Declare which sessions the tile grid has expanded for a server, so the
   *  backend captures previews only for those windows. Sends the in-band
   *  `preview-scope` op over the state socket, addressed by the socket's own
   *  conn id (the same identity the retained `POST /api/preview-scope` uses). */
  setPreviewScope: (server: string, expanded: string[]) => void;
  currentServer: string | null;
  servers: ServerInfo[];
  refreshServers: () => void;
  /** True once the first `fetchServers()` call has settled (even to an empty
   *  list or a caught error). Lets the route guard distinguish "list still
   *  loading" from "server genuinely absent" — the explicit replacement for
   *  the buggy `servers.length > 0` proxy. */
  serversLoaded: boolean;
  /** The name of a server the user just created and navigated to, which may
   *  not yet appear in `servers` (the refreshed list is in flight). The route
   *  guard renders a brief waiting state for this server instead of "not
   *  found"; it is cleared automatically once the refreshed list contains it
   *  (or on a failed create). `null` when no create is in flight. */
  pendingServer: string | null;
  /** Mark a server as "pending" (just created, awaiting list refresh). */
  markServerPending: (name: string) => void;
  /** Mark a server as "attached" so the provider opens its state-socket
   *  subscription. Idempotent. The current server is auto-attached; this is for
   *  non-current servers (sidebar groups expanded by the user). */
  attachServer: (name: string) => void;
  /** Subscribe to board-changed events on any attached server. Returns an
   *  unsubscribe function. The handler receives the source server name. */
  subscribeBoardChange: (handler: (server: string) => void) => () => void;
  /** Subscribe to the server-global `board-order` event (board list display
   *  order changed). Returns an unsubscribe function. Delivered once over the
   *  state socket as a `kind:"global"` event (host-global — never duplicated
   *  per subscription). */
  subscribeBoardOrder: (handler: () => void) => () => void;
  /** Subscribe to the server-global `status-refresh` event (a manual PR-status
   *  refresh completed). Returns an unsubscribe function. Delivered once over
   *  the state socket as a `kind:"global"` event (host-global, broadcast-only,
   *  no cached payload). The PANE-header refresh button subscribes to clear its
   *  spinner on completion. */
  subscribeStatusRefresh: (handler: () => void) => () => void;
  /** Subscribe to host-global notification payloads. The shell-level consumer
   *  performs environment, preference, and cross-view claim gating. */
  subscribeNotify: (handler: (payload: NotifyPayload) => void) => () => void;
  /** Imperative read of the per-server receipt tick (260823-ke9i): a monotonic
   *  counter bumped on every server-scoped snapshot or event received for that
   *  server, used by the pending-switch bounce verdict to tell post-click
   *  evidence from a frozen pre-click snapshot. Ref-backed — callers read it
   *  without subscribing to re-renders. A server never seen reads 0. */
  getServerReceiptTick: (server: string) => number;
  /** The running daemon version reported over the server-global `event: version`
   *  (no leading "v"). `null` until the first `version` event. */
  daemonVersion: string | null;
  /** The daemon process start time (epoch seconds) from the `event: version`
   *  `started` field. `null` until observed — and STAYS null against an older
   *  daemon whose payload lacks the field (the boot-field mixed-version
   *  precedent). Feeds the host page's daemon uptime readout. */
  daemonStarted: number | null;
  /** The port the daemon bound, from the `event: version` `port` field. `null`
   *  until observed / on an older daemon's field-less payload. */
  daemonPort: number | null;
  /** A pending toolkit update (matched tools + composite key), from the
   *  server-global `event: update-available`. `null` when no update is pending. */
  updateAvailable: UpdateAvailable | null;
  /** The latest manual update-check result (tab-local, non-persisted), or
   *  `null` when none is held. The SECOND feed behind the persistent update
   *  surfaces: `useUpdateNotification` merges it ambient-first, so a manual ⟳
   *  check that finds updates lights the chip/menu row instead of evaporating
   *  with its toast. */
  manualCheck: ManualCheckResult | null;
  /** Store a manual check's updatable tool subset + echoed report source.
   *  Called by `useUpdateCheck` after a check resolves. An EMPTY `tools` array
   *  CLEARS any held result — a fresh verdict supersedes a stale one, so a
   *  clean re-check must not leave a lying chip lit. */
  applyManualCheckResult: (tools: UpdateTool[], source: string) => void;
  /** The composite `key` the user dismissed the update notice for (localStorage
   *  `hexokit-update-dismissed`), or `null` when none. The chip hides when this
   *  equals the EFFECTIVE displayed key (the ambient `updateAvailable.key`, or
   *  the client-computed manual key when the manual feed is the lit one); the
   *  palette action ignores it. */
  updateDismissedKey: string | null;
  /** Trigger a one-click update: POST /api/update. Resolves with the trigger
   *  result (status + optional `watch` job-window target — 260812-z1ya).
   *  Best-effort — the daemon restart then drops the state socket, and the
   *  reconnect's differing `version` drives the reload guard. Rejects on a
   *  non-2xx so the caller can surface an error. */
  updateNow: () => Promise<UpdateTriggerResult>;
  /** Dismiss the update notice for the current pending `latest`, persisted
   *  per-version in localStorage. A later release re-shows the chip. */
  dismissUpdate: () => void;
  /** Whether the daemon is a Homebrew install, from the server-global
   *  `event: version` `brew` field. `false` until the first version event —
   *  gates the palette-only `HexoKit: Update Now` (force-update) entry. */
  brew: boolean;
  /** Force a self-upgrade regardless of the qualifying snapshot: POST
   *  /api/update `{"force":true}`. Best-effort — the ensuing restart drops the
   *  state socket and the reconnect's differing version/boot drives the reload.
   *  Rejects on a non-2xx (e.g. 409 not-brew) so the caller can catch it. */
  forceUpdateNow: () => Promise<UpdateTriggerResult>;
  /** Restart the daemon: POST /api/restart. Best-effort — the restart drops the
   *  state socket and the reconnect's differing `boot` drives the reload guard
   *  even at the same version. Rejects on a non-2xx (e.g. 409 on a dev build). */
  restartNow: () => Promise<UpdateTriggerResult>;
};

export const SessionContext = createContext<SessionContextType | null>(null);

// Metrics live in a separate context so that the ~2.5s metrics stream does not
// cascade re-renders through the whole app tree — only HostPanel subscribes.
// The default sentinel is `undefined` so `useMetrics()` can distinguish
// "outside provider" (throw) from the valid "no metrics yet" state (`null`).
const MetricsContext = createContext<MetricsSnapshot | null | undefined>(undefined);

// Host metrics live in their OWN context, fed by the host-global `metrics`
// event over the state socket (delivered as a `kind:"global"` frame — see the
// StateSocket handlers below). Unlike `MetricsContext` (which carries the
// current server's slice and is `null` on `/`), this context carries the
// host-global metrics broadcast and is available on EVERY route — including
// `/`, where there is no `currentServer`. The metrics broadcast is
// server-independent server-side (see api/sse.go poll loop), so the single
// socket delivers it once regardless of how many servers are subscribed. Same
// `undefined` sentinel idiom as `MetricsContext` — distinguishes
// "outside provider" (throw) from "no metrics yet" (`null`).
const HostMetricsContext = createContext<MetricsSnapshot | null | undefined>(undefined);

// Host listening-services live in their OWN context, fed by the same
// host-global broadcast as host metrics (the `services` event is a
// `kind:"global"` frame delivered once over the state socket, exactly like
// `metrics`). Separated from HostMetricsContext so the ~2.5s services stream
// does not cascade re-renders into metrics-only consumers. The `undefined`
// sentinel distinguishes "outside provider" (throw) from the valid "no services
// yet" state (`[]`).
const HostServicesContext = createContext<Service[] | undefined>(undefined);

/** The host-global code-server signal broadcast as the `code-server` global
 *  event (260811-k3vp; portless since 260811-a2bo — the port is server-private
 *  behind the stable /code/ route): just the TTL-cached reachability.
 *  Reachability governs the surface's CONTENT state only — availability is
 *  gitRoot-derived and never needs this signal. */
export type CodeServerSignal = { reachable: boolean };

// The code-server signal lives in its OWN context (the HostServicesContext
// precedent): host-global, delivered once per tick, so the per-tick repetition
// does not cascade re-renders into unrelated consumers. `undefined` = outside
// provider (throw); `null` = no signal yet.
const CodeServerContext = createContext<CodeServerSignal | null | undefined>(undefined);

/** One entry of the host-global `event: gui` payload (the backend's
 *  gui.StreamEntry). The payload is a LIST (forward-compat for per-session
 *  displays); consumers select the `id === "host"` entry. Reachability and
 *  viewers govern the tile's CONTENT — availability keys off `enabled` only
 *  (see `hasGui`). `wm` is the supervisor's window-manager stamp (`""` when
 *  bare) — the tile keys the bare-WM strip on it. `locked` is the host-side
 *  resolution pin (`rk gui lock`) — while set, no viewer drives
 *  SetDesktopSize. `geometry` is the host's `gui.geometry` setting (a fixed
 *  `WxH` or `auto`; `""` when disabled) — only its `auto` value lets a
 *  viewer drive SetDesktopSize at all. */
export type GuiSignal = {
  id: string;
  enabled: boolean;
  backend: string;
  reachable: boolean;
  display: string;
  width: number;
  height: number;
  viewers: number;
  wm: string;
  locked: boolean;
  geometry: string;
};

// The gui signal lives in its OWN context (the CodeServerContext precedent):
// host-global, broadcast every tick, so the per-tick repetition does not
// cascade re-renders into unrelated consumers. `undefined` = outside provider
// (throw); `null` = no event yet, which reads as DISABLED — the gui surface
// is never on by default and a late replay must not flash a button (the
// opposite of useCodeServer's null semantics).
const GuiContext = createContext<GuiSignal | null | undefined>(undefined);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function guiString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function guiNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Narrow one payload entry to a GuiSignal; every field falls back to its
 *  disabled-shape default (`false`/`""`/`0`) so a malformed payload narrows
 *  to safe defaults and never throws. */
function narrowGuiEntry(entry: unknown): GuiSignal {
  const e = isRecord(entry) ? entry : {};
  return {
    id: guiString(e.id),
    enabled: e.enabled === true,
    backend: guiString(e.backend),
    reachable: e.reachable === true,
    display: guiString(e.display),
    width: guiNumber(e.width),
    height: guiNumber(e.height),
    viewers: guiNumber(e.viewers),
    wm: guiString(e.wm),
    locked: e.locked === true,
    geometry: guiString(e.geometry),
  };
}

/** Select the `id === "host"` entry of the `event: gui` list (fallback: the
 *  first entry); `null` for a non-list or empty payload — read as disabled. */
function narrowGuiSignal(data: unknown): GuiSignal | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const host = data.find((e) => isRecord(e) && e.id === "host");
  return narrowGuiEntry(host ?? data[0]);
}

type SessionProviderProps = {
  children: React.ReactNode;
};

/** Per-server state slice held inside the provider. Lives in plain state
 *  (immutable Maps re-created on update so consumers see new references). */
type ServerSlice = {
  sessions: ProjectSession[];
  sessionOrder: string[];
  isConnected: boolean;
  metrics: MetricsSnapshot | null;
  previews: Record<string, string>;
};

const EMPTY_SLICE: ServerSlice = {
  sessions: [],
  sessionOrder: [],
  isConnected: false,
  metrics: null,
  previews: {},
};

/** Read `currentServer` from the matched route. Returns the server param when
 *  the deepest match has one (AppShell routes), otherwise `null` (board, index).
 *  Exported for the other route-param consumers (the quake terminal, the
 *  layout palette's Ask-operator gate) so the walk exists exactly once. */
export function useCurrentServerFromRoute(): string | null {
  const matches = useMatches();
  // Walk matches from deepest first looking for a `server` param. This is
  // resilient to the route-tree shape — `/$server/$window` puts
  // `server` on the layout match while child matches inherit it.
  for (let i = matches.length - 1; i >= 0; i--) {
    const params = (matches[i]?.params ?? {}) as Record<string, string | undefined>;
    if (typeof params.server === "string" && params.server.length > 0) {
      return params.server;
    }
  }
  return null;
}

export function SessionProvider({ children }: SessionProviderProps) {
  const [slicesByServer, setSlicesByServer] = useState<Map<string, ServerSlice>>(
    () => new Map(),
  );
  const [servers, setServers] = useState<ServerInfo[]>([]);
  // False until the first `fetchServers()` settles. The route guard uses this
  // (not `servers.length > 0`) to know the list has loaded.
  const [serversLoaded, setServersLoaded] = useState(false);
  // Name of a just-created server awaiting the list refresh (waiting state).
  const [pendingServer, setPendingServer] = useState<string | null>(null);
  // Lazy-attach set: which servers should have a state-socket subscription
  // open. The current server is automatically included; non-current servers
  // must opt in (typically when their sidebar group is expanded). See the
  // `SessionContextType` doc for why eager-attach blows past the browser's
  // 6-connection-per-origin cap that the pre-socket EventSources hit.
  const [attachedNonCurrent, setAttachedNonCurrent] = useState<Set<string>>(() => new Set());
  // Latest host-global metrics snapshot from the state socket's `metrics` global
  // event (see the StateSocket handlers below). `null` until the first tick.
  const [hostMetrics, setHostMetrics] = useState<MetricsSnapshot | null>(null);
  // Latest host-global listening services from the same host-global broadcast
  // (the `services` global event). Empty array until the first tick — never
  // null, so `/` consumers can map over it unconditionally.
  const [hostServices, setHostServices] = useState<Service[]>([]);
  // Latest host-global code-server signal (the `code-server` event) — just
  // `{reachable}` since 260811-a2bo. `null` until the first event; the port
  // now resolves by convention (RK_PORT+2), so the broadcast is always on and
  // `null` means "no signal yet", never "feature off".
  const [codeServer, setCodeServer] = useState<CodeServerSignal | null>(null);
  // Latest host-global gui signal (the `gui` event) — the `id:"host"` entry of
  // the payload list, narrowed field-by-field. `null` until the first event.
  const [gui, setGui] = useState<GuiSignal | null>(null);
  // Running daemon version from the server-global `event: version` (no leading
  // "v"). `null` until the first event. Drives the reload guard + update chip.
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  // Daemon process start (epoch seconds) + bound port, from the additive
  // `started`/`port` version-slot fields. `null` until observed; an older
  // daemon's field-less payload keeps both null (never NaN/0).
  const [daemonStarted, setDaemonStarted] = useState<number | null>(null);
  const [daemonPort, setDaemonPort] = useState<number | null>(null);
  // Whether the daemon is a Homebrew install, from the server-global
  // `event: version` `brew` field. `false` until the first version event (the
  // brew-gated `HexoKit: Update Now` palette entry stays hidden until observed).
  const [isBrew, setIsBrew] = useState(false);
  // Pending toolkit update from the server-global `event: update-available`.
  const [updateAvailable, setUpdateAvailable] = useState<UpdateAvailable | null>(null);
  // The latest MANUAL update-check result (the ⟳ / palette check commands).
  // Tab-local and deliberately non-persisted — see ManualCheckResult.
  const [manualCheck, setManualCheck] = useState<ManualCheckResult | null>(null);
  // The composite key the user dismissed the notice for (localStorage-backed).
  const [updateDismissedKey, setUpdateDismissedKey] = useState<string | null>(() => {
    try {
      return localStorage.getItem(UPDATE_DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const { setIsConnected: setChromeConnected } = useChromeDispatch();
  const currentServer = useCurrentServerFromRoute();

  // Reload guard: remember the FIRST {version, boot} this tab observed. When a
  // LATER `version` event (after a state-socket reconnect following a daemon
  // restart or upgrade) differs in EITHER field, the running process changed under this open
  // tab — a version change means new embedded assets, a same-version boot change
  // means a plain restart reconnecting the tab to a new process — so reload once
  // to pick up fresh assets / drop stale in-memory state. Never reload on the
  // first connect (firstVersionRef unset), so there is no reload loop. Held in
  // refs (not state) so the apply callback is stable and the comparison never
  // re-runs an effect. The boot-based branch self-suppresses on `dev` (air
  // recompile storm guard) inside shouldReloadOnVersion.
  const firstVersionRef = useRef<string | null>(null);
  const firstBootRef = useRef<string | null>(null);
  const applyVersion = useCallback((version: string, boot: string | null, brew: boolean, started: number | null, port: number | null) => {
    if (!version) return;
    setDaemonVersion(version);
    setIsBrew(brew);
    setDaemonStarted(started);
    setDaemonPort(port);
    if (shouldReloadOnVersion(firstVersionRef.current, firstBootRef.current, version, boot)) {
      // New process behind the same tab — reload to load fresh assets / drop
      // stale in-memory state.
      location.reload();
      return;
    }
    // Remember the first {version, boot} seen (only on the first connect); a
    // later differing pair is handled by the reload branch above.
    if (firstVersionRef.current === null) {
      firstVersionRef.current = version;
      firstBootRef.current = boot;
    }
  }, []);

  // Apply an `update-available` payload. Host-global (a `kind:"global"` event):
  // the backend delivers it as a cached-on-connect global slot (once per socket
  // connection) and re-broadcasts whenever the composite key changes — including
  // to EMPTY when a match is consumed (R7/R8). Deduping on the composite `key`
  // collapses an idempotent replay (a reconnect re-sends the cached slot) to no
  // state change, so a re-delivery of the same matched set does not churn
  // consumers.
  //
  // A CLEARED payload (empty key) clears the stored state so the chip hides —
  // it MUST NOT early-return (the old bug that left a consumed match advertised
  // forever after a siblings-only update, which never restarts the daemon). A
  // non-empty key stores/dedups as before.
  const applyUpdateAvailable = useCallback((next: UpdateAvailable) => {
    if (!next.key) {
      setUpdateAvailable((prev) => (prev === null ? prev : null));
      return;
    }
    setUpdateAvailable((prev) => (prev && prev.key === next.key ? prev : next));
  }, []);

  // The current ambient composite key, mirrored into a ref at render time (the
  // established `eventRef` idiom below) so `applyManualCheckResult` can read it
  // without taking `updateAvailable` as a dependency — the setter must keep a
  // stable identity across ambient churn (`use-update-check.ts` memoizes
  // `runUpdateCheck` on it, and board-page.tsx memoizes a large palette-action
  // array on THAT).
  const ambientKey = updateAvailable?.key ?? null;
  const ambientKeyRef = useRef<string | null>(ambientKey);
  ambientKeyRef.current = ambientKey;

  // The ambient composite key observed at the moment the manual result was
  // stored — the BASELINE for the update-consumed clearing signal below.
  // `undefined` when no manual result is held. Baselining at store time (rather
  // than watching `updateAvailable.key` raw) is what keeps the first ambient
  // render after a manual check from clearing it immediately; the idiom mirrors
  // use-update-click.ts's `clickKeyRef` R13 completion signal.
  const manualAmbientKeyRef = useRef<string | null | undefined>(undefined);

  // Store a manual check's updatable subset. An EMPTY set clears (a fresh
  // verdict supersedes a stale one — keeping a consumed positive would light a
  // chip the toast just contradicted).
  const applyManualCheckResult = useCallback((tools: UpdateTool[], source: string) => {
    if (tools.length === 0) {
      manualAmbientKeyRef.current = undefined;
      setManualCheck((prev) => (prev === null ? prev : null));
      return;
    }
    manualAmbientKeyRef.current = ambientKeyRef.current;
    setManualCheck({ tools, source });
  }, []);

  // Clear the held manual result once the AMBIENT composite key changes away
  // from the key observed when it was stored — the update-consumed signal (the
  // ambient feed is the durable, policy-driven one, so its verdict moving on
  // supersedes a manual snapshot). Includes the cleared empty key, which the
  // apply callback surfaces here as `null`. A daemon restart instead discards
  // the state via the tab reload.
  useEffect(() => {
    if (manualCheck === null) return;
    if (manualAmbientKeyRef.current === undefined) return;
    if (ambientKey !== manualAmbientKeyRef.current) {
      manualAmbientKeyRef.current = undefined;
      setManualCheck(null);
    }
  }, [ambientKey, manualCheck]);

  // Dismiss the EFFECTIVE displayed key — the ambient composite key when the
  // ambient feed is the lit one, the client-composed manual key when the manual
  // feed is. Re-deriving the same ambient-first merge the display uses
  // (`deriveUpdateFeed`) is what lets the chip's ✕ and the palette's dismiss
  // entry work unchanged against a manual-fed chip. Still a no-op on an empty
  // effective key.
  const dismissUpdate = useCallback(() => {
    const ambientTools = (updateAvailable?.tools ?? EMPTY_TOOLS).filter((t) => t.notable !== false);
    const manualTools = manualCheck?.tools ?? EMPTY_TOOLS;
    const { key } = deriveUpdateFeed(
      ambientTools,
      updateAvailable?.key ?? null,
      manualTools,
      manualTools.length > 0 ? computeUpdateKey(manualTools) : null,
      daemonVersion === DEV_VERSION,
      updateDismissedKey,
    );
    if (!key) return;
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, key);
    } catch {
      // localStorage unavailable — dismissal is best-effort.
    }
    setUpdateDismissedKey(key);
  }, [updateAvailable, manualCheck, daemonVersion, updateDismissedKey]);

  const updateNow = useCallback(() => triggerUpdate(), []);
  // Maintenance actions (palette-only): force a self-upgrade regardless of the
  // qualifying snapshot, and bounce the daemon. Thin wrappers over the client
  // helpers — same shape as updateNow. The ensuing state-socket drop +
  // boot/version-driven reload IS the feedback; the caller catches rejections
  // (no toast).
  const forceUpdateNow = useCallback(() => triggerForceUpdate(), []);
  const restartNow = useCallback(() => triggerRestart(), []);

  // Last raw host-metrics payload applied to `hostMetrics`. The `metrics` event
  // is host-global — the muxed socket delivers it ONCE per tick as a
  // `kind:"global"` event (vs. the old per-stream fan-out that arrived once per
  // attached server). This guard still earns its keep: a reconnect replays the
  // cached metrics slot, and the ack snapshot can repeat the current payload, so
  // deduping on the raw event string collapses identical payloads to one state
  // update — without it each arrival would call `setHostMetrics` with a
  // freshly-parsed (referentially-new) object, forcing a redundant
  // HostMetricsContext re-render.
  const hostMetricsPrevRef = useRef<string>("");
  // Latest host snapshot, ref-backed so the stable socket handlers can seed a
  // server slice that subscribes AFTER the last metrics frame arrived (the
  // server now suppresses identical frames, so no later event would fill it).
  const hostMetricsSnapRef = useRef<MetricsSnapshot | null>(null);
  const applyHostMetrics = useCallback((raw: string, snap: MetricsSnapshot): boolean => {
    if (raw === hostMetricsPrevRef.current) return false;
    hostMetricsPrevRef.current = raw;
    hostMetricsSnapRef.current = snap;
    setHostMetrics(snap);
    return true;
  }, []);

  // Same raw-payload dedup as `applyHostMetrics`, for the `services` event. It
  // is host-global too — delivered once per tick as a `kind:"global"` event —
  // but a reconnect replay can repeat the current payload; deduping on the raw
  // string collapses identical payloads to one state update.
  const hostServicesPrevRef = useRef<string>("");
  const applyHostServices = useCallback((raw: string, services: Service[]) => {
    if (raw === hostServicesPrevRef.current) return;
    hostServicesPrevRef.current = raw;
    setHostServices(services);
  }, []);

  // Same raw-payload dedup as `applyHostServices`, for the `code-server` event
  // (host-global — the dedup collapses reconnect replays and ack repeats to
  // actual port/reachability transitions).
  const codeServerPrevRef = useRef<string>("");
  const applyCodeServer = useCallback((raw: string, signal: CodeServerSignal) => {
    if (raw === codeServerPrevRef.current) return;
    codeServerPrevRef.current = raw;
    setCodeServer(signal);
  }, []);

  // Same raw-payload dedup as `applyCodeServer`, for the `gui` broadcast.
  const guiPrevRef = useRef<string>("");
  const applyGui = useCallback((raw: string, signal: GuiSignal | null) => {
    if (raw === guiPrevRef.current) return;
    guiPrevRef.current = raw;
    setGui(signal);
  }, []);

  // Apply a host-global `server-order` payload: stamp each named server's rank
  // from its position in `order`, drop the rank of any server not listed (so a
  // removed-from-order server falls to the unranked tail), then re-sort with the
  // same rank-aware comparator used at fetch time — a state update, no
  // /api/servers refetch. Always produces a fresh array; churn here is bounded
  // to explicit reorder events, not per-tick events, so no dedup guard is
  // needed. Delivered once over the state socket as a `kind:"global"` event.
  const applyServerOrder = useCallback((order: string[]) => {
    const rankByName = new Map<string, number>();
    order.forEach((name, i) => rankByName.set(name, i));
    setServers((prev) => {
      const next = prev.map((s) => ({
        ...s,
        rank: rankByName.has(s.name) ? rankByName.get(s.name)! : null,
      }));
      next.sort(compareServersRanked);
      return next;
    });
  }, []);

  const attachServer = useCallback((name: string) => {
    setAttachedNonCurrent((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  }, []);

  // Board-changed event subscribers. Stored in a ref so the state socket's
  // per-server event handler can fire all subscribers without re-running on
  // every subscriber registration.
  const boardChangeSubscribersRef = useRef<Set<(server: string) => void>>(new Set());
  const subscribeBoardChange = useCallback((handler: (server: string) => void) => {
    boardChangeSubscribersRef.current.add(handler);
    return () => {
      boardChangeSubscribersRef.current.delete(handler);
    };
  }, []);

  // Board-order event subscribers (host-global). Same ref-of-handlers pattern
  // as boardChangeSubscribersRef so the socket's global-event handler can fire
  // them without re-running on every subscriber registration.
  const boardOrderSubscribersRef = useRef<Set<() => void>>(new Set());
  const subscribeBoardOrder = useCallback((handler: () => void) => {
    boardOrderSubscribersRef.current.add(handler);
    return () => {
      boardOrderSubscribersRef.current.delete(handler);
    };
  }, []);
  const fireBoardOrder = useCallback(() => {
    for (const handler of boardOrderSubscribersRef.current) {
      try {
        handler();
      } catch {
        // ignore individual subscriber errors
      }
    }
  }, []);

  // Status-refresh completion subscribers (host-global). Same ref-of-handlers
  // pattern as boardOrderSubscribersRef: a manual PR-status refresh completing
  // server-side fans out `status-refresh` as a `kind:"global"` event over the
  // socket, and the PANE-header refresh button subscribes to clear its spinner
  // (it spins click→event, not click→POST).
  const statusRefreshSubscribersRef = useRef<Set<() => void>>(new Set());
  const subscribeStatusRefresh = useCallback((handler: () => void) => {
    statusRefreshSubscribersRef.current.add(handler);
    return () => {
      statusRefreshSubscribersRef.current.delete(handler);
    };
  }, []);
  const fireStatusRefresh = useCallback(() => {
    for (const handler of statusRefreshSubscribersRef.current) {
      try {
        handler();
      } catch {
        // ignore individual subscriber errors
      }
    }
  }, []);

  const notifySubscribersRef = useRef<Set<(payload: NotifyPayload) => void>>(new Set());
  const subscribeNotify = useCallback((handler: (payload: NotifyPayload) => void) => {
    notifySubscribersRef.current.add(handler);
    return () => {
      notifySubscribersRef.current.delete(handler);
    };
  }, []);
  const fireNotify = useCallback((payload: NotifyPayload) => {
    for (const handler of notifySubscribersRef.current) {
      try {
        handler(payload);
      } catch {
        // ignore individual subscriber errors
      }
    }
  }, []);

  // Effective attach set = currentServer ∪ attachedNonCurrent ∩ knownServers.
  // We intersect with known servers so that disappeared servers don't keep ES open.
  const attachedSet = useMemo(() => {
    const set = new Set<string>();
    const known = new Set(servers.map((s) => s.name));
    if (currentServer && known.has(currentServer)) set.add(currentServer);
    for (const n of attachedNonCurrent) {
      if (known.has(n)) set.add(n);
    }
    return set;
  }, [currentServer, attachedNonCurrent, servers]);

  // Persist last-used server to localStorage when on an AppShell route.
  useEffect(() => {
    if (!currentServer) return;
    try {
      localStorage.setItem(SERVER_STORAGE_KEY, currentServer);
    } catch {
      // localStorage unavailable
    }
  }, [currentServer]);

  // Mirror the current server's connection state into ChromeContext so the
  // existing connection dot in the top bar continues to reflect the active
  // server's subscription state. Single-server behavior preserved.
  useEffect(() => {
    if (!currentServer) {
      setChromeConnected(false);
      return;
    }
    const slice = slicesByServer.get(currentServer);
    setChromeConnected(slice?.isConnected ?? false);
  }, [currentServer, slicesByServer, setChromeConnected]);

  const fetchServers = useCallback(async () => {
    try {
      const data = await listServers();
      // Sort once at the single ingestion point so every consumer of ctx.servers
      // inherits the effective (infra-class, rank, name) ordering. /api/servers
      // stays alphabetical (asserted API contract) and carries each entry's
      // rank; display order — including user-defined rank — is a frontend
      // concern applied here.
      setServers(Array.isArray(data) ? [...data].sort(compareServersRanked) : []);
    } catch {
      // ignore
    } finally {
      // The fetch attempt has settled (success, empty, or caught error) — the
      // list is now "loaded" for the purposes of the route guard. A permanent
      // false here would hang the guard's not-found branch forever.
      setServersLoaded(true);
    }
  }, []);

  // Set the pending server. An empty string clears it (`null`) — used by the
  // create flow's rollback path so a failed create never strands the waiting
  // state. A real route's `server` param is never empty, so a cleared `null`
  // can never spuriously match the guard.
  const markServerPending = useCallback((name: string) => {
    setPendingServer(name || null);
  }, []);

  // Clear the pending marker once the refreshed list contains it, so the
  // waiting state swaps to the server view automatically and a *later* genuine
  // deletion of that same server correctly shows "Server not found" again
  // (rather than spinning on a stale marker). Runs as an effect, never during
  // render. No timer — event-driven on the list changing.
  useEffect(() => {
    if (pendingServer && servers.some((s) => s.name === pendingServer)) {
      setPendingServer(null);
    }
  }, [pendingServer, servers]);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  /** Helper — apply a partial update to a server's slice, replacing the Map
   *  reference so React picks up the change. Skips the update if the server
   *  no longer exists (race: cleanup happened mid-update). */
  const updateSlice = useCallback(
    (server: string, partial: Partial<ServerSlice>, requireExisting = false) => {
      setSlicesByServer((prev) => {
        const existing = prev.get(server);
        if (requireExisting && !existing) return prev;
        const next = new Map(prev);
        next.set(server, { ...EMPTY_SLICE, ...existing, ...partial });
        return next;
      });
    },
    [],
  );

  // Single state socket (`/ws/state`) carrying ALL session-state + host-metrics
  // streams (change 260716-qf3j). Replaces the per-server EventSource pool + the
  // dedicated `?metrics=1` stream. An established WebSocket holds no HTTP/1.1
  // pool slot (docs/findings/socket-pool-accounting.md), so one socket clears
  // the pool starvation that blocked terminal handshakes on Firefox/WebKit.
  //
  // Held in a ref so the socket survives effect re-runs / StrictMode remounts.
  // `attachServer` / `subscribe*` and every consumer above these seams are
  // unchanged — the socket demuxes the envelope back into the same per-server /
  // host-global apply paths the SSE listeners used.
  const socketRef = useRef<StateSocket | null>(null);
  // Socket-level connection state — true between onopen and onclose. The
  // per-server dot derives from (socket connected AND that server's subscription
  // acked).
  const socketConnectedRef = useRef(false);
  // 3s disconnect debounce (mirrors the old per-server `onerror` debounce) so a
  // transient socket blip doesn't flicker the connection dots gray.
  const socketDisconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which servers currently have an acked subscription (drives per-server
  // isConnected). A plain Set in a ref — connection-dot state is derived from
  // it plus socketConnectedRef; we still call updateSlice to publish isConnected.
  const ackedServersRef = useRef<Set<string>>(new Set());
  // Servers with an active per-server subscription (diffed against attachedSet).
  // Declared here (above the event handlers) so handleGlobalEvent can fan the
  // host-global metrics snapshot into each attached server's per-server slice.
  const subscribedServersRef = useRef<Set<string>>(new Set());
  // Per-server monotonic receipt tick (260823-ke9i): bumped on every
  // server-scoped snapshot or event received for that server. Read imperatively
  // by the pending-switch bounce verdict — ref-backed so the read never
  // subscribes to re-renders. A server never seen reads 0.
  const receiptTicksRef = useRef<Map<string, number>>(new Map());
  const bumpReceiptTick = useCallback((server: string) => {
    receiptTicksRef.current.set(server, (receiptTicksRef.current.get(server) ?? 0) + 1);
  }, []);
  const getServerReceiptTick = useCallback(
    (server: string) => receiptTicksRef.current.get(server) ?? 0,
    [],
  );

  // Stable event handlers held in a ref so the socket is constructed ONCE
  // (the apply* callbacks are stable useCallbacks; we thread them through a ref
  // to keep the socket-construction effect dependency-free).
  const handleServerEvent = useCallback(
    (type: string, key: string, data: unknown) => {
      switch (type) {
        case "sessions": {
          const sessions = data as ProjectSession[];
          startTransition(() => {
            updateSlice(key, { sessions, isConnected: true }, true);
          });
          break;
        }
        case "session-order": {
          const d = data as { server?: string; order?: string[] };
          if (d.server !== key) return; // defensive misroute guard (parity with SSE)
          updateSlice(key, { sessionOrder: Array.isArray(d.order) ? d.order : [] }, true);
          break;
        }
        case "preview": {
          const d = data as Record<string, string>;
          // Merge, don't replace — a preview event carries only the subset of
          // windows captured this tick (parity with the SSE preview listener).
          setSlicesByServer((prev) => {
            const existing = prev.get(key);
            if (!existing) return prev;
            const next = new Map(prev);
            next.set(key, { ...existing, previews: { ...existing.previews, ...d } });
            return next;
          });
          break;
        }
        case "board-changed": {
          for (const handler of boardChangeSubscribersRef.current) {
            try {
              handler(key);
            } catch {
              // ignore individual subscriber errors
            }
          }
          break;
        }
        default:
          break;
      }
    },
    [updateSlice],
  );

  const handleGlobalEvent = useCallback(
    (type: string, data: unknown) => {
      switch (type) {
        case "metrics": {
          const snap = data as MetricsSnapshot;
          // Dedupe on the raw payload (parity with applyHostMetrics's SSE
          // dedup): the metrics broadcast is host-global.
          const changed = applyHostMetrics(JSON.stringify(data), snap);
          // Also populate every attached server's per-server slice metrics, so
          // `useMetrics()` (current-server-scoped — the sidebar Host panel) stays
          // fed. Under SSE this rode each per-server stream's `metrics` listener;
          // the muxed socket delivers metrics ONCE as a global, so fan it into the
          // subscribed servers' slices here (parity with the old per-server write) —
          // but only on a real change: an identical payload (reconnect replay, an
          // ack repeating the slot) must not re-write every slice and re-render
          // the tree on identical data.
          if (changed) {
            for (const name of subscribedServersRef.current) {
              updateSlice(name, { metrics: snap }, true);
            }
          }
          break;
        }
        case "services": {
          const d = data as ServicesSnapshot;
          applyHostServices(JSON.stringify(data), Array.isArray(d.services) ? d.services : []);
          break;
        }
        case "code-server": {
          const d = data as { reachable?: boolean };
          applyCodeServer(JSON.stringify(data), {
            reachable: d.reachable === true,
          });
          break;
        }
        case "gui": {
          applyGui(JSON.stringify(data), narrowGuiSignal(data));
          break;
        }
        case "server-order": {
          const d = data as { order?: string[] };
          if (Array.isArray(d.order)) applyServerOrder(d.order);
          break;
        }
        case "board-order":
          fireBoardOrder();
          break;
        case "status-refresh":
          fireStatusRefresh();
          break;
        case "notify":
          if (isNotifyPayload(data)) fireNotify(data);
          break;
        case "version": {
          const d = data as { version?: string; boot?: string; brew?: boolean; started?: number; port?: number };
          if (typeof d.version === "string") {
            applyVersion(
              d.version,
              typeof d.boot === "string" ? d.boot : null,
              d.brew === true,
              typeof d.started === "number" && Number.isFinite(d.started) ? d.started : null,
              typeof d.port === "number" && Number.isFinite(d.port) ? d.port : null,
            );
          }
          break;
        }
        case "update-available": {
          const d = data as {
            tools?: {
              tool?: string;
              current?: string;
              latest?: string;
              updateAvailable?: boolean;
              notable?: boolean;
            }[];
            key?: string;
            current?: string;
            latest?: string;
          };
          if (typeof d.key === "string" && Array.isArray(d.tools)) {
            const tools: UpdateTool[] = d.tools
              .filter(
                (t): t is UpdateTool =>
                  typeof t.tool === "string" &&
                  typeof t.current === "string" &&
                  typeof t.latest === "string",
              )
              .map((t) => ({
                tool: t.tool,
                current: t.current,
                latest: t.latest,
                // The verdict flags ride only when the daemon sends booleans —
                // an old daemon's flag-less payload leaves them undefined, which
                // consumers treat as true (every listed tool was matched).
                ...(typeof t.updateAvailable === "boolean"
                  ? { updateAvailable: t.updateAvailable }
                  : {}),
                ...(typeof t.notable === "boolean" ? { notable: t.notable } : {}),
              }));
            applyUpdateAvailable({
              tools,
              key: d.key,
              current: typeof d.current === "string" ? d.current : "",
              latest: typeof d.latest === "string" ? d.latest : "",
            });
          }
          break;
        }
        default:
          break;
      }
    },
    [applyHostMetrics, applyHostServices, applyCodeServer, applyGui, applyServerOrder, fireBoardOrder, fireStatusRefresh, fireNotify, applyVersion, applyUpdateAvailable, updateSlice],
  );

  // Latest handlers, kept in a ref so the one-time socket-construction effect
  // never needs to re-run when a handler identity changes.
  const eventRef = useRef({ handleServerEvent, handleGlobalEvent, fetchServers });
  eventRef.current = { handleServerEvent, handleGlobalEvent, fetchServers };

  // Construct + connect the socket exactly once (mount → unmount). All state is
  // routed through eventRef so this effect has no changing dependencies.
  useEffect(() => {
    const applyServerConnected = () => {
      // A subscription is "connected" only while the socket itself is up.
      const up = socketConnectedRef.current;
      for (const name of ackedServersRef.current) {
        updateSlice(name, { isConnected: up }, true);
      }
    };

    const socket = new StateSocket({
      onEvent: (ev) => {
        if (ev.kind === "server" && ev.key) {
          bumpReceiptTick(ev.key);
          eventRef.current.handleServerEvent(ev.type, ev.key, ev.data);
        } else if (ev.kind === "global") {
          eventRef.current.handleGlobalEvent(ev.type, ev.data);
        }
      },
      onAck: (_req, kind, key, snapshot) => {
        if (kind === "metrics") {
          // The metrics ack snapshot is the cached metrics payload (or null).
          if (snapshot) {
            eventRef.current.handleGlobalEvent("metrics", snapshot);
          }
          return;
        }
        if (!key) return;
        ackedServersRef.current.add(key);
        bumpReceiptTick(key);
        // The server ack snapshot is the sessions payload (parity with the
        // first `event: sessions`). null means "no snapshot yet". The slice is
        // also seeded with the retained host metrics: the hub broadcasts
        // `metrics` only when it changed, so a server attached after the last
        // frame (e.g. a sidebar server on `/`, whose cached replay preceded the
        // attach) would otherwise hold a null metrics slice until the host
        // snapshot next moves.
        const sessions = Array.isArray(snapshot) ? (snapshot as ProjectSession[]) : [];
        const seedMetrics = hostMetricsSnapRef.current;
        startTransition(() => {
          updateSlice(
            key,
            {
              sessions,
              isConnected: socketConnectedRef.current,
              ...(seedMetrics ? { metrics: seedMetrics } : {}),
            },
            true,
          );
        });
      },
      onGone: (key) => {
        ackedServersRef.current.delete(key);
        // Also release the subscription itself — drop it from the active set and
        // the StateSocket's ref-count. Otherwise, if the server stays in
        // attachedSet (a still-attached server that only transiently went gone,
        // or one fetchServers keeps returning), the diff effect would see the
        // name already in subscribedServersRef and never re-subscribe — leaving
        // that server's UI permanently dead until detach/reload. Releasing here
        // lets the diff effect re-subscribe cleanly when attachedSet recomputes
        // (fetchServers below drives that) and the server is still desired.
        subscribedServersRef.current.delete(key);
        socketRef.current?.unsubscribeServer(key);
        setSlicesByServer((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        eventRef.current.fetchServers();
      },
      onConnectionChange: (connected) => {
        if (connected) {
          socketConnectedRef.current = true;
          if (socketDisconnectTimerRef.current) {
            clearTimeout(socketDisconnectTimerRef.current);
            socketDisconnectTimerRef.current = null;
          }
          applyServerConnected();
        } else {
          // 3s debounce before flipping dots gray (parity with the old
          // per-server / dedicated-stream onerror debounce).
          if (!socketDisconnectTimerRef.current) {
            socketDisconnectTimerRef.current = setTimeout(() => {
              socketDisconnectTimerRef.current = null;
              socketConnectedRef.current = false;
              applyServerConnected();
              // Fallback for a catastrophic drop the backend couldn't signal
              // with `gone` (e.g. the daemon itself is mid-restart): re-query
              // the server list so a genuinely-gone server drops out.
              eventRef.current.fetchServers();
            }, 3000);
          }
        }
      },
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      if (socketDisconnectTimerRef.current) {
        clearTimeout(socketDisconnectTimerRef.current);
        socketDisconnectTimerRef.current = null;
      }
      socket.close();
      socketRef.current = null;
      // Reset the subscription guard refs so a remount re-subscribes on the NEW
      // socket. StrictMode double-mounts the provider (dev + e2e run under
      // <StrictMode>): this effect destroys+recreates the socket, but the guard
      // refs below live OUTSIDE the effect and survive the remount. Without this
      // reset, mount 2's diff effect (`subscribedServersRef`) and metrics effect
      // (`metricsSubscribedRef`) would see their guards already true and never
      // subscribe on the fresh socket — permanently losing the metrics
      // subscription on `/` (host-metrics data dead, poll loop never started
      // when this is the hub's only client). `ackedServersRef` is cleared too
      // since nothing is acked on the new socket until fresh acks arrive. These
      // effects re-run on every remount regardless of dep changes, so cleared
      // guards make them re-subscribe.
      metricsSubscribedRef.current = false;
      subscribedServersRef.current.clear();
      ackedServersRef.current.clear();
    };
  }, [updateSlice]);

  // Diff the desired attach set against active server subscriptions. Newly
  // attached servers subscribe (seeding an empty slice for a stable initial
  // value); removed servers unsubscribe and drop their slice.
  // (subscribedServersRef is declared above, next to ackedServersRef.)
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const desired = attachedSet;
    const active = subscribedServersRef.current;

    for (const name of desired) {
      if (active.has(name)) continue;
      active.add(name);
      updateSlice(name, EMPTY_SLICE);
      socket.subscribeServer(name);
    }
    for (const name of Array.from(active)) {
      if (desired.has(name)) continue;
      active.delete(name);
      ackedServersRef.current.delete(name);
      socket.unsubscribeServer(name);
      setSlicesByServer((prev) => {
        if (!prev.has(name)) return prev;
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
    }
  }, [attachedSet, updateSlice]);

  // Host-metrics subscription — opened ONLY when no server is attached (the bare
  // `/` case with zero attached servers). When a server is attached its
  // subscription already carries the host-global `metrics`/`services` broadcasts
  // (they fan out to every connection), so a separate metrics subscription is
  // redundant. This mirrors the old dedicated-`?metrics=1`-stream open/close.
  const hostMetricsWanted = attachedSet.size === 0;
  const metricsSubscribedRef = useRef(false);
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    if (hostMetricsWanted && !metricsSubscribedRef.current) {
      metricsSubscribedRef.current = true;
      socket.subscribeMetrics();
    } else if (!hostMetricsWanted && metricsSubscribedRef.current) {
      metricsSubscribedRef.current = false;
      socket.unsubscribeMetrics();
    }
  }, [hostMetricsWanted]);

  // Derive per-field Maps from the slice Map. Memoized so unrelated re-renders
  // don't churn consumer references. Each Map is a fresh reference whenever
  // any slice changes — that's intentional: a consumer reading `sessionsByServer`
  // wants to re-render when any server's sessions change. Per-server fine-grained
  // memoization is a future optimization if needed.
  const sessionsByServer = useMemo(() => {
    const m = new Map<string, ProjectSession[]>();
    for (const [name, slice] of slicesByServer) m.set(name, slice.sessions);
    return m;
  }, [slicesByServer]);

  const sessionOrderByServer = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [name, slice] of slicesByServer) m.set(name, slice.sessionOrder);
    return m;
  }, [slicesByServer]);

  const isConnectedByServer = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const [name, slice] of slicesByServer) m.set(name, slice.isConnected);
    return m;
  }, [slicesByServer]);

  const metricsByServer = useMemo(() => {
    const m = new Map<string, MetricsSnapshot | null>();
    for (const [name, slice] of slicesByServer) m.set(name, slice.metrics);
    return m;
  }, [slicesByServer]);

  const previewsByServer = useMemo(() => {
    const m = new Map<string, Record<string, string>>();
    for (const [name, slice] of slicesByServer) m.set(name, slice.previews);
    return m;
  }, [slicesByServer]);

  // Declare the tile grid's expanded-session set for a server. Sent in-band over
  // the state socket (addressed by the socket's own conn id — decision D4), so
  // there is no POST-races-the-stream window. Best-effort: a not-yet-open socket
  // simply drops the frame (the next re-declare after connect covers it).
  const setPreviewScope = useCallback((server: string, expanded: string[]) => {
    socketRef.current?.sendPreviewScope(server, expanded);
  }, []);

  const value = useMemo<SessionContextType>(
    () => ({
      sessionsByServer,
      sessionOrderByServer,
      isConnectedByServer,
      metricsByServer,
      previewsByServer,
      setPreviewScope,
      currentServer,
      servers,
      refreshServers: fetchServers,
      serversLoaded,
      pendingServer,
      markServerPending,
      attachServer,
      subscribeBoardChange,
      subscribeBoardOrder,
      subscribeStatusRefresh,
      subscribeNotify,
      getServerReceiptTick,
      daemonVersion,
      daemonStarted,
      daemonPort,
      updateAvailable,
      manualCheck,
      applyManualCheckResult,
      updateDismissedKey,
      updateNow,
      dismissUpdate,
      brew: isBrew,
      forceUpdateNow,
      restartNow,
    }),
    [
      sessionsByServer,
      sessionOrderByServer,
      isConnectedByServer,
      metricsByServer,
      previewsByServer,
      setPreviewScope,
      currentServer,
      servers,
      fetchServers,
      serversLoaded,
      pendingServer,
      markServerPending,
      attachServer,
      subscribeBoardChange,
      subscribeBoardOrder,
      subscribeStatusRefresh,
      subscribeNotify,
      getServerReceiptTick,
      daemonVersion,
      daemonStarted,
      daemonPort,
      updateAvailable,
      manualCheck,
      applyManualCheckResult,
      updateDismissedKey,
      updateNow,
      dismissUpdate,
      isBrew,
      forceUpdateNow,
      restartNow,
    ],
  );

  // Provide metrics for the current server only — HostPanel and other current-
  // server-scoped consumers continue to call `useMetrics()` unchanged.
  const currentMetrics = currentServer ? metricsByServer.get(currentServer) ?? null : null;

  return (
    <SessionContext.Provider value={value}>
      <MetricsContext.Provider value={currentMetrics}>
        <HostMetricsContext.Provider value={hostMetrics}>
          <HostServicesContext.Provider value={hostServices}>
            <CodeServerContext.Provider value={codeServer}>
              <GuiContext.Provider value={gui}>
                {children}
              </GuiContext.Provider>
            </CodeServerContext.Provider>
          </HostServicesContext.Provider>
        </HostMetricsContext.Provider>
      </MetricsContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSessionContext(): SessionContextType {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessionContext must be used within SessionProvider");
  return ctx;
}

/** The roster names of this app's own row — `hexokit` (shll >= v0.1.34) plus the
 *  legacy `rk`/`run-kit` older shll reports. The self row is the single tool
 *  that keeps today's `⬆ v{latest}` chip form (any other single tool, or
 *  multiple, uses a count form). Mirrors the backend's `isSelfTool` names. */
const SELF_TOOL_NAMES: ReadonlySet<string> = new Set(["hexokit", "rk", "run-kit"]);

/** Frozen module-level empty tools list — the stable fallback for
 *  `updateAvailable?.tools ?? EMPTY_TOOLS` in `useUpdateNotification`, so a
 *  no-update render returns the SAME array reference every time instead of
 *  minting a fresh `[]` (which would defeat referential-equality memoization in
 *  consumers and churn the top bar's fit effect). Frozen at runtime (no consumer
 *  mutates it); typed as the mutable `UpdateTool[]` to match the exported
 *  `tools` contract without a readonly ripple through its consumers. */
const EMPTY_TOOLS: UpdateTool[] = Object.freeze([]) as unknown as UpdateTool[];

/** The merged two-feed update verdict — what the persistent update surfaces
 *  display. `manualOnly` names WHICH feed produced the other fields, so click
 *  routing can branch without re-deriving the merge. */
export type UpdateFeed = {
  tools: UpdateTool[];
  key: string | null;
  manualOnly: boolean;
};

/**
 * THE single two-feed merge (R6). Both persistent surfaces — the in-bar
 * `UpdateChip` and the overflow-menu version row — plus both palette mounts
 * consume it through `useUpdateNotification`, so the precedence rule exists in
 * exactly one place and the surfaces cannot drift.
 *
 * **Ambient-first**: when the ambient (SSE `update-available`) feed SHOWS — it
 * has notable tools, the daemon is not `dev`, and its key is not dismissed —
 * every field is the ambient one, byte-identical to the pre-merge behavior. The
 * ambient feed is the durable, policy-driven, cross-tab channel; a manual
 * snapshot never displaces it.
 *
 * **Manual fallback**: only when the ambient feed does not show does a held
 * manual result surface, with its key composed client-side (`computeUpdateKey`
 * — the manual check is a side channel with no server-computed key), so the
 * same composite-key dismissal and `!isDev` gates apply unchanged.
 *
 * Returns the ambient shape (with `manualOnly: false`) when neither feed has
 * anything, so a no-update render keeps the frozen `EMPTY_TOOLS` identity.
 */
export function deriveUpdateFeed(
  ambientTools: UpdateTool[],
  ambientKey: string | null,
  manualTools: UpdateTool[],
  manualKey: string | null,
  isDev: boolean,
  dismissedKey: string | null,
): UpdateFeed {
  const ambientShows = !isDev && ambientTools.length > 0 && ambientKey !== dismissedKey;
  if (ambientShows || manualTools.length === 0) {
    return { tools: ambientTools, key: ambientKey, manualOnly: false };
  }
  return { tools: manualTools, key: manualKey, manualOnly: true };
}

/** Derived view of the update-notification state, shared by the top-bar chip and
 *  the command-palette actions so their gating can never drift. It merges TWO
 *  feeds ambient-first (`deriveUpdateFeed`) — the durable SSE `update-available`
 *  verdict, and the tab-local manual ⟳ check result — so a manually-discovered
 *  update lands on the persistent surfaces instead of evaporating with its toast.
 *   - `qualifies` — the EFFECTIVE feed has tools AND the daemon is not the
 *     `dev` sentinel. (This is the palette's gate; the palette IGNORES
 *     dismissal — dismissal silences only the ambient chip.)
 *   - `showChip` — `qualifies` AND the effective composite `key` is not
 *     dismissed. This is the chip's visibility gate. Sub-threshold
 *     (`notable: false`) verdicts in the AMBIENT payload never light the chip —
 *     a patch-only ambient finding is toast-only, by policy. (A deliberate
 *     manual incl.-patches check DOES light it: the user asked.)
 *   - `tools` — the effective feed's tools (each `{tool, current, latest}`);
 *     the ambient feed contributes its NOTABLE subset (a missing flag —
 *     old-daemon payload — counts as notable), the manual feed contributes the
 *     updatable subset the check's toast reported. Empty when neither shows.
 *   - `key` — the effective composite dismissal key (or `null`): the ambient
 *     payload's server-computed key, or the client-composed manual one.
 *   - `manualOnly` — true exactly when the surfaced fields come from the manual
 *     feed, so `use-update-click` can route the click to the full-roster force
 *     update (the manual verdict has no scoped server-side match set).
 *   - `singleRunKit` — true when exactly one tool matched and it is run-kit, so
 *     the chip keeps today's `⬆ v{latest}` form; otherwise a count form.
 *   - `latest` / `current` — the run-kit row versions when `singleRunKit`, else
 *     `null`; kept for the single-run-kit chip/palette wording.
 *   - `updateNow` / `dismissUpdate` — the context actions, re-exported.
 *   - `daemonVersion` — the running version (or `null`), for the dev-gate.
 *   - `brew` — whether the daemon is a Homebrew install, gating the force-update
 *     maintenance entry (`false` until the first version event).
 *   - `forceUpdateNow` / `restartNow` — the maintenance actions, re-exported. */
export function useUpdateNotification(): {
  qualifies: boolean;
  showChip: boolean;
  tools: UpdateTool[];
  key: string | null;
  manualOnly: boolean;
  singleRunKit: boolean;
  latest: string | null;
  current: string | null;
  updateNow: () => Promise<UpdateTriggerResult>;
  dismissUpdate: () => void;
  daemonVersion: string | null;
  brew: boolean;
  forceUpdateNow: () => Promise<UpdateTriggerResult>;
  restartNow: () => Promise<UpdateTriggerResult>;
} {
  // Tolerant of a missing provider: the update chip/palette are chrome that must
  // degrade to "no update" (never crash) when mounted outside SessionProvider
  // — e.g. isolated component tests. Mirrors how usePushSubscription (the
  // settings dialog's Notifications row) never throws without a provider.
  const ctx = useContext(SessionContext);
  const daemonVersion = ctx?.daemonVersion ?? null;
  const updateAvailable = ctx?.updateAvailable ?? null;
  const manualCheck = ctx?.manualCheck ?? null;
  const updateDismissedKey = ctx?.updateDismissedKey ?? null;
  const updateNow = ctx?.updateNow ?? (() => Promise.resolve({ status: "" }));
  const dismissUpdate = ctx?.dismissUpdate ?? (() => {});
  const brew = ctx?.brew ?? false;
  const forceUpdateNow = ctx?.forceUpdateNow ?? (() => Promise.resolve({ status: "" }));
  const restartNow = ctx?.restartNow ?? (() => Promise.resolve({ status: "" }));
  const isDev = daemonVersion === DEV_VERSION;
  // The payload's tools list is the FULL verdict list (incl. sub-threshold
  // rows); chip/palette consumers care about the NOTABLE subset only. A missing
  // flag (old-daemon payload — it listed only matched tools) counts as notable.
  // Memoized with identity preserved when nothing filters out, so a no-op
  // filter never mints a fresh array (same referential-equality concern as
  // EMPTY_TOOLS — see its comment).
  const ambientTools = useMemo(() => {
    const all = updateAvailable?.tools ?? EMPTY_TOOLS;
    const notable = all.filter((t) => t.notable !== false);
    return notable.length === all.length ? all : notable;
  }, [updateAvailable]);
  const ambientKey = updateAvailable?.key ?? null;
  // The manual feed's tools + its client-composed composite key (the manual
  // check is a side channel with no server-computed key). Falls back to the
  // frozen EMPTY_TOOLS so a no-manual-result render keeps a stable identity.
  const manualTools = manualCheck?.tools ?? EMPTY_TOOLS;
  const manualKey = useMemo(
    () => (manualTools.length > 0 ? computeUpdateKey(manualTools) : null),
    [manualTools],
  );
  // THE merge — ambient-first, in exactly one place (see deriveUpdateFeed).
  const { tools, key, manualOnly } = deriveUpdateFeed(
    ambientTools,
    ambientKey,
    manualTools,
    manualKey,
    isDev,
    updateDismissedKey,
  );
  const singleRunKit = tools.length === 1 && SELF_TOOL_NAMES.has(tools[0].tool);
  // The run-kit row versions, surfaced only for the single-run-kit chip/palette
  // wording (`⬆ v{latest}` / `run-kit: Update to v{latest}`). Null otherwise —
  // a multi/non-run-kit chip uses the count form and per-tool detail.
  const latest = singleRunKit ? tools[0].latest : null;
  const current = singleRunKit ? tools[0].current : null;
  const qualifies = !isDev && tools.length > 0;
  const showChip = qualifies && key !== updateDismissedKey;
  return {
    qualifies,
    showChip,
    tools,
    key,
    manualOnly,
    singleRunKit,
    latest,
    current,
    updateNow,
    dismissUpdate,
    daemonVersion,
    brew,
    forceUpdateNow,
    restartNow,
  };
}

export function useMetrics(): MetricsSnapshot | null {
  const ctx = useContext(MetricsContext);
  if (ctx === undefined) throw new Error("useMetrics must be used within SessionProvider");
  return ctx;
}

/** Host-global metrics from the state socket's `metrics` global event. Unlike
 *  `useMetrics()` (current-server-scoped, `null` on `/`), this is available on
 *  EVERY route — the Host host-console home (`/`) consumes it. `null` before
 *  the first metrics tick. */
export function useHostMetrics(): MetricsSnapshot | null {
  const ctx = useContext(HostMetricsContext);
  if (ctx === undefined) throw new Error("useHostMetrics must be used within SessionProvider");
  return ctx;
}

/** Host-global listening services from the state socket's `services` global
 *  event. Available on EVERY route — the Host host-console home (`/`) consumes
 *  it for the SERVICES zone. Returns `[]` before the first services tick (never
 *  null), so consumers can map over it unconditionally. */
export function useHostServices(): Service[] {
  const ctx = useContext(HostServicesContext);
  if (ctx === undefined) throw new Error("useHostServices must be used within SessionProvider");
  return ctx;
}

/** Host-global code-server signal from the state socket's `code-server` global
 *  event (260811-k3vp; `{reachable}` only since 260811-a2bo). Available on
 *  EVERY route. Returns `null` only before the first event — the port resolves
 *  by convention, so the broadcast is always on and `null` never means "code
 *  lens off" (availability is gitRoot-derived — see `hasCode`). */
export function useCodeServer(): CodeServerSignal | null {
  const ctx = useContext(CodeServerContext);
  if (ctx === undefined) throw new Error("useCodeServer must be used within SessionProvider");
  return ctx;
}

/** Host-global gui signal from the state socket's `gui` global event — the
 *  narrowed `id:"host"` entry. Available on EVERY route. Returns `null` before
 *  the first event, which consumers MUST read as disabled (never-on-by-default;
 *  availability keys off `enabled` via `hasGui`). */
export function useGui(): GuiSignal | null {
  const ctx = useContext(GuiContext);
  if (ctx === undefined) throw new Error("useGui must be used within SessionProvider");
  return ctx;
}

// Standalone provider for tests and storybook — supplies a `null` or fake
// metrics value without requiring the full SessionProvider (which opens the
// state socket).
export function MetricsProvider({
  value,
  children,
}: {
  value: MetricsSnapshot | null;
  children: React.ReactNode;
}) {
  return <MetricsContext.Provider value={value}>{children}</MetricsContext.Provider>;
}

/** Standalone provider for tests and storybook — supplies a `null` or fake
 *  host-global metrics value without requiring the full SessionProvider.
 *  Counterpart to `MetricsProvider` above, for the `useHostMetrics()` seam. */
export function HostMetricsProvider({
  value,
  children,
}: {
  value: MetricsSnapshot | null;
  children: React.ReactNode;
}) {
  return <HostMetricsContext.Provider value={value}>{children}</HostMetricsContext.Provider>;
}

/** Standalone provider for tests — supplies a static SessionContext value
 *  without opening the state socket. Counterpart to `MetricsProvider` above.
 *  Accepts a partial multi-server shape and fills missing fields with safe
 *  defaults. */
export function StandaloneSessionContextProvider({
  value,
  children,
}: {
  value: Partial<SessionContextType>;
  children: React.ReactNode;
}) {
  const fullValue: SessionContextType = {
    sessionsByServer: value.sessionsByServer ?? new Map(),
    sessionOrderByServer: value.sessionOrderByServer ?? new Map(),
    isConnectedByServer: value.isConnectedByServer ?? new Map(),
    metricsByServer: value.metricsByServer ?? new Map(),
    previewsByServer: value.previewsByServer ?? new Map(),
    setPreviewScope: value.setPreviewScope ?? (() => {}),
    currentServer: value.currentServer ?? null,
    servers: value.servers ?? [],
    refreshServers: value.refreshServers ?? (() => {}),
    serversLoaded: value.serversLoaded ?? false,
    pendingServer: value.pendingServer ?? null,
    markServerPending: value.markServerPending ?? (() => {}),
    attachServer: value.attachServer ?? (() => {}),
    subscribeBoardChange: value.subscribeBoardChange ?? (() => () => {}),
    subscribeBoardOrder: value.subscribeBoardOrder ?? (() => () => {}),
    subscribeStatusRefresh: value.subscribeStatusRefresh ?? (() => () => {}),
    subscribeNotify: value.subscribeNotify ?? (() => () => {}),
    getServerReceiptTick: value.getServerReceiptTick ?? (() => 0),
    daemonVersion: value.daemonVersion ?? null,
    daemonStarted: value.daemonStarted ?? null,
    daemonPort: value.daemonPort ?? null,
    updateAvailable: value.updateAvailable ?? null,
    manualCheck: value.manualCheck ?? null,
    applyManualCheckResult: value.applyManualCheckResult ?? (() => {}),
    updateDismissedKey: value.updateDismissedKey ?? null,
    updateNow: value.updateNow ?? (() => Promise.resolve({ status: "" })),
    dismissUpdate: value.dismissUpdate ?? (() => {}),
    brew: value.brew ?? false,
    forceUpdateNow: value.forceUpdateNow ?? (() => Promise.resolve({ status: "" })),
    restartNow: value.restartNow ?? (() => Promise.resolve({ status: "" })),
  };
  return <SessionContext.Provider value={fullValue}>{children}</SessionContext.Provider>;
}
