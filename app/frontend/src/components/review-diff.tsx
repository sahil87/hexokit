import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { controlClass } from "@/components/control";
import { ReviewComposer } from "@/components/review-composer";
import { ReviewThreadCard } from "@/components/review-thread";
import {
  decorateMatches,
  gutterNumbers,
  restoreSelection,
  rowAddress,
  rowAttributes,
  rowClass,
  rowMatchesThread,
  rowSign,
  rowText,
  saveSelection,
  spanClass,
  undecorate,
  type ReviewSelection,
} from "@/lib/review-rows";
import { quotedCodeSpans } from "@/lib/review";
import type {
  PendingReviewComment,
  ReviewComment,
  ReviewFileBody,
  ReviewRow,
  ReviewSide,
  ReviewThread,
} from "@/lib/review";

/**
 * ReviewDiff — one expanded file's unified diff.
 *
 * A single file's diff is bounded BY that file, so this renders as plain DOM
 * (spec § R7); what is unbounded in a pull request is the number of FILES, and
 * that is what the file list virtualizes.
 *
 * Three contracts live in this component:
 *
 * - **The anchoring contract.** Every code row carries `data-side` / `data-l`
 *   and, on deletions, `data-at` (the post-image line the deletion sat before).
 *   That tuple plus the file path is GitHub's own comment address, so a click
 *   anywhere in the diff can drive the composer and a thread fetched from `gh`
 *   finds its row without a second index.
 * - **Selection survives a repaint.** A background refine swapping lines under
 *   an in-progress selection is the NORMAL case — that selection is usually
 *   about to be quoted into a comment — so the selection is saved as
 *   `{line, col}` file coordinates before a row swap and restored by walking
 *   text nodes afterwards.
 * - **One refine round trip, never a poll.** `refine: true` means the backend
 *   answered from a tier-1 window that may have guessed; the client re-requests
 *   the file exactly once and swaps the corrected rows in. A second `refine`
 *   is not chased: the blob was too large for the background pass, and its
 *   tier-1 colour is as good as it gets.
 */
export interface ReviewDiffProps {
  body: ReviewFileBody;
  /**
   * READ-ONLY MODE. The comment seams are optional, and when `onComment` is
   * absent the hover gutter and the composer do not render at all.
   *
   * This exists for the working-directory surface, which shows the same rows
   * with no comment layer: a working-tree line has no GitHub address to anchor
   * a thread to, so the affordance would be a button that cannot work. Making
   * four props optional was the better trade against a second diff renderer.
   */
  threads?: ReviewThread[];
  /** Comments the viewer batched into an unsubmitted review, for this file. */
  pending?: PendingReviewComment[];
  busy?: boolean;
  /** Re-request this file. `range` present = a context expansion. */
  onLoadRange: (range?: { start: number; count: number }) => void | Promise<void>;
  onComment?: (
    side: ReviewSide,
    line: number,
    text: string,
    mode: "single" | "review",
  ) => void | Promise<void>;
  onReply?: (thread: ReviewThread, body: string) => void | Promise<void>;
  onResolve?: (thread: ReviewThread, resolved: boolean) => void | Promise<void>;
  onApplySuggestion?: (thread: ReviewThread, comment: ReviewComment, body: string) => void;
}

/** How many lines a `↑ N lines` expander pulls in one step. */
const CONTEXT_STEP = 20;

/** The decoration class `globals.css` styles. One class for every decoration
 *  this component adds, so `undecorate` can unwrap the whole previous pass. */
const REVIEW_MARK_CLASS = "rk-review-mark";

