package operatorloop

import (
	"context"
	"os"
)

// StateFileExists reports whether rk's operator state file exists for the
// server — the switch cron.Deps.LoopSeed uses to seed the loop entry. Before
// `rk operator adopt` (or the first `track add`) creates it, a server keeps
// fab's typed operator tick untouched.
func StateFileExists(ctx context.Context, server string) bool {
	path, err := statePathFn(ctx, server)
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}
