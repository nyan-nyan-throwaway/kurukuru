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

  level(i, pos, cols) {
    const s = this.s;
    const idx = Math.floor(pos / 80) + (i - Math.floor(cols / 2)) * 3;
    if (s.state === 'play' && s.levels && idx >= 0 && idx < s.levels.length) return Math.min(1, s.levels[idx] * (.65 + .35 * ((i * 7) % 11) / 10));
    return 0;
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
      for (let i = 0; i < cols; i++) {
        const lv = this.level(i, now, cols);
        this.peaks[i] = Math.max(lv, this.peaks[i] - .02);
        const litn = Math.round(lv * rows), peak = Math.min(rows - 1, Math.round(this.peaks[i] * rows));
        for (let r = 0; r < rows; r++) {
          if (r === peak && this.peaks[i] > .05 && r >= litn) ctx.fillStyle = night ? T.led_on : T.accent;
          else if (r < litn) ctx.fillStyle = meterColors[r];
          else ctx.fillStyle = ghost;
          ctx.fillRect(x0 + i * (cw + gap), bottom - (r + 1) * rh - r * 2, cw, rh);
        }
      }
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
