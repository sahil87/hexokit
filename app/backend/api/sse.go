package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"rk/internal/daemon"
	"rk/internal/gui"
	"rk/internal/metrics"
	"rk/internal/ports"
	"rk/internal/prstatus"
	"rk/internal/push"
	"rk/internal/sessions"
	"rk/internal/settings"
	"rk/internal/tmux"
	"rk/internal/updatecheck"
	"rk/internal/validate"
)

// SessionOrderFetcher reads the persisted session order for a tmux server.
// Injected into the SSE hub so tests can stub the tmux dependency.
type SessionOrderFetcher interface {
	GetSessionOrder(ctx context.Context, server string) ([]string, error)
}

type prodSessionOrderFetcher struct{}

func (prodSessionOrderFetcher) GetSessionOrder(ctx context.Context, server string) ([]string, error) {
	return tmux.GetSessionOrder(ctx, server)
}

// PRStatusSnapshotter supplies the current in-memory PR-status map, keyed by
// canonical PR URL (PR numbers are only unique per repo — see prstatus.Collector).
// Injected into the SSE hub so the poll path can attach live PR status to any
// window with a derived PR via a PURE in-memory read — the hot path makes no
// network call. Implemented by *prstatus.Collector; a narrow interface lets
// tests stub it and lets the hub degrade gracefully (nil → no PR fields).
//
// UnhandledThreads is the review-thread DIGEST half of the same collector pass
// (it costs no additional gh call — internal/prstatus/prstatus_threads.go). It
// rides this interface rather than a second injection point because both
// methods are pure in-memory reads of one snapshot, taken at the same moment.
type PRStatusSnapshotter interface {
	Snapshot() map[string]prstatus.PRStatus
	UnhandledThreads(prURL string) []prstatus.ReviewThread
}

// boardEventName is the SSE event type for board-membership changes. Matches
// the kebab-case convention established by `event: session-order`.
const boardEventName = "board-changed"

// metricsOnlyServer is the reserved client key for a server-neutral,
// metrics-only SSE stream (opened with `?metrics=1`, no `server`). Such a
// client wants ONLY the server-independent `event: metrics` broadcast — it has
// no associated tmux server, so the poll loop skips session-fetching and
// reaping for it (there is no socket to poll or reap) while the metrics
// broadcast, which fans out to every registered client, still reaches it. This
// backs the Host host-console home (`/`), which shows host health with zero
// attached servers. The leading NUL makes it impossible to collide with a real
// tmux server name (validated to a safe charset by ValidateServerName).
const metricsOnlyServer = "\x00metrics-only"

// boardChangedPayload is the body of `event: board-changed` for explicit
// pin/unpin/reorder mutations. Board membership changes only through these
// mutations (each handler emits its own event), so there is no synthetic
// cleanup or bootstrap variant.
type boardChangedPayload struct {
	Board    string `json:"board"`
	Change   string `json:"change"` // "pin" | "unpin" | "reorder"
	Server   string `json:"server"`
	WindowID string `json:"windowId,omitempty"`
	OrderKey string `json:"orderKey,omitempty"`
}

const (
	// safetyPollInterval is the safety-net cadence for snapshot rebuilds
	// when no control-mode subscriber is available (PTY-unavailable
	// container, tmux predating control-mode notifications, brief
	// reconnect gap). The primary driver is the per-server tmuxctl Client;
	// see WindowChangeSubscriber.
	safetyPollInterval = 12 * time.Second
	// legacyPollInterval is the pre-tmuxctl poll cadence. It remains in
	// effect when no WindowChangeSubscriber is wired (PTY-unavailable
	// host, or unit tests that exercise the hub without a control-mode
	// driver) — under those conditions the snapshot-rebuild cadence is
	// the only freshness guarantee.
	legacyPollInterval = 2500 * time.Millisecond
	// metricsPollInterval is the cadence at which metrics.Collector polls
	// host CPU/memory. Kept separate from the SSE intervals so the
	// metrics sampling frequency is not coupled to the SSE event/safety
	// cadences — both have independent freshness requirements.
	metricsPollInterval = 2500 * time.Millisecond
	// servicesPollInterval is the cadence at which ports.Collector re-reads
	// the host's listening TCP ports (procfs + lsof on Linux, lsof on darwin).
	// Same cadence as metrics — both are host-global broadcasts riding the
	// server-neutral stream — but kept as its own constant so the two can
	// diverge later.
	servicesPollInterval = 2500 * time.Millisecond
	// prStatusPollInterval is the cadence at which prstatus.Collector makes
	// its single batched `gh` call. Deliberately slow (~40 calls/hr vs. the
	// 5000/hr authenticated limit) — the SSE hot path reads the cached
	// snapshot, never gh, so PR-status freshness is decoupled from the SSE
	// cadence. On-demand refresh (POST /api/status/refresh) covers the
	// "I want it now" case.
	prStatusPollInterval = 90 * time.Second
	sseCacheTTL          = 500 * time.Millisecond
	// ssePollConcurrency bounds how many per-server poll units run
	// concurrently. Parallelism is across servers, NEVER within one tmux
	// server (its command channel serializes anyway — concurrent execs
	// against one server only pile up forks). The bound caps daemon fork
	// pressure during server storms (e.g. a test suite spawning tmux
	// servers faster than the loop drains them); 6 covers realistic
	// live-server counts while keeping worst-case concurrent tmux execs low.
	ssePollConcurrency = 6
	// sseEventDebounce bounds the event-driven derive rate: after a control-mode
	// subscriber generation bump, waitForNext absorbs further bumps for this
	// window so a burst (rename churn from agent panes) coalesces into ONE
	// derive pass. Explicit wake() signals bypass it (a wake ends a pending
	// window immediately), and the safety timers and sseCacheTTL are independent
	// of it — it sits only between "bump observed" and "cache invalidated".
	sseEventDebounce = 300 * time.Millisecond
	// There are no SSE heartbeat/lifetime constants: both /ws/state and
	// /ws/terminals handle keepalive + liveness at the WebSocket layer.
)

// WindowChangeSubscriber is the interface the SSE hub uses to receive
// notifications that a server's tmux state has changed. Production
// implementations bridge into internal/tmuxctl.Client via the Supervisor;
// tests can implement it directly with a channel.
//
// Generation semantics mirror tmuxctl.Client: every observed notification
// increments the counter. Wait(after) returns a channel that closes once
// generation > after.
type WindowChangeSubscriber interface {
	Generation(server string) int64
	Wait(server string, after int64) <-chan struct{}
	// Covers reports whether this subscriber has a live control-mode driver
	// for the named server. A covered server is woken event-driven (its Wait
	// channel fires on tmux notifications), so the SSE loop can afford the long
	// safety-net interval. An UNcovered server (no Client — e.g. rk-test-*
	// servers the supervisor skips, or PTY-unavailable hosts) has no event
	// driver, so the safety-net timer is its ONLY freshness source and must run
	// at the fast cadence. See safetyIntervalEffective.
	Covers(server string) bool
}

// cachedResult holds a cached FetchSessions result with a timestamp.
type cachedResult struct {
	data      []sessions.ProjectSession
	fetchedAt time.Time
}

// sseClient is a single per-(connection, server-key) subscription record in the
// hub's routing index (`h.clients[serverKey]`). Since the state-socket migration
// (260716-qf3j) it is no longer a whole client connection — one state-socket
// connection (stateConn) holds one sseClient per subscribed server key (plus one
// for the metrics-only sentinel key), ALL sharing the connection's single send
// channel (`ch`). Per-server events fan out over `h.clients[server]` (these
// records); host-global events fan out over `h.stateConns` (once per connection)
// so a multi-subscription connection never receives a global event twice.
type sseClient struct {
	ch      chan hubEvent
	server  string
	dropped bool
	// conn is a back-pointer to the owning connection, so removeClient can drop
	// the record from its parent's subscription set. nil for the bare test
	// clients that construct an sseClient directly without a stateConn.
	conn *stateConn
	// connID is the client-supplied connection identifier (the `conn` id from the
	// `hello` frame), consistent with the per-connection relay identity model. It
	// is how POST /api/preview-scope (and the in-band preview-scope op) addresses
	// this exact connection. Empty when the client sent no conn id (then its
	// expanded set can never be set — it captures nothing).
	connID string
	// expanded is the set of session names this connection currently has
	// expanded in the tile grid FOR THIS SERVER. Preview capture is bounded to
	// windows in these sessions. In-memory only (Constitution II); dropped on
	// disconnect. Guarded by sseHub.mu.
	expanded map[string]bool
}

// stateConn is one state-socket (`/ws/state`) connection. It owns a single send
// channel shared by all its per-server subscription records, tracks its
// subscriptions for teardown, and is the unit of host-global event fan-out. The
// writer pump in handleStateWS drains `ch`.
type stateConn struct {
	ch     chan hubEvent
	connID string
	// subs maps a subscribed server key (a real server name or the
	// metricsOnlyServer sentinel) to its routing record in h.clients. Guarded by
	// sseHub.mu.
	subs    map[string]*sseClient
	dropped bool
}

// maxConnIDLen bounds the client-supplied `conn` query param. A legitimate id
// is a UUID (36 chars); anything longer is rejected so an oversized value can't
// waste memory as a map key. Over-cap ids fall back to empty (capture-nothing).
const maxConnIDLen = 128

// normalizeConnID trims surrounding whitespace from a client-supplied conn id
// and rejects over-long values. Since connID is the lookup key for POST
// /api/preview-scope, an untrimmed or absurdly long value would make the
// connection effectively unaddressable (a scope POST could never match it) and
// waste memory. Invalid input falls back to "" (empty = capture-nothing), the
// same as opening the stream without a conn id.
func normalizeConnID(raw string) string {
	id := strings.TrimSpace(raw)
	if len(id) > maxConnIDLen {
		return ""
	}
	return id
}

// orderBootstrapMaxAttempts caps how many times poll() will try to read
// @rk_srv_session_order from tmux when previous reads errored. Limits the blast
// radius of a hung or misbehaving tmux while still recovering from transient
// failures. After the cap is hit the bootstrap stops attempting; a successful
// POST (which populates previousOrderJSON via broadcast) re-establishes the
// cache without needing the bootstrap.
const orderBootstrapMaxAttempts = 3

