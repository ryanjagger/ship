import type { ProbeReport } from '../report.js';
import { loadViewerAssets, type ViewerAssets } from './assets.js';

const THEME_KEY = 'probe-viewer-theme';

export async function renderHtml(report: ProbeReport): Promise<string> {
  const assets = await loadViewerAssets();
  return composeHtml(report, assets);
}

function composeHtml(report: ProbeReport, assets: ViewerAssets): string {
  const json = JSON.stringify(report).replace(/<\/(script)/gi, '<\\/$1');
  const title = `Probe report — ${escapeHtml(report.runId)}`;

  return `<!DOCTYPE html>
<html lang="en" class="theme-dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${assets.tokensCss}${PROBE_EXTRAS_CSS}</style>
<script>${themeInitScript()}</script>
</head>
<body class="sr">
${renderSkeleton()}
<script id="probe-data" type="application/json">${json}</script>
<script>${assets.runtimeJs}</script>
</body>
</html>
`;
}

function themeInitScript(): string {
  return `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)})||'dark';document.documentElement.className='theme-'+(t==='light'?'light':'dark');}catch(e){document.documentElement.className='theme-dark';}})();`;
}

function renderSkeleton(): string {
  return `
<header class="probe-header">
  <div class="probe-breadcrumb">
    <span class="probe-brand">▮ probe</span>
    <span class="probe-crumb-sep">›</span>
    <span id="probe-target" class="probe-target"></span>
    <span class="probe-crumb-sep">›</span>
    <span id="probe-run-id" class="probe-run-id"></span>
  </div>
  <div class="probe-header-spacer"></div>
  <div id="probe-scan-age" class="probe-scan-age"></div>
  <button id="probe-theme-toggle" class="probe-theme-toggle" type="button" aria-label="Toggle theme">☼</button>
</header>

<main class="probe-body">

  <section class="probe-kpi-band" aria-label="Run summary">
    <div class="probe-stat"><div class="probe-stat-value" id="probe-kpi-findings">—</div><div class="probe-stat-label">findings</div></div>
    <div class="probe-stat"><div class="probe-stat-value probe-sev-critical-fg" id="probe-kpi-critical">—</div><div class="probe-stat-label">critical</div></div>
    <div class="probe-stat"><div class="probe-stat-value probe-sev-high-fg" id="probe-kpi-high">—</div><div class="probe-stat-label">high</div></div>
    <div class="probe-stat"><div class="probe-stat-value probe-sev-medium-fg" id="probe-kpi-medium">—</div><div class="probe-stat-label">medium</div></div>
    <div class="probe-stat"><div class="probe-stat-value probe-muted-fg" id="probe-kpi-not-tested">—</div><div class="probe-stat-label">not tested</div></div>
    <div class="probe-stat probe-stat-bar">
      <div class="probe-stat-label">severity mix</div>
      <div class="probe-sev-bar" id="probe-sev-bar" role="img" aria-label="Severity mix"></div>
    </div>
  </section>

  <div class="probe-filter-row">
    <div class="probe-search-wrap">
      <input id="probe-search" class="probe-search" type="search" placeholder="filter findings: check id, title…" autocomplete="off">
    </div>
  </div>

  <nav class="probe-tabs" role="tablist">
    <button class="probe-tab is-active" type="button" role="tab" data-tab="findings">findings <span class="probe-tab-count" id="probe-tab-count-findings">0</span></button>
    <button class="probe-tab" type="button" role="tab" data-tab="not-tested">not-tested <span class="probe-tab-count" id="probe-tab-count-not-tested">0</span></button>
    <button class="probe-tab" type="button" role="tab" data-tab="passed">passed <span class="probe-tab-count" id="probe-tab-count-passed">0</span></button>
    <button class="probe-tab" type="button" role="tab" data-tab="all">all <span class="probe-tab-count" id="probe-tab-count-all">0</span></button>
  </nav>

  <div class="probe-table">
    <div class="probe-table-head">
      <button class="probe-th probe-cell-sev" type="button" data-sort="sev">sev <span class="probe-sort-arrow"></span></button>
      <button class="probe-th probe-cell-id" type="button" data-sort="id">finding <span class="probe-sort-arrow"></span></button>
      <button class="probe-th probe-cell-title" type="button" data-sort="title">title <span class="probe-sort-arrow"></span></button>
      <button class="probe-th probe-cell-surface" type="button" data-sort="surface">surface <span class="probe-sort-arrow"></span></button>
      <button class="probe-th probe-cell-refs" type="button" data-sort="refs">refs <span class="probe-sort-arrow"></span></button>
      <button class="probe-th probe-cell-status" type="button" data-sort="status">status <span class="probe-sort-arrow"></span></button>
      <button class="probe-th probe-cell-age" type="button" data-sort="age">age <span class="probe-sort-arrow"></span></button>
    </div>
    <div id="probe-table-rows" class="probe-table-body"></div>
  </div>

</main>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Probe-specific CSS overlay applied after tokens.css. Defines:
// - status tokens for probe values (finding/pass/not-tested) — tokens.css only
//   has the design's open/fixed/triage/suppressed set
// - severity foreground utility classes used by the KPI stats
// - layout for header / KPI band / tabs / table / search / row badges
// - :focus-visible rule (tokens.css omits focus styles)
const PROBE_EXTRAS_CSS = `

.theme-dark, .theme-light { --status-finding: var(--sev-critical); --status-pass: var(--accent); --status-not-tested: var(--muted); }

button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); min-height: 100vh; font-family: var(--font-mono); font-size: var(--font-size-base); line-height: var(--leading-normal); }

