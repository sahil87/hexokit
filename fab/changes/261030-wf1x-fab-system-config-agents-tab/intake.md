# Intake: Agents settings tab for fab-kit's system config

**Change**: 261030-wf1x-fab-system-config-agents-tab
**Created**: 2026-10-30

## Origin

Conversational. A design discussion preceded this intake and produced an approved interactive mock. The intake was then created by a promptless dispatch (`{questioning-mode} = promptless-defer`), so no questions were asked. Decisions that would have needed a question are recorded as deferred rows in `## Assumptions`.

The user's own words:

> I want to be easy to control what the default agent is, what the default worker is and so on.

The synthesized brief: give HexoKit a UI for fab-kit's machine-wide (system) config at `~/.fab-kit/config.yaml`. It should cover the default session agent, the default worker agent, and related dispatch knobs. The user also mentioned `~/.config/hexokit/config.yaml`, but that file already has a UI (the registry-driven Settings dialog: General / Appearance / Shortcuts / All settings), so this change does no work there.

**Approved mock** (reference for layout, controls and copy): `/tmp/claude-1001/-home-sahil-code-sahil87-hexokit-worktrees-smart-cougar/252dcf97-ba72-4ad0-9f33-92f13d3fd629/scratchpad/agents-settings-mock.html`. That path is a session scratchpad and may not outlive the session. Everything in it that matters is reproduced below.

**How the decisions were reached:**
- The first proposal was a palette action that opens `fab/project/config.yaml` in the code tile. The user rejected it: they want the SYSTEM config, with a real UI.
- A separate settings page or dialog was rejected because it violates Constitution IV (single settings surface).
- Having HexoKit read or write the YAML directly was rejected. It violates Constitution III, and it would destroy fab's comment-preserving reference fence.
- Merging fab keys into the "All settings" registry table was rejected because it mixes two owners and two sources.

## Why

1. **Problem.** Choosing which agent CLI HexoKit's fab workflows run on is spread across several places:
   - `agent.session`: what you talk to (fab agent, operator, batch).
   - `agent.workers`: what pipeline stages dispatch to.
   - `agent.profiles.<role>`: per-role overrides.
   - `dispatch.*`: pane, native or headless launch, plus pane geometry.

   All of these live in fab-kit's config cascade. To change them today you either hand-edit `~/.fab-kit/config.yaml` or run `fab config set … --system` in a terminal. You also need to know the key names and the precedence rules (environment > system > project > default). Neither way is visible from the HexoKit dashboard where the agents actually run.
