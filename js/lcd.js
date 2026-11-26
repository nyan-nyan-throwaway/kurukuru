// The segmented LCD: state flags, track & time digits, scrolling title, lyrics, track calendar, level meter.
import { THEME, rgba, mix, fromHsv, toHsv } from './theme.js';
import { roundRect, font, sevenSeg, sevenSegWidth, drawIcon, elide, fmtTime, spacing } from './paint.js';

export class LcdView {
  constructor(canvas, source) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.s = source;          // the player state object
    this.peaks = new Array(24).fill(0);
    this.marqueeStart = performance.now() / 1000;
    this.lastTitle = '';
  }

  lyricNow(pos) {
    const s = this.s;
    if (!s.showLyrics || !s.lyrics || !s.lyrics.length) return null;
    let lo = 0, hi = s.lyrics.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.lyrics[mid][0] <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best < 0 ? null : s.lyrics[best][1];
  }

  // The visualizer: 16 frequency bands spread over the columns, bass on the left, treble on the right.
  bandTarget(i, cols, pos) {
    const s = this.s;
    if (s.state !== 'play') return 0;
    const sp = s.spectrum, B = 16;
    if (sp && sp.length >= B) {
      const frames = sp.length / B, fpos = pos / 40;
      const f0 = Math.max(0, Math.min(frames - 1, Math.floor(fpos))), f1 = Math.min(frames - 1, f0 + 1), ft = Math.max(0, fpos - f0);
      const bpos = i * (B - 1) / Math.max(1, cols - 1), b0 = Math.floor(bpos), b1 = Math.min(B - 1, b0 + 1), bt = bpos - b0;
      const at = (f, b) => sp[f * B + b] / 255;
      const v0 = at(f0, b0) * (1 - bt) + at(f0, b1) * bt, v1 = at(f1, b0) * (1 - bt) + at(f1, b1) * bt;
      return v0 + (v1 - v0) * ft;
    }
    if (s.levels) {   // still measuring this song: a gentle made-up shape that follows the loudness
      const lv = s.levels[Math.floor(pos / 80)] || 0;
      const shape = .55 + .45 * Math.sin(i * 1.7 + pos / 310) * Math.cos(i * .6 - pos / 530);
      return Math.min(1, lv * (.45 + .55 * shape));
    }
    return 0;
  }

  // Bars leap up and fall back smoothly; peak caps float for a moment, then drop.
  stepMeter(cols, pos) {
    const t = performance.now(), dt = Math.min(.1, (t - (this.meterT || t)) / 1000);
    this.meterT = t;
    this.bars = this.bars || []; this.caps = this.caps || [];
    for (let i = 0; i < cols; i++) {
      const target = this.bandTarget(i, cols, pos);
      let b = this.bars[i] || 0;
      b = target > b ? b + (target - b) * .75 : Math.max(target, b - dt * 1.7);
      this.bars[i] = b;
      const cap = this.caps[i] || (this.caps[i] = { v: 0, hold: 0, vel: 0 });
      if (b >= cap.v) { cap.v = b; cap.hold = .35; cap.vel = 0; }
      else if (cap.hold > 0) cap.hold -= dt;
      else { cap.vel += dt * 2.4; cap.v = Math.max(b, cap.v - cap.vel * dt); }
    }
  }

  draw() {
    const c = this.canvas, ctx = this.ctx, s = this.s, T = THEME;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const night = T.lcd_glow;
    const now = s.position();
    // Bezel and screen.
    ctx.fillStyle = T.shadow; roundRect(ctx, 1, 4, W - 2, H - 4, 18); ctx.fill();
    const bezel = ctx.createLinearGradient(0, 0, 0, H);
    bezel.addColorStop(0, T.lcd_bezel_top); bezel.addColorStop(1, T.lcd_bezel_bot);
    ctx.fillStyle = bezel; roundRect(ctx, 1, 1, W - 2, H - 4, 18); ctx.fill();
    const Sx = 10, Sy = 10, Sw = W - 20, Sh = H - 23;
    const screen = ctx.createLinearGradient(Sx, Sy, Sx + Sw, Sy + Sh);
    if (night) { screen.addColorStop(0, rgba(mix(T.lcd_top, T.tint, .1))); screen.addColorStop(1, rgba(mix(T.lcd_bot, T.tint2, .14))); }
    else { screen.addColorStop(0, rgba(fromHsv(Math.max(0, toHsv(T.tint).h), 38, 250))); screen.addColorStop(1, rgba(fromHsv(Math.max(0, toHsv(T.tint2).h), 62, 230))); }
    ctx.fillStyle = screen; roundRect(ctx, Sx, Sy, Sw, Sh, 10); ctx.fill();
    ctx.save(); roundRect(ctx, Sx, Sy, Sw, Sh, 10); ctx.clip();
    const on = T.lcd_on, ghost = rgba(T.lcd_on, T.lcd_ghost);
    const lit = f => (f ? on : ghost);
    const pad = 13, x0 = Sx + pad, x1 = Sx + Sw - pad;
    let y = Sy + 10;
    ctx.textBaseline = 'top';
    // Row 1: flags.
    ctx.font = font(9.5, true); spacing(ctx, 1);
    drawIcon(ctx, ({ play: 'play', pause: 'pause' })[s.state] || 'stop', x0 + 5, y + 6, 5.5, s.state !== 'nodisc' ? on : ghost);
    let x = x0 + 15;
    let label = ({ play: 'PLAY', pause: 'PAUSE', stop: 'STOP', nodisc: 'NO DISC', error: 'ERROR' })[s.state] || 'STOP';
    if (s.lidOpen) label = 'OPEN';
    ctx.fillStyle = on; ctx.fillText(label, x, y + 1);
    x += Math.max(ctx.measureText('NO DISC').width, ctx.measureText(label).width) + 10;
    for (const [text, flag] of [['SHUF', s.shuffle], ['RPT', s.repeat], ['LYRICS', !!(s.lyrics && s.lyrics.length && s.showLyrics)]]) {
      ctx.fillStyle = lit(flag); ctx.fillText(text, x, y + 1); x += ctx.measureText(text).width + 9;
    }
    const badge = s.disc ? `CD${s.disc}` : 'CD';   // which disc of a multi-disc album is in
    const bw = Math.max(26, ctx.measureText(badge).width + 12);
    ctx.strokeStyle = lit(s.trackCount); ctx.lineWidth = 1.3; roundRect(ctx, x1 - bw, y - 1, bw, 14, 4); ctx.stroke();
    ctx.fillStyle = lit(s.trackCount); ctx.textAlign = 'center'; ctx.fillText(badge, x1 - bw / 2, y + 1); ctx.textAlign = 'left';
    spacing(ctx, 0);
    y += 21;
    // Row 2: track number and time.
    const dh = Math.max(22, Math.min(44, Sh * .21));
    ctx.font = font(8.5, true); spacing(ctx, 1.3); ctx.fillStyle = on;
    ctx.fillText('TRACK', x0, y);
    const trackText = s.trackNo != null ? String(s.trackNo % 100).padStart(2, '0') : '--';
    const timeText = s.state !== 'nodisc' && s.trackNo != null ? fmtTime(now) : '--:--';
    const tw = sevenSegWidth(timeText, dh);
    ctx.fillText('TIME', x1 - tw, y);
    if (s.duration) { ctx.textAlign = 'right'; ctx.fillText('/ ' + fmtTime(s.duration), x1, y); ctx.textAlign = 'left'; }
    spacing(ctx, 0);
    y += 13;
    sevenSeg(ctx, trackText, x0, y, dh, on, ghost, night);
    sevenSeg(ctx, timeText, x1 - tw, y, dh, on, ghost, night);
    y += dh + 9;
    // Row 3: scrolling title.
    ctx.font = font(15, true); ctx.fillStyle = on;
    if (s.title !== this.lastTitle) { this.lastTitle = s.title; this.marqueeStart = performance.now() / 1000; }
    const width = ctx.measureText(s.title).width, area = x1 - x0;
    this.marquee = width > area;
    if (this.marquee) {
      const gap = 50, speed = 36, hold = 2.2;
      const cycle = (width + gap) / speed + hold;
      const phase = (performance.now() / 1000 - this.marqueeStart) % cycle;
      const off = phase < hold ? 0 : (phase - hold) * speed;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y - 2, area, 22); ctx.clip();
      ctx.fillText(s.title, x0 - off, y); ctx.fillText(s.title, x0 - off + width + gap, y);
      ctx.restore();
    } else ctx.fillText(s.title, x0, y);
    y += 21;
    // Row 4: lyric line, a short message, or artist · album.
    let line = null, bold = false;
    if (s.flash && performance.now() < s.flash[1]) { line = '» ' + s.flash[0]; bold = true; }
    else { const lyric = this.lyricNow(now); if (lyric) { line = '♪ ' + lyric; bold = true; } }
    if (!line) line = s.subtitle;
    let size = bold ? 12.5 : 11.5;
    ctx.font = font(size, bold);
    while (size > 9.5 && ctx.measureText(line).width > area) { size -= .5; ctx.font = font(size, bold); }
    ctx.fillText(elide(ctx, line, area), x0, y);
    y += 19;
    const bottom = Sy + Sh - 10;
    // Row 5: track calendar.
    const [pos, count] = s.calendar || [0, 0];
    if (count && bottom - y - (s.showMeter ? 26 : 0) >= 18) {
      const bw = 19, g = 3;
      const fits = Math.max(1, Math.floor((area - 36 + g) / (bw + g)));
      const first = count <= fits ? 0 : Math.min(Math.max(0, pos - Math.floor(fits / 2) - 1), count - fits);
      ctx.font = font(9.5, true); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let n = first; n < Math.min(count, first + fits); n++) {
        const bx = x0 + (n - first) * (bw + g);
        if (n + 1 === pos) { ctx.fillStyle = on; roundRect(ctx, bx, y, bw, 14, 3); ctx.fill(); ctx.fillStyle = T.lcd_top; }
        else ctx.fillStyle = on;
        ctx.fillText(String(n + 1), bx + bw / 2, y + 7.5);
      }
      ctx.font = font(8, true); ctx.fillStyle = lit(first + fits < count); ctx.textAlign = 'right';
      ctx.fillText('OVER', x1, y + 7.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      y += 21;
    }
    // Row 6: level meter.
    if (s.showMeter && bottom - y >= 16) {
      const cols = 24, gap = 2.5;
      const cw = (area - (cols - 1) * gap) / cols;
      const rows = Math.max(4, Math.min(10, Math.floor((bottom - y) / 6)));
      const rh = (bottom - y - (rows - 1) * 2) / rows;
      const meterColors = [];
      for (let r = 0; r < rows; r++) {
        const m = mix(T.fill2, T.fill, r / Math.max(1, rows - 1));
        meterColors.push(night ? rgba(mix(m, on, .1)) : rgba(fromHsv(Math.max(0, toHsv(m).h), Math.min(255, toHsv(m).s + 70), 185)));
      }
      this.stepMeter(cols, now);
      const capColor = night ? T.led_on : T.accent;
      for (let i = 0; i < cols; i++) {
        const b = this.bars[i], cap = this.caps[i].v;
        const litn = Math.round(b * rows);
        const x = x0 + i * (cw + gap);
        for (let r = 0; r < rows; r++) {
          ctx.fillStyle = r < litn ? meterColors[r] : ghost;
          ctx.fillRect(x, bottom - (r + 1) * rh - r * 2, cw, rh);
        }
        if (cap > .04) {   // the floating peak cap: a thin bar just above where the bar reached
          const capRow = Math.min(rows - 1, Math.max(litn, Math.ceil(cap * rows) - 1));
          const yTop = bottom - (capRow + 1) * rh - capRow * 2;
          ctx.fillStyle = capColor;
          ctx.fillRect(x, yTop + (capRow < litn ? 0 : rh * .55), cw, rh * .45);
        }
      }
      this.peaks = this.caps.map(c => c.v);
    }
    // Glass.
    const shade = ctx.createLinearGradient(0, Sy, 0, Sy + 10);
    shade.addColorStop(0, 'rgba(0,0,0,.16)'); shade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shade; ctx.fillRect(Sx, Sy, Sw, 10);
    ctx.beginPath(); ctx.moveTo(Sx, Sy); ctx.lineTo(Sx + Sw * .42, Sy); ctx.lineTo(Sx + Sw * .22, Sy + Sh); ctx.lineTo(Sx, Sy + Sh); ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${night ? .055 : .13})`; ctx.fill();
    ctx.restore();
  }

  needsFrame() {
    const s = this.s;
    return (s.state === 'play') || this.marquee || this.peaks.some(p => p > .02) || (s.flash && performance.now() < s.flash[1] + 100);
  }
}
