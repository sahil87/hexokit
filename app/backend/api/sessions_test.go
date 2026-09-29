package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

// mockSessionFetcher returns canned session data.
type mockSessionFetcher struct {
	result []sessions.ProjectSession
	err    error
	// calls counts FetchSessions invocations (handlers that must resolve
	// everything from ONE fetch assert on it).
	calls int
}

func (m *mockSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	m.calls++
	return m.result, m.err
}

// moveWindowCall is one recorded MoveWindow invocation.
type moveWindowCall struct {
	windowID string
	dstIndex int
}

// mockTmuxOps records calls for verification.
//
// Most fields are written and read within a single goroutine (synchronous
// handler tests), so they need no locking. The kill-session fields are the
// exception: a deferred cleanup on the SERVER goroutine may observe them while
// the test goroutine reads them, so those two are guarded by killMu and
// accessed via KillSessionWasCalled.
type mockTmuxOps struct {
	createSessionCalled  bool
	createSessionName    string
	createSessionCwd     string
	killMu               sync.Mutex
	killSessionCalled    bool
	killSessionName      string
	renameSessionCalled  bool
	renameSessionSession string
	renameSessionName    string

	createWindowCalled  bool
	createWindowSession string
	createWindowName    string
	createWindowCwd     string
	killWindowCalled    bool
	killWindowID        string
	swapWindowCalled    bool
	swapWindowID        string
	swapWindowDstIndex  int
	swapWindowErr       error
	// moveWindowCalls records every MoveWindow invocation in order (the
	// single-value swapWindow* fields above keep only the last). Sort-batch
	// handler tests assert the full call sequence.
	moveWindowCalls               []moveWindowCall
	moveWindowToSessionCalled     bool
	moveWindowToSessionWindowID   string
	moveWindowToSessionDstSession string
	moveWindowToSessionErr        error
	renameWindowCalled            bool
	renameWindowWindowID          string
	renameWindowName              string
	sendKeysCalled                bool
	sendKeysWindowID              string
	sendKeysKeys                  string

	selectWindowInSessionCalled   bool
	selectWindowInSessionSession  string
	selectWindowInSessionWindowID string
	selectWindowInSessionErr      error

	listWindowsResult []tmux.WindowInfo
	listWindowsErr    error
	// listWindowsBySession, when non-nil, makes ListWindows session-aware:
	// it returns the windows mapped to the queried session name (empty slice
	// for an unmapped session). This is required to faithfully model the
	// link-based board world, where a pinned window is a member of BOTH its
	// `_rk-pin-<id>` pin-session AND its home session at once — the flat
	// listWindowsResult (returned for every session) cannot express that a window
	// appears under two distinct session keys.
	listWindowsBySession map[string][]tmux.WindowInfo
	listSessionsResult   []tmux.SessionInfo
	listServersResult    []string

	resolveWindowSessionResult string
	resolveWindowSessionErr    error
	resolveWindowSessionID     string

	// Relay isolation: the ensure call record plus canned results, and the
	// client-count probe result the attach-failure rollback reads. isoMu guards
	// the ensure fields — the relay's attachStream writes them off the test
	// goroutine (socket-driven opens).
	isoMu                    sync.Mutex
	ensureIsoSessionCalled   bool
	ensureIsoSessionWindowID string
	ensureIsoSessionResult   string
	ensureIsoSessionErr      error
	sessionClientCountResult int
	sessionClientCountErr    error

	activeWindowIDResult  string
	activeWindowIDErr     error
	activeWindowIDServer  string
	activeWindowIDSession string

	// hasSessionNames, when non-nil, makes HasSession return true only for the
	// listed session names (models the relay's pin-session-first probe). When nil,
	// HasSession returns false for everything (no pin-session present).
	hasSessionNames map[string]bool

	splitWindowCalled     bool
	splitWindowID         string
	splitWindowHorizontal bool
	splitWindowResult     string
	splitWindowErr        error

	selectPaneCalled bool
	selectPanePaneID string
	selectPaneServer string
	selectPaneErr    error

	killActivePaneCalled   bool
	killActivePaneWindowID string

	setSessionColorCalled    bool
	setSessionColorSession   string
	setSessionColorColor     string
	setSessionColorErr       error
	unsetSessionColorCalled  bool
	unsetSessionColorSession string
	unsetSessionColorErr     error

	setSessionFlairCalled    bool
	setSessionFlairSession   string
	setSessionFlairFlair     string
	setSessionFlairErr       error
	unsetSessionFlairCalled  bool
	unsetSessionFlairSession string
	unsetSessionFlairErr     error

	setWindowColorCalled     bool
	setWindowColorWindowID   string
	setWindowColorColor      string
	setWindowColorErr        error
	unsetWindowColorCalled   bool
	unsetWindowColorWindowID string
	unsetWindowColorErr      error

	setWindowOptionCalled   bool
	setWindowOptionWindowID string
	setWindowOptionOption   string
	setWindowOptionValue    string

	unsetWindowOptionCalled   bool
	unsetWindowOptionWindowID string
	unsetWindowOptionOption   string

	setWindowOptionsCalled   bool
	setWindowOptionsWindowID string
	setWindowOptionsOps      []tmux.WindowOptionOp
	// setWindowLayoutsPairs records every chained multi-window layout write
	// (the borrow/return handlers) in call order.
	setWindowLayoutsCalled bool
	setWindowLayoutsPairs  []tmux.WindowLayoutWrite
	setWindowLayoutsErr    error
	clearWindowRoleCalled  bool
	clearWindowRoleKeepID  string
	clearWindowRoleResult  []string

	moveInOperatorCalled   bool
	moveInOperatorWindowID string
	moveInOperatorErr      error
	demoteOperatorCalled   bool
	demoteOperatorWindowID string
	demoteOperatorErr      error

	createWindowWithOptionsCalled  bool
	createWindowWithOptionsSession string
	createWindowWithOptionsName    string
	createWindowWithOptionsCwd     string
	createWindowWithOptionsOps     []tmux.WindowOptionOp

	getSessionOrderCalled bool
	getSessionOrderResult []string
	getSessionOrderErr    error

	setSessionOrderCalled bool
	setSessionOrderOrder  []string
	setSessionOrderErr    error

	// Server rank. rankMu guards the concurrent fan-out reads/writes (the
	// /api/servers handler calls GetServerRank once per server in parallel).
	rankMu                   sync.Mutex
	getServerRankByServer    map[string]*int
	getServerRankErrByServer map[string]error
	setServerRankCalls       []struct {
		Server string
		Rank   int
	}

	// Ephemeral mark, per server. Reads join the same fan-out as the rank
	// reads, so they share rankMu.
	isEphemeralByServer    map[string]bool
	isEphemeralErrByServer map[string]error

	// Protected mark, per server. Same fan-out/rankMu sharing as ephemeral.
	isProtectedByServer    map[string]bool
	isProtectedErrByServer map[string]error
	markProtectedCalls     []struct {
		Server    string
		Protected bool
	}
	markProtectedErr error

	// Managed mark, per server. Same fan-out/rankMu sharing as protected;
	// reloadConfig* backs the adopt handler's conf-source step.
	isManagedByServer    map[string]bool
	isManagedErrByServer map[string]error
	markManagedCalls     []string
	unmarkManagedCalls   []string
	markManagedErr       error
	unmarkManagedErr     error
	reloadConfigCalls    []string
	reloadConfigErr      error

	// Batched server marks, per server — the single read the /api/servers
	// fan-out makes. Shares rankMu with the other per-server fan-out fields.
	readServerMarksByServer    map[string]tmux.ServerMarks
	readServerMarksErrByServer map[string]error

	// Boards
	listBoardsCalled         bool
	listBoardsResult         []tmux.BoardSummary
	listBoardsErr            error
	getBoardCalled           bool
	getBoardName             string
	getBoardResult           []tmux.BoardEntry
	getBoardErr              error
	listBoardEntriesResult   []tmux.BoardEntry
	listBoardEntriesByServer map[string][]tmux.BoardEntry
	listBoardEntriesErr      error
	pinBoardCalled           bool
	pinBoardServer           string
	pinBoardWindowID         string
	pinBoardBoard            string
	pinBoardErr              error
	unpinBoardCalled         bool
	unpinBoardServer         string
	unpinBoardWindowID       string
	unpinBoardBoard          string
	unpinBoardErr            error
	reorderBoardCalled       bool
	reorderBoardServer       string
	reorderBoardWindowID     string
	reorderBoardBoard        string
	reorderBoardBefore       string
	reorderBoardAfter        string
	reorderBoardNewKey       string
	reorderBoardErr          error

	// Agent-send injection primitives (260714-jdyg-chat-send). agentSendCalls records
	// the ordered sequence of primitive invocations so a test can assert the
	// baseline capture → set-buffer → paste-buffer → capture-pane → send-keys
	// order (and that no send-keys follows a failed probe). agentSendMu guards ALL
	// agent-send mock fields: the concurrency test drives two sends on separate
	// goroutines under -race, so the recorder must not itself race.
	agentSendMu            sync.Mutex
	agentSendCalls         []string
	setAgentBufferText     string
	setAgentBufferTexts    []string // every text passed, in order (concurrency assertions)
	pasteAgentPaneID       string
	pasteAgentPaneIDs      []string // every paste target pane, in order (cross-pane concurrency assertions)
	pasteAgentRawPaneID    string
	sendEnterPaneID        string
	sendEnterCalled        bool
	sendPaneKeys           [][]string
	setAgentBufferErr      error
	pasteAgentBufferErr    error
	pasteAgentRawBufferErr error
	sendEnterErr           error
	sendPaneKeysErr        error
	clearPaneModeErr       error
	// capturePaneResults is consumed one entry per CapturePane call (baseline +
	// probe retries), falling back to capturePaneResult once exhausted.
	// capturePaneErr forces a capture failure.
	capturePaneResult  string
	capturePaneResults []string
	capturePaneErr     error
	capturePaneCalls   int
	// capturePaneCtxAware makes CapturePane block until the caller's ctx is done
	// and return ctx.Err() — modeling a real ctx-bound tmux exec hit by the shared
	// injection deadline (the shared-deadline abort test).
	capturePaneCtxAware bool
	// captureWindowHistoryResult/-Err stub GET /api/windows/{windowId}/history's
	// full-scrollback capture; captureWindowHistoryTarget records the target the
	// handler passed through.
	captureWindowHistoryResult string
	captureWindowHistoryErr    error
	captureWindowHistoryTarget string
	// setAgentBufferHook, when non-nil, runs INSIDE SetAgentSendBuffer while the
	// per-request work is in flight — used by the concurrency test to force an
	// A-set/B-set/A-paste interleave and prove the critical section serializes.
	setAgentBufferHook func(text string)

	err error
}

