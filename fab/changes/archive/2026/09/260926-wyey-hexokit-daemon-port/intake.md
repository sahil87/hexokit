# Intake: HexoKit Daemon Port

**Change**: 260926-wyey-hexokit-daemon-port
**Created**: 2026-09-26

## Origin

One-shot request from Sahil, HexoKit rebrand Phase 3, plan row **C5** in
`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` (the rules table — especially rule **P** — and
the C5 row are binding and are not to be re-opened). R0 (#950, `3d7afba1`) and C4 (#1053, `65407dc2`)
are both merged to main. User's words:

> Daemon default 3000 -> 6123 (+1/+2 kept: 6124 dev backend, 6125 code-server; code-server override
> semantics unchanged — explicit code-server port still means externally managed). Nothing forces
> existing users off 3000 (C4 just shipped the port pin, so existing installs stay on their pinned
> value). Update every place that states the default: README, hexokit.com install page (docs/site),
> serve help text, justfile comments, MCP allowed-origins docs, docs/specs/architecture.md, api.md,
> `rk url` prints the current one. Release notes: new installs land on :6123; existing installs keep
> their pinned port; how to move (config edit, restart, Tailscale Serve, bookmarks, MCP clients — rule
> P from the rules table). Doctor row nudges pinned-at-3000 installs toward 6123.
>
> Ships in the same release as R0+C4 (already merged). Full pipeline: /fab-new then /fab-fff.
>
> Also update the plan doc's C4 row (mark merged, link PR #1053) and Status line, since that
> bookkeeping is left for the next change.

Pre-intake survey in the conversation established that C4 already built the whole pin mechanism and a
dormant doctor row, so C5 is mostly the one-constant flip plus a present-tense sweep plus verification
tests.

## Why

1. **Problem**: 3000 is the most contended dev port on any machine (React/Next/Rails/Express
   defaults), so a fresh HexoKit daemon routinely collides with the user's own dev server — and the
   dev rig's Vite port collides with it too. Rule P picked **6123** (the 6 is the hexagon; only known
   tenant is Apache Flink's JobManager; not on any browser unsafe-port list) and folded the move into
   the rebrand so remote-access remapping happens at most once.
2. **If we don't**: every fresh install keeps landing on :3000 after the rebrand; the port move would
   need its own later disruption window, after C4's pin machinery has been documented as "dormant
   until C5" everywhere.
3. **Why this approach**: C4 already pins every existing install (real pin written into migrated
   config.yaml; virtual pin for unmigrated installs), so flipping the default is disruption-free for
   existing users. Moving is a documented config edit on the user's own schedule, nudged by
   `rk doctor`. Env vars are not renamed (D2 substrate).

## What Changes

### 1. The flip — `app/backend/internal/portpolicy/ports.env`

```sh
PORTPOLICY_DAEMON_DEFAULT=6123   # was 3000; dev backend = +1 (6124), code-server = +2 (6125)
PORTPOLICY_DAEMON_LEGACY=3000    # unchanged — the pin's source
```

Update the file's comments so they describe the present state (default is 6123; legacy 3000 is the
pin value for pre-rename installs). `PORTPOLICY_TUNNEL_START/END` stay 3100–3199 (C4 deferred the
tunnel move — do not touch). Rig 21000–21299 and sentinel 21999 untouched.

Everything Go-side that derives from `portpolicy.DaemonDefault` follows automatically: `config`
code-default rung (`internal/config/config.go` `daemonDefaultPort()`), `rk ports` output
(`cmd/rk/ports.go` — DefaultPort / +1 / +2), doctor `ports` row "(default)" label, code-server
fallback `port+2`. Verify no Go code hardcodes 3000 as the daemon default outside the policy file
(grep non-test `.go` for `3000`; the known hits are comments in `cmd/rk/origin.go:35`,
`cmd/rk/notify.go:58`, `cmd/rk/tab_wake.go:28`, `cmd/rk/url.go:26,39`, `internal/remote/ssh.go:182`,
`internal/homemigrate/homemigrate.go:234` (legacy — correct as is), `internal/settings/settings.go:461`
(legacy pin — correct as is), `api/windows.go:656` (a `/proxy/3000/` example of a user web tile —
leave)).

Code-server override semantics unchanged: an explicit `RK_CODE_SERVER_PORT` still means "externally
managed"; the default is `port+2` of the *effective* port (so a pinned-3000 install keeps 3002, a
fresh install gets 6125).

### 2. Existing installs are not moved — verify C4's mechanism with the real values

C4 shipped (read these before writing tests):

- `internal/homemigrate/homemigrate.go` `applyPortPin` appends `settings.PortPinComment` +
  `port: <portpolicy.DaemonLegacy>` to the staged config.yaml unless it already sets a port.
