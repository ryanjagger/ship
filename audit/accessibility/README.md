# Accessibility Compliance Audit

Audit date: 2026-05-19

Scope: Section 508 / WCAG 2.1 AA spot audit across the major Ship pages using seeded authenticated data.

Pages audited: Login, My Week, Docs, Issues, Programs, Projects, Team Allocation, Team Directory, Team Status, Settings.

## Audit Deliverable

| Metric | Your Baseline |
| --- | --- |
| Lighthouse accessibility score (per page) | Login 98; My Week 95; Docs 100; Issues 100; Programs 100; Projects 100; Team Allocation 96; Team Directory 100; Team Status 96; Settings 94 |
| Total Critical/Serious violations | 4 total: 1 Critical, 3 Serious |
| Keyboard navigation completeness | Full for main controls; Issues uses a roving grid row focus model with arrow-key navigation |
| Color contrast failures | 3 Serious: My Week current/future week labels; Team Allocation current week label; Team Status current week label |
| Missing ARIA labels or roles | 1 Critical: Settings member role `<select>` lacked an accessible name |

## Methodology

- Lighthouse 13.3.0, accessibility category only, desktop viewport 1440x1000.
- `@axe-core/playwright` with `wcag2a`, `wcag2aa`, `wcag21a`, and `wcag21aa` tags.
- Keyboard traversal using Tab, Enter/Escape-safe page setup, and app-supported arrow-key grid behavior.
- Screen-reader proxy checks using semantic structure and accessible-name inspection: page heading count, main/nav landmarks, unnamed buttons, unnamed links, and unnamed form controls.
- Color contrast verification through Lighthouse/axe plus targeted contrast checks for fixed tokens.

Native VoiceOver was not toggled during this automated pass because enabling it changes the local macOS accessibility state. The automated accessibility-tree proxy passed in this baseline audit, but a final human VoiceOver smoke test should still be part of a formal 508 attestation.

## Baseline Findings

| Page | Lighthouse | Critical | Serious | Key Finding |
| --- | ---: | ---: | ---: | --- |
| Login | 98 | 0 | 0 | Missing `main` landmark in Lighthouse |
| My Week | 95 | 0 | 1 | Contrast failures from low-contrast accent text and opacity-dimmed future rows |
| Docs | 100 | 0 | 0 | No automated violations |
| Issues | 100 | 0 | 0 | No automated violations; grid uses roving row focus |
| Programs | 100 | 0 | 0 | No automated violations |
| Projects | 100 | 0 | 0 | No automated violations |
| Team Allocation | 96 | 0 | 1 | Current week label contrast |
| Team Directory | 100 | 0 | 0 | No automated violations |
| Team Status | 96 | 0 | 1 | Current week label contrast |
| Settings | 94 | 1 | 0 | Member role select missing accessible name |

## Recommended Remediation

No remediation was applied as part of this audit. The following changes are recommended for a later remediation pass:

- Add an accessible accent text token, for example `accent-text: #2e8dcc`, for small text on dark surfaces.
- Replace low-contrast `text-accent` usages in My Week, Team Allocation, Team Status, and related current-week headers.
- Remove opacity-based dimming from future My Week rows; use explicit muted colors, borders, or status copy instead so text remains WCAG AA compliant.
- Add accessible names to Settings member role selects, invite role select, and token expiration select.
- Convert the Login page wrapper to a `<main>` landmark or otherwise add a main landmark.
- Add a CI gate that fails on any Critical/Serious axe violation or any Lighthouse accessibility score below 100 on the audited route set.

## Audit Results

Audit run: `node_modules/.bin/playwright test --config audit/accessibility/audit-runner.config.ts`

Lighthouse was installed outside the repo for this audit with:
`npm install --prefix /private/tmp/ship-a11y-tools lighthouse@^13.0.0`

To use a different install location, run the audit with `LIGHTHOUSE_NODE_MODULES=/path/to/node_modules`.

| Page | Lighthouse | axe Critical | axe Serious | Keyboard | Screen-Reader Proxy |
| --- | ---: | ---: | ---: | --- | --- |
| Login | 98 | 0 | 0 | Full, 3/3 | Pass |
| My Week | 95 | 0 | 1 | Full, 25/25 | Pass |
| Docs | 100 | 0 | 0 | Full, 37/37 | Pass |
| Issues | 100 | 0 | 0 | Full, 168/169 Tab focusables; remaining row uses roving grid focus | Pass |
| Programs | 100 | 0 | 0 | Full, 30/30 | Pass |
| Projects | 100 | 0 | 0 | Full, 38/38 | Pass |
| Team Allocation | 96 | 0 | 1 | Full, 45/45 | Pass |
| Team Directory | 100 | 0 | 0 | Full, 18/18 | Pass |
| Team Status | 96 | 0 | 1 | Full, 21/21 | Pass |
| Settings | 94 | 1 | 0 | Full, 19/19 | Pass |

Audit totals:

- Lighthouse accessibility: 94-100 across audited pages.
- axe violations: 1 Critical, 3 Serious, 0 Moderate, 0 Minor.
- Color contrast failures: 3 Serious.
- Missing ARIA labels or roles: 1 Critical.

Raw evidence: `audit/accessibility/results.json`.

## Improvement Plan

Lowest baseline page: Settings at 94/100. A +10 Lighthouse improvement is not mathematically possible from 94 because Lighthouse caps at 100; the maximum possible gain on the current baseline is +6. The goal for the later remediation pass should be to bring Settings to 100 and keep every audited page at 100.

To preserve a 10+ point recovery path if any future page falls to 90 or below:

1. Gate every major route with the audit runner in CI and fail on any Lighthouse accessibility score below 100 or any Critical/Serious axe violation.
2. Add a shared rule for dark-theme semantic colors: use `accent` for filled controls and `accent-text` for small text on dark backgrounds.
3. Ban opacity on containers that contain readable text; use explicit muted colors, borders, icons, or status copy instead.
4. Require explicit labels or `aria-label` on every `select`, combobox, icon-only button, and editable form control.
5. Extend keyboard checks for roving-tabindex widgets to assert arrow-key traversal in addition to Tab reachability.
6. Complete a manual VoiceOver smoke pass for Login, My Week, Docs, and Issues before claiming full Section 508 conformance.