func (m *mockTmuxOps) CreateSession(name, cwd, server string) error {
	m.createSessionCalled = true
	m.createSessionName = name
	m.createSessionCwd = cwd
	return m.err
}
func (m *mockTmuxOps) KillSession(session, server string) error {
	m.killMu.Lock()
	m.killSessionCalled = true
	m.killSessionName = session
	m.killMu.Unlock()
	return m.err
}
func (m *mockTmuxOps) KillSessionCtx(ctx context.Context, server, session string) error {
	m.killMu.Lock()
	m.killSessionCalled = true
	m.killSessionName = session
	m.killMu.Unlock()
	return m.err
}

// KillSessionWasCalled returns the recorded kill state under killMu. Use this
// (not the bare fields) when the kill may run on a different goroutine than the
// assertion — e.g. the relay abort-clean deferred reap.
func (m *mockTmuxOps) KillSessionWasCalled() (bool, string) {
	m.killMu.Lock()
	defer m.killMu.Unlock()
	return m.killSessionCalled, m.killSessionName
}
func (m *mockTmuxOps) RenameSession(session, name, server string) error {
	m.renameSessionCalled = true
	m.renameSessionSession = session
	m.renameSessionName = name
	return m.err
}
func (m *mockTmuxOps) CreateWindow(session, name, cwd, server string) error {
	m.createWindowCalled = true
	m.createWindowSession = session
	m.createWindowName = name
	m.createWindowCwd = cwd
	return m.err
}
func (m *mockTmuxOps) KillWindow(windowID, server string) error {
	m.killWindowCalled = true
	m.killWindowID = windowID
	return m.err
}
func (m *mockTmuxOps) MoveWindow(windowID string, targetIndex int, server string) error {
	m.swapWindowCalled = true
	m.swapWindowID = windowID
	m.swapWindowDstIndex = targetIndex
	m.moveWindowCalls = append(m.moveWindowCalls, moveWindowCall{windowID: windowID, dstIndex: targetIndex})
	if m.swapWindowErr != nil {
		return m.swapWindowErr
	}
	return m.err
}
func (m *mockTmuxOps) MoveWindowToSession(windowID, dstSession, server string) error {
	m.moveWindowToSessionCalled = true
	m.moveWindowToSessionWindowID = windowID
	m.moveWindowToSessionDstSession = dstSession
	if m.moveWindowToSessionErr != nil {
		return m.moveWindowToSessionErr
	}
	return m.err
}
func (m *mockTmuxOps) RenameWindow(windowID, name, server string) error {
	m.renameWindowCalled = true
	m.renameWindowWindowID = windowID
	m.renameWindowName = name
	return m.err
}
func (m *mockTmuxOps) SendKeys(windowID, keys, server string) error {
	m.sendKeysCalled = true
	m.sendKeysWindowID = windowID
	m.sendKeysKeys = keys
	return m.err
}
func (m *mockTmuxOps) SendKeysToPane(ctx context.Context, paneID, server string, keys ...string) error {
	m.agentSendMu.Lock()
	defer m.agentSendMu.Unlock()
	m.agentSendCalls = append(m.agentSendCalls, "send-keys "+strings.Join(keys, " "))
	m.sendPaneKeys = append(m.sendPaneKeys, append([]string{paneID}, keys...))
	return m.sendPaneKeysErr
}
func (m *mockTmuxOps) ListWindows(ctx context.Context, session, server string) ([]tmux.WindowInfo, error) {
	if m.listWindowsBySession != nil {
		return m.listWindowsBySession[session], m.listWindowsErr
	}
	return m.listWindowsResult, m.listWindowsErr
}
func (m *mockTmuxOps) ResolveWindowSession(ctx context.Context, server, windowID string) (string, error) {
	m.resolveWindowSessionID = windowID
	if m.resolveWindowSessionErr != nil {
		return "", m.resolveWindowSessionErr
	}
	return m.resolveWindowSessionResult, nil
}
func (m *mockTmuxOps) EnsureIsoSession(ctx context.Context, server, windowID string) (string, error) {
	m.isoMu.Lock()
	m.ensureIsoSessionCalled = true
	m.ensureIsoSessionWindowID = windowID
	result, err := m.ensureIsoSessionResult, m.ensureIsoSessionErr
	m.isoMu.Unlock()
	if err != nil {
		return "", err
	}
	if result != "" {
		return result, nil
	}
	name, _ := tmux.IsoSessionName(windowID)
	return name, nil
}

