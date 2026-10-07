# HexoKit Constitution

## Core Principles

### I. Security First
All process execution MUST use `exec.CommandContext` with explicit argument slices — never shell strings or `exec.Command` without a context/timeout. Shell injection is a show-stopper. User-provided input (session names, window names, paths) SHALL be validated before passing to any subprocess. This mirrors AO's security posture and is non-negotiable.

### II. Disposable Daemon
The daemon MUST be killable at any instant — crash, restart, deploy — without losing anything a user or agent depends on, and a fresh daemon MUST rebuild its full working state from durable sources alone: tmux (sessions, windows, panes, `@rk_*` options), the filesystem (`.status.yaml`, `fab/current`, the state home under `$XDG_STATE_HOME/hexokit/`), git, and `gh`. Recoverability is the invariant; where state is *held* while the daemon runs is not.

The daemon MAY hold any state in memory for speed — indexes, caches, a working copy of the durable sources — under two rules:

1. **Durable before acknowledged.** State the daemon originates (a user action, a setting, a layout change) MUST reach a durable source before the request that produced it succeeds. Memory is never the only copy: no write-behind, no periodic flush.
2. **External writes win.** The durable sources are shared with other writers — fab-kit, agent hooks, `wt`, a user's own `tmux` commands. The in-memory copy MUST reconcile against them and yield on conflict; it SHALL NOT overwrite an external change with a stale value.

Ephemeral process state — open connections, subscriptions, in-flight requests — is exempt; it dies with the process by nature. HexoKit SHALL NOT introduce a database server, ORM, or migration system: durable state the daemon owns lives as plain files.

Two bounded disk carve-outs exist under `$XDG_STATE_HOME/hexokit/`: **recovery backups** (layout snapshots — artifacts about the past; a user-facing recovery reader MAY serve them read-only — listing restorable snapshots and their stored layouts, and driving user-initiated restore — but live state never derives from a backup: no live-state query is ever answered from one) and **startup seed caches**, which MAY pre-fill in-memory state at process start but are NEVER authoritative — a fresh read of the durable sources always overwrites a seeded value, and deleting any of these files changes nothing but cold-start latency. A corrupt or absent carve-out file MUST degrade to the same behavior as a cold start.

The line is drawn by *whose* state it is. Terminal session data and rk's own session state live in tmux and the filesystem. Integrations such as code-server keep their own state by their own means (code-server's extensions dir stays at its own default location). rk-managed assets — the VAPID keypair and push subscriptions, downloaded binaries (the managed code-server install, the Linux desktop install), and job logs — live in the state home under `$XDG_STATE_HOME/hexokit/` alongside the two carve-outs above (`vapid.json`, `push-subscriptions.json`, `code-server/{bin,profile}/`, `logs/`, `desktop/`). None of these is a source of truth for session state. The VAPID keypair sits in the state home, not the config home, because the config home is often dotfiles-managed and a private key there could leak into a repo.

### III. Wrap, Don't Reinvent
Existing fab-kit utilities (`wt-create`, `wt-list`, `wt-delete`, `idea`, `changeman.sh`, `statusman.sh`) MUST be used via wrapper functions in `internal/` (Go). HexoKit SHALL NOT reimplement worktree management, change management, or backlog management. When a fab-kit script does what you need, call it.

### IV. Minimal Surface Area
The UI MUST stay minimal — a small fixed route set (Host Overview `/`, tmux Server `/$server`, Terminal `/$server/$window`, Board `/board/$name`, plus the Not Found fallback), no settings pages, no admin panels — with exactly ONE carve-out: a single registry-driven settings surface (singular by design) backed by the `internal/settings` registry; no second settings surface may be added. Configuration is layered, and the override order is code default < config.yaml < env < CLI flag: deployment binding lives in environment variables (`RK_PORT`, `RK_HOST`, `RK_CODE_SERVER_PORT` — `.env` committed, `.env.local` for overrides — the bootstrap vehicle, and the ONLY keys with env forms); the daemon port is also a `config.yaml` key (`port`), so an install can pin it durably while `RK_PORT` still wins; per-instance preferences live in `~/.config/hexokit/config.yaml` behind the settings registry; per-entity state lives in `@rk_*` tmux options; per-viewer state lives in localStorage. New pages SHOULD only be added when an existing page genuinely cannot accommodate the functionality. Resist feature creep.

### V. Keyboard-First
Every user-facing action MUST be reachable via keyboard. Mouse interaction is supported but secondary. The command palette (`Cmd+K`) SHALL be the primary discovery mechanism for actions and the complete action registry: every user-facing action reachable via a keyboard shortcut or a UI control MUST also be registered in the command palette. This guarantees the fallback for chords a surface reserves (e.g. browser-reserved desktop chords) is always palette → action.

### VI. Tmux Sessions Survive Server Restarts
The tmux layer MUST be fully independent of the Go server. Agent sessions running in tmux windows SHALL NOT be affected by server restarts, crashes, or deployments. The supervisor manages only the web server process — never tmux.

### VII. Convention Over Configuration
HexoKit SHOULD derive values from conventions rather than requiring explicit configuration. Project IDs from directory names, session prefixes from project names, worktree paths from fab-kit defaults. The `config.yaml` settings file SHOULD require nothing; every key has a working default.

