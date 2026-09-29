package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/user"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"rk/internal/config"
	"rk/internal/cron"
	"rk/internal/daemon"
	"rk/internal/gui"
	"rk/internal/mcp"
	"rk/internal/metrics"
	"rk/internal/ports"
	"rk/internal/prreview"
	"rk/internal/prstatus"
	"rk/internal/riff"
	"rk/internal/sessions"
	"rk/internal/settings"
	"rk/internal/snapshot"
	"rk/internal/tmux"
	"rk/internal/updatecheck"
	"rk/internal/validate"
	"rk/internal/wt"
	"rk/internal/wtdiff"
)

const (
	// statusRefreshMinInterval is the server-side minimum interval between forced
	// refreshes started by POST /api/status/refresh. This handler is the single
	// frequency-control choke point, so ANY trigger (button-mashing, multiple
	// tabs, future auto-triggers) is safe to over-fire: a call arriving within
	// this window returns 202 without starting a refresh. Mash-safe and well
	// under both poller tick cadences (viewer 90s, branch 30s).
	statusRefreshMinInterval = 10 * time.Second
	// statusRefreshTimeout bounds the detached refresh goroutine's own context.
	// The viewer collector's gh call is 10s-bounded internally; the branch pass
	// is one gh-per-registered-pair, so 60s bounds the whole pass without
	// truncating it. NOT r.Context() (which dies when the handler returns).
	statusRefreshTimeout = 60 * time.Second
)

// SessionFetcher fetches enriched session data.
type SessionFetcher interface {
	FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error)
}

// TmuxOps defines tmux operations used by handlers.
type TmuxOps interface {
	CreateSession(name, cwd, server string) error
	KillSession(session, server string) error
	KillSessionCtx(ctx context.Context, server, session string) error
	RenameSession(session, name, server string) error
	CreateWindow(session, name, cwd, server string) error
	KillWindow(windowID, server string) error
	MoveWindow(windowID string, targetIndex int, server string) error
	MoveWindowToSession(windowID, dstSession, server string) error
	RenameWindow(windowID, name, server string) error
	SendKeys(windowID, keys, server string) error
	SendKeysToPane(ctx context.Context, paneID, server string, keys ...string) error
	SelectWindowInSession(session, windowID, server string) error
	ListWindows(ctx context.Context, session, server string) ([]tmux.WindowInfo, error)
	ResolveWindowSession(ctx context.Context, server, windowID string) (string, error)
	// EnsureIsoSession returns (creating on demand) the window's single-window
	// isolated relay session `_rk-iso-<id>` for an `open` op with isolate:true
	// (see tmux.EnsureIsoSession); SessionClientCount backs the attach-failure
	// rollback, which kills a freshly ensured iso session only when no other
	// isolated viewer is attached to it.
	EnsureIsoSession(ctx context.Context, server, windowID string) (string, error)
	SessionClientCount(ctx context.Context, server, session string) (int, error)
	// ActiveWindowID reads the session's post-select active window id (@N);
	// handleWindowSelect composes its response body from it, falling back to
	// the requested id when the read fails.
	ActiveWindowID(ctx context.Context, server, session string) (string, error)
	HasSession(ctx context.Context, server, session string) bool
	SplitWindow(windowID string, horizontal bool, cwd string, server string) (string, error)
	SelectPane(paneID, server string) error
	KillActivePane(windowID, server string) error
	SetSessionColor(session string, colorValue string, server string) error
	UnsetSessionColor(session string, server string) error
	SetSessionFlair(session string, flair string, server string) error
	UnsetSessionFlair(session string, server string) error
	SetWindowColor(windowID string, colorValue string, server string) error
	UnsetWindowColor(windowID, server string) error
	ListServers(ctx context.Context) ([]string, error)
	ListSessions(ctx context.Context, server string) ([]tmux.SessionInfo, error)
	KillServer(server string) error
	ListKeys(server string) ([]string, error)
	SetWindowOption(ctx context.Context, windowID, server, option, value string) error
	UnsetWindowOption(ctx context.Context, windowID, server, option string) error
	SetWindowOptions(ctx context.Context, windowID, server string, ops []tmux.WindowOptionOp) error
	// SetWindowLayouts writes several windows' @rk_win_layout in ONE
	// \;-chained invocation — the borrow/return two-tab write (pairs apply in
	// slice order; the holder's removal comes first).
	SetWindowLayouts(ctx context.Context, server string, pairs []tmux.WindowLayoutWrite) error
	// ClearWindowRoleExceptOnServer is the server-scoped @rk_win_role radio clear:
	// it unsets the role option on every window of the server except
	// keepWindowID (see tmux.ClearWindowRoleExcept) and returns the cleared
	// window IDs so the caller can demote displaced carriers.
	ClearWindowRoleExceptOnServer(ctx context.Context, server, keepWindowID string) ([]string, error)
	// MoveWindowIntoOperatorSessionOnServer / DemoteWindowFromOperatorSessionOnServer
	// are the physical promotion halves of the @rk_win_role contract: role-set moves
	// the window into the per-server operator session, role-clear moves a member
	// back out to its cwd-basename session (see tmux.MoveWindowIntoOperatorSession
	// / tmux.DemoteWindowFromOperatorSession).
	MoveWindowIntoOperatorSessionOnServer(ctx context.Context, server, windowID string) error
	DemoteWindowFromOperatorSessionOnServer(ctx context.Context, server, windowID string) error
	CreateWindowWithOptions(session, name, cwd, server string, ops []tmux.WindowOptionOp) error
	GetSessionOrder(ctx context.Context, server string) ([]string, error)
	SetSessionOrder(ctx context.Context, server string, order []string) error
	GetServerRank(ctx context.Context, server string) (*int, error)
	SetServerRank(ctx context.Context, server string, rank int) error
	// ReadServerMarks is the batched per-server option read backing
	// GET /api/servers — one show-options -s dump carries rank, ephemeral,
	// protected, and managed (see tmux.ServerMarks).
	ReadServerMarks(ctx context.Context, server string) (tmux.ServerMarks, error)
	IsEphemeralServer(ctx context.Context, server string) (bool, error)
	// IsGuardedServer is the combined kill-guard predicate (rk-daemon by
	// derivation ∨ @rk_protected); Mark/UnmarkServerProtected write the
	// @rk_protected mark for the protect toggle endpoint.
	IsGuardedServer(ctx context.Context, server string) (bool, error)
	MarkServerProtected(ctx context.Context, server string) error
	UnmarkServerProtected(ctx context.Context, server string) error
	// IsManagedServer is the combined managed-class predicate (rk-daemon by
	// derivation ∨ @rk_srv_managed); Mark/UnmarkServerManaged write the
	// @rk_srv_managed provenance mark for the adopt endpoint (Unmark exists only
	// as the adopt-failure rollback), and ReloadConfig sources the managed
	// conf onto the server.
	IsManagedServer(ctx context.Context, server string) (bool, error)
	MarkServerManaged(ctx context.Context, server string) error
	UnmarkServerManaged(ctx context.Context, server string) error
	ReloadConfig(server string) error
	ListBoards(ctx context.Context) ([]tmux.BoardSummary, error)
	GetBoard(ctx context.Context, name string) ([]tmux.BoardEntry, error)
	ListBoardEntries(ctx context.Context, server string) ([]tmux.BoardEntry, error)
	PinBoard(ctx context.Context, server, windowID, board string) error
	UnpinBoard(ctx context.Context, server, windowID, board string) error
	ReorderBoard(ctx context.Context, server, windowID, board, before, after string) (string, error)
	// Pane-injection primitives backing the shared inject engine (see send.go).
	// Pane-targeted, in contrast to the window-targeted SendKeys used by POST
	// /keys. CapturePane is surfaced here for capture-based probes. Each takes
	// the caller's context so the handler threads one shared deadline across
	// paste, submit verification, and recovery rather than granting each
	// subprocess its own timeout.
	// ClearPaneMode is the pane-mode guard the engine runs first on every
	// delivery (a copy-mode pane would eat the paste; see tmux.ClearPaneModeCtx).
	ClearPaneMode(ctx context.Context, paneID, server string) error
	SetAgentSendBuffer(ctx context.Context, text, server string) error
	PasteAgentSendBuffer(ctx context.Context, paneID, server string) error
	PasteAgentSendBufferRaw(ctx context.Context, paneID, server string) error
	SendEnterToPane(ctx context.Context, paneID, server string) error
	CapturePane(ctx context.Context, paneID string, lines int, server string) (string, error)
	// CaptureWindowHistory serves GET /api/windows/{windowId}/history: the full
	// scrollback (`capture-pane -p -S -`) of the window's active pane, plain
	// text, bounded by the handler's request context.
	CaptureWindowHistory(ctx context.Context, target, server string) (string, error)
}