// EnsureIsoSessionWasCalled returns the recorded ensure state under isoMu (the
// relay's attachStream writes it off the test goroutine — the KillSessionWasCalled
// pattern).
func (m *mockTmuxOps) EnsureIsoSessionWasCalled() (bool, string) {
	m.isoMu.Lock()
	defer m.isoMu.Unlock()
	return m.ensureIsoSessionCalled, m.ensureIsoSessionWindowID
}
func (m *mockTmuxOps) SessionClientCount(ctx context.Context, server, session string) (int, error) {
	return m.sessionClientCountResult, m.sessionClientCountErr
}
func (m *mockTmuxOps) ActiveWindowID(ctx context.Context, server, session string) (string, error) {
	m.activeWindowIDServer = server
	m.activeWindowIDSession = session
	if m.activeWindowIDErr != nil {
		return "", m.activeWindowIDErr
	}
	return m.activeWindowIDResult, nil
}
func (m *mockTmuxOps) HasSession(ctx context.Context, server, session string) bool {
	if m.hasSessionNames == nil {
		return false
	}
	return m.hasSessionNames[session]
}
func (m *mockTmuxOps) SplitWindow(windowID string, horizontal bool, cwd string, server string) (string, error) {
	m.splitWindowCalled = true
	m.splitWindowID = windowID
	m.splitWindowHorizontal = horizontal
	return m.splitWindowResult, m.splitWindowErr
}
func (m *mockTmuxOps) SelectPane(paneID, server string) error {
	m.selectPaneCalled = true
	m.selectPanePaneID = paneID
	m.selectPaneServer = server
	return m.selectPaneErr
}
func (m *mockTmuxOps) SelectWindowInSession(session, windowID, server string) error {
	m.selectWindowInSessionCalled = true
	m.selectWindowInSessionSession = session
	m.selectWindowInSessionWindowID = windowID
	if m.selectWindowInSessionErr != nil {
		return m.selectWindowInSessionErr
	}
	return m.err
}
func (m *mockTmuxOps) KillActivePane(windowID, server string) error {
	m.killActivePaneCalled = true
	m.killActivePaneWindowID = windowID
	return m.err
}
func (m *mockTmuxOps) SetSessionColor(session string, color string, server string) error {
	m.setSessionColorCalled = true
	m.setSessionColorSession = session
	m.setSessionColorColor = color
	if m.setSessionColorErr != nil {
		return m.setSessionColorErr
	}
	return m.err
}
func (m *mockTmuxOps) UnsetSessionColor(session string, server string) error {
	m.unsetSessionColorCalled = true
	m.unsetSessionColorSession = session
	if m.unsetSessionColorErr != nil {
		return m.unsetSessionColorErr
	}
	return m.err
}
func (m *mockTmuxOps) SetSessionFlair(session string, flair string, server string) error {
	m.setSessionFlairCalled = true
	m.setSessionFlairSession = session
	m.setSessionFlairFlair = flair
	if m.setSessionFlairErr != nil {
		return m.setSessionFlairErr
	}
	return m.err
}
func (m *mockTmuxOps) UnsetSessionFlair(session string, server string) error {
	m.unsetSessionFlairCalled = true
	m.unsetSessionFlairSession = session
	if m.unsetSessionFlairErr != nil {
		return m.unsetSessionFlairErr
	}
	return m.err
}
func (m *mockTmuxOps) SetWindowColor(windowID string, color string, server string) error {
	m.setWindowColorCalled = true
	m.setWindowColorWindowID = windowID
	m.setWindowColorColor = color
	if m.setWindowColorErr != nil {
		return m.setWindowColorErr
	}
	return m.err
}
func (m *mockTmuxOps) UnsetWindowColor(windowID, server string) error {
	m.unsetWindowColorCalled = true
	m.unsetWindowColorWindowID = windowID
	if m.unsetWindowColorErr != nil {
		return m.unsetWindowColorErr
	}
	return m.err
}
func (m *mockTmuxOps) ListServers(ctx context.Context) ([]string, error) {
	if m.listServersResult != nil {
		return m.listServersResult, nil
	}
	return []string{"default"}, nil
}
func (m *mockTmuxOps) ListSessions(ctx context.Context, server string) ([]tmux.SessionInfo, error) {
	return m.listSessionsResult, nil
}
func (m *mockTmuxOps) KillServer(server string) error {
	return nil
}
func (m *mockTmuxOps) ListKeys(server string) ([]string, error) {
	return nil, nil
}
func (m *mockTmuxOps) SetWindowOption(ctx context.Context, windowID, server, option, value string) error {
	m.setWindowOptionCalled = true
	m.setWindowOptionWindowID = windowID
	m.setWindowOptionOption = option
	m.setWindowOptionValue = value
	return m.err
}
func (m *mockTmuxOps) UnsetWindowOption(ctx context.Context, windowID, server, option string) error {
	m.unsetWindowOptionCalled = true
	m.unsetWindowOptionWindowID = windowID
	m.unsetWindowOptionOption = option
	return m.err
}
func (m *mockTmuxOps) SetWindowOptions(ctx context.Context, windowID, server string, ops []tmux.WindowOptionOp) error {
	m.setWindowOptionsCalled = true
	m.setWindowOptionsWindowID = windowID
	m.setWindowOptionsOps = ops
	return m.err
}
func (m *mockTmuxOps) SetWindowLayouts(ctx context.Context, server string, pairs []tmux.WindowLayoutWrite) error {
	m.setWindowLayoutsCalled = true
	m.setWindowLayoutsPairs = pairs
	return m.setWindowLayoutsErr
}
func (m *mockTmuxOps) ClearWindowRoleExceptOnServer(ctx context.Context, server, keepWindowID string) ([]string, error) {
	m.clearWindowRoleCalled = true
	m.clearWindowRoleKeepID = keepWindowID
	if m.err != nil {
		return nil, m.err
	}
	return m.clearWindowRoleResult, nil
}
func (m *mockTmuxOps) MoveWindowIntoOperatorSessionOnServer(ctx context.Context, server, windowID string) error {
	m.moveInOperatorCalled = true
	m.moveInOperatorWindowID = windowID
	return m.moveInOperatorErr
}
func (m *mockTmuxOps) DemoteWindowFromOperatorSessionOnServer(ctx context.Context, server, windowID string) error {
	m.demoteOperatorCalled = true
	m.demoteOperatorWindowID = windowID
	return m.demoteOperatorErr
}
func (m *mockTmuxOps) CreateWindowWithOptions(session, name, cwd, server string, ops []tmux.WindowOptionOp) error {
	m.createWindowWithOptionsCalled = true
	m.createWindowWithOptionsSession = session
	m.createWindowWithOptionsName = name
	m.createWindowWithOptionsCwd = cwd
	m.createWindowWithOptionsOps = ops
	return m.err
}
func (m *mockTmuxOps) GetSessionOrder(ctx context.Context, server string) ([]string, error) {
	m.getSessionOrderCalled = true
	if m.getSessionOrderErr != nil {
		return nil, m.getSessionOrderErr
	}
	if m.getSessionOrderResult == nil {
		return []string{}, nil
	}
	return m.getSessionOrderResult, nil
}
func (m *mockTmuxOps) SetSessionOrder(ctx context.Context, server string, order []string) error {
	m.setSessionOrderCalled = true
	m.setSessionOrderOrder = order
	if m.setSessionOrderErr != nil {
		return m.setSessionOrderErr
	}
	return m.err
}
func (m *mockTmuxOps) GetServerRank(ctx context.Context, server string) (*int, error) {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	if m.getServerRankErrByServer != nil {
		if err, ok := m.getServerRankErrByServer[server]; ok && err != nil {
			return nil, err
		}
	}
	if m.getServerRankByServer != nil {
		return m.getServerRankByServer[server], nil
	}
	return nil, nil
}
func (m *mockTmuxOps) SetServerRank(ctx context.Context, server string, rank int) error {
	m.rankMu.Lock()
	m.setServerRankCalls = append(m.setServerRankCalls, struct {
		Server string
		Rank   int
	}{server, rank})
	m.rankMu.Unlock()
	m.rankMu.Lock()
	err := m.err
	if m.getServerRankErrByServer != nil {
		if e, ok := m.getServerRankErrByServer[server]; ok && e != nil {
			err = e
		}
	}
	m.rankMu.Unlock()
	return err
}
func (m *mockTmuxOps) IsEphemeralServer(ctx context.Context, server string) (bool, error) {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	if m.isEphemeralErrByServer != nil {
		if err, ok := m.isEphemeralErrByServer[server]; ok && err != nil {
			return false, err
		}
	}
	return m.isEphemeralByServer[server], nil
}
func (m *mockTmuxOps) IsGuardedServer(ctx context.Context, server string) (bool, error) {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	if m.isProtectedErrByServer != nil {
		if err, ok := m.isProtectedErrByServer[server]; ok && err != nil {
			return false, err
		}
	}
	// rk-daemon is guarded by derivation, never by the option map.
	if server == daemonServerName {
		return true, nil
	}
	return m.isProtectedByServer[server], nil
}
func (m *mockTmuxOps) MarkServerProtected(ctx context.Context, server string) error {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	m.markProtectedCalls = append(m.markProtectedCalls, struct {
		Server    string
		Protected bool
	}{server, true})
	return m.markProtectedErr
}
func (m *mockTmuxOps) UnmarkServerProtected(ctx context.Context, server string) error {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	m.markProtectedCalls = append(m.markProtectedCalls, struct {
		Server    string
		Protected bool
	}{server, false})
	return m.markProtectedErr
}
func (m *mockTmuxOps) IsManagedServer(ctx context.Context, server string) (bool, error) {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	if m.isManagedErrByServer != nil {
		if err, ok := m.isManagedErrByServer[server]; ok && err != nil {
			return false, err
		}
	}
	// rk-daemon is managed by derivation, never by the option map.
	if server == daemonServerName {
		return true, nil
	}
	return m.isManagedByServer[server], nil
}
func (m *mockTmuxOps) ReadServerMarks(ctx context.Context, server string) (tmux.ServerMarks, error) {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	if m.readServerMarksErrByServer != nil {
		if err, ok := m.readServerMarksErrByServer[server]; ok && err != nil {
			return tmux.ServerMarks{}, err
		}
	}
	return m.readServerMarksByServer[server], nil
}
func (m *mockTmuxOps) MarkServerManaged(ctx context.Context, server string) error {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	m.markManagedCalls = append(m.markManagedCalls, server)
	return m.markManagedErr
}
func (m *mockTmuxOps) UnmarkServerManaged(ctx context.Context, server string) error {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	m.unmarkManagedCalls = append(m.unmarkManagedCalls, server)
	return m.unmarkManagedErr
}
func (m *mockTmuxOps) ReloadConfig(server string) error {
	m.rankMu.Lock()
	defer m.rankMu.Unlock()
	m.reloadConfigCalls = append(m.reloadConfigCalls, server)
	return m.reloadConfigErr
}
func (m *mockTmuxOps) ListBoards(ctx context.Context) ([]tmux.BoardSummary, error) {
	m.listBoardsCalled = true
	if m.listBoardsErr != nil {
		return nil, m.listBoardsErr
	}
	return m.listBoardsResult, nil
}
func (m *mockTmuxOps) GetBoard(ctx context.Context, name string) ([]tmux.BoardEntry, error) {
	m.getBoardCalled = true
	m.getBoardName = name
	if m.getBoardErr != nil {
		return nil, m.getBoardErr
	}
	return m.getBoardResult, nil
}
func (m *mockTmuxOps) ListBoardEntries(ctx context.Context, server string) ([]tmux.BoardEntry, error) {
	if m.listBoardEntriesErr != nil {
		return nil, m.listBoardEntriesErr
	}
	if m.listBoardEntriesByServer != nil {
		return m.listBoardEntriesByServer[server], nil
	}
	return m.listBoardEntriesResult, nil
}
func (m *mockTmuxOps) PinBoard(ctx context.Context, server, windowID, board string) error {
	m.pinBoardCalled = true
	m.pinBoardServer = server
	m.pinBoardWindowID = windowID
	m.pinBoardBoard = board
	return m.pinBoardErr
}
func (m *mockTmuxOps) UnpinBoard(ctx context.Context, server, windowID, board string) error {
	m.unpinBoardCalled = true
	m.unpinBoardServer = server
	m.unpinBoardWindowID = windowID
	m.unpinBoardBoard = board
	return m.unpinBoardErr
}
func (m *mockTmuxOps) ReorderBoard(ctx context.Context, server, windowID, board, before, after string) (string, error) {
	m.reorderBoardCalled = true
	m.reorderBoardServer = server
	m.reorderBoardWindowID = windowID
	m.reorderBoardBoard = board
	m.reorderBoardBefore = before
	m.reorderBoardAfter = after
	if m.reorderBoardErr != nil {
		return "", m.reorderBoardErr
	}
	if m.reorderBoardNewKey == "" {
		return "m", nil
	}
	return m.reorderBoardNewKey, nil
}

