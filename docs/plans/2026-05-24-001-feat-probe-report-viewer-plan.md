---
date: 2026-05-24
topic: probe-report-viewer
type: feat
status: completed
origin: docs/brainstorms/2026-05-23-probe-report-viewer-requirements.md
---

# feat: Probe HTML Report Viewer + Interactive CLI

## Summary

Add a self-contained HTML report alongside the existing JSON and markdown that the probe writes after every run, plus a browsable `index.html` listing past runs, plus interactive prompts when `pnpm probe` is invoked with no flags. The HTML report follows the supplied terminal-aesthetic design (vendored at `probe/design/`) and inlines all CSS, JS, and the run's JSON so a single file can be emailed/Slacked and opened on `file://` with no fetches.

---

## Problem Frame

The probe today writes one `security-report.{json,md}` to `probe/results/`, overwriting on every run. The markdown is dense, evidence balloons under every check, severity counts are buried in tables, and there is no way to filter from inside the report. Previous runs are destroyed on every invocation, so comparing across runs is impossible. The CLI also assumes the operator remembers a half-dozen flag names and the API/web URLs the dev server picked for this worktree — fine the first time, painful by the fifth.

See origin: `docs/brainstorms/2026-05-23-probe-report-viewer-requirements.md` for the full requirements set, key flows (F1–F4), acceptance examples (AE1–AE7), and scope boundaries.

---

## Output Structure

New files this plan creates inside the probe workspace (existing files modified, not listed):

```
probe/
├── vitest.config.ts                  # U1: vitest in this workspace
└── src/
    ├── prompts.ts                    # U5: @inquirer/prompts wrapper
    ├── viewer/
    │   ├── html.ts                   # U3: renderHtml(report) → string
    │   ├── index-html.ts             # U4: renderIndexHtml(runs) → string
    │   ├── assets.ts                 # U3/U4: read+cache tokens.css and runtime.js
    │   └── runtime.js                # U3: vanilla-JS viewer (inlined at emit time)
    └── __tests__/
        ├── report.test.ts            # U2: file naming + alias
        ├── viewer-html.test.ts       # U3: per-run HTML emitter
        ├── viewer-index.test.ts      # U4: history index emitter
        ├── prompts.test.ts           # U5: prompt-skip logic + defaults
        └── cli.test.ts               # U6: CLI plumbing + auto-open behavior
```

Implementer may adjust the layout if a different split emerges naturally — the per-unit `**Files:**` sections are authoritative.

---

## Key Technical Decisions

- **`@inquirer/prompts` + `open` npm packages.** Probe today is zero-runtime-dep; these become the first two. Rationale: the brainstorm calls out interactive UX as a quality goal, and stdlib `readline/promises` can't do arrow-key selects or hint-line descriptions for the probe-group multi-select. `open` handles the per-platform browser-launch matrix cleanly. See origin Key Decisions for the file-per-run + alias and JSON-inlining decisions.
- **Vanilla JS in the viewer runtime.** No React, no Babel-in-browser. The design ships as JSX prototypes; the design README is explicit that the agent should match the visual output, not the structure. Vanilla JS keeps per-run HTML well under a megabyte and avoids shipping a Babel runtime in every report. (See origin.)
- **Vendor tokens by inlining at emit time.** The viewer reads `probe/design/project/tokens.css` from disk during `renderHtml` and inlines its contents into a `<style>` block — no copy step, single source of truth. If `probe/design/` is ever removed, `renderHtml` fails fast with a clear message rather than silently shipping unstyled HTML.
- **`security-report.*` alias is overwrite, not symlink.** Each run writes `<run-id>.{json,md,html}` (durable) AND overwrites `security-report.{json,md,html}` with the same content (alias). Cross-platform without symlink portability concerns; doubles disk per run but the JSON is ~50KB and the HTML is well under 1MB.
- **Interactive mode = "zero CLI flags passed AND `process.stdin.isTTY` truthy".** Any flag short-circuits the prompt layer entirely. Non-TTY (CI, piped input) short-circuits too. The same gate controls whether browser auto-open fires after the run.
- **History index scans `<outputDir>/probe-*.json` at emit time.** The existing `runId` already starts with `probe-` (see `probe/src/config.ts:84`), so the scan needs no new metadata file — each historical JSON has the `target`, `summary`, and `generatedAt` the index needs.
- **Inline hint text on every non-obvious prompt** via `@inquirer/prompts`' multi-line `message` (for confirms) and per-choice `description` (for selects). Specifically required for `--aggressive-rate-limit` per origin R1; we extend to `--allow-mutation` and the probe-group multi-select for consistent UX.
- **Vitest in the probe workspace.** Required because R7–R11 and R1–R3 are feature-bearing and need test scenarios; the workspace has no test infrastructure today. Vitest is already hoisted at the repo root — adding it to probe is config-only, no new top-level deps.

