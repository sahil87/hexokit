# HexoKit rebrand execution plan — run-kit becomes the product, `rk` stays the substrate

> Plan doc — written 2026-09-10 from the bright-pelican `/fab-discuss` thread.
> Cross-repo: this plan lives in run-kit because run-kit is the product being
> renamed, but its changes land in five repos (`run-kit`, `shll`, `shll.ai`,
> `homebrew-tap`, `fab-kit` + the satellite READMEs). Positioning authority:
> [`docs/wiki/competitive-landscape.md`](../../../docs/wiki/competitive-landscape.md)
> ("Cockpit for the agent era"). This doc owns the naming tiers, the decision
> log, the site shape, the change breakdown, and the cutover order.

**Goal**: make the product findable. "run-kit" is unsearchable — the first
page for `runkit` belongs to RunKit, the defunct YC-backed Node playground —
and shll.ai buries the dashboard as the 5th of "seven small CLIs" behind a
fab-kit-centred loop diagram. After this plan: the product is **HexoKit**
(hexokit.com, `brew install sahil87/tap/hexokit`, GitHub `sahil87/hexokit`),
the binary is still `rk`, every tmux/env/socket identifier is untouched, the
six companion CLIs keep their names and are presented as *the HexoKit
toolkit*, and shll.ai becomes a permanent redirect host.