- `internal/config/config.go` `daemonDefaultPort()` returns `DaemonLegacy` when
  `!settings.ConfigRootOverridden() && apphome.UnmigratedExistingInstall()` (virtual pin — keeps the
  still-running old daemon's port before the migration writes the real pin), else `DaemonDefault`.
- `cmd/rk/doctor.go` `portPinCheck(pinned, def, legacy, envOverride)` — "port pin" row, OK-shaped
  with a Note, fires only when `pinned == legacy && def != legacy && !envOverride`. Dormant until now;
  wakes automatically once `DaemonDefault=6123`.

This change adds/updates tests proving, with the real embedded policy (6123 vs 3000):

| Scenario | Expected effective port | Doctor "port pin" row |
|----------|-------------------------|-----------------------|
| Fresh install (no legacy dirs, no config `port`) | 6123 (code-server 6125) | absent |
| Unmigrated existing install (legacy `~/.config/run-kit` or legacy state dir, no new home) | 3000 via virtual pin | n/a (config not yet migrated) |
| Migrated install with `port: 3000` + pin comment | 3000 | present, OK-shaped, Note names :6123 and the move steps |
| Migrated install with `port: 3000`, `RK_PORT` set | RK_PORT | absent |
| Config `port: 6123` (already moved) or any other non-3000 port | that port | absent |
| `RK_CONFIG_DIR` test override set | 6123 (override suppresses virtual pin) | per config |

Existing C4 table tests that inject both constants stay; add at least one test that runs against the
real `portpolicy.DaemonDefault`/`DaemonLegacy` values and asserts `DaemonDefault == 6123`,
`DaemonLegacy == 3000` (portpolicy_test) so a regression in the policy file is caught.

**Nudge wording review** (current Note in `portPinCheck`):

```
pinned at :%d (kept through the HexoKit rename); new installs default to :%d — to move: set port: %d
in ~/.config/hexokit/config.yaml, rk daemon restart, then re-point Tailscale Serve, bookmarks/phone
shortcuts, and MCP clients at :%d/mcp
```

It already covers rule P's five steps (config edit, restart, Tailscale Serve, bookmarks/phone
shortcuts, MCP clients at `…:6123/mcp`). Keep it unless review finds a real gap; `settings.PortPinComment`
("…see rk doctor") stays as is.

Update tests that hardcode 3000 *as the default* (e.g. `config_test`, `settings/registry_test`,
`cmd/rk/ports_test`, `doctor_test` default-label cases, `serve_warn_test`, `origin_test`) to read
`portpolicy.DaemonDefault` or assert 6123. Tests that use 3000 as an arbitrary sample port (MCP origin
tests `http://box:3000`, tmux/webtabs `/proxy/3000/`, validate, present, remote, frontend URL fixtures)
**stay unchanged** — do not churn fixtures that are not about the default.

### 3. Sweep every present-tense place that states the default (D11: no history rewrites)

