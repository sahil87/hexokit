package main

import (
	"log/slog"
	"testing"
)

// migrateHomesUnlessDev gates the serve-start home migration on a release
// build (version != "dev"), so dev rigs and e2e rigs never freeze a stale
// copy of the developer's real legacy home, and DEFERS it while the daemon
// port is already bound — that live daemon still writes the legacy home,
// which a publish would hide. The one-shot ~/.rk move (moveRKTenants) and the
// stale legacy-home deletion (deleteLegacyHomes) run immediately after
// migrateHomes, in that order, and inherit both gates exactly.
func TestMigrateHomesUnlessDev(t *testing.T) {
	origMigrate := migrateHomes
	t.Cleanup(func() { migrateHomes = origMigrate })
	origMove := moveRKTenants
	t.Cleanup(func() { moveRKTenants = origMove })
	origDelete := deleteLegacyHomes
	t.Cleanup(func() { deleteLegacyHomes = origDelete })
	origVersion := version
	t.Cleanup(func() { version = origVersion })
	origBusy := daemonPortBusyFn
	t.Cleanup(func() { daemonPortBusyFn = origBusy })

	t.Run("dev build skips the migration, the ~/.rk move, and the legacy-home deletion", func(t *testing.T) {
		var calls []string
		migrateHomes = func(*slog.Logger) { calls = append(calls, "migrate") }
		moveRKTenants = func(*slog.Logger) { calls = append(calls, "move") }
		deleteLegacyHomes = func(*slog.Logger) { calls = append(calls, "delete") }
		version = "dev"
		daemonPortBusyFn = func() bool { return false }

		migrateHomesUnlessDev()

		if len(calls) != 0 {
			t.Errorf("dev build must not run the home migration, the ~/.rk move, or the legacy-home deletion, ran %v", calls)
		}
	})

	t.Run("release build runs the migration, then the ~/.rk move, then the legacy-home deletion", func(t *testing.T) {
		var calls []string
		migrateHomes = func(*slog.Logger) { calls = append(calls, "migrate") }
		moveRKTenants = func(*slog.Logger) { calls = append(calls, "move") }
		deleteLegacyHomes = func(*slog.Logger) { calls = append(calls, "delete") }
		version = "v1.2.3"
		daemonPortBusyFn = func() bool { return false }

		migrateHomesUnlessDev()

		if len(calls) != 3 || calls[0] != "migrate" || calls[1] != "move" || calls[2] != "delete" {
			t.Errorf("release build must run migrateHomes, MoveRKTenants, then DeleteLegacyHomes at serve start, ran %v", calls)
		}
	})

	t.Run("release build defers all three while the daemon port is bound", func(t *testing.T) {
		var calls []string
		migrateHomes = func(*slog.Logger) { calls = append(calls, "migrate") }
		moveRKTenants = func(*slog.Logger) { calls = append(calls, "move") }
		deleteLegacyHomes = func(*slog.Logger) { calls = append(calls, "delete") }
		version = "v1.2.3"
		daemonPortBusyFn = func() bool { return true }

		migrateHomesUnlessDev()

		if len(calls) != 0 {
			t.Errorf("release build must defer the home migration, the ~/.rk move, and the legacy-home deletion while a live daemon holds the port, ran %v", calls)
		}
	})
}
