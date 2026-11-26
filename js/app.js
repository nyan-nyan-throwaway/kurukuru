// Kurukuru CD for iPhone: the app.
import { THEME, setTheme, albumScheme, autoThemeName, SCHEME_KEYS, albumPalette, mix, rgba, hex, parse, smooth, crc32, darker } from './theme.js';
import { Sky, paintCaseFront, paintCaseBack, paintCaseBackImage, paintSpine, fmtTime, paintSlimCase, paintCdrBack, paintCdrSpine,
         renderDiscFace, CDR_DYES, MARKERS, OBI_DESIGNS, obiEffective } from './paint.js';
import { DiscView } from './disc.js';
import { LcdView } from './lcd.js';
import { lib, loadLibrary, importFiles, albumTracks, sortedAlbums, imageFor, imageBlob, audioBlob, deleteAlbum, cachedLevels, saveLevels,
         applyPlexLibrary, forgetPlex, keepAlbum, unkeepAlbum, saveTrack, art, bookletPages, setAlbumArt, resetAlbumArt, setObi,
         setTrackLyrics, decodeText, discOf, discCount, discArt, findCdr, cdrTracks, cdrMinutes, newCdr, updateCdr, burnTo, deleteCdr, CDR_MINUTES } from './library.js';
import { makeBackup, restoreBackup } from './backup.js';
import * as plexApi from './plex.js';
const { plex } = plexApi;
import { lyricsFor, unlockSounds, playSound, sounds, analyseLevels } from './audiofx.js';
import { storageInfo, askPersist } from './db.js';

const VERSION = '1.3';
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- settings

const DEFAULTS = { theme: 'Auto', disc: 'design', obi: true, sky: true, meter: true, lyrics: true, sounds: true, fx: 70, shelf: 'cases', volume: 1 };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('kurukuru-settings') || '{}')); } catch (e) { /* private mode */ }
const saveSettings = () => { try { localStorage.setItem('kurukuru-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

// ---------------------------------------------------------------- player state

const audio = new Audio();
audio.preload = 'auto';
audio.setAttribute('playsinline', '');
let audioUrl = null;
const state = {
  title: 'Insert a disc', subtitle: 'Tap the lid to add music', trackNo: null, duration: 0, state: 'nodisc',
  shuffle: false, repeat: false, trackCount: 0, calendar: [0, 0], levels: null, showMeter: settings.meter,
  lyrics: [], showLyrics: settings.lyrics, lidOpen: false, flash: null, disc: null,
  position: () => (current ? audio.currentTime * 1000 : 0),
};
let current = null;          // the playing track
let playingCdr = null;       // the CD-R being played (its id), or null when playing an album
let retried = false;         // a stream that failed once gets one retry after re-finding the server
let order = [];              // play order: every song, album by album
let energy = 0;
let scheme = { from: null, to: null, t: 1, source: [[], null] };

const disc = new DiscView($('disc'));
const lcd = new LcdView($('lcd'), state);
const sky = new Sky();
disc.setMode(settings.disc);
disc.onLid = open => { state.lidOpen = open; playSound('lid'); };

function flash(text, seconds = 3.5) { state.flash = [text, performance.now() + seconds * 1000]; }
function toast(text, seconds = 3.5) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, seconds * 1000);
}

// ---------------------------------------------------------------- colours

function setVars() {
  const T = THEME, night = T.name === 'Night';
  const v = {
    '--bg': T.bg, '--ink': T.ink, '--ink-soft': T.ink_soft, '--silk': T.silk,
    '--chassis-top': rgba(mix(T.body_top, T.tint, .3)), '--chassis-mid': rgba(mix(T.body_bot, T.tint, .3)),
    '--chassis-bot': rgba(mix(T.body_bot, T.tint2, .55)), '--chassis-edge': rgba(mix(T.body_edge, T.tint, .35)),
    '--chassis-base': rgba(mix(T.body_shadow, T.tint, .3)), '--shadow-a': night ? .5 : .2, '--gloss': night ? .16 : .6,
    '--visor-top': night ? .1 : .28, '--visor-bot': night ? .07 : .16, '--visor-tint': rgba(mix(T.body_top, T.tint, .35), night ? .27 : .45),
    '--recess-a': rgba(mix(T.recess, T.tint, .3)), '--recess-b': rgba(mix(T.recess, T.tint2, .42)), '--recess-edge-t': rgba(mix(T.recess_edge, T.tint, .3)),
    '--btn-top': T.btn_top, '--btn-bot': T.btn_bot, '--btn-bot-t': rgba(mix(T.btn_bot, T.tint, .15)), '--btn-edge': T.btn_edge,
    '--btn-shadow-t': rgba(mix(T.btn_shadow, T.tint, .25)), '--hl': T.hl,
    '--accent': T.accent, '--fill': T.fill, '--fill2': T.fill2, '--play-top': T.play_top, '--play-bot': T.play_bot,
    '--play-edge': T.play_edge, '--play-ink': T.play_ink, '--led-on': T.led_on, '--led-on-a': rgba(T.led_on, .45), '--led-off': T.led_off,
    '--list-bg': T.list_bg, '--list-sel': T.list_sel, '--list-hover': T.list_hover, '--tint-a': rgba(T.tint, night ? .24 : .18),
    '--groove-t': rgba(mix(T.groove, T.tint, .2)), '--groove-edge': T.groove_edge, '--handle-edge': T.handle_edge,
    '--knob': rgba(mix(T.handle, T.tint, .35)),
  };
  const root = document.documentElement.style;
  for (const k in v) root.setProperty(k, v[k]);
  document.querySelector('meta[name=theme-color]').content = T.bg;
}

function applyTheme() {
  setTheme(settings.theme === 'Auto' ? autoThemeName() : settings.theme);
  Object.assign(THEME, albumScheme(scheme.source[0], scheme.source[1], THEME.name === 'Night'));
  scheme.t = 1;
  setVars();
  disc.refresh();
  repaintCases();
}

async function schemeFor(track, cdr) {
  let palette = [], seed = null;
  if (cdr) {
    const [, light, mid, dark] = CDR_DYES[cdr.dye] || CDR_DYES.gold;
    palette = [parse(mid), parse(dark), parse(light)];
    seed = crc32(cdr.id);
  } else if (track) {
    const album = lib.albums.get(track.albumKey);
    const cover = art(album, 'cover');
    const img = cover ? await imageFor(cover) : null;
    palette = img ? albumPalette(img, 3, cover) : [];
    seed = crc32(`${track.album}\n${track.artist}`);
  }
  scheme.source = [palette, seed];
  scheme.from = Object.fromEntries(SCHEME_KEYS.map(k => [k, THEME[k]]));
  scheme.to = albumScheme(palette, seed, THEME.name === 'Night');
  scheme.t = 0;
}

// ---------------------------------------------------------------- playback

function rebuildOrder() {
  order = sortedAlbums().flatMap(a => albumTracks(a).map(t => t.id));
  state.trackCount = order.length;
  disc.setLoaded(order.length > 0);
  if (!current) idleText();
}

function idleText() {
  state.disc = null;
  if (order.length) { state.state = 'stop'; state.title = 'Disc ready'; state.subtitle = `${order.length} songs · press PLAY`; }
  else { state.state = 'nodisc'; state.title = 'Insert a disc'; state.subtitle = 'Tap the lid to add music'; }
}

// The disc in the player, its print and the colours, for what's playing now.
async function refreshDisc(animate) {
  if (!current) return null;
  const track = current, cdr = playingCdr && findCdr(playingCdr);
  if (cdr) {
    disc.setDisc({ image: null, cacheKey: `cdr:${cdr.id}:${cdr.v || 0}:${cdr.tracks.length}`, album: cdr.title, artist: '', cdr: cdrLook(cdr) }, animate);
    schemeFor(track, cdr);
    return null;
  }
  const album = lib.albums.get(track.albumKey);
  const n = album && discCount(album) > 1 ? discOf(track) : 0;
  const coverId = art(album, 'cover'), discId = discArt(album, n);
  const cover = coverId ? await imageFor(coverId) : null;
  const discImg = discId ? await imageFor(discId) : null;
  const artist = album ? album.artist : track.artist;
  disc.setDisc({ image: discImg || cover, cacheKey: (discId || coverId || '') + (n ? ':' + n : ''), album: track.album,
                 artist: n ? `${artist}  ·  DISC ${n}` : artist,
                 cdr: null, ...(discImg ? { forceArt: true } : {}) }, animate);
  if (discImg) disc.setMode('art'); else disc.setMode(settings.disc);
  schemeFor(track, null);
  return cover;
}

async function playTrack(id, { autoplay = true, animate = true, cdr = null } = {}) {
  const track = lib.tracks.get(id);
  if (!track) return;
  if (current && current.id !== id) playSound('skip');
  current = track;
  const disc_ = cdr && findCdr(cdr);
  playingCdr = disc_ ? disc_.id : null;
  const album = lib.albums.get(track.albumKey);
  let tracks = disc_ ? cdrTracks(disc_) : album ? albumTracks(album) : [track];
  const discs = !disc_ && album ? discCount(album) : 1;
  state.disc = discs > 1 ? discOf(track) : null;
  if (state.disc) tracks = tracks.filter(t => discOf(t) === state.disc);   // the counter covers this disc
  const pos = tracks.findIndex(t => t.id === id) + 1;
  state.trackNo = disc_ ? pos : (track.track || pos);
  state.calendar = [pos, tracks.length];
  state.duration = (track.duration || 0) * 1000;
  state.title = track.title;
  state.subtitle = [track.artist, track.album, disc_ ? '' : track.year].filter(Boolean).join('  ·  ');
  state.lyrics = lyricsFor(track.lyrics, track.duration);
  state.levels = null;
  const cover = await refreshDisc(animate);
  const streamed = track.source === 'plex' && !track.local;
  const blob = streamed ? null : await audioBlob(id);
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  if (streamed) {
    if (!plex.connected) { toast('Connect to Plex in Settings to play this.'); return; }
    audio.src = plexApi.streamUrl(track);
    retried = false;
  } else {
    if (!blob) { toast('This song’s file is missing.'); return; }
    audioUrl = URL.createObjectURL(blob);
    audio.src = audioUrl;
  }
  if (track.source === 'plex' && track.lyrics == null) {
    plexApi.fetchLyrics(track).then(text => {
      track.lyrics = text || '';
      saveTrack(track);
      if (current === track) state.lyrics = lyricsFor(track.lyrics, track.duration);
    });
  }
  if (autoplay) audio.play().catch(() => {});
  renderNow();
  markPlaying();
  updateMediaSession(track, disc_ ? cdrArtwork(disc_) : cover);
  try { localStorage.setItem('kurukuru-last', JSON.stringify({ id, cdr: playingCdr })); } catch (e) { /* ignore */ }
  // The level meter (and the glow) need the song's loudness: cached, or worked out in the background.
  const levels = await cachedLevels(id);
  if (levels) { if (current === track) state.levels = levels; }
  else if (settings.meter && (blob || (track.size && track.size < 60e6))) setTimeout(async () => {
    try {
      if (current !== track) return;
      const lv = await analyseLevels(blob || await plexApi.fetchSong(track));
      if (lv.length) { await saveLevels(id, lv); if (current === track) state.levels = lv; }
    } catch (e) { /* no meter for this one */ }
  }, 1500);
}

function togglePlay() {
  unlockSounds();
  if (!current) {
    if (shownCdr && findCdr(shownCdr) && findCdr(shownCdr).tracks.length) playTrack(cdrTracks(findCdr(shownCdr))[0].id, { cdr: shownCdr });
    else if (order.length) playTrack(order[0]); else openPicker();
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

// What PREV/NEXT move through: the CD-R being played, or every album on the shelf.
function queue() {
  const cdr = playingCdr && findCdr(playingCdr);
  return cdr ? cdrTracks(cdr).map(t => t.id) : order;
}

function step(dir) {
  const q = queue();
  if (!q.length) return;
  if (dir < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const ctx = { cdr: playingCdr };
  if (state.shuffle && q.length > 1 && dir > 0) {
    let id; do { id = q[Math.floor(Math.random() * q.length)]; } while (current && id === current.id);
    playTrack(id, ctx); return;
  }
  const i = current ? q.indexOf(current.id) : -1;
  playTrack(q[(i + dir + q.length) % q.length], ctx);
}

function cdrArtwork(cdr) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2633'; g.fillRect(0, 0, 512, 512);
  g.setTransform(512 / 172, 0, 0, 512 / 172, 0, 3);
  paintSlimCase(g, cdrLook(cdr));
  return c;
}

audio.addEventListener('play', () => {
  state.state = 'play'; disc.spinning = true; playSound('start');
  document.body.classList.add('playing'); $('led').classList.add('on');
  setPlayIcons(true);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
  if (current) state.state = 'pause';
  disc.spinning = false; playSound('stop');
  document.body.classList.remove('playing'); $('led').classList.remove('on');
  setPlayIcons(false);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
audio.addEventListener('ended', () => {
  if (state.repeat) { audio.currentTime = 0; audio.play(); } else step(1);
});
audio.addEventListener('loadedmetadata', () => {
  if (isFinite(audio.duration)) state.duration = audio.duration * 1000;
  updatePositionState();
});
audio.addEventListener('error', async () => {
  if (!current) return;
  if (current.source === 'plex' && !current.local && !retried) {
    retried = true;
    const t = current, at = audio.currentTime;
    try {
      await plexApi.reconnect();
      if (current !== t) return;
      audio.src = plexApi.streamUrl(t);
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
      audio.play().catch(() => {});
      return;
    } catch (e) { toast(e.message, 8); }
  }
  state.state = 'error';
  toast(current.source === 'plex' && !current.local ? 'Couldn’t stream this song from Plex. Is your computer on?' : 'Couldn’t play this song. iPhone may not support its format.', 6);
});

function setPlayIcons(playing) {
  for (const id of ['playIcon', 'miniPlayIcon']) $(id).setAttribute('href', playing ? '#i-pause' : '#i-play');
}

// ---------------------------------------------------------------- lock screen & Control Center

async function updateMediaSession(track, cover) {
  if (!('mediaSession' in navigator)) return;
  const artwork = [];
  if (cover) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      const g = c.getContext('2d');
      const s = Math.min(cover.width, cover.height);
      g.drawImage(cover, (cover.width - s) / 2, (cover.height - s) / 2, s, s, 0, 0, 512, 512);
      artwork.push({ src: c.toDataURL('image/jpeg', .88), sizes: '512x512', type: 'image/jpeg' });
    } catch (e) { /* no art */ }
  }
  navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !isFinite(audio.duration)) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: 1, position: Math.min(audio.currentTime, audio.duration) }); } catch (e) { /* ignore */ }
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => audio.play(), pause: () => audio.pause(),
    previoustrack: () => step(-1), nexttrack: () => step(1),
    seekto: d => { audio.currentTime = d.seekTime; updatePositionState(); },
  };
  for (const [k, f] of Object.entries(handlers)) { try { ms.setActionHandler(k, f); } catch (e) { /* unsupported */ } }
}

