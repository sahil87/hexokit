import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useChromeState, useChromeDispatch } from "@/contexts/chrome-context";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useOccludes } from "@/hooks/use-occludes";
import { matchesCombo, shouldSuppressChord } from "@/lib/keybindings";
import { focusSidebarCurrentRow, restoreWindowFocus } from "@/lib/sidebar-events";
import { STAGE_PADDING_PX, STAGE_COLUMN_GAP_PX } from "@/lib/stage-geometry";

// Re-exported so the top bar's sidebar head (and its tests) can overlay
// exactly the stage region without duplicating the numbers; the definitions
// live in the DOM-free lib module so e2e specs can import them too.
export { STAGE_PADDING_PX, STAGE_COLUMN_GAP_PX };

/**
 * `Cmd+B` (macOS) / `Shift+Ctrl+B` (Linux/Windows) — the stateful sidebar
 * chord (260819-qwr7 R5). Desktop arms:
 *
 * - hidden → open the sidebar and focus the current window's row (once the
 *   sidebar mounts — the row focuser registers on mount);
 * - visible, focus outside the sidebar → focus the current row;
 * - visible, focus inside the sidebar → hide the sidebar, then return focus
 *   via the terminal route's registered restore path (board/host routes
 *   register none — blur suffices).
 *
 * Mobile keeps today's plain toggle — the stateful arms are desktop-only and
 * must not fight the drawer (its focus trap owns Escape there). The row
 * focus crosses the shell→sidebar boundary via the module registry in
 * `lib/sidebar-events.ts` (the `registerComposeStripFocuser` pattern) — no
 * DOM reach-around; the sidebar records nothing in focus memory (chrome, not
 * a per-window `FocusKind`).
 *
 * We register at Shell level so the chord works on every route that mounts a
 * `<Shell>` (AppShell + BoardPage).
 *
 * The chord comes from the keybinding registry (`sidebar-toggle`, default ⌘B
 * on mac — demoted via `macTier`, since ⌘B is page-interceptable in a mac
 * browser — and ⇧Ctrl+B elsewhere; per-device rebindable — 260730-g40a); the
 * input gating mirrors the central dispatcher's rule 4: the shared
 * `shouldSuppressChord` predicate, skipped when the binding carries
 * `ignoreInputs` (the registry default for `sidebar-toggle` — the chord
 * stays live while composing). Binding + live state held in refs so the
 * listener registers once per mount.
 *
 * The chord is inert when the Shell renders no sidebar children (the popout
 * posture): `setSidebarOpen` writes the shared `hexokit-sidebar-open`
 * preference, which a sidebar-less window must never flip.
 */
function useSidebarKeyboardToggle(
  sidebarRef: RefObject<HTMLElement | null>,
  hasSidebar: boolean,
) {
  const { byAction } = useKeybindings();
  const { sidebarOpen } = useChromeState();
  const { setSidebarOpen } = useChromeDispatch();
  const isMobile = useIsMobile();
  const bindingRef = useRef(byAction.get("sidebar-toggle"));
  bindingRef.current = byAction.get("sidebar-toggle");
  const stateRef = useRef({ sidebarOpen, isMobile, hasSidebar });
  stateRef.current = { sidebarOpen, isMobile, hasSidebar };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const binding = bindingRef.current;
      if (!binding?.enabled || !matchesCombo(e, binding)) return;
      if (!binding.ignoreInputs && shouldSuppressChord(e.target)) return;
      if (!stateRef.current.hasSidebar) return;

      e.preventDefault();
      const { sidebarOpen: open, isMobile: mobile } = stateRef.current;
      if (mobile) {
        setSidebarOpen(!open);
        return;
      }
      if (!open) {
        setSidebarOpen(true);
        // The row focuser registers on the sidebar's mount — defer past the
        // commit (the mobile drawer-open effect's rAF precedent).
        requestAnimationFrame(() => {
          focusSidebarCurrentRow();
        });
        return;
      }
      if (!sidebarRef.current?.contains(document.activeElement)) {
        focusSidebarCurrentRow();
        return;
      }
      setSidebarOpen(false);
      if (!restoreWindowFocus()) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarOpen, sidebarRef]);
}

