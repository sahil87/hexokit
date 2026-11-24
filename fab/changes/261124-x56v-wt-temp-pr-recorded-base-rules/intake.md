# Intake: `--temp`, `--pr` and the recorded base in the run rules and chat skill

**Change**: 261124-x56v-wt-temp-pr-recorded-base-rules
**Created**: 2026-11-24

## Origin

> Execute step T10 (--temp, --pr and the recorded base in the run rules and chat skill) of the plan at
> /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first
> (Decisions and Rules bind you), then implement only the T10 Brief.

One-shot `/fab-new`, spawned as step T10 of the operator-triggers plan (queue mode `merge-auto`). The plan's
**T10 Brief** (verbatim — it is the spec for this change):

> - `brief_rules.md` § Merging: the temporary detached worktree for a restack or conflict round is
>   `wt create --temp <observed-head-sha> --fetch --json` (cleanup `wt delete <name>`), never raw
>   `git worktree add --detach`; a fix on a PR's head is `wt create --pr <n>`. The PR base for a plain
>   item is read from `wt list --json` (`base`) in the item's repo when the brief does not carry it.
> - `rk skill operator`: hand spawns the user explicitly asks for are
>   `rk riff -L <server> -- --base origin/<branch> --fetch` (the `--` passthrough), tracked with
>   `track add`; the gotcha that `--reuse` and `--base` no longer combine.
> - Tests: the render test asserts the `wt create --temp` text and that `git worktree add` is absent
>   from the rules; skill drift guards.
> - Docs: `operator-brief.md`, `docs/site/skill/operator.md` + sync.

Binding plan context: T9 (#1185, merged — `wt` v0.1.8 receipt adopted in riff and the engine) is the
predecessor. Plan Rule 5: a change touching a CLI-facing doc surface updates the `rk skill operator` topic in
the same change (CLI ⇒ docs + tests). Plan Rule 6: no UI change ⇒ the PR states
`No recording: internal CLI/engine behavior` (here: run-rules and skill text only) plus its validation.
Plan Non-goals: no change to the queue engine's spawn path, fab-kit, or fab pipeline skills.

## Why

`wt` v0.1.8 (sahil87/wt PRs #62–#66) added exactly the primitives the operator's run rules currently
hand-roll with raw git:

- **`wt create --temp <ref>`** — a detached throwaway worktree at a ref (name prefixed `tmp-`, no branch, no git
  config, init skipped). Today § Merging tells an unattended run to do `git fetch origin` then
  `git worktree add --detach <tmp> <observed-head-sha>` and later `git worktree remove <tmp>`: the run must
  invent a `<tmp>` path, it bypasses `wt`'s naming/location conventions (worktrees land outside
  `<repo>.worktrees/`, invisible to `wt list`), and the cleanup is a second raw git verb. Constitution III
  ("Wrap, Don't Reinvent") says worktree management goes through the toolkit, not raw git.
- **`wt create --pr <n>`** — a worktree on a PR's head branch (resolved via `gh pr view`). The recovery spawn for a
  red check today is described loosely as "a fresh worktree on the PR's branch" via `rk riff`, leaving the run to
  work out the branch name and the checkout flags itself.
- **The recorded base** (`branch.<name>.wt-base[-sha]`, surfaced as `base`/`base_sha` in `wt list --json`) — the
  start point a worktree's branch was created from. A plain item's PR base is carried on the brief's `queue:` line
  only when the entry set `base`; for a hand spawn or an entry without `base`, the run has no record and guesses.
- **`--reuse` + `--base` is now a usage error** (exit 2; `--reuse` + `--fetch` too). The chat skill's hand-spawn
  guidance (`rk riff` for a scratch tab) predates this and never mentions it, so a chat composing
  `rk riff -- --reuse --base …` hits a hard error.

If this is not done: runs keep creating stray detached worktrees outside `wt`'s view (nothing cleans a run that
dies mid-restack), the recovery spawn stays under-specified, PR-base decisions for plain items stay guesses, and
hand spawns from the chat fail on the v0.1.8 usage error. The approach is text-only (rules + skill + memory +
tests) because T9 already moved riff and the engine onto the receipt; this step makes the *AI-facing* rules match
the tool. Alternative rejected by the plan: keeping raw `git worktree add` "because it works" — the Brief says
"never raw `git worktree add --detach`".