type sseHub struct {
	mu sync.RWMutex
	// clients is the per-server routing index: each entry is a subscription
	// record (sseClient) whose channel is its owning connection's shared channel.
	// Per-server events fan out over this map.
	clients map[string][]*sseClient
	// stateConns is the set of live state-socket connections, the unit of
	// host-global event fan-out (once per connection, never once per
	// subscription). A connection is added on hello and dropped on disconnect.
	stateConns             map[*stateConn]bool
	previousJSON           map[string]string            // per-server sessions JSON dedup cache (the last SENT payload — ack/replay snapshots read it)
	previousSessionsKey    map[string]string            // per-server sessions dedup key: the payload rendered with ActivityTimestamp zeroed on active windows (the client renders no timestamp there)
	previousOrderJSON      map[string]string            // per-server session-order event payload cache (only present when populated by a successful read or a POST broadcast)
	orderBootstrapAttempts map[string]int               // per-server count of failed bootstrap attempts; capped at orderBootstrapMaxAttempts
	previousRealSessions   map[string]map[string]bool   // per-server prior-tick real (non-anchor) session names for disappearance logging
	previousPreviewJSON    map[string]map[string]string // per-server latest {windowId → preview text} snapshot (union of all clients' expanded windows); seeds cached-on-connect delivery
	cache                  map[string]*cachedResult     // per-server session fetch cache (500ms TTL)
	polling                bool
	fetcher                SessionFetcher
	orderFetcher           SessionOrderFetcher
	metrics                *metrics.Collector
	cachedMetricsJSON      string // latest metrics JSON for new clients
	services               *ports.Collector
	cachedServicesJSON     string // latest listening-services JSON for new clients
	// cachedServerOrderJSON is the latest server-global `event: server-order`
	// payload. Unlike previousOrderJSON (per-server @rk_srv_session_order), server
	// rank order is a HOST-global concern, so it is a single slot fanned to
	// EVERY client (incl. the `?metrics=1` metrics-only stream) and replayed on
	// connect — mirroring cachedMetricsJSON / cachedServicesJSON.
	cachedServerOrderJSON string
	// cachedBoardOrderJSON is the latest server-global `event: board-order`
	// payload. Like cachedServerOrderJSON, board display order is a HOST-global
	// concern (a board is an emergent cross-server aggregate), so it is a single
	// slot fanned to EVERY client (incl. the `?metrics=1` metrics-only stream)
	// and replayed on connect — NOT the per-server `board-changed` event.
	cachedBoardOrderJSON string
	// cachedVersionJSON is the server-global `event: version` payload — the
	// running daemon version. It is set ONCE from SetVersion (the version cannot
	// change for the process lifetime), so unlike the order slots there is no
	// broadcast/poll path: it is replayed on connect only, fanned to EVERY client
	// (incl. the `?metrics=1` metrics-only stream) — exactly the moment the client
	// needs it (the reload guard keys off SSE reconnect). Empty until SetVersion.
	cachedVersionJSON string
	// cachedUpdateAvailableJSON is the server-global `event: update-available`
	// payload published whenever the periodic checker's composite key changes.
	// Like the order slots it is a single cached slot fanned to EVERY client
	// (incl. `?metrics=1`) and replayed on connect for late-joining clients,
	// updated via broadcastUpdateAvailable. It holds the LATEST verdict — a
	// populated match OR a CLEARED verdict (empty tools/key) once a match is
	// consumed — so a reconnecting tab never replays a stale consumed match
	// (R8). Empty until the first check changes the key.
	cachedUpdateAvailableJSON string
	// codeServerPort is the RESOLVED code-server port (preset
	// RK_CODE_SERVER_PORT, else the RK_PORT+2 convention; 0 = degenerate
	// config = nothing is probed or broadcast). Set post-construction by
	// initSSEHub from the Server's config seed (the hub's many test
	// constructions keep the 4-arg newSSEHub shape). Probe-only since
	// 260811-a2bo — the broadcast payload carries just reachability; the port
	// stays server-private behind the /code route.
	codeServerPort int
	// codeServerProbeAt/codeServerReachable are the TTL-cached reachability
	// probe result (guarded by h.mu; only the poll loop writes). The probe is a
	// bare TCP dial of 127.0.0.1:{port} — never a per-request dial
	// (Constitution X; intake k3vp §2).
	codeServerProbeAt   time.Time
	codeServerReachable bool
	// cachedCodeServerJSON is the latest host-global `event: code-server`
	// payload ({"reachable"}), replayed on connect like
	// cachedServicesJSON so late-joining clients see the signal immediately.
	cachedCodeServerJSON string
	// The guiEnabled/guiProbeAt/guiInfo/guiBackend/guiDisplay/guiWM/guiViewers/
	// cachedGuiJSON group implements the host-global `event: gui` slot
	// (mirroring the code-server slot). guiEnabled and guiGeometry are re-read
	// from the settings file behind the settingsStamp gate — a CLI-side
	// `rk gui on` writes the file directly and must surface without a settings
	// POST. guiProbeAt/guiInfo
	// are the TTL-cached probe result; guiBackend/guiDisplay/guiWM are the
	// supervisor's stamped session options from the last probe pass (the
	// viewers>0 short-circuit keeps the last values — the stamps do not
	// change while the session lives);
	// guiViewers counts live /ws/gui/{id} relay connections (≥ 1 viewer
	// skips the probe dial — the live relay is stronger evidence, and each
	// dial would log accept/close lines into the supervisor pane).
	// cachedGuiJSON replays to late joiners like cachedCodeServerJSON.
	// Guarded by h.mu; only the poll loop, setGUIEnabled, and the relay's
	// viewer bookkeeping write.
	guiEnabled    bool
	guiGeometry   string
	guiProbeAt    time.Time
	guiInfo       gui.Info
	guiBackend    string
	guiDisplay    string
	guiWM         string
	guiViewers    map[string]int
	cachedGuiJSON string
	// cachedGuiKey is the dedup key beside cachedGuiJSON: the same payload
	// with HumanInputAgoMS flattened to a presence marker — the age moves
	// every tick once a viewer has driven the display and no stream consumer
	// reads it, so it must not defeat change-only emission.
	cachedGuiKey string
	// settingsStamp/settingsCache/settingsLoaded gate guiTick's settings
	// re-read behind a settings.Stamp fingerprint: the file is parsed on the
	// first tick and again only when the stamp moves (a CLI-side `rk gui on`
	// writes the file directly, so the POST path is not the only writer).
	settingsStamp  string
	settingsCache  settings.Settings
	settingsLoaded bool
	// guiLocked is the host resolution pin (@rk_gui_lock) as of the last
	// probe pass (read beside the stamps). guiHumanInput is the
	// last-relayed-human-input timestamp per id, written by the relay's
	// filter callback — in-memory only; the fact exists nowhere on disk and
	// dies with the daemon (Constitution X's in-flight carve-out).
	guiLocked     bool
	guiHumanInput map[string]time.Time
	// prStatus, when non-nil, supplies the in-memory PR-status snapshot the
	// poll path joins onto change-bound windows. nil degrades gracefully (no
	// PR fields attached) — used by tests and when no collector is wired.
	prStatus PRStatusSnapshotter

	// waitingPush tracks per-window `waiting` episodes and fires one Web Push per
	// sustained-waiting episode from the poll seam (260706-y1ar). In-memory only.
	waitingPush *waitingPushTracker

	// operatorQueue holds bounded user-initiated requests until a tick observes
	// the server's operator idle. It is always present and process-memory only.
	operatorQueue *operatorQueueTracker

	// prReviewListener holds unhandled PR review threads for ARMED windows
	// (@rk_win_pr_listen) until a tick observes that window's agent idle, then
	// dispatches ONE into the window's own agent pane. Always present and
	// process-memory only; a nil deliver closure (the test-hub shape) tracks
	// without fanning out.
	prReviewListener *prReviewListenerTracker

	// autoName tracks per-window busy→idle transitions and hands the server's
	// operator window an automatic fix-tab-name request (rate-limited, skipped
	// when the operator is busy) from the same poll seam (260822-q675).
	// In-memory only. nil means the feature is absent (the settings
	// `auto_name` key is off) — the tick sites skip on nil. A nil test-hub
	// tracker means delivery is skipped while transition tracking and live
	// keys still advance.
	//
	// Read/write ONLY through getAutoName/setAutoName: the poll loop reads
	// while a settings POST swaps the pointer from an HTTP handler goroutine,
	// so every access must hold autoNameMu. The tracker is otherwise
	// self-contained once published (own mutex; deliver closure wired by the
	// publisher), so callers use the snapshot without holding the lock.
	autoNameMu sync.Mutex
	autoName   *autoNameTracker

	// subscriber, when non-nil, provides per-server Wait(after) channels
	// driven by tmux control-mode notifications. When nil, the loop runs
	// on the safety-net ticker only — preserves correctness for tests and
	// for the PTY-unavailable startup case.
	//
	// Guarded by h.mu: SetWindowChangeSubscriber writes it (via
	// setSubscriber) from the serve goroutine while the poll loop may
	// already be running (an early client connect materialises and starts
	// the hub before rk serve wires the Supervisor), so every poll-path
	// read goes through getSubscriber — one snapshot per waitForNext call,
	// threaded through the whole wait for a single consistent view.
	subscriber WindowChangeSubscriber

	// wakeMu guards wakes. It is a dedicated mutex (not h.mu) so wake() can
	// signal from an HTTP handler goroutine without contending on the poll
	// loop's hot RWMutex.
	wakeMu sync.Mutex
	// wakes is the per-server wake-signal index: a CLOSED channel means a
	// wake is pending for that server (an immediate snapshot pass is owed).
	// wake() closes it; waitForNext observes the closed channel and replaces
	// it with a fresh open one on consumption. Close-based (not buffered-token)
	// so it composes with selectFirst's fan-in + the peek loop, which both
	// re-read the same channel and rely on fired-channels-staying-readable
	// (subscriber Wait channels fire by close too). Independent of subscriber,
	// so wakes work when subscriber == nil (unit-test hubs, PTY-unavailable
	// hosts). See wake / wakeChannel / consumeWake.
	wakes map[string]chan struct{}

	// membershipWake is the hub-level wake channel signalled by addClient when
	// a subscription registers a server key NOT previously in h.clients while
	// the poll loop is already running: waitForNext builds its per-server wait
	// cases from the server-list snapshot taken at the top of the current poll
	// iteration, so a brand-new server's per-server wake channel is watched by
	// nobody — only this hub-level signal unparks the parked loop, whose next
	// pass re-derives the server list (now including the new key) and fetches
	// it promptly instead of waiting out the safety interval. Same close-based,
	// consume-and-replace idiom as the per-server wakes, guarded by wakeMu.
	// See wakeMembership / membershipWakeChannel / consumeMembershipWake.
	membershipWake chan struct{}

	// pollInFlight is the single-flight set for per-server poll units: a
	// server present here has exactly one unit executing (possibly a
	// straggler from a prior tick or from a previous poll goroutine), so
	// dispatch MUST skip it. Hub-level (not poll-local) so single-flight
	// holds across ticks and across poll-goroutine restarts. Guarded by
	// h.mu; written by the poll goroutine (dispatch) and by unit goroutines
	// (clear on completion).
	pollInFlight map[string]bool
	// pollSem bounds concurrently executing poll units to
	// ssePollConcurrency. Acquired at dispatch (non-blocking — a tick skips
	// a server when no slot is free and re-tries on the next results wake),
	// released by the unit goroutine on completion.
	pollSem chan struct{}
	// pollResults receives completed per-unit results for folding at the
	// top of a tick. Buffered at ssePollConcurrency so a completing unit
	// never blocks on delivery (in-flight units never exceed the bound by
	// construction). Unit goroutines send; the poll goroutine is the only
	// receiver.
	pollResults chan pollUnitResult
	// resultsWake is the hub-level wake signalled by every completing poll
	// unit so a parked waitForNext unparks promptly to fold the result — a
	// dead server's gone frame and the retain sweeps must not wait out the
	// safety timer. Same close/consume-replace idiom as membershipWake,
	// guarded by wakeMu. See signalResultsWake / resultsWakeChannel /
	// consumeResultsWake.
	resultsWake chan struct{}

	// safetyInterval overrides safetyPollInterval per-hub. Zero falls back
	// to the package constant. Tests set this to a short duration so
	// existing time-based assertions remain valid; production callers
	// leave it zero.
	safetyInterval time.Duration

	// eventDebounce overrides sseEventDebounce per-hub. Zero falls back to
	// the package constant (the safetyInterval override idiom). Tests set it
	// long to prove wake bypass deterministically, or short to keep timing
	// assertions fast; production callers leave it zero.
	eventDebounce time.Duration

	// captureFn captures a window's pane-text preview. Defaults to the real
	// capturePreviewForWindow (tmux exec); tests override it to exercise the
	// preview-broadcast path without a live tmux server.
	captureFn captureFunc

	// guiProbeTTL overrides the package guiProbeTTL per hub. Zero falls back
	// to the package constant (the safetyInterval override idiom — a per-hub
	// field, never a global write, so a test shrink can't race another
	// test's still-running poll loop). Tests set it short; production
	// callers leave it zero.
	guiProbeTTL time.Duration

	// guiSessionOptionsFn/guiProbeFn are the injectable seams behind
	// guiTick: the rk-gui session's stamped option read and the RFB probe.
	// Production defaults are wired in newSSEHub; tests substitute per-hub
	// (the captureFn idiom — per-hub, so a stub never leaks into another
	// test's still-running poll loop).
	guiSessionOptionsFn func(ctx context.Context) (display, backend, wm string, ok bool)
	guiProbeFn          func(ctx context.Context, network, addr string) (gui.Info, error)
	// guiLockedFn reads the host resolution pin (@rk_gui_lock) on the gui
	// tick, beside the stamps. Same per-hub seam idiom.
	guiLockedFn func(ctx context.Context) bool
}

// getSubscriber returns the hub's current WindowChangeSubscriber under
// h.mu.RLock. The poll path snapshots it ONCE per waitForNext call so a single
// wait sees one consistent subscriber view even if SetWindowChangeSubscriber
// lands mid-wait.
func (h *sseHub) getSubscriber() WindowChangeSubscriber {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.subscriber
}

// setSubscriber wires the WindowChangeSubscriber under h.mu (write) — the
// poll loop may already be running when rk serve calls
// SetWindowChangeSubscriber, so a plain write would race the poll path's
// reads.
func (h *sseHub) setSubscriber(sub WindowChangeSubscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subscriber = sub
}

// safetyIntervalEffective returns the safety-net interval for a poll cycle
// covering the given servers. The long 12s interval is correct ONLY when every
// watched server is control-covered (its Wait channel fires event-driven, so
// the timer is just a backstop). If ANY watched server is uncovered — no
// control-mode Client, e.g. an rk-test-* server the supervisor skips, or a
// PTY-unavailable host — that server has NO event driver, so the safety timer
// is its only freshness source and must run at the fast legacy cadence;
// otherwise an external change on it takes up to 12s to surface (the SSE-sync
// e2e failures: tests assert at 5s but the test server was uncovered yet still
// got the 12s interval). A per-hub override (h.safetyInterval) wins when set.
//
// The metricsOnlyServer sentinel is EXCLUDED from the coverage gate: it has no
// tmux server to poll and is never session-fetched (see the poll loop skip), so
// it needs no freshness cadence of its own. It can never be Covers()-ed (no
// control-mode Client for a non-server key), so counting it would always force
// the fast legacy cadence whenever a metrics-only client is present (~always,
// since the Host home holds one open) — needlessly ~5x-ing FetchSessions
// calls for co-attached real servers. Skipping it lets the covered real servers
// keep the long safety interval.
//
// One exception: when the sentinel is the ONLY thing present (the bare `/`
// Host home with zero attached servers), skipping it would fall through to
// the 12s safety backstop — but the sentinel's Wait channel never fires (it is
// never Covers()-ed), so the loop would block the full 12s between metrics
// broadcasts, making host health on `/` update ~12s apart instead of the
// intended ~2.5s tick. A sentinel-only slice does zero session-fetching, so the
// fast legacy cadence costs nothing but the metrics marshal/broadcast — exactly
// the freshness we want. So a slice containing NO real (non-sentinel) server
// runs at legacyPollInterval.
//
// The caller passes the per-wait subscriber snapshot (see getSubscriber) so a
// single waitForNext call reasons about ONE consistent subscriber view.
func (h *sseHub) safetyIntervalEffective(servers []string, sub WindowChangeSubscriber) time.Duration {
	if h.safetyInterval > 0 {
		return h.safetyInterval
	}
	if sub == nil {
		return legacyPollInterval
	}
	sawRealServer := false
	for _, server := range servers {
		if server == metricsOnlyServer {
			continue
		}
		sawRealServer = true
		if !sub.Covers(server) {
			return legacyPollInterval
		}
	}
	// No real server in the slice (only the metrics-only sentinel, or empty):
	// use the fast cadence so the metrics broadcast ticks at ~2.5s for the
	// Host home. With a real, fully-covered server present, keep the long
	// safety interval.
	if !sawRealServer {
		return legacyPollInterval
	}
	return safetyPollInterval
}

func newSSEHub(fetcher SessionFetcher, mc *metrics.Collector, svc *ports.Collector, pc PRStatusSnapshotter) *sseHub {
	h := &sseHub{
		clients:                make(map[string][]*sseClient),
		stateConns:             make(map[*stateConn]bool),
		previousJSON:           make(map[string]string),
		previousSessionsKey:    make(map[string]string),
		previousOrderJSON:      make(map[string]string),
		orderBootstrapAttempts: make(map[string]int),
		previousRealSessions:   make(map[string]map[string]bool),
		previousPreviewJSON:    make(map[string]map[string]string),
		cache:                  make(map[string]*cachedResult),
		wakes:                  make(map[string]chan struct{}),
		pollInFlight:           make(map[string]bool),
		pollSem:                make(chan struct{}, ssePollConcurrency),
		pollResults:            make(chan pollUnitResult, ssePollConcurrency),
		guiViewers:             make(map[string]int),
		guiHumanInput:          make(map[string]time.Time),
		fetcher:                fetcher,
		orderFetcher:           prodSessionOrderFetcher{},
		metrics:                mc,
		services:               svc,
		prStatus:               pc,
		operatorQueue:          newOperatorQueueTracker(),
		prReviewListener:       newPRReviewListenerTracker(),
		autoName:               newAutoNameTracker(),
		captureFn:              capturePreviewForWindow,
		guiSessionOptionsFn:    daemon.GUISessionOptions,
		guiProbeFn:             gui.Probe,
		guiLockedFn:            daemon.GUILocked,
	}
	h.waitingPush = newWaitingPushTracker(func(ctx context.Context, title, body, url string) error {
		// Shell broadcast first: the hub write is immediate, while the Web
		// Push fan-out iterates subscriptions sequentially under a 10s timeout.
		h.broadcastNotify(title, body, url)
		_, err := push.Notify(ctx, title, body, url)
		return err
	})
	return h
}

func (h *sseHub) getOperatorQueue() *operatorQueueTracker {
	return h.operatorQueue
}

func (h *sseHub) getPRReviewListener() *prReviewListenerTracker {
	return h.prReviewListener
}

// getAutoName returns the hub's current auto-name tracker snapshot (nil =
// feature absent). The tracker is self-contained once published, so the
// returned pointer stays valid after the lock is released — a concurrent
// setAutoName swap only redirects later snapshots.
func (h *sseHub) getAutoName() *autoNameTracker {
	h.autoNameMu.Lock()
	defer h.autoNameMu.Unlock()
	return h.autoName
}

