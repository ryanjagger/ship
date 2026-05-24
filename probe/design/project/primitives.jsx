// primitives.jsx — small reusable atoms (Badge, Dot, Chip, IconBtn, etc.)
// Loaded BEFORE other component files. All exported to window.

// Color lookup for severity / status.
const SEV = {
  critical: { bg: 'rgba(255,71,87,0.14)', fg: '#ff4757', dot: '#ff4757', label: 'critical' },
  high:     { bg: 'rgba(255,138,61,0.14)', fg: '#ff8a3d', dot: '#ff8a3d', label: 'high' },
  medium:   { bg: 'rgba(255,210,61,0.14)', fg: '#ffd23d', dot: '#ffd23d', label: 'medium' },
  low:      { bg: 'rgba(124,196,255,0.14)', fg: '#7cc4ff', dot: '#7cc4ff', label: 'low' },
  info:     { bg: 'rgba(139,143,135,0.14)', fg: '#8b8f87', dot: '#8b8f87', label: 'info' },
};
const STATUS = {
  open:        { fg: '#ff4757', label: 'open' },
  fixed:       { fg: '#00e36b', label: 'fixed' },
  triaging:    { fg: '#ffd23d', label: 'triaging' },
  suppressed:  { fg: '#8b8f87', label: 'suppressed' },
  monitoring:  { fg: '#7cc4ff', label: 'monitoring' },
};

// Tiny inline SVG icons. 12x12 grid, stroke-based, terminal aesthetic.
function Icon({ name, size = 12, color = 'currentColor', strokeWidth = 1.5 }) {
  const p = {
    chevron:    'M3 4.5 L6 7.5 L9 4.5',
    chevronUp:  'M3 7.5 L6 4.5 L9 7.5',
    search:     'M5 5 m -3 0 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0  M7.5 7.5 L10 10',
    close:      'M3 3 L9 9 M9 3 L3 9',
    plus:       'M6 2 L6 10 M2 6 L10 6',
    sort:       'M3 4 L6 1 L9 4 M3 8 L6 11 L9 8',
    sortAsc:    'M3 4 L6 1 L9 4',
    sortDesc:   'M3 8 L6 11 L9 8',
    arrowRight: 'M2 6 L10 6 M7 3 L10 6 L7 9',
    check:      'M2 6 L5 9 L10 3',
    external:   'M3 3 L9 3 L9 9 M3 9 L9 3',
    filter:     'M2 3 L10 3 L7 7 L7 10 L5 9 L5 7 Z',
    shield:     'M6 1.5 L10 3 L10 6 C10 8.5 8 10.5 6 10.5 C4 10.5 2 8.5 2 6 L2 3 Z',
    bug:        'M4 3 L4 5 M8 3 L8 5 M3 6 L9 6 M3 6 L3 9 L4.5 9 M9 6 L9 9 L7.5 9 M4.5 6 L4.5 9 M7.5 6 L7.5 9',
    git:        'M3 2.5 L3 9.5 M3 2.5 a1 1 0 1 0 0 0.001 M3 9.5 a1 1 0 1 0 0 0.001 M9 5.5 a1 1 0 1 0 0 0.001 M3 5 c0 0 0 1 3 1 c3 0 3 -1.5 3 -1.5',
    dot:        'M6 6 m -1.5 0 a 1.5 1.5 0 1 0 3 0 a 1.5 1.5 0 1 0 -3 0',
    eye:        'M1.5 6 C3 3.5 4.5 2.5 6 2.5 C7.5 2.5 9 3.5 10.5 6 C9 8.5 7.5 9.5 6 9.5 C4.5 9.5 3 8.5 1.5 6 Z M6 6 m -1.5 0 a 1.5 1.5 0 1 0 3 0 a 1.5 1.5 0 1 0 -3 0',
    download:   'M6 2 L6 8 M3.5 5.5 L6 8 L8.5 5.5 M2.5 10 L9.5 10',
    refresh:    'M2 6 C2 3.5 4 2 6 2 C7.5 2 8.5 2.8 9.5 4 M9.5 1.5 L9.5 4 L7 4 M10 6 C10 8.5 8 10 6 10 C4.5 10 3.5 9.2 2.5 8 M2.5 10.5 L2.5 8 L5 8',
    kebab:      'M6 3 m -0.6 0 a 0.6 0.6 0 1 0 1.2 0 a 0.6 0.6 0 1 0 -1.2 0 M6 6 m -0.6 0 a 0.6 0.6 0 1 0 1.2 0 a 0.6 0.6 0 1 0 -1.2 0 M6 9 m -0.6 0 a 0.6 0.6 0 1 0 1.2 0 a 0.6 0.6 0 1 0 -1.2 0',
    bell:       'M3 8 L9 8 L8 7 L8 5 C8 3.5 7 2.5 6 2.5 C5 2.5 4 3.5 4 5 L4 7 L3 8 Z M5 9 C5 10 5.5 10.5 6 10.5 C6.5 10.5 7 10 7 9',
    lock:       'M3.5 6 L8.5 6 L8.5 10 L3.5 10 Z M4.5 6 L4.5 4.5 C4.5 3.5 5 2.5 6 2.5 C7 2.5 7.5 3.5 7.5 4.5 L7.5 6',
    triangle:   'M6 2 L10 9 L2 9 Z',
    diamond:    'M6 1.5 L10.5 6 L6 10.5 L1.5 6 Z',
    moon:       'M9 7 C8 8 6.5 8.5 5 8 C3 7.5 2 6 2 4 C2.5 5.5 4 6.5 5.5 6.5 C7 6.5 8.5 5.5 9 4 C9 5 9 6.5 9 7 Z',
    sun:        'M6 4 a 2 2 0 1 0 0 4 a 2 2 0 1 0 0 -4 M6 1 L6 2 M6 10 L6 11 M1 6 L2 6 M10 6 L11 6 M2.5 2.5 L3.2 3.2 M8.8 8.8 L9.5 9.5 M2.5 9.5 L3.2 8.8 M8.8 3.2 L9.5 2.5',
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color}
      strokeWidth={strokeWidth} strokeLinecap="square" strokeLinejoin="miter"
      style={{ flex: '0 0 auto', display: 'inline-block', verticalAlign: '-2px' }}>
      <path d={p} />
    </svg>
  );
}

