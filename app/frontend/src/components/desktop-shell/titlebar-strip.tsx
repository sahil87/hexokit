import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useInstanceAccent } from "@/contexts/instance-accent-context";
import { useTheme } from "@/contexts/theme-context";
import { deriveUIColors } from "@/themes";
import { useToast } from "@/components/toast";
import {
  canReorderShellHosts,
  canSubscribeShellServers,
  listShellServers,
  onShellAttached,
  onShellServersChanged,
  reorderShellHosts,
  shellInfo,
  switchShellServer,
} from "@/lib/shell";
import type { ShellServer } from "@/lib/shell";
import {
  activeShellHostName,
  HOST_MENU_OPEN_EVENT,
  HOST_STRIP_FOCUS_EVENT,
  hostReach,
  isHintChord,
  isSelfHost,
  lightAx,
  lightDx,
  moveInList,
  previewNameplate,
  SHELL_STRIP_HEIGHT_PX,
  SHELL_STRIP_MARKER_CLASS,
  stripInsets,
  stripLabelColor,
  stripSwitcherEnabled,
} from "@/lib/shell-strip";
import type { CssVarStyle, NameplateData } from "@/lib/shell-strip";
import { matchesCombo, shouldSuppressChord } from "@/lib/keybindings";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useStripPrefs } from "@/hooks/use-strip-prefs";
import { HostMenu } from "./host-menu";
import type { HostMenuFocus } from "./host-menu";
import { HostSquares } from "./host-squares";
import type { HostSquaresHandle } from "./host-squares";
import { KeyHintPill } from "./key-hint-pill";
import { Nameplate } from "./nameplate";
import { useHostNameplate } from "./use-host-nameplate";

/**
 * Desktop-shell titlebar strip: a 28px full-width draggable band above the top
 * bar, rendered ONLY inside the Electron viewer shell (callers gate the mount
 * on `isShell()`). The shell hides the native titlebar, so this strip IS the
 * visible titlebar: macOS traffic lights and the Windows/Linux window controls
 * composite over its ends (hence the platform insets on the row).
 *
 * The row is left-aligned: `[key-hint pill][host squares][+][nameplate]`. One
 * square per shell host switches with a click; hovering previews the host in
 * the nameplate; the nameplate always NAMES the active host, so colour never
 * works alone. The band itself is neutral chrome lit from the active square by
 * a CSS light effect (`strip.effect`, `strip.motion` from the shell's own
 * prefs) — three `@property` variables (`--rk-ax` square centre, `--rk-dx`
 * nameplate end, `--rk-acc` host colour) are set imperatively so a change
 * transitions. A host switch is a detach/attach flip between per-host
 * renderer views; the shell tells the newly shown view which host it replaced
 * (`onShellAttached`) so the light can slide from that square — absent the
 * signal it cuts.
 *
 * Nothing here ever moves a square or the nameplate: squares are fixed-size
 * (the active host is a ring), the pill's space is always reserved, digits sit
 * inside the squares, and nameplate folding happens inside its own flex cell.
 *
 * The whole band is a drag region (`.rk-shell-drag`); the squares, `+` and the
 * pill are no-drag islands. While mounted, `<html>` carries the
 * `rk-shell-strip` marker class — the shell's version-skew fallback CSS
 * (`html:not(.rk-shell-strip)` selectors, injected for older SPAs) keys off it
 * and no-ops here.
 *
 * Branches: in a popout window (`title` passed — AppShell's popout title
 * through the top-bar slot context) the strip shows that title, static, with
 * no squares; without the shell's `servers` group (older shell, denial, empty
 * list) it shows the static host name with no squares or pill. Both keep
 * today's flat accent tint of the band.
 *
 * The host-management dropdown (HostMenu) opens from the `+` square, a
 * right-click on a square, or the palette's `Host: Switcher`. ⇧⌘H/⇧Ctrl+H
 * (`host-strip-focus`) moves focus to the squares.
 */

interface MenuState {
  anchorLeft: number;
  focus: HostMenuFocus;
}

