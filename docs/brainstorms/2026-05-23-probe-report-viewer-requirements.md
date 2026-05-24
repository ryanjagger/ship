---
date: 2026-05-23
topic: probe-report-viewer
---

# Probe Report Viewer + Interactive CLI

## Summary

Each probe run writes a self-contained HTML report styled per the supplied terminal-aesthetic design — alongside the existing JSON and markdown — so findings are readable in a browser and shareable as a single file. An `index.html` lists past runs so history is browsable. When `pnpm probe` is run with no flags from a terminal, the CLI prompts the operator for the target, credentials, and probe groups instead of expecting them to remember flag syntax.

---

## Problem Frame

Today the probe writes one `security-report.{md,json}` to `probe/results/`, overwriting on every run. The markdown is dense and hard to scan — evidence blocks balloon underneath each check, severity counts are buried in tables, and there is no way to filter by surface or status from inside the report. Each new run also destroys the previous one, so there is no way to look back at what changed or to compare two runs from different points in time. Operationally, the CLI assumes the operator remembers a half-dozen flag names and the exact API/web URLs the dev server picked for this worktree — fine the first time, painful by the fifth.

---

## Key Flows

- F1. **Interactive run from a fresh terminal**
  - **Trigger:** Operator types `pnpm probe` with no flags
  - **Actors:** Probe operator
  - **Steps:** CLI prompts for API URL (with a default sourced from `.ports` when this worktree's dev server is running), optional web URL, credentials, which probe groups, whether to allow mutation, and whether to enable aggressive rate-limit (with an inline warning). Probe runs. HTML report opens in the default browser. CLI prints the JSON, markdown, and HTML paths.
  - **Outcome:** Operator sees a styled report in their browser without having recalled any flag names
  - **Covered by:** R1, R2, R3, R8, R10

- F2. **Scripted / CI run**
  - **Trigger:** Operator (or CI) runs `pnpm probe` with one or more flags
  - **Actors:** Probe operator, CI system
  - **Steps:** Any flag is detected → prompts skip entirely. Probe runs non-interactively as today. Reports are written. Browser auto-open is suppressed.
  - **Outcome:** Existing automation continues to work unchanged
  - **Covered by:** R3, R4, R10

- F3. **Browsing history**
  - **Trigger:** Operator opens `probe/results/index.html`
  - **Actors:** Probe operator
  - **Steps:** Page lists past runs newest-first with timestamp, target URL, total findings, and severity mix. Clicking a row opens that run's HTML report.
  - **Outcome:** Operator can find, re-open, and re-share any past run
  - **Covered by:** R5, R6

- F4. **Sharing a single report**
  - **Trigger:** Operator emails or Slacks one HTML file to a teammate / auditor
  - **Actors:** Probe operator, downstream reader
  - **Steps:** Recipient downloads the file and opens it directly in a browser. JSON is inlined so no fetches are required. The theme toggle works without any backing service.
  - **Outcome:** Recipient sees the same report the operator did, with no setup
  - **Covered by:** R7, R8, R9

---

## Requirements

**Interactive CLI**
- R1. When `pnpm probe` is invoked with zero CLI flags AND stdin is a TTY, the CLI prompts the operator for: target API URL, optional web URL, credentials, probe groups to run, whether to allow mutation, and whether to enable aggressive rate-limit. The aggressive rate-limit prompt surfaces an inline warning that enabling it will exhaust the login limiter.
- R2. Prompt defaults are sourced, in order, from: the `.ports` file written by `scripts/dev.sh` (for the target URLs when the worktree's dev server is running), the existing `PROBE_*` environment variables, and finally the hard-coded defaults already in `probe/src/config.ts`.
- R3. If any CLI flag is passed, OR stdin is not a TTY, all prompts are skipped and the probe runs as it does today.
- R4. All existing CLI flags (`--api-url`, `--web-url`, `--email`, `--password`, `--allow-mutation`, `--keep-data`, `--only`, `--skip`, `--aggressive-rate-limit`, `--output-dir`, `--run-id`, `--timeout-ms`) continue to work with unchanged semantics.

**Per-run reports + history**
- R5. Each run writes three durable files under `probe/results/`: `<run-id>.json`, `<run-id>.md`, `<run-id>.html`. The existing `security-report.{json,md}` files continue to be written on every run (overwriting the previous run's content) so any caller hard-coding those paths keeps working; `security-report.html` is added with the same overwrite semantics.
- R6. After every run, `probe/results/index.html` is regenerated to list all past runs newest-first with: timestamp, target API URL, total findings count, severity-mix bar, and a link to the run's HTML report.

**Self-contained HTML viewer**
- R7. The per-run HTML is a single file with the run's JSON inlined into the document, all CSS embedded, and all JS embedded. Opening the file via `file://` works with no network fetches and no console errors.
- R8. The viewer renders, top to bottom: a command-bar header (probe name, target, run id, theme toggle, "scan complete · Xm ago"), a KPI band with the run's real counts (total findings, critical, high, medium, not-tested) and a stacked severity-mix bar, an underline-tab row filtering by status with live counts, a search input filtering on check id and title, and a dense sortable table of checks.
- R9. The viewer supports both dark and light themes per the design tokens. The header-level toggle persists the operator's choice across browser sessions for that file.

**Data integration**
- R10. After the report is written, the CLI prints the JSON, markdown, and HTML paths to stdout (today's print for the first two is preserved). When the run was interactive AND stdout is a TTY, the HTML is auto-opened in the default browser; in non-interactive mode it is not.
- R11. The viewer's table uses the design's layout but maps probe check fields to design columns per the table below. The design's `ver → fix` column is dropped. Status filter tabs use probe's values (`findings`, `not-tested`, `passed`, `all`) — the design's `open / fixed / triaging / suppressed / monitoring` set is not used.

| Design column     | Probe source field                                  | Notes |
|---|---|---|
| `sev`             | `check.severity`                                    | `critical` / `high` / `medium` / `low` / `info` map across directly |
| `id` (finding)    | `check.id`                                          | e.g. `auth.session.cookie_hardening` |
| `title`           | `check.title`                                       | |
| `package · path`  | `check.surface`                                     | Replaces design column with probe surface (`auth`, `headers`, etc.) |
| `ver → fix`       | —                                                   | Dropped (probe has no version/fix concept) |
| `refs`            | count of `recommendations` + evidence keys          | Approximates "how much there is to read" |
| `status`          | `check.status`                                      | Rendered with the design's `Badge variant="minimal"` style |
| `age`             | run timestamp                                       | Same for every row in a single run; consider per-row drop later |

**Packaging**
- R12. The HTML emitter is part of the existing `probe` workspace and runs as part of `tsx src/cli.ts`. No new top-level package, no separate build step; the emitter generates a single string and writes it next to the JSON and markdown reports.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given a fresh terminal with no `PROBE_*` env vars set, when the operator runs `pnpm probe`, the CLI prompts for target URL, credentials, groups, and mutation/rate-limit options before doing any HTTP work.
- AE2. **Covers R3, R4.** Given the operator runs `pnpm probe --api-url http://localhost:3002 --allow-mutation`, no prompts fire and the probe runs to completion with those flag values.
- AE3. **Covers R3.** Given the probe is invoked from a non-TTY context (CI, piped input), no prompts fire even with zero flags; the probe runs against defaults and exits.
- AE4. **Covers R7.** Given the operator emails `<run-id>.html` to a teammate, when the teammate downloads the file and double-clicks to open in a browser, the report renders fully with no network fetches and no missing assets.
- AE5. **Covers R8, R9.** Given the report is open, when the operator toggles the theme, all colors switch immediately, and the choice persists when they reload the file.
- AE6. **Covers R6.** Given two prior runs exist, when the operator runs the probe a third time and opens `index.html`, all three runs are listed newest-first with the new run at the top.
- AE7. **Covers R10.** Given an interactive run finishes, when the CLI returns, the default browser is already opening the new HTML report; the same run invoked with `--api-url ...` does not auto-open the browser.

---

## Success Criteria

- The probe operator can run `pnpm probe` from a fresh terminal, answer prompts, and end up looking at a styled report in the browser without typing a flag or reading `--help`.
- A teammate who didn't run the probe can open an emailed `.html` file on a locked-down machine (no Node, no dev server) and see the same report.
- The `pnpm probe --api-url ...` invocations used today in scripts and CI continue to behave the same way they always have.
- A downstream agent picking this up for planning has enough here that they do not have to invent column mappings, prompt content, file layout, or what "interactive" means at the boundary.

---

## Scope Boundaries

- Cross-run diffing in the viewer (the "what changed since last run" view). The history index lists runs but does not compare them.
- Per-finding detail drawer / row expansion. The row is the leaf; full evidence stays in the JSON for now.
- Sparklines, empty/loading states, animated transitions beyond what falls out of CSS.
- Running the probe against deployed shadow/prod environments. Separate brainstorm.
- Retention or pruning of old runs. Files accumulate in `probe/results/` until the operator deletes them.
- Supporting the design's `open / fixed / triaging / monitoring / suppressed` finding statuses. Probe's data model has only `pass / finding / not-tested`; the viewer uses those.
- Hosting reports anywhere (S3, CloudFront, internal site). Single-file share via email/Slack only.
- CSV/XLSX export, PDF generation, scheduled email digests.
- The design chat's `HeaderA` (identity-first variant) — the viewer uses `HeaderB` (command-bar) only.

---

## Key Decisions

- **Vanilla JS in the viewer, not React + in-browser Babel.** The design ships as JSX prototypes, but its README explicitly says match the visual output not the structure. Vanilla JS keeps the per-run HTML self-contained and well under a megabyte, and avoids shipping a Babel runtime into every report.
- **JSON inlined into HTML, not fetched.** Required to make `file://` opens work with no console errors, which is the whole point of the "send one file" property.
- **File-per-run plus overwriting `security-report.*` alias.** The `<run-id>.*` files are the durable history; the `security-report.*` files keep working for any existing caller that hard-codes those paths. Cheaper than symlinks and avoids Windows portability concerns.
- **Auto-open browser only in interactive + TTY mode.** Anything else (CI, scripted, non-TTY) gets paths printed to stdout and that's it.
- **Theme defaults to dark, persists per file.** Reference aesthetic is dark-first; light theme is opt-in via the header toggle.
- **Column mapping is settled here, not in planning.** See the Requirements table — probe's data shape is different enough from the design's SAST/SBOM assumption that the mapping is a product decision, not an implementation detail.

---

## Dependencies / Assumptions

- The design bundle at `/tmp/probe-design/probe/` (chat transcript, `tokens.css`, JSX prototypes for primitives, badges, headers, tabs, table, and assembled report page) is the canonical visual spec. It must be copied into the repo (e.g. `probe/design/` or `probe/src/viewer/design/`) at the start of implementation so it survives `/tmp` cleanup.
- JetBrains Mono is loaded via a web-safe path (CDN, embedded, or system fallback to `ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas`, `monospace`). The font stack in `tokens.css` already handles fallback.
- Existing flag parser in `probe/src/config.ts` is the integration point for the prompt layer; the prompt code calls into the same `ProbeConfig` shape that's produced today.
- `.ports` file written by `scripts/dev.sh` is the source of truth for local API/web URL defaults in interactive mode (verified to exist in this worktree).
- The `ProbeReport` JSON shape written by `probe/src/report.ts` is the data contract the viewer reads; any future shape change has to be reflected in the viewer.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Which interactive-prompt library to use — `@inquirer/prompts`, `prompts`, `enquirer`, or pure `readline/promises`. Brainstorm settles that prompts happen; planning picks the library.
- [Affects R5][Technical] Whether to write three full file copies per run (`<run-id>.*` + `security-report.*`) or to symlink the latter to the former. Brainstorm picks "copy" for portability; planning may revisit if disk-usage becomes a concern.
- [Affects R10][Technical] How browser auto-open is implemented — `open` npm package, native `xdg-open` / `open` / `start` shell calls, or an explicit `--open` / `--no-open` flag. All variants satisfy R10.
- [Affects R6][Needs research] Whether the history index also embeds a small severity-trend chart across the last N runs, or stays as a flat list. Depends on how much data the index needs to load eagerly.
