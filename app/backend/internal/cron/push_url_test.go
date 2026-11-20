package cron

import (
	"context"
	"testing"

	"rk/internal/tmux"
)

func TestPushURL(t *testing.T) {
	for _, tc := range []struct {
		server, windowID, want string
	}{
		{"live1", "@7", "/live1/7?tab=cron"},
		{"live1", "", ""},
		{"live1", "7", "/live1/7?tab=cron"},
	} {
		if got := PushURL(tc.server, tc.windowID); got != tc.want {
			t.Errorf("PushURL(%q, %q) = %q, want %q", tc.server, tc.windowID, got, tc.want)
		}
	}
}

// TestOperatorPushURL: the resolver finds the role:operator carrier through
// the seam's radio semantics and degrades to "" when none resolves.
func TestOperatorPushURL(t *testing.T) {
	t.Run("operator carrier resolves", func(t *testing.T) {
		fk := newFakeTmux()
		fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
		fk.windows["dev"] = map[string][]tmux.WindowInfo{"work": {
			{WindowID: "@5"},
			{WindowID: "@9", Role: RoleOperator},
		}}
		if got := operatorPushURL(context.Background(), "dev", fk); got != "/dev/9?tab=cron" {
			t.Errorf("operatorPushURL = %q, want /dev/9?tab=cron", got)
		}
	})

	t.Run("no operator window yields empty", func(t *testing.T) {
		fk := newFakeTmux()
		fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
		fk.windows["dev"] = map[string][]tmux.WindowInfo{"work": {{WindowID: "@5"}}}
		if got := operatorPushURL(context.Background(), "dev", fk); got != "" {
			t.Errorf("operatorPushURL = %q, want empty", got)
		}
	})

	t.Run("no sessions yields empty", func(t *testing.T) {
		fk := newFakeTmux()
		if got := operatorPushURL(context.Background(), "dev", fk); got != "" {
			t.Errorf("operatorPushURL = %q, want empty", got)
		}
	})
}
