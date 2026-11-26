// Drawing: disc prints, obi, jewel cases, spines, case backs, the sky, LCD digits and icons.
// A port of the desktop app's QPainter code to canvas 2D.
import { THEME, parse, hex, rgba, mix, toHsv, fromHsv, soften, readableOn, darker, lighter, albumPalette,
         crc32, rng } from './theme.js';

const SANS = '"Hiragino Sans","Hiragino Kaku Gothic ProN",-apple-system,"Helvetica Neue","Noto Sans CJK JP","Noto Sans","DejaVu Sans",sans-serif';
const MONO = 'ui-monospace,"SF Mono",Menlo,"DejaVu Sans Mono",monospace';
export const font = (px, bold = false, mono = false) => `${bold ? 'bold ' : ''}${Math.max(1, px).toFixed(2)}px ${mono ? MONO : SANS}`;
export const tc = (key, alpha) => (alpha === undefined ? THEME[key] : rgba(THEME[key], alpha));
const col = c => (typeof c === 'string' ? c : rgba(c));
const TAU = Math.PI * 2;
const rad = d => d * Math.PI / 180;

export function spacing(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, TAU);
}

export function elide(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= width) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

// ---------------------------------------------------------------- seven-segment digits

const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc',
              8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };

function segment(name, x, y, w, h, t) {
  const g = t * .22;
  const L = x + t / 2, R = x + w - t / 2, T = y + t / 2, M = y + h / 2, B = y + h - t / 2;
  const horiz = (yc, x0, x1) => { x0 += g; x1 -= g; return [[x0, yc], [x0 + t / 2, yc - t / 2], [x1 - t / 2, yc - t / 2], [x1, yc], [x1 - t / 2, yc + t / 2], [x0 + t / 2, yc + t / 2]]; };
  const vert = (xc, y0, y1) => { y0 += g; y1 -= g; return [[xc, y0], [xc + t / 2, y0 + t / 2], [xc + t / 2, y1 - t / 2], [xc, y1], [xc - t / 2, y1 - t / 2], [xc - t / 2, y0 + t / 2]]; };
  const pts = { a: () => horiz(T, L, R), b: () => vert(R, T, M), c: () => vert(R, M, B), d: () => horiz(B, L, R),
                e: () => vert(L, M, B), f: () => vert(L, T, M), g: () => horiz(M, L, R) }[name]();
  return pts.map(([px, py]) => [px + (y + h - py) * .09, py]);
}

export const sevenSegWidth = (text, h) => [...text].reduce((w, ch) => w + (ch === ':' ? h * .3 : h * .72), 0) - h * .2;

