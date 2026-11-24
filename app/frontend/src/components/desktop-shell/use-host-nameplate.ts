import { useContext, useEffect, useMemo, useState } from "react";
import { getHealth } from "@/api/client";
import { SessionContext } from "@/contexts/session-context";
import type { ShellNameplateReport } from "@/lib/shell";
import { countAgentsAcrossServers } from "@/lib/waiting";

/**
 * This host's own nameplate facts — what the strip shows for the active host
 * and what the nameplate reporter sends the shell for other windows' hover
 * previews. `machine` is `${sshUser}@${hostname}` from `/api/health` (the os
 * hostname: `location.hostname` would read `127.0.0.1` on an SSH tunnel; the
 * `user@` prefix is omitted without an `sshUser`), `os` is the daemon's
 * `runtime.GOOS` (absent on older daemons), and `agents` derives from the SSE
 * session data already in the client (null-safe without a SessionProvider).
 */
export function useHostNameplate(): ShellNameplateReport {
  const session = useContext(SessionContext);
  const [health, setHealthFacts] = useState<{ machine?: string; os?: string }>({});

  useEffect(() => {
    let live = true;
    void getHealth()
      .then((h) => {
        if (!live) return;
        const machine = h.sshUser ? `${h.sshUser}@${h.hostname}` : h.hostname;
        setHealthFacts({ machine, os: h.os });
      })
      .catch(() => {
        // Health is best-effort chrome: the nameplate degrades to the name.
      });
    return () => {
      live = false;
    };
  }, []);

  const sessionsByServer = session?.sessionsByServer;
  const agents = useMemo(
    () => (sessionsByServer ? countAgentsAcrossServers(sessionsByServer) : undefined),
    [sessionsByServer],
  );

  return { ...health, ...(agents !== undefined ? { agents } : {}) };
}
