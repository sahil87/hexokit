import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchWorkingDiff, fetchWorkingDiffFile } from "@/api/client";
import { ReviewDiff } from "@/components/review-diff";
import { ReviewTree } from "@/components/review-tree";
import type { ReviewFileBody } from "@/lib/review";
import { ancestorDirs, buildReviewTree } from "@/lib/review-tree";
import { statusLetter, type WorkingFile, type WorkingSnapshot } from "@/lib/working";

/**
 * The working-directory surface: what `git status` and `git diff` say right
 * now, before anything is committed.
 *
 * It is the Changes surface's local sibling and shares its renderers — the
 * file tree, the diff rows, the virtualized file list — but NOT its machinery.
 * There is no cache to revalidate, no digest to push, no listener and no
 * comment layer: a working-tree line has no GitHub address to anchor a thread
 * to. Reads are two local git calls at ~50 ms, so freshness is a button rather
 * than a protocol.
 */

/** Rows of file header the virtualizer keeps mounted beyond the viewport. */
const FILE_ROW_HEIGHT = 28;

export interface WorkingSurfaceProps {
  server: string;
  windowId: string;
  /** The repo root, from the window payload. Identity: a change resets the
   *  tile, the way a new PR resets the review tile. */
  gitRoot: string;
}

export function WorkingSurface({ server, windowId, gitRoot }: WorkingSurfaceProps) {
  const [snapshot, setSnapshot] = useState<WorkingSnapshot | null>(null);
  const [bodies, setBodies] = useState<Record<string, ReviewFileBody>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (seed = false, signal?: AbortSignal) => {
      setLoading(true);
      try {
        const next = await fetchWorkingDiff(server, windowId, signal);
        setSnapshot(next);
        setError(null);
        // Only a FRESH identity seeds the open set. A refresh must not collapse
        // what the reader opened — their expand state is theirs, not the
        // server's, exactly as it is on the review tile.
        if (!seed) return;
        const seeded: Record<string, ReviewFileBody> = {};
        const open = new Set<string>();
        for (const file of next.files) {
          if (file.rows && file.rows.length > 0) {
            seeded[file.path] = {
              path: file.path,
              rows: file.rows,
              refine: false,
              totalLines: 0,
              headSha: "",
              baseSha: "",
              highlighted: true,
            };
          }
          open.add(file.path);
        }
        setBodies(seeded);
        setExpanded(open);
      } catch (err) {
        // An abort is this component's own doing — a remount, or a root change
        // superseding the request. It is not a failure and must not paint one.
        if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : "Failed to read the working tree");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [server, windowId],
  );

  // Identity change resets the tile. The abort makes StrictMode's double-invoke
  // cost one request rather than two, and stops an older in-flight response
  // landing after a newer one.
  useEffect(() => {
    setSnapshot(null);
    setBodies({});
    setExpanded(new Set());
    setSelected(null);
    const controller = new AbortController();
    void load(true, controller.signal);
    return () => controller.abort();
  }, [load, gitRoot]);

  const files = snapshot?.files ?? [];
  const tree = useMemo(() => buildReviewTree(files), [files]);

  const loadBody = useCallback(
    async (path: string) => {
      if (busy.current.has(path)) return;
      busy.current.add(path);
      try {
        const body = await fetchWorkingDiffFile(server, windowId, path);
        setBodies((prev) => ({ ...prev, [path]: body }));
      } catch {
        // A file that will not load stays collapsed with its Load-diff
        // affordance. It is one file, not the tile.
      } finally {
        busy.current.delete(path);
      }
    },
    [server, windowId],
  );

  const toggleFile = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!bodies[path]) void loadBody(path);
        }
        return next;
      });
    },
    [bodies, loadBody],
  );

  const selectFile = useCallback(
    (path: string) => {
      setSelected(path);
      setOpenDirs((prev) => {
        const next = new Set(prev);
        for (const dir of ancestorDirs(tree, path)) next.add(dir);
        return next;
      });
      document.getElementById(`wd-file-${path}`)?.scrollIntoView({ block: "start" });
    },
    [tree],
  );

  if (error) {
    return (
      <div className="p-3 text-[11px] text-text-secondary" data-testid="working-error">
        {error}
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="p-3 text-[11px] text-text-secondary" data-testid="working-loading">
        Reading the working tree…
      </div>
    );
  }
  // A clean tree is a STATE, not an absence. The lens exists whenever the
  // window has a repo; emptiness selects the content.
  if (snapshot.clean) {
    return (
      <div className="p-3 text-[11px] text-text-secondary" data-testid="working-empty">
        Working tree clean — nothing uncommitted.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="working-surface">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px]">
        <button
          type="button"
          className="rk-btn-ghost px-1"
          aria-pressed={treeOpen}
          title="Toggle the file tree"
          onClick={() => setTreeOpen((v) => !v)}
          data-testid="working-tree-toggle"
        >
          ⌸
        </button>
        <span className="text-text-secondary">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <button
          type="button"
          className="rk-btn-ghost ml-auto px-1"
          title="Re-read the working tree"
          onClick={() => void load()}
          disabled={loading}
          data-testid="working-refresh"
        >
          ↻
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {treeOpen && (
          <div className="w-56 shrink-0 overflow-auto border-r border-border" data-testid="working-tree">
            <ReviewTree
              nodes={tree}
              openDirs={openDirs}
              selectedPath={selected}
              viewedPaths={new Set()}
              unhandledByPath={new Map()}
              onToggleDir={(path) =>
                setOpenDirs((prev) => {
                  const next = new Set(prev);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              onSelectFile={selectFile}
            />
          </div>
        )}

        <div className="min-w-0 flex-1 overflow-auto">
          {files.map((file) => (
            <WorkingFileRow
              key={file.path}
              file={file}
              open={expanded.has(file.path)}
              body={bodies[file.path]}
              onToggle={() => toggleFile(file.path)}
              onLoad={() => void loadBody(file.path)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkingFileRow({
  file,
  open,
  body,
  onToggle,
  onLoad,
}: {
  file: WorkingFile;
  open: boolean;
  body?: ReviewFileBody;
  onToggle: () => void;
  onLoad: () => void;
}) {
  return (
    <div id={`wd-file-${file.path}`} data-path={file.path}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 text-left text-[11px] hover:bg-bg-hover"
        style={{ height: FILE_ROW_HEIGHT }}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="w-3 text-text-secondary">{open ? "▾" : "▸"}</span>
        <span
          className="w-3 text-center text-text-secondary"
          title={file.status}
          data-testid="working-status"
        >
          {statusLetter(file.status)}
        </span>
        {/* Staged-ness is a per-file fact, not a second view: `git diff HEAD`
            already merges the index and the worktree, and this says which
            files the index is carrying. */}
        {file.staged && (
          <span className="text-accent" title="staged" data-testid="working-staged">
            ●
          </span>
        )}
        <span className="truncate">{file.path}</span>
        {file.previousPath && (
          <span className="truncate text-text-secondary">← {file.previousPath}</span>
        )}
        <span className="ml-auto shrink-0 text-text-secondary">
          +{file.additions} −{file.deletions}
        </span>
      </button>

      {open && body && (
        <ReviewDiff
          body={body}
          // Read-only: no threads, no composer, no comment gutter. The optional
          // seams on ReviewDiff exist for exactly this.
          onLoadRange={() => onLoad()}
        />
      )}
      {open && !body && (
        <div className="px-6 py-2 text-[11px] text-text-secondary">
          {file.hasPatch ? (
            <button type="button" className="rk-btn-ghost" onClick={onLoad}>
              Load diff{file.collapsed === "large" ? ` (${file.rowCount} lines)` : ""}
            </button>
          ) : (
            "No diff available"
          )}
        </div>
      )}
    </div>
  );
}
