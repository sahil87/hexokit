package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// schemaVersion is the frozen contract version for the help-dump JSON.
// It mirrors the shape consumed by the sahil87/shll.ai landing site
// (reference sample: help/wt.json). Bump only on a breaking shape change.
const schemaVersion = 1

// node is one command in the emitted help tree. Field names and order match
// the frozen JSON contract (mirrors sahil87/shll.ai help/wt.json). commands is
// recursive and MUST serialize as [] for a leaf, never null — callers build it
// as a non-nil slice.
type node struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Short    string `json:"short"`
	Usage    string `json:"usage"`
	Text     string `json:"text"`
	Commands []node `json:"commands"`
}

// dump is the top-level help-dump document. The shape is frozen:
// {tool, version, schema_version, root}. captured_at is deliberately NOT
// emitted — the help-dump standard reserves the capture timestamp for the
// shll.ai puller (a tool cannot know its own capture time), which stamps it
// after capture.
type dump struct {
	Tool          string `json:"tool"`
	Version       string `json:"version"`
	SchemaVersion int    `json:"schema_version"`
	Root          node   `json:"root"`
}

// includeInDump reports whether a command should appear in the dump. Cobra's
// auto-generated completion and help subcommands are excluded by name, and any
// hidden command (including help-dump itself) is excluded by flag. Applied at
// every recursion level, so a hidden parent's whole subtree is dropped.
func includeInDump(cmd *cobra.Command) bool {
	if cmd.Hidden {
		return false
	}
	switch cmd.Name() {
	case "completion", "help":
		return false
	}
	return true
}

// captureNode recursively builds a node from cmd, descending into visible
// children to full depth. commands is always non-nil so a leaf serializes as
// [] rather than null. The capture is pure introspection — no subprocess, no
// shell-string construction (constitution: Security First).
func captureNode(cmd *cobra.Command) node {
	n := node{
		Name:     cmd.Name(),
		Path:     cmd.CommandPath(),
		Short:    cmd.Short,
		Usage:    cmd.UseLine(),
		Text:     cmd.UsageString(),
		Commands: []node{},
	}
	for _, child := range cmd.Commands() {
		if !includeInDump(child) {
			continue
		}
		n.Commands = append(n.Commands, captureNode(child))
	}
	return n
}

// buildDump assembles the full document from root and an injected version.
// Pure function of its inputs so it is testable without spawning a process.
// The tool field follows the root command's name so the envelope can never
// drift from the binary's invocation name.
func buildDump(root *cobra.Command, version string) dump {
	return dump{
		Tool:          root.Name(),
		Version:       version,
		SchemaVersion: schemaVersion,
		Root:          captureNode(root),
	}
}

var helpDumpCmd = &cobra.Command{
	Use:    "help-dump [output-path]",
	Short:  "Emit the CLI help tree as JSON (build tooling)",
	Hidden: true,
	Args:   cobra.MaximumNArgs(1),
	RunE:   runHelpDump,
}

func runHelpDump(cmd *cobra.Command, args []string) error {
	doc := buildDump(rootCmd, displayVersion())

	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding help-dump JSON: %w", err)
	}

	if len(args) == 1 {
		if err := os.WriteFile(args[0], data, 0o644); err != nil {
			return fmt.Errorf("writing help-dump to %s: %w", args[0], err)
		}
		return nil
	}

	if _, err := fmt.Fprintln(cmd.OutOrStdout(), string(data)); err != nil {
		return fmt.Errorf("writing help-dump to stdout: %w", err)
	}
	return nil
}
