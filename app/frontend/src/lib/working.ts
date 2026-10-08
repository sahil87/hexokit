/**
 * The working-directory surface's wire types.
 *
 * They deliberately mirror `lib/review.ts`'s shapes — a `WorkingFile` is a
 * `ReviewFile` with `staged` in place of the PR-only fields — because the row
 * renderer and the file tree are shared. What is NOT shared is the vocabulary
 * of state: a PR file is "modified against the base", a working file is
 * "modified against HEAD, and possibly staged", and the two are different
 * questions even when they render the same.
 */
import type { ReviewCollapsedReason, ReviewRow } from "./review";

/** How a path differs from HEAD. `untracked` is git's `??` — a file git has
 *  never seen, rendered as an all-added diff. */
export type WorkingStatus = "modified" | "added" | "removed" | "renamed" | "untracked";

export interface WorkingFile {
  path: string;
  previousPath?: string;
  status: WorkingStatus;
  /** The INDEX carries a change for this path. A file can be staged AND dirty
   *  at once (git's `MM`); this is true then, and the rows show the union,
   *  which is what `git diff HEAD` returns. */
  staged: boolean;
  additions: number;
  deletions: number;
  hasPatch: boolean;
  rowCount: number;
  rows?: ReviewRow[];
  /** Why the file arrived without rows. Same two reasons the PR surface uses,
   *  so the shared file row needs no new case. */
  collapsed?: ReviewCollapsedReason;
}

export interface WorkingSnapshot {
  /** Fingerprints everything the tile renders. The tile polls this and re-reads
   *  only when it moves. */
  digest: string;
  root: string;
  files: WorkingFile[];
  readAt: string;
  /** No changes at all. The tile stays available and renders an empty state —
   *  emptiness selects CONTENT, never availability. */
  clean: boolean;
}

/** The one-letter badge the file row shows, matching git's own porcelain
 *  letters so the surface reads the same as `git status` does. */
export function statusLetter(status: WorkingStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    default:
      return "M";
  }
}
