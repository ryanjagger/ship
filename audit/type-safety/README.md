# Type Safety Audit

Search & Count 'any' types

    rg --glob '*.ts' --glob '*.tsx' --glob '!*.d.ts' --only-matching '(?::\s*|\bas\s+|<|,\s*)any\b|\bany(\[\]|\s*[|&>])' api web shared e2e | wc -l

Search & Count type assertions (as)

    rg --glob '*.ts' --glob '*.tsx' --glob '!*.d.ts' --only-matching '\bas\s+([A-Z][A-Za-z0-9_]*|string|number|boolean|any|unknown|never|void|null|undefined|object|symbol|bigint)\b' api web shared e2e | wc -l

Search & Count non-null assertions (!)

    rg --glob '*.ts' --glob '*.tsx' --glob '!*.d.ts' --only-matching '[A-Za-z0-9_\)\]]!(\.|\[|,)' api web shared e2e | wc -l

Search & Count @ts-ignore / @ts-expect-error

    rg --glob '*.ts' --glob '*.tsx' --glob '!*.d.ts' --only-matching '@ts-(ignore|expect-error|nocheck)' api web shared e2e | wc -l

Search for strict mode

    rg --glob 'tsconfig*.json' '"strict"\s*:\s*(true|false)' tsconfig.json api/tsconfig.json web/tsconfig.json shared/tsconfig.json


---



Baseline measurement of type-safety violations across the Ship monorepo.

**Scope:** `api/`, `web/`, `shared/`, `e2e/` — all `.ts`/`.tsx` excluding `*.d.ts`.
**Date:** 2026-05-18
**Branch:** `audit/type-safety`
**Tool:** ripgrep 15.1.0

## Audit Deliverable

| Metric | Your Baseline |
|---|---|
| Total `any` types | **271** |
| Total type assertions (`as`) | **634** |
| Total non-null assertions (`!`) | **82** |
| Total `@ts-ignore` / `@ts-expect-error` | **1** |
| Strict mode enabled? | **Yes** (all packages) |
| Strict mode error count (if disabled) | N/A |
| Top 5 violation-dense files | see below |

### Top 5 violation-dense files

Combined count of `: any`, `as any`, `as unknown`, non-null assertions, and `@ts-*` directives per file.

**All files (tests dominate):**

| Rank | File | Count |
|---|---|---:|
| 1 | `api/src/__tests__/transformIssueLinks.test.ts` | 38 |
| 2 | `api/src/services/accountability.test.ts` | 32 |
| 3 | `api/src/__tests__/auth.test.ts` | 30 |
| 4 | `api/src/__tests__/activity.test.ts` | 24 |
| 5 | `api/src/routes/issues-history.test.ts` | 20 |

**Production source only (test files excluded):**

| Rank | File | Count |
|---|---|---:|
| 1 | `api/src/routes/admin.ts` | 14 |
| 2 | `api/src/routes/projects.ts` | 13 |
| 3 | `api/src/utils/yjsConverter.ts` | 12 |
| 4 | `api/src/routes/weeks.ts` | 12 |
| 5 | `api/src/routes/workspaces.ts` | 10 |

## Breakdown by package

| Violation | api | web | shared | e2e |
|---|---:|---:|---:|---:|
| `: any` annotation | 70 | 24 | 0 | 4 |
| `as any` | 151 | 7 | 0 | 2 |
| `any[]` (subset of `: any`) | 23 | 0 | 0 | 0 |
| `Record<string, any>` | 2 | 0 | 0 | 0 |
| `as unknown` | 9 | 0 | 0 | 0 |
| `as <UpperCaseType>` | 63 | 212 | 0 | 16 |
| `as <primitive>` (`string`, `number`…) | 38 | 130 | 0 | 3 |
| `@ts-ignore` | 0 | 0 | 0 | 0 |
| `@ts-expect-error` | 0 | 1 | 0 | 0 |
| `@ts-nocheck` | 0 | 0 | 0 | 0 |
| Non-null assertion (`x!.`, `x![`, `x!,`) | 51 | 17 | 0 | 11 |

## Strict mode settings

Root `tsconfig.json` is inherited by `api/` and `shared/`:

```json
"strict": true,
"noUncheckedIndexedAccess": true,
"noImplicitReturns": true,
"noFallthroughCasesInSwitch": true
```

**Gap:** `web/tsconfig.json` does not extend the root. It sets `"strict": true` but is **missing** `noUncheckedIndexedAccess` and `noImplicitReturns`. The same `arr[i]` expression is typed `T | undefined` in api code and `T` in web code.

## How violations were counted

> **Deprecated:** `count.sh` is regex-based and undercounts non-null assertions by ~2.5× (it misses `userId!;`, `userId!)`, and end-of-line forms — the dominant pattern). Use the type-aware ESLint baseline at `audit/type-safety/baseline/summary.md` (produced by `audit/type-safety/lint-report.mjs`) for all remediation tracking. The original script is kept below as historical context.

A helper script `audit/type-safety/count.sh` reproduces the counts, per-package breakdown, top violation-dense files, and strict-mode summary from this audit. It requires `ripgrep` (`rg`) and uses the same grep-based patterns shown below.

Run it from the repo root:

```bash
./audit/type-safety/count.sh
```

The commands below are the underlying one-off measurements used by the script.