---

## Dependencies / Assumptions

- Design bundle at `probe/design/project/{tokens.css, *.jsx, ...}` is the canonical visual reference. Verified present in this branch; do not assume `/tmp/probe-design/` is reachable.
- `probe/src/config.ts` `runId` already follows `probe-${ISO}-${uuid8}` shape — usable as a filename stem without sanitization.
- `probe/src/report.ts` exports the `ProbeReport`, `ProbeCheck`, `ProbeSeverity`, `ProbeStatus`, `ProbeSurface` types. The viewer reads these. Any future schema change has to be reflected in the runtime JS.
- `.ports` file at the repo root (written by `scripts/dev.sh`) is the source of truth for the local API/web URL defaults — but is deleted on dev-server exit, so the prompt layer must handle "file absent" gracefully (fall through to `PROBE_*` env, then hardcoded defaults).
- Vitest v4 is hoisted at the workspace root (root `package.json` devDependencies); no version bump or new top-level dep needed.
- `@inquirer/prompts` and `open` are added to `probe/package.json` as runtime dependencies. Both are pure-ESM and align with probe's `"type": "module"`.
- Root `pnpm test` script (`package.json:28`) currently runs api + web; it gets extended to also run `pnpm --filter probe test`.
- JetBrains Mono is NOT bundled — fallback stack already in `probe/design/project/tokens.css` (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`) is sufficient.

---

## Requirements Traceability

| Origin | Covered by units |
|---|---|
| R1 (interactive prompts when no flags + TTY) | U5 |
| R2 (defaults from `.ports` → env → hardcoded) | U5 |
| R3 (any flag OR non-TTY → skip prompts) | U5, U6 |
| R4 (existing flags unchanged) | U5 (regression-only; no code change to flag parser) |
| R5 (`<run-id>.*` + `security-report.*` alias) | U2 (json/md), U3 (html) |
| R6 (history `index.html`) | U4 |
| R7 (self-contained HTML, JSON inlined, no fetches) | U3 |
| R8 (header + KPI band + tabs + search + table) | U3 |
| R9 (dark+light themes + persisted toggle) | U3 |
| R10 (CLI prints paths; auto-open in interactive+TTY only) | U6 |
| R11 (column mapping table) | U3 |
| R12 (in `probe` workspace, no new top-level package) | U1 (vitest scaffolding only) |
| F1 (interactive run) | U5, U6 |
| F2 (scripted / CI run) | U5, U6 |
| F3 (browsing history) | U4 |
| F4 (sharing single file) | U3 |
| AE1–AE3 (prompt-skip behavior) | U5 |
| AE4 (no fetches) | U3 |
| AE5 (theme toggle persists) | U3 |
| AE6 (history listing newest-first) | U4 |
| AE7 (auto-open interactive-only) | U6 |

---

## Implementation Units

### U1. Set up vitest in the probe workspace

- **Goal:** Stand up vitest config + test script in `probe/` so subsequent units can add unit and integration tests.
- **Requirements:** R12 (no new top-level package — vitest comes from hoisted root devDep).
- **Dependencies:** none.
- **Files:**
  - `probe/vitest.config.ts` (new)
  - `probe/package.json` (modify — add `"test": "vitest run"` script)
  - `probe/tsconfig.json` (modify — add `"vitest/globals"` to the `types` array so `globals: true` typechecks without explicit `import { describe, it, expect } from 'vitest'` in every test)
  - `package.json` (modify — extend root `"test"` script to include `pnpm --filter probe test`)
  - `probe/src/__tests__/smoke.test.ts` (new, deleted by U2)
- **Approach:**
  - Mirror `api/vitest.config.ts` but omit `setupFiles` (no DB) and `fileParallelism: false` (no DB conflict to worry about).
  - `globals: true`, `environment: 'node'`, `include: ['src/**/*.test.ts']`.
  - Add `vitest` to `probe/package.json` devDependencies, version-matched to the root (`^4.0.16`) — needed because pnpm's default isolated layout does not make a workspace-root devDep resolvable from a child package without an explicit declaration or `public-hoist-pattern` in `.npmrc` (neither is present). Skip `@vitest/coverage-v8` — coverage tooling is not required by any test scenario in this plan and can be added in a follow-up if coverage gates become useful.
  - Smoke test asserts `1 + 1 === 2` so `vitest run` exits 0 on first invocation. U2 deletes it.
- **Patterns to follow:** `api/vitest.config.ts`, `api/package.json` test scripts.
- **Test scenarios:** *Test expectation: none — pure scaffolding (the smoke test is a one-line placeholder that gets removed in U2).*
- **Verification:** `pnpm --filter probe test` exits 0 with "1 passed"; `pnpm test` from the repo root runs api + web + probe tests in sequence.

---

### U2. Refactor `writeReports` for per-run + alias files

- **Goal:** Make every run write three durable files (`<run-id>.{json,md}` — `html` added in U3) plus overwrite the existing `security-report.{json,md}` alias for backwards compatibility.
- **Requirements:** R5.
- **Dependencies:** U1.
- **Files:**
  - `probe/src/report.ts` (modify — extend `writeReports` to write both file pairs; extend return shape from `{ jsonPath, markdownPath }` to `{ jsonPath, markdownPath, runJsonPath, runMarkdownPath }`)
  - `probe/src/cli.ts` (modify — update the summary print block at lines 102–103 to print the run paths)
  - `probe/src/__tests__/report.test.ts` (new — delete `smoke.test.ts` from U1)
- **Approach:**
  - The `<run-id>.json` and `security-report.json` content is byte-identical for any given run; write the buffer once and `writeFile` it twice. Same for markdown.
  - `mkdir -p outputDir` defensively (existing code already assumes the dir exists; harden it here).
  - Print order in CLI summary: `JSON: <runJsonPath>`, `Markdown: <runMarkdownPath>`; keep the existing `JSON:` / `Markdown:` labels pointing at the run-id paths (alias paths are implicit/documented). HTML path added in U3.
- **Patterns to follow:** Existing `writeReports` structure in `probe/src/report.ts` (zero-dep, fs/promises).
- **Test scenarios:**
  - Happy path: given a `ProbeReport` with `runId = 'probe-fixed-test'`, `writeReports` creates `<outputDir>/probe-fixed-test.json`, `<outputDir>/probe-fixed-test.md`, `<outputDir>/security-report.json`, `<outputDir>/security-report.md`.
  - Content parity: contents of `probe-fixed-test.json` byte-equal `security-report.json` after a single run.
  - Multi-run: simulate two sequential `writeReports` calls with different `runId`s; both run-id files persist; `security-report.*` matches the second run only.
  - Missing outputDir: outputDir does not exist before call → call creates it → all four files written.
  - Return shape: returned object has `jsonPath`, `markdownPath`, `runJsonPath`, `runMarkdownPath`, all absolute strings.
- **Verification:** Tests pass; running `pnpm probe` produces both file pairs in `probe/results/`.

---

### U3. Per-run HTML viewer emitter

- **Goal:** Generate a self-contained `<run-id>.html` (and `security-report.html` alias) styled per the design, with the run's JSON inlined and the full viewer runtime embedded.
- **Requirements:** R7, R8, R9, R11.
- **Dependencies:** U1, U2.
- **Files:**
  - `probe/src/viewer/html.ts` (new — `renderHtml(report: ProbeReport, assets: ViewerAssets): string`)
  - `probe/src/viewer/assets.ts` (new — reads + caches `probe/design/project/tokens.css` and `probe/src/viewer/runtime.js`)
  - `probe/src/viewer/runtime.js` (new — vanilla-JS, IIFE, reads `JSON.parse(document.getElementById('probe-data').textContent)`, renders KPI band + tabs + search + table, handles theme toggle + `localStorage`)
  - `probe/src/report.ts` (modify — `writeReports` now writes 6 files total: `<run-id>.{json,md,html}` + `security-report.{json,md,html}`; return shape gains `htmlPath`, `runHtmlPath`)
  - `probe/src/cli.ts` (modify — print `HTML: <runHtmlPath>` in summary)
  - `probe/src/__tests__/viewer-html.test.ts` (new)
- **Approach:**
  - `renderHtml(report)` returns a single HTML string. Top-down structure: `<!DOCTYPE html>` → `<head>` with inlined `<style>` (tokens.css contents) → `<body class="sr theme-dark">` containing skeleton DOM the runtime hydrates → `<script id="probe-data" type="application/json">{...}</script>` → `<script>{runtime.js contents wrapped in IIFE}</script>`.
  - Skeleton DOM: empty `<div id="root">` is fine; runtime owns full DOM. Or hardcode the chrome (header, KPI band, tabs row, search input, table host) and have runtime fill values — slightly faster first paint and degrades better if JS fails. Pick the latter.
  - Column mapping (R11) is implemented in `runtime.js` — it reads check fields and maps to design columns per the table in the origin doc, with one correction to the origin's field name. `surface` replaces `package · path`; `status` is rendered with the minimal-badge style; `ver → fix` is dropped; `refs` is `(check.reproductionSteps?.length ?? 0) + Object.keys(check.evidence ?? {}).length` (the origin's `check.recommendations` was a typo — `ProbeCheck` has no such field, only `reproductionSteps`); `age` is rendered as a relative time computed at browser-open time from `report.generatedAt`, using format buckets `<1h → 'Xm'`, `<24h → 'Xh'`, else `'Xd'`, so the value stays accurate when the file is reopened days later.
  - Status filter tabs are four UI controls — `findings` (default), `not-tested`, `passed`, `all` — that filter rows on the `check.status` data field. `check.status` has three possible values: `pass`, `finding`, `not-tested`. The `findings` tab filters to `status === 'finding'`, `passed` to `status === 'pass'`, `not-tested` to `status === 'not-tested'`, and `all` shows everything. Each tab shows a count derived from the inlined JSON.
  - Theme toggle persists in `localStorage` under the fixed key `probe-viewer-theme`; default to `dark`. To eliminate the dark→light flash on reload when a user has saved `light`, theme initialization runs as a synchronous inline `<script>` in `<head>` (before `<body>` parses): the script reads `localStorage['probe-viewer-theme']` and applies the corresponding class to `<body>` so the correct theme is in place before first paint.
  - Assets loader (`assets.ts`) reads both files once per CLI run (cache in module scope), throws a clear error if either is missing. Paths resolve via `new URL('../../design/project/tokens.css', import.meta.url)` and `new URL('./runtime.js', import.meta.url)` — ESM module-relative, not cwd-relative — so the loader works whether `tsx` is invoked from the workspace root, from `probe/`, or from vitest's working directory.
  - HeaderB breadcrumb slot mapping: slot 1 is the literal `probe`; slot 2 is the hostname extracted from `target.apiUrl`; slot 3 is the last 8-character segment of `runId`; the trailing right-aligned status reads `scan complete · <X>m ago` computed from `report.generatedAt` at render time. The design's version-tag chip is omitted (no probe equivalent).
  - Search affordance: build only the body filter input. Drop the design's HeaderB command-bar search — the ⌘K jump-to affordance requires an interaction model outside this scope. The header's search-shaped area renders as a static target-URL display instead.
  - KPI band slot mapping (parallel to R11's column mapping, since the design assumes SAST/SBOM data probe doesn't have): cells left-to-right are total findings, critical count, high count, medium count, not-tested count, severity-mix bar. The design's `risk score` and `auto-fixable` cells are dropped. Grid: `repeat(5, 1fr) 1.4fr` matching the design's proportions.
  - Probe status badge color tokens: the design's `tokens.css` defines status colors for `open` / `fixed` / `triage` / `suppressed` but not for probe's. The inlined `<style>` adds `--status-finding: var(--sev-critical); --status-pass: var(--accent); --status-not-tested: var(--muted);` so the minimal-badge style has tokens to pull for every probe status value.
  - Table is sortable. Clicking a column header toggles ascending/descending on that column; clicking a different column re-sorts ascending on the new column. Default load is sorted by `sev` ascending (matching the design's `useState({ id: 'sev', dir: 'asc' })` in `table.jsx`). The active sort column shows `▲` or `▼` in `var(--accent)` after the header label.
  - Accessibility: the inlined `<style>` includes a `:focus-visible` rule on interactive elements (e.g., `button:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }`) so sortable column headers and the theme toggle remain keyboard-reachable in both themes — the design tokens omit focus styles by default.
- **Patterns to follow:**
  - Hand-rolled HTML emission style (no template engine) consistent with `renderMarkdown` in `probe/src/report.ts`.
  - Design tokens / components: `probe/design/project/tokens.css`, `probe/design/project/report-page.jsx` (HeaderB + KPI band + TabsUnderline + FindingsTable layout).
- **Test scenarios:**
  - Happy path: `renderHtml` returns a string starting with `<!DOCTYPE html>` and containing `<script type="application/json" id="probe-data">`.
  - JSON inlined matches report: parse the JSON out of the script tag and `expect(parsed).toEqual(report)`.
  - Self-contained: no `src=` or `href=` attributes pointing at `http`, `https`, `//`, or any non-`data:` URL. (Covers AE4.)
  - Both themes present: output contains both `.theme-dark` and `.theme-light` rule blocks (from tokens.css inlining).
  - Theme persistence wired: output contains the localStorage key `probe-viewer-theme`. (Covers AE5.)
  - Status badges: output contains references to all three probe statuses (`pass`, `finding`, `not-tested`) — the runtime uses these to style rows.
  - Empty checks: `renderHtml({ ...report, checks: [] })` still renders the KPI band with zeros and a "no checks ran" empty state in the table.
  - Asset load failure: when `tokens.css` is missing, `renderHtml` throws an error mentioning the missing path (not a silent unstyled render).
  - Column mapping: a finding with `severity: 'critical'`, `surface: 'auth'`, `status: 'finding'` ends up in the inlined data and the runtime's rendering logic accesses it via `check.severity`, `check.surface`, `check.status` (verified by snapshot of runtime calls or DOM assertion via jsdom).
  - `refs` column uses `reproductionSteps`: a check with two `reproductionSteps` and one evidence key renders `refs = 3`; a check with no `reproductionSteps` and no evidence renders `refs = 0`.
  - Sortable table: given a report with checks of mixed severity, after rendering, table rows appear in `sev` ascending order (`critical` first, `info` last). Clicking the `sev` column header toggles the order to descending. Clicking the `title` column re-sorts ascending on title. The active column header renders the `▲`/`▼` indicator in `var(--accent)`.