func (m *mockTmuxOps) ClearPaneMode(ctx context.Context, paneID, server string) error {
	m.agentSendMu.Lock()
	defer m.agentSendMu.Unlock()
	m.agentSendCalls = append(m.agentSendCalls, "clear-pane-mode")
	return m.clearPaneModeErr
}
func (m *mockTmuxOps) SetAgentSendBuffer(ctx context.Context, text, server string) error {
	m.agentSendMu.Lock()
	m.agentSendCalls = append(m.agentSendCalls, "set-buffer")
	m.setAgentBufferText = text
	m.setAgentBufferTexts = append(m.setAgentBufferTexts, text)
	hook := m.setAgentBufferHook
	err := m.setAgentBufferErr
	m.agentSendMu.Unlock()
	// The hook runs OUTSIDE agentSendMu so it cannot itself provide the serialization
	// under test — the only serialization is the handler's package mutex around
	// the set → paste critical section.
	if hook != nil {
		hook(text)
	}
	return err
}
func (m *mockTmuxOps) PasteAgentSendBuffer(ctx context.Context, paneID, server string) error {
	m.agentSendMu.Lock()
	defer m.agentSendMu.Unlock()
	m.agentSendCalls = append(m.agentSendCalls, "paste-buffer")
	m.pasteAgentPaneID = paneID
	m.pasteAgentPaneIDs = append(m.pasteAgentPaneIDs, paneID)
	return m.pasteAgentBufferErr
}
func (m *mockTmuxOps) PasteAgentSendBufferRaw(ctx context.Context, paneID, server string) error {
	m.agentSendMu.Lock()
	defer m.agentSendMu.Unlock()
	m.agentSendCalls = append(m.agentSendCalls, "paste-buffer-raw")
	m.pasteAgentRawPaneID = paneID
	return m.pasteAgentRawBufferErr
}
func (m *mockTmuxOps) SendEnterToPane(ctx context.Context, paneID, server string) error {
	m.agentSendMu.Lock()
	defer m.agentSendMu.Unlock()
	m.agentSendCalls = append(m.agentSendCalls, "send-keys")
	m.sendEnterCalled = true
	m.sendEnterPaneID = paneID
	return m.sendEnterErr
}
func (m *mockTmuxOps) CapturePane(ctx context.Context, paneID string, lines int, server string) (string, error) {
	m.agentSendMu.Lock()
	m.agentSendCalls = append(m.agentSendCalls, "capture-pane")
	idx := m.capturePaneCalls
	m.capturePaneCalls++
	ctxAware := m.capturePaneCtxAware
	capErr := m.capturePaneErr
	var result string
	if idx < len(m.capturePaneResults) {
		result = m.capturePaneResults[idx]
	} else {
		result = m.capturePaneResult
	}
	m.agentSendMu.Unlock()

	if ctxAware {
		<-ctx.Done()
		return "", ctx.Err()
	}
	if capErr != nil {
		return "", capErr
	}
	return result, nil
}

