package sessions

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"sync"
	"time"

	"rk/internal/config"
	"rk/internal/cron"
	"rk/internal/gitinfo"
	"rk/internal/prstatus"
	"rk/internal/tmux"
	"rk/internal/transcript"
)

// Viewer is one size-arbitrating client attached to a session — the
// per-viewer grid fact (the size IS the diagnostic payload: it identifies the
// clamping client) behind the sidebar's viewer indicator.
type Viewer struct {
	Width  int `json:"width"`
	Height int `json:"height"`
	// Additive identity fields, all omitempty — old frontends ignore them, old
	// backends omit them.
	Kind         string `json:"kind,omitempty"` // "rk" | "tty"
	PID          int    `json:"pid,omitempty"`
	Device       string `json:"device,omitempty"`       // rk only: phone|tablet|desktop|desktop-shell|unknown
	Peer         string `json:"peer,omitempty"`         // rk only
	CreatedAt    int64  `json:"createdAt,omitempty"`    // unix seconds, from #{client_created} (both kinds)
	LastActiveAt int64  `json:"lastActiveAt,omitempty"` // unix seconds: rk → conn lastInbound; tty → #{client_activity}
}

// AttachMeta is what the relay knows about an attach client it forked. Supplied
// by the api layer through AttachResolver so this package never imports api.
type AttachMeta struct {
	Peer        string
	Device      string
	ConnectedAt time.Time
	// LastInbound reads the conn's last inbound frame time (unix seconds) at
	// fold time — a closure over the conn's atomic, so the registry never
	// copies a stale idle value. May be nil.
	LastInbound func() int64
}

// AttachResolver answers "is this list-clients pid one of the relay's forked
// attaches, and what does the relay know about its socket?". nil = every
// viewer is tty.
type AttachResolver func(pid int) (AttachMeta, bool)

// ProjectSession is a tmux session with its windows and optional fab enrichment.
type ProjectSession struct {
	Name string `json:"name"`
	// Color value descriptor ("4" / "1+3"), sourced from the @rk_ses_color tmux option.
	SessionColor *string `json:"sessionColor,omitempty"`
	// SessionID is the tmux session id ("$N" form, from #{session_id}) — the
	// canonical target handle. Additive JSON key.
	SessionID string `json:"sessionId,omitempty"`
	// SessionPath is the session working directory (#{session_path}). Raw
	// derived state; display abbreviation is the frontend's concern.
	SessionPath string `json:"sessionPath,omitempty"`
	// Flair is the session's per-row flair decoration ("" = unset; one of the
	// validate.FlairValues closed set), sourced from the @rk_ses_flair tmux
	// session option (scope-split from the window @rk_win_flair — see
	// tmux.SetSessionFlair).
	Flair   string            `json:"flair,omitempty"`
	Windows []tmux.WindowInfo `json:"windows"`
	// Hidden is the content-conditional operator-home marker, computed at the
	// FetchSessions join (post window fan-out): true only for the operator
	// session (tmux.OperatorSessionName) while it holds ≥1 window and EVERY
	// window carries role == "operator". The session and its windows STAY in
	// the payload (the window is moved, not linked, so this session is the
	// pinned operator row's only data source); user-facing session
	// enumerations exclude hidden sessions at render. A mixed or stray
	// population yields false, so no window can ever become invisible.
	Hidden bool `json:"hidden,omitempty"`
	// Viewers lists the session's size-arbitrating attached clients, derived
	// from `tmux list-clients` at fetch time (internal/tmux ListClients —
	// control-mode/ignore-size attaches and unsized clients already excluded)
	// and joined by group key (ClientInfo.SessionKey), so a client attached
	// via a derived group copy counts against the leader row. Absent when the
	// session has no attached clients (omitempty); the frontend surfaces a
	// viewer indicator only at ≥2. Each viewer carries additive identity
	// facts: kind "rk" (a relay-forked attach, enriched with device/peer) or
	// "tty" (tmux-only facts), the attach pid, and absolute unix-second
	// createdAt/lastActiveAt — never second-counters (the SSE hub dedups the
	// sessions JSON; a counter would defeat the dedup on every safety
	// rebuild).
	Viewers []Viewer `json:"viewers,omitempty"`
	// OperatorLastTickAt / OperatorStale are the per-server operator-watchdog
	// staleness facts — the fab operator state file's last_tick_at against
	// cron.DefaultWatchlistStaleThreshold — populated identically on every
	// session of one FetchSessions call (all sessions on a server share the
	// one operator-state file). 0/false when the file is absent (nothing to
	// be stale about).
	OperatorLastTickAt int64 `json:"operatorLastTickAt,omitempty"`
	OperatorStale      bool  `json:"operatorStale,omitempty"`
	// OperatorTracked is the sessions-payload projection of the operator state
	// file's whole tracked: list — server-scoped like OperatorLastTickAt/
	// OperatorStale and stamped identically on every session of one
	// FetchSessions call. Display only: the frontend's Operator Tasks segment
	// lists these; nothing in rk acts on them. A pointer so the two empties
	// stay distinguishable on the wire: nil when the operator state file is
	// absent or corrupt (the key is omitted — the same shape an older backend
	// emits, so the frontend falls back to the monitored-derived rows), and a
	// pointer to an EMPTY slice when the file was read but tracks nothing
	// (`"operatorTracked":[]` — a present, empty list). A plain slice with
	// omitempty would collapse the second case into the first.
	OperatorTracked *[]OperatorTrackedItem `json:"operatorTracked,omitempty"`
}

