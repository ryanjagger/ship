import type { ProbeReport } from '../report.js';
import { loadViewerAssets, type ViewerAssets } from './assets.js';
import { PROBE_BASE_CSS } from './css.js';
import { THEME_KEY, themeInitScriptBody } from './theme.js';

export async function renderHtml(report: ProbeReport): Promise<string> {
  const assets = await loadViewerAssets();
  return composeHtml(report, assets);
}

function composeHtml(report: ProbeReport, assets: ViewerAssets): string {
  const json = JSON.stringify(report).replace(/<\/(script)/gi, '<\\/$1');
  const title = `Probe report — ${escapeHtml(report.runId)}`;
  const runtimeJs = assets.runtimeJs.replace(/__PROBE_THEME_KEY__/g, JSON.stringify(THEME_KEY));

  return `<!DOCTYPE html>
<html lang="en" class="theme-dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${assets.tokensCss}${PROBE_BASE_CSS}${PROBE_REPORT_CSS}</style>
<script>${themeInitScriptBody()}</script>
</head>
<body class="sr">
${renderSkeleton()}
<script id="probe-data" type="application/json">${json}</script>
<script>${runtimeJs}</script>
</body>
</html>
`;
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
      <div class="probe-th probe-cell-age">age</div>
    </div>
    <div id="probe-table-rows" class="probe-table-body"></div>
  </div>

</main>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Per-run viewer overlay applied after PROBE_BASE_CSS. Layout/components
// unique to the per-run report: KPI band, tabs, search input, sortable table,
// badges, and the scan-age dot-pulse refinement.
const PROBE_REPORT_CSS = `

.probe-target { color: var(--text); }
.probe-run-id { color: var(--muted); }
.probe-scan-age { display: inline-flex; align-items: center; gap: 6px; }
.probe-scan-age::before { content: ''; display: inline-block; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; box-shadow: 0 0 8px var(--accent); }

.probe-body { display: flex; flex-direction: column; gap: 20px; }

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

.probe-filter-row { display: flex; align-items: center; gap: 14px; }
.probe-search-wrap { display: inline-flex; align-items: center; height: 28px; min-width: 360px; padding: 0 10px; border: 1px solid var(--border); background: var(--bg-elev); }
.probe-search { flex: 1; background: transparent; border: none; outline: none; color: inherit; font: inherit; font-size: 11px; min-width: 0; padding: 0; }

.probe-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); padding-left: 4px; }
.probe-tab { display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted); font-family: inherit; font-size: 12px; cursor: pointer; margin-bottom: -1px; letter-spacing: 0.01em; }
.probe-tab.is-active { border-bottom-color: var(--accent); color: var(--text-strong); }
.probe-tab-count { font-size: 10px; color: var(--muted-2); font-variant-numeric: tabular-nums; }
.probe-tab.is-active .probe-tab-count { color: var(--accent); }

.probe-table-head { display: grid; grid-template-columns: 110px 160px 1fr 110px 60px 130px 70px; padding: 0 14px; height: 28px; align-items: center; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; background: var(--bg); }
.probe-th { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: none; padding: 0; color: inherit; font: inherit; font-size: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; text-align: left; }
.probe-sort-arrow { font-size: 9px; }
.probe-table-body { display: flex; flex-direction: column; }
.probe-row { display: grid; grid-template-columns: 110px 160px 1fr 110px 60px 130px 70px; padding: 0 14px; height: 30px; align-items: center; border-bottom: 1px solid var(--border); cursor: pointer; }
.probe-row:last-child { border-bottom: none; }
.probe-row-zebra { background: var(--row-zebra); }
.probe-row:hover { background: var(--surface-hover); }
.probe-row.is-expanded { background: var(--surface-hover); border-bottom: 1px solid var(--border-strong); }
.probe-row.is-expanded > .probe-cell-id::before { content: '▾ '; color: var(--accent); }

.probe-row-detail { padding: 14px 18px 18px; background: var(--bg); border-left: 2px solid var(--border-strong); }
.probe-row-detail:not(:last-child) { border-bottom: 1px solid var(--border); }
.probe-row-detail-sev-critical { border-left-color: var(--sev-critical); }
.probe-row-detail-sev-high { border-left-color: var(--sev-high); }
.probe-row-detail-sev-medium { border-left-color: var(--sev-medium); }
.probe-row-detail-sev-low { border-left-color: var(--sev-low); }
.probe-row-detail-sev-info { border-left-color: var(--sev-info); }
.probe-detail-heading { color: var(--text-strong); font-size: 12px; margin-bottom: 4px; white-space: normal; }
.probe-detail-meta { color: var(--muted); font-size: 10px; letter-spacing: 0.04em; margin-bottom: 14px; }
.probe-detail-section { margin-top: 12px; }
.probe-detail-label { color: var(--muted); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 6px; }
.probe-detail-steps { margin: 0; padding-left: 20px; color: var(--text); font-size: 11px; line-height: 1.6; }
.probe-detail-steps li { white-space: normal; word-break: break-word; }
.probe-detail-evidence { margin: 0; padding: 10px 12px; background: var(--bg-elev); border: 1px solid var(--border); color: var(--text); font-family: var(--font-mono); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
.probe-cell-title { color: var(--text-strong); padding-right: 12px; }
.probe-cell-surface { color: var(--muted); }
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
`;
