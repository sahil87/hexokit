import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createServer, createSession, createWindow, getSessions, isExternalServer, isInfraServer, DAEMON_SERVER } from "@/api/client";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { finalizeSafeName, toSafeServerName } from "@/lib/names";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useToast } from "@/components/toast";
import { useHostMetrics, useHostServices, useSessionContext } from "@/contexts/session-context";
import { useInstanceName } from "@/contexts/instance-name-context";
import { WaitingBadge } from "@/components/waiting-badge";
import { countWaitingInSessions } from "@/lib/waiting";
import { HostMetrics } from "@/components/host-metrics";
import { SystemCard } from "@/components/system-card";
import { ExternalGlyph, ShieldGlyph } from "@/components/top-bar-icons";
import { useBoards } from "@/hooks/use-boards";
import { useBoardListReorder } from "@/hooks/use-board-list-reorder";
import { useServerReorder } from "@/hooks/use-server-reorder";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { chordHintFor } from "@/lib/keybindings";
import { SectionHeading } from "@/components/section-heading";
import { StatusBar } from "@/components/status-bar";
import { RecoverySection, useRecoveryOffers } from "@/components/recovery-section";
import { buildRecoveryActions } from "@/lib/palette/recovery";
import { useRegisterPaletteActions } from "@/contexts/palette-actions-context";
import { Tip } from "@/components/tip";
import { displayVersion } from "@/lib/palette/version";
import { deriveEffectiveSessionOrder } from "@/lib/palette/move";
import { readLastWindow, resolveServerLandingWindow } from "@/lib/last-window-per-server";

/** Well-known / system ports (< 1024, the reserved range) — sshd:22, smtp:25,
 *  etc. With the SERVICES zone now showing ALL listening ports (no HTTP probe
 *  filter), these are de-emphasized like infra servers: grey text, sorted last
 *  as a class (260715-vfcz). Presentation-only. */
function isWellKnownPort(port: number): boolean {
  return port < 1024;
}

