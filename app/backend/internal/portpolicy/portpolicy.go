// Package portpolicy is the single source of truth for run-kit's reserved
// and default ports. The values live in the committed ports.env data file,
// embedded here and also sourced by scripts/e2e-env.sh + scripts/test-e2e.sh
// and parsed by the Playwright e2e helpers — every consumer reads the same
// file. Unrelated to internal/ports, which collects live listening ports.
package portpolicy

import (
	_ "embed"
	"fmt"
	"strconv"
	"strings"
)

//go:embed ports.env
var raw string

// Block is an inclusive reserved port range.
type Block struct {
	Name       string
	Start, End int
}

// Contains reports whether p falls inside the block.
func (b Block) Contains(p int) bool { return p >= b.Start && p <= b.End }

// String renders the block as "name start–end", or "name port" for a
// one-port block (the sentinel) — the one block format every surface uses.
func (b Block) String() string {
	if b.Start == b.End {
		return fmt.Sprintf("%s %d", b.Name, b.Start)
	}
	return fmt.Sprintf("%s %d–%d", b.Name, b.Start, b.End)
}

var (
	// DaemonDefault is the default daemon (Vite/serve) port. Dev backend is
	// +1, code-server +2 by convention.
	DaemonDefault int
	// DaemonLegacy is the pre-rename daemon default. Existing installs are
	// pinned here through the HexoKit rename; only fresh installs take
	// DaemonDefault once it moves.
	DaemonLegacy int
	// Rig is the e2e rig block, allocated in triples (Vite, Go backend,
	// code-server stub).
	Rig Block
	// Tunnel is the rk remote SSH-tunnel local-port block. Values are
	// persisted in remotes.yaml.
	Tunnel Block
	// Sentinel is the Playwright fail-closed port: a bare `playwright test`
	// connects here and finds nothing listening.
	Sentinel int
)

func init() {
	vals, err := parse(raw)
	if err != nil {
		panic(fmt.Sprintf("portpolicy: %v", err))
	}
	DaemonDefault = vals["PORTPOLICY_DAEMON_DEFAULT"]
	DaemonLegacy = vals["PORTPOLICY_DAEMON_LEGACY"]
	Rig = Block{Name: "rig", Start: vals["PORTPOLICY_RIG_START"], End: vals["PORTPOLICY_RIG_END"]}
	Tunnel = Block{Name: "tunnel", Start: vals["PORTPOLICY_TUNNEL_START"], End: vals["PORTPOLICY_TUNNEL_END"]}
	Sentinel = vals["PORTPOLICY_SENTINEL"]
}

// parse reads bash-sourceable KEY=integer lines; '#' comments and blank
// lines are ignored. A missing key or non-integer value is a programmer
// error in the committed file, so it returns an error (init panics on it).
func parse(data string) (map[string]int, error) {
	vals := make(map[string]int)
	for i, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("ports.env line %d: %q is not KEY=VALUE", i+1, line)
		}
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("ports.env line %d: %s is not an integer", i+1, key)
		}
		vals[strings.TrimSpace(key)] = n
	}
	for _, key := range []string{
		"PORTPOLICY_DAEMON_DEFAULT",
		"PORTPOLICY_DAEMON_LEGACY",
		"PORTPOLICY_RIG_START",
		"PORTPOLICY_RIG_END",
		"PORTPOLICY_TUNNEL_START",
		"PORTPOLICY_TUNNEL_END",
		"PORTPOLICY_SENTINEL",
	} {
		if _, ok := vals[key]; !ok {
			return nil, fmt.Errorf("ports.env: missing key %s", key)
		}
	}
	return vals, nil
}

// Reserved returns every block a daemon must not land in: the rig block,
// the tunnel block, and the sentinel as a one-port block.
func Reserved() []Block {
	return []Block{Rig, Tunnel, {Name: "sentinel", Start: Sentinel, End: Sentinel}}
}

// Summary renders the reserved blocks as a one-line list
// ("rig 21000–21299, tunnel 3100–3199, sentinel 21999"). It is the single
// formatter for that list — `rk ports` and the doctor ports row both use it
// so the two surfaces can never disagree.
func Summary() string {
	parts := make([]string, 0, len(Reserved()))
	for _, b := range Reserved() {
		parts = append(parts, b.String())
	}
	return strings.Join(parts, ", ")
}

// Collisions reports which reserved blocks the daemon footprint overlaps.
// The footprint is the daemon port plus its resolved code-server port
// (port+2 by convention, or the explicit RK_CODE_SERVER_PORT; a 0
// code-server port is ignored). Each block is reported at most once.
func Collisions(port, codeServerPort int) []Block {
	var hits []Block
	for _, b := range Reserved() {
		if b.Contains(port) || (codeServerPort != 0 && b.Contains(codeServerPort)) {
			hits = append(hits, b)
		}
	}
	return hits
}
