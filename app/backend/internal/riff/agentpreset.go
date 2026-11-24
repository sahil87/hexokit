package riff

import (
	"context"
	"log/slog"

	"rk/internal/tmux"
	"rk/internal/validate"
)

// AgentPresetEnv is the env var fab reads as "the agent preset for this
// resolution" — set on the `fab agent` exec that resolves the launcher and on
// every pane of the spawned tab, so the agent's own fab calls (including `fab
// dispatch start`) resolve the same preset as its launcher.
const AgentPresetEnv = "FAB_AGENT_PRESET"

// Where an inherited agent preset came from.
const (
	AgentPresetFromGroup     = "group"
	AgentPresetFromWorkspace = "workspace"
	agentPresetFromExplicit  = "explicit"
)

// AgentPresetEnvEntry is the `FAB_AGENT_PRESET=<name>` env entry for a name.
func AgentPresetEnvEntry(name string) string { return AgentPresetEnv + "=" + name }

// PickAgentPreset is the spawn-time ladder: the explicit pick, else the
// group's option, else the workspace's, else nothing. It returns the name and
// where it came from ("" and "" when nothing is set). A group or workspace
// value failing the identifier allowlist (a hand-set tmux option) is skipped
// with a warning and the ladder continues; membership is deliberately not
// checked — a stale name still spawns and fab warns and ignores it. The
// explicit pick is the caller's, already validated.
func PickAgentPreset(explicit, sessionOpt, serverOpt string) (name, from string) {
	if explicit != "" {
		return explicit, agentPresetFromExplicit
	}
	for _, c := range []struct{ value, from, option string }{
		{sessionOpt, AgentPresetFromGroup, tmux.SessionAgentPresetOption},
		{serverOpt, AgentPresetFromWorkspace, tmux.ServerAgentPresetOption},
	} {
		if c.value == "" {
			continue
		}
		if msg := validate.ValidateAgentPresetName(c.value); msg != "" {
			slog.Warn("ignoring invalid agent preset option", "option", c.option, "value", c.value, "reason", msg)
			continue
		}
		return c.value, c.from
	}
	return "", ""
}

// readAgentPresetOptions is the tmux read seam behind ResolveAgentPreset (a var
// for tests).
var readAgentPresetOptions = tmux.ReadAgentPresetOptions

// ResolveAgentPreset runs the ladder for a spawn target. server/session name
// the target (empty server = the CLI path, targeted through callerTMUX). Every
// fresh-spawn caller resolves exactly once through here; resume and fork
// spawns never call it, so a restored conversation keeps its own launcher.
// Option reads are skipped when the explicit pick already decides the name.
func ResolveAgentPreset(ctx context.Context, explicit, server, session, callerTMUX string) string {
	if explicit != "" {
		name, _ := PickAgentPreset(explicit, "", "")
		return name
	}
	sessionOpt, serverOpt := readAgentPresetOptions(ctx, server, session, callerTMUX)
	name, _ := PickAgentPreset("", sessionOpt, serverOpt)
	return name
}
