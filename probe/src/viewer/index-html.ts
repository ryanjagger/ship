import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeReport, ProbeSeverity } from '../report.js';
import { loadViewerAssets } from './assets.js';

const THEME_KEY = 'probe-viewer-theme';

export type RunSummary = {
  runId: string;
  generatedAt: string;
  target: { apiUrl: string; webUrl?: string };
  summary: {
    findings: number;
    notTested: number;
    passed: number;
    bySeverity: Record<ProbeSeverity, number>;
  };
};

export async function scanRuns(outputDir: string): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return [];
  }

  const runFiles = entries.filter((name) => /^probe-.*\.json$/.test(name));
  const summaries: RunSummary[] = [];

  for (const file of runFiles) {
    const path = join(outputDir, file);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as ProbeReport;
      if (!parsed.runId || !parsed.generatedAt || !parsed.summary) continue;
      summaries.push({
        runId: parsed.runId,
        generatedAt: parsed.generatedAt,
        target: parsed.target,
        summary: {
          findings: parsed.summary.findings,
          notTested: parsed.summary.notTested,
          passed: parsed.summary.passed,
          bySeverity: parsed.summary.bySeverity,
        },
      });
    } catch (error) {
      console.warn(`Skipping unparseable run file ${path}: ${(error as Error).message}`);
    }
  }

  summaries.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0));
  return summaries;
}

export async function renderIndexHtml(runs: RunSummary[]): Promise<string> {
  const assets = await loadViewerAssets();
  return composeIndexHtml(runs, assets.tokensCss);
}

