import { useEffect, useRef } from "react";
import { setShellNameplate } from "@/lib/shell";
import { useHostNameplate } from "./use-host-nameplate";

/**
 * Desktop-shell nameplate reporter: mirrors this host's machine / OS / agent
 * count to the shell over the `nameplate.set` bridge, where it joins the
 * `servers:list` projection so ANOTHER host's strip can preview this host in
 * its nameplate on hover. Renders nothing; callers gate the mount on
 * `isShell()` (no-op in browsers).
 *
 * Reports on initial resolve and on CHANGE only (the serialized facts are the
 * effect dependency and a ref guards duplicates — the badge reporter's
 * shape); nothing is reported until at least one fact is known.
 * `setShellNameplate` never throws — an older shell without the group
 * resolves false.
 */
export function ShellNameplateReporter() {
  const facts = useHostNameplate();
  const lastReportedRef = useRef<string | null>(null);
  const key = JSON.stringify([facts.machine, facts.os, facts.agents]);

  useEffect(() => {
    if (facts.machine === undefined && facts.os === undefined && facts.agents === undefined) return;
    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    void setShellNameplate(facts);
    // `facts` is derived from `key`'s inputs; `key` is the change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}