/**
 * Shell — shared layout wrapper for `AppShell` and `BoardPage`.
 *
 * The TopBar is NO LONGER part of the Shell grid (260707-4vq2). It mounts once
 * in the persistent root layout (`RootTopBar` in `app.tsx`), full-width above
 * this Shell. Because the old grid already spanned the topbar full-width above
 * the sidebar, dropping the row here and painting the bar above Shell in the
 * root layout is a geometric no-op — the visual stack is preserved.
 *
 * The two-family chrome model: the FRAME family (top bar above Shell, status
 * bar below) is attached square chrome, never rounded, never inset. The CARD
 * family (every content surface) floats as rounded cards (`rounded-md` + the
 * shared dimmed `rk-card-border`) on one continuous `bg-bg-chrome` STAGE
 * ground with 6px padding/gap. The sidebar is neither: it is a FLAT column of
 * that ground (`bg-bg-chrome`, no border, no radius — the flush stage), so
 * sidebar and ground read as one chrome surface and only content tiles float.
 * The stage is Shell's UNIVERSAL desktop composition — every desktop route
 * that mounts `<Shell>` gets it (terminal, tmux Server, board).
 *
 * Topology (desktop, viewport ≥ 640px):
 *   ┌─────────────────────────────────────┐
 *   │  ┌──────────┐  ┌─────────────────┐  │
 *   │  │ sidebar  │  │     content     │  │  ← stage (chrome ground, 6px)
 *   │  │  (flat)  │  ├─────────────────┤  │
 *   │  └──────────┘  │ bottombar       │  │
 *   │                └─────────────────┘  │
 *   ├─────────────────────────────────────┤
 *   │         statusbar (full width)      │  ← attached frame, never inset
 *   └─────────────────────────────────────┘
 *
 * - Outer grid: one column, rows `1fr auto`, areas `"stage" / "statusbar"`.
 *   The statusbar row is a DIRECT outer-grid child so it stays full-width
 *   flush attached chrome (the `auto` row collapses to zero height with no
 *   `statusBarChildren`).
 * - The stage is a NESTED grid rather than padding/gap on the outer grid:
 *   grid padding/gap apply to every track, so an outer-grid inset would push
 *   the status bar off the viewport edges and open seams around it — breaking
 *   the attached-frame contract. Nesting scopes the `bg-bg-chrome p-[6px]`
 *   ground (+ 6px column-gap; the bottom seam is footer-owned, see the
 *   bottombar note) to exactly the region that floats cards. Stage areas:
 *   `"sidebar content" / "sidebar bottombar"`; rows `1fr auto`; columns
 *   `${sidebarWidth}px 1fr` when `sidebarVisible` (sidebarOpen, no zen, sidebar
 *   children present), else `0 1fr`, with a ~150ms
 *   ease-out transition on both `grid-template-columns` and `column-gap` (the
 *   column-gap collapses with the column so a hidden sidebar leaves no stray
 *   6px seam). The transition is suppressed while `sidebarResizing` — a drag
 *   writes a new width per pointermove, and a tween restarted on every write
 *   trails the pointer until it stops. Consumers' `gridArea: "content"`
 *   styles bind to the stage's template (areas bind to direct children).
 * - The sidebar is a CARD: it floats 6px from the viewport edges and 6px
 *   above the status bar (no more flush square T-junction). It still fully
 *   unmounts on collapse (`!isMobile && sidebarVisible && !!sidebarChildren`) —
 *   it holds no iframe state worth preserving.
 *
 * Topology (mobile, viewport < 640px):
 *   - Single-column grid (`content / bottombar`); the `sidebar` slot
 *     is removed from the grid. The statusbar row never exists here.
 *   - When `sidebarOpen === true`, the sidebar children render outside the
 *     grid as an absolute overlay with a backdrop. The overlay carries
 *     `role="dialog" aria-modal="true"` for assistive tech.
 *
 * The `sidebar`, `bottombar`, and `statusbar` placements are Shell-owned: on
 * desktop Shell renders the `<aside gridArea:"sidebar">` itself from
 * `sidebarChildren`, with an optional `sidebarResizeHandle` node placed over
 * the 6px gap at the card's right seam (AppShell's drag-resize handle; drag
 * state/handlers stay in AppShell). The bottom bar / compose strip arrive via
 * `bottomBarChildren` (Shell renders the `<footer gridArea:"bottombar">`
 * wrapper inside the stage's content column), and the status bar via
 * `statusBarChildren` (desktop only). Consumers therefore place ONLY the
 * `content` grid area via `style={{ gridArea: "content" }}` — never
 * `sidebar`/`bottombar`/`statusbar`.
 *
 * Height is `100%` — Shell fills the root layout's `flex-1` content region.
 * The `--app-height` var (iOS keyboard handling) is now maintained by
 * `useVisualViewport()` in `RootWrapper`, whose root layout div is the var's
 * consumer; Shell no longer calls the hook or reads the var directly.
 */
