/**
 * Pure builder for the command-palette `Code:` action family — the code
 * tile's header verbs (Follow terminal / Reload editor) mirrored for
 * Constitution V palette parity. Extracted from app.tsx so the per-state
 * gating is unit-testable without mounting the shell — mirroring
 * `lib/palette/zen.ts` (`buildZenActions`) and `lib/palette/gui.ts`
 * (`buildGuiActions`). The bodies route through the caller's
 * `codeCommandsRef` seam (the `guiCommandsRef` precedent), so a palette row
 * and its header button run the same function.
 *
 * Entries, per current state (the caller assembles these on the terminal
 * route only, both form factors):
 *  - `Code: Follow Terminal` — code tile open AND the latched root drifts
 *    from the live derivation (`followTarget` non-null); the description
 *    names the target's basename. Re-seeds `@rk_win_code_root` from the
 *    derived root through the shared follow wrapper.
 *  - `Code: Reload Editor`  — code tile open AND a frame is mounted
 *    (`frameMounted`: reachable with a resolved src); reboots the ACTIVE
 *    window's frame via the `reloadNonce` seam — retained frames untouched.
 *  - `Code: Restart code-server` — code tile open AND code-server unreachable;
 *    the not-running empty state's Restart button's twin (same client call).
 */

export type CodePaletteAction = {
  id: string;
  label: string;
  description?: string;
  onSelect: () => void;
};

export type CodePaletteOptions = {
  /** The resolved layout includes the code tile (the caller reads
   *  `leaves(layout).includes("code")`). */
  codeTileOpen: boolean;
  /** `codeRootFollowTarget(effectiveWindow)` — the drift target (derived
   *  `gitRoot`), or null when the roots agree or either is empty. */
  followTarget: string | null;
  /** A live frame exists for the active window (reachable + src resolved). */
  frameMounted: boolean;
  /** The header verb's body — the shared `requestCodeFollow` wrapper. */
  onFollowTerminal: () => void;
  /** The header verb's body — bumps the active frame's reload nonce. */
  onReload: () => void;
  /** The code-server reachability probe reports down (the empty state shows). */
  unreachable: boolean;
  /** The empty state's Restart button body — POSTs the restart route. */
  onRestartServer: () => void;
};

/** Build the `Code:` entries for the current code-tile state. */
export function buildCodeActions(opts: CodePaletteOptions): CodePaletteAction[] {
  if (!opts.codeTileOpen) return [];
  const actions: CodePaletteAction[] = [];
  if (opts.followTarget !== null) {
    const parts = opts.followTarget.split("/").filter(Boolean);
    const basename = parts.length > 0 ? parts[parts.length - 1] : opts.followTarget;
    actions.push({
      id: "code-follow-terminal",
      label: "Code: Follow Terminal",
      description: `→ ${basename}`,
      onSelect: opts.onFollowTerminal,
    });
  }
  if (opts.frameMounted) {
    actions.push({
      id: "code-reload-editor",
      label: "Code: Reload Editor",
      onSelect: opts.onReload,
    });
  }
  if (opts.unreachable) {
    actions.push({
      id: "code-restart-server",
      label: "Code: Restart code-server",
      onSelect: opts.onRestartServer,
    });
  }
  return actions;
}
