import { useMatches } from "@tanstack/react-router";
import type { TopBarMode } from "@/components/top-bar";
import { useTopBarNotFound } from "@/contexts/top-bar-slot-context";

/**
 * The route-derived inputs of the top bar: its `mode` plus the route params
 * the bar renders synchronously from the URL (before any page registers into
 * the slot). Param NAMES are unique across the route tree (`window` only on
 * the terminal route, `server` on the server layout, `name` on the board
 * route), so their presence fully determines the mode — the deepest-first
 * walk `SessionContext` uses for `currentServer`. The host (`/`) carries no
 * params and resolves to `host`.
 *
 * The not-found page signals its render via context and MUST win over the
 * param walk: TanStack Router's fuzzy not-found handling RETAINS the
 * partially-matched params (`/board/x/y` keeps `name=x`), which alone would
 * derive `board` over the not-found body. `boardName` is therefore withheld
 * while not-found renders.
 *
 * One derivation shared by `RootTopBar` and every other surface that must
 * agree with the bar (the New split button in the mobile drawer).
 */
export function useTopBarMode(): {
  mode: TopBarMode;
  serverParam: string | undefined;
  boardName: string | undefined;
} {
  const matches = useMatches();
  const notFound = useTopBarNotFound();
  let serverParam: string | undefined;
  let windowParam: string | undefined;
  let boardParam: string | undefined;
  for (let i = matches.length - 1; i >= 0; i--) {
    const p = (matches[i]?.params ?? {}) as { server?: string; window?: string; name?: string };
    if (serverParam === undefined && typeof p.server === "string") serverParam = p.server;
    if (windowParam === undefined && typeof p.window === "string") windowParam = p.window;
    if (boardParam === undefined && typeof p.name === "string") boardParam = p.name;
  }
  let mode: TopBarMode;
  if (notFound) mode = "host";
  else if (boardParam !== undefined) mode = "board";
  else if (windowParam !== undefined) mode = "terminal";
  else if (serverParam !== undefined) mode = "server";
  else mode = "host";
  return { mode, serverParam, boardName: notFound ? undefined : boardParam };
}
