import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalToast } from "@/components/toast";
import {
  canCloseShellWindow,
  canShellPopout,
  closeShellWindow,
  shellPopout,
} from "@/lib/shell";
import {
  applyPopoutSighting,
  forgetPopoutSighting,
  isPopoutMessage,
  POPOUT_CHANNEL,
  POPOUT_HEARTBEAT_MS,
  popoutFeatures,
  popoutSightingKey,
  popoutUrl,
  popoutWindowName,
  readPopped,
  snapshotPopoutSightings,
  sweepPopoutSightings,
  sweepStale,
  writePopped,
  type PopoutMessage,
  type PopoutSightings,
} from "@/lib/popout";
import type { Rect } from "@/lib/layout-tree";

/**
 * The opener/popout halves of the popout channel wiring (pure halves live in
 * `lib/popout.ts`). BroadcastChannel is same-origin per browser profile, so
 * "this viewer" is this browser profile — every opener tab of `@N` hides the
 * popped leaf, matching every other per-viewer key (`rk-layout-sizes:*`,
 * `rk-layout-zoom:*`). A missing BroadcastChannel (older engine, jsdom
 * without a stub) degrades the hooks to storage-only: marks still apply and
 * clear, only liveness (heartbeat/stale-sweep) and remote pop-in go silent.
 */

/** The channel a context posts on, or null when BroadcastChannel is
 *  unavailable (degrade-to-storage-only). */
function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(POPOUT_CHANNEL);
  } catch {
    return null;
  }
}

/** Why a popout failed to open: the browser refused the popup (`blocked`,
 *  reported synchronously) or the shell invoker resolved null (`failed`,
 *  reported asynchronously). */
export type PopoutOpenFailure = "blocked" | "failed";

/** The toast text for a failed popout open. */
export function popoutFailureMessage(reason: PopoutOpenFailure): string {
  return reason === "blocked" ? "Pop-out blocked by the browser" : "Pop-out failed";
}

/**
 * Open the popout window for a leaf of `(server, windowId)` — the one open
 * path shared by the tile header's Pop out and the sidebar card's Open in new
 * window. Callers own the popped-mark bookkeeping around it; `onFail` is
 * their rollback hook.
 */
export function openPopoutWindow(
  server: string,
  windowId: string,
  leafId: string,
  rect: Rect | undefined,
  onFail: (reason: PopoutOpenFailure) => void,
): void {
  if (canShellPopout()) {
    // A shell-hosted popout window shares this opener's origin and session,
    // so the marks/liveness wiring works unchanged — unlike the shell's
    // window.open policy, which sends everything to the system browser.
    void shellPopout(popoutUrl(server, windowId, leafId), rect).then((result) => {
      if (result === null) onFail("failed");
    });
    return;
  }
  const openedWindow = window.open(
    popoutUrl(server, windowId, leafId),
    popoutWindowName(server, windowId, leafId),
    popoutFeatures(rect),
  );
  if (openedWindow === null) onFail("blocked");
}

/** Focus the live popout window for a leaf without reloading it (the
 *  placeholder's go to window, the sidebar card's Focus window). */
export function focusPopoutWindow(server: string, windowId: string, leafId: string): void {
  if (canShellPopout()) {
    // Main's popout dedupe focuses/restores the existing popout for this
    // route and returns ok — no new window, no reload.
    void shellPopout(popoutUrl(server, windowId, leafId));
    return;
  }
  // The empty URL returns the named popout without navigating it; passing
  // the popout URL would reload an existing window (re-attaching the
  // terminal, losing web state). A null means the browser blocked it.
  const w = window.open("", popoutWindowName(server, windowId, leafId));
  if (w === null) return;
  // No popout by that name existed: navigate the fresh blank window to the
  // popout route, re-opening the popout.
  if (w.location.href === "about:blank") {
    w.location.href = popoutUrl(server, windowId, leafId);
  }
  w.focus();
}