func (m *mockTmuxOps) CaptureWindowHistory(ctx context.Context, target, server string) (string, error) {
	m.captureWindowHistoryTarget = target
	if m.captureWindowHistoryErr != nil {
		return "", m.captureWindowHistoryErr
	}
	return m.captureWindowHistoryResult, nil
}

func newTestRouter(sf SessionFetcher, ops TmuxOps) http.Handler {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	return NewTestRouter(logger, sf, ops, "test-host")
}

func TestSessionsList(t *testing.T) {
	sf := &mockSessionFetcher{
		result: []sessions.ProjectSession{
			{
				Name: "run-kit",
				Windows: []tmux.WindowInfo{
					{Index: 0, Name: "main", WorktreePath: "/home/user/code", Activity: "active", IsActiveWindow: true, FabChange: "260312-abc", FabStage: "apply"},
					{Index: 1, Name: "build", WorktreePath: "/tmp/build", Activity: "idle", IsActiveWindow: false, FabChange: "260312-abc", FabStage: "apply"},
				},
			},
		},
	}

	router := newTestRouter(sf, &mockTmuxOps{})
	req := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json")
	}

	var result []sessions.ProjectSession
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}

	if len(result) != 1 {
		t.Fatalf("len(result) = %d, want 1", len(result))
	}
	if result[0].Name != "run-kit" {
		t.Errorf("result[0].Name = %q, want %q", result[0].Name, "run-kit")
	}
	if len(result[0].Windows) != 2 {
		t.Fatalf("len(windows) = %d, want 2", len(result[0].Windows))
	}
	if result[0].Windows[0].FabChange != "260312-abc" {
		t.Errorf("FabChange = %q, want %q", result[0].Windows[0].FabChange, "260312-abc")
	}
	if result[0].Windows[0].FabStage != "apply" {
		t.Errorf("FabStage = %q, want %q", result[0].Windows[0].FabStage, "apply")
	}
}

