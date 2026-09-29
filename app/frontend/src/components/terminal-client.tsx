import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ProgressAddon } from "@xterm/addon-progress";
import { useEffect, useRef, useCallback, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useOptionalToast } from "@/components/toast";
import { useChromeState, useChromeDispatch } from "@/contexts/chrome-context";
import { useFocusedTerminal } from "@/contexts/focused-terminal-context";
import { deriveXtermTheme } from "@/themes";
import { dispatchComposeStripAttach } from "@/lib/compose-strip-events";
import { isQuakeTerminalTarget } from "@/lib/quake-terminal";
import { copyToClipboard } from "@/lib/clipboard";
import { notifyFirstWrite } from "@/lib/window-transition";
import { relayMux, type RelayStream } from "@/lib/relay-mux";
import { shouldRefuseTerminalChord } from "@/lib/keybindings";
import { createGestureArm, createWheelAccumulator } from "@/lib/zoom-gesture";
import {
  installTerminalVisibilityShim,
  type TerminalVisibilityShim,
} from "@/lib/terminal-visibility";
import { useKeybindings } from "@/hooks/use-keybindings";
import { evaluateMediaQuery } from "@/hooks/use-media-query";
import { COARSE_POINTER_QUERY } from "@/hooks/use-coarse-pointer";
import { evaluateIsMobile } from "@/hooks/use-is-mobile";

/**
 * Device-split scrollback defaults for the xterm Terminal when the `scrollback`
 * prop is absent (the terminal-font-size mount-time device rule — narrow width
 * OR coarse pointer counts as mobile). 25k covers a heavy agent session
 * (measured at ~19k–31k rendered lines); 10k bounds mobile memory. Boards opt
 * down explicitly via the prop — they mount many live terminals as previews.
 */
export const SCROLLBACK_DESKTOP = 25_000;
export const SCROLLBACK_MOBILE = 10_000;

function deviceDefaultScrollback(): number {
  return evaluateIsMobile() ? SCROLLBACK_MOBILE : SCROLLBACK_DESKTOP;
}

/**
 * The xterm theme for one instance. The `transparent` variant drops the opaque
 * background so a translucent surface behind the terminal (the quake
 * terminal's glass drawer) shows through the cells — it only takes effect with
 * `allowTransparency` set at construction, and needs the container's
 * `rk-terminal-transparent` class alongside it (globals.css): xterm.css
 * hardcodes an opaque black `.xterm-viewport` that the theme never overrides.
 *
 * The value MUST be alpha-zero HEX, never the `transparent` keyword: xterm's
 * color parser accepts only #hex/rgb()/rgba() forms and throws "Unsupported
 * css format" on keywords — the ThemeService swallows the throw and falls
 * back to OPAQUE BLACK, which it also writes inline onto
 * `.xterm-scrollable-element` (an inline style no stylesheet override can
 * reach), so the keyword silently defeats the whole variant.
 */
export const TRANSPARENT_XTERM_BG = "#00000000";

function effectiveXtermTheme(palette: Parameters<typeof deriveXtermTheme>[0], transparent: boolean) {
  const theme = deriveXtermTheme(palette);
  return transparent ? { ...theme, background: TRANSPARENT_XTERM_BG } : theme;
}

/**
 * Minimum whitespace-trimmed length an OSC 52 payload must have to reach the
 * system clipboard. tmux's default `MouseDragEnd1Pane → copy-pipe-and-cancel`
 * (with `set-clipboard on`) turns a one-cell pointer jitter on a focus-click
 * into a drag that copies exactly one character (over text) or exactly one
 * space (over a blank row) — clobbering the clipboard the user just filled in
 * another tab. Two-character tokens (`rk`, `-v`, `..`) are legitimate copies,
 * so this threshold MUST NOT exceed 2. Measurement only: a payload that passes
 * is written verbatim, untrimmed.
 */
export const OSC52_MIN_COPY_LENGTH = 2;

/**
 * Custom ClipboardProvider for the xterm.js ClipboardAddon.
 * Accepts both "" (empty/default) and "c" (explicit clipboard) as valid OSC 52
 * selection targets. Tmux sends "" by default; the built-in provider only accepts "c".
 * Writes below OSC52_MIN_COPY_LENGTH (trimmed) are dropped silently.
 *
 * navigator.clipboard is undefined on plain-http non-localhost origins (e.g. a
 * Tailscale IP), so writes route through copyToClipboard (execCommand fallback,
 * never throws) and reads degrade to "" — there is no read fallback.
 */
export const clipboardProvider = {
  async readText(selection: string): Promise<string> {
    if (selection !== "c" && selection !== "") return "";
    if (!navigator.clipboard) return "";
    return navigator.clipboard.readText();
  },
  async writeText(selection: string, text: string): Promise<void> {
    if (selection !== "c" && selection !== "") return;
    if (text.trim().length < OSC52_MIN_COPY_LENGTH) return;
    await copyToClipboard(text);
  },
};

/**
 * Test-only terminal registry. The echo-latency e2e harness needs a handle to
 * the live `Terminal` instance to poll `term.buffer.active` for the echoed
 * glyph (the WebGL canvas is not DOM-readable). We expose instances on
 * `window.__rkTerminals`, keyed by windowId, so a Playwright `page.evaluate`
 * can reach them. Kept tiny and symmetric (register on create, unregister on
 * dispose) so a stale handle never points at a disposed terminal.
 *
 * Gated on `import.meta.env.DEV`: this is populated ONLY in dev/e2e builds
 * (Vite's dev server, which is what `just dev` / the e2e harness run against),
 * never in a production `vite build`. So production bundles do not expose live
 * Terminal instances on `window` at all — the helpers compile to no-ops there.
 */
declare global {
  interface Window {
    __rkTerminals?: Record<string, import("@xterm/xterm").Terminal>;
    /** Active renderer per windowId — "webgl" until a context-loss demotes it. */
    __rkRenderer?: Record<string, "webgl" | "canvas">;
  }
}

function registerTestTerminal(windowId: string, terminal: import("@xterm/xterm").Terminal) {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  (window.__rkTerminals ??= {})[windowId] = terminal;
}

function unregisterTestTerminal(windowId: string) {
  if (!import.meta.env.DEV || typeof window === "undefined" || !window.__rkTerminals) return;
  delete window.__rkTerminals[windowId];
}

/** Record which renderer is live for `windowId` (read by the latency harness). */
function setActiveRenderer(windowId: string, renderer: "webgl" | "canvas") {
  if (typeof window === "undefined") return;
  (window.__rkRenderer ??= {})[windowId] = renderer;
}

function unsetActiveRenderer(windowId: string) {
  if (typeof window === "undefined" || !window.__rkRenderer) return;
  delete window.__rkRenderer[windowId];
}

/** Toast text on the first WebGL context loss of a page load. */
export const WEBGL_FALLBACK_TOAST =
  "Terminal GPU rendering lost — using the slower DOM renderer";

/**
 * Live xterm instances on this page: every TerminalClient that finished init
 * and has not unmounted holds a `__rkRenderer` entry. Chromium caps WebGL
 * contexts at 16 per page and evicts the oldest, so this count at the moment
 * of a loss is what separates "context budget" from "GPU reset".
 */
function mountedTerminalCount(): number {
  if (typeof window === "undefined" || !window.__rkRenderer) return 0;
  return Object.keys(window.__rkRenderer).length;
}

/**
 * Once per page load: a board or hidden-tile set losing many contexts at once
 * is one event to the user, while the console keeps the per-event count.
 */
let webglFallbackToastShown = false;

/** Test seam only — production code never re-arms the one-shot toast. */
export function resetWebglFallbackNoticeForTests(): void {
  webglFallbackToastShown = false;
}

type WebglFallbackKind = "context-loss" | "unavailable";

type FallbackToast = {
  addToast: (message: string, variant?: "error" | "info") => void;
} | null;

/**
 * The fallback is announced, not fixed: the DOM renderer roughly doubles
 * renderer CPU, and how often real hardware lands there is the number a fix
 * would be sized on. The `rk: xterm WebGL` prefix, the `{server}/{windowId}`
 * pair and the `(N terminal(s) mounted)` suffix are the greppable contract.
 *
 * Only a RUNTIME loss toasts: a host with no WebGL at all (software-rendered
 * headless Chromium) would otherwise raise an alert on every page load.
 */
