package main

import (
	"log/slog"
	"testing"
)

// migrateHomesUnlessDev gates the serve-start home migration on a release
// build (version != "dev"), so dev rigs and e2e rigs never freeze a stale
// copy of the developer's real legacy home, and DEFERS it while the daemon
// port is already bound — that live daemon still writes the legacy home,
// which a publish would hide. The one-shot ~/.rk move (moveRKTenants) runs
// immediately after migrateHomes and inherits both gates exactly.
func TestMigrateHomesUnlessDev(t *testing.T) {
	origMigrate := migrateHomes
	t.Cleanup(func() { migrateHomes = origMigrate })
	origMove := moveRKTenants
	t.Cleanup(func() { moveRKTenants = origMove })
	origVersion := version
	t.Cleanup(func() { version = origVersion })
	origBusy := daemonPortBusyFn
	t.Cleanup(func() { daemonPortBusyFn = origBusy })

	t.Run("dev build skips the migration and the ~/.rk move", func(t *testing.T) {
		var calls []string
		migrateHomes = func(*slog.Logger) { calls = append(calls, "migrate") }
		moveRKTenants = func(*slog.Logger) { calls = append(calls, "move") }
		version = "dev"
		daemonPortBusyFn = func() bool { return false }

		migrateHomesUnlessDev()

		if len(calls) != 0 {
			t.Errorf("dev build must not run the home migration or the ~/.rk move, ran %v", calls)
		}
	})

	t.Run("release build runs the migration then the ~/.rk move", func(t *testing.T) {
		var calls []string
		migrateHomes = func(*slog.Logger) { calls = append(calls, "migrate") }
		moveRKTenants = func(*slog.Logger) { calls = append(calls, "move") }
		version = "v1.2.3"
		daemonPortBusyFn = func() bool { return false }

		migrateHomesUnlessDev()

		if len(calls) != 2 || calls[0] != "migrate" || calls[1] != "move" {
			t.Errorf("release build must run migrateHomes then MoveRKTenants at serve start, ran %v", calls)
		}
	})

	t.Run("release build defers both while the daemon port is bound", func(t *testing.T) {
		var calls []string
		migrateHomes = func(*slog.Logger) { calls = append(calls, "migrate") }
		moveRKTenants = func(*slog.Logger) { calls = append(calls, "move") }
		version = "v1.2.3"
		daemonPortBusyFn = func() bool { return true }

		migrateHomesUnlessDev()

		if len(calls) != 0 {
			t.Errorf("release build must defer the home migration and the ~/.rk move while a live daemon holds the port, ran %v", calls)
		}
	})
}