export function ReviewDiff({
  body,
  threads = [],
  pending = [],
  busy = false,
  onLoadRange,
  onComment,
  onReply,
  onResolve,
  onApplySuggestion,
}: ReviewDiffProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const savedSelection = useRef<ReviewSelection | null>(null);
  const refinedOnce = useRef(false);
  const [composerAt, setComposerAt] = useState<{ side: ReviewSide; line: number } | null>(null);

  // One refine round trip. The saved selection is taken BEFORE the request so
  // the coordinates describe the rows the user is actually looking at.
  useEffect(() => {
    if (!body.refine || refinedOnce.current) return;
    refinedOnce.current = true;
    if (containerRef.current) savedSelection.current = saveSelection(containerRef.current);
    void onLoadRange();
  }, [body.refine, body.path, onLoadRange]);

  // Restore after the swap paints, before the browser can show the caret in the
  // wrong place.
  useLayoutEffect(() => {
    if (!savedSelection.current || !containerRef.current) return;
    restoreSelection(containerRef.current, savedSelection.current);
    savedSelection.current = null;
  }, [body.rows]);

  // Comment indicators, decorated with a TreeWalker over the rows' TEXT NODES
  // (spec § R6). When a reviewer backtick-quotes a symbol — "rename
  // `reviewMeta` for symmetry" — they are pointing at it, so that symbol is
  // marked on the row the thread anchors to. The walk touches text nodes only,
  // so the token spans the backend computed keep their colour; assigning
  // `innerHTML` would throw them away and is not permitted. The previous pass
  // is unwrapped first, so a row swap cannot strand a mark on a line that no
  // longer says what it said.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    undecorate(container, REVIEW_MARK_CLASS);
    for (const thread of threads) {
      if (thread.isResolved || thread.isOutdated) continue;
      const row = body.rows.find((candidate) => rowMatchesThread(candidate, thread));
      const address = row ? rowAddress(row) : undefined;
      if (!row || !address) continue;
      const text = rowText(row);
      const element = container.querySelector<HTMLElement>(
        `[data-side="${address.side}"][data-l="${address.line}"] [data-code]`,
      );
      if (!element) continue;
      for (const comment of thread.comments) {
        for (const needle of quotedCodeSpans(comment.body)) {
          // Filter against the row's own text first: a quoted symbol the line
          // does not contain would cost a DOM walk for nothing.
          if (text.includes(needle)) decorateMatches(element, needle, REVIEW_MARK_CLASS);
        }
      }
    }
    return () => undecorate(container, REVIEW_MARK_CLASS);
  }, [body.rows, threads]);

  // In read-only mode there is no composer to open, so the row offers no
  // affordance at all rather than one that opens a box with nowhere to post.
  const openComposer = useCallback(
    (row: ReviewRow) => {
      if (!onComment) return;
      const address = rowAddress(row);
      if (address) setComposerAt(address);
    },
    [onComment],
  );

  const firstRendered = firstRenderedLine(body.rows);

  return (
    <div ref={containerRef} className="rk-tok text-[11px] leading-[1.45] overflow-x-auto">
      {firstRendered > 1 && (
        <ContextExpanders
          totalLines={body.totalLines}
          firstRendered={firstRendered}
          busy={busy}
          onLoadRange={onLoadRange}
        />
      )}

      {body.rows.map((row, index) => {
        const address = rowAddress(row);
        const anchored =
          composerAt && address && composerAt.side === address.side && composerAt.line === address.line;
        const rowThreads = threads.filter((thread) => rowMatchesThread(row, thread));
        const gutter = gutterNumbers(row);
        return (
          <div key={`${row.kind}-${index}`}>
            <div
              {...rowAttributes(row)}
              className={`${rowClass(row)}${anchored ? " rk-review-row-anchored" : ""}`}
            >
              <span className="w-10 shrink-0 text-right pr-1.5 text-text-secondary select-none">
                {gutter.left}
              </span>
              <span className="w-10 shrink-0 text-right pr-1.5 text-text-secondary select-none">
                {gutter.right}
              </span>
              {row.kind === "hunk" ? (
                <span className="flex-1 px-1.5 text-text-secondary">{row.header}</span>
              ) : (
                <>
                  <button
                    type="button"
                    aria-label={`Comment on ${address ? `${address.side}${address.line}` : "line"}`}
                    onClick={() => openComposer(row)}
                    className="shrink-0 w-4 text-text-secondary hover:text-accent-green select-none"
                  >
                    +
                  </button>
                  <span className="shrink-0 w-3 text-text-secondary select-none">
                    {rowSign(row)}
                  </span>
                  {/* data-code scopes decoration to the CODE cell, so a
                      quoted `2` cannot also mark the gutter's line number. */}
                  <span data-code="" className="flex-1 pr-2">
                    {(row.spans ?? []).map((span, i) => (
                      <span key={i} className={spanClass(span)}>
                        {span.t}
                      </span>
                    ))}
                  </span>
                </>
              )}
            </div>

            {onReply &&
              onResolve &&
              rowThreads.map((thread) => (
                <ReviewThreadCard
                  key={thread.id}
                  thread={thread}
                  busy={busy}
                  onReply={onReply}
                  onResolve={onResolve}
                  onApplySuggestion={onApplySuggestion}
                />
              ))}

            {pending
              .filter(
                (entry) =>
                  address && entry.side === address.side && entry.line === address.line,
              )
              .map((entry, i) => (
                <PendingReviewCard key={`pending-${i}`} comment={entry} />
              ))}

            {anchored && composerAt && onComment && (
              <ReviewComposer
                side={composerAt.side}
                line={composerAt.line}
                busy={busy}
                onSubmit={async (text, mode) => {
                  await onComment(composerAt.side, composerAt.line, text, mode);
                  setComposerAt(null);
                }}
                onCancel={() => setComposerAt(null)}
              />
            )}
          </div>
        );
      })}

      {body.rows.length === 0 && (
        <div className="px-2 py-1.5 text-text-secondary">No diff available for this file.</div>
      )}
    </div>
  );
}

