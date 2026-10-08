# CLI Layering — Two Tools, Two Layers

> Decided 2026-08-15 (discussion session; alongside intake 260815-a5vf `rk send`/`rk await`).
> HexoKit (`rk`) and fab-kit (`fab`) are the **only two CLIs**. A third "tmux management"
> binary was considered and rejected: the substrate verbs are only valuable with rk's
> conventions present (`@rk_pane_agent_state`, hooks, reconcilers), a third binary would add a
> third axis of version skew and distribution overhead, and the hexokit rename already
> broadens rk's identity beyond the web dashboard.

## The model

| Layer | Tool | Owns |
|-------|------|------|
| **Substrate** | `rk` | tmux conventions (the `@rk_*` option registry), agent instrumentation (`agent setup`/`agent hook`, the `@rk_pane_agent_state` lifecycle), pane interaction verbs (`mux send`/`mux await`; future `capture`/`kill`/`process`), server hygiene (guard shim, reaper, layout snapshots, tmux.conf scaffold) — with the daemon, web UI, and desktop shell as consumers of this layer, not its definition. The MCP proxy (`rk mcp`, the daemon's `/mcp` route — [mcp.md](mcp.md)) is one more consumer: a mechanical, allowlisted door onto the same verbs, never a second contract |
| **Choreography** | `fab` | changes, stages, dispatch records, provider/profile resolution, confidence scoring, memory indexes, PR metadata — everything keyed to a change or a pipeline stage |

## Delegation rules

1. **Each tool delegates to the other for facts the other layer owns; neither reimplements the other's layer.** Both directions exist and both are correct: fab consumes substrate facts from rk (agent state, gated sends), rk consumes choreography facts from fab (`fab agent --print` for launcher resolution in riff, `fab pane map` for the change/stage join in sessions).
2. **fab → rk delegation is capability-probed and fail-open**: `command -v rk` gates every use; absence degrades to raw tmux / fab's internal builders, never to an error. fab-kit remains installable without rk; its skills carry the degraded path.
3. **Machine-invoked entry points are contracts**: commands baked into installed artifacts (hook lines in agent settings, the guard PATH shim, shell rc sourcing) keep their invocation names working permanently — renames ship with hidden aliases, and installers write the new form going forward.
4. **What fab may assume of rk when present**: the `@rk_pane_agent_state` schema per [agent-state.md](agent-state.md); the `rk mux send`/`rk mux await` contracts (gate matrix, probe-verified delivery, report words) once 260815-a5vf ships; `rk notify`'s fail-silent contract.

## rk command surface — grouping plan

Root noise is reduced by two mechanisms: **families** (for human-facing verbs, mirroring `fab config`/`fab pane`) and **hiding** (for machine-invoked plumbing — zero migration cost). Only obvious groupings; flagship conversation verbs stay flat.

### The `rk mux` family (tmux substrate)

| Member | From | Cost |
|--------|------|------|
| `rk mux send` | new (260815-a5vf) | free — lands here directly, nothing shipped |
| `rk mux await` | new (260815-a5vf) | free |
| `rk mux inventory` | new live fleet query | all live servers by default; `-L` scopes one; substrate session/pane facts only |
| `rk mux reap` | `rk reaper` | rename + deprecation alias |
| `rk mux snapshot list\|show\|restore` | `rk snapshot …` | move + deprecation alias (3-level depth has `fab pane window-name` precedent) |
| `rk mux guard` | `rk tmux-guard` | move + **permanent hidden root alias** (installed PATH shims exec the literal name; `rk agent setup` writes the new form going forward) |
| `rk mux init-conf` | `rk init-conf` | move + deprecation alias (it scaffolds tmux.conf/tmux.d — a mux concern) |
| *(future)* `rk mux capture`, `rk mux kill`, `rk mux process`, `rk mux panes` | fab pane migration sweep | after a5vf proves the pattern |

**Why `mux`, not `pane` or `tmux`**: `pane` is too narrow for the server-level members (reap, snapshot, guard); `tmux` reads as if it runs tmux itself and collides with the guard fronting the real binary; `mux` is short, distinctive, and umbrella-wide.

### The `rk agent` family (instrumentation)

| Member | From | Cost |
|--------|------|------|
| `rk agent setup` | `rk agent-setup` | rename + deprecation alias (human-typed) |
| `rk agent hook` | `rk agent-hook` | move + **permanent hidden root alias** (installed settings hooks carry the literal command line; setup writes the new form going forward) |

`role` stays at root — it marks the operator window, an operator-workflow verb, not instrumentation.

### New families for API-only capabilities

Rule: **a capability that exists only as a daemon route gets a CLI verb before it gets
any other door** ([mcp.md](mcp.md) Principle 1) — the verb is the contract, the route is
its implementation. Two families exist for exactly this reason; both are thin wrappers
over the daemon via the CLI's existing origin-resolution pattern (the `notify` /
`present` / `tab wake` door).

| Member | Wraps | Shape |
|--------|-------|-------|
| `rk operator request <template> [--window @N] [--text] [--session] [--list] [--json]` | `POST /api/windows/{windowId}/operator-request`, `POST /api/operator-request` | Subcommand of the existing `operator` verb; `--list` prints the closed template registry; busy ⇒ `queued:true` in the receipt for templates without `chatDelivery` (`user-message` skips the busy gate and queue by design) — a door onto the existing request lane, not a new one |
| `rk board show [name] [--json]` · `pin <name> <@N>` · `unpin <name> <@N>` · `reorder <name> <@N> [--before] [--after]` | `GET /api/boards[/{name}]`, `POST /api/boards/{name}/pin\|unpin\|reorder` | New flat root family (like `tab`, sharing its `@N` grammar); `-L` fills the routes' `server` field |