export function sevenSeg(ctx, text, x, y, h, on, ghost, glow = false) {
  const w = h * .52, gap = h * .2, t = h * .15;
  let cx = x;
  ctx.save();
  for (const ch of text) {
    if (ch === ':') {
      ctx.fillStyle = on;
      for (const fy of [.32, .72]) {
        const yy = y + h * fy;
        roundRect(ctx, cx + (y + h - yy) * .09 + h * .04, yy - t / 2, t, t, 1.5);
        ctx.fill();
      }
      cx += h * .3;
      continue;
    }
    const lit = SEG[ch] || '';
    for (const s of 'abcdefg') {
      const pts = segment(s, cx, y, w, h, t);
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      if (lit.includes(s)) {
        if (glow) { ctx.shadowColor = on; ctx.shadowBlur = t * 1.2; }
        ctx.fillStyle = on;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else { ctx.fillStyle = ghost; ctx.fill(); }
    }
    cx += w + gap;
  }
  ctx.restore();
}

// ---------------------------------------------------------------- icons

export function drawIcon(ctx, kind, cx, cy, s, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const poly = pts => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s))); ctx.closePath(); ctx.fill(); };
  if (kind === 'play') {
    ctx.lineWidth = s * .14;
    ctx.beginPath(); ctx.moveTo(-.42 * s, -.62 * s); ctx.lineTo(.62 * s, 0); ctx.lineTo(-.42 * s, .62 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (kind === 'pause') {
    for (const x of [-.46, .14]) { roundRect(ctx, x * s, -.58 * s, .32 * s, 1.16 * s, .08 * s); ctx.fill(); }
  } else if (kind === 'stop') {
    roundRect(ctx, -.5 * s, -.5 * s, s, s, .12 * s); ctx.fill();
  } else if (kind === 'prev' || kind === 'next') {
    if (kind === 'prev') ctx.scale(-1, 1);
    poly([[-.62, -.5], [-.02, 0], [-.62, .5]]);
    poly([[-.06, -.5], [.54, 0], [-.06, .5]]);
    roundRect(ctx, .5 * s, -.5 * s, .14 * s, s, .04 * s); ctx.fill();
  } else if (kind === 'eject') {
    poly([[-.6, .12], [0, -.55], [.6, .12]]);
    roundRect(ctx, -.6 * s, .3 * s, 1.2 * s, .22 * s, .05 * s); ctx.fill();
  } else if (kind === 'shuffle') {
    ctx.lineWidth = s * .15;
    ctx.beginPath(); ctx.moveTo(-.62 * s, .42 * s); ctx.bezierCurveTo(-.05 * s, .42 * s, -.05 * s, -.42 * s, .36 * s, -.42 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-.62 * s, -.42 * s); ctx.bezierCurveTo(-.05 * s, -.42 * s, -.05 * s, .42 * s, .36 * s, .42 * s); ctx.stroke();
    poly([[.28, -.66], [.68, -.42], [.28, -.18]]); poly([[.28, .18], [.68, .42], [.28, .66]]);
  } else if (kind === 'repeat') {
    ctx.lineWidth = s * .15;
    ctx.beginPath(); ctx.moveTo(-.6 * s, .1 * s); ctx.lineTo(-.6 * s, -.12 * s); ctx.quadraticCurveTo(-.6 * s, -.36 * s, -.36 * s, -.36 * s); ctx.lineTo(.3 * s, -.36 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(.6 * s, -.1 * s); ctx.lineTo(.6 * s, .12 * s); ctx.quadraticCurveTo(.6 * s, .36 * s, .36 * s, .36 * s); ctx.lineTo(-.3 * s, .36 * s); ctx.stroke();
    poly([[.24, -.6], [.6, -.36], [.24, -.12]]); poly([[-.24, .12], [-.6, .36], [-.24, .6]]);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- text helpers

export function textOnArc(ctx, text, radius, centerDeg, fontStr, color, outward = true) {
  ctx.save();
  ctx.font = fontStr;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  let total = ctx.measureText(text).width;
  const maxLen = radius * rad(150);
  if (total > maxLen) { text = elide(ctx, text, maxLen); total = ctx.measureText(text).width; }
  const span = total / Math.max(radius, 1) * 180 / Math.PI;
  let angle = outward ? centerDeg - span / 2 : centerDeg + span / 2;
  const asc = parseFloat(fontStr.match(/([\d.]+)px/)[1]) * .75;
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    const step = w / Math.max(radius, 1) * 180 / Math.PI;
    const mid = angle + (outward ? step / 2 : -step / 2);
    ctx.save();
    ctx.rotate(rad(mid));
    if (outward) ctx.fillText(ch, -w / 2, -radius);
    else { ctx.rotate(Math.PI); ctx.fillText(ch, -w / 2, radius + asc); }
    ctx.restore();
    angle += outward ? step : -step;
  }
  ctx.restore();
}

const UPRIGHT = /[⺀-鿿가-힯豈-﫿！-￯　-〿]/;

// Top-to-bottom text like Japanese print: CJK upright, Latin runs turned sideways. Returns the height used.
export function verticalText(ctx, text, xc, y, maxH, px, bold, color) {
  ctx.save();
  ctx.font = font(px, bold);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const pieces = [];
  let run = '';
  for (const ch of String(text).trim()) {
    if (UPRIGHT.test(ch)) { if (run) { pieces.push([false, run]); run = ''; } pieces.push([true, ch]); }
    else run += ch;
  }
  if (run) pieces.push([false, run]);
  const cell = px * 1.08;
  let used = 0;
  for (let [upright, piece] of pieces) {
    let need;
    if (upright) need = cell;
    else {
      piece = piece.trim();
      if (!piece) { used += cell * .35; continue; }
      need = ctx.measureText(piece).width + 2;
    }
    if (used + need > maxH) {
      const room = maxH - used;
      if (!upright && room > ctx.measureText('…').width + 8) { piece = elide(ctx, piece, room - 2); need = room; }
      else { ctx.fillText('︙', xc, y + used + cell * .1); used = maxH; break; }
    }
    if (upright) ctx.fillText(piece, xc, y + used + cell / 2);
    else {
      ctx.save();
      ctx.translate(xc, y + used + 1);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillText(piece, 0, 0);
      ctx.restore();
    }
    used += need;
  }
  ctx.restore();
  return used;
}

// ---------------------------------------------------------------- disc prints

const DISC_STYLES = ['rings', 'burst', 'dots', 'waves', 'bauhaus', 'stripe'];

function discPrintPalette(image, seed, cacheKey) {
  let raw = image ? albumPalette(image, 4, cacheKey) : [];
  const r = rng(seed);
  if (!raw.length) {
    const base = r.int(0, 359);
    raw = [0, 40, 180, 300].map(d => fromHsv((base + d) % 360, r.int(70, 139), 240));
  }
  raw = raw.slice();
  while (raw.length < 4) {
    const { h, s, v } = toHsv(raw[raw.length % Math.max(1, raw.length)]);
    raw.push(fromHsv(((h >= 0 ? h : 280) + 70 * raw.length) % 360, Math.max(60, s), Math.max(170, v)));
  }
  return raw;
}

export function drawImageCover(ctx, image, x, y, w, h) {
  const iw = image.width, ih = image.height;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

export function paintDiscPrint(ctx, R, image, mode, album, artist, night, cacheKey) {
  const seed = crc32(`${album}\n${artist}`);
  const r = rng(seed);
  if (mode === 'silver' || (mode === 'design' && !album)) {
    const g = ctx.createConicGradient(rad(-20), 0, 0);
    ['#d6d5f2', '#e7b8d8', '#fff1bd', '#b6e5ec', '#bdbde9', '#f3c2d7', '#f9f6ff', '#d6d5f2']
      .forEach((c, i, a) => g.addColorStop(i / (a.length - 1), c));
    ctx.fillStyle = g; circle(ctx, 0, 0, R); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
    for (let rr = R * .4; rr < R; rr += 4) { circle(ctx, 0, 0, rr); ctx.stroke(); }
    textOnArc(ctx, 'KURUKURU  ·  COMPACT  DISC', R * .8, 180, font(R * .075, true), 'rgba(120,100,160,.6)', false);
    return;
  }
  if (mode === 'art' && image) {
    drawImageCover(ctx, image, -R, -R, 2 * R, 2 * R);
    return;
  }
  const [base, c1, c2, c3] = discPrintPalette(image, seed, cacheKey).map(c => soften(c, night));
  const style = DISC_STYLES[seed % DISC_STYLES.length];
  const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  bg.addColorStop(0, col(lighter(base, 1.08))); bg.addColorStop(1, col(base));
  ctx.fillStyle = bg; circle(ctx, 0, 0, R); ctx.fill();
  if (style === 'rings') {
    let rr = R, i = 0;
    const colors = [c1, base, c2, c3, base, c1];
    while (rr > R * .34) {
      const band = R * r.uniform(.05, .13);
      ctx.fillStyle = col(colors[i % colors.length]); circle(ctx, 0, 0, rr); ctx.fill();
      rr -= band; i++;
    }
    ctx.fillStyle = col(base); circle(ctx, 0, 0, rr); ctx.fill();
  } else if (style === 'burst') {
    const rays = r.choice([12, 16, 18, 24]);
    ctx.save(); ctx.rotate(rad(r.uniform(0, 30)));
    for (let n = 0; n < rays; n++) {
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, n * TAU / rays, n * TAU / rays + TAU / rays / 2); ctx.closePath();
      ctx.fillStyle = col(n % 2 ? c1 : c2); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = col(base); circle(ctx, 0, 0, R * .52); ctx.fill();
    ctx.fillStyle = col(c3); circle(ctx, 0, 0, R * .46); ctx.fill();
  } else if (style === 'dots') {
    for (let row = 0; row < 9; row++) {
      const rr = R * (.38 + .6 * row / 8);
      const count = Math.floor(TAU * rr / (R * .085));
      const size = R * (.012 + .03 * row / 9);
      ctx.fillStyle = col([c1, c2, c3][row % 3]);
      const off = r.random();
      for (let k = 0; k < count; k++) {
        const a = TAU * (k + off) / count;
        circle(ctx, Math.cos(a) * rr, Math.sin(a) * rr, size); ctx.fill();
      }
    }
  } else if (style === 'waves') {
    const lobes = r.choice([5, 6, 7, 8]);
    [c1, c2, c3, c1, c2].forEach((c, n) => {
      const radius = R * (.98 - n * .13), amp = R * .035;
      ctx.beginPath();
      for (let k = 0; k <= 180; k++) {
        const a = TAU * k / 180, rr = radius + amp * Math.sin(lobes * a + n);
        k ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fillStyle = col(c); ctx.fill();
    });
  } else if (style === 'bauhaus') {
    for (const [c, scale] of [[c1, .75], [c2, .55], [c3, .4]]) {
      const a = r.uniform(0, TAU), d = R * r.uniform(.45, .8);
      ctx.fillStyle = col(c); circle(ctx, Math.cos(a) * d, Math.sin(a) * d, R * scale); ctx.fill();
    }
    ctx.strokeStyle = col(readableOn(base)); ctx.lineWidth = R * .012; circle(ctx, 0, 0, R * .7); ctx.stroke();
  } else if (style === 'stripe') {
    ctx.save(); ctx.rotate(rad(r.uniform(-50, 50)));
    let y = -R * .55;
    for (let n = 0; n < 5; n++) {
      const w = r.uniform(.08, .22);
      ctx.fillStyle = col([c1, c2, c3][n % 3]); ctx.fillRect(-R, y, 2 * R, R * w);
      y += R * (w + .04);
    }
    ctx.restore();
  }
  const ink = readableOn(['dots', 'bauhaus', 'waves'].includes(style) ? base : mix(base, c1, .5));
  textOnArc(ctx, album.toUpperCase(), R * .855, 0, font(R * .085, true), rgba(ink, .88), true);
  if (artist && artist !== 'Unknown artist') textOnArc(ctx, artist, R * .8, 180, font(R * .065), rgba(ink, .88), false);
}

// The finished disc face (print + clear hub) on its own canvas, for spinning.
export function renderDiscFace(R, dpr, image, mode, album, artist, night, cacheKey, cdr) {
  const size = Math.ceil(2 * R * dpr) + 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(R + 1 / dpr, R + 1 / dpr);
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.arc(0, 0, R * .155, 0, TAU, true); ctx.clip('evenodd');
  if (cdr) paintCdrFace(ctx, R, cdr);
  else paintDiscPrint(ctx, R, image, (!album && !image) ? 'silver' : mode, album, artist, night, cacheKey);
  ctx.fillStyle = 'rgba(236,236,248,.84)'; circle(ctx, 0, 0, R * .33); ctx.fill();
  const hub = ctx.createConicGradient(rad(-45), 0, 0);
  ['#e9e8f4', '#c9c6dc', '#fbfaff', '#bdb9d3', '#e9e8f4'].forEach((c, i) => hub.addColorStop(i / 4, c));
  ctx.fillStyle = hub; circle(ctx, 0, 0, R * .3); ctx.fill();
  ctx.fillStyle = 'rgba(246,246,252,.92)'; circle(ctx, 0, 0, R * .24); ctx.fill();
  ctx.strokeStyle = 'rgba(150,140,180,.43)'; ctx.lineWidth = 1;
  circle(ctx, 0, 0, R * .33); ctx.stroke(); circle(ctx, 0, 0, R * .2); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.4; circle(ctx, 0, 0, R - .7); ctx.stroke();
  return canvas;
}

// ---------------------------------------------------------------- CD-R (used later for playlists)

export const CDR_DYES = { gold: ['Gold', '#f7e7a8', '#dcb85c', '#a8802c'], blue: ['Azo blue', '#a8d8ff', '#3f74d6', '#1f3a8f'],
  green: ['Green', '#cff2dc', '#4fae84', '#246b4f'], silver: ['Silver', '#f6f7fb', '#c9ccd6', '#8f95a5'],
  pink: ['Pink', '#ffd9ea', '#ef8fbb', '#b54d80'], black: ['Black', '#5f5d6c', '#2b2a34', '#121117'] };

export function paintCdrFace(ctx, R, cdr) {
  const [, light, mid, dark] = CDR_DYES[cdr.dye] || CDR_DYES.gold;
  const base = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  base.addColorStop(0, light); base.addColorStop(.7, mid); base.addColorStop(1, light);
  ctx.fillStyle = base; circle(ctx, 0, 0, R); ctx.fill();
  const outer = R * (.37 + .6 * Math.max(.05, Math.min(1, cdr.fraction || .5)));
  ctx.beginPath(); ctx.arc(0, 0, outer, 0, TAU); ctx.arc(0, 0, R * .35, 0, TAU, true);
  ctx.fillStyle = rgba(dark, .27); ctx.fill('evenodd');
  ctx.strokeStyle = rgba(dark, .43); ctx.lineWidth = .8; circle(ctx, 0, 0, outer); ctx.stroke();
  textOnArc(ctx, 'CD-R  700MB  80min  ·  RECORDABLE', R * .9, 180, font(R * .055, true), rgba(dark, .6), false);
}

// ---------------------------------------------------------------- obi strips

export const OBI_DESIGNS = ['bands', 'gradient', 'candy', 'dots', 'split', 'burst', 'rainbow'];

export function obiColors(album, artist, palette) {
  const seed = crc32(`${album}\n${artist}`);
  const r = rng(seed);
  let colors = palette.filter(c => { const h = toHsv(c); return h.h >= 0 && h.s > 60; });
  if (!colors.length) colors = palette.slice();
  let h, s, v;
  if (colors.length) { ({ h, s, v } = toHsv(colors[0])); if (h < 0) h = r.int(0, 359); }
  else { h = r.int(0, 359); s = 180; v = 200; }
  const ink = fromHsv(h, Math.max(150, Math.min(235, s)), Math.max(120, Math.min(205, v)));
  let second = colors.length > 1 ? colors[1] : fromHsv((h + 150) % 360, 170, 220);
  const sh = toHsv(second);
  second = fromHsv(Math.max(0, sh.h), Math.max(120, sh.s), Math.max(170, sh.v));
  return { seed, ink, second };
}

export function obiPalette(album, artist, palette) {
  const { seed, ink, second } = obiColors(album, artist, palette);
  const h = Math.max(0, toHsv(ink).h);
  const extra = palette.slice(2).filter(c => { const x = toHsv(c); return x.h >= 0 && x.s > 50; });
  const third = extra.length ? fromHsv(toHsv(extra[0]).h, Math.max(140, toHsv(extra[0]).s), Math.max(170, toHsv(extra[0]).v))
                             : fromHsv((h + 200) % 360, 165, 225);
  const fourth = fromHsv((h + 55) % 360, 135, 250);
  return { seed, cols: [ink, second, third, fourth] };
}

function paintObiDesign(ctx, x, y, W, H, seed, cols, night, design) {
  const [ink, second, third, fourth] = cols;
  design = OBI_DESIGNS.includes(design) ? design : OBI_DESIGNS[Math.floor(seed / 7) % OBI_DESIGNS.length];
  const paper = parse(night ? '#e6dfd5' : '#f8f3ec');
  const topH = H * .15, botH = H * .12;
  const top = [x, y, W, topH], bottom = [x, y + H - botH, W, botH];
  const middle = [x, y + topH, W, H - topH - botH];
  let panel = [middle[0] + W * .16, middle[1] + H * .04, W - W * .32, middle[3] - H * .08];
  let usePanel = true, text = parse('#2f2638'), accent = darker(ink, 1.15);
  let topColor = ink, bottomColor = second;
  const deep = c => { const x2 = toHsv(c); return fromHsv(Math.max(0, x2.h), Math.max(150, x2.s), Math.min(150, x2.v)); };
  const fill = (c, ...r) => { ctx.fillStyle = col(c); ctx.fillRect(...r); };
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, W, H); ctx.clip();
  if (design === 'bands') {
    fill(paper, x, y, W, H); usePanel = false;
    [second, third, fourth].forEach((c, n) => fill(c, x, y + topH + n * 2.4, W, 2.4));
    [fourth, third].forEach((c, n) => fill(c, x, y + H - botH - (n + 1) * 2.4, W, 2.4));
  } else if (design === 'gradient') {
    const g = ctx.createLinearGradient(0, y, 0, y + H);
    g.addColorStop(0, col(deep(ink))); g.addColorStop(.5, col(deep(second))); g.addColorStop(1, col(deep(third)));
    ctx.fillStyle = g; ctx.fillRect(x, y, W, H);
    topColor = bottomColor = null; usePanel = false;
    text = parse('#ffffff'); accent = { r: 255, g: 255, b: 255, a: .84 };
    fill(fourth, x, y + topH, W, 1.5); fill(fourth, x, y + H - botH - 1.5, W, 1.5);
  } else if (design === 'candy') {
    fill(second, x, y, W, H);
    ctx.fillStyle = col(fourth);
    const step = Math.max(7, W * .32);
    for (let yy = y - W; yy < y + H + W; yy += step) {
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + W, yy - W); ctx.lineTo(x + W, yy - W + step / 2); ctx.lineTo(x, yy + step / 2); ctx.closePath(); ctx.fill();
    }
    bottomColor = third;
  } else if (design === 'dots') {
    fill(paper, x, y, W, H);
    const sp = Math.max(6, W * .2), rr = sp * .22;
    let row = 0;
    for (let yy = middle[1] + sp / 2; yy < middle[1] + middle[3]; yy += sp * .8, row++) {
      let k = row;
      for (let xx = x + (row % 2 ? sp / 2 : sp); xx < x + W; xx += sp, k++) {
        ctx.fillStyle = col([second, third, fourth][k % 3]); circle(ctx, xx, yy, rr); ctx.fill();
      }
    }
  } else if (design === 'split') {
    usePanel = false;
    fill(soften(second), x, y, W, H);
    ctx.beginPath(); ctx.moveTo(x, y + H / 2);
    for (let k = 0; k <= 24; k++) ctx.lineTo(x + W * k / 24, y + H / 2 + Math.sin(k / 24 * TAU + seed % 5) * W * .12);
    ctx.lineTo(x + W, y + H); ctx.lineTo(x, y + H); ctx.closePath();
    ctx.fillStyle = col(soften(third)); ctx.fill();
    bottomColor = fourth;
  } else if (design === 'burst') {
    usePanel = false;
    fill(soften(fourth), x, y, W, H);
    const cx = x + W / 2, cy = y + topH;
    for (let n = 0; n < 14; n++) {
      const a0 = n * Math.PI / 14, a1 = a0 + Math.PI / 14;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a0) * H, cy + Math.sin(a0) * H); ctx.lineTo(cx + Math.cos(a1) * H, cy + Math.sin(a1) * H); ctx.closePath();
      ctx.fillStyle = col(n % 2 ? soften(ink) : paper); ctx.fill();
    }
    bottomColor = third;
  } else if (design === 'rainbow') {
    fill(paper, x, y, W, H); usePanel = false;
    const stripe = Math.max(1.6, W * .06);
    [ink, second, third, fourth].forEach((c, n) => fill(c, x + W - (n + 1) * stripe, y, stripe, H));
    bottomColor = third;
  }
  if (topColor) fill(topColor, ...top);
  if (bottomColor) fill(bottomColor, ...bottom);
  if (design === 'rainbow') {
    ctx.fillStyle = col(fourth);
    for (const [fx, fy, sz] of [[.2, .25, .1], [.78, .7, .07]]) {
      const cx = x + W * fx, cy = y + topH * fy, s = W * sz;
      ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s * .3, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s * .3, cy); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx - s, cy); ctx.lineTo(cx, cy + s * .3); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy - s * .3); ctx.closePath(); ctx.fill();
    }
  }
  let area;
  if (usePanel) {
    ctx.fillStyle = col(paper); ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.lineWidth = .8;
    roundRect(ctx, ...panel, 2.5); ctx.fill(); ctx.stroke();
    area = panel;
  } else area = [middle[0], middle[1] + 3, W - (design === 'rainbow' ? W * .25 : 0), middle[3] - 6];
  ctx.restore();
  return { area, text, accent, top, bottom,
           topText: readableOn(topColor || deep(ink)), bottomText: readableOn(bottomColor || deep(third)) };
}

