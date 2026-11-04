import { useState } from "react";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { addShellHostDirect } from "@/lib/shell";

/**
 * The ONE Add/Edit host form: the desktop-shell titlebar
 * strip's Edit Host dialog extracted into a mode-discriminated shared
 * component so the strip's `+ Add Host…` footer can add a host IN PLACE (on
 * shells carrying `servers:add-direct`) instead of page-swapping to the
 * welcome page. Both modes render the same field contract — Name (optional)
 * above URL, same labels, same validation copy, same error slot, same
 * Cancel/primary row — on the shared `Dialog` shell inside the z-[60]
 * menu-stacking wrapper.
 *
 * Edit mode is a pure rendering extraction: the caller owns the save
 * semantics (diff-against-prefill, servers:rename / servers:set-url,
 * optimistic update, refocus) and answers with the inline error to show, or
 * null when the save proceeds. Add mode owns its submit: local URL
 * validation (the same full-http(s) check and copy), then ONE
 * `addShellHostDirect` invoke — the main process pings before persisting, so
 * a returned failure renders inline here and keeps the dialog open. The ping
 * can take up to 5s, so the form is busy (fields + submit disabled — the
 * spawn-agent in-flight convention) while the invoke is in flight.
 */

export const INVALID_HOST_URL_MESSAGE = "Enter a full http(s) URL, e.g. http://host:6123";

type EditModeProps = {
  mode: "edit";
  title: string;
  initialName: string;
  initialUrl: string;
  /** False on shells without `setUrl`: the URL field is disabled with the
   *  "newer desktop app" note. */
  urlEnabled: boolean;
  submitLabel: string;
  /** Runs the caller-owned save; returns the inline error to show (the
   *  dialog stays open), or null when the save proceeded (the caller
   *  unmounts the dialog). */
  onSubmit: (values: { name: string; url: string }) => string | null;
  onCancel: () => void;
};

type AddModeProps = {
  mode: "add";
  title: string;
  submitLabel: string;
  /** The shell has already switched to the new host when this fires. */
  onSuccess: () => void;
  onCancel: () => void;
};

export type HostFormDialogProps = EditModeProps | AddModeProps;

/** Reduce a full http(s) URL to its origin; null when malformed. Shared by
 *  add mode's local validation and the strip's edit-mode save — the SAME
 *  check backs both, paired with INVALID_HOST_URL_MESSAGE. */
export function reduceOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function HostFormDialog(props: HostFormDialogProps) {
  const [name, setName] = useState(props.mode === "edit" ? props.initialName : "");
  const [url, setUrl] = useState(props.mode === "edit" ? props.initialUrl : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urlEnabled = props.mode === "edit" ? props.urlEnabled : true;

  const submit = () => {
    if (busy) return;
    if (props.mode === "edit") {
      setError(props.onSubmit({ name, url }));
      return;
    }
    const origin = reduceOrigin(url.trim());
    if (origin === null) {
      setError(INVALID_HOST_URL_MESSAGE);
      return;
    }
    setError(null);
    setBusy(true);
    void addShellHostDirect(name.trim(), origin).then((result) => {
      if (result.ok) {
        props.onSuccess();
        return;
      }
      setError(result.error);
      setBusy(false);
    });
  };

  return (
    // The z-[60] wrapper lifts the dialog ABOVE the z-50 menu popover (same
    // stacking context) — the menu-scoped dialog treatment.
    <div className="relative z-[60]">
      <Dialog title={props.title} onClose={props.onCancel}>
        <label className="mb-2 block text-xs text-text-secondary">
          Name
          <input
            type="text"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className={`mt-1 w-full rounded border border-border bg-transparent px-2 py-1 text-sm text-text-primary ${INPUT_FOCUS} ${INPUT_COARSE} disabled:opacity-40`}
          />
        </label>
        <label className="mb-1 block text-xs text-text-secondary">
          URL
          <input
            type="text"
            value={url}
            disabled={!urlEnabled || busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className={`mt-1 w-full rounded border border-border bg-transparent px-2 py-1 text-sm text-text-primary ${INPUT_FOCUS} ${INPUT_COARSE} disabled:opacity-40`}
          />
        </label>
        {!urlEnabled && (
          <p className="mb-2 text-xs text-text-secondary opacity-70">
            URL editing needs a newer desktop app.
          </p>
        )}
        {error !== null && <p className="mb-2 text-xs text-signal-red">{error}</p>}
        <div className="mt-2 flex gap-2">
          <button
            onClick={props.onCancel}
            className={`flex-1 ${controlClass({ variant: "confirm" })}`}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className={`flex-1 ${controlClass({ variant: "confirm" })}`}
          >
            {props.submitLabel}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
