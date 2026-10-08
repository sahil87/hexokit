# Intake: HexoKit brand surfaces (plan row C3)

**Change**: 260911-mvuv-hexokit-brand-surfaces
**Created**: 2026-09-11

> **Split 2026-09-12 (plan row R0).** This change now carries only the app-identity half — cobra root name + completions, help-dump/upgrade strings, Electron productName/artifactName/userData carry-forward, `rk desktop` bundle + asset prefix, `fab/project/config.yaml`. The prose half (README, docs/site, skill H1s, specs, prose-scoped memory) moved to `260911-mljj-hexokit-brand-prose` (run-kit#952, row C3a). PR #950 stays the R0 PR and is deferred to Phase 3; sections and tasks below that describe the prose half are historical.

> **Rebuilt 2026-09-26 (Phase 3, R0).** The branch was 130 commits behind `main`, so it was rebuilt fresh from `main` (1a43927b) by 3-way patch-applying the old app-identity diff (`8a0f0d8c..6193071d`, change artifacts excluded). Two material additions ride the rebuild: **(a) `xk` alias (D16)** — shell completion now registers under all four names (`hexokit`, `rk`, `xk`, `run-kit`); **(b) Linux desktop merge** — `main` gained Linux AppImage install/update/uninstall (260917-ot32) since the old diff, so the rename now also covers the Linux arm: the desktop entry's `Name=`/`StartupWMClass=` → `HexoKit` (Electron's WM class follows `productName`), `rk desktop uninstall` strings, the AppImage asset-prefix legacy fallback, and the legacy-bundle helpers resolve the install root via `effectiveInstallDir` (an empty `InstallDir` now means the platform default). The inner AppImage names (`run-kit-desktop` ELF, `.desktop`, icon) stay — they derive from `package.json` `name`, which is unchanged.

## Origin

