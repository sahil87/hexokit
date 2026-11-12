//go:build linux

package proctree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Discover discovers the process tree for a given PID on Linux
// by reading /proc filesystem entries.
func Discover(_ context.Context, pid int) ([]Node, error) {
	node, err := buildNodeFromProc(pid, 0)
	if err != nil {
		return nil, err
	}
	return []Node{node}, nil
}

// buildNodeFromProc recursively builds a Node from /proc.
func buildNodeFromProc(pid, ppid int) (Node, error) {
	comm := readProcFile(fmt.Sprintf("/proc/%d/comm", pid))
	cmdline := readProcCmdline(pid)

	node := Node{
		PID:            pid,
		PPID:           ppid,
		Comm:           comm,
		Cmdline:        cmdline,
		Classification: Classify(comm, cmdline),
		Children:       []Node{},
	}

	// Read children from /proc/<pid>/task/<tid>/children
	childPIDs := readChildPIDs(pid)
	for _, childPID := range childPIDs {
		child, err := buildNodeFromProc(childPID, pid)
		if err != nil {
			continue // skip unreadable children
		}
		node.Children = append(node.Children, child)
	}

	return node, nil
}

// readChildPIDs reads child PIDs from /proc/<pid>/task/<tid>/children.
func readChildPIDs(pid int) []int {
	var children []int
	taskDir := fmt.Sprintf("/proc/%d/task", pid)

	entries, err := os.ReadDir(taskDir)
	if err != nil {
		return children
	}

	seen := make(map[int]bool)
	for _, entry := range entries {
		childrenFile := filepath.Join(taskDir, entry.Name(), "children")
		data, err := os.ReadFile(childrenFile)
		if err != nil {
			continue
		}
		for _, field := range strings.Fields(string(data)) {
			childPID, err := strconv.Atoi(field)
			if err != nil {
				continue
			}
			if !seen[childPID] {
				seen[childPID] = true
				children = append(children, childPID)
			}
		}
	}
	return children
}

// readProcFile reads a /proc file and returns its trimmed content.
func readProcFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// readProcCmdline reads /proc/<pid>/cmdline (NUL-separated) and returns a space-joined string.
func readProcCmdline(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	// cmdline is NUL-separated
	parts := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
	return strings.Join(parts, " ")
}
