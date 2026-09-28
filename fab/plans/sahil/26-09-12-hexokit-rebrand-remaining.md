# HexoKit rebrand — remaining work (announce gate + Phase 3)

> Focus doc — split 2026-09-12 from the master plan
> [`26-09-10-hexokit-rebrand.md`](26-09-10-hexokit-rebrand.md), which keeps the
> full evidence, decision log (D1–D15), site shape, and the done history of
> Phases 0–2. **This file is the tracker for everything still open.** Update
> rows here; the master gets one line when a phase closes.

**Where we are**: hexokit.com is live and is the canonical site. shll.ai is a
permanent redirect host (meta-refresh + canonical to the mapped hexokit.com
page; `/install` and `/versions.json` are byte copies, verified). The product
README, docs, specs, and every companion README already say HexoKit. R0
renamed the app identity itself: the command is `hexokit` (with `xk`/`rk`
completions) and the desktop app is "HexoKit". The on-disk homes are done
(C4). The daemon port default (C5) and R1(a)/(b) (formula/release) are done.
R1(c) (the shll roster) is done in shll v0.1.34. Still on the old name: the
GitHub repo `sahil87/run-kit` (R2) and R1(d) (hexokit-site).

**Status (2026-09-28)**: **everything before Phase 3 is done except the
announce.** A1 (shll v0.1.33) and A2 done; P1, P2, P3 merged and shipped in
rk v3.20.20. A3 (announce hexokit.com) is Sahil's call. **Phase 3 in
progress**: R0 **merged** 2026-09-26 ([run-kit#950](https://github.com/sahil87/run-kit/pull/950),
`3d7afba1`); C4 **merged** 2026-09-26 ([run-kit#1053](https://github.com/sahil87/run-kit/pull/1053),
`65407dc2`); C5 **merged** ([run-kit#1054](https://github.com/sahil87/run-kit/pull/1054)); R1(a)/(b)
**merged**, release v3.20.22 cut ([run-kit#1055](https://github.com/sahil87/run-kit/pull/1055),
homebrew-tap PR#6); R1(c) **merged** 2026-09-28 after Sahil verified the
brew-upgrade gate ([shll#103](https://github.com/sahil87/shll/pull/103), `4def30d`),
released as [shll v0.1.34](https://github.com/sahil87/shll/releases/tag/v0.1.34);
R1(d), R2 and X3 not started. Decisions: repos stay under `sahil87`, R2 → `sahil87/hexokit` (D15);
binary `rk` + alias `xk` (D16); port config key (D17, now shipped).

## Rules that bind every row here (from the master decision log)

| # | Rule |
|---|------|
| D2 | **Binary stays `rk`.** `hexokit` replaces `run-kit` as the long command name; **`rk` stays the canonical short name** and **`xk` is added as a second alias** (D16). Docs, skills, help text, and examples use `rk` only; `xk` is mentioned once, as an alias. `hk` is rejected: homebrew-core ships `hk` (jdx's git-hook manager), so installing both is a `bin/hk` link conflict. Every `RK_*` env var, `@rk_*` tmux option, `rk-*` socket/session name, the Go module path `rk`, `rk-code-bridge` and its `rk.*` settings keys, and all `rk-*` CSS classes are **untouched**. If a change appears to need one renamed, stop and add a row |
| D8 | **Electron**: `productName` "Run Kit" → "HexoKit", `artifactName` → `hexokit-desktop-…`, **`appId` `ai.shll.run-kit` kept** so installed apps keep their identity. `rk desktop` stays the CLI verb |
| D9 | **On-disk homes migrate once, silently**: `~/.config/run-kit/` → `~/.config/hexokit/`, `$XDG_STATE_HOME/run-kit/` → `…/hexokit/`, `runkit-*` localStorage → `hexokit-*`. Read-old-then-write-new on first run, old left in place one release, then dropped |
| D11 | **History is not renamed.** `fab/` archives, `docs/memory/` narrative, git history, old PR titles keep "run-kit". Only present-tense live surfaces change |
| D14 | **Standards are not renamed.** `shll standards`, file names, the shll repo home all stay. Content already swept (C1, X4) |
| D15 | **Every repo stays under `sahil87`; the product repo becomes `sahil87/hexokit` at R2.** Fixed 2026-09-25 by Sahil — the `hexokit` GitHub handle is not available (the account is flagged by GitHub abuse review and hidden; rename/org path blocked, tickets pending), so nothing in this plan waits for it or targets it. If the org materialises later, moving repos into it is a separate, later piece of work: a GitHub transfer after a rename keeps the redirect chain, so `sahil87/run-kit` → `sahil87/hexokit` → `hexokit/hexokit` all resolve |
| P | **Ports fold into the rebrand — without moving anyone.** Daemon default 3000 → **6123** (the 6 is the hexagon; only known tenant is Apache Flink's JobManager; not on any browser unsafe-port list) with the +1/+2 arithmetic kept (6124 Go dev backend, 6125 code-server). Machine-only ports move to a 5-digit block humans never type: e2e rig triples 21000–21299, remote tunnels 21500–21599, Playwright sentinel 21999. GUI ports unchanged. **Existing installs are pinned, not moved**: P3 adds a `port` key to config.yaml (env still wins), then C4's config migration writes the current effective port into the migrated config.yaml, so nobody's Tailscale serve, bookmark, or phone shortcut breaks; a doctor row nudges toward 6123. **Env vars are not renamed** — `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` are substrate (D2) and stay the only keys with env forms (constitution IV). **Moving is a documented config edit**: set `port: 6123` in `~/.config/hexokit/config.yaml`, restart the daemon, re-point Tailscale Serve, update bookmarks / phone shortcuts / MCP clients at `…:3000/mcp` (D17) |

Roster coupling (why the order below is strict): shll's roster `Name` /
`Formula` / `Repo` are read at runtime by `shll install`, `doctor`, and
`check-updates`. Each field flips **with** its rename in the same sitting,
never ahead of it.

---

## Open rows

### Announce gate

| # | Repo | What | Depends on | Size | PR | Status |
|---|------|------|-----------|------|----|--------|
| A1 | shll | **Cut a shll release** so the embedded `shll standards` / `shll skill` text stops naming shll.ai (X4 merged as [shll#100](https://github.com/sahil87/shll/pull/100) at 17:36 UTC; latest tag v0.1.32 was cut at 05:26 UTC and predates it). Tag = or after commit `f04e3c2b` | — | XS | [shll v0.1.33](https://github.com/sahil87/shll/releases/tag/v0.1.33) | **done** — released 2026-09-25, 5 commits past the X4 merge; verified on the installed binary: zero `shll.ai` mentions across every `shll standards` page and `shll skill shll` |
| A2 | hexokit-site | Cosmetic: footer aligned with the content column | — | XS | [hexokit-site#7](https://github.com/sahil87/hexokit-site/pull/7) | **done** — merged 2026-09-13 |
| A3 | — | **Announce hexokit.com.** No code. After A1 (A2 optional) | A1 | — | — | not started |
| P1 | run-kit | **Machine-only ports + the ports policy.** New policy package holds the daemon default, rig block, tunnel block, sentinel — exposed as a new `rk ports` verb (no such verb exists today) so `scripts/e2e-env.sh`, `test-e2e.sh`, `playwright.config.ts` read the ranges instead of hardcoding; e2e rig triples 3400–3699 → 21000–21299, Playwright fail-closed sentinel 3333 → 21999 (collapse the literal, now in 12 files, into one helper); refuse or warn when the configured daemon port lands inside a reserved block; doctor row. **Name the package `internal/portpolicy`, not `internal/ports`** — `internal/ports` already exists as the listening-TCP-port collector. The remote tunnel range constants live in `internal/remote/ports.go` (`PortRangeStart`/`End`) and should read from the policy too, **keeping their 3100–3199 values** — only C4 may move them. Nothing persists rig ports, so this is disruption-free and independent of the rebrand | — | [run-kit#1050](https://github.com/sahil87/run-kit/pull/1050) | **merged** 2026-09-25, in v3.20.20 (fab change `40fa`) — one committed policy file `internal/portpolicy/ports.env` (Go embed + shell source): daemon default 3000, rig 21000–21299, tunnel **3100–3199 kept**, sentinel 21999; `rk ports` verb; `3333` literal gone from all 12 files |
| P2 | run-kit | **Host default fix.** Committed `.env` sets `RK_HOST=0.0.0.0` while the Go default is 127.0.0.1, and `just setup` copies it to `.env.local`, so every dev rig exposes the unauthenticated relay and the open `/proxy` route on all interfaces. Make the committed default `127.0.0.1` with `0.0.0.0` as a commented LAN/phone-testing example. Also reconcile portless loopback URLs: Go `present.go` proxies `http://localhost/x` as port 80 while the frontend `web-url.ts` classifies it external. Security fix — do not wait for anything | — | XS | [run-kit#1049](https://github.com/sahil87/run-kit/pull/1049) | **merged** 2026-09-25, in v3.20.20 (fab change `1067`) — `.env`, `scripts/dev.sh`, and the e2e multi-rig lane all bind `127.0.0.1`; `0.0.0.0` is a commented LAN example |
| P3 | run-kit | **Daemon port gets a config.yaml key (D17).** Today the port is env-only (`RK_PORT`; no registry key, no `serve` flag), so there is nowhere durable to pin an existing install and no documented way to move. Add `port` to the `internal/settings` registry, default 3000 (unchanged here), precedence code default < config.yaml < `RK_PORT` < CLI flag; `RK_CODE_SERVER_PORT` still falls back to port+2. **Amend constitution IV** (v1.14.0 → 1.15.0): port becomes a config.yaml key that also keeps its env form; `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` remain the only env forms. Also make `rk daemon start`/`restart` resolve the port from config + env at call time and pass it into the rk-daemon session explicitly (`-e`, as the log path already is) — the daemon's tmux server otherwise keeps the environment it was born with, so a changed port may not take effect on restart (unverified; the change must test it). Non-disruptive: nobody's port changes | — | [run-kit#1051](https://github.com/sahil87/run-kit/pull/1051) | **merged** 2026-09-25, in v3.20.20 (fab change `v1r0`) — `port` config.yaml key (default < config.yaml < `RK_PORT`); constitution amended (now v1.15.0); `rk daemon start`/`restart` pass `-e RK_PORT=<resolved>` — the born-with-environment hazard was **reproduced** and fixed |

### Phase 3 — the disruptive renames (Sahil's call on timing; each bundle is one sitting)

R1 and R2 are independent of each other and can be weeks apart. R0 → C4 → C5 → R1
is one sequence because the desktop release-asset prefix (R0) ships with the
formula/release bundle (R1), and C4 rides that same release.

| # | Repo(s) | Slug (suggested) | Depends on | Size | Scope | PR | Status |
|---|---------|------------------|-----------|------|-------|----|--------|
| R0 | run-kit | `hexokit-app-identity` | A3 (or Sahil's call) | M | **The app rename.** Cobra root command name `hexokit` (`run-kit` kept as hidden alias one release), **`xk` added as an alias (D16)** + shell completions under all four names (`hexokit`, `rk`, `xk`, `run-kit`); **the parked code registers three — add `xk` during the rebuild**; help-dump / upgrade strings; Electron `productName` "Run Kit" → "HexoKit", `artifactName` → `hexokit-desktop-…`, `appId` kept (D8), the userData carry-forward of `hosts.json`/`windows.json`; `rk desktop` bundle name + release-asset prefix (`internal/desktop/*`); `fab/project/config.yaml` project name | [run-kit#950](https://github.com/sahil87/run-kit/pull/950) | **merged** 2026-09-26 (`3d7afba1`) — shipped: `hexokit` command + `xk`/`rk`/`run-kit` completions (four names), Electron productName → "HexoKit" / artifactName → `hexokit-desktop-…`, Linux AppImage arm (desktop entry, uninstall strings, legacy-prefix fallback), `appId` kept |
| C4 | run-kit | `hexokit-home-migration` | R0, P3 | M | D9: `~/.config/run-kit` → `~/.config/hexokit` (one-time move, dual-read one release); `$XDG_STATE_HOME/run-kit` → `hexokit` (cron entries + snapshots **must** move; droppable caches may cold-start); `runkit-*` localStorage → `hexokit-*` read-old/write-new. Add an e2e that seeds old keys/dirs and asserts pickup. **Port pin (rule P):** while migrating config.yaml, write the current effective daemon port into P3's `port` key (with a one-line comment: pinned during the rename so remote access kept working) so existing installs stay on 3000 and only fresh installs get the new default; doctor row nudges toward 6123. **Tunnel range:** persisted `remotes.yaml` 3100–3199 → 21500–21599 as a one-shot reassignment (lowest free) in the same load path *only if trivial*; otherwise leave the range alone and record it in the policy. Ships in the same release as R0 | [run-kit#1053](https://github.com/sahil87/run-kit/pull/1053) | **merged** 2026-09-26 (`65407dc2`). **Tunnel range deferred**: 3100–3199 kept; the rule P target 21500–21599 is deferred — `local_port` is immutable by design (keys per-origin browser state + desktop view identity), live `ssh -L` tunnels would orphan on the old port, and `remote.Load` range-checks every persisted entry. The doctor `port pin` nudge **wakes with C5** (the daemon-default flip). Follow-up: `remotes.yaml` stays at `~/.config/rk/remotes.yaml`, outside both homes |
| C5 | run-kit | `hexokit-daemon-port` | C4 | S | **Daemon default 3000 → 6123** (+1/+2 kept: 6124 dev backend, 6125 code-server; code-server override semantics unchanged — an explicit code-server port still means externally managed). Nothing forces existing users off 3000 (C4 pins them). Same change updates every place that states the default: README, hexokit.com install page, `serve` help text, `justfile` comments, MCP allowed-origins docs, `docs/specs/architecture.md`, `api.md`, `rk url` prints the current one. Release notes: new installs land on :6123; existing installs keep their pinned port; how to move (config edit, restart, Tailscale Serve, bookmarks, MCP clients — rule P). Doctor row nudges pinned-at-3000 installs toward 6123. Ships in the same release as R0 + C4 | [run-kit#1054](https://github.com/sahil87/run-kit/pull/1054) | **merged** |
| R1 | homebrew-tap → run-kit → shll → hexokit-site | `hexokit-formula-bundle` | R0, C4, C5 merged | M | In order, one sitting: **(a) DONE — homebrew-tap PR#6:** tap: `Formula/hexokit.rb` (installs `hexokit` + `rk` and `xk` symlinks), `formula_renames.json` adds `run-kit → hexokit` (precedent `rk → run-kit`), README banner + drop stale `ai.shll.in`; **(b) DONE — run-kit PR#1055, release v3.20.22 (carries R0+C4+C5+R1b), tap push confirmed (homebrew-tap commit `747f7d2`, Formula/hexokit.rb now real hashes):** run-kit: `.github/workflows/release.yml` writes `Formula/hexokit.rb`, `.github/formula-template.rb` name; **cut the release** (carries R0 + C4 + C5); **(c) DONE — [shll#103](https://github.com/sahil87/shll/pull/103) (merged 2026-09-28, `4def30d`), release [shll v0.1.34](https://github.com/sahil87/shll/releases/tag/v0.1.34):** shll: roster `Name`+`Formula` → `hexokit`, `LegacyName` gains `run-kit`, release shll — the `versions.json` row → `hexokit` / S3 `envelope` carry-over item is **not** shll's and moved to hexokit-site (see "Found at (c)" below; not done in (c)). (Release verified: workflow green; 4 tarballs; homebrew-tap commit `ac2d6cc` bumps `Formula/shll.rb` to 0.1.34; downloaded binary verified — `shll version` lists `hexokit v3.20.22`, `check-updates --json` resolves the `hexokit` row). Shipped: roster `Name`/`Formula`/`Update` → `hexokit` (`sahil87/tap/hexokit`, `hexokit update`), `Repo` stays `run-kit` until R2; `LegacyName` became `LegacyNames {rk, run-kit}` (ErrNotFound-only version-probe chain); `rk` and `run-kit` resolve as target aliases (`note: run-kit is now hexokit`); `shll setup agent` delegates to `hexokit agent setup`; check-updates looks the manifest row up by `hexokit` then the legacy names, so it works while hexokit.com's `versions.json` is still keyed `run-kit`. Found at (c): `versions.json` is not a shll file — hexokit-site builds it from `help/<slug>.json` + `versions-policy.json`, so retiring the S3 `envelope` carry-over (`help/run-kit.json`, the `run-kit` policy key, the `run-kit:run-kit:run-kit` triple in `refresh-help.yml`) is hexokit-site work alongside (d). Follow-up (run-kit, not yet filed): `app/backend/internal/updatecheck/updatecheck.go` matches its own row by `runKitTool = "run-kit"`; shll ≥ v0.1.34 names that row `hexokit`, so until run-kit accepts `hexokit` the daemon treats its own row as a sibling (brew-visible version, no selfBrew gate); **(d)** hexokit-site: landing shows `brew install sahil87/tap/hexokit`, install-script default → `hexokit`. **Gate before (c):** `brew upgrade` on a box with the old formula follows the rename cleanly — **verified 2026-09-28 by Sahil** on his own box (old formula run-kit 3.20.21 from `sahil87/tap`, pre-rename tap clone), after `brew update && brew upgrade` + `rk daemon restart`: brew migrated run-kit → hexokit 3.20.22 cleanly (`Cellar/run-kit` is Homebrew's compatibility symlink to hexokit; `brew info sahil87/tap/run-kit` resolves to hexokit with "Old Names: run-kit"); `hexokit`, `rk`, `xk`, and `run-kit` on PATH all resolve to `Cellar/hexokit/3.20.22/bin/hexokit` and the daemon process runs that binary; C4 migrated `~/.config/run-kit` → `~/.config/hexokit` with `port: 3000` pinned, and the daemon is still listening on :3000, so Tailscale kept working. Minor leftover, not a blocker: `opt/rk` is a dangling link (→ `Cellar/run-kit/3.20.21`) from the old rk → run-kit rename; nothing in hook or agent configs references it, and `brew cleanup` may prune it | [shll#103](https://github.com/sahil87/shll/pull/103) | (a)+(b)+(c) done — release v3.20.22 (run-kit) and shll v0.1.34 cut; (d) not started |
| R2 | run-kit → shll → hexokit-site → satellites | `hexokit-repo-bundle` | A3 (any time; independent of R1) | S | One sitting: **(a)** GitHub rename `sahil87/run-kit` → `sahil87/hexokit` (`gh auth switch --user sahil87`, switch back after; **never recreate `run-kit`** or the redirect dies); **(b)** shll roster `Repo` → `hexokit`, release; **(c)** hexokit-site slug-table source → `sahil87/hexokit`, run both Refresh crons once; **(d)** run-kit badges / `homepage` fields / formula-template URLs, sahil87 profile + the six C7 repo links. GitHub redirects web, clone, releases, and raw URLs between (a) and (d). **Target is `sahil87/hexokit`, fixed (D15)** — no org dependency, no "decide at R2" | | not started |
| X3 | run-kit | `hexokit-memory-hydrate` | R1, R2 | S | Memory + specs identity sweep for present-truth lines only (D11); competitive-landscape one-liner; `context.md`; close both plan docs (Status → Done) | | not started |

Order: ~~(P1 ∥ P2 ∥ P3)~~ done · A1 → (A2) → A3 → *[Sahil's call]* → ~~R0~~ → ~~C4~~ → ~~C5~~ → R1 (a,b,c done; d next) · R2 (any time after A3) → X3.

### Release notes draft (C5 — paste at R1)

> **Daemon port: new installs use :6123.** Fresh installs now listen on `127.0.0.1:6123` (dev backend
> 6124, code-server 6125). **Existing installs keep their port** — the one-time home migration pinned
> `port: 3000` in `~/.config/hexokit/config.yaml`, so Tailscale Serve mappings, bookmarks, phone
> shortcuts and MCP clients keep working. `rk doctor` shows a `port pin` row while you're pinned.
> **To move** (optional, any time): set `port: 6123` in `~/.config/hexokit/config.yaml`, run
> `rk daemon restart`, re-point Tailscale Serve at 6123, and update bookmarks / phone shortcuts / MCP
> clients (`http://<host>:6123/mcp`). `RK_PORT` still overrides everything.

---

## Risks still live

- **Silent state loss** (C4). Shipped mitigation: copy + atomic publish
  (rename) at daemon start; dual-read resolution (new-if-exists, else
  legacy-if-exists, else new); the port pin at the legacy default; a
  marker-guarded localStorage boot copy; and the pickup e2e tests that seed
  the old dirs/keys and assert pickup. Legacy homes and keys stay in place
  for one release.
- **Formula rename edge cases** (R1). `formula_renames.json` has worked once
  (`rk → run-kit`); still verify on a box with the old formula before the
  roster flips, because a broken rename strands `shll install`.
- **Electron identity** (R0). `appId` kept, `productName` changed: supported,
  but macOS may show the old name in some dialogs until relaunch. Acceptable.
- **Two names on one machine** until R1/R2 land: `brew list` and the desktop
  app say run-kit while the site says HexoKit; badges point at the old repo
  URL through GitHub's redirect. Accepted by Sahil as cosmetic.
- **Remote-access remap** (C5). A moved daemon port means every Tailscale
  serve mapping, bookmark, and phone shortcut is re-done at once. Mitigated by
  design: C4 pins existing installs to their current port, so only fresh
  installs see 6123 and existing users move on their own schedule.
- **Parked branch drift** (R0). `#950` sits behind `main`; rebase and run the
  full suite (no `| tail`) before merging — the earlier split broke once when
  a checkout reverted newer main changes.

---

## Pickup protocol

1. The rules table above is Certain; do not re-open it. Anything not covered
   goes back to the master plan's decision log.
2. A1 is a release, not a fab change. R0 is a parked PR, not a new change —
   rebuild `260911-mvuv-hexokit-brand-surfaces` onto current main by patch
   apply (see the R0 row) and force-push the same branch; keep PR #950.
3. Substrate identifiers (`rk`, `RK_*`, `@rk_*`, `rk-*`) are never renamed.
4. Update the row and the Status line here when you start or finish; when
   Phase 3 closes, add one line to the master plan's Status and mark both Done.
