// Shop stickers for jewel cases. They sit on the lid, over the cover and the obi.
// The desktop app draws the same set (main.py: draw_sticker); positions are in case
// coordinates (the 172×178 jewel case) and the tilt comes from the album name, so a
// sticker sits the same way on both apps.
export const STICKERS = {
  new:      'NEW!',
  price:    'Price tag',
  sale:     'SALE',
  limited:  'Limited edition',
  sparkles: 'Sparkles',
  hearts:   'Hearts',
};
export const STICKER_SPOTS = { new: [136, 34], price: [128, 146], sale: [128, 96], limited: [90, 24], sparkles: [108, 66], hearts: [62, 140] };

function hash(text) { let h = 2166136261; for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
export function priceOf(album) { return `$${9 + (hash(album) % 10)}.99`; }
export const stickersOf = album => (album && ((album.custom && album.custom.stickers) || (album.pc && album.pc.stickers))) || [];

function star(ctx, x, y, outer, inner, points) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer, a = -Math.PI / 2 + (i * Math.PI) / points;
    ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}
function heart(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * .35);
  ctx.bezierCurveTo(x - s * 1.1, y - s * .35, x - s * .45, y - s * 1.05, x, y - s * .45);
  ctx.bezierCurveTo(x + s * .45, y - s * 1.05, x + s * 1.1, y - s * .35, x, y + s * .35);
  ctx.closePath();
}
function label(ctx, text, x, y, size, color, bold = true) {
  ctx.fillStyle = color; ctx.font = `${bold ? '800 ' : ''}${size}px "Nunito", "Avenir Next", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y);
}
const shadow = (ctx, on) => { ctx.shadowColor = on ? 'rgba(20,10,40,.35)' : 'transparent'; ctx.shadowBlur = on ? 2.5 : 0; ctx.shadowOffsetY = on ? 1 : 0; };

export function drawSticker(ctx, kind, album) {
  const [x, y] = STICKER_SPOTS[kind] || [90, 90];
  const tilt = (((hash(`${album}|${kind}`) % 1000) / 1000) - .5) * .5;
  ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
  if (kind === 'new') {
    shadow(ctx, true); star(ctx, 0, 0, 19, 15, 14); ctx.fillStyle = '#ffd93b'; ctx.fill(); shadow(ctx, false);
    ctx.strokeStyle = '#e8a700'; ctx.lineWidth = 1; ctx.stroke();
    label(ctx, 'NEW!', 0, .5, 10, '#d6264f');
  } else if (kind === 'price') {
    shadow(ctx, true);
    ctx.beginPath(); ctx.moveTo(-22, -9); ctx.lineTo(16, -9); ctx.lineTo(24, 0); ctx.lineTo(16, 9); ctx.lineTo(-22, 9); ctx.closePath();
    ctx.fillStyle = '#fffdf6'; ctx.fill(); shadow(ctx, false);
    ctx.strokeStyle = '#e46b8c'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.arc(17, 0, 1.8, 0, Math.PI * 2); ctx.fillStyle = '#c9b8c9'; ctx.fill();
    label(ctx, priceOf(album), -3, .5, 9.5, '#3a3046');
  } else if (kind === 'sale') {
    shadow(ctx, true); ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fillStyle = '#ef3b5d'; ctx.fill(); shadow(ctx, false);
    ctx.beginPath(); ctx.arc(0, 0, 12.5, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.setLineDash([2, 1.6]); ctx.lineWidth = .9; ctx.stroke(); ctx.setLineDash([]);
    label(ctx, 'SALE', 0, -2, 8.5, '#fff'); label(ctx, '20% OFF', 0, 6.5, 5, '#ffe3ea');
  } else if (kind === 'limited') {
    shadow(ctx, true);
    const g = ctx.createLinearGradient(-30, -7, 30, 7);
    g.addColorStop(0, '#c99a2e'); g.addColorStop(.45, '#ffe49a'); g.addColorStop(1, '#b88722');
    ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-31, -7, 62, 14, 3) : ctx.rect(-31, -7, 62, 14); ctx.fill(); shadow(ctx, false);
    label(ctx, 'LIMITED EDITION', 0, .5, 6.4, '#5a3d06');
  } else if (kind === 'sparkles') {
    ctx.fillStyle = '#fff'; shadow(ctx, true);
    for (const [sx, sy, r] of [[0, 0, 8], [13, -9, 4.5], [-9, 11, 3.5]]) { star(ctx, sx, sy, r, r * .28, 4); ctx.fill(); }
    shadow(ctx, false);
  } else if (kind === 'hearts') {
    shadow(ctx, true);
    for (const [hx, hy, s, c] of [[0, 0, 8, '#ff6f9f'], [12, -8, 5, '#ff9cc0'], [-10, -9, 4, '#ffc2d8']]) { heart(ctx, hx, hy, s); ctx.fillStyle = c; ctx.fill(); }
    shadow(ctx, false);
  }
  ctx.restore();
}

export function drawStickers(ctx, list, album) {
  for (const kind of Object.keys(STICKERS)) if (list.includes(kind)) drawSticker(ctx, kind, album || '');
}
