/**
 * Help topics — the curated list of published documentation pages the
 * chevron menu's `Help topics` disclosure and the `Help: <topic>` palette
 * actions open, plus the one open path both entry points share.
 *
 * Pure data and DOM-event helpers only (no React import): the registry is the
 * single source for both surfaces, so a topic added here appears in the menu
 * and the palette together (Constitution V — every menu action has a palette
 * twin).
 *
 * Opening a topic rides a cancelable `window` CustomEvent rather than a
 * callback chain: the menu and the global palette mount at the root layout
 * with no access to the current window's layout, while the shell that owns
 * the layout (`AppShell`) only exists on a terminal route. The shell cancels
 * the event once it has opened the page in the window's web tile; when nobody
 * cancels (board / server / host routes, or a layout that cannot grow) the
 * dispatcher opens a browser tab instead.
 *
 * Every URL must be framable (no `X-Frame-Options`, no frame-ancestors CSP) —
 * hexokit.com is served by GitHub Pages and sends neither — because the in-tile
 * path renders it inside the web tile's iframe.
 */

export type HelpTopic = {
  /** Stable id — the palette action id is `help-topic-${id}`; the menu row key. */
  id: string;
  /** Row label. The palette label is `Help: ${label}`. */
  label: string;
  /** Absolute https URL, stored verbatim as the web-tab target. */
  url: string;
  /** Which toolkit tool the page belongs to; rendered as a trailing muted tag
   *  when not run-kit so the reader knows why the page leaves run-kit's docs. */
  tool: "run-kit" | "fab-kit";
};

/** Display order is registry order — no grouping at this list size. */
export const HELP_TOPICS: readonly HelpTopic[] = [
  { id: "status-dot", label: "Status dot legend", url: "https://hexokit.com/docs/status-dot/", tool: "run-kit" },
  { id: "cron-schedule-kinds", label: "Cron schedule kinds", url: "https://hexokit.com/docs/cron-schedule-kinds/", tool: "run-kit" },
  { id: "boards", label: "Boards", url: "https://hexokit.com/docs/boards/", tool: "run-kit" },
  { id: "notifications", label: "Notifications", url: "https://hexokit.com/docs/notifications/", tool: "run-kit" },
  { id: "gui", label: "GUI desktop", url: "https://hexokit.com/docs/gui/", tool: "run-kit" },
  { id: "merge-topologies", label: "Merge topologies", url: "https://hexokit.com/fab-kit/merge-topologies/", tool: "fab-kit" },
  { id: "fkf", label: "FKF", url: "https://hexokit.com/fab-kit/fkf/", tool: "fab-kit" },
];

const ACTION_ID_PREFIX = "help-topic-";
const PALETTE_LABEL_PREFIX = "Help: ";

/** Palette action id for a topic (`help-topic-<id>`). */
export function helpTopicActionId(topic: HelpTopic): string {
  return `${ACTION_ID_PREFIX}${topic.id}`;
}

/** Palette label for a topic (`Help: <label>` — the `Category: Action` convention). */
export function helpTopicPaletteLabel(topic: HelpTopic): string {
  return `${PALETTE_LABEL_PREFIX}${topic.label}`;
}

/** Window event name carrying a `HelpTopic` detail. Cancelable: a listener
 *  that opened the topic in-tile calls `preventDefault()` to suppress the
 *  browser-tab fallback. */
export const HELP_TOPIC_EVENT = "rk:help-topic";

/** Type guard for the event detail (tolerant of foreign CustomEvents). */
export function isHelpTopic(detail: unknown): detail is HelpTopic {
  if (typeof detail !== "object" || detail === null) return false;
  const d = detail as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.label === "string" &&
    typeof d.url === "string" &&
    (d.tool === "run-kit" || d.tool === "fab-kit")
  );
}

/**
 * Open a help topic: dispatch the cancelable event to whichever shell owns a
 * web tile; when no listener cancels it, open the page in a new browser tab
 * (the same `noopener,noreferrer` open the `Help: Documentation` entry uses —
 * external navigation must never unload the live dashboard).
 */
export function openHelpTopic(topic: HelpTopic): void {
  const handledInTile = !window.dispatchEvent(
    new CustomEvent<HelpTopic>(HELP_TOPIC_EVENT, { detail: topic, cancelable: true }),
  );
  if (handledInTile) return;
  window.open(topic.url, "_blank", "noopener,noreferrer");
}
