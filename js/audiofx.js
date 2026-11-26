// Lyrics, the mechanical sounds, and the level meter's analysis of each song.

const STAMP = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;

export function parseLrc(text) {
  let offset = 0;
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim();
    const off = s.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) { offset = parseInt(off[1], 10); continue; }
    const stamps = [...s.matchAll(STAMP)];
    if (!stamps.length) continue;
    const body = s.replace(STAMP, '').replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim();
    for (const [, mm, ss] of stamps) {
      lines.push([Math.max(0, Math.round((parseInt(mm, 10) * 60 + parseFloat(ss.replace(':', '.'))) * 1000) - offset), body]);
    }
  }
  return lines.sort((a, b) => a[0] - b[0]);
}

// Lyrics with no timings: spread evenly through the song as a rough guide.
export function spreadLyrics(text, seconds) {
  let lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => !/^\[[^\]]*\]$/.test(l));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  if (!lines.length || !seconds) return [];
  const weights = lines.map(l => (l ? 1 : .6));
  const start = seconds * 70, end = seconds * 930;
  const step = (end - start) / weights.reduce((a, b) => a + b, 0);
  let t = start;
  return lines.map((l, i) => { const out = [Math.round(t), l]; t += step * weights[i]; return out; });
}

export function lyricsFor(text, seconds) {
  if (!text) return [];
  const synced = parseLrc(text);
  return synced.length ? synced : spreadLyrics(text, seconds);
}

// ---------------------------------------------------------------- mechanical sounds (synthesized)

let audioCtx = null;
const buffers = {};
export const sounds = { enabled: true, volume: .7 };

function seeded(seed) {
  let s = 0; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; };
}

function render(name, duration, make) {
  const rate = audioCtx.sampleRate, count = Math.floor(rate * duration);
  const buf = audioCtx.createBuffer(1, count, rate);
  const data = buf.getChannelData(0);
  const state = { lp: 0, phase: 0, noise: seeded(name) };
  let peak = 0;
  for (let i = 0; i < count; i++) { data[i] = make(i / rate, i / count, state, rate); peak = Math.max(peak, Math.abs(data[i])); }
  const fade = Math.floor(rate * .003);
  for (let i = 0; i < count; i++) data[i] = data[i] * .9 / (peak || 1) * (i > count - fade ? (count - i) / fade : 1);
  buffers[name] = buf;
}

function tick(t, s, bright = 2300) {
  if (t < 0) return 0;
  s.lp += .35 * (s.noise() - s.lp);
  return s.lp * Math.exp(-t / .0025) * 1.1 + Math.sin(2 * Math.PI * bright * t) * Math.exp(-t / .010) * .5
       + Math.sin(2 * Math.PI * bright * 1.62 * t) * Math.exp(-t / .005) * .25;
}

const motor = rising => (t, u, s, rate) => {
  const f = rising ? 55 + 270 * u ** .7 : 40 + 300 * (1 - u) ** .8;
  s.phase += 2 * Math.PI * f / rate;
  const env = rising ? (1 - Math.exp(-u * 14)) * (1 - u) ** 1.1 : (1 - u) ** 1.6;
  return (Math.sin(s.phase) + .45 * Math.sin(2 * s.phase) + .2 * Math.sin(3 * s.phase) + s.noise() * .12) * env;
};

const LEVELS = { press: 1, skip: .8, lid: 1, start: .55, stop: .55,
  case: .9, flip: .8, page: .8, scrub: .45, marker: .5, burn: .55, burned: .7, end: .6 };

