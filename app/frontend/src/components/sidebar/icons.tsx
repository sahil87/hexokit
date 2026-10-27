/** Shared sidebar icons. */
import type { WindowInfo } from "@/types";

/** Icon column treatment shared by the sidebar info panels (Pane, Host):
 *  brighter token, bold weight, +2px size. leading-none keeps the taller
 *  glyph inside the row's 16px line box (no row-height change). */
export const ICON_CLASS = "text-accent-bright font-bold text-[14px] leading-none";

/** Small palette icon for color-picker triggers — an artist's palette
 *  silhouette with four paint blobs. Line-art to match the sidebar's other
 *  line icons (e.g. the window-row pin); replaces the former U+25A0 glyph,
 *  which read as a media "stop" button rather than a color control. Blobs are
 *  pure fills (stroke="none") so they read as dots, not stroked rings.
 *
 *  Shared by the window-row, session-row, and server-panel color triggers so
 *  the affordance is identical everywhere. `size` defaults to 13px (sidebar
 *  rows); the compact server tile passes a smaller size.
 *
 *  strokeWidth is 2 (not the lucide-default 1.7) so the *effective* stroke
 *  weight matches the window-row pin: 2 ÷ 24-viewBox × 13px ≈ 1.08px vs the
 *  pin's 1.5 ÷ 16 × 12 ≈ 1.125px. A thinner stroke reads as a lighter color
 *  even with the same `currentColor` token, so weight parity is what makes the
 *  icons look like the same color in a cluster. */
export function PaletteIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="13.5" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="10.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="12.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.96 6.01 17.46 2 12 2z" />
    </svg>
  );
}

/** Operator identity glyph shared by window-name surfaces. */
export function HeadsetIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="operator-headset-icon"
    >
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="13" width="4.5" height="6" rx="1.8" />
      <rect x="16.5" y="13" width="4.5" height="6" rx="1.8" />
      <path d="M21 19v.5a3 3 0 0 1-3 3h-4" />
    </svg>
  );
}

/** Small gear icon for the settings trigger (the top-bar right-cluster chip
 *  since 260812-d1at, the sidebar footer before) — a lucide
 *  `settings` silhouette (cog outline + hub dot). Line-art matching the
 *  sibling icons' idiom (`currentColor` stroke, `strokeWidth={2}`,
 *  `aria-hidden`, 24-unit viewBox, 13px default size). (o7q8) */
export function GearIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Small keyboard icon for the shortcuts trigger (the top-bar overflow menu's
 *  Keyboard shortcuts row since 260812-d1at, the sidebar footer before) — a
 *  lucide
 *  `keyboard` silhouette (rounded rect + key dots + space bar). Line-art
 *  matching the sibling `GearIcon` idiom (`currentColor` stroke,
 *  `strokeWidth={2}`, `aria-hidden`, 24-unit viewBox, 13px default size).
 *  (260801-sm6g) */
export function KeyboardIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* body */}
      <rect x="2" y="5" width="20" height="14" rx="2" />
      {/* key dots (two rows) */}
      <path d="M6 9h.01" />
      <path d="M10 9h.01" />
      <path d="M14 9h.01" />
      <path d="M18 9h.01" />
      <path d="M6 12.5h.01" />
      <path d="M10 12.5h.01" />
      <path d="M14 12.5h.01" />
      <path d="M18 12.5h.01" />
      {/* space bar */}
      <path d="M8 16h8" />
    </svg>
  );
}

/** Small robot-head icon for the session-row spawn-agent trigger — a lucide
 *  `bot` silhouette (antenna + rounded head with two eye dots and a side port).
 *  Line-art matching the sibling `PaletteIcon` idiom (`currentColor` stroke,
 *  `strokeWidth={2}`, `aria-hidden`, same 24-unit viewBox + 13px default size)
 *  so it reads as the same weight/color inside the row's hover-revealed icon
 *  cluster. Sits immediately left of the `+` create-window button. */