- **Verification:** `pnpm probe` produces `probe/results/<run-id>.html`; opening it in a browser via `file://` shows the styled report with no console errors; toggling the theme persists across reload.

---

### U4. History `index.html` emitter

- **Goal:** Regenerate `probe/results/index.html` after every run so the operator can browse all past runs newest-first.
- **Requirements:** R6.
- **Dependencies:** U1, U2, U3.
- **Files:**
  - `probe/src/viewer/index-html.ts` (new — `renderIndexHtml(runs: RunSummary[]): string`, plus `scanRuns(outputDir): Promise<RunSummary[]>`)
  - `probe/src/report.ts` (modify — `writeReports` calls `scanRuns` + `renderIndexHtml` and writes `index.html` last; return shape gains `indexPath`)
  - `probe/src/cli.ts` (modify — print `Index: <indexPath>` in summary)
  - `probe/src/__tests__/viewer-index.test.ts` (new)
- **Approach:**
  - `scanRuns(outputDir)` does `readdir`, filters for `^probe-.*\.json$`, parses each minimally for `target.apiUrl`, `generatedAt`, `summary` (findings + by-severity counts). Skip files that fail to parse with a logged warning.
  - `RunSummary` shape: `{ runId, generatedAt, target: { apiUrl, webUrl? }, summary: { findings, notTested, passed, bySeverity } }`.
  - `renderIndexHtml(runs)` returns a single HTML string styled like the per-run report (reuses tokens.css inlining via `assets.ts`). Layout: same `HeaderB` chrome with title "Probe — run history", followed by a table with columns: timestamp, target, findings, severity-mix bar, link.
  - Sort newest-first by `generatedAt` (ISO strings sort lexicographically when consistently formatted).
  - Empty state: when no runs found, show "No runs yet. Run `pnpm probe`." centered in the body.
  - Each row links to `./<runId>.html`. Relative href is correct because index lives in the same directory.