// RiffEngine is the web-facing seam onto the extracted spawn engine
// (internal/riff). It is a DEDICATED dependency — deliberately NOT folded into
// TmuxOps — so the shared mockTmuxOps (used by every handler test) is untouched
// and the riff handler gets its own focused mock. Mirrors the metrics/services/
// prStatus collector injection pattern.
type RiffEngine interface {
	Spawn(ctx context.Context, opts riff.Options) (riff.Result, error)
}

// prodRiffEngine wraps the internal/riff package for production use.
type prodRiffEngine struct{}

func (prodRiffEngine) Spawn(ctx context.Context, opts riff.Options) (riff.Result, error) {
	return riff.Spawn(ctx, opts)
}

// WtOps is the seam onto the internal/wt wrapper (Constitution III) used by
// the Open-in-App handlers. A DEDICATED dependency like RiffEngine — not
// folded into TmuxOps — so the shared mockTmuxOps stays untouched and the
// open handlers get their own focused stub.
type WtOps interface {
	ListApps(ctx context.Context) ([]wt.App, error)
	Open(ctx context.Context, path, app string) error
}

// prodWtOps wraps the internal/wt package for production use.
type prodWtOps struct{}

func (prodWtOps) ListApps(ctx context.Context) ([]wt.App, error) {
	return wt.ListApps(ctx)
}

func (prodWtOps) Open(ctx context.Context, path, app string) error {
	return wt.Open(ctx, path, app)
}

// Server holds handler dependencies.
type Server struct {
	logger   *slog.Logger
	sessions SessionFetcher
	tmux     TmuxOps
	riff     RiffEngine
	wt       WtOps
	hostname string
	// sshUser is the username the daemon runs as (os/user.Current at startup,
	// or SetSSHUser in tests), surfaced on GET /api/health so remote clients
	// can derive an SSH destination (`user@location.hostname`) when the
	// ssh_host setting is unset. Pure derivation per Constitution X — no
	// config. Empty on lookup failure = the frontend omits the `user@` prefix.
	sshUser string
	// codeServerPort is the RESOLVED code-server port (preset
	// RK_CODE_SERVER_PORT, else the RK_PORT+2 convention). Seeded from
	// config.Load() at startup; handed to the SSE hub, which probes it and
	// broadcasts the host-level {"reachable"} signal. Never leaves the server
	// — the frontend embeds via the stable /code/ route.
	codeServerPort int
	// listenPort is the RESOLVED daemon listen port (code default <
	// config.yaml `port` < RK_PORT), seeded from the same startup
	// config.Load() as codeServerPort. handleHealth advertises it as the
	// `tunnel` capability signal. Startup-fixed on purpose: the listener is
	// bound at startup, so a mid-run config.yaml edit must not move the
	// advertised port away from it (the change takes effect on the next
	// daemon restart — the registry key's `live: false` contract).
	listenPort int
	// autoNameEnabled arms the auto-name-on-idle trigger (the `auto_name` key
	// in the settings store, default off — the trigger injects prompts into
	// the operator on its own, so it is strictly opt-in). Seeded from
	// settings.Load() at startup as initSSEHub's initial apply; a settings
	// POST re-applies through the same seam, so a toggle takes live effect
	// without a daemon restart. A nil hub tracker is the feature-absent state
	// both tick sites already understand.
	autoNameEnabled bool
	metrics         *metrics.Collector
	services        *ports.Collector
	prStatus        *prstatus.Collector
	// prReview is the review surface's on-demand detail fetcher and
	// prReviewRefresh its per-PR forced-refresh choke point. Both are built
	// lazily on first use (api/pr_review.go): a daemon whose user never opens a
	// review tile allocates neither.
	prReview     *prreview.Fetcher
	prReviewOnce sync.Once
	// wtDiff is the working-directory surface's git reader. It holds no cache
	// — a working-tree read is two local subprocesses and ~50 ms — so it is
	// here only to avoid rebuilding the seam per request.
	wtDiff              *wtdiff.Reader
	wtDiffOnce          sync.Once
	prReviewRefresh     *prReviewRefreshState
	prReviewRefreshOnce sync.Once
	updateChecker       *updatecheck.Checker
	sseHub              *sseHub
	sseOnce             sync.Once
	// attachReloaded guards the pre-attach managed-conf reload: at most one
	// attempt per tmux server (keys are server names) per daemon lifetime.
	// The entry is released on a managed-check read failure so a transient
	// wobble retries on a later attach. See reloadConfigForAttach.
	attachReloaded sync.Map
	// attachRegistry annotates relay-forked attach pids with their conn facts
	// (viewer kind "rk"); prodSessionFetcher reads it through Lookup. Nil on
	// test-constructed Servers — Lookup is nil-receiver safe.
	attachRegistry *attachRegistry
	// version is the running daemon version (ldflags-injected main.version),
	// seeded once at startup via SetVersion. Read by handleRestart's dev guard
	// (a "dev" build must not bounce the real daemon out from under `just dev`'s
	// air process). In-memory only (Constitution II) — same lifetime as the
	// SSE version slot.
	version string

	// layoutWriteMu serializes the borrow/return endpoints' read-modify-write
	// (api/layout_borrow.go): holder lookup and the live-in-one-place check
	// run from one fetched window snapshot, so a concurrent request must not
	// interleave between fetchServerWindows and SetWindowLayouts and commit
	// from a stale read.
	layoutWriteMu sync.Mutex

	// Manual status-refresh (POST /api/status/refresh) — the single frequency
	// choke point for forced refreshes of BOTH PR pollers.
	//
	// refreshCollectorFn / refreshBranchFn are the two on-demand kicks. Function
	// fields (mirroring the collector-injection house pattern) so handler tests
	// can assert both fire without spawning gh. Defaulted in NewRouterAndServer;
	// nil is a no-op (either kick may be absent on a partially-wired server).
	refreshCollectorFn func(context.Context)
	refreshBranchFn    func(context.Context)

	// serverKillNotify, when non-nil, is invoked with the server name by
	// handleServerKill just before the audited tmux.KillServer — the layout
	// snapshotter uses it (SetServerKillNotifier) to mark the imminent
	// tombstone as an audited kill. Fire-and-forget write-path annotation.
	serverKillNotify func(server string)
	// snapshotStore backs the /api/recovery endpoints (see api/recovery.go):
	// the read-only offer listing and the user-initiated restore/dismiss
	// mutations. Wired by `rk serve` (SetSnapshotStore) from the same store
	// the snapshotter writes to; nil degrades recovery to empty offers.
	snapshotStore *snapshot.Store
	// refreshStatusMu guards the coalesce/throttle state below.
	refreshStatusMu sync.Mutex
	// refreshStatusInFlight is true while a detached refresh goroutine runs — a
	// concurrent POST coalesces onto it (no second refresh).
	refreshStatusInFlight bool
	// refreshStatusLast is the start time of the most recent forced refresh, used
	// for the min-interval throttle.
	refreshStatusLast time.Time
	// nowFn is a clock seam (defaults to time.Now) so throttle behavior is
	// deterministically testable without real sleeps.
	nowFn func() time.Time

	// cronFactsFn gathers per-entry resolved-target facts for GET /api/cron —
	// a live tmux read (production wires cron.GatherFactsLive). Nil (the test
	// router) degrades to no facts: every entry derives orphaned with no
	// backoff next-fire.
	cronFactsFn func(ctx context.Context, server string, entries []cron.Entry) cron.ServerFacts

	// The gui*Fn group is the injectable seam layer behind GET /api/gui/{id},
	// POST /api/gui/{id}/restart, POST /api/gui/{id}/launch,
	// POST /api/gui/{id}/resize, and the gui.enabled/gui.geometry settings POST
	// side effects (see api/gui.go and settings.go). Nil falls back to the
	// production daemon/gui calls, mirroring the hub's gui seams in sse.go.
	guiEnsureFn         func() (daemon.GUIEnsureOutcome, error)
	guiKillFn           func() (bool, error)
	guiRestartFn        func() error
	guiDaemonUpFn       func() bool
	guiSessionExistsFn  func(ctx context.Context) bool
	guiSessionOptionsFn func(ctx context.Context) (display, backend, wm string, ok bool)
	guiSessionCreatedFn func(ctx context.Context) (time.Time, bool)
	guiPanePidsFn       func(ctx context.Context) map[int]bool
	guiProbeFn          func(ctx context.Context, network, addr string) (gui.Info, error)
	guiAppsFn           func(display string, exclude map[int]bool) ([]gui.App, error)
	guiLookPathFn       func(name string) (string, error)
	guiStatFn           func(path string) (os.FileInfo, error)
	guiLaunchFn         func(argv, env []string) (int, error)
	guiXrandrRunFn      gui.DisplayRunner

	// tintCacheMu guards tintCache.
	tintCacheMu sync.Mutex
	// tintCache memoizes accent-tinted PWA assets (see api/pwa.go) keyed
	// "asset|descriptor". Each entry is a pure function of the fixed stock
	// bytes + descriptor — a memoization, not persistent state (Constitution
	// §II) — and the key space is bounded (10 owned families × 4 assets).
	// Lazily initialized by tintCached.
	tintCache map[string][]byte

	// mcpHandler is the MCP streamable-HTTP handler behind /mcp, wired by
	// `rk serve` via SetMCPHandler (the api package cannot import cmd/rk's
	// rootCmd, so the MCP server is built there). Nil answers 503 — see
	// handleMCP.
	mcpHandler http.Handler
}

