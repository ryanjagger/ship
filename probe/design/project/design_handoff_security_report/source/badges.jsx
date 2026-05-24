// badges.jsx — Status / count badge showcase. Multiple variants laid out as a swatch wall.

function BadgeShowcase() {
  const sevs = ['critical', 'high', 'medium', 'low', 'info'];
  const statuses = ['open', 'triaging', 'fixed', 'monitoring', 'suppressed'];

  const ColLabel = ({ children }) => (
    <div style={{ color: 'var(--muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>{children}</div>
  );

  const Row = ({ items, render }) => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
      {items.map(render)}
    </div>
  );

  return (
    <div style={{ padding: 24, background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 36 }}>

        {/* Severity column */}
        <div>
          <div style={{ color: 'var(--text-strong)', fontSize: 12, marginBottom: 16, letterSpacing: '0.02em' }}>severity</div>

          <ColLabel>solid</ColLabel>
          <Row items={sevs} render={(s) => <Badge key={s} kind={s} variant="solid" />} />

          <ColLabel>outline</ColLabel>
          <Row items={sevs} render={(s) => <Badge key={s} kind={s} variant="outline" />} />

          <ColLabel>with count</ColLabel>
          <Row items={sevs} render={(s) => <Badge key={s} kind={s} variant="solid" count={Math.floor(Math.random() * 90) + 2} />} />

          <ColLabel>minimal · dot + label</ColLabel>
          <Row items={sevs} render={(s) => <Badge key={s} kind={s} variant="minimal" uppercase={false} />} />

          <ColLabel>inline ramp</ColLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, marginBottom: 18 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--sev-critical)' }}>
              <Dot kind="critical" /> 3
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--sev-high)' }}>
              <Dot kind="high" /> 11
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--sev-medium)' }}>
              <Dot kind="medium" /> 42
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--sev-low)' }}>
              <Dot kind="low" /> 91
            </span>
            <span style={{ color: 'var(--muted)' }}>·</span>
            <span style={{ color: 'var(--muted)' }}>247 total</span>
          </div>

          <ColLabel>stacked bar (severity mix)</ColLabel>
          <SeverityBar parts={[
            { kind: 'critical', n: 3 },
            { kind: 'high', n: 11 },
            { kind: 'medium', n: 42 },
            { kind: 'low', n: 91 },
            { kind: 'info', n: 100 },
          ]} />
        </div>

        {/* Status / count column */}
        <div>
          <div style={{ color: 'var(--text-strong)', fontSize: 12, marginBottom: 16, letterSpacing: '0.02em' }}>status & counts</div>

          <ColLabel>minimal · dot + label</ColLabel>
          <Row items={statuses} render={(s) => <Badge key={s} kind={s} variant="minimal" uppercase={false} />} />

          <ColLabel>outline</ColLabel>
          <Row items={statuses} render={(s) => <Badge key={s} kind={s} variant="outline" />} />

          <ColLabel>count chips · ref count</ColLabel>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14, fontSize: 11 }}>
            <span style={{ color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>4</span>
            <span style={{ color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>13</span>
            <span style={{ color: 'var(--sev-medium)', fontVariantNumeric: 'tabular-nums' }}>22</span>
            <span style={{ color: 'var(--sev-high)', fontVariantNumeric: 'tabular-nums' }}>46</span>
            <span style={{ color: 'var(--sev-critical)', fontVariantNumeric: 'tabular-nums' }}>201</span>
            <span style={{ color: 'var(--muted-2)' }}>n/a</span>
          </div>

          <ColLabel>bordered count chips</ColLabel>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
            <CountChip value="3" color="var(--sev-critical)" />
            <CountChip value="11" color="var(--sev-high)" />
            <CountChip value="42" color="var(--sev-medium)" />
            <CountChip value="91" color="var(--sev-low)" />
            <CountChip value="247" color="var(--muted)" />
          </div>

          <ColLabel>tag pills (topics)</ColLabel>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {['auth', 'crypto', 'dependency', 'secrets', 'rce', 'ssrf', 'xss', 'dos'].map(t => (
              <span key={t} style={{
                fontSize: 10, padding: '2px 7px', border: '1px solid var(--border-strong)',
                color: 'var(--muted)',
              }}>{t}</span>
            ))}
          </div>

          <ColLabel>ASCII delta</ColLabel>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', fontSize: 11, marginBottom: 14 }}>
            <span style={{ color: 'var(--sev-critical)' }}>▲ +2 critical</span>
            <span style={{ color: 'var(--accent)' }}>▼ −6 high</span>
            <span style={{ color: 'var(--muted)' }}>± 0 medium</span>
          </div>

          <ColLabel>state tags</ColLabel>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <StateTag>EXPLOITABLE</StateTag>
            <StateTag color="var(--sev-medium)">PATCH AVAILABLE</StateTag>
            <StateTag color="var(--accent)">AUTO-FIXABLE</StateTag>
            <StateTag color="var(--muted)">NO FIX</StateTag>
            <StateTag color="var(--sev-low)">REACHABLE</StateTag>
          </div>
        </div>
      </div>
    </div>
  );
}

function StateTag({ children, color = 'var(--sev-critical)' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 9, letterSpacing: '0.1em', padding: '2px 6px',
      color, border: `1px dashed ${color}`, opacity: 0.95,
    }}>{children}</span>
  );
}

function SeverityBar({ parts, height = 4 }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  return (
    <div style={{ display: 'flex', width: '100%', height, gap: 1, marginBottom: 8 }}>
      {parts.map((p, i) => (
        <div key={i} title={`${p.kind}: ${p.n}`} style={{
          flex: p.n, height: '100%',
          background: `var(--sev-${p.kind})`,
        }} />
      ))}
    </div>
  );
}

Object.assign(window, { BadgeShowcase, SeverityBar, StateTag });