- **Patterns to follow:** `probe/src/viewer/html.ts` (U3) for general emitter shape.
- **Test scenarios:**
  - Happy path: given 3 mock JSON files in a tmpdir, `scanRuns` returns 3 `RunSummary`s sorted newest-first; `renderIndexHtml` produces HTML containing each `runId` in newest-first order. (Covers AE6.)
  - Empty: `scanRuns` on an empty dir returns `[]`; `renderIndexHtml([])` returns HTML containing the empty-state copy.
  - Malformed file: a `probe-bad.json` containing `not-json` is skipped, a warning is logged, other runs still listed.
  - Non-run JSON: a file named `something-else.json` is not picked up (only `probe-*.json` matches).
  - Each row links to the correct relative path: `href="./<runId>.html"`.
  - Severity-mix bar renders: parts sum to total findings; widths are proportional.
- **Verification:** After two `pnpm probe` invocations, `probe/results/index.html` lists both runs newest-first; clicking either link opens the corresponding per-run HTML.

---

### U5. Interactive prompt layer

- **Goal:** When `pnpm probe` is invoked with no CLI flags AND `process.stdin.isTTY` is truthy, prompt the operator for target / credentials / groups / mutation / aggressive-rate-limit; otherwise skip prompts entirely and run with config built from flags + env + defaults.
- **Requirements:** R1, R2, R3, R4.
- **Dependencies:** U1.
- **Files:**
  - `probe/package.json` (modify — add `@inquirer/prompts` to dependencies)
  - `probe/src/prompts.ts` (new — `promptForConfig(baseConfig: ProbeConfig): Promise<ProbeConfig>`)
  - `probe/src/config.ts` (modify — add `loadPortsFile(repoRoot): { api?: string, web?: string }` helper; export a `shouldRunInteractive(argv): boolean` predicate that returns `true` when no flag-style arg is passed (no element of `argv` starts with `-`) AND `process.stdin.isTTY` is truthy)
  - `probe/src/cli.ts` (modify — at entry, if `shouldRunInteractive`, call `promptForConfig` to replace `config`; otherwise proceed as today)
  - `probe/src/__tests__/prompts.test.ts` (new)
