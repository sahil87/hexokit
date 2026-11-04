# Customizing tmux

HexoKit owns its default tmux configuration as a **managed file**: `~/.config/hexokit/tmux.conf`. rk writes it, stamps it, and refreshes it — you never edit it. Your customizations live next door in `~/.config/hexokit/tmux.d/`, which the managed file sources at the end (`source-file -q ~/.config/hexokit/tmux.d/*.conf`), so your settings always win.

## The managed header

Every rk-written `tmux.conf` starts with a hash-stamped first line:

```
# rk-managed sha256:<hex> — DO NOT EDIT; overrides go in ~/.config/hexokit/tmux.d/
```

The stamp is the SHA-256 of everything below the header. It lets rk tell, deterministically and offline, whether you edited the file:

| State | What happens |
|-------|--------------|
| **Missing** | rk writes the embedded default (stamped) |
| **Managed, current** | Nothing — the file is already up to date |
| **Managed, stale** | rk force-writes the new default on next daemon start and reloads every live tmux server |
| **Hand-edited** | rk never touches it — see the migration recipe below |

## `tmux.d/user.conf` — your override home

`~/.config/hexokit/tmux.d/user.conf` is the conventional place for your settings. Every scaffold path (`rk mux init-conf`, daemon start, the API) creates it as a commented starter when absent, and **never overwrites it** — including under `--force`.

Sibling drop-ins in `tmux.d/` are sourced in lexicographic order, so use numeric prefixes (`10-*.conf`, `20-*.conf`) when ordering matters.

## Refresh behavior

The managed file refreshes at **daemon start only** (no timer, no watcher): a stale managed file is rewritten and every live tmux server is reloaded. Caveat: `history-limit`-class options apply only to panes **created after** the reload — existing panes keep their old values.

## Hand-edited the managed file? The migration recipe

rk never clobbers and never auto-migrates a hand-edited managed file. To get back onto the managed track:

1. Move your customizations into `~/.config/hexokit/tmux.d/user.conf`.
2. Run `rk mux init-conf --force` to restore the managed file (your `tmux.d/` overrides are untouched).

`rk doctor` reports the drift state in its `tmux config` row and prints this recipe.

## Opting out entirely

Set the `tmux_conf` key in `~/.config/hexokit/config.yaml` (or the `RK_TMUX_CONF` env var) to point rk at your own tmux.conf. In that mode rk performs no ensure, refresh, or drift analysis on the file — you own everything.