// ---------------------------------------------------------------- seek bar

const bar = $('bar');
let dragging = false;
function barFrac(e) { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); }
bar.addEventListener('pointerdown', e => { if (!current) return; dragging = true; bar.setPointerCapture(e.pointerId); showBar(barFrac(e)); });
bar.addEventListener('pointermove', e => { if (dragging) showBar(barFrac(e)); });
bar.addEventListener('pointerup', e => {
  if (!dragging) return; dragging = false;
  if (isFinite(audio.duration)) { audio.currentTime = barFrac(e) * audio.duration; updatePositionState(); }
});
function showBar(frac) {
  const w = bar.clientWidth;
  bar.querySelector('.fill').style.width = `${frac * w}px`;
  bar.querySelector('.shimmer').style.width = `${frac * w}px`;
  bar.querySelector('.knob').style.left = `${frac * w}px`;
  bar.style.setProperty('--bar-w', `${w}px`);
  const d = state.duration;
  $('elapsed').textContent = fmtTime(frac * d);
  $('total').textContent = fmtTime(d);
}

// ---------------------------------------------------------------- lists

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const EQ = '<span class="eq"><i></i><i></i><i></i><i></i></span>';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// numbering: 'track' (the album's own numbers) or 'position' (a CD-R's running order).
function trackRows(list, tracks, numbering = 'track') {
  const multi = numbering === 'track' && new Set(tracks.map(discOf)).size > 1;
  let lastDisc = null;
  list.innerHTML = tracks.map((t, i) => {
    let head = '';
    if (multi && discOf(t) !== lastDisc) {
      lastDisc = discOf(t);
      const these = tracks.filter(x => discOf(x) === lastDisc);
      const min = Math.round(these.reduce((m, x) => m + (x.duration || 0), 0) / 60);
      head = `<li class="disc-head"><b>DISC ${lastDisc}</b><span>${plural(these.length, 'song')}${min ? ` · ${min} min` : ''}</span></li>`;
    }
    const on = current && current.id === t.id;
    const num = numbering === 'position' ? i + 1 : (t.track || i + 1);
    const sub = numbering === 'position' ? `${t.artist} · ${t.album}` : t.artist;
    return head + `<li data-id="${t.id}" data-num="${num}" class="${on ? 'current' : ''}">
      <span class="n">${on ? EQ : String(num).padStart(2, '0')}</span>
      <span class="tt"><b>${esc(t.title)}</b><span>${esc(sub)}</span></span>
      <span class="d">${t.duration ? fmtTime(t.duration * 1000) : ''}</span>
      <button class="more" aria-label="More for this song">•••</button>
    </li>`;
  }).join('');
}

