package operatorloop

import (
	"context"
	"os"
)

// StateFileExists reports whether rk's operator state file exists for the
// server — the switch cron.Deps.LoopSeed uses to seed the loop entry. Any rk
// state write creates the file: `rk operator adopt`, `rk operator track add`
// and `rk operator check` (which writes `last_check_at` through Mutate). Until
// one of them runs, a server keeps fab's typed operator tick untouched.
func StateFileExists(ctx context.Context, server string) bool {
	path, err := statePathFn(ctx, server)
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}
