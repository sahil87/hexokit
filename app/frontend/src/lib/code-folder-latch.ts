/**
 * Code-surface folder helpers (spec docs/specs/right-panel.md § The code lens).
 *
 * The code surface's folder is SHARED tab state: it lives in the
 * `@rk_win_code_root` window option and arrives in the window payload as
 * `codeRoot`. `gitRoot` is re-derived per SSE tick from the ACTIVE pane's cwd
 * (the git toplevel, else the raw cwd itself when outside any repo),
 * so a pane switch or a `cd` would retarget the embedded editor and take its
 * in-flight state with it — open tabs, dirty buffers, undo stacks. (Retarget,
 * never unmount: leaving a repo falls back to the raw cwd rather than
 * emptying `gitRoot` — unavailability now only happens when no cwd is
 * resolvable at all.) Derivation therefore only SEEDS (`codeRootSeed`): the first render
 * of the code tile with an empty option writes the derived root once, and from
 * then on the writers are the editor's own navigation (File > Open Folder,
 * reported by `CodeSurface`'s load-event seam) AND the explicit Follow
 * terminal header verb (`codeRootFollowTarget` below) — the terminal still
 * never moves the editor on its own.
 *
 * Pure and DOM-free — the `window-view.ts` / `right-panel.ts` module contract.
 */

import type { ViewWindow } from "./window-view";
import { leaves, type Layout } from "./surface-layout";

/**
 * The folder the code surface opens: the shared code root, falling back to
 * the derived `gitRoot` while the option is still unset (pre-seed renders and
 * availability gating) — `gitRoot` here is the resolved code folder (git
 * toplevel, else the raw cwd outside any repo). "" when neither exists — the
 * code surface is unavailable then (`hasCode` keys off the same pair).
 */
export function codeRootFor(win: ViewWindow | null | undefined): string {
  return win?.codeRoot || win?.gitRoot || "";
}

/**
 * The one-time seed for `@rk_win_code_root`: the derived `gitRoot` (toplevel,
 * else raw cwd), but only
 * when the code tile is actually open AND the option is still empty — seeding
 * a closed tile would pin a root the user never asked for, and seeding over a
 * set root would clobber the editor's own navigation. `null` means "no write".
 */
export function codeRootSeed(
  win: ViewWindow | null | undefined,
  layout: Layout,
): string | null {
  return leaves(layout).includes("code") && !win?.codeRoot && win?.gitRoot
    ? win.gitRoot
    : null;
}

/**
 * The Follow terminal verb's target: the live derived `gitRoot` when the
 * latched code root has DRIFTED from it — both non-empty and different —
 * else `null` (no drift ⇒ no verb, nothing to write). Empty inputs never
 * count as drift: a pre-seed window (`codeRoot` empty) is about to be seeded
 * from `gitRoot` anyway, and an empty derivation (no cwd resolvable) has no
 * folder to follow.
 */
export function codeRootFollowTarget(win: ViewWindow | null | undefined): string | null {
  const latched = win?.codeRoot ?? "";
  const derived = win?.gitRoot ?? "";
  return latched !== "" && derived !== "" && latched !== derived ? derived : null;
}
