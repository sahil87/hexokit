package main

import (
	"rk/internal/config"
	"rk/internal/portpolicy"

	"github.com/spf13/cobra"
)

// portsJSON switches `rk ports` to the machine-readable envelope form.
var portsJSON bool

func init() {
	portsCmd.Flags().BoolVar(&portsJSON, "json", false, "Emit the policy as a {\"ok\",\"result\"} envelope (stable shape for scripts)")
}

// portsBlockDoc is the JSON form of one reserved block (name/start/end).
type portsBlockDoc struct {
	Name  string `json:"name"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// portsDaemonDoc carries the daemon default (with its +1/+2 footprint
// arithmetic) alongside the effective env-resolved ports.
type portsDaemonDoc struct {
	DefaultPort             int `json:"default_port"`
	DefaultDevBackendPort   int `json:"default_dev_backend_port"`
	DefaultCodeServerPort   int `json:"default_code_server_port"`
	EffectivePort           int `json:"effective_port"`
	EffectiveCodeServerPort int `json:"effective_code_server_port"`
}

// portsReport is the stable --json result shape: the policy blocks, the
// sentinel, and the effective-port collision verdict. Collisions is built
// non-nil so it serializes as [] (never null) when clean.
type portsReport struct {
	Daemon     portsDaemonDoc  `json:"daemon"`
	Blocks     []portsBlockDoc `json:"blocks"`
	Sentinel   int             `json:"sentinel"`
	Collisions []portsBlockDoc `json:"collisions"`
}

func blockDoc(b portpolicy.Block) portsBlockDoc {
	return portsBlockDoc{Name: b.Name, Start: b.Start, End: b.End}
}

// portsCmd prints the port POLICY (internal/portpolicy): the reserved blocks
// and the daemon-default arithmetic, plus the effective env-resolved ports
// and a warn-only collision verdict. It always exits 0.
var portsCmd = &cobra.Command{
	Use:   "ports",
	Short: "Print the run-kit port policy (reserved blocks, defaults, collisions)",
	Long: "Print the run-kit port POLICY — the reserved port blocks and the daemon " +
		"default with its footprint arithmetic (dev backend = port+1, code-server = " +
		"port+2 or RK_CODE_SERVER_PORT). Also prints the EFFECTIVE daemon port " +
		"(RK_PORT env over the default) with its resolved code-server port, and " +
		"warns when the effective footprint overlaps a reserved block (a dev build " +
		"exempts the rig block — dev/e2e rigs live there by design). This is the " +
		"policy, not a listing of live listening ports — for those see the " +
		"dashboard's Ports tile (internal/ports collector). Warn-only: a collision " +
		"never fails; the exit code is always 0.",
	Example: `  rk ports
  rk ports --json`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg := config.Load()
		codeServer := cfg.ResolvedCodeServerPort()
		hits := reservedCollisions(cfg)
		collisions := make([]portsBlockDoc, 0, len(hits))
		for _, b := range hits {
			collisions = append(collisions, blockDoc(b))
		}

		sink := newSink(cmd)
		if portsJSON {
			sink.JSONResult(portsReport{
				Daemon: portsDaemonDoc{
					DefaultPort:             portpolicy.DaemonDefault,
					DefaultDevBackendPort:   portpolicy.DaemonDefault + 1,
					DefaultCodeServerPort:   portpolicy.DaemonDefault + 2,
					EffectivePort:           cfg.Port,
					EffectiveCodeServerPort: codeServer,
				},
				Blocks:     []portsBlockDoc{blockDoc(portpolicy.Rig), blockDoc(portpolicy.Tunnel)},
				Sentinel:   portpolicy.Sentinel,
				Collisions: collisions,
			})
			return nil
		}

		sink.Dataf("run-kit port policy (reserved blocks and defaults — not live listening ports)\n\n")
		sink.Dataf("Daemon default:  %d (dev backend +1 → %d, code-server +2 → %d)\n",
			portpolicy.DaemonDefault, portpolicy.DaemonDefault+1, portpolicy.DaemonDefault+2)
		sink.Dataf("Reserved blocks: %s\n", portpolicy.Summary())
		sink.Dataf("Rig triples:     %d per worktree (Vite + Go backend + code-server stub)\n\n",
			(portpolicy.Rig.End-portpolicy.Rig.Start+1)/3)
		sink.Dataf("Effective daemon port: %d (code-server %d)\n", cfg.Port, codeServer)
		if len(collisions) == 0 {
			sink.Dataf("Collisions: none\n")
			return nil
		}
		for _, b := range hits {
			sink.Dataf("WARNING: effective daemon/code-server ports collide with the reserved block %s — set RK_PORT outside it\n", b)
		}
		return nil
	},
}