// OperatorTrackedItem is the sessions-payload projection of one tracked item
// (cron.TrackedItem). WindowID is the pane's live window when the pane
// resolves in this fetch — the Tasks row's navigation target — and absent for
// pane-less items and for a pane that no window carries (a dead pane).
type OperatorTrackedItem struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind,omitempty"`
	Text      string   `json:"text,omitempty"`
	Refs      []string `json:"refs,omitempty"`
	Pane      string   `json:"pane,omitempty"`
	WindowID  string   `json:"windowId,omitempty"`
	Repo      string   `json:"repo,omitempty"`
	Session   string   `json:"session,omitempty"`
	Stage     string   `json:"stage,omitempty"`
	Agent     string   `json:"agent,omitempty"`
	Branch    string   `json:"branch,omitempty"`
	Paused    bool     `json:"paused,omitempty"`
	DoneAt    int64    `json:"doneAt,omitempty"`
	AddedAt   int64    `json:"addedAt,omitempty"`
	UpdatedAt int64    `json:"updatedAt,omitempty"`
}

// foldViewers buckets the size-arbitrating clients onto session names via the
// group-key join (ClientInfo.SessionKey: the group leader's name for a grouped
// attach, else the attached session's own name — mirroring the leader-keeps-name
// rule so a viewer attached via a derived group copy still counts against the
// UI session). Pure (no I/O) so the join is unit-testable without a live
// server. Returns nil for no clients.
//
// Identity: every surviving client starts as kind "tty" with tmux's own
// client_created/client_activity; when resolve reports the pid as one of the
// relay's forked attaches, the viewer becomes kind "rk" with the relay's
// device/peer and the conn's live lastInbound as lastActiveAt (falling back to
// client_activity when the closure is nil or reports 0). A pid of 0 (older
// tmux without client_pid) is always "tty" — identity degrades, nothing
// breaks.
func foldViewers(clients []tmux.ClientInfo, resolve AttachResolver) map[string][]Viewer {
	if len(clients) == 0 {
		return nil
	}
	bySession := make(map[string][]Viewer)
	for _, c := range clients {
		key := c.SessionKey()
		if key == "" {
			continue
		}
		v := Viewer{
			Width:  c.Width,
			Height: c.Height,
			Kind:   "tty",
			PID:    c.PID,
		}
		if !c.Created.IsZero() {
			v.CreatedAt = c.Created.Unix()
		}
		if !c.Activity.IsZero() {
			v.LastActiveAt = c.Activity.Unix()
		}
		if c.PID > 0 && resolve != nil {
			if meta, ok := resolve(c.PID); ok {
				v.Kind = "rk"
				v.Device = meta.Device
				v.Peer = meta.Peer
				if meta.LastInbound != nil {
					if inbound := meta.LastInbound(); inbound > 0 {
						v.LastActiveAt = inbound
					}
				}
			}
		}
		bySession[key] = append(bySession[key], v)
	}
	return bySession
}

// operatorSessionHidden is the pure content rule behind ProjectSession.Hidden:
// hidden iff the session is the operator session AND it holds ≥1 window AND
// every window carries role == "operator". Pure (no I/O) so the truth table is
// unit-testable without a live server.
func operatorSessionHidden(name string, windows []tmux.WindowInfo) bool {
	if name != tmux.OperatorSessionName || len(windows) == 0 {
		return false
	}
	for _, w := range windows {
		if w.Role != "operator" {
			return false
		}
	}
	return true
}

// joinWatchlist rolls the operator watchlist (keyed by pane ID) up onto each
// window: a window is Monitored when any pane's PaneID matches an entry's
// Pane; the first matching pane wins (the same window-level-rollup-over-panes
// shape rollupAgentState/rollupAgentSession use). Pure (no I/O) so the join is
// unit-testable without a live server.
func joinWatchlist(windows []tmux.WindowInfo, byPane map[string]cron.WatchlistEntry) {
	for i := range windows {
		for _, p := range windows[i].Panes {
			we, ok := byPane[p.PaneID]
			if !ok {
				continue
			}
			windows[i].Monitored = true
			windows[i].MonitoredChange = we.ChangeID
			windows[i].MonitoredStage = we.Stage
			windows[i].MonitoredRepo = we.Repo
			windows[i].MonitoredBranch = we.Branch
			windows[i].MonitoredAgent = we.Agent
			break
		}
	}
}

