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

const LEVELS = { press: 1, skip: .8, lid: 1, start: .55, stop: .55 };

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
export async function analyseLevels(blob) {
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