function cdrMeta(cdr) {
  const n = cdrTracks(cdr).length, m = Math.round(cdrMinutes(cdr));
  return `CD-R · ${plural(n, 'song')} · ${m} of ${CDR_MINUTES} min` + (m > CDR_MINUTES ? ' · too long for a real disc!' : '');
}

function renderNow() {
  $('emptyHint').hidden = order.length > 0 || lib.cdrs.length > 0;
  const header = $('nowHeader');
  const cdr = playingCdr && findCdr(playingCdr);
  const album = !cdr && current ? lib.albums.get(current.albumKey) : null;
  if (cdr) {
    header.innerHTML = `<canvas width="172" height="178"></canvas><div><div class="silk">NOW PLAYING · CD-R</div><div class="t">${esc(cdr.title)}</div><div class="dim">${esc(cdrMeta(cdr))}</div></div>`;
    drawCdrCase(header.querySelector('canvas'), cdr);
    header.onclick = () => openCdr(cdr.id);
    $('nowList').dataset.cdr = cdr.id;
    trackRows($('nowList'), cdrTracks(cdr), 'position');
  } else if (album) {
    header.innerHTML = `<canvas width="172" height="178"></canvas><div><div class="silk">NOW PLAYING</div><div class="t">${esc(album.album)}</div><div class="dim">${esc(album.artist)}${album.year ? ' · ' + esc(album.year) : ''}</div></div>`;
    drawCase(header.querySelector('canvas'), album);
    header.onclick = () => openAlbum(album.key);
    $('nowList').dataset.cdr = '';
    trackRows($('nowList'), albumTracks(album));
  } else if (order.length) {
    header.innerHTML = `<div><div class="silk">YOUR DISCS</div><div class="dim">${plural(lib.albums.size, 'album')} · ${plural(order.length, 'song')}${lib.cdrs.length ? ' · ' + plural(lib.cdrs.length, 'CD-R') : ''}. Pick one from the LIBRARY, or press PLAY.</div></div>`;
    header.onclick = null;
    $('nowList').innerHTML = '';
  } else { header.innerHTML = ''; $('nowList').innerHTML = ''; }
}

const playingKey = () => (current ? (playingCdr ? 'cdr:' + playingCdr : current.albumKey) : null);

function markPlaying() {
  for (const list of [$('nowList'), $('albumList')]) {
    for (const li of list.children) {
      if (!li.dataset.id) continue;   // disc headings
      const on = !!current && li.dataset.id === current.id;
      if (on !== li.classList.contains('current')) {
        li.classList.toggle('current', on);
        li.querySelector('.n').innerHTML = on ? EQ : String(li.dataset.num).padStart(2, '0');
      }
    }
  }
  const key = playingKey();
  document.querySelectorAll('.card, .spine').forEach(el => {
    const on = el.dataset.key === key;
    if (el.classList.contains('playing') !== on) { el.classList.toggle('playing', on); if (el.redraw) el.redraw(); }
  });
}

for (const list of [$('nowList'), $('albumList')]) {
  list.addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li || !li.dataset.id) return;
    const cdrId = list.dataset.cdr || null;
    unlockSounds(); playSound('press');
    if (e.target.closest('.more')) { trackMenu(li.dataset.id, cdrId); return; }
    playTrack(li.dataset.id, { cdr: cdrId });
  });
}

// ---------------------------------------------------------------- cases, shelf, album page

async function albumArt(album) {
  const cover = art(album, 'cover');
  const img = cover ? await imageFor(cover) : null;
  return { img, palette: img ? albumPalette(img, 3, cover) : [] };
}

async function obiOf(album) {
  const o = album.custom && album.custom.obi;
  if (!o) return {};
  return o.image ? { ...o, imageObj: await imageFor(o.image) } : o;
}

function sizeCase(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 172;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * 178 / 172 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / 172, 0, 0, canvas.width / 172, 0, 0);
  ctx.clearRect(0, 0, 172, 178);
  return ctx;
}

async function drawCase(canvas, album) {
  const [{ img, palette }, obi] = await Promise.all([albumArt(album), obiOf(album)]);
  const ctx = sizeCase(canvas);
  paintCaseFront(ctx, { album: album.album, artist: album.artist, year: album.year, obi, discs: discCount(album) }, img, palette, THEME.name === 'Night', settings.obi);
}

const cdrLook = cdr => ({ ...cdr, fraction: cdrMinutes(cdr) / CDR_MINUTES });
function drawCdrCase(canvas, cdr) { paintSlimCase(sizeCase(canvas), cdrLook(cdr)); }

async function drawSpine(canvas, album, playing) {
  const [{ palette }, obi] = await Promise.all([albumArt(album), obiOf(album)]);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 30 * dpr; canvas.height = 172 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 30, 172);
  paintSpine(ctx, 1, 12, 27, 158, { album: album.album, artist: album.artist, obi, discs: discCount(album) }, palette, playing);
}

function drawCdrSpine(canvas, cdr, playing) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 30 * dpr; canvas.height = 172 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 30, 172);
  paintCdrSpine(ctx, 1, 12, 27, 158, cdr, playing);
}

const lazy = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { lazy.unobserve(e.target); e.target.redraw(); }
}, { rootMargin: '300px' });

function renderShelf() {
  const shelf = $('shelf');
  const q = $('search').value.trim().toLowerCase();
  const items = [
    ...lib.cdrs.filter(c => !q || `${c.title}\ncd-r`.toLowerCase().includes(q)).map(c => ({ cdr: c, key: 'cdr:' + c.id })),
    ...sortedAlbums().filter(a => !q || `${a.album}\n${a.artist}`.toLowerCase().includes(q)).map(a => ({ album: a, key: a.key })),
  ];
  const spines = settings.shelf === 'spines';
  shelf.className = 'shelf' + (spines ? ' spines' : '');
  $('viewToggle').classList.toggle('lit', spines);
  shelf.innerHTML = '';
  if (!items.length) {
    shelf.innerHTML = `<p class="dim">${lib.albums.size || lib.cdrs.length ? 'Nothing matches.' : 'Your shelf is empty. Tap ⏏ to add music, or connect Plex in Settings.'}</p>`;
    return;
  }
  const key = playingKey();
  let row = null;
  items.forEach(({ album, cdr, key: k }, i) => {
    const el = document.createElement('div');
    el.dataset.key = k;
    el.classList.toggle('playing', k === key);
    const title = cdr ? cdr.title : album.album, sub = cdr ? `CD-R · ${plural(cdr.tracks.length, 'song')}` : album.artist;
    if (spines) {
      el.className += ' spine';
      el.innerHTML = '<canvas></canvas>';
      el.title = `${title} — ${sub}`;
      el.redraw = cdr ? () => drawCdrSpine(el.firstChild, cdr, el.classList.contains('playing'))
                      : () => drawSpine(el.firstChild, album, el.classList.contains('playing'));
      const perRow = Math.max(1, Math.floor((shelf.clientWidth || 320) / 31));
      if (i % perRow === 0) { row = document.createElement('div'); row.className = 'rack-row'; shelf.appendChild(row); }
      row.appendChild(el);
    } else {
      el.className += ' card';
      el.innerHTML = `<canvas></canvas><b>${esc(title)}</b><span>${esc(sub)}</span>`;
      el.redraw = cdr ? () => drawCdrCase(el.firstChild, cdr) : () => drawCase(el.firstChild, album);
      shelf.appendChild(el);
    }
    el.addEventListener('click', () => { playSound('press'); if (cdr) openCdr(cdr.id); else openAlbum(album.key); });
    lazy.observe(el);
  });
}

function repaintCases() {
  document.querySelectorAll('.card, .spine').forEach(el => el.redraw && el.redraw());
  if (shownAlbum) renderAlbumCase(lib.albums.get(shownAlbum));
  if (shownCdr && findCdr(shownCdr)) renderCdrCase(findCdr(shownCdr));
  const nowCanvas = document.querySelector('#nowHeader canvas');
  if (nowCanvas && current) {
    if (playingCdr && findCdr(playingCdr)) drawCdrCase(nowCanvas, findCdr(playingCdr));
    else if (lib.albums.get(current.albumKey)) drawCase(nowCanvas, lib.albums.get(current.albumKey));
  }
  lastMini = '';
}

let shownAlbum = null, shownCdr = null;

function backCtx() {
  const back = $('caseBack');
  return sizeCase(back);
}

