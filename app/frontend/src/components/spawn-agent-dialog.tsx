import { useState, useEffect, useRef, useCallback } from "react";
import { spawnRiff, getRiffPresets, type RiffPreset, type RiffWhere } from "@/api/client";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { LogoSpinner } from "@/components/logo-spinner";
import { finalizeSafeName, toSafeWorktreeName } from "@/lib/names";

type SpawnAgentDialogProps = {
  /** The target tmux server — the server that OWNS the target session. Supplied
   *  explicitly (not read from the current route) so the sidebar can spawn into
   *  any listed session on any server (cross-server spawn); the client fns are
   *  per-call server-scoped via `withServer`. */
  server: string;
  /** The target session — the session the user invoked the spawn from. The new
   *  worktree/window is created in this session's repo. */
  session: string;
  /** Navigate to the freshly-spawned window (on the TARGET server). Wired to
   *  app.tsx's cross-server-aware navigation, so it inherits the window-switch
   *  transition when the target IS the current server. */
  onSpawned: (windowId: string) => void;
  onClose: () => void;
};

/** The default tier — matches the backend's "empty tier = default tier" and the
 *  mockup's `Agent [ default ▾ ]`. Selecting it yields a byte-identical launcher
 *  to the shipped (tier-less) path. */
const DEFAULT_TIER = "default";

/**
 * Compact dialog surfacing `rk riff` as a one-action web spawn (260713-sbk1,
 * extended to the full mockup in 260714-q9cg). Fields in mockup order:
 *
 *   Task      — free text, optional (empty = blank agent session)
 *   Preset    — dropdown, optional (only shown when the repo defines presets)
 *   Where     — radio: new worktree (default) | this checkout
 *   Worktree  — editable name, blank = auto-named; hidden when "this checkout"
 *   Agent     — tier dropdown (built-ins ∪ repo agent.tiers), default = "default"
 *
 * The title carries the target session (`Spawn agent in {session}`). Enter
 * submits from any field. While the synchronous spawn runs it shows an
 * indeterminate worktree → window → agent pipeline label and disables
 * double-submit; a 400/500 renders in-dialog (nothing was created on a 400) and
 * the dialog stays open for correction. On success it closes and navigates to
 * the new window (guarding a falsy best-effort windowId — SSE surfaces the row).
 *
 * Follows the shared dialog patterns (Dialog shell, `text-xs` field
 * labels, disabled-submit styling); the busy state deliberately shows no
 * per-step progression because the endpoint is synchronous and emits no
 * per-step events (intake assumption / plan A-9).
 */