- **Approach:**
  - Prompt sequence (using `@inquirer/prompts`):
    1. `input` — API URL, default from `.ports.API` → `PROBE_API_URL` env → `DEFAULT_API_URL`.
    2. `input` — Web URL (optional, allow empty), default from `.ports.WEB` → `PROBE_WEB_URL` env → empty.
    3. `input` — email, default from `PROBE_EMAIL` → `DEFAULT_EMAIL`.
    4. `password` — password, default from `PROBE_PASSWORD` → `DEFAULT_PASSWORD` (masked).
    5. `checkbox` — probe groups to run, choices from `PROBE_GROUPS`, all preselected; each choice has a `description` summarizing that group's checks (mirrors the descriptions in `probe/features.md`).
    6. `confirm` — `--allow-mutation`? Default `false`. `message` includes a line explaining what mutation does ("creates test wikis/issues/comments/tokens; required for full coverage").
    7. `confirm` — `--aggressive-rate-limit`? Default `false`. `message` includes the warning per origin R1 ("will exhaust the login limiter; affected accounts can't log in for ~15min after").
  - Returns a `ProbeConfig` with the same field semantics as flag-built configs — downstream probe code cannot tell the difference.
  - `shouldRunInteractive` reads `process.argv.slice(2)`; if any element starts with `-`, returns false. Also returns false when `process.stdin.isTTY` is falsy.
  - `loadPortsFile` reads `<repoRoot>/.ports`, parses the simple `KEY=VALUE` format (skip `#`-prefixed and blank lines), returns `{ api, web }` derived from `API` / `WEB` ports as full URLs (`http://localhost:${port}`). Returns `{}` if file missing — explicitly no throw.
