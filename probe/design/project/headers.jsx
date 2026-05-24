// headers.jsx — Header / page chrome variants for a security report app.
// All headers share the same product context: "probe · security report"
// scanning a hypothetical app codebase. Original aesthetic.

function HeaderA({ theme, onToggleTheme, project = 'web-storefront' }) {
  // Variant A: meta-driven, identity-first.
  // logo · product · slash · project name (editable feel) · ━━━━━ · stats
  return (
    <div style={{
      padding: '22px 28px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* product mark — small bracketed glyph */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          color: 'var(--accent)', fontSize: 13, letterSpacing: '0.04em',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 2 L2 12 L4 12 M12 2 L12 12 L10 12 M5 7 L9 7" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span style={{ fontWeight: 500 }}>probe</span>
          <span style={{ color: 'var(--muted-2)' }}>/</span>
          <span style={{ color: 'var(--text)' }}>{project}</span>
          <span style={{ color: 'var(--muted)', fontSize: 10, padding: '1px 5px', border: '1px solid var(--border)' }}>main</span>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 10 }}>
          <Icon name="refresh" color="var(--muted)" />
          <span>scanned 14:22:08 · 6 minutes ago</span>
        </div>
        <GhostBtn icon="download">export</GhostBtn>
        <GhostBtn icon={theme === 'dark' ? 'sun' : 'moon'} onClick={onToggleTheme} />
      </div>

      {/* stat bar — three KPIs, low-key */}
      <div style={{ display: 'flex', gap: 56, marginTop: 22, alignItems: 'flex-end' }}>
        <Stat label="findings" value="247" delta="+12" />
        <Stat label="critical" value="3" valueColor="var(--sev-critical)" delta="+1" deltaColor="var(--sev-critical)" />
        <Stat label="risk score" value="68" deltaLabel="of 100" />
        <Stat label="last clean build" value="3d" deltaLabel="ago" />
        <div style={{ flex: 1 }} />
        <div style={{ color: 'var(--muted)', fontSize: 10, lineHeight: 1.6, maxWidth: 320 }}>
          Static + dependency analysis across <span style={{ color: 'var(--text)' }}>1,284 files</span> and <span style={{ color: 'var(--text)' }}>312 packages</span>. Includes SAST, secrets, and SBOM diff vs last release.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, delta, deltaLabel, deltaColor, valueColor }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 28, lineHeight: 1, fontWeight: 400, letterSpacing: '-0.02em',
        color: valueColor || 'var(--text-strong)',
      }}>
        {value}
        {(delta || deltaLabel) && (
          <span style={{ fontSize: 11, marginLeft: 8, color: deltaColor || 'var(--muted)', letterSpacing: 0 }}>
            {delta || deltaLabel}
          </span>
        )}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

function HeaderB({ theme, onToggleTheme }) {
  // Variant B: command-bar style. ASCII slash + path · search · actions.
  // No big KPIs — they live in the body. Tighter, more "tool" than "report".
  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elev)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 20px', height: 44,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)', fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>▮</span>
          <span style={{ color: 'var(--text)' }}>probe</span>
        </div>
        <span style={{ color: 'var(--muted-2)' }}>›</span>
        <span style={{ color: 'var(--text)', fontSize: 12 }}>acme-prod</span>
        <span style={{ color: 'var(--muted-2)' }}>›</span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>web-storefront</span>
        <span style={{ color: 'var(--muted)', fontSize: 10, padding: '1px 5px', border: '1px solid var(--border)' }}>@v2.18.0</span>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', border: '1px solid var(--border)', background: 'var(--bg)', minWidth: 320, color: 'var(--muted)' }}>
          <Icon name="search" color="var(--muted)" />
          <span style={{ fontSize: 11, flex: 1 }}>jump to finding, file, package…</span>
          <Kbd>⌘</Kbd><Kbd>K</Kbd>
        </div>

        <GhostBtn icon="bell" />
        <GhostBtn icon={theme === 'dark' ? 'sun' : 'moon'} onClick={onToggleTheme} />
        <div style={{
          width: 26, height: 26, background: 'var(--accent)', color: '#0a0d0a',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 600,
        }}>sk</div>
      </div>

      {/* Sub-row: scan summary one-liner, like a status line in a terminal */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '8px 20px', borderTop: '1px solid var(--border)',
        background: 'var(--bg)', fontSize: 11, color: 'var(--muted)',
      }}>
        <span><Dot kind="critical" /> <span style={{ color: 'var(--sev-critical)', marginLeft: 6 }}>3 critical</span></span>
        <span><Dot kind="high" /> <span style={{ color: 'var(--sev-high)', marginLeft: 6 }}>11 high</span></span>
        <span><Dot kind="medium" /> <span style={{ color: 'var(--sev-medium)', marginLeft: 6 }}>42 medium</span></span>
        <span><Dot kind="low" /> <span style={{ color: 'var(--sev-low)', marginLeft: 6 }}>91 low</span></span>
        <span style={{ color: 'var(--muted-2)' }}>·</span>
        <span>247 findings across 312 packages</span>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, background: 'var(--accent)', borderRadius: '50%', boxShadow: '0 0 8px var(--accent)' }} />
          scan complete · 6m ago
        </span>
      </div>
    </div>
  );
}

Object.assign(window, { HeaderA, HeaderB, Stat });
