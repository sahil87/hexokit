# `rk riff` — spawn agent workspaces

`rk riff` creates a git worktree, opens a new tmux window inside it, and launches one or more Claude Code panes — all in a single command. It's the primary way to start agent work in HexoKit.

A "riff" is one disposable workspace: one branch, one worktree, one tmux window, one or more agent panes. Tear it down by closing the window and deleting the worktree (`wt delete`).

## Prerequisites

- You must be running inside a tmux session (`$TMUX` set).
- [`wt`](https://github.com/sahil87/wt) must be on your `PATH`.
- The launcher (`claude --dangerously-skip-permissions` by default) must be available.

In a fab-kit project, the launcher is resolved per-project through `fab agent` — the `providers` and `agent` tables in `fab/project/config.yaml` — so it can point at any agent CLI, or any command at all. Without fab-kit (or on any resolution failure), riff falls back to the default launcher.

## Quick start

```bash
rk riff                                   # 1 pane, default skill (/fab-discuss)
rk riff --skill /review                   # 1 pane, specific slash-command
rk riff --skill /fab-fff --cmd "just dev" # 2 panes (agent + dev server)
```

Open the resulting window in the browser to drive it from the HexoKit UI, or stay in tmux — both work, since the agent is just a tmux pane.

## Pane array model

`--skill` and `--cmd` are repeatable. Argv order (left to right) becomes pane order (pane 0, pane 1, …). The flags can be interleaved:

```bash
rk riff --skill /a --cmd htop --skill /b --cmd "tail -f log"
# pane 0: claude /a   pane 1: htop   pane 2: claude /b   pane 3: tail
```

- **Bare `--skill`** (no value) launches a blank Claude session.
- **Bare `--cmd`** drops into `$SHELL` (fallback `/bin/sh`).

## Layouts

`--layout` controls pane arrangement. Default is `auto` (1 pane = none, 2 = even-horizontal, 3+ = tiled).

| Name | Shortform | Shape |
|------|-----------|-------|
| `auto` | `a` | pane-count-based default |
| `tiled` | `t` | grid |
| `even-horizontal` | `h` | side-by-side |
| `even-vertical` | `v` | stacked |
| `main-horizontal` | `deck-h` | main on top, deck below |
| `main-vertical` | `deck-v` | main on left, deck on right |

```bash
rk riff --skill /a --cmd x --cmd y --layout main-vertical
```

## Presets

Three built-in presets ship with the binary: `discuss` (→ `/fab-discuss`), `incognito` (→ `/fab-incognito`), and `blank` (a bare agent, nothing typed into it). Add your own — or override a built-in's skill — under `riff_presets` in `~/.config/hexokit/config.yaml`:

```yaml
riff_presets:
  review: "/code-review high"   # an addition: rk riff review
  blank: "/fab-discuss"         # an override of the built-in
```

Each preset is exactly one skill pane (`""` = a bare agent).

Invoke by name (positional or via `--preset`):

```bash
rk riff incognito           # positional preset name
rk riff --preset blank      # explicit form
rk riff --list-presets      # list the merged presets (built-ins + user)
```

CLI `--skill` / `--cmd` flags **replace** the preset's pane entirely.

## Parallel spawning with `--count`

`-N <N>` (or `--count <N>`) creates N worktree/window pairs in parallel, each with the same pane shape:

```bash
rk riff discuss --count 3   # 3 parallel discuss workspaces
rk riff -N 5 --skill /fab-fff
```

Worktree names come from `wt`'s adjective-noun generator (e.g. `swift-fox`, `zippy-yak`). On any failure, successful worktrees and windows are rolled back before exit.

## Passing flags to `wt`

Anything after `--` is forwarded verbatim to `wt create`. Useful for:

```bash
rk riff -- --worktree-name pacing-canyon   # name the worktree
rk riff -- --base main                     # branch off main
rk riff -- --reuse                         # reuse an existing branch
```

Run `wt create --help` for the full passthrough flag list.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | precondition failure (`$TMUX` unset, `wt` not found) |
| 2 | validation/usage error (unknown layout, invalid `--count`, unknown/conflicting preset, bad flag) |
| 3 | subprocess failure (`wt` or `tmux` non-zero, parse failure, timeout) |

## Common patterns

```bash
# Solo planning session
rk riff --skill /fab-discuss

# Implement + watch dev server + watch tests
rk riff --skill /fab-fff --cmd "just dev" --cmd "just test-watch" --layout main-vertical

# Three parallel attempts at the same change
rk riff discuss --count 3

# Investigate a bug with a shell pane handy
rk riff --skill /fab-discuss --cmd

# Branch off a specific base
rk riff --skill /fab-fff -- --base release/v2
```