function composeIndexHtml(runs: RunSummary[], tokensCss: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="theme-dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Probe — run history</title>
<style>${tokensCss}${INDEX_CSS}</style>
<script>${themeInitScript()}</script>
</head>
<body class="sr">
<header class="probe-header">
  <div class="probe-breadcrumb">
    <span class="probe-brand">▮ probe</span>
    <span class="probe-crumb-sep">›</span>
    <span>run history</span>
  </div>
  <div class="probe-header-spacer"></div>
  <div class="probe-scan-age">${runs.length} run${runs.length === 1 ? '' : 's'}</div>
  <button id="probe-theme-toggle" class="probe-theme-toggle" type="button" aria-label="Toggle theme">☼</button>
</header>

<main class="probe-body">
${runs.length === 0 ? renderEmptyState() : renderTable(runs)}
</main>

<script>${themeToggleScript()}</script>
</body>
</html>
`;
}

function renderEmptyState(): string {
  return `<div class="probe-empty">No runs yet. Run <code>pnpm probe</code>.</div>`;
}

function renderTable(runs: RunSummary[]): string {
  const rows = runs.map(renderRow).join('\n');
  return `<div class="probe-table">
  <div class="probe-table-head probe-index-head">
    <div>when</div>
    <div>target</div>
    <div>findings</div>
    <div>severity mix</div>
    <div>report</div>
  </div>
  <div class="probe-table-body">
    ${rows}
  </div>
</div>`;
}

function renderRow(run: RunSummary, i: number): string {
  const sev = run.summary.bySeverity;
  const parts: Array<{ kind: ProbeSeverity; n: number }> = [
    { kind: 'critical', n: sev.critical || 0 },
    { kind: 'high', n: sev.high || 0 },
    { kind: 'medium', n: sev.medium || 0 },
    { kind: 'low', n: sev.low || 0 },
    { kind: 'info', n: run.summary.passed || 0 },
  ];
  const total = parts.reduce((s, p) => s + p.n, 0);
  const bar = total === 0
    ? `<span class="probe-sev-seg probe-sev-empty" style="flex:1"></span>`
    : parts
        .filter((p) => p.n > 0)
        .map((p) => `<span class="probe-sev-seg probe-sev-${p.kind}" style="flex:${p.n}" title="${p.kind}: ${p.n}"></span>`)
        .join('');

  const ts = escapeHtml(run.generatedAt);
  const target = escapeHtml(safeHostname(run.target?.apiUrl ?? ''));
  const runId = escapeHtml(run.runId);
  const zebra = i % 2 ? ' probe-row-zebra' : '';

  return `<a class="probe-row probe-index-row${zebra}" href="./${runId}.html">
      <div class="probe-cell" title="${ts}">${ts}</div>
      <div class="probe-cell">${target}</div>
      <div class="probe-cell probe-cell-refs">${run.summary.findings}</div>
      <div class="probe-cell"><div class="probe-sev-bar probe-sev-bar-inline">${bar}</div></div>
      <div class="probe-cell probe-cell-id">${runId}</div>
    </a>`;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function themeInitScript(): string {
  return `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)})||'dark';document.documentElement.className='theme-'+(t==='light'?'light':'dark');}catch(e){document.documentElement.className='theme-dark';}})();`;
}

function themeToggleScript(): string {
  return `(function(){var btn=document.getElementById('probe-theme-toggle');if(!btn)return;function paint(){var dark=document.documentElement.className!=='theme-light';btn.textContent=dark?'☼':'☾';btn.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme');}btn.addEventListener('click',function(){var dark=document.documentElement.className!=='theme-light';var next=dark?'light':'dark';document.documentElement.className='theme-'+next;try{localStorage.setItem(${JSON.stringify(THEME_KEY)},next);}catch(e){}paint();});paint();})();`;
}

const INDEX_CSS = `

.theme-dark, .theme-light { --status-finding: var(--sev-critical); --status-pass: var(--accent); --status-not-tested: var(--muted); }
button:focus-visible, a:focus-visible, [tabindex]:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); min-height: 100vh; font-family: var(--font-mono); font-size: var(--font-size-base); line-height: var(--leading-normal); }

.probe-header { display: flex; align-items: center; gap: 12px; padding: 10px 20px; height: 44px; border-bottom: 1px solid var(--border); background: var(--bg-elev); }
.probe-brand { color: var(--accent); font-weight: 600; }
.probe-breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.probe-crumb-sep { color: var(--muted-2); }
.probe-header-spacer { flex: 1; }
.probe-scan-age { color: var(--muted); font-size: 11px; }
.probe-theme-toggle { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border-strong); background: transparent; color: var(--text); font-family: inherit; font-size: 13px; cursor: pointer; padding: 0; }
.probe-theme-toggle:hover { background: var(--surface-hover); }

.probe-body { padding: 24px 20px 60px; }

.probe-table { border: 1px solid var(--border); background: var(--bg-elev); font-size: 11px; }
.probe-table-head.probe-index-head { display: grid; grid-template-columns: 230px 1fr 80px 220px 1fr; padding: 0 14px; height: 28px; align-items: center; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; background: var(--bg); }
.probe-row.probe-index-row { display: grid; grid-template-columns: 230px 1fr 80px 220px 1fr; padding: 0 14px; height: 32px; align-items: center; border-bottom: 1px solid var(--border); color: inherit; text-decoration: none; }
.probe-row.probe-index-row:last-child { border-bottom: none; }
.probe-row.probe-row-zebra { background: var(--row-zebra); }
.probe-row.probe-index-row:hover { background: var(--surface-hover); }
.probe-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.probe-cell-id { color: var(--link); font-variant-numeric: tabular-nums; }
.probe-cell-refs { text-align: right; color: var(--accent); font-variant-numeric: tabular-nums; padding-right: 16px; }

.probe-sev-bar { display: flex; width: 100%; height: 6px; gap: 1px; }
.probe-sev-bar-inline { width: 200px; }
.probe-sev-seg { height: 100%; }
.probe-sev-seg.probe-sev-critical { background: var(--sev-critical); }
.probe-sev-seg.probe-sev-high { background: var(--sev-high); }
.probe-sev-seg.probe-sev-medium { background: var(--sev-medium); }
.probe-sev-seg.probe-sev-low { background: var(--sev-low); }
.probe-sev-seg.probe-sev-info { background: var(--sev-info); }
.probe-sev-seg.probe-sev-empty { background: var(--border); }

.probe-empty { padding: 60px 24px; text-align: center; color: var(--muted); font-size: 12px; }
.probe-empty code { color: var(--accent); }
`;
