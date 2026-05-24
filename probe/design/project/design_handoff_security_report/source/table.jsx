// table.jsx — Dense data table for security findings.
// Sortable columns, hoverable rows, severity-aware.

const FINDINGS = [
  { id: 'CVE-2024-39338', sev: 'critical', title: 'SSRF via undici proxy header injection',           pkg: 'undici',           ver: '5.28.2',  fixIn: '6.21.1', status: 'open',     age: '2h',  refs: 4, file: 'web/server/proxy.ts' },
  { id: 'PR-7741',         sev: 'critical', title: 'Hard-coded JWT signing key in build artefact',     pkg: 'src/auth/jwt.ts',  ver: '—',       fixIn: '—',      status: 'open',     age: '4h',  refs: 1, file: 'src/auth/jwt.ts' },
  { id: 'CVE-2024-29415',  sev: 'critical', title: 'ip package allows attacker-controlled bypass',      pkg: 'ip',               ver: '1.1.8',   fixIn: '2.0.1',  status: 'triaging', age: '1d',  refs: 7, file: '12 importers' },
  { id: 'CVE-2024-28849',  sev: 'high',     title: 'follow-redirects leaks auth across hosts',          pkg: 'follow-redirects', ver: '1.15.4',  fixIn: '1.15.6', status: 'open',     age: '6h',  refs: 9, file: '7 importers' },
  { id: 'GHSA-7q7g-4xm8',  sev: 'high',     title: 'tar slip on POSIX symlink during extraction',       pkg: 'tar',              ver: '6.1.13',  fixIn: '6.2.1',  status: 'open',     age: '8h',  refs: 3, file: 'scripts/restore.sh' },
  { id: 'PR-2210',         sev: 'high',     title: 'Insecure cookie missing SameSite + Secure',          pkg: 'src/web/session.ts', ver: '—',     fixIn: '—',      status: 'monitoring',  age: '1d',  refs: 1, file: 'src/web/session.ts' },
  { id: 'CVE-2024-37890',  sev: 'high',     title: 'ws DoS via permessage-deflate large frames',         pkg: 'ws',               ver: '8.16.0',  fixIn: '8.17.1', status: 'open',     age: '1d',  refs: 5, file: 'realtime/gateway' },
  { id: 'SEC-1192',        sev: 'medium',   title: 'Outdated SSL/TLS suite advertised by edge',          pkg: 'edge/cdn.tf',      ver: '—',       fixIn: '—',      status: 'open',     age: '2d',  refs: 2, file: 'infra/edge/cdn.tf' },
  { id: 'CVE-2024-33883',  sev: 'medium',   title: 'ejs prototype-pollution via render opts',           pkg: 'ejs',              ver: '3.1.9',   fixIn: '3.1.10', status: 'fixed',    age: '3d',  refs: 1, file: 'apps/admin/views' },
  { id: 'PR-7129',         sev: 'medium',   title: 'Missing rate-limit on /api/login',                  pkg: 'src/api/login.ts', ver: '—',       fixIn: '—',      status: 'triaging', age: '3d',  refs: 1, file: 'src/api/login.ts' },
  { id: 'CVE-2024-21484',  sev: 'medium',   title: 'jose CBC oracle on key-wrap',                       pkg: 'jose',             ver: '4.15.4',  fixIn: '4.15.5', status: 'fixed',    age: '4d',  refs: 1, file: 'auth/keys' },
  { id: 'SEC-1085',        sev: 'low',      title: 'Verbose error in production response',              pkg: 'src/api/errors.ts', ver: '—',      fixIn: '—',      status: 'open',     age: '5d',  refs: 1, file: 'src/api/errors.ts' },
  { id: 'GHSA-9wv6-86v2',  sev: 'low',      title: 'semver regex DoS (low practical impact)',           pkg: 'semver',           ver: '7.5.4',   fixIn: '7.5.5',  status: 'suppressed', age: '5d', refs: 2, file: '23 importers' },
  { id: 'CVE-2023-45857',  sev: 'low',      title: 'axios CSRF token leak with withCredentials',        pkg: 'axios',            ver: '1.6.0',   fixIn: '1.6.2',  status: 'fixed',    age: '1w',  refs: 4, file: 'web/api/client.ts' },
];

