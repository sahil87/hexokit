/** The daemon route the MCP streamable-HTTP transport is mounted at — mirrors
 *  `HTTPRoutePath` in `app/backend/internal/mcp/http.go`. */
export const MCP_ROUTE_PATH = "/mcp";

/**
 * The MCP endpoint as THIS browser reaches the daemon. Every API call is
 * relative, so the page origin is the daemon's address from this device —
 * through whatever proxy fronts it (`tailscale serve`, the Vite dev rig) —
 * which the daemon's own bind address (`rk url --mcp`) is not.
 */
export function mcpEndpointUrl(): string {
  return `${window.location.origin}${MCP_ROUTE_PATH}`;
}
