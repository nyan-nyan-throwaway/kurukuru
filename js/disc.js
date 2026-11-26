// The top-loading disc compartment: hinged glass lid, spinning printed disc, rotating clamp.
import { THEME, rgba, mix, smooth, darker } from './theme.js';
import { renderDiscFace, roundRect, circle, font, spacing } from './paint.js';

const TAU = Math.PI * 2;
const LID_MS = 240, OUT_MS = 260, IN_MS = 340;

export class DiscView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.angle = 0; this.speed = 0; this.spinning = false; this.loaded = false;
    this.disc = { image: null, cacheKey: '', album: '', artist: '', cdr: null };
    this.mode = 'design';
    this.lid = 0; this.holdOpen = false;
    this.alpha = 1; this.scale = 1; this.dy = 0; this.energy = 0;
    this.steps = []; this.u = 0; this.pending = null;
    this.face = null; this.faceKey = '';
    this.onLid = null;
    this.lidWasOpen = false;
    this.dirty = true;
  }

  setDisc(disc, animate = false) {
    const same = disc.album === this.disc.album && disc.artist === this.disc.artist && !!disc.cdr === !!this.disc.cdr;
    if (animate && !same) {
      this.pending = disc;
      this.steps = [['lid', 1]];
      if (this.loaded && this.alpha > .5) this.steps.push(['out']);
      this.steps.push(['apply'], ['in'], ['lid', 0]);
      this.u = 0;
    } else if (this.steps.length && this.pending) this.pending = disc;
    else { this.disc = disc; this.face = null; }
    this.dirty = true;
  }

  setMode(mode) { this.mode = mode; this.face = null; this.dirty = true; }
  setLoaded(v) { if (v !== this.loaded) { this.loaded = v; this.dirty = true; } }
  refresh() { this.face = null; this.dirty = true; }
  openLid() { this.holdOpen = true; if (!this.steps.length) this.steps = [['lid', 1]]; }
  closeLid() { this.holdOpen = false; if (!this.steps.length) this.steps = [['lid', 0]]; }

  step(dt) {
    const target = this.spinning ? 4.5 : 0;
    this.speed += (target - this.speed) * (this.spinning ? .06 : .035) * dt / 25;
    if (Math.abs(this.speed) < .004 && !this.spinning) this.speed = 0;
    let changed = !!this.speed || this.dirty;
    if (this.speed) this.angle = (this.angle + this.speed * dt / 25) % 360;
    if (this.steps.length) {
      changed = true;
      const s = this.steps[0];
      if (s[0] === 'lid') {
        const waiting = s[1] === 0 && this.holdOpen;
        const goal = waiting ? 1 : s[1];
        const d = dt / LID_MS;
        this.lid = goal > this.lid ? Math.min(goal, this.lid + d) : Math.max(goal, this.lid - d);
        if (this.lid === goal && !waiting) this.steps.shift();
      } else if (s[0] === 'out') {
        this.u += dt / OUT_MS; const e = smooth(this.u);
        this.alpha = 1 - e; this.scale = 1 + .1 * e; this.dy = -.1 * e;
        if (this.u >= 1) { this.steps.shift(); this.u = 0; }
      } else if (s[0] === 'apply') {
        if (this.pending) { this.disc = this.pending; this.pending = null; this.face = null; }
        this.steps.shift(); this.alpha = 0;
      } else if (s[0] === 'in') {
        this.u += dt / IN_MS; const e = smooth(this.u);
        this.alpha = e; this.scale = 1.1 - .1 * e; this.dy = -.1 * (1 - e);
        if (this.u >= 1) { this.steps.shift(); this.u = 0; }
      }
    }
    const opened = this.lid > .5;
    if (opened !== this.lidWasOpen) { this.lidWasOpen = opened; if (this.onLid) this.onLid(opened); }
    if (this.spinning) changed = true;
    return changed;
  }

  faceFor(R, dpr) {
    const d = this.disc;
    const key = [Math.round(R), dpr, this.mode, d.album, d.artist, d.cacheKey, THEME.name, JSON.stringify(d.cdr || null)].join('|');
    if (!this.face || this.faceKey !== key) {
      this.face = renderDiscFace(R, dpr, d.image, this.mode, d.album, d.artist, THEME.name === 'Night', d.cacheKey, d.cdr);
      this.faceKey = key;
    }
    return this.face;
  }

  draw() {
    this.dirty = false;
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const T = THEME;
    const side = Math.min(W, H) - 10;
    const Sx = (W - side) / 2, Sy = (H - side) / 2 - 2;
    const corner = side * .09;
    const cx = Sx + side / 2, cy = Sy + side / 2;
    const R = side * .425;
    // Shadow and the deck the lid closes onto.
    ctx.fillStyle = T.shadow; roundRect(ctx, Sx, Sy + 6, side, side, corner); ctx.fill();
    const deck = ctx.createLinearGradient(Sx, Sy, Sx + side, Sy + side);
    deck.addColorStop(0, rgba(mix(mix(T.lid_top, T.body_shadow, .18), T.tint, .2)));
    deck.addColorStop(1, rgba(mix(mix(T.lid_bot, T.body_shadow, .3), T.tint2, .25)));
    ctx.fillStyle = deck; ctx.strokeStyle = T.lid_edge; ctx.lineWidth = 2;
    roundRect(ctx, Sx, Sy, side, side, corner); ctx.fill(); ctx.stroke();
    if (this.lid > .02) {
      ctx.fillStyle = T.silk; ctx.font = font(Math.max(7, side * .024), true); ctx.textAlign = 'center'; spacing(ctx, 1.2);
      ctx.fillText('CLASS 1 LASER PRODUCT', cx, Sy + side - side * .045); spacing(ctx, 0); ctx.textAlign = 'left';
    }
    // Window lip and the well.
    const lip = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
    lip.addColorStop(0, rgba(darker(T.lid_edge, 1.12))); lip.addColorStop(1, 'rgba(255,255,255,.7)');
    ctx.fillStyle = lip; circle(ctx, cx, cy, R + 5); ctx.fill();
    const well = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    well.addColorStop(0, rgba(mix(T.well, '#ffffff', .15))); well.addColorStop(1, rgba(darker(T.well, 1.2)));
    ctx.fillStyle = well; circle(ctx, cx, cy, R); ctx.fill();
    ctx.save(); ctx.translate(cx, cy);
    if (!this.loaded || this.alpha < .99) {
      ctx.save(); ctx.rotate(35 * Math.PI / 180);
      ctx.fillStyle = rgba(darker(T.well, 1.4)); roundRect(ctx, R * .16, -R * .11, R * .72, R * .22, R * .05); ctx.fill();
      ctx.fillStyle = '#c8c3dc'; roundRect(ctx, R * .38, -R * .09, R * .22, R * .18, R * .03); ctx.fill();
      const lens = ctx.createRadialGradient(R * .49, 0, 0, R * .49, 0, R * .06);
      lens.addColorStop(0, '#e8f6ff'); lens.addColorStop(.6, '#7fb6ff'); lens.addColorStop(1, '#5a6fb5');
      ctx.fillStyle = lens; circle(ctx, R * .49, 0, R * .055); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#d2cce2'; circle(ctx, 0, 0, R * .13); ctx.fill();
      ctx.fillStyle = '#968eb0'; circle(ctx, 0, 0, R * .05); ctx.fill();
    }
    if (this.loaded && this.alpha > .01) {
      const Rd = R * .96;
      const face = this.faceFor(Rd, dpr);
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.translate(0, this.dy * R);
      ctx.scale(this.scale, this.scale);
      if (this.scale > 1.001) { ctx.fillStyle = `rgba(0,0,0,${.6 * (this.scale - 1) * 10 * .4})`; circle(ctx, R * .04, R * .1, Rd); ctx.fill(); }
      ctx.save();
      ctx.rotate(this.angle * Math.PI / 180);
      ctx.drawImage(face, -Rd - 1 / dpr, -Rd - 1 / dpr, face.width / dpr, face.height / dpr);
      ctx.fillStyle = '#ded9ec'; ctx.strokeStyle = '#968eb0'; ctx.lineWidth = 1;
      circle(ctx, 0, 0, Rd * .145); ctx.fill(); ctx.stroke();
      for (let n = 0; n < 3; n++) {
        const a = n * TAU / 3;
        ctx.fillStyle = '#ffffff'; circle(ctx, Math.cos(a) * Rd * .09, Math.sin(a) * Rd * .09, Rd * .025); ctx.fill();
      }
      ctx.fillStyle = '#a8a0c0'; circle(ctx, 0, 0, Rd * .045); ctx.fill();
      ctx.restore();
      // Stationary reflections on the spinning disc.
      ctx.save(); circle(ctx, 0, 0, Rd); ctx.clip();
      for (const [rot, a] of [[-35, .22], [145, .14]]) {
        ctx.save(); ctx.rotate(rot * Math.PI / 180);
        const sheen = ctx.createLinearGradient(-Rd, 0, Rd, 0);
        sheen.addColorStop(0, 'rgba(255,255,255,0)'); sheen.addColorStop(.47, 'rgba(255,255,255,0)');
        sheen.addColorStop(.5, `rgba(255,255,255,${a})`); sheen.addColorStop(.53, 'rgba(255,255,255,0)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sheen; circle(ctx, 0, 0, Rd); ctx.fill(); ctx.restore();
      }
      ctx.restore();
      ctx.restore();
    }
    ctx.restore();
    this.drawLid(ctx, Sx, Sy, side, corner, cx, cy, R);
  }

  drawLid(ctx, Sx, Sy, side, corner, cx, cy, R) {
    const T = THEME;
    const theta = this.lid * 84 * Math.PI / 180;
    const k = Math.cos(theta);
    if (this.lid > .001) {
      const ey = Sy + side * k;
      const shade = ctx.createLinearGradient(0, ey, 0, ey + side * .12);
      shade.addColorStop(0, `rgba(0,0,0,${.27 * this.lid})`); shade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shade; ctx.fillRect(Sx + corner * .4, ey, side - corner * .8, side * .12);
    }
    ctx.save();
    ctx.translate(0, Sy); ctx.scale(1, Math.max(k, .001)); ctx.translate(0, -Sy);
    // Body with a round window cut out.
    const lid = ctx.createLinearGradient(Sx, Sy, Sx + side, Sy + side);
    lid.addColorStop(0, rgba(mix(T.lid_top, T.tint, .32))); lid.addColorStop(1, rgba(mix(T.lid_bot, T.tint2, .45)));
    roundRect(ctx, Sx, Sy, side, side, corner);
    ctx.moveTo(cx + R + 5, cy); ctx.arc(cx, cy, R + 5, 0, TAU, true);
    ctx.fillStyle = lid; ctx.fill('evenodd');
    ctx.strokeStyle = rgba(mix(T.lid_edge, T.tint, .3)); ctx.lineWidth = 2; ctx.stroke();
    const gloss = ctx.createLinearGradient(0, Sy, 0, Sy + side * .5);
    gloss.addColorStop(0, `rgba(255,255,255,${T.name === 'Night' ? .12 : .47})`); gloss.addColorStop(1, 'rgba(255,255,255,0)');
    roundRect(ctx, Sx, Sy, side, side, corner); ctx.moveTo(cx + R + 5, cy); ctx.arc(cx, cy, R + 5, 0, TAU, true);
    ctx.fillStyle = gloss; ctx.fill('evenodd');
    ctx.strokeStyle = `rgba(255,255,255,${T.hl / 2})`; ctx.lineWidth = 1.5;
    roundRect(ctx, Sx + 4, Sy + 4, side - 8, side - 8, corner - 3); ctx.stroke();
    // Light ring that breathes with the music.
    const strength = this.spinning ? .35 + .65 * this.energy : .22;
    ctx.beginPath(); ctx.arc(cx, cy, R + 15, 0, TAU); ctx.arc(cx, cy, R + 5, 0, TAU, true);
    const glow = ctx.createRadialGradient(cx, cy, R + 4, cx, cy, R + 15);
    glow.addColorStop(0, rgba(T.led_on, .92 * strength)); glow.addColorStop(1, rgba(T.led_on, 0));
    ctx.fillStyle = glow; ctx.fill('evenodd');
    ctx.beginPath(); ctx.arc(cx, cy, R + 8, 0, TAU); ctx.arc(cx, cy, R + 5, 0, TAU, true);
    const sweep = ctx.createConicGradient(-this.angle * 1.5 * Math.PI / 180, cx, cy);
    sweep.addColorStop(0, rgba(T.fill2, .63 * strength)); sweep.addColorStop(.5, rgba(T.fill, 0)); sweep.addColorStop(1, rgba(T.fill2, .63 * strength));
    ctx.fillStyle = sweep; ctx.fill('evenodd');
    // Smoked glass window.
    ctx.save(); circle(ctx, cx, cy, R); ctx.clip();
    ctx.fillStyle = T.glass; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.translate(cx, cy);
    for (const [pts, a] of [[[[-R, -R * .25], [-R * .25, -R], [-R * .05, -R], [-R, -R * .05]], .2], [[[-R, R * .15], [R * .15, -R], [R * .27, -R], [-R, R * .27]], .1]]) {
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, R - 3, -170 * Math.PI / 180, -100 * Math.PI / 180); ctx.stroke();
    ctx.strokeStyle = rgba(darker(T.lid_edge, 1.15)); ctx.lineWidth = 1.5; circle(ctx, cx, cy, R); ctx.stroke();
    ctx.fillStyle = T.silk; spacing(ctx, 1.5);
    if (side >= 220) {
      ctx.font = font(Math.max(8, side * .028), true);
      ctx.textAlign = 'left'; ctx.fillText('ANTI-SKIP', Sx + corner * .7, Sy + side - side * .05);
      ctx.textAlign = 'right'; ctx.fillText('DIGITAL AUDIO', Sx + side - corner * .7, Sy + side - side * .05);
    }
    ctx.font = font(Math.max(7, side * .022), true); ctx.textAlign = 'center';
    ctx.fillText('▲ OPEN', cx, Sy + side * .055); ctx.textAlign = 'left'; spacing(ctx, 0);
    if (this.lid > .001) { roundRect(ctx, Sx, Sy, side, side, corner); ctx.fillStyle = `rgba(0,0,0,${.22 * this.lid})`; ctx.fill(); }
    ctx.restore();
    if (this.lid > .001) {
      const ey = Sy + side * k, thick = 8 * Math.sin(theta);
      const edge = ctx.createLinearGradient(0, ey, 0, ey + thick);
      edge.addColorStop(0, T.lid_edge); edge.addColorStop(1, rgba(darker(T.lid_edge, 1.3)));
      ctx.fillStyle = edge; roundRect(ctx, Sx + 2, ey - 1, side - 4, thick + 1, 3); ctx.fill();
    }
  }
}