async function renderAlbumCase(album) {
  await drawCase($('caseFront'), album);
  const backId = art(album, 'back');
  const backImg = backId ? await imageFor(backId) : null;
  const ctx = backCtx();
  if (backImg) paintCaseBackImage(ctx, backImg, THEME.name === 'Night');
  else {
    const { palette } = await albumArt(album);
    const all = albumTracks(album), discs = discCount(album);
    const tracks = [];
    let lastDisc = null;
    all.forEach((t, i) => {
      if (discs > 1 && discOf(t) !== lastDisc) { lastDisc = discOf(t); tracks.push(['disc', `DISC ${lastDisc}`, 0]); }
      tracks.push([t.track || i + 1, t.title, t.duration]);
    });
    paintCaseBack(ctx, { ...album, discs }, tracks, palette, THEME.name === 'Night');
  }
}

function renderCdrCase(cdr) {
  drawCdrCase($('caseFront'), cdr);
  paintCdrBack(backCtx(), cdr, cdrTracks(cdr).map(t => t.title));
}

function setPageButtons(isCdr) {
  $('openBooklet').hidden = isCdr;
  $('cdrAdd').hidden = !isCdr;
}

function openAlbum(key) {
  const album = lib.albums.get(key);
  if (!album) return;
  shownAlbum = key; shownCdr = null;
  const tracks = albumTracks(album);
  $('albumTitle').textContent = album.album;
  const minutes = Math.round(tracks.reduce((s, t) => s + (t.duration || 0), 0) / 60);
  const discs = discCount(album);
  $('albumMeta').textContent = [album.artist, album.year, discs > 1 ? plural(discs, 'disc') : '', plural(tracks.length, 'song'), minutes ? `${minutes} min` : '',
    album.source === 'plex' ? (tracks.every(t => t.local) ? 'on this phone' : 'streams from Plex') : ''].filter(Boolean).join(' · ');
  setPageButtons(false);
  $('caseFlip').classList.remove('flipped');
  $('albumList').dataset.cdr = '';
  trackRows($('albumList'), tracks);
  showPage('album');
  requestAnimationFrame(() => renderAlbumCase(album));
}

function openCdr(id, { keepFlip = false } = {}) {
  const cdr = findCdr(id);
  if (!cdr) { showPage('library'); return; }
  shownCdr = id; shownAlbum = null;
  $('albumTitle').textContent = cdr.title;
  $('albumMeta').textContent = cdrMeta(cdr) + (cdr.tracks.length ? '' : ' · nothing burned yet: tap + ADD SONGS, or use ••• next to any song');
  setPageButtons(true);
  if (!keepFlip) $('caseFlip').classList.remove('flipped');
  $('albumList').dataset.cdr = id;
  trackRows($('albumList'), cdrTracks(cdr), 'position');
  showPage('album');
  requestAnimationFrame(() => renderCdrCase(cdr));
}

function showPage(name) {
  for (const p of ['now', 'library', 'album']) $('page-' + p).hidden = p !== name;
  document.querySelectorAll('.tab[data-page]').forEach(t => t.classList.toggle('lit', t.dataset.page === name || (name === 'album' && t.dataset.page === 'library')));
  document.querySelectorAll('.tab[data-page] .lamp').forEach(l => l.classList.toggle('lit', l.parentElement.classList.contains('lit')));
  if (name === 'library') renderShelf();
  if (name !== 'album') { shownAlbum = null; shownCdr = null; }
}

// Something about a CD-R changed: redraw wherever it shows.
function cdrChanged(cdr) {
  if (shownCdr === cdr.id) openCdr(cdr.id, { keepFlip: true });
  if (playingCdr === cdr.id) { renderNow(); refreshDisc(false); }
  if (!$('page-library').hidden) renderShelf();
}

// ---------------------------------------------------------------- booklet

let pages = [], page = 0;
async function openBooklet() {
  const album = lib.albums.get(shownAlbum);
  if (!album) return;
  pages = [];
  if (art(album, 'cover')) pages.push(['Front cover', art(album, 'cover')]);
  bookletPages(album).forEach((id, i) => pages.push([`Page ${i + 1}`, id]));
  if (art(album, 'back')) pages.push(['Back cover', art(album, 'back')]);
  if (!pages.length) { toast('No pictures for this album yet.'); return; }
  $('bookletTitle').textContent = `${album.album} · ${album.artist}`;
  $('bookletHint').textContent = bookletPages(album).length ? '' : 'No booklet pages yet: add some with ••• → Change pictures.';
  page = 0;
  $('booklet').hidden = false;
  showBookletPage(0);
}
async function showBookletPage(dir) {
  const target = page + dir;
  if (target < 0 || target >= pages.length) return;
  const img = $('bookletPage');
  if (dir) { playSound('press'); img.classList.add('fold'); await new Promise(r => setTimeout(r, 190)); }
  page = target;
  const blob = await imageBlob(pages[page][1]);
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.dataset.url = blob ? URL.createObjectURL(blob) : '';
  img.src = img.dataset.url;
  $('bookletLabel').textContent = `${pages[page][0]} · ${page + 1} / ${pages.length}`;
  requestAnimationFrame(() => img.classList.remove('fold'));
}
$('bookletPrev').onclick = () => showBookletPage(-1);
$('bookletNext').onclick = () => showBookletPage(1);
$('closeBooklet').onclick = () => { $('booklet').hidden = true; };
let touchX = null;
$('bookletStage').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
$('bookletStage').addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) > 40) showBookletPage(dx < 0 ? 1 : -1);
});
$('bookletStage').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  showBookletPage(e.clientX < r.left + r.width / 2 ? -1 : 1);
});

// ---------------------------------------------------------------- importing

const picker = $('filePicker');
function openPicker() {
  unlockSounds();
  disc.openLid();
  picker.value = '';
  picker.click();
  // If the picker is dismissed without choosing anything, close the lid again.
  const close = () => setTimeout(() => { if (!importing) disc.closeLid(); }, 600);
  window.addEventListener('focus', close, { once: true });
  picker.addEventListener('cancel', close, { once: true });
}
let importing = false;
picker.addEventListener('change', async () => {
  const files = [...picker.files];
  if (!files.length) { disc.closeLid(); return; }
  importing = true;
  $('importer').hidden = false;
  try {
    await askPersist();
    const result = await importFiles(files, p => {
      $('importStage').textContent = p.stage + (p.total ? ` (${Math.min(p.done + 1, p.total)} of ${p.total})` : '');
      $('importName').textContent = p.name || '';
      $('importBar').style.width = p.total ? `${(p.done / p.total) * 100}%` : '8%';
    });
    rebuildOrder();
    renderNow();
    if (!$('page-library').hidden) renderShelf();
    toast(`Added ${result.songs} song${result.songs === 1 ? '' : 's'} in ${result.albums.length} album${result.albums.length === 1 ? '' : 's'}.` +
          (result.failures.length ? ` ${result.failures.length} couldn’t be added: ${result.failures[0]}` : ''), result.failures.length ? 10 : 3.5);
    if (!current && result.albums.length) {
      const first = albumTracks(result.albums[0])[0];
      if (first) playTrack(first.id, { autoplay: false });
    }
  } catch (e) {
    console.error(e);
    toast((e && e.name && e.name !== 'Error' ? e.name + ': ' : '') + ((e && e.message) || 'Couldn’t add those files.'), 12);
  } finally {
    importing = false;
    $('importer').hidden = true;
    disc.closeLid();
  }
});

// ---------------------------------------------------------------- progress overlay (imports, Plex)

async function busy(task, doneText) {
  $('importer').hidden = false;
  $('importBar').style.width = '8%'; $('importName').textContent = '';
  try {
    const result = await task(p => {
      $('importStage').textContent = p.stage + (p.total ? ` (${Math.min(Math.floor(p.done) + 1, p.total)} of ${p.total})` : '');
      $('importName').textContent = p.name || '';
      $('importBar').style.width = p.total ? `${(p.done / p.total) * 100}%` : '8%';
    });
    if (doneText) toast(typeof doneText === 'function' ? doneText(result) : doneText, 5);
    return result;
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 10);
    return null;
  } finally { $('importer').hidden = true; }
}

// ---------------------------------------------------------------- Plex

let linking = null;
function plexUi() {
  $('plexStatus').textContent = plex.connected
    ? `Connected to “${plex.serverName}”. ${[...lib.albums.values()].filter(a => a.source === 'plex').length} albums stream from it.`
    : 'Stream your Plex music library instead of storing it on your phone.';
  $('plexConnect').hidden = plex.connected || !!linking;
  $('plexSync').hidden = $('plexDisconnect').hidden = !plex.connected;
  $('plexLink').hidden = !linking;
}