export function HostOverviewPage() {
  // Read the server list from SessionContext — the SAME source the AppShell
  // route guard (`resolveServerView`) reads. Keeping a separate local
  // `listServers()` fetch here was the root of this change's bug class: the
  // page showed one list while the guard checked another, so a just-created
  // server the guard hadn't seen yet flashed "Server not found".
  const {
    servers,
    serversLoaded,
    refreshServers,
    markServerPending,
    sessionsByServer,
    sessionOrderByServer,
    daemonVersion,
    isConnectedByServer,
    attachServer,
  } = useSessionContext();
  // The system card's service rows read the rk-daemon server's sessions —
  // attach it through the existing lazy-attach seam so the rows are live (the
  // host route has no current server, so nothing attaches it otherwise).
  useEffect(() => {
    attachServer(DAEMON_SERVER);
  }, [attachServer]);
  // The status bar's connection dot on `/` (260814-ldbs): the host-global
  // read — connected while EVERY known server stream is up (the board route's
  // boardConnected rule). No servers → disconnected.
  const hostConnected =
    servers.length > 0 && servers.every((s) => isConnectedByServer.get(s.name));
  // Local optimistic pulsing tiles for a create in flight. Self-contained and
  // unrelated to the guard (the OptimisticContext server-level ghosts are
  // rendered nowhere), so this stays local.
  const [ghostServers, setGhostServers] = useState<string[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createName, setCreateName] = useState("");
  const navigate = useNavigate();
  const { addToast } = useToast();
  // Server-tile switch — resolves a landing window for the target server
  // (remembered → derived from the effective session order), falling back to
  // bare `/$server` (the session-tiles overview) when the resolver finds
  // nothing. Only this SWITCH path resolves; the create-server navigations
  // below keep landing on bare `/$server`.
  const handleSwitchServer = useCallback(
    (name: string) => {
      const targetSessions = sessionsByServer.get(name) ?? [];
      const windowId = resolveServerLandingWindow({
        sessions: targetSessions,
        sessionOrder: deriveEffectiveSessionOrder(
          targetSessions.map((s) => s.name),
          sessionOrderByServer.get(name) ?? [],
        ),
        remembered: readLastWindow(name),
      });
      if (windowId) {
        navigate({
          to: "/$server/$window",
          params: { server: name, window: windowId },
          search: {},
        });
      } else {
        navigate({ to: "/$server", params: { server: name } });
      }
    },
    [navigate, sessionsByServer, sessionOrderByServer],
  );
  const hostMetrics = useHostMetrics();
  // Effective palette chord for the empty-zone education copy (260811-ke2s) —
  // derived, never hardcoded; the `→ Pin:` clause is omitted when the binding
  // is unbound/disabled (a hint advertising a dead chord would lie) or when the
  // pointer is coarse (the app's chord-hints-off-touch rule — touch users get
  // the pin-icon path only).
  const coarsePointer = useCoarsePointer();
  // The status-bar gate (260814-ldbs rework): `!isMobile`, the same predicate
  // Shell applies — width-OR-coarse, so a coarse desktop-width device gets the
  // mobile experience everywhere (no status bar).
  const isMobile = useIsMobile();
  const { bindings: keybindings, host: keybindingHost } = useKeybindings();
  const paletteChord = coarsePointer
    ? undefined
    : chordHintFor("command-palette", keybindings, keybindingHost.platform);
  // Instance display name (o7q8): the HOST HEALTH hostname line prefers the
  // settings override; null falls back to the metrics hostname below.
  const { instanceName } = useInstanceName();
  const hostServices = useHostServices();
  // Recovery offers + flows (the RECOVERY zone below and its palette verbs
  // share this one hook instance — one fetch, one mutation flow).
  const recovery = useRecoveryOffers();
  // Recovery palette verbs (Constitution V): `Server: Restore <name>` /
  // `Restore all previous servers` / `Server: Dismiss recovery <name>` /
  // `Dismiss all previous servers` — one entry per offer (the bulk verbs gated
  // on more than one), gated on offers existing (empty list → no entries).
  // Registered from THIS route: `/` mounts no AppShell, so the host page owns
  // its route-scoped palette slot registration. The bodies invoke the same
  // useRecoveryOffers flows the zone's buttons do.
  const recoveryPaletteActions = useMemo(
    () =>
      buildRecoveryActions(recovery.offers, {
        onRestore: (server) => void recovery.restore(server),
        onRestoreAll: () => void recovery.restoreAll(),
        onDismiss: (server) => void recovery.dismiss(server),
        onDismissAll: () => void recovery.dismissAll(),
      }),
    [recovery],
  );
  useRegisterPaletteActions(recoveryPaletteActions);
  // De-emphasize system/infra listeners (mirrors the isInfraServer treatment on
  // server tiles): well-known ports (< 1024, the reserved/system range —
  // ssh:22, smtp:25, etc.) sort AFTER regular ports as a class and render in
  // grey secondary text. Presentation-only — the backend snapshot stays
  // port-sorted; regular tiles keep their port-ascending order (260715-vfcz).
  const orderedServices = useMemo(() => {
    const regular = hostServices.filter((s) => !isWellKnownPort(s.port));
    const wellKnown = hostServices.filter((s) => isWellKnownPort(s.port));
    const byPort = (a: (typeof hostServices)[number], b: (typeof hostServices)[number]) =>
      a.port - b.port;
    return regular.sort(byPort).concat(wellKnown.sort(byPort));
  }, [hostServices]);
  // No TopBar slot registration (260724-6j1v): the connection dot — the only
  // page input the Host page ever published — moved to the sidebar footer, and
  // the Host page has no sidebar. RootTopBar's tolerant-empty defaults cover
  // every other host-mode prop, so the route deliberately loses its connection
  // indicator (intake assumption: no host-route special case).
  // Cross-server pane boards for the BOARDS zone. useBoards is self-contained
  // (plain /api/boards fetch + the shared SSE pool) and boards aggregate
  // windows across servers, so the box-level Host is their natural home.
  const { boards, isLoading: boardsLoading } = useBoards();
  const ghostNameRef = useRef<string | null>(null);
  // Guards against a double-click firing two create flows for the same port.
  const openingRef = useRef(false);
  // Drag-reorder for the TMUX SERVERS tile grid (shared with the sidebar
  // ServerPanel via the same hook). `servers` is already effective-sorted.
  const { orderedServers, getTileProps, isDragging, draggingName } = useServerReorder(servers, addToast);
  // Drag-reorder for the BOARDS zone tile grid (shared with the sidebar
  // BoardsSection via the same hook). `boards` is the backend-sorted list.
  const {
    orderedBoards,
    getTileProps: getBoardTileProps,
    isDragging: isBoardDragging,
    draggingName: draggingBoardName,
  } = useBoardListReorder(boards, addToast);

  // Reconcile ghost tiles against SessionContext's list: drop any ghost whose
  // real server has appeared. Computed at render time (no effect/local fetch).
  const realNames = new Set(servers.map((s) => s.name));
  const visibleGhosts = ghostServers.filter((g) => !realNames.has(g));

  const { execute: executeCreateServer } = useOptimisticAction<[string]>({
    action: (name) => createServer(name),
    onOptimistic: (name) => {
      ghostNameRef.current = name;
      setGhostServers((prev) => [...prev, name]);
    },
    onRollback: () => {
      if (ghostNameRef.current) {
        const ghostName = ghostNameRef.current;
        setGhostServers((prev) => prev.filter((g) => g !== ghostName));
        ghostNameRef.current = null;
      }
    },
    // No `onError` toast here (unlike AppShell.handleCreateServer, whose hook
    // stays mounted): this page unmounts on navigate, so the mount-guarded
    // `onError` would be skipped on the common post-navigate failure path AND
    // would double-toast on the rare still-mounted failure. The failure toast
    // lives solely in the unmount-safe `onAlwaysRollback` below.
    onSettled: () => {
      ghostNameRef.current = null;
    },
    // Refresh SessionContext's server list once the create resolves so the new
    // server appears and the route guard swaps the waiting state → the view.
    // `onAlwaysSettled` runs even though the create dialog has unmounted on
    // navigation — it only touches root-level SessionContext, which stays
    // mounted. Mirrors AppShell.handleCreateServer.
    onAlwaysSettled: () => {
      refreshServers();
    },
    // A failed create must not strand the UI on the waiting state — clear the
    // pending marker (empty string clears to null) on the rollback path (also
    // unmount-safe, root-context only). Mirrors AppShell.handleCreateServer.
    // Also surface the failure here: `handleCreate` navigates away from `/`
    // synchronously, so this page unmounts before the create resolves and the
    // mount-guarded `onError` toast is skipped — the user would otherwise land
    // on "Server not found" with no explanation. `addToast` reaches the
    // root-level ToastProvider, which stays mounted across the navigation.
    onAlwaysRollback: () => {
      markServerPending("");
      addToast("Failed to create server");
    },
  });

  const handleCreate = useCallback(() => {
    // The input applies the live server transform; commit trims the trailing
    // separator. The regex stays as defense in depth (always passes post-
    // transform).
    const trimmed = finalizeSafeName(createName.trim());
    if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return;
    executeCreateServer(trimmed);
    // Mark the just-created server pending BEFORE navigating so the route guard
    // shows the "Creating server…" waiting state (not "Server not found") until
    // the refreshed list includes it. Cleared automatically by SessionContext
    // once it appears. Mirrors AppShell.handleCreateServer.
    markServerPending(trimmed);
    navigate({
      to: "/$server",
      params: { server: trimmed },
    });
    setShowCreateDialog(false);
    setCreateName("");
  }, [createName, navigate, executeCreateServer, markServerPending]);

  // "Open in tab" — open a listening service's UI in an iframe tmux window
  // (the `createWindow` web arm) via the existing /proxy/{port}/ reverse
  // proxy. `/` is server-less, so
  // resolve a target (server, session): the first-listed server, reusing its
  // first known session or creating an instant one, then create the iframe
  // window there and navigate to the server (the window surfaces via SSE).
  // Disabled when no servers exist (see the tile's disabled state).
  const handleOpenInWindow = useCallback(
    async (port: number) => {
      if (openingRef.current) return;
      const target = servers[0];
      if (!target) return; // action is disabled in this state; defensive guard
      openingRef.current = true;
      try {
        const server = target.name;
        // Prefer the SSE-cached sessions, but on a fresh `/` load the per-server
        // stream is usually not attached yet, so `sessionsByServer` can be empty
        // even when the server HAS sessions. Fall back to an authoritative fetch
        // before creating anything — otherwise we'd try to create a "services"
        // session that may already exist, and tmux new-session 500s on a
        // duplicate name.
        let session = (sessionsByServer.get(server) ?? [])[0]?.name;
        if (!session) {
          const fetched = await getSessions(server).catch(() => []);
          session = fetched[0]?.name;
        }
        if (!session) {
          // The server genuinely has no session — create an instant one to host
          // the iframe window (reuses the createSession machinery the app uses).
          session = "services";
          await createSession(server, session);
        }
        await createWindow(
          server,
          session,
          // Window name, NOT a display label: tmux rejects colons and periods
          // (validate.ValidateName), so `:${port}` fails — use `port-${port}`.
          `port-${port}`,
          undefined,
          `/proxy/${port}/`,
        );
        navigate({ to: "/$server", params: { server } });
      } catch (err) {
        addToast(
          err instanceof Error ? err.message : "Failed to open service in tab",
        );
      } finally {
        openingRef.current = false;
      }
    },
    [servers, sessionsByServer, navigate, addToast],
  );

  return (
    <div className="flex flex-col h-full bg-bg-chrome">
      {/* The host-mode TopBar mount moved to the persistent root layout
          (260707-4vq2). Its route-derived mode is `host` (brand root crumb +
          the solo `Host` center heading + route-agnostic controls; no
          hamburger). The page publishes nothing into the TopBar slot
          (260724-6j1v — the connection dot it used to feed moved to the
          sidebar footer, and `/` has no sidebar). `h-full` (was `h-screen`)
          because the root layout now owns the viewport height; the list below
          still scrolls within `flex-1`. */}

      {/* Server list. `pt-6` matches the `mb-6` inter-section rhythm so the
          gap below the TopBar equals the gap between sections. The Host's
          page identity now lives in the top-bar center heading (260704-pr0p);
          the old in-page `[ host ]` PageHeading row was removed. */}
      <div className="flex-1 min-h-0 overflow-y-auto pt-6 px-4 sm:px-6 pb-6">
        {/* Page-level heading (260715-zs1y). Reuses the shared SectionHeading
            idiom (bracket + typed-sweep, reduced-motion-safe) so the page carries
            one canonical "Host Overview" long-form name above the zone headings. */}
        <SectionHeading label="Host Overview" className="mb-4" />
        {/* HOST HEALTH zone (Host host-console home). Renders host-global
            metrics from the server-independent `useHostMetrics()` stream, above
            the tmux-server tiles. `/` is the only surface that is about the BOX,
            not a session, so host health belongs here. */}
        <section aria-label="Host health" className="mb-6 max-w-md">
          {/* Bracket section heading (260704-pr0p): the PageHeading bracket
              idiom moved to the zone labels. The SectionHeading `side` slot is
              reserved for the tmux-Server stats relocation — on the host zones it
              stays empty (plan assumption #4). Each zone's existing inline
              metadata (here the live hostname) stays in the zone body at its
              original `text-xs` sizing, right below the heading. */}
          <SectionHeading label="Host Health" className="mb-2" />
          {/* HexoKit system card — the daemon read as a SYSTEM surface
              (version/uptime/port + Restart, service rows + View deep-links).
              Renders independently of the metrics stream: the daemon serving
              this page is up by definition. */}
          <SystemCard />
          {hostMetrics && (
            <div className="text-xs text-text-secondary font-mono truncate mb-2">
              {/* Display name (o7q8): the settings override wins over the
                  metrics-reported hostname — display-only, the accent hash
                  and SSH deeplinks keep the real hostname. */}
              {instanceName ?? hostMetrics.hostname}
            </div>
          )}
          {hostMetrics ? (
            <HostMetrics metrics={hostMetrics} />
          ) : (
            // Education copy (260811-ke2s): the zone's fill mechanism is the
            // daemon's host-metrics stream — there is no user action to name.
            <div className="text-xs text-text-secondary">No metrics — waiting for the host's first report</div>
          )}
        </section>

        {/* BOARDS zone — cross-server pane boards. A board aggregates windows
            across tmux servers, so the box-level Host (not any single
            tmux Server) is its list's natural home. Sits above TMUX SERVERS
            per the page's general→specific flow. Always visible: when zero
            boards exist the body shows the same "pin to start" hint as the
            sidebar BoardsSection, instead of the section appearing/vanishing
            with the first/last board. */}
        <section aria-label="Boards" className="mb-6">
          {/* Side slot stays empty on host zones (plan assumption #4); the
              board count stays in the zone body at its original text-xs sizing. */}
          <SectionHeading label="Boards" className="mb-2" />
          <div className="text-xs text-text-secondary font-mono mb-2">
            {boardsLoading
              ? "loading…"
              : `${boards.length} board${boards.length !== 1 ? "s" : ""}`}
          </div>
          {!boardsLoading && boards.length === 0 ? (
            <div className="text-xs text-text-secondary">
              {paletteChord
                ? `No boards yet — hover a sidebar tab row and click its 📌, or ${paletteChord} → Pin:`
                : "No boards yet — hover a sidebar tab row and click its 📌"}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {orderedBoards.map((b) => {
                const drag = getBoardTileProps(b.name);
                const isDragSource = isBoardDragging && draggingBoardName === b.name;
                return (
                  <button
                    key={b.name}
                    draggable={drag.draggable}
                    onDragStart={drag.onDragStart}
                    onDragOver={drag.onDragOver}
                    onDragEnd={drag.onDragEnd}
                    onDrop={drag.onDrop}
                    onClick={() =>
                      navigate({ to: "/board/$name", params: { name: b.name } })
                    }
                    className={`bg-bg-card border border-border rounded p-4 text-left hover:border-text-secondary transition-colors min-h-[60px]${isDragSource ? " opacity-50" : ""}`}
                  >
                    <div className="text-text-primary font-medium text-sm">
                      {b.name}
                    </div>
                    <div className="text-text-secondary text-xs mt-1">
                      {b.pinCount} pin{b.pinCount !== 1 ? "s" : ""}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* TMUX SERVERS zone (zone 2) — the tmux-server tile grid. */}
        <section aria-label="Tmux servers" className="mb-6">
          {/* Side slot stays empty on host zones (plan assumption #4); the
              server count stays in the zone body at its original text-xs sizing. */}
          <SectionHeading label="Tmux Servers" className="mb-2" />
          <div className="text-xs text-text-secondary font-mono mb-2">
            {!serversLoaded
              ? "loading…"
              : `${servers.length} server${servers.length !== 1 ? "s" : ""}`}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {orderedServers.map((info) => {
              const { name, sessionCount, ephemeral, protected: protected_ } = info;
              const drag = getTileProps(name);
              const isDragSource = isDragging && draggingName === name;
              // Protected-class marker: the rk-daemon server derives protected
              // client-side (the same ∨ the sidebar toggle computes); the glyph
              // is additive — dim-and-pin-last treatment unchanged.
              const isProtected = name === DAEMON_SERVER || protected_ === true;
              // External-class marker (managed === false): ↗ before the name +
              // the grey-name de-emphasis below. Absent field = no treatment.
              const isExternal = isExternalServer(info);
              return (
              <button
                key={name}
                draggable={drag.draggable}
                onDragStart={drag.onDragStart}
                onDragOver={drag.onDragOver}
                onDragEnd={drag.onDragEnd}
                onDrop={drag.onDrop}
                onClick={() => handleSwitchServer(name)}
                className={`relative bg-bg-card border border-border rounded p-4 text-left hover:border-text-secondary transition-colors min-h-[60px]${isDragSource ? " opacity-50" : ""}`}
              >
                {/* Attention rollup (260706-y1ar): per-server waiting count,
                    summed over this server's sessions. One glance at `/` answers
                    "does anything need me". Data comes from the streamed
                    `sessionsByServer` — only attached servers have windows
                    streamed, so an unattached server's count is 0 and the badge
                    (WaitingBadge renders null at 0) is simply absent until its
                    stream attaches; never a wrong count. */}
                <span className="absolute right-2 top-2">
                  <WaitingBadge count={countWaitingInSessions(sessionsByServer.get(name) ?? [])} />
                </span>
                {/* De-emphasize infra servers (daemon + test sockets),
                    @rk_srv_ephemeral-marked scratch servers, and external servers
                    alike: grey the name only; the tile stays fully
                    clickable/attachable. Marked servers also get a `scratch`
                    chip (the recovery tree's resumable-chip styling) —
                    surface, never hide. */}
                <div className={`${isInfraServer(name) || ephemeral || isExternal ? "text-text-secondary" : "text-text-primary"} font-medium text-sm`}>
                  {isProtected && (
                    <Tip label="Protected server — kill requires typing the name">
                      <span
                        role="img"
                        aria-label={`${name} is protected`}
                        className="inline-flex align-[-2px] mr-1"
                        data-testid={`shield-${name}`}
                      >
                        <ShieldGlyph />
                      </span>
                    </Tip>
                  )}
                  {isExternal && (
                    <span
                      role="img"
                      aria-label={`${name} is external`}
                      className="inline-flex align-[-2px] mr-1"
                      data-testid={`external-${name}`}
                    >
                      <ExternalGlyph />
                    </span>
                  )}
                  {name}
                  {ephemeral && (
                    <span className="ml-1.5 border border-border rounded px-1 text-text-secondary text-xs">
                      scratch
                    </span>
                  )}
                </div>
                <div className="text-text-secondary text-xs mt-1">
                  {sessionCount} sess
                </div>
              </button>
              );
            })}

            {/* Ghost server cards */}
            {visibleGhosts.map((name) => (
              <div
                key={`ghost-${name}`}
                className="bg-bg-card border border-border rounded p-4 text-left min-h-[60px] opacity-50 animate-pulse"
              >
                <div className="text-text-primary font-medium text-sm">
                  {name}
                </div>
              </div>
            ))}

            {/* New Server button */}
            <button
              onClick={() => setShowCreateDialog(true)}
              className="border border-dashed border-border rounded p-4 text-sm text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors min-h-[60px] flex items-center justify-center"
            >
              + New Server
            </button>
          </div>
        </section>

        {/* RECOVERY zone — reboot-orphaned servers with restorable snapshot
            offers. Slotted between TMUX SERVERS and SERVICES; renders ONLY
            when offers exist (zero footprint otherwise — no heading, no empty
            state). Offers load on mount + refetch after the section's own
            restore/dismiss mutations; no polling, no new SSE kind. */}
        <RecoverySection recovery={recovery} />

        {/* SERVICES zone (zone 3, Host host-console home). A listening TCP
            port is a HOST property (not owned by any tmux window/session), so
            `/` — the box-level console — is its home. The backend passively
            enumerates the host's listening ports (procfs on Linux, lsof on
            darwin) and broadcasts ALL of them with best-effort process
            attribution (see internal/ports) — there is NO HTTP probe: the probe
            broke one-shot local servers (OAuth callbacks) and was removed
            (260715-vfcz). So a tile is not guaranteed to speak HTTP; opening a
            non-HTTP port yields a failed iframe — that is user-initiated,
            visible, and harmless (the iframe load IS the on-demand probe).
            "Open in tab" is therefore gated solely on a tmux server existing.
            Each tile opens the port's UI in an iframe tmux window via
            the /proxy/{port}/ proxy. Well-known ports (< 1024) are de-emphasized
            (grey, sorted last) like infra servers. Placed last, after the
            tmux-server tiles. */}
        <section aria-label="Services" className="mb-6 max-w-md">
          <SectionHeading label="Services" className="mb-2" />
          {orderedServices.length === 0 ? (
            // Education copy (260811-ke2s): the zone's fill mechanism is the
            // backend's passive listening-port enumeration — no config source
            // exists to point at.
            <div className="text-xs text-text-secondary">No services — listening TCP ports appear here automatically</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {orderedServices.map((svc) => (
                <div
                  key={svc.port}
                  className="flex items-center justify-between gap-3 bg-bg-card border border-border rounded px-3 py-2"
                >
                  <div className="min-w-0">
                    <span
                      className={`font-mono text-sm ${
                        isWellKnownPort(svc.port)
                          ? "text-text-secondary"
                          : "text-text-primary"
                      }`}
                    >
                      :{svc.port}
                    </span>
                    {svc.process && (
                      <span className="text-text-secondary text-xs ml-2 truncate">
                        {svc.process}
                      </span>
                    )}
                  </div>
                  {/* Conditional tip: only the disabled state needs the "why"
                      (label undefined otherwise → child renders untouched). */}
                  <Tip label={servers.length === 0 ? "Create a server first" : undefined}>
                    <button
                      onClick={() => handleOpenInWindow(svc.port)}
                      disabled={servers.length === 0}
                      className="shrink-0 text-xs px-2 py-1 border border-border rounded text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-secondary disabled:hover:border-border"
                    >
                      Open in tab
                    </button>
                  </Tip>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Version stamp (260715-ifco): a small, passive BIOS/boot-style footer
            line at the bottom of the scroll container, after the zone hierarchy.
            On-brand with the CRT/terminal aesthetic — monospace, text-secondary,
            no border, no interaction, no hover treatment (passive means passive;
            the hover-animation vocabulary categories don't apply to inert text).
            Hidden entirely until the first `event: version` (never `vundefined`).
            The Host `/` is the only page without a top-bar version surface on
            phones, and its BIOS-footer aesthetic fits the running-version stamp
            better than any other surface. */}
        {daemonVersion && (
          <div className="mt-2 text-xs text-text-secondary font-mono">
            HexoKit {displayVersion(daemonVersion)}
          </div>
        )}
      </div>

      {/* Status bar (260814-ldbs R4): the full-width attached strip renders on
          EVERY desktop route — here with the host cluster only (no current
          window on `/`, no compose target). Gated on `!isMobile` — the SAME
          gate Shell applies — so ALL routes agree (rework cycle 1: a
          width-only gate would leak the bar onto a coarse desktop-width
          device, but `useIsMobile()` is width-OR-coarse, so an iPad renders
          the MOBILE experience app-wide — chip bar, drawer panels, NO status
          bar). */}
      {!isMobile && (
        <StatusBar window={null} server={null} isConnected={hostConnected} />
      )}

      {showCreateDialog && (
        <Dialog
          title="Create tmux server"
          onClose={() => {
            setShowCreateDialog(false);
            setCreateName("");
          }}
        >
          <input
            autoFocus
            type="text"
            value={createName}
            // Live safe-name conversion (server kind — strictest charset).
            onChange={(e) => setCreateName(toSafeServerName(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            onFocus={(e) => e.target.select()}
            aria-label="Server name"
            placeholder="Server name..."
            className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
          />
          <p className="text-xs text-text-secondary mt-1.5">
            Alphanumeric, hyphens, and underscores only.
          </p>
          <button
            onClick={handleCreate}
            disabled={
              !createName.trim() ||
              !/^[a-zA-Z0-9_-]+$/.test(createName.trim())
            }
            className={`mt-2.5 w-full ${controlClass({ variant: "wide", disabled: !createName.trim() || !/^[a-zA-Z0-9_-]+$/.test(createName.trim()) })}`}
          >
            Create
          </button>
        </Dialog>
      )}
    </div>
  );
}