// now returns the server clock, defaulting to time.Now when unseeded (the test
// router leaves nowFn nil).
func (s *Server) now() time.Time {
	if s.nowFn != nil {
		return s.nowFn()
	}
	return time.Now()
}

// initSSEHub lazily creates the SSE hub on first use.
func (s *Server) initSSEHub() {
	s.sseOnce.Do(func() {
		// A nil *prstatus.Collector must be passed as a nil interface so the
		// hub's nil check (no PR fields attached) works — wrap only when set.
		var pc PRStatusSnapshotter
		if s.prStatus != nil {
			pc = s.prStatus
		}
		s.sseHub = newSSEHub(s.sessions, s.metrics, s.services, pc)
		s.sseHub.codeServerPort = s.codeServerPort
		s.sseHub.getOperatorQueue().deliver = s.operatorQueueDeliver()
		s.sseHub.setAutoName(s.autoNameEnabled, s.autoNameDeliver())
		// PR-review comment listener seams. `enabled` is read at every tick so
		// the pr_review_listener settings key takes effect live, exactly like
		// cron_ticker.
		listener := s.sseHub.getPRReviewListener()
		listener.deliver = s.deliverPRReviewThread
		listener.unhandled = s.prReviewUnhandled
		listener.enabled = func() bool { return settings.Load().PrReviewListener }
		listener.disarm = s.disarmPRReviewListener
	})
}

// operatorQueueDeliver fetches fresh sessions inside the detached delivery
// worker, revalidates the queued request, renders current facts, and enters the
// shared prompt-level delivery core.
func (s *Server) operatorQueueDeliver() operatorQueueDeliver {
	return func(ctx context.Context, server string, request queuedOperatorRequest) error {
		snapshot, err := s.sessions.FetchSessions(ctx, server)
		if err != nil {
			return fmt.Errorf("%w: %v", errOperatorQueueFetch, err)
		}
		tmpl, ok := operatorTemplates[request.template]
		if !ok {
			return fmt.Errorf("operator template %q is no longer registered", request.template)
		}
		operator := findOperatorWindow(snapshot)
		if operator == nil {
			return &operatorReject{http.StatusNotFound, "no operator on this server"}
		}
		if request.windowID != "" {
			if tmpl.serverScoped {
				return fmt.Errorf("operator template %q is not window-scoped", request.template)
			}
			subject := findOperatorSubject(snapshot, request.windowID)
			if subject == nil {
				return &operatorReject{http.StatusNotFound, "window not found"}
			}
			if subject.Role == "operator" || subject == operator {
				return errors.New("operator window cannot be its own request subject")
			}
			return s.deliverOperatorRequest(ctx, server, subject, operator, tmpl, request.text)
		}
		if !tmpl.serverScoped {
			return fmt.Errorf("operator template %q is not server-scoped", request.template)
		}
		facts := buildServerOperatorFacts(snapshot, request.text)
		if request.session != "" {
			if !tmpl.acceptsSession {
				return fmt.Errorf("operator template %q does not accept a session scope", request.template)
			}
			var known bool
			facts, known = filterServerOperatorFacts(snapshot, facts, request.session)
			if !known {
				return fmt.Errorf("no session %s on this server", request.session)
			}
		}
		if tmpl.requiresWaiting && !hasWaitingOperatorFacts(facts) {
			return errors.New("nothing is waiting on this server")
		}
		return s.deliverOperatorPrompt(ctx, server, operator, tmpl.renderServer(facts), tmpl.chatDelivery)
	}
}

// autoNameDeliver builds the auto-name delivery closure: the shared
// operator-request delivery core (fact derivation, busy gate, pane resolution,
// injection — the same path the HTTP endpoint takes), always with the
// fix-tab-name template. The single builder keeps initSSEHub's startup apply
// and the settings POST's live re-apply on identical wiring.
func (s *Server) autoNameDeliver() func(ctx context.Context, server string, subject, operator *tmux.WindowInfo) error {
	return func(ctx context.Context, server string, subject, operator *tmux.WindowInfo) error {
		return s.deliverOperatorRequest(ctx, server, subject, operator, operatorTemplates["fix-tab-name"], "")
	}
}

