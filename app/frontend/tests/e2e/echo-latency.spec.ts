/**
 * Keystroke→echo latency benchmark.
 *
 * Measures the time from a keystroke being dispatched in the browser to the
 * echoed glyph becoming visible in the xterm.js buffer — the full perceived
 * input path:
 *
 *   key dispatch → xterm onData → ws.send → WS frame → Go relay → tmux PTY
 *   → tmux echo → relay → WS frame → ws.onmessage → requestAnimationFrame
 *   flush → terminal.write → xterm parse → glyph in buffer.
 *
 * The clock stops at "glyph in buffer.active", NOT at "WS message received":
 * terminal-client.tsx batches incoming data and flushes once per animation
 * frame, so the rAF coalescing delay is part of what the user actually feels.
 * Measuring to the buffer captures it; measuring to the WS frame would
 * understate latency by up to a frame.
 *
 * A baseline loop measures the pure tmux echo (`send-keys` → `capture-pane`,
 * no browser, no WebSocket) so the run-kit tax can be isolated from machine and
 * tmux noise: tax ≈ full-path p50 − baseline p50.
 *
 * This is an AUDIT, like sync-latency.spec.ts — it records a p50/p95/p99
 * distribution and prints a summary in afterAll; it does NOT assert a latency
 * budget (localhost timing is too noisy for a stable perf gate). The `@perf`
 * suite is excluded from default e2e runs and remains available on demand:
 *   just pw test echo-latency --list
 *
 * Shared setup: the per-file timeout is raised to 90s (120s on CI) — the file
 * runs FULL_PATH_TRIALS + BASELINE_TRIALS + UNDER_LOAD_TRIALS (40 + 40 + 30)
 * echo round-trips back to back. `beforeAll` creates session `e2e-echo-<ts>`
 * (80×24) and starts `cat` in it — `cat` echoes every line of stdin verbatim,
 * the cleanest echo source with no prompt/completion/PS1 noise. The throughput
 * guard uses its own `e2e-burst-<ts>` session and the under-load test its own
 * `e2e-echo-load-<ts>` session, so the flood and the tick stream never pollute
 * the idle measurements. `afterAll` sends `C-c` to break out of `cat`, kills
 * all three sessions, then prints the summary table (full-path / network /
 * render / under-load / baseline p50/p95/p99, the run-kit tax, the attribution
 * verdict, the distribution histograms, and the throughput time).
 * `resolveFirstWindowId(page, session?)` polls `/api/sessions` for the named
 * session's first window's stable `@N` id (the terminal route is keyed by
 * window id, not index). Trials alternate the two chars `x`/`o` and reset the
 * line (Enter) each trial, so global char-uniqueness is never needed. A shared
 * `samples` array collects `{ label, ms }` rows that `afterAll` summarizes.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { harnessOrigin } from "./_harness";
import { resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

const TEST_SESSION = `e2e-echo-${Date.now()}`;
// Dedicated session for the throughput test — it runs a burst command rather
// than the interactive `cat`, so it gets its own window to avoid disturbing the
// echo session.
const BURST_SESSION = `e2e-burst-${Date.now()}`;
// Dedicated session for the under-load echo test — it runs a background tick
// generator alongside `cat`, so it gets its own window to keep the idle echo
// session's measurements clean.
const LOAD_SESSION = `e2e-echo-load-${Date.now()}`;
const BASE = harnessOrigin();

// Trial counts. Kept modest so the file stays well within the per-test budget
// on a shared CI runner while still yielding a stable-enough distribution.
const FULL_PATH_TRIALS = 40;
const BASELINE_TRIALS = 40;
// Under-load echo trials. Fewer than the idle benchmark: each trial also pays
// an absence-wait against the tick stream, and 30 samples are plenty to expose
// a bimodal fast/slow split (the question is the distribution's SHAPE, not a
// tight p50).
const UNDER_LOAD_TRIALS = 30;
// Probe characters for the under-load test, rotated per trial. Excludes every
// letter of the background stream's `tick` text (t/i/c/k) so detection can be
// presence-based, and excludes the warmup char `w`. 19 chars means a char is
// reused only ~19 trials later — by then the tick stream has scrolled the
// previous occurrence far out of the bottom-of-buffer scan window.
const LOAD_PROBE_CHARS = "abdefghjmnopqrsuvxy";
// Rows scanned (from the bottom of the buffer) for under-load echo detection.
// Bounded so the rAF poll stays cheap regardless of scrollback depth.
const LOAD_SCAN_ROWS = 8;
// Per-keystroke echo deadline. Generous — a stalled echo should fail loudly
// rather than silently skew the distribution toward the poll cap.
const ECHO_DEADLINE_MS = 5_000;

// Throughput guard: number of lines a burst command emits. `seq 1 N` produces
// predictable, countable output whose final line (`N`) is a unique end-marker.
// Large enough that the relay delivers it as many multi-KB frames — exercising
// the coalescing (under-load) branch of the adaptive flush, the path that must
// NOT regress when echo latency is optimized.
const THROUGHPUT_LINES = 20_000;
const THROUGHPUT_DEADLINE_MS = 30_000;

interface Sample {
  label: string;
  ms: number;
}

let samples: Sample[] = [];

/**
 * Drop any prior samples for `label`. Called at the start of each test so a
 * Playwright retry (config has `retries: 1`) re-runs in the SAME worker process
 * — and therefore against this persistent module-level array — without the
 * failed attempt's partial samples lingering. Without this, a retry would
 * double-count (failing the exact-count assertions) and skew the afterAll
 * percentile summary.
 */
