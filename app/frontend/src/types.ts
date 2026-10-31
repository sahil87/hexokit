/** Host-level system metrics snapshot from the backend SSE stream. */
export type MetricsSnapshot = {
  hostname: string;
  cpu: {
    samples: number[]; // ring buffer, 60 entries
    current: number;   // latest percentage 0-100
    cores: number;     // logical CPU count
  };
  memory: {
    used: number;  // bytes
    total: number; // bytes
  };
  load: {
    avg1: number;
    avg5: number;
    avg15: number;
    cpus: number;
  };
  disk: {
    used: number;  // bytes
    total: number; // bytes
  };
  uptime: number; // seconds
};

/** A single listening TCP service on the host (from the `event: services` SSE
 *  broadcast). `process`/`pid` are best-effort process attribution (lsof on
 *  both darwin and Linux) and absent when attribution is unavailable — e.g. a
 *  root-owned listener invisible to a non-root lsof still appears, bare. */
export type Service = {
  port: number;
  process?: string;
  pid?: number;
};

/** Host listening-services snapshot from the backend SSE stream. */
export type ServicesSnapshot = {
  services: Service[];
};

/** A single tmux pane within a window. */
export type PaneInfo = {
  paneId: string;
  paneIndex: number;
  cwd: string;
  command: string;
  isActive: boolean;
  gitBranch?: string;
  /** True when `cwd` no longer exists on disk (e.g. an archived worktree
   *  deleted out from under a still-live pane). The cwd row renders a
   *  "(deleted)" marker when set. */
  cwdMissing?: boolean;
};

/** One item of the operator's tracked list (the fab operator state file's
 *  `tracked:` — every kind, pane-bearing or not, done or not), stamped onto
 *  every session of the server like the tick facts. `windowId` is set when
 *  the item's pane resolves to a live window. Display only. Absent on
 *  payloads from an older backend. */
export type OperatorTrackedItem = {
  id: string;
  kind?: string;
  text?: string;
  refs?: string[];
  pane?: string;
  windowId?: string;
  repo?: string;
  session?: string;
  stage?: string;
  agent?: string;
  branch?: string;
  paused?: boolean;
  doneAt?: number;
  addedAt?: number;
  updatedAt?: number;
};

/** A tmux session with its windows and optional fab enrichment. */
export type ProjectSession = {
  name: string;
  /** Color value descriptor: "4" for a single ANSI index, "1+3" for a blend. */
  sessionColor?: string;
  /** Tmux session id (`$N` form, from `#{session_id}`) — the canonical target
   *  handle. Absent on payloads from an older backend. */
  sessionId?: string;
  /** Session working directory (`#{session_path}`), raw. Absent on payloads
   *  from an older backend; display abbreviation is a frontend concern. */
  sessionPath?: string;
  /** Row flair state: ""/absent (no flair) | "rain" | "scan" | "nyan" |
   *  "naruto" | "onepiece" | "pacman" | "matrix" | "aquarium" | "nemo" |
   *  "roadrunner" | "invaders" | "cube" | "warp" | "spidey" | "ironman" |
   *  "noon".
   *  Decoration only (FLAIR_STATES in themes.ts) — an ambient CSS-only overlay
   *  with no status semantics. */
  flair?: string;
  /** Content-conditional operator-home marker, computed backend-side at the
   *  FetchSessions join: true only for the `_rk-operator` session while every
   *  window in it carries role "operator". The session and its windows STAY in
   *  the payload (the pinned operator row's only data source — the window is
   *  moved, not linked); user-facing session enumerations exclude hidden
   *  sessions at render. A mixed/stray population keeps it absent. */
  hidden?: boolean;
  /** Size-arbitrating clients attached to this session, derived server-side
   *  from `tmux list-clients` (control-mode/ignore-size attaches and unsized
   *  clients excluded; group-copy attaches count against the leader row). The
   *  grid is the diagnostic payload — it identifies the clamping client.
   *  Absent on zero-viewer sessions and on payloads from an older backend.
   *  Identity keys are additive and optional: `kind` is "rk" (a relay-forked
   *  attach, enriched with the closed-set `device` tag and the display-only
   *  `peer`) or "tty" (tmux-only facts); `createdAt`/`lastActiveAt` are
   *  absolute unix seconds (never counters — the SSE hub dedups the sessions
   *  JSON), age/idle derived at render. An old-backend payload carries only
   *  width/height and must still render. */
  viewers?: {
    width: number;
    height: number;
    kind?: "rk" | "tty";
    pid?: number;
    device?: "phone" | "tablet" | "desktop" | "desktop-shell" | "unknown";
    peer?: string;
    createdAt?: number;
    lastActiveAt?: number;
  }[];
  /** Per-server operator-watchdog facts, stamped onto every session of the
   *  server by the FetchSessions join (one operator loop per server, so the
   *  value is identical across that server's sessions): `operatorLastTickAt`
   *  is the operator's last watchlist tick (unix seconds, 0/absent = never),
   *  `operatorStale` is the server-side derived staleness verdict (tick older
   *  than the watchlist stale threshold). Consumers read these verbatim —
   *  never re-derive the threshold client-side. Absent on payloads from an
   *  older backend. */
  operatorLastTickAt?: number;
  operatorStale?: boolean;
  /** The operator's whole tracked list (the fab operator state file's
   *  `tracked:` — every kind, pane-bearing or not, done or not), stamped onto
   *  every session of the server like the tick facts. The Operator Tasks
   *  segment lists these; display only — nothing in rk acts on them. An
   *  empty array when the operator state file exists but tracks nothing;
   *  absent on payloads from an older backend or when the file is absent
   *  (fall back to the `monitored`-derived rows). */
  operatorTracked?: OperatorTrackedItem[];
  windows: WindowInfo[];
};

