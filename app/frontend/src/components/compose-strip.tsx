import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useFocusedTerminal, type FocusedTerminal } from "@/contexts/focused-terminal-context";
import { useChromeDispatch, useChromeState } from "@/contexts/chrome-context";
import { useFileUpload } from "@/hooks/use-file-upload";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useKeybindings } from "@/hooks/use-keybindings";
import { chordHintFor } from "@/lib/keybindings";
import { ApiError, sendOperatorRequest, sendToWindow, type WindowSendMode } from "@/api/client";
import { useToast } from "@/components/toast";
import { controlClass } from "@/components/control";
import { INPUT_FOCUS } from "@/components/controls";
import { OperatorContextChip } from "@/components/operator-context-chip";
import { getOperatorChatTarget, useOperatorChatChip } from "@/lib/quake-terminal";
import {
  classifyComposeEnter,
  composeSubmitKeycap,
  type ComposeEnterAction,
} from "@/lib/compose-keys";
import { fitTextarea } from "@/lib/textarea-autogrow";
import { handleReadlineKey, insertTextAtCaret } from "@/lib/readline-keys";
import { useWindowStore, entryKey } from "@/store/window-store";
import { Tip, TipGroup } from "@/components/tip";
import { ComposeHistoryFlyout } from "@/components/compose-history-flyout";
import {
  COMPOSE_STRIP_ATTACH_EVENT,
  consumeComposeStripFocusOnOpen,
  drainComposeStripAttachments,
  registerComposeRecallOpener,
  registerComposeStripFocuser,
  setComposeStripFocused,
} from "@/lib/compose-strip-events";
import { focusMemoryKey, recordFocus } from "@/lib/focus-memory";
import {
  getComposeDraft,
  getComposeSentHistory,
  pushComposeSentHistory,
  subscribeComposeDraft,
  setComposeText,
  setComposeAttachments,
  clearComposeDraft,
  type ComposeAttachment,
} from "@/lib/compose-draft-store";

/**
 * The docked compose strip — a single global, sticky text-input surface docked
 * at the bottom of the terminal area, immediately above the bottom-bar keys
 * (260718-dhdj). It REPLACES the modal `ComposeBuffer` dialog: no backdrop, no
 * `role="dialog"`/`aria-modal`, no focus trap, no Escape-closes, no
 * close-on-send.
 *
 * A real `<textarea>` gives IME/dictation (xterm.js renders to a `<canvas>`, so
 * the OS has no text input to attach to) and is a stable home for pasting large
 * text blocks over a laggy relay. Autocorrect, autocapitalize, and spellcheck
 * are all switched OFF below: this text goes to a shell, where a helpful
 * rewrite of a path or a flag is a bug, not a convenience.
 *
 * Target model has two explicit modes. Normal terminal composition sends to the
 * CURRENTLY-focused pane from `FocusedTerminalContext`, read live at send time
 * and addressed through the window send API — never a target snapshotted at
 * open. Selection broadcast instead
 * receives a FROZEN composite-key set from the palette, labels it `→ N selected`,
 * and submits the text through its callback. The target is always visible, so a
 * user can tell which mode owns the draft before sending. Broadcast is
 * SUBMIT-ONLY (a cross-server recipient set has no single pane to address for
 * insert/raw and no shared worktree for upload), so it takes the classifier's
 * `"broadcast"` policy — plain Enter is a local
 * newline, Cmd/Ctrl+Enter is the sole submit, and `enterkeyhint` says so — and
 * a submit that reached NO recipient (0 of N) keeps the composed draft.
 *
 * Interaction (the shared `classifyComposeEnter` classifier with
 * `surface: "strip"` — 260802-lj98, the terminal-faithful Enter matrix): plain
 * Enter = INSERT LINE intent and clear that target's draft, so consecutive
 * Enters stage sentence-per-line in the agent's composer, visibly, exactly
 * like typing into the pane itself. Selection broadcast
 * deliberately diverges (keeps Enter=newline): a frozen cross-server recipient
 * set has no single visible pane for a staged line to land in, so
 * Enter-as-insert there would make typed text vanish — the one
 * classifier declares both policies, per surface. Shift+Enter is the ONLY
 * local multi-line compose. Cmd/Ctrl+Enter is the ONLY submit chord, and on an
 * EMPTY textarea carries bare-Enter intent, completing the stage-then-submit
 * loop from the keyboard. Alt+Enter is the chord-only
 * byte-exact raw insert (text WITHOUT any trailing byte — completing a partial
 * line); the Insert button follows Enter (insert line). `enterkeyhint` is
 * `"send"` (Enter transmits — the truthful hint). Enter is guarded against IME
 * composition; an empty plain Enter is a FULL no-op (consumed, no local
 * newline, nothing sent); empty insert/raw-insert are no-ops. The textarea
 * also carries the shared readline editing layer (`handleReadlineKey` —
 * Ctrl+U/Ctrl+W/Alt+B/F/D; natively-bound macOS chords pass through).
 *
 * Focus contract (260801-sm6g, revising 260718-dhdj): the strip focuses its
 * textarea on the OPEN transition only — every open path funnels through
 * `toggleComposeStrip()`, which marks the module-level focus-on-open flag
 * (`compose-strip-events.ts`); the mount effect consumes-and-clears it and
 * focuses, declining in the disabled "no target" state. Everything else keeps
 * the no-steal rule: after-send never grabs focus, Escape blurs the textarea
 * back to the terminal, and a route remount with the strip already enabled
 * (no toggle → no flag) never steals focus.
 *
 * Uploads ride `useFileUpload` scoped to the LIVE focused target's worktree
 * (eager upload). Because the draft — attachments included — is keyed by that
 * same target, an attachment can never face a different worktree than the one
 * it was uploaded to: switching targets switches drafts, so there is no
 * re-homing (no re-upload, no path rewriting) on focus change.
 *
 * The compose SURFACE always mounts at its dock — the callers (the in-tile
 * dock in `surface-layout.tsx` via its `ttyDockContent` slot, the shell
 * footers in `app.tsx` / `board-page.tsx`) mount `ComposeStrip`
 * unconditionally, and the `composeStripEnabled` chrome preference picks the
 * FORM inside this module: the expanded body below, or the one-row collapsed
 * tongue (see `ComposeStrip`'s decision table). The expanded body itself
 * mounts only while it is the chosen form.
 * The header row carries an on-strip × close button firing the SAME
 * `toggleComposeStrip()` as the `>_` chip / palette entry (260722-d5q7) — a
 * pointer convenience only (Escape still blurs, never closes; no confirmation
 * needed because closing is lossless via the module store).
 * Because that mount is conditional AND per-route (the two footers are distinct
 * subtrees), drafts live in a MODULE store (`compose-draft-store.ts`, a
 * `useSyncExternalStore` seam) rather than component-local `useState`. Drafts
 * are PER TARGET — keyed by `entryKey(server, windowId)`, the live focused
 * target (260801-cyth, reversing 260718-dhdj's single traveling draft): each
 * window keeps its own unsent draft, shown whenever that window is focused,
 * surviving toggle-off/on, route changes, board pane-focus cycling, and (text
 * only, via localStorage) page refreshes. Blob URLs for previews are derived
 * per-mount from the retained `File` objects, so they are the one piece of
 * state that stays component-local.
 *
 * Sent-history recall (260806-kadm): sending clears the draft unconditionally
 * and none of the three hops (a queued `ws.send`, the backend's ignored PTY
 * write error, a pane app that swallows the bytes) can confirm acceptance — so
 * every delivered send is recorded per target (`pushComposeSentHistory`,
 * immediately before the clear) and ↑ walks back through it. Recovery over
 * verification: the clear stays unconditional and the send semantics are
 * untouched; the text is simply always one keystroke away. ↑ is intercepted
 * ONLY on an empty textarea (or mid-walk) so a multi-line draft keeps native
 * cursor movement; ↓ walks toward newer and, past the newest entry, restores
 * the stashed pre-recall text and ends the walk. Mid-walk the arrows follow
 * the REPL line-boundary discipline — a recalled entry can be multi-line, so
 * ↑ steps older only from the FIRST line and ↓ steps newer only from the LAST
 * line (collapsed selection required); everywhere else they move the caret
 * natively within the recalled text. Only a BARE, non-composing
 * arrow can recall — an IME-composing arrow navigates the candidate list and a
 * modified one is a native editing motion (Shift=select, Alt/Cmd=paragraph or
 * document jump), the same exact-modifier discipline `classifyReadlineKey`
 * declares. The walk's index + stash live in refs (no render reads them — the
 * recalled text goes through `setComposeText`, so the store-controlled textarea
 * and its auto-grow behave exactly as if typed), and it ends on ANY text
 * mutation that is not a recall step (a keystroke, an upload's path lines, an
 * attachment removal), on any send, and — eagerly, via a `draftKey` effect
 * rather than at the next keydown — on a target switch. Recall restores TEXT
 * ONLY: the `File` objects were revoked at send and are unpersistable, but
 * their path lines ride the recalled text. The card also exposes that same
 * newest-first history as a portalled list: choosing a row loads the draft and
 * focuses the textarea, but never transmits it.
 *
 * Pane-aligned geometry (260812-fryz) is retired (260813-j3jb): the strip no
 * longer measures the focused pane to narrow its visible box. It renders at
 * exactly one of two docks, both container-aligned by construction — INSIDE
 * the first tty tile on the desktop terminal route (single-send; the tile
 * frame makes the target self-evident, and the tile's zoom/hide/close carries
 * the strip for free), or full-width at the shell footer (selection
 * broadcast, the board route, mobile, and no-tty layouts). Both docks render
 * this same component backed by the module draft store, so a dock flip loses
 * no draft; the dock split doubles as the mode signal — in-tile = sends to
 * this terminal, footer = broadcast (or a tile-less fallback).
 */