/**
 * The sixth comment state: a comment the viewer batched into an unsubmitted
 * review (`docs/wiki/review-comment-states.html` § 6). It is LOCAL ONLY — gh
 * cannot see a pending review — so it carries an amber left edge to say that
 * nobody else can see it yet, and it offers no reply or resolve affordance
 * because there is no thread to act on until the review is submitted.
 */
function PendingReviewCard({ comment }: { comment: PendingReviewComment }) {
  return (
    <div
      data-testid="review-pending-comment"
      data-thread-state="pending"
      className="rk-review-pending m-1 rounded bg-bg-card text-xs font-mono px-2 py-1.5"
    >
      <div className="text-marker-ink">pending review · not visible to anyone else yet</div>
      <pre className="whitespace-pre-wrap text-text-primary">{comment.body}</pre>
    </div>
  );
}

/** `↕ All N lines` / `↑ N lines` — both read the SAME cached blob the lexer
 *  uses, so expansion costs no extra gh call once the file has been opened. */
function ContextExpanders({
  totalLines,
  firstRendered,
  busy,
  onLoadRange,
}: {
  totalLines: number;
  firstRendered: number;
  busy: boolean;
  onLoadRange: (range?: { start: number; count: number }) => void | Promise<void>;
}) {
  const step = Math.min(CONTEXT_STEP, firstRendered - 1);
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-secondary">
      <button
        type="button"
        disabled={busy}
        onClick={() => void onLoadRange({ start: Math.max(1, firstRendered - step), count: step })}
        className={controlClass({ variant: "chip", disabled: busy || undefined })}
      >
        {`↑ ${step} lines`}
      </button>
      {totalLines > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onLoadRange({ start: 1, count: totalLines })}
          className={controlClass({ variant: "chip", disabled: busy || undefined })}
        >
          {`↕ All ${totalLines} lines`}
        </button>
      )}
    </div>
  );
}

/** The lowest post-image line the current rows show — what the `↑` expander
 *  counts back from. */
function firstRenderedLine(rows: ReviewRow[]): number {
  for (const row of rows) {
    if (row.right && row.right > 0) return row.right;
  }
  return 1;
}