export function ShellTitlebarStrip({ title }: { title?: string } = {}) {
  const { stripeHex, titlebarHex } = useInstanceAccent();
  const { theme } = useTheme();
  const { addToast } = useToast();
  const prefs = useStripPrefs();
  const selfFacts = useHostNameplate();
  const { byAction } = useKeybindings();
  const [servers, setServers] = useState<ShellServer[] | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [holdHints, setHoldHints] = useState(false);
  const [pillHover, setPillHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const squaresRef = useRef<HostSquaresHandle>(null);
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);

  const platform = shellInfo()?.platform ?? "";

  // Mark <html> so the shell's injected fallback strip disables itself.
  useLayoutEffect(() => {
    document.documentElement.classList.add(SHELL_STRIP_MARKER_CLASS);
    return () => document.documentElement.classList.remove(SHELL_STRIP_MARKER_CLASS);
  }, []);

  // Monotonic sequence guarding every list fetch: a resolution older than the
  // latest issued request is dropped, so two in-flight fetches resolving out
  // of order can never leave a stale list rendered. A null resolution (denial
  // or rejection) keeps the last known list. The cleanup bump invalidates a
  // still-in-flight fetch (the guard doubles as cancellation).
  const listSeqRef = useRef(0);
  const fetchServers = useCallback(() => {
    const seq = ++listSeqRef.current;
    void listShellServers().then((fresh) => {
      if (fresh !== null && seq === listSeqRef.current) setServers(fresh);
    });
  }, []);

  useEffect(() => {
    fetchServers();
    return () => {
      listSeqRef.current++;
    };
  }, [fetchServers]);

  // The squares are always visible, so the projection must stay current: the
  // shell pushes `servers:changed` on every store/registry change. An older
  // shell without the push refetches when the window regains focus (a
  // mutation also refetches at its own call site).
  useEffect(() => {
    if (canSubscribeShellServers()) return onShellServersChanged(fetchServers);
    window.addEventListener("focus", fetchServers);
    return () => window.removeEventListener("focus", fetchServers);
  }, [fetchServers]);

  const interactive = stripSwitcherEnabled(servers);
  // Document/window listeners register once and read liveness through this ref,
  // so a list change never leaves a stale closure attached.
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const canReorder = canReorderShellHosts();
  const self = servers?.find(isSelfHost) ?? null;

  const selectHost = useCallback(
    (id: string) => {
      setMenu(null);
      void switchShellServer(id).then((ok) => {
        if (!ok) addToast("Host switch failed", "error");
      });
    },
    [addToast],
  );

  // One committed shell invocation per gesture; the local list reorders
  // OPTIMISTICALLY first so the digits renumber at once, and a denial/failure
  // surfaces the toast precedent and refetches so the list reconciles.
  const reorderHost = useCallback(
    (id: string, from: number, to: number) => {
      setServers((prev) => (prev ? moveInList(prev, from, to) : prev));
      void reorderShellHosts(id, to).then((ok) => {
        if (!ok) {
          addToast("Shell host reorder failed", "error");
          fetchServers();
        }
      });
    },
    [addToast, fetchServers],
  );

  // ── Host menu ──────────────────────────────────────────────────────────────

  // Refetch on every open: the native `Hosts → Remove "<name>"…` menu mutates
  // the list without a push on shells that predate `servers:changed`.
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const openMenu = useCallback(
    (focus: HostMenuFocus, anchor: HTMLElement) => {
      // The `+` square toggles; any other opener (re)anchors the menu.
      const prev = menuRef.current;
      if (prev !== null && focus.kind === "add" && prev.focus.kind === "add") {
        setMenu(null);
        return;
      }
      const root = rootRef.current;
      const rootLeft = root ? root.getBoundingClientRect().left : 0;
      menuReturnRef.current = anchor;
      fetchServers();
      setMenu({ anchorLeft: anchor.getBoundingClientRect().left - rootLeft, focus });
    },
    [fetchServers],
  );

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) menuReturnRef.current?.focus();
  }, []);

  // An emptied list (a refetch after the last host was removed) unmounts the
  // squares: release the menu state with them.
  useEffect(() => {
    if (!interactive) setMenu(null);
  }, [interactive]);

  // The palette's `Host: Switcher` body reaches this menu through the
  // HOST_MENU_OPEN_EVENT document seam (it cannot touch the strip's state).
  // Open-only — palette bodies keep single-verb semantics.
  useEffect(() => {
    function onOpenRequest() {
      const add = rootRef.current?.querySelector<HTMLElement>('[data-testid="shell-host-add"]');
      if (add && interactiveRef.current) openMenu({ kind: "add" }, add);
    }
    document.addEventListener(HOST_MENU_OPEN_EVENT, onOpenRequest);
    return () => document.removeEventListener(HOST_MENU_OPEN_EVENT, onOpenRequest);
  }, [openMenu]);

  // ── Focus the squares (⇧⌘H / ⇧Ctrl+H, palette) ─────────────────────────────

  const focusSquares = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !squaresRef.current?.hasFocus()) {
      focusReturnRef.current = active;
    }
    setMenu(null);
    squaresRef.current?.focusActive();
  }, []);

  const releaseSquares = useCallback(() => {
    const back = focusReturnRef.current;
    focusReturnRef.current = null;
    if (back?.isConnected) back.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  // `host-strip-focus` chord — a component-local listener (the strip is the
  // only surface that can act, so its mount IS the handler-presence gate: in a
  // browser the strip never mounts and the chord falls through everywhere).
  // Toggle semantics: a second press releases focus. A non-interactive strip
  // never preventDefaults — the key must fall through untouched. Binding and
  // live state ride refs so the listener registers once per mount.
  const chordBindingRef = useRef(byAction.get("host-strip-focus"));
  chordBindingRef.current = byAction.get("host-strip-focus");
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const binding = chordBindingRef.current;
      if (!binding?.enabled || !matchesCombo(e, binding)) return;
      if (shouldSuppressChord(e.target)) return;
      if (!interactiveRef.current) return;
      e.preventDefault();
      if (squaresRef.current?.hasFocus()) releaseSquares();
      else focusSquares();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSquares, releaseSquares]);

  useEffect(() => {
    function onFocusRequest() {
      if (interactiveRef.current) focusSquares();
    }
    document.addEventListener(HOST_STRIP_FOCUS_EVENT, onFocusRequest);
    return () => document.removeEventListener(HOST_STRIP_FOCUS_EVENT, onFocusRequest);
  }, [focusSquares]);

  // ── Key hints (hold the chord) ─────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      setHoldHints(isHintChord(e, platform));
    }
    const clear = () => setHoldHints(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", clear);
    };
  }, [platform]);

  // ── Band light ─────────────────────────────────────────────────────────────

  const setLight = useCallback((ax: number, dx: number) => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty("--rk-ax", `${ax}px`);
    root.style.setProperty("--rk-dx", `${dx}px`);
  }, []);

  // The active square's centre and the active nameplate's end, measured from
  // the DOM. Skipped while another host is previewed (the preview's text would
  // move the end) or a square is mid-drag (its transform would move the
  // centre): the light does not move on hover or drag.
  const measureLight = useCallback(() => {
    const root = rootRef.current;
    if (!root || hoverId !== null || dragging) return;
    const active = root.querySelector<HTMLElement>('[data-host-id][aria-current="true"]');
    if (!active) return;
    const rootLeft = root.getBoundingClientRect().left;
    const square = active.getBoundingClientRect();
    const ax = lightAx(square.left - rootLeft, square.width);
    const shown = root.querySelectorAll<HTMLElement>("[data-np-shown]");
    const lastEl = shown.length > 0 ? shown[shown.length - 1] : null;
    setLight(ax, lightDx(lastEl ? lastEl.getBoundingClientRect().right - rootLeft : null, ax));
  }, [hoverId, dragging, setLight]);

  const effect = interactive ? prefs.effect : "flat";
  const lit = stripeHex !== null;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || stripeHex === null) return;
    root.style.setProperty("--rk-acc", stripeHex);
    measureLight();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(measureLight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measureLight]);

  // Cross-view slide: this view was just shown over another host's. Re-seat
  // the light at the previous square without a transition, then measure the
  // real position so the transition slides it here (and sweeps, if chosen).
  const appliedMotion = prefs.appliedMotion;
  useEffect(() => {
    if (appliedMotion === "cut") return;
    return onShellAttached((previousId) => {
      const root = rootRef.current;
      if (!root) return;
      let previous: HTMLElement | null = null;
      for (const el of root.querySelectorAll<HTMLElement>("[data-host-id]")) {
        if (el.dataset.hostId === previousId) previous = el;
      }
      if (!previous) return;
      const rootLeft = root.getBoundingClientRect().left;
      const rect = previous.getBoundingClientRect();
      const fromAx = lightAx(rect.left - rootLeft, rect.width);
      root.classList.add("rk-strip-notrans");
      root.style.setProperty("--rk-ax", `${fromAx}px`);
      const previousColor = servers?.find((s) => s.id === previousId)?.accentColor;
      if (previousColor !== undefined) root.style.setProperty("--rk-acc", previousColor);
      void root.offsetWidth; // commit the seat before re-enabling the transition
      root.classList.remove("rk-strip-notrans");
      // Slide position AND colour to this host's own values, independent of any
      // servers:changed re-render.
      if (stripeHex !== null) root.style.setProperty("--rk-acc", stripeHex);
      measureLight();
      const sweep = sweepRef.current;
      if (appliedMotion === "sweep" && sweep) {
        sweep.style.setProperty("--rk-from", `${fromAx}px`);
        sweep.classList.remove("rk-strip-sweep-go");
        void sweep.offsetWidth;
        sweep.classList.add("rk-strip-sweep-go");
      }
    });
  }, [appliedMotion, measureLight, servers, stripeHex]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const chrome = deriveUIColors(theme.palette, theme.category).bgChrome;
  const insets = stripInsets(platform);
  const hostLabel = activeShellHostName(servers) ?? window.location.hostname;

  // Popout and older-shell branches keep today's flat accent tint of the band.
  if (title !== undefined || !interactive) {
    const bg = titlebarHex ?? chrome;
    return (
      <div
        data-testid="shell-titlebar-strip"
        className="rk-shell-drag shrink-0 flex items-center justify-center select-none"
        style={{
          height: `${SHELL_STRIP_HEIGHT_PX}px`,
          backgroundColor: bg,
          color: stripLabelColor(bg),
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <span
          data-testid={title !== undefined ? "shell-titlebar-popout-title" : "shell-titlebar-host-name"}
          className="min-w-0 truncate text-xs"
        >
          {title ?? hostLabel}
        </span>
      </div>
    );
  }

  const reach = hostReach(self?.url ?? window.location.origin);
  const activeData: NameplateData = {
    name: self?.name ?? hostLabel,
    userMachine: selfFacts.machine,
    os: selfFacts.os,
    kind: reach.kind,
    link: reach.link,
    agents: selfFacts.agents,
  };
  const hovered = hoverId !== null ? servers.find((s) => s.id === hoverId) : undefined;
  const preview = hovered !== undefined && !isSelfHost(hovered);
  const hintsOn = holdHints || pillHover;
  const style: CssVarStyle = {
    height: `${SHELL_STRIP_HEIGHT_PX}px`,
    backgroundColor: chrome,
    color: stripLabelColor(chrome),
    paddingLeft: insets.left,
    paddingRight: insets.right,
    "--rk-strip-bg": chrome,
  };

  return (
    <div
      ref={rootRef}
      data-testid="shell-titlebar-strip"
      data-hints={hintsOn ? "on" : "off"}
      data-hold={holdHints ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      className={[
        "rk-strip rk-shell-drag shrink-0 select-none",
        lit ? `rk-strip-fx-${effect}` : "",
        `rk-strip-motion-${appliedMotion}`,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      <div aria-hidden="true" className="rk-strip-layer" />
      <div ref={sweepRef} aria-hidden="true" className="rk-strip-sweep" onAnimationEnd={(e) => e.currentTarget.classList.remove("rk-strip-sweep-go")} />
      <div className="rk-strip-row">
        <KeyHintPill platform={platform} onHoverChange={setPillHover} />
        <HostSquares
          ref={squaresRef}
          servers={servers}
          platform={platform}
          selfColor={stripeHex}
          canReorder={canReorder}
          onSwitch={selectHost}
          onHover={setHoverId}
          onReorder={reorderHost}
          onOpenMenu={openMenu}
          onDraggingChange={setDragging}
          onRelease={releaseSquares}
        />
        <Nameplate
          data={preview && hovered ? previewNameplate(hovered) : activeData}
          peek={preview}
          onLayout={measureLight}
        />
      </div>
      {menu !== null && (
        <HostMenu
          // A re-anchor (right-click on another square) remounts so the new
          // initial focus applies.
          key={menu.focus.kind === "host" ? menu.focus.id : "add"}
          servers={servers}
          setServers={setServers}
          fetchServers={fetchServers}
          platform={platform}
          anchorLeft={menu.anchorLeft}
          initialFocus={menu.focus}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
