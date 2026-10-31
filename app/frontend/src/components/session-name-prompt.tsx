import { useMemo, useRef, useState, useEffect } from "react";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { toSafeSessionName, finalizeSafeName } from "@/lib/names";
import type { ProjectSession } from "@/types";

type SessionNamePromptProps = {
  sessions: ProjectSession[];
  /** The name instant-create would have used — computed by the caller at open time. */
  defaultName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
};

/**
 * The save-as-style prompt behind `Session: Create` (palette + chord): a single
 * name input prefilled with the auto-derived session name, select-all'd so
 * Enter accepts the default and typing replaces it. Escape/backdrop close via
 * the Dialog shell. Deliberately lighter than CreateSessionDialog — no path
 * picker; `Tab: Create at Folder` remains the path-picking flow.
 */
export function SessionNamePrompt({ sessions, defaultName, onSubmit, onClose }: SessionNamePromptProps) {
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the prefill once on mount. The Dialog focus trap targets this same
  // first-focusable input, and re-focusing a focused element preserves the
  // selection, so the two effects compose in either order.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const existingNames = useMemo(
    () => new Set(sessions.map((s) => s.name)),
    [sessions],
  );

  // The name a submit would actually create (commit shape) — collision-checked
  // so the warning matches what would be created.
  const finalName = useMemo(() => finalizeSafeName(name.trim()), [name]);
  const nameCollision = finalName !== "" && existingNames.has(finalName);
  const submitDisabled = finalName === "" || nameCollision;

  function handleSubmit() {
    if (submitDisabled) return;
    onSubmit(finalName);
  }

  return (
    <Dialog title="New group" onClose={onClose}>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => {
          // Live safe-name conversion (WYSIWYG): a typed space appears as "_".
          setName(toSafeSessionName(e.target.value));
        }}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        aria-label="Group name"
        aria-invalid={nameCollision}
        placeholder="Group name..."
        className={`w-full bg-transparent text-text-primary p-2 border rounded ${nameCollision ? "outline-none focus:border-red-500" : INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary ${
          nameCollision ? "border-red-500" : "border-border"
        }`}
      />
      {nameCollision && (
        <p className="text-xs text-signal-red mt-1">
          Session "{finalName}" already exists
        </p>
      )}
      <button
        onClick={handleSubmit}
        disabled={submitDisabled}
        className={`w-full mt-3 ${controlClass({ variant: "wide", disabled: submitDisabled })}`}
      >
        Create
      </button>
    </Dialog>
  );
}