export function paintObi(ctx, x, y, W, H, album, artist, year, palette, night, custom = {}) {
  if (custom && custom.design === 'none') return;
  const { seed, cols } = obiPalette(album, artist, palette);
  ctx.save();
  ctx.fillStyle = 'rgba(30,20,50,.18)'; ctx.fillRect(x + 1.5, y + 1, W, H);
  const info = paintObiDesign(ctx, x, y, W, H, seed, cols, night, custom && custom.design);
  const [tx, ty, tw, th] = info.top;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = col(info.topText);
  ctx.font = font(W * .36, true); ctx.fillText('CD', tx + tw / 2, ty + th * .32);
  ctx.font = font(Math.max(4, W * .17), true); ctx.fillText(elide(ctx, (custom && custom.label) || 'くるくる', W - 2), tx + tw / 2, ty + th * .75);
  const [ax, ay, aw, ah] = info.area;
  const artistText = artist && artist !== 'Unknown artist' ? artist : '';
  const titleX = ax + aw * (artistText ? .64 : .5);
  verticalText(ctx, album || 'Kurukuru CD', titleX, ay + 3, ah - 6, W * .29, true, col(info.text));
  if (artistText) {
    ctx.fillStyle = rgba(info.accent, .43); ctx.fillRect(ax + aw * .43, ay + 5, 1, ah - 10);
    verticalText(ctx, artistText, ax + aw * .22, ay + 3, ah - 6, W * .21, false, col(info.accent));
  }
  const [bx, by, bw, bh] = info.bottom;
  ctx.fillStyle = col(info.bottomText);
  ctx.font = font(Math.max(5, W * .17), true);
  const code = (custom && custom.catalogue) || `KRCD ${seed % 9000 + 1000}`;
  const lines = code.split(/[\s-]/, 2);
  lines.forEach((l, i) => ctx.fillText(l, bx + bw / 2, by + bh / 2 + (i - (lines.length - 1) / 2) * W * .19));
  ctx.fillStyle = 'rgba(255,255,255,.47)'; ctx.fillRect(x, y, 1.2, H);
  ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(x + W - 1, y, 1, H);
  ctx.restore();
}