function reportWebglFallback(
  kind: WebglFallbackKind,
  server: string,
  windowId: string,
  toast: FallbackToast,
): void {
  const n = mountedTerminalCount();
  const what = kind === "context-loss" ? "context lost" : "unavailable at load";
  console.warn(
    `rk: xterm WebGL ${what} for ${server}/${windowId} — using the DOM renderer (${n} terminal${n === 1 ? "" : "s"} mounted)`,
  );
  if (kind !== "context-loss" || webglFallbackToastShown) return;
  webglFallbackToastShown = true;
  toast?.addToast(WEBGL_FALLBACK_TOAST, "info");
}

/**
 * The muxed relay adapter surfaced through `wsRef` is WebSocket-shaped but adds
 * a dedicated `resize(cols, rows)` op so terminal-grid resizes travel on their
 * OWN channel — NOT muxed into `send()`, which carries raw terminal input
 * (keystrokes, SGR scroll, pasted text). Sniffing `send()` payloads for a
 * `{type:"resize"}` shape would let a paste that happens to contain that JSON be
 * swallowed as a resize instead of reaching the PTY. Optional so a plain
 * `WebSocket` (pre-mux / tests) still satisfies the type; `fitAndSync` falls
 * back to the JSON control frame when `resize` is absent.
 */
type ResizableSocket = WebSocket & {
  resize?: (cols: number, rows: number) => void;
};

type TerminalClientProps = {
  sessionName: string;
  windowId: string;
  server: string;
  wsRef: React.MutableRefObject<WebSocket | null>;
  onSessionNotFound?: () => void;
  focusRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Imperative addon seams for the tile layer (the focusRef convention:
   * filled at init when provided, nulled on cleanup). The addons load
   * passively for every terminal; these refs are how a consumer drives
   * find-in-terminal (search) and buffer export (serialize).
   */
  searchAddonRef?: React.MutableRefObject<SearchAddon | null>;
  serializeAddonRef?: React.MutableRefObject<SerializeAddon | null>;
  /**
   * The live `Terminal` instance itself (same fill/null lifecycle as the
   * addon refs above). Buffer-walk consumers (export transcript/visible-copy)
   * need `terminal.buffer`, which no addon seam exposes.
   */
  terminalRef?: React.MutableRefObject<Terminal | null>;
  /**
   * Fires with the progress addon's tracked OSC 9;4 state on every change.
   * The scaffold does no throttling or rendering — consumers own both.
   */
  onProgressChange?: (state: number, value: number) => void;
  /**
   * When `true`, this terminal's inbound data frames report the window-switch
   * first-write receipt (`notifyFirstWrite`) that releases the route's slide
   * gate and lifts its spinner mask. The receipt is module-global, so exactly
   * ONE terminal may report it: the terminal route's primary tty tile. Board
   * panes, duplicate tty tiles, and the quake terminal leave it unset — their
   * output must never confirm a switch of the window they are not showing.
   */
  switchReceiptSource?: boolean;
  /**
   * When `true`, a same-session `windowId` change arms the deferred buffer
   * clear (`terminal.clear()` before the first post-switch chunk). The route
   * passes it only for a UI-initiated switch, where the URL changes BEFORE
   * tmux redraws. On a tmux/SSE-driven switch the attached client has already
   * painted the new window by the time the URL follows, so arming the clear
   * then would wipe that content on its next chunk — those rides leave the
   * buffer alone (the old window's rows stay in scrollback).
   */
  clearOnRide?: boolean;
  scrollLocked?: boolean;
  /**
   * Lines of scrollback on the xterm buffer. Absent → device-split default
   * (`SCROLLBACK_MOBILE`/`SCROLLBACK_DESKTOP` by the narrow-width-OR-coarse
   * rule, resolved at Terminal construction). Boards pass an explicit small
   * value — they mount many live terminals as preview surfaces.
   */
  scrollback?: number;
  /**
   * When `true`, the terminal renders see-through: xterm `allowTransparency`
   * plus a transparent theme background, so a translucent SURFACE behind the
   * terminal (the quake terminal's glass drawer) shows through the cells.
   * Opt-in per instance — route/board terminals keep the opaque theme
   * background and pay no renderer cost.
   */
  transparent?: boolean;
  /**
   * When `true` (default), this terminal registers itself as the focused
   * terminal on mount so the shell-level BottomBar targets it. Set to
   * `false` for board panes — BoardPane handles registration based on its
   * own focused-pane state so multiple TerminalClients in a board don't
   * fight over the focused-terminal slot.
   */
  registerFocus?: boolean;
  /**
   * When `true`, this terminal's relay stream opens with `isolate: true` —
   * the backend attaches an isolated session so the stream shares no
   * sizing/state with the home tab's own attach. Set only by a foreign
   * (cross-tab) tty tile; bare home-tab streams omit it. Fixed for the
   * mount's lifetime (a tile retargeting remounts).
   */
  isolate?: boolean;
  /**
   * When `true`, this terminal's tile is display-hidden (P3
   * hide-never-unmount): the terminal stays mounted and streaming but must
   * not render. It is xterm's render-pause signal, delivered through the
   * visibility shim installed around `open()` (ANDed with `document.hidden`
   * inside the shim) — `lib/terminal-visibility.ts` explains why xterm's own
   * IntersectionObserver cannot be used. Boards omit it: a paused board pane
   * unmounts its TerminalClient outright.
   */
  hidden?: boolean;
};