// setAutoName is the hub's single auto-name apply seam, shared by initSSEHub
// (startup seed) and the settings POST handler (live toggle): enabled=false
// publishes nil (feature absent), enabled=true publishes a freshly-built
// tracker whose deliver closure closes over deliver (nil deliver = tracking
// without fan-out, the test-hub shape). Enabling builds a NEW tracker — prior
// in-memory cooldowns drop, matching the documented process-memory semantics.
func (h *sseHub) setAutoName(enabled bool, deliver func(ctx context.Context, server string, subject, operator *tmux.WindowInfo) error) {
	h.autoNameMu.Lock()
	defer h.autoNameMu.Unlock()
	if !enabled {
		h.autoName = nil
		return
	}
	tracker := newAutoNameTracker()
	tracker.deliver = deliver
	h.autoName = tracker
}

// addClient registers a per-server subscription record and delivers the cached
// PER-SERVER slots (sessions, session-order, preview) immediately. Host-global
// slots are NOT sent here — a state-socket connection replays them once at hello
// via replayGlobalSlots, so sending them per-subscription would duplicate them
// on a multi-server connection. The metricsOnlyServer sentinel key carries no
// per-server cache, so for it this is a no-op beyond starting the poll loop.
func (h *sseHub) addClient(c *sseClient) {
	h.mu.Lock()
	defer h.mu.Unlock()

	_, known := h.clients[c.server]
	h.clients[c.server] = append(h.clients[c.server], c)

	// Send cached session snapshot immediately
	if prev, ok := h.previousJSON[c.server]; ok && prev != "" {
		h.sendLocked(c, hubEvent{kind: kindServer, typ: "sessions", key: c.server, data: prev})
	}

	// Send cached session-order snapshot immediately (after sessions)
	if prev, ok := h.previousOrderJSON[c.server]; ok && prev != "" {
		h.sendLocked(c, hubEvent{kind: kindServer, typ: "session-order", key: c.server, data: prev})
	}

	// Send cached preview snapshot immediately, filtered to this connection's
	// expanded windows for this server. A brand-new subscription has nothing
	// expanded yet, so this is a no-op until its scope declaration lands.
	h.sendCachedPreviewLocked(c)

	if !h.polling {
		h.polling = true
		go h.poll()
	} else if !known {
		// The running loop is parked on a wait-case list built from the
		// PREVIOUS server set, so no per-server signal can reach it for this
		// brand-new key — only the hub-level membership wake unparks it so
		// the next pass fetches the new server promptly. An already-registered
		// key never re-fires (no waking storms); a key deleted by
		// removeClientLocked counts as new again on resubscribe. Lock order:
		// h.mu is held, wakeMu nests after it (h.mu → wakeMu).
		h.wakeMembership()
	}
}

// removeClient unregisters a per-server subscription record from the routing
// index (and from its owning connection's subscription set, if any).
func (h *sseHub) removeClient(c *sseClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeClientLocked(c)
}

// removeClientLocked is removeClient's body; caller MUST hold h.mu (write).
func (h *sseHub) removeClientLocked(c *sseClient) {
	cs := h.clients[c.server]
	for i, cl := range cs {
		if cl == c {
			cs[i] = cs[len(cs)-1]
			cs[len(cs)-1] = nil // avoid leak
			cs = cs[:len(cs)-1]
			break
		}
	}
	if len(cs) == 0 {
		delete(h.clients, c.server)
	} else {
		h.clients[c.server] = cs
	}
	if c.conn != nil {
		delete(c.conn.subs, c.server)
	}
}

// sendLocked delivers a hubEvent to one subscription record, best-effort with
// the same drop-logging semantics as the broadcast helpers. Caller MUST hold
// h.mu (write).
func (h *sseHub) sendLocked(c *sseClient, ev hubEvent) {
	select {
	case c.ch <- ev:
		c.dropped = false
	default:
		if !c.dropped {
			slog.Warn("state event dropped", "server", c.server, "event", ev.typ)
			c.dropped = true
		}
	}
}

// codeServerProbeTTL bounds how often the hub dials the configured code-server
// port: the probe piggybacks the existing poll cadence and is never a
// per-request dial (intake k3vp §2, assumption 9).
const codeServerProbeTTL = 5 * time.Second

// codeServerDialTimeout bounds the TCP reachability dial. Localhost refused is
// instant; the timeout covers only a filtered/hung listener so the poll loop
// never stalls on it.
const codeServerDialTimeout = 500 * time.Millisecond

// codeServerPayload is the host-global `event: code-server` body: the current
// reachability of the resolved code-server port. The port itself is NOT
// carried — since 260811-a2bo it is a private implementation detail behind the
// stable /code/ route (the client builds no URL from it). Availability (a
// window's gitRoot derived) is computed client-side; reachability governs only
// the surface's CONTENT state (live iframe vs the not-running empty state) —
// spec right-panel.md § Surface Registry (k3vp amendment).
type codeServerPayload struct {
	Reachable bool `json:"reachable"`
}

// codeServerTick returns the configured code-server port and its TTL-cached
// reachability, re-dialing 127.0.0.1:{port} only when the cache is stale.
// Called from the poll loop only; (0, false) when the feature is off. The dial
// itself runs OUTSIDE h.mu so a slow listener never stalls event delivery.
func (h *sseHub) codeServerTick() (int, bool) {
	h.mu.RLock()
	port, at, reachable := h.codeServerPort, h.codeServerProbeAt, h.codeServerReachable
	h.mu.RUnlock()
	if port == 0 {
		return 0, false
	}
	if time.Since(at) < codeServerProbeTTL {
		return port, reachable
	}

	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), codeServerDialTimeout)
	reachable = err == nil
	if conn != nil {
		conn.Close()
	}

	h.mu.Lock()
	h.codeServerProbeAt = time.Now()
	h.codeServerReachable = reachable
	h.mu.Unlock()
	return port, reachable
}

// guiProbeTTL bounds how often the hub re-probes the GUI backend: the probe
// piggybacks the existing poll cadence and is never a per-request dial (the
// codeServerProbeTTL shape). Overridable per hub via the guiProbeTTL field
// (the safetyInterval idiom) — tests shrink the field, never this constant.
const guiProbeTTL = 5 * time.Second

// guiProbeTTLEffective returns the hub's probe TTL: the per-hub override
// when set, else the package default.
func (h *sseHub) guiProbeTTLEffective() time.Duration {
	if h.guiProbeTTL > 0 {
		return h.guiProbeTTL
	}
	return guiProbeTTL
}

// guiTickTimeout bounds the per-tick tmux option read + probe context so a
// hung endpoint can never stall the poll loop past one tick.
const guiTickTimeout = 5 * time.Second

// guiTick maintains the host-global `event: gui` slot and is invoked on
// dispatch ticks (never fold-only ticks) beside the code-server emitter. It
// re-reads gui.enabled/gui.geometry from the settings file behind a
// settings.Stamp gate — parsed on the first tick and again only when the
// file's fingerprint moves (a CLI-side `rk gui on` writes the file directly
// and must surface without a settings POST) — refreshes the TTL-cached probe
// when enabled, and broadcasts the always-list-shaped payload only when its
// dedup key changed. The tmux option read and the probe dial run OUTSIDE
// h.mu (the codeServerTick discipline).
// While at least one relay viewer is live the dial is skipped: reachability
// follows from the live relay and each dial would write accept/close lines
// into the supervisor pane's log.
func (h *sseHub) guiTick() {
	stamp := settings.Stamp()
	h.mu.RLock()
	reload := !h.settingsLoaded || stamp != h.settingsStamp
	h.mu.RUnlock()
	if reload {
		// Parsed outside h.mu; the poll loop is the only writer of the
		// settings trio, so the re-lock cannot lose a concurrent update.
		loaded := settings.Load()
		h.mu.Lock()
		h.settingsCache = loaded
		h.settingsStamp = stamp
		h.settingsLoaded = true
		h.mu.Unlock()
	}

	h.mu.Lock()
	enabled := h.settingsCache.GUIEnabled
	h.guiGeometry = h.settingsCache.GUIGeometry
	if enabled != h.guiEnabled {
		h.guiEnabled = enabled
		// Force a fresh probe on the flip so a CLI on/off surfaces within one
		// TTL instead of riding the stale cache.
		h.guiProbeAt = time.Time{}
	}
	probeAt := h.guiProbeAt
	viewers := h.guiViewers[daemon.GUIWindowName]
	h.mu.Unlock()

	if enabled && time.Since(probeAt) >= h.guiProbeTTLEffective() {
		ctx, cancel := context.WithTimeout(context.Background(), guiTickTimeout)
		locked := h.guiLockedFn(ctx)
		if viewers > 0 {
			h.mu.Lock()
			h.guiInfo.Reachable = true
			h.guiInfo.Reason = ""
			h.guiProbeAt = time.Now()
			h.guiLocked = locked
			h.mu.Unlock()
			cancel()
		} else {
			display, backend, wm, ok := h.guiSessionOptionsFn(ctx)
			if ok && display != "" {
				// An unparsable stamped display reads as "not running".
				if _, derr := gui.ParseDisplay(display); derr != nil {
					ok = false
				}
			}
			var info gui.Info
			switch {
			case !ok:
				info = gui.Info{Reason: "session absent"}
				display, backend, wm = "", "", ""
			default:
				network, addr, aerr := guiBackendAddr()
				switch {
				case aerr != nil:
					info = gui.Info{Reason: aerr.Error()}
				default:
					pi, perr := h.guiProbeFn(ctx, network, addr)
					if perr != nil {
						info = gui.Info{Reason: perr.Error()}
					} else {
						info = pi
					}
				}
			}
			cancel()

			h.mu.Lock()
			h.guiDisplay = display
			h.guiBackend = backend
			h.guiWM = wm
			h.guiInfo = info
			h.guiProbeAt = time.Now()
			h.guiLocked = locked
			h.mu.Unlock()
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	payload, key := h.guiPayloadLocked()
	if payload == "" {
		return
	}
	if key != h.cachedGuiKey {
		h.cachedGuiJSON = payload
		h.cachedGuiKey = key
		h.broadcastGlobalLocked(hubEvent{kind: kindGlobal, typ: "gui", data: payload})
	}
}

// guiPayloadLocked renders the `event: gui` payload from hub state, plus its
// dedup key — the same payload with HumanInputAgoMS flattened to a
// presence marker. That field is a live age (it moves every tick once any
// viewer has driven the display) and no stream consumer reads it, so the AGE
// is excluded from the key while still riding the wire; its PRESENCE stays
// in the key (the omitempty absent→present transition is wire-visible).
// The payload is ALWAYS a single-element list; a disabled GUI renders the
// fixed all-zero entry. Caller MUST hold h.mu.
func (h *sseHub) guiPayloadLocked() (payload, key string) {
	entry := gui.StreamEntry{ID: daemon.GUIWindowName, Enabled: h.guiEnabled}
	if h.guiEnabled {
		entry.Backend = h.guiBackend
		entry.Reachable = h.guiInfo.Reachable
		entry.Display = h.guiDisplay
		entry.Width = h.guiInfo.Width
		entry.Height = h.guiInfo.Height
		entry.Viewers = h.guiViewers[daemon.GUIWindowName]
		entry.WM = h.guiWM
		entry.Locked = h.guiLocked
		entry.Geometry = h.guiGeometry
		if at, ok := h.guiHumanInput[daemon.GUIWindowName]; ok {
			entry.HumanInputAgoMS = gui.HumanInputAgoMS(at, time.Now())
		}
	}
	b, err := json.Marshal([]gui.StreamEntry{entry})
	if err != nil {
		return "", ""
	}
	// The age is clamped ≥ 1 when present, so > 0 ⟺ present; 1 is the
	// presence marker (any fixed positive value would do).
	if entry.HumanInputAgoMS > 0 {
		entry.HumanInputAgoMS = 1
	}
	kb, err := json.Marshal([]gui.StreamEntry{entry})
	if err != nil {
		return "", ""
	}
	return string(b), string(kb)
}

// setGUIEnabled is the settings-POST apply seam: flips guiEnabled, zeroes the
// probe age (the next tick re-probes), and re-renders + broadcasts
// immediately (and unconditionally — the flip path must stay one-state-event
// fast) so the POST caller's state socket sees the flip within one state
// event instead of waiting out the poll cadence. The CLI path (`rk gui on`)
// never calls this — the tick's stamp-gated settings re-read covers it.
func (h *sseHub) setGUIEnabled(enabled bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.guiEnabled = enabled
	// Drop the cached probe result together with its age: a flip must never
	// rebroadcast the previous state's reachable/backend/display until the
	// next tick re-probes — the payload reports unreachable until then.
	h.guiProbeAt = time.Time{}
	h.guiInfo = gui.Info{}
	h.guiBackend = ""
	h.guiDisplay = ""
	h.guiWM = ""
	h.guiLocked = false
	if !enabled {
		h.guiGeometry = ""
	}
	payload, key := h.guiPayloadLocked()
	if payload == "" {
		return
	}
	h.cachedGuiJSON = payload
	h.cachedGuiKey = key
	h.broadcastGlobalLocked(hubEvent{kind: kindGlobal, typ: "gui", data: payload})
}

// guiViewerAdd / guiViewerRemove track live /ws/gui/{id} relay connections
// per id — the payload's viewers field and the probe's viewer-skip gate.
// Removal floors at zero. Called from the relay handler goroutines.
func (h *sseHub) guiViewerAdd(id string) {
	h.mu.Lock()
	h.guiViewers[id]++
	h.mu.Unlock()
}

func (h *sseHub) guiViewerRemove(id string) {
	h.mu.Lock()
	if h.guiViewers[id] > 0 {
		h.guiViewers[id]--
	}
	h.mu.Unlock()
}

// guiViewerCount is the current live-viewer count for an id (the relay's
// bookkeeping assertions in tests).
func (h *sseHub) guiViewerCount(id string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.guiViewers[id]
}

// guiHumanInputSeen records one relayed human input for an id — the relay
// filter's onHumanInput callback. In-memory only: the timestamp exists
// nowhere on disk and dies with the daemon (Constitution X's in-flight
// carve-out — the one pushed fact on this surface).
func (h *sseHub) guiHumanInputSeen(id string) {
	h.mu.Lock()
	h.guiHumanInput[id] = time.Now()
	h.mu.Unlock()
}

// guiHumanInputAt is the last relayed human-input time for an id; ok=false
// when no viewer has driven the display since the daemon started.
func (h *sseHub) guiHumanInputAt(id string) (time.Time, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	at, ok := h.guiHumanInput[id]
	return at, ok
}

// guiLockedState is the host resolution pin as of the last gui tick.
func (h *sseHub) guiLockedState() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.guiLocked
}

// replayGlobalSlots sends the cached host-global slots to a state-socket
// connection ONCE, right after hello. This is the state-socket counterpart of
// the per-connect global delivery the old SSE addClient performed. Ordering
// mirrors the historical order (metrics → services → server-order → board-order
// → version → update-available); each is skipped when its slot is empty.
func (h *sseHub) replayGlobalSlots(sc *stateConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cachedMetricsJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "metrics", data: h.cachedMetricsJSON})
	}
	if h.cachedServicesJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "services", data: h.cachedServicesJSON})
	}
	if h.cachedCodeServerJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "code-server", data: h.cachedCodeServerJSON})
	}
	if h.cachedGuiJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "gui", data: h.cachedGuiJSON})
	}
	if h.cachedServerOrderJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "server-order", data: h.cachedServerOrderJSON})
	}
	if h.cachedBoardOrderJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "board-order", data: h.cachedBoardOrderJSON})
	}
	if h.cachedVersionJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "version", data: h.cachedVersionJSON})
	}
	if h.cachedUpdateAvailableJSON != "" {
		h.sendConnLocked(sc, hubEvent{kind: kindGlobal, typ: "update-available", data: h.cachedUpdateAvailableJSON})
	}
	h.stateConns[sc] = true
}

