import { useEffect, useRef, useState } from "react";
import { INPUT_FOCUS } from "@/components/controls";
import { TextSettingError, textSettingInputClass } from "@/components/text-setting-core";
import { dangerButtonClass, errorMessage, smallButtonClass } from "@/components/settings-agents-shared";
import { MSG_DESCRIPTION_REQUIRED, PRESET_NAME_MAX, presetNameError } from "@/lib/agent-presets-editor";

/** The inline forms of the Presets section: one name form serves New,
 *  Duplicate, Rename and the leftover move; the delete confirm asks before a
 *  preset goes. Escape closes either without closing the dialog. */

const NAME_PLACEHOLDER = "name, e.g. night-shift";
const DESCRIPTION_PLACEHOLDER = "one-line description (required)";

export type NameFormValues = { name: string; description: string };

export function NameForm({
  title,
  verb,
  initialName,
  initialDescription = "",
  askDescription,
  takenNames,
  sameName,
  note,
  onSubmit,
  onCancel,
}: {
  title: string;
  verb: string;
  initialName: string;
  initialDescription?: string;
  /** New, Duplicate and the leftover move require a description. */
  askDescription: boolean;
  /** Every listed preset name (built-in or yours). */
  takenNames: readonly string[];
  /** Submitting this exact name just closes the form (a no-op rename). */
  sameName?: string;
  note?: string;
  onSubmit: (values: NameFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = name.trim();
    if (sameName !== undefined && trimmed === sameName) {
      onCancel();
      return;
    }
    const nameProblem = presetNameError(trimmed, takenNames);
    if (nameProblem) return setError(nameProblem);
    if (askDescription && description.trim() === "") return setError(MSG_DESCRIPTION_REQUIRED);
    setBusy(true);
    setError("");
    try {
      await onSubmit({ name: trimmed, description: description.trim() });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const inputClass = `${textSettingInputClass} flex-1 basis-[180px] min-w-0 max-w-none p-1.5 text-xs`;
  return (
    <div
      data-testid="preset-name-form"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border border-accent rounded p-2"
    >
      <b className="text-xs text-text-primary">{title}</b>
      <input
        ref={nameRef}
        type="text"
        aria-label="Preset name"
        value={name}
        maxLength={PRESET_NAME_MAX}
        placeholder={NAME_PLACEHOLDER}
        disabled={busy}
        onChange={(e) => {
          setName(e.target.value);
          setError("");
        }}
        onKeyDown={onKeyDown}
        className={inputClass}
      />
      {askDescription && (
        <input
          type="text"
          aria-label="Preset description"
          value={description}
          placeholder={DESCRIPTION_PLACEHOLDER}
          disabled={busy}
          onChange={(e) => {
            setDescription(e.target.value);
            setError("");
          }}
          onKeyDown={onKeyDown}
          className={inputClass}
        />
      )}
      <button type="button" disabled={busy} onClick={() => void submit()} className={smallButtonClass}>
        {verb}
      </button>
      <button type="button" disabled={busy} onClick={onCancel} className={smallButtonClass}>
        Cancel
      </button>
      {error && (
        <div className="basis-full">
          <TextSettingError error={error} />
        </div>
      )}
      {note && <p className="basis-full text-[10px] text-text-secondary leading-relaxed">{note}</p>}
    </div>
  );
}

export function DeleteConfirm({
  name,
  usedBy,
  onConfirm,
  onCancel,
}: {
  name: string;
  usedBy: string[];
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-label="Delete preset"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 border border-signal-red rounded p-2 text-xs text-text-primary ${INPUT_FOCUS}`}
    >
      <span className="flex-1 basis-[220px] min-w-0">
        Delete <b>{name}</b>?
        {usedBy.length > 0 &&
          ` It is used by ${usedBy.join(", ")}. Their choice is cleared, and tabs already running with it fall back to the default.`}
      </span>
      <button type="button" disabled={busy} onClick={() => void confirm()} className={dangerButtonClass}>
        Delete
      </button>
      <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className={smallButtonClass}>
        Cancel
      </button>
      {error && (
        <div className="basis-full">
          <TextSettingError error={error} />
        </div>
      )}
    </div>
  );
}
