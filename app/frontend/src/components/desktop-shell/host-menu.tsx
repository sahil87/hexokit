import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { HostFormDialog, INVALID_HOST_URL_MESSAGE, reduceOrigin } from "@/components/host-form-dialog";
import { Tip } from "@/components/tip";
import { useToast } from "@/components/toast";
import {
  addShellHost,
  canAddShellHost,
  canAddShellHostDirect,
  canConfirmedRemoveShellHost,
  canRemoveShellHost,
  canRenameShellHost,
  canReorderShellHosts,
  canSetShellHostUrl,
  confirmedRemoveShellHost,
  removeShellHost,
  renameShellHost,
  reorderShellHosts,
  setShellHostUrl,
  switchShellServer,
} from "@/lib/shell";
import type { ShellServer } from "@/lib/shell";
import { moveInList, shellHostMenuRows } from "@/lib/shell-strip";
import type { ShellHostMenuRow } from "@/lib/shell-strip";
import { useOccludes } from "@/hooks/use-occludes";

/**
 * The host-management dropdown of the desktop-shell titlebar strip. The strip
 * itself is the one-click switcher (a square per host); this menu keeps what a
 * square cannot carry — rows with the origin and accelerator hint, the accent
 * bar, the waiting chip, per-row Edit / Remove / drag-grip, the `+ Add Host…`
 * footer, the Remove confirm, and the HostFormDialog in edit and add modes —
 * and opens from the `+` square, a right-click (or Shift+F10 / ContextMenu) on
 * a square, or the palette's `Host: Switcher`. It is mounted only while open:
 * its dialog state dies with it.
 *
 * Add Host rides EITHER add path: the additive `servers.addDirect` invoker
 * (the shared HostFormDialog in add mode, in place) or the older
 * `servers.add` welcome-page swap; a shell with neither renders the menu
 * without the footer. Reorder, Remove and Edit are independently
 * capability-gated on their optional invokers, so an older shell degrades to
 * plain marker/name/origin/hint rows. Selecting a host hands off to the
 * shell's `switchToHost` seam (a full page swap with lastPath restore), so
 * there is no optimistic UI for a switch; reorder and rename ARE optimistic
 * through `setServers`, reconciled by `fetchServers`.
 *
 * Row order IS the ⌥⌘1–9/Alt+1–9 accelerator map, so a reorder renumbers the
 * hints live and the shell rebuilds its native menu on each committed move.
 * Keys while open: ↑/↓ roving focus (wraps), ⌥↑/⌥↓ reorder, digits 1–9 select,
 * Delete/Backspace Remove, F2 Edit, Escape closes.
 */

/** Custom MIME so a host-reorder drag never collides with the other
 *  drag-reorder payloads (server/session/board-list). */
const HOST_REORDER_MIME = "application/x-shell-host-reorder";

/** Selects the strip elements that open or toggle the menu (they carry a
 *  `data-host-menu-anchor` attribute): a mousedown on one is not an "outside
 *  click" — the element's own handler decides. */
const HOST_MENU_ANCHOR_SELECTOR = "[data-host-menu-anchor]";

/** Where focus lands when the menu opens. */
export type HostMenuFocus =
  | { kind: "add" } // the `+ Add Host…` footer when an add path exists, else the active row
  | { kind: "host"; id: string };

export interface HostMenuProps {
  servers: ShellServer[];
  setServers: Dispatch<SetStateAction<ShellServer[] | null>>;
  fetchServers: () => void;
  platform: string;
  /** Left edge of the menu, in px from the strip's left edge. */
  anchorLeft: number;
  initialFocus: HostMenuFocus;
  /** Close the menu; `restoreFocus` returns focus to the element that opened it. */
  onClose: (restoreFocus: boolean) => void;
}