// Severity dot — small filled square (terminal style)
function Dot({ kind = 'info', size = 8 }) {
  const c = SEV[kind] || STATUS[kind] || { dot: 'var(--muted)' };
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, background: c.dot || c.fg,
      display: 'inline-block', flex: '0 0 auto',
    }} />
  );
}

// Severity / status badge — pill with optional dot.
// variants: 'solid' (text on tint), 'outline', 'minimal' (dot + text)
function Badge({ kind = 'info', children, variant = 'solid', uppercase = true, count }) {
  const c = SEV[kind] || STATUS[kind];
  if (!c) return null;
  const label = children ?? c.label;
  const text = uppercase ? String(label).toUpperCase() : String(label);

  if (variant === 'minimal') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11, letterSpacing: '0.04em', color: c.fg,
      }}>
        <Dot kind={kind} size={7} />
        <span>{text}</span>
        {count != null && <span style={{ color: 'var(--muted)' }}>· {count}</span>}
      </span>
    );
  }
  if (variant === 'outline') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '1px 6px', border: `1px solid ${c.fg}`,
        color: c.fg, fontSize: 10, letterSpacing: '0.06em',
        height: 16, lineHeight: 1,
      }}>
        <span>{text}</span>
        {count != null && <span style={{ opacity: 0.7 }}>{count}</span>}
      </span>
    );
  }
  // solid
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 6px', background: c.bg, color: c.fg,
      fontSize: 10, letterSpacing: '0.06em', height: 16, lineHeight: 1,
    }}>
      <span>{text}</span>
      {count != null && <span style={{ opacity: 0.75 }}>· {count}</span>}
    </span>
  );
}

// Count chip — number + small label, used in tab counts ("13 today")
function CountChip({ value, color = 'var(--accent)' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 18, height: 16, padding: '0 5px',
      background: 'transparent', color, fontSize: 10, fontWeight: 500,
      border: `1px solid ${color}`, letterSpacing: '0.02em',
    }}>{value}</span>
  );
}

// Bracket label like [ tab ]  ·  used in terminal tab variant
function Bracketed({ children, active }) {
  return (
    <span style={{
      color: active ? 'var(--accent)' : 'var(--muted)',
      letterSpacing: '0.04em',
    }}>
      <span style={{ opacity: active ? 1 : 0.5 }}>[</span>
      <span style={{ padding: '0 4px' }}>{children}</span>
      <span style={{ opacity: active ? 1 : 0.5 }}>]</span>
    </span>
  );
}

// Simple ghost button used in headers
function GhostBtn({ children, icon, onClick, accent }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 10px', height: 26, border: '1px solid var(--border-strong)',
      background: 'transparent', color: accent ? 'var(--accent)' : 'var(--text)',
      fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.02em',
      cursor: 'pointer', borderRadius: 0,
    }}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

// Themed input
function Input({ value, onChange, placeholder, icon = 'search', width = '100%' }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '0 8px', height: 28, border: '1px solid var(--border)',
      background: 'var(--bg-elev)', width, color: 'var(--text)',
    }}>
      <Icon name={icon} color="var(--muted)" />
      <input value={value} onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1, background: 'transparent', border: 'none', outline: 'none',
          color: 'inherit', font: 'inherit', fontSize: 11, padding: 0,
          minWidth: 0,
        }} />
    </div>
  );
}

// Kbd-style key cap
function Kbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 16, height: 16, padding: '0 4px',
      border: '1px solid var(--border-strong)', color: 'var(--muted)',
      fontSize: 10, lineHeight: 1,
    }}>{children}</span>
  );
}

Object.assign(window, { Icon, Dot, Badge, CountChip, Bracketed, GhostBtn, Input, Kbd, SEV, STATUS });