// paneToWindowMap maps every pane ID across the fetch's sessions to the
// window carrying it — the WindowID resolution for the operatorTracked
// projection. A pane belongs to one window; a pane no window carries (a dead
// pane) simply has no entry. Pure (no I/O), unit-testable.
func paneToWindowMap(data []sessionData) map[string]string {
	byPane := make(map[string]string)
	for _, sd := range data {
		for _, w := range sd.windows {
			for _, p := range w.Panes {
				byPane[p.PaneID] = w.WindowID
			}
		}
	}
	return byPane
}

// projectTrackedItems lifts the operator state's tracked items into the
// sessions-payload shape, resolving each item's Pane to its live WindowID
// through paneToWindow (absent for pane-less items and dead panes). The item
// order is the state's list order — the operator's ledger order. Pure (no
// I/O), unit-testable.
func projectTrackedItems(items []cron.TrackedItem, paneToWindow map[string]string) []OperatorTrackedItem {
	// Never nil: the caller takes the address, and an empty list must reach the
	// wire as [] (present, empty) rather than vanish under omitempty.
	out := make([]OperatorTrackedItem, len(items))
	for i, item := range items {
		out[i] = OperatorTrackedItem{
			ID:        item.ID,
			Kind:      item.Kind,
			Text:      item.Text,
			Refs:      item.Refs,
			Pane:      item.Pane,
			WindowID:  paneToWindow[item.Pane],
			Repo:      item.Repo,
			Session:   item.Session,
			Stage:     item.Stage,
			Agent:     item.Agent,
			Branch:    item.Branch,
			Paused:    item.Paused,
			DoneAt:    item.DoneAt,
			AddedAt:   item.AddedAt,
			UpdatedAt: item.UpdatedAt,
		}
	}
	return out
}

// operatorStaleness derives ProjectSession.OperatorStale: true when the
// operator's last tick is older than DefaultWatchlistStaleThreshold. An absent
// stamp (0) is never stale — there is nothing to be stale about. Pure (no
// I/O), unit-testable.
func operatorStaleness(lastTickAt, nowUnix int64) bool {
	return lastTickAt > 0 && nowUnix-lastTickAt > int64(cron.DefaultWatchlistStaleThreshold/time.Second)
}

// ActiveWindowProvider supplies the event-tracked active window (`@wid`) for a
// (server, group) pair — the authoritative Tier-1 signal derived from tmux
// control-mode `%session-window-changed` events. It is the seam between the
// tmuxctl layer (which owns the tracker) and the fetch path. A nil provider, or
// a (server, group) miss, signals "no tracked value" so FetchSessions falls
// back to the base-session `#{window_active}` pointer (Tier 2) — preserving
// today's behavior when control-mode is unavailable.
type ActiveWindowProvider interface {
	ActiveWindow(server, group string) (wid string, ok bool)
}

// applyActiveWindow enforces the two-tier active-window derivation on one
// session's windows in place. When trackedWid is non-empty (Tier 1) AND a live
// window matches it, exactly that window is marked active and all others are
// cleared — overriding the base-pointer flag parsed by parseWindows. If
// trackedWid is empty (no tracked entry) OR matches no live window (stale —
// e.g. the window closed between the event and this fetch), the base-pointer
// flags are left untouched (Tier 2 fallback). This guarantees the sidebar's
// single-highlight invariant: at most one window is active per session.
//
// Pure function (no I/O) so the derivation is unit-testable directly, mirroring
// the parseWindows/parsePanes split.
func applyActiveWindow(windows []tmux.WindowInfo, trackedWid string) {
	if trackedWid == "" {
		return // Tier 2: keep base-pointer flags.
	}
	matchIdx := -1
	for i := range windows {
		if windows[i].WindowID == trackedWid {
			matchIdx = i
			break
		}
	}
	if matchIdx < 0 {
		// Stale tracked @wid (window gone) — fall back to Tier 2 for this
		// session rather than marking none active.
		return
	}
	for i := range windows {
		windows[i].IsActiveWindow = i == matchIdx
	}
}

type cwdExistsCacheEntry struct {
	missing   bool
	expiresAt time.Time
}

const (
	// A deleted worktree stays deleted, so the positive ("exists") result can
	// be cached longer; the negative ("missing") result is the interesting,
	// changeable one, but it too rarely flips back, so both use one short TTL
	// that keeps the SSE tick from stat-storming while staying responsive.
	cwdExistsTTL = 10 * time.Second
)

var (
	cwdExistsCacheMu sync.RWMutex
	cwdExistsCache   = make(map[string]cwdExistsCacheEntry)
)