export function BotIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      // viewBox y-shifted +1.5: the antenna is top weight, so the HEAD (the
      // perceived body, spanning y=8..20, center 14) sat optically below the
      // palette circle's center (~12). Shifting the view down moves the drawing
      // up ~0.8px at 13px without changing the rendered box (260724-2bmy).
      viewBox="0 1.5 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* antenna */}
      <path d="M12 8V4" />
      <circle cx="12" cy="3" r="1" fill="currentColor" stroke="none" />
      {/* head */}
      <rect x="4" y="8" width="16" height="12" rx="2" />
      {/* side ports */}
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      {/* eyes */}
      <circle cx="9" cy="13.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Small plus icon for the session-row create-window trigger — a lucide `plus`
 *  cross. Replaces the former `+` text glyph so the row's icon cluster shares
 *  ONE stroke system (equal ink width/weight is what makes the icons read as
 *  equidistant — mixed text glyphs beside stroke SVGs looked uneven even at
 *  even center gaps). Same idiom as the siblings: `currentColor` stroke,
 *  `strokeWidth={2}`, `aria-hidden`, 24-unit viewBox, 13px default size.
 *  (260724-2bmy) */
export function PlusIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

/** Small plug icon for the session row's attached-viewer chip — a lucide
 *  `plug` silhouette (two prongs into a rounded body, cord below): the literal
 *  tmux semantics of a viewer, an ATTACHED client. Line-art in the file's
 *  fixed idiom (`currentColor` stroke, `strokeWidth={2}`, `fill="none"`, round
 *  caps/joins, 24-unit viewBox, 13px default). Non-action member —
 *  aria-hidden decoration inside a non-interactive span (the chip's accessible
 *  name lives on the span's aria-label). */
export function PlugIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

/** Small git-pull-request icon for the window row's REST-STATE PR glyph — a
 *  lucide `git-pull-request` silhouette (source-branch circle + its rail, an
 *  arc into the merge rail, target circle). Line-art matching the sibling
 *  icons' fixed idiom (`currentColor` stroke, `strokeWidth={2}`, `fill="none"`,
 *  round caps/joins, 24-unit viewBox, 13px default size) so it reads at the
 *  same ink weight inside the row's trailing cluster — NOT the Nerd Font
 *  U+F407 glyph the PANE panel's L3 register uses (one icon system per the
 *  Sidebar Row Icon System, 260724-2bmy). Informational decoration only: the
 *  glyph is aria-hidden and never a focusable control. (93dy) */
export function GitPullRequestIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* source branch: circle + vertical rail */}
      <circle cx="6" cy="6" r="3" />
      <path d="M6 9v12" />
      {/* arc from the source into the merge rail, ending in the target circle */}
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <circle cx="18" cy="18" r="3" />
    </svg>
  );
}

/** Closed-PR variant of the window row's rest-state PR glyph — a lucide
 *  `git-pull-request-closed` silhouette: the same source circle + rail, but
 *  an ✕ where the merge arc was, a truncated target rail, and the target
 *  circle. GitHub disambiguates closed by SHAPE, not color — red ✕ icon =
 *  closed, red normal icon = failing — so this icon is what lets closed and
 *  failing share the red token. Same fixed idiom as the siblings (`currentColor` stroke,
 *  `strokeWidth={2}`, `fill="none"`, round caps/joins, 24-unit viewBox, 13px
 *  default size). (xuej) */
export function GitPullRequestClosedIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* source branch: circle + vertical rail */}
      <circle cx="6" cy="6" r="3" />
      <path d="M6 9v12" />
      {/* ✕ where the merge arc was — the "closed" mark */}
      <path d="m21 3-6 6" />
      <path d="m21 9-6-6" />
      {/* truncated target rail + target circle */}
      <path d="M18 11.5V15" />
      <circle cx="18" cy="18" r="3" />
    </svg>
  );
}

