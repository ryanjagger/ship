// Single source of truth for the viewer's theme persistence — both per-run
// reports and the history index inline the same head-script and read/write the
// same localStorage key.

export const THEME_KEY = 'probe-viewer-theme';

/**
 * Inline script body for <head>. Applies the stored theme to <html> before
 * <body> parses so a returning user who saved `light` doesn't see a dark→light
 * flash on reload. Runs synchronously; safe to wrap in <script>...</script>.
 */
export function themeInitScriptBody(): string {
  return `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)})||'dark';document.documentElement.className='theme-'+(t==='light'?'light':'dark');}catch(e){document.documentElement.className='theme-dark';}})();`;
}

/**
 * Inline script body for the page-level theme toggle (used by the static
 * history index, which has no separate runtime). Wires the toggle button to
 * flip the class on <html> and persist the choice.
 */
export function themeToggleScriptBody(): string {
  return `(function(){var btn=document.getElementById('probe-theme-toggle');if(!btn)return;function paint(){var dark=document.documentElement.className!=='theme-light';btn.textContent=dark?'☼':'☾';btn.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme');}btn.addEventListener('click',function(){var dark=document.documentElement.className!=='theme-light';var next=dark?'light':'dark';document.documentElement.className='theme-'+next;try{localStorage.setItem(${JSON.stringify(THEME_KEY)},next);}catch(e){}paint();});paint();})();`;
}