// resolveCwdMissing reports, for each unique non-empty cwd, whether the path no
// longer exists on disk (true == missing). It follows the same TTL-cache pattern
// as gitinfo.ResolveBranches: a per-entry TTL cache fronts a cheap os.Stat so the SSE
// hub's periodic refresh doesn't stat every pane on every tick. (It omits that
// function's per-call resolve limit and ctx-cancellation checks — an os.Stat is
// cheaper than git resolution and the loop is bounded by the distinct pane cwds.)
// A cwd that exists (or whose stat fails for any reason other than not-existing)
// is treated as present — we only flag the unambiguous fs.ErrNotExist case to
// avoid false "(deleted)" markers on transient errors (permissions, races).
func resolveCwdMissing(cwds []string) map[string]bool {
	now := time.Now()
	result := make(map[string]bool)
	seen := make(map[string]bool)
	var misses []string

	cwdExistsCacheMu.RLock()
	for _, cwd := range cwds {
		if cwd == "" || seen[cwd] {
			continue
		}
		seen[cwd] = true
		if entry, ok := cwdExistsCache[cwd]; ok && now.Before(entry.expiresAt) {
			if entry.missing {
				result[cwd] = true
			}
			continue
		}
		misses = append(misses, cwd)
	}
	cwdExistsCacheMu.RUnlock()

	if len(misses) == 0 {
		return result
	}

	updates := make(map[string]cwdExistsCacheEntry, len(misses))
	for _, cwd := range misses {
		_, err := os.Stat(cwd)
		missing := errors.Is(err, fs.ErrNotExist)
		if missing {
			result[cwd] = true
		}
		updates[cwd] = cwdExistsCacheEntry{missing: missing, expiresAt: now.Add(cwdExistsTTL)}
	}

	cwdExistsCacheMu.Lock()
	for cwd, entry := range updates {
		cwdExistsCache[cwd] = entry
	}
	cwdExistsCacheMu.Unlock()

	return result
}

// agentStatePrecedence ranks the three agent states for the window-level rollup:
// waiting > active > idle. A higher number wins. An unknown/empty state ranks 0
// (contributes nothing). waiting is the attention state, so it must win the
// rollup — a split window with one waiting pane is a waiting window.
func agentStatePrecedence(state string) int {
	switch state {
	case tmux.AgentStateWaiting:
		return 3
	case tmux.AgentStateActive:
		return 2
	case tmux.AgentStateIdle:
		return 1
	default:
		return 0
	}
}

// FormatAgentDuration formats an elapsed-seconds value in the Ns/Nm/Nh style
// fab produced (floor division), so the frontend duration surface is
// byte-compatible with the previous fab-formatted string. A non-positive
// elapsed yields "".
func FormatAgentDuration(elapsedSeconds int64) string {
	if elapsedSeconds <= 0 {
		return ""
	}
	switch {
	case elapsedSeconds < 60:
		return fmt.Sprintf("%ds", elapsedSeconds)
	case elapsedSeconds < 3600:
		return fmt.Sprintf("%dm", elapsedSeconds/60)
	default:
		return fmt.Sprintf("%dh", elapsedSeconds/3600)
	}
}

// rollupAgentState derives the window-level agent state and duration from the
// window's panes (post-reconciler), applying the waiting > active > idle
// precedence. The duration is computed rk-side from the winning pane's
// AgentStateEpoch for ANY known state (empty for unknown): active carries its
// age too, because a lost idle write on a live agent reads as a fresh active
// indefinitely — the age is the only downstream staleness signal.
// Pure function (no I/O) so the rollup is unit-testable, mirroring the
// parseWindows/parsePanes/applyActiveWindow split.
func rollupAgentState(panes []tmux.PaneInfo, nowUnix int64) (state string, duration string) {
	best := -1
	var bestEpoch int64
	for _, p := range panes {
		if p.AgentState == "" {
			continue
		}
		rank := agentStatePrecedence(p.AgentState)
		// Deterministic tie-break: at the same precedence (e.g. two waiting
		// panes), prefer the pane with the newest AgentStateEpoch so the
		// window duration reflects the most-recently-updated pane rather than
		// an arbitrary older one (which would inflate the shown waiting/idle
		// duration). A strictly-higher rank always wins outright.
		if rank > best || (rank == best && p.AgentStateEpoch > bestEpoch) {
			best = rank
			state = p.AgentState
			bestEpoch = p.AgentStateEpoch
		}
	}
	if state == "" {
		return "", ""
	}
	// Duration is emitted for any known state with epoch > 0 — active carries
	// its age too, so a lost write on a live agent is not stale forever
	// without a signal.
	if bestEpoch > 0 {
		duration = FormatAgentDuration(nowUnix - bestEpoch)
	}
	return state, duration
}

