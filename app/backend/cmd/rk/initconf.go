package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"rk/internal/tmux"
)

// newInitConfCmd builds one instance of the init-conf command. A cobra command
// object cannot have two parents, so the family member (`rk mux init-conf`)
// and the hidden root alias (`rk init-conf`) are two instances sharing the same
// RunE core; the flag variable binds per-instance so the two never share state.
// deprecated marks the root alias: hidden from help, and cobra prints the
// pointer (to OutOrStderr — stderr in production) before still running the
// command with identical flags and exit codes.
func newInitConfCmd(use string, deprecated bool) *cobra.Command {
	var force bool

	c := &cobra.Command{
		Use:   use,
		Short: "Scaffold the rk-managed tmux.conf and tmux.d/ overrides under ~/.config/hexokit/",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := muxRejectInheritedServerFlag(cmd); err != nil {
				return err
			}
			dest := tmux.DefaultConfigPath
			if dest == "" {
				return fmt.Errorf("could not determine home directory")
			}
			userConf := filepath.Join(filepath.Dir(dest), "tmux.d", "user.conf")

			if !force {
				if _, err := os.Stat(dest); err == nil {
					return fmt.Errorf("%s already exists — put your overrides in %s (never overwritten), or use --force to refresh the managed file", dest, userConf)
				}
			}

			if err := tmux.ForceWriteConfig(); err != nil {
				return err
			}

			fmt.Fprintf(cmd.OutOrStdout(), "Wrote %s (rk-managed — do not edit)\n", dest)
			fmt.Fprintf(cmd.OutOrStdout(), "Overrides: %s (edit freely — never overwritten; numeric prefixes like 10-*.conf control ordering)\n", userConf)
			return nil
		},
	}
	c.Flags().BoolVar(&force, "force", false, "Overwrite the rk-managed tmux.conf; overrides in tmux.d/ are untouched")
	if deprecated {
		c.Hidden = true
		c.Deprecated = "use `rk mux init-conf` instead"
	}
	return c
}

var (
	// initConfFamilyCmd is the `rk mux init-conf` family member.
	initConfFamilyCmd = newInitConfCmd("init-conf", false)
	// initConfAliasCmd is the hidden deprecation alias kept at the root so the
	// old human-typed form keeps working while pointing at the new one.
	initConfAliasCmd = newInitConfCmd("init-conf", true)
)
