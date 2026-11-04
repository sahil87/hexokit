import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useKeybindings } from "@/hooks/use-keybindings";
import { formatCombo } from "@/lib/keybindings";
import { SessionContext } from "@/contexts/session-context";
import { OperatorStateGlyph } from "@/components/operator-state-glyph";
import { controlClass } from "@/components/control";
import { Tip } from "@/components/tip";
import {
  isQuakeTerminalTarget,
  resolveQuakeTerminalTarget,
  setQuakeMachineState,
  setQuakeRestoreOrigin,
  useQuakeComposeEngaged,
  useQuakeMachineState,
  useOperatorCompose,
} from "@/lib/quake-terminal";
import { focusComposeStrip } from "@/lib/compose-strip-events";

const LAUNCHER_BASE = "flex items-center gap-1.5 px-2 rounded border text-xs shrink-0";
const LAUNCHER_REST =
  "border-border text-text-secondary hover:border-text-secondary hover:text-text-primary";
/** `!` outranks the latched arm's `border-border-pressed`: class order alone
 *  cannot decide a same-specificity tie. */
const LAUNCHER_ENGAGED_EDGE = "border-accent-green!";

export type LauncherProps = {
  routeServer: string | null;
  routeWindow: string | null;
};

/** The bar forms, widest first: `full` (glyph + label + keycap), `label`
 *  (keycap dropped), `glyph` (label and keycap dropped). */
export type LauncherForm = "full" | "label" | "glyph";

/**
 * Everything the launcher's two renderings (the top-bar button and the
 * overflow-menu row) share: the resolved operator, the chord, the draft flag
 * and the click action. The route server and window arrive as props — the
 * top bar already carries them, and this module must not pull router hooks
 * its test harness doesn't mock. Tolerant of a missing SessionProvider: it
 * degrades to "no operator", never crashes.
 */
export function useQuakeLauncher({ routeServer, routeWindow }: LauncherProps) {
  const ctx = useContext(SessionContext);
  const lastViewedRef = useRef<string | null>(null);
  if (routeServer) lastViewedRef.current = routeServer;
  const servers = ctx?.servers ?? [];
  const sessionsByServer = ctx?.sessionsByServer;
  const { server, target } = useMemo(
    () =>
      resolveQuakeTerminalTarget(
        routeServer,
        servers.map((s) => s.name),
        sessionsByServer,
        lastViewedRef.current,
      ),
    [routeServer, servers, sessionsByServer],
  );
  // The draft is the resolved operator's — the same key the drawer's docked
  // strip reads, so the dot and the docked textarea agree.
  const compose = useOperatorCompose(server, target);
  const { byAction, host } = useKeybindings();
  const binding = byAction.get("quake-terminal");
  const chord = binding?.enabled
    ? formatCombo({ code: binding.code, tier: binding.tier }, host.platform)
    : undefined;
  // On the operator window's own route the page IS the quake surface: no
  // drawer ever opens there, so the click focuses the page's compose strip.
  const onOperatorRoute =
    routeServer !== null && routeServer === server && target !== undefined &&
    routeWindow === target.window.windowId;

  const activate = useCallback(() => {
    if (onOperatorRoute) {
      focusComposeStrip();
      return;
    }
    // Same-value while already open: the activity bump is what the
    // outside-click settle check honours.
    setQuakeMachineState("open");
    const el = document.querySelector('[data-testid="quake-terminal-compose-input"]');
    if (el instanceof HTMLElement) el.focus();
  }, [onOperatorRoute]);

  return {
    agentState: target?.window.agentState,
    noOperator: target === undefined,
    hasDraft: compose.text.trim() !== "",
    chord,
    onOperatorRoute,
    activate,
  };
}

/**
 * Focus ownership's invariant (a): at machine entry (rest → open) the restore
 * origin is captured into the lib's slot ONLY when the active element lies
 * outside every quake-terminal-owned element (`isQuakeTerminalTarget`) — a
 * mouse click focuses the launcher button BEFORE the click transitions the
 * machine, and the button carries the quake-terminal root attribute, so an
 * unguarded capture would name the button itself. The ownership-gated return
 * (invariant (b)) lives in the drawer's own machine-follower effect.
 *
 * Mounted once, unconditionally, by the top bar: the launcher button can be
 * overflowed out of the bar (and its probe copy is inert), so the capture must
 * not live in the button.
 */
