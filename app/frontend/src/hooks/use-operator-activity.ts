import { useCallback, useEffect, useState } from "react";
import { getOperatorActivity, type OperatorActivityResponse } from "@/api/client";
import { useSessionContext } from "@/contexts/session-context";

const EMPTY_ACTIVITY: OperatorActivityResponse = { server: "", in_flight: null, rows: [] };

/**
 * Fetch GET /api/operator/activity for `server`, refreshed like `useCronData`:
 * once on mount, then on every state-socket `sessions` event for this server
 * (the slice's array identity changes per event), plus an explicit `refetch`
 * for the caller's own writes. No timers, no polling loop.
 *
 * An empty `server` fires no request and yields the empty shape. Failures keep
 * the last good data. The cached data is keyed to the server that produced
 * it: a server switch yields the empty shape until the new server's first
 * fetch resolves. `fetchedAt` bumps on every successful fetch so a caller can
 * tell "the next fetch returned".
 */
export function useOperatorActivity(server: string): {
  data: OperatorActivityResponse;
  fetchedAt: number;
  refetch: () => void;
} {
  const { sessionsByServer } = useSessionContext();
  const sessions = sessionsByServer.get(server);
  const [state, setState] = useState<{
    server: string;
    data: OperatorActivityResponse;
    fetchedAt: number;
  }>({ server: "", data: EMPTY_ACTIVITY, fetchedAt: 0 });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!server) return;
    let cancelled = false;
    getOperatorActivity(server)
      .then((data) => {
        if (!cancelled) setState((prev) => ({ server, data, fetchedAt: prev.fetchedAt + 1 }));
      })
      .catch(() => {
        // Fail-silent: a transient error keeps the last good data; the next
        // sessions tick retries.
      });
    return () => {
      cancelled = true;
    };
  }, [server, sessions, tick]);

  const refetch = useCallback(() => setTick((n) => n + 1), []);
  const live = server !== "" && state.server === server;
  return {
    data: live ? state.data : EMPTY_ACTIVITY,
    fetchedAt: live ? state.fetchedAt : 0,
    refetch,
  };
}