- **Patterns to follow:**
  - Probe-local style: pure functions returning data + a single I/O entrypoint. Keep `promptForConfig` the only async I/O in `prompts.ts`.
  - Config resolution order already documented in origin Dependencies/Assumptions.
- **Test scenarios:**
  - **Happy interactive path:** mock `@inquirer/prompts` to return canned answers; `promptForConfig({...defaultConfig})` resolves to a `ProbeConfig` whose `apiUrl`, `webUrl`, `email`, `password`, `onlyGroups`, `allowMutation`, `aggressiveRateLimit` reflect the mocked answers.
  - **`shouldRunInteractive` truthy:** `process.argv` is `['node', 'cli.ts']`, `process.stdin.isTTY = true` → returns `true`.
  - **Flag short-circuits prompts:** `process.argv` includes `--api-url` → returns `false`. (Covers AE2.)
  - **Non-TTY short-circuits prompts:** `process.argv` is `['node', 'cli.ts']`, `process.stdin.isTTY = undefined` → returns `false`. (Covers AE3.)
  - **`.ports` file present:** mock fs to return a sample `.ports`; `loadPortsFile` returns `{ api: 'http://localhost:3002', web: 'http://localhost:5175' }`.
  - **`.ports` file absent:** fs throws ENOENT; `loadPortsFile` returns `{}` without rethrowing.
  - **`.ports` parsing:** handles comments (`# foo`), blank lines, `KEY=VALUE` lines, trailing whitespace; ignores keys other than `API` / `WEB`.
  - **Aggressive-rate-limit prompt content:** assert the rendered `message` string contains "lock" or "limiter" to confirm the warning is wired. (Covers origin R1.)
  - **Group multi-select with `description`:** assert each choice object has a non-empty `description` field — enforces the inline-hint quality bar.
  - **Defaults flow into prompts:** when `.ports.API = 3002`, the API URL prompt's `default` argument is `http://localhost:3002`; when `.ports` is absent but `PROBE_API_URL` is set, the env value is used. (Covers AE1.)