// emitError delivers a state-socket `error` frame to a connection, echoing the
// offending op's req. The frame rides the connection's send channel as a
// pre-rendered raw hubEvent so ONLY the writer pump ever writes to the socket
// (gorilla forbids concurrent writes). Takes h.mu itself. Best-effort.
func (h *sseHub) emitError(sc *stateConn, req int64, message string) {
	b, err := json.Marshal(errorFrame{Op: "error", Req: req, Message: message})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sendConnLocked(sc, hubEvent{raw: b})
}

// sendConnLocked delivers a hubEvent to a whole connection (host-global fan-out
// unit). Best-effort. Caller MUST hold h.mu (write).
func (h *sseHub) sendConnLocked(sc *stateConn, ev hubEvent) {
	h.sendConnLockedOK(sc, ev)
}

// sendConnLockedOK is sendConnLocked returning whether the event was enqueued
// (false ⇒ the connection's channel was full and the event was DROPPED).
// Caller MUST hold h.mu (write).
func (h *sseHub) sendConnLockedOK(sc *stateConn, ev hubEvent) bool {
	select {
	case sc.ch <- ev:
		sc.dropped = false
		return true
	default:
		if !sc.dropped {
			slog.Warn("state event dropped (conn)", "event", ev.typ)
			sc.dropped = true
		}
		return false
	}
}

// stateSubscribe registers a subscription for a state-socket connection and
// acks it with the current snapshot. A `server` kind enters the poll set and
// carries the sessions snapshot; a `metrics` kind registers under the
// metrics-only sentinel and carries the cached metrics snapshot.
func (h *sseHub) stateSubscribe(sc *stateConn, msg clientMsg) {
	var key string
	switch msg.Kind {
	case kindServer:
		// The key flows into the poll set and reaches tmux subprocesses (tmux -L
		// <key> via serverArgs), so it MUST pass the same validation barrier the
		// retired SSE edge had via serverFromRequest (Constitution §I). An invalid
		// name is rejected with an error frame carrying the offending req rather
		// than silently dropped, so the client can surface the failure.
		if err := validate.ValidateServerName(msg.Key); err != "" {
			h.emitError(sc, msg.Req, err)
			return
		}
		key = msg.Key
	case kindMetrics:
		key = metricsOnlyServer
	default:
		h.emitError(sc, msg.Req, "unknown subscribe kind: "+msg.Kind)
		return
	}

	h.mu.Lock()
	// Ensure the connection is in the host-global fan-out set (defensive — the
	// handler already adds it via replayGlobalSlots at hello, but a subscribe
	// must never leave a connection unable to receive global events).
	h.stateConns[sc] = true
	// Idempotent: a repeat subscribe re-acks with a fresh snapshot but does not
	// create a second routing record.
	rec, exists := sc.subs[key]
	if !exists {
		rec = &sseClient{ch: sc.ch, server: key, conn: sc, connID: sc.connID, expanded: map[string]bool{}}
		sc.subs[key] = rec
	}
	h.mu.Unlock()

	if !exists {
		// addClient takes the lock itself and starts the poll loop; it also
		// delivers the per-server cached slots (sessions/order/preview) for a
		// server subscription.
		h.addClient(rec)
	}

	// Read the ack snapshot and enqueue the ack in ONE critical section. Reading
	// under an EARLIER lock than the enqueue (as this once did) opened a race: a
	// poll tick interleaving after the read but before the ack could update
	// previousJSON and enqueue a NEWER `sessions` event ahead of the stale-
	// snapshot ack, and the client (which applies the ack's snapshot
	// unconditionally) would then overwrite the fresh sessions with the stale
	// one — and the hub's previousJSON dedup would suppress re-emission,
	// stranding stale UI on a quiet server. Reading the snapshot in the same
	// critical section that enqueues the ack guarantees the ack's snapshot is ≥
	// every `sessions`/`metrics` event already on this connection's channel
	// (registration via addClient above means any concurrent poll tick either
	// finished before this lock — so the read sees its value — or runs after the
	// ack, in which case the client's newest-wins apply is correct).
	h.mu.Lock()
	var snapshot string
	if msg.Kind == kindServer {
		snapshot = h.previousJSON[key]
	} else {
		snapshot = h.cachedMetricsJSON
	}
	// A server subscribe that finds NO cached snapshot is a COLD subscribe
	// (first fetch failed or hasn't completed): wake the poll loop for this
	// server so the first snapshot arrives in one pass rather than after the
	// safety interval. A warm resubscribe (snapshot present) never wakes —
	// that is the storm guard. The wake is issued AFTER h.mu.Unlock() below:
	// wake() takes h.mu.RLock internally and sync.RWMutex is not reentrant, so
	// calling it under this held write lock would deadlock.
	cold := msg.Kind == kindServer && snapshot == ""
	// Ack with the snapshot (empty snapshot → null, which the client tolerates).
	ack := ackFrame{Op: "ack", Req: msg.Req}
	if snapshot != "" {
		ack.Snapshot = json.RawMessage(snapshot)
	} else {
		ack.Snapshot = json.RawMessage("null")
	}
	ackBytes, err := json.Marshal(ack)
	if err != nil {
		h.mu.Unlock()
		return
	}
	// Deliver the ack over the same channel as a pre-rendered raw frame so it is
	// ordered with the subscription's events.
	h.sendConnLocked(sc, hubEvent{raw: ackBytes})
	h.mu.Unlock()

	if cold {
		// wake()'s new-entry allocation gate passes: addClient registered the
		// subscription above, so h.clients[key] is non-empty. For a server new
		// to the poll set entirely this per-server wake may find no parked
		// waiter — addClient's membership wake covers that shape.
		h.wake(key)
	}
}

// stateUnsubscribe drops a subscription. A server left with no subscribers
// leaves the poll set on the next idle tick (its record removal empties
// h.clients[server]).
func (h *sseHub) stateUnsubscribe(sc *stateConn, msg clientMsg) {
	var key string
	switch msg.Kind {
	case kindServer:
		// Validate for the same reason as stateSubscribe: an unsubscribe key is a
		// map lookup only (never reaches a subprocess), but rejecting an invalid
		// name keeps the barrier uniform and can never match a legitimately-keyed
		// subscription anyway.
		if err := validate.ValidateServerName(msg.Key); err != "" {
			h.emitError(sc, msg.Req, err)
			return
		}
		key = msg.Key
	case kindMetrics:
		key = metricsOnlyServer
	default:
		h.emitError(sc, msg.Req, "unknown unsubscribe kind: "+msg.Kind)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if rec, ok := sc.subs[key]; ok {
		h.removeClientLocked(rec)
	}
}

// dropStateConn tears down a whole state-socket connection: unregister every
// per-server subscription record and remove the connection from the global
// fan-out set.
func (h *sseHub) dropStateConn(sc *stateConn) {
	h.mu.Lock()
	for _, rec := range sc.subs {
		h.removeClientLocked(rec)
	}
	sc.subs = map[string]*sseClient{}
	delete(h.stateConns, sc)
	h.mu.Unlock()
}

// broadcastSessionOrder pushes a session-order event to every client connected
// for the given server, and caches the payload so future clients receive it
// during addClient. Order changes are eager — they do not wait for the next
// poll tick.
//
// nil order is normalized to an empty slice so the cached JSON is always "[]"
// rather than "null", matching the GET endpoint shape.
func (h *sseHub) broadcastSessionOrder(server string, order []string) {
	if order == nil {
		order = []string{}
	}
	payload := struct {
		Server string   `json:"server"`
		Order  []string `json:"order"`
	}{Server: server, Order: order}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("session-order broadcast marshal failed", "err", err, "server", server)
		return
	}
	jsonStr := string(jsonBytes)

	// Render once, before the lock — every recipient gets the same bytes and
	// the envelope marshal never extends h.mu hold time.
	ev := preRendered(hubEvent{kind: kindServer, typ: "session-order", key: server, data: jsonStr})

	h.mu.Lock()
	defer h.mu.Unlock()
	h.previousOrderJSON[server] = jsonStr
	for _, c := range h.clients[server] {
		h.sendLocked(c, ev)
	}
}

// broadcastServerOrder pushes a server-global `event: server-order` to EVERY
// connected client across every server key (including the `?metrics=1`
// metrics-only stream) and caches the payload so future clients receive it on
// connect. Server rank order is a HOST-global concern — a client viewing one
// server (or none, on the Host) still needs to re-sort its server list — so
// this fans out to all clients like the metrics/services broadcasts, NOT to a
// single server's clients like broadcastSessionOrder.
//
// nil order is normalized to an empty slice so the cached JSON is always "[]"
// rather than "null".
func (h *sseHub) broadcastServerOrder(order []string) {
	if order == nil {
		order = []string{}
	}
	payload := struct {
		Order []string `json:"order"`
	}{Order: order}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("server-order broadcast marshal failed", "err", err)
		return
	}
	jsonStr := string(jsonBytes)

	// Rendered before the lock — see broadcastSessionOrder.
	ev := preRendered(hubEvent{kind: kindGlobal, typ: "server-order", data: jsonStr})

	h.mu.Lock()
	defer h.mu.Unlock()
	h.cachedServerOrderJSON = jsonStr
	h.broadcastGlobalLocked(ev)
}

// broadcastBoardOrder pushes a server-global `event: board-order` to EVERY
// connected client across every server key (including the `?metrics=1`
// metrics-only stream) and caches the payload so future clients receive it on
// connect. Board display order is a HOST-global concern — a board is an
// emergent cross-server aggregate with no owning tmux server — so this fans out
// to all clients like broadcastServerOrder, NOT to one server's clients like
// broadcastBoardChanged.
//
// nil order is normalized to an empty slice so the cached JSON is always "[]"
// rather than "null".
func (h *sseHub) broadcastBoardOrder(order []string) {
	if order == nil {
		order = []string{}
	}
	payload := struct {
		Order []string `json:"order"`
	}{Order: order}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("board-order broadcast marshal failed", "err", err)
		return
	}
	jsonStr := string(jsonBytes)

	// Rendered before the lock — see broadcastSessionOrder.
	ev := preRendered(hubEvent{kind: kindGlobal, typ: "board-order", data: jsonStr})

	h.mu.Lock()
	defer h.mu.Unlock()
	h.cachedBoardOrderJSON = jsonStr
	h.broadcastGlobalLocked(ev)
}

// setVersion seeds the server-global `event: version` cached slot with the
// running daemon version, a per-process boot identity, and the brew-install
// flag. Called once at startup via Server.SetVersion. The version cannot change
// for the process lifetime, so there is deliberately NO broadcast to
// already-connected clients here — the slot is delivered purely on connect
// (addClient), which is exactly when the client needs it. An empty version is
// ignored (leaves the slot empty → no `event: version` sent).
//
// `boot`/`brew`/`started`/`port` are ADDITIVE fields — older clients that parse
// only `version` are unaffected. `boot` is a per-process id (regenerated on every
// daemon start) that lets a tab detect a same-version restart and reload; `brew`
// gates the palette's force-update / restart maintenance entries client-side.
// `started` (process start, epoch seconds) + `port` (the bound RK_PORT) feed the
// host page's daemon uptime/port readout — both are server-derived constants
// known at boot.
func (h *sseHub) setVersion(version, boot string, brew bool, started int64, port int) {
	if version == "" {
		return
	}
	payload := struct {
		Version string `json:"version"`
		Boot    string `json:"boot"`
		Brew    bool   `json:"brew"`
		Started int64  `json:"started"`
		Port    int    `json:"port"`
	}{Version: version, Boot: boot, Brew: brew, Started: started, Port: port}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("version slot marshal failed", "err", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cachedVersionJSON = string(jsonBytes)
}

// updateAvailableTool is one tool in the `update-available` payload — the FULL
// per-tool verdict (every tool with a pending update, including sub-threshold
// rows), not just the notable/matched set, so the client can filter either
// check view (default = notable only; incl.-patches = all updateAvailable).
type updateAvailableTool struct {
	Tool    string `json:"tool"`
	Current string `json:"current"`
	Latest  string `json:"latest"`
	// UpdateAvailable reports installed < latest.
	UpdateAvailable bool `json:"updateAvailable"`
	// Notable reports the bump crosses the tool's notify threshold — the set
	// that lights the chip and composes the dismissal key.
	Notable bool `json:"notable"`
}

// updateAvailablePayload is the JSON body shared by the SSE `update-available`
// slot and the POST /api/updates/check response. ONE builder
// (buildUpdateAvailablePayload) serves both surfaces so their shapes can never
// drift.
type updateAvailablePayload struct {
	Tools []updateAvailableTool `json:"tools"`
	// Key is the composite dismissal key derived from the NOTABLE set only.
	Key string `json:"key"`
	// Current/Latest are the legacy run-kit-row fields, retained for
	// transitional compat (populated only when run-kit is in the notable set).
	Current string `json:"current"`
	Latest  string `json:"latest"`
	// Source echoes the report's self-identified backend ("released"/"github"),
	// so the check-toast client reacts to what actually ran (the incl.-patches
	// annotation is suppressed for github, which carries no notify policy). The
	// ambient SSE slot carries "released" — harmless, and keeps the
	// one-builder-no-drift property. Kept LAST so existing byte-fragment
	// assertions on the payload stay valid.
	Source string `json:"source"`
}

// buildUpdateAvailablePayload maps a checker verdict onto the wire payload.
func buildUpdateAvailablePayload(verdict updatecheck.Result) updateAvailablePayload {
	tools := make([]updateAvailableTool, 0, len(verdict.Tools))
	for _, v := range verdict.Tools {
		tools = append(tools, updateAvailableTool{
			Tool:            v.Tool,
			Current:         v.Installed,
			Latest:          v.Latest,
			UpdateAvailable: v.UpdateAvailable,
			Notable:         v.Notable,
		})
	}
	return updateAvailablePayload{Tools: tools, Key: verdict.Key, Current: verdict.Current, Latest: verdict.Latest, Source: verdict.Source}
}

// broadcastUpdateAvailable pushes a server-global `event: update-available` to
// EVERY connected client across every server key (including the `?metrics=1`
// metrics-only stream) and caches the payload so future clients receive it on
// connect. A pending update is a HOST-global concern (the daemon is one process
// regardless of how many tmux servers a client views), so this fans out to all
// clients like broadcastServerOrder/broadcastBoardOrder, NOT to one server's
// clients. Invoked from the updatecheck OnQualify callback wired in serve.go.
//
// The payload carries the FULL per-tool verdict list (updateAvailable +
// notable per tool — see buildUpdateAvailablePayload) plus the composite
// dismissal key derived from the notable set. The legacy top-level
// `current`/`latest` are populated from the run-kit row when run-kit is in the
// notable set (else empty) so a not-yet-reloaded frontend keying off a
// non-empty `latest` degrades to run-kit-only display.
//
// A CLEARED verdict (empty Matched, empty Key — fired by the checker per R7 when
// a match is consumed) is NOT skipped: it is marshalled, broadcast, and REPLACES
// the cached slot exactly like a populated verdict, so a tab connecting after a
// consumed-match clear replays the cleared state (empty tools/key) rather than a
// stale match (R8). replayGlobalSlots still replays the slot on connect —
// nothing special-cases the empty payload there either.
func (h *sseHub) broadcastUpdateAvailable(verdict updatecheck.Result) {
	jsonBytes, err := json.Marshal(buildUpdateAvailablePayload(verdict))
	if err != nil {
		slog.Warn("update-available broadcast marshal failed", "err", err)
		return
	}
	jsonStr := string(jsonBytes)

	// Rendered before the lock — see broadcastSessionOrder.
	ev := preRendered(hubEvent{kind: kindGlobal, typ: "update-available", data: jsonStr})

	h.mu.Lock()
	defer h.mu.Unlock()
	h.cachedUpdateAvailableJSON = jsonStr
	h.broadcastGlobalLocked(ev)
}

type notifyPayload struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
	Tag   string `json:"tag,omitempty"`
}

