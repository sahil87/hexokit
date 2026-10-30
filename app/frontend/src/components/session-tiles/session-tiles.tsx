import { useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import { parseFabChange, formatDuration } from "@/lib/format";
import { StatusDot } from "@/components/status-dot";
import { prOwnsGlyph, prGlyphColor } from "@/components/pr-status-model";
import { prGlyphIcon } from "@/components/sidebar/icons";
import { NOTE_STALE_SECONDS } from "@/components/sidebar/row-flyout-card";
import { AnsiText } from "@/components/session-tiles/ansi-text";
import { SectionHeading } from "@/components/section-heading";
import { useSessionContext } from "@/contexts/session-context";
import type { ProjectSession } from "@/types";
import { isGhostWindow } from "@/contexts/optimistic-context";
import type { MergedSession } from "@/contexts/optimistic-context";

type SessionTilesProps = {
  server: string;
  sessions: (ProjectSession | MergedSession)[];
  onNavigate: (windowId: string) => void;
  onCreateSession: () => void;
  onCreateWindow: (session: string) => void;
  /** Optional content rendered after the grid, inside the SAME scrolling tile
   *  area — the one-scroll-container rule for page zones below the Sessions
   *  grid (the WATCHED zone's mount seam). */
  footer?: ReactNode;
};

/**
 * The multi-agent monitoring-DENSITY view rendered by the `/$server` index
 * route (`serverIndexRoute`). Session tiles expand into per-window tiles, each
 * showing a periodic TEXT SNAPSHOT of the pane (via `tmux capture-pane`,
 * delivered over the existing SSE hub as `event: preview`) — NOT a live xterm
 * relay per tile (that would re-trigger the documented HTTP/1.1 6-per-origin
 * connection-pool starvation). A tile upgrades to a real live terminal only on
 * click, which navigates to the existing `/$server/$window` route.
 *
 * Preview capture is bounded to expanded sessions: whenever the expanded set
 * changes, the view declares it via `setPreviewScope`, and the backend captures
 * panes only for windows in those sessions.
 */
export function SessionTiles({
  server,
  sessions,
  onNavigate,
  onCreateSession,
  onCreateWindow,
  footer,
}: SessionTilesProps) {
  const { previewsByServer, setPreviewScope } = useSessionContext();
  const previews = previewsByServer.get(server) ?? {};

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = useCallback((name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const totalWindows = useMemo(
    () => sessions.reduce((sum, s) => sum + s.windows.length, 0),
    [sessions],
  );

  // The set of currently-expanded session names, stable-stringified so the
  // scope-declaration effect only fires when the set actually changes.
  const expandedNames = useMemo(
    () =>
      sessions
        .map((s) => s.name)
        .filter((name) => expanded[name])
        .sort(),
    [sessions, expanded],
  );
  const expandedKey = expandedNames.join("\0");

  // Declare the expanded set to the backend so it captures previews only for
  // these sessions' windows. Re-declares on server change too (the connection
  // — and thus its server-side scope — is fresh). No client polling: the
  // previews arrive on the SSE stream.
  useEffect(() => {
    setPreviewScope(server, expandedNames);
    // expandedKey captures the set's content; expandedNames identity churns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, expandedKey, setPreviewScope]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* The tmux Server's page identity now lives in the top-bar center
          heading (`tmux Server: <server>`, 260704-pr0p) — the old in-page
          `[ tmux server · name ]` PageHeading row was removed. The stats it
          carried relocate to the `[ Sessions ]` section-heading line below,
          right-aligned after the rule. */}

      {/* Scrollable tile area */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pt-4 sm:pt-6 pb-4 sm:pb-6">
        {/* Page-level heading (260715-zs1y). Reuses the shared SectionHeading
            idiom so the tmux Server page carries one canonical long-form name
            above the "Sessions" section heading. */}
        <SectionHeading label="Workspace overview" className="mb-4" />
        {/* Bracket section heading (260704-pr0p): the PageHeading bracket idiom
            moved here; the relocated session/window stats are the right-aligned
            side slot. Same idiom as the Host page's zone headings. */}
        <SectionHeading
          label="Groups"
          side={`${sessions.length} group${sessions.length !== 1 ? "s" : ""}, ${totalWindows} tab${totalWindows !== 1 ? "s" : ""}`}
          className="mb-2"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sessions.map((session) => {
            const isExpanded = expanded[session.name] ?? false;
            const activeCount = session.windows.filter(
              (w) => w.activity === "active",
            ).length;
            const idleCount = session.windows.length - activeCount;
            const isGhostSession =
              "optimistic" in session && session.optimistic;

            return (
              <div
                key={session.name}
                className={`bg-bg-card border border-border rounded${isGhostSession ? " opacity-50 animate-pulse" : ""}`}
                data-testid={`session-tile-${session.name}`}
              >
                {/* Session tile header */}
                <button
                  onClick={() => toggleExpand(session.name)}
                  className="w-full text-left p-3 min-h-[36px] coarse:min-h-[44px] flex items-center justify-between"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${session.name}`}
                >
                  <div className="min-w-0">
                    <div className="text-text-primary font-medium text-sm truncate">
                      {session.name}
                    </div>
                    <div className="text-text-secondary text-xs mt-0.5">
                      {session.windows.length} window
                      {session.windows.length !== 1 ? "s" : ""}
                      {session.windows.length > 0 && (
                        <span className="ml-1.5">
                          &middot; {activeCount} active, {idleCount} idle
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className="text-xs text-text-secondary shrink-0 ml-2"
                    aria-hidden="true"
                  >
                    {isExpanded ? "▼" : "▶"}
                  </span>
                </button>

                {/* Window tiles */}
                {isExpanded && (
                  <div className="border-t border-border px-3 pb-3 pt-2 flex flex-col gap-2">
                    {session.windows.map((win) => {
                      const fabInfo = parseFabChange(win.fabChange ?? "");
                      const ghost = isGhostWindow(win);
                      const preview = ghost
                        ? undefined
                        : previews[win.windowId];

                      return (
                        <button
                          key={
                            ghost
                              ? `ghost-${win.optimisticId}`
                              : win.windowId
                          }
                          onClick={() => !ghost && onNavigate(win.windowId)}
                          disabled={ghost}
                          data-testid={
                            ghost
                              ? undefined
                              : `window-tile-${session.name}-${win.index}`
                          }
                          className={`w-full text-left rounded border border-border bg-bg-primary hover:border-text-secondary transition-colors p-2 min-h-[36px] coarse:min-h-[44px]${ghost ? " opacity-50 animate-pulse" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 min-w-0">
                              <StatusDot win={win} />
                              <span className="text-text-primary text-sm font-medium truncate">
                                {win.name}
                              </span>
                            </span>
                            <span className="flex items-center gap-1 shrink-0">
                              {win.fabStage && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">
                                  {win.fabStage}
                                </span>
                              )}
                              {/* Rest-state PR glyph (aqo6 → xuej) — the tile's
                                  only PR channel, mirroring the sidebar row's
                                  glyph (window-row.tsx): same prOwnsGlyph gate
                                  (closed earns the glyph too), same shared
                                  prGlyphColor vocabulary (red closed / red
                                  failing / gray draft / yellow checks-running /
                                  green open / purple merged), same state-picked
                                  icon via prGlyphIcon (✕ closed / dotted-rail
                                  draft / arc otherwise), same aria-hidden
                                  decoration semantics (the dot's aria-label +
                                  the register surfaces carry the info). Never
                                  on ghost windows. */}
                              {!ghost && prOwnsGlyph(win) && (
                                <span
                                  aria-hidden="true"
                                  data-testid="tile-pr-glyph"
                                  className={`flex items-center shrink-0 ${prGlyphColor(win)}`}
                                >
                                  {prGlyphIcon(win)}
                                </span>
                              )}
                            </span>
                          </div>

                          {/* Pane text preview — static monospace snapshot,
                              never a live xterm. Empty until the first
                              `event: preview` arrives for this expanded set.
                              Bottom-anchored (flex-col justify-end): when the
                              text is taller than the box, the OLDEST lines are
                              clipped off the top so the newest output — "what
                              is this agent doing right now" — stays visible.
                              Colors are rendered by AnsiText from the ANSI
                              escapes tmux `capture-pane -e` preserves. The inner
                              `whitespace-pre` block keeps colored runs flowing
                              inline (the outer flex would otherwise stack each
                              span on its own row) while the block sits at the
                              bottom. */}
                          {!ghost && win.note ? (
                            /* A written note answers "why is this tab here"
                               better than the capture, so it REPLACES the
                               preview as the tile body (degrade-to-absent: no
                               note → the preview renders exactly as before).
                               Same conventions as the flyout's NoteLine —
                               relative age via formatDuration, dimmed past
                               NOTE_STALE_SECONDS (never hidden), epoch-0
                               text-only. Compact body, no fixed h-40 box. */
                            (() => {
                              const epoch = win.noteEpoch ?? 0;
                              const ageSeconds =
                                epoch > 0
                                  ? Math.max(0, Math.floor(Date.now() / 1000) - epoch)
                                  : null;
                              const stale =
                                ageSeconds !== null && ageSeconds > NOTE_STALE_SECONDS;
                              return (
                                <div
                                  data-testid={`window-tile-note-${win.windowId}`}
                                  className={`mt-1.5 text-[10px] leading-tight font-mono text-text-secondary${stale ? " opacity-50" : ""}`}
                                >
                                  {win.note}
                                  {ageSeconds !== null && (
                                    <span className="text-text-secondary">{` · ${formatDuration(ageSeconds)} ago`}</span>
                                  )}
                                </div>
                              );
                            })()
                          ) : (
                            <div
                              data-testid={
                                ghost
                                  ? undefined
                                  : `window-tile-preview-${win.windowId}`
                              }
                              className="mt-1.5 h-40 overflow-hidden text-[10px] leading-tight text-text-secondary font-mono bg-bg-inset rounded px-1.5 py-1 flex flex-col justify-end"
                            >
                              <div className="whitespace-pre">
                                {preview ? <AnsiText text={preview} /> : ""}
                              </div>
                            </div>
                          )}

                          {fabInfo && (
                            <div className="text-xs text-text-secondary mt-1">
                              {fabInfo.id} &middot; {fabInfo.slug}
                            </div>
                          )}
                        </button>
                      );
                    })}

                    {/* New Window button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateWindow(session.name);
                      }}
                      className="text-sm text-text-secondary hover:text-text-primary transition-colors py-1.5 border border-dashed border-border rounded hover:border-text-secondary min-h-[36px] coarse:min-h-[44px] flex items-center justify-center"
                    >
                      + New Tab
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* New Session tile */}
          <button
            onClick={onCreateSession}
            className="border border-dashed border-border rounded p-3 text-sm text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors min-h-[36px] coarse:min-h-[44px] flex items-center justify-center"
          >
            + New group
          </button>
        </div>
        {/* Footer slot — page zones below the grid (the WATCHED zone),
            inside this same scroll container so only the tile area scrolls. */}
        {footer}
      </div>
    </div>
  );
}
