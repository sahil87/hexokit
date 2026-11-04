package tmux

import (
	"context"
	"strconv"
	"strings"
)

// Session role values returned by SessionRole. Roles are derived from the
// session NAME at request time against the reserved-name constants — never
// stored in a tmux option (Constitution II/X: derivable facts are derived, an
// option would drift from the name that actually drives behavior).
const (
	SessionRoleUser     = "user"
	SessionRolePin      = "pin"
	SessionRoleIso      = "iso"
	SessionRoleControl  = "control"
	SessionRoleOperator = "operator"
	SessionRoleReserved = "reserved"
)

// ReservedSessionPrefix is run-kit's reserved session-name namespace. Every
// infrastructure session run-kit creates is named under it (PinSessionPrefix,
// IsoSessionPrefix, ControlAnchorSessionName, OperatorSessionName); a prefixed
// name matching no known kind classifies SessionRoleReserved, so external consumers that filter
// on `role != "user"` stay correct when a new reserved kind is introduced.
const ReservedSessionPrefix = "_rk-"

// SessionRole classifies a session name into one of the SessionRole* values.
// Only a name STARTING with the reserved prefix is infrastructure — `_rk-`
// occurring mid-name is an ordinary user session.
func SessionRole(name string) string {
	switch {
	case strings.HasPrefix(name, PinSessionPrefix):
		return SessionRolePin
	case strings.HasPrefix(name, IsoSessionPrefix):
		return SessionRoleIso
	case name == ControlAnchorSessionName:
		return SessionRoleControl
	case name == OperatorSessionName:
		return SessionRoleOperator
	case strings.HasPrefix(name, ReservedSessionPrefix):
		return SessionRoleReserved
	}
	return SessionRoleUser
}

// SessionFacts is one session's substrate facts for the `rk mux sessions`
// enumeration — identity, derived role, and the structural facts a spawn-target
// consumer weighs (attached viewers, window count, start path). No
// choreography fields: change/stage enrichment is the fab layer's job
// (docs/specs/cli-layering.md). The field order is the --json key order.
type SessionFacts struct {
	Name string `json:"name"`
	Role string `json:"role"`
	// Attached counts size-arbitrating human clients, group-credited: a
	// client attached via a session-group copy lands on the leader row
	// (ClientInfo.SessionKey), and control-mode/ignore-size attaches — the
	// dashboard's own relays — are already excluded by ListClients.
	Attached int    `json:"attached"`
	Windows  int    `json:"windows"`
	Path     string `json:"path"`
	Grouped  bool   `json:"grouped"`
}

// ListSessionFacts enumerates every session on the server — infrastructure
// included — as SessionFacts rows in tmux enumeration order. A dead server
// degrades to (nil, nil) like ListSessions; CLI callers separate that from an
// alive-but-empty server with their own ServerAlive probe.
func ListSessionFacts(ctx context.Context, server string) ([]SessionFacts, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()

	lines, err := tmuxExecList(ctx, server, "list-sessions", "-F", sessionListFormat())
	if err != nil {
		if containsServerGoneText(err.Error()) {
			return nil, nil
		}
		return nil, err
	}
	clients, err := ListClients(ctx, server)
	if err != nil {
		return nil, err
	}
	return buildSessionFacts(lines, clients), nil
}

// buildSessionFacts folds raw list-sessions lines (sessionListFormat fields)
// into SessionFacts rows. User-role rows follow parseSessions' keep decision
// exactly — the single chokepoint's group-copy fold — so the user-facing set
// can never diverge from what the dashboard shows. Infrastructure rows
// (pin/iso/control), which the chokepoint drops unconditionally, are
// re-included
// from their raw lines: they are never group leaders (baseGroupName excludes
// the anchor by design), so no fold decision applies to them. Pure (no I/O)
// for testability.
func buildSessionFacts(lines []string, clients []ClientInfo) []SessionFacts {
	attached := make(map[string]int)
	for _, c := range clients {
		if key := c.SessionKey(); key != "" {
			attached[key]++
		}
	}

	kept := make(map[string]bool)
	for _, s := range parseSessions(lines) {
		kept[s.Name] = true
	}

	var out []SessionFacts
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 2 {
			continue
		}
		name := parts[0]
		role := SessionRole(name)
		if role != SessionRolePin && role != SessionRoleIso && role != SessionRoleControl && !kept[name] {
			continue
		}
		f := SessionFacts{
			Name:     name,
			Role:     role,
			Attached: attached[name],
			Grouped:  parts[1] == "1",
		}
		// A leaderless group's kept representative (parseSessions' renamed-
		// leader fallback) carries a name that differs from the group key
		// clients report: SessionKey resolves those attaches to the GROUP name
		// (non-numeric #{session_group}), never the representative. Each
		// client lands under exactly one key, so adding the group bucket for
		// a name≠group row cannot double-count. User rows only: an
		// infrastructure member of a user session's group (the _rk-ctl
		// anchor) must not absorb the base session's viewers.
		if role == SessionRoleUser && len(parts) >= 3 {
			if g := parts[2]; g != "" && g != name && !isNumericGroupID(g) {
				f.Attached += attached[g]
			}
		}
		if len(parts) >= 6 {
			f.Windows, _ = strconv.Atoi(parts[5])
		}
		if len(parts) >= 9 {
			f.Path = parts[8]
		}
		out = append(out, f)
	}
	return out
}
