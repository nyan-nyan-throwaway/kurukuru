// Colors: Day/Night themes, album palettes and the album color scheme (ported from the desktop app).

export function parse(c) {
  if (typeof c !== 'string') return c;
  const h = c.replace('#', '');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}
const clamp = (v, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, v));
export const hex = c => '#' + [c.r, c.g, c.b].map(v => clamp(Math.round(v)).toString(16).padStart(2, '0')).join('');
export const rgba = (c, a) => { c = parse(c); return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a === undefined ? c.a : a})`; };
export function mix(a, b, t) {
  a = parse(a); b = parse(b);
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}
// HSV on Qt's scale: hue 0-359 (-1 for gray), saturation and value 0-255.
export function toHsv(c) {
  c = parse(c);
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = -1;
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    h = Math.round(h) % 360;
  }
  return { h, s: max ? Math.round(d / max * 255) : 0, v: Math.round(max * 255) };
}
export function fromHsv(h, s, v) {
  h = ((h % 360) + 360) % 360; s = clamp(s) / 255; v = clamp(v) / 255;
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}
export const lightness = c => { c = parse(c); return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; };
export const readableOn = c => lightness(c) > 150 ? parse('#3d3252') : parse('#fff8fd');
export const darker = (c, f) => { c = parse(c); return { r: c.r / f, g: c.g / f, b: c.b / f, a: c.a }; };
export const lighter = (c, f) => { const h = toHsv(c); return fromHsv(h.h < 0 ? 0 : h.h, h.s / Math.max(1, f * .9), Math.min(255, h.v * f)); };

export function soften(color, night = false) {
  const { h, s, v } = toHsv(color);
  if (h < 0) return fromHsv(0, 0, night ? 70 : 238);
  if (night) return fromHsv(h, Math.min(200, Math.max(80, s)), Math.min(190, Math.max(110, v)));
  return fromHsv(h, Math.min(150, Math.max(55, Math.round(s * .7))), Math.min(250, Math.max(205, v)));
}

export const THEMES = {
  Day: {
    bg: '#f2e2ee', ink: '#5b4d74', ink_soft: '#9787ad', silk: '#a08bb8',
    body_top: '#fffafd', body_bot: '#ecdff0', body_edge: '#d3c0e0', body_shadow: '#bba5cf',
    recess: '#f5ebf4', recess_edge: '#e0d0e8', recess_shadow: '#cdb9da',
    lid_top: '#f7eef8', lid_bot: '#e4d6ec', lid_edge: '#c6b2d6', well: '#8f86a6',
    glass: 'rgba(214,200,240,.15)', shadow: 'rgba(80,50,110,.16)',
    lcd_bezel_top: '#8a80a8', lcd_bezel_bot: '#6f6690', lcd_top: '#e5f0e3', lcd_bot: '#cddfd0',
    lcd_on: '#2f4744', lcd_ghost: .094, lcd_glow: false,
    btn_top: '#fffbfe', btn_bot: '#ebdff2', btn_edge: '#bba7cf', btn_shadow: '#ad97c4',
    led_off: '#dccde2', hl: .78, list_bg: 'rgba(255,255,255,.65)', list_hover: '#f3ebfa',
    groove: '#ddcde7', groove_edge: '#c9b5d8', handle: '#ffffff',
  },
  Night: {
    bg: '#211f34', ink: '#efe6ff', ink_soft: '#a99fc6', silk: '#9d90c4',
    body_top: '#3f3b5f', body_bot: '#302d4a', body_edge: '#57517e', body_shadow: '#18162a',
    recess: '#2a2843', recess_edge: '#46406a', recess_shadow: '#1a1830',
    lid_top: '#46416a', lid_bot: '#343052', lid_edge: '#5f5888', well: '#1b1a2a',
    glass: 'rgba(150,140,210,.12)', shadow: 'rgba(0,0,0,.35)',
    lcd_bezel_top: '#151320', lcd_bezel_bot: '#0d0c16', lcd_top: '#1d1b2f', lcd_bot: '#141322',
    lcd_on: '#a4f3e5', lcd_ghost: .07, lcd_glow: true,
    btn_top: '#544e7a', btn_bot: '#403b61', btn_edge: '#6f689b', btn_shadow: '#1d1b2f',
    led_off: '#4a4568', hl: .24, list_bg: 'rgba(42,40,66,.67)', list_hover: '#35324f',
    groove: '#47426a', groove_edge: '#5a5482', handle: '#efe6ff',
  },
};

export const SCHEME_KEYS = ['accent', 'fill', 'fill2', 'play_top', 'play_bot', 'play_edge', 'play_ink', 'led_on',
                            'list_sel', 'tint', 'tint2', 'handle_edge'];

export const THEME = { name: 'Day', ...THEMES.Day };

export function autoThemeName(date = new Date()) {
  const h = date.getHours();
  return h >= 19 || h < 7 ? 'Night' : 'Day';
}

export function setTheme(name) {
  for (const k of Object.keys(THEME)) if (!SCHEME_KEYS.includes(k)) delete THEME[k];
  Object.assign(THEME, THEMES[name] || THEMES.Day, { name: THEMES[name] ? name : 'Day' });
}

// Representative colors of a picture, most prominent first (saturated hues favoured).
const paletteCache = new Map();
export function albumPalette(image, count = 4, cacheKey = null) {
  if (cacheKey && paletteCache.has(cacheKey + ':' + count)) return paletteCache.get(cacheKey + ':' + count);
  if (!image) return [];
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, 48, 48);
  const data = g.getImageData(0, 0, 48, 48).data;
  const bins = new Map(), neutrals = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const col = { r: data[i], g: data[i + 1], b: data[i + 2] };
    const { h, s, v } = toHsv(col);
    let key, store, weight;
    if (h < 0 || s < 42) { key = Math.floor(v / 52); store = neutrals; weight = .35; }
    else {
      if (v < 40) continue;
      key = `${Math.floor(h / 20)},${Math.floor(s / 86)},${Math.floor(v / 86)}`; store = bins;
      weight = (s / 255) ** 1.2 * (.45 + v / 510);
    }
    const e = store.get(key) || [0, 0, 0, 0];
    store.set(key, [e[0] + weight, e[1] + col.r * weight, e[2] + col.g * weight, e[3] + col.b * weight]);
  }
  const pick = store => {
    const out = [];
    for (const [n, r, g, b] of [...store.values()].sort((a, b) => b[0] - a[0])) {
      const col = { r: r / n, g: g / n, b: b / n, a: 1 };
      const hc = toHsv(col);
      const distinct = out.every(o => {
        const ho = toHsv(o);
        if (ho.h < 0 || hc.h < 0) return true;
        return Math.abs(hc.h - ho.h) > 14 || Math.abs(hc.v - ho.v) > 60;
      });
      if (distinct) out.push(col);
      if (out.length >= count) break;
    }
    return out;
  };
  let result = pick(bins);
  if (result.length < count) result = result.concat(pick(neutrals).slice(0, count - result.length));
  result = result.slice(0, count);
  if (cacheKey) paletteCache.set(cacheKey + ':' + count, result);
  return result;
}

export function crc32(str) {
  let c, crc = 0xFFFFFFFF;
  const bytes = new TextEncoder().encode(str);
  for (const b of bytes) {
    c = (crc ^ b) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Seeded random numbers (so an album always gets the same design).
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return { random: next, uniform: (a, b) => a + (b - a) * next(), int: (a, b) => a + Math.floor(next() * (b - a + 1)),
           choice: arr => arr[Math.floor(next() * arr.length)] };
}

export function albumScheme(palette, seed, night) {
  const cols = palette.filter(c => { const h = toHsv(c); return h.h >= 0 && h.s > 40; });
  let h1, h2;
  if (cols.length) {
    h1 = toHsv(cols[0]).h;
    h2 = cols.length > 1 && Math.abs(toHsv(cols[1]).h - h1) > 12 ? toHsv(cols[1]).h : (h1 + 45) % 360;
  } else if (seed === null || seed === undefined) { h1 = 330; h2 = 268; }
  else { const r = rng(seed); h1 = r.int(0, 359); h2 = (h1 + r.choice([40, -40, 150]) + 360) % 360; }
  const hsv = fromHsv;
  const d = !night ? {
    accent: hsv(h1, 175, 190), fill: hsv(h1, 125, 245), fill2: hsv(h2, 115, 240),
    play_top: hsv(h1, 45, 255), play_bot: hsv(h1, 110, 245), play_edge: hsv(h1, 130, 212),
    play_ink: hsv(h1, 190, 100), led_on: hsv(h1, 175, 255), list_sel: hsv(h1, 45, 250),
    tint: hsv(h1, 75, 252), tint2: hsv(h2, 75, 245), handle_edge: hsv(h1, 115, 200),
  } : {
    accent: hsv(h1, 110, 255), fill: hsv(h1, 140, 230), fill2: hsv(h2, 130, 215),
    play_top: hsv(h1, 125, 180), play_bot: hsv(h1, 150, 135), play_edge: hsv(h1, 110, 205),
    play_ink: parse('#fff4fb'), led_on: hsv(h1, 120, 255), list_sel: hsv(h1, 95, 118),
    tint: hsv(h1, 130, 125), tint2: hsv(h2, 130, 115), handle_edge: hsv(h1, 90, 225),
  };
  const out = {};
  for (const k of SCHEME_KEYS) out[k] = hex(d[k]);
  return out;
}
Object.assign(THEME, albumScheme([], null, false));

export const smooth = u => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
