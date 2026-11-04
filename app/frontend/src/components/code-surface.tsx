import { useEffect, useRef, useState } from "react";
import type { CodeBridgeResult, CodeServerRestartResult } from "@/api/client";
import {
  CODE_BOOT_RESCUE_RECHECK_MS,
  CODE_BOOT_RESCUE_WAIT_MS,
  decideRescue,
  isWorkspaceSrc,
  newerThanBaseline,
} from "@/lib/code-boot-rescue";

/**
 * CodeSurface — the renderer for the `code` lens AND the panel's CODE surface
 * (change 260811-k3vp-right-panel-code-lens; the daemon-managed stable route
 * 260811-a2bo; spec docs/specs/right-panel.md § The code lens).
 *
 * Deliberately a NEW lean component, NOT `IframeWindow`: the code-server URL is
 * fully DERIVED (`/code/?workspace=<tab-keyed workspace file>`, with
 * `/code/?folder=…` as the degrade form), so the URL bar — `@rk_win_url`
 * substrate state — is meaningless here, and IframeWindow reuse would drag in
 * inapplicable chrome. It is exactly an iframe plus the pending and
 * not-running states.
 *
 * - **Availability vs reachability**: availability (gitRoot derived — the git
 *   toplevel, falling back to the raw cwd outside any repo; the port is always
 *   resolvable by convention since a2bo) is computed upstream — this
 *   component renders only when the lens/surface was resolved. REACHABILITY
 *   selects the content: a reachable code-server renders the iframe once the
 *   workspace src is resolved (the terse pending state until then); an
 *   unreachable one renders the terse monospace empty state instead of a dead
 *   iframe.
 * - **Relative path discipline**: `codeServerSrc` returns the STABLE
 *   root-relative path `/code/?folder=…` and never composes an absolute origin
 *   — the same convention `toProxySrc` (iframe-window.tsx) follows, so the
 *   embed works behind any origin or reverse proxy. The pathname is workspace-
 *   state identity (code-server keys IndexedDB by it); it never carries the
 *   port, so it can never change.
 * - **Chord reclaim (keyboard-capture spike, intake §5)**: same-origin makes an
 *   escape hatch possible — a capture-phase `keydown` listener on the iframe's
 *   `contentDocument` intercepts run-kit's registry chords BEFORE the embedded
 *   app's keybinding service sees them and re-dispatches them to the parent
 *   window. The predicate is INJECTED (`shouldReclaimChord`, built in app.tsx
 *   from the keybinding registry) so this component stays free of the registry
 *   import graph, and only registry chords are reclaimed — the embedded app's
 *   own Ctrl/⌘ bindings keep working. Failure mode is benign: a cross-origin
 *   or pre-load frame simply skips the attach (click-out remains the escape).
 * - **Latched folder (260813-if5d)**: `gitRoot` arrives already LATCHED (app.tsx
 *   substitutes it) — this component's contribution is the two halves the latch
 *   needs at the iframe itself. (a) The `src` is computed once per MOUNT
 *   GENERATION, never reactively from the prop: re-setting `src` on a live frame
 *   re-navigates it even to the URL it is already at, which would destroy the
 *   editor state the latch exists to protect (spec P3 — hide, never unmount).
 *   (b) The same-origin `load` seam reports where the EDITOR navigated itself
 *   (File > Open Folder → a full workbench navigation to `/code/?folder=…`) via
 *   `onFolderNavigated`, so the latch follows the editor. Derivation seeds the
 *   latch exactly once; thereafter the editor or an explicit user verb moves
 *   it, never the terminal.
 * - **Sanctioned parent re-navigations — two mechanisms, four triggers**: a
 *   live frame is parent-navigated ONLY by (a) the nonce-keyed `followSrc`
 *   re-navigation — triggered by the editor's own File > Open Folder OR the
 *   header's Follow terminal verb — and (b) `contentWindow.location.reload()`
 *   — triggered by the marker-gated first-boot rescue OR the header's Reload
 *   editor verb (the `reloadNonce` prop). Both keep the frame's URL and tab
 *   identity; neither writes `src`; nothing else may parent-navigate a live
 *   frame.
 * - **First-boot rescue**: a never-cached `?workspace=` boot can load zero
 *   folders; the bridge extension reports that failure itself by writing an
 *   empty-boot marker. When the `fetchBridgeStatus` seam is injected, a
 *   `?workspace=` mount generation reads the bridge status once at src
 *   adoption (baseline: both the host-record and marker stamps), once at
 *   `CODE_BOOT_RESCUE_WAIT_MS` after the first `load` (verdict), and at most
 *   once more at `CODE_BOOT_RESCUE_RECHECK_MS` later when neither stamp has
 *   moved (the re-check). Only a marker strictly NEWER than its baseline —
 *   the extension positively reporting THIS boot saw zero folders — fires
 *   `contentWindow.location.reload()`, at most once per generation and never
 *   a `src` write; the absence of a host record is never a trigger, and a
 *   NEWER host record is the good-boot confirmation that settles the
 *   generation early. Not-installed and unavailable statuses fail closed (no
 *   reload, one warning per generation); `?folder=` mounts are never rescued.
 */