// The newer sounds (the desktop app makes the same ones, from the same recipes).
const TAU = 2 * Math.PI;
const SOUND_RECIPES = {
  // a jewel case snapping open: two plastic clicks and a little hollow ring
  case: [.2, (t, u, s) => tick(t, s, 3200) * .9 + tick(t - .06, s, 2500) * .7 + Math.sin(TAU * 420 * t) * Math.exp(-t / .025) * .35
                         + (t > .06 ? Math.sin(TAU * 300 * (t - .06)) * Math.exp(-(t - .06) / .03) * .3 : 0)],
  // turning the case over: a soft plastic clack
  flip: [.12, (t, u, s) => Math.sin(TAU * 230 * t) * Math.exp(-t / .03) * .8 + tick(t, s, 1800) * .6 + Math.sin(TAU * 520 * t) * Math.exp(-t / .012) * .25],
  // a booklet page: a swipe of papery noise with a few crinkles
  page: [.32, (t, u, s) => {
    const n = s.noise();
    s.lp += .5 * (n - s.lp);
    s.b = (s.b || 0) + .3 * ((n - s.lp) - (s.b || 0));
    const env = Math.min(1, t / .04) * Math.exp(-Math.max(0, t - .04) / .11);
    return (s.b * 2.4 + (Math.abs(n) > .993 ? n * .5 : 0)) * env;
  }],
  // scrubbing: the laser's quick electronic pip
  scrub: [.05, (t, u, s, rate) => {
    s.phase += TAU * (2300 + 600 * u) / rate;
    return (Math.sin(s.phase) + .3 * Math.sin(3 * s.phase)) * Math.exp(-t / .02) * (1 - u);
  }],
  // a felt-tip marker squeaking on plastic
  marker: [.24, (t, u, s, rate) => {
    s.phase += TAU * (1100 + 250 * Math.sin(TAU * 7 * t) + 60 * s.noise()) / rate;
    s.lp += .4 * (s.noise() - s.lp);
    return (Math.sin(s.phase) * .55 + s.lp * .5) * Math.sin(Math.PI * u) ** .6 * (.7 + .3 * Math.sin(TAU * 23 * t));
  }],
  // a CD burner spinning up, with the laser seeking as it writes
  burn: [1.1, (t, u, s, rate) => {
    s.phase += TAU * (160 + 380 * Math.min(1, u * 2.2)) / rate;
    s.lp += .2 * (s.noise() - s.lp);
    const env = Math.min(1, u * 8) * (u > .85 ? 1 - (u - .85) / .15 : 1);
    const seek = u > .35 ? tick(t % .14, s, 2100) * .25 : 0;
    return (Math.sin(s.phase) + .35 * Math.sin(2 * s.phase) + s.lp * .6) * env * .8 + seek;
  }],
  // ...and the "done!" chime
  burned: [.75, (t) => {
    const note = (f, at) => (t < at ? 0 : (Math.sin(TAU * f * (t - at)) + .25 * Math.sin(TAU * 2 * f * (t - at))) * Math.exp(-(t - at) / .25));
    return note(1318.5, 0) * .8 + note(1975.5, .12);
  }],
  // the end of a disc: the motor winding down, then the pickup settling with a click
  end: [1.2, (t, u, s, rate) => {
    if (u < .85) {
      s.phase += TAU * (30 + 260 * (1 - u / .85) ** .9) / rate;
      return (Math.sin(s.phase) + .45 * Math.sin(2 * s.phase) + s.noise() * .1) * (1 - u / .85) ** 1.4;
    }
    return tick(t - 1.2 * .85, s, 1600) * .8;
  }],
};

export function unlockSounds() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = new Ctx();
  render('press', .07, (t, u, s) => tick(t, s) + Math.sin(2 * Math.PI * 150 * t) * Math.exp(-t / .018) * .7);
  render('skip', .1, (t, u, s) => tick(t, s, 1900) * .8 + tick(t - .045, s, 2100) * .6);
  render('lid', .15, (t, u, s) => Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t / .035) * .9 + tick(t, s, 1500) + tick(t - .055, s, 2600) * .45);
  render('start', .45, motor(true));
  render('stop', .4, motor(false));
  for (const [name, [duration, make]] of Object.entries(SOUND_RECIPES)) render(name, duration, make);
}

// For sounds that would repeat very fast (scrubbing, writing): at most one every `gap` ms.
const lastPlayed = {};
export function playSoundEvery(name, gap) {
  const now = performance.now();
  if (now - (lastPlayed[name] || 0) < gap) return;
  lastPlayed[name] = now;
  playSound(name);
}

export function playSound(name) {
  if (!sounds.enabled || !audioCtx || !buffers[name]) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const src = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  gain.gain.value = sounds.volume * (LEVELS[name] || 1) * .8;
  src.buffer = buffers[name];
  src.connect(gain).connect(audioCtx.destination);
  src.start();
}

// ---------------------------------------------------------------- level meter