// serverFromRequest extracts and validates the server query parameter from the
// request, defaulting to "default" if absent or invalid.
func serverFromRequest(r *http.Request) string {
	s := r.URL.Query().Get("server")
	if s == "" {
		return "default"
	}
	if validate.ValidateServerName(s) != "" {
		return "default"
	}
	return s
}

// prodSessionFetcher wraps the sessions package for production use. The
// provider, when set (after the tmuxctl Supervisor is up — see
// SetActiveWindowProvider), supplies the Tier-1 event-tracked active window. A
// nil provider degrades FetchSessions to Tier-2-only (base-pointer) behavior.
// The resolver joins relay-forked attach pids onto their conn facts (viewer
// kind "rk"); nil degrades every viewer to kind "tty".
type prodSessionFetcher struct {
	provider sessions.ActiveWindowProvider
	resolver sessions.AttachResolver
}

func (p *prodSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	return sessions.FetchSessions(ctx, server, p.provider, p.resolver)
}

// prodTmuxOps wraps the tmux package for production use.
type prodTmuxOps struct{}

func (p *prodTmuxOps) CreateSession(name, cwd, server string) error {
	return tmux.CreateSession(name, cwd, server)
}
func (p *prodTmuxOps) KillSession(session, server string) error {
	return tmux.KillSession(session, server)
}
func (p *prodTmuxOps) KillSessionCtx(ctx context.Context, server, session string) error {
	return tmux.KillSessionCtx(ctx, server, session)
}
func (p *prodTmuxOps) RenameSession(session, name, server string) error {
	return tmux.RenameSession(session, name, server)
}
func (p *prodTmuxOps) CreateWindow(session, name, cwd, server string) error {
	return tmux.CreateWindow(session, name, cwd, server)
}
func (p *prodTmuxOps) KillWindow(windowID, server string) error {
	return tmux.KillWindow(windowID, server)
}
func (p *prodTmuxOps) MoveWindow(windowID string, targetIndex int, server string) error {
	return tmux.MoveWindow(windowID, targetIndex, server)
}
func (p *prodTmuxOps) MoveWindowToSession(windowID, dstSession, server string) error {
	return tmux.MoveWindowToSession(windowID, dstSession, server)
}
func (p *prodTmuxOps) RenameWindow(windowID, name, server string) error {
	return tmux.RenameWindow(windowID, name, server)
}
func (p *prodTmuxOps) SendKeys(windowID, keys, server string) error {
	return tmux.SendKeys(windowID, keys, server)
}
func (p *prodTmuxOps) SendKeysToPane(ctx context.Context, paneID, server string, keys ...string) error {
	return tmux.SendKeysToPane(ctx, paneID, server, keys...)
}
func (p *prodTmuxOps) SelectWindowInSession(session, windowID, server string) error {
	return tmux.SelectWindowInSession(session, windowID, server)
}
func (p *prodTmuxOps) ListWindows(ctx context.Context, session, server string) ([]tmux.WindowInfo, error) {
	return tmux.ListWindows(ctx, session, server)
}
func (p *prodTmuxOps) ResolveWindowSession(ctx context.Context, server, windowID string) (string, error) {
	return tmux.ResolveWindowSession(ctx, server, windowID)
}
func (p *prodTmuxOps) EnsureIsoSession(ctx context.Context, server, windowID string) (string, error) {
	return tmux.EnsureIsoSession(ctx, server, windowID)
}
func (p *prodTmuxOps) SessionClientCount(ctx context.Context, server, session string) (int, error) {
	return tmux.SessionClientCount(ctx, server, session)
}
func (p *prodTmuxOps) ActiveWindowID(ctx context.Context, server, session string) (string, error) {
	return tmux.ActiveWindowID(ctx, server, session)
}
func (p *prodTmuxOps) HasSession(ctx context.Context, server, session string) bool {
	return tmux.HasSession(ctx, server, session)
}
func (p *prodTmuxOps) SplitWindow(windowID string, horizontal bool, cwd string, server string) (string, error) {
	return tmux.SplitWindow(windowID, horizontal, cwd, server)
}
func (p *prodTmuxOps) SelectPane(paneID, server string) error {
	return tmux.SelectPane(paneID, server)
}
func (p *prodTmuxOps) KillActivePane(windowID, server string) error {
	return tmux.KillActivePane(windowID, server)
}
func (p *prodTmuxOps) SetSessionColor(session string, colorValue string, server string) error {
	return tmux.SetSessionColor(session, colorValue, server)
}
func (p *prodTmuxOps) UnsetSessionColor(session string, server string) error {
	return tmux.UnsetSessionColor(session, server)
}
func (p *prodTmuxOps) SetSessionFlair(session string, flair string, server string) error {
	return tmux.SetSessionFlair(session, flair, server)
}
func (p *prodTmuxOps) UnsetSessionFlair(session string, server string) error {
	return tmux.UnsetSessionFlair(session, server)
}
func (p *prodTmuxOps) SetWindowColor(windowID string, colorValue string, server string) error {
	return tmux.SetWindowColor(windowID, colorValue, server)
}
func (p *prodTmuxOps) UnsetWindowColor(windowID, server string) error {
	return tmux.UnsetWindowColor(windowID, server)
}
func (p *prodTmuxOps) ListServers(ctx context.Context) ([]string, error) {
	return tmux.ListServers(ctx)
}
func (p *prodTmuxOps) ListSessions(ctx context.Context, server string) ([]tmux.SessionInfo, error) {
	return tmux.ListSessions(ctx, server)
}
func (p *prodTmuxOps) KillServer(server string) error {
	return tmux.KillServer(server)
}
func (p *prodTmuxOps) ListKeys(server string) ([]string, error) {
	return tmux.ListKeys(server)
}
func (p *prodTmuxOps) SetWindowOption(ctx context.Context, windowID, server, option, value string) error {
	return tmux.SetWindowOption(ctx, windowID, server, option, value)
}
func (p *prodTmuxOps) UnsetWindowOption(ctx context.Context, windowID, server, option string) error {
	return tmux.UnsetWindowOption(ctx, windowID, server, option)
}
func (p *prodTmuxOps) SetWindowOptions(ctx context.Context, windowID, server string, ops []tmux.WindowOptionOp) error {
	return tmux.SetWindowOptions(ctx, windowID, server, ops)
}
func (p *prodTmuxOps) SetWindowLayouts(ctx context.Context, server string, pairs []tmux.WindowLayoutWrite) error {
	return tmux.SetWindowLayouts(ctx, server, pairs)
}
func (p *prodTmuxOps) ClearWindowRoleExceptOnServer(ctx context.Context, server, keepWindowID string) ([]string, error) {
	return tmux.ClearWindowRoleExceptOnServer(ctx, server, keepWindowID)
}
func (p *prodTmuxOps) MoveWindowIntoOperatorSessionOnServer(ctx context.Context, server, windowID string) error {
	return tmux.MoveWindowIntoOperatorSessionOnServer(ctx, server, windowID)
}
func (p *prodTmuxOps) DemoteWindowFromOperatorSessionOnServer(ctx context.Context, server, windowID string) error {
	return tmux.DemoteWindowFromOperatorSessionOnServer(ctx, server, windowID)
}
func (p *prodTmuxOps) CreateWindowWithOptions(session, name, cwd, server string, ops []tmux.WindowOptionOp) error {
	return tmux.CreateWindowWithOptions(session, name, cwd, server, ops)
}
func (p *prodTmuxOps) GetSessionOrder(ctx context.Context, server string) ([]string, error) {
	return tmux.GetSessionOrder(ctx, server)
}
func (p *prodTmuxOps) SetSessionOrder(ctx context.Context, server string, order []string) error {
	return tmux.SetSessionOrder(ctx, server, order)
}
func (p *prodTmuxOps) GetServerRank(ctx context.Context, server string) (*int, error) {
	return tmux.GetServerRank(ctx, server)
}
func (p *prodTmuxOps) SetServerRank(ctx context.Context, server string, rank int) error {
	return tmux.SetServerRank(ctx, server, rank)
}
func (p *prodTmuxOps) ReadServerMarks(ctx context.Context, server string) (tmux.ServerMarks, error) {
	return tmux.ReadServerMarks(ctx, server)
}
func (p *prodTmuxOps) IsEphemeralServer(ctx context.Context, server string) (bool, error) {
	return tmux.IsEphemeralServer(ctx, server)
}
func (p *prodTmuxOps) IsGuardedServer(ctx context.Context, server string) (bool, error) {
	return tmux.IsGuardedServer(ctx, server)
}
func (p *prodTmuxOps) MarkServerProtected(ctx context.Context, server string) error {
	return tmux.MarkServerProtected(ctx, server)
}
func (p *prodTmuxOps) UnmarkServerProtected(ctx context.Context, server string) error {
	return tmux.UnmarkServerProtected(ctx, server)
}
func (p *prodTmuxOps) IsManagedServer(ctx context.Context, server string) (bool, error) {
	return tmux.IsManagedServer(ctx, server)
}
func (p *prodTmuxOps) MarkServerManaged(ctx context.Context, server string) error {
	return tmux.MarkServerManaged(ctx, server)
}
func (p *prodTmuxOps) UnmarkServerManaged(ctx context.Context, server string) error {
	return tmux.UnmarkServerManaged(ctx, server)
}
func (p *prodTmuxOps) ReloadConfig(server string) error {
	return tmux.ReloadConfig(server)
}
func (p *prodTmuxOps) ListBoards(ctx context.Context) ([]tmux.BoardSummary, error) {
	return tmux.ListBoards(ctx)
}
func (p *prodTmuxOps) GetBoard(ctx context.Context, name string) ([]tmux.BoardEntry, error) {
	return tmux.GetBoard(ctx, name)
}
func (p *prodTmuxOps) ListBoardEntries(ctx context.Context, server string) ([]tmux.BoardEntry, error) {
	return tmux.ListBoardEntries(ctx, server)
}
func (p *prodTmuxOps) PinBoard(ctx context.Context, server, windowID, board string) error {
	return tmux.Pin(ctx, server, windowID, board)
}
func (p *prodTmuxOps) UnpinBoard(ctx context.Context, server, windowID, board string) error {
	return tmux.Unpin(ctx, server, windowID, board)
}
func (p *prodTmuxOps) ClearPaneMode(ctx context.Context, paneID, server string) error {
	return tmux.ClearPaneModeCtx(ctx, paneID, server)
}
func (p *prodTmuxOps) SetAgentSendBuffer(ctx context.Context, text, server string) error {
	return tmux.SetAgentSendBufferCtx(ctx, text, server)
}
func (p *prodTmuxOps) PasteAgentSendBuffer(ctx context.Context, paneID, server string) error {
	return tmux.PasteAgentSendBufferCtx(ctx, paneID, server)
}
func (p *prodTmuxOps) PasteAgentSendBufferRaw(ctx context.Context, paneID, server string) error {
	return tmux.PasteAgentSendBufferRawCtx(ctx, paneID, server)
}
func (p *prodTmuxOps) SendEnterToPane(ctx context.Context, paneID, server string) error {
	return tmux.SendEnterToPaneCtx(ctx, paneID, server)
}
func (p *prodTmuxOps) CapturePane(ctx context.Context, paneID string, lines int, server string) (string, error) {
	return tmux.CapturePaneCtx(ctx, paneID, lines, server)
}
func (p *prodTmuxOps) CaptureWindowHistory(ctx context.Context, target, server string) (string, error) {
	return tmux.CaptureWindowHistoryCtx(ctx, target, server)
}