**Status (2026-09-12)**: Phases 0–2 done. **Remaining work (announce gate + Phase 3) is tracked in [`26-09-12-hexokit-rebrand-remaining.md`](26-09-12-hexokit-rebrand-remaining.md)** — update rows there; this doc keeps the evidence, decisions, and done history. Approach B chosen (product rename,
substrate kept). D1–D4 and D13–D17 confirmed by Sahil in the thread; D5–D12 are
the plan's proposals and are open until marked confirmed. S1 done (operator,
direct git op, no fab change). S2 merged (PR [hexokit-site#1](https://github.com/sahil87/hexokit-site/pull/1), fab change `1ha7`);
hexokit.com live over HTTPS, unannounced.
S3 merged 2026-09-10 (PR [hexokit-site#3](https://github.com/sahil87/hexokit-site/pull/3), fab change `it5d`).
S4 merged 2026-09-10 (PR [hexokit-site#4](https://github.com/sahil87/hexokit-site/pull/4),
fab change `lvnp`) after Sahil's design review; the earlier attempt
([hexokit-site#2](https://github.com/sahil87/hexokit-site/pull/2), fab change `jwhx`) is closed.
S5 merged 2026-09-11 ([hexokit-site#8](https://github.com/sahil87/hexokit-site/pull/8)) — Phase 0 complete
(one cosmetic follow-up open, [hexokit-site#7](https://github.com/sahil87/hexokit-site/pull/7)).
**2026-09-11: the formula rename and the GitHub repo rename moved to a final
Phase 3 (R1, R2) at Sahil's request; roster fields move with them.**
**Phase 1 complete (2026-09-12)**: C1 merged and released (shll v0.1.31);
C7 done in all six repos; C3a merged as [run-kit#952](https://github.com/sahil87/run-kit/pull/952)
(`mljj`, the prose half split out of #950). The app-identity half is
**parked** as R0 on the rebuilt [run-kit#950](https://github.com/sahil87/run-kit/pull/950)
(draft, retargeted to `main`; do not merge before X2), and C4 (home
migration) sits beside it in Phase 3. **Phase 2 complete (2026-09-12)**: X1 ([hexokit-site#9](https://github.com/sahil87/hexokit-site/pull/9)),
X2 ([shll.ai#104](https://github.com/sahil87/shll.ai/pull/104), live and verified — shll.ai is the redirect
host, `/install` + `/versions.json` still real files) and X4 ([shll#100](https://github.com/sahil87/shll/pull/100))
all merged. **Announce gate: one shll release** so the embedded standards
text stops naming shll.ai (v0.1.32 predates X4). Then announce. Phase 3
(R0 → C4 → R1, R2, then X3) waits for Sahil's call. Cosmetic
[hexokit-site#7](https://github.com/sahil87/hexokit-site/pull/7) still open.
**Phase 3 complete (2026-09-29)**: R0 ([run-kit#950](https://github.com/sahil87/run-kit/pull/950)), C4 ([#1053](https://github.com/sahil87/run-kit/pull/1053)), C5 ([#1054](https://github.com/sahil87/run-kit/pull/1054)), R1, R2 (`sahil87/run-kit` → `sahil87/hexokit`) and X3 ([hexokit#1063](https://github.com/sahil87/hexokit/pull/1063)) are all done — row detail lives in the remaining-work doc; the cosmetic hexokit-site#7 merged 2026-09-13.
**Not closed — open items remain**: A3 (announce hexokit.com — no code, Sahil's call) has not happened, and the Naming tiers' **Brand** row lists surfaces that no row ever covered: the web UI's user-visible `CamelCase RunKit` strings (wordmark, `document.title`, PWA manifest, notification titles, version row) and the `run-kit-frontend`/`run-kit-desktop` npm names — tracked as "Open follow-ups from X3" in the remaining-work doc, beside R2's URL-sweep follow-ups. D5–D12 were executed as written but never marked Confirmed in the Decision log.
---

## Why this shape (the evidence)

- **The name is lost.** `runkit` search → RunKit (Node playground, "Try on
  RunKit" on npm, dead since ~2024, last commit 2023). `"run-kit" tmux agent`
  → zero hits for this project. `hexokit` → one 6-star abandoned 2020 repo
  (a Hexo blog-generator installer); GitHub org, crates.io free. **Homebrew:
  `hexokit` exists in neither homebrew-core nor casks nor any indexed tap
  (checked 2026-09-10), so the tap formula `sahil87/tap/hexokit` is
  claimable now. Plain `brew install hexokit` on an untapped machine does
  **not** work for any tap formula — unprefixed names resolve only against
  homebrew-core and already-added taps; there is no global tap-name registry.
  Making the short form work needs a homebrew-core submission (stable release,
  OSS license, notability ≈ 75 stars / 30 forks) — a possible later row, not
  part of this plan. Nobody holds `hexokit` in core today, so that path is
  open. Conversely homebrew-core already ships a *different* `run-kit`
  (Esubaalew/run, "Universal multi-language runner and smart REPL", 0.10.0) —
  so today an unprefixed `brew install run-kit` installs a stranger's tool.**
  Ownable in weeks.
- **The site contradicts the thesis.** shll.ai hero: "Seven small CLIs that
  force AI agents to plan before they code." Tool order in
  `src/lib/tool-slugs.ts`: idea, hop, fab-kit, wt, run-kit, tu, shll. The
  loop diagram centres fab-kit. Yet `shll`'s own roster (`tools.go`) already
  ranks run-kit first by importance, and the competitive-landscape doc is a
  single-product thesis. The market agrees: the adoption in this space goes
  to dashboards/multiplexers (guppi, herdr, cmux), not planning harnesses.
- **Coupling is to the substrate, not the name.** fab-kit references
  `@rk_pane_agent_state` 92×, `rk mux send` 39×, `rk mux await` 30×, all
  behind `exec.LookPath("rk")`. idea references run-kit 0×. Nothing in any
  repo depends on the *string* `run-kit` except brew, URLs, the config dir,
  and the README banner mandated by the `readme-extraction` standard.
- **The logo already says it.** `assets/logo.svg` is a cube inside a
  flat-top hexagon; shll.ai's logo is a verbatim copy of it. Six sides,
  six companions (fab-kit, wt, idea, tu, hop, desktop). The story is free.

---

## Decision log

| # | Decision | Status | Why |
|---|----------|--------|-----|
| D1 | **HexoKit names the dashboard product.** The family is "the HexoKit toolkit"; the companions keep their names (fab-kit, wt, idea, tu, hop, `shll`) | Confirmed | Approach B; umbrella-only (A) leaves the unsearchable product name in place; a second new name (D, "execute") teaches two names and is generic |
| D2 | **Binary stays `rk`.** `hexokit` becomes the long binary name, replacing `run-kit`, with `rk` the interchangeable alias — exactly today's `run-kit`/`rk` pair. Every `RK_*` env var, `@rk_*` tmux option (90 distinct), `rk-*` socket/session name (`rk-daemon`, `rk-gui`, `rk-test-e2e`, …), the Go module path `rk`, `rk-code-bridge` and its `rk.*` VS Code settings keys, and all `rk-*` CSS classes are **untouched** | Confirmed | ripgrep/`rg`, helix/`hx` precedent. Avoids a live-tmux-state migration that fab-kit also reads. Cross-repo contracts (`docs/specs/agent-state.md`, `cli-layering.md`) survive without a line changed |
| D3 | **Hexo association accepted.** "hexokit" reads as "Hexo kit" to Hexo users; exact-match SERP is empty so the term is ownable | Confirmed | — |
| D4 | **`shll` command stays** as the toolkit manager/installer name for now. Renaming it is out of scope (possible later phase) | Confirmed | Typed by few, near-zero brand exposure; its two network endpoints (`shll.ai/install`, `shll.ai/versions.json`) are baked into shipped binaries |
| D5 | **One website: hexokit.com.** shll.ai is folded, not kept beside it — two brands for one toolkit is the mistake being corrected. shll.ai stays registered forever as a 301 host, plus the two live endpoints in D4 | Proposed | — |
| D6 | **hexokit.com is a single-product site** in the guppi.sh / herdr.dev shape (hero → screenshot → install one-liner → features → toolkit → footer), *on top of* the existing Starlight docs layer, which moves under it unchanged. See § Site shape | Proposed | The landing page is the thing that was missing; the docs pipeline is the thing that works |
| D7 | **URL scheme.** HexoKit's own docs live at `/docs/…`; the companions keep the root-slug shape `/fab-kit/…`, `/wt/…` etc. that shll.ai already emits, so the sync pipeline and redirects are mechanical: `shll.ai/run-kit/* → hexokit.com/docs/*`, `shll.ai/<tool>/* → hexokit.com/<tool>/*`, `shll.ai/getting-started/* → hexokit.com/toolkit/*` | Proposed | Two redirect rules, zero pipeline changes for the six companions |
| D8 | **Electron**: `productName` "Run Kit" → "HexoKit", `artifactName` → `hexokit-desktop-…`; **`appId` `ai.shll.run-kit` is kept** so installed apps keep their identity/settings. Roster entry `rk-desktop` keeps its name (it's a CLI verb, `rk desktop`) | Proposed | appId is invisible to users; changing it makes the app a stranger to the OS |
| D9 | **On-disk homes migrate once, silently.** `~/.config/run-kit/` → `~/.config/hexokit/` (the `config-home` standard fixes the dir to the full tool name); `$XDG_STATE_HOME/run-kit/` → `…/hexokit/`; browser `runkit-*` localStorage keys → `hexokit-*`. Each is read-old-then-write-new on first run, old left in place for one release, then dropped | Proposed | Silent settings loss (theme, keybindings, macros, sidebar geometry) would be the one user-visible regression of the rename |
| D10 | **Install one-liner is product-first.** `curl -fsSL hexokit.com/install \| sh` installs `shll` + `hexokit` by default and prints the toolkit hint; the toolkit page offers the full install. Same script as today's `shll.ai/install` (it already takes tool args) with a changed default | Proposed | A product site whose install line pulls seven binaries reads as a bundle, not a product. Needs the `install-composition` standard's Policy B wording moved to hexokit.com |
| D11 | **Historical text is not renamed.** `fab/` change archives and plans, `docs/memory/` narrative, git history, old PR titles keep "run-kit". Only live surfaces (README, docs/site, specs' present-tense identity lines, code identifiers in the brand tier) change | Proposed | ~60 % of the 9,500 `run-kit` occurrences are archives; rewriting history is churn with no reader |
| D12 | **"kit" twice (HexoKit, fab-kit) is accepted.** If it ever grates, the fix is renaming fab-kit to `fab` (its binary already is), not touching HexoKit | Proposed | — |
| D13 | **Site repo is a copy, not a rename; shll.ai's repo is never renamed.** `git clone --mirror` of `sahil87/shll.ai` pushed to a new **`sahil87/hexokit-site`** (full history, all branches/tags). hexokit.com is built and published there while shll.ai stays live and untouched. At cutover, the `shll.ai` repo's *contents* are replaced in place with the redirect stub (CNAME `shll.ai`, redirect pages, byte copies of `/install` + `/versions.json`) — no new repo, no rename, GitHub redirects and history intact. No `hexokit.com`-named repo is ever created (avoids the `shll`/`shll.ai` twin-name confusion). Site is not folded into the product repo: its daily sync crons commit to `main` and would pollute the product's history and CI | Confirmed | Sahil's ordering: nothing irreversible happens until the site has been tested end to end on the real domain. One repo carries one Pages deployment + one custom domain, so two live domains need two repos regardless. Lost in the copy: only the site repo's issues/PRs/stars (near zero) |
| D14 | **The standards are not renamed.** `shll standards` stays the command, the nine documents stay in the shll repo at `docs/site/standards/` and embedded in the `shll` binary, run-kit's constitution keeps citing `shll standards`, and the `shll-toolkit` skill dir + rc sentinel stay. Only *content* changes, in two passes: **C1** edits the mandated README blockquote (→ "Part of [HexoKit](https://hexokit.com) — see all projects there") and `install-composition` Policy B's install-docs location; **X4** (Phase 2) flips the 32 `shll.ai` mentions that name the consuming site ("shll.ai pulls and renders", "owned by shll.ai") to hexokit.com and the nine "[shll toolkit](https://shll.ai)" intro phrases to "HexoKit toolkit". The consumer extractor matches any leading blockquote (`BLOCKQUOTE_RE` in `extract-readme.ts`), so the banner text change is free on the pipeline side | Confirmed | Sahil asked whether the standards need renaming — they don't, and never did; `shll` is the toolkit manager, a tool name like `hop`. The blockquote still changes because it is the most visible cross-repo brand surface (first line under the H1 on seven repo pages) and leaving it reintroduces the two-brand split for a saving of seven lines. The domain mentions are a correctness fix (shll.ai stops being the consuming site at X2), so they wait for Phase 2 |
| D15 | **Every repo stays under `sahil87`; the product repo is renamed to `sahil87/hexokit` at R2.** The `hexokit` GitHub handle is unavailable (account flagged by GitHub abuse review and hidden; rename/org path blocked; support tickets filed 2026-09-23), so the plan neither waits for nor targets it. A same-day 2026-09-12 decision to move `hexokit-site` there was cancelled for the same reason. If the org materialises later, moving repos into it is separate work; a transfer after a rename keeps the redirect chain | Confirmed | Sahil, 2026-09-25: "I do not have the hexokit account handle yet … we will stick to the sahil87 account handle like we had planned earlier" |
| D16 | **Brand HexoKit; binary stays `rk`; `xk` is added as an alias.** Command names: `hexokit` (long), `rk` (canonical short — every doc, skill, help line, and example), `xk` (alias, mentioned once), `run-kit` (hidden legacy alias for one release). Stylized "heXoKit" rejected: people type it three ways and search splits. `hk` rejected: homebrew-core ships `hk` (jdx's git-hook manager), a `bin/hk` link conflict for anyone with both. Replacing `rk` rejected: fab-kit calls it ~100×, `rk agent setup` hooks and skills embed it | Confirmed | Sahil, 2026-09-25. `xk` is free in homebrew-core (checked 2026-09-25). Lands in R0 (cobra alias + completions) and R1 (formula symlink) |
| D17 | **The daemon port gets a config.yaml key**, env form kept and winning (code default < config.yaml < `RK_PORT` < flag). Amends constitution IV, which made the port env-only | Confirmed | Sahil, 2026-09-25. Without it C4's "pin existing installs" step had nowhere to write, so C5's 6123 default would silently move every user who never set `RK_PORT` — breaking their Tailscale Serve mappings. Also gives users a durable, documented way to move. Row P3 in the remaining-work doc |

---

## Naming tiers

| Tier | Identifiers | Action |
|------|-------------|--------|
| **Brand** (user reads it) | GitHub repo `sahil87/run-kit`; tap formula `run-kit`; long binary `run-kit`; README H1/tagline/banner; `docs/site/*` (10 pages); shll roster `Name`/`Formula`/`Repo`; shll.ai slug tables + sidebar; Electron `productName`/`artifactName`; `~/.config/run-kit/`; `$XDG_STATE_HOME/run-kit/`; `runkit-*` localStorage keys; `run-kit-frontend`/`run-kit-desktop` private npm names; `CamelCase RunKit` in user-visible strings; sahil87 profile README; homebrew-tap README (still points at stale `ai.shll.in`); Discord/OG/JSON-LD on the site | **Rename** |
| **Substrate** (machines read it) | `rk` binary; ~90 cobra verbs; `RK_*` (43 vars); `@rk_*` (90 options); `rk-daemon`/`rk-gui`/`rk-ctl`/`rk-jobs`/`rk-test-e2e-*` sockets & sessions; Go module `rk`; `rk-code-bridge` + `rk.*` settings; `rk-*` CSS; `rk agent setup` hook names; release asset names `rk-<os>-<arch>` | **Keep** |
| **Historical** | `fab/changes`, `fab/plans`, `docs/memory` prose, PR/commit history | **Leave** (D11) |

Rough live-surface size: 30–50 files across the five repos plus the three
standards documents. The 9,500-occurrence grep count is not the work.

---

## Site shape (hexokit.com)

Answering the open question from the thread: **yes, the homepage is a
star-tool page like guppi/herdr, and no, the companion docs do not go away —
they move one level down, pipeline intact.**

Three layers, one Astro site (the existing `sites/astro-starlight-terminal1`
fork, or a sibling variant per shll.ai's multi-site constitution):

1. **`/` — product landing.** Custom page, not the Starlight docs template.
   Carries run-kit's own visual vocabulary (monospace, hexagon mark, accent
   green, the CRT/typed-cursor treatments already in `globals.css`) so the
   site and the app look like one thing. Sections, in order:
   - Hero. Working tagline is already in the README: **"Your tmux, in the
     browser and on your phone."** Sub-line from the landscape doc: *Cockpit
     for the agent era.* Desktop + phone screenshot side by side (shll.ai
     already curates `public/screenshots/run-kit-*.webp`).
   - Install one-liner (D10) + `brew install sahil87/tap/hexokit`.
   - Features, five or six cards, each with a real screenshot: every pane a
     live terminal from any device · agents are just panes (state via hooks,
     agent-agnostic, "the agent is one of the things you run") · `rk riff`
     — one agent per worktree, watch the fleet · boards + status pyramid ·
     cron clock + operator · code / web / GUI tiles.
   - "Nothing wraps your agent" — the agent-agnostic paragraph from the
     README, verbatim-ish. This is the differentiator vs herdr/cmux.
   - **The toolkit hexagon.** The cube-in-hexagon mark with the six
     companions on the six edges — fab-kit, wt, idea, tu, hop, desktop —
     one line each, linking into `/toolkit/` and each tool's subtree. This
     is where the current shll.ai loop diagram's content survives, reframed
     around the product.
   - Desktop app card (today the app has no page anywhere).
   - Footer: Docs · Toolkit · GitHub · Discord · versions.json · llms.txt.
2. **`/docs/…` — HexoKit docs.** Starlight. Synced from run-kit's
   `docs/site/` exactly as today (install, tutorial, boards, notifications,
   agent-hooks, status-dot, customizing-tmux, cron-schedule-kinds, skill +
   topics) plus the help-dump command reference. First-class nav item.
3. **`/toolkit/` + `/<tool>/…` — the family.** `/toolkit/` absorbs today's
   Getting started (overview, philosophy, daily flow, "start a new change")
   rewritten from "seven CLIs" to "HexoKit and the six tools around it".
   Each companion keeps its synced Overview / Readme / Commands / docs-site
   pages at the root slug (D7). The daily README/help-dump crons keep
   running with one slug change (`run-kit` → `hexokit`, output to `/docs/`).

What is deliberately *not* on the homepage: the seven-tool table, the
install-everything-first flow, fab-kit's pipeline diagram (it lives at
`/fab-kit/` and on `/toolkit/`).

Navigation: `Docs · Toolkit · Desktop · GitHub`. shll.ai's `/llms.txt`,
`/llms-full.txt`, `/versions.json`, `/.well-known/security.txt` move as is.

---

## Change breakdown

Three phases. **Phase 0 builds the new site beside the old one with nothing
irreversible; Phase 1 does the renames; Phase 2 is the cutover flip.** One
row = one PR (S1 is a one-off git operation, not a PR). Rows in the same
block can run in parallel. Agents: fill folder/PR when you create the change.

### Phase 0 — build hexokit.com beside shll.ai (reversible; shll.ai untouched)

| # | Repo | Slug (suggested) | Depends on | Size | Scope | PR | Status |
|---|------|------------------|-----------|------|-------|----|--------|
| S1 | hexokit-site (new) | *(git op, no fab change)* | — | S | `git clone --mirror sahil87/shll.ai` → push to new `sahil87/hexokit-site` (create with `gh auth switch --user sahil87`). Disable the copied cron workflows until S3 lands so they don't scaffold a second run-kit tree | — | **done** — repo created private, 40 branches mirrored (PR hidden-refs rejected as expected), `Refresh: Help`/`Refresh: README` workflows disabled |
| S2 | hexokit-site | `hexokit-domain-and-deploy` | S1 | S | CNAME → `hexokit.com`; Namecheap DNS → Pages (A/AAAA + `www` CNAME); verify the domain on the `sahil87` account; `site:` in astro.config; deploy workflow green on the new repo. Site is live but unannounced | [hexokit-site#1](https://github.com/sahil87/hexokit-site/pull/1) | **done** — merged 2026-09-10; hexokit.com live over HTTPS (enforced), www/http 301 to the apex, hexokit.dev 301s to hexokit.com; repo flipped public (free plan has no private Pages); DNS applied out of band. Remaining manual: account-level domain verification in GitHub Settings → Pages |
| S3 | hexokit-site | `hexokit-site-structure` | S2 | M | D7 URL scheme: slug table gets `hexokit` → output `/docs/`, **source repo still `sahil87/run-kit`** (one field flips in X2); companions unchanged at root slugs; `/toolkit/` from getting-started; re-enable both crons with the new map; nav `Docs · Toolkit · Desktop · GitHub`; llms.txt, JSON-LD, OG, favicon regen | [hexokit-site#3](https://github.com/sahil87/hexokit-site/pull/3) | **merged** 2026-09-10 (fab change `it5d`) — single roster module `src/lib/tool-roster.mjs`; `/docs/` + `/toolkit/` + thin `/desktop/` mounts; `HeaderNav.astro`; enumerated redirects; HexoKit JSON-LD/OG/llms.txt; Copilot-reviewed, CI green. Post-merge operator step: `gh workflow enable` both Refresh workflows + one `gh workflow run` each (`--ref main`), verify `help/run-kit.json`/`content/run-kit/` do not reappear. Found in flight: `versions.json` keeps its `run-kit` row until C1 (shll `check-updates` matches roster `Name`) via a new `envelope` policy field; favicon regen was a no-op (logo already the HexoKit mark) |
| S4 | hexokit-site | `hexokit-landing` | S2 | L | D6 landing page + design iteration (§ Site shape). Hand-written, so it is on-brand from day one even while `/docs/` still reads "run-kit" | [hexokit-site#4](https://github.com/sahil87/hexokit-site/pull/4) | **merged** 2026-09-10 (fab change `lvnp`) — `/` on a StarlightPage splash wrapper; hero → install → seven feature cards (incl. a full-width operator-console card) → "Use any agent, untouched" → toolkit hexagon → desktop card → footer; assets OCR-triaged from Sahil's Desktop pool, tight card crops; copy per hexokit-site `docs/findings/landing-copy-study.md`; terminal island retained unmounted. Design accepted; #2 (`jwhx`) closed. Follow-up open: [hexokit-site#7](https://github.com/sahil87/hexokit-site/pull/7) footer alignment |
| S5 | hexokit-site | `hexokit-install-script` | S3 | S | D10: `/install` served from the same script with the product-first default; the `install-composition` Policy B text prepared for C1 | [hexokit-site#8](https://github.com/sahil87/hexokit-site/pull/8) | **merged** 2026-09-11 (fab change `d11j`) — deploy-time composition of the product-first default onto the shll install script; default stays `run-kit` (roster name) until R1 |

### Phase 1 — brand prose, no renames, nothing installed changes (shll.ai live; repo, formula, roster, app identity, on-disk homes untouched)

| # | Repo | Slug (suggested) | Depends on | Size | Scope | PR | Status |
|---|------|------------------|-----------|------|-------|----|--------|
| C1 | shll | `hexokit-banner-and-policy` | S4 accepted | S | **No rename of the standards (D14). Roster untouched (→ R1/R2).** Content only: `readme-extraction` §2 blockquote → "Part of [HexoKit](https://hexokit.com) — see all projects there"; `install-composition` Policy B install-docs location → hexokit.com; `config-home` example → `hexokit`; `versions.json` URL constant → hexokit.com (shll.ai kept as fallback); `shll skill` bundle prose. Leave every other `shll.ai` / "shll toolkit" mention for X4 | [shll#98](https://github.com/sahil87/shll/pull/98) | **merged** 2026-09-11, **released as shll v0.1.31** (tag = merge commit) — fab change `ttoa`; blockquote, Policy B, config-home example, ordered manifest URLs (hexokit.com primary, shll.ai fallback), skill prose; roster untouched |
| C3a | run-kit | `hexokit-brand-prose` | C1 | S | **Prose only, zero runtime effect** — split out of [run-kit#950](https://github.com/sahil87/run-kit/pull/950) (2026-09-12, Sahil: the app rename is the disruption to defer). README H1/tagline/identity prose (badge URLs stay `sahil87/run-kit` until R2); `docs/site/*` identity lines + skill H1s; the embedded `cmd/rk/skill/*.md` (byte-identical to `docs/site/skill*` per the skill standard, so it moves with them); `docs/specs/*` present-tense identity lines; memory hydrate. **Nothing that changes a command name, an app name, a bundle, an asset, or a path.** This is what X1's docs refresh needs | [run-kit#952](https://github.com/sahil87/run-kit/pull/952) | **merged** 2026-09-12 (fab change `mljj`, split out of #950; CI green, Copilot's one comment skipped with reason). X1 is unblocked |
| C7 | fab-kit + wt, idea, tu, hop, sahil87 | `hexokit-banner-sweep` | C1 | S each | fab-kit [#668](https://github.com/sahil87/fab-kit/pull/668) · wt [#59](https://github.com/sahil87/wt/pull/59) · idea [#50](https://github.com/sahil87/idea/pull/50) · tu [#77](https://github.com/sahil87/tu/pull/77) · hop [#70](https://github.com/sahil87/hop/pull/70) · sahil87 [#1](https://github.com/sahil87/sahil87/pull/1) | **done** — all six merged 2026-09-11; sahil87 profile row renamed + broken install line fixed |

S5 (Phase 0) is unaffected but its default must be `shll install run-kit`
(roster name) until R1 flips the roster; the script's *prose* says HexoKit.

### Phase 2 — site cutover (irreversible for shll.ai only; announce after)

| # | Repo | Slug (suggested) | Depends on | Size | Scope | PR | Status |
|---|------|------------------|-----------|------|-------|----|--------|
| X1 | hexokit-site | `hexokit-site-cutover-prep` | C3a, C7 merged | S | Redirect map for the old shll.ai paths ready (D7) — also `shll.ai/workflows/* → hexokit.com/toolkit/*` and `shll.ai/tools/* → hexokit.com/tools/*` (both hop once more in-site; S3 left static redirects for every old path). **Slug-table source stays `sahil87/run-kit`** (flip → R2); refresh crons run once so `/docs/` carries the C3a README | [hexokit-site#9](https://github.com/sahil87/hexokit-site/pull/9) | **merged** 2026-09-12 16:51 UTC (fab change `1u4q`) — build-time `/shll-ai-redirects.json` mapping every URL shll.ai ever served to its final hexokit.com page, completeness-checked; cron seed. Live |
| X2 | shll.ai | `shll-ai-redirect-stub` | X1 live | S | [shll.ai#104](https://github.com/sahil87/shll.ai/pull/104) | **merged + live** 2026-09-12 16:54 UTC (fab change `sn0a`) — verified: `/`, `/run-kit/`, `/fab-kit/install/`, `/getting-started/philosophy/` and unknown paths all serve meta-refresh + canonical to the mapped hexokit.com page; `/install` serves the script (`application/octet-stream`, `#!/bin/sh`) and `/versions.json` real JSON — the byte-copy requirement holds. shll.ai is now the permanent redirect host |
| X4 | shll | `standards-consumer-site-sweep` | X2 live | S | [shll#100](https://github.com/sahil87/shll/pull/100) | **merged** 2026-09-12 17:36 UTC (fab change `dk8f`) — 34 consuming-site mentions → hexokit.com, intros → HexoKit toolkit. **Not yet released**: latest shll tag v0.1.32 (05:26 UTC) predates the merge, so the embedded `shll standards` text still says shll.ai until the next shll release — cut one before announcing |

### Phase 3 — the two renames, as late as wanted (each a one-sitting bundle)

Deferred at Sahil's request (2026-09-11). Nothing in Phases 1–2 depends on
them: the roster's `Name`/`Formula`/`Repo` are runtime-coupled to the tap
formula and the GitHub repo (`shll install`, `doctor`, `check-updates`), so
each roster field moves *with* its rename, never ahead of it. GitHub redirects
old repo URLs (web, clone, releases, raw) and brew's `formula_renames.json`
handles the tap, so stragglers are covered either way. R1 and R2 are
independent of each other and can be weeks apart. **2026-09-12: the app-identity
half of C3 (now R0) and the on-disk home migration (C4) also moved here — the
rule is that Phases 1–2 change no installed binary's name, no app name, and
no path on a user's machine.**

| # | Repo(s) | Slug (suggested) | Depends on | Size | Scope | PR | Status |
|---|---------|------------------|-----------|------|-------|----|--------|
| R0 | run-kit | `hexokit-app-identity` | X2 live (may be much later) | M | **The app rename — the other half of `mvuv` (#950).** Cobra root command name `hexokit` (`run-kit` kept as hidden alias one release) + shell completions under all three names; help-dump / upgrade strings; Electron `productName` "Run Kit" → "HexoKit", `artifactName` → `hexokit-desktop-…`, `appId` kept (D8), the userData carry-forward of `hosts.json`/`windows.json`; `rk desktop` bundle name + release-asset prefix (`internal/desktop/*`); `fab/project/config.yaml` project name. Sequenced **immediately before R1** because the asset prefix ships with the formula/release bundle | [run-kit#950](https://github.com/sahil87/run-kit/pull/950) | **merged** 2026-09-26 (`3d7afba1`) — detail in the remaining-work doc (was parked 2026-09-12 as the app-identity half of `mvuv`) |
| C4 | run-kit | `hexokit-home-migration` | R0 | M | D9, moved from Phase 1 (2026-09-12, same on-disk-disruption principle): `~/.config/run-kit` → `~/.config/hexokit` (one-time move, dual-read one release); `$XDG_STATE_HOME/run-kit` → `hexokit` (cron entries + snapshots must move; droppable caches may cold-start); `runkit-*` localStorage → `hexokit-*` read-old/write-new. Ride the R0/R1 release | [run-kit#1053](https://github.com/sahil87/run-kit/pull/1053) | **merged** 2026-09-26 (`65407dc2`); tunnel range kept at 3100–3199 — detail in the remaining-work doc. **C5** (daemon default 3000 → 6123, added in the remaining-work doc) merged as [run-kit#1054](https://github.com/sahil87/run-kit/pull/1054) |
| R1 | homebrew-tap → run-kit → shll → hexokit-site | `hexokit-formula-bundle` | X2 live (may be much later) | M | In order, one sitting: **(a)** tap: `Formula/hexokit.rb` (installs `hexokit` + `rk` symlink), `formula_renames.json` adds `run-kit → hexokit` (precedent `rk → run-kit`), README banner + drop stale `ai.shll.in`; **(b)** run-kit: `.github/workflows/release.yml` writes `Formula/hexokit.rb`, `.github/formula-template.rb` name; cut a release; **(c)** shll: roster `Name`+`Formula` → `hexokit`, `LegacyName` gains `run-kit`, `versions.json` row → `hexokit` (retire S3's `envelope` carry-over), release shll; **(d)** hexokit-site: landing shows `brew install sahil87/tap/hexokit`, S5 script default → `hexokit`. Verify `brew upgrade` on a box with the old formula before (c) | homebrew-tap PR#6, [run-kit#1055](https://github.com/sahil87/run-kit/pull/1055), [shll#103](https://github.com/sahil87/shll/pull/103), [hexokit-site#11](https://github.com/sahil87/hexokit-site/pull/11) | **done** 2026-09-28 — release v3.20.22 + shll v0.1.34; brew-upgrade gate verified by Sahil; detail in the remaining-work doc |
| R2 | run-kit → shll → hexokit-site → satellites | `hexokit-repo-bundle` | X2 live (may be much later) | S | One sitting: **(a)** GitHub rename `sahil87/run-kit` → `sahil87/hexokit` (`gh auth switch --user sahil87`; never recreate `run-kit`); **(b)** shll roster `Repo` → `hexokit`, release; **(c)** hexokit-site slug-table source → `sahil87/hexokit`, crons run once; **(d)** run-kit badges/`homepage` fields/formula-template URLs, sahil87 profile + C7 repo links. Redirects cover everything between (a) and (d) | [shll#104](https://github.com/sahil87/shll/pull/104), [hexokit-site#12](https://github.com/sahil87/hexokit-site/pull/12), [hexokit-site#13](https://github.com/sahil87/hexokit-site/pull/13), [hexokit#1060](https://github.com/sahil87/hexokit/pull/1060) | **done** 2026-09-28 — repo renamed to `sahil87/hexokit`; detail in the remaining-work doc |
| X3 | run-kit | `hexokit-memory-hydrate` | R1, R2 | S | Memory + specs identity sweep for present-truth lines only (D11); competitive-landscape one-liner; `context.md`; this plan's Status → Done | [hexokit#1063](https://github.com/sahil87/hexokit/pull/1063) (fab change `zuov`) | **done** 2026-09-29 — the sweep and the doc closures shipped; this plan's Status stays open (see the Status block: A3 + unrowed Brand-tier surfaces) |

Order: S1 → S2 → (S3 ∥ S4) → S5 → *[design accepted]* → C1 → (C3a ∥ C7)
→ X1 → X2 → X4 → *[announce]* → … → (R0 → C4 → R1), R2 (R2 any time, any gap) → X3.
Users on old `shll` binaries keep working via X2's endpoints throughout;
users on the old formula get brew's rename handling at R1.

## Constitution mapping (run-kit)

- **II No Database** — C4 moves files under `$XDG_STATE_HOME`; every moved
  class is either a droppable cache (may cold-start) or the two bounded
  carve-outs (snapshots, seed caches). Nothing becomes authoritative.
- **IV Minimal Surface Area** — no new routes, no settings surface; the
  config key set is unchanged, only its directory (registry-driven).
- **VII Convention Over Configuration** — the config dir still derives from
  the tool name; `hexokit` is now the tool name.
- **Toolkit Standards** — the standards are not renamed (D14); C1 edits the
  content of three before any repo edit, and every later row is checked
  against the revised text.
- **X Hooks Carry Only the Underivable** — untouched; hook names are
  substrate tier.

---

## Risks

- **Silent state loss on rename** (D9). Mitigation: dual-read one release,
  e2e test that seeds old keys/dirs and asserts they are picked up.
- **Formula rename edge cases.** `brew upgrade` with `formula_renames.json`
  has worked once (`rk → run-kit`); verify on a clean box before C2 merges.
- **Electron identity.** Keeping `appId` while changing `productName` is
  supported by electron-builder but macOS may show the old name in some
  system dialogs until re-launch; acceptable.
- **Hexo confusion** (D3). Accepted; mitigate with a one-line "not related
  to the Hexo blog generator" in the GitHub repo description if it comes up.
- **fab-kit skill prose drift.** fab-kit's `_cli-agents.md`/`fab-operator.md`
  mention "run-kit" as the product ~30×; substrate verbs (`rk mux …`) are
  correct and stay. C7 needs a careful present-tense-only pass.
- **Two-site window.** During Phase 0/1 both sites are live: shll.ai
  unchanged, hexokit.com unannounced. Nobody is pointed at hexokit.com until
  X1, so the window is safe; its docs layer reads "run-kit" until then.
- **Two names on one machine (Phase 3 deferral).** Between the announce
  and R1, `brew list` says `run-kit` while the product says HexoKit, and the
  landing page cannot show a `brew install … hexokit` line, and the desktop app,
  the `hexokit` command name, and `~/.config/run-kit` keep their old names
  (R0/C4); between announce
  and R2, README badges and repo links point at `sahil87/run-kit`. Accepted
  by Sahil — the redirect and rename machinery makes both gaps cosmetic.
- **Cron double-scaffold.** hexokit-site's copied cron workflows must stay
  disabled until S3's slug map lands, or they commit a second `run-kit` tree.

---

## Pickup protocol (for the agent taking the next change)

1. Read this doc's Decision log; D1–D4, D13–D15 are Certain, D5–D12 become Certain
   when Sahil marks them confirmed here — do not re-open either set.
2. Phase 0 lives in the new `hexokit-site` repo (S1 creates it). Phase 1
   starts in `shll` (`hop where shll`) and is standards-first by design:
   run `shll standards` and read `readme-extraction`, `install-composition`,
   `config-home`, `update` before editing. Do not start Phase 1 until Sahil
   has accepted the S4 landing page.
3. Substrate identifiers (`rk`, `RK_*`, `@rk_*`, `rk-*`) are never renamed
   under this plan. If a change appears to need it, stop and add a row here.
4. Update the Status line and your row when you create/merge a change.