// Loudness of the song in 80 ms steps (0..1), decoded at a low sample rate to keep memory small.
export async function analyzeLevels(blob) {
  const data = await blob.arrayBuffer();
  let buffer = null;
  for (const rate of [8000, 22050, 44100]) {
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Offline(1, rate, rate);
      buffer = await ctx.decodeAudioData(data.slice(0));
      break;
    } catch (e) { buffer = null; }
  }
  if (!buffer) return [];
  const ch = buffer.getChannelData(0);
  const chunk = Math.max(1, Math.round(buffer.sampleRate * .08));
  const out = [];
  for (let i = 0; i < ch.length; i += chunk) {
    let sum = 0; const end = Math.min(ch.length, i + chunk);
    for (let j = i; j < end; j++) sum += ch[j] * ch[j];
    const rms = Math.sqrt(sum / (end - i));
    out.push(Math.min(1, Math.max(.04, rms ** .55 * 2.1)));
  }
  return out;
}

// ---------------------------------------------------------------- the spectrum for the LCD visualizer

export const BANDS = 16, SPECTRUM_FPS = 25;

function fft(re, im) {   // in place, radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Turns per-band power (frames x BANDS, in dB) into 0..255 per band: each band scaled to its own loud
// moments, so bass, mids and treble all dance, while bands that hardly ever have anything stay low.
export function shapeSpectrum(db, frames) {
  const out = new Uint8Array(frames * BANDS);
  const tops = [], floors = [];
  for (let b = 0; b < BANDS; b++) {
    const col = [];
    for (let f = 0; f < frames; f++) col.push(db[f * BANDS + b]);
    col.sort((x, y) => x - y);
    const at = q => col[Math.min(col.length - 1, Math.floor(col.length * q))] ?? -120;
    tops.push(at(.99)); floors.push(at(.1));
  }
  const loudest = Math.max(...tops);
  for (let b = 0; b < BANDS; b++) {
    const top = tops[b] + 1.5, range = Math.max(18, top - floors[b]);   // this band's own quiet-to-loud span
    const weight = Math.max(0, Math.min(1, (tops[b] - (loudest - 48)) / 24));   // nearly-empty bands stay low
    for (let f = 0; f < frames; f++) {
      const v = Math.max(0, Math.min(1, (db[f * BANDS + b] - (top - range)) / range));
      out[f * BANDS + b] = Math.round(255 * v ** 1.35 * (.35 + .65 * weight));   // a curve leaves headroom for real hits
    }
  }
  return out;
}

// { spectrum: Uint8Array(frames x 16) at 25 fps, levels: [...] at 12.5 fps for the glow }
export async function analyzeSpectrum(blob) {
  const data = await blob.arrayBuffer();
  let buffer = null;
  for (const rate of [16000, 22050, 44100]) {
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      buffer = await new Offline(1, rate, rate).decodeAudioData(data.slice(0));
      break;
    } catch (e) { buffer = null; }
  }
  if (!buffer) return null;
  const rate = buffer.sampleRate, ch = buffer.getChannelData(0);
  const N = rate > 30000 ? 2048 : rate > 18000 ? 1024 : 512;
  const hop = rate / SPECTRUM_FPS, frames = Math.max(1, Math.floor(ch.length / hop));
  const edges = [];
  for (let b = 0; b <= BANDS; b++) edges.push(Math.max(1, Math.round(38 * (7600 / 38) ** (b / BANDS) / rate * N)));
  const win = new Float32Array(N).map((_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const re = new Float32Array(N), im = new Float32Array(N), db = new Float32Array(frames * BANDS);
  const levels = [];
  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop);
    let rms = 0;
    for (let i = 0; i < N; i++) { const v = ch[start + i] || 0; re[i] = v * win[i]; im[i] = 0; rms += v * v; }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      const lo = edges[b], hi = Math.max(lo + 1, edges[b + 1]);
      for (let k = lo; k < hi && k < N / 2; k++) sum += re[k] * re[k] + im[k] * im[k];
      db[f * BANDS + b] = 10 * Math.log10(sum / (hi - lo) + 1e-12);
    }
    if (f % 2 === 0) levels.push(Math.min(1, Math.max(.04, Math.sqrt(rms / N) ** .55 * 2.1)));
    if (f % 400 === 399) await new Promise(r => setTimeout(r, 0));   // keep the app responsive
  }
  return { v: 2, spectrum: shapeSpectrum(db, frames), levels };
}
