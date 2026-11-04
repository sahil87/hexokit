package config

import (
	"os"
	"strconv"

	"rk/internal/apphome"
	"rk/internal/portpolicy"
	"rk/internal/settings"
)

// Deployment-binding env var names — the ONLY keys with env forms
// (Constitution IV). Named constants so the daemon's `-e` pass and every
// reader share one spelling.
const (
	// PortEnvVar wins over the config.yaml `port` key when set to a valid port.
	PortEnvVar = "RK_PORT"
	// HostEnvVar overrides the default bind host when set non-empty.
	HostEnvVar = "RK_HOST"
	// CodeServerPortEnvVar is the optional code-server port override; unset or
	// invalid falls back to the resolved port + 2 convention.
	CodeServerPortEnvVar = "RK_CODE_SERVER_PORT"
)

// Config holds server configuration.
type Config struct {
	Port int
	Host string
	// CodeServerPort is the optional code-server port OVERRIDE (env
	// RK_CODE_SERVER_PORT); 0 means unset (invalid values load as unset).
	// It is never used directly — consumers call ResolvedCodeServerPort,
	// which falls back to the RK_PORT+2 convention. Set the override only to
	// point rk at an externally managed code-server; by default the daemon
	// runs one behind the stable /code/ route, so the port is a private
	// implementation detail and never appears in a URL the frontend builds.
	CodeServerPort int
}

// ResolvedCodeServerPort returns the effective code-server port: the preset
// RK_CODE_SERVER_PORT (CodeServerPort) when valid, else the RK_PORT+2
// convention. This is the ONE resolution rule shared by the daemon's
// code-server spawn, the /code reverse proxy, the SSE reachability probe, and
// doctor — nothing else configures it (Constitution VII). 0 means the feature
// is off, reachable only via a degenerate RK_PORT whose +2 falls outside
// 1-65535.
func (c Config) ResolvedCodeServerPort() int {
	if validPort(c.CodeServerPort) {
		return c.CodeServerPort
	}
	if validPort(c.Port + 2) {
		return c.Port + 2
	}
	return 0
}

var defaults = Config{
	Host: "127.0.0.1",
}

// daemonDefaultPort resolves the code-default port rung at Load time (never
// captured at init, so portpolicy's embedded values are read fresh). An
// unmigrated existing install (apphome.UnmigratedExistingInstall — the same
// predicate the home migration's pin decision uses) is virtually pinned at
// portpolicy.DaemonLegacy: it keeps the port the still-running old daemon
// binds until the migration writes the real pin, and the two pins can never
// disagree. The RK_CONFIG_DIR test override suppresses the pin — an isolated
// run must behave like a fresh install.
func daemonDefaultPort() int {
	if !settings.ConfigRootOverridden() && apphome.UnmigratedExistingInstall() {
		return portpolicy.DaemonLegacy
	}
	return portpolicy.DaemonDefault
}

// validPort returns true if the port is in the valid range 1-65535.
func validPort(p int) bool {
	return p >= 1 && p <= 65535
}

// Load resolves configuration: code default < config.yaml < env. The port's
// middle rung is the settings registry's `port` key (0 = unset); a valid
// RK_PORT wins over it, an invalid one (non-numeric or out of range) is
// ignored so the lower rung applies. RK_HOST and RK_CODE_SERVER_PORT stay
// env-only.
func Load() Config {
	cfg := defaults
	cfg.Port = daemonDefaultPort()

	if p := settings.Load().Port; validPort(p) {
		cfg.Port = p
	}

	if portStr := os.Getenv(PortEnvVar); portStr != "" {
		if p, err := strconv.Atoi(portStr); err == nil && validPort(p) {
			cfg.Port = p
		}
	}

	if host := os.Getenv(HostEnvVar); host != "" {
		cfg.Host = host
	}

	if csPortStr := os.Getenv(CodeServerPortEnvVar); csPortStr != "" {
		if p, err := strconv.Atoi(csPortStr); err == nil && validPort(p) {
			cfg.CodeServerPort = p
		}
	}

	return cfg
}
