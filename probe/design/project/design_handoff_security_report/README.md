# Handoff: Probe — App Security Report Components

## Overview
A component set for a single-page **app security report**: header chrome, tabs / segmented controls, status & count badges, and a dense findings table. The aesthetic is a monospace, terminal/dev-tool feel — dark by default, with a paired light theme — intended to surface a lot of severity-coded data with very little decoration.

Five sections of components are presented inside a design-canvas (each artboard has its own ☼/☾ toggle):

1. Page chrome — two header variants
2. Tabs & segmented controls — three patterns
3. Status & count badges — severity + status + counts
4. Findings table — dense, sortable, severity-aware
5. Assembled full page — all components composed

---

## About the Design Files
The files in `preview/` and `source/` are **design references** built in HTML + React (via in-browser Babel). They are **not production code to copy directly**. The task is to recreate them inside the target codebase's existing environment (React, Vue, Svelte, native, etc.) using its established patterns, component primitives, and styling system. If no UI framework exists yet, pick whichever the rest of the app uses; if there is no app yet, React + plain CSS or CSS-in-JS is the closest match to what's here.

The JSX in `source/` is intentionally framework-agnostic: function components, inline styles backed by CSS custom properties, no external dependencies beyond React.

## Fidelity
**High-fidelity.** All colors, spacing, typography, and interaction states are specified. Recreate to pixel-fidelity where possible. The reference screenshot from `release.bar` informed the *vibe* — original aesthetic, not a copy of any branded UI.

---

## Design Tokens

All token values live in `source/tokens.css` as CSS custom properties on `.theme-dark` and `.theme-light`. Apply one of those classes to the report root; nested components read from `var(--…)`.

### Type
| Token | Value |
|---|---|
| Font family | `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |
| Base size | 12px |
| Small | 11px |
| Extra-small | 10px (uppercase labels, badges) |
| Large | 16px |
| KPI display | 28px (single line, letter-spacing: -0.02em) |
| Line-height (UI) | 1.45 |
| Numeric | `font-variant-numeric: tabular-nums` on all numeric cells |

### Severity ramp (theme-agnostic)
| Token | Hex | Use |
|---|---|---|
| `--sev-critical` | `#ff4757` | Critical findings, exploitable items |
| `--sev-high`     | `#ff8a3d` | High findings |
| `--sev-medium`   | `#ffd23d` | Medium findings, patch-available badges |
| `--sev-low`      | `#7cc4ff` | Low findings, monitoring status |
| `--sev-info`     | `#8b8f87` | Info, suppressed, n/a |

Solid badge fill is `rgba(<sev-rgb>, 0.14)` with `--sev-*` as text — i.e. a translucent tint of the same hue.

### Status
| Token | Hex | Use |
|---|---|---|
| `--status-open`       | `#ff4757` | Open finding |
| `--status-fixed`      | `#00e36b` | Resolved |
| `--status-triage`     | `#ffd23d` | Being investigated |
| `--status-suppressed` | `#6a7268` | Manually suppressed |
| (uses `--sev-low` for `monitoring`) | `#7cc4ff` | |

### Theme — Dark
| Token | Hex |
|---|---|
| `--bg`             | `#0a0d0a` |
| `--bg-elev`        | `#0e1110` |
| `--surface`        | `#11140f` |
| `--surface-hover`  | `#161a14` |
| `--border`         | `#1c211c` |
| `--border-strong`  | `#2a2f29` |
| `--text`           | `#cdd6cd` |
| `--text-strong`    | `#ecf2ea` |
| `--muted`          | `#5d6a5d` |
| `--muted-2`        | `#3e463d` |
| `--accent`         | `#00e36b` (terminal green) |
| `--accent-dim`     | `rgba(0, 227, 107, 0.18)` |
| `--link`           | `#00e36b` |

### Theme — Light
| Token | Hex |
|---|---|
| `--bg`             | `#f6f7f3` |
| `--bg-elev`        | `#fbfcf8` |
| `--surface`        | `#ffffff` |
| `--surface-hover`  | `#f0f2ec` |
| `--border`         | `#e3e6dd` |
| `--border-strong`  | `#c9cec1` |
| `--text`           | `#1a1f1a` |
| `--text-strong`    | `#050905` |
| `--muted`          | `#6a7268` |
| `--muted-2`        | `#9aa297` |
| `--accent`         | `#067a3a` (darker green for AA contrast on light) |
| `--link`           | `#067a3a` |