/** Compose the window-store lookup key from a focused target. */
function focusedKey(f: NonNullable<FocusedTerminal>): string {
  return entryKey(f.server, f.windowId);
}

export type ComposeSelectionTarget = {
  /** Frozen composite selection keys captured by the palette action. */
  keys: readonly string[];
  /**
   * Submit the composed prompt to the frozen recipients, resolving with the
   * DELIVERED recipient count. `0` (nobody received it) retains the draft — the
   * executor absorbs per-recipient failures into one aggregate toast, so a
   * clear-on-resolve would destroy a prompt that reached no agent at all.
   */
  onSend: (text: string) => Promise<number>;
};

/** A stable, collision-resistant draft key for one frozen recipient set. */
function selectionDraftKey(keys: readonly string[]): string {
  return `selection:${JSON.stringify([...keys].sort())}`;
}

/** The target-less copy — one constant so the no-target tongue and the
 *  expanded body's placeholder cannot drift apart. Carries no chord: toggling
 *  the preference changes nothing visible in this state. */
const NO_TARGET_COPY = "No focused terminal — click a pane to target it";

/** Prevent mousedown from stealing focus away from the terminal/textarea —
 *  every strip button and the collapsed tongue share it. */
const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();

type ComposeStripProps = {
  selectionTarget?: ComposeSelectionTarget | null;
  /** The terminal route's window identity, for the focus-memory write gate
   *  (spec right-panel.md § The code lens). The strip targets the LIVE focused
   *  terminal, which lags a window switch by a commit: when the restore
   *  router focuses the textarea during that gap, `focused` still names the
   *  PREVIOUS window, and recording against it would cross-write that
   *  window's memory key. The textarea's `onFocus` therefore records
   *  `compose` only when the focused target IS this window. Absent (the
   *  board route's mount — focus memory is a terminal-route concern) ⇒ no
   *  recording. */
  focusMemoryWindow?: { server: string; windowId: string };
  /** True only when this element renders at the in-tile dock (app.tsx drives
   *  one shared element from its `inTileDock` predicate, so the strip never
   *  re-derives dock identity from DOM ancestry). The fine-pointer header
   *  fold keys on it — the tile frame already names the target; footer
   *  mounts (selection broadcast, board route, no-tty fallback) omit it and
   *  keep the header. */
  dockedInTile?: boolean;
  /** Hand focus to the terminal after Escape blurs the textarea — the strip
   *  is the keyboard, the terminal is the control surface, and the
   *  placeholder promises `Esc → terminal`. Each mount passes its own
   *  terminal-focus seam (the route's `focusTerminalRef`, the board's focused
   *  pane); absent, Escape only blurs. */
  onEscapeToTerminal?: () => void;
};

/**
 * The compose surface's mount point. The surface ALWAYS mounts at its dock;
 * the `composeStripEnabled` preference picks the FORM — the expanded strip or
 * a one-row collapsed tongue — so "off" leaves an in-place cue (glyph, label,
 * chord) where the strip lived instead of an empty dock. Decision table, first
 * match wins:
 *
 *   forceExpanded            → expanded body (the operator page's forced-on
 *                              footer input; its disabled no-target form stays
 *                              reachable there under a non-terminal tab)
 *   preference off           → collapsed tongue — "Compose", interactive
 *   preference on, no target → no-target tongue — inert status line
 *   otherwise                → expanded body
 *
 * "Off wins over no-target" keeps the label a truthful description of what a
 * click does: the collapsed tongue's click enables the strip; the no-target
 * line has no click because no click could produce an expanded strip.
 *
 * The expanded body UNMOUNTS while a tongue shows — deliberately. Every
 * mount-keyed seam in the body (the attach-queue drain, the focus-on-open
 * consume, the focuser registration, the focused-signal reset, the blob-URL
 * revoke) is keyed on the body mounting, so a file pasted while collapsed is
 * queued by the terminal, the toggle mounts the body, and the body's own
 * mount-time drain uploads it — no seam changes. A hidden-but-mounted body
 * would have to re-key all of those on the enabled transition.
 */
export function ComposeStrip({
  forceExpanded = false,
  ...props
}: ComposeStripProps & {
  /** Render the expanded body regardless of the preference and of target
   *  state. Passed only by the app.tsx shared element for the operator page,
   *  whose footer input is forced on. */
  forceExpanded?: boolean;
}) {
  const { composeStripEnabled } = useChromeState();
  const { focused } = useFocusedTerminal();
  const selectionTarget = props.selectionTarget ?? null;
  const hasTarget =
    (selectionTarget !== null && selectionTarget.keys.length > 0) || focused !== null;
  if (forceExpanded) return <ComposeStripExpanded {...props} forceExpanded />;
  if (!composeStripEnabled) return <CollapsedTongue />;
  if (!hasTarget) return <NoTargetTongue />;
  return <ComposeStripExpanded {...props} />;
}

/** Sentinel for the one-time "on by default" notice — written before the
 *  toast fires so StrictMode's double-invoked mount effect shows it once. */
const COMPOSE_DEFAULT_NOTICE_KEY = "hexokit-compose-default-notice";

/** Shared dock-seam wrapper for both tongue forms: the same outer/inner shape
 *  as the expanded body (unstyled outer box carrying the test id and the
 *  production `data-compose-strip` marker; inner element carrying the seam
 *  chrome) so the row-growth/refit mechanic at either dock is identical, and
 *  so the tty tile's pointerdown focus-memory write skips a press on the
 *  tongue exactly as it skips a press on the strip. */
function TongueFrame({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="compose-strip" data-compose-strip>
      <div className="border-t border-border bg-bg-primary px-1.5 py-1 flex items-center">
        {children}
      </div>
    </div>
  );
}

/** The preference-off form: a full-width show control. The `a▏` glyph is the
 *  strip's identity (shared with the status-bar and bottom-bar chips) and is
 *  STATIC here — the caret blink means "on", and this row means "off". The
 *  chord rides a trailing `<kbd>` on fine pointers only (chords are noise on
 *  touch) and is omitted when the binding is unbound/disabled, so the row never
 *  advertises a dead chord. */
