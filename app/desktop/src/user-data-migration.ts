/**
 * Carry-forward, then retirement, of the per-user stores across the product
 * rename. Electron keys `app.getPath("userData")` on the app name, so the
 * rename (Run Kit → HexoKit) silently moves hosts.json/windows.json — copying
 * them forward once keeps every desktop user's host list instead of regressing
 * to a fresh install. Once the new dir has its own hosts.json the legacy dir
 * has no reader left, so it is deleted rather than left as a stale copy.
 *
 * Deliberately electron-free — both directories are parameters (main.ts
 * passes `app.getPath("userData")` and its legacy sibling), which keeps this
 * module unit-testable under plain `node --test` (the hosts.ts convention).
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  constants,
} from "node:fs";
import { join } from "node:path";

const CARRIED_FILES = ["hosts.json", "windows.json"];

/**
 * Copy the store files from legacyDir into newDir — only when newDir has no
 * hosts.json of its own (an existing one means the new-name app already ran
 * here, and nothing may be overwritten). A store newDir already has is
 * skipped, and COPYFILE_EXCL double-guards the never-overwrite rule. The copy
 * is all-or-nothing: a failure unlinks this attempt's copies, so newDir never
 * gains a hosts.json — the retirement gate — without the rest of the stores,
 * and the next start retries. Every failure (unreadable legacy dir,
 * permissions) is logged and ignored: the app then behaves as a fresh
 * install, exactly as it does today with a missing store.
 */
export function carryForwardLegacyUserData(
  newDir: string,
  legacyDir: string,
): { copied: string[]; failed: boolean } {
  const copied: string[] = [];
  try {
    if (existsSync(join(newDir, "hosts.json"))) return { copied, failed: false };
    if (!existsSync(join(legacyDir, "hosts.json"))) return { copied, failed: false };
    mkdirSync(newDir, { recursive: true });
    for (const name of CARRIED_FILES) {
      const src = join(legacyDir, name);
      const dest = join(newDir, name);
      if (!existsSync(src) || existsSync(dest)) continue;
      copyFileSync(src, dest, constants.COPYFILE_EXCL);
      copied.push(name);
    }
  } catch (err) {
    // Fresh-install degradation — never block startup on the carry-forward,
    // but the failure must be diagnosable.
    const kept = copied.filter((name) => {
      try {
        unlinkSync(join(newDir, name));
        return false;
      } catch {
        return true;
      }
    });
    console.warn(
      `userData carry-forward failed (rolled back ${copied.length - kept.length} of ${copied.length} copied file(s)) — continuing as a fresh install:`,
      err,
    );
    return { copied: kept, failed: true };
  }
  return { copied, failed: false };
}

/**
 * Delete legacyDir once newDir has its own hosts.json — the same condition
 * that makes the carry-forward a no-op, so retirement can never run before
 * the carry-forward had its chance. A symlinked legacyDir loses only the
 * link: lstat, never stat, so nothing outside userData is ever followed.
 * Best-effort like the carry-forward — every failure is logged and ignored.
 */
export function retireLegacyUserData(
  newDir: string,
  legacyDir: string,
): { removed: boolean } {
  try {
    if (!existsSync(join(newDir, "hosts.json"))) return { removed: false };
    const stat = lstatSync(legacyDir, { throwIfNoEntry: false });
    if (!stat) return { removed: false };
    if (stat.isSymbolicLink()) unlinkSync(legacyDir);
    else rmSync(legacyDir, { recursive: true });
    return { removed: true };
  } catch (err) {
    console.warn(`legacy userData removal failed — leaving ${legacyDir} in place:`, err);
    return { removed: false };
  }
}