export function HostMenu({
  servers,
  setServers,
  fetchServers,
  platform,
  anchorLeft,
  initialFocus,
  onClose,
}: HostMenuProps) {
  const { addToast } = useToast();
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Menus register `transient` (overlay-presence): while the host menu is
  // open, a native guest composited above the DOM hides so the menu never
  // paints underneath it.
  useOccludes("transient", true);

  const rows = shellHostMenuRows(servers, platform);
  // The `+ Add Host…` footer rides the union of the two add paths.
  const canAdd = canAddShellHost() || canAddShellHostDirect();
  const canAddDirect = canAddShellHostDirect();
  // The reorder affordances (drag grip, ⌥↑/⌥↓) ride the optional
  // `servers.reorder` invoker — an older shell renders plain rows.
  const canReorder = canReorderShellHosts();
  // removeConfirmed decides WHERE Remove confirms: themed SPA dialog when
  // present, the shell's native dialog otherwise — exactly one either way.
  const canRemoveNative = canRemoveShellHost();
  const canRemoveConfirmed = canConfirmedRemoveShellHost();
  const canRemove = canRemoveNative || canRemoveConfirmed;
  const canRename = canRenameShellHost();
  const canSetUrl = canSetShellHostUrl();
  const affordanceCount = (canReorder ? 1 : 0) + (canRemove ? 1 : 0) + (canRename ? 1 : 0);

  // Hand off to the shell's single switch seam. The whole page navigates
  // (lastPath capture/restore is shell-side), so there is nothing to update
  // optimistically; a denial/failure surfaces the palette's toast precedent.
  const selectHost = useCallback(
    (id: string) => {
      onClose(false);
      void switchShellServer(id).then((ok) => {
        if (!ok) addToast("Host switch failed", "error");
      });
    },
    [addToast, onClose],
  );

  // Latest COMMITTED host-row count, read live inside the capture-phase
  // keydown handler: that handler stays attached from a commit until the
  // passive-effect flush swaps the subscription, so a closure capture would
  // observe the OLD count in that window. A layout effect writes the ref at
  // commit time — before any keydown dispatched after an emptied-list commit
  // can reach the stale handler.
  const hostCountRef = useRef(0);
  useLayoutEffect(() => {
    hostCountRef.current = rows.length;
  }, [rows.length]);

  // Live copy of the derived rows for the reorder gestures (the keydown
  // handler's subscription can lag a reorder commit the same way it lags a
  // count change — the ref always reads the committed order).
  const rowsRef = useRef<ShellHostMenuRow[]>([]);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  });

  // One committed shell invocation per gesture; a denial/failure surfaces
  // the toast precedent and refetches so the list reconciles with the store.
  const commitReorder = useCallback(
    (id: string, toIndex: number) => {
      void reorderShellHosts(id, toIndex).then((ok) => {
        if (!ok) {
          addToast("Shell host reorder failed", "error");
          fetchServers();
        }
      });
    },
    [addToast, fetchServers],
  );

  const [confirmTarget, setConfirmTarget] = useState<ShellHostMenuRow | null>(null);

  // One removal tail for both confirm surfaces — `confirmed` picks the
  // channel: the SPA's themed dialog already confirmed (removeConfirmed) vs
  // the shell's own native Cancel-default dialog (remove).
  const finishRemove = useCallback(
    (id: string, confirmed: boolean) => {
      const invoke = confirmed ? confirmedRemoveShellHost : removeShellHost;
      void invoke(id).then((ok) => {
        if (!ok) addToast("Shell host remove failed", "error");
        fetchServers();
      });
    },
    [addToast, fetchServers],
  );

  const requestRemove = useCallback(
    (row: ShellHostMenuRow) => {
      if (canRemoveConfirmed) setConfirmTarget(row);
      else finishRemove(row.id, false);
    },
    [canRemoveConfirmed, finishRemove],
  );

  // Closing a dialog re-seats the roving focus on its target's row —
  // key-driven round-trips (Delete → Escape, F2 → Save/Escape) must not
  // strand document focus on <body> while the menu stays open.
  const refocusRow = useCallback((id: string) => {
    const idx = rowsRef.current.findIndex((r) => r.id === id);
    if (idx >= 0) requestAnimationFrame(() => itemRefs.current[idx]?.focus());
  }, []);

  const confirmRemove = useCallback(() => {
    const target = confirmTarget;
    setConfirmTarget(null);
    if (target) finishRemove(target.id, true);
  }, [confirmTarget, finishRemove]);

  const cancelRemove = useCallback(() => {
    const target = confirmTarget;
    setConfirmTarget(null);
    if (target) refocusRow(target.id);
  }, [confirmTarget, refocusRow]);

  // Edit Host (pencil / F2): the shared HostFormDialog in edit mode — it owns
  // the fields and error slot; the save semantics below stay caller-owned.
  const [editTarget, setEditTarget] = useState<ShellHostMenuRow | null>(null);
  // Add Host (footer, addDirect-capable shells): the same dialog in add mode.
  const [addOpen, setAddOpen] = useState(false);

  const openEdit = useCallback((row: ShellHostMenuRow) => {
    setEditTarget(row);
  }, []);

  const cancelEdit = useCallback(() => {
    const target = editTarget;
    setEditTarget(null);
    if (target) refocusRow(target.id);
  }, [editTarget, refocusRow]);

  // Save commits only what changed; the shell re-normalizes the URL
  // authoritatively and owns the page swap for a displayed host. "Changed"
  // is judged against the dialog's own prefill first (an untouched field is
  // never a change — and never parsed, so a name-only edit cannot be blocked
  // by a malformed stored URL), then against the LIVE row (a background
  // refetch may have reconciled while the dialog sat open). Returns the
  // inline error the dialog shows (it stays open), or null once the save
  // proceeds.
  const saveEdit = useCallback(
    ({ name: nameValue, url: urlValue }: { name: string; url: string }): string | null => {
      const target = editTarget;
      if (!target) return null;
      const live = rowsRef.current.find((r) => r.id === target.id) ?? target;
      const name = nameValue.trim();
      const urlRaw = urlValue.trim();
      let origin = live.origin;
      if (canSetUrl && urlRaw !== "" && urlRaw !== target.origin) {
        const reduced = reduceOrigin(urlRaw);
        if (reduced === null) return INVALID_HOST_URL_MESSAGE;
        origin = reduced;
      }
      setEditTarget(null);
      refocusRow(target.id);
      const nameChanged = name !== "" && name !== target.name && name !== live.name;
      const urlChanged = canSetUrl && origin !== live.origin;
      if (!nameChanged && !urlChanged) return null;
      if (nameChanged) {
        setServers((prev) =>
          prev ? prev.map((s) => (s.id === target.id ? { ...s, name } : s)) : prev,
        );
      }
      const ops: Promise<unknown>[] = [];
      if (nameChanged) {
        ops.push(
          renameShellHost(target.id, name).then((ok) => {
            if (!ok) addToast("Shell host rename failed", "error");
          }),
        );
      }
      if (urlChanged) {
        ops.push(
          setShellHostUrl(target.id, origin).then((ok) => {
            if (!ok) addToast("Shell host URL update failed", "error");
          }),
        );
      }
      void Promise.all(ops).then(() => fetchServers());
      return null;
    },
    [editTarget, canSetUrl, addToast, fetchServers, refocusRow],
  );

  // Menu-scoped dialog state dies with the menu — close paths bypass the
  // dialogs' own handlers, and stale state would wedge the next open.
  useEffect(() => {
    if (!open) {
      setConfirmTarget(null);
      setEditTarget(null);
      setAddOpen(false);
    }
  }, [open]);

  // Shared move commit (⌥↑/⌥↓ per keypress): the local list reorders
  // OPTIMISTICALLY so the accelerator hints re-number immediately, and the
  // roving-tabindex seat follows the moved row (DOM focus follows on its
  // own — the row's keyed element moves with it).
  const moveHostRow = useCallback(
    (from: number, to: number) => {
      const row = rowsRef.current[from];
      if (!row) return;
      setServers((prev) => (prev ? moveInList(prev, from, to) : prev));
      setFocusedIndex(to);
      commitReorder(row.id, to);
    },
    [commitReorder],
  );

  // Drag-grip reorder (the board-tile/session-reorder precedent): the local
  // order reorders optimistically during the drag (presentation state — the
  // open-time refetch reconciles), and exactly ONE reorder invocation
  // commits at drop, keyed on the immutable host id.
  const dragIdRef = useRef<string | null>(null);

  const onRowDragStart = useCallback((e: React.DragEvent, id: string) => {
    dragIdRef.current = id;
    e.dataTransfer.setData(HOST_REORDER_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    // A grip-initiated drag would default to the tiny dots as its drag
    // image; the row (the handler's wrapper) is what moves. Optional call:
    // jsdom/test DataTransfer mocks carry no setDragImage.
    const rect = e.currentTarget.getBoundingClientRect();
    e.dataTransfer.setDragImage?.(
      e.currentTarget,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  }, []);

  const onRowDragOver = useCallback((e: React.DragEvent, targetId: string) => {
    const dragId = dragIdRef.current;
    if (!dragId || !e.dataTransfer.types.includes(HOST_REORDER_MIME)) return;
    // Accept the drop BEFORE the self-target bail: the final dragover lands
    // on the dragged row's own element, and only a preventDefaulted dragover
    // registers the release as a drop.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragId === targetId) return;
    // Resolve indexes by id INSIDE the functional updater: React can batch
    // several dragover updates before a commit refreshes `rowsRef`, so
    // ref-derived indexes could be stale relative to the `prev` being spliced.
    setServers((prev) => {
      if (!prev) return prev;
      const from = prev.findIndex((s) => s.id === dragId);
      const to = prev.findIndex((s) => s.id === targetId);
      if (from === -1 || to === -1 || from === to) return prev;
      return moveInList(prev, from, to);
    });
  }, []);

  const onRowDrop = useCallback(
    (e: React.DragEvent) => {
      const dragId = dragIdRef.current;
      if (!dragId || !e.dataTransfer.types.includes(HOST_REORDER_MIME)) return;
      e.preventDefault();
      dragIdRef.current = null;
      // The optimistic dragover splices already landed the row at its drop
      // position — commit exactly that index.
      const to = rowsRef.current.findIndex((r) => r.id === dragId);
      if (to === -1) return;
      commitReorder(dragId, to);
    },
    [commitReorder],
  );

  const onRowDragEnd = useCallback(() => {
    dragIdRef.current = null;
  }, []);

  // A refetch can EMPTY the list: the rows unmount while the menu would stay
  // mounted with nothing to act on — release it.
  useEffect(() => {
    if (rows.length === 0) onClose(false);
  }, [rows.length, onClose]);

  // Outside-click closes (the BreadcrumbDropdown contract); the strip's own
  // anchors decide for themselves (they toggle or re-anchor the menu).
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (containerRef.current?.contains(target)) return;
      if (target.closest(HOST_MENU_ANCHOR_SELECTOR)) return;
      onClose(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);
  // Escape closes + returns focus to the opener; ArrowDown/ArrowUp move focus with
  // wraparound (capture-phase, mirroring BreadcrumbDropdown). With the
  // reorder capability, ⌥↑/⌥↓ instead MOVES the focused host row. Enter
  // needs no handler — the focused row is a native <button>. Delete/Backspace
  // opens the focused row's remove confirm and F2 its Edit Host dialog.
  const dialogOpen = confirmTarget !== null || editTarget !== null || addOpen;
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // While either dialog is up its focus trap owns every key.
      if (dialogOpen) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose(true);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Disconnect the focused host row — the themed dialog (or the native
        // one on older shells) is the accident guard. The Add-Host footer is
        // not bound, and a shell without any remove capability falls through.
        if (!canRemove) return;
        const idx = itemRefs.current.findIndex((el) => el === document.activeElement);
        if (idx < 0 || idx >= hostCountRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        const row = rowsRef.current[idx];
        if (row) requestRemove(row);
        return;
      }
      if (e.key === "F2") {
        // Edit the focused host row — same gating as Delete/Backspace.
        if (!canRename) return;
        const idx = itemRefs.current.findIndex((el) => el === document.activeElement);
        if (idx < 0 || idx >= hostCountRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        const row = rowsRef.current[idx];
        if (row) openEdit(row);
        return;
      }
      // Plain digits select the Nth host row — rendered-list order IS the
      // ⌥⌘1–9/Alt+1–9 accelerator order, so `⇧⌘H, 3` mirrors ⌥⌘3. The
      // no-modifier guard keeps the shell's own accelerators and every chord
      // tier untouched; a digit past the live committed count releases the
      // key (the arrow guard's hostCountRef read, same staleness reasoning).
      if (
        /^Digit[1-9]$/.test(e.code) &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const n = Number(e.code.slice(5));
        const row = n <= hostCountRef.current ? rowsRef.current[n - 1] : undefined;
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        selectHost(row.id);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Never swallow arrows the menu cannot act on: an emptied-list
        // refetch unmounts the rows one render before the close-on-empty
        // effect flips `open`, and this handler may still be the STALE
        // subscription (attached until the passive-effect flush swaps it).
        // The guard therefore reads the live committed count from
        // `hostCountRef` — written at commit time — so even a stale
        // subscription sees the zero and releases the key instead of
        // preventDefaulting app-wide. Keyed on the HOST count — the menu
        // (footer included) unmounts when it hits zero.
        const hostCount = hostCountRef.current;
        if (hostCount === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        // ⌥↑/⌥↓ moves the focused HOST row (all platforms — arrows compose
        // no characters): one committed move per keypress, hints re-number
        // live via the optimistic reorder. The Add-Host footer is NOT
        // movable — Alt-arrows there (and ALL Alt-arrows on an older shell
        // without the capability) fall through to the roving cycle. No wrap
        // at the list edges: a move past either end swallows the key
        // without invoking the shell.
        if (e.altKey && canReorder) {
          const from = itemRefs.current.findIndex((el) => el === document.activeElement);
          if (from >= 0 && from < hostCount) {
            const to = from + delta;
            if (to < 0 || to >= hostCount) return;
            moveHostRow(from, to);
            return;
          }
        }
        // The roving set spans the host rows PLUS the Add-Host footer when
        // the bridge carries it — the footer is the last stop in the arrow
        // cycle. The modulus derives from the same live read, so a
        // shrunk-but-non-empty list also cycles over the live count.
        const count = hostCount + (canAdd ? 1 : 0);
        setFocusedIndex((prev) => {
          const next = (prev + delta + count) % count;
          itemRefs.current[next]?.focus();
          return next;
        });
      }
    }
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => document.removeEventListener("keydown", handleKey, { capture: true });
  }, [rows.length, canAdd, canReorder, canRemove, canRename, dialogOpen, moveHostRow, requestRemove, openEdit, selectHost, onClose]);

  // Focus lands on the requested row on open: the right-clicked host's row,
  // the `+ Add Host…` footer for the `+` square (when an add path exists), else
  // the active row.
  useEffect(() => {
    const activeIdx = Math.max(
      rows.findIndex((r) => r.active),
      0,
    );
    let idx = activeIdx;
    if (initialFocus.kind === "host") {
      const hostIdx = rows.findIndex((r) => r.id === initialFocus.id);
      if (hostIdx >= 0) idx = hostIdx;
    } else if (canAdd) {
      idx = rows.length;
    }
    setFocusedIndex(idx);
    requestAnimationFrame(() => {
      itemRefs.current[idx]?.focus();
    });
    // Keys on mount only — re-running on a refetched row set would yank focus
    // while the user is arrowing through the menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-clamp the roving-tabindex seat when a refetch SHRINKS the row set below
  // it — otherwise no row would carry tabIndex=0 and focus falls to <body>. An
  // in-bounds seat is left alone, so a refetch that leaves the list unchanged
  // never yanks focus mid-arrowing.
  useEffect(() => {
    if (rows.length === 0) return;
    const itemCount = rows.length + (canAdd ? 1 : 0);
    setFocusedIndex((prev) => {
      if (prev < itemCount) return prev;
      const clamped = itemCount - 1;
      itemRefs.current[clamped]?.focus();
      return clamped;
    });
  }, [rows.length, canAdd]);

  // Add Host footer fork: an addDirect-capable shell opens the shared dialog
  // IN PLACE (the menu stays open behind it; on success the shell swaps the
  // view anyway). Older shells keep the welcome-page swap — a full page
  // navigation, so the menu just closes first.
  const openAddHost = useCallback(() => {
    if (canAddDirect) {
      setAddOpen(true);
      return;
    }
    onClose(false);
    void addShellHost().then((ok) => {
      if (!ok) addToast("Shell add host failed", "error");
    });
  }, [canAddDirect, addToast, onClose]);
  return (
    // Anchored under the opener inside the strip (which clips nothing below
    // it); both dialogs render inside the container so their backdrop
    // mousedown never trips the outside-click close.
    <div
      ref={containerRef}
      data-testid="shell-host-menu"
      className="rk-shell-no-drag absolute top-full z-50 mt-1"
      style={{ left: anchorLeft }}
    >
            <div
              role="menu"
              aria-label="Switch host"
              // The menu paints over SPA content below the band, so it uses
              // theme surface colors, not the strip's light.
              className="max-h-72 min-w-[220px] max-w-[320px] overflow-y-auto rounded-lg border border-border bg-bg-primary py-1 shadow-2xl"
            >
              {rows.map((row, i) => (
                // Row wrapper owns the hover/focus group and drag handlers;
                // icon buttons are SIBLINGS of the button (never nested).
                <div
                  key={row.id}
                  className="group relative"
                  onDragStart={(e) => onRowDragStart(e, row.id)}
                  onDragOver={(e) => onRowDragOver(e, row.id)}
                  onDrop={onRowDrop}
                  onDragEnd={onRowDragEnd}
                >
                  <button
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    // menuitemradio + aria-checked: the active host is a
                    // single-select state AT must hear, not a color-only cue
                    // (the view-switcher precedent; aria-pressed is invalid on
                    // a menu item).
                    role="menuitemradio"
                    aria-checked={row.active}
                    tabIndex={focusedIndex === i ? 0 : -1}
                    onClick={() => selectHost(row.id)}
                    draggable={canReorder}
                    className={`relative flex w-full items-baseline gap-2 py-2 pl-3 pr-12 text-left text-sm transition-colors ${
                      row.active
                        ? "text-accent-green"
                        : "text-text-secondary hover:bg-bg-card hover:text-text-primary"
                    }`}
                  >
                    {/* Accent edge bar — overlaid so colorless rows keep
                        alignment; hex-validated in the row model. */}
                    {row.accentColor !== null && (
                      <span
                        aria-hidden="true"
                        data-testid="shell-host-accent-bar"
                        className="absolute bottom-1 left-0 top-1 w-[3px] rounded-full"
                        style={{ backgroundColor: row.accentColor }}
                      />
                    )}
                    {/* Active marker column — fixed width so names align. */}
                    <span aria-hidden="true" className="w-3 shrink-0">
                      {row.active ? "✓" : ""}
                    </span>
                    <span className="min-w-0 shrink-0 truncate">{row.name}</span>
                    {/* Dimmed origin — display names are not unique, the
                        origin disambiguates. */}
                    <span className="min-w-0 truncate text-xs opacity-60">{row.origin}</span>
                    {/* Waiting count — background rows only; yields the
                        trailing zone while the cluster shows. */}
                    {row.waiting !== null && (
                      <span
                        className={`ml-auto shrink-0 pl-2 text-xs text-amber-600${
                          affordanceCount > 0
                            ? " group-hover:invisible group-has-[:focus-visible]:invisible"
                            : ""
                        }`}
                      >
                        ● {row.waiting}
                      </span>
                    )}
                    {/* Accelerator hint — the row's at-rest data, right-
                        aligned identically on every row; the hover cluster
                        takes over the zone. */}
                    {row.hint && (
                      <span
                        className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-secondary${
                          affordanceCount > 0
                            ? " group-hover:invisible group-has-[:focus-visible]:invisible"
                            : ""
                        }`}
                      >
                        {row.hint}
                      </span>
                    )}
                  </button>
                  {/* Hover/focus action cluster: edit · remove · grip.
                      Instant reveal (visibility, no fade) on a solid chip;
                      buttons tab-skip — Delete/Backspace and F2 are the
                      keyboard paths. Reveal is hover + :focus-visible (NOT
                      focus-within): the open-transition effect focuses the
                      active row programmatically, and after a pointer open
                      that focus must show the ⌥⌘n hint, not the cluster —
                      keyboard navigation still matches :focus-visible, and
                      `has` covers the cluster's own buttons when tabbed. */}
                  {affordanceCount > 0 && (
                    <div className="invisible absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded bg-bg-card px-1 py-0.5 group-hover:visible group-has-[:focus-visible]:visible">
                      {canRename && (
                        <Tip label="Edit">
                          <button
                            type="button"
                            aria-label="Edit"
                            tabIndex={-1}
                            onClick={() => openEdit(row)}
                            className="flex h-5 w-5 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary"
                          >
                            <svg
                              aria-hidden="true"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                        </Tip>
                      )}
                      {canRemove && (
                        <Tip label="Remove">
                          <button
                            type="button"
                            aria-label="Remove"
                            tabIndex={-1}
                            onClick={() => requestRemove(row)}
                            className="flex h-5 w-5 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary"
                          >
                            <svg
                              aria-hidden="true"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M5 12h14" />
                            </svg>
                          </button>
                        </Tip>
                      )}
                      {/* Drag grip — a REAL handle, not decoration: the
                          cluster is a SIBLING of the draggable row button, so
                          a pointer-events-none grip would drop presses on the
                          non-draggable cluster div and no drag could ever
                          start from the dots. Its dragstart bubbles to the
                          wrapper's shared handler; clicks on it stay inert
                          (a grip never selects the host). */}
                      {canReorder && (
                        <span
                          aria-hidden="true"
                          draggable
                          data-testid="shell-host-grip"
                          className="cursor-grab text-[10px] leading-none tracking-[-2px] text-text-secondary opacity-60"
                        >
                          ⋮⋮
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {canAdd && (
                <button
                  ref={(el) => {
                    itemRefs.current[rows.length] = el;
                  }}
                  type="button"
                  // Plain menuitem — an action, not a member of the host
                  // radio group. Last roving-tabindex stop (index rows.length).
                  role="menuitem"
                  tabIndex={focusedIndex === rows.length ? 0 : -1}
                  onClick={openAddHost}
                  className="mt-1 flex w-full items-baseline gap-2 border-t border-border px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-card hover:text-text-primary"
                >
                  {/* Aligned with the rows' fixed marker column. */}
                  <span aria-hidden="true" className="w-3 shrink-0">
                    +
                  </span>
                  <span className="min-w-0 truncate">Add Host…</span>
                </button>
              )}
            </div>
          {/* Both dialogs render inside the container so their backdrop
              mousedown never trips the menu's outside-click close. */}
          {confirmTarget !== null && (
            // The z-[60] wrapper lifts the dialog ABOVE the z-50 menu popover
            // (same stacking context): without it the menu paints over the
            // backdrop and stays clickable while the "modal" confirm is up.
            <div className="relative z-[60]">
              <Dialog title="Remove host" onClose={cancelRemove}>
                <p className="text-sm text-text-secondary mb-3">
                  Are you sure you want to remove <strong>{confirmTarget.name}</strong> (
                  {confirmTarget.origin})?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={cancelRemove}
                    className={`flex-1 ${controlClass({ variant: "confirm" })}`}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmRemove}
                    className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
                  >
                    Remove
                  </button>
                </div>
              </Dialog>
            </div>
          )}
          {editTarget !== null && (
            <HostFormDialog
              mode="edit"
              title="Edit host"
              initialName={editTarget.name}
              initialUrl={editTarget.origin}
              urlEnabled={canSetUrl}
              submitLabel="Save"
              onSubmit={saveEdit}
              onCancel={cancelEdit}
            />
          )}
          {addOpen && (
            <HostFormDialog
              mode="add"
              title="Add host"
              submitLabel="Add Host"
              onSuccess={() => setAddOpen(false)}
              onCancel={() => setAddOpen(false)}
            />
          )}
    </div>
  );
}