```bash
GLOBS=(-g '*.ts' -g '*.tsx' -g '!*.d.ts')

# Total 'any' in type position (deduped across `:any`, `as any`, `<any`, `,any`, `any[]`, `any|`, `any&`, `any>`)
rg "${GLOBS[@]}" -o '(?::\s*|\bas\s+|<|,\s*)any\b|\bany(\[\]|\s*[|&>])' api web shared e2e | wc -l

# TS type assertions: uppercase-first types OR TS primitives (excludes SQL `AS alias` inside string literals)
rg "${GLOBS[@]}" -o '\bas\s+([A-Z][A-Za-z0-9_]*|string|number|boolean|any|unknown|never|void|null|undefined|object|symbol|bigint)\b' \
   api web shared e2e | wc -l

# Non-null assertions (heuristic: identifier/bracket/paren + ! + . [ , )
rg "${GLOBS[@]}" -o '[A-Za-z0-9_\)\]]!(\.|\[|,)' api web shared e2e | wc -l

# @ts-* directives
rg "${GLOBS[@]}" -c '@ts-(ignore|expect-error|nocheck)' api web shared e2e \
  | awk -F: '{s+=$NF} END{print s+0}'
```

## Caveats

- **`as Type` includes benign coercions** — `as Error` in React Query `onError` handlers, `as HTMLElement` for DOM, `as Partial<T>` for property merges. Most of web's `as <UpperCaseType>` hits fall into these categories.
- **Test files account for most `as any`** — 150 of 151 `as any` in `api/` are in `*.test.ts` (vitest mocks against the `pg` driver). Production `as any` is 1 occurrence (`api/src/routes/issues.ts:155`).
- **Non-null assertion pattern is heuristic** — matches `x!.`, `x![`, `x!,`. Does not match `x!;`, `x!)` or end-of-line. Actual total may be marginally higher. Will consider using TypeScript compiler API for improvment target.
- **Excluded from "assertions":** `as const`, `import { x as y }` aliases, and SQL `AS alias` clauses inside template strings (which were inflating the raw `as` count by ~600).
- **Counts are occurrences, not unique sites** — a single line with two assertions counts twice. `-c` returns per-file counts; we sum the last field with `awk`.

## Notable concentrations (where to start)

1. **`api/src/routes/admin.ts` non-null assertions (14)** — all are `req.userId!`. Auth middleware guarantees `userId` but the request type doesn't reflect it. A single typed `AuthedRequest` interface would eliminate ~25 of these across all routes.
2. **`api/src/routes/projects.ts` / `weeks.ts` `: any` (13/12)** — `extractIssueFromRow(row: any)`, `extractProjectFromRow(row: any)`, `formatStandupResponse(row: any)`. The DB→domain boundary is untyped.
3. **`api/src/utils/yjsConverter.ts` (12)** — Yjs↔TipTap JSON conversion. Boundary code against an untyped CRDT shape; the public surface should return `JSONContent` rather than `any`.
4. **Dynamic SQL parameter arrays** — `const values: any[] = []` appears in `weeks.ts`, `issues.ts`, `standups.ts`, `auth.ts`, `projects.ts`. Canonical `pg` driver idiom, but `values: SqlParam[]` with `type SqlParam = string | number | boolean | null | Date | Buffer | string[] | number[]` would preserve type safety.

## Initial remediation plan

### Ground rules

- Every fix must preserve existing functionality. Relevant tests must still pass after each change.
- Superficial fixes do not count. Reducing the audit number is not enough if the code is not actually safer.
- Replacing `any` with `unknown` without proper type narrowing is not an improvement.
- Each fix must introduce correct, meaningful types that reflect the actual runtime data.
- Prefer small, reviewable changes grouped by boundary: request/auth types, database row mapping, Yjs/editor content, and tests/mocks.

### Phase 1: Improve the audit signal

1. Add an AST-based non-null assertion counter using the TypeScript compiler API so `x!;`, `x!)`, and end-of-line assertions are counted accurately.
2. Split `count.sh` output into production and test counts for each violation class, not just the top files.
3. Add a short allowlist or classification for benign frontend assertions such as DOM narrowing and React Query error handling, so remediation focuses on risky assertions first.

### Phase 2: Remove high-value production `any`

1. Define reusable database row types for the highest-count route helpers: projects, weeks, admin, and workspaces.
2. Replace route-level `row: any` mapper inputs with explicit row interfaces that match the SQL selected columns.
3. Replace dynamic SQL `any[]` parameter arrays with a shared `SqlParam` type that covers the values actually accepted by `pg`.
4. Add runtime narrowing where data crosses trust boundaries, especially JSONB properties and API request bodies.

### Phase 3: Fix auth/request non-null assertions

1. Introduce an authenticated request type that reflects what `authMiddleware` guarantees after it runs.
2. Use that type in protected route handlers instead of repeated `req.userId!` and related assertions.
3. Keep unauthenticated route behavior unchanged; the type improvement should model the middleware contract, not weaken runtime checks.

### Phase 4: Type editor and Yjs boundaries

1. Replace broad `any` in Yjs↔TipTap conversion with `JSONContent` or a local editor-node type that matches the actual document shape.
2. Add narrow helpers for converting unknown JSONB/editor data into typed editor content.
3. Preserve compatibility with existing stored document content while tightening new writes.

### Phase 5: Clean test-only type escapes

1. Replace `as any` in Vitest mocks with typed mock helpers for `pg`, request objects, and service dependencies.
2. Keep intentional impossible-state tests explicit, but prefer `satisfies`, typed factories, or narrow helper types over blanket `as any`.
3. Do test cleanup after production boundaries are typed so tests can reuse the same domain types.

### Verification

For each remediation PR:

1. Run `pnpm --filter @ship/api test` for API changes.
2. Run `pnpm --filter @ship/web test` for frontend changes.
3. Run targeted Playwright specs when behavior crosses API/web boundaries.
4. Run `./audit/type-safety/count.sh` and include before/after counts in the PR notes.