### VIII. Thin Justfile
Justfile recipes MUST be one-liners that delegate to `scripts/`. Logic, loops, and conditionals belong in shell scripts — the justfile is an index, not an implementation.

### IX. Uniform HTTP Verb
All mutating API endpoints MUST use `POST`. `PUT`, `PATCH`, and `DELETE` SHALL NOT be used — read operations are `GET`, everything else is `POST`. Fewer verb shapes means fewer ways for a client call to be wrong, and the operation's intent belongs in the URL path and request body, not the HTTP method. The CORS `AllowedMethods` allowlist MUST be `[GET, POST, OPTIONS]`. Endpoint semantics that would conventionally map to other verbs (e.g. partial updates) are expressed via the path and a documented body contract (e.g. partial-merge: present keys set, `null` unsets).

One documented exception:

**The MCP streamable-HTTP transport** binds `/mcp` — and only `/mcp` — to `POST` + `GET` + `DELETE` on a single path because the protocol mandates all three (`docs/specs/mcp.md` § Transports, `docs/specs/api.md` § MCP). The exception is transport-scoped, grants nothing to `/api/*`, and leaves the CORS allowlist at `[GET, POST, OPTIONS]`.

### X. Hooks Carry Only the Underivable
Agent-harness hooks (lifecycle telemetry pushed by hook commands into tmux or the filesystem) SHALL carry only state that cannot be derived from tmux, the filesystem, or git at request time — ephemeral in-flight facts such as busy/waiting lifecycle and the pending question text, which exist nowhere on disk. Anything derivable from a pane's cwd, git, `gh`, or fab artifacts (PR links, branches, worktrees, change identity, diff stats) MUST be derived server-side per Principle II — never pushed by an agent. When a fact is available both ways, derivation wins.

## Additional Constraints

### Test Integrity
Tests MUST conform to the implementation spec — never the other way around. When tests fail, the fix SHALL either (a) update the tests to match the spec, or (b) update the implementation to match the spec. Modifying implementation code solely to accommodate test fixtures or test infrastructure is prohibited. Specs are the source of truth; tests verify conformance to specs.

### Test Intent Comments
Every Playwright `test()` in `app/frontend/tests/e2e/*.spec.ts` and `app/desktop/tests/e2e/*.spec.ts` MUST carry a JSDoc block immediately above it stating (a) **Proves:** the user-visible behavior under test, in one or two sentences, and (b) **Steps:** a numbered list mirroring the test body, so a reviewer can reason about intent without reading Playwright APIs. Each spec file MUST open with a file-header comment covering shared setup — `beforeAll`/`beforeEach`, fixtures, viewport, `page.route` stubs, and any host-global state the file saves/restores. Intent comments state what the test proves and why the setup is shaped as it is; they SHALL NOT narrate history or cite change IDs / PR numbers (git history and `docs/memory/` own provenance). There are no companion `.spec.md` files: PRs that add or modify a `test()` SHALL update its intent comment in the same commit. Unit tests (`*.test.ts`/`*.test.tsx`, `*_test.go`) are exempt — their scope is narrow enough that the test name plus code is self-documenting.

### Process Execution
All `exec.CommandContext` calls MUST use a context with timeout (default 5-10 seconds for tmux operations, 30 seconds for build operations). Zombie processes from hung tmux commands MUST NOT block the server.

### PR Evidence
Every PR that changes user-visible behavior of the web UI — feature or bug fix — MUST carry a short screen recording of the change, produced with `just demo` against a throwaway rig (never a live `rk serve` instance or the user's tmux server) and attached to the PR body with `gh pr create --attach` / `gh pr edit --attach`, so it is uploaded as a GitHub attachment and never committed to the repository. The video reference MUST stand alone in its own paragraph so it renders as a player. Bug fixes MUST show before (the base branch) and after, where the bug is visible. Recordings MUST cover both the desktop and the mobile viewport unless the changed surface does not render on mobile. Changes with nothing visible to record (backend-only, CLI-only, docs, pure refactors) are exempt, but the PR body SHALL state `No recording: <reason>` rather than omit it silently. Desktop-shell changes are out of scope until `just demo` gains an Electron recording path; their PRs state `No recording: desktop shell recording not yet supported by just demo`.

### Self-Improvement Safety
The restart mechanism uses tmux-based kill-and-restart: `rk serve --restart` sends `C-c` to the daemon tmux pane, waits for graceful shutdown, then sends a fresh `rk serve` command. There is no supervisor loop, no `.restart-requested` signal file, and no automatic file-change watching. Rollback MUST be atomic (`git revert HEAD`).

### Toolkit Standards
This tool is part of the shll toolkit and MUST conform to the toolkit's published standards. The standards are enumerated by running `shll standards` — each entry names what it governs; read one with `shll standards <name>`. Before changing the CLI surface, help output, README.md, or docs/site/, the change MUST be checked against the standards governing that surface. If shll is unavailable, the canonical sources are the sahil87/shll repository's docs/site/standards/ tree (rendered on https://shll.ai). Standards added or revised there bind this repo without further amendment to this constitution.

## Governance

**Version**: 2.0.0 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-10-08
