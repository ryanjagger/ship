// Probe report viewer runtime. Vanilla JS, IIFE, inlined into per-run HTML.
// Reads the inlined report JSON, hydrates the skeleton DOM, wires interactions.
// Mirrors the field shape of ProbeReport / ProbeCheck in probe/src/report.ts —
// if the schema changes there, this file must change too.

(function () {
  'use strict';

  // Template placeholder. html.ts replaces __PROBE_THEME_KEY__ with
  // JSON.stringify(THEME_KEY) from viewer/theme.ts at emit time so the key
  // string is declared once.
  var THEME_KEY = __PROBE_THEME_KEY__;
  var SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  var STATUS_ORDER = { finding: 0, 'not-tested': 1, pass: 2 };

  var dataEl = document.getElementById('probe-data');
  if (!dataEl) return;
  var report;
  try {
    report = JSON.parse(dataEl.textContent || '{}');
  } catch (e) {
    document.body.innerHTML = '<pre style="padding:20px">Probe report data unparseable: ' + escapeText(e.message) + '</pre>';
    return;
  }

  var state = {
    tab: 'findings',
    search: '',
    sortKey: 'sev',
    sortDir: 'asc',
    expandedId: null,
  };

  hydrateHeader();
  hydrateKpis();
  wireSearch();
  wireTabs();
  wireSort();
  wireThemeToggle();
  render();

  // ---------- Header / chrome ----------

  function hydrateHeader() {
    var hostname = '';
    try { hostname = new URL(report.target.apiUrl).hostname; } catch (e) { hostname = report.target.apiUrl; }
    setText('probe-target', hostname);

    var runSuffix = (report.runId || '').split('-').pop() || report.runId || '';
    setText('probe-run-id', runSuffix);

    setText('probe-scan-age', 'scan complete · ' + formatAge(report.generatedAt));
  }

  // ---------- KPI band ----------

  function hydrateKpis() {
    var sev = (report.summary && report.summary.bySeverity) || {};
    setText('probe-kpi-findings', String(report.summary ? report.summary.findings : 0));
    setText('probe-kpi-critical', String(sev.critical || 0));
    setText('probe-kpi-high', String(sev.high || 0));
    setText('probe-kpi-medium', String(sev.medium || 0));
    setText('probe-kpi-not-tested', String(report.summary ? report.summary.notTested : 0));

    var parts = [
      { kind: 'critical', n: sev.critical || 0 },
      { kind: 'high', n: sev.high || 0 },
      { kind: 'medium', n: sev.medium || 0 },
      { kind: 'low', n: sev.low || 0 },
      { kind: 'info', n: (report.summary && report.summary.passed) || 0 },
    ];
    var total = parts.reduce(function (s, p) { return s + p.n; }, 0);
    var bar = document.getElementById('probe-sev-bar');
    if (bar) {
      bar.innerHTML = '';
      parts.forEach(function (p) {
        if (p.n === 0) return;
        var seg = document.createElement('span');
        seg.className = 'probe-sev-seg probe-sev-' + p.kind;
        seg.style.flex = String(p.n);
        seg.title = p.kind + ': ' + p.n;
        bar.appendChild(seg);
      });
      if (total === 0) bar.innerHTML = '<span class="probe-sev-seg probe-sev-empty" style="flex:1"></span>';
    }
  }

  // ---------- Tabs ----------

  function wireTabs() {
    var nodes = document.querySelectorAll('[data-tab]');
    Array.prototype.forEach.call(nodes, function (node) {
      node.addEventListener('click', function () {
        state.tab = node.getAttribute('data-tab');
        render();
      });
    });
  }

  function tabRows() {
    var checks = report.checks || [];
    if (state.tab === 'findings') return checks.filter(function (c) { return c.status === 'finding'; });
    if (state.tab === 'not-tested') return checks.filter(function (c) { return c.status === 'not-tested'; });
    if (state.tab === 'passed') return checks.filter(function (c) { return c.status === 'pass'; });
    return checks.slice();
  }

  function tabCounts() {
    var checks = report.checks || [];
    return {
      findings: checks.filter(function (c) { return c.status === 'finding'; }).length,
      'not-tested': checks.filter(function (c) { return c.status === 'not-tested'; }).length,
      passed: checks.filter(function (c) { return c.status === 'pass'; }).length,
      all: checks.length,
    };
  }

  // ---------- Search ----------

  function wireSearch() {
    var input = document.getElementById('probe-search');
    if (!input) return;
    input.addEventListener('input', function (e) {
      state.search = (e.target.value || '').toLowerCase().trim();
      render();
    });
  }

  // ---------- Sort ----------

  function wireSort() {
    var nodes = document.querySelectorAll('[data-sort]');
    Array.prototype.forEach.call(nodes, function (node) {
      node.addEventListener('click', function () {
        var key = node.getAttribute('data-sort');
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDir = 'asc';
        }
        render();
      });
    });
  }

  function sortRows(rows) {
    var key = state.sortKey;
    var dir = state.sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function sortValue(check, key) {
    if (key === 'sev') return SEV_ORDER[check.severity] != null ? SEV_ORDER[check.severity] : 9;
    if (key === 'status') return STATUS_ORDER[check.status] != null ? STATUS_ORDER[check.status] : 9;
    if (key === 'refs') return refCount(check);
    return String(check[key] || '').toLowerCase();
  }

  // ---------- Theme ----------

  function wireThemeToggle() {
    var toggle = document.getElementById('probe-theme-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var current = document.documentElement.className === 'theme-light' ? 'light' : 'dark';
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.className = 'theme-' + next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      updateThemeGlyph();
    });
    updateThemeGlyph();
  }

  function updateThemeGlyph() {
    var toggle = document.getElementById('probe-theme-toggle');
    if (!toggle) return;
    var isDark = document.documentElement.className !== 'theme-light';
    toggle.textContent = isDark ? '☼' : '☾';
    toggle.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
  }

  // ---------- Render loop ----------

  function render() {
    var counts = tabCounts();
    setText('probe-tab-count-findings', String(counts.findings));
    setText('probe-tab-count-not-tested', String(counts['not-tested']));
    setText('probe-tab-count-passed', String(counts.passed));
    setText('probe-tab-count-all', String(counts.all));

    var tabs = document.querySelectorAll('[data-tab]');
    Array.prototype.forEach.call(tabs, function (node) {
      node.classList.toggle('is-active', node.getAttribute('data-tab') === state.tab);
    });

    var headers = document.querySelectorAll('[data-sort]');
    Array.prototype.forEach.call(headers, function (node) {
      var key = node.getAttribute('data-sort');
      var arrow = node.querySelector('.probe-sort-arrow');
      if (!arrow) return;
      if (key === state.sortKey) {
        arrow.textContent = state.sortDir === 'asc' ? '▲' : '▼';
        arrow.style.color = 'var(--accent)';
      } else {
        arrow.textContent = '';
      }
    });

    var rows = tabRows();
    if (state.search) {
      rows = rows.filter(function (c) {
        return (c.id + ' ' + c.title).toLowerCase().indexOf(state.search) >= 0;
      });
    }
    rows = sortRows(rows);

    var tbody = document.getElementById('probe-table-rows');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (rows.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'probe-empty';
      empty.textContent = (report.checks && report.checks.length === 0) ? 'no checks ran' : 'no rows match this filter';
      tbody.appendChild(empty);
      return;
    }
    // Reset expansion when the visible row set changes (filter/search/sort).
    state.expandedId = null;
    rows.forEach(function (check, i) {
      tbody.appendChild(renderRow(check, i));
    });
  }

  function renderRow(check, i) {
    var row = document.createElement('div');
    row.className = 'probe-row' + (i % 2 ? ' probe-row-zebra' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'false');
    row.dataset.checkId = check.id;

    row.appendChild(cellBadge(check.severity, 'sev'));
    row.appendChild(cellText(check.id, 'probe-cell-id'));
    row.appendChild(cellText(check.title, 'probe-cell-title'));
    row.appendChild(cellText(check.surface, 'probe-cell-surface'));
    row.appendChild(cellText(String(refCount(check)), 'probe-cell-refs'));
    row.appendChild(cellBadge(check.status, 'status'));
    row.appendChild(cellText(formatAge(report.generatedAt), 'probe-cell-age'));

    function toggle() {
      var isOpen = row.classList.contains('is-expanded');
      collapseAll();
      if (!isOpen) expandRow(row, check);
    }
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    return row;
  }

  function collapseAll() {
    var open = document.querySelectorAll('.probe-row.is-expanded');
    Array.prototype.forEach.call(open, function (row) {
      row.classList.remove('is-expanded');
      row.setAttribute('aria-expanded', 'false');
      var next = row.nextElementSibling;
      if (next && next.classList.contains('probe-row-detail')) next.parentNode.removeChild(next);
    });
    state.expandedId = null;
  }

  function expandRow(row, check) {
    row.classList.add('is-expanded');
    row.setAttribute('aria-expanded', 'true');
    state.expandedId = check.id;
    var detail = renderDetail(check);
    row.parentNode.insertBefore(detail, row.nextSibling);
  }

  function renderDetail(check) {
    var wrap = document.createElement('div');
    wrap.className = 'probe-row-detail probe-row-detail-sev-' + check.severity;

    var heading = document.createElement('div');
    heading.className = 'probe-detail-heading';
    heading.textContent = check.title;
    wrap.appendChild(heading);

    var meta = document.createElement('div');
    meta.className = 'probe-detail-meta';
    meta.textContent = check.id + ' · ' + check.surface + ' · ' + check.severity + ' · ' + check.status;
    wrap.appendChild(meta);

    var steps = (check.reproductionSteps && check.reproductionSteps.length) ? check.reproductionSteps : [];
    if (steps.length > 0) {
      var stepsSection = document.createElement('div');
      stepsSection.className = 'probe-detail-section';
      var stepsLabel = document.createElement('div');
      stepsLabel.className = 'probe-detail-label';
      stepsLabel.textContent = 'reproduction steps';
      stepsSection.appendChild(stepsLabel);
      var ol = document.createElement('ol');
      ol.className = 'probe-detail-steps';
      steps.forEach(function (step) {
        var li = document.createElement('li');
        li.textContent = String(step);
        ol.appendChild(li);
      });
      stepsSection.appendChild(ol);
      wrap.appendChild(stepsSection);
    }

    if (check.evidence !== undefined && check.evidence !== null) {
      var evSection = document.createElement('div');
      evSection.className = 'probe-detail-section';
      var evLabel = document.createElement('div');
      evLabel.className = 'probe-detail-label';
      evLabel.textContent = 'evidence';
      evSection.appendChild(evLabel);
      var pre = document.createElement('pre');
      pre.className = 'probe-detail-evidence';
      try {
        pre.textContent = JSON.stringify(check.evidence, null, 2);
      } catch (e) {
        pre.textContent = String(check.evidence);
      }
      evSection.appendChild(pre);
      wrap.appendChild(evSection);
    }

    return wrap;
  }

  function cellBadge(value, kind) {
    var el = document.createElement('div');
    el.className = 'probe-cell probe-cell-' + kind;
    var badge = document.createElement('span');
    if (kind === 'sev') {
      badge.className = 'probe-badge probe-badge-sev probe-sev-' + value;
      badge.textContent = String(value || '').toUpperCase();
    } else {
      badge.className = 'probe-badge probe-badge-status probe-status-' + value;
      var dot = document.createElement('span');
      dot.className = 'probe-dot probe-status-bg-' + value;
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(' ' + (value || '')));
    }
    el.appendChild(badge);
    return el;
  }

  function cellText(value, className) {
    var el = document.createElement('div');
    el.className = 'probe-cell ' + className;
    el.textContent = String(value == null ? '' : value);
    return el;
  }

  function refCount(check) {
    var reps = (check.reproductionSteps && check.reproductionSteps.length) || 0;
    var evid = check.evidence && typeof check.evidence === 'object' ? Object.keys(check.evidence).length : 0;
    return reps + evid;
  }

  // ---------- Utilities ----------

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatAge(iso) {
    if (!iso) return '';
    var ts = Date.parse(iso);
    if (isNaN(ts)) return '';
    var diff = Math.max(0, Date.now() - ts);
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }
})();