func TestSessionCreate(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"my-project","cwd":"~/code/my-project"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusCreated)
	}

	if !ops.createSessionCalled {
		t.Error("CreateSession was not called")
	}
	if ops.createSessionName != "my-project" {
		t.Errorf("createSessionName = %q, want %q", ops.createSessionName, "my-project")
	}

	var result map[string]bool
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !result["ok"] {
		t.Error("expected ok: true")
	}
}

func TestSessionCreateEmptyName(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"name":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !strings.Contains(result["error"], "cannot be empty") {
		t.Errorf("error = %q, want containing %q", result["error"], "cannot be empty")
	}
}

func TestSessionCreateForbiddenChars(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"name":"test;hack"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !strings.Contains(result["error"], "forbidden characters") {
		t.Errorf("error = %q, want containing %q", result["error"], "forbidden characters")
	}
}

func TestSessionCreateSpaceRejected(t *testing.T) {
	// The tightened new-name rule (validate.ValidateNewName): a to-be-created
	// session name with a space is rejected — spaces bite tmux CLI targeting,
	// session-group naming, and the /$server/$window routes.
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"My problem"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.createSessionCalled {
		t.Error("CreateSession must NOT be called for a spacey name")
	}
	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !strings.Contains(result["error"], "cannot contain spaces") {
		t.Errorf("error = %q, want containing %q", result["error"], "cannot contain spaces")
	}
}

func TestSessionRenameSpaceyNewNameRejected(t *testing.T) {
	// The renamed-TO name is held to the tightened rule.
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"My problem"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/main/rename", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if ops.renameSessionCalled {
		t.Error("RenameSession must NOT be called for a spacey new name")
	}
}

func TestSessionRenameSpaceyOldNameAccepted(t *testing.T) {
	// The rename SOURCE (URL param) stays on the permissive ValidateName so a
	// pre-existing spacey session (created outside run-kit via raw tmux) can
	// still be renamed TO a safe name.
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"name":"My_problem"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/My%20problem/rename", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.renameSessionCalled {
		t.Fatal("RenameSession was not called")
	}
	if ops.renameSessionSession != "My problem" {
		t.Errorf("old name = %q, want %q", ops.renameSessionSession, "My problem")
	}
	if ops.renameSessionName != "My_problem" {
		t.Errorf("new name = %q, want %q", ops.renameSessionName, "My_problem")
	}
}

func TestSessionRouteGuards(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		body      string
		wantError string
		touched   func(*mockTmuxOps) bool
	}{
		{name: "create invalid JSON", path: "/api/sessions", body: "{invalid", touched: func(ops *mockTmuxOps) bool { return ops.createSessionCalled }},
		{name: "close pane invalid window ID", path: "/api/windows/abc/close-pane", wantError: "Invalid window ID", touched: func(ops *mockTmuxOps) bool { return ops.killActivePaneCalled }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			router := newTestRouter(&mockSessionFetcher{}, ops)
			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			if tc.touched(ops) {
				t.Error("tmux operation must not run for an invalid request")
			}
			if tc.wantError != "" {
				var result map[string]string
				if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
					t.Fatalf("decode error: %v", err)
				}
				if !strings.Contains(result["error"], tc.wantError) {
					t.Errorf("error = %q, want containing %q", result["error"], tc.wantError)
				}
			}
		})
	}
}

func TestSessionKill(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/test-session/kill", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	killed, killedName := ops.KillSessionWasCalled()
	if !killed {
		t.Error("KillSession was not called")
	}
	if killedName != "test-session" {
		t.Errorf("killSessionName = %q, want %q", killedName, "test-session")
	}
}

func TestClosePaneSuccess(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/windows/@3/close-pane", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if !ops.killActivePaneCalled {
		t.Error("KillActivePane was not called")
	}
	if ops.killActivePaneWindowID != "@3" {
		t.Errorf("killActivePaneWindowID = %q, want %q", ops.killActivePaneWindowID, "@3")
	}

	var result map[string]bool
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !result["ok"] {
		t.Error("expected ok: true")
	}
}

// --- Session Color endpoint tests ---