export function Shell({
  children,
  sidebarChildren,
  sidebarResizeHandle,
  sidebarResizing = false,
  bottomBarChildren,
  statusBarChildren,
  zenActive = false,
}: {
  children: ReactNode;
  sidebarChildren?: ReactNode;
  /**
   * Zen mode (260820-o8cr R3): the terminal route's transient render-time
   * sidebar hide. Composes `sidebarOpen && !zenActive` for the desktop stage
   * columns, the aside, and the resize handle — the persisted preference
   * (`hexokit-sidebar-open`) is NEVER written on a zen path, so exiting zen
   * restores exactly what the preference says. The column-gap collapses with
   * the column for free (the existing hidden-sidebar geometry), and the 150ms
   * ease-out transition animates the zen collapse like any sidebar toggle.
   */
  zenActive?: boolean;
  /**
   * Desktop-only drag affordance rendered over the 6px stage gap at the
   * sidebar card's right seam (AppShell passes its drag-resize handle;
   * BoardPage passes none). Shell places it in a zero-width grid item aligned
   * to the sidebar track's right edge with visible overflow, so the handle
   * straddles the gap without widening the layout or doubling the card's
   * border seam. The mobile overlay never renders it.
   */
  sidebarResizeHandle?: ReactNode;
  /**
   * True while the `sidebarResizeHandle` drag is in progress. Drops the
   * stage's column transition for the duration so each pointermove width
   * lands immediately; the toggle/zen animation resumes once the drag ends.
   */
  sidebarResizing?: boolean;
  /**
   * Bottom-bar row content: the compose strip + the BottomBar. Shell renders
   * the `<footer gridArea:"bottombar">` wrapper itself, inside the stage on
   * desktop (content column, second row — the footer carries its own
   * content-gated 6px top seam, `has-[>*]:mt-[6px]`) and in
   * the outer grid on mobile. BottomBar self-gates on pointer type (fine
   * pointers render nothing), so an empty footer collapses the `auto` row to
   * zero — no reserved height survives (the 260814-ink6/PR #598 property).
   */
  bottomBarChildren?: ReactNode;
  /**
   * Status-bar row content — the full-width attached frame strip at the shell
   * bottom. Desktop only: rendered as the `statusbar` area of the OUTER grid,
   * outside the stage, so it is never inset by the stage's padding/gap; never
   * rendered on mobile (the mobile template has no such row).
   */
  statusBarChildren?: ReactNode;
}) {
  const { sidebarOpen, sidebarWidth } = useChromeState();
  const { setSidebarOpen } = useChromeDispatch();
  const isMobile = useIsMobile();
  const drawerRef = useRef<HTMLElement>(null);
  const sidebarAsideRef = useRef<HTMLElement>(null);

  // Zen render-time override: the EFFECTIVE sidebar visibility for the desktop
  // stage. Never feeds back into `setSidebarOpen` — the chord and the ⌘B
  // keyboard toggle keep reading/writing the persisted preference untouched.
  // A Shell without sidebar children (the popout posture) reserves no sidebar
  // column at all, even when the persisted preference says open.
  const sidebarVisible = sidebarOpen && !zenActive && sidebarChildren != null;

  // ⌘B / ⇧Ctrl+B — the stateful sidebar chord (show+focus / focus / hide+
  // return). Input/textarea/contenteditable suppression rules live in the
  // hook; the containment check reads the Shell-owned desktop aside.
  useSidebarKeyboardToggle(sidebarAsideRef, sidebarChildren != null);

  // The mobile drawer is `aria-modal`: trap Tab focus within it and close on
  // Escape while it is mounted, honoring the `role="dialog" aria-modal="true"
  // contract. Active ONLY for the mobile overlay — the desktop sidebar lives in
  // the grid and is never a modal, so its Tab navigation is unchanged.
  const drawerActive = isMobile && sidebarOpen && !!sidebarChildren;
  useFocusTrap(drawerRef, drawerActive, () => setSidebarOpen(false));
  useOccludes("modal", drawerActive);

  // Desktop: outer rows `"stage" / "statusbar"` — the stage nested grid owns
  // the inset ground and the sidebar column (with its width-collapse
  // transition); the statusbar stays a direct outer-grid child so it is never
  // inset. Mobile: single column (`content / bottombar`), no stage, no
  // statusbar row — collapsed/open is purely a function of whether the overlay
  // renders, so that grid stays byte-identical.
  const gridStyle: React.CSSProperties = isMobile
    ? {
        height: "100%",
        display: "grid",
        gridTemplateColumns: "1fr",
        gridTemplateRows: "1fr auto",
        gridTemplateAreas: '"content" "bottombar"',
        position: "relative",
      }
    : {
        height: "100%",
        display: "grid",
        gridTemplateColumns: "1fr",
        gridTemplateRows: "1fr auto",
        gridTemplateAreas: '"stage" "statusbar"',
      };

  // The universal desktop stage: one continuous inset ground holding the
  // sidebar card, the consumer's content, and the bottombar footer. The
  // column-gap animates alongside the width so the collapsed sidebar leaves
  // no stray 6px seam (an explicit track keeps its gap even at zero width).
  // No row-gap: grid gaps charge between tracks even when a track is zero
  // height, so a stage row-gap would sink the content column 6px below the
  // row-spanning sidebar whenever the bottombar row is empty (the resting
  // desktop state). The bottombar footer owns its own content-gated top seam
  // instead.
  const stageStyle: React.CSSProperties = {
    gridArea: "stage",
    display: "grid",
    gridTemplateColumns: sidebarVisible ? `${sidebarWidth}px 1fr` : "0 1fr",
    gridTemplateRows: "1fr auto",
    gridTemplateAreas: '"sidebar content" "sidebar bottombar"',
    columnGap: sidebarVisible ? `${STAGE_COLUMN_GAP_PX}px` : "0",
    padding: `${STAGE_PADDING_PX}px`,
    minWidth: 0,
    minHeight: 0,
    transition: sidebarResizing
      ? "none"
      : "grid-template-columns 150ms ease-out, column-gap 150ms ease-out",
  };

  return (
    <div className="app-shell" style={gridStyle}>
      {isMobile ? (
        <>
          {children}
          {bottomBarChildren != null && (
            <footer style={{ gridArea: "bottombar" }}>{bottomBarChildren}</footer>
          )}
        </>
      ) : (
        <div style={stageStyle} className="bg-bg-chrome">
          {/* Desktop sidebar aside (Shell-owned — 260719-rwqf). Gated the same
              way the callers used to gate their own asides (`sidebarVisible` —
              `sidebarOpen` composed with the zen render-time override and the
              sidebar-children presence — plus a `sidebarChildren` narrowing
              check), so it fully unmounts on
              collapse — no zero-width rail. Flush stage: the aside paints
              `bg-bg-chrome` with no border or radius — it is one column of the
              chrome ground, not a floating card; only content tiles float. */}
          {sidebarVisible && sidebarChildren && (
            <aside
              ref={sidebarAsideRef}
              style={{ gridArea: "sidebar" }}
              aria-label="Sidebar"
              className="relative flex flex-row overflow-hidden bg-bg-chrome"
            >
              <div className="flex-1 min-w-0 overflow-hidden">{sidebarChildren}</div>
            </aside>
          )}

          {/* Sidebar drag-resize handle (AppShell only): a zero-width grid
              item pinned to the sidebar track's right edge with visible
              overflow, so the handle's hit zone straddles the 6px gap instead
              of consuming layout width or adding a seam of its own. */}
          {sidebarVisible && sidebarChildren && sidebarResizeHandle && (
            <div
              style={{ gridArea: "sidebar", justifySelf: "end" }}
              className="relative z-10 h-full w-0 overflow-visible"
            >
              {sidebarResizeHandle}
            </div>
          )}

          {children}

          {/* Bottom-bar row (Shell-owned placement): inside the stage's
              content column so the strip stays scoped to that column. The 6px
              seam above it is content-gated on the footer itself (`:has(>*)`)
              rather than a stage row-gap: an empty footer (fine pointers —
              BottomBar self-gates to null, compose strip off) contributes
              zero height AND zero seam, keeping the content column's bottom
              edge flush with the row-spanning sidebar card's. */}
          {bottomBarChildren != null && (
            <footer style={{ gridArea: "bottombar" }} className="has-[>*]:mt-[6px]">
              {bottomBarChildren}
            </footer>
          )}
        </div>
      )}

      {/* Status-bar row: full-width attached frame chrome, a DIRECT outer-grid
          child so the stage's padding/gap never insets it (the frame family
          is never rounded). Desktop only; the mobile template has no
          statusbar area, so the slot is ignored there. */}
      {!isMobile && statusBarChildren != null && (
        <div style={{ gridArea: "statusbar" }} className="min-w-0">
          {statusBarChildren}
        </div>
      )}

      {/* Mobile overlay: renders below the topbar so the hamburger stays
          visible as a close affordance (matches the project convention
          documented in `fab/project/context.md`: "Mobile sidebar drawer is
          `absolute` inside the main area (not `fixed inset-0`) so the top
          bar stays visible and the logo toggle can close the drawer.").
          Implementation: a grid child spanning both rows (content +
          bottombar, `gridRow: "1 / 3"`) hosts the absolutely-positioned
          backdrop and aside.
          Backdrop tap and explicit close both fire `setSidebarOpen(false)`.
          Destination-tap auto-close lives in the consumer (Sidebar callbacks
          already invoke `setSidebarOpen(false)` after navigation). */}
      {isMobile && sidebarOpen && sidebarChildren && (
        <div
          style={{ gridRow: "1 / 3", gridColumn: 1, position: "relative" }}
          className="z-40 pointer-events-none"
        >
          <div
            className="absolute inset-0 z-40 bg-black/50 pointer-events-auto"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 z-50 w-[92%] max-w-[340px] bg-bg-chrome border-r border-border overflow-y-auto shadow-2xl pointer-events-auto"
          >
            {sidebarChildren}
          </aside>
        </div>
      )}
    </div>
  );
}
