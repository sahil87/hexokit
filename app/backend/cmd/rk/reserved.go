package main

import (
	"fmt"
	"strings"

	"rk/internal/config"
	"rk/internal/portpolicy"
)

// reservedCollisions is the one collision read shared by serve's startup
// warning, the doctor ports row, and `rk ports`, so the three surfaces never
// disagree. Dev builds (version == "dev": just dev/air and the e2e rig's
// un-ldflagged go build) drop ONLY the rig block — worktree dev servers and
// e2e rigs sit on rig-block ports by design, so warning there would fire on
// every dev loop with advice that does not apply. Tunnel and sentinel hits
// warn on every build. Tests flip the root.go `version` var directly.
func reservedCollisions(cfg config.Config) []portpolicy.Block {
	hits := portpolicy.Collisions(cfg.Port, cfg.ResolvedCodeServerPort())
	if version != "dev" {
		return hits
	}
	out := hits[:0]
	for _, b := range hits {
		if b.Name != portpolicy.Rig.Name {
			out = append(out, b)
		}
	}
	return out
}

// footprintHit is one daemon-footprint port that landed inside a reserved
// block, plus the env var that moves it: RK_PORT for the daemon port itself
// and for a code-server port riding the +2 convention, RK_CODE_SERVER_PORT
// for an explicit override. reservedCollisions says WHICH block collides;
// blockFootprintHits says WHICH port does, so a code-server-only collision
// (RK_PORT outside the block, RK_CODE_SERVER_PORT inside) is never
// attributed to the daemon port.
type footprintHit struct {
	kind   string // "daemon" or "code-server"
	port   int
	envVar string
}

// String renders the hit as "daemon :3150" / "code-server :3100" — the one
// fragment format serve's warning and doctor's note both use.
func (h footprintHit) String() string {
	return fmt.Sprintf("%s :%d", h.kind, h.port)
}

// blockFootprintHits reports which footprint ports (daemon port, resolved
// code-server port) fall inside b, daemon first. Call it only for a block
// reservedCollisions already returned — it never comes back empty there.
func blockFootprintHits(cfg config.Config, b portpolicy.Block) []footprintHit {
	var hits []footprintHit
	if b.Contains(cfg.Port) {
		hits = append(hits, footprintHit{kind: "daemon", port: cfg.Port, envVar: "RK_PORT"})
	}
	if cs := cfg.ResolvedCodeServerPort(); cs != 0 && b.Contains(cs) {
		envVar := "RK_PORT"
		if cfg.CodeServerPort >= 1 && cfg.CodeServerPort <= 65535 {
			envVar = "RK_CODE_SERVER_PORT"
		}
		hits = append(hits, footprintHit{kind: "code-server", port: cs, envVar: envVar})
	}
	return hits
}

// footprintSummary joins hit fragments for one block ("daemon :3150,
// code-server :3152") and collects the remedy env vars in first-seen order.
func footprintSummary(hits []footprintHit) (ports string, envVars []string) {
	parts := make([]string, len(hits))
	seen := make(map[string]bool, len(hits))
	for i, h := range hits {
		parts[i] = h.String()
		if !seen[h.envVar] {
			seen[h.envVar] = true
			envVars = append(envVars, h.envVar)
		}
	}
	return strings.Join(parts, ", "), envVars
}