// ReorderBoard locates the (server, windowID, board) entry, computes a new
// order key strictly between the supplied neighbours via fractional indexing,
// and writes it back. Returns the new key on success.
func (p *prodTmuxOps) ReorderBoard(ctx context.Context, server, windowID, board, before, after string) (string, error) {
	beforeKey, afterKey, err := lookupNeighbourKeys(ctx, p, board, before, after)
	if err != nil {
		return "", err
	}
	newKey, err := tmux.ComputeOrderKey(beforeKey, afterKey)
	if err != nil {
		return "", err
	}
	if err := tmux.Reorder(ctx, server, windowID, board, newKey); err != nil {
		return "", err
	}
	return newKey, nil
}

// lookupNeighbourKeys translates neighbour windowIDs into their order keys on
// the named board, resolving them against the board's entries aggregated across
// ALL reachable servers — mirroring handleGetBoard's cross-server aggregation
// (a board spans servers, so a neighbour pinned from a different server than the
// moved pane is a legitimate on-board neighbour). Either neighbour may be empty
// (prepend/append). A non-empty neighbour ID absent from the board on EVERY
// server returns errNeighbourNotFound.
func lookupNeighbourKeys(ctx context.Context, ops interface {
	ListServers(ctx context.Context) ([]string, error)
	ListBoardEntries(ctx context.Context, server string) ([]tmux.BoardEntry, error)
}, board, beforeID, afterID string) (string, string, error) {
	servers, err := ops.ListServers(ctx)
	if err != nil {
		return "", "", err
	}
	if len(servers) == 0 {
		servers = []string{"default"}
	}
	// Aggregate the board's (windowID → orderKey) map across every server. A
	// windowID is unique per tmux server but a board spans servers, so the
	// neighbour may live on a different server than the moved pane. Collisions
	// across servers are not a concern here: neighbours are addressed by the
	// same windowIDs the client read from GET /api/boards/{name} (itself a
	// cross-server aggregation), so a last-writer-wins map matches that source.
	keys := map[string]string{}
	for _, srv := range servers {
		entries, lerr := ops.ListBoardEntries(ctx, srv)
		if lerr != nil {
			// Skip an unreachable server rather than failing the whole lookup —
			// matches GetBoard/ListBoards, which log-and-continue per server.
			// Without the log, an unreachable server that happens to hold the
			// neighbour silently degrades to a 400; the warning leaves a trace.
			slog.Warn("board: ListBoardEntries failed", "server", srv, "err", lerr)
			continue
		}
		for _, e := range entries {
			if e.Board == board {
				keys[e.WindowID] = e.OrderKey
			}
		}
	}
	beforeKey := ""
	afterKey := ""
	if beforeID != "" {
		k, ok := keys[beforeID]
		if !ok {
			return "", "", errNeighbourNotFound
		}
		beforeKey = k
	}
	if afterID != "" {
		k, ok := keys[afterID]
		if !ok {
			return "", "", errNeighbourNotFound
		}
		afterKey = k
	}
	return beforeKey, afterKey, nil
}