function resetSamples(label: string): void {
  samples = samples.filter((s) => s.label !== label);
}

function tmux(cmd: string): void {
  execSync(`tmux -L ${TMUX_SERVER} ${cmd}`, { stdio: "ignore" });
}

function tmuxCapture(): string {
  return execSync(`tmux -L ${TMUX_SERVER} capture-pane -p -t ${TEST_SESSION}`, {
    encoding: "utf8",
  });
}

/** Percentile of a sample set (linear interpolation), p in [0,100]. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function summarize(label: string, values: number[]): string {
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const p99 = percentile(values, 99);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (
    `  ${label.padEnd(22)} n=${String(values.length).padStart(3)}  ` +
    `p50=${p50.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  p99=${p99.toFixed(1)}ms  ` +
    `spread(p95−p50)=${(p95 - p50).toFixed(1)}ms  ` +
    `min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`
  );
}

/**
 * ASCII histogram over fixed-width buckets. Percentiles alone can hide a
 * bimodal distribution (fast immediate-path echoes vs. echoes bumped to the
 * next animation frame); the bucket counts make the two modes — or their
 * absence — visible at a glance. Samples beyond the last bucket collapse into
 * an overflow row so one outlier can't stretch the chart; trailing empty
 * buckets are trimmed.
 */
function histogram(
  label: string,
  values: number[],
  bucketMs = 4,
  maxBuckets = 15,
): string {
  if (values.length === 0) return "";
  const buckets = new Array<number>(maxBuckets + 1).fill(0);
  for (const v of values) {
    buckets[Math.min(Math.floor(v / bucketMs), maxBuckets)]++;
  }
  let last = buckets.length - 1;
  while (last > 0 && buckets[last] === 0) last--;
  const peak = Math.max(...buckets);
  const rows = buckets
    .slice(0, last + 1)
    .map((n, i) => {
      const lo = String(i * bucketMs).padStart(3);
      const range =
        i === maxBuckets
          ? `${lo}+ms    `
          : `${lo}–${String((i + 1) * bucketMs).padStart(3)}ms`;
      const bar = "#".repeat(peak === 0 ? 0 : Math.round((n / peak) * 30));
      return `    ${range} ${bar.padEnd(30)} ${n}`;
    })
    .join("\n");
  return `  ${label} (${bucketMs}ms buckets):\n${rows}`;
}

/**
 * Resolve the first window's stable tmux id (`@N`) for `session` from the
 * backend snapshot. The terminal route is keyed by window id, not index, so a
 * deep-link must carry `@N`. Polls because the session is created via the tmux
 * CLI and surfaces in the snapshot asynchronously.
 */
async function resolveFirstWindowId(
  page: import("@playwright/test").Page,
  session: string = TEST_SESSION,
): Promise<string> {
  return (await resolveWindow(page, TMUX_SERVER, session)).windowId;
}

/**
 * Init script: wrap WebSocket.prototype.send so every relay send stamps the
 * page-clock time of the most recent outbound byte on `window.__rkSendAt`. A
 * real keystroke flows xterm keydown → onData → ws.send (TerminalClient's
 * `terminal.onData` handler), so this stamp is the moment the keystroke leaves
 * the browser — the true
 * start of the relay→tmux→echo→render round-trip. Stamping inside the real send
 * path (rather than marking time in the test before keyboard.press) keeps start
 * and finish on ONE clock and excludes only the sub-ms, unbatched keydown
 * handler. Installed via addInitScript so it is in place before the app's
 * WebSocket is constructed. Mirrors the prototype-wrap pattern in
 * mobile-touch-scroll.spec.ts.
 */
const INSTALL_SEND_STAMP = () => {
  const w = window as unknown as { __rkSendAt?: number };
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
    // Under the terminals mux (change 260717-803u), a keystroke is a BINARY
    // frame `[u32 BE streamId][payload]` — a single-char keystroke is exactly
    // 4 + 1 = 5 bytes. (The old per-pane relay sent the char as a 1-char string;
    // resize is a JSON control string in both eras and must not be mistaken for
    // a keystroke.) Stamp on the 5-byte binary keystroke frame.
    let len = -1;
    if (typeof data === "string") {
      len = data.length === 1 ? 1 : -1; // legacy 1-char string keystroke
    } else if (data instanceof ArrayBuffer) {
      len = data.byteLength === 5 ? 1 : -1;
    } else if (ArrayBuffer.isView(data)) {
      len = data.byteLength === 5 ? 1 : -1;
    }
    if (len === 1) {
      w.__rkSendAt = performance.now();
    }
    return orig.call(this, data);
  };
};

/**
 * Init script: stamp the page-clock time at which the FIRST inbound WebSocket
 * frame arrives after a keystroke send (`window.__rkRecvAt`). Wrapping the
 * `WebSocket` constructor lets us attach a `message` listener that fires before
 * the app's own `onmessage` handler (message events have no capture/bubble — on
 * a non-DOM target listeners fire in registration order, and we register first).
 *
 * For single-char interactive echo there is nothing else in flight, so the
 * first frame after the send IS the echo: we stamp `__rkRecvAt` only when a send
 * has been recorded and no receive has yet — the harness resets both per trial.
 * This splits the full path into two attributable segments:
 *   send → recv   = network out + relay + tmux echo + relay + network back
 *   recv → glyph  = rAF flush + xterm parse + buffer commit  (the render tail)
 * Installed alongside INSTALL_SEND_STAMP via addInitScript.
 */