> Per fab/plans/sahil/26-09-10-hexokit-rebrand.md row C3 (hexokit-brand-surfaces, run-kit repo), Phase 1, gated on C1 (shll change ttoa, PR shll#98 up, review-pr done): update run-kit's own brand surfaces. Scope per the row: README H1/tagline flip to HexoKit (badge URLs stay pointed at sahil87/run-kit until the deferred R2 repo rename -- do NOT touch badge/repo-link URLs); docs/site/* identity lines + skill.md H1 flip; Electron productName/artifactName -> HexoKit per D8 (appId `ai.shll.run-kit` is KEPT, do not change it); add a `hexokit` cobra alias verb alongside the existing `run-kit` verb (keep `run-kit` as a working hidden alias for one release -- do not remove it); specs' present-tense identity lines flip; fab/project/config.yaml project name -> hexokit. Explicitly OUT of scope (deferred to R1/R2): no GitHub repo rename, no release-tooling/formula changes. Read the plan doc's Decision log (D1-D14) and this row in full before drafting the intake.

One-shot `/fab-new` invocation with an explicit scope brief. The plan doc is the design authority: D1–D4, D13, D14 are confirmed; D5–D12 are proposals the pickup protocol says not to re-open. This intake reads D2 (binary stays `rk`; `hexokit` is the long name), D8 (Electron productName/artifactName flip, appId kept), D11 (historical text is not renamed — only live surfaces), and D14 (standards are content-edited by C1, not renamed; C3 consumes the revised text) as binding.

**Gate status at intake time**: shll PR [#98](https://github.com/sahil87/shll/pull/98) ("chore: HexoKit banner and policy (D14 first pass)", fab change `ttoa`) is open as a draft and not merged. The user defines the C3 gate as "PR up, review-pr done", which holds. C3's README blockquote must match C1's final text; the text below is what `ttoa`'s branch carries today.

**Research done at intake** (so apply does not re-derive it): the shll `version` standard parses `--version` by a first-line `<word> version <rest>` prefix or bare token and probes install by *roster/binary* name — so changing the cobra root name is probe-safe. The `skill` standard mandates no H1 shape for `docs/site/skill.md`. The `readme-extraction` standard (as revised by C1) mandates the head order H1 → blockquote → badges and the blockquote `> Part of [HexoKit](https://hexokit.com) — see all projects there.`. The revised `install-composition` Policy B says README install sections link to https://hexokit.com; `https://hexokit.com/install` already serves the bootstrap script (HTTP 200, verified 2026-09-11). hexokit-site's `refresh-help.yml` writes `help/<slug>.json` from its own slug table and passes the help-dump `tool` field through unchanged. `.github/workflows/release.yml` uploads desktop artifacts by extension glob (`*.dmg`, `*.AppImage`, `*.deb`, `*.exe`), never by the `run-kit-desktop-` prefix.

## Why

**The product is unfindable under its current name.** `runkit` search belongs to a defunct Node playground; `"run-kit" tmux agent` returns nothing for this project. The plan's answer (D1, Approach B) is to rename the *product* to HexoKit while keeping the *substrate* — the `rk` binary, every `RK_*` env var, `@rk_*` tmux option, `rk-*` socket/session/CSS name — untouched, so nothing that machines or fab-kit read ever changes.

**Phase 1 flips run-kit's own brand surfaces without any rename that is hard to reverse.** C1 (shll) has already changed the standards' mandated README blockquote and the install-docs location to HexoKit/hexokit.com. run-kit's README now *violates* its own governing standard until this change lands, and the constitution's Toolkit Standards clause binds this repo to those standards. The GitHub repo name, the tap formula, the roster fields, and the release tooling stay exactly as they are (R1/R2, weeks later), so after this change a user sees "HexoKit" in the README, the docs, the desktop app, and `rk --help`, while `brew list` and the repo URL still say `run-kit` — a cosmetic gap the plan's Risks section records as accepted by Sahil.

**Why not wait for R1/R2 and do it all at once?** The cutover order is fixed by the plan: X1 (site cutover prep) depends on C3 and C7 being merged so the hexokit.com `/docs/` tree carries the rebranded README on the first refresh. Doing C3 now is what unblocks Phase 2; the renames were deliberately moved last so nothing irreversible happens before the site is proven.

**Why the Electron and CLI parts carry small migrations.** Two things the row lists have consequences the plan's decision log does not spell out, found at intake: (1) Electron keys the per-user data directory on the product name, so flipping `productName` silently moves `hosts.json`/`windows.json` — the exact "silent settings loss" regression D9 exists to prevent — unless the shell copies them forward once; (2) the cobra root name drives the generated shell-completion function names, so `run-kit`/`rk` completion breaks unless shell-init registers the new function for all three names. Both are handled here rather than deferred because they are caused by this change.

## What Changes

Seven surfaces. Everything not listed is out of scope — see § Non-goals at the end of this section. Throughout, the **classification rule** for a `run-kit` token is:

| Token is… | Action | Examples |
|-----------|--------|----------|
| The product noun in prose (present tense, identity/tagline/heading) | → **HexoKit** | "run-kit is a remote console", "## Why run-kit?", "for agents operating run-kit", `# run-kit API Specification` |
| A command invocation, formula/roster name, or completion name | **keep** | `run-kit daemon start`, `shll install run-kit`, `sh -s -- run-kit`, `sahil87/tap/run-kit`, `compdef … run-kit` |
| A path, URL, identifier, or payload value | **keep** | `~/.config/run-kit/`, `$XDG_STATE_HOME/run-kit/`, `github.com/sahil87/run-kit`, `shields.io/…/run-kit`, `"tool": "run-kit"`, `docs/memory/run-kit/`, tmux session names in mockups |
| Historical narrative (plans, archives, memory logs, ASCII mockups, old PR titles) | **keep** (D11) | `fab/changes/**`, `docs/memory/**` prose, design.md diagram frames |

### 1. README.md — head, tagline, identity prose

The head keeps the readme-extraction order (H1 → blockquote → contiguous badges → first prose line = tagline). Exact edits:

```markdown
# before (lines 1, 3)
# <img src="https://raw.githubusercontent.com/sahil87/run-kit/main/assets/logo.svg" alt="run-kit logo" width="32" height="32"> run-kit

> Part of the [shll toolkit](https://shll.ai) — see all projects there.

# after
# <img src="https://raw.githubusercontent.com/sahil87/run-kit/main/assets/logo.svg" alt="HexoKit logo" width="32" height="32"> HexoKit

> Part of [HexoKit](https://hexokit.com) — see all projects there.
```

The logo `src` URL, and the three badge lines (`shields.io/…/sahil87/run-kit`, `github.com/sahil87/run-kit/releases`, `…/stargazers`) are **untouched** (R2).

Prose identity lines that flip `run-kit` → `HexoKit` (line numbers as of `c703a254`): 7 (tagline sentence "HexoKit is a remote console…"), 9 ("But HexoKit never wraps the agent", "not the thing HexoKit is"), 17 ("HexoKit relies on its sibling tools" — the clause "installs `rk` as a fully interchangeable short alias of `run-kit`" is a formula fact and **stays**), 48 (`## Why HexoKit?`), 50 (the comparison table's `run-kit` column header → `HexoKit`), 58 ("Reach for HexoKit when…"), 74 ("HexoKit is two independent halves"), 138 (code-block comment "installs HexoKit's dashboard hooks"), 143 ("trust the HexoKit entries via `/hooks`"), 157, 175, 207, 208, 222 (the `rk url` / `rk skill` / `rk remote` command-table descriptions).

**Install section, per the revised install-composition Policy B (C1)**: the curl line and its prose flip to the centralized location:

```markdown
# before
curl -fsSL https://shll.ai/install | sh
…
Installs the entire shll toolkit via Homebrew, …

# after
curl -fsSL https://hexokit.com/install | sh
…
Installs the entire HexoKit toolkit via Homebrew, …
```

`hexokit.com/install` is a byte copy of the shll.ai script today (verified 200); S5 later changes that script's *default* tool set, not its location. The command-reference link on line 225 (`https://shll.ai/run-kit/commands/`) names the *consuming site* and **stays** for X1/X4, exactly as C1 left shll's own consuming-site mentions. The "shll toolkit" phrases elsewhere in the README (line 138's `shll setup agent` comment aside) are left for C7/X4 unless they sit inside a line already being edited.

### 2. docs/site/** — identity lines, skill H1s, the desktop bundle name

Every page keeps its GitHub back-links (`github.com/sahil87/run-kit/...` → R2) and every command token. Edits:

- **`docs/site/skill.md`** — line 1 `# run-kit skill` → `# HexoKit skill`; line 3 "The agent skill bundle for **run-kit**" → "**HexoKit**"; prose mentions on lines 20, 25, 31, 40, 60, 71, 88, 111 ("Reach for HexoKit to", "HexoKit is optional and may be absent", "skip every HexoKit step", "the HexoKit **server URL**", "HexoKit missing", "what HexoKit does", "HexoKit may not be installed"). The gate command on line 33 (`command -v run-kit` or whatever token it carries in a code span) **stays**.
- **`docs/site/skill/{code,cron,display,gui,messaging,mux,tutorial}.md`** — each H1 `# run-kit skill: <topic>` → `# HexoKit skill: <topic>`; each page's prose "when to reach for run-kit at all" / "run-kit is optional and may be absent" / "a tmux pane run-kit manages" / "run-kit's server-birth path" / "run-kit's internal sessions" / "run-kit's reserved namespace" / tutorial.md's "run-kit is mission control", "first-time run-kit user", "the run-kit dashboard", "run-kit is agents in parallel" → HexoKit. Keep `rk skill <topic>` tokens and `../skill.md` links.
- **Embedded copies** — `app/backend/cmd/rk/skill/{skill,code,cron,display,gui,…}.md` are byte-copies drift-guarded by `TestSkill*EmbedMatchesCanonical`; run `scripts/sync-skill.sh` after editing the canonical pages, and confirm the ≤150-line budget tests still pass (line counts are unchanged by a word swap).
- **`docs/site/install.md`** — line 3 "How to install HexoKit"; line 10 `curl -fsSL https://hexokit.com/install | sh -s -- run-kit` (**host flips per Policy B; the `run-kit` tool argument is the roster name and stays** until R1); line 13 "This installs HexoKit (plus the shll meta-CLI)… and puts the `run-kit` binary on your `PATH`" (binary name stays); line 24 "open **HexoKit.app**" and "connect to HexoKit on other machines"; lines 32, 43, 54 ("Upgrading from an earlier version?"), 78, 80, 113, 118, 138, 153 (×2), 175, 191 prose → HexoKit. Line 56's old-`rk`-formula note is formula history and **stays**. All `run-kit <verb>` command lines **stay**.
- **`docs/site/agent-hooks.md`** — lines 3, 5 ("removes exactly the HexoKit-owned artifacts"), 23, 25, 27 ("trust the HexoKit entries … not a HexoKit limitation"), 40 → HexoKit; `run-kit agent setup` tokens stay.
- **`docs/site/customizing-tmux.md`** — line 3 "HexoKit owns its default tmux configuration"; the `~/.config/run-kit/…` paths and the line-10 stamp comment **stay** (C4 moves the directory).
- **`docs/site/workflows.md`** — lines 3, 23 ("start agent work in HexoKit", "drive it from the HexoKit UI").
- **`docs/site/cron-schedule-kinds.md`** — line 9 eyebrow `run-kit · rk cron` → `HexoKit · rk cron`. The inline HTML/CSS is otherwise untouched.
- `boards.md`, `notifications.md`, `status-dot.md` carry only back-links → no change.

### 3. Electron desktop shell (D8) — productName, artifactName, and the userData carry-forward

`app/desktop/electron-builder.yml`:

```yaml
# before
appId: ai.shll.run-kit
productName: Run Kit
artifactName: "run-kit-desktop-${version}-${arch}.${ext}"

# after
appId: ai.shll.run-kit            # KEPT — installed apps keep their OS identity (D8)
productName: HexoKit
artifactName: "hexokit-desktop-${version}-${arch}.${ext}"
```

`app/desktop/src/main.ts` `const PRODUCT_NAME = "Run Kit"` → `"HexoKit"` (window titles `HexoKit — <host>`; `menu.ts` uses `app.name`, which follows productName). `package.json` `description` prose "run-kit desktop viewer shell" → "HexoKit desktop viewer shell"; the private `name: run-kit-desktop` and `homepage` URL **stay** (see § Non-goals). Update `window-registry.test.ts` (`PRODUCT = "Run Kit"` and the two title/label fixtures).

**userData carry-forward (new, caused by the productName flip).** Electron resolves `app.getPath('userData')` from the app name, so the stores move from `…/Application Support/Run Kit/` (Linux `~/.config/Run Kit/`, Windows `%APPDATA%\Run Kit\`) to `…/HexoKit/`. On startup, before `hosts.json`/`windows.json` are read, apply the D9 pattern once:

- Compute the legacy dir as the sibling of the new userData dir named `Run Kit`.
- If the new dir has **no** `hosts.json` and the legacy dir has one, copy `hosts.json` and (if present) `windows.json` into the new dir. Copy, do not move — the legacy dir is left in place for one release (D9), then a later change drops the shim.
- Never overwrite an existing new-dir file; failures are logged and ignored (the app then behaves as a fresh install, exactly as today with a missing store).
- Unit-test it with the same injected-directory seam `hosts.ts`/`windows.ts` already use (`node --test`).

### 4. `rk desktop` (Go) — bundle name and release-asset prefix follow D8

`app/backend/internal/desktop/desktop.go`:

```go
// before
AppBundleName = "Run Kit.app"
assetPrefix   = "run-kit-desktop-"

// after
AppBundleName       = "HexoKit.app"
legacyAppBundleName = "Run Kit.app"   // one release: detect + replace the pre-rename install
assetPrefix         = "hexokit-desktop-"
legacyAssetPrefix   = "run-kit-desktop-"
```

- `release.go` asset selection: match `assetPrefix` first, then `legacyAssetPrefix` (a release carrying either naming resolves; the error message names both). `release_test.go` fixtures gain a `hexokit-desktop-…` case and keep one legacy case.
- `install.go` validates the mounted bundle is `HexoKit.app`, stages and installs it at `<InstallDir>/HexoKit.app`. After a successful swap, if `<InstallDir>/Run Kit.app` exists it is removed (it is the same rk-installed app under its old name; leaving it yields two Dock entries).
- Installed-version detection (`installed.go`) and `rk desktop status` read `HexoKit.app` first and fall back to `Run Kit.app`, reporting the legacy bundle as the installed (older) version so `rk desktop update` upgrades it rather than reporting "not installed".
- `restart.go` quits whichever of `HexoKit` / `Run Kit` is running before the swap (today it derives one name from `AppBundleName`).
- User-facing strings in `app/backend/cmd/rk/desktop.go` (`Short`/`Long`, "Installed Run Kit v…", "Run Kit was running — restarted…", "Run Kit is not installed at …") → `HexoKit`. These are D8's productName surfacing in help and output, not the deferred general help-prose sweep. Update `desktop_test.go`, `installed_test.go` fixtures accordingly.
- `release.yml` needs **no** change (extension globs). `rk update`'s CLI-then-desktop order means a user on the pre-C3 binary self-heals: `rk update` installs the new CLI first, which then finds the new asset prefix.

### 5. Cobra root — `hexokit` becomes the command name; `run-kit` keeps working

There is no cobra-level alias for a *root* command: the binary answers to whatever name it is invoked by (`rk` and `run-kit` are formula symlinks to one executable), so `run-kit …` keeps working with zero code. The row's "alias verb" resolves to the root command's **name** and everything derived from it:

```go
// app/backend/cmd/rk/root.go — before
Use:   "run-kit",
Short: "run-kit — tmux session manager with web UI",

// after
Use:   "hexokit",
Short: "hexokit — tmux session manager with web UI",
```

Derived surfaces that change automatically and whose tests must follow:

| Surface | Before | After | Test to update |
|---------|--------|-------|----------------|
| `rk --version` first line | `run-kit version v3.x.y` | `hexokit version v3.x.y` | `root_test.go` (`want := "run-kit version dev"` ×2) |
| `rk --help` usage / unknown-command hint | `Usage: run-kit [command]`, `Run 'run-kit --help'` | `hexokit …` | `root_test.go` line ~214 error fixture; verify `exitCode`'s `unknownCommandPrefix` match is name-independent |
| `rk help-dump` envelope | `tool: run-kit`, `root.name/path: run-kit` | `hexokit` | `help_dump_test.go` (three asserts) |
| cobra completion function | `_run-kit` / `__start_run-kit` | `_hexokit` / `__start_hexokit` | `shell_init_test.go` |

**Shell completion — the one place `run-kit` must be *kept working* explicitly** (`shell_init.go`): cobra registers the generated function only for the root name, so today the code appends `compdef _run-kit rk`. After the flip, append registrations for **both** legacy-and-current invocation names:

```sh
# zsh (appended after cobra's own `compdef _hexokit hexokit`)
compdef _hexokit rk
compdef _hexokit xk        # D16 alias — added in the 2026-09-26 rebuild
compdef _hexokit run-kit
# bash
complete -o default -F __start_hexokit rk
complete -o default -F __start_hexokit xk
complete -o default -F __start_hexokit run-kit
```

Banner comment `# hexokit(1) zsh completion`; the rc-file hint inside the output uses `rk shell-init <shell>` (always on PATH). `shll setup shell` writes its own eval line by roster name and is unaffected.

**Deliberately unchanged in the Go tree** (roster/substrate-coupled, not brand):
- `internal/updatecheck` `runKitTool = "run-kit"` and the frontend `RUN_KIT_TOOL` — the roster `Name` the hexokit.com `versions.json` still keys on until R1.
- `resolveRkPath()` LookPath order `run-kit`, `rk` — `hexokit` is not an installed binary name until R1, and probing for it now would risk resolving a foreign executable of that name into installed hooks. R1 adds it.
- `guiPointerPath` (`~/.local/share/rk/bin/run-kit`), every `$XDG_STATE_HOME/run-kit/…` and `~/.config/run-kit/…` path (C4), `internal/mcp` `Implementation{Name: "run-kit"}` (see § Non-goals), all `"run-kit riff: …"` error prefixes and the ~25 other subcommands' `Short`/`Long` prose naming run-kit (see § Non-goals).
- `internal/remote/ssh.go` `versionPattern` and `local-daemon.ts` `parseRkVersion` are token-based and already accept `hexokit version v…`; their doc comments may be refreshed but no logic changes.

### 6. docs/specs/** — present-tense identity lines

Apply the classification rule to the ~77 prose occurrences (`grep -nP '(?<![\`/\w.-])run-kit(?![\`/\w-])' docs/specs/*.md` minus `docs/memory/run-kit` and `sahil87/run-kit` hits). Flip:

- H1s: `# run-kit API Specification` (api.md), `# run-kit UI Design Philosophy` (design.md), `# run-kit Architecture Specification` (architecture.md), `# run-kit Reimplementation Plan` (project-plan.md) → `# HexoKit …`.
- Intro blockquotes / identity sentences: api.md:3 ("HexoKit's Go backend"); architecture.md:3, 16, 148, 199 ("HexoKit is a local dev tool"); design.md:4, 12 ("HexoKit is a terminal orchestrator"), 43, 47, 360; agent-state.md:3, 19, 23, 71, 76, 80 ("the HexoKit *server*"); status-pyramid.md:3, 43; window-views.md:3, 130; code-bridge.md:3, 10, 106, 254; ui-state.md:40, 42, 53, 57, 97, 370; cli-layering.md:4 ("HexoKit (`rk`) and fab-kit (`fab`) are the only two CLIs") and :96; mcp.md:12, 58; themes.md:36, 70; right-panel.md:163, 292, 312; short-term-goal.md:12; agent-messaging.md:36, 68 (the `[run-kit request]` envelope tag is a wire token — **keep**); project-plan.md:3.
- `docs/specs/index.md`: the Competitive Landscape, Cron/Code Bridge and other row descriptions that say "run-kit" as the product → HexoKit; spec file names and links stay.

Keep: `cmd/run-kit`, `bin/run-kit` build paths (project-plan.md:18, architecture.md:248 — historical build examples); api.md JSON payloads (`"name": "run-kit"` is a tmux session name, `"tool": "run-kit"` the roster name); design.md ASCII mockups (`☰ run-kit / zsh` is a session name, `{logo} Run Kit` frames are historical design frames); cli-layering.md / agent-messaging.md execution tables whose `run-kit` column is the *repo*; every `docs/memory/run-kit/…` link.

### 7. `fab/project/config.yaml`

```yaml
project:
    description: Web based agent orchestration framework
    name: hexokit        # was run-kit
```

Nothing reads `project.name` for routing (fab uses it for display); the constitution's `# run-kit Constitution` H1 and `context.md` are X3's identity sweep and **stay**.

### Non-goals (recorded so review does not flag them as omissions)

- **No GitHub repo rename, no formula, no `release.yml`/`formula-template.rb` edits** (R1/R2). Badge/repo/raw URLs everywhere stay `sahil87/run-kit`.
- **No on-disk home moves** — `~/.config/run-kit/`, `$XDG_STATE_HOME/run-kit/`, `runkit-*` localStorage keys (C4). The Electron userData carry-forward in § 3 is the one exception because this change causes that move.
- **Adjacent brand-tier surfaces the plan assigns to no row** — surfaced for Sahil, **not** done here (see Open Questions): the frontend's `RunKit` strings (`index.html` `<title>`, `public/manifest.json` name/short_name, `use-browser-title.ts`, the top-bar brand crumb, push/shell-notification default titles, `sw.js`); the MCP server `Implementation.Name`; the private npm names `run-kit-frontend` / `run-kit-desktop`; and the ~25 non-desktop subcommands whose `Short`/`Long` help says "run-kit" (`daemon`, `url`, `mcp`, `remote`, `skill`, `upgrade`, …).
- **No `run-kit <verb>` → `rk <verb>` rewrite** of command examples in docs; those tokens remain valid invocations until R1.
- **No memory/plan/archive rewrites** (D11). Hydrate updates memory for the behavior this change *introduces* only.

## Affected Memory

- `run-kit/toolkit-standards`: (modify) README head now carries the C1 blockquote and links install steps to hexokit.com (revised readme-extraction / install-composition); `--version` first word and help-dump `tool` are `hexokit` while roster/binary/formula stay `run-kit` — the version standard's sanctioned rename-in-flight posture; skill bundles' H1s.
- `run-kit/architecture/cli`: (modify) root `Use: hexokit`, version line, help-dump envelope values, shell-init registering completion for `hexokit`/`run-kit`/`rk`, `run-kit` as the still-installed long invocation name; `rk desktop` bundle/asset naming.
- `run-kit/desktop-shell`: (modify) productName HexoKit, artifactName `hexokit-desktop-…`, appId `ai.shll.run-kit` kept, `HexoKit.app` bundle with legacy `Run Kit.app` detection/replacement, the one-release userData carry-forward of hosts.json/windows.json, titlebar/menu strings.
- `run-kit/build-and-release`: (modify) desktop artifact naming convention and the dual-prefix asset match; release workflow unchanged (extension globs).
- `run-kit/architecture/overview`: (modify) product identity sentence — HexoKit is the product name, `rk` the binary, `run-kit` the long name until R1 (D2).

## Impact

**Code**: `app/backend/cmd/rk/{root.go,shell_init.go,desktop.go}` + tests (`root_test.go`, `help_dump_test.go`, `shell_init_test.go`, `desktop_test.go`); `app/backend/internal/desktop/{desktop.go,release.go,install.go,installed.go,restart.go}` + tests; `app/backend/cmd/rk/skill/*.md` (synced copies); `app/desktop/{electron-builder.yml,package.json,src/main.ts}` + a new startup carry-forward (touching `hosts.ts`/`windows.ts` load path or `main.ts`) + `window-registry.test.ts`.

**Docs/config**: `README.md`; `docs/site/*.md` and `docs/site/skill/*.md`; ~18 `docs/specs/*.md` files plus `docs/specs/index.md`; `fab/project/config.yaml`.

**Runtime behavior that changes for users**: `rk --version` / `rk --help` / `rk help-dump` say `hexokit`; the desktop app installs as `HexoKit.app` from `hexokit-desktop-*` assets, replacing `Run Kit.app` and carrying its host list forward; shell completion continues to work for `run-kit` and `rk`. Everything under `RK_*`, `@rk_*`, `rk-*`, and on-disk paths is unchanged.

**External consumers**: shll's `version`/`doctor`/install probes (by roster name, prefix-tolerant parse) unaffected; hexokit.com's help refresh keys on its slug table and passes `tool` through; fab-kit reads `rk mux …` verbs and `@rk_*` options only. The `versions.json` row stays `run-kit` until R1.

**Verification gates** (code-quality.md order): `just test-backend`; `cd app/desktop && pnpm run compile && pnpm test`; frontend `tsc --noEmit` (no frontend source changes expected); `just build`. `just test-e2e` is not expected to change (no frontend strings move), so run only the smoke subset unless review asks. Before the PR: re-run the readme-extraction conformance checklist (head order, no relative images, no new `docs/site` reserved names) and `scripts/sync-skill.sh` drift tests.

## Open Questions

- The plan's Brand tier lists "`CamelCase RunKit` in user-visible strings" and the private npm names for rename, but no C-row owns them; the ~25 subcommands' help prose ("Start the run-kit daemon") and the MCP server name are in the same position. This intake excludes them per the explicit row scope. Should they become a new Phase 1 row (suggested `C5 hexokit-ui-and-help-strings`, depends on C3) or be folded into this change via `/fab-clarify`? Default taken: **new row; not here**.
- Should `run-kit <verb>` command examples in docs/site be rewritten to `rk <verb>` now, so the docs never show a long name that will change again at R1? Default taken: **no** — the tokens stay valid, and R1's binary rename is the natural moment.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is exactly the C3 row's list; GitHub rename, formula, `release.yml`/`formula-template.rb`, badge/repo URLs, and on-disk homes are out (R1/R2/C4) | User brief and plan row state it verbatim; D11 backs leaving historical text | S:95 R:90 A:95 D:95 |
| 2 | Certain | README blockquote becomes `> Part of [HexoKit](https://hexokit.com) — see all projects there.`; head order H1 → blockquote → badges preserved | D14 gives the text; C1's `ttoa` branch carries it verbatim; readme-extraction mandates the order | S:95 R:90 A:95 D:95 |
| 3 | Certain | `appId: ai.shll.run-kit` is kept; `productName: HexoKit`; `artifactName: hexokit-desktop-${version}-${arch}.${ext}` | D8 verbatim; user brief repeats it | S:95 R:85 A:95 D:95 |
| 4 | Certain | C1 gate treated as satisfied (PR #98 up, review-pr done) even though the PR is an unmerged draft; C3's blockquote follows C1's final text | User defined the gate; verified PR state at intake | S:90 R:90 A:85 D:90 |
| 5 | Confident | "Add a `hexokit` cobra alias verb" = set the root `Use` (and `Short`) to `hexokit`; `run-kit` keeps working because root dispatch is by symlink name, with explicit completion registration for `run-kit` and `rk` | Cobra has no root alias mechanism; D2 says `hexokit` is the long binary name; the derived surfaces (version line, help-dump `tool`, completion function) are what a "root name" change touches | S:60 R:75 A:80 D:65 |
| 6 | Confident | `rk --version` → `hexokit version vX.Y.Z` is safe for shll and run-kit's own parsers | version standard parses `<word> version <rest>`; `versionPattern`/`parseRkVersion` are token regexes; probes run by roster name | S:70 R:85 A:90 D:85 |
| 7 | Confident | help-dump `tool`/`root.name` = `hexokit` does not break hexokit-site's help refresh | `refresh-help.yml` keys output on its slug table and passes `tool` through jq unchanged; the site's schema file was not located at intake — verify `tool` is an unconstrained string when the PR is up | S:60 R:85 A:60 D:80 |
| 8 | Confident | Electron userData carry-forward (copy `hosts.json`/`windows.json` from the legacy `Run Kit` dir once, old left in place) is part of this change | The productName flip causes the dir move; D9 gives the read-old-then-write-new pattern; without it the flip regresses every desktop user | S:55 R:70 A:80 D:75 |
| 9 | Confident | `rk desktop` detects/replaces legacy `Run Kit.app`, matches both asset prefixes, and quits either running app name | Same rk-installed app under a new name; `rk update` orders CLI before desktop; leaving both bundles yields two Dock entries | S:60 R:75 A:80 D:70 |
| 10 | Confident | README install one-liner and docs/site/install.md host flip to `hexokit.com/install`; the `run-kit` tool argument and the commands-page URL stay | Revised install-composition Policy B (C1) says READMEs link to hexokit.com; `hexokit.com/install` serves the script (200); the commands URL names the consuming site (X1/X4) | S:55 R:90 A:70 D:65 |
| 11 | Confident | `resolveRkPath` LookPath order stays `run-kit`, `rk` — no `hexokit` probe until R1 | No installed binary carries that name yet; a foreign `hexokit` on PATH would be baked into hooks | S:50 R:90 A:75 D:70 |
| 12 | Confident | `rk desktop` family `Short`/`Long` and output strings flip to HexoKit; the other ~25 subcommands' help prose does not | Desktop strings are D8's productName surfacing; the rest is the unassigned brand-tier cluster (Open Question 1) | S:50 R:85 A:60 D:55 |
| 13 | Confident | Adjacent brand-tier surfaces (frontend `RunKit` strings, MCP server name, private npm names, general help prose) are excluded and surfaced as a plan gap | User said "scope per the row"; the plan assigns them to no row; adding them is a scope widening for Sahil to decide | S:45 R:85 A:55 D:50 |
| 14 | Confident | Specs: flip H1s, intro blockquotes and "run-kit is/renders/owns" identity prose; keep paths, payload values, repo-column table cells, ASCII mockups | Row says "present-tense identity lines"; D11 keeps historical/mockup text; the classification rule in § What Changes is the tie-breaker | S:60 R:85 A:70 D:65 |
| 15 | Confident | `run-kit <verb>` command examples in docs are left as-is (not rewritten to `rk <verb>`) | Still valid invocations until R1; smaller diff; R1 is the natural sweep | S:50 R:90 A:75 D:60 |
| 16 | Confident | `fab/project/config.yaml` `project.name: hexokit`; constitution H1 and `context.md` untouched | Row lists only config.yaml; X3 owns the constitution/context identity sweep | S:85 R:90 A:90 D:85 |
| 17 | Confident | Change type pinned `chore` (explicit) | Rebrand/rename with no new capability; matches C1's `ttoa` (`chore`); gate threshold is type-independent | S:60 R:95 A:80 D:70 |

17 assumptions (4 certain, 13 confident, 0 tentative, 0 unresolved).