// ---------------------------------------------------------------- jewel cases (172 x 178 card space)

export function baseAccent(palette) {
  return palette.length ? palette[0] : parse('#bfa9e3');
}

export function paintCaseFront(ctx, group, image, palette, night, showObi = true) {
  const { h: h0, s } = toHsv(baseAccent(palette));
  const h = h0 < 0 ? 275 : h0;
  const accent = night ? fromHsv(h, Math.min(125, Math.max(55, Math.round(s * .55))), 123)
                       : fromHsv(h, Math.min(125, Math.max(58, Math.round(s * .52))), 237);
  const outline = night ? '#716988' : '#b8a5c4';
  ctx.save();
  ctx.fillStyle = `rgba(14,10,29,${night ? .14 : .07})`; roundRect(ctx, 9, 9, 161, 169, 9); ctx.fill();
  ctx.fillStyle = col(accent); ctx.strokeStyle = outline; ctx.lineWidth = 1.4;
  roundRect(ctx, 5, 3, 159, 165, 7); ctx.fill(); ctx.stroke();
  const ix = 25, iy = 12, iw = 130, ih = 145;
  ctx.fillStyle = night ? '#49435f' : '#fff4fa'; ctx.fillRect(ix, iy, iw, ih);
  if (image) { ctx.save(); ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip(); drawImageCover(ctx, image, ix, iy, iw, ih); ctx.restore(); }
  else {
    ctx.fillStyle = night ? '#c9bfdc' : '#887a9b'; ctx.font = font(11, true); ctx.textAlign = 'center';
    ctx.fillText('KURUKURU', ix + iw / 2, iy + ih / 2 - 4); ctx.fillText('CD', ix + iw / 2, iy + ih / 2 + 12); ctx.textAlign = 'left';
  }
  // Plastic lid sheen and streaks.
  ctx.save(); roundRect(ctx, 6, 4, 157, 163, 6); ctx.clip();
  const sheen = ctx.createLinearGradient(25, 8, 150, 150);
  sheen.addColorStop(0, `rgba(255,255,255,${night ? .23 : .47})`); sheen.addColorStop(.25, 'rgba(255,255,255,.05)');
  sheen.addColorStop(.57, `rgba(200,223,255,${night ? .05 : .11})`); sheen.addColorStop(.82, 'rgba(255,255,255,.03)');
  sheen.addColorStop(1, `rgba(255,255,255,${night ? .15 : .27})`);
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, 172, 178);
  for (const [pts, a] of [[[[29, 5], [51, 5], [158, 112], [158, 129]], .18], [[[70, 5], [78, 5], [159, 86], [159, 94]], .1], [[[26, 111], [26, 122], [70, 166], [81, 166]], .09]]) {
    ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${night ? a / 2 : a})`; ctx.fill();
  }
  ctx.restore();
  const spine = ctx.createLinearGradient(7, 0, 24, 0);
  spine.addColorStop(0, col(darker(accent, 1.35))); spine.addColorStop(.2, col(lighter(accent, 1.4)));
  spine.addColorStop(.48, col(accent)); spine.addColorStop(.75, col(lighter(accent, 1.3))); spine.addColorStop(1, col(darker(accent, 1.18)));
  ctx.fillStyle = spine; roundRect(ctx, 7, 6, 16, 159, 3); ctx.fill();
  ctx.strokeStyle = `rgba(255,255,255,${night ? .3 : .57})`; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(10, 9); ctx.lineTo(10, 160); ctx.moveTo(20, 9); ctx.lineTo(20, 160); ctx.moveTo(27, 9); ctx.lineTo(153, 9); ctx.stroke();
  ctx.strokeStyle = outline; ctx.lineWidth = 1;
  for (const yy of [23, 140]) {
    const hg = ctx.createLinearGradient(9, yy, 20, yy + 9);
    hg.addColorStop(0, `rgba(255,255,255,${night ? .41 : .78})`); hg.addColorStop(1, col(darker(accent, 1.2)));
    ctx.fillStyle = hg; roundRect(ctx, 9, yy, 11, 9, 2); ctx.fill(); ctx.stroke();
  }
  if (showObi && (group.album || group.artist)) paintObi(ctx, 4, 3.5, 40, 164, group.album, group.artist, group.year, palette, night, group.obi || {});
  ctx.restore();
}

function caseShell(ctx, night, fill) {
  ctx.fillStyle = `rgba(14,10,29,${night ? .14 : .07})`; roundRect(ctx, 9, 9, 161, 169, 9); ctx.fill();
  ctx.fillStyle = col(fill); ctx.strokeStyle = night ? '#716988' : '#b8a5c4'; ctx.lineWidth = 1.4;
  roundRect(ctx, 5, 3, 159, 165, 7); ctx.fill(); ctx.stroke();
}

function caseSheen(ctx, night) {
  ctx.save(); roundRect(ctx, 6, 4, 157, 163, 6); ctx.clip();
  const sheen = ctx.createLinearGradient(25, 8, 150, 150);
  sheen.addColorStop(0, `rgba(255,255,255,${night ? .18 : .35})`); sheen.addColorStop(.3, 'rgba(255,255,255,.03)');
  sheen.addColorStop(1, `rgba(255,255,255,${night ? .1 : .2})`);
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, 172, 178); ctx.restore();
}

export function paintCaseBack(ctx, group, tracks, palette, night) {
  const { album = '', artist = '', year = '' } = group;
  const { seed, ink, second } = obiColors(album, artist, palette);
  const r = rng(seed);
  let base = soften(palette[0] || ink, false);
  base = fromHsv(Math.max(0, toHsv(base).h), Math.min(70, toHsv(base).s), 246);
  const text = '#3a3046';
  ctx.save();
  caseShell(ctx, night, mix(base, ink, .25));
  const ins = [9, 7, 151, 157];
  ctx.fillStyle = col(base); ctx.fillRect(...ins);
  // Faded disc print peeking from the corner.
  ctx.save(); ctx.beginPath(); ctx.rect(23, 7, 123, 157); ctx.clip();
  ctx.translate(132, 146); ctx.globalAlpha = .22;
  ctx.beginPath(); ctx.arc(0, 0, 62, 0, TAU); ctx.clip();
  paintDiscPrint(ctx, 62, null, 'design', album || 'x', artist, false);
  ctx.restore();
  const spineText = artist && artist !== 'Unknown artist' ? `${album}  ·  ${artist}` : album;
  for (const x of [ins[0], ins[0] + ins[2] - 13]) {
    ctx.fillStyle = col(ink); ctx.fillRect(x, ins[1], 13, ins[3]);
    ctx.fillStyle = col(second); ctx.fillRect(x, ins[1], 13, 16);
    ctx.fillStyle = col(readableOn(second)); ctx.font = font(5.5, true); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('CD', x + 6.5, ins[1] + 8);
    verticalText(ctx, spineText, x + 6.5, ins[1] + 20, ins[3] - 26, 6.5, true, col(readableOn(ink)));
  }
  const left = 27, width = 115;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = text; ctx.font = font(9, true); ctx.fillText(elide(ctx, album, width), left, 17);
  ctx.fillStyle = col(darker(ink, 1.2)); ctx.font = font(6.2); ctx.fillText(elide(ctx, artist, width), left, 27.5);
  ctx.fillStyle = col(ink); ctx.fillRect(left, 34, width, .8);
  ctx.font = font(5.8);
  let y = 37 + 3.6;
  const line = 7.2, maxLines = Math.floor((136 - 37) / line);
  const shown = tracks.length <= maxLines ? tracks : tracks.slice(0, maxLines - 1);
  for (const [num, title, len] of shown) {
    ctx.fillStyle = col(darker(ink, 1.15)); ctx.textAlign = 'left'; ctx.fillText(String(num).padStart(2, '0'), left, y);
    ctx.fillStyle = text; ctx.textAlign = 'right';
    if (len) ctx.fillText(fmtTime(len * 1000), left + width, y);
    ctx.textAlign = 'left'; ctx.fillText(elide(ctx, title, width - 31), left + 11, y);
    y += line;
  }
  if (shown.length < tracks.length) { ctx.fillStyle = col(darker(ink, 1.15)); ctx.fillText(`… and ${tracks.length - shown.length} more`, left + 11, y); }
  ctx.fillStyle = '#ffffff'; ctx.fillRect(left + width - 38, 139, 38, 21);
  ctx.fillStyle = '#1d1724';
  for (let x = left + width - 35; x < left + width - 3;) {
    const w = r.choice([.5, .5, 1, 1.5]); ctx.fillRect(x, 141, w, 12); x += w + r.choice([.5, 1, 1]);
  }
  ctx.font = font(4.2, false, true); ctx.textAlign = 'center';
  ctx.fillText(`4 ${String(seed % 999983).padStart(6, '0')} ${String(seed % 99991).padStart(5, '0')}`.slice(0, 14), left + width - 19, 157);
  ctx.fillStyle = text; ctx.font = font(4.6); ctx.textAlign = 'left';
  [`KRCD-${seed % 9000 + 1000}`, `℗ ${year ? year + ' ' : ''}Kurukuru Records`, 'Made with love in a tiny CD player']
    .forEach((l, i) => ctx.fillText(l, left, 143 + i * 6.2));
  caseSheen(ctx, night);
  ctx.restore();
}

export function paintCaseBackImage(ctx, image, night) {
  ctx.save();
  caseShell(ctx, night, night ? '#57506f' : '#e9e4ef');
  ctx.save(); ctx.beginPath(); ctx.rect(9, 7, 151, 157); ctx.clip(); drawImageCover(ctx, image, 9, 7, 151, 157); ctx.restore();
  caseSheen(ctx, night);
  ctx.restore();
}

// ---------------------------------------------------------------- spines

export function paintSpine(ctx, x, y, w, h, group, palette, playing) {
  const { album = '', artist = '' } = group;
  const custom = group.obi || {};
  const { seed, cols } = obiPalette(album, artist, palette);
  ctx.save();
  ctx.fillStyle = 'rgba(20,10,40,.16)'; roundRect(ctx, x + 1.5, y + 1.5, w, h, 2.5); ctx.fill();
  roundRect(ctx, x, y, w, h, 2.5); ctx.save(); ctx.clip();
  const info = paintObiDesign(ctx, x, y, w, h, seed, cols, THEME.name === 'Night', custom.design !== 'none' ? custom.design : null);
  const [tx, ty, tw, th] = info.top;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = col(info.topText); ctx.font = font(8, true); ctx.fillText('CD', tx + tw / 2, ty + th * .32);
  ctx.font = font(4.5, true); ctx.fillText('くるくる', tx + tw / 2, ty + th * .76);
  const [bx, by, bw, bh] = info.bottom;
  ctx.fillStyle = col(info.bottomText); ctx.font = font(4.6, true);
  ctx.fillText('KRCD', bx + bw / 2, by + bh / 2 - 3); ctx.fillText(String(seed % 9000 + 1000), bx + bw / 2, by + bh / 2 + 3);
  const [ax, ay, aw, ah] = info.area;
  const xc = ax + aw / 2;
  const artistText = artist && artist !== 'Unknown artist' ? artist : '';
  const room = ah - 6;
  const used = verticalText(ctx, album, xc, ay + 3, room * (artistText ? .68 : 1), Math.min(w * .4, aw * .62), true, col(info.text));
  if (artistText) {
    ctx.fillStyle = col(info.accent); ctx.fillRect(xc - 4, ay + 3 + used + 3, 8, 1);
    verticalText(ctx, artistText, xc, ay + 3 + used + 7, room - used - 7, Math.min(w * .3, aw * .5), false, col(info.accent));
  }
  ctx.restore();
  ctx.strokeStyle = playing ? THEME.accent : 'rgba(0,0,0,.2)'; ctx.lineWidth = playing ? 1.6 : 1;
  roundRect(ctx, x, y, w, h, 2.5); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(x + 1.5, y + 2, 1, h - 4);
  ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.fillRect(x + w - 2.5, y + 2, 1, h - 4);
  ctx.restore();
}

// ---------------------------------------------------------------- sky

export class Sky {
  constructor() {
    const r = rng(20261125);
    this.clouds = [];
    for (let n = 0; n < 11; n++) {
      const width = r.uniform(90, 210);
      const puffs = Array.from({ length: r.int(3, 5) }, () => [r.uniform(-.32, .32), r.uniform(-.28, -.05), r.uniform(.16, .3)]);
      this.clouds.push({ x: r.random(), y: n < 6 ? r.uniform(-.02, .13) : r.uniform(.15, 1), width, speed: r.uniform(7, 19), puffs });
    }
    const tints = ['#ffffff', '#ffe3f1', '#e2ecff', '#fff4cc', '#e9e0ff'];
    this.stars = Array.from({ length: 150 }, () => [r.random(), r.random(), r.uniform(.5, 1.8), r.uniform(0, 6.3), r.uniform(.7, 2.6), r.choice(tints)]);
    this.r = r;
    this.shooting = null;
    this.nextShooting = performance.now() / 1000 + r.uniform(4, 10);
  }

  paint(ctx, W, H, night, now) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (night) { g.addColorStop(0, col(mix('#0f0d27', THEME.tint, .16))); g.addColorStop(1, col(mix('#2a2052', THEME.tint2, .32))); }
    else { g.addColorStop(0, col(mix('#b9defc', THEME.tint, .3))); g.addColorStop(1, col(mix('#fde6f2', THEME.tint2, .45))); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (night) {
      const mx = W * .78, my = 60;
      const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 70);
      halo.addColorStop(0, 'rgba(255,245,220,.27)'); halo.addColorStop(1, 'rgba(255,245,220,0)');
      ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
      ctx.save(); ctx.beginPath(); ctx.arc(mx, my, 17, 0, TAU); ctx.arc(mx + 8, my - 5, 15, 0, TAU, true);
      ctx.fillStyle = '#fff4d6'; ctx.fill('evenodd'); ctx.restore();
      for (const [x, y, size, phase, speed, tint] of this.stars) {
        const tw = .5 + .5 * Math.sin(now * speed + phase);
        const px = x * W, py = y * H;
        ctx.fillStyle = rgba(tint, (70 + 185 * tw) / 255);
        circle(ctx, px, py, size * (.7 + .3 * tw)); ctx.fill();
        if (size > 1.45) {
          ctx.strokeStyle = rgba(tint, 140 * tw / 255); ctx.lineWidth = .9;
          const arm = size * (2.5 + 2.5 * tw);
          ctx.beginPath(); ctx.moveTo(px - arm, py); ctx.lineTo(px + arm, py); ctx.moveTo(px, py - arm); ctx.lineTo(px, py + arm); ctx.stroke();
        }
      }
      if (!this.shooting && now >= this.nextShooting) this.shooting = [now, this.r.uniform(.15, .95) * W, this.r.uniform(0, .25) * H];
      if (this.shooting) {
        const [start, sx, sy] = this.shooting;
        const u = (now - start) / .9;
        if (u >= 1) { this.shooting = null; this.nextShooting = now + this.r.uniform(7, 16); }
        else {
          const hx = sx - u * 260, hy = sy + u * 130;
          const trail = ctx.createLinearGradient(hx, hy, hx + 70, hy - 35);
          trail.addColorStop(0, `rgba(255,255,255,${Math.sin(u * Math.PI)})`); trail.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = trail; ctx.lineWidth = 2; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + 70, hy - 35); ctx.stroke();
        }
      }
    } else {
      const sun = ctx.createRadialGradient(W * .88, -10, 0, W * .88, -10, 190);
      sun.addColorStop(0, 'rgba(255,246,205,.78)'); sun.addColorStop(.35, 'rgba(255,236,200,.35)'); sun.addColorStop(1, 'rgba(255,236,200,0)');
      ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H);
      const shade = mix('#ffffff', THEME.tint2, .4);
      for (const c of this.clouds) {
        const span = W + c.width * 2;
        const cx = ((c.x * span + now * c.speed) % span) - c.width;
        const cy = c.y * H + 30;
        const path = () => {
          ctx.beginPath();
          ctx.ellipse(cx, cy, c.width / 2, c.width * .16, 0, 0, TAU);
          for (const [dx, dy, rr] of c.puffs) { ctx.moveTo(cx + dx * c.width + rr * c.width, cy + dy * c.width * .6); ctx.arc(cx + dx * c.width, cy + dy * c.width * .6, rr * c.width, 0, TAU); }
        };
        ctx.save(); ctx.translate(0, 4); path(); ctx.fillStyle = 'rgba(120,100,170,.09)'; ctx.fill('nonzero'); ctx.restore();
        const body = ctx.createLinearGradient(0, cy - c.width * .3, 0, cy + c.width * .16);
        body.addColorStop(0, 'rgba(255,255,255,.96)'); body.addColorStop(.65, 'rgba(255,255,255,.92)'); body.addColorStop(1, rgba(shade, .9));
        path(); ctx.fillStyle = body; ctx.fill('nonzero');
      }
    }
  }
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