func newNotifyID() (string, error) {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

// broadcastNotify emits a moment-in-time notification to connected clients.
// It intentionally has no cached slot because reconnect replay would surface
// a stale OS notification.
func (h *sseHub) broadcastNotify(title, body, url string) {
	h.broadcastNotifyTagged(title, body, url, "")
}

// broadcastNotifyTagged is broadcastNotify plus a `tag` classifying the
// notification source so clients can key behavior (dismiss/replace) on it.
// An empty tag is omitted from the wire payload (json:",omitempty"), keeping
// untagged producers byte-identical.
func (h *sseHub) broadcastNotifyTagged(title, body, url, tag string) {
	id, err := newNotifyID()
	if err != nil {
		slog.Warn("notify id generation failed", "err", err)
		return
	}
	jsonBytes, err := json.Marshal(notifyPayload{
		ID:    id,
		Title: title,
		Body:  body,
		URL:   url,
		Tag:   tag,
	})
	if err != nil {
		slog.Warn("notify broadcast marshal failed", "err", err)
		return
	}
	ev := preRendered(hubEvent{kind: kindGlobal, typ: "notify", data: string(jsonBytes)})

	h.mu.Lock()
	defer h.mu.Unlock()
	h.broadcastGlobalLocked(ev)
}

// broadcastStatusRefresh pushes a server-global `event: status-refresh` to EVERY
// connected client across every server key (including the `?metrics=1`
// metrics-only stream). It is emitted from finishStatusRefresh() at the end of
// the detached POST /api/status/refresh pass, signalling "the forced refresh
// completed — you're current" so the PANE-header refresh button can clear its
// spinner (which spins click→event, not click→POST). A manual refresh is a
// HOST-global concern (both PR pollers are process-wide, not per-`?server=`), so
// this fans out to all clients like broadcastServerOrder/broadcastUpdateAvailable,
// NOT to one server's clients like broadcastBoardChanged.
//
// Broadcast-only: unlike server-order/board-order/update-available there is NO
// cached slot and NO replay-on-connect. Freshness for a late-connecting client
// is surfaced independently by the StatusDotTip's "checked Xs ago" line
// (PrFetchedAt), so a missed completion pulse loses nothing.
func (h *sseHub) broadcastStatusRefresh(completedAt time.Time) {
	payload := struct {
		CompletedAt string `json:"completedAt"`
	}{CompletedAt: completedAt.UTC().Format(time.RFC3339)}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("status-refresh broadcast marshal failed", "err", err)
		return
	}
	// Rendered before the lock — see broadcastSessionOrder.
	ev := preRendered(hubEvent{kind: kindGlobal, typ: "status-refresh", data: string(jsonBytes)})

	h.mu.Lock()
	defer h.mu.Unlock()
	h.broadcastGlobalLocked(ev)
}

// broadcastGlobalLocked fans a host-global event out to every live state-socket
// connection exactly once (never once per subscription, which would duplicate a
// global event on a multi-server connection). Caller MUST hold h.mu (write).
func (h *sseHub) broadcastGlobalLocked(ev hubEvent) {
	for sc := range h.stateConns {
		h.sendConnLocked(sc, ev)
	}
}

// broadcastBoardChanged pushes a board-changed event to every client
// connected for the supplied server. The payload is rendered as JSON and
// emitted using the shared SSE envelope. No payload caching is performed:
// board membership changes only through the explicit pin/unpin/reorder
// handlers (each emits its own event), and a killed pinned window drops out
// of the next live ListBoardEntries read — there is no snapshot to cache.
func (h *sseHub) broadcastBoardChanged(server string, payload boardChangedPayload) {
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("board-changed broadcast marshal failed", "err", err, "server", server)
		return
	}
	// Rendered before the lock — see broadcastSessionOrder.
	ev := preRendered(hubEvent{kind: kindServer, typ: boardEventName, key: server, data: string(jsonBytes)})

	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients[server] {
		h.sendLocked(c, ev)
	}
}

