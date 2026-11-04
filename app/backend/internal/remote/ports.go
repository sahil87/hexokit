package remote

import (
	"fmt"

	"rk/internal/portpolicy"
)

// The reserved local-port range for tunnel origins comes from the port
// policy (internal/portpolicy/ports.env); assigned tunnel ports are persisted
// in remotes.yaml and stay immutable thereafter. Declared as vars because Go
// const cannot hold an init-time value.
var (
	// PortRangeStart is the first assignable local tunnel port.
	PortRangeStart = portpolicy.Tunnel.Start
	// PortRangeEnd is the last assignable local tunnel port (inclusive).
	PortRangeEnd = portpolicy.Tunnel.End
)

// AssignPort picks the local port for a new remote. taken is the host's
// current live listener set (ports.ListeningNow at the call boundary);
// explicit is a user-requested port (0 = auto-assign).
//
// Auto-assignment returns the lowest port in [PortRangeStart, PortRangeEnd]
// that no remotes.yaml entry holds and no live listener occupies. An explicit
// port must fall inside the range and pass the same two collision checks —
// the reserved-range guarantee holds for explicit picks too.
func AssignPort(f File, taken []int, explicit int) (int, error) {
	inUse := make(map[int]bool, len(f.Remotes)+len(taken))
	for _, r := range f.Remotes {
		inUse[r.LocalPort] = true
	}
	live := make(map[int]bool, len(taken))
	for _, p := range taken {
		live[p] = true
	}

	if explicit != 0 {
		if explicit < PortRangeStart || explicit > PortRangeEnd {
			return 0, fmt.Errorf("--local-port %d is outside the reserved range %d-%d", explicit, PortRangeStart, PortRangeEnd)
		}
		if inUse[explicit] {
			return 0, fmt.Errorf("--local-port %d is already assigned to another remote", explicit)
		}
		if live[explicit] {
			return 0, fmt.Errorf("--local-port %d is already in use by a listening process", explicit)
		}
		return explicit, nil
	}

	for p := PortRangeStart; p <= PortRangeEnd; p++ {
		if !inUse[p] && !live[p] {
			return p, nil
		}
	}
	return 0, fmt.Errorf("no free local port in the reserved range %d-%d", PortRangeStart, PortRangeEnd)
}
