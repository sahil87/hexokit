import { useMatches } from "@tanstack/react-router";

/** The `window` route param of the deepest matched route that has one (the
 *  tab being viewed), or undefined off a tab route. */
export function useRouteWindowId(): string | undefined {
  const matches = useMatches();
  return matches
    .map((m) => (m.params as { window?: string }).window)
    .reverse()
    .find((w): w is string => typeof w === "string");
}
