import { useState } from "react";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { FolderPathInput } from "@/components/folder-path-input";
import { deriveNameFromPath, finalizeSafeName, toSafeServerName } from "@/lib/names";

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

type CreateWorkspaceDialogProps = {
  /** Folder prefilled on open (e.g. the current tab's worktree). */
  initialFolder?: string;
  /** Names of the workspaces that already exist; a matching name blocks Create. */
  existingNames: string[];
  /** Folder dropdown entries while the folder is empty. */
  quickPicks: string[];
  /** Called with the finalized name and the trimmed folder (undefined when blank). */
  onSubmit: (name: string, cwd: string | undefined) => void;
  onClose: () => void;
};

function folderToName(folder: string): string {
  return toSafeServerName(deriveNameFromPath(folder));
}

/**
 * The "New workspace" dialog shared by the in-workspace shell and the host
 * page: a name plus an optional starting folder. While the name is untouched
 * it follows the folder's basename; typing in the name field ends that until
 * the dialog is reopened. Mounted only while open, so state resets on close.
 */
export function CreateWorkspaceDialog({ initialFolder = "", existingNames, quickPicks, onSubmit, onClose }: CreateWorkspaceDialogProps) {
  const [folder, setFolder] = useState(initialFolder);
  const [name, setName] = useState(() => folderToName(initialFolder));
  const [nameTouched, setNameTouched] = useState(false);

  const finalizedName = finalizeSafeName(name.trim());
  const nameTaken = existingNames.includes(finalizedName);
  const valid = SERVER_NAME_PATTERN.test(name.trim()) && !nameTaken;

  function handleFolderChange(next: string) {
    setFolder(next);
    if (!nameTouched) setName(folderToName(next));
  }

  function handleSubmit() {
    // The input applies the live server transform; commit trims the trailing
    // separator. The pattern stays as defense in depth.
    const finalized = finalizeSafeName(name.trim());
    if (!finalized || !SERVER_NAME_PATTERN.test(finalized) || nameTaken) return;
    onSubmit(finalized, folder.trim() || undefined);
  }

  return (
    <Dialog title="New workspace" onClose={onClose}>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => {
          setNameTouched(true);
          setName(toSafeServerName(e.target.value));
        }}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        onFocus={(e) => e.target.select()}
        aria-label="Workspace name"
        placeholder="Workspace name..."
        className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
      />
      {nameTaken ? (
        <p className="text-xs text-signal-red mt-1.5">A workspace named {finalizedName} already exists</p>
      ) : (
        <p className="text-xs text-text-secondary mt-1.5">
          Alphanumeric, hyphens, and underscores only.
        </p>
      )}
      <div className="mt-3">
        <p className="text-xs text-text-secondary mb-1.5">Folder (optional)</p>
        <FolderPathInput
          value={folder}
          onChange={handleFolderChange}
          onSubmit={handleSubmit}
          quickPicks={quickPicks}
          ariaLabel="Workspace folder"
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={!valid}
        className={`mt-2.5 w-full ${controlClass({ variant: "wide", disabled: !valid })}`}
      >
        Create
      </button>
    </Dialog>
  );
}