.probe-header { display: flex; align-items: center; gap: 12px; padding: 10px 20px; height: 44px; border-bottom: 1px solid var(--border); background: var(--bg-elev); }
.probe-brand { color: var(--accent); font-weight: 600; }
.probe-breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.probe-crumb-sep { color: var(--muted-2); }
.probe-target { color: var(--text); }
.probe-run-id { color: var(--muted); }
.probe-header-spacer { flex: 1; }
.probe-scan-age { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
.probe-scan-age::before { content: ''; display: inline-block; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; box-shadow: 0 0 8px var(--accent); }
.probe-theme-toggle { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border-strong); background: transparent; color: var(--text); font-family: inherit; font-size: 13px; cursor: pointer; padding: 0; }
.probe-theme-toggle:hover { background: var(--surface-hover); }

.probe-body { padding: 24px 20px 60px; display: flex; flex-direction: column; gap: 20px; }

.probe-kpi-band { display: grid; grid-template-columns: repeat(5, 1fr) 1.4fr; gap: 24px; padding: 20px 24px; border: 1px solid var(--border); background: var(--bg-elev); }
.probe-stat { display: flex; flex-direction: column; gap: 6px; }
.probe-stat-bar { justify-content: flex-end; }
.probe-stat-value { font-size: 28px; line-height: 1; letter-spacing: -0.02em; color: var(--text-strong); font-variant-numeric: tabular-nums; }
.probe-stat-label { color: var(--muted); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.probe-sev-critical-fg { color: var(--sev-critical); }
.probe-sev-high-fg { color: var(--sev-high); }
.probe-sev-medium-fg { color: var(--sev-medium); }
.probe-sev-low-fg { color: var(--sev-low); }
.probe-muted-fg { color: var(--muted); }
.probe-sev-bar { display: flex; width: 100%; height: 6px; gap: 1px; }
.probe-sev-seg { height: 100%; }
.probe-sev-seg.probe-sev-critical { background: var(--sev-critical); }
.probe-sev-seg.probe-sev-high { background: var(--sev-high); }
.probe-sev-seg.probe-sev-medium { background: var(--sev-medium); }
.probe-sev-seg.probe-sev-low { background: var(--sev-low); }
.probe-sev-seg.probe-sev-info { background: var(--sev-info); }
.probe-sev-seg.probe-sev-empty { background: var(--border); }

.probe-filter-row { display: flex; align-items: center; gap: 14px; }
.probe-search-wrap { display: inline-flex; align-items: center; height: 28px; min-width: 360px; padding: 0 10px; border: 1px solid var(--border); background: var(--bg-elev); }
.probe-search { flex: 1; background: transparent; border: none; outline: none; color: inherit; font: inherit; font-size: 11px; min-width: 0; padding: 0; }

.probe-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); padding-left: 4px; }
.probe-tab { display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted); font-family: inherit; font-size: 12px; cursor: pointer; margin-bottom: -1px; letter-spacing: 0.01em; }
.probe-tab.is-active { border-bottom-color: var(--accent); color: var(--text-strong); }
.probe-tab-count { font-size: 10px; color: var(--muted-2); font-variant-numeric: tabular-nums; }
.probe-tab.is-active .probe-tab-count { color: var(--accent); }

.probe-table { border: 1px solid var(--border); background: var(--bg-elev); font-size: 11px; }
.probe-table-head { display: grid; grid-template-columns: 110px 160px 1fr 110px 60px 130px 70px; padding: 0 14px; height: 28px; align-items: center; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; background: var(--bg); }
.probe-th { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: none; padding: 0; color: inherit; font: inherit; font-size: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; text-align: left; }
.probe-sort-arrow { font-size: 9px; }
.probe-table-body { display: flex; flex-direction: column; }
.probe-row { display: grid; grid-template-columns: 110px 160px 1fr 110px 60px 130px 70px; padding: 0 14px; height: 30px; align-items: center; border-bottom: 1px solid var(--border); }
.probe-row:last-child { border-bottom: none; }
.probe-row-zebra { background: var(--row-zebra); }
.probe-row:hover { background: var(--surface-hover); }
.probe-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.probe-cell-id { color: var(--link); font-variant-numeric: tabular-nums; }
.probe-cell-title { color: var(--text-strong); padding-right: 12px; }
.probe-cell-surface { color: var(--muted); }
.probe-cell-refs { text-align: right; color: var(--accent); font-variant-numeric: tabular-nums; }
.probe-cell-age { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.probe-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px; font-size: 10px; letter-spacing: 0.06em; height: 16px; line-height: 1; }
.probe-badge-sev { color: var(--sev-info); background: rgba(139,143,135,0.14); }
.probe-badge-sev.probe-sev-critical { color: var(--sev-critical); background: rgba(255,71,87,0.14); }
.probe-badge-sev.probe-sev-high { color: var(--sev-high); background: rgba(255,138,61,0.14); }
.probe-badge-sev.probe-sev-medium { color: var(--sev-medium); background: rgba(255,210,61,0.14); }
.probe-badge-sev.probe-sev-low { color: var(--sev-low); background: rgba(124,196,255,0.14); }
.probe-badge-status { background: transparent; padding: 0; text-transform: none; letter-spacing: 0.04em; font-size: 11px; }
.probe-badge-status.probe-status-finding { color: var(--status-finding); }
.probe-badge-status.probe-status-pass { color: var(--status-pass); }
.probe-badge-status.probe-status-not-tested { color: var(--status-not-tested); }
.probe-dot { width: 7px; height: 7px; display: inline-block; }
.probe-status-bg-finding { background: var(--status-finding); }
.probe-status-bg-pass { background: var(--status-pass); }
.probe-status-bg-not-tested { background: var(--status-not-tested); }

.probe-empty { padding: 24px; text-align: center; color: var(--muted); font-size: 11px; }
`;