// ResolveAgentPane derives the window-level agent session identity AND the
// resolved pane id from the window's panes (post-reconciler): the ACTIVE
// pane's agent session if it carries one, else the FIRST pane (in tmux pane
// order) that carries one. Deterministic — the common case is a single agent
// pane per window; the multi-pane rule can be revisited without a backend
// contract break since per-pane truth also ships on
// PaneInfo.AgentProvider/AgentSessionRef. Returns ("", "", "") when no pane
// carries an agent session. Pure function (no I/O).
//
// The paneID is what agent-send injects into — a WINDOW target routes to the
// active pane, which in a split may not be the agent pane, so the resolved pane
// (not the window) is the correct injection target. This is the single source
// of the active-pane-first rollup rule; rollupAgentSession delegates to it.
func ResolveAgentPane(panes []tmux.PaneInfo) (provider, ref, paneID string) {
	for _, p := range panes {
		if p.IsActive && p.AgentProvider != "" {
			return p.AgentProvider, p.AgentSessionRef, p.PaneID
		}
	}
	for _, p := range panes {
		if p.AgentProvider != "" {
			return p.AgentProvider, p.AgentSessionRef, p.PaneID
		}
	}
	return "", "", ""
}

// rollupAgentSession derives the window-level agent session identity from the
// window's panes, discarding the resolved pane id (the SSE/read path rolls up
// to the window and re-resolves the pane server-side per request). Delegates
// to ResolveAgentPane so the active-pane-first rule lives in exactly one place.
func rollupAgentSession(panes []tmux.PaneInfo) (provider, ref string) {
	provider, ref, _ = ResolveAgentPane(panes)
	return provider, ref
}

// deriveConversationAvailable reports whether a window's rolled-up agent
// identity resolves to a READABLE conversation. Providers with a
// ConversationChecker (opencode, whose resolution is a request-priced export
// subprocess) answer through the cheap probe; every other provider resolves
// for real via the bounded glob/index lookups. Every failure class — absent
// identity, unregistered provider, invalid ref, missing transcript — degrades
// to false; the derive tick never errors on a conversation lookup and never
// spawns a subprocess. Called once per identified window per fetch.
func deriveConversationAvailable(provider, ref string) bool {
	if provider == "" || ref == "" {
		return false
	}
	a, err := transcript.Lookup(provider)
	if err != nil {
		return false
	}
	if checker, ok := a.(transcript.ConversationChecker); ok {
		return checker.ConversationAvailable(ref)
	}
	if _, ok := a.(transcript.TranscriptLocator); !ok {
		return false
	}
	_, err = transcript.Path(provider, ref)
	return err == nil
}

// rollupAltScreen derives the window-level alt-screen flag from the ACTIVE
// pane — the same active-pane rule CaptureWindowHistoryCtx targets: an
// alt-screen active pane means tmux holds no scrollback for the window's
// capture, so the export menu gates its server-capture row on this. False for
// a zero-pane window (never lies toward true).
func rollupAltScreen(panes []tmux.PaneInfo) bool {
	for _, p := range panes {
		if p.IsActive {
			return p.AltScreen
		}
	}
	return false
}

// deriveGitRoot resolves the window's code folder for the code lens/surface
// (docs/specs/right-panel.md): the ACTIVE pane's cwd, else the first pane's
// cwd, else the window's worktree path — the same precedence as api/riff.go's
// windowCwd (duplicated here because api imports this package, not vice
// versa) — walked up via config.FindGitRoot (a pure filesystem stat-walk, no
// subprocess — Constitution I needs no timeout here). Keyed by git ROOT when
// one exists, not window id: editor state follows the code, and two windows
// on one worktree deliberately share one editor state. Falls back to the raw
// cwd when it sits outside any repo (the same "toplevel, else cwd" pattern as
// cmd/rk/code.go's codeTargetFolder), so non-git windows stay code-capable.
// Returns "" only when no cwd is resolvable at all (zero panes, no worktree
// path).
func deriveGitRoot(w *tmux.WindowInfo) string {
	cwd := w.WorktreePath
	if len(w.Panes) > 0 {
		if first := w.Panes[0].Cwd; first != "" {
			cwd = first
		}
		for _, p := range w.Panes {
			if p.IsActive {
				if p.Cwd != "" {
					cwd = p.Cwd
				}
				break
			}
		}
	}
	if cwd == "" {
		return ""
	}
	if root := config.FindGitRoot(cwd); root != "" {
		return root
	}
	return cwd
}

// windowBranchRepo returns the (repoDir, branch) to derive a window's PR from:
// the active pane's cwd/branch when the active pane is on a branch, else the
// first pane that has a resolved branch. A window is the UI unit that carries a
// single PrURL, and the active pane is its canonical representative. Returns
// ("", "") when no pane has a resolved branch.
func windowBranchRepo(w *tmux.WindowInfo) (repoDir, branch string) {
	// Prefer the active pane.
	for i := range w.Panes {
		if w.Panes[i].IsActive && w.Panes[i].GitBranch != "" {
			return w.Panes[i].Cwd, w.Panes[i].GitBranch
		}
	}
	// Fall back to the first pane with a branch.
	for i := range w.Panes {
		if w.Panes[i].GitBranch != "" {
			return w.Panes[i].Cwd, w.Panes[i].GitBranch
		}
	}
	return "", ""
}