- **Verification:** `pnpm probe` from a fresh terminal prompts the operator and runs the probe with the chosen config; `pnpm probe --api-url http://localhost:3002 --allow-mutation` runs to completion with no prompts; piping `echo '' | pnpm probe` runs with no prompts.

---

### U6. Browser auto-open + final CLI plumbing

- **Goal:** When the run was interactive AND stdout is a TTY, auto-open the per-run HTML in the default browser after `writeReports` returns. Print all paths (run JSON, markdown, HTML, alias HTML, index) to stdout regardless.
- **Requirements:** R10.
- **Dependencies:** U2, U3, U4, U5.
- **Files:**
  - `probe/package.json` (modify — add `open` to dependencies)
  - `probe/src/cli.ts` (modify — after `writeReports`, if `wasInteractive && process.stdout.isTTY`, call `open(runHtmlPath)`; always print paths)
  - `probe/src/__tests__/cli.test.ts` (new — uses module mocking for `open` and a stubbed `runProbe`)
- **Approach:**
  - `wasInteractive` is the same boolean the prompt layer set (pass it explicitly from `cli.ts` into the post-write block — don't re-derive).
  - Wrap `open()` in try/catch; if it throws (headless SSH, missing browser, etc.), log a soft warning ("could not open browser automatically — open <path> manually") and continue. Never let auto-open failure crash the run.
  - Final stdout block additions:
    - `Run JSON: <runJsonPath>`
    - `Run Markdown: <runMarkdownPath>`
    - `HTML: <runHtmlPath>`
    - `Index: <indexPath>`
  - The existing `JSON:` and `Markdown:` lines that point at `security-report.*` aliases stay for backwards compatibility with anyone parsing the CLI summary.
- **Patterns to follow:** Existing CLI summary block in `probe/src/cli.ts:93-103`.
- **Test scenarios:**
  - **Auto-open fires when interactive + TTY:** mock `open`; given `wasInteractive = true` and `process.stdout.isTTY = true`, `open` is called once with the run HTML path. (Covers AE7.)
  - **Auto-open suppressed when not interactive:** given `wasInteractive = false`, `open` is not called regardless of TTY state. (Covers AE7.)
  - **Auto-open suppressed when not TTY:** given `wasInteractive = true` but `process.stdout.isTTY = undefined`, `open` is not called.
  - **Auto-open failure is non-fatal:** mock `open` to throw; CLI completes successfully, warning is logged to stderr, exit code matches the no-auto-open case.
  - **Path output completeness:** stdout contains all five expected path lines in interactive mode and at least the three new ones in non-interactive mode.
  - **Path output ordering:** paths appear after the existing summary block (`Probe complete. Findings: ...`), not before — preserves the existing front-matter for anyone parsing output.
- **Verification:** `pnpm probe` from a fresh terminal opens the new HTML in the default browser; `pnpm probe --api-url ... < /dev/null` does not.

---

### U7. Documentation updates

- **Goal:** Capture the new commands and behaviors in `probe/features.md` and any README that references probe.
- **Requirements:** none directly — completes the work for downstream readers.
- **Dependencies:** U2–U6.
- **Files:**
  - `probe/features.md` (modify — add Implemented entries for: per-run reports with history, self-contained HTML viewer with theme toggle, interactive CLI prompts, browser auto-open; leave the Planned "probe group timing" entry alone)
  - `README.md` (modify if it mentions `pnpm probe` — verify; current state unknown without re-reading)
- **Approach:** Add four bullets under `## Implemented` in `probe/features.md`, sentence-case, mirroring the existing entries' style: (1) per-run reports with history index, (2) self-contained HTML viewer with dark/light theme toggle, (3) interactive CLI prompts when invoked with no flags, (4) post-run browser auto-open in interactive mode. Leave the existing `## Planned` section's "Probe group timing" bullet unchanged. Do not cross-link to this plan from `probe/features.md` — the file does not conventionally link to plans.
- **Test scenarios:** *Test expectation: none — documentation only.*
- **Verification:** Visual review of `probe/features.md` after edit; `pnpm --filter probe type-check` and `pnpm --filter probe test` still pass.

---

## Scope Boundaries

- Cross-run diffing in the viewer. (Origin: deferred.)
- Per-finding detail drawer / row expansion. (Origin: deferred.)
- Sparklines, empty/loading states beyond what falls out of CSS.
- Running the probe against deployed shadow/prod environments. (Origin: separate brainstorm.)
- Retention or pruning of old runs in `probe/results/`.
- Supporting design statuses `open / fixed / triaging / monitoring / suppressed`; probe uses `pass / finding / not-tested` only. (Origin.)
- Hosting reports anywhere (S3, CloudFront, internal site). Single-file share only.
- CSV/XLSX export, PDF generation, scheduled email digests.
- `HeaderA` from the design (identity-first variant). Viewer uses `HeaderB` (command-bar) only. (Origin.)

### Deferred to Follow-Up Work

- Severity-trend chart on the history index. (Origin: deferred-to-planning — confirmed flat list for v1.)
- Adding probe to a CI workflow that runs on PRs (out of scope here; brainstorm explicitly defers to the deployed-envs brainstorm).
- Capturing learnings under `docs/solutions/` after the work lands (single-file HTML inlining + TTY-mode switching + file-per-run+alias are all greenfield-in-repo per `ce-learnings-researcher`).

---

## Risks and Mitigations

- **`@inquirer/prompts` mocking in vitest.** ESM module mocking in vitest needs `vi.mock` at the top of the test file with the module path; getting the test seam right for the prompt sequence is the most likely day-one blocker. Mitigation: U5 builds the prompt layer behind a single async function (`promptForConfig`) that's trivially mockable from `cli.test.ts`, so `prompts.test.ts` only needs to assert structure (defaults, descriptions, hint text) rather than drive the whole flow.
- **`open` package failure modes.** Headless SSH sessions, missing default-browser registration on Linux, and corp-locked-down machines can all make `open()` throw or hang. Mitigation: try/catch in U6 with a soft-warning fallback; never block the run on browser launch.
- **`probe/design/project/tokens.css` becoming a hidden runtime dependency.** The viewer reads it at emit time; if the design dir is ever pruned, every probe run will throw a confusing error. Mitigation: `assets.ts` (U3) throws with a clear message naming the missing path, not a generic ENOENT. Optionally, a future hardening pass can vendor the resolved CSS into `probe/src/viewer/` and drop the read.
- **Repository test script ordering.** Extending the root `pnpm test` chain to include probe means a probe test failure now blocks api/web test runs too. Mitigation: probe tests are unit-only (no DB, no network, no playwright) — they should add ~1s to the overall run; failures are signal, not noise.
- **Schema drift between `ProbeReport` and the runtime JS.** The inlined runtime depends on the JSON shape; a future change to `ProbeCheck` could break the viewer silently (renders blank cells rather than throwing). Mitigation: U3 test scenarios include a check that all current fields are accessed; document in `probe/src/viewer/runtime.js` header comment that this file mirrors `ProbeCheck`.
- **JetBrains Mono not actually loaded.** The font stack falls back to OS monospace, which renders correctly but doesn't match the design's visual spec exactly. Mitigation: explicitly listed in Dependencies/Assumptions; deferred to a follow-up font-bundling pass if visual fidelity becomes a complaint.

---

## Outstanding Questions

### Deferred to Implementation

- [Affects U3][Technical] Whether the inlined viewer JS lives as a string literal in TS or as a separate `.js` file read at emit time. Lean: separate `.js` file (better readability + linting). Path-resolution concern is resolved by the `import.meta.url` decision in U3.
- [Affects U3][Technical] Whether `runtime.js` uses ES modules or an IIFE. Since the script is inlined (not `<script type="module" src="…">`), IIFE is the natural choice.
- [Affects U4][Technical] Whether `scanRuns` skips files whose `generatedAt` is older than N days. Lean: no — let the operator decide via manual cleanup; matches the "no retention policy" scope boundary.
- [Affects U2 and U3][Technical] Whether to write the alias files (`security-report.*`) atomically (write+rename) or accept the brief window where the file is half-written. Lean: simple `writeFile` is fine — readers of `probe/results/` are humans or this tool itself, not concurrent processes.