export interface PopoutRegistry {
  /** The leaf ids of (server, window) live in a popout right now, or
   *  undefined when none. Its identity changes only when membership does. */
  poppedLeaves: (server: string, windowId: string) => ReadonlySet<string> | undefined;
  /** Record a popout this viewer just opened, before its first `opened`. */
  noteOpened: (server: string, windowId: string, leafId: string) => void;
  /** Drop a sighting now (a failed open, a pop-in already sent). */
  forget: (server: string, windowId: string, leafId: string) => void;
  /** Bring a popout back from OUTSIDE its window's opener (the sidebar, for a
   *  tab other than the route window): tell the popout to close, clear the
   *  viewer's popped mark for that window, drop the sighting. */
  popIn: (server: string, windowId: string, leafId: string) => void;
}

const NO_SIGHTINGS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/**
 * The viewer-wide popout registry (the sidebar's popped state for every tab):
 * folds every popout's `opened`/`alive`/`closed` traffic on the channel into
 * one sightings map and sweeps sightings silent for POPOUT_STALE_MS. Purely
 * presence-derived, so it also sees popouts opened from a tile header or from
 * another opener tab. A missing BroadcastChannel leaves it empty (no marker,
 * the card offers Open in new window, whose name dedupe focuses a live one).
 */
export function usePopoutRegistry(enabled: boolean): PopoutRegistry {
  const sightingsRef = useRef<PopoutSightings>(new Map());
  const [snapshot, setSnapshot] = useState(NO_SIGHTINGS);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const publish = useCallback(() => {
    setSnapshot(snapshotPopoutSightings(sightingsRef.current));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const channel = openChannel();
    channelRef.current = channel;
    const onMessage = (e: MessageEvent) => {
      const msg: unknown = e.data;
      if (!isPopoutMessage(msg)) return;
      if (applyPopoutSighting(sightingsRef.current, msg, Date.now())) publish();
    };
    channel?.addEventListener("message", onMessage);
    const sweep = window.setInterval(() => {
      if (sweepPopoutSightings(sightingsRef.current, Date.now())) publish();
    }, POPOUT_HEARTBEAT_MS);
    return () => {
      window.clearInterval(sweep);
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      channelRef.current = null;
    };
  }, [enabled, publish]);

  const poppedLeaves = useCallback(
    (server: string, windowId: string) => snapshot.get(popoutSightingKey(server, windowId)),
    [snapshot],
  );
  const noteOpened = useCallback(
    (server: string, windowId: string, leafId: string) => {
      const msg: PopoutMessage = { type: "opened", server, window: windowId, leaf: leafId };
      if (applyPopoutSighting(sightingsRef.current, msg, Date.now())) publish();
    },
    [publish],
  );
  const forget = useCallback(
    (server: string, windowId: string, leafId: string) => {
      if (forgetPopoutSighting(sightingsRef.current, server, windowId, leafId)) publish();
    },
    [publish],
  );
  const popIn = useCallback(
    (server: string, windowId: string, leafId: string) => {
      const msg: PopoutMessage = { type: "pop-in", server, window: windowId, leaf: leafId };
      channelRef.current?.postMessage(msg);
      writePopped(server, windowId, readPopped(server, windowId).filter((id) => id !== leafId));
      forget(server, windowId, leafId);
    },
    [forget],
  );

  return useMemo(
    () => ({ poppedLeaves, noteOpened, forget, popIn }),
    [poppedLeaves, noteOpened, forget, popIn],
  );
}

export interface PoppedSet {
  /** This viewer's popped leaf ids for the window (storage-backed). */
  popped: string[];
  /** Pop a tile out: optimistic mark, then open the popout (the shell's
   *  `windows.popout` invoker when the shell carries it, else `window.open`);
   *  a failed open rolls the mark back and toasts. */
  popOut: (leafId: string, rect?: Rect) => void;
  /** Pop a leaf back in: tell the popout to close and clear the mark. */
  popIn: (leafId: string) => void;
  /** Focus the live popout window without reloading it (the placeholder's
   *  go to window verb). */
  focusPopout: (leafId: string) => void;
}

/** The disabled hook's stable empty set — a fresh `[]` per render would
 *  re-key every consumer memo (the absent-server render-loop class). */
const NO_POPPED: string[] = [];