// windowPRKey is the (repoDir, branch) pair enrichWindowPR registers and joins
// on. It keys on the GIT ROOT of the branch-supplying pane, not its raw cwd: a
// pane cd-ing between subdirectories of one worktree must keep hitting the same
// (repoDir, branch) entry, or every cd blanks the PR fields until the refresher
// resolves a brand-new pair. The root is resolved from the SAME pane that
// supplied the branch (not w.GitRoot, which follows the active pane) so the two
// halves of the key always describe one repo. FindGitRoot is a pure stat-walk —
// no subprocess, hot-path safe. A cwd outside any repo falls back to the raw
// cwd key; no branch yields ("", "").
func windowPRKey(w *tmux.WindowInfo) (repoDir, branch string) {
	repoDir, branch = windowBranchRepo(w)
	if branch == "" || repoDir == "" {
		// A branch with no cwd carries no joinable identity — and FindGitRoot("")
		// would stat a relative ".git" against the server's own working directory.
		return "", ""
	}
	if root := config.FindGitRoot(repoDir); root != "" {
		repoDir = root
	}
	return repoDir, branch
}

// enrichWindowPR populates the window's PrURL/PrNumber (and a fallback PrState)
// from its branch (Constitution §X — PR links are derivable, not pushed):
// any pane on a branch with a PR (open, merged, or closed) gets its link, in
// any repo, under any workflow.
//
// CRITICAL — this runs on the SSE hot path (FetchSessions), so it does ZERO
// network/subprocess work: it (a) REGISTERS the (repoDir, branch) pair with the
// prstatus background refresher — a cheap, lock-guarded set touch — and (b)
// JOINS the last-good derived PR from the refresher's in-memory snapshot. The
// actual `gh pr list` resolution happens off-tick on the refresher goroutine
// (see internal/prstatus.BranchRefresher). A window with no branch is skipped; a
// branch not yet resolved, with no PR, or gh absent leaves the fields nil.
//
// PrState is seeded as a FALLBACK from the branch-derived state so that the
// authoritative viewer-wide collector (sse.attachPRStatus, keyed by PR URL) can
// override it on a hit but a MISS does not strand PrState empty. Without this, a
// branch-derived CLOSED PR outside the viewer's top-$limit collector window
// would carry prNumber set + prState "" and the frontend's prOwnsDot would paint
// a solid done-square for a dead PR. MapBranchState maps unknown/empty to "" so
// an unconfident state never defaults to "open" and re-creates that bug.
//
// PrIsDraft is seeded the same way and for a sharper reason: the viewer-wide
// collector queries `viewer { pullRequests }`, so it only ever sees the
// AUTHENTICATED USER'S OWN PRs. A draft opened by a teammate is resolved by this
// branch channel (author-agnostic) but MISSES the URL join, so without this seed
// its prIsDraft stays false and the row glyph renders as a non-draft. The
// collector still overrides on a hit, and since it polls at 90s against this
// channel's 30s it can serve a briefly stale flag — accepted, and exactly how
// PrState already behaves.
func enrichWindowPR(w *tmux.WindowInfo) {
	repoDir, branch := windowPRKey(w)
	if branch == "" {
		return
	}
	// Report the pair so the background refresher resolves it (cheap; no exec).
	prstatus.Register(repoDir, branch)
	// Join the last-good result from the in-memory snapshot (no exec).
	if pr, ok := prstatus.SnapshotBranchPR(repoDir, branch); ok {
		url := pr.URL
		num := pr.Number
		w.PrURL = &url
		w.PrNumber = &num
		w.PrState = prstatus.MapBranchState(pr.State)
		w.PrIsDraft = pr.IsDraft
	}
}

// sessionData pairs a session's tmux info with its fresh window snapshot. It is
// the unit FetchSessions fans out per session and the input to the per-window
// enrichment passes (fab state, git branch, rollups).
type sessionData struct {
	info    tmux.SessionInfo
	windows []tmux.WindowInfo
}

// FetchSessions' tmux seams — package-level vars (the internal/tmux sweep-var
// idiom) so tests drive the fetch path with fakes instead of a live tmux
// server; production binds the internal/tmux functions verbatim.
var (
	listSessionsFn = tmux.ListSessions
	listClientsFn  = tmux.ListClients
	listWindowsFn  = tmux.ListWindows
	socketPathFn   = tmux.SocketPath
)

