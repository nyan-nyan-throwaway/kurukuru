// Display mode: a calm, full-screen "now playing" for when the phone is turned sideways
// (or the desktop app is left playing). Big spinning disc, a clock, the song, the current
// lyric line, a progress bar and the visualizer, all in the album's colors.
// The desktop app draws the same layout (main.py: DisplayView).
import { THEME, rgba, mix } from './theme.js';
import { font, circle, renderDiscFace } from './paint.js';
import { LcdView } from './lcd.js';

const TAU = Math.PI * 2;
const COLS = 28;

export class DisplayView {
  // disc: the player's DiscView (its face and angle are reused); state: the player state;
  // info(): { title, artist, album, cover (image or null), lyric, position ms, duration ms, playing }
  constructor(canvas, disc, state, info) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.disc = disc; this.info = info;
    this.meter = Object.create(LcdView.prototype);       // the same bars as the player's display
    this.meter.s = state;
    this.blurKey = ''; this.blur = null;
    this.lyricFade = { text: '', t: 1, prev: '' };
  }

  // The cover, shrunk to a few pixels and stretched back up: a soft color wash for the background.
  backdrop(cover) {
    const key = cover ? (cover.src || cover.width + 'x' + cover.height) + THEME.accent : 'none' + THEME.accent;
    if (key === this.blurKey) return this.blur;
    this.blurKey = key;
    if (!cover) { this.blur = null; return null; }
    const c = document.createElement('canvas'); c.width = 12; c.height = 12;
    const g = c.getContext('2d'); g.drawImage(cover, 0, 0, 12, 12);
    this.blur = c;
    return c;
  }

  draw(now = performance.now()) {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const T = THEME, s = this.info();
    const accent = T.accent;

    // ---- background: deep night with the album's colors glowing through
    ctx.fillStyle = '#120d22'; ctx.fillRect(0, 0, W, H);
    const wash = this.backdrop(s.cover);
    if (wash) {
      ctx.save(); ctx.globalAlpha = .55; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(wash, -W * .1, -H * .1, W * 1.2, H * 1.2); ctx.restore();
    }
    const glow = ctx.createRadialGradient(W * .28, H * .5, 0, W * .28, H * .5, Math.max(W, H) * .75);
    glow.addColorStop(0, rgba(accent, .30)); glow.addColorStop(.5, rgba(mix(accent, '#120d22', .6), .35)); glow.addColorStop(1, 'rgba(10,6,20,.82)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(10,6,20,.15)'); shade.addColorStop(1, 'rgba(10,6,20,.55)');
    ctx.fillStyle = shade; ctx.fillRect(0, 0, W, H);

    // ---- the disc, spinning
    const pad = Math.min(W, H) * .08;
    const R = Math.min(H * .40, W * .22);
    const cx = pad + R + W * .02, cy = H / 2;
    ctx.save();
    ctx.shadowColor = rgba(accent, .55); ctx.shadowBlur = R * .35;
    ctx.fillStyle = 'rgba(0,0,0,.35)'; circle(ctx, cx, cy, R * 1.01); ctx.fill();
    ctx.restore();
    // its own copy of the disc face at this size (the player keeps one at its own size)
    const dd = this.disc.disc;
    const key = [Math.round(R), dpr, this.disc.mode, dd.album, dd.artist, dd.cacheKey, THEME.name, JSON.stringify(dd.cdr || null)].join('|');
    if (key !== this.faceKey) {
      this.face = dd.album || dd.cdr ? renderDiscFace(R, dpr, dd.image, this.disc.mode, dd.album, dd.artist, THEME.name === 'Night', dd.cacheKey, dd.cdr) : null;
      this.faceKey = key;
    }
    const face = this.face;
    if (face) {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(this.disc.angle * Math.PI / 180);
      ctx.drawImage(face, -R, -R, R * 2, R * 2); ctx.restore();
    }
    // a gentle shine that stays still while the disc turns under it
    const shine = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    shine.addColorStop(0, 'rgba(255,255,255,.16)'); shine.addColorStop(.45, 'rgba(255,255,255,0)'); shine.addColorStop(.55, 'rgba(255,255,255,.07)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save(); circle(ctx, cx, cy, R); ctx.clip(); ctx.fillStyle = shine; ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.restore();

    // ---- the right side: clock, song, lyric, progress, visualizer
    const x0 = cx + R + W * .06, x1 = W - pad, colW = Math.max(120, x1 - x0);
    const fit = (text, px, bold) => {      // shrink long text a little, then trim it
      let size = px; ctx.font = font(size, bold);
      while (ctx.measureText(text).width > colW && size > px * .7) { size -= 1; ctx.font = font(size, bold); }
      if (ctx.measureText(text).width <= colW) return text;
      let t = text; while (t.length > 1 && ctx.measureText(t + '…').width > colW) t = t.slice(0, -1);
      return t + '…';
    };
    const d = new Date();
    const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)$/i, '');
    const ampm = (d.toLocaleTimeString([], { hour: 'numeric' }).match(/AM|PM/i) || [''])[0];
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    let y = H * .30;
    let clockPx = H * .2; ctx.font = font(clockPx, true);
    while (ctx.measureText(clock + ' PM').width > colW && clockPx > 20) { clockPx *= .92; ctx.font = font(clockPx, true); }   // narrow screens
    ctx.fillStyle = '#fff';
    ctx.shadowColor = rgba(accent, .6); ctx.shadowBlur = H * .05;
    ctx.fillText(clock, x0, y);
    const cw = ctx.measureText(clock).width;
    ctx.shadowBlur = 0;
    if (ampm) { ctx.font = font(H * .05, true); ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText(ampm, x0 + cw + H * .02, y); }
    y += H * .07;
    ctx.font = font(H * .042, true); ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillText(d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase(), x0, y);

    y = H * .55;
    if (s.title) {
      const title = fit(s.title, H * .075, true);      // (fit leaves the font set to the size that fits)
      ctx.fillStyle = '#fff'; ctx.fillText(title, x0, y);
      y += H * .065;
      const sub = fit(`${s.artist} · ${s.album}`, H * .045, false);
      ctx.fillStyle = 'rgba(255,255,255,.68)'; ctx.fillText(sub, x0, y);
    } else {
      ctx.font = font(H * .06, true); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText('Nothing playing', x0, y);
    }

    // the lyric line, fading in when it changes
    const lyric = s.lyric || '';
    const lf = this.lyricFade;
    if (lyric !== lf.text) { lf.prev = lf.text; lf.text = lyric; lf.t = 0; }
    lf.t = Math.min(1, lf.t + 1 / 14);
    if (lf.text) {
      y += H * .085;
      ctx.save(); ctx.globalAlpha = lf.t;
      ctx.font = font(H * .052, true); ctx.fillStyle = rgba(mix(accent, '#ffffff', .55));
      ctx.shadowColor = rgba(accent, .7); ctx.shadowBlur = H * .03;
      const line = fit('♪ ' + lf.text, H * .052, true);
      ctx.fillText(line, x0, y + (1 - lf.t) * 6);
      ctx.restore();
    }

    // progress
    const by = H * .80, bh = Math.max(3, H * .012);
    const frac = s.duration ? Math.max(0, Math.min(1, s.position / s.duration)) : 0;
    ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, by, colW, bh, bh / 2) : ctx.rect(x0, by, colW, bh); ctx.fill();
    ctx.fillStyle = accent; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, by, Math.max(bh, colW * frac), bh, bh / 2) : ctx.rect(x0, by, colW * frac, bh); ctx.fill();
    const mmss = ms => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    ctx.font = font(H * .036, false, true); ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillText(mmss(s.position), x0, by + bh + H * .055);
    ctx.textAlign = 'right'; ctx.fillText(s.duration ? '-' + mmss(s.duration - s.position) : '', x1, by + bh + H * .055); ctx.textAlign = 'left';
    if (s.title && !s.playing) {
      ctx.font = font(H * .036, true); ctx.fillStyle = rgba(accent, .95);
      ctx.textAlign = 'center'; ctx.fillText('❚❚ PAUSED', x0 + colW / 2, by + bh + H * .055); ctx.textAlign = 'left';
    }

    // the visualizer, along the very bottom of the right side
    this.meter.stepMeter(COLS, s.position);
    const vy = H - pad * .5, vh = H * .09, gap = colW / COLS;
    for (let i = 0; i < COLS; i++) {
      const v = (this.meter.bars[i] || 0), cap = (this.meter.caps[i] || { v: 0 }).v;
      const x = x0 + i * gap;
      ctx.fillStyle = rgba(accent, .25 + .55 * v);
      ctx.fillRect(x, vy - Math.max(1.5, v * vh), gap * .62, Math.max(1.5, v * vh));
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      if (cap > .02) ctx.fillRect(x, vy - cap * vh - 3, gap * .62, 1.5);
    }
  }
}