/**
 * The opener's popped-set hook: reads `rk-layout-popped:{server}:{@N}`,
 * applies marks immediately (no flash of the popped tile), and settles them
 * against the popouts' liveness — `ping` on mount (live popouts re-announce
 * with `opened` instead of the opener waiting a heartbeat), `opened`/`alive`
 * refresh a mark's last-seen, `closed` clears it, and a sweep interval drops
 * any mark silent for POPOUT_STALE_MS (a crashed popout where `pagehide`
 * never fired). `treeLeafIds` is the FULL shared tree's leaf ids: marks whose
 * leaf left the tree are pruned from storage (the popout itself keeps
 * running — it addresses the surface, not the layout).
 */
export function usePoppedSet(
  server: string,
  windowId: string,
  enabled: boolean,
  treeLeafIds: string[],
): PoppedSet {
  const toast = useOptionalToast();
  const [popped, setPopped] = useState<string[]>(() =>
    enabled ? readPopped(server, windowId) : [],
  );
  // Last `opened`/`alive` per leaf. Persisted marks seed at mount time so the
  // sweep gives them one full stale window to answer the mount `ping`.
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  // Render-mirrored refs for the interval/message closures (the
  // latest-closure pattern — effects key on identity, not values).
  const poppedRef = useRef(popped);
  poppedRef.current = popped;
  // Render-mirrored full-tree ids for the channel handler: an announced mark
  // is adopted only while its leaf is still in the shared tree — a pruned
  // leaf's popout keeps announcing, and re-adopting its mark would hide a
  // tile later re-added under the same id (the tree-key effect does not
  // rerun for a storage update).
  const treeIdsRef = useRef(treeLeafIds);
  treeIdsRef.current = treeLeafIds;
  // The effect-owned channel, shared with popIn so its `pop-in` post never
  // races a `close()` (a post on a closing channel can drop).
  const channelRef = useRef<BroadcastChannel | null>(null);

  const commit = useCallback(
    (next: string[]) => {
      writePopped(server, windowId, next);
      setPopped((prev) => {
        if (prev.length === next.length && prev.every((id, i) => id === next[i])) return prev;
        return next;
      });
    },
    [server, windowId],
  );

  // Channel lifecycle + stale sweep. Re-opens per (server, window).
  useEffect(() => {
    if (!enabled) return;
    const marks = readPopped(server, windowId);
    setPopped(marks);
    const now = Date.now();
    lastSeenRef.current = new Map(marks.map((id) => [id, now]));

    const channel = openChannel();
    channelRef.current = channel;
    const onMessage = (e: MessageEvent) => {
      const msg: unknown = e.data;
      if (!isPopoutMessage(msg)) return;
      if (msg.server !== server || msg.window !== windowId) return;
      switch (msg.type) {
        case "opened":
        case "alive": {
          lastSeenRef.current.set(msg.leaf, Date.now());
          if (!poppedRef.current.includes(msg.leaf) && treeIdsRef.current.includes(msg.leaf)) {
            // A sibling opener tab of this profile popped it — take the mark.
            commit([...poppedRef.current, msg.leaf]);
          }
          break;
        }
        case "closed":
          lastSeenRef.current.delete(msg.leaf);
          if (poppedRef.current.includes(msg.leaf)) {
            commit(poppedRef.current.filter((id) => id !== msg.leaf));
          }
          break;
        default:
          break; // pop-in/ping address popouts, not openers
      }
    };
    channel?.addEventListener("message", onMessage);
    const ping: PopoutMessage = { type: "ping", server, window: windowId, leaf: "" };
    channel?.postMessage(ping);

    const sweep = window.setInterval(() => {
      const alive = sweepStale(poppedRef.current, lastSeenRef.current, Date.now());
      if (alive.length !== poppedRef.current.length) commit(alive);
    }, POPOUT_HEARTBEAT_MS);

    return () => {
      window.clearInterval(sweep);
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      channelRef.current = null;
    };
  }, [server, windowId, enabled, commit]);

  // Prune marks whose leaf left the shared tree (another viewer closed the
  // tile): the reduction ignores them, and storage must not grow stale ids.
  // Keyed on the joined ids, not the array identity (the tree re-derives per
  // SSE tick).
  const treeKey = treeLeafIds.join("\n");
  useEffect(() => {
    if (!enabled) return;
    const valid = new Set(treeLeafIds);
    const pruned = poppedRef.current.filter((id) => valid.has(id));
    if (pruned.length !== poppedRef.current.length) commit(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeKey, enabled, commit]);

  const popOut = useCallback(
    (leafId: string, rect?: Rect) => {
      // Optimistic mark BEFORE opening the popout: the render hides the tile
      // in the same gesture, and a failed open rolls the mark back.
      const marked = poppedRef.current.includes(leafId)
        ? poppedRef.current
        : [...poppedRef.current, leafId];
      commit(marked);
      lastSeenRef.current.set(leafId, Date.now());
      openPopoutWindow(server, windowId, leafId, rect, (reason) => {
        // The shell's verdict is async: roll back only while the mark is
        // still this call's (a pop-in or a stale sweep that already cleared
        // it skips the toast). The browser's is synchronous — the
        // render-mirrored ref has not caught up with the commit above yet —
        // so it rolls back unconditionally.
        if (reason === "failed" && !poppedRef.current.includes(leafId)) return;
        commit(poppedRef.current.filter((id) => id !== leafId));
        lastSeenRef.current.delete(leafId);
        toast?.addToast(popoutFailureMessage(reason), "error");
      });
    },
    [server, windowId, commit, toast],
  );

  const popIn = useCallback(
    (leafId: string) => {
      const msg: PopoutMessage = { type: "pop-in", server, window: windowId, leaf: leafId };
      channelRef.current?.postMessage(msg);
      lastSeenRef.current.delete(leafId);
      commit(poppedRef.current.filter((id) => id !== leafId));
    },
    [server, windowId, commit],
  );

  const focusPopout = useCallback(
    (leafId: string) => focusPopoutWindow(server, windowId, leafId),
    [server, windowId],
  );

  return { popped: enabled ? popped : NO_POPPED, popOut, popIn, focusPopout };
}

export interface PopoutPresence {
  /** The header's Pop back in verb: announce the close and close the window;
   *  the opener clears its mark on the `closed` message — equivalent to
   *  closing the window by any other means. */
  closeSelf: () => void;
}

/** Close the popout's own window: `window.close()` is a no-op for a shell
 *  host view, so a shell carrying the `close` invoker closes through it. */
function closeThisWindow(): void {
  if (canCloseShellWindow()) {
    void closeShellWindow();
  } else {
    window.close();
  }
}

/**
 * The popout's presence hook: announces itself (`opened` on mount and in
 * reply to an opener's `ping`), heartbeats (`alive` every
 * POPOUT_HEARTBEAT_MS), and signs off (`closed` on `pagehide`). An opener's
 * `pop-in` for THIS leaf closes the window. Only messages naming this
 * server/window (and leaf, for `pop-in`) are acted on.
 */
export function usePopoutPresence(
  server: string,
  windowId: string,
  leafId: string,
  enabled: boolean,
): PopoutPresence {
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const channel = openChannel();
    channelRef.current = channel;
    const announce = () => {
      const msg: PopoutMessage = { type: "opened", server, window: windowId, leaf: leafId };
      channel?.postMessage(msg);
    };
    const signOff = () => {
      const msg: PopoutMessage = { type: "closed", server, window: windowId, leaf: leafId };
      channel?.postMessage(msg);
    };
    announce();
    const heartbeat = window.setInterval(() => {
      const msg: PopoutMessage = { type: "alive", server, window: windowId, leaf: leafId };
      channel?.postMessage(msg);
    }, POPOUT_HEARTBEAT_MS);
    const onMessage = (e: MessageEvent) => {
      const msg: unknown = e.data;
      if (!isPopoutMessage(msg)) return;
      if (msg.server !== server || msg.window !== windowId) return;
      if (msg.type === "ping") {
        announce();
      } else if (msg.type === "pop-in" && msg.leaf === leafId) {
        signOff();
        closeThisWindow();
      }
    };
    channel?.addEventListener("message", onMessage);
    window.addEventListener("pagehide", signOff);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("pagehide", signOff);
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      channelRef.current = null;
    };
  }, [server, windowId, leafId, enabled]);

  const closeSelf = useCallback(() => {
    const msg: PopoutMessage = { type: "closed", server, window: windowId, leaf: leafId };
    channelRef.current?.postMessage(msg);
    closeThisWindow();
  }, [server, windowId, leafId]);

  return { closeSelf };
}