## What Changes

### 1. Run rules — `app/backend/internal/operator/brief_rules.md`

**§ Role, direct-action allowlist (line ~17–20).** `git` loses `worktree` from its verb list — worktrees are made
and removed through `wt` only:

```
`git` (fetch, rebase, cherry-pick, push with `--force-with-lease` only), `gh pr ready|merge|edit|checks|view`, `wt`
(`create --temp|--pr`, `delete`, `list --json`), and `rk riff -L <server>` (the recovery spawn in Merging)
```

**§ Confirmation tiers, Recoverable row.** "creating and removing the temporary worktree you made yourself" stays,
phrased as `wt create --temp` / `wt delete` of the `tmp-` worktree you made yourself.

**§ Merging, `stacked-prs` steps 1–5** become (the observed-head and `<old-base>` recording and the retarget are
unchanged):

```
  1. `wt create --temp <observed-head-sha> --fetch --json` in the item's repo: the temporary detached
     worktree. `--fetch` refreshes `origin` first; the receipt's `path` is `<tmp>` and its `name`
     (prefixed `tmp-`) is what you delete
  2. in `<tmp>`: `git rebase --onto origin/<default> <old-base>`
  3. `git push origin HEAD:<branch> --force-with-lease=<branch>:<observed-head-sha>`
  4. merge when its checks are green and the user's word covers this item, then
     `wt delete <name> --non-interactive`
```

The separate `git fetch origin` step is dropped (the `--fetch` on `wt create` does it). Never
`git worktree add --detach` / `git worktree remove`.

**§ Merging, conflict paragraph.** "resolve, in that temporary worktree" now names it as the `wt create --temp`
worktree; on failure: abort the rebase, `wt delete <name> --non-interactive`, note, `rk notify`.

