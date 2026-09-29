# Intake: HexoKit Repo URL Sweep

**Change**: 260928-n031-hexokit-repo-url-sweep
**Created**: 2026-09-28

## Origin

> HexoKit rebrand R2(d) in run-kit (plan `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`, R2 row): the GitHub repo was renamed `sahil87/run-kit` → `sahil87/hexokit` (redirects work; this is cleanliness). Update the three URL surfaces named in R2(d) to `sahil87/hexokit`: README badges, the `homepage` field(s), and `.github/formula-template.rb`'s homepage + release-download URLs.

One-shot operator dispatch. R2(a) (the GitHub rename) is done and verified: GitHub redirects web, clone, releases, and raw URLs. R2(b) (shll roster) and R2(c) (hexokit-site slug table) run in parallel in other agents and own the plan-doc R2 row — this change does **not** edit the plan doc. The operator scoped this step to exactly: (1) README badges, (2) `homepage` fields, (3) formula-template URLs.

## Why

1. **Problem**: after R2(a), the three public "where is this project" surfaces — the README badge row, the desktop app's `package.json` `homepage`, and the Homebrew formula (homepage shown by `brew info`, plus the tarball download URLs) — still name `sahil87/run-kit`. They resolve today only through GitHub's rename redirect.
2. **Consequence if not fixed**: the product says HexoKit everywhere except its own repo links; every formula install/upgrade takes a redirect hop on the release download; and the redirect chain is fragile — it dies if anyone ever creates a new `sahil87/run-kit` repo (plan R2 note: "never recreate `run-kit`").
3. **Why this approach**: direct string swaps on the three named surfaces. The rest of the repo's `sahil87/run-kit` mentions (tests, history, memory narrative, runtime constants) are either history (D11) or behavior-bearing code that deserves its own reviewed change — keeping this change narrow keeps it zero-risk.

## What Changes

### README.md — badge row (line 5)

Swap `sahil87/run-kit` → `sahil87/hexokit` in all three shields and their link targets:

```markdown
[![Latest release](https://img.shields.io/github/v/release/sahil87/hexokit)](https://github.com/sahil87/hexokit/releases) [![Downloads](https://img.shields.io/github/downloads/sahil87/hexokit/total)](https://github.com/sahil87/hexokit/releases) [![Stars](https://img.shields.io/github/stars/sahil87/hexokit?style=social)](https://github.com/sahil87/hexokit/stargazers)
```

Only line 5 changes. The README's other `sahil87/run-kit` URLs (the `raw.githubusercontent.com` logo/image URLs on lines 1, 64, 127 and the `blob/main/docs/specs/agent-state.md` link on line 145) are not badges and stay out of scope.

### app/desktop/package.json — `homepage`

`"homepage": "https://github.com/sahil87/run-kit"` → `"homepage": "https://github.com/sahil87/hexokit"`. This is the only `homepage` key in the repo (verified by `git grep`); there is no Go module metadata carrying a homepage.

### .github/formula-template.rb — homepage + download URLs

- `homepage "https://github.com/sahil87/run-kit"` → `homepage "https://github.com/sahil87/hexokit"`
- The four `url "https://github.com/sahil87/run-kit/releases/download/v#{version}/rk-<os>-<arch>.tar.gz"` lines (darwin-arm64, darwin-amd64, linux-arm64, linux-amd64) → `https://github.com/sahil87/hexokit/releases/download/...`

The tarball file names `rk-<os>-<arch>.tar.gz` are **unchanged** (substrate — D2). `release.yml` only substitutes the `VERSION_PLACEHOLDER` / `SHA_*` placeholders, so it needs no change; the new URLs take effect at the next release's tap push.

### Explicitly untouched

`go.mod` module path; every `RK_*` / `@rk_*` / `rk-*` identifier; `internal/desktop` `DefaultRepo`; `internal/push` `vapidSubscriber`; frontend doc-link constants (`global-chrome.tsx`, `row-flyout-card.tsx`); `docs/site/*` back-links; tests and fixtures; `docs/memory/`; `fab/` history; the plan doc.

## Affected Memory

None — no documented behavior changes. `docs/memory/run-kit/build-and-release.md` describes the formula by its tap path and template file, not by URL.

## Impact

Three files, seven URL-bearing lines (one README line, one package.json line, five formula-template lines). No code, no tests affected. The formula change first lands in the tap at the next release. Verification: `git grep sahil87/run-kit` over the three files returns nothing; `ruby -c` on the template (if ruby is available) and `jq` parse of package.json stay valid.

## Open Questions

(none)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Target is `sahil87/hexokit` | Plan rule D15 fixes it; R2(a) rename done and verified by the operator | S:95 R:90 A:95 D:95 |
| 2 | Certain | Scope is exactly README badge line, desktop `homepage`, formula-template URLs | Operator named exactly these three surfaces | S:95 R:90 A:90 D:90 |
| 3 | Certain | Tarball names `rk-*.tar.gz` stay | D2/rule P substrate — only the repo path segment changes | S:90 R:85 A:95 D:95 |
| 4 | Certain | Do not edit the plan doc R2 row | Operator: R2(b)/R2(c) agents touch it in parallel; operator consolidates | S:95 R:90 A:95 D:95 |
| 5 | Confident | No memory update needed | build-and-release memory names the formula by path, not URL; no behavior changes | S:80 R:85 A:85 D:80 |
| 6 | Confident | README non-badge `sahil87/run-kit` URLs stay out of scope | Operator asked for "README badges" specifically; the other README URLs are reported back to the operator as a possible follow-up rather than folded in | S:80 R:90 A:80 D:75 |

6 assumptions (4 certain, 2 confident, 0 tentative, 0 unresolved).