async function syncPlex(quiet) {
  const run = async p => { const r = await applyPlexLibrary(await plexApi.fetchLibrary(p)); rebuildOrder(); renderNow(); if (!$('page-library').hidden) renderShelf(); return r; };
  if (quiet) {
    try { await run(() => {}); } catch (e) { console.warn('Plex sync later:', e.message); }
  } else {
    await busy(run, r => `Plex is synced. ${[...lib.albums.values()].filter(a => a.source === 'plex').length} albums ready to stream.`);
  }
  plexUi();
  if (!$('settings').hidden) openSettings();
}

$('plexConnect').onclick = async () => {
  playSound('press');
  const btn = $('plexConnect');
  btn.disabled = true; btn.textContent = 'CONNECTING…';
  try {
    linking = await plexApi.startLink();
    $('plexCode').textContent = linking.code;
    plexUi();
    const ok = await linking.wait();
    linking = null;
    plexUi();
    if (ok) { toast(`Connected to ${plex.serverName}!`); await syncPlex(false); }
  } catch (e) {
    linking = null; plexUi();
    toast('Couldn’t reach plex.tv: ' + (e.name === 'AbortError' ? 'it took too long.' : e.message || e) + ' Check your internet connection and try again.', 10);
  } finally { btn.disabled = false; btn.textContent = 'CONNECT TO PLEX'; }
};
$('plexSync').onclick = () => { playSound('press'); syncPlex(false); };
$('plexDisconnect').onclick = async () => {
  if (!confirm('Disconnect from Plex? Its albums leave your shelf (albums you kept on the phone too). Your Plex server isn’t changed.')) return;
  if (current && current.source === 'plex') { audio.pause(); audio.removeAttribute('src'); current = null; idleText(); }
  plexApi.disconnect();
  await forgetPlex();
  rebuildOrder(); renderNow(); plexUi();
};

// ---------------------------------------------------------------- settings sheet

async function openSettings() {
  $('setTheme').value = settings.theme; $('setDisc').value = settings.disc; $('setObi').checked = settings.obi;
  $('setSky').checked = settings.sky; $('setMeter').checked = settings.meter; $('setLyrics').checked = settings.lyrics;
  $('setSounds').checked = settings.sounds; $('setFx').value = settings.fx;
  $('version').textContent = `Kurukuru CD for iPhone · version ${VERSION}`;
  const info = await storageInfo();
  const mb = n => (n / 1048576).toFixed(n > 1048576 * 100 ? 0 : 1);
  const local = [...lib.albums.values()].filter(a => a.source !== 'plex').length;
  const kept = [...lib.tracks.values()].filter(t => t.source !== 'plex' || t.local).length;
  $('storageText').textContent = `${local} albums imported, ${kept} songs on this phone · using ${mb(info.usage)} MB` +
    (info.quota ? ` of about ${(info.quota / 1073741824).toFixed(1)} GB available` : '') +
    (info.persisted ? ' · kept safe ✓' : ' · iPhone may clear it if storage runs very low');
  $('persistButton').hidden = info.persisted;
  plexUi();
  $('settings').hidden = false;
}
function settingChanged() {
  Object.assign(settings, { theme: $('setTheme').value, disc: $('setDisc').value, obi: $('setObi').checked, sky: $('setSky').checked,
    meter: $('setMeter').checked, lyrics: $('setLyrics').checked, sounds: $('setSounds').checked, fx: +$('setFx').value });
  saveSettings();
  state.showMeter = settings.meter; state.showLyrics = settings.lyrics;
  sounds.enabled = settings.sounds; sounds.volume = settings.fx / 100;
  const album = current ? lib.albums.get(current.albumKey) : null;
  if (!(album && album.disc)) disc.setMode(settings.disc);
  applyTheme();
}
for (const id of ['setTheme', 'setDisc', 'setObi', 'setSky', 'setMeter', 'setLyrics', 'setSounds', 'setFx']) $(id).addEventListener('change', settingChanged);
$('setFx').addEventListener('change', () => playSound('press'));
$('persistButton').onclick = async () => { const ok = await askPersist(); toast(ok ? 'Your music is marked to be kept.' : 'iPhone didn’t allow it yet. It usually does once the app is on your Home Screen.'); openSettings(); };
$('openSettings').onclick = () => { playSound('press'); openSettings(); };
$('closeSettings').onclick = () => { $('settings').hidden = true; };

// ---------------------------------------------------------------- buttons

function hw(id, fn) {
  const el = $(id);
  el.addEventListener('pointerdown', () => { unlockSounds(); playSound('press'); });
  el.addEventListener('click', fn);
}
hw('play', togglePlay);
hw('miniPlay', togglePlay);
hw('prev', () => step(-1));
hw('next', () => step(1));
hw('miniNext', () => step(1));
hw('shuffle', () => { state.shuffle = !state.shuffle; $('shuffle').classList.toggle('lit', state.shuffle); $('shuffle').querySelector('.lamp').classList.toggle('lit', state.shuffle); });
hw('repeat', () => { state.repeat = !state.repeat; $('repeat').classList.toggle('lit', state.repeat); $('repeat').querySelector('.lamp').classList.toggle('lit', state.repeat); });
$('disc').addEventListener('click', openPicker);
$('addMusic').addEventListener('click', () => { playSound('press'); openPicker(); });
document.querySelectorAll('.tab[data-page]').forEach(t => t.addEventListener('click', () => { unlockSounds(); playSound('press'); showPage(t.dataset.page); }));
$('search').addEventListener('input', renderShelf);
$('viewToggle').onclick = () => { playSound('press'); settings.shelf = settings.shelf === 'spines' ? 'cases' : 'spines'; saveSettings(); renderShelf(); };
$('backToShelf').onclick = () => { playSound('press'); showPage('library'); };
$('caseFlip').onclick = () => { playSound('press'); $('caseFlip').classList.toggle('flipped'); };
$('flipCase').onclick = () => $('caseFlip').classList.toggle('flipped');
$('playAlbum').onclick = () => {
  unlockSounds();
  if (shownCdr) { const c = findCdr(shownCdr); const t = c && cdrTracks(c)[0]; if (t) playTrack(t.id, { cdr: c.id }); else toast('Nothing is burned on this CD-R yet.'); return; }
  const a = lib.albums.get(shownAlbum); const t = a && albumTracks(a)[0]; if (t) playTrack(t.id);
};
$('openBooklet').onclick = openBooklet;
$('cdrAdd').onclick = () => { playSound('press'); const c = findCdr(shownCdr); if (c) openSongPicker(c); };
$('newCdr').onclick = () => { playSound('press'); openCdrEditor(null, null); };
$('albumMore').onclick = () => { playSound('press'); if (shownCdr) cdrMenu(findCdr(shownCdr)); else if (shownAlbum) albumMenu(lib.albums.get(shownAlbum)); };

// ---------------------------------------------------------------- menus

function menu(title, items) {
  $('menuTitle').textContent = title || '';
  const box = $('menuItems');
  box.innerHTML = '';
  const close = () => { $('menu').hidden = true; };
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (it.danger ? ' danger' : '');
    b.innerHTML = esc(it.label) + (it.note ? `<small>${esc(it.note)}</small>` : '');
    b.onclick = () => { playSound('press'); close(); it.run(); };   // run() stays inside the tap (file pickers need that)
    box.appendChild(b);
  }
  $('menuCancel').onclick = close;
  $('menu').onclick = e => { if (e.target === $('menu')) close(); };
  $('menu').hidden = false;
}

function albumMenu(album) {
  if (!album) return;
  const ids = albumTracks(album).map(t => t.id);
  const items = [
    { label: 'Burn this album to a CD-R…', run: () => chooseCdr(ids) },
    { label: 'Change pictures…', note: 'front, back, disc print, booklet pages', run: () => openArtSheet(album.key) },
    { label: 'Edit the obi strip…', run: () => openObiEditor(album.key) },
  ];
  if (album.source === 'plex') {
    const kept = albumTracks(album).every(t => t.local);
    items.push(kept ? { label: 'Remove from this phone', note: 'it still streams from Plex', run: () => unkeep(album) }
                    : { label: 'Keep on this phone', note: 'plays without a connection', run: () => keep(album) });
  } else {
    items.push({ label: 'Remove album', danger: true, note: 'from Kurukuru only', run: () => removeAlbum(album) });
  }
  menu(album.album, items);
}

function cdrMenu(cdr) {
  if (!cdr) return;
  menu(cdr.title, [
    { label: 'Add songs…', run: () => openSongPicker(cdr) },
    { label: 'Edit the disc…', note: 'title, date, dye and marker colour', run: () => openCdrEditor(cdr, null) },
    { label: 'Throw away this CD-R', danger: true, note: 'the songs stay in your library', run: () => throwAway(cdr) },
  ]);
}

