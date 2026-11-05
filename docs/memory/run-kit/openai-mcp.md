---
type: memory
description: "ChatGPT connector: openai_mcp.enabled/openai_mcp.tunnel_id settings, the 0600 runtime key under <state>/openai-mcp (POST /api/openai-mcp/key, never read back), the derived tunnel-client profile (file: key, startup_wait_timeout, loopback /mcp URL), checksum-verified managed install of openai/tunnel-client, the rk-openai-mcp sibling session (env-stripped spawn, daemon-gated ensure/restart), event: openai-mcp status states, Settings → General rows, palette verbs, rk openai-mcp install/start/restart, doctor row."
---
# ChatGPT Connector (OpenAI MCP)

**Domain**: run-kit

## Overview

One Settings switch puts the daemon's MCP tools in front of ChatGPT through OpenAI's Secure MCP Tunnel. The daemon installs and runs OpenAI's `tunnel-client` in the `rk-openai-mcp` sibling session; `tunnel-client` dials out to OpenAI and forwards ChatGPT's requests to `/mcp` over loopback. No inbound port opens. Design authority: `docs/specs/openai-mcp.md`. Packages: `internal/openaimcp` (files and install, no processes), `internal/daemon/openaimcp.go` (lifecycle and status), `api/openaimcp.go` (routes and settings side effects), `cmd/rk/openai_mcp.go` (CLI and doctor row), `app/frontend/src/components/settings-openai-mcp.tsx` and `lib/palette/openai-mcp.ts`.

## Requirements

### Requirement: settings and the key file
`openai_mcp.enabled` (bool, default false, category connectivity, live) and `openai_mcp.tunnel_id` (string, `^tunnel_[A-Za-z0-9]+$` via `openaimcp.ValidateTunnelID`, malformed values dropped on parse and rejected on apply) are registry keys. The enabled key's description states that every tool becomes reachable and that turning it on accepts that. The runtime API key is NOT a setting: `POST /api/openai-mcp/key` (`{"key":"sk-…"}`, validated `^sk-[A-Za-z0-9_-]{20,}$` before touching disk; `{"key":""}` deletes) writes `<state>/openai-mcp/api-key` (0600 file, 0700 dir, `fsatomic`). Responses carry only `keySet`.

#### Scenario: the key never comes back
- **GIVEN** a saved key
- **WHEN** any client reads `/api/settings`, the key route's response, or the `openai-mcp` event
- **THEN** none contains the key; only `keySet: true` is visible

### Requirement: the derived profile
`Layout.WriteProfile` renders `<state>/openai-mcp/profile/openai-mcp.yaml` (0600) on every ensure: `control_plane.api_key: "file:<state>/openai-mcp/api-key"`, `health.listen_addr: 127.0.0.1:0` + `url_file: <state>/openai-mcp/health.url`, `mcp.startup_wait_timeout: "60s"`, and `mcp.server_urls[main]` = `openaimcp.MCPURL(RK_HOST, port)` (unspecified binds map to `127.0.0.1`). Strings are `strconv.Quote`d. A contract test runs the real `tunnel-client doctor` over the rendered profile.

### Requirement: the sibling session
`ensureOpenAIMCPCore(cli)` skip order: disabled → unconfigured (no tunnel ID or key) → session exists → binary ladder (managed `bin/current/tunnel-client`, then PATH; none ⇒ daemon posture spawns the `openai-mcp-install` rk-jobs chain `rk openai-mcp install && rk openai-mcp start`, CLI posture errors) → write profile, remove stale `health.url`, spawn `tmux new-session -d -s rk-openai-mcp -n tunnel env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY <bin> run --profile-dir … --profile openai-mcp`. Daemon start calls `ensureOpenAIMCP()` after `ensureGUI()`. `EnsureOpenAIMCP` and `RestartOpenAIMCP` are daemon-gated; `ProbeOpenAIMCP` makes no tmux reads while off, unconfigured, or with no daemon session.

#### Scenario: an ambient key cannot override the saved one
- **GIVEN** the daemon was started from a shell exporting `OPENAI_API_KEY`
- **WHEN** the session spawns
- **THEN** `env -u` strips `CONTROL_PLANE_API_KEY` and `OPENAI_API_KEY`, so `tunnel-client` uses the profile's `file:` key (it otherwise prefers either env var)

### Requirement: postures and reconcile
`openAIMCPEnsureOptions{strict, installOnMissing, restartOnProfileChange}` with three presets: `openAIMCPDaemonStart` (log, install, restart on change), `openAIMCPFromDaemon` (settings/key POSTs and `RestartOpenAIMCP`: error, install, restart on change; exported as `EnsureOpenAIMCPFromDaemon`), `openAIMCPFromCLI` (`EnsureOpenAIMCP`, `rk openai-mcp start`: error, no install, never restarts a running session, because a manual shell may resolve another `RK_PORT`). `Layout.WriteProfile` reports `changed`. `ReconcileOpenAIMCP` kills a session the settings no longer allow; it runs at daemon start and from `WatchOpenAIMCPSettings` (started by `rk serve` beside the cron ticker; stats `settings.Stamp()` every `OpenAIMCPWatchInterval` = 5 s and reconciles on change). The hub is not the reconciler: it only polls while a browser is connected. `RestartOpenAIMCP` checks the daemon before any tmux.

#### Scenario: a dotfiles sync turns the connector off
- **GIVEN** a running connector
- **WHEN** `config.yaml` is rewritten with `openai_mcp.enabled` absent
- **THEN** within one watch interval `WatchOpenAIMCPSettings` sees the stamp change and `ReconcileOpenAIMCP` kills `rk-openai-mcp`, with or without a UI connected (measured live: 3.6 s); if the daemon was down at the time, daemon start reconciles before ensuring

### Requirement: status
`ProbeOpenAIMCP` → `classifyOpenAIMCP` precedence: `off`, `unconfigured` (detail names the missing piece), `stopped` (daemon down), `installing` (live install job window), `stopped` (no session; detail when the binary is missing), `starting` (no health URL or unreachable), `ready` (`/readyz` 200), `degraded` (detail = first line of the `/readyz` body). The hub carries it as the host-global `event: openai-mcp` (5 s TTL, change-only, replayed to late joiners); every POST calls `refreshOpenAIMCP` so the next tick re-probes.

## Design Decisions

### HTTP `/mcp` target, stateless transport
**Decision**: `tunnel-client` forwards to the daemon's `/mcp`, which serves stateless and 404s `/.well-known/*` (see [mcp](/run-kit/mcp.md), [api-and-sockets](/run-kit/api-and-sockets.md)).
**Why**: one MCP endpoint per host. ChatGPT speaks MCP `2026-07-28` (no initialize, no session), which a stateful go-sdk handler rejects; and an HTML 200 for OAuth discovery made `tunnel-client` retry forever without polling.
**Rejected**: stdio (`tunnel-client` spawning `rk mcp`), which worked unchanged but runs a second MCP server per host outside the daemon's view.

### Key in the state home, through its own route
**Decision**: a write-only route and a 0600 file referenced by `file:`.
**Why**: `config.yaml` may be dotfiles-managed (the VAPID precedent); `file:` keeps the key out of argv and env.
**Rejected**: an `env:`/`file:` reference typed into settings; a write-only registry kind.

### Doctor row always OK-shaped
**Decision**: the `openai-mcp` row never flips the verdict; the note carries the state.
**Why**: the `gui`/`code-server` posture: an opt-in integration that is not ready is a state, not a dependency failure.
