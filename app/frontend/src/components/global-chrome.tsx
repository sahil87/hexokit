/**
 * Shared app-global chrome definitions (260724-6j1v). The theme/help chrome
 * relocated to the top bar's overflow menu in 260812-d1at (Settings rides as a
 * right-cluster gear chip) — the URLs and the icon SVGs live here as SINGLE
 * definitions so the menu rows, the settings dialog, and the command palettes
 * (`app.tsx`, `board-page.tsx`) can never drift. The footer button's
 * click-to-cycle (`cycleTheme`) was retired with the relocation — the theme
 * selector is the only chrome theme-switch surface.
 */

/** Help — external docs/landing page. Opens in a new tab. Shared by the
 *  top-bar overflow menu's Help row (260812-d1at) and the command-palette
 *  "Help: Documentation" actions (app + board palettes). */
export const HELP_URL = "https://hexokit.com/docs/";

/** Notifications help page (rendered by GitHub). Opens in a new tab from the
 *  settings dialog's Notifications row — the canonical "it says sent but
 *  nothing shows" guide. */
export const NOTIFICATIONS_HELP_URL =
  "https://github.com/sahil87/hexokit/blob/main/docs/site/notifications.md";

/** Question-mark help glyph — the retired top-bar HelpLink's SVG. */
export function HelpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.75 6a2.25 2.25 0 1 1 3.2 2.04c-.62.29-.95.79-.95 1.35v.36"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="12.25" r="0.9" fill="currentColor" />
    </svg>
  );
}