func TestSessionColorSet(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"color":"6"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/color", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.setSessionColorCalled {
		t.Error("SetSessionColor was not called")
	}
	if ops.setSessionColorSession != "myproject" {
		t.Errorf("session = %q, want %q", ops.setSessionColorSession, "myproject")
	}
	if ops.setSessionColorColor != "6" {
		t.Errorf("color = %q, want %q", ops.setSessionColorColor, "6")
	}
}

func TestSessionColorSetBlend(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"color":"1+3"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/color", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ops.setSessionColorColor != "1+3" {
		t.Errorf("color = %q, want %q", ops.setSessionColorColor, "1+3")
	}
}

func TestSessionColorRejectsMalformed(t *testing.T) {
	for _, bad := range []string{`{"color":"99"}`, `{"color":"1+"}`, `{"color":"x"}`, `{"color":"1+2+3"}`} {
		ops := &mockTmuxOps{}
		router := newTestRouter(&mockSessionFetcher{}, ops)
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/color", strings.NewReader(bad))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want %d", bad, rec.Code, http.StatusBadRequest)
		}
		if ops.setSessionColorCalled {
			t.Errorf("body %s: SetSessionColor should not be called on invalid input", bad)
		}
	}
}

func TestSessionColorClear(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"color":null}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/color", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.unsetSessionColorCalled {
		t.Error("UnsetSessionColor was not called")
	}
	if ops.unsetSessionColorSession != "myproject" {
		t.Errorf("session = %q, want %q", ops.unsetSessionColorSession, "myproject")
	}
}

func TestSessionColorInvalidSession(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	body := `{"color":4}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/bad;session/color", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestSessionColorTmuxError(t *testing.T) {
	ops := &mockTmuxOps{setSessionColorErr: fmt.Errorf("tmux error")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"color":"4"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/color", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

// --- Session Flair endpoint tests ---

func TestSessionFlairSet(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"flair":"onepiece"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/flair", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.setSessionFlairCalled {
		t.Error("SetSessionFlair was not called")
	}
	if ops.setSessionFlairSession != "myproject" {
		t.Errorf("session = %q, want %q", ops.setSessionFlairSession, "myproject")
	}
	if ops.setSessionFlairFlair != "onepiece" {
		t.Errorf("flair = %q, want %q", ops.setSessionFlairFlair, "onepiece")
	}
}

func TestSessionFlairClearNull(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"flair":null}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/flair", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.unsetSessionFlairCalled {
		t.Error("UnsetSessionFlair was not called")
	}
	if ops.unsetSessionFlairSession != "myproject" {
		t.Errorf("session = %q, want %q", ops.unsetSessionFlairSession, "myproject")
	}
}

// An empty string clears (same as null) — the "empty = unset" contract shared
// with the window @rk_win_flair option.
func TestSessionFlairClearEmpty(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"flair":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/flair", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !ops.unsetSessionFlairCalled {
		t.Error("UnsetSessionFlair was not called")
	}
	if ops.setSessionFlairCalled {
		t.Error("SetSessionFlair must NOT be called for an empty flair")
	}
}

// Outside the closed set → 400 and zero tmux calls (validate-before-tmux).
func TestSessionFlairRejectsInvalid(t *testing.T) {
	for _, bad := range []string{`{"flair":"pikachu"}`, `{"flair":"Nyan"}`, `{"flair":"one-piece"}`, `{"flair":" nyan "}`} {
		ops := &mockTmuxOps{}
		router := newTestRouter(&mockSessionFetcher{}, ops)
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/flair", strings.NewReader(bad))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want %d", bad, rec.Code, http.StatusBadRequest)
		}
		if ops.setSessionFlairCalled || ops.unsetSessionFlairCalled {
			t.Errorf("body %s: no tmux flair call should be made on invalid input", bad)
		}
	}
}

func TestSessionFlairTmuxError(t *testing.T) {
	ops := &mockTmuxOps{setSessionFlairErr: fmt.Errorf("tmux error")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"flair":"nyan"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/flair", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestSessionKillInvalidName(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/test;rm/kill", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var result map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !strings.Contains(result["error"], "forbidden characters") {
		t.Errorf("error = %q, want containing %q", result["error"], "forbidden characters")
	}
}

func TestSessionOrder_GET_unset(t *testing.T) {
	ops := &mockTmuxOps{} // getSessionOrderResult nil → returns []string{}, nil
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/order?server=default", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var result struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.Order == nil {
		t.Fatal("order field is null in JSON, expected empty array")
	}
	if len(result.Order) != 0 {
		t.Errorf("order = %v, want []", result.Order)
	}
	if !ops.getSessionOrderCalled {
		t.Error("GetSessionOrder was not called")
	}
}

func TestSessionOrder_GET_set(t *testing.T) {
	ops := &mockTmuxOps{getSessionOrderResult: []string{"main", "dev"}}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/order?server=default", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var result struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(result.Order) != 2 || result.Order[0] != "main" || result.Order[1] != "dev" {
		t.Errorf("order = %v, want [main dev]", result.Order)
	}
}

func TestSessionOrder_GET_tmuxError(t *testing.T) {
	ops := &mockTmuxOps{getSessionOrderErr: fmt.Errorf("decode @rk_srv_session_order: invalid character")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/order?server=default", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestSessionOrder_POST_roundTrip(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"order":["main","dev","scratch"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !ops.setSessionOrderCalled {
		t.Fatal("SetSessionOrder was not called")
	}
	got := ops.setSessionOrderOrder
	if len(got) != 3 || got[0] != "main" || got[1] != "dev" || got[2] != "scratch" {
		t.Errorf("setSessionOrderOrder = %v, want [main dev scratch]", got)
	}
	var result map[string]bool
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !result["ok"] {
		t.Error("expected ok: true")
	}
}

func TestSessionOrder_POST_invalidBody_notArray(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"order":"main"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if ops.setSessionOrderCalled {
		t.Error("SetSessionOrder should NOT be called for invalid body")
	}
}

func TestSessionOrder_POST_invalidBody_malformedJSON(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if ops.setSessionOrderCalled {
		t.Error("SetSessionOrder should NOT be called for malformed JSON")
	}
}

func TestSessionOrder_POST_invalidName(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	// "bad;name" contains a forbidden shell metacharacter — validate.ValidateName rejects.
	body := `{"order":["main","bad;name"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if ops.setSessionOrderCalled {
		t.Error("SetSessionOrder should NOT be called for invalid name")
	}
	var result map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&result)
	if !strings.Contains(result["error"], "forbidden characters") {
		t.Errorf("error = %q, want containing %q", result["error"], "forbidden characters")
	}
}

func TestSessionOrder_POST_emptyArray(t *testing.T) {
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"order":[]}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if !ops.setSessionOrderCalled {
		t.Error("SetSessionOrder was not called")
	}
	if len(ops.setSessionOrderOrder) != 0 {
		t.Errorf("got order %v, want empty", ops.setSessionOrderOrder)
	}
}