function trackMenu(id, cdrId) {
  const t = lib.tracks.get(id);
  if (!t) return;
  const items = [];
  const cdr = cdrId && findCdr(cdrId);
  if (cdr) {
    const i = cdr.tracks.indexOf(id);
    if (i > 0) items.push({ label: 'Move up', run: () => moveInCdr(cdr, i, -1) });
    if (i < cdr.tracks.length - 1) items.push({ label: 'Move down', run: () => moveInCdr(cdr, i, 1) });
    items.push({ label: 'Take off this CD-R', danger: true, run: async () => { await updateCdr(cdr, { tracks: cdr.tracks.filter(x => x !== id) }); cdrChanged(cdr); } });
  } else {
    items.push({ label: 'Burn to a CD-R…', run: () => chooseCdr([id]) });
  }
  items.push({ label: t.lyrics ? 'Replace the lyrics…' : 'Add lyrics…', note: 'an .lrc (timed) or .txt file', run: () => pickLyrics(id) });
  if (t.customLyrics) items.push({ label: 'Remove the lyrics you added', danger: true, run: () => lyricsChanged(id, null) });
  menu(`${t.title} · ${t.artist}`, items);
}

async function keep(album) {
  await busy(p => keepAlbum(album.key, p), `“${album.album}” is saved on your phone and plays without a connection.`);
  if (shownAlbum === album.key) openAlbum(album.key);
}
async function unkeep(album) {
  await unkeepAlbum(album.key);
  toast('Removed from your phone. It still streams from Plex.');
  if (shownAlbum === album.key) openAlbum(album.key);
}
async function removeAlbum(album) {
  if (!confirm(`Remove “${album.album}” and its songs from Kurukuru? (The files in your Files app aren’t touched.)`)) return;
  if (current && current.albumKey === album.key) stopAndEject();
  const gone = new Set(album.trackIds);
  await deleteAlbum(album.key);
  for (const c of lib.cdrs) if (c.tracks.some(id => gone.has(id))) await updateCdr(c, { tracks: c.tracks.filter(id => !gone.has(id)) });
  rebuildOrder(); renderNow(); showPage('library');
  toast('Album removed.');
}
function stopAndEject() {
  audio.pause(); audio.removeAttribute('src'); current = null; playingCdr = null; idleText();
  disc.setDisc({ image: null, album: '', artist: '' }, true);
}

// ---------------------------------------------------------------- burning CD-Rs

function chooseCdr(ids) {
  const what = ids.length === 1 ? `“${lib.tracks.get(ids[0]).title}”` : plural(ids.length, 'song');
  menu(`Burn ${what} to…`, [
    ...lib.cdrs.map(c => ({ label: c.title, note: cdrMeta(c), run: () => burn(c, ids) })),
    { label: '+ A new blank CD-R', run: () => openCdrEditor(null, ids) },
  ]);
}

async function burn(cdr, ids) {
  const n = await burnTo(cdr, ids);
  playSound('lid');
  const over = cdrMinutes(cdr) > CDR_MINUTES ? ' It’s now longer than a real 80-minute disc.' : '';
  toast(n ? `Burned ${plural(n, 'song')} to “${cdr.title}”.${ids.length > n ? ` (${ids.length - n} already on it.)` : ''}${over}`
          : `${ids.length === 1 ? 'That song is' : 'Those songs are'} already on “${cdr.title}”.`, over ? 6 : 3.5);
  cdrChanged(cdr);
}

async function moveInCdr(cdr, i, dir) {
  const tracks = [...cdr.tracks];
  [tracks[i], tracks[i + dir]] = [tracks[i + dir], tracks[i]];
  await updateCdr(cdr, { tracks });
  cdrChanged(cdr);
}

async function throwAway(cdr) {
  if (!confirm(`Throw away the CD-R “${cdr.title}”? The songs stay in your library.`)) return;
  if (playingCdr === cdr.id) stopAndEject();
  await deleteCdr(cdr);
  renderNow(); showPage('library');
  toast('CD-R thrown away.');
}

let cdrDraft = null, cdrEditing = null, cdrBurnAfter = null;
function todayStamp() { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; }

function openCdrEditor(cdr, ids) {
  cdrEditing = cdr; cdrBurnAfter = ids;
  const dyes = Object.keys(CDR_DYES);
  cdrDraft = cdr ? { id: cdr.id, title: cdr.title, date: cdr.date || '', dye: cdr.dye, marker: cdr.marker, tracks: cdr.tracks }
                 : { id: 'cdr-new-' + Date.now(), title: `Mix #${lib.cdrs.length + 1}`, date: todayStamp(),
                     dye: dyes[lib.cdrs.length % dyes.length], marker: 'black', tracks: ids || [] };
  $('cdrEditorTitle').textContent = cdr ? 'EDIT CD-R' : 'NEW CD-R';
  $('cdrTitle').value = cdrDraft.title; $('cdrDate').value = cdrDraft.date;
  $('cdrDyes').innerHTML = dyes.map(k => `<span class="swatch-col"><button class="swatch" data-dye="${k}" style="background:radial-gradient(${CDR_DYES[k][1]},${CDR_DYES[k][2]})" aria-label="${CDR_DYES[k][0]}"></button>${CDR_DYES[k][0]}</span>`).join('');
  $('cdrMarkers').innerHTML = Object.keys(MARKERS).map(k => `<span class="swatch-col"><button class="swatch" data-marker="${k}" style="background:${MARKERS[k][1]}" aria-label="${MARKERS[k][0]}"></button>${MARKERS[k][0]}</span>`).join('');
  syncCdrEditor();
  $('cdrEditor').hidden = false;
}

function syncCdrEditor() {
  document.querySelectorAll('#cdrDyes .swatch').forEach(b => b.classList.toggle('on', b.dataset.dye === cdrDraft.dye));
  document.querySelectorAll('#cdrMarkers .swatch').forEach(b => b.classList.toggle('on', b.dataset.marker === cdrDraft.marker));
  const c = $('cdrPreview');
  const dpr = window.devicePixelRatio || 1, R = 112;
  c.width = c.height = Math.round(230 * dpr);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const minutes = cdrDraft.tracks.map(id => lib.tracks.get(id)).filter(Boolean).reduce((m, t) => m + (t.duration || 0), 0) / 60;
  const face = renderDiscFace(R, dpr, null, 'design', cdrDraft.title, '', THEME.name === 'Night', 'preview' + Math.random(),
                              { ...cdrDraft, fraction: minutes / CDR_MINUTES || .25 });
  g.drawImage(face, (c.width - face.width) / 2, (c.height - face.height) / 2);
}

$('cdrDyes').addEventListener('click', e => { const b = e.target.closest('[data-dye]'); if (b) { playSound('press'); cdrDraft.dye = b.dataset.dye; syncCdrEditor(); } });
$('cdrMarkers').addEventListener('click', e => { const b = e.target.closest('[data-marker]'); if (b) { playSound('press'); cdrDraft.marker = b.dataset.marker; syncCdrEditor(); } });
$('cdrTitle').addEventListener('input', () => { cdrDraft.title = $('cdrTitle').value; syncCdrEditor(); });
$('cdrDate').addEventListener('input', () => { cdrDraft.date = $('cdrDate').value; syncCdrEditor(); });
$('cdrCancel').onclick = () => { $('cdrEditor').hidden = true; };
$('cdrSave').onclick = async () => {
  playSound('press');
  const fields = { title: cdrDraft.title.trim() || 'Mix', date: cdrDraft.date.trim(), dye: cdrDraft.dye, marker: cdrDraft.marker };
  $('cdrEditor').hidden = true;
  if (cdrEditing) { await updateCdr(cdrEditing, fields); cdrChanged(cdrEditing); return; }
  const cdr = await newCdr(fields);
  renderNow();
  if (cdrBurnAfter && cdrBurnAfter.length) { await burn(cdr, cdrBurnAfter); return; }
  openCdr(cdr.id);
  openSongPicker(cdr);
};

// ---------------------------------------------------------------- picking songs for a CD-R

