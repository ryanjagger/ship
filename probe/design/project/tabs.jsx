// tabs.jsx — Three tabs / segmented control variants.

function TabsUnderline({ tabs, active, onChange }) {
  // Variant A — underline tabs with neutral counts. Most legible / report-y.
  return (
    <div style={{
      display: 'flex', gap: 0, borderBottom: '1px solid var(--border)',
      paddingLeft: 4,
    }}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button key={t.id} onClick={() => onChange?.(t.id)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '10px 14px', background: 'transparent', border: 'none',
            borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
            color: isActive ? 'var(--text-strong)' : 'var(--muted)',
            fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
            marginBottom: -1, letterSpacing: '0.01em',
          }}>
            <span>{t.label}</span>
            {t.count != null && (
              <span style={{
                fontSize: 10, color: isActive ? 'var(--accent)' : 'var(--muted-2)',
                fontVariantNumeric: 'tabular-nums',
              }}>{t.count}</span>
            )}
            {t.sev && <Dot kind={t.sev} size={6} />}
          </button>
        );
      })}
    </div>
  );
}

function TabsSegmented({ tabs, active, onChange }) {
  // Variant B — pill segmented control. Best for short option sets / view modes.
  return (
    <div style={{
      display: 'inline-flex', padding: 2, border: '1px solid var(--border)',
      background: 'var(--bg-elev)',
    }}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button key={t.id} onClick={() => onChange?.(t.id)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', height: 24, border: 'none',
            background: isActive ? 'var(--surface-hover)' : 'transparent',
            color: isActive ? 'var(--text-strong)' : 'var(--muted)',
            fontFamily: 'inherit', fontSize: 11, cursor: 'pointer',
            position: 'relative',
            boxShadow: isActive ? 'inset 0 0 0 1px var(--border-strong)' : 'none',
          }}>
            {t.icon && <Icon name={t.icon} color={isActive ? 'var(--text-strong)' : 'var(--muted)'} />}
            <span>{t.label}</span>
            {t.count != null && (
              <span style={{
                fontSize: 10, opacity: 0.7, fontVariantNumeric: 'tabular-nums',
              }}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TabsBracket({ tabs, active, onChange }) {
  // Variant C — terminal-style bracket tabs with prefix glyph.
  // Reads like `> [ open 247 ]   [ fixed 1.2k ]   [ all 1.4k ]`.
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12 }}>
      <span style={{ color: 'var(--accent)' }}>›</span>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button key={t.id} onClick={() => onChange?.(t.id)} style={{
            background: 'transparent', border: 'none', padding: 0,
            font: 'inherit', cursor: 'pointer',
            color: isActive ? 'var(--accent)' : 'var(--muted)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{ opacity: isActive ? 1 : 0.4 }}>[</span>
            <span style={{ padding: '0 2px', color: isActive ? 'var(--text-strong)' : 'inherit' }}>
              {t.label}
              {t.count != null && (
                <span style={{ color: isActive ? 'var(--accent)' : 'var(--muted-2)', marginLeft: 6, fontVariantNumeric: 'tabular-nums' }}>
                  {t.count}
                </span>
              )}
            </span>
            <span style={{ opacity: isActive ? 1 : 0.4 }}>]</span>
          </button>
        );
      })}
    </div>
  );
}

Object.assign(window, { TabsUnderline, TabsSegmented, TabsBracket });