// errNeighbourNotFound is returned when reorder is called with a neighbour
// windowID that has no entry on the target board+server.
var errNeighbourNotFound = neighbourNotFoundError{}

type neighbourNotFoundError struct{}

func (neighbourNotFoundError) Error() string { return "neighbour window not found on board" }

// NewRouter creates the chi router with all middleware and routes.
// Uses production dependencies (live tmux, real session fetcher).
// The ctx controls the lifecycle of background goroutines (e.g., metrics collector).
// cfg is the caller's single startup-resolved config snapshot — the Server
// never re-loads config, so the bound listener, /api/health's advertised
// tunnel port, and the /code/ proxy target can never diverge.
func NewRouter(ctx context.Context, logger *slog.Logger, cfg config.Config) chi.Router {
	router, _ := NewRouterAndServer(ctx, logger, cfg)
	return router
}

// NewRouterAndServer is the variant of NewRouter that also returns the
// underlying *Server, so callers (`rk serve`) can wire in additional hooks
// such as the tmuxctl WindowChangeSubscriber once their Supervisor is up.
// cfg is the caller's startup-resolved config snapshot (see NewRouter).
func NewRouterAndServer(ctx context.Context, logger *slog.Logger, cfg config.Config) (chi.Router, *Server) {
	hostname, _ := os.Hostname()

	// The daemon's own username, for the frontend's derived SSH destination
	// (the fallback when the ssh_host setting is unset). Best-effort: a failed
	// lookup leaves it empty and the health response omits the field.
	sshUser := ""
	if u, err := user.Current(); err == nil {
		sshUser = u.Username
	}

	mc := metrics.NewCollector(metricsPollInterval)
	mc.Start(ctx)

	svc := ports.NewCollector(servicesPollInterval)
	svc.Start(ctx)

	pc := prstatus.NewCollector(prStatusPollInterval)
	// Seed the branch refresher's viewer head-index from the collector's ONE
	// batched GraphQL call: the batch already carries every recent
	// viewer-authored PR's head repo + ref, so the refresher can JOIN most
	// observed pairs instead of spawning a `gh pr list` per pair. Wired BEFORE
	// pc.Start so the collector's immediate first refresh has somewhere to land.
	//
	// The cold-start guarantee does NOT rest on this ordering: the collector's first
	// fetch completes at an unpredictable time relative to the first SSE
	// registrations (and on the restart path the registrations win), so
	// StoreViewerIndex itself wakes the refresher after a non-empty store. Either
	// arrival order converges on one debounced index-served pass. NewTestRouter
	// leaves this unwired — an unseeded index simply misses and every pair falls
	// back to gh.
	pc.SetViewerPRSink(prstatus.DefaultBranchRefresher.StoreViewerIndex)

	// Disk seed: pre-fill both pollers' last-good state from
	// $XDG_STATE_HOME/hexokit/prstatus.json and attach the write hooks, BEFORE either
	// Start — the cold-start machinery above is network-gated, so a restart while
	// gh is slow/offline/rate-limited would otherwise start blank. The seed is
	// never authoritative (the immediate first fetch replaces it wholesale,
	// authoritative negatives included) and a missing/corrupt file is a silent
	// cold start. NewTestRouter leaves this unwired — unit tests never touch the
	// real state dir.
	prstatus.AttachSeedCache(pc, prstatus.DefaultBranchRefresher)

	pc.Start(ctx)

	// The thread digest's SCOPE guard (spec pr-review.md § R3): threads are
	// fetched only for the PRs live windows actually resolve to, never for the
	// viewer's 100 most recent. Both consumers — the listener's predicate and
	// the toggle's dot — are per-window questions, so the viewer-wide shape was
	// paying ~40x for an answer nobody asked. PositiveEntries IS that live set:
	// the pairs the refresher resolved for observed panes.
	pc.SetLivePRSource(func() []string {
		entries := prstatus.DefaultBranchRefresher.PositiveEntries()
		urls := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.PR.URL != "" {
				urls = append(urls, entry.PR.URL)
			}
		}
		return urls
	})
	pc.StartThreads(ctx, prstatus.DefaultThreadInterval)

	// Branch→PR refresher: resolves observed (repo, branch) pairs
	// to their open PR on a background tick so the SSE hot path (which only
	// registers pairs + joins the snapshot) never spawns gh. Started next to the
	// viewer-wide collector; both exit on ctx cancellation.
	prstatus.DefaultBranchRefresher.Start(ctx)

	registry := &attachRegistry{byPID: map[int]sessions.AttachMeta{}}
	s := &Server{
		logger:          logger,
		sessions:        &prodSessionFetcher{resolver: registry.Lookup},
		tmux:            &prodTmuxOps{},
		riff:            prodRiffEngine{},
		wt:              prodWtOps{},
		hostname:        hostname,
		sshUser:         sshUser,
		codeServerPort:  cfg.ResolvedCodeServerPort(), // 0 = degenerate config (probe off)
		listenPort:      cfg.Port,
		autoNameEnabled: settings.Load().AutoName,
		metrics:         mc,
		services:        svc,
		prStatus:        pc,
		cronFactsFn:     cron.GatherFactsLive,
		attachRegistry:  registry,
	}
	// Wire the two on-demand PR-refresh kicks for POST /api/status/refresh. The
	// collector kick nil-guards its own pointer (a partially-wired server may
	// have none); the branch kick targets the process-wide default refresher
	// Start()ed above.
	s.refreshCollectorFn = func(ctx context.Context) {
		if s.prStatus != nil {
			s.prStatus.RefreshNow(ctx)
		}
	}
	s.refreshBranchFn = prstatus.DefaultBranchRefresher.RefreshNow
	return s.buildRouter(), s
}

// NewTestRouter creates a chi router with injectable dependencies for testing.
// The riff engine is left nil (the riff handler tests inject one directly via
// NewTestRouterWithRiff); riff-unrelated tests never reach it.
func NewTestRouter(logger *slog.Logger, sf SessionFetcher, ops TmuxOps, hostname string) chi.Router {
	s := &Server{
		logger:   logger,
		sessions: sf,
		tmux:     ops,
		hostname: hostname,
	}
	seedTestPorts(s)
	return s.buildRouter()
}

// seedTestPorts seeds the startup-resolved ports the way NewRouterAndServer
// does, so test routers resolve them exactly once at construction — a later
// env/config change inside the test must not move /code/ or `tunnel`, just
// like a mid-run edit cannot move them in production.
func seedTestPorts(s *Server) {
	cfg := config.Load()
	s.listenPort = cfg.Port
	s.codeServerPort = cfg.ResolvedCodeServerPort()
}

// NewTestRouterAndServer is NewTestRouter plus the *Server, so tests can
// drive the setter-wired surfaces (SetMCPHandler).
func NewTestRouterAndServer(logger *slog.Logger, sf SessionFetcher, ops TmuxOps, hostname string) (chi.Router, *Server) {
	s := &Server{
		logger:   logger,
		sessions: sf,
		tmux:     ops,
		hostname: hostname,
	}
	seedTestPorts(s)
	return s.buildRouter(), s
}

