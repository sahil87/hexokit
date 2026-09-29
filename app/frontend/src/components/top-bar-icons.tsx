import type { ReactNode } from "react";
import { layoutRects, type LayoutNode } from "@/lib/surface-layout";

/**
 * Shared top-bar control glyphs (260801-3q1z) — one definition per mirrored
 * control, consumed by the surviving in-bar button forms AND their
 * chevron-menu / SplitControl-popover rows, so bar↔menu visual parity is
 * structural (the `OpenTargetIcon` precedent, `open-app-icons.tsx`).
 *
 * Conventions (the OpenTargetIcon shape): ~14px rendered size, `currentColor`
 * stroke/fill (rides the row hover treatments and rk-glint flips for free),
 * `aria-hidden="true"` decoration — the row's accessible name stays its text
 * label — `shrink-0`, and a kebab-case `data-icon` attribute as the test seam
 * (monochrome paths are indistinguishable to queries).
 *
 * Unlike `open-app-icons.tsx`'s fixed 24-viewBox/1.8-stroke `Glyph`, the
 * wrapper here is parameterized by viewBox/strokeWidth/join so each glyph
 * byte-preserves its original's SVG attributes — the refactor is
 * zero-visual-change to the bar (split/close/refresh: 24-viewBox strokeWidth 2;
 * fixed-width: 14-viewBox strokeWidth 1.5 round caps only; autofit: 14-viewBox
 * strokeWidth 1.5 round caps+joins).
 *
 * The one stateful toggle with an in-bar form (autofit) exposes a variant prop
 * so one definition serves both forms: the in-bar button passes live state
 * (`filled={autofit}`), while the menu row renders the DEFAULT — a static
 * identity variant (leading icon = identity; the row's trailing ✓ is the sole
 * state marker, the macOS menu pattern). Menu-only controls (fixed-width,
 * close-pane, terminal-font) ship the static identity form alone.
 */

function ControlGlyph({
  name,
  viewBox = "0 0 24 24",
  strokeWidth = 2,
  join = true,
  children,
}: {
  name: string;
  viewBox?: string;
  strokeWidth?: number;
  /** strokeLinejoin="round" — off for glyphs drawn with round caps only
   *  (FixedWidthGlyph's arrows). */
  join?: boolean;
  children: ReactNode;
}) {
  return (
    <svg
      width="14"
      height="14"
      viewBox={viewBox}
      data-icon={name}
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      {...(join ? { strokeLinejoin: "round" as const } : {})}
    >
      {children}
    </svg>
  );
}

/** Split vertical — lucide square-split-vertical (top/bottom brackets +
 *  horizontal divider), the 90°-rotated sibling of SplitHorizontalGlyph. */
export function SplitVerticalGlyph() {
  return (
    <ControlGlyph name="split-vertical">
      <path d="M5 8V5c0-1 1-2 2-2h10c1 0 2 1 2 2v3" />
      <path d="M19 16v3c0 1-1 2-2 2H7c-1 0-2-1-2-2v-3" />
      <line x1="4" x2="20" y1="12" y2="12" />
    </ControlGlyph>
  );
}

/** Split horizontal — lucide square-split-horizontal (side brackets +
 *  vertical divider). The SplitControl primary segment's glyph. */
export function SplitHorizontalGlyph() {
  return (
    <ControlGlyph name="split-horizontal">
      <path d="M8 19H5c-1 0-2-1-2-2V7c0-1 1-2 2-2h3" />
      <path d="M16 5h3c1 0 2 1 2 2v10c0 1-1 2-2 2h-3" />
      <line x1="12" x2="12" y1="4" y2="20" />
    </ControlGlyph>
  );
}

/** Close pane — the ✕ (two crossed lines), the close-pane menu row's glyph. */
export function ClosePaneGlyph() {
  return (
    <ControlGlyph name="close-pane">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </ControlGlyph>
  );
}

