# Code Quality

## Principles

- Readability and maintainability over cleverness
- Follow existing project patterns unless there's compelling reason to deviate
- Prefer composition over inheritance
- **Go backend**: Use `exec.CommandContext` with timeouts for all subprocess calls — never shell strings
- **Frontend**: Type narrowing over type assertions — prefer `if` guards and discriminated unions over `as` casts
- Disposable daemon (Constitution II) — in-memory state MAY serve reads, but writes are durable (tmux/filesystem) before acknowledgement and the in-memory copy yields to external changes; never write-behind
- User-visible UI changes ship with a `just demo` recording attached to the PR (Constitution § PR Evidence)
- New features and bug fixes MUST include tests covering the added/changed behavior
- UI changes SHOULD include Playwright e2e tests where possible

## Anti-Patterns

- God functions (>50 lines without clear reason)
- Duplicating existing utilities — check `internal/tmux/`, `internal/sessions/`, `internal/fab/`, `internal/inject/` (Go) and `src/api/client.ts` (frontend) first
- Magic strings or numbers without named constants
- Shell string construction for subprocess calls — always use `exec.CommandContext` with argument slices (Go)
- Inline tmux command construction — all tmux interaction goes through `internal/tmux/` (Go)
- Polling from the client — use the SSE stream, not `setInterval` + fetch
- Database/ORM/migration imports — this project has no database by constitution
- Adding routes without explicit spec justification
- Comment narration — comments must state constraints the code can't show (invariants, cross-file contracts, non-obvious "why"); never narrate the next line, mirror sibling code, address the reviewer ("this preserves X"), or cite change IDs / PR numbers (git history owns provenance)

## Verification

Before considering a change complete, run these gates in order:

1. **Go tests** — `cd app/backend && go test ./...`
2. **Frontend type check** — `cd app/frontend && npx tsc --noEmit`
3. **Smoke check** — `just test` (runs backend + frontend + e2e tests)
4. **Production build** — `just build`

**Control-gallery screenshot baselines**: the `/__controls` gallery drift guard is enforced by committed PNG baselines — `app/frontend/tests/e2e/control-gallery.spec.ts` compares fine- and coarse-pointer screenshots against `app/frontend/tests/e2e/control-gallery.spec.ts-snapshots/`. Any change to `control-gallery.tsx` or to classes the Control primitive emits is changed surface for that spec: run `just test-e2e "control-gallery"`, regenerate both baselines, and visually review the PNG diff (only the intended cells should change).

## Test Strategy

### Go backend (`app/backend/`)
Tests live alongside the code they test using Go conventions (`*_test.go` in the same package).

```
api/
  sessions.go
  sessions_test.go
internal/tmux/
  tmux.go
  tmux_test.go
```

### Frontend (`app/frontend/src/`)
Tests use `.test.ts` or `.test.tsx` extension, colocated with source files.

```
src/components/
  sidebar.tsx
  sidebar.test.tsx
  command-palette.tsx
  command-palette.test.tsx
src/api/
  client.ts
  client.test.ts
```