// NewTestRouterWithRiff is NewTestRouter plus an injected RiffEngine, used by the
// riff handler tests to supply a mock engine without touching the shared
// TmuxOps/mockTmuxOps surface.
func NewTestRouterWithRiff(logger *slog.Logger, sf SessionFetcher, ops TmuxOps, engine RiffEngine, hostname string) chi.Router {
	s := &Server{
		logger:   logger,
		sessions: sf,
		tmux:     ops,
		riff:     engine,
		hostname: hostname,
	}
	seedTestPorts(s)
	return s.buildRouter()
}

// NewTestRouterWithWt is NewTestRouter plus an injected WtOps, used by the
// open handler tests to stub the wt wrapper (mirrors NewTestRouterWithRiff).
func NewTestRouterWithWt(logger *slog.Logger, sf SessionFetcher, ops TmuxOps, wtOps WtOps, hostname string) chi.Router {
	s := &Server{
		logger:   logger,
		sessions: sf,
		tmux:     ops,
		wt:       wtOps,
		hostname: hostname,
	}
	seedTestPorts(s)
	return s.buildRouter()
}

// SetSSHUser seeds the derived daemon username surfaced on GET /api/health.
// Production wiring reads it from os/user.Current in NewRouterAndServer;
// tests use this seam directly (mirrors SetVersion).
func (s *Server) SetSSHUser(user string) {
	s.sshUser = user
}

// SetMCPHandler wires the MCP streamable-HTTP handler behind /mcp (the
// SetVersion/SetUpdateChecker precedent — called by `rk serve` before
// ListenAndServe). Until set, /mcp answers 503 (see handleMCP).
func (s *Server) SetMCPHandler(h http.Handler) {
	s.mcpHandler = h
}