### Hidden plumbing (visible today, machine-invoked)

`shell-init` (sourced from shell rc) becomes hidden; `help-dump` already is. The permanent aliases above (`agent-hook`, `tmux-guard`) are hidden. `skill` stays visible — agents discover it by name and the toolkit skill standard governs it.

### Stays flat (deliberately)

- **Conversation verbs**: `present`, `notify`, `riff` — flagship, established, typed constantly.
- **Lifecycle core**: `serve` (default), `daemon` (already a family), `url`, `status`, `doctor`, `update`.
- **Client families**: `desktop`, `code-server`, `remote` — already families; no super-family.
- **`mcp`**: the stdio MCP server — a transport verb typed into connector configs (`ssh <box> rk mcp`), not by humans; kept visible so the connector command is documentable and discoverable ([mcp.md](mcp.md) § Transports).
- **`board`**: a new flat family (see § New families for API-only capabilities) — flat like `tab`, whose `@N` grammar it shares.

Net effect at `rk -h`: ~23 visible root commands → ~15 after the grouping plan, ~17 once `mcp` and `board` land.

**Conformance**: every surface change above must pass the shll toolkit standards check (`shll standards` — help-dump, ten principles, skill topic pages) before landing.

## fab command surface — the split

| fab family | Layer | Disposition |
|------------|-------|-------------|
| `pane send`, `pane await` | substrate | superseded by `rk mux send`/`await` (260815-a5vf); operator + helper guidance migrate, then delete (fab-kit follow-up change) |
| `pane ready`, `pane deliver`, `pane capture`, `pane kill`, `pane process` | substrate mechanics | rk grows canonical twins over time; fab's copies become dispatch-internal (pane arm must work rk-less), dropped from skill-facing guidance |
| `pane open` | choreography | stays — provider/profile resolution from fab config |
| `pane map` | hybrid | long-term: rk owns enumeration (`rk mux panes`), fab enriches with change/stage; today rk's server consumes `fab pane map` for the join |
| `pane window-name` | mechanics generic, convention fab's | stays until the marker convention itself moves (rk's native channel is `@rk_win_flair` + status pyramid) |
| `change`, `status`, `dispatch`, `score`, `resolve`, `resolve-agent`, `preflight`, `log`, `memory-index`, `impact`, `pr-meta`, `batch`, `operator`, `agent`, `config`, workspace commands (`init`, `sync`, `setup`, `upgrade-repo`, `update`, `doctor`), `kit-path`, `skill`, `shell-init` | choreography / fab-internal | stay in fab |

## Execution plan

Each part is **one fab change**, sized for a single pipeline run, and names its repo — the
operator coordinates across both repos on one tmux server. Parts marked *(released)* gate on
the dependency being **shipped in a release** (brew-installable), not merely merged: the
consuming repo's agents run the installed binary. Every HexoKit part that touches the CLI
surface intrinsically includes the standards audit (`shll standards`), the help-dump test,
and `rk skill` topic-page updates — not listed per-row.

| # | Part | Repo | Delivers | Depends on |
|---|------|------|----------|------------|
| 1 | `mux` family + send/await | run-kit | `rk mux` parent (shared `-L`), `rk mux send`, `rk mux await` — **merged as 260815-a5vf (PR #617)** | — |
| 2 | `agent` family | run-kit | **in flight as 260815-r2wp-agent-family** (apply + review done) — `rk agent setup`/`rk agent hook`; `agent-hook` stays as permanent hidden alias (installed hook lines); setup writes the new form | — (parallel-safe with 1; overlaps on `root.go` + help-dump test — sequence or rebase) |
| 3 | `mux` consolidation, low-risk | run-kit | `mux reap` (← `reaper`), `mux snapshot` (← `snapshot`), `mux init-conf` (← `init-conf`), deprecation aliases; hide `shell-init` | 1 |
| 4 | guard move | run-kit | `mux guard` (← `tmux-guard`) with permanent hidden root alias; `rk agent setup` regenerates shims to the new form; doctor states updated | 1 (light overlap with 2 in `agent setup`) |
| 5 | `fab pane send`/`await` retirement | fab-kit | `fab-operator` + `_cli-agents`/`_cli-external` migrate to `rk mux send`/`await` with a raw-tmux fallback when rk is absent; delete the two CLI verbs (internal builders stay — dispatch delivery uses them) | 1 *(released)* |
| 6 | substrate twins | run-kit | `rk mux capture`, `rk mux kill`, `rk mux process` — mechanics ported/twinned from fab pane, agent-state-aware where applicable | 1 |
| 7 | guidance re-point | fab-kit | `_cli-external`/`_cli-agents` point capture/kill/process at rk; fab's pane copies demoted to dispatch-internal (kept for rk-less pane arm), dropped from skill-facing guidance | 5, 6 *(released)* |
| 8 | pane-map split | run-kit + fab-kit | `rk mux panes` (native enumeration + agent state); rk's server drops the cached `fab pane map` join in `sessions.go` (kills the StatusDot 5s-lag class); fab enriches enumeration with change/stage | 6 |

Sequencing summary: **1 → {3, 4, 6} in any order; 2 anytime; 5 after 1 releases; 7 after 5+6 release; 8 last.**
Parts not yet drafted enter the pipeline via `/fab-draft` (queue without activating) or the
backlog, whichever the operator is driving from.

## Non-goals

- No third binary, ever, for this layer split.
- No big-bang rename of shipped rk commands — every move ships with its alias per rule 3.
- No rk reimplementation of provider/profile resolution (that is fab's; riff keeps delegating).
- No MCP tool that is not an `rk` verb; the MCP server is a consumer of this layer, not a third layer ([mcp.md](mcp.md)).