### Geometry & spacing
- **Corner radius**: 0 throughout. Square corners are part of the aesthetic.
- **Borders**: 1px, `var(--border)` for hairlines, `var(--border-strong)` for emphasis (sort indicators, key cap outlines).
- **Row height (dense)**: 30px.
- **Row height (comfortable)**: 38px.
- **Row height (roomy)**: 48px.
- **Header row height**: 28px.
- **Section gutter**: 20–24px vertical.
- **Card padding**: 20–24px.
- **Letter-spacing**: `0.08em` uppercase, `0.04em` titles, `0.02em` body, `0.06em` badges.

---

## Screens / Views

### 1 · Page chrome — Header A (identity + KPIs)
**File**: `source/headers.jsx → HeaderA`

A 200px-tall full-width header with two zones:

- **Top row** (40px tall): product mark + `probe / <project>` path, `main` branch chip, right side: scan timestamp, `export` ghost button, theme toggle.
- **KPI band** (below, 22px gap): five `<Stat>` blocks laid out horizontally: `findings`, `critical`, `risk score`, `last clean build`. Each stat is 28px value + 10px uppercase label, with a small inline delta (`+12`, `−2`, `of 100`) in muted color. Right side has a single-paragraph scan description in muted 10px text.

Component composition:
```
<HeaderA project="web-storefront">
  ├── product-mark (bracket SVG glyph, accent color)
  ├── path: probe / web-storefront [main]
  ├── (flex spacer)
  ├── scan timestamp
  ├── <GhostBtn icon="download">export</GhostBtn>
  └── <GhostBtn icon="sun|moon" /> (theme toggle)
  
  └── KPI row
     ├── <Stat label="findings" value="247" delta="+12" />
     ├── <Stat label="critical" value="3" valueColor="critical" delta="+1" deltaColor="critical" />
     ├── <Stat label="risk score" value="68" deltaLabel="of 100" />
     ├── <Stat label="last clean build" value="3d" deltaLabel="ago" />
     └── scan-description paragraph
```

### 1 · Page chrome — Header B (command-bar)
**File**: `source/headers.jsx → HeaderB`

A tighter, two-row header (~88px total) styled like a developer tool's title-bar:

- **Row 1** (44px): product mark, breadcrumb (`probe › acme-prod › web-storefront @v2.18.0`), search input occupying the center (`jump to finding, file, package…` with `⌘K` key-cap hint), bell + theme toggle, 26×26 avatar tile (accent fill, dark text).
- **Row 2** (~38px): a single-line **severity strip** — `● 3 critical · ● 11 high · ● 42 medium · ● 91 low · 247 findings across 312 packages · scan complete · 6m ago`. Bottom-bordered.

Use Header B as the default for the live tool; Header A for export / share / PDF views.

### 2 · Tabs & segmented — three patterns
**File**: `source/tabs.jsx`

| Component | Use for | Visual |
|---|---|---|
| `TabsUnderline` | Primary page nav (Open / Fixed / Suppressed / All) | 12px text, 2px accent underline on active, count + optional severity dot |
| `TabsSegmented` | View-mode toggles (Table / By package / Graph) | 24px pill row with inset border on active |
| `TabsBracket`   | Terminal-leaning surfaces, alternate styling | `› [ open 247 ]   [ fixed 191 ]` — brackets dim when inactive |

All three accept `{ tabs, active, onChange }`. `tabs` is `[{ id, label, count?, sev?, icon? }]`. Both `count` and `sev` are optional decorators.

### 3 · Status & count badges
**File**: `source/badges.jsx → BadgeShowcase`, primitives in `source/primitives.jsx`

Three badge variants per severity / status, plus six secondary patterns:

| Variant | Visual | Where it's used |
|---|---|---|
| `solid`   | Tinted bg + tinted text, 10px uppercase | Table SEV column |
| `outline` | Hairline border, tinted text | Filter chips, alternate emphasis |
| `minimal` | Dot + label, no bg | Table STATUS column, header severity strip |