func TestSessionOrder_POST_staleNameAccepted(t *testing.T) {
	// Names that pass validate.ValidateName but don't match a current session
	// MUST be accepted — the frontend's render layer handles stale names.
	ops := &mockTmuxOps{}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"order":["main","deleted-yesterday"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestSessionOrder_POST_tmuxError(t *testing.T) {
	ops := &mockTmuxOps{setSessionOrderErr: fmt.Errorf("tmux failed")}
	router := newTestRouter(&mockSessionFetcher{}, ops)

	body := `{"order":["main"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// TestSessionOrder_POST_triggersBroadcast verifies the end-to-end wiring from
// the POST handler through the SSE hub: a successful POST must result in a
// connected client receiving a session-order event for that server.
func TestSessionOrder_POST_triggersBroadcast(t *testing.T) {
	ops := &mockTmuxOps{}
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	server := &Server{
		logger:   logger,
		sessions: &mockSessionFetcher{},
		tmux:     ops,
		hostname: "test-host",
	}

	// Connect a client to the SSE hub directly. Using the hub avoids needing
	// httptest.NewServer for a streaming response.
	server.initSSEHub()
	client := &sseClient{ch: make(chan hubEvent, 16), server: "default"}
	server.sseHub.addClient(client)
	defer server.sseHub.removeClient(client)

	// Drain any cached snapshot events so the channel is empty before the PUT.
	drainDeadline := time.After(100 * time.Millisecond)
draining:
	for {
		select {
		case <-client.ch:
		case <-drainDeadline:
			break draining
		}
	}

	router := server.buildRouter()
	body := `{"order":["main","dev"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/order?server=default", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// The client must receive a session-order event within ~100ms (broadcast
	// is synchronous on the PUT path).
	select {
	case ev := <-client.ch:
		evStr := ev.String()
		if !strings.Contains(evStr, "event: session-order") {
			t.Errorf("expected session-order event, got: %s", evStr)
		}
		if !strings.Contains(evStr, `"server":"default"`) {
			t.Errorf("event missing server field: %s", evStr)
		}
		if !strings.Contains(evStr, `"order":["main","dev"]`) {
			t.Errorf("event missing or wrong order: %s", evStr)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("client did not receive session-order event after PUT")
	}
}

// newWakeSeamServer builds a test Server with an SSE hub and one connected
// client on "default", drains the bootstrap snapshot, and returns the server +
// its fetch tracker. The seam tests assert on the tracker's fetch count rather
// than on a broadcast: the SSE hub's previousJSON dedup correctly SUPPRESSES a
// no-change snapshot broadcast, so the observable seam behavior is "the wake
// drove a fresh poll pass (FetchSessions ran)", not "a frame was delivered".
// Shared by the option-mutation wake-seam tests (windows /options, sessions
// /color). Mirrors the Server construction in TestSessionOrder_POST_triggersBroadcast.
func newWakeSeamServer(t *testing.T, ops TmuxOps) (*Server, *fetchTracker) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	tracker := &fetchTracker{result: map[string][]sessions.ProjectSession{
		"default": {{Name: "s1"}},
	}}
	server := &Server{logger: logger, sessions: tracker, tmux: ops, hostname: "test-host"}
	server.initSSEHub()
	// A long safety interval so any observed fetch beyond the bootstrap is
	// attributable to the wake, never the safety-net timer.
	server.sseHub.safetyInterval = 5 * time.Second
	client := &sseClient{ch: make(chan hubEvent, 16), server: "default"}
	server.sseHub.addClient(client)
	t.Cleanup(func() {
		// removeClient drops the client from h.clients under h.mu, so the poll
		// loop can no longer send to client.ch (and every send is non-blocking
		// anyway). No drain goroutine is needed — spawning one over the
		// never-closed buffered channel would just leak, blocking forever.
		server.sseHub.removeClient(client)
	})
	// Let the bootstrap poll pass complete and the loop settle into waitForNext.
	time.Sleep(100 * time.Millisecond)
	return server, tracker
}

// expectWake asserts FetchSessions ran again after the POST (the wake drove a
// fresh poll pass). label is used in the failure message.
func expectWake(t *testing.T, tracker *fetchTracker, before int64, label string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if tracker.count.Load() > before {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("%s: FetchSessions did not run after a successful mutation (want a wake-driven poll pass; count stayed %d)", label, before)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// expectNoWake asserts FetchSessions did NOT run again within a short window (a
// rejected mutation must not wake the hub). The window is well short of the 5s
// safety interval so a stray fetch could only come from an (erroneous) wake.
func expectNoWake(t *testing.T, tracker *fetchTracker, before int64, label string) {
	t.Helper()
	time.Sleep(300 * time.Millisecond)
	if got := tracker.count.Load(); got > before {
		t.Fatalf("%s: FetchSessions ran (%d→%d) after a REJECTED mutation (must not wake)", label, before, got)
	}
}

// TestSessionColor_POST_wakesHub verifies the handleSessionColor wake seam: a
// successful POST wakes the request's server so the poll loop runs a fresh pass
// promptly (instead of waiting for the safety tick), while a rejected (malformed)
// color does not wake.
func TestSessionColor_POST_wakesHub(t *testing.T) {
	t.Run("successful set wakes", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/color?server=default", strings.NewReader(`{"color":"6"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		expectWake(t, tracker, before, "session color set")
	})

	t.Run("rejected color does not wake", func(t *testing.T) {
		server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
		before := tracker.count.Load()
		router := server.buildRouter()
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/myproject/color?server=default", strings.NewReader(`{"color":"99"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST status = %d, want 400; body=%s", rec.Code, rec.Body.String())
		}
		expectNoWake(t, tracker, before, "session color rejected")
	})
}
