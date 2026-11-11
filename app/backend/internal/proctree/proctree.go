// Package proctree discovers the process tree running under a tmux pane and
// classifies each process (agent / node / git / other). It is the one
// liveness walk shared by `rk mux process`, `rk mux panes`, and the operator
// check: the agent-name set comes from the agent setup registry in cmd/rk via
// SetAgentCommNames, so a harness registered there is recognized here without
// a second table.
package proctree

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// Process classifications.
const (
	ClassAgent = "agent"
	ClassNode  = "node"
	ClassGit   = "git"
	ClassOther = "other"
)

// Node is a single process in the discovered tree.
type Node struct {
	PID            int    `json:"pid"`
	PPID           int    `json:"ppid"`
	Comm           string `json:"comm"`
	Cmdline        string `json:"cmdline"`
	Classification string `json:"classification"`
	Children       []Node `json:"children"`
}

// DiscoverFunc discovers the process tree rooted at pid. Discover is the
// per-OS implementation; callers with a test seam pass their own.
type DiscoverFunc func(ctx context.Context, pid int) ([]Node, error)

var (
	agentMu        sync.RWMutex
	agentCommNames = map[string]bool{}
)

// SetAgentCommNames installs the set of lowercase process basenames that
// identify an agent process. Until it is called no process classifies agent
// by name. `node` must not be in the set: a bare node process is not agent
// evidence, and node-hosted CLIs are caught by the cmdline fallback instead.
func SetAgentCommNames(names map[string]bool) {
	agentMu.Lock()
	defer agentMu.Unlock()
	agentCommNames = names
}

func isAgentName(name string) bool {
	agentMu.RLock()
	defer agentMu.RUnlock()
	return agentCommNames[name]
}

// basename normalizes a comm or cmdline token for set matching: quotes
// stripped, directory prefix dropped, lowercased. Empty stays empty.
func basename(token string) string {
	token = strings.Trim(token, `"'`)
	if token == "" {
		return ""
	}
	return strings.ToLower(filepath.Base(token))
}

// Classify classifies a process: agent when its comm basename — or the
// basename of either of the first two cmdline tokens — is in the agent name
// set; else node, git (git/gh), or other. The cmdline fallback is bounded to
// two tokens so prompt text later in argv can never become liveness evidence.
func Classify(comm, cmdline string) string {
	lower := basename(comm)
	if isAgentName(lower) {
		return ClassAgent
	}
	fields := strings.Fields(cmdline)
	if len(fields) > 2 {
		fields = fields[:2]
	}
	for _, tok := range fields {
		if isAgentName(basename(tok)) {
			return ClassAgent
		}
	}
	switch lower {
	case "node":
		return ClassNode
	case "git", "gh":
		return ClassGit
	default:
		return ClassOther
	}
}

// parsePSCmdlines parses `ps -axo pid=,args=` output into a PID→args map.
// Each line is a (right-aligned) numeric PID followed by the full command
// line; pid is numeric-first and the remainder is args, so the parse is
// robust against spaces inside the command line. Lines whose first field is
// not a PID are skipped. Lives in this un-tagged file (consumed by the
// darwin discovery) so the parsing is unit-testable on every platform.
func parsePSCmdlines(out string) map[int]string {
	m := make(map[int]string)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, " ", 2)
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		args := ""
		if len(fields) == 2 {
			args = strings.TrimSpace(fields[1])
		}
		m[pid] = args
	}
	return m
}

// markAgentPID reclassifies the tree node carrying the instrumented agent pid
// as agent, regardless of comm — the @rk_agent_state instrumentation is
// authoritative over the comm heuristic table.
func markAgentPID(nodes []Node, pid int) {
	if pid <= 0 {
		return
	}
	for i := range nodes {
		if nodes[i].PID == pid {
			nodes[i].Classification = ClassAgent
		}
		markAgentPID(nodes[i].Children, pid)
	}
}

// HasAgent reports whether any node in the tree is classified agent
// (comm-derived or pid-cross-checked).
func HasAgent(nodes []Node) bool {
	for _, n := range nodes {
		if n.Classification == ClassAgent || HasAgent(n.Children) {
			return true
		}
	}
	return false
}

// PaneHasAgentVia discovers pid's process tree through discover, reclassifies
// the node carrying agentPID as agent when agentPID > 0 (the pane's reconciled
// agent-state pid — instrumentation beats the comm heuristics), and reports
// whether any node classifies agent. It is the ONE liveness walk: `rk mux
// process` prints the returned tree, `rk mux panes` and the operator check
// consume only the bool.
func PaneHasAgentVia(ctx context.Context, discover DiscoverFunc, pid, agentPID int) ([]Node, bool, error) {
	tree, err := discover(ctx, pid)
	if err != nil {
		return nil, false, err
	}
	markAgentPID(tree, agentPID)
	return tree, HasAgent(tree), nil
}

// PaneHasAgent is PaneHasAgentVia over the platform Discover.
func PaneHasAgent(ctx context.Context, pid, agentPID int) ([]Node, bool, error) {
	return PaneHasAgentVia(ctx, Discover, pid, agentPID)
}
