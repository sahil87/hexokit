//go:build darwin

package proctree

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// psEntry holds a parsed ps output entry.
type psEntry struct {
	pid  int
	ppid int
	comm string
}

// Discover discovers the process tree for a given PID on macOS
// by using ps to enumerate processes and filtering by PPID traversal. The ps
// invocations run under the caller's context (exec.CommandContext argv slices
// — Constitution §I).
func Discover(ctx context.Context, pid int) ([]Node, error) {
	out, err := exec.CommandContext(ctx, "ps", "-o", "pid,ppid,comm", "-ax").Output()
	if err != nil {
		return nil, fmt.Errorf("ps: %w", err)
	}

	var entries []psEntry
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines[1:] { // skip header
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		p, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		pp, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		// comm may have path -- take the last component
		comm := fields[2]
		if idx := strings.LastIndex(comm, "/"); idx >= 0 {
			comm = comm[idx+1:]
		}
		entries = append(entries, psEntry{pid: p, ppid: pp, comm: comm})
	}

	// Build children map
	childrenMap := make(map[int][]psEntry)
	entryMap := make(map[int]psEntry)
	for _, e := range entries {
		childrenMap[e.ppid] = append(childrenMap[e.ppid], e)
		entryMap[e.pid] = e
	}

	rootEntry, ok := entryMap[pid]
	if !ok {
		return nil, fmt.Errorf("PID %d not found in ps output", pid)
	}

	// Second single pass: full command lines for every PID, joined by PID
	// during the tree walk. Replaces the per-node `ps -o args= -p <pid>`
	// spawns (N+1) and removes the TOCTOU window where a process exiting
	// between the enumeration and the per-pid lookup yielded cmdline "".
	// The two-pass pid=,args= form is used (not one-pass pid,ppid,comm,args)
	// because comm may contain spaces (common for macOS app paths), which
	// would mis-parse a combined listing.
	cmdlines := getPSCmdlines(ctx)

	node := buildNodeFromPS(rootEntry, childrenMap, cmdlines)
	return []Node{node}, nil
}

// buildNodeFromPS recursively builds a Node from ps data. cmdlines is
// the PID→args map from getPSCmdlines; a PID missing from it (process exited
// between the two ps passes) yields cmdline "" — the same degraded value the
// per-pid spawn produced on failure.
func buildNodeFromPS(entry psEntry, childrenMap map[int][]psEntry, cmdlines map[int]string) Node {
	node := Node{
		PID:            entry.pid,
		PPID:           entry.ppid,
		Comm:           entry.comm,
		Cmdline:        cmdlines[entry.pid],
		Classification: Classify(entry.comm, cmdlines[entry.pid]),
		Children:       []Node{},
	}

	for _, child := range childrenMap[entry.pid] {
		node.Children = append(node.Children, buildNodeFromPS(child, childrenMap, cmdlines))
	}

	return node
}

// getPSCmdlines returns the full command line per PID via ONE
// `ps -axo pid=,args=` pass. Returns an empty map on ps failure (every
// node then degrades to cmdline "", matching the prior per-pid behavior).
func getPSCmdlines(ctx context.Context) map[int]string {
	out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,args=").Output()
	if err != nil {
		return map[int]string{}
	}
	return parsePSCmdlines(string(out))
}