/**
 * The relative URL for the window's code-server folder, via the stable /code/
 * route (260811-a2bo — the code-server port is a server-side implementation
 * detail and never appears here). code-server restores per-folder state from
 * the `?folder=` param, and keys browser-side workspace state by the proxy
 * PATHNAME — /code/ is deliberately constant so the state survives restarts.
 */
export function codeServerSrc(gitRoot: string): string {
  return `/code/?folder=${encodeURIComponent(gitRoot)}`;
}

/**
 * The relative URL for the window's tab-keyed workspace file, via the same
 * stable /code/ route and the same relative-path discipline as
 * `codeServerSrc` — never an origin, never a port, and the pathname stays
 * constant (code-server keys browser-side workspace state by it). The
 * `?workspace=` form is the PRIMARY mount src; `?folder=` survives as the
 * degrade path and the editor's own File > Open Folder navigation.
 */
export function codeServerWorkspaceSrc(workspacePath: string): string {
  return `/code/?workspace=${encodeURIComponent(workspacePath)}`;
}

interface CodeSurfaceProps {
  /** The window's LATCHED code folder (absolute path) — the comparison
   *  baseline for the load-seam report below ("the folder we believe the
   *  editor is in"). Not the mount src: the frame's URL arrives via
   *  `workspaceSrc`. */
  gitRoot: string;
  /** The iframe's mount src: the tab-keyed `?workspace=` URL once the
   *  derivation GET has resolved, or the `?folder=` degrade after a failed
   *  one. `null` ⇒ pending — the tile renders the pending state instead of
   *  the iframe. Read at iframe MOUNT only (first non-null value per mount
   *  generation); a later change never re-navigates a live frame — the
   *  `followSrc` seam is the one exception. */
  workspaceSrc: string | null;
  /** Follow-the-editor override (the one sanctioned parent re-navigation):
   *  after the editor navigated ITSELF to a new folder (File > Open Folder),
   *  the parent re-derived the workspace URL and hands it down with a fresh
   *  nonce. A nonce not seen before overrides the mount-generation src ref
   *  exactly once; an already-seen nonce (every ordinary payload tick) never
   *  touches a live frame. Absent ⇒ no override. */
  followSrc?: { src: string; nonce: number } | null;
  /** User-initiated reload (the header's Reload editor verb): a nonce not seen
   *  before by THIS instance runs one `contentWindow.location.reload()` —
   *  the rescue's seam — which keeps the frame's URL and tab identity and
   *  never writes `src`. The value present at mount is pre-seen (a mount IS a
   *  fresh boot); an already-seen nonce (every ordinary re-render) is inert.
   *  Absent ⇒ no reload path. */
  reloadNonce?: number;
  /** The host's TTL-cached code-server reachability probe result. */
  reachable: boolean;
  /** The not-running state's Restart code-server action (kill + re-ensure,
   *  POST /api/code-server/restart). Absent ⇒ no button. */
  onRestart?: () => Promise<CodeServerRestartResult>;
  /** Keyboard spike: return true when the event matches a run-kit registry
   *  chord that should be reclaimed from the iframe. Absent ⇒ no reclaim. */
  shouldReclaimChord?: (e: KeyboardEvent) => boolean;
  /** Tile-focus seam (260812-wfic R2): fired when a keydown/pointerdown
   *  arrives inside the same-origin contentDocument — editor interaction
   *  counts as tile focus. No parent-document event fires for in-frame
   *  interaction (clicks stay in the frame's document; focus entering it
   *  fires no focusin in the parent), so this seam is the tile wrapper's
   *  only signal. Absent ⇒ no reporting. */
  onInteract?: () => void;
  /** Steal-guard seam (spec right-panel.md § The code lens): fired when focus
   *  lands anywhere inside the frame's document (a capture-phase `focusin` on
   *  the contentDocument) — the only signal the workbench's script `focus()`
   *  grab produces, since it fires NO parent-side event on the iframe element.
   *  The handler decides: return `true` when it reverted the grab (guard armed
   *  + remembered kind ≠ `code`), `false` when the focus stands (guard
   *  disarmed, or the remembered kind IS `code` — then the grab IS the
   *  restore). Absent ⇒ no reporting. */
  onProgrammaticFocus?: () => boolean;
  /** Follow-the-editor seam (260813-if5d R3): fired with the folder the EDITOR
   *  navigated itself to (File > Open Folder), read from the same-origin frame's
   *  `?folder=` on each `load`. Only fired for a present, non-empty folder that
   *  differs from `gitRoot` — the parent writes it to the window's latch. Absent
   *  ⇒ no reporting. */
  onFolderNavigated?: (folder: string) => void;
  /** First-boot rescue's status read (built in app.tsx, threaded through
   *  SurfaceLayout): one call at a `?workspace=` mount generation's src
   *  adoption (baseline), one at the rescue wait's expiry (verdict), and at
   *  most one re-check when neither stamp moved. The injected fetcher keeps
   *  this component free of the API client import graph. Absent ⇒ no rescue
   *  runs (no fetches, no timer). */
  fetchBridgeStatus?: () => Promise<CodeBridgeResult>;
}