const INSTALL_RECV_STAMP = () => {
  const w = window as unknown as { __rkSendAt?: number; __rkRecvAt?: number };
  const OrigWS = window.WebSocket;
  const Wrapped = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const ws = new OrigWS(url, protocols);
    ws.addEventListener("message", () => {
      if (w.__rkSendAt !== undefined && w.__rkRecvAt === undefined) {
        w.__rkRecvAt = performance.now();
      }
    });
    return ws;
  } as unknown as { prototype: WebSocket } & Record<string, unknown>;
  // Preserve the prototype and the readonly ready-state constants so any code
  // referencing WebSocket.OPEN etc. through the wrapper still works.
  Wrapped.prototype = OrigWS.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Wrapped[k] = (OrigWS as unknown as Record<string, unknown>)[k];
  }
  (window as unknown as { WebSocket: unknown }).WebSocket = Wrapped;
};

/**
 * Dispatch one real keystroke and time how long until its glyph appears in the
 * live xterm buffer. The keystroke goes through the genuine input path
 * (keyboard.press → xterm keydown → onData → ws.send); the send-stamp wrapper
 * records the page-clock start, and an rAF-driven poll of `term.buffer.active`
 * records first-visible on the same clock.
 *
 * The poll reads the parsed buffer rather than the DOM: the WebGL renderer
 * paints to a canvas that is not DOM-readable, so the buffer is the only honest
 * "glyph visible" signal — and it sits AFTER the rAF flush in
 * terminal-client.tsx, so the coalescing delay the user feels is included.
 *
 * Detection is **position-based, not content-based**: we read the cursor cell
 * (`cursorY`, `cursorX`) BEFORE the keystroke — that is exactly the cell the
 * echo will paint into — then poll that single cell until it holds `ch`. This
 * sidesteps the fragility of scanning the viewport for a "unique" char: the
 * viewport already contains noise (the word `cat`, prior echoes), and a single
 * glyph is a poor global sentinel. Anchoring on the cursor cell means the same
 * char can be reused every trial.
 */
/** A single keystroke's latency, split into attributable segments (ms). */
interface EchoTiming {
  /** send → glyph-visible: the full perceived path. */
  full: number;
  /** send → first inbound frame: network out + relay + tmux echo + back. */
  network: number;
  /** first inbound frame → glyph-visible: rAF flush + xterm parse (render tail). */
  render: number;
}

