/**
 * Shared control className constants — the OUT-OF-MATRIX vocabulary that is
 * not part of the Control primitive's variant matrix (the button-shaped
 * recipes — menu rows, top-bar squares/segments, latch arms, wide/confirm
 * dialog buttons, kbd chips — live in `components/control.tsx` as the
 * primitive's private implementation). What remains here: the popover shell
 * and section label (container recipes), the menu-row content extras (the ✓
 * mark is call-site content; the keycap is education), the switch-track
 * family (color-only — track/knob geometry stays per-site), and the
 * text-input idioms (the border idiom is not a button recipe).
 *
 * Dependency-free (imports nothing from components) so every control surface
 * imports the SAME definitions without an import cycle.
 */

/** The trailing green ✓ that carries a menu row's checked state
 *  (`aria-hidden` at the call site; the row's label stays the accessible
 *  name). The row's class composition comes from the primitive's `menu-row`
 *  variant; this mark stays call-site content. */
export const MENU_ROW_CHECK_MARK = "ml-auto text-accent-green";

/**
 * The one popover shell — every floating menu container (overflow menu,
 * split/layout/open popovers, breadcrumb dropdown, F▴ menu) composes this and
 * adds only its own positioning, width, and height/viewport caps at the call
 * site.
 */
export const POPOVER_SHELL =
  "bg-bg-primary border border-border rounded-lg shadow-2xl py-1 z-50";
/** The one menu section-label recipe (aria-hidden decoration — menu semantics
 *  ride the rows). */
export const POPOVER_SECTION_LABEL_CASED =
  "px-2.5 pt-1.5 pb-0.5 text-[10px] tracking-wider text-text-secondary select-none";
export const POPOVER_SECTION_LABEL = `${POPOVER_SECTION_LABEL_CASED} uppercase`;
/* `_CASED` is the same label without the `uppercase` transform, for headers
   that carry case-sensitive names (the New menu's `IN <workspace> › <group>`). */

/**
 * The one switch-track recipe (scheme C: green = state) — every `role="switch"`
 * control (the server-card Protect row, the settings BoolToggle) composes these
 * around its OWN track/knob geometry, which stays per-site. The recipe carries
 * color only: ON is the translucent green track + solid green knob, OFF the
 * recessed-well ground (`bg-bg-inset` — the same "off/empty" surface the marker
 * wells and status rail use) + secondary-ink knob. No second spelling of the
 * track colors may appear at a call site.
 */
export const SWITCH_TRACK_ON = "bg-accent-green/30 border-accent-green";
export const SWITCH_TRACK_OFF = "bg-bg-inset border-border";
export const SWITCH_KNOB_ON = "bg-accent-green";
export const SWITCH_KNOB_OFF = "bg-text-secondary";

/** Trailing menu-row keycap — the right-aligned chord chip on menu rows whose
 *  action has a registry binding. Matches the palette rows' kbd visual weight
 *  (command-palette.tsx), `ml-auto`-pinned to the row's right edge;
 *  `aria-hidden` at the call sites keeps the chord out of the accessible name
 *  (the row's label is the name; the keycap is visual education). */
export const MENU_ROW_KBD_CLASS =
  "ml-auto text-xs text-text-secondary bg-bg-card px-1.5 py-0.5 rounded border border-border";

/** Dialog text-input coarse floor — 40px on coarse pointers, fine size
 *  unchanged (no fine axis: the input's own padding sets it). */
export const INPUT_COARSE = "coarse:min-h-[40px]"; // lockstep: --ctl-h-bar-coarse

/**
 * The ONE live-input focus treatment (scheme C: green = state — typing focus
 * is the keyboard analogue of the green family). Every text input composes
 * this around its own geometry/background; no other focus border color may
 * appear on an input. Inputs stay OUT of the global `:focus-visible` ring in
 * globals.css — the border is the input idiom, so the ring never stacks on
 * it.
 */
export const INPUT_FOCUS = "outline-none focus:border-accent-green";
