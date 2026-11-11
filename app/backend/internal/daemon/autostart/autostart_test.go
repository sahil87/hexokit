package autostart

import (
	"context"
	"strings"
	"testing"
)

type fakeBackend struct{}

func (fakeBackend) On(context.Context, OnOptions) (Result, error) { return Result{}, nil }
func (fakeBackend) Off(context.Context) (Result, error)           { return Result{}, nil }
func (fakeBackend) Status(context.Context) (Status, error)        { return Status{}, nil }

// withRegistry swaps the package registry for the test's duration so tests
// never see (or disturb) the backends real files register from init().
func withRegistry(t *testing.T, r map[string]func() Backend) {
	t.Helper()
	orig := registry
	registry = r
	t.Cleanup(func() { registry = orig })
}

func TestFor_RegisteredGOOS(t *testing.T) {
	withRegistry(t, map[string]func() Backend{})
	Register("plan9", func() Backend { return fakeBackend{} })

	b, err := For("plan9")
	if err != nil {
		t.Fatalf("For(plan9) error = %v", err)
	}
	if _, ok := b.(fakeBackend); !ok {
		t.Fatalf("For(plan9) = %T, want fakeBackend", b)
	}
}

func TestFor_UnregisteredGOOSNamesPlatform(t *testing.T) {
	withRegistry(t, map[string]func() Backend{})
	Register("plan9", func() Backend { return fakeBackend{} })
	Register("aix", func() Backend { return fakeBackend{} })

	_, err := For("windows")
	if err == nil {
		t.Fatal("For(windows) error = nil, want unsupported-platform error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "not supported on windows") {
		t.Errorf("error %q does not name the platform", msg)
	}
	if !strings.Contains(msg, "aix, plan9") {
		t.Errorf("error %q does not list the supported platforms sorted", msg)
	}
}

func TestRegister_DuplicatePanics(t *testing.T) {
	withRegistry(t, map[string]func() Backend{})
	Register("plan9", func() Backend { return fakeBackend{} })
	defer func() {
		if recover() == nil {
			t.Error("second Register(plan9) did not panic")
		}
	}()
	Register("plan9", func() Backend { return fakeBackend{} })
}

func TestStartScript(t *testing.T) {
	tests := []struct {
		name     string
		rkPath   string
		unsetEnv []string
		want     string
	}{
		{
			name:   "no unset",
			rkPath: "/opt/homebrew/bin/hexokit",
			want:   `exec '/opt/homebrew/bin/hexokit' daemon start --if-not-running`,
		},
		{
			name:     "unset prefix",
			rkPath:   "/usr/local/bin/rk",
			unsetEnv: []string{"INVOCATION_ID", "JOURNAL_STREAM"},
			want:     `exec env -u 'INVOCATION_ID' -u 'JOURNAL_STREAM' '/usr/local/bin/rk' daemon start --if-not-running`,
		},
		{
			name:   "path with space and quote stays one word",
			rkPath: "/Users/o'neil/my bin/rk",
			want:   `exec '/Users/o'\''neil/my bin/rk' daemon start --if-not-running`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := StartScript(tt.rkPath, tt.unsetEnv); got != tt.want {
				t.Errorf("StartScript() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestStatusSummary(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		name string
		s    Status
		want string
	}{
		{"unregistered", Status{}, SummaryOff},
		{"unregistered but enabled flag", Status{Enabled: true, StartsAt: StartsAtBoot}, SummaryOff},
		{"registered disabled", Status{Registered: true, StartsAt: StartsAtLogin}, SummaryDisabled},
		{"boot", Status{Registered: true, Enabled: true, StartsAt: StartsAtBoot, Linger: &yes}, "on (boot)"},
		{"boot, linger nil", Status{Registered: true, Enabled: true, StartsAt: StartsAtBoot}, "on (boot)"},
		{"login, linger off", Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin, Linger: &no}, "on (login only — enable lingering for boot)"},
		{"login, linger nil", Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin}, "on (login)"},
		{"login, linger on", Status{Registered: true, Enabled: true, StartsAt: StartsAtLogin, Linger: &yes}, "on (login)"},
		{"enabled, unknown starts_at", Status{Registered: true, Enabled: true}, "on (login)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.s.Summary(); got != tc.want {
				t.Errorf("Summary() = %q, want %q", got, tc.want)
			}
		})
	}
}
