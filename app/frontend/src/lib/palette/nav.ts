/**
 * Pure builder for the command-palette navigation actions (260714-uco1):
 * browser-history `Go: Back` / `Go: Forward` and the current route's
 * ANCESTOR-navigation entries (`Go: tmux Server` / `Go: Host`). Extracted
 * from app.tsx so the route-gating and label composition are unit-testable
 * without mounting the whole shell — mirroring lib/palette/view.ts /
 * lib/palette/move.ts. The action bodies are thin wrappers passed in by the
 * caller (they call `router.history.back()/.forward()` and `navigate(...)`).
 *
 * Constitution V palette parity for the top-bar history arrows + hierarchy
 * dropdown. History actions are ALWAYS offered (history is global; forward is a
 * harmless no-op with no forward entry, matching the always-active arrow). The
 * ancestor entries mirror the hierarchy dropdown's contents for the current
 * route — ancestors only, nearest-first — and every supported mode emits at
 * least `Go: Host` (the Host root is an ancestor of every palette-bearing
 * route).
 */

export type NavPaletteAction = {
  id: string;
  label: string;
  onSelect: () => void;
};

/**
 * The route's page mode — the palette-bearing subset of `TopBarMode` (the root
 * Host route mounts no palette, hence no `host` mode). Drives which ancestor
 * entries are offered:
 *   - `terminal`: `Go: tmux Server` + `Go: Host`
 *   - `board` / `server`: `Go: Host`
 */
export type NavMode = "terminal" | "board" | "server";

/**
 * Build the navigation palette actions. Returns the two history actions
 * (always) followed by the route-appropriate ancestor actions.
 *
 * `server` is required for the `terminal`-mode `Go: tmux Server` target; when
 * empty (e.g. before the route resolves), the tmux Server entry is omitted so
 * the action never navigates to `/` (a blank server).
 */
export function buildNavActions(
  mode: NavMode,
  server: string,
  handlers: {
    onBack: () => void;
    onForward: () => void;
    onTmuxServer: () => void;
    onHost: () => void;
  },
): NavPaletteAction[] {
  const actions: NavPaletteAction[] = [
    { id: "go-back", label: "Go: Back", onSelect: handlers.onBack },
    { id: "go-forward", label: "Go: Forward", onSelect: handlers.onForward },
  ];

  // Ancestor entries — nearest-first, mirroring the hierarchy dropdown.
  if (mode === "terminal" && server) {
    actions.push({
      id: "go-tmux-server",
      label: "Go: Workspace",
      onSelect: handlers.onTmuxServer,
    });
  }
  // `Go: Host` is unconditional — the Host root is an ancestor of every
  // palette-bearing mode (only the `terminal` extra above differs by mode).
  actions.push({
    id: "go-host",
    label: "Go: Host",
    onSelect: handlers.onHost,
  });

  return actions;
}