function CollapsedTongue() {
  const { toggleComposeStrip } = useChromeDispatch();
  const coarsePointer = useCoarsePointer();
  const { bindings, host } = useKeybindings();
  const chord = coarsePointer ? undefined : chordHintFor("compose-toggle", bindings, host.platform);
  return (
    <TongueFrame>
      <button
        type="button"
        data-testid="compose-tongue"
        aria-label="Show compose strip"
        aria-expanded={false}
        // The click must not move focus to the button: the toggle mounts the
        // body, whose focus-on-open effect takes the textarea.
        onMouseDown={preventFocusSteal}
        onClick={toggleComposeStrip}
        className="rk-glint flex w-full items-center gap-2 rounded text-xs leading-none text-text-secondary transition-colors hover:text-text-primary coarse:min-h-[36px]"
      >
        <span aria-hidden="true">a▏</span>
        <span>Compose</span>
        {chord && (
          <kbd
            aria-hidden="true"
            className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-text-secondary"
          >
            {chord}
          </kbd>
        )}
      </button>
    </TongueFrame>
  );
}

/** The enabled-but-target-less form (board route before a pane is selected,
 *  the `/$server` tiles route, no-tty layouts). Inert: nothing a click could
 *  do would produce an expanded strip. The preference stays toggleable through
 *  the chord, the palette, and the two chips. */
function NoTargetTongue() {
  // Mirror the expanded body's decline: an open that lands here (toggle on
  // with no target) still CONSUMES the focus-on-open flag, so a body that
  // mounts later — when a pane finally gets focus — cannot inherit a stale
  // flag and steal focus on a plain remount.
  useEffect(() => {
    consumeComposeStripFocusOnOpen();
  }, []);
  return (
    <TongueFrame>
      <div
        role="status"
        data-testid="compose-tongue"
        data-state="no-target"
        className="flex w-full items-center gap-2 text-xs leading-none text-text-secondary coarse:min-h-[36px]"
      >
        <span aria-hidden="true">a▏</span>
        <span>{NO_TARGET_COPY}</span>
      </div>
    </TongueFrame>
  );
}