/** Draft-PR variant of the rest-state PR glyph — a lucide
 *  `git-pull-request-draft` silhouette: the same source circle + rail, but a
 *  DOTTED merge rail (two short dashes) where the arc sits, and the target
 *  circle. Draft is the only gray glyph state, and gray-arc vs green-arc was a
 *  color-only distinction — the shape is what makes a draft readable next to an
 *  open PR (and next to the closed ✕) without relying on hue. Same fixed idiom
 *  as the siblings. */
export function GitPullRequestDraftIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* source branch: circle + vertical rail */}
      <circle cx="6" cy="6" r="3" />
      <path d="M6 9v12" />
      {/* dotted merge rail — the "draft" mark, where the arc would be */}
      <path d="M18 6V5" />
      <path d="M18 11v-1" />
      <circle cx="18" cy="18" r="3" />
    </svg>
  );
}

/** State → icon for the rest-state PR glyph, shared by the sidebar window row
 *  (fine-pointer overlay + coarse rail slot) and the session-tile header so the
 *  three sites cannot drift. Closed is checked FIRST so a closed draft reads
 *  closed — the same open-gate `prGlyphColor` applies to its draft branch.
 *  Callers gate on `prOwnsGlyph` before reaching here. */
export function prGlyphIcon(win: WindowInfo) {
  if (win.prState === "closed") return <GitPullRequestClosedIcon />;
  if (win.prState === "open" && win.prIsDraft) return <GitPullRequestDraftIcon />;
  return <GitPullRequestIcon />;
}

/** Boards-section toggle glyph for the section rail — a lucide `layout-grid`
 *  silhouette (four rounded cells). Same fixed idiom as the sibling icons. */
export function BoardsSectionIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/** Server-section toggle glyph for the section rail — a lucide `server`
 *  silhouette (two stacked rack units with status dots). Same fixed idiom. */
export function ServerSectionIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <path d="M6 6h.01" />
      <path d="M6 18h.01" />
    </svg>
  );
}

/** Pane-section toggle glyph for the section rail — a lucide `panel-bottom`
 *  silhouette (a frame with a bottom dock). Same fixed idiom. */
export function PaneSectionIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 15h18" />
    </svg>
  );
}

/** Host-section toggle glyph for the section rail — a lucide `activity`
 *  silhouette (a metrics pulse line). Same fixed idiom. */
export function HostSectionIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

/** Small close/kill icon for the session- and window-row kill triggers — a
 *  lucide `x` cross. Replaces the former U+2715 text glyph for the same
 *  one-stroke-system reason as `PlusIcon`. (260724-2bmy) */
export function CloseIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** Small compose icon for the pinned operator row's compose trigger (260822-wyn3)
 *  — a lucide `pencil-line` silhouette (diagonal pen over a baseline). Line-art
 *  matching the sibling stroke-SVG idiom (`currentColor` stroke,
 *  `strokeWidth={2}`, `aria-hidden`, 24-unit viewBox, 13px default size). */
export function ComposeIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** Small pencil-with-baseline glyph for the session card's Update annotations
 *  row — the same silhouette family as ComposeIcon (a note-writing verb).
 *  Line-art matching the sibling stroke-SVG idiom (`currentColor` stroke,
 *  `strokeWidth={2}`, `aria-hidden`, 24-unit viewBox, 13px default size). */
export function NotePencilIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="M12 20h9" />
    </svg>
  );
}

/** Open in new window — a box with an arrow leaving its top-right corner (the
 *  tile header's Pop out glyph, at the sidebar's 13px / 24-viewBox weight). */
export function PopOutIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h6v6" />
      <path d="m21 3-9 9" />
      <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

/** Bring back — the curving return arrow (the tile header's send-home glyph,
 *  at the sidebar's 13px / 24-viewBox weight). */
export function BringBackIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}
