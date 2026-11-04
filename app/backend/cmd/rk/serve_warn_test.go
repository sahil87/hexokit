package main

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"rk/internal/config"
	"rk/internal/portpolicy"
)

// captureSlog swaps the default slog logger for one writing to a buffer and
// restores it on cleanup — serve's collision warning rides the default
// logger (warnReservedPorts runs before serve installs its own).
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := new(bytes.Buffer)
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, nil)))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return buf
}

func TestWarnReservedPorts(t *testing.T) {
	// version is the ldflags build var; flip it per case (restored on
	// cleanup) to cover the dev-build rig-block exemption. Empty means the
	// test binary's default "dev".
	cases := []struct {
		name      string
		version   string
		cfg       config.Config
		wantWarns int
		want      []string
		notWant   []string
	}{
		{name: "default port stays silent", cfg: config.Config{Port: portpolicy.DaemonDefault}},
		{name: "dev build on a rig port stays silent", cfg: config.Config{Port: 21000}},
		{name: "released build on a rig port warns", version: "1.2.3", cfg: config.Config{Port: 21000}, wantWarns: 1,
			want: []string{"daemon :21000", "block=rig", "start=21000", "end=21299", "RK_PORT"}},
		{name: "dev build on a tunnel port warns", cfg: config.Config{Port: 3150}, wantWarns: 1,
			want: []string{"daemon :3150", "code-server :3152", "block=tunnel", "start=3100", "end=3199", "RK_PORT"}},
		{name: "dev build on the sentinel warns", cfg: config.Config{Port: 21999}, wantWarns: 1,
			want: []string{"daemon :21999", "block=sentinel", "start=21999", "end=21999"}},
		{name: "code-server straddles into tunnel via explicit override", cfg: config.Config{Port: 3098, CodeServerPort: 3100}, wantWarns: 1,
			want: []string{"code-server :3100", "block=tunnel", "RK_CODE_SERVER_PORT"},
			notWant: []string{"daemon :3098"}},
		{name: "code-server straddles into tunnel via the +2 convention", cfg: config.Config{Port: 3098}, wantWarns: 1,
			want: []string{"code-server :3100", "block=tunnel", "RK_PORT"},
			notWant: []string{"daemon :3098", "RK_CODE_SERVER_PORT"}},
		{name: "code-server-only collision never names the daemon port", cfg: config.Config{Port: 3000, CodeServerPort: 3100}, wantWarns: 1,
			want: []string{"code-server :3100", "block=tunnel", "RK_CODE_SERVER_PORT"},
			notWant: []string{"daemon :3000"}},
		{name: "released build: one warning per non-rig block", version: "1.2.3", cfg: config.Config{Port: 21000, CodeServerPort: 3100}, wantWarns: 2,
			want: []string{"block=rig", "daemon :21000", "block=tunnel", "code-server :3100"}},
		{name: "dev build: rig dropped, tunnel still warns", cfg: config.Config{Port: 21000, CodeServerPort: 3100}, wantWarns: 1,
			want: []string{"block=tunnel", "code-server :3100"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.version != "" {
				orig := version
				version = tc.version
				t.Cleanup(func() { version = orig })
			}
			buf := captureSlog(t)
			warnReservedPorts(tc.cfg)
			out := buf.String()
			if got := strings.Count(out, "level=WARN"); got != tc.wantWarns {
				t.Fatalf("warn count = %d, want %d (output %q)", got, tc.wantWarns, out)
			}
			for _, want := range tc.want {
				if !strings.Contains(out, want) {
					t.Errorf("output missing %q (got %q)", want, out)
				}
			}
			for _, notWant := range tc.notWant {
				if strings.Contains(out, notWant) {
					t.Errorf("output must not contain %q (got %q)", notWant, out)
				}
			}
		})
	}
}
