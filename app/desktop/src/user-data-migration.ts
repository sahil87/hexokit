/**
 * One-release carry-forward of the per-user stores across the product rename.
 * Electron keys `app.getPath("userData")` on the app name, so the rename
 * (Run Kit → HexoKit) silently moves hosts.json/windows.json — copying them
 * forward once keeps every desktop user's host list instead of regressing to
 * a fresh install. Copy, never move: the legacy dir stays in place so a
 * downgrade to the pre-rename build still finds its stores.
 *
 * Deliberately electron-free — both directories are parameters (main.ts
 * passes `app.getPath("userData")` and its legacy sibling), which keeps this
 * module unit-testable under plain `node --test` (the hosts.ts convention).
 */
import { copyFileSync, existsSync, mkdirSync, constants } from "node:fs";
import { join } from "node:path";

const CARRIED_FILES = ["hosts.json", "windows.json"];

/**
 * Copy the store files from legacyDir into newDir — only when newDir has no
 * hosts.json of its own (an existing one means the new-name app already ran
 * here, and nothing may be overwritten). COPYFILE_EXCL double-guards the
 * never-overwrite rule. Every failure (unreadable legacy dir, permissions)
 * is logged and ignored: the app then behaves as a fresh install, exactly as
 * it does today with a missing store.
 */
export function carryForwardLegacyUserData(
  newDir: string,
  legacyDir: string,
): { copied: string[] } {
  const copied: string[] = [];
  try {
    if (existsSync(join(newDir, "hosts.json"))) return { copied };
    if (!existsSync(join(legacyDir, "hosts.json"))) return { copied };
    mkdirSync(newDir, { recursive: true });
    for (const name of CARRIED_FILES) {
      const src = join(legacyDir, name);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(newDir, name), constants.COPYFILE_EXCL);
      copied.push(name);
    }
  } catch (err) {
    // Fresh-install degradation — never block startup on the carry-forward,
    // but the failure must be diagnosable (intake: logged and ignored).
    console.warn(
      `userData carry-forward failed after copying ${copied.length} file(s) — continuing as a fresh install:`,
      err,
    );
  }
  return { copied };
}
