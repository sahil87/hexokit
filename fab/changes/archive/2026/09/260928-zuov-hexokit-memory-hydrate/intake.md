# Intake: HexoKit Memory Hydrate (rebrand row X3)

**Change**: 260928-zuov-hexokit-memory-hydrate
**Created**: 2026-09-29

## Origin

> Phase 3 of the HexoKit rebrand, plan row X3 — the LAST step of this whole rebrand effort
> (fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md). (1) Memory + specs identity sweep for
> present-truth lines only (rule D11) — update lines that state run-kit as the product's CURRENT
> name; do NOT rewrite historical narrative, past-tense change descriptions, or "why we did X"
> explanations. (2) Competitive-landscape one-liner. (3) `context.md` stale run-kit-as-current-identity
> lines. (4) Close both plan docs — X3 row done, Status → Done, Order line strikes X3; for the master
> plan (26-09-10-hexokit-rebrand.md) confirm every row is actually done, and if not, note it rather
> than force-closing. (5) Full pipeline: /fab-new then /fab-fff. Do not merge the PR.

One-shot operator request. Before this intake the session surveyed every `run-kit`/`RunKit`/`Run Kit`
hit in `docs/memory/` and `docs/specs/` (1,944 raw hits → 279 after dropping links, change IDs,
backticked identifiers, and the append-only `log*.md` files) and read the candidates. The decisions
below come from that survey.

## Why

The product has been HexoKit since R0 (`hexokit` root command, Electron `productName`), R1 (formula
`sahil87/tap/hexokit`, shll roster `Name` → `hexokit` in shll v0.1.34), and R2 (GitHub repo
`sahil87/run-kit` → `sahil87/hexokit`). A handful of memory lines still state the pre-R1/R2 naming as
present truth — "`run-kit` is the still-installed long, roster, and formula name until the rebrand
plan's R1/R2 rows" — which is now false, and an agent loading memory would act on it (e.g. telling a
user to `shll install run-kit` as the canonical name, or believing the formula is still `run-kit`).

