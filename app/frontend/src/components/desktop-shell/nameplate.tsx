import { useLayoutEffect, useRef, useState } from "react";
import { HOST_KIND_LABEL, nameplateFields, visibleFieldCount } from "@/lib/shell-strip";
import type { HostKind, NameplateData, NameplateField } from "@/lib/shell-strip";

/**
 * The strip's host nameplate: the host name (bold, never folded — it
 * truncates) followed by `·`-separated fields — user@machine, OS with a kind
 * glyph, link, agent count. Fields fold right-to-left as the band narrows
 * (agents first), measurement-driven: a hidden clone lays every field out at
 * its natural width and a ResizeObserver on the nameplate re-fits them. The
 * nameplate is `flex: 1` after the squares, so folding can never move a
 * square. `peek` renders a hover preview of another host (dimmed, `→ ` before
 * the name — styled in globals.css off `data-peek`).
 */

const KIND_GLYPHS: Record<HostKind, string[]> = {
  local: ['<rect x="3" y="3.5" width="10" height="7" rx="1"/>', '<path d="M1.5 13h13"/>'],
  net: [
    '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/>',
    '<rect x="2.5" y="9" width="11" height="4.5" rx="1"/>',
    '<path d="M5 4.75h.01M5 11.25h.01"/>',
  ],
  tunnel: [
    '<path d="M2 13.5V8a6 6 0 0 1 12 0v5.5"/>',
    '<path d="M5.5 13.5V8.5a2.5 2.5 0 0 1 5 0v5"/>',
    '<path d="M1 13.5h14"/>',
  ],
};

/** Monochrome kind glyph (`currentColor`), labelled for assistive tech. */
function KindGlyph({ kind }: { kind: HostKind }) {
  return (
    <svg
      role="img"
      aria-label={HOST_KIND_LABEL[kind]}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Static, build-time path data — never user input.
      dangerouslySetInnerHTML={{ __html: KIND_GLYPHS[kind].join("") }}
    />
  );
}

function FieldContent({ field }: { field: NameplateField }) {
  return (
    <>
      {field.kind !== undefined && <KindGlyph kind={field.kind} />}
      {field.text}
    </>
  );
}

export interface NameplateProps {
  data: NameplateData;
  peek?: boolean;
  /** Called after each layout pass (fold changes included) so the strip can
   *  re-measure where the light should end. */
  onLayout?: () => void;
}

export function Nameplate({ data, peek = false, onLayout }: NameplateProps) {
  const fields = nameplateFields(data);
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(fields.length);
  const fieldCount = fields.length;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure) return;
    function fit() {
      if (!root || !measure) return;
      const available = root.clientWidth;
      const name = measure.querySelector<HTMLElement>("[data-np-name]");
      const widths = [...measure.querySelectorAll<HTMLElement>("[data-np-field]")].map(
        (el) => el.offsetWidth,
      );
      // No layout (jsdom, a hidden strip): nothing to fold against — show all.
      const count =
        available <= 0 ? widths.length : visibleFieldCount(name?.offsetWidth ?? 0, widths, available);
      setVisible(count);
    }
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
    // `data` identity changes every render; its content is what the clone lays out.
  }, [fieldCount, peek, data.name, data.userMachine, data.os, data.kind, data.link, data.agents]);

  useLayoutEffect(() => {
    onLayout?.();
  });

  const shown = fields.slice(0, Math.min(visible, fieldCount));
  return (
    <div
      ref={rootRef}
      data-testid="shell-nameplate"
      data-peek={peek ? "true" : "false"}
      className="rk-strip-nameplate rk-shell-drag relative"
    >
      <span data-testid="shell-nameplate-name" className="rk-strip-np-name">
        {peek ? "→ " : ""}
        {data.name}
      </span>
      {shown.map((field) => (
        <span key={field.key} data-np-shown={field.key} className="rk-strip-np-field">
          <FieldContent field={field} />
        </span>
      ))}
      {/* Hidden clone at natural widths — the fold measurement source. Absolutely
          positioned so it never takes part in layout. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap"
      >
        <span data-np-name className="rk-strip-np-name">
          {peek ? "→ " : ""}
          {data.name}
        </span>
        {fields.map((field) => (
          <span key={field.key} data-np-field className="rk-strip-np-field">
            <FieldContent field={field} />
          </span>
        ))}
      </div>
    </div>
  );
}
