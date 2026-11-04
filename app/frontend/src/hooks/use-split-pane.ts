import { splitWindow } from "@/api/client";
import { useToast } from "@/components/toast";
import { useFocusedTerminal } from "@/contexts/focused-terminal-context";
import { useIsMobile } from "./use-is-mobile";
import { useOptimisticAction } from "./use-optimistic-action";

/**
 * The single split-pane action behind every split entry point (palette,
 * chords, tty tile header, top-bar split control and menu rows, board).
 *
 * The backend makes the new pane tmux's active pane, but the click/palette
 * that triggered the split leaves DOM focus on a button or `<body>`, so the
 * split also hands keyboard focus to the focused terminal. It does so
 * synchronously at invoke: a split renders inside the same xterm, so there is
 * nothing to wait for. A tile-header click lands here already pointing at the
 * clicked tile — its pointerdown made it the `FocusedTerminal` registrant.
 * Desktop only (auto-focus pops the mobile keyboard), and a programmatic
 * focus that never writes focus memory.
 */
export function useSplitPane() {
  const { focused } = useFocusedTerminal();
  const isMobile = useIsMobile();
  const { addToast } = useToast();
  const { execute, isPending } = useOptimisticAction<[string, string, boolean, string | undefined]>({
    action: (server, windowId, horizontal, cwd) => splitWindow(server, windowId, horizontal, cwd),
    onOptimistic: () => {
      if (!isMobile) focused?.focus?.();
    },
    onError: (err) => addToast(err.message || "Failed to split pane"),
  });
  return { split: execute, isPending };
}