// FetchSessions fetches all sessions from the specified server, derives project
// roots from tmux, enriches with fab state, and applies the two-tier
// active-window derivation. The provider supplies the event-tracked active
// window per group (Tier 1); when it is nil or has no entry for a session's
// group, the base-session `#{window_active}` pointer parsed from tmux (Tier 2)
// stands. A nil provider therefore degrades to exactly today's behavior. The
// resolver joins relay-forked attach pids onto their conn facts (viewer kind
// "rk"); a nil resolver degrades every viewer to kind "tty".
func FetchSessions(ctx context.Context, server string, provider ActiveWindowProvider, resolve AttachResolver) ([]ProjectSession, error) {
	sessionInfos, err := listSessionsFn(ctx, server)
	if err != nil {
		return nil, err
	}

	if len(sessionInfos) == 0 {
		return []ProjectSession{}, nil
	}

	// Attached-viewer tier: one list-clients round-trip per fetch (same cost
	// class as the enumeration calls), folded onto sessions by group key. A
	// failure degrades to no viewers (log-and-continue) — the fetch itself
	// never fails on it.
	clients, err := listClientsFn(ctx, server)
	if err != nil {
		slog.Warn("list-clients failed; sessions carry no viewers", "server", server, "error", err)
	}
	viewers := foldViewers(clients, resolve)

	// Fetch windows for all sessions in parallel.
	data := make([]sessionData, len(sessionInfos))
	var wg sync.WaitGroup

	for i, info := range sessionInfos {
		wg.Add(1)
		go func(idx int, si tmux.SessionInfo) {
			defer wg.Done()
			windows, _ := listWindowsFn(ctx, si.Name, server)
			if windows == nil {
				windows = []tmux.WindowInfo{}
			}
			data[idx] = sessionData{info: si, windows: windows}
		}(i, info)
	}
	wg.Wait()

	// Away tier: per-window awayIn derivation runs ONCE across all sessions'
	// windows (@N is unique per server, so a foreign leaf may name a window in
	// any session of this server). Flatten, derive in place, split back.
	var allWindows []tmux.WindowInfo
	windowCounts := make([]int, len(data))
	for i := range data {
		windowCounts[i] = len(data[i].windows)
		allWindows = append(allWindows, data[i].windows...)
	}
	tmux.DeriveAwayIn(allWindows)
	pos := 0
	for i := range data {
		data[i].windows = allWindows[pos : pos+windowCounts[i]]
		pos += windowCounts[i]
	}

	// Collect all pane cwds for git branch resolution.
	var allCwds []string
	for _, sd := range data {
		for _, w := range sd.windows {
			for _, p := range w.Panes {
				allCwds = append(allCwds, p.Cwd)
			}
		}
	}
	gitBranches := gitinfo.ResolveBranches(ctx, allCwds)
	cwdMissing := resolveCwdMissing(allCwds)

	// The fab tier is derived natively from disk (cwd → .fab-status.yaml →
	// .status.yaml — see fabstate.go), fresh on every call: no subprocess, no
	// cross-request cache, so a stage transition repaints on the next fetch.
	// The memo dedupes reads within this one call (many panes share a worktree).
	fabMemo := newFabStateMemo()

	// The operator-watchlist tier: ONE tolerant read of the fab-owned operator
	// state file per fetch (server-scoped — no per-cwd memo needed, unlike the
	// fab tier), yielding two projections: the pane-bearing not-done subset
	// joined onto windows by pane ID via joinWatchlist, and the whole tracked
	// list stamped onto every session as OperatorTracked (display only — the
	// Operator Tasks segment's data). The read's last_tick_at doubles as the
	// per-server staleness timestamp populated identically on every
	// ProjectSession below. The file name is the slugified SOCKET PATH, not the
	// server name (fab's naming — a cross-repo contract, see
	// cron.FabOperatorSlug); a failed socket-path query degrades to the
	// "default" slug, fab's own cold-name fallback, and is never surfaced.
	var watchlistByPane map[string]cron.WatchlistEntry
	var operatorLastTickAt int64
	var operatorTracked *[]OperatorTrackedItem
	slug := "default"
	if sock, sockErr := socketPathFn(ctx, server); sockErr == nil {
		slug = cron.FabOperatorSlug(sock)
	}
	if opPath, err := cron.FabOperatorStatePath(slug); err == nil {
		state, present := cron.ReadOperatorState(opPath)
		if present {
			operatorLastTickAt = state.LastTickAt
			entries := state.WatchlistEntries()
			watchlistByPane = make(map[string]cron.WatchlistEntry, len(entries))
			for _, we := range entries {
				watchlistByPane[we.Pane] = we
			}
			tracked := projectTrackedItems(state.Items, paneToWindowMap(data))
			operatorTracked = &tracked
		}
	}

	// Build result with per-window fab enrichment and git branches.
	nowUnix := time.Now().Unix()
	operatorStale := operatorStaleness(operatorLastTickAt, nowUnix)
	result := make([]ProjectSession, len(data))
	for i, sd := range data {
		// Watchlist tier: the operator-watchlist join by pane ID, over all of the
		// session's windows in one pass.
		joinWatchlist(sd.windows, watchlistByPane)
		for j := range sd.windows {
			// Fab tier proper (change/stage/displayState) from the native
			// per-pane derivation, rolled up to the window (change-bound pane
			// wins, else the first pane carrying one).
			fab := fabMemo.windowState(sd.windows[j].Panes)
			sd.windows[j].FabChange = fab.change
			sd.windows[j].FabStage = fab.stage
			sd.windows[j].FabDisplayState = fab.displayState
			for k := range sd.windows[j].Panes {
				cwd := sd.windows[j].Panes[k].Cwd
				if branch, ok := gitBranches[cwd]; ok {
					sd.windows[j].Panes[k].GitBranch = branch
				}
				if cwdMissing[cwd] {
					sd.windows[j].Panes[k].CwdMissing = true
				}
			}
			// Generic agent-state tier (260705-dmex): window-level rollup over
			// the panes' @rk_agent_state (waiting > active > idle), with the
			// idle/waiting duration computed rk-side from the epoch.
			sd.windows[j].AgentState, sd.windows[j].AgentIdleDuration = rollupAgentState(sd.windows[j].Panes, nowUnix)
			// Agent session identity tier (260713-nh86): window-level rollup
			// over the panes' reconciled @rk_pane_agent_session (active pane
			// first, else first set). Per-pane truth is preserved on the Panes
			// entries; both ride the existing ProjectSession marshal to
			// GET /api/sessions and SSE event: sessions.
			sd.windows[j].AgentProvider, sd.windows[j].AgentSessionRef = rollupAgentSession(sd.windows[j].Panes)
			// Conversation-access tier: whether the rolled-up identity resolves
			// to a readable conversation — the provider has a registered
			// transcript adapter AND the bounded lookup succeeds. Derived ONCE
			// per identified window (never per pane); every failure degrades to
			// false. Gates the transcript-backed operator actions (fix-tab-name)
			// so identity-only providers never advertise them.
			sd.windows[j].ConversationAvailable = deriveConversationAvailable(sd.windows[j].AgentProvider, sd.windows[j].AgentSessionRef)
			// Alt-screen tier (260820-4le0): the ACTIVE pane's alternate_on,
			// rolled up to the window so the export menu's server-capture row
			// can be honest about panes where tmux holds no scrollback.
			sd.windows[j].AltScreen = rollupAltScreen(sd.windows[j].Panes)
			// Code-lens availability tier (260811-k3vp): the window's git root,
			// derived from its active pane's cwd (Constitution II/X — nothing
			// stored, nothing pushed). Empty when the cwd is not a repo.
			sd.windows[j].GitRoot = deriveGitRoot(&sd.windows[j])
			// PR-from-branch derivation (260705-dmex): register the window's
			// branch with the prstatus refresher and join its last-good PR from
			// the in-memory snapshot — no subprocess on this hot path.
			enrichWindowPR(&sd.windows[j])
		}

		// Two-tier active-window derivation. The user-facing session name IS
		// the session-group key (parseSessions keeps the leader whose name ==
		// #{session_group}, or an ungrouped session keyed by its own name —
		// matching parseSessionGroups/parseActiveWindowsByGroup). Tier 1: if
		// the provider reports a tracked @wid for this group, it overrides the
		// base-pointer flag (authoritative). Tier 2: otherwise the parsed
		// #{window_active} flag stands. A nil provider is a no-op (Tier 2).
		if provider != nil {
			if trackedWid, ok := provider.ActiveWindow(server, sd.info.Name); ok {
				applyActiveWindow(sd.windows, trackedWid)
			}
		}

		result[i] = ProjectSession{Name: sd.info.Name, SessionColor: sd.info.Color, SessionID: sd.info.ID, SessionPath: sd.info.Path, Flair: sd.info.Flair, Windows: sd.windows, Hidden: operatorSessionHidden(sd.info.Name, sd.windows), Viewers: viewers[sd.info.Name], OperatorLastTickAt: operatorLastTickAt, OperatorStale: operatorStale, OperatorTracked: operatorTracked}
	}

	return result, nil
}

// ProjectRoot derives the project root from the target window identified by its
// stable window ID. It resolves the owning session from the window ID, then
// returns that window's worktree path. Falls back to the session's first window
// when the ID is not found among the enumerated windows.
func ProjectRoot(ctx context.Context, windowID, server string) (string, error) {
	session, err := tmux.ResolveWindowSession(ctx, server, windowID)
	if err != nil {
		return "", err
	}

	windows, err := tmux.ListWindows(ctx, session, server)
	if err != nil {
		return "", err
	}
	if len(windows) == 0 {
		return "", nil
	}

	for _, w := range windows {
		if w.WindowID == windowID {
			return w.WorktreePath, nil
		}
	}
	// Fall back to first window
	return windows[0].WorktreePath, nil
}
