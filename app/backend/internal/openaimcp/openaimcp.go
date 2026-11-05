// Package openaimcp owns the files behind the ChatGPT connector: the
// tunnel-client install under the state home, the 0600 runtime API key file,
// and the tunnel-client profile derived from settings. It runs no processes
// and touches no tmux; internal/daemon spawns and supervises tunnel-client
// from what this package resolves (docs/specs/openai-mcp.md).
package openaimcp

import "regexp"

// tunnelIDPattern is the shape of an OpenAI tunnel ID as Platform shows it.
// The charset is closed so the value is safe to write into the YAML profile
// and to echo in logs.
var tunnelIDPattern = regexp.MustCompile(`^tunnel_[A-Za-z0-9]+$`)

// ValidateTunnelID returns "" for a well-formed tunnel ID, else a one-line
// reason suitable for a 400 body.
func ValidateTunnelID(id string) string {
	if !tunnelIDPattern.MatchString(id) {
		return "tunnel ID must look like tunnel_ followed by letters and digits (copy it from platform.openai.com → Settings → Tunnels)"
	}
	return ""
}