The earlier C3a pass (#952, `260911-mljj-hexokit-brand-prose`) already moved the specs'
present-tense identity lines ("HexoKit is a terminal orchestrator", spec H1s) to HexoKit, so this
sweep is small and targeted: it fixes the name-fact lines that were correct *until* R0/R1/R2 and
became stale when they shipped. Rule D11 forbids a blanket replace — about 60 % of the occurrences
are history, and most of the rest are substrate identifiers (rule P/D2) or generic "the run-kit
daemon" prose that is not a name assertion.

Closing the two plan docs ends the tracker. The master doc must not be marked Done falsely: the
survey found Brand-tier surfaces (per the master's own Naming tiers table) that no row ever
covered, plus the A3 announce row, which is still open.

## What Changes

### 1. Memory — stale present-truth name-fact lines (edit these lines only)

- **`docs/memory/run-kit/architecture/overview.md:9`** — the product-identity sentence. Replace the
  clause "`run-kit` is the still-installed long, roster, and formula name until the rebrand plan's
  R1/R2 rows (`fab/plans/sahil/26-09-10-hexokit-rebrand.md`)" with present truth: `hexokit` is the
  long command name, the Homebrew formula (`sahil87/tap/hexokit`), the shll roster `Name`, and the
  GitHub repo (`sahil87/hexokit`); `rk` stays the canonical short name, `xk` is an alias, and
  `run-kit` is a legacy alias. The formula symlinks all four, per `.github/formula-template.rb:45-48`:
  ```ruby
  bin.install "rk" => "hexokit"
  bin.install_symlink bin/"hexokit" => "rk"
  bin.install_symlink bin/"hexokit" => "xk"
  bin.install_symlink bin/"hexokit" => "run-kit"
  ```
  Keep the rest of the sentence (substrate staying `run-kit`/`rk` by design, homes, dual-read).
- **`docs/memory/run-kit/architecture/cli.md:9`** — replace "the formula symlinks that install each
  name land with the rebrand plan's R1 row, and until then the installed names stay `run-kit` and
  `rk`" with: the `sahil87/tap/hexokit` formula installs `hexokit` plus `rk`/`xk`/`run-kit` symlinks.
- **`docs/memory/run-kit/build-and-release.md:15`** — "while the roster/binary/formula names stay
  `run-kit` until the rebrand plan's R1/R2 rows" → the formula and shll roster name are `hexokit` as
  well, so the version line's first word matches the tool name. Keep the parse-agnostic point.
- **`docs/memory/run-kit/toolkit-standards.md:1298-1303`** (§ version — PASS) — same stale clause
  ("roster, binary, and formula names stay `run-kit` until R1/R2 … unaffected by the divergence") →
  there is no divergence now: the version line's first word `hexokit` equals the roster name.
- **`docs/memory/run-kit/toolkit-standards.md:11`** — self-identification "run-kit is one of the shll
  toolkit CLIs" → "HexoKit (`rk`) is one of the HexoKit toolkit CLIs". X4 renamed the toolkit intros
  to "HexoKit toolkit"; `shll standards` stays the command name (D14), so leave that as-is.
- **`docs/memory/run-kit/toolkit-standards.md:1360-1362`** — "the `run-kit` tool argument is the
  roster name and stays" → the roster name is `hexokit`; `run-kit` is a legacy name that shll
  ≥ v0.1.34 still resolves (`LegacyNames {rk, run-kit}`). Keep the literal
  `sh -s -- run-kit`, because `docs/site/install.md:10` still passes that argument, so the
  description stays accurate. Changing docs/site is out of scope and listed as a follow-up.
- **`docs/memory/index.md:26`** — the `run-kit` domain row's description "Web-based agent
  orchestration dashboard" → name the product, e.g. "HexoKit — web-based agent orchestration
  dashboard". The link label and path `run-kit` stay (domain folder name).
- **`docs/memory/run-kit/ui/routes-and-shell.md:332`** — says the brand wordmark is "Run Kit" (twice
  on that line). The code renders `RunKit` (`app/frontend/src/components/top-bar.tsx:347`, `:1450`).
  Correct the line to match the code (`RunKit`), not to HexoKit.

**Explicitly kept (D11 / code-accurate / substrate)**:
- Every memory line describing the web UI's live `RunKit` strings: top-bar/sidebar wordmark and
  `aria-label="RunKit home"`, `document.title` `RunKit — {hostname}`, PWA manifest `name`/`short_name`
  `RunKit`, the `sw.js`/push/shell notification default title `RunKit`, the overflow-menu version
  row `RunKit v{version}`, `singleRunKit`. These describe current code accurately. Renaming the
  strings is a code change, recorded as a follow-up.
- `docs/memory/run-kit/` domain folder, the `# run-kit Memory Domain` / `# run-kit UI — …` /
  `# run-kit Architecture — …` domain headings, `**Domain**: run-kit` lines, all `log*.md` files.
- Generic present-tense prose that names the product without asserting its name ("the run-kit
  daemon", "run-kit's settings registry", "outside run-kit", "run-kit system card" — the system card
  line matches the code's `aria-label="run-kit system"`).
- Substrate: `rk`, `RK_*`, `@rk_*`, `rk-*`, `-L runkit`/the `runkit` tmux server, `runkitShell`,
  the `run-kit` hook key (`agent_setup_markers.go:232`), `MOVED-to-run-kit`, `run-kit-desktop.desktop`,
  the `run-kit` code-bridge `category`, `run-kit: rk not found` toast text (all match code).
- Design Decisions / `*Introduced by*` / change-ID citations.

### 2. Competitive landscape one-liner

The only positioning doc is `docs/wiki/competitive-landscape.md` (indexed from
`docs/specs/index.md:53`, whose row already says "Where HexoKit sits"). It is a dated study
("Written during an exploratory discussion session (2026-07-01)") and says run-kit throughout.
- Add one line to the header blockquote, e.g.: `> **Name (2026-09):** the product is now **HexoKit**
  (hexokit.com, binary \`rk\`) — renamed partly because "run-kit" was unsearchable next to the defunct
  RunKit Node playground; "run-kit" below is the name at the time of writing, and the positioning is
  unchanged.` Link the rebrand plan (`../../fab/plans/sahil/26-09-10-hexokit-rebrand.md`).
- Prefix the closing `**One-liner:**` quote with the name: *"HexoKit — Cockpit for the agent era …"*.
- Do NOT rewrite the body, the capability matrix row, or the competitor entries (dated narrative).

### 3. Specs — the update-check example in `docs/specs/api.md` (~lines 500-521)

The self row is now reported as `hexokit` (shll ≥ v0.1.34; `internal/updatecheck` keeps the name
shll reported — `isSelfTool` matches `hexokit` or legacy `rk`/`run-kit`). Update the example
`"tool": "run-kit"` → `"hexokit"`, `"key": "run-kit@3.9.0"` → `"hexokit@3.9.0"`, and the bullet
"`current`/`latest` — legacy run-kit-row compat fields (populated only when run-kit is in the notable
set)" → the self-row (HexoKit: `hexokit`, or legacy `rk`/`run-kit`) compat fields.

**Specs kept**: `design.md`'s "Run Kit"/RunKit branding lines (lines 67, 183, 203-204, 442). They
match the still-`RunKit` web UI, and #24 is a dated design decision; they change together with the
UI-strings follow-up. Also kept: example session names (`run-kit / zsh`, `"name": "run-kit"`, paths
under `sahil87/run-kit`), rollout tables naming the repo (`agent-messaging.md`, `cli-layering.md`),
`architecture.md`/`project-plan.md` historical trees, `ui-state.md:440`, and the `shll.ai` URL in
`specs/index.md:49`, which still redirects and belongs to the URL sweep follow-up.

### 4. `fab/project/context.md`

There is no `docs/context.md`; the file is `fab/project/context.md`. It has no run-kit identity
sentence. Its one stale name line is the Mobile Responsive Design bullet
"persisted to `runkit-terminal-font-size`": C4 migrated `runkit-*` keys to `hexokit-*`, and the
code key is `hexokit-terminal-font-size` (`app/frontend/src/contexts/chrome-context.tsx:24`).
Update that key only.

### 5. Close the plan docs

**`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`**:
- X3 row: PR column → this PR; Status → **done**, with a one-line summary of what changed and what
  was deliberately left.
- Order line: `· X3.` → `· ~~X3~~.`
- Status paragraph + "Where we are": Phase 3 **Done** (2026-09-29). **A3 (announce hexokit.com)
  remains open**: it involves no code and is Sahil's call. Say this plainly; do not mark A3 done.
- Add to the open follow-ups list (none of these are filed; each is a Brand-tier item from the
  master's Naming tiers table that no row covered, or a D2 violation found here):
  1. The web UI's user-visible `RunKit` strings: top-bar/sidebar wordmark + `RunKit home` aria-label
     (e2e selectors key on it), `document.title`, PWA `manifest.json` `name`/`short_name`,
     notification default titles (`sw.js`, `push.ts`, `shell-notifications.ts`,
     `use-push-subscription.ts`), overflow version row. Master Naming tiers lists "CamelCase `RunKit`
     in user-visible strings" as **Rename**.
  2. Private npm names `run-kit-frontend`/`run-kit-desktop` (Naming tiers: Rename). Also the
     code-bridge `publisher`/`displayName` (`run-kit` / "run-kit Code Bridge") and palette
     `category: "run-kit"`.
  3. `docs/site/install.md` still uses `run-kit …` command examples and `sh -s -- run-kit`, against
     D2 ("docs … use `rk` only").
  4. `fab/project/constitution.md` title "# run-kit Constitution" and its "run-kit SHALL …" prose.
     This one needs a constitution amendment with a version bump, which is outside X3.

**`fab/plans/sahil/26-09-10-hexokit-rebrand.md`** (master):
- Its Phase 3 table rows still read R0 "parked", C4/R1/R2/X3 "not started". Sync each Status cell to
  **done** with a pointer to the remaining-work doc and the PR (R0 #950, C4 #1053, R1 per shll#103 /
  hexokit-site#11 / #1055, R2 per shll#104 / hexokit-site#12+#13 / hexokit#1060, X3 this PR). Also
  add a one-line C5 (#1054) mention; C5 was added to the remaining doc only.
- Add the one closing line to its Status (the remaining doc's pickup protocol step 4: "when Phase 3
  closes, add one line to the master plan's Status"): Phase 3 complete 2026-09-29.
- **Do NOT flip the master to Done.** State in that Status line why it stays open: A3 is not done,
  and the Brand-tier surfaces listed above have no row. The operator asked for exactly this ("if any
  row is stale/incomplete, note it rather than force-closing").

## Affected Memory

- `run-kit/architecture/overview`: (modify) product-identity sentence → post-R1/R2 naming
- `run-kit/architecture/cli`: (modify) invocation-name/formula-symlink sentence → post-R1 truth
- `run-kit/build-and-release`: (modify) version-output-string bullet's stale R1/R2 clause
- `run-kit/toolkit-standards`: (modify) overview self-identification; version-PASS divergence clause; Policy B `run-kit` argument note
- `run-kit/ui/routes-and-shell`: (modify) wordmark text corrected to the code's `RunKit`
- `docs/memory/index.md` (top-level index row description): (modify) name the product HexoKit

## Impact

Docs-only: `docs/memory/**`, `docs/specs/api.md`, `docs/wiki/competitive-landscape.md`,
`fab/project/context.md`, two plan docs. There are no code, test, or build changes. CI (Backend,
Frontend, Code-bridge, E2E, Desktop) should be unaffected. A red CI run on this PR is therefore a
flake or a pre-existing issue, and gets one bounded investigation before it is treated as real.
Relative links inside edited files must still resolve (see memory note on relative-link breakage).

## Open Questions

- None blocking. The master-plan closure question ("Done" vs "open with reasons") is decided by the
  operator's own instruction to note, not force-close.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Only name-fact / self-identification lines change; generic "the run-kit daemon" prose, domain headings, substrate identifiers, and all log files stay | Rule D11 + operator's explicit instruction ("only lines asserting a current/ongoing truth about the product's name") | S:95 R:90 A:90 D:85 |
| 2 | Certain | Memory lines describing the live `RunKit` web-UI strings stay as-is | Memory mirrors code; the code still renders `RunKit` (top-bar.tsx, manifest.json, sw.js); changing memory would make it lie | S:85 R:90 A:95 D:90 |
| 3 | Certain | routes-and-shell.md:332 "Run Kit" corrected to the code's `RunKit`, not to HexoKit | The line is a brand-string fact that is wrong against current code; correcting to code is the accurate present truth | S:70 R:95 A:85 D:75 |
| 4 | Certain | Competitive landscape gets a header name note + HexoKit-prefixed One-liner; body untouched | Operator asked for a one-line mention; the doc is a dated study (D11 history) | S:80 R:95 A:80 D:70 |
| 5 | Certain | api.md update-check example flips to `hexokit` self row | updatecheck keeps shll's reported name and shll ≥ v0.1.34 reports `hexokit`; example is present-truth about the product's roster name | S:65 R:95 A:85 D:70 |
| 6 | Confident | design.md RunKit/Run Kit branding lines stay until the UI-strings code change | Spec lines match current code; flipping only the spec creates spec/code/memory divergence with no code change in scope | S:60 R:90 A:75 D:65 |
| 7 | Certain | context.md: only the `runkit-terminal-font-size` key changes → `hexokit-terminal-font-size` | Verified in chrome-context.tsx:24; no identity sentence exists in context.md; no docs/context.md exists | S:90 R:95 A:95 D:90 |
| 8 | Certain | Master plan is NOT flipped to Done; gets the closing Phase 3 line + reasons it stays open (A3 + unrowed Brand-tier surfaces) | Operator: "if any row in that doc is stale/incomplete, note it rather than force-closing"; A3 is open and Naming tiers lists un-renamed Brand items | S:90 R:90 A:90 D:85 |
| 9 | Certain | Remaining-work doc: Phase 3 Done, X3 done, Order strikes X3, A3 stated as still open | Operator asked to flip Status to Done; A3 is an announce-gate row outside Phase 3, so Phase 3 closing is truthful | S:80 R:90 A:80 D:70 |
| 10 | Certain | Found gaps (web UI strings, npm/code-bridge names, docs/site/install.md run-kit examples, constitution title) are listed as follow-ups, not fixed here | Code changes and a constitution amendment are out of X3's docs-only scope; operator said not to scope-creep | S:80 R:90 A:80 D:75 |

10 assumptions (9 certain, 1 confident, 0 tentative, 0 unresolved).