Plus:
- **Count chips** — bordered number, sev color (`<CountChip value="3" color="critical" />`)
- **Tag pills** — bordered, muted; for free-form topics (`auth`, `crypto`, `ssrf`, …)
- **State tags** — dashed border, accent text, 9px tracking (`EXPLOITABLE`, `AUTO-FIXABLE`, `PATCH AVAILABLE`)
- **Inline severity ramp** — dot + number, repeated; for header strips
- **Stacked severity bar** — `<SeverityBar parts={[{kind, n}, …]} />`, 4–6px tall, 1px gaps
- **ASCII delta** — `▲ +2 critical`, `▼ −6 high`, `± 0 medium`

### 4 · Findings table
**File**: `source/table.jsx → FindingsTable`

Dense, sortable. 30px rows. 8 columns:

| # | Column | Width | Align | Content |
|---|---|---|---|---|
| 1 | `sev` | 110px | left | `<Badge kind={sev} variant="solid" />` |
| 2 | `finding` | 140px | left | Advisory id (CVE / GHSA / PR) — `var(--link)` color, tabular-nums |
| 3 | `title` | flex 1 | left | One-line, `--text-strong`, ellipsis on overflow |
| 4 | `package · path` | 220px | left | Package name (`--text`) · path / importer count (`--muted-2`) |
| 5 | `ver → fix` | 130px | left | `5.28.2 → 6.21.1` (or `—`). Fix version colored: `--accent` if status=fixed, `--sev-medium` otherwise |
| 6 | `refs` | 50px | right | Reference count — green if ≤5, `--sev-high` if >5 |
| 7 | `status` | 110px | left | `<Badge kind={status} variant="minimal" uppercase={false} />` |
| 8 | `age` | 50px | right | `2h`, `1d`, `3d`, `1w` — muted, tabular-nums |

**Header row**: 28px tall, uppercase 10px labels, click to sort (sort indicator appears as `▲` / `▼` next to active column, in accent color).

**Rows**: 30px. Hover → `--surface-hover`. Alternating rows get a very subtle (`rgba(255,255,255,0.012)` / `rgba(0,0,0,0.012)`) zebra.

Sample data is bundled in `source/table.jsx → FINDINGS` (14 realistic rows mixing CVE / GHSA / PR ids).

### 5 · Assembled · full page
**File**: `source/report-page.jsx → ReportPage`

Composition:
```
<ReportPage>
  ├── <HeaderB />               (sticky-able)
  └── body (24px padding)
     ├── KPI band (5 Stats + severity-mix bar in a 6-column grid)
     ├── filter row
     │    ├── <Input icon="search" placeholder="filter findings: …" width={420} />
     │    ├── dashed filter chips: + sev:critical, + is:reachable, + has:patch, + team:platform
     │    └── <TabsSegmented> for view mode (table / by package / graph)
     ├── <TabsUnderline> primary tabs (open / fixed / suppressed / all)
     ├── <FindingsTable rows={filtered} density="dense" />
     └── footer status line: count · scan id · next scan in 53m · "all systems nominal" (accent)
```

---

## Interactions & Behavior

| Surface | Trigger | Effect |
|---|---|---|
| Theme toggle (☼/☾) | Click | Switch between `theme-dark` and `theme-light` on the root. No transition — instant. |
| Tab header | Click | Sets `active` tab; underline indicator moves (no animation in source — feel free to add `transition: border-color 120ms` if desired). |
| Segmented control | Click | Same as tabs. |
| Column header | Click | Toggles sort: ascending → descending → ascending on same column; switching columns resets to asc. Severity column uses an ordinal sort: `critical < high < medium < low < info`. |
| Row | Hover | Background → `--surface-hover`. **Click** is wired for navigation to the finding detail (not implemented in the prototype). |
| Search input | Type | Live-filters rows by case-insensitive substring across `title + id + package + file`. |
| Filter chips (`+ sev:critical` etc.) | Click | Currently inert — these are stubs for the query-builder. Implement as token chips that append to a query string. |