export function TerminalClient({
  sessionName,
  windowId,
  server,
  wsRef,
  onSessionNotFound,
  focusRef,
  searchAddonRef,
  serializeAddonRef,
  terminalRef: terminalSeamRef,
  onProgressChange,
  switchReceiptSource = false,
  clearOnRide = false,
  scrollLocked,
  scrollback,
  transparent = false,
  registerFocus = true,
  isolate = false,
  hidden = false,
}: TerminalClientProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  // The component's root wrapper div — registered as the focused terminal's
  // `containerRef` (the element whose box visually IS the pane).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const { theme: activeTheme } = useTheme();
  const { terminalFontSize, composeStripEnabled } = useChromeState();
  const { toggleComposeStrip, increaseTerminalFont, decreaseTerminalFont } = useChromeDispatch();
  const { setFocused } = useFocusedTerminal();

  // App-owned chords (260730-g40a): the custom key handler below consults the
  // effective keybinding registry through this render-updated ref (the handler
  // attaches once at terminal init, but overrides can change at any time).
  // The host platform feeds the seam's mac-only ⌘-tier refusal (260730-n789);
  // it is immutable per page load but ref-mirrored for the same
  // attach-once reason.
  const { bindings: appKeybindings, host: keybindingHost } = useKeybindings();
  const appKeybindingsRef = useRef(appKeybindings);
  appKeybindingsRef.current = appKeybindings;
  const keybindingPlatformRef = useRef(keybindingHost.platform);
  keybindingPlatformRef.current = keybindingHost.platform;

  // The progress addon registers its onChange once at terminal init, but the
  // callback prop can change on any render — same attach-once reason as the
  // keybinding refs above.
  const onProgressChangeRef = useRef(onProgressChange);
  onProgressChangeRef.current = onProgressChange;
  // The init effect installs the visibility shim around open() (mount-only),
  // so the hidden prop is read through this render-mirrored ref there; changes
  // after mount flow through the dedicated effect below.
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const visibilityShimRef = useRef<TerminalVisibilityShim | null>(null);
  // Provider-optional: isolated mounts (tests) degrade to no toast. Mirrored
  // into a ref so the init effect's dependency list stays unchanged.
  const toast = useOptionalToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Register this terminal as the BottomBar's focused input target. The
  // single-terminal route trivially has only one terminal — this is the
  // explicit form of the focus relationship that previously was implicit
  // through prop drilling. On unmount we clear so a stale ref isn't read
  // by a subsequent route's BottomBar before its own TerminalClient mounts.
  // BoardPane passes `registerFocus={false}` and handles registration itself
  // based on its focused-pane state.
  useEffect(() => {
    if (!registerFocus) return;
    setFocused({ wsRef, containerRef, server, session: sessionName, windowId });
    return () => {
      setFocused(null);
    };
  }, [registerFocus, setFocused, wsRef, server, sessionName, windowId]);

  // Refit the terminal to its container and tell tmux the new grid size. The
  // resize message is the ONLY way the backend learns the new cols/rows, so
  // every fit() must be paired with it — otherwise tmux keeps rendering at the
  // old grid (stale columns, dead space) until a remount. Used by both the
  // container ResizeObserver and the font-size effect.
  const fitAndSync = useCallback(() => {
    fitAddonRef.current?.fit();
    xtermRef.current?.scrollToBottom();
    const term = xtermRef.current;
    const ws = wsRef.current as ResizableSocket | null;
    if (ws?.readyState === WebSocket.OPEN && term) {
      // Prefer the adapter's dedicated resize op — resizes must NOT share the
      // `send()` input channel (a paste containing resize JSON would be
      // swallowed). Fall back to the JSON control frame only for a plain
      // WebSocket that lacks `resize` (pre-mux / tests).
      if (ws.resize) {
        ws.resize(term.cols, term.rows);
      } else {
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      }
    }
  }, [wsRef]);

  // Forward dropped/pasted files to the docked compose strip. The strip owns
  // the upload (scoped to the live focused target's worktree) and its own
  // draft/attachment state — terminal-client only enables the strip preference
  // (if off) and hands off the raw files. This replaces the old
  // upload-then-open-modal flow.
  const attachToStrip = useCallback(
    (files: FileList) => {
      if (files.length === 0) return;
      if (!composeStripEnabled) toggleComposeStrip();
      dispatchComposeStripAttach(Array.from(files));
    },
    [composeStripEnabled, toggleComposeStrip],
  );

  // Clipboard paste interception for file upload
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      // File pastes originating inside the quake terminal belong to the
      // quake terminal's own upload path — forwarding them to the strip would upload
      // to the ROUTE's focused target (the tab below the quake terminal). Text paste
      // is untouched everywhere (no files on the clipboard).
      if (isQuakeTerminalTarget(e.target)) return;
      e.preventDefault();
      attachToStrip(files);
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [attachToStrip]);

  // Drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      // Drops landing on the quake terminal's embedded terminal belong to the
      // quake terminal root's own drop handler (the event bubbles to it) — the strip
      // forward would upload to the route's focused target instead. The
      // drag-over highlight still clears: no dragleave follows a drop.
      // preventDefault precedes the quake terminal early-return: blocking the
      // browser's default drop action (URL/text navigation) must not depend
      // on the drop bubbling to the quake terminal root.
      setDragOver(false);
      e.preventDefault();
      if (isQuakeTerminalTarget(e.currentTarget)) return;
      const files = e.dataTransfer.files;
      if (files.length === 0) return;
      attachToStrip(files);
    },
    [attachToStrip],
  );

  // xterm.js init — mount only, creates terminal instance and resize observer.
  // WebSocket connection is handled by the separate effect below.
  useEffect(() => {
    let cancelled = false;
    let terminal: import("@xterm/xterm").Terminal | null = null;
    let resizeRafId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function init() {
      if (!terminalRef.current) return;

      // Effective font size from ChromeContext (stored preference, else the
      // device default). Read at mount; subsequent changes are applied by the
      // dedicated terminalFontSize effect below (this init effect is mount-only).
      const fontPx = terminalFontSize;

      // Ensure the bundled webfont is loaded before xterm measures cell
      // dimensions. xterm.js measures once at open() and does not re-measure
      // when fonts arrive later, so fallback metrics would persist as
      // misaligned glyphs. Load all three weights concurrently, but do not
      // block terminal startup indefinitely if the FontFaceSet API is
      // unavailable or a font request stalls (e.g., proxy blackholes .woff2).
      if (typeof document.fonts?.load === "function") {
        const FONT_LOAD_TIMEOUT_MS = 3000;
        const fontLoads = Promise.all([
          document.fonts.load(`${fontPx}px "MonaspiceNe Nerd Font Mono"`),
          document.fonts.load(`bold ${fontPx}px "MonaspiceNe Nerd Font Mono"`),
          document.fonts.load(`italic ${fontPx}px "MonaspiceNe Nerd Font Mono"`),
        ]);
        const timeout = new Promise<void>((resolve) => {
          window.setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
        });
        // Proceed with the fallback font stack if font loading fails or stalls.
        await Promise.race([fontLoads, timeout]).catch(() => undefined);
      }

      // Component unmounted while awaiting font loads
      if (cancelled || !terminalRef.current) return;

      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"MonaspiceNe Nerd Font Mono", ui-monospace, monospace',
        fontSize: fontPx,
        // Mount-time device rule like fontPx — an explicit prop (boards) wins.
        scrollback: scrollback ?? deviceDefaultScrollback(),
        theme: effectiveXtermTheme(activeTheme.palette, transparent),
        allowTransparency: transparent,
        allowProposedApi: true,
        // The search addon's decorations tick the overview ruler only when it
        // has a width — without the option the ruler never renders.
        overviewRuler: { width: 14 },
        // Option/Alt is Meta, not a third-level shift. xterm's default (false)
        // lets macOS compose Option+letter into a glyph (Option+P → `π`) and
        // sends those bytes to the pty, so Meta-bound CLI keybindings never
        // fire. The tradeoff is deliberate: composing special characters inside
        // a pane loses to driving CLI agents. Matches the ESC-prefix convention
        // the bottom bar's `sendSpecial` already uses for synthetic Alt keys.
        macOptionIsMeta: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      // open() runs under the visibility shim so xterm never registers its
      // page-level IntersectionObserver (lib/terminal-visibility.ts owns the
      // why); the shim must be restored on every path out of open().
      const visibilityShim = installTerminalVisibilityShim(!hiddenRef.current);
      try {
        terminal.open(terminalRef.current);
      } finally {
        visibilityShim.restore();
      }
      visibilityShimRef.current = visibilityShim;
      fitAddon.fit();
      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // (The test-only registry is keyed on `windowId`, which can change while
      // this terminal stays mounted — see the dedicated effect below, which
      // re-keys register/unregister on windowId so the registry never goes
      // stale. The init effect deliberately does NOT register here.)

      // Clipboard addon — enriched clipboard support
      terminal.loadAddon(new ClipboardAddon(undefined, clipboardProvider));

      // Clickable URLs. The explicit handler matters: the addon's default
      // opens a blank window and assigns location.href — inside the desktop
      // shell that surfaces as "about:blank" (denied, link dead). Passing the
      // URI through window.open keeps browser behavior identical and lets the
      // shell's setWindowOpenHandler see the real URL and route it externally.
      terminal.loadAddon(
        new WebLinksAddon((_event, uri) => {
          window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );

      // xterm defaults to Unicode 6 width tables, but tmux lays out its buffer
      // using wcwidth (Unicode 14/15). Without this addon, emojis tmux treats
      // as 2 cells wide land in 1-cell slots and subsequent glyphs overlap.
      // Must load before WebGL so the renderer measures cells against the
      // correct table on first paint.
      terminal.loadAddon(new UnicodeGraphemesAddon());
      terminal.unicode.activeVersion = "15-graphemes";

      // Search/serialize load passively — nothing here invokes them; the tile
      // layer drives them through the searchAddonRef/serializeAddonRef seams.
      const searchAddon = new SearchAddon();
      terminal.loadAddon(searchAddon);
      if (searchAddonRef) searchAddonRef.current = searchAddon;
      const serializeAddon = new SerializeAddon();
      terminal.loadAddon(serializeAddon);
      if (serializeAddonRef) serializeAddonRef.current = serializeAddon;
      if (terminalSeamRef) terminalSeamRef.current = terminal;

      // Progress is a passive OSC 9;4 stream parser. Its onChange payload is
      // an { state, value } object — adapted to the two-arg prop so consumers
      // never import the addon's types.
      const progressAddon = new ProgressAddon();
      terminal.loadAddon(progressAddon);
      progressAddon.onChange(({ state, value }) => {
        onProgressChangeRef.current?.(state, value);
      });

      // GPU-accelerated rendering (silent fallback to canvas). The module is
      // statically imported (resolved at chunk load), but WebGL context
      // creation can still throw at runtime — keep the guard around it.
      //
      // Two robustness additions over a bare load:
      //  1. Record the active renderer ("webgl" | "canvas") on a window hook so
      //     the latency harness can ASSERT WebGL is live — a silent canvas
      //     fallback renders slower, and without this we'd never know it
      //     happened (the whole point of the latency work is to not regress
      //     blind).
      //  2. Handle `onContextLoss`: a WebGL context can be lost AFTER successful
      //     creation (tab backgrounding, GPU reset, driver hiccup). When that
      //     happens the addon stops painting and the terminal FREEZES unless we
      //     dispose it — disposing drops xterm back to its DOM/canvas renderer,
      //     which keeps working. Correctness, not latency.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // Drop to the fallback renderer so output keeps flowing.
          try { webgl.dispose(); } catch { /* already disposing */ }
          setActiveRenderer(windowId, "canvas");
          reportWebglFallback("context-loss", server, windowId, toastRef.current);
        });
        terminal.loadAddon(webgl);
        setActiveRenderer(windowId, "webgl");
      } catch {
        // canvas renderer continues working
        setActiveRenderer(windowId, "canvas");
        reportWebglFallback("unavailable", server, windowId, toastRef.current);
      }

      // Keyboard input → current WebSocket (wsRef always points to latest)
      terminal.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN)
          wsRef.current.send(data);
      });

      // Cmd+C / Ctrl+C: copy selection instead of sending SIGINT
      // Local const narrows the type for the closure (outer `terminal` is T | null).
      const term = terminal;
      term.attachCustomKeyEventHandler((event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "c" &&
          event.type === "keydown"
        ) {
          if (term.hasSelection()) {
            const text = term.getSelection();
            void copyToClipboard(text).finally(() => {
              term.clearSelection();
            });
            return false;
          }
        }
        // App-owned chords (260730-g40a / 260730-n789): a keydown matching an
        // ENABLED registry binding on an app-owned tier is refused here
        // (`false` = xterm must not handle or transmit it). xterm does not
        // preventDefault a refused key, so the event bubbles to the
        // window-level dispatcher, which fires the action even while the
        // terminal owns focus. The refusal rule lives in
        // `shouldRefuseTerminalChord`: shifted-tier matches on every platform
        // (legacy TTY encoding cannot distinguish Ctrl+Shift+letter from
        // Ctrl+letter, so xterm would emit the Ctrl-char), plus — on macOS
        // only — cmd-tier matches pressed with metaKey (⌘ chords are never
        // pane bytes). Plain-Ctrl chords (Ctrl+W delete-word, Ctrl+L clear,
        // Ctrl+T fzf, Ctrl+[ ESC) always reach the pane on every platform —
        // refusing a plain-Ctrl cmd-tier alias would steal them.
        if (
          event.type === "keydown" &&
          shouldRefuseTerminalChord(
            event,
            appKeybindingsRef.current,
            keybindingPlatformRef.current,
          )
        ) {
          return false;
        }
        return true;
      });

      resizeObserver = new ResizeObserver(() => {
        if (cancelled) return;
        if (resizeRafId) cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(() => {
          if (cancelled) return;
          resizeRafId = null;
          fitAndSync();
        });
      });

      // Guard against unmount during terminal setup. The addon section above is
      // now synchronous (static imports), so this single post-construction check
      // before setTerminalReady disposes a terminal orphaned by an unmount that
      // raced the font-load await.
      if (cancelled || !terminalRef.current) {
        try { terminal.dispose(); } catch { /* WebGL addon may throw during teardown */ }
        return;
      }

      resizeObserver.observe(terminalRef.current);
      if (focusRef) focusRef.current = () => xtermRef.current?.focus();
      setTerminalReady(true);
    }

    init();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      // Close any active WS on true unmount
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (focusRef) focusRef.current = null;
      if (searchAddonRef) searchAddonRef.current = null;
      if (serializeAddonRef) serializeAddonRef.current = null;
      if (terminalSeamRef) terminalSeamRef.current = null;
      // Note: __rkTerminals register/unregister moved to the dedicated
      // windowId-keyed effect below. __rkRenderer is set at WebGL-load time in
      // this init effect, so its cleanup stays here.
      unsetActiveRenderer(windowId);
      xtermRef.current = null;
      fitAddonRef.current = null;
      visibilityShimRef.current?.dispose();
      visibilityShimRef.current = null;
      try { terminal?.dispose(); } catch { /* WebGL addon may throw during teardown */ }
      setTerminalReady(false);
    };
  }, [wsRef, focusRef, searchAddonRef, serializeAddonRef, terminalSeamRef]);

  // Tile visibility drives xterm's render pause through the shim installed at
  // open() (see init): a display-hidden terminal keeps streaming but must not
  // render. Mount order guarantees the shim exists before this effect can
  // observe a hidden≠initial transition; before init lands it is a no-op and
  // the shim's initial state (set from the mount-time prop) already holds.
  useEffect(() => {
    visibilityShimRef.current?.setLocallyVisible(!hidden);
  }, [hidden]);

  // Apply terminal-font CHANGES to the live xterm instance. The font size lives
  // in ChromeContext (global, all terminals react), so when the user steps or
  // resets it, set the option then fitAndSync so xterm recomputes rows×cols AND
  // tells tmux the new grid — a font change does NOT resize the container, so
  // the ResizeObserver never fires; without the explicit sync tmux would keep
  // rendering at the old grid (stale columns, dead space) until a remount.
  //
  // Skips the first run after (re)mount: the init effect already constructs the
  // terminal at the current size and fits it, so re-fitting + re-sending resize
  // here would be redundant (and would fire before the WebSocket is open). Only
  // an actual post-mount change of `terminalFontSize` needs this path.
  const lastAppliedFontSize = useRef<number | null>(null);
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (lastAppliedFontSize.current === terminalFontSize) return;
    const isFirstRun = lastAppliedFontSize.current === null;
    lastAppliedFontSize.current = terminalFontSize;
    if (isFirstRun) return; // init effect already applied the mount-time size
    term.options.fontSize = terminalFontSize;
    fitAndSync();
  }, [terminalFontSize, terminalReady, fitAndSync]);

  // Test-only registry, keyed on the CURRENT windowId. The init effect runs
  // mount-only (deps are all stable ref objects), but `windowId` can change while this
  // component stays mounted (it is rendered without a `key` in app.tsx, so a
  // window switch re-renders rather than remounts). Registering here — keyed on
  // [terminalReady, windowId] — re-keys the entry on every switch and cleans up
  // the OLD id before adding the new one, so `window.__rkTerminals` never holds
  // a stale handle. The echo-latency harness reads this to poll
  // `term.buffer.active` (the WebGL canvas is not DOM-readable). Inert in normal
  // use — nothing reads the registry unless a test driver does.
  useEffect(() => {
    if (!terminalReady || !xtermRef.current) return;
    registerTestTerminal(windowId, xtermRef.current);
    return () => unregisterTestTerminal(windowId);
  }, [terminalReady, windowId]);

  // Always-on coarse-pointer contextmenu gate (NOT scroll-lock-gated): xterm
  // has two element-level focus paths, and this one bypasses the synthetic-
  // click chain entirely — "contextmenu" → rightClickHandler →
  // moveTextAreaUnderMouseCursor, which WebKit's long-press recognizer can
  // fire during a slow scroll drag. A long-press is never a deliberate focus
  // request on touch (right-click has no touch meaning), so the suppression
  // applies in BOTH locked and unlocked states. The React onContextMenu
  // preventDefault on this container is root-delegated (bubble phase), so it
  // runs AFTER xterm's own listener has already moved and focused the
  // textarea; a capture-phase listener on the container runs BEFORE xterm's
  // element listeners, so stopping the event here is what actually prevents
  // the focus. mousedown stays out of this effect deliberately — it is the
  // deliberate tap's focus path and is gated on scroll-lock below.
  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;

    // Coarse-pointer only, evaluated PER EVENT (not at effect setup): the
    // preference persists and the primary pointer can change mid-session, so
    // a setup-time snapshot could strand the suppression on or off.
    const coarse = () => evaluateMediaQuery(COARSE_POINTER_QUERY);

    function suppressContextMenu(e: Event) {
      if (!coarse()) return;
      e.preventDefault();
      e.stopPropagation();
    }

    container.addEventListener("contextmenu", suppressContextMenu, { capture: true });
    return () => {
      container.removeEventListener("contextmenu", suppressContextMenu, { capture: true });
    };
  }, []);

  // Scroll-lock: prevent xterm textarea from gaining focus when locked.
  // Instead of reactively blurring on focusin (which disrupts active touch
  // sequences and can corrupt xterm.js internal state), we preventDefault()
  // on touchend to suppress the synthetic mousedown → focusin → click chain.
  // touchstart/touchmove still fire normally so SGR scroll keeps working.
  //
  // touchend suppression alone is not enough: xterm has two element-level
  // focus paths. The contextmenu path (long-press → rightClickHandler →
  // moveTextAreaUnderMouseCursor) is covered by the always-on coarse gate
  // above, in every lock state. mousedown capture closes the second path
  // (xterm's mousedown handler calls focus()) against any synthetic-mouse
  // delivery the touchend preventDefault didn't cover — and stays
  // lock-gated because mousedown IS the deliberate tap's focus path.
  useEffect(() => {
    if (!scrollLocked) return;
    const container = terminalRef.current;
    if (!container) return;

    // Coarse-pointer only, evaluated PER EVENT (not at effect setup): the
    // preference persists and the primary pointer can change mid-session, so
    // a setup-time snapshot could strand the suppression on (fine pointer,
    // no unlock chip rendered) or off (device turned coarse after lock).
    const coarse = () => evaluateMediaQuery(COARSE_POINTER_QUERY);

    function onTouchEnd(e: TouchEvent) {
      if (!coarse()) return;
      e.preventDefault();
    }

    function suppress(e: Event) {
      if (!coarse()) return;
      e.preventDefault();
      e.stopPropagation();
    }

    // Backstop for focus paths the suppressors don't cover: while locked, any
    // focus landing inside xterm is immediately blurred — a flicker instead
    // of a stuck keyboard. Scoped to locked state, so the disruption the
    // comment above warns about cannot affect normal (unlocked) use.
    function onFocusIn(e: FocusEvent) {
      if (!coarse()) return;
      const target = e.target;
      if (target instanceof HTMLElement && target.closest(".xterm")) {
        target.blur();
      }
    }

    container.addEventListener("touchend", onTouchEnd, { capture: true });
    container.addEventListener("mousedown", suppress, { capture: true });
    container.addEventListener("focusin", onFocusIn, { capture: true });
    return () => {
      container.removeEventListener("touchend", onTouchEnd, { capture: true });
      container.removeEventListener("mousedown", suppress, { capture: true });
      container.removeEventListener("focusin", onFocusIn, { capture: true });
    };
  }, [scrollLocked]);

  // Ctrl/Cmd+wheel and touchpad-pinch zoom gestures (260823-cwvv R7): step
  // the GLOBAL terminal font preference through the ChromeContext steppers
  // (the same seam the palette actions ride — every mounted terminal reacts;
  // the font-change effect below owns the xterm refit). Capture phase runs
  // before xterm's own wheel handling so preventDefault blocks browser page
  // zoom; ONLY ctrl/meta-modified wheel and Safari gesture* events are
  // intercepted — an unmodified wheel passes through to xterm untouched, and
  // the touch-scroll-to-tmux handler below is unaffected (it reads
  // single-touch moves, not wheel).
  const fontStepRef = useRef({ increaseTerminalFont, decreaseTerminalFont });
  fontStepRef.current = { increaseTerminalFont, decreaseTerminalFont };
  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;
    const feed = createWheelAccumulator();
    const arm = createGestureArm();
    const step = (steps: number) => {
      const { increaseTerminalFont: up, decreaseTerminalFont: down } = fontStepRef.current;
      for (let i = 0; i < Math.abs(steps); i++) (steps > 0 ? up : down)();
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      step(feed(e.deltaY));
    };
    // Safari's gesture* events are non-standard — defensive scale read.
    const onGestureStart = () => arm.reset();
    const onGestureChange = (e: Event) => {
      const scale = (e as { scale?: unknown }).scale;
      if (typeof scale !== "number") return;
      e.preventDefault();
      step(arm.change(scale));
    };
    container.addEventListener("wheel", onWheel, { passive: false, capture: true });
    container.addEventListener("gesturestart", onGestureStart);
    container.addEventListener("gesturechange", onGestureChange);
    return () => {
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("gesturestart", onGestureStart);
      container.removeEventListener("gesturechange", onGestureChange);
    };
  }, [terminalReady]);

  // Mobile touch-to-scroll: translate vertical swipe gestures into SGR mouse
  // wheel escape sequences sent to tmux via WebSocket.
  //
  // No overlay/proxy needed — we listen for touchmove directly on the terminal
  // container in the capture phase. touch-action: none on the container ensures
  // iOS delivers all touchmove events to JS. Taps naturally reach xterm.js for
  // keyboard focus since there's no overlay blocking them.
  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;

    // Only on touch devices — desktop uses native mouse wheel via xterm.js
    const isTouch = evaluateMediaQuery(COARSE_POINTER_QUERY);
    if (!isTouch) return;

    let startY = 0;
    let accumulatedDelta = 0;

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      accumulatedDelta = 0;
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const currentY = e.touches[0].clientY;
      const dy = startY - currentY; // positive = swiped up
      accumulatedDelta += dy;
      startY = currentY;

      // Read the font size live — it can change at runtime via the terminal-font
      // control, and this effect is not torn down on a font change (deps below
      // are mount-stable), so capturing it at setup would go stale.
      const lineHeight = xtermRef.current?.options.fontSize ?? 13;
      const lines = Math.trunc(accumulatedDelta / lineHeight);
      if (lines === 0) return;
      accumulatedDelta -= lines * lineHeight;

      // SGR mouse encoding: \x1b[<button;col;rowM
      // button 64 = scroll up (older), 65 = scroll down (newer)
      // col/row must be valid terminal coordinates — tmux ignores 1;1.
      const term = xtermRef.current;
      const col = term ? Math.ceil(term.cols / 2) : 40;
      const row = term ? Math.ceil(term.rows / 2) : 12;
      // Swipe up (dy > 0, lines > 0) = see newer content = scroll down = 65
      // Swipe down (dy < 0, lines < 0) = see older content = scroll up = 64
      const button = lines > 0 ? 65 : 64;
      const seq = `\x1b[<${button};${col};${row}M`;
      const count = Math.abs(lines);
      let payload = "";
      for (let i = 0; i < count; i++) payload += seq;
      ws.send(payload);
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true, capture: true });
    return () => {
      container.removeEventListener("touchstart", onTouchStart, { capture: true });
      container.removeEventListener("touchmove", onTouchMove, { capture: true });
    };
  }, [terminalReady, wsRef]);

  // Update xterm theme when the app theme changes
  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.theme = effectiveXtermTheme(activeTheme.palette, transparent);
  }, [activeTheme, transparent]);

  // Keep a ref to windowId so the stream open op always reads the latest value
  // without the connect effect needing to be torn down/rebuilt — this is what
  // lets same-session window switches ride the existing stream. A same-session
  // ride also pushes the new windowId into the live stream via
  // stream.setWindowId (the effect below), so a later socket-level reconnect
  // re-issues `open` for the window the user is looking at NOW, not the one from
  // connect time (without it, RelayMux would re-open the STALE open-time window
  // and the server would SelectWindowInSession it, yanking the pane back).
  const windowIdRef = useRef(windowId);
  windowIdRef.current = windowId;
  // Read inside the connect effect's data handler without being one of its
  // deps (a role flip must never tear the stream down).
  const switchReceiptSourceRef = useRef(switchReceiptSource);
  switchReceiptSourceRef.current = switchReceiptSource;
  // Same discipline: the windowId effect reads it, never depends on it.
  const clearOnRideRef = useRef(clearOnRide);
  clearOnRideRef.current = clearOnRide;

  // The live RelayMux stream handle for the current connection. Held in a ref so
  // the same-session-ride effect below can update its re-open target without
  // being a dependency of (and thus re-running) the connect effect.
  const streamRef = useRef<RelayStream | null>(null);

  // Deferred buffer clear for a same-session ride. Armed by the windowId effect
  // below when a resolved same-session switch rides the live stream; consumed
  // once by the connect effect's `consumePendingClear()` immediately before the
  // first inbound chunk written after the change. Component-scoped (not
  // effect-scoped like `pendingReset`): the arming seam lives OUTSIDE the
  // connect effect — the ride's whole point is that the connect effect does
  // NOT re-run on a same-session windowId change.
  //
  // Why `clear()` and never `reset()` on a ride: tmux's in-place redraw
  // repaints the screen rows only, so without a clear the previous window's
  // screen lines would sit in xterm's scrollback and find-in-terminal / the ⇩
  // export would read mixed content. But `reset()` also resets terminal modes
  // (mouse reporting, bracketed paste, focus events) that tmux believes it
  // already set on this still-attached client and will not re-send — a fresh
  // attach re-sends them, an in-place switch does not. Deferring to the first
  // chunk keeps the no-blank-frame invariant (the old content persists until
  // the redraw paints in the same tick).
  const pendingClearRef = useRef(false);

  // Same-session windowId ride: keep the live stream's re-open target fresh.
  // The connect effect deliberately does NOT depend on windowId (a same-session
  // switch rides the existing stream — tmux moves the attached PTY's active
  // window in place), so this effect is the seam that tells RelayMux the new
  // windowId for reconnect purposes. A genuine identity change (cross-session /
  // server / loss) instead bumps connectionEpoch and re-opens a fresh stream,
  // which carries the current windowId at open time — so this call is redundant
  // (harmless) there and load-bearing only for the ride.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.setWindowId(windowId);
    // Arm the deferred buffer clear for the ride — only while a stream is live
    // AND the served session is resolved (an unresolved connection reconnects
    // instead: the identity watcher's windowId-based rule bumps the epoch) AND
    // the switch is UI-initiated (`clearOnRide`): a tmux-driven switch has
    // already redrawn the new window before the URL followed, so a clear armed
    // now would fire on the new window's NEXT chunk and wipe painted content.
    if (connectedSessionRef.current && clearOnRideRef.current) {
      pendingClearRef.current = true;
    }
  }, [windowId]);

  // Connection identity — (server, owning session), NOT windowId.
  //
  // Backend model (since 260602-qn62, move-based board pin-sessions): the
  // relay resolves the window's real owning session via ResolveWindowSession
  // — in the move-based model a window lives in exactly ONE session, its
  // home session or its `_rk-pin-*` board pin-session — then runs a
  // session-scoped select (`tmux select-window -t <session>:@N`) and
  // attaches the PTY DIRECTLY to that real session
  // (`attach-session -t <session>`). The attached PTY therefore tracks its
  // session's active window natively, exactly like a local `tmux attach`
  // client.
  //
  // Consequence: a same-session windowId change needs NO reconnect — tmux
  // has already switched the active window in place (a status-bar click
  // travels over this very socket) or will switch it (REST selectWindow
  // fired by navigateToWindow and the mount-time URL alignment in app.tsx),
  // and the attached PTY redraws by itself. Reconnecting would only add a
  // WS + PTY + attach roundtrip and wipe the xterm scrollback. So the
  // connection is keyed on (server, owning session), tracked as:
  //
  //   - connectedSessionRef — the session the live connection serves.
  //     "" means "not yet resolved": on a cold deep-link the sessionName
  //     prop is SSE-derived and resolves a beat after mount, so we connect
  //     immediately by windowId (the relay resolves the owning session
  //     server-side) and absorb the "" → resolved transition by merely
  //     recording it — by construction the live connection is already
  //     attached to that window's owning session. That construction only
  //     holds if the windowId hasn't changed since connect, which is why
  //     the UNRESOLVED state falls back to windowId-based identity (next
  //     bullet).
  //   - connectedWindowIdRef — the windowId the live connection was opened
  //     for. Read ONLY while unresolved (connectedSessionRef is ""): with
  //     no session known yet, the connection's identity IS its windowId,
  //     so a windowId change in that state bumps for a reconnect — the
  //     relay re-resolves the new window's owner. Without this, navigating
  //     to another window before the first SSE snapshot (browser history,
  //     typed URL) would leave the socket attached to the OLD window's
  //     session, and the later "" → resolved absorption would record the
  //     NEW window's session — a silent identity/attachment mismatch.
  //     Once resolved, windowId changes are same-session rides and this
  //     ref is not consulted.
  //   - connectedServerRef — the server the live connection was opened
  //     against. The connect effect re-runs on `server` changes directly
  //     (it stays in the deps), so the watcher below must NOT also bump
  //     the epoch when the server changed in the same commit — that would
  //     tear down and reconnect twice.
  //   - connectionEpoch — bumped by the watcher to force a teardown +
  //     reconnect when the served identity changes in a way the connect
  //     effect's own deps don't already cover:
  //       • resolved → different resolved: cross-session navigation, or a
  //         window moved to another session. A session RENAME also lands
  //         here and reconnects — accepted tradeoff: the SSE snapshot
  //         carries no stable session id to tell a rename from a genuine
  //         session change, renames are rare, and the deferred reset keeps
  //         any reconnect flicker-free.
  //       • resolved → "": LOSS of identity. sessionName is derived by
  //         locating the URL's @N in the SSE snapshot, so it goes "" and
  //         STAYS "" when the viewed window is killed externally, pinned
  //         to a `_rk-pin-*` board session (pin-sessions are filtered from
  //         the snapshot — pinning the viewed window therefore presents as
  //         resolved → "", never resolved → resolved), or the route is a
  //         dead deep link. The bump issues a probe reconnect by windowId:
  //         if the window still exists (e.g. an X → "" → X ghost gap
  //         during navigation — one reconnect, flicker-free) the relay
  //         re-resolves the owning session server-side; if it is gone the
  //         relay closes 4004 and the onSessionNotFound redirect fires.
  //         Without this bump nothing recovers: the kill redirect and the
  //         URL writeback in app.tsx are both gated on a non-empty
  //         sessionName, so the route would wedge.
  //     "" → resolved never bumps (absorption — connectedSessionRef
  //     above), and "" → "" with an unchanged windowId is a no-op; a
  //     windowId change while unresolved bumps (windowId-based identity —
  //     connectedWindowIdRef above). The watcher also records identity
  //     before a connection exists — harmless: pre-ready bumps are blocked
  //     by the server guard (connectedServerRef is "" until the first
  //     connect; the server prop never is).
  const connectedSessionRef = useRef("");
  const connectedServerRef = useRef("");
  const connectedWindowIdRef = useRef("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  // Session-identity watcher. MUST stay declared BEFORE the connect effect:
  // on a same-commit server+session change it has to read the PRE-change
  // server from connectedServerRef (the connect effect overwrites it) to
  // see that the reconnect is already being handled by the `server` dep.
  useEffect(() => {
    const servedSession = connectedSessionRef.current;

    // UNRESOLVED connection (opened before the first snapshot — its served
    // session is ""): identity is the windowId it was opened for. A
    // windowId change here must reconnect — the relay resolved the OLD
    // window's owner, so riding the socket (or absorbing a same-commit
    // resolution) would silently mismatch identity and attachment.
    // connectedWindowIdRef is "" before the first connect, so pre-ready
    // renders skip this branch (and the server guard blocks their bumps).
    if (
      !servedSession &&
      connectedWindowIdRef.current &&
      windowId !== connectedWindowIdRef.current
    ) {
      connectedSessionRef.current = sessionName;
      // Server changed in this same commit → the connect effect re-runs
      // via its `server` dep; bumping the epoch too would reconnect twice.
      if (server !== connectedServerRef.current) return;
      setConnectionEpoch((epoch) => epoch + 1);
      return;
    }

    if (!sessionName) {
      // "" → "" (cold mount, still unresolved, same window): nothing to do.
      if (!servedSession) return;
      // resolved → "": loss of identity (see the connectionEpoch bullet
      // above) — record it and bump so the probe reconnect either
      // re-resolves the window server-side or closes 4004 and the
      // onSessionNotFound redirect fires.
      connectedSessionRef.current = "";
      // Server changed in this same commit → the connect effect re-runs
      // via its `server` dep; bumping the epoch too would reconnect twice.
      if (server !== connectedServerRef.current) return;
      setConnectionEpoch((epoch) => epoch + 1);
      return;
    }
    connectedSessionRef.current = sessionName;
    // First resolution ("" → resolved) or unchanged → record only.
    if (!servedSession || servedSession === sessionName) return;
    // Same-commit server change → see above.
    if (server !== connectedServerRef.current) return;
    setConnectionEpoch((epoch) => epoch + 1);
  }, [sessionName, server, windowId]);

  // WebSocket connection — lives as long as (server, owning session) does.
  // windowId is deliberately NOT a dependency: same-session switches ride
  // the existing socket, and the relay URL reads windowIdRef.current so any
  // genuine reconnect (session change, server change, transient drop) picks
  // up the latest window. sessionName is NOT a dependency either: its
  // changes are translated into connectionEpoch bumps by the watcher above,
  // which is what lets the cold-deep-link "" → resolved transition pass
  // without a reconnect.
  useEffect(() => {
    if (!terminalReady || !xtermRef.current) return;

    // Record the identity this connection serves. sessionName may be ""
    // here (cold deep-link, or a loss-of-identity probe reconnect) — the
    // watcher above fills it in on resolution without forcing a reconnect.
    // Recording at effect-run time is sufficient: any identity change
    // re-runs this effect (clearing the reconnect timer), so a
    // timer-driven connect() can never observe a changed identity.
    connectedServerRef.current = server;
    connectedSessionRef.current = sessionName;
    connectedWindowIdRef.current = windowIdRef.current;

    const terminal = xtermRef.current;

    let cancelled = false;

    // Adaptive write flushing.
    //
    // The naive strategy — buffer every inbound chunk and flush once per
    // requestAnimationFrame — adds up to a full frame (~16ms) of latency to a
    // lone keystroke echo for no benefit: there is nothing to coalesce when one
    // small chunk arrives in an idle frame. (Latency attribution showed this
    // rAF tail dominates perceived input latency ~3:1 over the network hop.)
    //
    // Instead: write SMALL chunks that arrive while idle straight to the
    // terminal, synchronously, so an echo paints on the same tick. Fall back to
    // rAF-coalescing only under load — i.e. once a chunk is large, or once we
    // are already buffering — so a flood (`cat largefile`, a build log) still
    // batches into one write per frame and does not melt the renderer.
    //
    // Ordering safety (terminal bytes are order-sensitive): the moment ANYTHING
    // is buffered, every subsequent chunk also buffers until the buffer drains.
    // An immediate write therefore only happens when the buffer is empty AND no
    // flush is pending, so a synchronous write can never jump ahead of buffered
    // bytes.
    // Under the mux, inbound PTY output is always BINARY (the relay's byte
    // stream, tagged with the stream id and demuxed by RelayMux), so there is no
    // string-buffer path — every chunk is a Uint8Array.
    let binaryBuffers: Uint8Array[] = [];
    let flushRafId: number | null = null;
    // At most ONE immediate (synchronous) write per animation frame. The flag is
    // reset on each rAF tick. This is the flood guard: the first small idle
    // chunk in a frame paints immediately (interactive echo), but a burst of
    // small chunks within the same frame coalesces — without it, a program
    // emitting one byte at a time would write synchronously on every message.
    let wroteImmediatelyThisFrame = false;
    let frameResetRafId: number | null = null;

    // A chunk larger than this is treated as "under load" and coalesced rather
    // than written immediately. A keystroke echo is a handful of bytes; a paste,
    // a program's burst output, or a redraw is far larger (the relay reads the
    // PTY in 4KB chunks). The threshold trades a little extra latency on medium
    // chunks for protection against synchronous-write storms.
    const IMMEDIATE_WRITE_MAX_BYTES = 64;

    // Deferred per-connection reset. Each connect() arms this flag; the reset
    // then executes immediately BEFORE the first chunk of that connection is
    // written — in the same tick on the immediate path, and inside the same
    // rAF callback (same frame) on the coalesced path — so clear + repaint
    // land in one presented frame. Resetting at message-RECEIPT time (the old
    // behavior) guaranteed ≥1 fully-cleared frame whenever the first chunk
    // took the coalesced path: the wipe was synchronous but the repaint
    // waited for the next animation frame. That cleared frame was the
    // window-switch flicker. Until the new redraw arrives, the user keeps
    // seeing the OLD content instead of black.
    //
    // Handoff semantics (why an effect-scoped flag is per-connection safe):
    // connections within one effect are strictly sequential, and the flush
    // buffers above only ever hold the CURRENT connection's data. An old
    // connection's close-time drain (ws.onclose) runs before the reconnect
    // timer's connect() re-arms the flag, so a tail drain can never consume a
    // reset armed for a DIFFERENT connection — which is why arming must stay
    // in connect() and nowhere earlier. A zero-message connection closes with
    // empty buffers; the empty flush below neither consumes nor executes the
    // pending reset (resetting with nothing to repaint would recreate the
    // flicker) — the next connect() simply re-arms, idempotently.
    let pendingReset = false;

    /** Run the deferred per-connection reset exactly once, at first-write time. */
    function consumePendingReset() {
      if (!pendingReset) return;
      pendingReset = false;
      terminal.reset();
    }

    /** Run the deferred same-session-ride buffer clear exactly once, at
     *  first-write time — the `clear()` (not `reset()`) counterpart armed by
     *  the windowId effect; see `pendingClearRef`. Mutually exclusive with a
     *  pending reset: `onOpened` drops the clear when it arms the reset. */
    function consumePendingClear() {
      if (!pendingClearRef.current) return;
      pendingClearRef.current = false;
      terminal.clear();
    }

    function flushToTerminal() {
      flushRafId = null;
      // An empty flush (e.g. a zero-message connection's close-time drain)
      // must not consume or execute the pending reset — see above.
      if (binaryBuffers.length === 0) return;
      consumePendingReset();
      consumePendingClear();
      for (const buf of binaryBuffers) {
        terminal.write(buf);
      }
      binaryBuffers = [];
    }

    /** True while we are coalescing — a flush is pending or data is buffered. */
    function isBuffering(): boolean {
      return flushRafId !== null || binaryBuffers.length > 0;
    }

    function scheduleFlush() {
      if (flushRafId === null) {
        flushRafId = requestAnimationFrame(flushToTerminal);
      }
    }

    /** Decide whether an inbound chunk of `len` bytes can be written now. */
    function canWriteImmediately(len: number): boolean {
      return (
        !isBuffering() &&
        !wroteImmediatelyThisFrame &&
        len <= IMMEDIATE_WRITE_MAX_BYTES
      );
    }

    /** Mark that an immediate write happened; arm a one-shot frame reset. */
    function markImmediateWrite() {
      wroteImmediatelyThisFrame = true;
      if (frameResetRafId === null) {
        frameResetRafId = requestAnimationFrame(() => {
          frameResetRafId = null;
          wroteImmediatelyThisFrame = false;
        });
      }
    }

    // Open a muxed stream on the single per-tab terminals socket (RelayMux),
    // replacing the former per-pane `new WebSocket('/relay/...')`. The stream
    // handle is surfaced through wsRef as a WebSocket-shaped adapter so the
    // shell consumers (BottomBar, ComposeStrip, touch-scroll, fitAndSync) —
    // which read wsRef.current.{readyState,send,close} — are untouched. Every
    // `send` (keystrokes, SGR, paste) becomes a binary data frame; resizes use
    // the adapter's DEDICATED `resize(cols, rows)` op (fitAndSync calls it), so
    // a paste containing `{type:"resize"}` JSON is never mistaken for a resize.
    //
    // Socket-level reconnect is owned by RelayMux (one backoff loop for the
    // whole tab); on reconnect it re-issues `open` for this stream — targeting
    // the CURRENT windowId (kept fresh via stream.setWindowId on same-session
    // rides — M1) — the server re-attaches, and stream.onOpened re-arms the
    // deferred reset, so a transient socket drop repaints flicker-free on the
    // incoming first data frame WITHOUT a per-pane reconnect timer.
    // stream.onClosed fires for STREAM-level closes: 4004 → redirect; 4001/1000
    // → probe ONE fresh re-open (S1 — a gone window then 4004s → redirect, a
    // transient one re-attaches).

    /** Consume one inbound data chunk through the adaptive write / deferred-reset
     *  path. Inbound frames are always binary under the mux. */
    function handleInbound(chunk: Uint8Array) {
      if (cancelled) return;
      // First inbound bytes of the incoming window RECEIVED — release any
      // in-flight window-switch view-transition awaiting the incoming first
      // paint (260703-l4nf). Fired at receipt time and BEFORE the write/coalesce
      // decision, because `startViewTransition` suppresses rendering while its
      // update callback runs and rAF callbacks DO NOT fire during that
      // suppression — so a write-time release would be structurally
      // unreleasable and every animated switch would eat the full timeout. This
      // callback is a macrotask that runs during suppression, and the pending
      // flush still paints these bytes at the first rendering opportunity. The
      // receipt source is now the stream's first DATA frame (seam 1 of the
      // TerminalClient port), replacing the socket's `onmessage`. No-op when no
      // transition is armed. Only the route's designated receipt source
      // reports (`switchReceiptSource`) — another mounted terminal's bytes are
      // not evidence that THIS route's incoming window has painted.
      if (switchReceiptSourceRef.current) notifyFirstWrite();

      if (canWriteImmediately(chunk.length)) {
        consumePendingReset();
        consumePendingClear();
        terminal.write(chunk);
        markImmediateWrite();
        return;
      }
      binaryBuffers.push(chunk);
      scheduleFlush();
    }

    // The live stream. Held in a mutable local (not a const) because a
    // stream-level `closed` for a non-4004 reason probes ONE fresh re-open (S1),
    // which replaces this reference; the adapter + cleanup read `currentStream`.
    let currentStream: RelayStream;
    // At most one probe re-open per stream-level close, so a genuinely dead
    // window (which 4004s the probe) redirects instead of looping.
    let probedReopen = false;

    /** Open a fresh stream for the CURRENT window and wire its callbacks. */
    function openAndWire(): RelayStream {
      const stream = relayMux.openStream({
        server,
        windowId: windowIdRef.current,
        cols: terminal.cols,
        rows: terminal.rows,
        isolate,
      });
      currentStream = stream;
      streamRef.current = stream;

      // open → opened (seam 2 anchor + seam 4 re-arm): arm the deferred reset for
      // this (re)connection and re-fit + re-sync the grid. Fires on the initial
      // open AND every transparent re-open after a socket-level reconnect.
      stream.onOpened(() => {
        if (cancelled || streamRef.current !== stream) return;
        pendingReset = true;
        // A stream (re)open supersedes a pending ride clear: the fresh
        // connection's deferred reset owns the first chunk, and `reset()`
        // already covers everything `clear()` would.
        pendingClearRef.current = false;
        // Wipe adaptive-flush state carried over from the dead connection
        // (mirroring the effect-cleanup neutralization below). On a transparent
        // re-open, bytes buffered from the PREVIOUS connection may still be
        // awaiting a rAF flush — on a backgrounded tab rAF never fires, so
        // tmux's unanswered queries (and stale content) sit here until wake.
        // Replaying them into the NEW connection is exactly what re-answered
        // old DA queries into a client that had already been answered (typed
        // junk at prompts) — and the deferred reset wipes the repaint anyway.
        // Safe w.r.t. the pendingReset handoff: an empty flush neither
        // consumes nor executes a pending reset (the guard in flushToTerminal).
        binaryBuffers = [];
        if (flushRafId !== null) {
          cancelAnimationFrame(flushRafId);
          flushRafId = null;
        }
        fitAddonRef.current?.fit();
        stream.resize(terminal.cols, terminal.rows);
      });

      stream.onData((chunk) => {
        if (streamRef.current !== stream) return; // superseded by a probe re-open
        handleInbound(chunk);
      });

      stream.onClosed((code) => {
        if (streamRef.current !== stream) return; // stale — a newer stream is live

        // Flush any buffered data before handling close.
        if (flushRafId) {
          cancelAnimationFrame(flushRafId);
          flushRafId = null;
        }
        if (frameResetRafId) {
          cancelAnimationFrame(frameResetRafId);
          frameResetRafId = null;
        }
        wroteImmediatelyThisFrame = false;
        try { flushToTerminal(); } catch { /* terminal may be disposed */ }

        if (cancelled) return;
        // 4004 = session or window not found — redirect, no reconnect.
        if (code === 4004) {
          terminal.write("\r\n\x1b[91m[session not found]\x1b[0m\r\n");
          onSessionNotFound?.();
          return;
        }
        // Non-4004 (4001 attach-failed, 1000 graceful/PTY-EOF): the old per-pane
        // relay printed "[reconnecting…]" and self-healed. RelayMux only re-opens
        // on a SOCKET drop, not a stream-level close, so probe ONE fresh re-open
        // here (S1). If the window is genuinely gone the probe 4004s and the
        // branch above redirects; otherwise it re-attaches. Bounded to one probe
        // so a hard-failing window can't loop.
        if (probedReopen) {
          terminal.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
          return;
        }
        probedReopen = true;
        terminal.write("\r\n\x1b[90m[reconnecting...]\x1b[0m\r\n");
        openAndWire();
      });

      return stream;
    }

    currentStream = openAndWire();

    // WebSocket-shaped adapter over the current stream handle. Keeps the wsRef
    // contract ({ readyState, send, close }) the shell consumers depend on. Reads
    // `currentStream` live so a probe re-open (S1) transparently retargets it.
    const adapter = {
      get readyState() {
        return relayMux.isOpen() ? WebSocket.OPEN : WebSocket.CONNECTING;
      },
      send(data: string | ArrayBufferView | ArrayBuffer) {
        // Everything sent here is raw terminal input (keystrokes, SGR scroll,
        // pasted text) — forwarded verbatim to the PTY. Resizes travel on the
        // dedicated `resize` op below, NOT this channel, so a paste that
        // happens to contain `{type:"resize"}` JSON is never swallowed.
        currentStream.send(data);
      },
      resize(cols: number, rows: number) {
        if (cols > 0 && rows > 0) currentStream.resize(cols, rows);
      },
      close() {
        currentStream.close();
      },
    };
    wsRef.current = adapter as unknown as WebSocket;

    return () => {
      cancelled = true;
      // Neutralize this effect's pending write state. A late inbound chunk or a
      // close can be delivered asynchronously AFTER this cleanup, and its drain
      // runs BEFORE the `cancelled` check in some paths. Clearing the flag and
      // buffers turns any orphaned drain into a no-op via the empty-flush guard
      // in flushToTerminal.
      pendingReset = false;
      pendingClearRef.current = false;
      binaryBuffers = [];
      if (flushRafId) cancelAnimationFrame(flushRafId);
      if (frameResetRafId) cancelAnimationFrame(frameResetRafId);
      // Close the muxed stream (a `close` control op). The tab's single
      // terminals socket stays open for the other panes.
      currentStream.close();
      if (streamRef.current === currentStream) {
        streamRef.current = null;
      }
      if (wsRef.current === (adapter as unknown as WebSocket)) {
        wsRef.current = null;
      }
    };
    // sessionName and windowId are deliberately omitted (connection identity
    // is (server, owning session) — see the comment block above); they are
    // read inside only via windowIdRef / identity recording, which must not
    // retrigger the effect. onSessionNotFound is a close-time callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalReady, server, wsRef, connectionEpoch]);

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={terminalRef}
        role="application"
        aria-label={`Terminal: ${sessionName}/${windowId}`}
        className={`flex-1 min-h-0 overflow-hidden coarse:touch-none ${
          transparent ? "rk-terminal-transparent " : ""
        }${dragOver ? "ring-2 ring-accent ring-inset" : ""}`}
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />
    </div>
  );
}