function ComposeStripExpanded({
  selectionTarget = null,
  focusMemoryWindow,
  dockedInTile = false,
  onEscapeToTerminal,
  forceExpanded = false,
}: ComposeStripProps & {
  /** Set by the wrapper on the operator page's forced mount. The "on by
   *  default" notice is suppressed there: the toggle it advertises would flip
   *  the preference without hiding this strip. */
  forceExpanded?: boolean;
}) {
  const { focused } = useFocusedTerminal();
  const { composeStripDefaulted } = useChromeState();
  const { bindings: keybindings, host: keybindingHost } = useKeybindings();
  // The chat-subject store (lib/quake-terminal.ts): on the operator window's
  // own route the quake terminal stamps the validated `?from=` origin window here.
  // The strip attaches the chip and forks its plain text submit onto the
  // templated chat lane only when the subject is a DIFFERENT window than the
  // strip's target — on an ordinary terminal route the stamped subject IS the
  // route window (the desktop quake launcher's chip), which must not reroute the
  // strip's direct pane sends.
  const chatChip = useOperatorChatChip();
  const navigate = useNavigate();
  const operatorChatServer =
    focused !== null &&
    chatChip.subject !== null &&
    chatChip.subject.server === focused.server &&
    chatChip.subject.windowId !== focused.windowId
      ? focused.server
      : null;
  // The header-row × fires the exact same toggle as the bottom-bar `>_` chip
  // and the `Compose: Toggle` palette entry. Consumed here (not threaded as a
  // prop) so both footer mounts (app.tsx / board-page.tsx) inherit the close
  // affordance with zero per-route work. Closing is lossless — the draft lives
  // in the module store — so no confirmation is needed.
  const { toggleComposeStrip } = useChromeDispatch();
  const { addToast } = useToast();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isSelectionTarget = selectionTarget !== null && selectionTarget.keys.length > 0;
  // Normal drafts key on the live focused target (`entryKey(server, windowId)`).
  // A selection-broadcast draft keys on the frozen, sorted recipient set, so it
  // cannot overwrite the focused pane's draft or drift if live selection changes.
  // Both use the same module store and therefore survive strip unmounts. With no
  // target the key is null: setters no-op and the textarea is disabled.
  //
  // Memoized because the store-controlled textarea re-renders the strip on EVERY
  // keystroke, and the selection branch sorts + stringifies the whole recipient
  // set. `keys` is the frozen snapshot the palette action captured (held in
  // parent state), so its reference is stable for the life of a broadcast and
  // the sort runs once per recipient-set change instead of once per keypress.
  const selectionKeys = isSelectionTarget ? selectionTarget.keys : null;
  const draftKey = useMemo(
    () => (selectionKeys ? selectionDraftKey(selectionKeys) : focused ? focusedKey(focused) : null),
    [selectionKeys, focused],
  );
  const { text, attachments: files } = useSyncExternalStore(subscribeComposeDraft, () =>
    getComposeDraft(draftKey),
  );
  const setText = useCallback(
    (next: string | ((prev: string) => string)) => {
      if (draftKey !== null) setComposeText(draftKey, next);
    },
    [draftKey],
  );
  const setFiles = useCallback(
    (next: ComposeAttachment[] | ((prev: ComposeAttachment[]) => ComposeAttachment[])) => {
      if (draftKey !== null) setComposeAttachments(draftKey, next);
    },
    [draftKey],
  );
  const blobUrlsRef = useRef<Map<File, string>>(new Map());

  // Sent history has no independent subscriber by design. A delivered send
  // clears the draft through the subscribed store seam, and a target switch
  // re-renders with its own key, so this render-time read stays current without
  // widening the persistence store's notification contract.
  const sentHistory = getComposeSentHistory(draftKey);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);

  // ── sent-history recall walk (260806-kadm) ────────────────────────────────
  // Control state only — no render reads these, so refs (not state) avoid a
  // re-render per arrow press while the visible text stays store-owned.
  //   recallIndexRef: steps back from live. -1 = no walk in progress; 0 selects
  //     the newest sent entry, 1 the one before it, and so on.
  //   recallStashRef: the textarea text at walk start, restored when ↓ steps
  //     past the newest entry (empty under the empty-textarea intercept gate,
  //     but the walk can also be re-entered mid-recall).
  const recallIndexRef = useRef(-1);
  const recallStashRef = useRef("");

  /** End any in-progress recall walk (edit, send, target switch, past-newest,
   * and any programmatic text mutation that is not a recall step). */
  const endRecall = useCallback(() => {
    recallIndexRef.current = -1;
    recallStashRef.current = "";
  }, []);

  // A target switch ends the walk EAGERLY, the instant `draftKey` changes —
  // not lazily at the next keydown. A lazy check (comparing the live key
  // against one captured at walk start) leaves the walk armed while focus is
  // elsewhere, so an A→B→A round-trip with no arrow pressed on B resumes A's
  // stale index, and an edit on B tears down A's stash. The index and stash
  // are meaningless against a stranger target, so they are discarded the
  // moment the target they belong to stops being focused.
  useEffect(() => {
    endRecall();
  }, [draftKey, endRecall]);

  // A flyout never follows focus to a different target: its entries and anchor
  // belong to the draft key that opened it.
  useLayoutEffect(() => {
    setHistoryOpen(false);
  }, [draftKey]);

  // Normal send target is read live at send time (reverses DD-6). Selection
  // broadcast is the deliberate frozen-target exception. The upload hook stays
  // scoped to the focused target's worktree and its controls are disabled in
  // selection mode, where recipients may span unrelated worktrees/servers.
  const hasTarget = isSelectionTarget || focused !== null;
  const canUpload = !isSelectionTarget && focused !== null;
  const coarsePointer = useCoarsePointer();
  const { uploadFiles, uploading } = useFileUpload(
    focused?.session ?? "",
    focused?.windowId ?? "",
    // useFileUpload throws if server resolves empty; only call it meaningfully
    // when a target exists. When `focused === null` we pass a sentinel that is
    // never used (the strip is disabled and cannot upload).
    focused?.server ?? "no-target",
  );

  // Resolve a human-readable window name for the target label, layered:
  // window-store name (live — tracks renames) → the name the registrant knew
  // at registration (board entries carry a server-derived windowName; the
  // store only covers servers whose sidebar group has delivered sessions, so
  // board panes from other servers would otherwise miss) → raw windowId.
  const focusedTargetName = useWindowStore((s) =>
    focused
      ? s.entries.get(focusedKey(focused))?.name ||
        focused.windowName ||
        focused.windowId
      : null,
  );
  const targetName = isSelectionTarget
    ? `${selectionTarget.keys.length} selected`
    : focusedTargetName;

  // Placeholder education (260811-ke2s): the strip's dead space teaches the
  // Enter policy — and is the sole surfacing of ↑ sent-history recall anywhere
  // in the UI. Fine pointers only: chord hints never render on touch. On
  // coarse pointers the terminal-target placeholder instead folds in the
  // target name (`→ {name}…`) — the header row it used to live in is folded
  // away on touch (260814-ink6). The submit keycap comes from the shared
  // `composeSubmitKeycap()` seam (⌘/Ctrl split); the Enter-policy chords are
  // classifier-owned (not registry bindings), so a computed static keycap is
  // the correct form.
  const placeholder = isSelectionTarget
    ? coarsePointer
      ? "Compose prompt…"
      : `Compose prompt — ${composeSubmitKeycap()} sends to all selected`
    : hasTarget
      ? coarsePointer
        ? `→ ${focusedTargetName ?? ""}…`
        : `Compose text — Enter inserts · ${composeSubmitKeycap()} sends · ↑ history · Esc → terminal`
      : NO_TARGET_COPY;

  // The header row renders only where it carries real signal: selection
  // broadcast, the disabled no-target state, and fine pointers at the FOOTER
  // dock. On coarse terminal-target mode the target name folds into the
  // placeholder (one visible pane, and closing stays lossless via the module
  // draft store); at the fine IN-TILE dock the tile frame already names the
  // target, so the row folds there too.
  const showHeader = isSelectionTarget || !hasTarget || (!coarsePointer && !dockedInTile);

  // ── Card/compact morph state ─────────────────────────────────────────────
  // One layout model for both pointer types; only the TRIGGER forks. Coarse:
  // card while focused, multi-line, or carrying attachments (the OS keyboard
  // slide masks the layout jump). Fine: card on DRAFT PRESENCE only — never
  // on focus, because every strip resize refits xterm — held by a hysteresis
  // latch through any edit (including backspacing the draft to empty) and
  // released only by blur-while-empty in the textarea's onBlur. Selection
  // broadcast and the no-target state are exempt: they always take card form
  // (their header + controls cannot collapse into a compact row).
  const [textFocused, setTextFocused] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  // The latch is keyed so a target switch can never hold a stranger's card
  // open: it latches for the draft key that had content and reads false for
  // any other key.
  const [latchedKey, setLatchedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!coarsePointer && draftKey !== null && (text !== "" || files.length > 0)) {
      setLatchedKey(draftKey);
    }
  }, [coarsePointer, draftKey, text, files.length]);
  // Multi-line probe: an explicit newline, or single-line content whose
  // rendered height wraps past the one-row box (measured in `resize` below).
  const multiline = text.includes("\n") || wrapped;
  const isCard =
    isSelectionTarget ||
    !hasTarget ||
    historyOpen ||
    (coarsePointer
      ? textFocused || multiline || files.length > 0
      : text !== "" || files.length > 0 || (draftKey !== null && latchedKey === draftKey));

  // Auto-grow to content, bounded (then internal scroll) via the shared
  // fitTextarea helper. `preserveWrap` is the layout-remeasure mode: a
  // morph-driven re-measure may
  // SET the wrap probe but never CLEAR it — the card's full-width box renders
  // the same text unwrapped, so a fresh read there would release the very
  // trigger that just opened the card and oscillate compact⇄card forever.
  // Only a text edit (the fresh mode below) can clear it.
  const resize = useCallback((preserveWrap = false) => {
    const el = textareaRef.current;
    if (!el) return;
    // The wrap probe measures under the same height:auto posture fitTextarea
    // measures in: a larger scrollHeight than the one-row box means the
    // content wrapped (jsdom: both are 0, so it reads unwrapped).
    el.style.height = "auto";
    const measured = el.scrollHeight > el.offsetHeight + 1;
    setWrapped((prev) => (preserveWrap ? prev || measured : measured));
    fitTextarea(el);
  }, []);

  useLayoutEffect(() => resize(), [text, resize]);
  // The wrap probe is layout-dependent — the compact box is narrower than the
  // card's (chips flank it) — so a card⇄compact morph re-measures under the
  // new width: a long single-line draft that fit the full-width card must
  // re-enter the card when the compact row wraps it (blur changes no text, so
  // the text-keyed measure above never runs on a morph). Preserve mode keeps
  // the re-entry stable, and the re-run also refreshes the pixel height the
  // old width left behind.
  useLayoutEffect(() => resize(true), [isCard, resize]);

  // Blob-URL lifecycle: this mount's preview URLs are per-mount (the map is a
  // fresh ref each mount), so revoke them on unmount to avoid a leak. The
  // retained `File` objects live on in the module store, so a remount recreates
  // the URLs lazily via `getBlobUrl` — the draft (files + text) is unaffected.
  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // Reclaim URLs for files no longer in the VISIBLE draft: switching targets
  // (or a draft cleared while unfocused) would otherwise strand a departed
  // target's preview URLs in the map for as long as the strip stays mounted.
  // Over-revoking is safe — the files live on in their draft, and `getBlobUrl`
  // recreates a URL lazily when that draft is shown again.
  useEffect(() => {
    const visible = new Set(files.map((uf) => uf.file));
    for (const [file, url] of blobUrlsRef.current) {
      if (!visible.has(file)) {
        URL.revokeObjectURL(url);
        blobUrlsRef.current.delete(file);
      }
    }
  }, [files]);

  function getBlobUrl(file: File): string {
    const existing = blobUrlsRef.current.get(file);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    blobUrlsRef.current.set(file, url);
    return url;
  }

  const [sending, setSending] = useState(false);

  const send = useCallback(
    (mode: Exclude<ComposeEnterAction, "default">) => {
      if (draftKey === null || sending) return; // no target — nothing to send or clear
      const empty = text.trim() === ""; // whitespace-only counts as empty
      // Delivered: clear THIS target's draft + attachments; the strip stays
      // open and does NOT grab or return focus. (An empty submit carries no
      // text, so there is nothing meaningful to clear — a whitespace-only
      // draft is simply discarded here.) The module store is the source of
      // truth for the draft; revoke only the cleared draft's preview URLs
      // (other targets' previews recreate lazily when their draft is shown).
      const finishDeliveredSend = () => {
        for (const uf of files) {
          const url = blobUrlsRef.current.get(uf.file);
          if (url) {
            URL.revokeObjectURL(url);
            blobUrlsRef.current.delete(uf.file);
          }
        }
        // Record the transmitted text BEFORE clearing so ↑ can recover it —
        // the clear stays unconditional (recovery over verification). Every
        // mode pushes the composed text; the store's own whitespace guard makes
        // an empty submit push nothing. A guard-blocked or failed send never
        // reaches here, so nothing is cleared or recorded.
        pushComposeSentHistory(draftKey, text);
        clearComposeDraft(draftKey);
        // A send is a walk-ending event: the next ↑ starts fresh from the
        // newest entry (which is the text just sent).
        endRecall();
      };
      // Selection broadcast is deliberately TEXT-SUBMIT only. A frozen
      // recipient set spans servers, so raw/insert modes have no single target
      // to address and upload has no shared worktree; Cmd/Ctrl+Enter and the
      // Send button both reach this submit branch. Shift+Enter remains the
      // normal local-newline path.
      if (isSelectionTarget) {
        if (mode !== "submit" || empty) return;
        setSending(true);
        void selectionTarget
          .onSend(text)
          .then((delivered) => {
            // 0 of N delivered: nobody saw the prompt, so keep it composed for
            // the retry (the failed recipients also stay selected). A PARTIAL
            // delivery clears like any delivered send — ↑ recalls the text.
            if (delivered === 0) return;
            pushComposeSentHistory(draftKey, text);
            clearComposeDraft(draftKey);
            endRecall();
          })
          // The integration executor absorbs per-recipient failures and
          // reports them via one aggregate toast. Preserve the draft if an
          // unexpected outer failure escapes that boundary.
          .catch(() => undefined)
          .finally(() => setSending(false));
        return;
      }
      // Empty policy is per mode: an empty SUBMIT becomes the `enter` mode —
      // "press Enter in the pane", completing the stage-then-submit loop
      // (whitespace is discarded, never transmitted); empty insert/insert-line
      // never send.
      if (empty && mode !== "submit") return;
      if (!focused) return;

      // The templated chat lane: on the operator window's route with an
      // origin subject attached, a plain text SUBMIT rides the
      // operator-request lane at the SUBJECT window (the server wraps the
      // text in a source envelope) instead of the direct pane send. Only the
      // plain-submit path forks — special-key and mode-carrying sends
      // (bottom-bar keys, enter, raw, inserts) always go direct to the pane;
      // driving the TUI is the point of the route. The subject is read at
      // send time, never captured earlier.
      const chatSubject =
        mode === "submit" && !empty ? getOperatorChatTarget(focused.server) : null;

      const sendMode: WindowSendMode =
        mode === "submit" ? (empty ? "enter" : "submit") : mode === "insert" ? "raw" : mode;
      const sentKey = draftKey;
      const sentFiles = files;
      setSending(true);
      const delivery: Promise<unknown> =
        chatSubject !== null && chatSubject.windowId !== focused.windowId
          ? sendOperatorRequest(focused.server, chatSubject.windowId, "user-message", text)
          : sendToWindow(focused.server, focused.windowId, empty ? "" : text, sendMode);
      void delivery
        .then(() => {
          const live = getComposeDraft(sentKey);
          const filesUnchanged =
            live.attachments.length === sentFiles.length &&
            live.attachments.every((attachment, index) => attachment === sentFiles[index]);
          if (live.text === text && filesUnchanged) {
            finishDeliveredSend();
            return;
          }
          pushComposeSentHistory(sentKey, text);
          endRecall();
        })
        .catch((err: unknown) => {
          if (
            err instanceof ApiError &&
            (err.code === "probe_failure" || err.code === "staged_send_failure")
          ) {
            addToast(
              "Text is staged in the pane but unsent. Pressing Send again would duplicate it.",
              "error",
              {
                label: "Press Enter in pane",
                // The recovery Enter is a delivery like any other, so it holds
                // the same in-flight lock: Send and Insert stay unavailable
                // until it settles and cannot stack a second Enter onto it.
                onSelect: () => {
                  setSending(true);
                  void sendToWindow(focused.server, focused.windowId, "", "enter")
                    .catch(() => {
                      addToast("Enter could not be sent; nothing was delivered.", "error");
                    })
                    .finally(() => setSending(false));
                },
              },
            );
            return;
          }
          if (err instanceof ApiError && err.code === "submit_unverified") {
            addToast(
              "Enter was sent, but the message may or may not have landed. Check the pane before resending.",
              "error",
            );
            return;
          }
          addToast("Send failed; nothing was delivered. Retrying is safe.", "error");
        })
        .finally(() => setSending(false));
    },
    [
      draftKey,
      text,
      files,
      focused,
      endRecall,
      isSelectionTarget,
      sending,
      selectionTarget,
      addToast,
    ],
  );

  /**
   * ↑/↓ sent-history recall. Returns `true` when the arrow was consumed (the
   * caller then preventDefaults it), `false` to let native cursor movement
   * proceed.
   *
   * ↑ is intercepted only when it CANNOT mean cursor movement — an empty
   * textarea, or a walk already in progress (where the visible text is
   * recalled, not composed). ↓ is intercepted only during a walk. Stepping
   * back past the oldest entry pins there (no wrap); stepping forward past the
   * newest restores the pre-walk stash and ends the walk.
   *
   * Mid-walk, recalled entries can be MULTI-LINE, so the walk only steps from
   * a line boundary (the REPL discipline): ↑ steps older only with the caret
   * on the FIRST line, ↓ steps newer only with the caret on the LAST line, and
   * both require a collapsed selection (a bare arrow over a selection is the
   * native collapse motion). Everywhere else the arrow moves the caret
   * natively WITHIN the recalled text and the walk stays alive — caret motion
   * is not an edit, so it must not end the session. A recall step lands the
   * caret at the end of the entry (native value-set behavior), so on a
   * single-line entry — first line == last line — repeated ↑ walks straight
   * through, byte-identical to the pre-boundary behavior.
   */
  function handleRecallKey(key: "ArrowUp" | "ArrowDown", el: HTMLTextAreaElement): boolean {
    if (draftKey === null) return false;
    // No stale-target check is needed here: the walk is torn down eagerly by
    // the `draftKey` effect above, so an in-progress walk always belongs to
    // the currently-focused target.
    const walking = recallIndexRef.current !== -1;
    // Line-boundary gate. An empty textarea satisfies both sides trivially
    // (selection 0/0, no newlines), so the session-start path is unaffected.
    const collapsed = el.selectionStart === el.selectionEnd;
    const onFirstLine = collapsed && !el.value.slice(0, el.selectionStart).includes("\n");
    const onLastLine = collapsed && !el.value.includes("\n", el.selectionEnd);

    if (key === "ArrowDown") {
      if (!walking) return false; // outside a walk, ↓ is native cursor movement
      if (!onLastLine) return false; // inside a multi-line recall — move natively
      const next = recallIndexRef.current - 1;
      if (next < 0) {
        // Past the newest entry — restore what the user had before the walk.
        const stash = recallStashRef.current;
        endRecall();
        setComposeText(draftKey, stash);
        return true;
      }
      recallIndexRef.current = next;
      setComposeText(draftKey, getComposeSentHistory(draftKey)[next] ?? "");
      return true;
    }

    // ArrowUp. Outside a walk it means recall ONLY on an empty textarea;
    // otherwise the caret is inside real composition and must move natively.
    if (!walking && text !== "") return false;
    if (!onFirstLine) return false; // inside a multi-line recall — move natively
    const history = getComposeSentHistory(draftKey);
    if (history.length === 0) return false; // nothing to recall — stay native
    // Step back one, pinning at the oldest entry rather than wrapping.
    const next = Math.min(recallIndexRef.current + 1, history.length - 1);
    if (!walking) recallStashRef.current = text;
    recallIndexRef.current = next;
    setComposeText(draftKey, history[next] ?? "");
    return true;
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Escape dismisses transient recall, blurs the textarea, and hands focus
    // to the terminal through the mount's seam (never closes the strip).
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setHistoryOpen(false);
      textareaRef.current?.blur();
      onEscapeToTerminal?.();
      return;
    }
    // Shared readline editing layer (handleReadlineKey): Ctrl+U/Ctrl+W/Alt+B/F/D,
    // consuming the chord so it never reaches global listeners. Everything else
    // falls through.
    if (handleReadlineKey(e.nativeEvent, e.currentTarget)) return;
    // Sent-history recall — sits between the readline layer (which owns no
    // arrow keys, so composition is clean) and the Enter classifier.
    //
    // Only a BARE, non-composing arrow can mean recall, matching the exact-
    // modifier discipline the neighbouring layers already declare:
    //   - IME composing (`isComposing`) — ↑/↓ navigate the candidate list, so
    //     intercepting would break every CJK/IME composition in the strip (the
    //     surface that exists BECAUSE xterm.js has no IME). Both neighbours
    //     (`classifyComposeEnter`, `classifyReadlineKey`) guard on it.
    //   - Any modifier — Shift+↑/↓ extends the selection, Alt/Opt+↑/↓ and
    //     Cmd+↑/↓ are macOS paragraph/document jumps, Ctrl+↑/↓ is bound by
    //     desktop environments. All are native editing motions that recall
    //     must never swallow (`classifyReadlineKey`: "Meta or Shift anywhere →
    //     unhandled").
    const bareArrow =
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.nativeEvent.isComposing &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.ctrlKey;
    if (bareArrow) {
      if (handleRecallKey(e.key as "ArrowUp" | "ArrowDown", e.currentTarget)) {
        e.preventDefault();
        e.stopPropagation();
      }
      // A non-intercepted arrow falls through untouched: native cursor
      // movement in a non-empty draft is never hijacked.
      return;
    }
    // Shared Enter policy (classifyComposeEnter — one classifier, declared per
    // surface; the strip's plain Enter is insert-line while the broadcast
    // mode's stays newline — a deliberate, visibility-motivated divergence
    // declared inside the one classifier, never forked here). "default" means:
    // do not intercept — the textarea inserts a
    // newline (Shift+Enter, IME composition, non-Enter keys).
    //
    // Selection broadcast takes the "broadcast" policy for the classifier's own
    // stated reason: insert-line exists because the strip overlays the VISIBLE
    // pane a staged line lands in, and a frozen cross-server recipient set has
    // no such pane. Plain Enter therefore inserts a local newline (multiline
    // compose is retained) and Cmd/Ctrl+Enter stays the sole submit.
    const action = classifyComposeEnter(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
      },
      isSelectionTarget ? "broadcast" : "strip",
    );
    if (action === "default") return;
    // Broadcast mode is submit-only, so the terminal-stream modes are left
    // NATIVE rather than consumed into a silent no-op (Alt+Enter's raw insert
    // would otherwise swallow the keystroke and do nothing).
    if (isSelectionTarget && action !== "submit") return;
    // Consume every non-default action (preventDefault + stopPropagation so
    // it never bubbles to global chords) and hand it to send() as-is. An
    // insert-line on an EMPTY textarea is therefore a FULL no-op: the keydown
    // is consumed (no local newline appears) and send() sends nothing.
    e.preventDefault();
    e.stopPropagation();
    send(action);
  };

  // File uploads through the strip's own 📎 button.
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const handleUpload = useCallback(
    async (list: FileList | File[]) => {
      const arr = Array.from(list);
      if (!canUpload || arr.length === 0) return;
      const results = await uploadFiles(arr);
      if (results.length === 0) return;
      // Appending path lines is a text mutation exactly like typing, so it ends
      // any recall walk. Leaving the walk armed would orphan the attachment:
      // the next arrow overwrites the text (dropping the path line) while the
      // `File` and its preview stay mounted, leaving a chip with no path.
      endRecall();
      setFiles((prev) => [...prev, ...results]);
      setText((current) => {
        const paths = results.map((u) => u.path).join("\n");
        if (current === "") return paths;
        return current.endsWith("\n") ? current + paths : current + "\n" + paths;
      });
    },
    [canUpload, uploadFiles, setFiles, setText, endRecall],
  );

  // Drain files handed off from the terminal's drag-drop / paste gestures
  // (via `dispatchComposeStripAttach`). Drain both on the attach event and on
  // mount (the strip may have just been enabled, mounting after the dispatch).
  useEffect(() => {
    function drain() {
      const files = drainComposeStripAttachments();
      if (files.length > 0) void handleUpload(files);
    }
    drain();
    document.addEventListener(COMPOSE_STRIP_ATTACH_EVENT, drain);
    return () => document.removeEventListener(COMPOSE_STRIP_ATTACH_EVENT, drain);
  }, [handleUpload]);

  // Register the strip's textarea focuser so the touch ⌨ keyboard button can
  // focus this real input (the IME surface xterm's canvas lacks) without reaching
  // into the DOM by test id. Reads the textarea's live `disabled` state so the
  // "no target" case declines and the caller falls back to the terminal. Stable
  // (reads a ref), so a single register/unregister at mount suffices.
  useEffect(() => {
    return registerComposeStripFocuser(() => {
      const el = textareaRef.current;
      if (!el || el.disabled) return false;
      el.focus();
      return true;
    });
  }, []);

  const openHistory = useCallback(() => {
    if (draftKey === null || sentHistory.length === 0) return false;
    // Palette invocation can arrive while the strip is compact. Opening first
    // expands the shared card so the same chip can become the floating anchor.
    setHistoryOpen(true);
    return true;
  }, [draftKey, sentHistory.length]);

  useEffect(() => registerComposeRecallOpener(openHistory), [openHistory]);

  // Focus-on-open (260801-sm6g): consume the flag set by `toggleComposeStrip`'s
  // off→on transition and focus the textarea — the same disabled-state respect
  // as the registered focuser (the "no target" state declines, but the consume
  // still clears the flag so a later remount cannot inherit it). Plain route
  // remounts never set the flag, so they never steal focus.
  useEffect(() => {
    if (!consumeComposeStripFocusOnOpen()) return;
    const el = textareaRef.current;
    if (!el || el.disabled) return;
    el.focus();
  }, []);

  // One-time "on by default" notice: only when the DEFAULT put the strip on
  // screen (no stored preference), never on the operator page's forced mount
  // (the advertised toggle would not hide that strip), and once per browser.
  // The sentinel is written BEFORE the toast so a StrictMode effect replay
  // cannot show it twice. Read-once inputs, so mount-only deps are correct.
  useEffect(() => {
    if (forceExpanded || !composeStripDefaulted) return;
    try {
      if (localStorage.getItem(COMPOSE_DEFAULT_NOTICE_KEY) !== null) return;
      localStorage.setItem(COMPOSE_DEFAULT_NOTICE_KEY, "1");
    } catch {
      return;
    }
    const chord = chordHintFor("compose-toggle", keybindings, keybindingHost.platform);
    addToast(chord ? `Compose is on by default — ${chord} hides it` : "Compose is on by default", "info");
  }, []);

  // Publish the textarea's focus state to the module store (260814-ink6) so
  // the bottom bar can hide while composing on coarse pointers. onFocus/
  // onBlur on the textarea keep the flag live; this effect SYNCS it from the
  // real DOM focus at mount and clears it on unmount (a strip toggled off
  // while focused can never stick the bar hidden). The mount-time sync —
  // declared AFTER focus-on-open so it observes that focus — is what keeps
  // StrictMode's effect replay (e2e/dev run under <StrictMode>) from
  // stranding the flag false: the replay's cleanup clears the flag but no
  // new focus event fires for the still-focused textarea, so the re-run
  // must re-derive it from document.activeElement.
  useEffect(() => {
    const el = textareaRef.current;
    setComposeStripFocused(el !== null && document.activeElement === el);
    return () => setComposeStripFocused(false);
  }, []);

  const removeFile = useCallback(
    (index: number) => {
      // Read the target from the live store snapshot rather than reaching into
      // a setter's updater — updaters stay pure so StrictMode's double-invoke
      // does not double-fire the blob-URL revoke or the textarea splice.
      const target = getComposeDraft(draftKey).attachments[index];
      if (!target) return;
      const url = blobUrlsRef.current.get(target.file);
      if (url) {
        URL.revokeObjectURL(url);
        blobUrlsRef.current.delete(target.file);
      }
      // Splicing the path line out is a text mutation like typing, so it ends
      // any recall walk (same orphaning hazard as handleUpload, in reverse).
      endRecall();
      // Remove the path line from the textarea.
      setText((current) => {
        const lines = current.split("\n");
        const i = lines.indexOf(target.path);
        if (i === -1) return current;
        lines.splice(i, 1);
        return lines.join("\n");
      });
      setFiles((prev) => prev.filter((_, i) => i !== index));
    },
    [draftKey, setText, setFiles, endRecall],
  );

  /**
   * The coarse-only ⏎ chip (260814-ink6) — the Shift+Enter local-newline path
   * mobile keyboards cannot produce. A local edit, never a send: the
   * insertion rides the shared undo-safe helper; its (native or bubbled)
   * `input` event reaches the textarea's onChange, which ends any recall
   * walk and writes the store, so the draft persists and auto-grows exactly
   * as if typed. `classifyComposeEnter` and `enterKeyHint` are untouched.
   */
  const insertLocalNewline = () => {
    const el = textareaRef.current;
    if (!el || el.disabled) return;
    insertTextAtCaret(el, "\n");
  };

  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const selectHistoryEntry = useCallback(
    (entry: string) => {
      endRecall();
      setText(entry);
      setHistoryOpen(false);
      textareaRef.current?.focus();
    },
    [endRecall, setText],
  );

  // Per-button enablement (260802-lj98, revised 260813-kvk7, re-revised
  // 260814): Insert follows Enter's empty no-op — disabled with no text. Send
  // mirrors its Cmd/Ctrl+Enter chord INCLUDING the empty bare-`\r` case
  // ("press Enter in the pane") — on touch devices the chord doesn't exist,
  // so the button is the ONLY way to send a bare Enter there. kvk7's
  // complaint (a lit primary Send over an empty composer read as broken) is
  // answered by STYLE, not state: an empty composer renders Send in the
  // neutral secondary face; the lit green fill returns with text.
  // Selection-broadcast targets keep their own rule (text required, Insert
  // always disabled there).
  const composerEmpty = text.trim() === "";
  const canInsert = !isSelectionTarget && hasTarget && !composerEmpty && !sending;
  const canSubmit = isSelectionTarget
    ? !composerEmpty && !sending
    : hasTarget && !sending;

  // Shared element descriptors for the single card/compact structure below —
  // each control's props live in exactly one place. Every control is a KEYED
  // sibling of the strip body, so the compact⇄card morph re-styles and
  // reorders them via classes without ever moving them in the tree: the DOM
  // nodes (and the textarea's focus) survive the morph.
  const chipTone = isCard
    ? "border border-transparent hover:border-border"
    : "border border-border hover:border-text-secondary";
  const textareaEl = (
    <textarea
      key="ta"
      ref={textareaRef}
      // rows={1} on both pointers — the compact state supersedes the old
      // fine-pointer 2-row floor. The auto-grow floor follows the rows
      // attribute by construction (the `height = "auto"` measurement resolves
      // to it); the shared autogrow bound (lib/textarea-autogrow.ts) caps
      // growth.
      rows={1}
      value={text}
      // A user edit ends any recall walk — the visible text is now
      // composition, not a recalled entry, so ↑ returns to meaning cursor
      // movement. Recall itself writes through `setComposeText` (never
      // this handler), so a recalled entry does not end its own walk.
      onChange={(e) => {
        endRecall();
        setText(e.target.value);
      }}
      onKeyDown={onKeyDown}
      // Publish focus for the bottom bar's coarse-pointer hide (the
      // module-store seam, 260814-ink6); unmount clears the flag. Also the
      // focus-memory write seam (spec right-panel.md § The code lens):
      // focusing the textarea records `compose` for the window it targets —
      // TERMINAL-TARGET mode only (a selection broadcast has no window
      // identity; its draft key is `selection:…`, not a window), and only
      // when the live target matches the route window (`focusMemoryWindow`)
      // so a restore-driven focus during the window-switch commit can't
      // cross-write the previous window's key.
      onFocus={() => {
        setComposeStripFocused(true);
        setTextFocused(true);
        if (
          !isSelectionTarget &&
          focused &&
          focused.server === focusMemoryWindow?.server &&
          focused.windowId === focusMemoryWindow?.windowId
        ) {
          recordFocus(focusMemoryKey(focused.server, focused.windowId), "compose");
        }
      }}
      onBlur={() => {
        setComposeStripFocused(false);
        setTextFocused(false);
        // The fine-pointer latch releases ONLY here: blur while empty with no
        // attachments. Erasing mid-edit and removing the last attachment
        // while blurred both hold the card (no snap, no xterm refit).
        if (text === "" && files.length === 0) setLatchedKey(null);
      }}
      disabled={!hasTarget}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      // Truthful hint, per target mode: on a terminal target Enter
      // transmits the text to the pane (insert-line) and clears the draft,
      // so the mobile action key says "send"; in selection broadcast Enter
      // is a local newline (submit is the Cmd/Ctrl+Enter chord), so it says
      // "enter" rather than promising a send the key does not perform.
      enterKeyHint={isSelectionTarget ? "enter" : "send"}
      aria-label={
        isSelectionTarget
          ? "Compose prompt to send to selection"
          : "Compose text to send to terminal"
      }
      placeholder={placeholder}
      data-testid="compose-strip-input"
      // In the card the textarea is full-width, transparent, and borderless —
      // the card wrapper carries the chrome (including the focused green
      // border via focus-within). In the compact row it wears its own border
      // and takes the flexible middle slot; the coarse sizing (py-[9px] +
      // the 16px text-xs line + 2px borders = 36px, floored by min-h-[36px])
      // keeps the one-line box flush with its flanking chips.
      className={
        isCard
          ? "w-full min-w-0 min-h-0 resize-none border-0 bg-transparent px-1 py-1 font-mono text-xs text-text-primary placeholder:text-text-secondary outline-none disabled:opacity-40"
          : `order-3 flex-1 min-w-0 resize-none rounded border border-border bg-bg-card px-2 font-mono text-xs text-text-primary placeholder:text-text-secondary ${INPUT_FOCUS} disabled:opacity-40 ${coarsePointer ? "min-h-[36px] py-[9px]" : "min-h-0 py-1.5"}`
      }
    />
  );
  const fileInput = (
    <input
      key="file"
      ref={uploadInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={(e) => {
        if (e.target.files && e.target.files.length > 0) {
          void handleUpload(e.target.files);
          e.target.value = "";
        }
      }}
    />
  );
  // While an upload is in flight the chip itself goes busy (pulsing glyph +
  // disabled) and carries the live status — the old standalone `Uploading…`
  // text stole row width exactly when an upload appends path lines.
  const attachChip = (
    <button
      key="attach"
      type="button"
      aria-label="Upload file"
      disabled={!canUpload || uploading}
      aria-busy={uploading || undefined}
      onMouseDown={preventFocusSteal}
      onClick={() => uploadInputRef.current?.click()}
      className={`rk-glint shrink-0 rounded px-2 py-1.5 text-xs text-text-secondary transition-colors disabled:opacity-50 coarse:min-h-[36px] ${chipTone} ${isCard ? "" : "order-1"}`}
    >
      <span aria-hidden="true" className={uploading ? "animate-pulse" : undefined}>{"📎"}</span>
      {uploading && (
        <span role="status" data-testid="compose-strip-uploading" className="sr-only">
          Uploading…
        </span>
      )}
    </button>
  );
  const historyChip = (
    <button
      key="history"
      ref={setHistoryAnchor}
      type="button"
      aria-label="Recall sent text"
      aria-expanded={historyOpen}
      aria-controls={historyOpen ? "compose-history-list" : undefined}
      onMouseDown={preventFocusSteal}
      onClick={() => setHistoryOpen((open) => !open)}
      data-testid="compose-strip-history"
      className={controlClass({
        variant: "toggle",
        base: "rk-glint shrink-0 rounded px-2 py-1.5 text-xs transition-colors coarse:min-h-[36px] coarse:min-w-[36px]",
        rest: `text-text-secondary ${chipTone}`,
        onBorder: true,
        pressed: historyOpen,
      })}
    >
      {/* text-lg matches the attach chip's emoji weight — the button box is
          size-fixed, so only the glyph scales. */}
      <span aria-hidden="true" className="text-lg leading-none">↺</span>
    </button>
  );
  // The `a|` close affordance — fine pointers only (dropped on coarse, where
  // the bottom-bar `a▏` chip, the `Compose: Toggle` palette action, and
  // ⌘I/⇧Ctrl+E remain the closers). With the header folded at the fine
  // in-tile dock this is the sole on-strip closer there. Fires the exact same
  // `toggleComposeStrip` path as the header × and the chord.
  const closeChip = (
    <Tip label="Close compose strip" placement="top">
      <button
        key="close"
        type="button"
        aria-label="Close compose strip (a|)"
        onMouseDown={preventFocusSteal}
        onClick={toggleComposeStrip}
        data-testid="compose-strip-a-close"
        className={`rk-glint shrink-0 rounded px-2 py-1.5 text-xs text-text-secondary transition-colors coarse:min-h-[36px] ${chipTone} ${isCard ? "" : "order-2"}`}
      >
        <span aria-hidden="true">{"a|"}</span>
      </button>
    </Tip>
  );
  // The coarse-only ⏎ chip — the Shift+Enter local-newline path mobile
  // keyboards cannot produce. It renders only in the card with a non-empty
  // composer (hidden while empty; the compact row has no slot for it) and
  // stays hidden in selection broadcast, where the broadcast Enter policy already
  // makes plain Enter a local newline. No Tip — tips never render on the
  // coarse pointers this chip targets.
  const newlineChip = (
    <button
      key="newline"
      type="button"
      aria-label="Insert newline"
      disabled={!hasTarget}
      onMouseDown={preventFocusSteal}
      onClick={insertLocalNewline}
      data-testid="compose-strip-newline"
      className={`rk-glint shrink-0 rounded px-2 py-1.5 text-xs leading-none text-text-secondary transition-colors disabled:opacity-50 coarse:min-h-[36px] coarse:min-w-[36px] ${chipTone}`}
    >
      <span aria-hidden="true" className="text-lg leading-none">{"⏎"}</span>
    </button>
  );
  // Insert follows Enter (verified insert-line, clears the draft); the
  // byte-exact raw insert is chord-only now, kept discoverable in the tip
  // label (Alt+Enter). Fine pointers only, card form only — hidden in the
  // compact row, where it would be disabled anyway while empty.
  const insertChip = (
    <Tip label="Insert line (Alt+Enter: raw insert)" kbd="Enter" placement="top">
      <button
        key="insert"
        type="button"
        aria-label="Insert line"
        disabled={!canInsert}
        onMouseDown={preventFocusSteal}
        onClick={() => send("insert-line")}
        data-testid="compose-strip-insert"
        className={`rk-glint shrink-0 rounded px-2 py-1.5 text-xs text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed coarse:min-h-[36px] ml-auto ${chipTone}`}
      >
        Insert
      </button>
    </Tip>
  );
  // Send mirrors its chord including the empty bare-`\r` case, so it is
  // enabled whenever a target exists — in the neutral secondary face while
  // the composer is empty (see the enablement comment above). The coarse
  // "Ctrl/⌘+Enter" title branch is gone: tips never render on coarse
  // pointers, so only the fine-pointer shortcut is ever shown.
  const sendChip = (
    <Tip label="Send" kbd={composeSubmitKeycap()} placement="top">
      <button
        key="send"
        type="button"
        aria-label="Send text"
        disabled={!canSubmit}
        onMouseDown={preventFocusSteal}
        onClick={() => send("submit")}
        data-testid="compose-strip-send"
        className={controlClass({
          variant: "toggle",
          base: `rk-glint shrink-0 rounded border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed coarse:min-h-[36px] ${isCard ? (coarsePointer ? "ml-auto" : "") : "order-4"}`,
          pressed: !(composerEmpty && !isSelectionTarget),
        })}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </Tip>
  );

  // The header row (target label + × close) renders only where `showHeader`
  // says it carries signal. It is a KEYED sibling of the strip body so the
  // header appearing or disappearing never remounts the body (and with it
  // the focused textarea).
  const headerEl = (
    <div key="header" className="flex items-center gap-2 text-xs text-text-secondary">
      <span aria-hidden="true">{"→"}</span>
      <span data-testid="compose-strip-target" className={hasTarget ? "text-text-primary" : "italic"}>
        {hasTarget ? targetName : "no target"}
      </span>
      <button
        type="button"
        aria-label="Close compose strip"
        title="Close compose strip"
        onMouseDown={preventFocusSteal}
        onClick={toggleComposeStrip}
        data-testid="compose-strip-close"
        className="rk-glint ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-xs leading-none text-text-secondary transition-colors hover:border-text-secondary coarse:min-h-[36px] coarse:min-w-[36px]"
      >
        ×
      </button>
    </div>
  );

  // Attachment previews — the card's first child, above the textarea. They
  // never render in compact form: attachments force the card on both
  // pointers, so this row and the compact state are mutually exclusive.
  const previewsEl = (
    <div key="previews" className="flex w-full gap-1.5 overflow-x-auto" data-testid="compose-strip-previews">
      {files.map((uf, i) => {
        const isImage = uf.file.type.startsWith("image/");
        return (
          <div key={`${uf.path}-${i}`} className="relative shrink-0 group">
            {isImage ? (
              <img
                src={getBlobUrl(uf.file)}
                alt={uf.file.name}
                className="h-[40px] w-auto rounded border border-border object-cover"
              />
            ) : (
              <div className="h-[40px] px-2 flex items-center rounded border border-border bg-bg-primary">
                <span className="text-[10px] text-text-secondary max-w-[80px] truncate">
                  {uf.file.name}
                </span>
              </div>
            )}
            <button
              type="button"
              aria-label={`Remove ${uf.file.name}`}
              onMouseDown={preventFocusSteal}
              onClick={() => removeFile(i)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-bg-primary border border-border text-text-secondary text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-500 hover:border-red-500 transition-all"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );

  return (
    // `data-compose-strip` is a PRODUCTION marker (unlike the test id): the
    // tty tile's pointerdown focus-memory write reads it to tell a press on
    // the docked strip (strip interaction — its textarea records `compose`)
    // apart from a press on the terminal (records `tty`).
    <div data-testid="compose-strip" data-compose-strip>
      {/* The inner wrapper carries only the dock seam chrome; the outer
          element stays an unstyled box so the row-growth/refit mechanic (at
          the footer dock the `auto` row grows and the terminal's
          ResizeObserver refits; in-tile the tile's flex column does the same)
          works identically at both docks. */}
      <div
        className="border-t border-border bg-bg-primary px-1.5 py-1.5 flex flex-col gap-1"
        data-testid="compose-strip-inner"
      >
      {showHeader && headerEl}

      {/* The chat-lane context chip — only on the operator window's route
          with a `?from=` subject attached (operatorChatServer is null
          everywhere else); dismissal and the empty state are the chip's own.
          The navigate prop makes the label the way back to the origin window
          (this mount only — the quake launcher chip stays inert). */}
      {operatorChatServer !== null && (
        <div className="flex items-center empty:hidden">
          <OperatorContextChip
            server={operatorChatServer}
            onNavigate={() => {
              const subject = chatChip.subject;
              if (!subject) return;
              void navigate({
                to: "/$server/$window",
                params: { server: subject.server, window: subject.windowId },
                search: {},
              });
            }}
          />
        </div>
      )}

      {/* One warm-tip cluster for the strip's buttons (260722-73al);
          placement `top` — the strip sits at the bottom of the screen. */}
      {/* ONE structure for both forms — the card/compact morph re-styles and
          reorders the same keyed siblings (never a second branch), so no
          control remounts and the textarea keeps focus across the morph.
          Card: a bordered, rounded box — full-width previews, then the
          full-width transparent textarea, then the chip row (the `w-full`
          rows wrap above the chips under `flex-wrap`). Compact: the same
          siblings as a single plain row — 📎 (· a| on fine) · textarea
          (flex-1) · Send. */}
      <TipGroup>
      <div
        key="body"
        data-testid={isCard ? "compose-strip-card" : undefined}
        className={
          isCard
            ? "flex flex-wrap items-center gap-1.5 rounded border border-border bg-bg-card px-1.5 py-1 focus-within:border-accent-green"
            : "flex items-center gap-1.5"
        }
      >
        {isCard && files.length > 0 && previewsEl}
        {fileInput}
        {textareaEl}
        {attachChip}
        {!coarsePointer && closeChip}
        {coarsePointer && isCard && !isSelectionTarget && !composerEmpty && newlineChip}
        {isCard && sentHistory.length > 0 && historyChip}
        {!coarsePointer && isCard && insertChip}
        {sendChip}
      </div>
      </TipGroup>
      </div>
      {historyOpen && historyAnchor !== null && sentHistory.length > 0 && (
        <ComposeHistoryFlyout
          anchor={historyAnchor}
          entries={sentHistory}
          onSelect={selectHistoryEntry}
          onClose={closeHistory}
        />
      )}
    </div>
  );
}