/** Close pane (boxed) — lucide square-x (rounded rect + inner cross), the
 *  tty-tile pane segment's Close Pane glyph (260813-w1lf). Deliberately NOT
 *  the bare-✕ ClosePaneGlyph: the box is the misclick-trap distinction from
 *  the tile-close ✕. */
export function ClosePaneBoxedGlyph() {
  return (
    <ControlGlyph name="close-pane-boxed">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </ControlGlyph>
  );
}

/** Find — lucide search (circle + handle), the tile-header find toggle
 *  (tty and web ⌕ vocabulary). */
export function FindGlyph() {
  return (
    <ControlGlyph name="find">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </ControlGlyph>
  );
}

/** Export — arrow-down-to-line ("pull the buffer down to a file"), the tty
 *  tile header's export-menu trigger. */
export function ExportGlyph() {
  return (
    <ControlGlyph name="export">
      <path d="M12 17V3" />
      <path d="m6 11 6 6 6-6" />
      <path d="M19 21H5" />
    </ControlGlyph>
  );
}

/** Zoom — lucide maximize corner brackets. One glyph serves zoom and unzoom;
 *  state is carried by the button's accent-green + aria-label, never the shape. */
export function ZoomGlyph() {
  return (
    <ControlGlyph name="zoom">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </ControlGlyph>
  );
}

/** Tile close — bare crossed lines. Deliberately NOT boxed: the boxed
 *  square-x is Close Pane's shape (`ClosePaneBoxedGlyph`), and the two
 *  destructive closes in one header never share a shape (the close-distinction
 *  contract). Distinct data-icon from the menu-row `ClosePaneGlyph` — the seam
 *  names the verb, not the drawing. */
export function TileCloseGlyph() {
  return (
    <ControlGlyph name="tile-close">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </ControlGlyph>
  );
}

/** Web back — lucide arrow-left, the web tile URL bar's Back button. */
export function WebBackGlyph() {
  return (
    <ControlGlyph name="web-back">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </ControlGlyph>
  );
}

/** Web forward — lucide arrow-right, the web tile URL bar's Forward button. */
export function WebForwardGlyph() {
  return (
    <ControlGlyph name="web-forward">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </ControlGlyph>
  );
}

/** Open external — lucide arrow-up-right ("leave the tile"), the web tile
 *  URL bar's Open in browser button. */
export function OpenExternalGlyph() {
  return (
    <ControlGlyph name="open-external">
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </ControlGlyph>
  );
}

/** Inspect — lucide code-xml ("<>/", the page's source), the web tile URL
 *  bar's Inspect page button. */
export function InspectGlyph() {
  return (
    <ControlGlyph name="inspect">
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </ControlGlyph>
  );
}

/** Refresh — lucide rotate-cw (circular arrow with a top-right arrowhead),
 *  the in-bar RefreshButton glyph. */
export function RefreshGlyph() {
  return (
    <ControlGlyph name="refresh">
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </ControlGlyph>
  );
}

/** Follow terminal (the code tile header's Follow terminal verb) — a terminal
 *  prompt whose baseline is a rightward arrow: the editor follows the
 *  terminal's folder. Placeholder drawing pending a design pass — one-file
 *  swap. */
export function FollowTerminalGlyph() {
  return (
    <ControlGlyph name="follow-terminal">
      <path d="m4 7 4 4-4 4" />
      <path d="M11 19h7" />
      <path d="m15 16 3 3-3 3" />
    </ControlGlyph>
  );
}

/** Send home — lucide undo-2 (the curving return arrow), a foreign tile's ↩
 *  verb: the borrowed surface returns to its home tab. */
export function SendHomeGlyph() {
  return (
    <ControlGlyph name="send-home">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </ControlGlyph>
  );
}

/** Pop out — a box with an arrow leaving its top-right corner ("the tile
 *  leaves the layout into its own window"), the tile header's Pop out verb.
 *  Distinct from OpenExternalGlyph's bare diagonal arrow: the box anchors the
 *  source tile. */
export function PopOutGlyph() {
  return (
    <ControlGlyph name="pop-out">
      <path d="M15 3h6v6" />
      <path d="m21 3-9 9" />
      <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
    </ControlGlyph>
  );
}

