// report-page.jsx — Full-bleed assembled security report page using all primitives.
// This is the "in-context" view — shows how the components fit together.

function ReportPage({ theme, onToggleTheme }) {
  const [activeTab, setActiveTab] = React.useState('open');
  const [activeView, setActiveView] = React.useState('table');
  const [q, setQ] = React.useState('');

  // Counts derived from FINDINGS (the source list)
  const counts = React.useMemo(() => {
    const open = FINDINGS.filter(r => r.status !== 'fixed' && r.status !== 'suppressed').length;
    const fixed = FINDINGS.filter(r => r.status === 'fixed').length;
    return { open, fixed, all: FINDINGS.length, suppressed: FINDINGS.filter(r => r.status === 'suppressed').length };
  }, []);

  const tabRows = React.useMemo(() => {
    let r = FINDINGS;
    if (activeTab === 'open')        r = r.filter(x => x.status !== 'fixed' && x.status !== 'suppressed');
    else if (activeTab === 'fixed')  r = r.filter(x => x.status === 'fixed');
    else if (activeTab === 'suppressed') r = r.filter(x => x.status === 'suppressed');
    if (q.trim()) {
      const Q = q.toLowerCase();
      r = r.filter(x => (x.title + x.id + x.pkg + x.file).toLowerCase().includes(Q));
    }
    return r;
  }, [activeTab, q]);

  return (
    <div className={`sr theme-${theme}`} style={{ minHeight: '100%', background: 'var(--bg)' }}>
      <HeaderB theme={theme} onToggleTheme={onToggleTheme} />

      {/* Body */}
      <div style={{ padding: '24px 20px 60px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Hero KPI band */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) 1.4fr',
          gap: 24, padding: '20px 24px',
          border: '1px solid var(--border)', background: 'var(--bg-elev)',
        }}>
          <Stat label="findings" value="247" delta="+12 wk" />
          <Stat label="critical" value="3" valueColor="var(--sev-critical)" delta="+1" deltaColor="var(--sev-critical)" />
          <Stat label="high" value="11" valueColor="var(--sev-high)" delta="−2" deltaColor="var(--accent)" />
          <Stat label="risk score" value="68" deltaLabel="/ 100" />
          <Stat label="auto-fixable" value="184" valueColor="var(--accent)" deltaLabel="74%" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>severity mix</div>
            <SeverityBar parts={[
              { kind: 'critical', n: 3 },
              { kind: 'high', n: 11 },
              { kind: 'medium', n: 42 },
              { kind: 'low', n: 91 },
              { kind: 'info', n: 100 },
            ]} height={6} />
            <div style={{ display: 'flex', gap: 14, fontSize: 10 }}>
              <span style={{ color: 'var(--sev-critical)' }}><Dot kind="critical" size={6} /> 3</span>
              <span style={{ color: 'var(--sev-high)' }}><Dot kind="high" size={6} /> 11</span>
              <span style={{ color: 'var(--sev-medium)' }}><Dot kind="medium" size={6} /> 42</span>
              <span style={{ color: 'var(--sev-low)' }}><Dot kind="low" size={6} /> 91</span>
              <span style={{ color: 'var(--muted)' }}><Dot kind="info" size={6} /> 100</span>
            </div>
          </div>
        </div>

        {/* Filter + view controls row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <Input value={q} onChange={setQ} placeholder="filter findings: package, file, advisory, owner…" width={420} />
          <span style={{ color: 'var(--muted)', fontSize: 10 }}>or:</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {['sev:critical', 'is:reachable', 'has:patch', 'team:platform'].map(f => (
              <button key={f} style={{
                fontSize: 10, padding: '4px 8px', border: '1px dashed var(--border-strong)',
                background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
                fontFamily: 'inherit',
              }}>+ {f}</button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <TabsSegmented tabs={[
            { id: 'table', label: 'table', icon: 'sort' },
            { id: 'group', label: 'by package' },
            { id: 'graph', label: 'graph' },
          ]} active={activeView} onChange={setActiveView} />
        </div>

        {/* Tab row */}
        <TabsUnderline
          active={activeTab} onChange={setActiveTab}
          tabs={[
            { id: 'open',       label: 'open',       count: counts.open,       sev: 'critical' },
            { id: 'fixed',      label: 'fixed',      count: counts.fixed },
            { id: 'suppressed', label: 'suppressed', count: counts.suppressed },
            { id: 'all',        label: 'all',        count: counts.all },
          ]}
        />

        {/* Table */}
        <FindingsTable rows={tabRows} density="dense" />

        {/* Footer status line */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          color: 'var(--muted)', fontSize: 10, paddingTop: 4,
        }}>
          <span>{tabRows.length} findings · sorted by severity</span>
          <span>·</span>
          <span>scan id <span style={{ color: 'var(--text)' }}>0x8a1f.b09c</span></span>
          <span>·</span>
          <span>next scan in 53m</span>
          <div style={{ flex: 1 }} />
          <span style={{ color: 'var(--accent)' }}>▲ all systems nominal</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ReportPage });
