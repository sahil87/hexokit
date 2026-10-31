import { useEffect, useRef, useState } from "react";
import { INPUT_FOCUS } from "@/components/controls";

/**
 * The shared text-setting core: the draft/commit/Escape state machine behind
 * every text setting in the dialog (curated `TextSetting` rows and the
 * All-settings table's string/path control). Enter/blur commit, Escape
 * cancels the edit only (a second Escape closes the dialog), a commit
 * rejection renders inline (`role="alert"`) and the input keeps the typed
 * value. `commit` receives the trimmed value ("" = clear).
 */
export function useTextSettingDraft(value: string, commit: (trimmed: string) => Promise<void>) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  // Follow external updates (fetch landing, another surface editing) unless
  // the user has diverged the draft.
  const lastValueRef = useRef(value);
  useEffect(() => {
    if (draft === lastValueRef.current) setDraft(value);
    lastValueRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleCommit = () => {
    const trimmed = draft.trim();
    if (trimmed === value.trim()) {
      setDraft(value);
      setError("");
      return;
    }
    commit(trimmed)
      .then(() => {
        setError("");
        setDraft(trimmed);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : "Failed to save");
      });
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
    setError("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCommit();
    } else if (e.key === "Escape") {
      // Cancel the edit only — a second Escape closes the dialog.
      if (draft !== value) {
        e.stopPropagation();
        setDraft(value);
        setError("");
      }
    }
  };

  return { draft, error, handleCommit, onChange, onKeyDown };
}

export const textSettingInputClass =
  `w-full max-w-[320px] bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} placeholder:text-text-secondary`;

export function TextSettingError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p className="text-xs text-signal-red mt-1" role="alert">
      {error}
    </p>
  );
}

/** Scope heading — a full-width underlined rule: uppercase scope name left,
 *  storage hint right-aligned on the same line (6j1v). Shared by the dialog's
 *  curated scope groups and the All-settings table's category headers (an
 *  empty hint renders no right span). */
export function ScopeHeading({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 mb-1">
      <span className="text-[10px] uppercase tracking-wider text-text-primary font-medium shrink-0">
        {label}
      </span>
      {hint !== "" && (
        <span className="text-[10px] text-text-secondary text-right">{hint}</span>
      )}
    </div>
  );
}

/**
 * One preference row (6j1v): label column left (label + optional small
 * sublabel hint underneath), control column right. `min-[480px]:` gates the
 * two-column grid — below it the row stacks label-above-control (today's
 * phone layout) from the same markup. `htmlFor` renders the label as a real
 * `<label>` bound to the row's input; rows whose control has its own labeled
 * elements (theme selects, steppers) pass none. `meta` is a small monospace
 * line under the sublabel (a config key).
 */
export function PreferenceRow({
  label,
  sublabel,
  meta,
  htmlFor,
  children,
}: {
  label: string;
  sublabel?: string;
  meta?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 min-[480px]:grid-cols-[190px_1fr] gap-x-6 gap-y-1.5 py-2.5 items-start">
      <div className="min-[480px]:pt-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-xs text-text-primary">
            {label}
          </label>
        ) : (
          <p className="text-xs text-text-primary">{label}</p>
        )}
        {sublabel && (
          <p className="text-[10px] text-text-secondary mt-0.5 leading-relaxed">{sublabel}</p>
        )}
        {meta && <p className="text-[10px] font-mono text-text-secondary/70 mt-0.5 break-all">{meta}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