export function SpawnAgentDialog({ server, session, onSpawned, onClose }: SpawnAgentDialogProps) {
  const [task, setTask] = useState("");
  const [preset, setPreset] = useState("");
  const [presets, setPresets] = useState<RiffPreset[]>([]);
  const [where, setWhere] = useState<RiffWhere>("worktree");
  const [worktreeName, setWorktreeName] = useState("");
  const [tier, setTier] = useState(DEFAULT_TIER);
  const [tiers, setTiers] = useState<string[]>([DEFAULT_TIER]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const taskRef = useRef<HTMLInputElement>(null);
  // Guards against a stale async setState after unmount (the dialog closes on
  // success/Escape while a fetch or spawn may still be in flight).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch presets + tiers on open — best-effort.
  //
  // The tier list is FAB-GATED at the backend (gsmu): a fab project returns the
  // built-ins ∪ its `agent.tiers`; a non-fab repo returns `tiers: []`. We mirror
  // the response verbatim so an empty list HIDES the Agent Tier field (a tier is
  // inert noise in a non-fab repo — every option resolves to the same launcher).
  //
  // The preflight-FAILURE branch is different (R5): on a rejected fetch the
  // repo's fab-ness is unknown, so we conservatively keep the built-in default
  // (field shown) rather than hide it — the shipped status quo, still allowing a
  // task-only spawn.
  useEffect(() => {
    if (!server || !session) return;
    let cancelled = false;
    getRiffPresets(server, session)
      .then((data) => {
        if (cancelled) return;
        setPresets(data.presets);
        setTiers(data.tiers);
      })
      .catch(() => {
        if (!cancelled) {
          setPresets([]);
          setTiers([DEFAULT_TIER]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [server, session]);

  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    if (busy) return;
    if (!server || !session) {
      setError("No target group — open a terminal tab first.");
      return;
    }
    setBusy(true);
    setError("");
    spawnRiff(server, session, {
      task: task.trim() || undefined,
      preset: preset || undefined,
      where,
      // Worktree name only applies to worktree mode; the backend rejects it with
      // checkout, so drop it there. Commit-time finalize trims the trailing
      // separator the live transform keeps visible while typing.
      worktreeName: where === "worktree" ? finalizeSafeName(worktreeName.trim()) || undefined : undefined,
      // The tier is sent ONLY when the Agent Tier field is shown (a fab project
      // — non-empty tiers). When the field is hidden (non-fab repo) `tier` is
      // omitted entirely, matching the gate: rk never sends an inert tier.
      tier: tiers.length > 0 ? tier : undefined,
    })
      .then((res) => {
        if (!mountedRef.current) return;
        onClose();
        // windowId is best-effort — the backend returns "" when its
        // display-message window-id resolve fails. Navigating with an empty id
        // would land on a junk /$server/@ URL, so close without navigating and
        // let the SSE stream surface the new row instead.
        if (res.windowId) onSpawned(res.windowId);
      })
      .catch((err: Error) => {
        if (!mountedRef.current) return;
        setBusy(false);
        setError(err.message || "Failed to spawn agent");
      });
  }, [busy, server, session, task, preset, where, worktreeName, tier, tiers, onClose, onSpawned]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog title={`Spawn agent in ${session}`} onClose={onClose}>
      {/* Task */}
      <div className="mb-3">
        <p className="text-xs text-text-secondary mb-1.5">Task (optional):</p>
        <input
          ref={taskRef}
          type="text"
          value={task}
          onChange={(e) => {
            setTask(e.target.value);
            setError("");
          }}
          onKeyDown={handleKeyDown}
          disabled={busy}
          aria-label="Task"
          placeholder="What should the agent do? (blank = plain shell)"
          className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary disabled:opacity-40`}
        />
      </div>

      {/* Preset — hidden only when the preflight fetch failed; a live backend
          always returns the riff_presets built-ins. */}
      {presets.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-text-secondary mb-1.5">Preset (optional):</p>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            aria-label="Preset"
            className="w-full bg-bg-primary text-text-primary p-2 border border-border rounded outline-none disabled:opacity-50"
          >
            <option value="">None</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.layout ? ` — ${p.layout}` : ""}
                {p.paneCount > 0 ? ` (${p.paneCount} pane${p.paneCount === 1 ? "" : "s"})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Where — isolation choice (new worktree vs. this checkout). */}
      <div className="mb-3">
        <p className="text-xs text-text-secondary mb-1.5">Where:</p>
        <div role="radiogroup" aria-label="Where" className="flex gap-4">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="riff-where"
              value="worktree"
              checked={where === "worktree"}
              onChange={() => setWhere("worktree")}
              onKeyDown={handleKeyDown}
              disabled={busy}
              className="accent-accent-green disabled:opacity-50"
            />
            <span className="text-text-primary">new worktree</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="riff-where"
              value="checkout"
              checked={where === "checkout"}
              onChange={() => setWhere("checkout")}
              onKeyDown={handleKeyDown}
              disabled={busy}
              className="accent-accent-green disabled:opacity-50"
            />
            <span className="text-text-primary">this checkout</span>
          </label>
        </div>
      </div>

      {/* Worktree name — worktree mode only (no meaning for "this checkout"). */}
      {where === "worktree" && (
        <div className="mb-3">
          <p className="text-xs text-text-secondary mb-1.5">Worktree Name (optional):</p>
          <input
            type="text"
            value={worktreeName}
            onChange={(e) => {
              // Live safe-name conversion (worktree kind — hyphens kept, no
              // leading hyphen, slash converts).
              setWorktreeName(toSafeWorktreeName(e.target.value));
              setError("");
            }}
            onKeyDown={handleKeyDown}
            disabled={busy}
            aria-label="Worktree name"
            placeholder="auto-named (e.g. swift-fox)"
            className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary disabled:opacity-40`}
          />
        </div>
      )}

      {/* Agent — the fab tier the launcher resolves. Shown ONLY for a fab
          project (non-empty, fab-gated tiers). In a non-fab repo the tier is
          inert (every option resolves to the same DefaultLauncher), so the
          backend returns tiers:[] and the field is hidden entirely — no label,
          no hint, no disabled control (gsmu). */}
      {tiers.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-text-secondary mb-1.5">Agent Tier:</p>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            aria-label="Agent tier"
            className="w-full bg-bg-primary text-text-primary p-2 border border-border rounded outline-none disabled:opacity-50"
          >
            {tiers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Busy pipeline label — indeterminate (the endpoint is synchronous). */}
      {busy && (
        <p className="text-xs text-text-secondary mb-2 flex items-center gap-2" role="status" aria-live="polite">
          <LogoSpinner size={14} />
          <span>Spawning: worktree → tab → agent…</span>
        </p>
      )}

      {/* Error — rendered in-dialog; nothing was created on a 400. */}
      {error && !busy && <p className="text-xs text-signal-red mb-2">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={busy}
        className={`w-full ${controlClass({ variant: "wide", disabled: busy })}`}
      >
        {busy ? "Spawning…" : "Spawn"}
      </button>
    </Dialog>
  );
}
