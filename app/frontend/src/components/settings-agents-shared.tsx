import { useCallback, useState } from "react";
import type { FabConfigDocument, FabOrigin } from "@/api/client";
import { INPUT_FOCUS } from "@/components/controls";

/** Pieces the Agents tab's modules share: the document and write types, the
 *  row-scoped write state, and the provenance chip. */

export type Document = Extract<FabConfigDocument, { installed: true }>;
export type Patch = Record<string, string | number | boolean | null>;
export type Write = (patch: Patch) => Promise<void>;

export const roleSelectBase = `bg-transparent text-text-primary p-1 border border-border rounded text-xs ${INPUT_FOCUS}`;

export function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Failed to save";
}

export function stringValue(field: { value: unknown } | undefined): string {
  return typeof field?.value === "string" ? field.value : "";
}

/** Provenance chip: which tier the effective value comes from. `env` renders
 *  amber (it shadows the saved value); `project` is read-only informational. */
export function ProvenanceChip({ origin, detail, preset }: { origin: FabOrigin | ""; detail?: string; preset?: string }) {
  if (preset !== undefined) {
    return (
      <span
        data-testid="provenance-chip"
        title={`preset ${preset}`}
        className="px-1 py-px border rounded text-[9px] uppercase tracking-wide text-text-secondary border-border"
      >
        preset
      </span>
    );
  }
  if (origin === "") return null;
  const tone = origin === "env" ? "text-signal-yellow border-signal-yellow" : "text-text-secondary border-border";
  return (
    <span
      data-testid="provenance-chip"
      title={detail || undefined}
      className={`px-1 py-px border rounded text-[9px] uppercase tracking-wide ${tone}`}
    >
      {origin}
    </span>
  );
}

export function ResetLink({ label, onReset, busy }: { label: string; onReset: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={busy}
      onClick={onReset}
      className="text-[10px] text-accent hover:underline disabled:opacity-40"
    >
      reset
    </button>
  );
}

/** Row-scoped write state: a failed write shows fab's message on THAT row; the
 *  panel then re-reads fab rather than trusting the values it showed before. */
export function useRowWrite(write: Write) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (patch: Patch) => {
      setBusy(true);
      setError("");
      try {
        await write(patch);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [write],
  );
  return { error, busy, run };
}

/** A boxed section with a header bar stating its job. `action` sits in the
 *  header (the Presets section's "+ New preset"); `tone="notice"` frames the
 *  box in the warning color. */
export function SettingsSection({
  title,
  job,
  testId,
  action,
  tone,
  sectionRef,
  children,
}: {
  title: string;
  job: string;
  testId: string;
  action?: React.ReactNode;
  tone?: "notice";
  sectionRef?: React.Ref<HTMLElement>;
  children: React.ReactNode;
}) {
  const frame = tone === "notice" ? "border-signal-yellow" : "border-border";
  const titleTone = tone === "notice" ? "text-signal-yellow" : "text-text-primary";
  return (
    <section ref={sectionRef} aria-label={title} data-testid={testId} className={`border ${frame} rounded overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 bg-bg-card border-b border-border">
        <h3 className={`text-[11px] uppercase tracking-wider font-medium ${titleTone}`}>{title}</h3>
        <p className="text-[11px] text-text-secondary flex-1 basis-[240px] min-w-0">{job}</p>
        {action}
      </div>
      <div className="px-2.5 py-3 flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

/** The small bordered button the preset controls share. */
export const smallButtonClass = `px-2 py-1 border border-border rounded text-xs text-text-primary hover:border-accent disabled:opacity-40 disabled:hover:border-border ${INPUT_FOCUS}`;
export const dangerButtonClass = `px-2 py-1 border border-signal-red rounded text-xs text-signal-red hover:bg-signal-red/10 disabled:opacity-40 ${INPUT_FOCUS}`;
