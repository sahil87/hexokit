/**
 * node:test suite for the web-proxy pure logic (run via `pnpm run test`
 * after compile — the `web-views.test.ts` convention).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  guestPartitionName,
  proxyRulesFor,
  setProxyConfigFor,
  settleHostProxy,
  webProxyModeFor,
} from "./web-proxy";

// ── guestPartitionName ──────────────────────────────────────────────────────

test("guestPartitionName keys the partition on the host id", () => {
  assert.equal(guestPartitionName("b3f1-uuid"), "persist:rk-web:b3f1-uuid");
  assert.notEqual(guestPartitionName("a"), guestPartitionName("b"));
});

// ── webProxyModeFor ─────────────────────────────────────────────────────────

test("a remote-field host with a LOOPBACK origin is never direct (SSH tunnel)", () => {
  const ssh = { url: "http://127.0.0.1:3100", remote: "buildbox" };
  // The origin matches the local daemon origin exactly — remote still wins.
  assert.equal(webProxyModeFor(ssh, "http://127.0.0.1:3100", true), "proxy");
  assert.equal(webProxyModeFor(ssh, "http://127.0.0.1:3000", true), "proxy");
  assert.equal(webProxyModeFor(ssh, null, true), "proxy");
  assert.equal(webProxyModeFor(ssh, null, false), "legacy");
});

test("an exact local-daemon origin match is direct", () => {
  const host = { url: "http://localhost:3000" };
  assert.equal(webProxyModeFor(host, "http://localhost:3000", false), "direct");
  assert.equal(webProxyModeFor(host, "http://localhost:3000", true), "direct");
});

test("a loopback origin with NO local-daemon answer is direct", () => {
  assert.equal(webProxyModeFor({ url: "http://localhost:3000" }, null, false, "linux"), "direct");
  assert.equal(webProxyModeFor({ url: "http://127.0.0.1:3000" }, null, false, "darwin"), "direct");
  assert.equal(webProxyModeFor({ url: "http://[::1]:3000" }, null, false, "linux"), "direct");
});

test("on Windows a loopback origin is never assumed local (mirrors interstitialKindFor)", () => {
  assert.equal(webProxyModeFor({ url: "http://127.0.0.1:3000" }, null, true, "win32"), "proxy");
  assert.equal(webProxyModeFor({ url: "http://127.0.0.1:3000" }, null, false, "win32"), "legacy");
});

test("a loopback origin that is NOT the local daemon is probe-gated", () => {
  // rk answered with a different origin (e.g. 127.0.0.1 form vs localhost):
  // the loopback fallback applies only when there is NO local origin.
  const host = { url: "http://localhost:3400" };
  assert.equal(webProxyModeFor(host, "http://127.0.0.1:3400", true), "proxy");
  assert.equal(webProxyModeFor(host, "http://127.0.0.1:3400", false), "legacy");
});

test("a non-loopback host is probe-gated", () => {
  const host = { url: "http://100.101.2.3:3000" };
  assert.equal(webProxyModeFor(host, "http://127.0.0.1:3000", true), "proxy");
  assert.equal(webProxyModeFor(host, "http://127.0.0.1:3000", false), "legacy");
  assert.equal(webProxyModeFor(host, null, false), "legacy");
});

// ── proxyRulesFor ───────────────────────────────────────────────────────────

test("proxyRulesFor targets the host's loopback proxy listener", () => {
  assert.equal(proxyRulesFor(40123), "http://127.0.0.1:40123");
  assert.equal(proxyRulesFor(1), "http://127.0.0.1:1");
  assert.equal(proxyRulesFor(65535), "http://127.0.0.1:65535");
});

// ── setProxyConfigFor ───────────────────────────────────────────────────────

test("proxy mode with rules is fixed_servers with the loopback bypass removed", () => {
  assert.deepEqual(setProxyConfigFor("proxy", "http://127.0.0.1:3100"), {
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:3100",
    proxyBypassRules: "<-loopback>",
  });
});

test("proxy mode without rules degrades to direct", () => {
  assert.deepEqual(setProxyConfigFor("proxy", null), { mode: "direct" });
});

test("direct and legacy modes are plain direct sessions", () => {
  assert.deepEqual(setProxyConfigFor("direct", null), { mode: "direct" });
  assert.deepEqual(setProxyConfigFor("legacy", null), { mode: "direct" });
  assert.deepEqual(setProxyConfigFor("legacy", "http://127.0.0.1:3100"), { mode: "direct" });
});

// ── settleHostProxy ─────────────────────────────────────────────────────────

/** Effect spies with a controllable staleness flag. */
function settleEffects(current: () => boolean, listener: { port: number } | null = { port: 40123 }) {
  const calls = { probe: 0, listener: 0, setProxy: 0 };
  return {
    calls,
    effects: {
      probeTunnel: () => {
        calls.probe += 1;
        return Promise.resolve(true);
      },
      ensureListener: () => {
        calls.listener += 1;
        return Promise.resolve(listener);
      },
      setProxy: () => {
        calls.setProxy += 1;
        return Promise.resolve();
      },
      isCurrent: current,
    },
  };
}

const remoteHost = { url: "http://100.101.2.3:3000", remote: "buildbox" };

test("settleHostProxy probes, creates the listener, and applies proxy rules", async () => {
  const { calls, effects } = settleEffects(() => true);
  const mode = await settleHostProxy(remoteHost, null, effects);
  assert.equal(mode, "proxy");
  assert.deepEqual(calls, { probe: 1, listener: 1, setProxy: 1 });
});

test("settleHostProxy a stale query runs NO side effects after the probe", async () => {
  // The host's URL changed while the probe was in flight (main.ts replaced
  // the pending entry): no listener for the superseded origin, no setProxy
  // on the shared guest session.
  let current = true;
  const { calls, effects } = settleEffects(() => current);
  const probe = effects.probeTunnel;
  effects.probeTunnel = async () => {
    const ok = await probe();
    current = false;
    return ok;
  };
  const mode = await settleHostProxy(remoteHost, null, effects);
  assert.equal(mode, "proxy"); // the derivation still answers the caller
  assert.deepEqual(calls, { probe: 1, listener: 0, setProxy: 0 });
});

test("settleHostProxy a query gone stale during listener creation skips setProxy", async () => {
  let current = true;
  const { calls, effects } = settleEffects(() => current);
  const ensure = effects.ensureListener;
  effects.ensureListener = async () => {
    const listener = await ensure();
    current = false;
    return listener;
  };
  const mode = await settleHostProxy(remoteHost, null, effects);
  assert.equal(mode, "proxy");
  assert.deepEqual(calls, { probe: 1, listener: 1, setProxy: 0 });
});

test("settleHostProxy degrades to legacy when no listener is available", async () => {
  const { calls, effects } = settleEffects(() => true, null);
  const mode = await settleHostProxy(remoteHost, null, effects);
  assert.equal(mode, "legacy");
  assert.deepEqual(calls, { probe: 1, listener: 1, setProxy: 1 });
});