/** A single tmux window within a session. */
export type WindowInfo = {
  windowId: string;
  index: number;
  name: string;
  worktreePath: string;
  activity: "active" | "idle";
  isActiveWindow: boolean;
  paneCommand?: string;
  activityTimestamp: number;
  /** Color value from the `@rk_win_color` window option — a legacy numeric/blend
   *  descriptor ("4" / "1+3"); the backend only validates/stores this vocabulary
   *  (ValidateColorValue). Family names ("orange") are frontend read aliases that
   *  resolve 1:1 to a family (resolveFamily) — the picker maps them back to the
   *  legacy descriptor at the write seam (familyToLegacy). Drives the row's hue
   *  (label axis). */
  color?: string;
  /** Left-gutter marker state from `@rk_win_marker`: `<mode>[:<stage>]`, with
   *  manual, auto, or blocked mode and stage 1–3; empty means no marker. An
   *  independent label axis from `color` — see docs/specs/themes.md. */
  marker?: string;
  /** Row flair state, from the `@rk_win_flair` window option: ""/absent (no
   *  flair) | "rain" | "scan" | "nyan" | "naruto" | "onepiece" | "pacman" |
   *  "matrix" | "aquarium" | "nemo" | "roadrunner" | "invaders" | "cube" |
   *  "warp" | "spidey" | "ironman" | "noon". Decoration
   *  only (FLAIR_STATES in themes.ts) — an ambient CSS-only overlay with no
   *  status semantics. */
  flair?: string;
  /** Window role from the `@rk_win_role` window option: ""/absent (no role) |
   *  "operator" (the server's operator window — the sidebar pins its row at
   *  the top of the server's session area; server-scoped radio, enforced
   *  backend-side so at most one window per server carries it). */
  role?: string;
  /** Free-text one-line status note, from the `@rk_win_note` window option —
   *  user/agent-authored annotation (the marker/flair user-preference class,
   *  not derived state). Absent when the option is unset (degrade-to-absent:
   *  no note row renders anywhere). Rendered with its relative age; notes
   *  older than 24h render dimmed (faded, never hidden or auto-expired). */
  note?: string;
  /** Unix-seconds write time from the note's epoch prefix (`<epoch>:<text>`
   *  schema); absent/0 for tolerant-parse notes (text-only, no age shown). */
  noteEpoch?: number;
  /** Generic agent-lifecycle state from the `@rk_pane_agent_state` pane option:
   *  `active` (turn in progress) | `waiting` (blocked on a human — permission
   *  prompt / question dialog) | `idle` (at rest). Empty/absent = unknown.
   *  Window-level rollup with precedence `waiting > active > idle`. See
   *  docs/specs/agent-state.md. */
  agentState?: string;
  /** Agent-state duration (e.g. `2m`), computed server-side from the option's
   *  epoch for any known state (`active` included); consumers render it only
   *  for the `idle` and `waiting` rest states. Empty for unknown states. */
  agentIdleDuration?: string;
  fabChange?: string;
  fabStage?: string;
  /** Pipeline state of the displayed stage from `fab pane map` `display_state`
   *  (`active`/`ready`/`done`/`failed`/`pending`/`skipped`); absent when fab
   *  reports null or omits the field (fab < 2.1.7). */
  fabDisplayState?: string;
  /** PR URL / number from `fab pane map` (Layer 1 — filesystem, cheap). */
  prUrl?: string;
  prNumber?: number;
  /** Live PR status from the in-memory prstatus collector (Layer 3 — attached
   *  by the SSE hub only for change-bound windows). */
  prState?: "open" | "merged" | "closed";
  prChecks?: "pass" | "fail" | "pending" | "none";
  prReview?: "approved" | "changes_requested" | "review_required" | "none";
  prIsDraft?: boolean;
  /** ISO timestamp (RFC3339) of when the joined PR status was last fetched by
   *  the viewer-wide collector. Collector-join-owned (set on a URL hit, absent
   *  on a miss); surfaced as the row flyout card's "checked Xs ago" freshness line. */
  prFetchedAt?: string;
  /** The tab's surface layout, from the `@rk_win_layout` window option
   *  (`<shape>:<surface>[,<surface>…]`). Empty/absent renders `single:tty`.
   *  Read-side is tolerant: the raw value rides through unvalidated (validation
   *  is write-side; consumers parse). */
  layout?: string;
  /** Where each of this window's surfaces is currently held when borrowed into
   *  another tab: surface kind (`tty`/`web`/`code`) → holder window id (e.g.
   *  `@7`). Derived server-side from every window's parsed layout (a foreign
   *  leaf `@A/<kind>` in window W's layout sets `A.awayIn[kind] = W`);
   *  absent when nothing is away (the backend's omitempty) and on payloads
   *  from an older backend. */
  awayIn?: Record<string, string>;
  /** The dense `@rk_win_web_<n>` family: slots 1..N walked in order, stopping
   *  at the first empty (a hand-written gap degrades to the prefix). Index 0 is
   *  tmux slot 1. */
  webTabs?: string[];
  /** The 1-based index into `webTabs` the web surface shows, from
   *  `@rk_win_web_active`. 0/absent when no tabs; a non-numeric or out-of-range
   *  stored value clamps to 1 backend-side (degrade, never error). */
  webActive?: number;
  /** The absolute folder the code surface opens, from `@rk_win_code_root`.
   *  Empty/absent when unset. */
  codeRoot?: string;
  /** The window's code folder, derived server-side from the active pane's cwd
   *  (`internal/sessions` `deriveGitRoot`): the git toplevel when inside a
   *  repo, else the raw cwd itself; empty/absent only when no cwd is
   *  resolvable at all. The per-window half of the code lens/surface
   *  availability gate (`hasCode`); keyed by the resolved folder so editor
   *  state follows the code. */
  gitRoot?: string;
  /** Window-level rollup of the panes' `@rk_pane_agent_session` pane option
   *  (active-pane-first, else first pane) — the window's agent session
   *  identity. `agentProvider` is the routing key (e.g. `claude`) and the
   *  gate for the fork action; `agentSessionRef` is the provider session id
   *  (the operator-action gate). Both are emitted by the backend on every
   *  `/api/sessions` response and SSE `sessions` event (rollupAgentSession,
   *  internal/sessions/sessions.go). Empty/absent = no agent session for this
   *  window. */
  agentProvider?: string;
  agentSessionRef?: string;
  /** Server-derived conversation-access capability (deriveConversationAvailable,
   *  internal/sessions): true when the window's reconciled agent identity
   *  resolves to a readable conversation — the provider has a transcript
   *  adapter AND the bounded lookup succeeded. This is the gate for the
   *  transcript-backed operator actions (Fix tab name / Annotate tab) in both
   *  the flyout and the palette, so identity-only providers (no transcript
   *  adapter) never advertise an action that would predictably 404. Absent =
   *  false. */
  conversationAvailable?: boolean;
  /** True when the ACTIVE pane's application is on tmux's alternate screen
   *  (rollup of the pane's `alternate_on`, derived server-side in
   *  FetchSessions). Alt-screen panes have no scrollback, so a server-side
   *  `capture-pane -S -` history capture is structurally empty for them — the
   *  export menu disables its "full history" row and the palette omits the
   *  action while this is true. The backend emits it on every window (false =
   *  normal screen); optional here only for partial test fixtures — consumers
   *  treat absent as false. */
  altScreen?: boolean;
  /** Operator-watchlist tier: FetchSessions joins the fab operator state
   *  file's monitored map onto each window by pane ID. `monitored` is true
   *  when any pane matches a watchlist entry; the remaining fields are that
   *  entry's identity facets (change key, stage, repo, branch, agent). All
   *  absent on unwatched windows and on payloads from an older backend. */
  monitored?: boolean;
  monitoredChange?: string;
  monitoredStage?: string;
  monitoredRepo?: string;
  monitoredBranch?: string;
  monitoredAgent?: string;
  /** Done-trail marker from the `@rk_win_owner` window option — a closed set,
   *  currently only "operator" (the operator finished with this window).
   *  Absent when unset and on payloads from an older backend. Feeds the `opr`
   *  register's done head only when the window is NOT on the watchlist —
   *  `monitored` wins over `owner` (getOperatorParts in sidebar/registers.ts).
   *  Carries no status-dot semantics. */
  owner?: "operator";
  panes?: PaneInfo[];
};