let pickFor = null, picked = new Set();
function openSongPicker(cdr) {
  pickFor = cdr; picked = new Set();
  $('pickSearch').value = '';
  $('pickTitle').textContent = `ADD TO “${cdr.title.toUpperCase()}”`;
  renderPicker();
  $('songPicker').hidden = false;
}
function renderPicker() {
  const q = $('pickSearch').value.trim().toLowerCase();
  const all = order.map(id => lib.tracks.get(id)).filter(Boolean);
  const matches = q ? all.filter(t => `${t.title}\n${t.artist}\n${t.album}`.toLowerCase().includes(q)) : all;
  const shown = matches.slice(0, 300);
  const onDisc = new Set(pickFor.tracks);
  $('pickList').innerHTML = shown.map(t => `<li data-id="${t.id}" class="${picked.has(t.id) ? 'on' : ''} ${onDisc.has(t.id) ? 'burned' : ''}">
      <span class="tick"></span><span class="tt"><b>${esc(t.title)}</b><span>${esc(t.artist)} · ${esc(t.album)}</span></span>
      <span class="d">${onDisc.has(t.id) ? 'on it' : t.duration ? fmtTime(t.duration * 1000) : ''}</span></li>`).join('');
  pickInfo(matches.length > shown.length ? ` Showing ${shown.length} of ${matches.length}: search to narrow it down.` : '');
}
function pickInfo(extra = '') {
  const add = [...picked].map(id => lib.tracks.get(id));
  const minutes = add.reduce((m, t) => m + (t.duration || 0), 0) / 60;
  const total = Math.round(cdrMinutes(pickFor) + minutes);
  $('pickInfo').textContent = (picked.size ? `${plural(picked.size, 'song')} picked · the disc would be ${total} of ${CDR_MINUTES} min${total > CDR_MINUTES ? ' (too long for a real CD-R!)' : ''}.`
                                           : 'Tap songs to pick them.') + extra;
  $('pickAdd').textContent = picked.size ? `ADD ${picked.size}` : 'ADD';
}
$('pickSearch').addEventListener('input', renderPicker);
$('pickList').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li || li.classList.contains('burned')) return;
  playSound('press');
  if (picked.has(li.dataset.id)) picked.delete(li.dataset.id); else picked.add(li.dataset.id);
  li.classList.toggle('on', picked.has(li.dataset.id));
  pickInfo();
});
$('pickCancel').onclick = () => { $('songPicker').hidden = true; };
$('pickAdd').onclick = async () => {
  $('songPicker').hidden = true;
  if (!picked.size) return;
  await burn(pickFor, order.filter(id => picked.has(id)));
};

// ---------------------------------------------------------------- lyrics you add

let lyricsFor_ = null;
function pickLyrics(id) {
  lyricsFor_ = id;
  $('lyricsPicker').value = '';
  $('lyricsPicker').click();
}
$('lyricsPicker').addEventListener('change', async () => {
  const file = $('lyricsPicker').files[0];
  if (!file || !lyricsFor_) return;
  if (file.size > 512 * 1024) { toast('That file is too big to be lyrics.'); return; }
  const text = decodeText(new Uint8Array(await file.arrayBuffer())).trim();
  if (!text) { toast('That file is empty.'); return; }
  await lyricsChanged(lyricsFor_, text);
});
async function lyricsChanged(id, text) {
  await setTrackLyrics(id, text);
  const t = lib.tracks.get(id);
  if (current && current.id === id) state.lyrics = lyricsFor(t.lyrics, t.duration);
  toast(text ? `Lyrics added to “${t.title}”${/\[\d+:\d+/.test(text) ? '' : ' (no timings, so they’ll scroll evenly)'}.` : 'Lyrics removed.');
}

// ---------------------------------------------------------------- pictures you add

let artFor = null, artPick = null, artUrls = [];
const ART_KINDS = [['cover', 'Front cover', 'The jewel case, disc colours and lock screen'], ['back', 'Back cover', 'Shown when you flip the case'],
                   ['disc', 'Disc print', 'Printed on the disc itself']];

function openArtSheet(key) {
  artFor = key;
  $('artTitle').textContent = 'PICTURES';
  renderArtSheet();
  $('artSheet').hidden = false;
}

async function thumb(id) {
  const blob = id ? await imageBlob(id) : null;
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  artUrls.push(url);
  return url;
}

async function renderArtSheet() {
  const album = lib.albums.get(artFor);
  if (!album) return;
  artUrls.forEach(u => URL.revokeObjectURL(u)); artUrls = [];
  const custom = album.custom || {};
  let html = `<p class="dim">${esc(album.album)} · ${esc(album.artist)}</p>`;
  for (const [kind, label, help] of ART_KINDS) {
    const url = await thumb(art(album, kind));
    html += `<div class="art-row">${url ? `<img src="${url}" alt="">` : '<span class="noimg"></span>'}
      <span class="what"><b>${label}</b><span>${custom[kind] ? 'Your picture' : url ? 'From the album' : 'None yet'} · ${help}</span></span>
      <span class="btns"><button class="hw-flat" data-pick="${kind}">CHOOSE…</button>${custom[kind] ? `<button class="hw-flat danger" data-reset="${kind}">RESET</button>` : ''}</span></div>`;
  }
  html += `<p class="silk">BOOKLET PAGES</p><div class="pages">`;
  const own = new Set(custom.booklet || []);
  const pagesList = bookletPages(album);
  for (let i = 0; i < pagesList.length; i++) {
    const id = pagesList[i];
    html += `<figure><img src="${await thumb(id)}" alt="">${own.has(id) ? `<button data-page="${id}" aria-label="Remove page">×</button>` : ''}<figcaption>Page ${i + 1}</figcaption></figure>`;
  }
  html += `</div><div class="row-buttons"><button class="hw-flat primary" data-pick="booklet">ADD PAGES…</button></div>
    <p class="dim small">Pages are shown in the order you add them. Photos work too: take them flat and in good light.</p>`;
  $('artBody').innerHTML = html;
}

$('artBody').addEventListener('click', async e => {
  const pick = e.target.closest('[data-pick]'), reset = e.target.closest('[data-reset]'), pg = e.target.closest('[data-page]');
  if (pick) {
    playSound('press');
    artPick = pick.dataset.pick;
    const input = $('imagePicker');
    input.multiple = artPick === 'booklet';
    input.value = '';
    input.click();
  } else if (reset) {
    playSound('press');
    await resetAlbumArt(artFor, reset.dataset.reset);
    artUpdated();
  } else if (pg) {
    playSound('press');
    await resetAlbumArt(artFor, 'booklet', pg.dataset.page);
    artUpdated();
  }
});
$('artDone').onclick = () => { $('artSheet').hidden = true; artUrls.forEach(u => URL.revokeObjectURL(u)); artUrls = []; };

$('imagePicker').addEventListener('change', async () => {
  const files = [...$('imagePicker').files];
  if (!files.length) return;
  if (artPick === 'obi') { obiScanChosen(files[0]); return; }
  try {
    for (const f of files) await setAlbumArt(artFor, artPick, f);
    artUpdated();
  } catch (e) { toast(e.message, 6); }
});

function artUpdated() {
  renderArtSheet();
  repaintCases();
  if (current && current.albumKey === artFor && !playingCdr) refreshDisc(false).then(cover => { if (cover) updateMediaSession(current, cover); });
}

// ---------------------------------------------------------------- obi editor

let obiFor = null, obiDraft = null, obiScanFile = null, obiScanImg = null;
const DESIGN_NAMES = { bands: 'Bands', gradient: 'Gradient', candy: 'Candy stripes', dots: 'Polka dots', split: 'Split', burst: 'Starburst', rainbow: 'Rainbow' };

async function openObiEditor(key) {
  obiFor = key;
  const album = lib.albums.get(key);
  const o = (album.custom && album.custom.obi) || {};
  obiDraft = { design: o.design || '', colors: o.colors ? [...o.colors] : null, label: o.label || '', catalogue: o.catalogue || '', image: o.image || null };
  obiScanFile = null;
  obiScanImg = o.image ? await imageFor(o.image) : null;
  $('obiDesign').innerHTML = `<option value="">Automatic</option>` + OBI_DESIGNS.map(d => `<option value="${d}">${DESIGN_NAMES[d] || d}</option>`).join('') + `<option value="none">No obi</option>`;
  $('obiDesign').value = obiDraft.design; $('obiLabel').value = obiDraft.label; $('obiCatalogue').value = obiDraft.catalogue;
  await obiColours();
  syncObi();
  $('obiEditor').hidden = false;
}

async function obiColours() {
  const album = lib.albums.get(obiFor);
  const { palette } = await albumArt(album);
  const { cols } = obiEffective(album.album, album.artist, palette, { colors: obiDraft.colors });
  $('obiColours').innerHTML = cols.map((c, i) => `<span class="swatch-col"><input type="color" class="swatch" data-n="${i}" value="${hex(c)}">${['Main', 'Second', 'Third', 'Fourth'][i]}</span>`).join('');
}

async function syncObi() {
  $('obiScanRemove').hidden = !obiScanImg;
  $('obiScan').textContent = obiScanImg ? 'CHOOSE ANOTHER…' : 'CHOOSE PICTURE…';
  const album = lib.albums.get(obiFor);
  const { img, palette } = await albumArt(album);
  const c = $('obiPreview');
  const ctx = sizeCase(c);
  const obi = { design: obiDraft.design || undefined, colors: obiDraft.colors, label: obiDraft.label, catalogue: obiDraft.catalogue, imageObj: obiScanImg };
  paintCaseFront(ctx, { album: album.album, artist: album.artist, year: album.year, obi, discs: discCount(album) }, img, palette, THEME.name === 'Night', true);
}