// Column meta — header label + alignment + sort-fn key
const COLS = [
  { id: 'sev',   label: 'sev',     width: 110, align: 'left' },
  { id: 'id',    label: 'finding', width: 140, align: 'left' },
  { id: 'title', label: 'title',   width: 'auto', align: 'left', grow: true },
  { id: 'pkg',   label: 'package · path', width: 220, align: 'left' },
  { id: 'ver',   label: 'ver → fix', width: 130, align: 'left' },
  { id: 'refs',  label: 'refs',    width: 50,  align: 'right' },
  { id: 'status',label: 'status',  width: 110, align: 'left' },
  { id: 'age',   label: 'age',     width: 50,  align: 'right' },
];

function FindingsTable({ rows = FINDINGS, density = 'dense', showHeader = true, maxRows }) {
  const [sortBy, setSortBy] = React.useState({ id: 'sev', dir: 'asc' });
  const [hover, setHover] = React.useState(null);

  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = React.useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let av = a[sortBy.id], bv = b[sortBy.id];
      if (sortBy.id === 'sev') { av = sevOrder[av]; bv = sevOrder[bv]; }
      if (av < bv) return sortBy.dir === 'asc' ? -1 : 1;
      if (av > bv) return sortBy.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [rows, sortBy]);

  const visible = maxRows ? sorted.slice(0, maxRows) : sorted;
  const rowH = density === 'dense' ? 30 : density === 'comfortable' ? 38 : 48;

  return (
    <div style={{
      border: '1px solid var(--border)', background: 'var(--bg-elev)',
      fontSize: 11, color: 'var(--text)',
    }}>
      {/* header */}
      {showHeader && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: COLS.map(c => c.grow ? '1fr' : `${c.width}px`).join(' '),
          padding: '0 14px', height: 28, alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          color: 'var(--muted)', fontSize: 10, letterSpacing: '0.06em',
          textTransform: 'uppercase', background: 'var(--bg)',
        }}>
          {COLS.map((c) => {
            const isSorted = sortBy.id === c.id;
            return (
              <button key={c.id} onClick={() => setSortBy(s => ({ id: c.id, dir: s.id === c.id && s.dir === 'asc' ? 'desc' : 'asc' }))} style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                color: isSorted ? 'var(--text)' : 'inherit', font: 'inherit',
                fontSize: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 4,
                justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start',
              }}>
                <span>{c.label}</span>
                {isSorted && <Icon name={sortBy.dir === 'asc' ? 'sortAsc' : 'sortDesc'} size={10} color="var(--accent)" />}
              </button>
            );
          })}
        </div>
      )}

      {/* rows */}
      {visible.map((r, i) => {
        const isHover = hover === i;
        return (
          <div key={r.id + i}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            style={{
              display: 'grid',
              gridTemplateColumns: COLS.map(c => c.grow ? '1fr' : `${c.width}px`).join(' '),
              padding: '0 14px', height: rowH, alignItems: 'center',
              borderBottom: i === visible.length - 1 ? 'none' : '1px solid var(--border)',
              background: isHover ? 'var(--surface-hover)' : (i % 2 ? 'var(--row-zebra)' : 'transparent'),
              cursor: 'pointer', position: 'relative',
            }}>

            {/* SEV cell */}
            <div><Badge kind={r.sev} variant="solid" /></div>

            {/* ID cell */}
            <div style={{ color: 'var(--link)', fontVariantNumeric: 'tabular-nums' }}>{r.id}</div>

            {/* TITLE cell */}
            <div style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 12 }}>
              {r.title}
            </div>

            {/* PKG · path cell */}
            <div style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--text)' }}>{r.pkg}</span>
              {r.ver !== '—' && <span style={{ color: 'var(--muted-2)' }}> · {r.file.includes('importer') ? r.file : 'pkg'}</span>}
            </div>

            {/* VER → FIX cell */}
            <div style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {r.ver === '—' ? (
                <span style={{ color: 'var(--muted-2)' }}>—</span>
              ) : (
                <>
                  <span style={{ color: 'var(--text)' }}>{r.ver}</span>
                  <span style={{ color: 'var(--muted-2)' }}> → </span>
                  <span style={{ color: r.status === 'fixed' ? 'var(--accent)' : 'var(--sev-medium)' }}>{r.fixIn}</span>
                </>
              )}
            </div>

            {/* REFS cell — count chip like reference */}
            <div style={{ textAlign: 'right' }}>
              <span style={{ color: r.refs > 5 ? 'var(--sev-high)' : 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{r.refs}</span>
            </div>

            {/* STATUS cell */}
            <div><Badge kind={r.status} variant="minimal" uppercase={false} /></div>

            {/* AGE cell */}
            <div style={{ textAlign: 'right', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{r.age}</div>
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { FindingsTable, FINDINGS });