func (s *Server) buildRouter() chi.Router {
	r := chi.NewRouter()

	// Middleware stack
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// API routes
	r.Get("/api/health", s.handleHealth)
	r.Get("/api/sessions", s.handleSessionsList)
	r.Post("/api/sessions", s.handleSessionCreate)
	r.Get("/api/sessions/order", s.handleSessionOrderGet)
	r.Post("/api/sessions/order", s.handleSessionOrderPost)
	r.Get("/api/boards", s.handleBoardsList)
	r.Get("/api/boards/{name}", s.handleBoardGet)
	r.Post("/api/boards/{name}/pin", s.handleBoardPin)
	r.Post("/api/boards/{name}/unpin", s.handleBoardUnpin)
	r.Post("/api/boards/{name}/reorder", s.handleBoardReorder)
	// Cron — server-scoped schedule entries: entries + derived facts (GET) and
	// the create/delete/mute/pin/edit mutations (POST per §IX), each mutation waking the
	// SSE hub explicitly (file writes emit no tmux event). See api/cron.go.
	r.Get("/api/cron", s.handleCronList)
	r.Post("/api/cron/create", s.handleCronCreate)
	r.Post("/api/cron/delete", s.handleCronDelete)
	r.Post("/api/cron/mute", s.handleCronMute)
	r.Post("/api/cron/pin", s.handleCronPin)
	r.Post("/api/cron/edit", s.handleCronEdit)
	r.Post("/api/sessions/{session}/color", s.handleSessionColor)
	r.Post("/api/sessions/{session}/flair", s.handleSessionFlair)
	r.Post("/api/sessions/{session}/kill", s.handleSessionKill)
	r.Post("/api/sessions/{session}/rename", s.handleSessionRename)
	r.Post("/api/sessions/{session}/sort-windows", s.handleSessionSortWindows)
	r.Post("/api/sessions/{session}/windows", s.handleWindowCreate)
	r.Post("/api/windows/{windowId}/kill", s.handleWindowKill)
	r.Post("/api/windows/{windowId}/move", s.handleWindowMove)
	r.Post("/api/windows/{windowId}/move-to-session", s.handleWindowMoveToSession)
	r.Post("/api/windows/{windowId}/rename", s.handleWindowRename)
	r.Post("/api/windows/{windowId}/options", s.handleWindowOptions)
	// Cross-tab layout verbs — a surface is live in one tab; moving it is a
	// server-recomputed two-window write chained in one tmux invocation. See
	// api/layout_borrow.go.
	r.Post("/api/layout/borrow", s.handleLayoutBorrow)
	r.Post("/api/layout/return", s.handleLayoutReturn)
	// Web-tab verbs (POST only, §IX) — see api/windows_web.go.
	r.Post("/api/windows/{windowId}/web", s.handleWindowWebAdd)
	r.Post("/api/windows/{windowId}/web/{n}/remove", s.handleWindowWebRemove)
	r.Post("/api/windows/{windowId}/web/{n}/select", s.handleWindowWebSelect)
	r.Post("/api/windows/{windowId}/web/{n}/move", s.handleWindowWebMove)
	r.Post("/api/windows/{windowId}/keys", s.handleWindowKeys)
	r.Post("/api/windows/{windowId}/send", s.handleWindowSend)
	r.Post("/api/windows/{windowId}/select", s.handleWindowSelect)
	r.Post("/api/windows/{windowId}/split", s.handleWindowSplit)
	r.Post("/api/windows/{windowId}/close-pane", s.handleClosePaneKill)
	// Operator actuation seam — templated work items delivered to the server's
	// operator window via the shared injection engine (see api/send.go and
	// api/operator.go).
	r.Post("/api/windows/{windowId}/operator-request", s.handleOperatorRequest)
	// Server-scoped half of the seam — templates with no subject window. See
	// api/operator.go.
	r.Post("/api/operator-request", s.handleServerOperatorRequest)
	// Start the server's operator window — execs this daemon's own binary as
	// `rk operator -L <server> --json` and answers on the JSON receipt. See
	// api/operator_start.go.
	r.Post("/api/operator/start", s.handleOperatorStart)
	r.Get("/api/windows/{windowId}/history", s.handleWindowHistory)
	// Derived per-tab .code-workspace file — read-shaped ensure (GET, §IX); the
	// ONLY daemon-side writer of workspace files. See api/codeworkspace.go.
	r.Get("/api/windows/{windowId}/code-workspace", s.handleCodeWorkspace)
	// The first-boot rescue's status read: extension-installed + the tab's
	// newest pid-alive host-record stamp, derived per request. See
	// api/codebridge.go.
	r.Get("/api/windows/{windowId}/code-bridge", s.handleCodeBridge)
	// Conversation fork — a new window in the SAME session + directory, resuming
	// the window's agent session with --fork-session. See api/fork.go.
	r.Post("/api/windows/{windowId}/fork", s.handleWindowFork)
	// Recently-closed windows — the kill-seam ring (read GET; mutations POST per
	// §IX). See api/closed.go.
	r.Get("/api/windows/closed", s.handleClosedList)
	r.Post("/api/windows/closed/{id}/reopen", s.handleClosedReopen)
	r.Post("/api/windows/closed/{id}/dismiss", s.handleClosedDismiss)
	r.Post("/api/windows/closed/{id}/resume", s.handleClosedResume)
	r.Get("/api/directories", s.handleDirectories)
	r.Post("/api/sessions/{session}/upload", s.handleUpload)
	r.Post("/api/preview-scope", s.handlePreviewScope)
	r.Post("/api/tmux/reload-config", s.handleTmuxReloadConfig)
	r.Post("/api/tmux/init-conf", s.handleTmuxInitConf)
	r.Post("/api/status/refresh", s.handleStatusRefresh)
	// The `review` surface (docs/specs/pr-review.md § R4). Reads GET, every
	// mutation POST (Constitution IX); the file list and the file body are
	// separate reads so a 200-file PR renders without tokenizing any of them.
	r.Get("/api/diff", s.handleDiff)
	r.Get("/api/diff/file", s.handleDiffFile)
	r.Get("/api/pr/review", s.handlePRReview)
	r.Get("/api/pr/review/file", s.handlePRReviewFile)
	r.Post("/api/pr/review/comment", s.handlePRReviewComment)
	r.Post("/api/pr/review/thread", s.handlePRReviewThread)
	r.Post("/api/pr/review/listen", s.handlePRReviewListen)
	r.Post("/api/pr/review/refresh", s.handlePRReviewRefresh)
	r.Post("/api/update", s.handleUpdate)
	r.Post("/api/updates/check", s.handleUpdatesCheck)
	r.Post("/api/restart", s.handleRestart)
	r.Post("/api/code-server/restart", s.handleCodeServerRestart)

	// Riff — web-UI agent spawn (POST) + preset list (GET). See api/riff.go.
	r.Post("/api/riff", s.handleRiffSpawn)
	r.Get("/api/riff/presets", s.handleRiffPresets)

	// Open-in-App — host app registry (GET, fail-silent) + validated launch
	// (POST per §IX). See api/open.go.
	r.Get("/api/open-apps", s.handleOpenApps)
	r.Post("/api/open", s.handleOpen)

	// Server management routes
	r.Get("/api/servers", s.handleServersList)
	r.Post("/api/servers", s.handleServerCreate)
	r.Post("/api/servers/order", s.handleServerOrderPost)
	r.Post("/api/servers/kill", s.handleServerKill)
	r.Post("/api/servers/protect", s.handleServerProtect)
	r.Post("/api/servers/adopt", s.handleServerAdopt)
	r.Post("/api/servers/wake", s.handleServerWake)

	// Recovery — reboot-orphaned server offers (read-only GET) plus the
	// user-initiated restore/dismiss mutations (POST per §IX). See
	// api/recovery.go.
	r.Get("/api/recovery", s.handleRecoveryList)
	r.Post("/api/recovery/restore", s.handleRecoveryRestore)
	r.Post("/api/recovery/dismiss", s.handleRecoveryDismiss)

	// Keybindings
	r.Get("/api/keybindings", s.handleKeybindings)

	// Settings (global, not per-server) — one registry-driven surface:
	// GET returns registry metadata + current values; POST is a partial merge
	// (present keys set, null unsets) per Constitution IX.
	r.Get("/api/settings", s.handleGetSettings)
	r.Post("/api/settings", s.handlePostSettings)

	// GUI surface — the status document (GET, incl. the apps list the
	// off-confirm renders), the supervisor restart, the allowlisted
	// terminal/browser launcher, the live desktop resize, and the no-op ping
	// (POST per §IX). On/off ride POST /api/settings (the gui.enabled side
	// effect). See api/gui.go.
	r.Get("/api/gui/{id}", s.handleGuiStatus)
	r.Post("/api/gui/{id}/restart", s.handleGuiRestart)
	r.Post("/api/gui/{id}/launch", s.handleGuiLaunch)
	r.Post("/api/gui/{id}/resize", s.handleGuiResize)
	r.Post("/api/gui/{id}/ping", s.handleGuiPing)

	// Web Push: VAPID key (read), subscribe + notify (mutations, POST per §IX)
	r.Get("/api/push/vapid-public-key", s.handlePushVAPIDPublicKey)
	r.Post("/api/push/subscribe", s.handlePushSubscribe)
	r.Post("/api/notify", s.handleNotify)

	// Frame-refusal probe — read-only header fetch for the web tile's
	// embedding check (absolute external URLs only). See api/framecheck.go.
	r.Get("/api/frame-check", s.handleFrameCheck)

	// Reverse proxy for iframe windows
	r.HandleFunc("/proxy/{port}/*", s.handleProxy)
	r.HandleFunc("/proxy/{port}", s.handleProxy)

	// Content route for `rk present` file/dir targets — the serve root is
	// derived from tmux at request time (Constitution II/X). One handler
	// serves BOTH arms, sniffed on the first path segment's shape (chi cannot
	// distinguish /present/{seg}/* forms, so the sniff is the disambiguator):
	// ^@[0-9]+$ → the legacy slot form /present/@N/{n}/{path}?server= (one
	// release — n-less maps to slot 1, slot-1 dual-reads the retired
	// @rk_win_present_root); otherwise → the new content-keyed form
	// /present/{server}/{roothash}/{path} resolving against the server's
	// declared roots (see api/present.go).
	r.HandleFunc("/present/{windowId}/*", s.handlePresent)
	r.HandleFunc("/present/{windowId}", s.handlePresent)

	// The stable code-server route — same proxy machinery as
	// /proxy/{port} with a FIXED pathname (workspace-state identity); the port
	// is resolved server-side and never appears in a URL.
	r.HandleFunc("/code/*", s.handleCode)
	r.HandleFunc("/code", s.handleCode)

	// State socket — muxed session-state + host-metrics stream (replaces the
	// retired GET /api/sessions/stream SSE edge; see api/state_ws.go).
	r.Get("/ws/state", s.handleStateWS)

	// Terminals socket — muxed terminal I/O: ONE WebSocket per tab carrying all
	// pane relay streams (replaces the retired per-pane GET /relay/{windowId} +
	// handleRelay; see api/terminals_ws.go).
	r.Get("/ws/terminals", s.handleTerminalsWS)

	// GUI relay — the raw RFB byte stream of the host desktop over WS (binary
	// frames only; the backend never listens on TCP itself). See api/gui_ws.go.
	r.Get("/ws/gui/{id}", s.handleGuiWS)

	// Web-tile tunnel — dials target TCP from this host and pipes bytes over
	// the socket (Origin-less clients only). See api/tunnel_ws.go.
	r.Get("/ws/tunnel", s.handleTunnelWS)

	// MCP streamable-HTTP transport — POST (client→server), GET (SSE stream),
	// DELETE (session end) on ONE path, the single recorded Constitution IX
	// exception (docs/specs/api.md § MCP). chi's Handle matches every method;
	// the SDK handler answers 405 for anything else. CORS stays
	// [GET POST OPTIONS]: MCP clients are not browsers, and rs/cors passes a
	// non-preflight DELETE through without headers. See api/mcp.go.
	r.Handle(mcp.HTTPRoutePath, http.HandlerFunc(s.handleMCP))

	// PWA identity assets — explicit GET routes registered BEFORE the SPA
	// catch-all so the instance accent (config.yaml instance_color, read per
	// request) can tint the manifest, Dock icons, and tab favicon; with no
	// owned accent these serve the stock bytes byte-identically. See api/pwa.go.
	r.Get("/manifest.json", s.handleManifest)
	r.Get("/generated-icons/favicon.svg", s.handleFavicon)
	r.Get("/generated-icons/icon-192.png", s.handleGeneratedIcon)
	r.Get("/generated-icons/icon-512.png", s.handleGeneratedIcon)
	r.Get("/generated-icons/icon-512-maskable.png", s.handleGeneratedIcon)

	// SPA static serving — catch-all, must be last
	s.mountSPA(r)

	return r
}

// writeJSON writes a JSON response with the given status code.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeError writes a JSON error response.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeErrorCode(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": msg, "code": code})
}