$('obiDesign').addEventListener('change', () => { obiDraft.design = $('obiDesign').value; syncObi(); });
$('obiLabel').addEventListener('input', () => { obiDraft.label = $('obiLabel').value; syncObi(); });
$('obiCatalogue').addEventListener('input', () => { obiDraft.catalogue = $('obiCatalogue').value; syncObi(); });
$('obiColours').addEventListener('input', () => {
  obiDraft.colors = [...document.querySelectorAll('#obiColours input')].map(i => i.value);
  syncObi();
});
$('obiScan').onclick = () => { playSound('press'); artPick = 'obi'; const i = $('imagePicker'); i.multiple = false; i.value = ''; i.click(); };
$('obiScanRemove').onclick = () => { playSound('press'); obiScanFile = null; obiScanImg = null; obiDraft.image = null; syncObi(); };
$('obiReset').onclick = async () => {
  playSound('press');
  obiDraft = { design: '', colors: null, label: '', catalogue: '', image: null };
  obiScanFile = null; obiScanImg = null;
  $('obiDesign').value = ''; $('obiLabel').value = ''; $('obiCatalogue').value = '';
  await obiColours(); syncObi();
};
$('obiCancel').onclick = () => { $('obiEditor').hidden = true; };
$('obiSave').onclick = async () => {
  playSound('press');
  try {
    await setObi(obiFor, { design: obiDraft.design, colors: obiDraft.colors, label: obiDraft.label.trim(), catalogue: obiDraft.catalogue.trim(),
                           image: obiScanFile ? undefined : obiDraft.image }, obiScanFile);
    $('obiEditor').hidden = true;
    if (!settings.obi) toast('Saved. (Obi strips are switched off in Settings, so turn them on to see it.)', 5); else toast('Obi saved.');
    repaintCases();
  } catch (e) { toast(e.message, 6); }
};

// A scan: obi strips are tall, so a sideways photo is turned upright.
async function obiScanChosen(file) {
  try {
    const bmp = await createImageBitmap(file);
    let blob = file;
    if (bmp.width > bmp.height) {
      const c = document.createElement('canvas'); c.width = bmp.height; c.height = bmp.width;
      const g = c.getContext('2d'); g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(bmp, 0, 0);
      blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .92));
    }
    obiScanFile = blob;
    obiScanImg = await createImageBitmap(blob);
    syncObi();
  } catch (e) { toast('That doesn’t look like a picture Kurukuru can read.'); }
}

// ---------------------------------------------------------------- backup

let readyBackup = null;
$('backupSave').onclick = async () => {
  playSound('press');
  if (readyBackup) { shareBackup(); return; }
  const blob = await busy(p => makeBackup({ songs: $('backupSongs').checked }, p));
  if (!blob) return;
  const d = new Date();
  readyBackup = new File([blob], `Kurukuru backup ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`, { type: 'application/zip' });
  $('backupSave').textContent = 'SAVE THE FILE…';
  toast(`Backup ready (${(blob.size / 1048576).toFixed(1)} MB). Tap SAVE THE FILE… and choose “Save to Files”.`, 8);
};
async function shareBackup() {
  const file = readyBackup;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: file.name });
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    readyBackup = null; $('backupSave').textContent = 'SAVE A BACKUP';
  } catch (e) { if (e.name !== 'AbortError') toast('Couldn’t save the file: ' + e.message, 6); }
}
$('backupSongs').addEventListener('change', () => { readyBackup = null; $('backupSave').textContent = 'SAVE A BACKUP'; });
$('backupRestore').onclick = () => { playSound('press'); $('backupPicker').value = ''; $('backupPicker').click(); };
$('backupPicker').addEventListener('change', async () => {
  const file = $('backupPicker').files[0];
  if (!file) return;
  const r = await busy(p => restoreBackup(file, p));
  if (!r) return;
  toast(`Restored ${plural(r.cdrs, 'CD-R')}, pictures and obi for ${plural(r.albums, 'album')}, ${r.lyrics} lyrics${r.songs ? `, ${plural(r.songs, 'song')}` : ''}.` +
        (r.waiting ? ` ${r.waiting} more will appear once their albums are back (import them or sync Plex).` : '') + ' Reloading…', 6);
  setTimeout(() => location.reload(), 2500);
});

$('mini').addEventListener('click', e => { if (!e.target.closest('button')) $('player').scrollIntoView({ behavior: 'smooth' }); });

// Show the mini player when the big one is scrolled away.
new IntersectionObserver(([e]) => { $('mini').hidden = e.isIntersecting || !current; }, { threshold: .12 }).observe($('player'));

// ---------------------------------------------------------------- animation loop

const skyCanvas = $('sky');
let last = performance.now(), lastSky = 0, lastMini = '';
function sizeCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return dpr;
}
function drawSky(now) {
  const night = THEME.name === 'Night';
  const t = settings.sky ? now / 1000 : 0;
  const dpr = sizeCanvas(skyCanvas);
  // The moon stays put in the sky, peeking out at the top right (below the status bar).
  if (drawSky.safeTop === undefined) drawSky.safeTop = Math.max(0, parseFloat(getComputedStyle(document.body).paddingTop) - 12);
  sky.moon = { x: skyCanvas.clientWidth - 46, y: drawSky.safeTop + 15, r: 13, low: true };
  const g = skyCanvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  sky.paint(g, skyCanvas.clientWidth, skyCanvas.clientHeight, night, t);
}

function frame(now) {
  const dt = Math.min(100, now - last); last = now;
  if (scheme.t < 1 && scheme.to) {
    scheme.t = Math.min(1, scheme.t + dt / 900);
    const e = smooth(scheme.t);
    for (const k of SCHEME_KEYS) THEME[k] = hex(mix(scheme.from[k], scheme.to[k], e));
    setVars();
    lastSky = 0;
    if (scheme.t >= 1) repaintCases();
  }
  const playing = state.state === 'play';
  let target = 0;
  if (playing && state.levels) { const i = Math.floor(audio.currentTime * 12.5); target = state.levels[i] || 0; }
  energy += (target - energy) * (target > energy ? .45 : .18);
  disc.energy = energy;
  document.documentElement.style.setProperty('--energy', energy.toFixed(3));
  document.documentElement.style.setProperty('--glow', playing ? (.35 + .65 * energy).toFixed(3) : '0');
  if (disc.step(dt) || disc.dirty) disc.draw();
  if (lcd.needsFrame() || frame.lcdDirty !== state.title + state.state + state.lidOpen + state.shuffle + state.repeat + state.trackCount + state.disc) {
    lcd.draw(); frame.lcdDirty = state.title + state.state + state.lidOpen + state.shuffle + state.repeat + state.trackCount + state.disc;
  }
  if (!dragging && current) {
    const d = isFinite(audio.duration) ? audio.duration : (state.duration / 1000 || 0);
    showBar(d ? audio.currentTime / d : 0);
  }
  if (now - lastSky > (settings.sky ? 66 : 2000)) { drawSky(now); lastSky = now; }
  const miniKey = current ? current.id + THEME.accent + (playingCdr || '') : '';
  if (miniKey !== lastMini && current) {
    lastMini = miniKey;
    $('miniTitle').textContent = current.title; $('miniSub').textContent = `${current.artist} · ${current.album}`;
    const cdr = playingCdr && findCdr(playingCdr);
    const album = lib.albums.get(current.albumKey);
    if (cdr) drawCdrCase($('miniArt'), cdr); else if (album) drawCase($('miniArt'), album);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- start

async function start() {
  sounds.enabled = settings.sounds; sounds.volume = settings.fx / 100;
  applyTheme();
  showPage('now');
  try { await loadLibrary(); } catch (e) { toast('Couldn’t open the music library: ' + e.message, 8); }
  rebuildOrder();
  renderNow();
  // Pick up where you left off (paused).
  try {
    const lastPlayed = JSON.parse(localStorage.getItem('kurukuru-last') || 'null');
    if (lastPlayed && lib.tracks.has(lastPlayed.id)) await playTrack(lastPlayed.id, { autoplay: false, animate: false, cdr: lastPlayed.cdr || null });
  } catch (e) { /* ignore */ }
  if (plex.connected) syncPlex(true);
  setInterval(() => { if (settings.theme === 'Auto' && autoThemeName() !== THEME.name) applyTheme(); }, 60000);
  setInterval(updatePositionState, 5000);
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('visibilitychange', () => { last = performance.now(); });
window.kurukuru = { lib, state, settings, plex: plexApi, makeBackup, get playingCdr() { return playingCdr; } };   // handy for debugging in Web Inspector
start();