export function QuakeLauncherFocusCapture() {
  const machine = useQuakeMachineState();
  const prevMachineRef = useRef(machine);
  useEffect(() => {
    const prev = prevMachineRef.current;
    prevMachineRef.current = machine;
    if (machine !== "rest" && prev === "rest") {
      const origin = document.activeElement;
      setQuakeRestoreOrigin(
        origin instanceof HTMLElement && !isQuakeTerminalTarget(origin) ? origin : null,
      );
    }
  }, [machine]);
  return null;
}

/**
 * The quake launcher — one `<button>` in the top bar's right cluster that is
 * the same element in every state (desktop only; on mobile the quake
 * terminal's seam arm navigates to the operator window's terminal route and
 * nothing renders here). It is a launcher, not a compose: the compose docks
 * inside the drawer (the QuakeCompose strip in quake-terminal.tsx) and shares
 * the one compose seam in lib/quake-terminal.ts.
 *
 * Anatomy: the `◉` glyph with the resolved operator's live state dot, the
 * fixed label "Operator", the chord keycap, and a draft dot when the shared
 * compose draft is non-empty. `form` is the bar rung: `full`, `label` (keycap
 * dropped) or `glyph` (label dropped too; `aria-label` keeps the name). The
 * top bar's measured fit chooses it — this component never measures itself,
 * since a child whose width changes on its own would feed the fit probe a
 * moving width.
 *
 * Click: at rest it opens the drawer; while open it re-focuses the docked
 * textarea and never closes (Esc and click-away own the release — Escape is
 * not handled here, so a single Esc can never double-step; blur is not a
 * release either). It is latched (`aria-expanded`, inset well) while the
 * drawer is open, with the accent edge only while the docked compose owns
 * focus — chrome never claims focus it lacks. On the operator route it never
 * latches and focuses the page's compose strip instead.
 *
 * `data-quake-terminal` marks its click as quake-owned so it is not read as
 * an outside click that collapses the drawer, and the route terminals'
 * document-level file-paste forward skips it. `probe` marks the top bar's
 * inert measurement copy, which drops the test ids so the live button stays
 * the only match.
 */
export function QuakeLauncher({
  routeServer,
  routeWindow,
  form = "full",
  probe = false,
}: LauncherProps & { form?: LauncherForm; probe?: boolean }) {
  const isMobile = useIsMobile();
  const machine = useQuakeMachineState();
  const engaged = useQuakeComposeEngaged();
  const { agentState, noOperator, hasDraft, chord, onOperatorRoute, activate } = useQuakeLauncher({
    routeServer,
    routeWindow,
  });

  if (isMobile) return null;

  const latched = machine === "open" && !onOperatorRoute;
  const tip =
    `${noOperator ? "Start the operator" : "Ask the operator"}${chord ? ` (${chord})` : ""}` +
    (hasDraft ? " · unsent draft" : "");
  const testId = (id: string) => (probe ? undefined : id);

  return (
    <Tip label={tip}>
      <button
        type="button"
        data-quake-terminal=""
        data-testid={testId("quake-launcher")}
        aria-label={form === "glyph" ? "Operator" : undefined}
        aria-expanded={onOperatorRoute ? undefined : latched}
        onClick={activate}
        className={`${controlClass({
          variant: "icon",
          box: "height",
          pressed: latched,
          rest: LAUNCHER_REST,
          className: LAUNCHER_BASE,
        })}${latched && engaged ? ` ${LAUNCHER_ENGAGED_EDGE}` : ""}`}
      >
        <OperatorStateGlyph agentState={agentState} dotTestId={probe ? null : undefined} />
        {form !== "glyph" && <span>Operator</span>}
        {form === "full" && chord && (
          <kbd
            aria-hidden="true"
            className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-text-secondary"
          >
            {chord}
          </kbd>
        )}
        {hasDraft && (
          <span
            aria-hidden="true"
            data-testid={testId("quake-launcher-draft")}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-primary"
          />
        )}
      </button>
    </Tip>
  );
}