**§ Merging, red-check paragraph.** The recovery spawn becomes concrete:
`rk riff -L <server> -- --pr <n>` (riff's `--` passthrough runs `wt create --pr <n>`: a fresh worktree on the
PR's head branch), an agent told to fix the failing check and push, tracked as a ledger item. One round each, then
note + notify — unchanged.

**PR base for a plain item.** In the queue-items / plain-item rule (the paragraph near line ~132–136 that says a
`plain` item is judged like a no-fab item), add: the PR base is the `queue:` line's `base` when set; otherwise read
`base` for the item's branch from `wt list --json` in the item's repo (strip a leading `origin/`); a null `base`
means the repo's default branch. Use it wherever the run needs the plain item's base (checking the PR targets it,
`gh pr edit --base`).

**§ Allowed tools.** The git-writes line drops `git worktree`; `wt` is spelled out:
`git fetch`, `git rebase`, `git cherry-pick`, `git push --force-with-lease`; `wt create --temp|--pr`,
`wt delete`, `wt list --json`.

Constraint: the rules file stays ≤ 40 960 bytes (test-enforced) — the edits are near byte-neutral.

### 2. Chat skill — `docs/site/skill/operator.md` (synced byte-identical to `app/backend/cmd/rk/skill/operator.md`)

**§ Spawning agents, the hand-spawn paragraph** (currently: "An explicit request for an **untracked scratch tab** is
the only case where you may start one yourself, with `rk riff` or `rk tab new -- <cmd>` …") becomes:

> A hand spawn — an agent the user explicitly asks you to start yourself rather than queue — is
> `rk riff -L <server> -- --base origin/<branch> --fetch` (riff's `--` passthrough hands the flags to `wt create`;
> `<branch>` is the default branch unless the user names one), then `rk operator track add <id> --kind pane --pane
> <pane> --repo <repo>` so the check watches it. It is not an engine queue item: nothing may depend on it. A
> plain shell tab is `rk tab new -- <cmd>`. Every other request for an agent is a queue entry.

**§ Merging** (the chat's mirror of the run rules) gets the same edits as §1: `wt create --temp
<observed-head-sha> --fetch --json` / `wt delete <name>` replacing `git fetch origin` + `git worktree add --detach`
+ `git worktree remove`; the recovery spawn is `rk riff -L <server> -- --pr <n>`.

**§ Gotchas** gains one bullet: `wt` v0.1.8 refuses `--reuse` with `--base` (and with `--fetch`) — exit 2; a reused
worktree keeps its branch, so pass `--reuse` alone (with `--name`), or drop it to start fresh from a base.

The skill's line budget (`TestSkillTopicsWithinLineBudget`) must still hold.

### 3. Tests

- `app/backend/internal/operator/brief_test.go` `TestBriefRules_CoverTheRunContract`: replace the
  `"git worktree add --detach"` want with `"wt create --temp <observed-head-sha> --fetch --json"`, add
  `"wt delete"`, `"-- --pr <n>"`, and the `wt list --json` plain-base text.
- The removed-text test (the one asserting `git push --force ` etc. absent, ~line 396) gains `"git worktree add"`
  and `"git worktree remove"` as must-be-absent strings.
- Skill drift guards: `cmd/rk/skill_test.go` `TestSkillTopicsMatchCanonical` / `TestSkillTopicsPrintByteIdentical`
  pass after the sync (copy `docs/site/skill/operator.md` → `app/backend/cmd/rk/skill/operator.md` via the repo's
  sync mechanism); add an operator-topic content assertion (existing test file pattern) that the topic contains
  `-- --base origin/<branch> --fetch` and the `--reuse` gotcha and does not contain `git worktree add`.
- Golden/render tests for the brief (`cmd/rk/operator_brief_test.go`, any golden under `internal/operator/testdata`)
  are regenerated if they embed the rules text.

### 4. Memory

- `docs/memory/run-kit/operator-brief.md`: the Rules summary paragraph, the allowlist/allowed-tool paragraph, and
  § Merging (`stacked-prs` bullet, conflict + recovery-spawn paragraph) updated to `wt create --temp` /
  `wt delete` / `rk riff -- --pr <n>` and the plain-item base rule; the two-axis spawn bullet's hand-spawn clause
  updated to the `rk riff -L <server> -- --base origin/<branch> --fetch` + `track add` form; a Design Decision
  "Temporary worktrees go through `wt`" (Why: Constitution III, `wt list` visibility, one verb to clean up;
  Rejected: raw `git worktree add --detach`; Introduced by this change).

## Affected Memory

- `run-kit/operator-brief`: (modify) Rules summary, allowlist/allowed tools, § Merging restack/conflict/recovery,
  plain-item PR base, chat-skill hand-spawn clause, new Design Decision "Temporary worktrees go through `wt`"

## Impact

- `app/backend/internal/operator/brief_rules.md` (embedded via `//go:embed`; rendered into every run brief)
- `docs/site/skill/operator.md` and its synced copy `app/backend/cmd/rk/skill/operator.md` (`rk skill operator`)
- `app/backend/internal/operator/brief_test.go`, `app/backend/cmd/rk/skill_test.go`, possibly
  `app/backend/cmd/rk/operator_brief_test.go` / brief goldens
- `docs/memory/run-kit/operator-brief.md`
- No Go logic, no CLI flag, no API, no UI change → no `rk help-dump` fixture change, no recording
  (`No recording: internal CLI/engine behavior — run-rules and chat-skill text`).
- Runtime dependency: `wt` ≥ v0.1.8 on the box (already required by T9's version probe).

**Non-goals** (plan Rule 4 — review bar copied verbatim): **must-fix** = merges, pushes, deletes or spawns the
wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. **Should-fix** = everything else.
Also out of scope: any change to riff or the engine's spawn path (T9 owns it), T11's merge-auto projection text
beyond what already landed, T12/T13, fab-kit or fab pipeline skills.

## Open Questions

- Does `wt create --temp <sha> --fetch` actually fetch `origin` (the help says `--fetch` fetches "the first `--base`
  segment if it is a remote, else origin", and `--temp` is not in `--fetch`'s exclusion list)? Apply verifies in a
  scratch repo; if `--fetch` is refused with `--temp`, the rule keeps an explicit `git fetch origin` before
  `wt create --temp <sha> --json` and the test strings follow.
- Does a branch created with `--base origin/<b>` record `wt-base` as `origin/<b>` or `<b>`? The rule strips a
  leading `origin/` either way; apply confirms with one scratch `wt create`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is exactly the T10 Brief: run rules, chat skill + sync, tests, `operator-brief.md`; no Go logic or CLI surface change | Plan Rules/Brief bind; user said "implement only the T10 Brief" | S:95 R:85 A:95 D:95 |
| 2 | Certain | Restack/conflict temp worktree = `wt create --temp <observed-head-sha> --fetch --json`, cleanup `wt delete <name>`; `git worktree add` absent from the rules | Verbatim in the Brief; test asserts absence | S:95 R:85 A:90 D:95 |
| 3 | Confident | Drop the separate `git fetch origin` step since `--fetch` covers it (fallback to keeping it if `wt` refuses `--temp --fetch`) | Brief's command carries `--fetch`; help lists no `--temp`/`--fetch` conflict; verified at apply | S:70 R:85 A:70 D:75 |
| 4 | Confident | Cleanup uses `wt delete <name> --non-interactive` (temp worktree has no branch, so no branch flags) | Runs are unattended; `wt delete` prompts otherwise; Brief names `wt delete <name>` | S:75 R:90 A:80 D:80 |
| 5 | Confident | Recovery spawn for a red check = `rk riff -L <server> -- --pr <n>` (riff passthrough → `wt create --pr <n>`) | Brief: "a fix on a PR's head is `wt create --pr <n>`"; rules already route recovery through `rk riff`; riff adds no `--base` on the CLI path | S:75 R:85 A:80 D:70 |
| 6 | Confident | `git worktree` removed from the run's git allowlist and allowed-tools line; `wt` verbs spelled out | Brief: "never raw `git worktree add`"; leaving `worktree` allowed contradicts it | S:65 R:85 A:80 D:75 |
| 7 | Confident | Plain-item PR base: `queue:` line `base` if set, else `wt list --json` `base` for the item's branch (strip `origin/`), null ⇒ default branch | Brief names the source; null/`origin/` handling is the obvious completion (observed `base: null` rows and `origin/`-prefixed `--base` from T9) | S:70 R:85 A:70 D:65 |
| 8 | Confident | Chat hand spawn is tracked as a `pane` ledger item via `track add` but is not an engine queue item, so nothing may depend on it; `rk tab new -- <cmd>` stays for a plain shell tab | Brief: "tracked with `track add`" supersedes T8's "untracked"; the no-dependency rule follows from it not being a queue entry | S:65 R:80 A:65 D:60 |
| 9 | Certain | The skill's § Merging mirror gets the same `--temp`/`--pr` edits as the run rules | The skill states it is "the same rules a run follows"; drift otherwise | S:80 R:90 A:90 D:90 |
| 10 | Certain | No recording; PR states `No recording: internal CLI/engine behavior` with validation | Plan Rule 6; no UI surface touched | S:90 R:95 A:95 D:95 |

10 assumptions (4 certain, 6 confident, 0 tentative, 0 unresolved).
