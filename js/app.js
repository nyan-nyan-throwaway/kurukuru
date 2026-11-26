// Kurukuru CD for iPhone: the app.
import { THEME, setTheme, albumScheme, autoThemeName, SCHEME_KEYS, albumPalette, mix, rgba, hex, parse, smooth, crc32, darker } from './theme.js';
import { Sky, paintCaseFront, paintCaseBack, paintCaseBackImage, paintSpine, fmtTime } from './paint.js';
import { DiscView } from './disc.js';
import { LcdView } from './lcd.js';
import { lib, loadLibrary, importFiles, albumTracks, sortedAlbums, imageFor, imageBlob, audioBlob, deleteAlbum, cachedLevels, saveLevels } from './library.js';
import { lyricsFor, unlockSounds, playSound, sounds, analyseLevels } from './audiofx.js';
import { storageInfo, askPersist } from './db.js';

const VERSION = '1.0.2';
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
  lyrics: [], showLyrics: settings.lyrics, lidOpen: false, flash: null,
  position: () => (current ? audio.currentTime * 1000 : 0),
};
let current = null;          // the playing track
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

async function schemeFor(track) {
  let palette = [], seed = null;
  if (track) {
    const album = lib.albums.get(track.albumKey);
    const img = album && album.cover ? await imageFor(album.cover) : null;
    palette = img ? albumPalette(img, 3, album.cover) : [];
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
  if (order.length) { state.state = 'stop'; state.title = 'Disc ready'; state.subtitle = `${order.length} songs · press PLAY`; }
  else { state.state = 'nodisc'; state.title = 'Insert a disc'; state.subtitle = 'Tap the lid to add music'; }
}

async function playTrack(id, { autoplay = true, animate = true } = {}) {
  const track = lib.tracks.get(id);
  if (!track) return;
  if (current && current.id !== id) playSound('skip');
  current = track;
  const album = lib.albums.get(track.albumKey);
  const tracks = album ? albumTracks(album) : [track];
  const pos = tracks.findIndex(t => t.id === id) + 1;
  state.trackNo = track.track || pos;
  state.calendar = [pos, tracks.length];
  state.duration = (track.duration || 0) * 1000;
  state.title = track.title;
  state.subtitle = [track.artist, track.album, track.year].filter(Boolean).join('  ·  ');
  state.lyrics = lyricsFor(track.lyrics, track.duration);
  state.levels = null;
  const cover = album && album.cover ? await imageFor(album.cover) : null;
  const discImg = album && album.disc ? await imageFor(album.disc) : null;
  disc.setDisc({ image: discImg || cover, cacheKey: (album && (album.disc || album.cover)) || '', album: track.album, artist: album ? album.artist : track.artist,
                 cdr: null, ...(discImg ? { forceArt: true } : {}) }, animate);
  if (discImg) disc.setMode('art'); else disc.setMode(settings.disc);
  schemeFor(track);
  const blob = await audioBlob(id);
  if (!blob) { toast('This song’s file is missing.'); return; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  audio.src = audioUrl;
  if (autoplay) audio.play().catch(() => {});
  renderNow();
  markPlaying();
  updateMediaSession(track, cover);
  try { localStorage.setItem('kurukuru-last', JSON.stringify({ id, t: 0 })); } catch (e) { /* ignore */ }
  // The level meter (and the glow) need the song's loudness: cached, or worked out in the background.
  const levels = await cachedLevels(id);
  if (levels) { if (current === track) state.levels = levels; }
  else setTimeout(async () => {
    try {
      const lv = await analyseLevels(blob);
      if (lv.length) { await saveLevels(id, lv); if (current === track) state.levels = lv; }
    } catch (e) { /* no meter for this one */ }
  }, 1500);
}

function togglePlay() {
  unlockSounds();
  if (!current) { if (order.length) playTrack(order[0]); else openPicker(); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function step(dir) {
  if (!order.length) return;
  if (dir < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.shuffle && order.length > 1 && dir > 0) {
    let id; do { id = order[Math.floor(Math.random() * order.length)]; } while (current && id === current.id);
    playTrack(id); return;
  }
  const i = current ? order.indexOf(current.id) : -1;
  playTrack(order[(i + dir + order.length) % order.length]);
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
audio.addEventListener('error', () => { if (current) { state.state = 'error'; toast('Couldn’t play this song. iPhone may not support its format.'); } });

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

function trackRows(list, tracks) {
  list.innerHTML = tracks.map((t, i) => `
    <li data-id="${t.id}" class="${current && current.id === t.id ? 'current' : ''}">
      <span class="n">${current && current.id === t.id ? '<span class="eq"><i></i><i></i><i></i><i></i></span>' : String(t.track || i + 1).padStart(2, '0')}</span>
      <span class="tt"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span>
      <span class="d">${t.duration ? fmtTime(t.duration * 1000) : ''}</span>
    </li>`).join('');
}

function renderNow() {
  const album = current ? lib.albums.get(current.albumKey) : null;
  $('emptyHint').hidden = order.length > 0;
  const header = $('nowHeader');
  if (album) {
    header.innerHTML = `<canvas width="172" height="178"></canvas><div><div class="silk">NOW PLAYING</div><div class="t">${esc(album.album)}</div><div class="dim">${esc(album.artist)}${album.year ? ' · ' + esc(album.year) : ''}</div></div>`;
    drawCase(header.querySelector('canvas'), album);
    header.onclick = () => openAlbum(album.key);
    trackRows($('nowList'), albumTracks(album));
  } else if (order.length) {
    header.innerHTML = `<div><div class="silk">YOUR DISCS</div><div class="dim">${lib.albums.size} albums · ${order.length} songs. Pick one from the LIBRARY, or press PLAY.</div></div>`;
    header.onclick = null;
    $('nowList').innerHTML = '';
  } else { header.innerHTML = ''; $('nowList').innerHTML = ''; }
}

function markPlaying() {
  for (const list of [$('nowList'), $('albumList')]) {
    for (const li of list.children) {
      const on = current && li.dataset.id === current.id;
      if (on !== li.classList.contains('current')) {
        const t = lib.tracks.get(li.dataset.id);
        li.classList.toggle('current', on);
        li.querySelector('.n').innerHTML = on ? '<span class="eq"><i></i><i></i><i></i><i></i></span>' : String(t.track || [...list.children].indexOf(li) + 1).padStart(2, '0');
      }
    }
  }
  document.querySelectorAll('.card, .spine').forEach(el => {
    const on = current && el.dataset.key === current.albumKey;
    if (el.classList.contains('playing') !== on) { el.classList.toggle('playing', on); if (el.redraw) el.redraw(); }
  });
}

for (const list of [$('nowList'), $('albumList')]) {
  list.addEventListener('click', e => {
    const li = e.target.closest('li');
    if (li) { unlockSounds(); playSound('press'); playTrack(li.dataset.id); }
  });
}

// ---------------------------------------------------------------- cases, shelf, album page

async function albumArt(album) {
  const img = album.cover ? await imageFor(album.cover) : null;
  return { img, palette: img ? albumPalette(img, 3, album.cover) : [] };
}

async function drawCase(canvas, album) {
  const { img, palette } = await albumArt(album);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 172;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * 178 / 172 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / 172, 0, 0, canvas.width / 172, 0, 0);
  ctx.clearRect(0, 0, 172, 178);
  paintCaseFront(ctx, { album: album.album, artist: album.artist, year: album.year, obi: album.obi }, img, palette, THEME.name === 'Night', settings.obi);
}

async function drawSpine(canvas, album, playing) {
  const { palette } = await albumArt(album);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 30 * dpr; canvas.height = 172 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 30, 172);
  paintSpine(ctx, 1, 12, 27, 158, { album: album.album, artist: album.artist, obi: album.obi }, palette, playing);
}

const lazy = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { lazy.unobserve(e.target); e.target.redraw(); }
}, { rootMargin: '300px' });

function renderShelf() {
  const shelf = $('shelf');
  const q = $('search').value.trim().toLowerCase();
  const albums = sortedAlbums().filter(a => !q || `${a.album}\n${a.artist}`.toLowerCase().includes(q));
  const spines = settings.shelf === 'spines';
  shelf.className = 'shelf' + (spines ? ' spines' : '');
  $('viewToggle').classList.toggle('lit', spines);
  shelf.innerHTML = '';
  if (!albums.length) { shelf.innerHTML = `<p class="dim">${lib.albums.size ? 'No albums match.' : 'Your shelf is empty. Tap ⏏ to add music.'}</p>`; return; }
  let row = null;
  albums.forEach((album, i) => {
    const el = document.createElement('div');
    el.dataset.key = album.key;
    const playing = current && current.albumKey === album.key;
    el.classList.toggle('playing', !!playing);
    if (spines) {
      el.className += ' spine';
      el.innerHTML = '<canvas></canvas>';
      el.title = `${album.album} — ${album.artist}`;
      el.redraw = () => drawSpine(el.firstChild, album, el.classList.contains('playing'));
      const perRow = Math.max(1, Math.floor((shelf.clientWidth || 320) / 31));
      if (i % perRow === 0) { row = document.createElement('div'); row.className = 'rack-row'; shelf.appendChild(row); }
      row.appendChild(el);
    } else {
      el.className += ' card';
      el.innerHTML = `<canvas></canvas><b>${esc(album.album)}</b><span>${esc(album.artist)}</span>`;
      el.redraw = () => drawCase(el.firstChild, album);
      shelf.appendChild(el);
    }
    el.addEventListener('click', () => { playSound('press'); openAlbum(album.key); });
    lazy.observe(el);
  });
}

function repaintCases() {
  document.querySelectorAll('.card, .spine').forEach(el => el.redraw && el.redraw());
  if (shownAlbum) renderAlbumCase(lib.albums.get(shownAlbum));
  const nowCanvas = document.querySelector('#nowHeader canvas');
  if (nowCanvas && current) drawCase(nowCanvas, lib.albums.get(current.albumKey));
}

let shownAlbum = null;

async function renderAlbumCase(album) {
  await drawCase($('caseFront'), album);
  const back = $('caseBack');
  const dpr = window.devicePixelRatio || 1;
  const w = back.clientWidth || 172;
  back.width = Math.round(w * dpr); back.height = Math.round(w * 178 / 172 * dpr);
  const ctx = back.getContext('2d');
  ctx.setTransform(back.width / 172, 0, 0, back.width / 172, 0, 0);
  ctx.clearRect(0, 0, 172, 178);
  const backImg = album.back ? await imageFor(album.back) : null;
  if (backImg) paintCaseBackImage(ctx, backImg, THEME.name === 'Night');
  else {
    const { palette } = await albumArt(album);
    const tracks = albumTracks(album).map((t, i) => [t.track || i + 1, t.title, t.duration]);
    paintCaseBack(ctx, album, tracks, palette, THEME.name === 'Night');
  }
}

function openAlbum(key) {
  const album = lib.albums.get(key);
  if (!album) return;
  shownAlbum = key;
  const tracks = albumTracks(album);
  $('albumTitle').textContent = album.album;
  const minutes = Math.round(tracks.reduce((s, t) => s + (t.duration || 0), 0) / 60);
  $('albumMeta').textContent = [album.artist, album.year, `${tracks.length} song${tracks.length === 1 ? '' : 's'}`, minutes ? `${minutes} min` : '']
    .filter(Boolean).join(' · ');
  $('openBooklet').hidden = false;
  $('caseFlip').classList.remove('flipped');
  trackRows($('albumList'), tracks);
  showPage('album');
  requestAnimationFrame(() => renderAlbumCase(album));
}

function showPage(name) {
  for (const p of ['now', 'library', 'album']) $('page-' + p).hidden = p !== name;
  document.querySelectorAll('.tab[data-page]').forEach(t => t.classList.toggle('lit', t.dataset.page === name || (name === 'album' && t.dataset.page === 'library')));
  document.querySelectorAll('.tab[data-page] .lamp').forEach(l => l.classList.toggle('lit', l.parentElement.classList.contains('lit')));
  if (name === 'library') renderShelf();
  if (name !== 'album') shownAlbum = null;
}

// ---------------------------------------------------------------- booklet

let pages = [], page = 0;
async function openBooklet() {
  const album = lib.albums.get(shownAlbum);
  if (!album) return;
  pages = [];
  if (album.cover) pages.push(['Front cover', album.cover]);
  (album.booklet || []).forEach((id, i) => pages.push([`Page ${i + 1}`, id]));
  if (album.back) pages.push(['Back cover', album.back]);
  if (!pages.length) { toast('No pictures for this album yet.'); return; }
  $('bookletTitle').textContent = `${album.album} · ${album.artist}`;
  $('bookletHint').textContent = (album.booklet || []).length ? '' : 'No booklet pages: add scans named booklet01.jpg… in the album’s zip.';
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

// ---------------------------------------------------------------- settings sheet

async function openSettings() {
  $('setTheme').value = settings.theme; $('setDisc').value = settings.disc; $('setObi').checked = settings.obi;
  $('setSky').checked = settings.sky; $('setMeter').checked = settings.meter; $('setLyrics').checked = settings.lyrics;
  $('setSounds').checked = settings.sounds; $('setFx').value = settings.fx;
  $('version').textContent = `Kurukuru CD for iPhone · version ${VERSION}`;
  const info = await storageInfo();
  const mb = n => (n / 1048576).toFixed(n > 1048576 * 100 ? 0 : 1);
  $('storageText').textContent = `${lib.albums.size} albums, ${lib.tracks.size} songs · using ${mb(info.usage)} MB` +
    (info.quota ? ` of about ${(info.quota / 1073741824).toFixed(1)} GB available` : '') +
    (info.persisted ? ' · kept safe ✓' : ' · iPhone may clear it if storage runs very low');
  $('persistButton').hidden = info.persisted;
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
$('playAlbum').onclick = () => { const a = lib.albums.get(shownAlbum); const t = a && albumTracks(a)[0]; if (t) { unlockSounds(); playTrack(t.id); } };
$('openBooklet').onclick = openBooklet;
$('removeAlbum').onclick = async () => {
  const album = lib.albums.get(shownAlbum);
  if (!album || !confirm(`Remove “${album.album}” and its songs from Kurukuru? (The files in your Files app aren’t touched.)`)) return;
  if (current && current.albumKey === album.key) { audio.pause(); audio.removeAttribute('src'); current = null; idleText(); disc.setDisc({ image: null, album: '', artist: '' }, true); }
  await deleteAlbum(album.key);
  rebuildOrder(); renderNow(); showPage('library');
  toast('Album removed.');
};
$('mini').addEventListener('click', e => { if (!e.target.closest('button')) $('player').scrollIntoView({ behavior: 'smooth' }); });

// Show the mini player when the big one is scrolled away.
new IntersectionObserver(([e]) => { $('mini').hidden = e.isIntersecting || !current; }, { threshold: .12 }).observe($('player'));

// ---------------------------------------------------------------- animation loop

const skyCanvas = $('sky'), visor = $('visor');
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
  let dpr = sizeCanvas(skyCanvas);
  let g = skyCanvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  sky.paint(g, skyCanvas.clientWidth, skyCanvas.clientHeight, night, t);
  // The visor shows the same sky, lined up with where it sits on screen.
  const r = visor.getBoundingClientRect();
  if (r.bottom > 0 && r.top < innerHeight) {
    dpr = sizeCanvas(visor);
    g = visor.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, -r.left * dpr, -r.top * dpr);
    sky.paint(g, skyCanvas.clientWidth, skyCanvas.clientHeight, night, t);
  }
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
  if (lcd.needsFrame() || frame.lcdDirty !== state.title + state.state + state.lidOpen + state.shuffle + state.repeat + state.trackCount) {
    lcd.draw(); frame.lcdDirty = state.title + state.state + state.lidOpen + state.shuffle + state.repeat + state.trackCount;
  }
  if (!dragging && current) {
    const d = isFinite(audio.duration) ? audio.duration : (state.duration / 1000 || 0);
    showBar(d ? audio.currentTime / d : 0);
  }
  if (now - lastSky > (settings.sky ? 66 : 2000)) { drawSky(now); lastSky = now; }
  const miniKey = current ? current.id + THEME.accent : '';
  if (miniKey !== lastMini && current) {
    lastMini = miniKey;
    $('miniTitle').textContent = current.title; $('miniSub').textContent = `${current.artist} · ${current.album}`;
    const album = lib.albums.get(current.albumKey);
    if (album) drawCase($('miniArt'), album);
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
    if (lastPlayed && lib.tracks.has(lastPlayed.id)) await playTrack(lastPlayed.id, { autoplay: false, animate: false });
  } catch (e) { /* ignore */ }
  setInterval(() => { if (settings.theme === 'Auto' && autoThemeName() !== THEME.name) applyTheme(); }, 60000);
  setInterval(updatePositionState, 5000);
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('visibilitychange', () => { last = performance.now(); });
window.kurukuru = { lib, state, settings };   // handy for debugging in Web Inspector
start();
