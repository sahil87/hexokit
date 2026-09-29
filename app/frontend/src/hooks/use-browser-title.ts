import { useEffect } from "react";

/**
 * Sets document.title based on route params and hostname.
 *
 * Dashboard: "HexoKit — {hostname}" or "HexoKit" if hostname is empty.
 * Terminal:  "{session}/{window} — {hostname}" or "{session}/{window}" if empty.
 * `override` (the popout window's "<Surface> · <window name>") wins outright
 * when present.
 */
export function useBrowserTitle(
  sessionName: string | undefined,
  windowIndex: string | undefined,
  hostname: string,
  override?: string,
): void {
  useEffect(() => {
    // The popout window's `<Surface> · <window name>` title wins outright
    // when present — it names the popped surface, not the session/window
    // pair.
    if (override !== undefined) {
      document.title = override;
      return;
    }
    const suffix = hostname ? ` \u2014 ${hostname}` : "";
    if (sessionName && windowIndex) {
      document.title = `${sessionName}/${windowIndex}${suffix}`;
    } else {
      document.title = `HexoKit${suffix}`;
    }
  }, [sessionName, windowIndex, hostname, override]);
}
