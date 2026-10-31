import { useMemo, useState } from "react";
import { createWindow } from "@/api/client";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { FolderPathInput, projectRoots } from "@/components/folder-path-input";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useSessionContext } from "@/contexts/session-context";
import type { ProjectSession } from "@/types";

type CreateSessionDialogProps = {
  /** Quick-picks ("Recent:") derive from these sessions' project roots. */
  sessions: ProjectSession[];
  /** The session to create the window in. */
  session: string;
  onClose: () => void;
  /** Pre-fill the path input on mount. */
  defaultPath?: string;
};

/**
 * The window-at-folder dialog behind the palette's `Tab: Create at Folder`:
 * pick a starting directory (quick-picks + debounced autocomplete) and create
 * an unnamed window there — tmux auto-names it to the folder basename.
 */
export function CreateSessionDialog({ sessions, session, onClose, defaultPath }: CreateSessionDialogProps) {
  const [path, setPath] = useState(defaultPath ?? "");
  const [error, setError] = useState("");
  // The dialog only opens from AppShell where `currentServer` is set;
  // fallback to empty string is defensive.
  const { currentServer } = useSessionContext();
  const server = currentServer ?? "";

  const quickPicks = useMemo(() => projectRoots(sessions), [sessions]);

  const { execute: executeCreateWindowAction } = useOptimisticAction<[string, string, string | undefined]>({
    // No name — tmux auto-names the window to its chosen folder basename via
    // automatic-rename-format (the -c cwd on create makes this immediate). This
    // flow sets no optimistic ghost, so there is no ghost label to derive.
    action: (srv, targetSession, cwd) => createWindow(srv, targetSession, undefined, cwd),
    onError: (err) => {
      setError(err.message || "Failed to create tab");
    },
  });

  function handleCreate() {
    setError("");
    executeCreateWindowAction(server, session, path.trim() || undefined);
    onClose();
  }

  return (
    <Dialog title="Create tab at folder" onClose={onClose}>
      <div className="mb-3">
        <p className="text-xs text-text-secondary mb-1.5">Path:</p>
        <FolderPathInput
          autoFocus
          value={path}
          onChange={(value) => {
            setPath(value);
            setError("");
          }}
          onSubmit={handleCreate}
          quickPicks={quickPicks}
        />
      </div>

      {error && (
        <p className="text-xs text-signal-red mb-2">{error}</p>
      )}

      <button
        onClick={handleCreate}
        className={`w-full ${controlClass({ variant: "wide" })}`}
      >
        Create
      </button>
    </Dialog>
  );
}