### State (assembled page)
- `activeTab: 'open' | 'fixed' | 'suppressed' | 'all'`
- `activeView: 'table' | 'group' | 'graph'`
- `q: string` (filter)
- `sort: { id: ColumnId, dir: 'asc' | 'desc' }` (lives inside `FindingsTable`)
- `theme: 'dark' | 'light'`
- `hover: number | null` (row index — lives inside `FindingsTable`)

### Keyboard
The reference includes a `⌘K` key-cap in Header B but the shortcut itself isn't bound — wire it to your existing command-palette / quick-jump if one exists. Suggested additional bindings:
- `/` — focus the filter input
- `j` / `k` — move row hover up / down
- `enter` — open hovered row

---

## Iconography

`source/primitives.jsx` defines a 12×12 SVG icon set rendered via `<Icon name="…" />`. All icons are stroke-based, 1.5px stroke, `square` caps, `miter` joins — keep this rule when adding more.

Available names: `chevron`, `chevronUp`, `search`, `close`, `plus`, `sort`, `sortAsc`, `sortDesc`, `arrowRight`, `check`, `external`, `filter`, `shield`, `bug`, `git`, `dot`, `eye`, `download`, `refresh`, `kebab`, `bell`, `lock`, `triangle`, `diamond`, `moon`, `sun`.

If your app already has an icon library (lucide-react, phosphor, heroicons), drop ours and use yours — match the 12px size and 1.5px stroke for consistency.

---

## Sample data

`source/table.jsx → FINDINGS` contains 14 realistic rows covering all severity/status combinations. Use this only as a fixture for UI development — replace with real API data shaped like:

```ts
type Finding = {
  id: string;                    // 'CVE-2024-39338' | 'GHSA-…' | 'PR-7741' | 'SEC-1192'
  sev: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  pkg: string;                   // package name or file path
  ver: string | '—';             // current version (— if not a dep finding)
  fixIn: string | '—';           // fixed-in version
  status: 'open' | 'triaging' | 'fixed' | 'monitoring' | 'suppressed';
  age: string;                   // pre-formatted '2h', '1d', '3d', '1w' — or compute from a Date
  refs: number;                  // number of importer / call-site references
  file: string;                  // path or 'N importers'
};
```

---

## Files in this handoff

```
design_handoff_security_report/
├── README.md                          ← this file
├── preview/
│   └── Security Report Components.html ← open this in a browser to see all components
└── source/
    ├── tokens.css                     ← CSS custom properties for dark + light
    ├── primitives.jsx                 ← Icon, Dot, Badge, CountChip, Bracketed,
    │                                    GhostBtn, Input, Kbd, SEV/STATUS constants
    ├── headers.jsx                    ← HeaderA, HeaderB, Stat
    ├── tabs.jsx                       ← TabsUnderline, TabsSegmented, TabsBracket
    ├── badges.jsx                     ← BadgeShowcase, SeverityBar, StateTag
    ├── table.jsx                      ← FindingsTable, FINDINGS sample data, COLS
    └── report-page.jsx                ← ReportPage (assembled view)
```

---

## Implementation notes for Claude Code

- **Don't ship the JSX as-is.** It uses inline `style={{ … }}` because the prototype loads in-browser Babel. Port to whichever pattern the target repo uses — Tailwind, CSS Modules, vanilla-extract, styled-components, etc. The CSS variables in `tokens.css` should carry over verbatim.
- **Square corners are intentional.** If the host codebase has a global `border-radius` default, override it on this surface.
- **Monospace everywhere.** If JetBrains Mono isn't already loaded, add it (Google Fonts: weights 300/400/500/600). Falls back gracefully to the system mono stack.
- **Theme is a class on the root**, not a media query — `.theme-dark` / `.theme-light`. Make sure your top-level wrapper applies one of these, and honor the user's OS preference plus an explicit override.
- **Tabular numerals** matter a lot in the table — apply `font-variant-numeric: tabular-nums` to every numeric cell or globally on the table.
- **Density.** The 30px rows are tight. If the host design system has a min hit-target of 32 or 36px for rows, bump the density prop to `'comfortable'` (38px) and verify with the design team before shipping.
