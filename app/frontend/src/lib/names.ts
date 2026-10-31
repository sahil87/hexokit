/**
 * Per-kind safe-name transforms applied LIVE in every naming input's onChange
 * (260722-ln4n): the user watches "My problem" become "My_problem" as they
 * type, so the optimistic-update name is identical to the committed name
 * (WYSIWYG). The backend stays reject-only — these transforms steer input to
 * the charset the backend's tightened new-name validation accepts.
 *
 * Shape shared by all transforms: unsafe chars CONVERT to "_" (never strip —
 * stripping silently shortens names and loses word boundaries), consecutive
 * converted chars collapse to one "_", leading separators drop as typed (a
 * space pressed in an empty field produces nothing), case is preserved, and
 * length caps live at the backend maxima. A TRAILING "_" deliberately stays
 * visible while typing — trimming it live would delete the separator the user
 * just typed ("My " + "p" would become "Myp") — and is trimmed only at commit
 * via `finalizeSafeName`.
 */

/** Mirrors backend validate.MaxNameLength (session/window names). */
const MAX_NAME_LENGTH = 128;
/** Mirrors backend validate.MaxServerNameLength. */
const MAX_SERVER_NAME_LENGTH = 64;

/**
 * Chars every tmux-name transform converts: the backend forbidden set
 * (validate.go forbiddenChars), the ":" / "." pair ValidateName rejects
 * separately, and the space the tightened new-name rule rejects.
 */
const BASE_UNSAFE = /[ ;&|`$(){}[\]<>!#*?\n\r\t:.]/g;

/** Collapse "_" runs, drop leading "_", cap length. */
function squash(converted: string, max: number): string {
  return converted.replace(/_{2,}/g, "_").replace(/^_+/, "").slice(0, max);
}

/**
 * Session names: base rule PLUS hyphen→"_". The hyphen rule is
 * session-specific — it avoids collisions with session-group naming.
 */
export function toSafeSessionName(raw: string): string {
  return squash(raw.replace(BASE_UNSAFE, "_").replace(/-/g, "_"), MAX_NAME_LENGTH);
}

/**
 * Window names: base rule, hyphens KEPT — `riff-*` windows use hyphens
 * legitimately and the session-group collision rationale doesn't apply.
 */
export function toSafeWindowName(raw: string): string {
  return squash(raw.replace(BASE_UNSAFE, "_"), MAX_NAME_LENGTH);
}

/**
 * Server names: strictest — anything outside [a-zA-Z0-9_-] converts to "_"
 * (mirrors backend ValidateServerName's ^[a-zA-Z0-9_-]+$).
 */
export function toSafeServerName(raw: string): string {
  return squash(raw.replace(/[^a-zA-Z0-9_-]/g, "_"), MAX_SERVER_NAME_LENGTH);
}

/**
 * Worktree names: the window rule plus ValidateWorktreeName's extra
 * constraints — "/" converts to "_" (worktree directory basename), and a
 * leading hyphen run is dropped (a leading "-" would look like a flag to
 * `wt create`).
 */
export function toSafeWorktreeName(raw: string): string {
  return squash(
    raw.replace(BASE_UNSAFE, "_").replace(/\//g, "_").replace(/^[-_]+/, ""),
    MAX_NAME_LENGTH,
  );
}

/**
 * Commit-time finisher: trims the trailing "_" the live transforms keep
 * visible while typing (plus a defensive leading trim). Apply at every
 * commit/submit site whose input carries a live transform — the one minimal
 * deviation from strict WYSIWYG.
 */
export function finalizeSafeName(name: string): string {
  return name.replace(/^_+|_+$/g, "");
}

/**
 * Derive a session-name suggestion from a filesystem path: last segment,
 * session-transformed, fully trimmed (suggestions are commit-shaped — no
 * trailing separator to preserve).
 */
export function deriveNameFromPath(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "~" || trimmed === "") return "";
  const segment = trimmed.split("/").pop() ?? "";
  return finalizeSafeName(toSafeSessionName(segment));
}

/**
 * Deduplicate `base` against `existing` by appending -2 through -10; beyond
 * that appends -11 (best-effort). Shared by instant group creation and the
 * New sheet so the preview shows the name that will actually be created.
 */
export function uniqueName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 10; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-11`;
}

/**
 * Raw (unsanitized) basename of a filesystem path — the last non-empty path
 * segment. Used as the optimistic ghost-window label so it matches what tmux
 * will name an unnamed window (tmux's `#{b:pane_current_path}` uses the raw
 * basename, NOT the tmux-safe sanitization `deriveNameFromPath` applies).
 * Falls back to "window" when no basename is derivable.
 */
export function rawBasename(cwd: string | undefined): string {
  if (!cwd) return "window";
  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed === "") return "window";
  const segment = trimmed.split("/").pop() ?? "";
  return segment || "window";
}