/** Fixed width — the inward/contract fixed-width arrows: the static identity
 *  form the menu row uses (state stays on the trailing ✓). The state-driven
 *  `expanded` outward variant went with the in-bar toggle (260814-6b0j). */
export function FixedWidthGlyph() {
  return (
    <ControlGlyph name="fixed-width" viewBox="0 0 14 14" strokeWidth={1.5} join={false}>
      {/* Arrows pointing inward — contract */}
      <line x1="1" y1="7" x2="5" y2="7" />
      <polyline points="5,5 5,7 5,9" />
      <line x1="9" y1="7" x2="13" y2="7" />
      <polyline points="9,5 9,7 9,9" />
    </ControlGlyph>
  );
}

/** Board autofit — the frame-with-columns ("panes fill the row"). `filled`
 *  renders the in-bar pressed (on) variant with filled panes; the default
 *  unfilled frame is the static identity form the menu row uses. */
export function AutofitGlyph({ filled = false }: { filled?: boolean }) {
  return (
    <ControlGlyph name="autofit" viewBox="0 0 14 14" strokeWidth={1.5}>
      {/* Outer frame = the board row */}
      <rect x="1" y="2.5" width="12" height="9" rx="1" />
      {/* Two internal dividers = panes sharing the row. When on, the panes are
          filled (they've stretched to fill); when off, just outlines. */}
      <line x1="5" y1="2.5" x2="5" y2="11.5" />
      <line x1="9" y1="2.5" x2="9" y2="11.5" />
      {filled && (
        <>
          <rect x="1.5" y="3" width="3" height="8" fill="currentColor" stroke="none" opacity="0.35" />
          <rect x="5.5" y="3" width="3" height="8" fill="currentColor" stroke="none" opacity="0.35" />
          <rect x="9.5" y="3" width="3" height="8" fill="currentColor" stroke="none" opacity="0.35" />
        </>
      )}
    </ControlGlyph>
  );
}

/** Terminal font — the "Aa" TEXT glyph ("Aa" reads as "text size"): an
 *  aria-hidden span in a fixed ~14px shrink-0 box, not an SVG. Font size
 *  inherits from the host (text-xs on the menu rows) so the glyph matches its
 *  surface. */
export function TerminalFontGlyph() {
  return (
    <span
      data-icon="terminal-font"
      aria-hidden="true"
      className="w-[14px] shrink-0 inline-flex items-center justify-center font-semibold leading-none"
    >
      Aa
    </span>
  );
}

/** Layout chip face (260812-ab5v R9) — the ▦ preset-grid pictogram: a rounded
 *  frame quartered into a 2×2 tile grid ("the center is a layout of tiles").
 *  14-viewBox/1.5-stroke, the AutofitGlyph register (a tile-frame sibling). */
export function LayoutGlyph() {
  return (
    <ControlGlyph name="layout" viewBox="0 0 14 14" strokeWidth={1.5}>
      <rect x="1" y="2.5" width="12" height="9" rx="1" />
      <line x1="7" y1="2.5" x2="7" y2="11.5" />
      <line x1="1" y1="7" x2="13" y2="7" />
    </ControlGlyph>
  );
}

/** Shield — lucide shield, the protected-server class marker. Rendered on the
 *  server-list surfaces (host TMUX SERVERS tiles, sidebar server group headers)
 *  where `name === DAEMON_SERVER || server.protected` — the visible cause for
 *  the guarded kill fork (typed-name confirm). The surrounding label carries
 *  the accessible name; the glyph stays aria-hidden decoration. */
export function ShieldGlyph() {
  return (
    <ControlGlyph name="shield">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </ControlGlyph>
  );
}

/** External — lucide arrow-up-right, the external-server class marker
 *  (`managed === false`: the socket was not started by run-kit). Shares the
 *  shield's leading-glyph slot on the server-list surfaces (strip tile, tree
 *  header, host tile); when both classes apply the shield renders first. Same
 *  drawing as the web URL bar's OpenExternalGlyph but a distinct data-icon —
 *  the seam names the class, not the drawing (the close-glyph precedent). */