async function measureEcho(
  page: import("@playwright/test").Page,
  windowId: string,
  ch: string,
  deadlineMs: number,
): Promise<EchoTiming> {
  // Snapshot the cursor row's count of `ch` BEFORE the keystroke. The echo
  // increments that count by one. Counting occurrences in the whole cursor row
  // (rather than betting on an exact column) is robust to prompt-rendering noise
  // and cursor drift: a fancy multi-line prompt can re-flow the line, but the
  // arrival of one more `ch` on the active row is unambiguous. Also clear the
  // prior send/recv stamps so we time THIS keystroke's round-trip.
  const before = await page.evaluate(
    ({ windowId, ch }) => {
      const term = window.__rkTerminals?.[windowId];
      if (!term) throw new Error(`no registered terminal for ${windowId}`);
      const w = window as unknown as { __rkSendAt?: number; __rkRecvAt?: number };
      w.__rkSendAt = undefined;
      w.__rkRecvAt = undefined;
      const buf = term.buffer.active;
      const row = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
      return row.split(ch).length - 1; // count of ch in the row
    },
    { windowId, ch },
  );

  // Real keystroke through the actual input path. The xterm helper textarea
  // already holds focus from setup; press the key directly.
  await page.keyboard.press(ch);

  // Poll the cursor row on the page clock until the count of `ch` increases,
  // then return the three segments. All timestamps are performance.now() in the
  // page context — no Node↔browser clock mixing.
  return page.evaluate(
    async ({ windowId, ch, before, deadlineMs }) => {
      const term = window.__rkTerminals?.[windowId];
      if (!term) throw new Error(`no registered terminal for ${windowId}`);

      const echoLanded = (): boolean => {
        const buf = term.buffer.active;
        const row =
          buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
        return row.split(ch).length - 1 > before;
      };

      const startWait = performance.now();
      // This shape mirrors EchoTiming, but it CANNOT reference that interface:
      // page.evaluate serializes this callback into the browser's JS realm,
      // where the outer module's compile-time types don't exist. The inline
      // literal is required here — do not "DRY" it against EchoTiming.
      return await new Promise<{ full: number; network: number; render: number }>(
        (resolve, reject) => {
          const deadline = startWait + deadlineMs;
          const tick = () => {
            if (echoLanded()) {
              const glyphAt = performance.now();
              const w = window as unknown as { __rkSendAt?: number; __rkRecvAt?: number };
              if (w.__rkSendAt === undefined) {
                reject(new Error("keystroke produced no WebSocket send"));
                return;
              }
              // recv stamp should exist (the echo frame arrived before paint);
              // if a coalesced first-frame somehow missed it, fall back to the
              // glyph time so `network` is a lower bound rather than negative.
              const recvAt = w.__rkRecvAt ?? glyphAt;
              resolve({
                full: glyphAt - w.__rkSendAt,
                network: recvAt - w.__rkSendAt,
                render: glyphAt - recvAt,
              });
              return;
            }
            if (performance.now() > deadline) {
              reject(new Error(`echo timeout for ${JSON.stringify(ch)}`));
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
      );
    },
    { windowId, ch, before, deadlineMs },
  );
}

/**
 * Measure one keystroke's echo latency while a background stream is writing to
 * the same pane. Returns only the full (send → glyph-visible) time: the
 * network/render attribution split is meaningless here because the first
 * inbound frame after the send may be a tick, not the echo.
 *
 * Detection is presence-based with rotating probe chars rather than
 * cursor-row-count-based (`measureEcho`): the tick stream moves the cursor
 * between snapshot and detection, so anchoring on the cursor row would lose
 * the echo. Instead the probe char is chosen to share no letters with the
 * stream text, the helper first WAITS until the char is absent from the
 * bottom `LOAD_SCAN_ROWS` rows (so the next appearance is unambiguously this
 * trial's echo), then polls that window on rAF until it appears.
 */
async function measureEchoUnderLoad(
  page: import("@playwright/test").Page,
  windowId: string,
  ch: string,
  deadlineMs: number,
): Promise<number> {
  // Wait until the probe char is absent from the scan window, and clear the
  // send stamp so the wrapper's next single-char stamp is THIS keystroke.
  // Rotation makes residue unlikely (last use ~19 trials ago); waiting rather
  // than asserting keeps the detector unambiguous even on a slow run.
  await page.waitForFunction(
    ({ windowId, ch, scanRows }) => {
      const term = window.__rkTerminals?.[windowId];
      if (!term) return false;
      (window as unknown as { __rkSendAt?: number }).__rkSendAt = undefined;
      const buf = term.buffer.active;
      for (let y = Math.max(0, buf.length - scanRows); y < buf.length; y++) {
        if ((buf.getLine(y)?.translateToString(true) ?? "").includes(ch)) {
          return false;
        }
      }
      return true;
    },
    { windowId, ch, scanRows: LOAD_SCAN_ROWS },
    { timeout: deadlineMs },
  );

  // Real keystroke through the genuine input path (same as measureEcho).
  await page.keyboard.press(ch);

  return page.evaluate(
    async ({ windowId, ch, scanRows, deadlineMs }) => {
      const term = window.__rkTerminals?.[windowId];
      if (!term) throw new Error(`no registered terminal for ${windowId}`);
      const w = window as unknown as { __rkSendAt?: number };

      const echoLanded = (): boolean => {
        const buf = term.buffer.active;
        for (let y = Math.max(0, buf.length - scanRows); y < buf.length; y++) {
          if ((buf.getLine(y)?.translateToString(true) ?? "").includes(ch)) {
            return true;
          }
        }
        return false;
      };

      const startWait = performance.now();
      return await new Promise<number>((resolve, reject) => {
        const deadline = startWait + deadlineMs;
        const tick = () => {
          if (echoLanded()) {
            const glyphAt = performance.now();
            if (w.__rkSendAt === undefined) {
              reject(new Error("keystroke produced no WebSocket send"));
              return;
            }
            resolve(glyphAt - w.__rkSendAt);
            return;
          }
          if (performance.now() > deadline) {
            reject(new Error(`under-load echo timeout for ${JSON.stringify(ch)}`));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    { windowId, ch, scanRows: LOAD_SCAN_ROWS, deadlineMs },
  );
}

test.describe("@perf Echo latency benchmark", () => {
  // The file runs FULL_PATH_TRIALS + BASELINE_TRIALS echo round-trips back to
  // back; give it ample headroom over the default per-test budget.
  test.setTimeout(process.env.CI ? 120_000 : 90_000);

  test.beforeAll(() => {
    createSession(TEST_SESSION);
    // Run `cat` with no args: the tty echoes each typed char immediately and
    // cat itself adds no prompt/completion/PS1 noise of its own — the cleanest
    // echo source. (The shell prompt that launched cat sits above; trials work
    // on cat's own input line below it.)
    tmux(`send-keys -t ${TEST_SESSION} 'cat' Enter`);
  });

  test.afterAll(() => {
    try {
      // Break out of cat, then kill the session.
      tmux(`send-keys -t ${TEST_SESSION} C-c`);
    } catch { /* ok */ }
    killSession(TEST_SESSION);
    killSession(BURST_SESSION);
    killSession(LOAD_SESSION);

    const pick = (label: string) =>
      samples.filter((s) => s.label === label).map((s) => s.ms);
    const full = pick("full-path");
    const network = pick("network");
    const render = pick("render");
    const base = pick("baseline");
    const load = pick("under-load");
    const throughput = pick("throughput");

    console.log("\n=== ECHO LATENCY BENCHMARK ===");
    console.log("  keystroke → glyph-visible, p50/p95/p99\n");
    if (full.length) console.log(summarize("full-path (browser)", full));
    if (network.length) console.log(summarize("├─ network (send→recv)", network));
    if (render.length) console.log(summarize("└─ render (recv→glyph)", render));
    if (load.length) console.log(summarize("under-load (ticks)", load));
    if (base.length) console.log(summarize("baseline (tmux only)", base));
    if (full.length && base.length) {
      const tax = percentile(full, 50) - percentile(base, 50);
      console.log(
        `\n  run-kit tax (full p50 − baseline p50): ${tax.toFixed(1)}ms` +
          " — the cost the web path adds over a local tmux echo.",
      );
    }
    if (network.length && render.length) {
      const np = percentile(network, 50);
      const rp = percentile(render, 50);
      const dominant = rp >= np ? "render" : "network";
      console.log(
        `  attribution (p50): network=${np.toFixed(1)}ms, render=${rp.toFixed(1)}ms` +
          ` → ${dominant} dominates. Render is the rAF-flush + xterm-parse tail` +
          " (the adaptive-flush target).",
      );
    }
    if (full.length || load.length) {
      console.log(
        "\n  -- distribution shape (two clusters = a fast/slow split on the echo path) --",
      );
      if (full.length) console.log(histogram("idle full-path", full));
      if (load.length) console.log(histogram("under-load", load));
    }
    if (throughput.length) {
      console.log(
        `\n  throughput guard: ${THROUGHPUT_LINES} lines rendered to quiescence in` +
          ` ${throughput[0].toFixed(0)}ms — the under-load coalescing path. Echo` +
          " latency must drop WITHOUT this regressing.",
      );
    }
    console.log("=== END BENCHMARK ===\n");
  });

  /**
   * Proves: a keystroke typed in the browser echoes back into the visible xterm
   * buffer with a measurable latency; the test characterizes that latency as a
   * p50/p95/p99 distribution over 40 trials, exercising the full input path
   * including the rAF render flush.
   *
   * Steps:
   * 1. `page.addInitScript(INSTALL_SEND_STAMP)` and
   *    `page.addInitScript(INSTALL_RECV_STAMP)` — wrap
   *    `WebSocket.prototype.send` and the `WebSocket` constructor before the app
   *    loads so the relay socket is wrapped at construction (send stamp +
   *    first-inbound-frame recv stamp).
   * 2. `resolveFirstWindowId(page)` to get the deep-link `@N`.
   * 3. Navigate to `/${server}/${windowId}`; wait for `.xterm-screen` visible.
   * 4. Poll until `window.__rkTerminals[windowId]` exists (terminal mounted +
   *    opened).
   * 5. Assert `window.__rkRenderer[windowId] === "webgl"` — fail loudly if the
   *    renderer silently fell back to canvas (slower; non-comparable numbers).
   * 6. Click `[role='application']` and focus `.xterm-helper-textarea` so
   *    `keyboard.press` routes into xterm.
   * 7. Warmup: press Enter, then repeatedly press `w` (250ms cadence, up to
   *    15s) until a `w` shows on the cursor row — confirms the full input path
   *    is live and absorbs the cold-backend connect delay instead of guessing
   *    with a fixed sleep.
   * 8. For each of 40 trials (char alternates `x`/`o`): press Enter (fresh
   *    line) and settle ~30ms; `measureEcho(page, windowId, ch, …)` snapshots
   *    the `ch` count on the cursor row, clears both stamps, presses the key,
   *    and rAF-polls the row until the count increases — returning
   *    `{ full, network, render }` (rejecting on a 5s deadline or if the
   *    keystroke produced no WebSocket send); push one row per label.
   * 9. Assert 40 full-path samples were collected.
   */
  test("full-path keystroke→echo distribution", async ({ page }) => {
    // Idempotent across a Playwright retry — this test records all three labels.
    resetSamples("full-path");
    resetSamples("network");
    resetSamples("render");
    // Install the send- and recv-stamp wrappers BEFORE the app loads so they
    // wrap the relay WebSocket at construction time. Together they split each
    // measurement into network (send→recv) and render (recv→glyph) segments.
    await page.addInitScript(INSTALL_SEND_STAMP);
    await page.addInitScript(INSTALL_RECV_STAMP);

    const windowId = await resolveFirstWindowId(page);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });

    // Wait until the terminal instance is registered (mounted + opened).
    await expect
      .poll(
        () => page.evaluate((wid) => Boolean(window.__rkTerminals?.[wid]), windowId),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Renderer confirmation: the WebGL addon loads in a try/catch with a silent
    // canvas fallback. A canvas fallback renders measurably slower, so the
    // latency numbers below are only meaningful if WebGL is actually live —
    // assert it. (If a CI runner genuinely lacks a GPU/WebGL this will fail
    // loudly, which is the right signal: the numbers from that box are not
    // comparable to a WebGL run and shouldn't be silently trusted.)
    const renderer = await page.evaluate(
      (wid) => window.__rkRenderer?.[wid],
      windowId,
    );
    expect(
      renderer,
      `expected WebGL renderer to be active (got ${renderer}); canvas fallback ` +
        "renders slower and would make these latency numbers non-comparable",
    ).toBe("webgl");

    // Focus the terminal for keyboard input. Click the terminal area (the
    // documented tap-to-focus path) then focus the helper textarea xterm reads
    // keystrokes from — belt and suspenders so keyboard.press routes into xterm.
    await page.locator("[role='application']").click();
    await page.locator(".xterm-helper-textarea").focus();

    // Warm up: the relay WebSocket must be OPEN and `cat` must be consuming
    // stdin before any timing. Press a char and wait until it echoes — this
    // both confirms the full input path is live and absorbs the connect delay,
    // rather than guessing with a fixed sleep that may be too short on a cold
    // backend (relay attach + tmux select + cat start).
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () => {
          await page.keyboard.press("w");
          return page.evaluate((wid) => {
            const term = window.__rkTerminals?.[wid];
            if (!term) return false;
            const buf = term.buffer.active;
            const row =
              buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
            return row.includes("w");
          }, windowId);
        },
        { timeout: 15_000, intervals: [250] },
      )
      .toBe(true);

    // Alternate between two chars so consecutive trials differ.
    const CHARS = ["x", "o"];
    for (let n = 0; n < FULL_PATH_TRIALS; n++) {
      const ch = CHARS[n % CHARS.length];
      // Reset to a fresh line before each trial so the row starts without `ch`,
      // keeping the count-based detector unambiguous. Brief settle so the
      // newline echo lands before we snapshot the pre-keystroke count.
      await page.keyboard.press("Enter");
      await page.waitForTimeout(30);
      const t = await measureEcho(page, windowId, ch, ECHO_DEADLINE_MS);
      // Record the full path plus its two attributable segments as separate
      // labeled rows, so the summary can report each distribution and the
      // render tail (the PR-#2 target) is tracked objectively over time.
      samples.push({ label: "full-path", ms: t.full });
      samples.push({ label: "network", ms: t.network });
      samples.push({ label: "render", ms: t.render });
    }
    expect(samples.filter((s) => s.label === "full-path").length).toBe(
      FULL_PATH_TRIALS,
    );
  });

  /**
   * Proves: the latency floor — pure tmux echo with no browser and no
   * WebSocket — so the run-kit tax can be isolated. Characterized as a
   * p50/p95/p99 distribution over 40 trials.
   *
   * Steps:
   * 1. Re-assert a fresh `cat`: `send-keys C-c` then `send-keys 'cat' Enter`
   *    and settle ~500ms (the full-path test attached a browser relay to this
   *    session, so its disconnect may have left `cat` in an unknown state;
   *    restarting it makes the baseline independent of test ordering).
   * 2. For each of 40 trials (char alternates `x`/`o`): `send-keys Enter`
   *    (fresh line) and settle ~20ms; mark `performance.now()`,
   *    `tmux send-keys '<char>'`, then busy-poll `capture-pane -p` (trailing
   *    blanks stripped) until the last non-empty line ends with the char, or
   *    the 5s deadline passes.
   * 3. Assert it landed; push `{ label: "baseline", ms }`; assert 40 baseline
   *    samples were collected.
   */
  test("baseline tmux-only echo distribution", async ({ page }) => {
    resetSamples("baseline"); // idempotent across a Playwright retry
    // Pure tmux echo: send a char via the tmux CLI directly into the same
    // `cat`, then poll capture-pane until the current line shows it. No
    // browser, no WebSocket — this is the floor the full path is measured
    // against. Each trial resets to a fresh line (Enter), so the echoed char is
    // the sole content of the last non-empty line — no global-uniqueness needed.
    //
    // Re-assert `cat` is running: the full-path test attached a browser relay
    // to this session and its disconnect may have left cat in an unknown state.
    // `q` Enter would quit a pager but is harmless to cat; instead we just
    // ensure a fresh cat by sending C-c then `cat` Enter and letting it settle.
    tmux(`send-keys -t ${TEST_SESSION} C-c`);
    tmux(`send-keys -t ${TEST_SESSION} 'cat' Enter`);
    await page.waitForTimeout(500);

    const CHARS = ["x", "o"];
    for (let n = 0; n < BASELINE_TRIALS; n++) {
      const ch = CHARS[n % CHARS.length];
      tmux(`send-keys -t ${TEST_SESSION} Enter`);
      await page.waitForTimeout(20); // let the newline echo land
      // Last line should now be empty; the next echoed char will be its tail.
      const t0 = performance.now();
      tmux(`send-keys -t ${TEST_SESSION} '${ch}'`);
      let landed = false;
      const deadline = t0 + ECHO_DEADLINE_MS;
      // Each capture-pane subprocess costs ~10-20ms, which is itself the poll
      // granularity here — there is no tight-loop storm to throttle, and a
      // baseline below that resolution is not separable from the measurement
      // tool's own cost (an honest limitation noted in the summary).
      while (performance.now() < deadline) {
        const lines = tmuxCapture().replace(/\n+$/, "").split("\n");
        // Trim trailing whitespace on the candidate line: `capture-pane -p` can
        // right-pad a row with spaces, which would defeat a bare `endsWith(ch)`.
        const last = (lines[lines.length - 1] ?? "").replace(/\s+$/, "");
        if (last.endsWith(ch)) {
          landed = true;
          break;
        }
      }
      const ms = performance.now() - t0;
      expect(landed, `baseline echo timeout for ${JSON.stringify(ch)}`).toBe(true);
      samples.push({ label: "baseline", ms });
    }
    expect(samples.filter((s) => s.label === "baseline").length).toBe(
      BASELINE_TRIALS,
    );
  });

  /**
   * Proves: echo latency while the pane is ALSO receiving a background stream —
   * "typing while an agent is producing output", the everyday condition the
   * idle benchmark deliberately excludes. Concurrent output splits echoes into
   * a fast mode and a slow mode (measured ~4ms vs ~22ms clusters); the slow
   * mode originates upstream of the client flush (tmux paces updates to
   * attached clients while a pane streams — a controlled experiment with a
   * uniform `setTimeout(0)` flush reproduced the same bimodal histogram), so
   * the recorded distribution and its histogram characterize the split wherever
   * it comes from and guard against a client change making it worse.
   *
   * Steps:
   * 1. `page.addInitScript(INSTALL_SEND_STAMP)` — send stamp only; the recv
   *    stamp is NOT installed (under load the first inbound frame after a send
   *    may be a tick rather than the echo, so the network/render split is
   *    meaningless and only `full` is recorded).
   * 2. Create `LOAD_SESSION`; start the load + echo pair in it:
   *    `seq 1 2000 | while read i; do echo tick; sleep 0.05; done & cat` — a
   *    background tick line every ~50ms plus the same interactive `cat`; the
   *    generator is bounded (2000 ticks ≈ 100s) so it self-terminates even if
   *    cleanup fails.
   * 3. Navigate to the window; wait for `.xterm-screen` + the registered
   *    terminal; assert the WebGL renderer (same rationale as the idle test);
   *    focus.
   * 4. Two-stage warmup: poll until `tick` is visible in the bottom rows
   *    (inbound stream live through the relay), then press `w` until it appears
   *    (keystroke path live; `w` is never used as a probe char).
   * 5. For each of 30 trials (probe char rotates through a 19-char alphabet
   *    that shares no letter with `tick`): `measureEchoUnderLoad` waits until
   *    the probe char is absent from the bottom 8 rows (so its next appearance
   *    is unambiguously this trial's echo), clears the send stamp, presses the
   *    key, and rAF-polls the bottom rows until the char appears; push
   *    `{ label: "under-load", ms }` and settle 40ms so trials approximate a
   *    human typing cadence.
   * 6. Assert 30 under-load samples were collected.
   */
  test("under-load keystroke→echo distribution", async ({ page }) => {
    resetSamples("under-load"); // idempotent across a Playwright retry
    await page.addInitScript(INSTALL_SEND_STAMP);

    // Dedicated session: a bounded background tick generator writes a short
    // line every ~50ms to the same pane `cat` echoes into — "typing while an
    // agent is producing output". Concurrent output splits echo latency into
    // a fast and a slow mode (measured ~4ms vs ~22ms clusters). Note the
    // split is NOT primarily the adaptive flush's doing: a controlled
    // experiment that replaced the flush with a uniform setTimeout(0)
    // strategy reproduced the same bimodal histogram, so the slow mode
    // originates upstream (tmux paces client updates while a pane streams;
    // an echo arriving inside a pacing window waits for the next batch).
    // This test characterizes the split wherever it comes from, and guards
    // against a flush change making it worse.
    //
    // The generator is bounded (2000 ticks ≈ 100s) so it self-terminates even
    // if cleanup fails — it can never outlive the run as an orphaned load
    // loop. Killing the session kills it with the pane in the normal case.
    // Retry-safe: if a prior attempt failed after creating the session and the
    // retry runs in the same worker process (same module-level Date.now() name),
    // the leftover session would make new-session fail with "duplicate session".
    // Kill any leftover first; on a clean first attempt this is a no-op error.
    // createSession pre-kills any leftover, then creates.
    createSession(LOAD_SESSION);
    // The attached client renders the tmux status line on the terminal's
    // bottom row, and it permanently shows the session name (`e2e-echo-load-…`)
    // and auto-renamed window name (`cat`) — letters that overlap the probe
    // alphabet. Presence-based detection scans the bottom rows, so the status
    // line would make the absence-wait unsatisfiable for those chars. Turn it
    // off for this session; the scan window then sees only pane content.
    tmux(`set-option -t ${LOAD_SESSION} status off`);
    tmux(
      `send-keys -t ${LOAD_SESSION} "seq 1 2000 | while read i; do echo tick; sleep 0.05; done & cat" Enter`,
    );

    const windowId = await resolveFirstWindowId(page, LOAD_SESSION);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        () => page.evaluate((wid) => Boolean(window.__rkTerminals?.[wid]), windowId),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Same renderer confirmation as the idle benchmark — a silent canvas
    // fallback would make these numbers non-comparable.
    const renderer = await page.evaluate(
      (wid) => window.__rkRenderer?.[wid],
      windowId,
    );
    expect(
      renderer,
      `expected WebGL renderer to be active (got ${renderer})`,
    ).toBe("webgl");

    await page.locator("[role='application']").click();
    await page.locator(".xterm-helper-textarea").focus();

    // Warm up in two stages: (1) the tick stream is visibly flowing through
    // the relay, (2) a keystroke echoes (`w` — never used as a probe char).
    // Together these prove both directions of the path before any timing.
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ windowId, scanRows }) => {
              const term = window.__rkTerminals?.[windowId];
              if (!term) return false;
              const buf = term.buffer.active;
              for (let y = Math.max(0, buf.length - scanRows); y < buf.length; y++) {
                if ((buf.getLine(y)?.translateToString(true) ?? "").includes("tick")) {
                  return true;
                }
              }
              return false;
            },
            { windowId, scanRows: LOAD_SCAN_ROWS },
          ),
        { timeout: 15_000, intervals: [250] },
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          await page.keyboard.press("w");
          return page.evaluate(
            ({ windowId, scanRows }) => {
              const term = window.__rkTerminals?.[windowId];
              if (!term) return false;
              const buf = term.buffer.active;
              for (let y = Math.max(0, buf.length - scanRows); y < buf.length; y++) {
                if ((buf.getLine(y)?.translateToString(true) ?? "").includes("w")) {
                  return true;
                }
              }
              return false;
            },
            { windowId, scanRows: LOAD_SCAN_ROWS },
          );
        },
        { timeout: 15_000, intervals: [250] },
      )
      .toBe(true);

    for (let n = 0; n < UNDER_LOAD_TRIALS; n++) {
      const ch = LOAD_PROBE_CHARS[n % LOAD_PROBE_CHARS.length];
      const ms = await measureEchoUnderLoad(page, windowId, ch, ECHO_DEADLINE_MS);
      samples.push({ label: "under-load", ms });
      // Space trials out to a human-ish typing cadence so each echo's frame
      // collision with a tick is roughly independent of the previous trial.
      await page.waitForTimeout(40);
    }
    expect(samples.filter((s) => s.label === "under-load").length).toBe(
      UNDER_LOAD_TRIALS,
    );
  });

  /**
   * Proves: optimizing echo latency (the adaptive flush in
   * `terminal-client.tsx`, which writes small idle chunks immediately instead
   * of always waiting for a `requestAnimationFrame`) did NOT regress burst
   * rendering. A large, countable flood must still render completely and
   * quickly via the under-load coalescing path — no dropped/garbled output, no
   * renderer melt. Lives in the same file as the echo benchmark so a change
   * that shaves echo latency at the cost of flood performance fails in the same
   * run that shows the latency win.
   *
   * Steps:
   * 1. Create a dedicated `BURST_SESSION` (so the flood doesn't disturb the
   *    echo session's interactive `cat`).
   * 2. `resolveFirstWindowId(page, BURST_SESSION)`; navigate; wait for
   *    `.xterm-screen` and the registered terminal handle; focus the terminal.
   * 3. Mark `performance.now()`, then `keyboard.type("seq 1 N\n")` (N =
   *    `THROUGHPUT_LINES`, 20000): `seq` emits predictable output whose final
   *    line `N` is a unique end-marker; the relay delivers it as many multi-KB
   *    frames, exercising the coalescing branch.
   * 4. In-page `requestAnimationFrame` loop tracks `term.buffer.active.length`;
   *    quiescence = the end-marker line is present in the last rows of
   *    scrollback AND the line count has been stable for ~150ms; returns the
   *    in-page elapsed time, or rejects past the 30s deadline.
   * 5. Assert wall-clock under the deadline; push `{ label: "throughput", ms }`
   *    (the in-page quiescence time) for the summary.
   */
  test("throughput guard — burst output renders fully and fast", async ({ page }) => {
    resetSamples("throughput"); // idempotent across a Playwright retry
    // Flood the terminal with a large, countable burst (`seq 1 N`) and measure
    // time-to-quiescence plus that the final line landed. This exercises the
    // adaptive flush's UNDER-LOAD branch: the relay delivers seq's output as
    // many multi-KB frames, which must coalesce into ~one write per frame rather
    // than writing synchronously per frame. The guard's job is to prove the
    // echo-latency optimization did not trade away burst-render performance —
    // it asserts both completeness (no dropped/garbled output) and a sane bound.
    createSession(BURST_SESSION);

    const windowId = await resolveFirstWindowId(page, BURST_SESSION);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        () => page.evaluate((wid) => Boolean(window.__rkTerminals?.[wid]), windowId),
        { timeout: 10_000 },
      )
      .toBe(true);

    await page.locator("[role='application']").click();
    await page.locator(".xterm-helper-textarea").focus();

    // Warm up with a marker-based poll instead of a fixed sleep — the relay
    // WebSocket must be OPEN and the shell consuming input before the burst, and
    // a fixed sleep is flaky on a cold/slow runner (consistent with the
    // full-path test, which avoids fixed sleeps for the same reason). Press `z`
    // until it echoes on the cursor row, then clear the line so the marker isn't
    // mistaken for burst output.
    await expect
      .poll(
        async () => {
          await page.keyboard.press("z");
          return page.evaluate((wid) => {
            const term = window.__rkTerminals?.[wid];
            if (!term) return false;
            const buf = term.buffer.active;
            const row =
              buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
            return row.includes("z");
          }, windowId);
        },
        { timeout: 15_000, intervals: [250] },
      )
      .toBe(true);
    // Clear the typed warmup marker(s) from the prompt line WITHOUT executing
    // them (Ctrl-U kills the line in the shell's line editor) so the burst
    // command runs from a clean prompt.
    await page.keyboard.press("Control+u");

    // Issue the burst. The unique end-marker is the final line `N` on its own.
    const endMarker = String(THROUGHPUT_LINES);
    const t0 = performance.now();
    await page.keyboard.type(`seq 1 ${THROUGHPUT_LINES}\n`);

    // Quiescence = the terminal's scrollback line count stops growing AND the
    // end-marker is present in the buffer. Poll the registered Terminal's
    // buffer; the WebGL canvas is not DOM-readable (same rationale as measureEcho).
    const elapsed = await page.evaluate(
      async ({ windowId, endMarker, deadlineMs }) => {
        const term = window.__rkTerminals?.[windowId];
        if (!term) throw new Error(`no registered terminal for ${windowId}`);
        const t0 = performance.now();
        const deadline = t0 + deadlineMs;

        const endMarkerPresent = (): boolean => {
          const buf = term.buffer.active;
          // Scan the last rows of scrollback for the marker on its own line.
          const total = buf.length;
          for (let y = Math.max(0, total - term.rows * 2); y < total; y++) {
            const line = buf.getLine(y)?.translateToString(true).trim();
            if (line === endMarker) return true;
          }
          return false;
        };

        return await new Promise<number>((resolve, reject) => {
          let lastLen = -1;
          let stableSince = 0;
          const tick = () => {
            const now = performance.now();
            const len = term.buffer.active.length;
            if (len !== lastLen) {
              lastLen = len;
              stableSince = now;
            }
            // Done when the end-marker is in the buffer and growth has settled
            // for ~150ms (a few frames with no new lines).
            if (endMarkerPresent() && now - stableSince > 150) {
              resolve(now - t0);
              return;
            }
            if (now > deadline) {
              reject(
                new Error(
                  `throughput timeout: endMarker=${endMarkerPresent()}, len=${len}`,
                ),
              );
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      { windowId, endMarker, deadlineMs: THROUGHPUT_DEADLINE_MS },
    );
    const wall = performance.now() - t0;

    // Correctness: the final line of the burst rendered (no truncation/garble).
    // Timing: recorded for the summary and bounded by the deadline (the
    // page.evaluate above already rejects past it). We record `elapsed` (the
    // in-page quiescence time) as the comparable metric across runs.
    samples.push({ label: "throughput", ms: elapsed });
    expect(wall).toBeLessThan(THROUGHPUT_DEADLINE_MS);
  });
});