// setPreviewScope replaces the expanded-session set for the connection on the
// given server whose connID matches. A miss (no live connection with that id)
// is a silent no-op — the connection may have disconnected between the client's
// last SSE read and this POST. In-memory only (Constitution II); the set is
// dropped when the connection is removed (removeClient drops the whole client).
func (h *sseHub) setPreviewScope(server, connID string, expanded []string) {
	if connID == "" {
		return
	}
	set := make(map[string]bool, len(expanded))
	for _, s := range expanded {
		if s != "" {
			set[s] = true
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients[server] {
		if c.connID == connID {
			c.expanded = set
			// Emit the cached preview subset immediately so a just-expanded
			// tile is not blank until the next poll tick (R7 intent). No-op
			// when the new set is empty or no preview is cached yet.
			h.sendCachedPreviewLocked(c)
			return
		}
	}
}

// sendCachedPreviewLocked delivers the cached preview subset for the client's
// current expanded set over `event: preview`. Caller MUST hold h.mu (write —
// it reads shared maps and writes to the client channel). Best-effort: a full
// client channel drops the event silently (the next poll tick retries).
func (h *sseHub) sendCachedPreviewLocked(c *sseClient) {
	full := h.previousPreviewJSON[c.server]
	if len(full) == 0 || len(c.expanded) == 0 {
		return
	}
	var byWindow map[string][]string
	if cached, ok := h.cache[c.server]; ok {
		byWindow = windowsBySession(cached.data)
	} else {
		return
	}
	subset := previewSubsetFor(c, full, byWindow)
	if subset == nil {
		return
	}
	payload, err := json.Marshal(subset)
	if err != nil {
		return
	}
	h.sendLocked(c, hubEvent{kind: kindServer, typ: "preview", key: c.server, data: string(payload)})
}

// expandedUnionLocked returns the union of expanded session names across every
// client on the given server. Caller MUST hold h.mu (read or write).
func expandedUnionLocked(clients []*sseClient) map[string]bool {
	union := map[string]bool{}
	for _, c := range clients {
		for name := range c.expanded {
			union[name] = true
		}
	}
	return union
}

// capturePreviews captures pane-text previews for every window belonging to a
// session in the expanded union, deduped by window ID (a window is captured
// once per tick regardless of how many clients expanded its session). Returns
// a {windowId → text} map. Runs the tmux captures WITHOUT the hub lock held —
// each CapturePane is an exec with its own timeout (Constitution I). Returns an
// empty map when the union is empty (capture-nothing default).
func capturePreviews(sess []sessions.ProjectSession, union map[string]bool, server string, capture captureFunc) map[string]string {
	previews := map[string]string{}
	if len(union) == 0 {
		return previews
	}
	for si := range sess {
		if !union[sess[si].Name] {
			continue
		}
		for wi := range sess[si].Windows {
			w := sess[si].Windows[wi]
			if _, done := previews[w.WindowID]; done {
				continue
			}
			if text, ok := capture(w, server); ok {
				previews[w.WindowID] = text
			}
		}
	}
	return previews
}

// captureFunc captures one window's pane-text preview on a server. Production
// uses capturePreviewForWindow (a real tmux exec); tests inject a stub so the
// preview-broadcast path is exercisable without a live tmux server.
type captureFunc func(w tmux.WindowInfo, server string) (string, bool)

// windowsBySession maps each session name to its window IDs, used to filter the
// server-wide preview union down to a single connection's expanded windows.
func windowsBySession(sess []sessions.ProjectSession) map[string][]string {
	m := make(map[string][]string, len(sess))
	for si := range sess {
		ids := make([]string, 0, len(sess[si].Windows))
		for wi := range sess[si].Windows {
			ids = append(ids, sess[si].Windows[wi].WindowID)
		}
		m[sess[si].Name] = ids
	}
	return m
}

// previewSubsetFor returns the {windowId → text} subset of the server-wide
// preview map that covers the windows in the client's expanded sessions.
// Returns nil when the client has nothing expanded (nothing to send).
func previewSubsetFor(c *sseClient, full map[string]string, byWindow map[string][]string) map[string]string {
	if len(c.expanded) == 0 || len(full) == 0 {
		return nil
	}
	subset := map[string]string{}
	for name := range c.expanded {
		for _, wid := range byWindow[name] {
			if text, ok := full[wid]; ok {
				subset[wid] = text
			}
		}
	}
	if len(subset) == 0 {
		return nil
	}
	return subset
}

// attachPRStatus joins live PR status onto any window with a derived PR from the
// in-memory collector snapshot. It is a PURE read of prStatus.Snapshot() — NO
// network/gh call — preserving the SSE hot path's zero-network-call guarantee.
//
// Gate: status is attached to any window that has a non-empty PrURL (nil and ""
// both fail the gate). PrURL is now derived from the pane's branch server-side —
// internal/sessions.enrichWindowPR REGISTERS the (repo, branch) pair and JOINS
// the last-good PR from internal/prstatus.BranchRefresher's in-memory snapshot,
// while the actual `gh pr list` runs off-tick on that refresher's background
// goroutine — so a PR appears for ANY pane on a branch with a PR (open, merged,
// or closed), not only fab-change-bound windows (the FabChange gate was removed
// in 260705-dmex), with zero gh subprocesses on this hot path. The join is by
// canonical PR URL, never by bare PR number — numbers are only unique per repo,
// so a number join can pick up an unrelated repo's PR state.
//
// PrChecks/PrReview are collector-only, so they are always reset first and
// re-attached solely on a snapshot hit. PrState and PrIsDraft are DUAL-SOURCED:
// the viewer-wide collector is authoritative on a URL-hit, but enrichWindowPR has
// already seeded branch-derived values into both, so a collector MISS must
// PRESERVE them rather than wipe them — a branch-derived closed PR outside the
// viewer's top-$limit window would otherwise carry prNumber set + prState "" and
// prOwnsDot would paint a dead PR's dot solid, and a teammate's draft (never in
// `viewer { pullRequests }` at all, whatever the limit) would lose its draft flag
// and render as a plain open PR. Both fallbacks are refreshed by enrichWindowPR
// every FetchSessions (500ms cache TTL), so preserving them on a cache-hit re-run
// of this idempotent pass cannot strand a stale value for longer than one cache
// generation.
//
// No-op when no collector is wired (nil prStatus) — degrades gracefully.
func (h *sseHub) attachPRStatus(sess []sessions.ProjectSession) {
	if h.prStatus == nil {
		return
	}
	snap := h.prStatus.Snapshot()
	for si := range sess {
		windows := sess[si].Windows
		for wi := range windows {
			w := &windows[wi]
			// Reset collector-only fields so stale values never linger. PrState
			// and PrIsDraft are left intact: they hold enrichWindowPR's branch
			// fallbacks and are overridden below only on a collector hit
			// (PrIsDraft must survive a MISS, or a draft authored by anyone but
			// the viewer — which the collector's `viewer { pullRequests }` query
			// can never return — is wiped back to false). PrFetchedAt is
			// collector-join-owned like PrChecks/PrReview, so it resets to nil
			// here and is re-attached solely on a snapshot hit — a URL-miss
			// window carries no stale freshness timestamp.
			w.PrChecks, w.PrReview, w.PrFetchedAt = "", "", nil
			w.PrReviewUnhandled = 0
			if w.PrURL == nil || *w.PrURL == "" {
				continue
			}
			// The review-thread digest is keyed by PR URL like the status map
			// and comes from the same collector, so a window with a PR gets its
			// unhandled count whether or not the status map holds an entry.
			w.PrReviewUnhandled = len(h.prStatus.UnhandledThreads(*w.PrURL))
			if st, ok := snap[*w.PrURL]; ok {
				w.PrState = st.State
				w.PrChecks = st.Checks
				w.PrReview = st.ReviewDecision
				w.PrIsDraft = st.IsDraft
				// st is a value copy scoped to this block, so taking its address
				// yields a stable pointer independent of the loop/snapshot.
				fetchedAt := st.FetchedAt
				w.PrFetchedAt = &fetchedAt
			}
		}
	}
}

// realSessionNameSet returns the set of *user-facing* session names in the
// snapshot — excluding the hidden link-target sessions (_rk-pin-*/_rk-iso-*)
// and the control-mode anchor (_rk-ctl), which are not sessions a user would
// notice losing. Used to
// detect when a real session disappears between poll ticks (observability for
// Constitution VI — tmux sessions must survive).
func realSessionNameSet(sess []sessions.ProjectSession) map[string]bool {
	out := make(map[string]bool)
	for _, s := range sess {
		if s.Name == "" {
			continue
		}
		if tmux.IsHiddenLinkSession(s.Name) || s.Name == tmux.ControlAnchorSessionName {
			continue
		}
		out[s.Name] = true
	}
	return out
}

// detectDisappearedSessions returns names present in prev but absent in
// current. Pure helper for the real-session disappearance WARN.
func detectDisappearedSessions(prev, current map[string]bool) []string {
	var gone []string
	for name := range prev {
		if !current[name] {
			gone = append(gone, name)
		}
	}
	return gone
}

// pollUnitResult carries one completed per-server poll unit's outcome back to
// the poll goroutine, which folds all completed results at the top of a tick.
// Unit goroutines never touch the poll goroutine's fold accumulators directly
// — each unit fills its own result and the fold merges them.
type pollUnitResult struct {
	server string
	// polled reports the fetch succeeded — the server counts as observed for
	// the retain sweeps. dead reports the fetch failed with
	// tmux.IsServerGone — the server counts as observed AND is reaped. A
	// transient failure sets neither (not observed: its tracker episodes
	// survive the sweep).
	polled bool
	dead   bool
	// waitingKeys/autoNameKeys are the live (server, windowID) keys the unit
	// observed, for the waiting-push / auto-name retain sweeps.
	waitingKeys  map[string]bool
	autoNameKeys map[string]bool
}

func (h *sseHub) poll() {
	// Track per-server generation observed on the prior pass. The
	// event-driven wait fires when generation advances past this.
	perServerGen := map[string]int64{}
	// eventDrivenServers records which servers had their wait channel
	// fire on the most recent waitForNext call. The next iteration
	// invalidates each of those servers' fetch caches so the loop
	// observes the post-mutation tmux state immediately.
	eventDrivenServers := map[string]bool{}
	// resultsOnly marks ticks whose wait ended solely on unit completions
	// with no event-driven flags pending: they fold/sweep but emit NO
	// host-global event and do NOT dispatch (dispatching there would
	// self-perpetuate — see waitForNext's resultsOnly return). A completion
	// with a pending flag is a full tick: that flag's dispatch was skipped
	// mid-flight and the completion is its prompt re-dispatch moment.
	resultsOnly := false

	for {
		// Read-only check: count clients and collect server keys
		h.mu.RLock()
		total := 0
		for _, cs := range h.clients {
			total += len(cs)
		}
		if total == 0 {
			h.mu.RUnlock()
			// Upgrade to write lock to set polling = false
			h.mu.Lock()
			// Re-check under write lock — a client may have been added
			recheck := 0
			for _, cs := range h.clients {
				recheck += len(cs)
			}
			if recheck == 0 {
				h.polling = false
				h.mu.Unlock()
				return
			}
			h.mu.Unlock()
			continue
		}
		servers := make([]string, 0, len(h.clients))
		for server := range h.clients {
			servers = append(servers, server)
		}
		h.mu.RUnlock()

		// Prune pending event-driven flags for servers that left the poll set
		// (last client disconnected; the dead-server reap below covers only
		// IsServerGone results). A stale flag would otherwise be load-bearing
		// forever: nothing dispatches an absent server, so the flag is never
		// consumed, and the resultsOnly pending-flag term would turn every
		// completion tick into a full tick — the self-perpetuation the
		// fold-only gate exists to prevent. Both maps are poll-goroutine-local.
		if len(eventDrivenServers) > 0 {
			inSet := make(map[string]bool, len(servers))
			for _, server := range servers {
				inSet[server] = true
			}
			for server := range eventDrivenServers {
				if !inSet[server] {
					delete(eventDrivenServers, server)
				}
			}
		}

		// Tick shape: fold → sweep → [dispatch tick: global broadcasts →
		// dispatch] → wait. Per-server work runs as concurrent units (bounded
		// by ssePollConcurrency) that emit their own server's events as they
		// complete; the poll goroutine itself never executes fetch work, so
		// one slow server cannot delay another server's snapshot, the
		// host-global broadcasts, or the sweeps below.
		//
		// Fold every unit result completed since the last tick.
		// deadServers collects servers whose tmux socket is gone
		// (tmux.IsServerGone) so they can be reaped from the poll set AFTER
		// the fold — never mid-unit, and never under the write lock while
		// FetchSessions runs. polledServers records which servers were
		// SUCCESSFULLY fetched in a folded result — the retain sweep is
		// scoped to these so a server whose fetch failed transiently, or
		// whose unit is still in flight (skipped at dispatch), counts as not
		// observed and keeps its still-waiting episodes.
		deadServers, liveWaitingKeys, liveAutoNameKeys, polledServers := h.foldPollResults()

		// Reap waiting-push episodes for windows no longer present, so a re-created
		// window id can't inherit a stale "pushed" flag. The sweep is SCOPED to
		// servers whose state we actually observed in a folded unit result: the
		// ones successfully polled (polledServers) plus the ones confirmed GONE
		// (deadServers — their windows truly vanished). A server that failed to
		// fetch TRANSIENTLY (non-IsServerGone) or whose unit is still IN FLIGHT
		// (skipped at dispatch, no result folded) is in neither set, so its
		// still-waiting episodes are left untouched — reaping them would reset
		// the run and fire a duplicate push the moment the server recovers.
		reapableServers := make(map[string]bool, len(polledServers)+len(deadServers))
		for s := range polledServers {
			reapableServers[s] = true
		}
		for _, s := range deadServers {
			reapableServers[s] = true
		}
		if h.waitingPush != nil {
			h.waitingPush.retain(liveWaitingKeys, reapableServers)
		}
		// Same reap for the auto-name tracker (260822-q675): dead windows/servers
		// drop their previous-state and cooldown stamps so the maps stay bounded.
		if autoName := h.getAutoName(); autoName != nil {
			autoName.retain(liveAutoNameKeys, reapableServers)
		}
		if operatorQueue := h.getOperatorQueue(); operatorQueue != nil {
			operatorQueue.retain(polledServers, reapableServers)
		}
		if listener := h.getPRReviewListener(); listener != nil {
			listener.retain(polledServers, reapableServers)
		}

		// Reap dead servers whose units reported the socket gone. A dead socket
		// has no reason to stay in the poll set ("no socket = no polling") — a
		// reconnecting client re-registers it naturally via addClient (which
		// re-spawns this goroutine when !h.polling). Emit a one-time
		// server-gone event to each dead server's registered clients so the
		// frontend can react immediately, then delete the server from h.clients
		// and ALL per-server maps so no stale state leaks into a future
		// re-registration. All mutation happens here, under a single write
		// lock, at the fold point (never mid-unit, never across FetchSessions).
		// The reporting unit has already completed — its folded result is what
		// landed the server here — so no in-flight unit touches these maps for
		// it; the pollInFlight delete is a safeguard (the completing unit clears
		// its own entry when it finishes bookkeeping).
		if len(deadServers) > 0 {
			h.mu.Lock()
			for _, server := range deadServers {
				for _, c := range h.clients[server] {
					select {
					case c.ch <- hubEvent{gone: true, key: server}:
					default:
					}
					// Detach the subscription from its owning connection so a
					// later re-subscribe re-registers cleanly (no stale record).
					if c.conn != nil {
						delete(c.conn.subs, server)
					}
				}
				delete(h.clients, server)
				delete(h.cache, server)
				delete(h.previousJSON, server)
				delete(h.previousSessionsKey, server)
				delete(h.previousRealSessions, server)
				delete(h.orderBootstrapAttempts, server)
				delete(h.previousOrderJSON, server)
				delete(h.previousPreviewJSON, server)
				delete(h.pollInFlight, server)
				delete(perServerGen, server)
				delete(eventDrivenServers, server)
			}
			// h.wakes is guarded by its own wakeMu (not h.mu). Drop each dead
			// server's wake channel so a reaped server leaves no residual entry.
			// Lock order is h.mu → wakeMu; no path takes them the other way
			// (wake() nests h.mu.RLock → wakeMu in this same order; the
			// other wake helpers touch only wakeMu), so this cannot
			// deadlock.
			h.wakeMu.Lock()
			for _, server := range deadServers {
				delete(h.wakes, server)
			}
			h.wakeMu.Unlock()
			h.mu.Unlock()
		}

		// Dispatch-tick work — skipped on results-only ticks (see above): the
		// host-global broadcasts ride dispatch ticks only, because a fold-only
		// tick has nothing new to say (unit completions carry their own
		// per-server frames), and each global emits only when its marshalled
		// payload differs from the cached slot. Then this tick's per-server
		// units dispatch, each on its own goroutine (bounded by
		// ssePollConcurrency via pollSem) delivering its result to pollResults
		// for a later tick's fold — the loop never joins on units, so a slow
		// server cannot stall the tick.
		if !resultsOnly {
			// Metrics (server-independent, fanned once per connection). The
			// collector snapshot and its marshal stay OUTSIDE h.mu; the
			// compare against the cached slot and the slot write happen under
			// it, and an unchanged payload emits nothing.
			if h.metrics != nil {
				snap := h.metrics.Snapshot()
				if metricsJSON, err := json.Marshal(snap); err == nil {
					metricsStr := string(metricsJSON)
					h.mu.Lock()
					if metricsStr != h.cachedMetricsJSON {
						h.cachedMetricsJSON = metricsStr
						h.broadcastGlobalLocked(preRendered(hubEvent{kind: kindGlobal, typ: "metrics", data: metricsStr}))
					}
					h.mu.Unlock()
				}
			}

			// Listening services — same change-only shape as metrics.
			if h.services != nil {
				snap := h.services.Snapshot()
				if servicesJSON, err := json.Marshal(snap); err == nil {
					servicesStr := string(servicesJSON)
					h.mu.Lock()
					if servicesStr != h.cachedServicesJSON {
						h.cachedServicesJSON = servicesStr
						h.broadcastGlobalLocked(preRendered(hubEvent{kind: kindGlobal, typ: "services", data: servicesStr}))
					}
					h.mu.Unlock()
				}
			}

			// The code-server signal — same change-only shape. Reachability
			// comes from the TTL-cached probe; the payload is replayed to late
			// joiners via cachedCodeServerJSON.
			if h.codeServerPort != 0 {
				_, reachable := h.codeServerTick()
				if payload, err := json.Marshal(codeServerPayload{Reachable: reachable}); err == nil {
					str := string(payload)
					h.mu.Lock()
					if str != h.cachedCodeServerJSON {
						h.cachedCodeServerJSON = str
						h.broadcastGlobalLocked(hubEvent{kind: kindGlobal, typ: "code-server", data: str})
					}
					h.mu.Unlock()
				}
			}

			// The GUI state (enabled or not) — change-only on the
			// age-stripped key inside guiTick; replays to late joiners via
			// cachedGuiJSON.
			h.guiTick()

			for _, server := range servers {
				// Metrics-only clients (server-neutral, `?metrics=1`) have no tmux
				// server — skip all session-fetch / order / reap work for them. They
				// still receive the server-independent metrics broadcast above,
				// which fans out to every registered client.
				if server == metricsOnlyServer {
					continue
				}
				// Single-flight: skip a server whose unit is still running (a
				// straggler from a prior tick or from a previous poll goroutine) —
				// one in-flight unit per server, always. Its pending
				// cache-invalidation flag stays un-consumed for its next dispatch.
				h.mu.RLock()
				inFlight := h.pollInFlight[server]
				h.mu.RUnlock()
				if inFlight {
					continue
				}
				select {
				case h.pollSem <- struct{}{}:
				default:
					// Concurrency bound reached — retried on the next
					// non-results-only tick (event wake or safety timer).
					continue
				}
				h.mu.Lock()
				h.pollInFlight[server] = true
				h.mu.Unlock()
				// Consume the server's pending cache-invalidation flag (set when
				// its wait channel fired in the last waitForNext) and hand it to
				// the unit as an immutable value — eventDrivenServers/perServerGen
				// stay owned by the poll goroutine.
				invalidateCache := eventDrivenServers[server]
				delete(eventDrivenServers, server)
				go h.runPollUnit(server, invalidateCache)
			}
		}

		// Connection liveness on the state socket is handled at the WebSocket
		// layer (failed write on the writer pump, read-loop error), not by an
		// SSE-style comment heartbeat — so there is no per-tick heartbeat frame.
		// Wait for either:
		//   (a) a tmux control-mode notification for any subscribed server
		//       (subscriber.Wait channel closes — typically sub-ms after a
		//       tmux mutation), OR
		//   (b) a signalled wake — per-server (wake()), membership (new server
		//       key subscribed), or a completed unit's results wake (fold its
		//       result promptly), OR
		//   (c) the safety-net ticker — guarantees correctness even when
		//       no subscriber is registered (PTY-unavailable case) or when
		//       control-mode is reconnecting.
		resultsOnly = h.waitForNext(servers, perServerGen, eventDrivenServers)
	}
}

// foldPollResults drains every unit result completed so far and merges them
// into the tick's accumulators: deadServers (tmux.IsServerGone — reaped by the
// caller), liveWaitingKeys/liveAutoNameKeys (live (server, windowID) keys for
// the retain sweeps), polledServers (successfully fetched — the sweep scoping
// set). A server whose unit is still in flight contributes nothing this tick:
// it is NOT observed, and the sweeps leave its tracker episodes untouched.
func (h *sseHub) foldPollResults() (deadServers []string, liveWaitingKeys, liveAutoNameKeys, polledServers map[string]bool) {
	liveWaitingKeys = map[string]bool{}
	liveAutoNameKeys = map[string]bool{}
	polledServers = map[string]bool{}
	for {
		select {
		case res := <-h.pollResults:
			if res.polled {
				polledServers[res.server] = true
			}
			if res.dead {
				deadServers = append(deadServers, res.server)
			}
			for k := range res.waitingKeys {
				liveWaitingKeys[k] = true
			}
			for k := range res.autoNameKeys {
				liveAutoNameKeys[k] = true
			}
		default:
			return
		}
	}
}

// runPollUnit executes one server's poll unit and delivers the outcome. The
// result is queued BEFORE the in-flight flag clears, so the poll goroutine
// cannot re-dispatch the server while its latest result is still unfolded;
// completion always signals the results wake so a parked waitForNext folds
// promptly instead of waiting out the safety timer. A unit that outlives its
// poll goroutine (total == 0 exit, later re-spawn) still runs this exact
// sequence — the buffered channel never blocks it, the fresh poll goroutine
// sees the in-flight entry until it clears (no double dispatch), and its late
// result folds harmlessly (a server absent from h.clients no-ops through the
// sweeps and the reap).
func (h *sseHub) runPollUnit(server string, invalidateCache bool) {
	res := h.pollServerUnit(server, invalidateCache)
	h.pollResults <- res
	h.mu.Lock()
	delete(h.pollInFlight, server)
	h.mu.Unlock()
	<-h.pollSem
	h.signalResultsWake()
}

// pollServerUnit executes one server's per-tick poll work: cache check →
// FetchSessions → attachPRStatus → waiting-push/auto-name/operator-queue
// advance → sessions marshal/dedup/emit → previews → order bootstrap →
// disappearance WARN. The unit emits its server's events itself (per-server
// emission on completion, never batched at end of tick) and returns the
// tick's accumulators as a pollUnitResult for the poll goroutine to fold.
// Execution within a unit is serial — capturePreviews' one exec per expanded
// window stays sequential.
func (h *sseHub) pollServerUnit(server string, invalidateCache bool) pollUnitResult {
	res := pollUnitResult{server: server, waitingKeys: map[string]bool{}, autoNameKeys: map[string]bool{}}
	// Check session fetch cache (500ms TTL). invalidateCache records whether
	// the prior waitForNext call observed a control-mode notification for this
	// server (the poll goroutine consumes the flag at dispatch); when set,
	// invalidate the cache so we observe the post-mutation tmux state
	// immediately. All h.cache access is
	// under h.mu — handler goroutines read the same map under h.mu
	// (sendCachedPreviewLocked, the dead-server reap), so an
	// unsynchronized poll-side access is a crash-class map race.
	// The lock is held only around the map operations, NEVER across
	// FetchSessions (a subprocess exec with up to 10s of inner execs).
	h.mu.Lock()
	if invalidateCache {
		delete(h.cache, server)
	}
	var result []sessions.ProjectSession
	var cacheHit bool
	if cached, ok := h.cache[server]; ok && time.Since(cached.fetchedAt) < sseCacheTTL {
		result, cacheHit = cached.data, true
	}
	h.mu.Unlock()
	if !cacheHit {
		var err error
		result, err = h.fetcher.FetchSessions(context.Background(), server)
		if err != nil {
			if tmux.IsServerGone(err) {
				// The tmux socket is gone — killed, never started, or
				// unreachable. Reap it from the poll set instead of
				// re-polling the corpse every tick (the WARN drumbeat).
				// Reported in the unit result; the poll goroutine reaps
				// after folding completed results (see poll()).
				slog.Info("SSE: tmux server gone, reaping from poll set", "server", server)
				res.dead = true
			} else {
				slog.Warn("SSE poll error", "err", err, "server", server)
			}
			return res
		}
		h.mu.Lock()
		h.cache[server] = &cachedResult{data: result, fetchedAt: time.Now()}
		h.mu.Unlock()
	}

	// Attach live PR status to any window with a derived PR. PURE
	// in-memory read of the collector snapshot — the hot path makes NO
	// network/gh call. All gh cost lives on background ticks: the
	// viewer-wide collector's 90s tick (state/checks/review) + on-demand
	// POST, and the branch→PR refresher's tick (PrURL/PrNumber, derived
	// upstream in FetchSessions via register + snapshot-join, also
	// network-free here). NOTE: `result` and `h.cache[server].data` are the SAME
	// slice (stored by reference above), so this mutates the cached
	// snapshot in place — that is intentional, and the mutation runs
	// under h.mu because handler goroutines read the same slice under
	// h.mu (sendCachedPreviewLocked → windowsBySession); an unlocked
	// in-place write would be a value-level data race against them.
	// attachPRStatus is pure in-memory (collector snapshot read, no
	// I/O), so the hold is bounded. It is also idempotent: it resets
	// the three collector-only fields (PrChecks/PrReview/PrFetchedAt)
	// to zero before re-attaching, so re-running it on a cache hit
	// yields the same result and a PR that left the collector snapshot
	// clears those cleanly. The dual-sourced PrState/PrIsDraft are
	// deliberately NOT reset, so on a cache hit they keep whatever the
	// previous tick left — bounded by one cache generation (500ms),
	// after which FetchSessions re-seeds both from the branch channel.
	// Re-deriving every tick keeps the cached sessions in sync with the
	// latest PR snapshot without a deep copy.
	h.mu.Lock()
	h.attachPRStatus(result)
	h.mu.Unlock()

	// This server's fetch succeeded — record it in the unit result so the
	// post-fold reap only sweeps episodes belonging to servers actually polled.
	res.polled = true

	// Web Push on sustained waiting (260706-y1ar). Ride this per-server
	// tick, where the rolled-up window AgentState already exists: advance
	// the episode tracker (pure, synchronous — no I/O in the hot path) and
	// fan the resulting pushes out in a detached goroutine inside
	// notifyWaiting. Best-effort, in-memory only; push errors never block
	// the tick. Accumulate the live keys into the unit result for the
	// post-fold reap.
	if h.waitingPush != nil {
		for k := range h.waitingPush.notifyWaiting(server, result) {
			res.waitingKeys[k] = true
		}
	}

	// Auto-name on busy→idle (260822-q675). Same seam and same shape as
	// waiting-push above: the decision is pure/synchronous (no I/O in the
	// hot path), delivery fans out in a detached goroutine inside advance
	// through the injected deliver closure (nil in test hubs — tracking
	// still advances). Rate-limited and skipped when the operator is
	// busy; best-effort, in-memory only, never blocks the tick.
	if autoName := h.getAutoName(); autoName != nil {
		for k := range autoName.advance(server, result) {
			res.autoNameKeys[k] = true
		}
	}

	if operatorQueue := h.getOperatorQueue(); operatorQueue != nil {
		operatorQueue.advance(server, result)
	}

	// PR-review comment listener: same seam, same shape — the queue refresh
	// and the reservation are synchronous and subprocess-free (the arm rides
	// the window payload and the eligible threads come from the collector's
	// already-polled digest), and delivery fans out detached.
	if listener := h.getPRReviewListener(); listener != nil {
		listener.advance(server, result)
	}

	jsonBytes, err := json.Marshal(result)
	if err != nil {
		return res
	}
	jsonStr := string(jsonBytes)
	key, err := sessionsDedupKey(result)
	if err != nil {
		return res
	}

	// Dedup-check and cache-update under the lock, but render OUTSIDE
	// it: the envelope marshal on this hot tick must not extend h.mu
	// hold time (it would block subscribe/unsubscribe/preview-scope
	// updates). Splitting the critical section is safe:
	//   - the ack-ordering invariant holds — previousJSON (the last SENT
	//     payload; ack/replay snapshots read it) and previousSessionsKey
	//     are updated TOGETHER BEFORE any fan-out of that tick, so a
	//     subscribe ack reading previousJSON is always ≥ every sessions
	//     frame already enqueued
	//     (TestStateWS_SubscribeAckNotStaleUnderPollInterleave);
	//   - a client subscribing in the gap replays the NEW snapshot in
	//     addClient and then also receives the identical event below —
	//     a benign duplicate (the client applies state by replacement).
	// The dedup compares the KEY, not the payload: the key zeroes
	// ActivityTimestamp on active windows so output churn on an
	// already-`flowing` window does not re-emit a frame nothing visible
	// reads, while a suppressed tick leaves previousJSON holding the last
	// payload clients actually hold.
	h.mu.Lock()
	changed := key != h.previousSessionsKey[server]
	if changed {
		h.previousJSON[server] = jsonStr
		h.previousSessionsKey[server] = key
	}
	h.mu.Unlock()
	if changed {
		// Render once — every client on this server gets the same bytes.
		ev := preRendered(hubEvent{kind: kindServer, typ: "sessions", key: server, data: jsonStr})
		h.mu.Lock()
		for _, c := range h.clients[server] {
			h.sendLocked(c, ev)
		}
		h.mu.Unlock()
	}

	// Pane-text previews (tile grid). Bounded to the union of sessions
	// any client on this server has expanded — capture-nothing when the
	// union is empty (opt-in per expansion). Rides this existing poll
	// tick: no new goroutine, no new loop. The tmux captures run OUTSIDE
	// the hub lock (each is an exec with its own timeout), then a
	// re-lock delivers each client a per-connection-filtered subset over
	// a dedicated `event: preview`. The sessions payload above is
	// unchanged — preview text never bloats the sessions dedup cache.
	h.mu.RLock()
	union := expandedUnionLocked(h.clients[server])
	h.mu.RUnlock()
	if len(union) > 0 {
		previews := capturePreviews(result, union, server, h.captureFn)
		byWindow := windowsBySession(result)
		h.mu.Lock()
		h.previousPreviewJSON[server] = previews
		for _, c := range h.clients[server] {
			subset := previewSubsetFor(c, previews, byWindow)
			if subset == nil {
				continue
			}
			if payload, perr := json.Marshal(subset); perr == nil {
				h.sendLocked(c, hubEvent{kind: kindServer, typ: "preview", key: server, data: string(payload)})
			}
		}
		h.mu.Unlock()
	}

	// Bootstrap: on first poll per server, seed the order cache from
	// tmux. Closes the gap when rk-go restarts but tmux survives —
	// connecting clients otherwise see no order until the next POST.
	// Runs after the sessions broadcast so first-poll event order is
	// sessions → session-order → metrics.
	//
	// Errors are retried up to orderBootstrapMaxAttempts before giving
	// up — transient tmux failures (e.g., a momentary timeout) can
	// recover, but a persistent failure won't poll-spam every tick.
	// Bootstrap state is tracked separately from previousOrderJSON so
	// a successful POST (which populates previousOrderJSON via
	// broadcastSessionOrder) cleanly satisfies the "seeded" gate.
	h.mu.RLock()
	_, orderSeeded := h.previousOrderJSON[server]
	attempts := h.orderBootstrapAttempts[server]
	h.mu.RUnlock()
	if !orderSeeded && attempts < orderBootstrapMaxAttempts {
		bootCtx, cancelBoot := context.WithTimeout(context.Background(), 2*time.Second)
		order, oerr := h.orderFetcher.GetSessionOrder(bootCtx, server)
		cancelBoot()
		if oerr != nil {
			slog.Debug("session-order bootstrap (best-effort)", "server", server, "err", oerr, "attempt", attempts+1)
			h.mu.Lock()
			h.orderBootstrapAttempts[server] = attempts + 1
			h.mu.Unlock()
		} else {
			h.broadcastSessionOrder(server, order)
		}
	}

	// Board membership changes are surfaced only via the explicit
	// pin/unpin/reorder handlers (each emits its own board-changed
	// event). Under the link-based model a killed pinned window's pin-session simply
	// drops out of the next ListBoardEntries read — the frontend's
	// refetch on the session-list change picks it up — so there is no
	// eager board-cleanup diff and no first-poll bootstrap broadcast.

	// Real-session disappearance logging (observability only — no
	// behavior change). run-kit audit-logs every session IT kills
	// (board pin-session teardown on unpin, explicit kill-session), but
	// a real user session can vanish OUTSIDE that path — a shell exiting,
	// an external `tmux kill-session`, an OOM kill, or a server collapsing
	// to zero under `exit-empty`. When that happens today the logs go
	// silent, making post-hoc diagnosis impossible (see the `utils`
	// incident). Emit one WARN per disappeared real session so the next
	// occurrence is diagnosable. We exclude pin-session/anchor churn via
	// realSessionNameSet. This does NOT prevent the loss — it records
	// it. Constitution VI PREVENTION (always-on `_rk-ctl` anchor floor +
	// imperative `exit-empty off` on every dialed server) is implemented
	// in change 260602-a1wo-prevent-exit-empty-server-death
	// (tmuxctl.resolveBootstrap / productionDial, tmux.SetExitEmptyOff).
	// This WARN is KEPT as defense-in-depth: it still surfaces losses
	// from paths prevention can't cover — an external `tmux kill-session`,
	// an OOM kill, or a shell exiting a real session.
	currentReal := realSessionNameSet(result)
	h.mu.RLock()
	prevReal, hadPrevReal := h.previousRealSessions[server]
	h.mu.RUnlock()
	if hadPrevReal {
		for _, name := range detectDisappearedSessions(prevReal, currentReal) {
			slog.Warn("real session disappeared between SSE polls (not killed by run-kit's audited path)",
				"server", server, "session", name,
				"remaining", len(currentReal))
		}
	}
	h.mu.Lock()
	h.previousRealSessions[server] = currentReal
	h.mu.Unlock()
	return res
}

// sessionsDedupKey renders the dedup key for a sessions snapshot: the same
// JSON the wire payload carries, but with ActivityTimestamp zeroed on every
// window whose Activity is "active". The client renders no timestamp for an
// active window (it shows `flowing`), so output churn there changes nothing
// visible and must not re-emit the frame; an idle window's timestamp drives
// its `idle <dur>` label and stays in the key. The input is the cached
// result slice other consumers (attachPRStatus, previews) read, so the key
// is built from shallow copies — result is never mutated.
func sessionsDedupKey(result []sessions.ProjectSession) (string, error) {
	keyed := make([]sessions.ProjectSession, len(result))
	for i := range result {
		keyed[i] = result[i]
		windows := make([]tmux.WindowInfo, len(result[i].Windows))
		copy(windows, result[i].Windows)
		for j := range windows {
			if windows[j].Activity == tmux.WindowActivityActive {
				windows[j].ActivityTimestamp = 0
			}
		}
		keyed[i].Windows = windows
	}
	b, err := json.Marshal(keyed)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// wake marks the server for an immediate snapshot pass. Non-blocking and safe
// from any goroutine; called by the option-mutation handlers after a successful
// tmux write (set-option @rk_win_color/@rk_ses_color/@rk_win_web_<n>/@rk_win_layout is invisible to
// the tmuxctl control-mode parser, so no subscriber notification fires — the
// wake is the freshness driver for these mutations). Per-server, keyed by the
// same server name the poll set uses. A wake for a name with NO existing
// h.wakes entry and no connected clients is dropped without allocating (see
// the gate below); a server with an existing entry keeps accepting wakes even
// while momentarily client-less — the pending signal fires on resubscribe.
// Coalescing, at-least-once: N wakes before consumption trigger
// 1..N passes; redundant passes are suppressed by the previousJSON dedup.
func (h *sseHub) wake(server string) {
	// Allocation gate: /api/servers/wake accepts any syntactically valid
	// name from out-of-process callers, and nothing reaps h.wakes entries
	// for servers outside the poll set — so a NEW entry is created only for
	// a server with a live subscription, keeping arbitrary names from
	// growing the map unboundedly. An EXISTING entry (any server the poll
	// loop has ever waited on — wakeChannel creates them) still accepts the
	// wake even with zero clients at this instant: the closed channel stays
	// pending and fires the moment a client resubscribes, so a wake racing
	// a brief socket reconnect is deferred, never lost. The RLock is held
	// across the wakeMu section so the client-set check and the allocation
	// agree (a concurrent last-client removal needs the write lock); the
	// nesting follows the reap loop's h.mu → wakeMu lock order, never the
	// reverse.
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	ch, ok := h.wakes[server]
	if !ok {
		if len(h.clients[server]) == 0 {
			return
		}
		ch = make(chan struct{})
		h.wakes[server] = ch
	}
	select {
	case <-ch:
		// Already closed — a wake is already pending; coalesce.
	default:
		close(ch)
	}
}

// wakeChannel returns the current wake-signal channel for a server, lazily
// creating an open one if none exists. waitForNext adds the returned channel as
// a wait case. A channel returned here that is ALREADY closed means a wake
// landed before the loop reached waitForNext — it fires immediately, exactly as
// intended (at-least-once). Guarded by wakeMu.
func (h *sseHub) wakeChannel(server string) <-chan struct{} {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	ch, ok := h.wakes[server]
	if !ok {
		ch = make(chan struct{})
		h.wakes[server] = ch
	}
	return ch
}

// consumeWake retires a server's wake signal if it is currently closed: it
// replaces the closed channel with a fresh open one and reports true. Called
// when waitForNext observes a server's wake channel fired (winner or peek). The
// replacement happens BEFORE the next fetch pass, so a wake landing between
// observation and fetch closes the FRESH channel and triggers one more pass —
// never lost, and never a busy-loop (the closed channel is retired the moment
// it is observed). If the channel is not closed (a spurious call, or a wake that
// was already consumed), it is left in place and consumeWake reports false.
// Guarded by wakeMu.
func (h *sseHub) consumeWake(server string) bool {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	ch, ok := h.wakes[server]
	if !ok {
		return false
	}
	select {
	case <-ch:
		// Closed — a wake was pending. Retire it with a fresh open channel.
		h.wakes[server] = make(chan struct{})
		return true
	default:
		return false
	}
}

// wakeMembership signals that a server key NOT previously in h.clients just
// gained a subscription while the poll loop is running. The parked waitForNext
// cannot see a per-server wake for a server absent from its current case list,
// so this hub-level signal is what unparks it for a cold subscribe to a
// new-to-the-poll-set server. Called from addClient with h.mu held — the
// nesting follows the documented h.mu → wakeMu lock order. Non-blocking and
// coalescing: a repeat signal before consumption is a no-op.
func (h *sseHub) wakeMembership() {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	if h.membershipWake == nil {
		h.membershipWake = make(chan struct{})
	}
	select {
	case <-h.membershipWake:
		// Already closed — a membership wake is already pending; coalesce.
	default:
		close(h.membershipWake)
	}
}

// membershipWakeChannel returns the current hub-level membership-wake channel
// (lazily created) for waitForNext to add as a wait case on every wait. A
// channel returned here that is ALREADY closed means a membership wake landed
// before the loop reached waitForNext — it fires immediately (at-least-once).
// Guarded by wakeMu.
func (h *sseHub) membershipWakeChannel() <-chan struct{} {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	if h.membershipWake == nil {
		h.membershipWake = make(chan struct{})
	}
	return h.membershipWake
}

// consumeMembershipWake retires a pending membership wake: if the channel is
// currently closed it is replaced with a fresh open one and true is reported.
// The replacement happens BEFORE the next poll pass, so a membership wake
// landing between observation and the re-derived fetch closes the fresh
// channel and triggers one more pass — at-least-once, never lost, never a
// busy-loop. Guarded by wakeMu.
func (h *sseHub) consumeMembershipWake() bool {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	if h.membershipWake == nil {
		return false
	}
	select {
	case <-h.membershipWake:
		h.membershipWake = make(chan struct{})
		return true
	default:
		return false
	}
}

// signalResultsWake signals that a per-server poll unit completed and its
// result is queued for folding. The parked waitForNext cannot see unit
// completion otherwise, so this hub-level signal unparks it promptly — a dead
// server's gone frame and the retain sweeps run on the next fold instead of
// waiting out the safety timer. Called by unit goroutines with no hub lock
// held (wakeMu nests under h.mu, never the reverse). Non-blocking and
// coalescing: a repeat signal before consumption is a no-op; the fold drains
// every queued result, so one wake covers any number of completions.
func (h *sseHub) signalResultsWake() {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	if h.resultsWake == nil {
		h.resultsWake = make(chan struct{})
	}
	select {
	case <-h.resultsWake:
		// Already closed — a results wake is already pending; coalesce.
	default:
		close(h.resultsWake)
	}
}

// resultsWakeChannel returns the current hub-level results-wake channel
// (lazily created) for waitForNext to add as a wait case on every wait. A
// channel returned here that is ALREADY closed means a unit completed before
// the loop reached waitForNext — it fires immediately (at-least-once).
// Guarded by wakeMu.
func (h *sseHub) resultsWakeChannel() <-chan struct{} {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	if h.resultsWake == nil {
		h.resultsWake = make(chan struct{})
	}
	return h.resultsWake
}

// consumeResultsWake retires a pending results wake: if the channel is
// currently closed it is replaced with a fresh open one and true is reported.
// The replacement happens BEFORE the fold, so a unit completing between
// observation and the fold closes the fresh channel and triggers one more
// pass — at-least-once, never lost, never a busy-loop. Guarded by wakeMu.
func (h *sseHub) consumeResultsWake() bool {
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	if h.resultsWake == nil {
		return false
	}
	select {
	case <-h.resultsWake:
		h.resultsWake = make(chan struct{})
		return true
	default:
		return false
	}
}

// waitForNext blocks until either a control-mode notification fires for any of
// the supplied servers, a wake is signalled for any of them (via wake()), a
// NEW server key enters the subscription set (via the membership wake), a poll
// unit completes (via the results wake), OR the safety-net timer elapses.
// Updates perServerGen with each server's current generation so the next pass
// can detect change, and marks woken/notified servers in eventDrivenServers so
// poll() invalidates their fetch cache at dispatch.
//
// The resultsOnly return reports that the wait ended SOLELY on unit
// completions (no timer, no subscriber bump, no wake, no membership signal)
// AND no event-driven flags are pending in eventDrivenServers. The caller runs
// such ticks fold-only — no dispatch — because dispatching on unit completion
// alone would self-perpetuate (dispatch → complete → results wake →
// dispatch …); re-poll cadence for completed servers comes from their own
// wakes and the safety timer, exactly as it did before the fan-out. A pending
// flag is the exception: it marks a bump already consumed (its Wait channel
// re-armed at the updated generation) whose dispatch was skipped mid-flight,
// so the completion tick is its only prompt dispatch opportunity — deferring
// it would be a lost wakeup healed only by the safety timer.
//
// Wake cases are built independent of the subscriber snapshot: a wake must wake
// the loop even when subscriber == nil (unit-test hubs, PTY-unavailable hosts),
// where the code previously short-circuited to a timer-only wait. Wake wins do
// NOT enter subscriber bookkeeping (no perServerGen / Generation() touch) —
// they are distinguished from subscriber cases by waitCase.isWake.
//
// The subscriber is snapshot ONCE per call (getSubscriber, under h.mu.RLock)
// and threaded through the whole wait — the interval selection, the case
// build, and the peek closure — so a concurrent SetWindowChangeSubscriber
// never races a plain field read and one wait always sees a single
// consistent subscriber view.
//
// The membership wake is the ONLY signal that can unpark a wait for a server
// absent from the current case list: the cases below cover just this call's
// server-list snapshot, so a brand-new server's per-server wake channel is
// watched by nobody. A membership win carries no per-server bookkeeping (a
// brand-new server has no cache to invalidate and no generation entry) — the
// next poll pass re-derives the server list, which now includes the new key.
// The results wake is likewise bookkeeping-free: a unit completion simply
// unparks the loop so the next tick folds the queued result.
func (h *sseHub) waitForNext(servers []string, perServerGen map[string]int64, eventDrivenServers map[string]bool) (resultsOnly bool) {
	sub := h.getSubscriber()
	timer := time.NewTimer(h.safetyIntervalEffective(servers, sub))
	defer timer.Stop()

	// Build wait cases: a subscriber case per server (only when a subscriber is
	// wired), anchored at the generation we last observed, a wake case per
	// server (always — independent of the subscriber), the hub-level membership
	// wake (always), AND the hub-level results wake (always — a completing unit
	// unparks the loop for a prompt fold). selectFirst falls through to the
	// timer when the combined case list is empty.
	cases := make([]waitCase, 0, len(servers)*2+2)
	for _, server := range servers {
		if sub != nil {
			after := perServerGen[server]
			cases = append(cases, waitCase{server: server, ch: sub.Wait(server, after)})
		}
		cases = append(cases, waitCase{server: server, ch: h.wakeChannel(server), isWake: true})
	}
	cases = append(cases, waitCase{ch: h.membershipWakeChannel(), isMembership: true})
	cases = append(cases, waitCase{ch: h.resultsWakeChannel(), isResults: true})

	// selectFirst blocks until one case's channel fires (or the timer wins). It
	// returns only the winning server NAME, not which kind of case fired — and
	// a fired channel stays readable (subscriber Wait fires by close; wake fires
	// by close) — so we don't special-case the winner. Instead, once selectFirst
	// unblocks, a single non-blocking peek over ALL cases picks up every case
	// that has fired (the winner plus any that fired concurrently), routing each
	// by kind. This is correct even when a server has BOTH a subscriber case
	// and a wake case that fired: each is handled independently in one pass.
	// Re-peeking a closed subscriber channel is idempotent: Generation() re-read
	// folds any newer bumps into perServerGen, and consumeWake reports false for
	// an already-retired wake.
	peek := func() (bumped, woke, results bool) {
		for _, c := range cases {
			select {
			case <-c.ch:
				switch {
				case c.isMembership:
					// A new server key entered the subscription set mid-wait.
					// woke keeps a pending debounce window from delaying the
					// pass that re-derives the server list and fetches it.
					if h.consumeMembershipWake() {
						woke = true
					}
				case c.isResults:
					// A poll unit completed mid-wait. results is tracked
					// separately from woke: a results-ONLY win re-arms the
					// loop fold-only when no event-driven flags are pending
					// (see the resultsOnly return — a retained flag makes the
					// completion tick a full tick), and it still ends a
					// pending debounce window so the fold is not delayed.
					if h.consumeResultsWake() {
						results = true
					}
				case c.isWake:
					// Only mark event-driven when this call actually retires a
					// pending (closed) wake — consumeWake reports false once the
					// wake has already been retired (e.g. two servers sharing a
					// name cannot happen, but a repeated peek must be idempotent).
					if h.consumeWake(c.server) {
						eventDrivenServers[c.server] = true
						woke = true
					}
				default:
					perServerGen[c.server] = sub.Generation(c.server)
					eventDrivenServers[c.server] = true
					bumped = true
				}
			default:
			}
		}
		return bumped, woke, results
	}

	selectFirst(cases, timer)
	// A timer win — or a timer that fired concurrently with a channel win —
	// makes this a full tick. Conservative by design: a fold+dispatch pass is
	// always correct, a wrongly fold-only pass would stall dispatch until the
	// next external signal.
	timerFired := false
	select {
	case <-timer.C:
		timerFired = true
	default:
	}
	bumped, woke, results := peek()
	// Unit completions alone must not re-arm dispatch: a results-driven tick
	// that dispatched would self-perpetuate (dispatch → complete → wake →
	// dispatch …). Anything else in the mix (timer, bump, wake, membership)
	// runs a normal full tick — and so does a completion while event-driven
	// flags are still pending: a bump consumed during a unit's flight is
	// skipped at dispatch (single-flight / pollSem), so the completion is
	// exactly the moment its retained flag becomes dispatchable. Without the
	// pending-flag term the flag would wait out the safety timer (a lost
	// wakeup — its Wait channel is already re-armed at the updated
	// generation). Self-perpetuation stays impossible: entries are consumed
	// at dispatch and re-set only by real bumps/wakes, so an empty pending
	// map keeps the fold-only path.
	resultsOnly = results && !bumped && !woke && !timerFired && len(eventDrivenServers) == 0

	// Coalesce subscriber-bump-driven passes: a control-mode event burst (e.g.
	// %window-renamed from cd churn under automatic-rename-format
	// '#{b:pane_current_path}') must cost ONE derive, not one per event, so the
	// event-driven derive rate is floored at sseEventDebounce. The window is
	// entered only for a pure bump win: a wake or unit completion consumed in
	// the same peek — or firing mid-window, ending the selectFirst below
	// early — keeps its sub-second post-mutation repaint (the wake seam's
	// whole purpose) / prompt fold, and a timer win (bumped == false) adds no
	// delay. The final peek folds every bump/wake/completion that landed
	// during the window into this same pass; a bump landing after it closes
	// the NEXT Wait channel (anchored at the updated perServerGen), so nothing
	// is lost.
	if !bumped || woke || results {
		return resultsOnly
	}
	window := h.eventDebounce
	if window <= 0 {
		window = sseEventDebounce
	}
	debounce := time.NewTimer(window)
	defer debounce.Stop()
	wakeCases := make([]waitCase, 0, len(servers)+2)
	for _, c := range cases {
		if c.isWake || c.isMembership || c.isResults {
			wakeCases = append(wakeCases, c)
		}
	}
	selectFirst(wakeCases, debounce)
	peek()
	return false
}

// waitCase is a small (server, channel) pair used by selectFirst to
// determine which server's wait fired first. We avoid reflect.Select by
// fan-in: each channel sends its server name to a unifying channel. isWake
// distinguishes a wake-signal case (wakeChannel) from a subscriber Wait case:
// wake wins skip subscriber bookkeeping and consume the wake instead.
// isMembership marks the hub-level membership-wake case — a win there means
// a new server key joined the subscription set mid-wait; it carries no
// per-server bookkeeping (the peek consumes the signal and the next pass
// re-derives the server list). isResults marks the hub-level results-wake
// case — a win there means a poll unit completed mid-wait; it likewise
// carries no per-server bookkeeping (the next pass folds the queued result).
type waitCase struct {
	server       string
	ch           <-chan struct{}
	isWake       bool
	isMembership bool
	isResults    bool
}

// selectFirst blocks until either one of the wait channels closes OR the
// safety-net timer fires. Returns the server name whose channel fired (or
// the empty string when the timer wins). Reading timer.C directly in the
// outer select avoids the goroutine leak that occurs when a subscriber
// wins the race and the timer goroutine would otherwise block forever on
// timer.C (Stop does not deliver on C).
func selectFirst(cases []waitCase, timer *time.Timer) string {
	if len(cases) == 0 {
		<-timer.C
		return ""
	}
	out := make(chan string, len(cases))
	stop := make(chan struct{})
	defer close(stop)
	for _, c := range cases {
		go func(c waitCase) {
			select {
			case <-c.ch:
				select {
				case out <- c.server:
				case <-stop:
				}
			case <-stop:
			}
		}(c)
	}
	select {
	case s := <-out:
		return s
	case <-timer.C:
		return ""
	}
}

// The former SSE edge (handleSSE + `GET /api/sessions/stream`) was retired in
// 260716-qf3j-state-socket — the frontend was the sole consumer and it now
// speaks the state-socket protocol over `/ws/state` (see state_ws.go). The hub
// machinery above (poll, collectors, broadcast helpers) is unchanged; only the
// client-facing transport moved from SSE to WebSocket.
