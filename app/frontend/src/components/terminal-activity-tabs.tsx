import { useNavigate, useSearch } from "@tanstack/react-router";
import { controlClass } from "@/components/control";

// The strip renders the label set `Terminal · Tasks · Activity · Cron` in that
// fixed order. Content-sized, non-wrapping
// buttons (never equal-share) are what keep every label from truncating at
// the desktop drawer width or a 375px mobile header.
const SEGMENTS = [
  { tab: "terminal", label: "Terminal" },
  { tab: "tasks", label: "Tasks" },
  { tab: "activity", label: "Activity" },
  { tab: "cron", label: "Cron" },
] as const;

export type QuakeSegment = (typeof SEGMENTS)[number]["tab"];

// The accepted tab values are exported for the union-agreement guard: the
// strip's tabs, `QuakeTerminalRequest.segment`, and router-url.ts's literal
// `tab` union are three spellings of the same set and must never drift.
export { SEGMENTS };

/**
 * The presentational `Terminal | Tasks | Activity | Cron`
 * segment strip — one controlled render shared by the mobile
 * operator route's tabs (`TerminalActivityTabs` below, driven by the router
 * `tab` search param) and the desktop quake terminal drawer (driven by
 * drawer-local component state). Both consumers get identical markup,
 * roles, and test ids. The file name and the `terminal-activity-tabs` test
 * id predate the extra segments and stay — renaming would churn every spec
 * for no behavior gain.
 */
export function QuakeSegments({
  value,
  onChange,
  className,
}: {
  value: QuakeSegment;
  onChange: (tab: QuakeSegment) => void;
  /** Chrome override — the desktop drawer's folded header row drops the
   *  strip's own border/background (the row carries both). Absent = the
   *  standalone chrome (the mobile route's mount). */
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Quake terminal segments"
      data-testid="terminal-activity-tabs"
      className={`flex shrink-0 ${className ?? "border-b border-border bg-bg-primary"}`}
    >
      {SEGMENTS.map(({ tab, label }) => {
        const pressed = value === tab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={pressed}
            onClick={() => onChange(tab)}
            className={`rk-glint shrink-0 whitespace-nowrap px-1.5 py-2 text-center text-[11px] font-mono transition-colors coarse:min-h-[36px] ${controlClass({ variant: "segment", pressed, rest: "border-transparent text-text-secondary hover:text-text-primary" })}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The operator page's segmented header (mounted by AppShell whenever the
 * resolved window's role is `operator`, on every form factor). Each segment
 * drives the terminal route's `tab` search param through the router's
 * search-param setter — a client-side search update, never a full
 * navigation — and `tab` absent reads as `terminal`.
 *
 * `clearTongue` adds the `pt-9` wrapper that clears the mobile tongue's hit
 * area: the tongue hangs `absolute top-0 h-9 w-16` centered over the content
 * column (app.tsx), and a middle segment's center would land under it — the strip must start below the tongue's 36px box. The
 * tongue never renders on desktop, so the clearance is mobile-only.
 */
export function TerminalActivityTabs({ clearTongue }: { clearTongue?: boolean }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const active: QuakeSegment =
    search.tab === "tasks" ||
    search.tab === "activity" ||
    search.tab === "cron"
      ? search.tab
      : "terminal";

  return (
    <div className={clearTongue ? "shrink-0 pt-9" : "shrink-0"}>
      <QuakeSegments
        value={active}
        onChange={(tab) =>
          void navigate({
            to: ".",
            search: (prev) => ({ ...prev, tab }),
            replace: true,
          })
        }
      />
    </div>
  );
}