2. **Consequence of not doing it.** Switching the worker fleet from claude to codex or kimi, or dialing just the review role to another provider, stays a terminal-and-docs exercise. Users can't easily see which tier a value comes from, so an environment override silently shadowing a saved value goes unnoticed.
3. **Why this approach.**
   - A curated tab inside the one existing Settings dialog keeps Constitution IV's single settings surface.
   - Wrapping the `fab config` CLI follows Constitution III (Wrap, Don't Reinvent). It also keeps fab's comment-preserving writes, its key validation, and its reference fence intact.
   - Re-reading on every open follows Constitution II (external writes win). fab-kit, the user's shell and `fab config upgrade` all write the same file.

## What Changes

### 1. Placement: a new "Agents" tab in the existing Settings dialog

- `app/frontend/src/contexts/settings-dialog-context.tsx`: the `SettingsTab` union gains `"agents"`:
  `export type SettingsTab = "general" | "appearance" | "agents" | "all" | "shortcuts";`
  `openSettings(tab?)` accepts `"agents"` with no other change to its semantics. A tab-less open still lands on General.
- `app/frontend/src/components/settings-dialog.tsx`: in `SETTINGS_TABS`, insert `{ id: "agents", label: "Agents" }` between Appearance and Shortcuts. The rail order becomes **General, Appearance, Agents, Shortcuts, All settings**. The roving-tabindex and arrow-key logic in `SettingsTabList` already iterates `SETTINGS_TABS`, so it picks this up automatically.
- Do NOT add a new route or page, and do NOT add a second settings dialog.
- Do NOT add fab keys to the "All settings" tab. That tab stays the `internal/settings` registry table for hexokit's own config.

### 2. Backend: wrap the fab CLI (never parse-and-rewrite the YAML)

Add a new backend wrapper. Its location is up to apply: a new `app/backend/internal/fabsysconfig/` package, or an extension of `internal/fabconfig`. Today `internal/fabconfig` only reads project-file facts and says the launcher is resolved by shelling out. The existing shell-out pattern to follow is `internal/riff/riff.go` `runFabAgent`: `exec.CommandContext(ctx, "fab", argv...)` with `FabTimeout = 10 * time.Second` and `Output()` so that stderr can't pollute parsed output.

**Rules (Constitution I, II, III, IX, § Process Execution):**
- Every call uses `exec.CommandContext` with an argv slice and a timeout context (10 s, matching `riff.FabTimeout`). Never a shell string.
- Never hold a cache as the authority. Every GET re-runs the reads, so external edits win.
- A write is durable before the HTTP request succeeds. `fab config set` returns only after writing the file, and the POST handler returns only after fab exits 0.
- Reads are `GET`. Mutations are `POST` only, never PUT/PATCH/DELETE.
- Detect fab with `exec.LookPath("fab")`. When it is absent, return `{"installed": false}` and no error.

**CLI surface. These behaviors were verified against fab 2.28.9 during intake:**

| Purpose | Command | Verified behavior |
|---|---|---|
| Schema / descriptions | `fab config explain --json` | JSON array of `{key, default, description, scope, advertise}`. It has 20 rows. Relevant rows: `dispatch.mode`, `dispatch.column_width`, `dispatch.min_cols`, `dispatch.min_rows`, `dispatch.reap_done`, `agent.session`, `agent.workers` (all `scope: both`, `advertise: true`); `agent.profiles` and `providers` (`scope: both`, `advertise: false`, map-valued defaults). It exposes **no per-provider allowed model or effort enums**. |
| Effective values + provenance | `fab config show --origin` | **No `--json` flag exists** (`ERROR: unknown flag: --json`). The output is padded text, one line per leaf: `<key> = <value><spaces># <origin>`. The origin token is one of: an absolute system path (`/home/u/.fab-kit/config.yaml`), an absolute project path, the literal `default`, or an env var name such as `$FAB_AGENT_WORKERS`. Map-valued fields are drilled down per leaf, for example `agent.profiles.doing.provider`, `providers.codex.profiles.review.model` and `providers.claude.interactive_command`. List values are flattened onto one line. The command works outside a fab project: run from `$HOME`, it shows only env/system/default tiers. It runs in about 5 ms. |
| Per-key stack | `fab config show <key> --origin` | One line per tier that defines the key, with the tier labelled, e.g. `agent.workers = claude  # system /home/u/.fab-kit/config.yaml  (effective)` / `… # default  (shadowed)`. |
| Per-role resolution | `fab agent <role> -o yaml` | Returns resolved `provider`, `model`, `effort` and a `source:` map, e.g. `source: {provider: agent.workers, model: agent.profiles.doing, effort: agent.profiles.doing}`. This is the authoritative source for the "inherited" display, because `show --origin` labels an inherited role provider as `# default` (for example `agent.profiles.doing.provider = agy # default` when `agent.workers = agy` lives in the system file). |
| Write | `fab config set <key> <value> --system` | Prints `Set <key> in <path>` and exits 0. It **creates** `~/.fab-kit/config.yaml` if it is absent. It refuses an empty value (`refusing to set … to an empty value … run fab config unset`) and a value containing a YAML comment (`must not contain a YAML comment`). It refuses unknown keys, e.g. `providers.codex.native`, with exit 1. It does **NOT** validate values: `agent.workers bogus` and `dispatch.mode weird` both exit 0. It does **NOT** warn when an env var (`$FAB_AGENT_WORKERS`) shadows the system write; the help's "warning naming the tier that wins" did not fire for the env tier in testing. |
| Reset | `fab config unset <key> --system` | Prints `Unset <key> in <path>`. An absent key is an exit-0 no-op: `<key> is not set; nothing to unset`. |

**Verified upstream bug (out of scope; file it with fab-kit):** with `dispatch.mode: weird` in the system file, `fab agent review -o yaml` panics with a nil-pointer dereference in `config.(*Config).GetDispatchMode`, because it calls `fmt.Fprintf` on a nil writer. HexoKit must therefore never write an out-of-enum `dispatch.mode`.

**Server-side validation before calling fab (Constitution I, plus the missing value validation above):**
- The key must be in the v1 allowlist (§3). Reject anything else with 400 before exec.
- Provider values (`agent.session`, `agent.workers`, `agent.profiles.<role>.provider`) must be one of the provider names in the effective `providers` table, derived from the `providers.<name>.*` lines of `show --origin`. fab-kit ships `claude`, `codex`, `agy` and `kimi`. Do not hard-code this list.
- `dispatch.mode` must be one of `pane | native | headless`.
- `dispatch.column_width` must be an integer from 1 to 99, fab's accepted range. Outside it, fab silently falls back to 45. The mock's input used `min=10 max=90`.
- `dispatch.min_cols` and `dispatch.min_rows` must be positive integers.
- `dispatch.reap_done` must be a bool.
- `agent.profiles.<role>.{model,effort}` must be single-line and non-empty, with no `#` and no leading `-` (so it can't parse as a flag), and must stay under a length cap. Empty means unset.
- `null` means unset, which runs `fab config unset <key> --system`.

**Provenance source — fab-kit ≥ 2.28.11 JSON (clarified, shipped in sahil87/fab-kit#694).** HexoKit does NOT parse `show --origin` text; it decodes these verified contracts with `encoding/json`:
- `fab config show --origin --json` → array of `{key, value, origin, origin_detail, status}` rows, one per leaf (typed `value`; `origin` ∈ `default|env|system|project`; `origin_detail` = file path or env var name, empty for default; `status` = `effective`). Derived role defaults carry `derived_from: {key, origin, origin_detail}` — e.g. `agent.profiles.doing.provider` → `derived_from.key = agent.workers` — so the inherited-cell display reads this directly (no `fab agent <role>` calls needed for provenance).
- `fab config show <key> --origin --json` → that key's tier stack, winner first, each row `status: effective|shadowed` (supplies `systemValue` when env wins).
- `fab config set … --system` now validates: out-of-enum `dispatch.mode`, unknown providers (for session/workers/profile provider), non-bool `reap_done`, and out-of-range `column_width` exit 1 with a message naming the allowed values; an env-shadowed write exits 0 and prints `fab: warning: <key> is shadowed by env $FAB_… — the written value is not in effect` on stderr. `set`/`unset` round-trip flow-style profile maps (`review: { model: …, effort: … }`) in the real system file. HexoKit still validates server-side first (Constitution I) and surfaces fab's stderr message verbatim on a 4xx.
- Observed hazard for the UI: fab does not validate provider×model pairs — with `agent.workers: codex` and a system `agent.profiles.review.model: claude-…`, `fab agent review` resolves `provider: codex, model: claude-…`. The role table SHOULD flag a model override whose value isn't in the resolved provider's suggestion list (a warning, not a block). <!-- clarified: wrap fab ≥2.28.11 JSON contract -->

**Working directory (clarified).** The daemon runs every fab read and write from `$HOME` (a neutral, non-project directory). The view is therefore strictly machine-wide — env, system and default tiers only. The `project` origin is never expected; if it appears it is rendered as a read-only chip, not an error. The API takes no window/server parameter. <!-- clarified: fab runs from $HOME, machine-wide view -->

**Proposed endpoints.** These follow the existing `/api/settings` pattern: GET returns metadata plus values, and POST is a partial merge where present keys are set and `null` unsets.

```
GET  /api/fab-config        → 200 document below (or {"installed": false})
POST /api/fab-config        body: {"agent.workers": "codex", "agent.profiles.review.model": null}
                            → runs set/unset sequentially, then re-reads and returns the fresh document
                              plus "warnings": [...] (verbatim fab stderr warnings, if any)
                            → 400 on allowlist/validation failure (no exec), 502/500 with fab's stderr on non-zero exit
```

```jsonc
// GET /api/fab-config (proposed shape)
{
  "installed": true,
  "systemPath": "/home/u/.fab-kit/config.yaml",
  "providers": ["agy", "claude", "codex", "kimi"],          // from providers.<name>.* lines
  "fields": {
    "agent.session":        { "value": "claude", "origin": "system",  "originDetail": "/home/u/.fab-kit/config.yaml", "description": "…" },
    "agent.workers":        { "value": "kimi",   "origin": "env",     "originDetail": "FAB_AGENT_WORKERS", "systemValue": "codex" },
    "dispatch.mode":        { "value": "pane",   "origin": "system" },
    "dispatch.column_width":{ "value": 45,       "origin": "default" },
    "dispatch.min_cols":    { "value": 50,       "origin": "default" },
    "dispatch.min_rows":    { "value": 20,       "origin": "default" },
    "dispatch.reap_done":   { "value": true,     "origin": "default" }
  },
  "roles": [   // order: default, operator (session) · doing, fast, hydrate, review (workers)
    { "role": "doing", "depth": "workers",
      "provider": { "override": null,  "effective": "claude",            "source": "agent.workers" },
      "model":    { "override": "claude-sonnet-5-5", "effective": "claude-sonnet-5-5", "source": "agent.profiles.doing" },
      "effort":   { "override": "high", "effective": "high",            "source": "agent.profiles.doing" } }
  ],
  "modelSuggestions": { "claude": ["claude-opus-5-5", "claude-sonnet-5-5"], "codex": ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-sol"], "agy": ["gemini-3.1-pro-high", "gemini-3.6-flash-low"], "kimi": [] },
  "effortSuggestions": ["low", "medium", "high", "xhigh", "max"]
}
```

`systemValue` covers the shadowed case: an env override wins while a system value also exists. The per-key `fab config show <key> --origin` stack can supply it, but only for the keys whose winner is `env`. `override` is set only when the leaf's origin is `system`. Values from a project-tier leaf are shown as their origin and are not editable here.

### 3. v1 key set (machine-wide-settable keys only)

| Group | Key | Control |
|---|---|---|
| Agents | `agent.session`: what you talk to (fab agent, operator, batch). Session roles: `default`, `operator` | latched segmented chips, one per provider |
| Agents | `agent.workers`: what pipeline stages dispatch to. Worker roles: `doing`, `fast`, `hydrate`, `review` | latched segmented chips, one per provider |
| Agents | `agent.profiles.<role>.{provider,model,effort}` for roles `default`, `operator`, `doing`, `fast`, `hydrate`, `review` | per-role override table (§4) |
| Dispatch | `dispatch.mode`: `pane \| native \| headless` | latched segmented chips |
| Dispatch | `dispatch.column_width`: percent | number input + `%` |
| Dispatch | `dispatch.min_cols` / `dispatch.min_rows` | two number inputs on one row: `[50] cols × [20] rows` |
| Dispatch | `dispatch.reap_done`: bool | `BoolToggle` |

Not shown:
- Project-only keys (`fab/project/config.yaml`: `project.*`, `source_paths`, `test_paths`, `stage_hooks`, `docs_index.roots`, …).
- Collection-valued keys (the `providers` table).
- `autopilot.merge_mode`. It is `scope: both`, advertised and machine-wide settable, but it is not in the user's v1 list (Assumptions #20). <!-- assumed: autopilot.merge_mode excluded from v1 — not in the user's enumerated set -->

### 4. UI: the Agents tab panel

Reuse the existing settings primitives from `settings-dialog.tsx`, `text-setting-core`, `settings-all-panel` and the Control primitive. Do not add a new visual vocabulary.

**Structure (matches the approved mock):**

```
Agents  ~/.fab-kit/config.yaml · machine-wide, outranks project files      ← ScopeHeading
  Session agent   (What you talk to: fab agent, operator, batch)  agent.session
      [claude][codex][agy][kimi]   ⟨system⟩ ●  reset
  Worker agent    (What pipeline stages dispatch to)              agent.workers
      [claude][codex][agy][kimi]   ⟨env⟩
      ⚠ An environment variable sets codex for the daemon, so the system value is shadowed.
        Changes here are saved but don't take effect until that variable is unset.
  Per-role overrides (Optional. Change one role without moving the whole tier.)  agent.profiles.<role>
      role     | tier     | provider   | model              | effort  |
      default  | session  | ↳ claude   | ↳ provider default | ↳ …     |
      operator | session  | claude     | …                  | …       | reset
      doing    | workers  | ↳ kimi     | …                  | …       |
      fast     | workers  | …
      hydrate  | workers  | …
      review   | workers  | …

Dispatch  how worker stages are launched                                    ← ScopeHeading
  Dispatch mode        (Preference ceiling: pane → native → headless)   dispatch.mode   [pane][native][headless]
  Worker column width  (Pane-worker column, % of window)                 dispatch.column_width  [45] %
  Split floor          (Below this, the worker opens in its own window) dispatch.min_cols  [50] cols × [20] rows
  Reap finished panes  (Close a worker's pane when its stage is done)   dispatch.reap_done  (toggle)

Footer: The providers table and other list/map keys can't be set from the CLI.
        Open ~/.fab-kit/config.yaml in the code tile ↗
        Project-only keys (fab/project/config.yaml) aren't shown here.
```

**Row anatomy.** `PreferenceRow` grid with a 190px label column. Each row has:
- a label, a sublabel, and the key in small type;
- the control;
- a **provenance chip** (`system` / `env` / `default`) taken from fab's JSON provenance (fab runs from `$HOME`, so `project` does not occur);
- a **modified dot** when a system-scope override exists for that key;
- a **"reset" link** (→ `fab config unset <key> --system`) shown **only** when a system override exists.

**Per-role table.**
- Columns: role | tier (session/workers) | provider | model | effort | reset.
- An unset cell shows the inherited value, dimmed, with a `↳` prefix. For example `↳ kimi` when the provider is inherited from `agent.workers`, or `↳ provider default` (or the resolved value from `fab agent <role> -o yaml`) for model and effort.
- Choosing the blank or inherit option unsets that leaf.
- A row's reset unsets all three `agent.profiles.<role>.*` system leaves in one POST.
- In the mock, provider, model and effort cells are `<select>`s with a first `↳ inherited` option. Model and effort have no fab-provided enum, so their exact control is Tentative (Assumptions #17). <!-- assumed: model = free text + datalist from providers.<p>.profiles.*.model; effort = select low/medium/high/xhigh/max + inherit -->

**Env-shadow warning.** When a key's effective origin is `env`, render an inline amber warning on that row. The warning says the saved system value won't take effect until the variable is unset. Derive it from provenance, because `fab config set --system` does not emit an env warning (verified). Also surface verbatim any warnings fab prints on stderr after a write.

**fab not installed.** When `installed: false`, the tab shows only the scope heading (`fab-kit · this machine`, `~/.fab-kit/config.yaml`) and a graceful empty state: "fab isn't installed on this host. Install fab-kit to manage agent defaults here." There are no error toasts and no console errors.

**Write flow.**
- Chips and the toggle commit on change.
- Number inputs commit on blur or Enter, following the existing `TextSetting` commit idiom rather than committing per keystroke. Escape reverts.
- After each POST, the panel re-renders from the fresh document the POST returns.
- A failed write shows fab's stderr inline on that row and leaves the previous value in place.

**Freshness.** The tab fetches `GET /api/fab-config` every time it becomes visible: on dialog open while on Agents, and on switching to the Agents tab. It never relies on a client cache.

**Phone collapse.** At the dialog's single `min-[480px]:` breakpoint, the rail becomes a horizontal strip and rows stack, like the rest of the dialog. The per-role table must not cause horizontal page scroll. The mock wraps it in a `.rolewrap` container that scrolls internally.

**Footer "open in code tile" link.** HexoKit has no existing frontend seam that opens an arbitrary absolute path in the code tile. The tile is keyed to the window's git root. A candidate mechanism exists: the code bridge (`rk code exec vscode.open '{"$uri":"file:///home/u/.fab-kit/config.yaml"}'` against the current window's code-server host, via `internal/codebridge`). Mechanism and fallback are Tentative (Assumptions #19). <!-- assumed: open via code-bridge vscode.open on the active window's code host; fall back to a copy-path affordance when no host/window -->

### 5. Keyboard-first (Constitution V)

- Add a palette entry `Settings: Agents` (id `settings-agents`) → `openSettings("agents")` in `app/frontend/src/hooks/use-global-palette-actions.ts`. It sits next to the existing `Settings: Open`, `Settings: Appearance` and `Settings: All` entries and follows their naming.
- If the footer's "Open ~/.fab-kit/config.yaml" action ships as a real action, it also needs a palette entry (e.g. `Settings: Open fab system config`).
- All controls inside the tab are keyboard-operable: the chips are buttons, the inputs are native, and the table cells are native selects or inputs.

### 6. Constitution amendment (signed off)

Constitution IV currently says the single settings surface is "backed by the `internal/settings` registry". A curated tab backed by the fab CLI stretches that wording. This change includes a small clarifying amendment to `fab/project/constitution.md`, bumping the MINOR version from 2.2.0 to 2.3.0 and setting Last Amended to the merge date. It states that the single settings surface MAY host one curated tab for fab-kit's system config (`~/.fab-kit/config.yaml`), backed by the fab CLI per Principle III, and that this is not a second settings surface. Wording (user confirmed, Assumptions #23):

> … with exactly ONE carve-out: a single registry-driven settings surface (singular by design) backed by the `internal/settings` registry; no second settings surface may be added. That surface MAY also host a curated tab for fab-kit's machine-wide config (`~/.fab-kit/config.yaml`), read and written exclusively through the `fab config` CLI (Principle III) — HexoKit never parses or rewrites that file itself.

### 7. Tests and PR evidence

- **Go unit tests**:
  - Parser for `show --origin` text, using the verified line formats above as fixtures: system, project, default, `$FAB_*`, values containing `#` or quotes, and flattened lists.
  - Origin-to-tier mapping.
  - Allowlist and value validation, with a 400 before exec.
  - The argv shape for set/unset.
  - The `installed:false` path.
  - The handler partial-merge and `null` → unset behavior.

  Run fab through an injectable runner seam so tests never call the real binary or touch the developer's `~/.fab-kit/config.yaml`.
- **Vitest**:
  - Agents panel rendering: chips, provenance chip, modified dot, reset visibility, `↳` inherited cells, env warning, the not-installed empty state.
  - The palette entry.
- **Playwright e2e and `just demo`** (Constitution § PR Evidence): desktop 1280×800 and mobile 375×812, with before (no Agents tab) and after recordings. Tests MUST NOT write the developer's real `~/.fab-kit/config.yaml`. Note: running fab with an isolated `HOME` triggered the fab shim's network fetch (`Fetching fab-kit v2.28.9...`) during intake. The e2e approach is therefore a stub `fab` on the rig's PATH, or an isolated HOME with the kit pre-provisioned. Assumptions #21 covers this. <!-- assumed: injectable runner seam for unit tests + stub fab on the rig PATH for e2e/demo + one real-fab isolated-HOME pass --> § PR Evidence also requires that correctness depending on an external integration be exercised against that integration, so at least one verification pass should use the real fab binary against an isolated HOME.

## Affected Memory

- `run-kit/ui/dialogs-and-state`: (modify) the Settings dialog gains the curated Agents tab (rail order, fab-backed data source, provenance chips, reset, env-shadow warning, not-installed state, phone collapse).
- `run-kit/ui/keyboard-and-palette`: (modify) adds the `Settings: Agents` palette entry, plus the open-fab-config action if it ships.
- `run-kit/configuration`: (modify) documents that fab-kit's system config is surfaced (not owned) by HexoKit: the two config homes (`~/.config/hexokit/config.yaml` via the registry vs `~/.fab-kit/config.yaml` via the fab CLI), the cascade env > system > project > default, and the v1 key set.
- `run-kit/api-and-sockets`: (modify) the new `GET /api/fab-config` and `POST /api/fab-config` routes and their body contract.
- `run-kit/architecture/backend-packages`: (modify) the new or extended Go package that wraps `fab config explain/show/set/unset` and `fab agent <role> -o yaml`.
- `run-kit/architecture/testing`: (modify) only if a stub-`fab` e2e harness or an isolated-HOME seam is added.

## Impact

- **Backend**:
  - New wrapper package (or `internal/fabconfig` extension).
  - New handler file `app/backend/api/fab_config.go`, with tests, registered in `app/backend/api/router.go` next to `/api/settings`.
  - No changes to `internal/settings`.
- **Frontend**:
  - `contexts/settings-dialog-context.tsx` (union).
  - `components/settings-dialog.tsx` (`SETTINGS_TABS`, a new `AgentsPanel`). This could instead be a new `components/settings-agents-panel.tsx` to keep `settings-dialog.tsx`, already 720 lines, from growing.
  - `api/client.ts` (typed `getFabConfig` / `postFabConfig`).
  - `hooks/use-global-palette-actions.ts` (palette entry).
  - Tests.
  - If the Control primitive's emitted classes change, the `/__controls` gallery baselines are affected (code-quality.md). Avoid changing them.
- **Governance**: `fab/project/constitution.md` (Principle IV amendment, version 2.3.0).
- **Specs (human-curated, flag only)**: `docs/specs/api.md` may want the new routes.
- **External dependency**: fab ≥ 2.28.9 on the daemon host's PATH, degrading gracefully when absent. The daemon's environment determines the `env` tier HexoKit sees. It may differ from the environment of agents launched in tmux.
- **Security**: user-supplied values reach a subprocess. They pass as argv elements (no shell) after allowlist and validation checks (Constitution I).
- **Performance**: one GET runs about 1 + 1 + 6 fab invocations (show --origin, explain --json, six `fab agent <role> -o yaml`). Each took about 5 ms or less locally. Running them concurrently is optional.
- **Upstream (separate, out of scope)**: two fab-kit items to file.
  - The `fab agent` nil-writer panic on an invalid `dispatch.mode`.
  - The missing env-tier warning on `set --system`.
  - A `--json` flag for `fab config show --origin`, if decided (Assumptions #24).
- **Observed machine state at intake** (reference only):
  - The system file sets `dispatch.mode: pane`, `agent.session: claude`, `agent.workers: claude`, and per-role model and effort for all six roles.
  - The user's discussion cited `agent.workers: kimi` and `agent.profiles.operator.provider: claude`. Those values have since changed, or were mock data.

## Open Questions

- How should the footer link open `~/.fab-kit/config.yaml` in the code tile? There is no existing seam; the code-bridge `vscode.open` is the candidate. What is the fallback on pages with no window or code host?
- Model and effort controls: fab exposes no enum. Should they be free text with suggestions (derived from `providers.<p>.profiles.*`), or a select with a fixed effort list as in the mock?
- Should `autopilot.merge_mode`, which is machine-wide settable, join the v1 set?

## Clarifications

### Session 2026-10-30

| # | Question | Answer |
|---|----------|--------|
| 23 | Constitution IV amendment wording and version step? | Accepted the §6 draft wording; MINOR bump to 2.3.0. |
| 24 | Parse `show --origin` text in Go, or add `--json` to fab-kit first? | Add `--json` to fab-kit first; HexoKit wraps the JSON. |
| 25 | Run fab reads from `$HOME` or the active window's project? | `$HOME` — machine-wide view, no `project` chip. |

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Placement is a new curated "Agents" tab inside the existing Settings dialog, between Appearance and Shortcuts. Rail order: General, Appearance, Agents, Shortcuts, All settings. `SettingsTab` and `openSettings(tab)` gain `"agents"`. No new route, page or dialog. | Discussed. User chose this explicitly; a separate page or dialog was rejected (Constitution IV). | S:95 R:85 A:90 D:95 |
| 2 | Certain | The backend wraps the fab CLI (`explain --json`, `show --origin`, `set --system`, `unset --system`). HexoKit never parses-and-rewrites `~/.fab-kit/config.yaml`. | Discussed. Direct YAML editing was rejected (Constitution III; it would destroy fab's comment-preserving fence). | S:95 R:70 A:95 D:95 |
| 3 | Certain | Values are re-read fresh every time the tab opens or becomes active. No cache is authoritative. Writes are durable before the HTTP request succeeds. | Discussed. Constitution II (external writes win; durable before acknowledged). | S:90 R:80 A:95 D:90 |
| 4 | Certain | Reads are GET and mutations are POST only. All subprocess calls use `exec.CommandContext` with argv slices and timeouts (10 s, like `riff.FabTimeout`). | Discussed. Constitution I, IX and § Process Execution; mirrors the existing `riff.runFabAgent` pattern. | S:90 R:80 A:95 D:90 |
| 5 | Certain | The v1 key set is `agent.session`, `agent.workers`, `agent.profiles.<role>.{provider,model,effort}` for default/operator/doing/fast/hydrate/review, and `dispatch.mode`/`column_width`/`min_cols`/`min_rows`/`reap_done`. | Discussed. User enumerated the set; the per-role table is explicitly in v1. | S:95 R:85 A:85 D:90 |
| 6 | Certain | Provider choices come from the effective `providers` table (derived from `providers.<name>.*` lines in `show --origin`) and are not hard-coded. | Discussed. User specified it; verified that `show --origin` lists `providers.{agy,claude,codex,kimi}.*`. | S:90 R:85 A:90 D:90 |
| 7 | Certain | Reuse the existing settings primitives: `ScopeHeading` ("Agents" with the hint "~/.fab-kit/config.yaml · machine-wide, outranks project files", and "Dispatch" with "how worker stages are launched"), the `PreferenceRow` 190px grid with sublabel and small key, latched segmented chips via the Control primitive, number inputs, and `BoolToggle`. | Discussed and shown in the approved mock. | S:90 R:85 A:90 D:90 |
| 8 | Certain | Each row has a provenance chip (system/project/env/default), a modified dot when a system override exists, and a "reset" link (→ `unset --system`) only when a system override exists. | Discussed and in the approved mock. | S:90 R:85 A:90 D:90 |
| 9 | Certain | Per-role table: role, tier, provider, model, effort, reset columns. Unset cells show the inherited value dimmed (`↳ kimi`). Choosing blank unsets the leaf. | Discussed and in the approved mock. | S:90 R:80 A:85 D:85 |
| 10 | Confident | The env-shadow warning is derived from provenance (`$FAB_*` origin), and any fab stderr warning after a write is surfaced verbatim. | Discussed: user wanted the shadow warning. Verified that `fab config set --system` emits no env-tier warning, so provenance must drive it. | S:80 R:80 A:80 D:70 |
| 11 | Certain | When `fab` is not on the host PATH (`exec.LookPath`), the tab shows the "fab isn't installed on this host" empty state with no errors. | Discussed and in the approved mock. | S:90 R:85 A:90 D:90 |
| 12 | Certain | The tab works at the 480px single-breakpoint phone collapse (rail becomes a strip, rows stack), and the role table scrolls inside its wrapper rather than the page. | Discussed. It is the existing dialog idiom (context.md, Mobile Responsive Design). | S:85 R:85 A:90 D:85 |
| 13 | Certain | Add palette entry `Settings: Agents` (id `settings-agents`) → `openSettings("agents")`, next to `Settings: Open/Appearance/All`. | Discussed (Constitution V). The label follows the existing naming in `use-global-palette-actions.ts`. | S:80 R:90 A:85 D:75 |
| 14 | Certain | fab keys are NOT added to the "All settings" tab. Project-only and collection-valued keys are not shown; the footer explains this. | Discussed. Merging into the registry table was rejected as mixing owners and sources. | S:90 R:85 A:90 D:90 |
| 15 | Confident | Endpoints are `GET /api/fab-config` (document with installed, providers, fields, roles, suggestions) and `POST /api/fab-config` (partial merge `{key: value-or-null}` → sequential set/unset, then a fresh re-read). | Mirrors the existing `/api/settings` GET plus partial-merge POST contract. A map body lets the per-role reset unset three leaves in one request. | S:55 R:80 A:75 D:60 |
| 16 | Confident | The backend validates before exec: key allowlist, provider ∈ the effective providers, mode ∈ {pane, native, headless}, column_width 1..99, positive min_cols/min_rows, bool reap_done, and single-line model/effort with no `#` and no leading `-`. | Verified that fab `set` accepts `agent.workers bogus` and `dispatch.mode weird` (exit 0), and an invalid mode makes `fab agent` panic. Constitution I requires validating user input. | S:60 R:80 A:80 D:70 |
| 17 | Tentative | Model is free text with a datalist of suggestions built from the effective `providers.<p>.profiles.*.model` for the row's resolved provider. Effort is a select of `low/medium/high/xhigh/max`, as in the mock, with an inherit option. | Verified that fab exposes no allowed-model or effort enum (explain --json has none). Provider profiles give real model IDs. The open question was flagged as unverified. | S:40 R:70 A:40 D:30 |
| 18 | Confident | Per-role inherited values and sources come from `fab agent <role> -o yaml` (resolved provider/model/effort + `source:` map), not from the `show --origin` label. | Verified: `show --origin` labels an inherited role provider `# default` even when it comes from the system `agent.workers`; `fab agent` reports `source.provider: agent.workers`. | S:45 R:80 A:70 D:50 |
| 19 | Tentative | Footer "Open ~/.fab-kit/config.yaml in the code tile" uses the code bridge (`vscode.open` with a `$uri` file URI) on the active window's code-server host. Where there is no window or host, a copy-path affordance is shown instead. Any resulting action also gets a palette entry. | The user asked for the link, but no seam exists today: the code tile is git-root keyed, and the `rk code exec` bridge is the only candidate found. The mechanism and fallback are guesses. | S:35 R:40 A:25 D:20 |
| 20 | Tentative | `autopilot.merge_mode` (scope `both`, advertised, machine-wide settable) is excluded from v1. | The user's enumerated v1 set omits it; it is cheap to add later. | S:40 R:80 A:30 D:40 |
| 21 | Tentative | Test isolation: Go and Vitest tests use an injectable fab runner seam; Playwright/demo uses a stub `fab` on the rig PATH (or an isolated HOME with the kit pre-provisioned); at least one real-fab pass runs against an isolated HOME. | Discussed constraint: never write the developer's real config. Verified that an isolated HOME makes the fab shim fetch the kit over the network. The exact harness is a guess. | S:45 R:70 A:45 D:30 |
| 22 | Confident | The constitution amendment is included in this change (Principle IV clarification, MINOR bump 2.2.0 → 2.3.0). | Discussed: the user asked for the amendment to be included and flagged it for sign-off. Its wording is deferred (#23). | S:75 R:60 A:60 D:60 |
| 23 | Tentative | Constitution IV amendment uses the wording in What Changes §6; MINOR bump 2.2.0 → 2.3.0, Last Amended set to the merge date. | Clarified — user confirmed | S:95 R:40 A:0 D:10 |
| 24 | Tentative | Add a `--json` output to fab-kit's `fab config show` (per-leaf value + origin) upstream first; HexoKit wraps that JSON — no Go text parser for `show --origin`. | Clarified — user confirmed | S:95 R:25 A:15 D:15 |
| 25 | Tentative | The daemon runs fab from `$HOME`: a machine-wide view of env/system/default tiers only; no `project` chip, no window parameter on the API. | Clarified — user confirmed | S:95 R:30 A:10 D:10 |

25 assumptions (13 certain, 5 confident, 7 tentative, 0 unresolved).
