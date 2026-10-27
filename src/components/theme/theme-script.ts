/**
 * Theme handling shared by the inline boot script and the React hooks.
 *
 * The choice is stored under THEME_STORAGE_KEY as "light" or "dark". With
 * nothing stored the page follows the system setting. The boot script runs in
 * <head> before first paint, so the page never flashes the wrong theme.
 *
 * Content-Security-Policy: the script is static, so a policy without
 * 'unsafe-inline' can allow it by hash. THEME_SCRIPT_SHA256 is that hash
 * ("'sha256-…'" in script-src); a test keeps it in step with the script.
 */
export const THEME_STORAGE_KEY = 'pricingkit-theme';

export type ThemeChoice = 'light' | 'dark';

export const THEME_SCRIPT = `(function(){var d=document.documentElement,t=null;try{t=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}d.classList.toggle('dark',t==='dark');d.style.colorScheme=t})()`;

export const THEME_SCRIPT_SHA256 = 'sha256-wA1Y6k8Yo4d+vtB0VD2LXKZD2Aq/964EinjLbF0N99I=';