Backend CLI surfaces:
- `app/backend/cmd/rk/serve.go:225–231` help: `RK_PORT  Port to bind (default 3000)`, the
  "Port resolution (lowest to highest): default 3000 < 'port:' in …" line, and the
  `run-kit serve   # foreground on 127.0.0.1:3000` example → 6123. Prefer formatting the help from
  `portpolicy.DaemonDefault` (and `run-kit` → `rk` in examples only if the surrounding help already
  uses `rk`; don't widen scope) over a second literal.
- `app/backend/cmd/rk/url.go:26,39` — `rk url` is config-derived (prints the resolved origin; confirm
  it is not hardcoded); fix the help/comment that says "(127.0.0.1:3000)" → reference the current
  default (6123) or, better, derive from `portpolicy.DaemonDefault` in the help string.
- `app/backend/cmd/rk/skill/skill.md:40` — "default `http://127.0.0.1:3000`" → 6123 (this is the
  embedded `rk skill` text).
- Comments in `cmd/rk/origin.go:35`, `cmd/rk/notify.go:58`, `cmd/rk/tab_wake.go:28`,
  `internal/remote/ssh.go:182` naming the 127.0.0.1:3000 default → 6123 (or "the portpolicy default").

Docs:
- `README.md`, `docs/site/install.md` (the hexokit.com install page source), `docs/site/skill.md` —
  every present-tense statement of the default URL/port → 6123; where the install page explains
  remote access / Tailscale Serve, show 6123. Add one short note to install.md: installs that existed
  before the rename stay on their pinned port (see `rk doctor`).
- `docs/specs/architecture.md`, `docs/specs/api.md` (incl. MCP allowed-origins text and any
  `http://127.0.0.1:3000/mcp` example), `docs/specs/project-plan.md` only where present-tense.
- MCP allowed-origins docs: wherever the MCP client config / origin allowlist is documented with
  `:3000/mcp` (README/api.md/mcp docs), show `:6123/mcp`.

Dev tooling (the dev rig default follows the daemon default: 6123 Vite, 6124 Go backend, 6125
code-server):
- `justfile:35–43` — `${RK_PORT:-3000}` fallbacks and "default 3000/3001" comments. Prefer sourcing
  `app/backend/internal/portpolicy/ports.env` (it is bash-sourceable; P1 made it the one source of
  truth, `scripts/e2e-env.sh` already sources it) so the justfile carries no second literal — if that
  is awkward inside just recipes, a literal 6123 with a comment pointing at ports.env is acceptable.
- `app/frontend/vite.config.ts:42–92` — seven `parseInt(process.env.RK_PORT ?? "3000") + 1` proxy
  targets → collapse to one computed constant and use the new default (6123). Reading ports.env from
  vite.config is optional; a literal with a pointer comment is fine.
- `scripts/perf-idle-cpu.sh:25`, `scripts/perf-idle-cpu.mjs:28` `DEFAULT_URL` → `http://127.0.0.1:6123`.
- `scripts/gui-perf-link.sh:6`, `scripts/e2e-env.sh:16`, `scripts/dev-desktop.sh:4`,
  `app/desktop/src/main.ts:51` comments naming `:3000` as the live daemon / dev override → 6123.
- `.env` comments mention `RK_PORT+2` only — check, likely no change.

UI example placeholders — judge each by what it illustrates:
- Flip to 6123 (they illustrate an rk daemon/host URL): `app/frontend/src/components/host-form-dialog.tsx:28`
  `e.g. http://host:3000`, `app/desktop/src/hosts.ts:70`, `app/desktop/src/welcome/welcome.ts:805`,
  `app/desktop/src/welcome/welcome.html:363` placeholder `http://100.101.2.3:3000`,
  `app/desktop/src/welcome/welcome.ts:343` doc comment. Update the matching unit tests that assert these
  strings.
- **Leave**: `app/frontend/src/components/iframe-window.tsx:1241,1453,1457` (`localhost:3000`,
  `rk present :3000` — these illustrate a user's arbitrary dev server in a web tile, not the daemon),
  `app/frontend/public/tutorial/tutorial.html` only if it illustrates a user dev server (judge).
- **Untouched**: every millisecond `3000` (WAKE_PROBE_TIMEOUT_MS, FONT_LOAD_TIMEOUT_MS,
  LOCAL_STATUS_POLL_MS, setStatusBarMessage durations, push timeout, etc.).

Out of scope: `docs/memory/` narrative (hydrate updates present-truth lines only), `fab/changes/archive`,
`docs/wiki/*.html` studies, `docs/findings/*` (historical), remote tunnel range.

### 4. Release notes

GitHub release notes are auto-generated from PR titles (`release.yml` `generate_release_notes: true`),
and the release itself is cut in **R1** (carries R0 + C4 + C5). So:

- The PR body carries an **Upgrade notes** section.
- The plan doc gains a **Release-notes draft** (under the C5 row or a short section before R1) that R1
  pastes into the release. Content:

> **Daemon port: new installs use :6123.** Fresh installs now listen on `127.0.0.1:6123` (dev backend
> 6124, code-server 6125). **Existing installs keep their port** — the one-time home migration pinned
> `port: 3000` in `~/.config/hexokit/config.yaml`, so Tailscale Serve mappings, bookmarks, phone
> shortcuts and MCP clients keep working. `rk doctor` shows a `port pin` row while you're pinned.
> **To move** (optional, any time): set `port: 6123` in `~/.config/hexokit/config.yaml`, run
> `rk daemon restart`, re-point Tailscale Serve at 6123, and update bookmarks / phone shortcuts / MCP
> clients (`http://<host>:6123/mcp`). `RK_PORT` still overrides everything.

### 5. Plan-doc bookkeeping — `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`

- **C4 row** → `**merged** 2026-09-26 (\`65407dc2\`)` with PR column
  `[run-kit#1053](https://github.com/sahil87/run-kit/pull/1053)`; keep the tunnel-deferral and
  remotes.yaml follow-up notes; "doctor nudge dormant until C5" becomes "wakes with C5".
- **C5 row** → `**in progress** — fab change \`260926-wyey-hexokit-daemon-port\``, PR link filled at
  ship.
- **Status line** (2026-09-26): R0 merged, C4 merged (#1053), C5 in progress, R1 next.
- **"Where we are" paragraph**: on-disk homes are done (C4); still on the old name: the daemon port
  default (C5, in progress) and the GitHub repo (R2) / formula (R1).
- **Order line**: strike C4 (`~~C4~~`).
- **Risks "Silent state loss (C4)"**: leave (already present-tense shipped mitigation).

## Affected Memory

- `run-kit/configuration`: (modify) daemon default 6123 (legacy 3000 pin value), doctor `port pin` row
  now live; ports.env values; code-server default = effective port + 2
- `run-kit/daemon-lifecycle`: (modify) present-truth lines that state the default port / origin
- `run-kit/architecture/cli`: (modify) `serve` help / `rk url` / `rk ports` default values
- `run-kit/mcp`: (modify) only present-tense lines stating the default `…:3000/mcp` mount (leave
  scenario fixtures using 3000 as sample values)

## Impact

- Go: `internal/portpolicy` (policy file + tests), `cmd/rk` (serve/url help, doctor tests, ports
  tests, comments), `internal/config` tests, `internal/settings` tests, `internal/homemigrate` tests.
- Frontend: `vite.config.ts`, `host-form-dialog.tsx` (+ test).
- Desktop: `hosts.ts`, `welcome/*`, `main.ts` comment (+ tests).
- Scripts/justfile: dev rig default now 6123/6124/6125.
- Docs: README, docs/site/{install,skill}.md, docs/specs/{architecture,api,project-plan}.md,
  embedded `cmd/rk/skill/skill.md`.
- e2e: rigs use 21000+ ports from the policy, so no e2e port changes expected; `host-system-card.spec`,
  `web-tabs.spec`, `present-viewer.spec` etc. use 3000 as sample user ports — leave unless they assert
  the daemon default.
- Local e2e hygiene: after any local e2e run, check `head -1 ~/.config/run-kit/tmux.conf` and
  `~/.config/hexokit/tmux.conf` for rig leaks; restore with brew `rk mux init-conf --force`.
- Gates: `just _ensure-tmux-conf` then `env -u TMUX -u TMUX_PANE go test ./...` in app/backend;
  `pnpm install --frozen-lockfile` in app/frontend then `just test-frontend`; desktop unit tests for
  touched desktop files; relevant single e2e specs only (`<name>.spec`, check with `--list`).

## Open Questions

- None blocking. Whether the justfile/vite.config source ports.env or carry a pointer-commented
  literal is an apply-time call (either satisfies "one source of truth" in spirit).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Daemon default 6123, +1/+2 → 6124/6125; `PORTPOLICY_DAEMON_LEGACY` stays 3000 | Rule P + user's explicit values | S:95 R:80 A:95 D:95 |
| 2 | Certain | No env var renamed; `RK_PORT`/`RK_CODE_SERVER_PORT` semantics unchanged, explicit code-server port still means externally managed | D2 + user statement | S:90 R:85 A:95 D:95 |
| 3 | Certain | Existing installs are not moved — rely on C4's real + virtual pin; C5 only verifies with tests | User: "C4 just shipped the port pin"; code survey confirmed the mechanism | S:90 R:80 A:90 D:90 |
| 4 | Confident | Doctor nudge = C4's dormant `portPinCheck` row, which wakes automatically; keep its wording (already names all five rule-P steps) unless review finds a gap | Code survey; wording matches rule P | S:80 R:90 A:85 D:80 |
| 5 | Confident | Dev rig default follows the daemon default (6123/6124/6125) in justfile + vite.config | Plan lists justfile comments; P1 made ports.env the single source; keeping dev == daemon default preserves current convention | S:65 R:85 A:70 D:70 |
| 6 | Confident | Leave sample-port `3000` fixtures and web-tile `localhost:3000` examples (they illustrate a user dev server); flip host-URL placeholders to 6123 | They're not statements of the daemon default; minimizes churn | S:70 R:90 A:75 D:70 |
| 7 | Confident | Release notes live in the PR body "Upgrade notes" + a draft in the plan doc for R1 to paste, since GitHub notes are auto-generated and R1 cuts the release | release.yml uses generate_release_notes; R1 row says it cuts the release | S:70 R:90 A:80 D:70 |
| 8 | Certain | Plan doc: C4 row merged + #1053 + `65407dc2`, C5 in progress, Status/Where-we-are/Order updated | User's explicit instruction | S:95 R:95 A:95 D:95 |
| 9 | Certain | Remote tunnel range 3100–3199 untouched | C4 deferred it; recorded in ports.env | S:85 R:85 A:95 D:95 |
| 10 | Confident | History not rewritten (D11): no edits to fab archive, docs/wiki studies, docs/findings; memory updated only in present-truth lines at hydrate | D11 rule | S:80 R:90 A:90 D:85 |

10 assumptions (5 certain, 5 confident, 0 tentative, 0 unresolved).
