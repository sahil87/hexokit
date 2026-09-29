/**
 * The ONE harness-port read. Every Playwright site that needs the rig's port
 * resolves it through here so the fail-closed fallback lives in exactly one
 * place.
 *
 * Read lazily at call time, never captured at module load: under the
 * multi-rig lane playwright.config.ts rewrites the harness env vars via
 * applyWorkerRig() before spec modules load (see _rig.ts for the ordering
 * contract), and a module-level capture in the config itself would freeze the
 * pre-rewrite value.
 *
 * E2E_PORT is set only by the harness (scripts/test-e2e.sh, scripts/pw.sh).
 * When unset, the fallback is the policy's PORTPOLICY_SENTINEL parsed from
 * ports.env — a bare `playwright test` connects there and finds nothing. The
 * ambient RK_PORT is never consulted: direnv exports it into every dev shell,
 * so reading it would point a bare run at a live dev server.
 *
 * Module-system constraint: the frontend package is "type": "module" (files
 * load as true ESM, where `__filename` is undefined) while the desktop
 * package loads this same file as CJS (where `import.meta` is a parse error,
 * so it can never appear here). A stack frame is the only self-location
 * anchor that survives both: the innermost frame of an Error created here
 * always names this file — a file:// URL under ESM, a plain path under CJS.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This file's own absolute path (see the module header for why not
 *  `import.meta`/`__filename`). The CJS path alternatives exclude only `)`
 *  (the stack-frame delimiter), never whitespace — a checkout under a
 *  directory with spaces must still match; the trailing `:line:column`
 *  strips via greedy backtracking. The ESM `file://` alternative stays
 *  whitespace-free because URLs arrive percent-encoded. */
function selfFile(): string {
  const match = (new Error().stack ?? "").match(
    /\(?(file:\/\/[^)\s]+|[A-Za-z]:[\\/][^)]+|\/[^)]+):\d+:\d+/,
  );
  if (!match) throw new Error("could not locate _harness.ts from its own stack frame");
  return match[1].startsWith("file://") ? fileURLToPath(match[1]) : match[1];
}

const PORTS_ENV = join(
  dirname(selfFile()),
  "..",
  "..",
  "..",
  "backend",
  "internal",
  "portpolicy",
  "ports.env",
);

/** PORTPOLICY_SENTINEL from the port-policy file — the fail-closed
 *  connect-to-nothing fallback for runs with no harness. Parsed on every
 *  call: the file is 15 lines, and caching would buy nothing. */
function sentinelPort(): number {
  const match = readFileSync(PORTS_ENV, "utf8").match(/^PORTPOLICY_SENTINEL=(\d+)$/m);
  if (!match) {
    throw new Error(`PORTPOLICY_SENTINEL missing or malformed in ${PORTS_ENV}`);
  }
  return Number(match[1]);
}

/** The rig's Vite port: E2E_PORT when the harness set it, else the policy's
 *  fail-closed sentinel. */
export function harnessPort(): number {
  const raw = process.env.E2E_PORT;
  if (raw !== undefined && raw !== "") return Number(raw);
  return sentinelPort();
}

/** The rig's origin, `http://localhost:<harnessPort()>`. */
export function harnessOrigin(): string {
  return `http://localhost:${harnessPort()}`;
}
