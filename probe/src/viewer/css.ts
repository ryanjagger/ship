// Base CSS shared by the per-run viewer and the run-history index. Both pages
// inline tokens.css from probe/design/, then this base, then their own overlay.
// Anything that appears in both pages lives here so changes can't drift.

export const PROBE_BASE_CSS = `

.theme-dark, .theme-light { --status-finding: var(--sev-critical); --status-pass: var(--accent); --status-not-tested: var(--muted); }

button:focus-visible, a:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

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
.probe-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.probe-cell-id { color: var(--link); font-variant-numeric: tabular-nums; }
.probe-cell-refs { text-align: right; color: var(--accent); font-variant-numeric: tabular-nums; }

.probe-sev-bar { display: flex; width: 100%; height: 6px; gap: 1px; }
.probe-sev-seg { height: 100%; }
.probe-sev-seg.probe-sev-critical { background: var(--sev-critical); }
.probe-sev-seg.probe-sev-high { background: var(--sev-high); }
.probe-sev-seg.probe-sev-medium { background: var(--sev-medium); }
.probe-sev-seg.probe-sev-low { background: var(--sev-low); }
.probe-sev-seg.probe-sev-info { background: var(--sev-info); }
.probe-sev-seg.probe-sev-empty { background: var(--border); }

.probe-empty { padding: 24px; text-align: center; color: var(--muted); font-size: 11px; }
`;
