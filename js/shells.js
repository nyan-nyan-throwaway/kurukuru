// Player shells: recolor the Discman body. "Auto" keeps the album-colored look.
// The desktop app has the same shells (main.py: SHELLS).
import { toHsv, fromHsv, parse, hex } from './theme.js';

// hue, how much color the plastic keeps (x the theme's), extra color, and the accent hue
export const SHELLS = {
  auto:     { name: 'Auto (album colors)' },
  silver:   { name: 'Silver',       hue: 222, keep: .25, add: 4,  accent: 215, accentSat: 120, metal: true },
  purple:   { name: 'Clear purple', hue: 276, keep: 1.6, add: 26, accent: 280, accentSat: 190, clear: true },
  mint:     { name: 'Mint',         hue: 158, keep: 1.3, add: 22, accent: 162, accentSat: 170 },
  sakura:   { name: 'Sakura pink',  hue: 340, keep: 1.3, add: 22, accent: 342, accentSat: 175 },
  midnight: { name: 'Midnight',     hue: 232, keep: 1.2, add: 18, accent: 205, accentSat: 150, night: true },
};
const BODY_KEYS = ['bg', 'body_top', 'body_bot', 'body_edge', 'body_shadow', 'recess', 'recess_edge', 'recess_shadow',
  'lid_top', 'lid_bot', 'lid_edge', 'btn_top', 'btn_bot', 'btn_edge', 'btn_shadow', 'led_off', 'groove', 'groove_edge',
  'list_hover', 'silk', 'ink_soft'];

export const shellTheme = (shell, themeName) => (SHELLS[shell] && SHELLS[shell].night ? 'Night' : themeName);

// Re-hues the theme's plastic in place.
export function applyShell(theme, shell) {
  const s = SHELLS[shell];
  if (!s || s.hue === undefined) return;
  for (const k of BODY_KEYS) {
    if (!(k in theme)) continue;
    const c = toHsv(theme[k]);
    let sat = Math.min(255, (c.s * s.keep) + s.add);
    let v = c.v;
    if (s.metal) v = Math.min(255, v * (k.endsWith('_top') ? 1.02 : .97));
    if (s.night) v = v * .82;
    theme[k] = hex(fromHsv(s.hue, sat, v));
  }
  if (s.clear) theme.glass = theme.name === 'Night' ? 'rgba(190,140,255,.22)' : 'rgba(205,160,255,.3)';
  if (s.night) { theme.lcd_on = '#9fd8ff'; }
}

// What the album-color scheme is made from when a shell is on.
export function shellPalette(shell) {
  const s = SHELLS[shell];
  if (!s || s.accent === undefined) return null;
  return [fromHsv(s.accent, s.accentSat, 230), fromHsv((s.accent + 30) % 360, s.accentSat * .8, 225)];
}
