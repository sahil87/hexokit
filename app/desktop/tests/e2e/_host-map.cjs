/**
 * Main-process preload (`-r`) for the unresolvable-origin rig: maps the
 * hostnames listed in RK_E2E_HOST_MAP (`name=ip[,name=ip…]`) to fixed
 * addresses in Node's `dns.lookup`.
 *
 * Constraint the launcher cannot show: Chromium's `--host-resolver-rules`
 * reaches the renderer and `net.fetch`, but not the main process's Node
 * networking — the tunnel proxy's `/ws/tunnel` client is Node's global
 * WebSocket (undici → `net.connect` → `dns.lookup`). The rig needs the
 * SHELL to resolve a name the rk server cannot, so both resolvers are mapped:
 * this file for Node, the switch for Chromium (`_shell.ts`
 * `unresolvableHostRig`). Plain CommonJS so `-r` loads it before the app.
 */
const dns = require("node:dns");

const entries = new Map();
for (const pair of (process.env.RK_E2E_HOST_MAP || "").split(",")) {
  const eq = pair.indexOf("=");
  if (eq > 0) entries.set(pair.slice(0, eq), pair.slice(eq + 1));
}

if (entries.size > 0) {
  const realLookup = dns.lookup;
  dns.lookup = function lookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options !== null ? options : {};
    const mapped = entries.get(hostname);
    if (mapped === undefined) return realLookup.apply(this, arguments);
    if (opts.all) {
      process.nextTick(cb, null, [{ address: mapped, family: 4 }]);
    } else {
      process.nextTick(cb, null, mapped, 4);
    }
    return undefined;
  };
}