export function ExternalGlyph() {
  return (
    <ControlGlyph name="external">
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </ControlGlyph>
  );
}

/**
 * Mini tree glyph (the ▦ chip popover's rows and the overflow menu's
 * `Layout: …` rows): the layout tree drawn as a tiny rect diagram — one
 * bordered rect per leaf, positioned from `layoutRects` at the template's own
 * default sizes (absent override ⇒ the tree's carried sizes, then equal
 * shares), so the `main-*` templates keep their off-center main split. One
 * renderer serves every template, plus the chip's single/custom current-state
 * row (the live tree drawn as-is). `name` keys the kebab-case `data-icon`
 * test seam (`layout-row`, `layout-main-left`, …).
 */
const TREE_GLYPH_BOX = { x: 0, y: 0, w: 14, h: 14 };
const TREE_GLYPH_GAP_PX = 1;

export function LayoutTreeGlyph({ name, tree }: { name: string; tree: LayoutNode }) {
  const rects = [...layoutRects(tree, TREE_GLYPH_BOX, undefined, TREE_GLYPH_GAP_PX).values()];
  return (
    <span
      data-icon={`layout-${name}`}
      aria-hidden="true"
      className="relative inline-block w-[14px] h-[14px] shrink-0"
    >
      {rects.map((r) => (
        <span
          key={`${r.x}:${r.y}`}
          className="absolute rounded-[1px] border border-current"
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        />
      ))}
    </span>
  );
}

/** Paste clipboard (gui header fold) — the lucide clipboard. */
export function PasteGlyph() {
  return (
    <ControlGlyph name="paste">
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </ControlGlyph>
  );
}

/** Send key… (gui header fold) — the lucide keyboard. */
export function SendKeyGlyph() {
  return (
    <ControlGlyph name="send-key">
      {/* The ⌥ option symbol the pill carried here — a modifier chord, not a
          keyboard. A keyboard silhouette is indistinguishable from
          KeyboardGlyph (capture) at the rendered 14px. */}
      <path d="M4 17 12 7h8" />
      <path d="M4 7h4" />
    </ControlGlyph>
  );
}

/** Open terminal (gui header fold) — the lucide terminal (`>_`). */
export function TerminalGlyph() {
  return (
    <ControlGlyph name="terminal">
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </ControlGlyph>
  );
}

/** Open browser (gui header fold) — the lucide globe. */
export function BrowserGlyph() {
  return (
    <ControlGlyph name="browser">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </ControlGlyph>
  );
}

/** Toggle stats (gui header fold) — the lucide activity waveform. */
export function StatsGlyph() {
  return (
    <ControlGlyph name="stats">
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </ControlGlyph>
  );
}

/** Reconnect (gui header fold) — the lucide rotate-cw. */
export function ReconnectGlyph() {
  return (
    <ControlGlyph name="reconnect">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </ControlGlyph>
  );
}

/** More controls (the gui fold's ⚙ pinned block) — the lucide settings gear. */
export function GearGlyph() {
  return (
    <ControlGlyph name="gear">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </ControlGlyph>
  );
}

/** Fullscreen (the gui header's ⤢ rail verb) — diagonal outward arrows
 *  (lucide maximize-2), distinct from the tile-expand ZoomGlyph's corner
 *  brackets. */
export function FullscreenGlyph() {
  return (
    <ControlGlyph name="fullscreen">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
    </ControlGlyph>
  );
}

/** Keyboard (the gui header's capture verb) — a rounded case with two dot
 *  key rows and a dot · spacebar · dot bottom row symmetric about x=12, all
 *  three rows on one grid (the dots sit under the outer keys of the first
 *  row). */
export function KeyboardGlyph() {
  return (
    <ControlGlyph name="keyboard">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
      <path d="M6 16h.01" />
      <path d="M9 16h6" />
      <path d="M18 16h.01" />
    </ControlGlyph>
  );
}