export function CodeSurface({
  gitRoot,
  workspaceSrc,
  followSrc,
  reloadNonce,
  reachable,
  onRestart,
  shouldReclaimChord,
  onInteract,
  onFolderNavigated,
  onProgrammaticFocus,
  fetchBridgeStatus,
}: CodeSurfaceProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // The not-running state's restart feedback: "restarting…" while the POST is
  // in flight, then the outcome/error line. Cleared on every reachability flip
  // so a later outage starts fresh.
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    setRestartNote(null);
    setRestarting(false);
  }, [reachable]);
  const reclaimRef = useRef(shouldReclaimChord);
  reclaimRef.current = shouldReclaimChord;
  const interactRef = useRef(onInteract);
  interactRef.current = onInteract;
  const folderNavigatedRef = useRef(onFolderNavigated);
  folderNavigatedRef.current = onFolderNavigated;
  const programmaticFocusRef = useRef(onProgrammaticFocus);
  programmaticFocusRef.current = onProgrammaticFocus;
  const fetchBridgeRef = useRef(fetchBridgeStatus);
  fetchBridgeRef.current = fetchBridgeStatus;
  // The comparison baseline for the load-event report below, read through a ref
  // because the listener outlives the render that installed it. It tracks the
  // latch, which after seeding tracks the editor — so it is exactly "the folder
  // we believe the editor is in".
  const gitRootRef = useRef(gitRoot);
  gitRootRef.current = gitRoot;

  // P3: one `src` per iframe MOUNT GENERATION. The iframe mounts only while
  // `reachable` AND the workspace src has resolved (non-null) — a reachability
  // false→true flip or a frame eviction + re-creation (the frame LRU's
  // overflow/kill/root-divergence drops) boots at the CURRENT src
  // (fresh workbench, right workspace) while a mounted frame is never
  // parent-navigated: a `src` React re-renders IS a navigation, even to the
  // URL the frame already sits at. A window switch alone is NOT a generation
  // boundary — the retained frame re-shows untouched (its `reachable`/`src`
  // props don't change, so the effects below never re-arm on show/hide).
  // Held in a ref, not `useMemo`: a memo
  // cache is a performance hint React may drop, and dropping this one would
  // reload the editor out from under the user. The pending → resolved
  // transition adopts the first non-null src of the generation; any later
  // change is ignored by the live frame.
  const srcRef = useRef<{ mountGen: boolean; src: string | null }>({
    mountGen: reachable,
    src: null,
  });
  if (srcRef.current.mountGen !== reachable) {
    srcRef.current = { mountGen: reachable, src: null };
  }
  if (srcRef.current.src === null && workspaceSrc !== null) {
    srcRef.current.src = workspaceSrc;
  }
  // The follow rule's one sanctioned parent navigation: a fresh nonce
  // overrides the ref exactly once (the editor already moved itself; the
  // parent only lands it on the derived workspace URL). The seen-nonce ref is
  // deliberately NOT reset by a mount-generation flip — a remount adopts the
  // current `workspaceSrc`, which the follow fetch already advanced.
  const followNonceRef = useRef<number | null>(null);
  if (followSrc && followSrc.nonce !== followNonceRef.current) {
    followNonceRef.current = followSrc.nonce;
    srcRef.current.src = followSrc.src;
  }
  const src = srcRef.current.src;

  // The Reload editor verb's seam (the second sanctioned re-navigation
  // mechanism): an unseen nonce reloads the live frame exactly once via
  // `contentWindow.location.reload()` — the rescue's try/catch posture, never
  // a `src` write. The ref pre-sees the MOUNT-TIME value (a mount is a fresh
  // boot, so nothing pending could apply to it), which is also what keeps a
  // retained frame that later becomes active — or a frame created after
  // another window's verb click — from ever replaying a nonce. A nonce
  // arriving while no iframe is mounted (pending or unreachable) is recorded
  // as seen and is a no-op: there is no frame to reload, and the next mount
  // boots fresh anyway. The reload fires no new mount generation (src
  // untouched): a settled rescue generation ignores the extra `load`, an
  // unsettled one at most re-arms its existing wait timer, and the
  // chord-reclaim/folder-report listeners re-attach on that `load` exactly as
  // they do after the rescue's reload.
  const reloadNonceRef = useRef(reloadNonce);
  useEffect(() => {
    if (reloadNonce === undefined || reloadNonce === reloadNonceRef.current) return;
    reloadNonceRef.current = reloadNonce;
    if (!reachable || srcRef.current.src === null) return;
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      /* cross-origin or pre-load frame — skip silently */
    }
  }, [reloadNonce, reachable]);

  // Chord-reclaim spike: attach a capture-phase keydown listener to the
  // iframe's same-origin contentDocument after every load (each navigation
  // replaces the document). A matching chord is stopped before the embedded
  // app's keybinding service sees it and re-dispatched on the PARENT document
  // (bubbling reaches both the document-level listeners — the command
  // palette's chord — and the window-level ones — the keybinding
  // dispatcher). Cleanup removes the listener from the document it was
  // attached to. The
  // capture-phase keydown/pointerdown pair ALSO feeds `onInteract`
  // (260812-wfic): any in-editor interaction reports tile focus. The
  // capture-phase `focusin` feeds `onProgrammaticFocus` (the steal guard) —
  // it is attached to the frame's document because a script `focus()` grab
  // fires no parent-side event on the iframe element. Keyed on `reachable`
  // AND `src`: the iframe only MOUNTS once reachable with a resolved src (the
  // pending/empty states render no iframe), so the pending → resolved
  // transition and any reachability flip re-run this effect against the fresh
  // iframe.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (
      !iframe ||
      (!reclaimRef.current &&
        !interactRef.current &&
        !folderNavigatedRef.current &&
        !programmaticFocusRef.current)
    ) {
      return;
    }
    let attachedDoc: Document | null = null;
    const onKey = (e: KeyboardEvent) => {
      interactRef.current?.();
      const reclaim = reclaimRef.current;
      if (!reclaim?.(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          bubbles: true,
        }),
      );
    };
    const onPointer = () => interactRef.current?.();
    // Steal guard: the workbench's load-time grab is an in-frame script
    // `focus()` — in Chromium it re-points the focus chain (the parent's
    // `document.activeElement` becomes the iframe) but fires NO parent-side
    // event on the iframe element, so the ONLY observable is a `focusin` on
    // the frame's own document. The prop decides whether to revert (`true`) —
    // this component only reports; it knows nothing about the focus-memory
    // module. A genuine click-in produces `pointerdown` (→ `onInteract`, which
    // disarms the guard) BEFORE this focusin, so real editor focus reports
    // against an already-disarmed guard and is never reverted.
    const onFrameFocus = () => {
      programmaticFocusRef.current?.();
    };
    const attach = () => {
      try {
        // Cross-origin frames throw on contentDocument access — the /proxy/
        // embed is same-origin by design, so a throw means "nothing to do".
        // A navigation replaces the document; the listener on the discarded
        // one dies with it, and we re-attach to the fresh document.
        const doc = iframe.contentDocument;
        if (doc && doc !== attachedDoc) {
          doc.addEventListener("keydown", onKey, true);
          doc.addEventListener("pointerdown", onPointer, true);
          doc.addEventListener("focusin", onFrameFocus, true);
          attachedDoc = doc;
        }
      } catch {
        /* noop — spike stays silent */
      }
    };
    // Follow rule (if5d R3): a workbench navigation replaces the frame's
    // document, so every load is a chance the EDITOR moved itself to another
    // folder (File > Open Folder). Same try/catch posture as the attach above —
    // a cross-origin or pre-load frame silently reports nothing.
    const reportFolder = () => {
      try {
        const search = iframe.contentWindow?.location.search;
        if (!search) return;
        // `URLSearchParams` decodes, so this compares decoded paths against the
        // decoded prop — `encodeURIComponent` round-trips make raw-string
        // comparison flaky.
        const folder = new URLSearchParams(search).get("folder");
        if (!folder || folder === gitRootRef.current) return;
        folderNavigatedRef.current?.(folder);
      } catch {
        /* noop — cross-origin or pre-load frame */
      }
    };
    const onLoad = () => {
      attach();
      reportFolder();
    };
    attach();
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      try {
        attachedDoc?.removeEventListener("keydown", onKey, true);
        attachedDoc?.removeEventListener("pointerdown", onPointer, true);
        attachedDoc?.removeEventListener("focusin", onFrameFocus, true);
      } catch {
        /* noop */
      }
    };
  }, [reachable, src]);

  // First-boot rescue: per mount generation (this effect's [reachable, src]
  // keying re-runs on every generation boundary — the reachable flip, an
  // eviction + re-creation, or a followSrc nonce adoption — never a window
  // switch alone, which keeps the retained frame's props unchanged), a
  // `?workspace=`
  // mount gets at most THREE status reads and at most ONE reload. The
  // baseline read at src adoption captures BOTH stamps (host record and
  // empty-boot marker); the first `load` arms the wait timer; at its expiry a
  // verdict read decides, and only when NEITHER stamp moved does exactly one
  // re-check timer arm for CODE_BOOT_RESCUE_RECHECK_MS later. A "reload"
  // verdict re-navigates via contentWindow.location.reload() — a reload keeps
  // the `?workspace=` URL and tab identity, so the per-generation src ref
  // stays untouched. `?folder=` mounts never enter here (a folder-opened
  // bridge host writes no tab identity, so the signal can never exist), and
  // without the injected fetcher the generation is inert (no reads, no
  // timer). Cleanup clears a pending timer and discards in-flight reads, so
  // an unmounted or superseded generation can neither reload nor warn.
  useEffect(() => {
    const fetcher = fetchBridgeRef.current;
    const iframe = iframeRef.current;
    if (!fetcher || !iframe || !reachable || src === null || !isWorkspaceSrc(src)) return;
    const gen = {
      baselineStartedAt: null as string | null,
      baselineEmptyBootAt: null as string | null,
      settled: false,
      warned: false,
      verdicts: 0,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    let alive = true;
    fetcher()
      .then((res) => {
        // An unavailable baseline leaves both stamps null, and null is NOT
        // confirmable (newerThanBaseline fails closed) — an unseen baseline
        // must never license a reload.
        if (alive && res.status === "ok") {
          gen.baselineStartedAt = res.startedAt;
          gen.baselineEmptyBootAt = res.emptyBootAt;
        }
      })
      .catch(() => {
        /* an injected fetcher may throw; a failed baseline reads as none */
      });
    const verdict = () => {
      gen.timer = null;
      const decide = fetchBridgeRef.current;
      // Settle BEFORE the verdict fetch: `arm`'s guard reads `settled`, and
      // leaving it false until the promise resolves would let a second
      // `load` during a slow GET arm another timer — an extra verdict read
      // and a possible double reload.
      gen.settled = true;
      if (!decide) return;
      gen.verdicts += 1;
      decide()
        .then((res) => {
          if (!alive) return;
          const ok = res.status === "ok" ? res : null;
          // A newer host record is the positive good-boot confirmation: the
          // boot registered the bridge, hence loaded the folder. It settles
          // the generation (no re-check) and OUTRANKS a newer marker — a
          // folder that arrived late raced the read, and a live tab-keyed
          // record proves the frame works.
          if (ok !== null && newerThanBaseline(gen.baselineStartedAt, ok.startedAt)) return;
          const decision = decideRescue({
            baselineEmptyBootAt: gen.baselineEmptyBootAt,
            emptyBootAt: ok !== null ? ok.emptyBootAt : null,
            installed: ok !== null ? ok.installed : null,
            isWorkspaceMount: true,
          });
          if (decision === "reload") {
            try {
              iframe.contentWindow?.location.reload();
            } catch {
              /* cross-origin or pre-load frame — skip */
            }
            return;
          }
          if (decision === "skip-not-installed") {
            if (!gen.warned) {
              gen.warned = true;
              console.warn(
                "code bridge extension not installed — first-boot rescue disabled; run `rk code-server install`",
              );
            }
            return;
          }
          // Neither stamp moved. The marker is written by the same slow
          // extension-host activation as the record, so a signal-less FIRST
          // verdict gets exactly one re-check; the second verdict settles the
          // generation whatever it finds.
          if (gen.verdicts === 1) {
            gen.settled = false;
            gen.timer = setTimeout(verdict, CODE_BOOT_RESCUE_RECHECK_MS);
          }
        })
        .catch(() => {
          /* a throwing injected fetcher fails closed — the generation is
             already settled, so it never retries into another decision */
        });
    };
    const arm = () => {
      if (!alive || gen.settled || gen.timer !== null) return;
      gen.timer = setTimeout(verdict, CODE_BOOT_RESCUE_WAIT_MS);
    };
    iframe.addEventListener("load", arm);
    return () => {
      alive = false;
      iframe.removeEventListener("load", arm);
      if (gen.timer !== null) clearTimeout(gen.timer);
    };
  }, [reachable, src]);

  if (!reachable) {
    return (
      <div
        data-testid="code-surface-empty"
        className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-text-secondary text-xs font-mono select-none"
      >
        <div>code-server not running — check rk doctor</div>
        {onRestart ? (
          <button
            type="button"
            className="border border-border rounded px-2 py-1 hover:bg-bg-inset disabled:opacity-50"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              setRestartNote(null);
              onRestart()
                .then((r) => {
                  // "started" stays "restarting…": the port is serving, so the
                  // reachability probe flips this state away within its TTL.
                  if (r.status === "started") return;
                  setRestarting(false);
                  if (r.status === "installing")
                    setRestartNote("installing code-server — the editor appears when the download finishes");
                  else if (r.status === "external")
                    setRestartNote("port already serving an externally managed code-server");
                })
                .catch((err: Error) => {
                  setRestartNote(err.message || "restart failed");
                  setRestarting(false);
                });
            }}
          >
            {restarting ? "restarting…" : "Restart code-server"}
          </button>
        ) : null}
        {restartNote ? <div data-testid="code-surface-restart-note">{restartNote}</div> : null}
      </div>
    );
  }

  // Reachable but the workspace path is not resolved yet (derivation GET in
  // flight, or a no-root answer awaiting the next payload change): the terse
  // pending state, same chrome as the empty state. Reachability keeps
  // precedence — an unreachable host never renders pending.
  if (src === null) {
    return (
      <div
        data-testid="code-surface-pending"
        className="flex-1 min-h-0 flex items-center justify-center text-text-secondary text-xs font-mono select-none"
      >
        opening…
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={src}
      className="flex-1 w-full border-0"
      title="Code editor"
      // Same sandbox as IframeWindow, plus allow-downloads (without it VS Code
      // file downloads break) — the k3vp proxy-prerequisite set.
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
    />
  );
}
