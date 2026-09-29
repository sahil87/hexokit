import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { SETTINGS_PATH } from "./_settings";
import { harnessOrigin } from "./_harness";

// Shared helpers for the specs that drive the REAL Xvnc rig (gui-surface's
// gated half, gui-perf): capability probes, the rig-origin fetchers over
// /api/settings and /api/gui/host, geometry settling, and the settings-file
// snapshot/restore that keeps a developer's real config.yaml intact under the
// interactive `just pw` lane (RK_CONFIG_DIR unset ⇒ SETTINGS_PATH is theirs).

/** True when the named binary resolves on PATH (`which`). */
export function onPath(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** The Linux VNC backend the supervisor spawns — the gate for every real-rig
 *  gui spec (CI lacks it, so those specs skip cleanly). */
export const hasXtigervnc = onPath("Xtigervnc");
/** The X11 input driver the perf spec scrolls the guest with. */
export const hasXdotool = onPath("xdotool");

/** The rig's origin from the harness-port helper (E2E_PORT is harness-set;
 *  unset resolves to the policy's fail-closed sentinel — see _harness.ts).
 *  Module-level capture is safe: spec modules load after playwright.config.ts
 *  has applied the worker-rig rewrite (see _rig.ts). */
export const RIG_ORIGIN = harnessOrigin();

export async function postSettingsRaw(body: Record<string, unknown>): Promise<void> {
  await fetch(`${RIG_ORIGIN}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** The fields of `GET /api/gui/host` the rig specs read. */
export interface GuiStatusDoc {
  enabled: boolean;
  reachable: boolean;
  session: boolean;
  display: string;
  width: number;
  height: number;
  viewers: number;
  reason: string;
}

export async function fetchGuiStatusRaw(): Promise<GuiStatusDoc | null> {
  try {
    const res = await fetch(`${RIG_ORIGIN}/api/gui/host`);
    if (!res.ok) return null;
    return (await res.json()) as GuiStatusDoc;
  } catch {
    return null;
  }
}

/** Poll the gui status until `pred` holds (or the budget lapses). On
 *  exhaustion the error carries the LAST observed document — the reason field
 *  is the difference between "session absent" and "probe failed". */
export async function pollGuiStatus(
  pred: (s: GuiStatusDoc) => boolean,
  budgetMs = 25_000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const s = await fetchGuiStatusRaw();
    if (s) {
      last = s;
      if (pred(s)) return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log("pollGuiStatus exhausted; last status:", JSON.stringify(last));
  return false;
}

/** Read the payload geometry once it is STABLE across two reads ≥1 s apart —
 *  a focused fine-pointer viewer's SetDesktopSize may still be landing, and
 *  any stage that samples after it must wait for that settle or it races the
 *  desktop viewer's own resize. Throws when the geometry never stabilizes. */
export async function stableGuiGeometry(budgetMs = 15_000): Promise<{ width: number; height: number }> {
  const deadline = Date.now() + budgetMs;
  let prev: { width: number; height: number } | null = null;
  while (Date.now() < deadline) {
    const s = await fetchGuiStatusRaw();
    if (s && prev && s.width === prev.width && s.height === prev.height) {
      return { width: s.width, height: s.height };
    }
    if (s) prev = { width: s.width, height: s.height };
    await new Promise((r) => setTimeout(r, 1_200));
  }
  throw new Error("gui geometry never stabilized");
}

/** The settings file as found (null when absent) — pair with restoreSettings
 *  in afterAll so a spec's `gui.enabled` writes never outlive the run. */
export function snapshotSettings(): Buffer | null {
  try {
    return readFileSync(SETTINGS_PATH);
  } catch (err) {
    // Only a missing file is "absent" — any other read failure (EACCES, EIO)
    // must not let afterAll remove a config it never captured.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Turn the switch back off (kills rk-gui), unset the key, then put the
 *  snapshotted file back byte-for-byte (or remove one that did not exist). */
export async function restoreSettings(snapshot: Buffer | null): Promise<void> {
  await postSettingsRaw({ "gui.enabled": null });
  if (snapshot !== null) {
    writeFileSync(SETTINGS_PATH, snapshot);
  } else {
    rmSync(SETTINGS_PATH, { force: true });
  }
}
