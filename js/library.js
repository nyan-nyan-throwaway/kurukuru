// The music library: importing songs (one by one or as .zip album folders), albums, images.
import * as db from './db.js';
import { readTags, probeDuration } from './tags.js';
import { listZip, extract } from './zip.js';
import * as plex from './plex.js';

export const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
                       ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff' };
const IMAGE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const FRONT = /^(cover|folder|front|album|albumart|artwork)\b/i;
const BACK = /^(back|back cover|cover_back|backcover|tray|inlay|rear)\b/i;
const DISC = /^(?:cd|disc|disk|media)\s*[-_.]?\s*(\d*)$/i;
// Folders like "CD1", "Disc 2", "disc_02" inside an album folder: one disc of a multi-disc album.
export const DISC_DIR = /^(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})\b/i;
const BOOKLET = /^(booklet|book|page|scan|inside|insert|liner|leaflet|lyrics)[\s_\-]*\d*/i;
const BOOKLET_DIRS = new Set(['scans', 'scan', 'booklet', 'artwork', 'art', 'covers', 'images']);

export const lib = { tracks: new Map(), albums: new Map(), cdrs: [], pending: {} };

const ext = name => (name.split('.').pop() || '').toLowerCase();
const stem = name => name.split('/').pop().replace(/\.[^.]+$/, '');
const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export async function loadLibrary() {
  lib.tracks = new Map(await db.all('tracks'));
  lib.albums = new Map(await db.all('albums'));
  lib.cdrs = (await db.get('extras', 'cdrs')) || [];
  lib.pending = (await db.get('extras', 'pending')) || {};
  // Tidy up songs left behind by an import that was interrupted.
  const owned = new Set([...lib.albums.values()].flatMap(a => a.trackIds));
  for (const id of [...lib.tracks.keys()]) {
    if (!owned.has(id)) {
      lib.tracks.delete(id);
      try { await db.del('audio', id); await db.del('tracks', id); } catch (e) { /* try again next time */ }
    }
  }
}

export function albumTracks(album) {
  return album.trackIds.map(id => lib.tracks.get(id)).filter(Boolean)
    .sort((a, b) => (a.disc || 0) - (b.disc || 0) || (a.track || 999) - (b.track || 999) || natural(a.file, b.file));
}

export function sortedAlbums() {
  return [...lib.albums.values()].sort((a, b) => natural(a.album, b.album) || natural(a.artist, b.artist));
}

// ---------------------------------------------------------------- images

const bitmaps = new Map();
export async function imageFor(id) {
  if (!id) return null;
  if (bitmaps.has(id)) return bitmaps.get(id);
  const promise = (async () => {
    let blob = await db.get('images', id);
    if (!blob && id.startsWith('plexart:') && plex.plex.connected) {
      try { blob = await plex.fetchArt(id.slice(8)); await db.put('images', id, blob); }
      catch (e) { bitmaps.delete(id); return null; }   // try again later (e.g. back on home Wi-Fi)
    }
    if (!blob) return null;
    try { return await createImageBitmap(blob); }
    catch (e) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      try { await img.decode(); return img; } catch (e2) { return null; }
    }
  })();
  bitmaps.set(id, promise);
  return promise;
}

export async function imageBlob(id) {
  if (!id) return null;
  if (id.startsWith('plexart:')) await imageFor(id);
  return db.get('images', id);
}

async function storeImage(blob) {
  const id = 'img-' + db.uid();
  await db.put('images', id, blob);
  return id;
}

// ---------------------------------------------------------------- importing

// files: File objects from the picker (songs, images, .lrc, .zip).
export async function importFiles(files, progress = () => {}) {
  const items = [];
  for (const file of files) {
    if (ext(file.name) === 'zip') {
      progress({ stage: 'Opening ' + file.name });
      const entries = await listZip(file);
      const root = file.name.replace(/\.zip$/i, '');
      for (const e of entries) {
        items.push({ path: e.name.includes('/') ? e.name : root + '/' + e.name, size: e.size,
                     get: () => extract(file, e, AUDIO[ext(e.base)] || IMAGE[ext(e.base)] || '') });
      }
    } else {
      items.push({ path: file.name, size: file.size, get: async () => file });
    }
  }
  const audio = items.filter(i => AUDIO[ext(i.path)]);
  const images = items.filter(i => IMAGE[ext(i.path)]);
  const lyricFiles = items.filter(i => ['lrc', 'txt'].includes(ext(i.path)));
  if (!audio.length) throw new Error('No songs found. Kurukuru plays MP3, M4A/AAC, FLAC, Ogg/Opus and WAV.');

  // Lyrics files, matched to songs by name.
  const lyricText = new Map();
  for (const item of lyricFiles) {
    const text = decodeText(new Uint8Array(await (await item.get()).arrayBuffer()));
    lyricText.set((dirOf(item.path) + '/' + stem(item.path)).toLowerCase(), text);
  }

  const touched = new Map();   // album key -> album (new or existing)
  const folderAlbums = new Map();
  const discFolders = new Map();   // "Album/CD2" -> 2
  let n = 0, added = 0;
  const failures = [];
  for (const item of audio) {
    n++;
    progress({ stage: `Adding songs`, done: n - 1, total: audio.length, name: stem(item.path) });
    try {
    const blob = await item.get();
    const tags = await readTags(blob);
    if (!tags.duration) tags.duration = await probeDuration(blob);
    const songFolder = dirOf(item.path);
    let folder = songFolder, discFromFolder = 0;
    const m = songFolder.split('/').pop().match(DISC_DIR);
    if (m && songFolder.includes('/')) { discFromFolder = +m[1]; folder = dirOf(songFolder); }
    else if (m) { discFromFolder = +m[1]; }
    if (!tags.disc && discFromFolder) tags.disc = discFromFolder;
    const folderName = (folder || songFolder).split('/').pop();
    const title = tags.title || stem(item.path).replace(/^\d+[\s.\-_]+/, '');
    const artist = tags.artist || tags.albumArtist || 'Unknown artist';
    const album = tags.album || folderName || 'Unknown album';
    const albumArtist = tags.albumArtist || artist;
    const key = (folder ? folder.toLowerCase() : albumArtist.toLowerCase()) + '\n' + album.toLowerCase();
    let rec = touched.get(key) || lib.albums.get(key);
    if (!rec) rec = { key, album, artist: albumArtist, year: tags.year || '', cover: null, back: null, disc: null, booklet: [], trackIds: [], added: Date.now() };
    touched.set(key, rec);
    if (folder) folderAlbums.set(folder, rec);
    if (songFolder && songFolder !== folder) { folderAlbums.set(songFolder, rec); discFolders.set(songFolder, discFromFolder); }
    // Skip songs that are already in the library.
    const dupe = rec.trackIds.map(id => lib.tracks.get(id)).find(t => t && t.title === title && t.track === tags.track
                 && Math.abs((t.duration || 0) - (tags.duration || 0)) < 1.5);
    if (dupe) continue;
    if (!rec.cover && tags.picture) rec.cover = await storeImage(new Blob([tags.picture.data], { type: tags.picture.mime }));
    if (!rec.year && tags.year) rec.year = tags.year;
    const id = 'trk-' + db.uid();
    const lyric = lyricText.get((songFolder + '/' + stem(item.path)).toLowerCase());
    const track = { id, albumKey: key, title, artist, album, track: tags.track || 0, disc: tags.disc || 0, year: tags.year || '',
                    duration: tags.duration || 0, lyrics: lyric || tags.lyrics || null, file: item.path.split('/').pop(),
                    type: blob.type || AUDIO[ext(item.path)], added: Date.now() };
    adoptPendingLyrics(track);
    await db.put('audio', id, new Blob([await blob.arrayBuffer()], { type: blob.type || AUDIO[ext(item.path)] }));
    await db.put('tracks', id, track);
    lib.tracks.set(id, track);
    rec.trackIds.push(id);
    await db.put('albums', rec.key, rec);   // saved song by song, so a later problem can't undo this one
    lib.albums.set(rec.key, rec);
    added++;
    } catch (e) {
      console.error('Import failed for', item.path, e);
      failures.push(`${stem(item.path)}: ${(e && (e.name && e.name !== 'Error' ? e.name + ' – ' : '') + e.message) || e}`);
    }
  }
  if (!added && failures.length) throw new Error('Couldn’t add any songs. ' + failures[0]);

  // Pictures: front / back / disc / booklet pages, by name and folder.
  const single = touched.size === 1 ? [...touched.values()][0] : null;
  for (const item of images.sort((a, b) => natural(a.path, b.path))) {
    const folder = dirOf(item.path);
    const parts = folder.split('/');
    const inBookletDir = BOOKLET_DIRS.has(parts[parts.length - 1].toLowerCase());
    const rec = folderAlbums.get(folder) || (inBookletDir ? folderAlbums.get(parts.slice(0, -1).join('/')) : null) || single;
    if (!rec) continue;
    const name = stem(item.path);
    let kind = null;
    if (inBookletDir || BOOKLET.test(name)) kind = 'booklet';
    else if (BACK.test(name)) kind = 'back';
    else if (DISC.test(name)) kind = 'disc';
    else if (FRONT.test(name)) kind = 'front';
    else if (!rec.cover) kind = 'front';
    if (!kind) continue;
    if (kind === 'front' && rec.cover && !FRONT.test(name)) continue;
    if (kind === 'front' && rec.cover && FRONT.test(name)) continue;  // keep the embedded art, like the desktop app
    let id;
    try { id = await storeImage(await item.get()); } catch (e) { console.error('Image failed', item.path, e); continue; }
    if (kind === 'booklet') rec.booklet.push(id);
    else if (kind === 'front') rec.cover = id;
    else if (kind === 'back') { if (!rec.back) rec.back = id; }
    else if (kind === 'disc') {
      const n = +((name.match(DISC) || [])[1] || discFolders.get(folder) || 1);
      if (n <= 1) { if (!rec.disc) rec.disc = id; }
      else { rec.discs = rec.discs || {}; if (!rec.discs[n]) rec.discs[n] = id; }
    }
  }
  for (const rec of touched.values()) {
    if (!rec.trackIds.length) continue;
    if (adoptPending(rec)) await savePending();
    await db.put('albums', rec.key, rec);
    lib.albums.set(rec.key, rec);
  }
  await relink();
  progress({ stage: 'Done', done: audio.length, total: audio.length });
  return { albums: [...touched.values()].filter(a => a.trackIds.length), songs: added, failures };
}

export function decodeText(bytes) {
  for (const enc of ['utf-8', 'shift_jis', 'gb18030']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes).replace(/^﻿/, ''); } catch (e) { /* next */ }
  }
  return new TextDecoder('latin1').decode(bytes);
}

export async function deleteAlbum(key) {
  const rec = lib.albums.get(key);
  if (!rec) return;
  for (const id of rec.trackIds) {
    await db.del('audio', id); await db.del('tracks', id); await db.del('extras', 'levels:' + id);
    lib.tracks.delete(id);
  }
  const c = rec.custom || {};
  for (const id of [rec.cover, rec.back, rec.disc, ...(rec.booklet || []), c.cover, c.back, c.disc, ...(c.booklet || []), c.obi && c.obi.image])
    if (id) { await db.del('images', id); bitmaps.delete(id); }
  await db.del('albums', key);
  lib.albums.delete(key);
}

export async function audioBlob(id) { return db.get('audio', id); }

export async function cachedLevels(id) { return db.get('extras', 'levels:' + id); }
export async function saveLevels(id, levels) { return db.put('extras', 'levels:' + id, levels); }

// ---------------------------------------------------------------- Plex

// Replaces the Plex part of the library with a fresh listing, keeping songs you saved on the phone.
export async function applyPlexLibrary({ albums, tracks }) {
  const oldTracks = [...lib.tracks.values()].filter(t => t.source === 'plex');
  const fresh = new Set(tracks.map(t => t.id));
  for (const t of tracks) {
    const old = lib.tracks.get(t.id);
    if (old) { t.local = old.local; t.customLyrics = old.customLyrics; if (old.lyrics != null) t.lyrics = old.lyrics; }
    adoptPendingLyrics(t);
  }
  for (const a of albums) {
    const old = lib.albums.get(a.key);
    if (old && old.custom) a.custom = old.custom;
    adoptPending(a);
  }
  const gone = oldTracks.filter(t => !fresh.has(t.id)).map(t => t.id);
  const goneAlbums = [...lib.albums.values()].filter(a => a.source === 'plex' && !albums.some(n => n.key === a.key)).map(a => a.key);
  await db.delMany('audio', gone);
  await db.delMany('tracks', gone);
  await db.delMany('albums', goneAlbums);
  await db.putMany('tracks', tracks.map(t => [t.id, t]));
  await db.putMany('albums', albums.map(a => [a.key, a]));
  for (const id of gone) lib.tracks.delete(id);
  for (const k of goneAlbums) lib.albums.delete(k);
  for (const t of tracks) lib.tracks.set(t.id, t);
  for (const a of albums) lib.albums.set(a.key, a);
  await savePending();
  await relink();
  return { added: tracks.length - (oldTracks.length - gone.length), removed: gone.length };
}

export async function forgetPlex() {
  const ids = [...lib.tracks.values()].filter(t => t.source === 'plex').map(t => t.id);
  const keys = [...lib.albums.values()].filter(a => a.source === 'plex').map(a => a.key);
  await db.delMany('audio', ids); await db.delMany('tracks', ids); await db.delMany('albums', keys);
  for (const id of ids) lib.tracks.delete(id);
  for (const k of keys) lib.albums.delete(k);
}

// Downloads a Plex album so it plays without a connection.
export async function keepAlbum(key, progress = () => {}) {
  const album = lib.albums.get(key);
  const tracks = albumTracks(album).filter(t => !t.local);
  let i = 0;
  for (const t of tracks) {
    progress({ stage: 'Saving to your phone', done: i, total: tracks.length, name: t.title });
    const blob = await plex.fetchSong(t, f => progress({ stage: 'Saving to your phone', done: i + f, total: tracks.length, name: t.title }));
    await db.put('audio', t.id, blob);
    if (t.lyrics == null) t.lyrics = (await plex.fetchLyrics(t)) || '';
    t.local = true;
    await db.put('tracks', t.id, t);
    i++;
  }
}

export async function unkeepAlbum(key) {
  for (const t of albumTracks(lib.albums.get(key))) {
    if (!t.local) continue;
    await db.del('audio', t.id);
    t.local = false;
    await db.put('tracks', t.id, t);
  }
}

export async function saveTrack(t) { return db.put('tracks', t.id, t); }

// ---------------------------------------------------------------- your own art, obi designs and lyrics

// An album's picture of a kind ('cover' | 'back' | 'disc'): yours if you added one, else the album's own.
export function art(album, kind) { return (album && ((album.custom && album.custom[kind]) || album[kind])) || null; }
export function bookletPages(album) { return [...((album && album.booklet) || []), ...((album && album.custom && album.custom.booklet) || [])]; }

async function saveAlbum(album) { await db.put('albums', album.key, album); }

// Big photos are shrunk to a sensible size before they're stored.
export async function storePicture(file, maxSide = 1800) {
  let blob = file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale < 1 || !/jpe?g|png|webp/.test(file.type || '')) {
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .9));
    }
  } catch (e) { throw new Error(`${file.name || 'That file'} doesn’t look like a picture Kurukuru can read.`); }
  return storeImage(blob);
}

async function dropImage(id) { if (id) { await db.del('images', id); bitmaps.delete(id); } }

export async function setAlbumArt(key, kind, file) {
  const album = lib.albums.get(key);
  album.custom = album.custom || {};
  const id = await storePicture(file);
  if (kind === 'booklet') album.custom.booklet = [...(album.custom.booklet || []), id];
  else { await dropImage(album.custom[kind]); album.custom[kind] = id; }
  await saveAlbum(album);
  return id;
}

export async function resetAlbumArt(key, kind, pageId) {
  const album = lib.albums.get(key);
  if (!album.custom) return;
  if (kind === 'booklet') {
    if (pageId) { await dropImage(pageId); album.custom.booklet = (album.custom.booklet || []).filter(x => x !== pageId); }
  } else { await dropImage(album.custom[kind]); delete album.custom[kind]; }
  await saveAlbum(album);
}

// obi: { design, colors: [hex…], label, catalogue, image: image id } — or null for automatic.
export async function setObi(key, obi, scanFile) {
  const album = lib.albums.get(key);
  album.custom = album.custom || {};
  const old = album.custom.obi || {};
  const next = { ...obi };
  if (scanFile) { await dropImage(old.image); next.image = await storePicture(scanFile, 1600); }
  else if (obi.image === undefined && old.image) next.image = old.image;
  if (!next.image && old.image) await dropImage(old.image);
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === '' || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
  if (Object.keys(next).length) album.custom.obi = next; else delete album.custom.obi;
  await saveAlbum(album);
}

export async function setTrackLyrics(id, text) {
  const t = lib.tracks.get(id);
  t.lyrics = text;   // null lets a Plex song fetch Plex's own lyrics again
  t.customLyrics = text != null;
  await db.put('tracks', id, t);
}

// ---------------------------------------------------------------- burned CD-Rs

export const CDR_MINUTES = 80;
export async function saveCdrs() { await db.put('extras', 'cdrs', lib.cdrs); }
export const findCdr = id => lib.cdrs.find(c => c.id === id) || null;
export const cdrTracks = cdr => (cdr ? cdr.tracks.map(id => lib.tracks.get(id)).filter(Boolean) : []);
export const cdrMinutes = cdr => cdrTracks(cdr).reduce((m, t) => m + (t.duration || 0), 0) / 60;

export async function newCdr(fields = {}) {
  const today = new Date();
  const cdr = { id: 'cdr-' + db.uid(), title: `Mix #${lib.cdrs.length + 1}`, dye: 'gold', marker: 'black',
                date: `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(2)}`,
                tracks: [], created: Date.now(), v: 1, ...fields };
  lib.cdrs.push(cdr);
  await saveCdrs();
  return cdr;
}

export async function updateCdr(cdr, fields) { Object.assign(cdr, fields); cdr.v = (cdr.v || 0) + 1; await saveCdrs(); }

// Adds songs (skipping ones already on the disc). Returns how many went on.
export async function burnTo(cdr, ids) {
  const have = new Set(cdr.tracks);
  const add = ids.filter(id => !have.has(id) && lib.tracks.has(id));
  cdr.tracks.push(...add);
  cdr.v = (cdr.v || 0) + 1;
  await saveCdrs();
  return add.length;
}

export async function deleteCdr(cdr) { lib.cdrs = lib.cdrs.filter(c => c !== cdr); await saveCdrs(); }

// ---------------------------------------------------------------- backups restored before their albums exist

function adoptPending(album) {
  const c = lib.pending[album.key];
  if (!c) return false;
  album.custom = { ...(album.custom || {}), ...c };
  delete lib.pending[album.key];
  return true;
}
function adoptPendingLyrics(track) {
  const text = lib.pending['lyrics:' + track.id];
  if (text == null) return;
  track.lyrics = text; track.customLyrics = true;
  delete lib.pending['lyrics:' + track.id];
}
export async function savePending() { await db.put('extras', 'pending', lib.pending); }
export async function finishPlexAdoption() { await savePending(); }

// Imported songs get new ids when imported again (say, on a new phone), so backups also keep a
// lasting reference to each song (album + file name). relink() swaps old ids for the songs as they are now.
export const songRef = t => ({ albumKey: t.albumKey, file: t.file, title: t.title, track: t.track });
function findByRef(ref) {
  for (const t of lib.tracks.values()) {
    if (t.albumKey !== ref.albumKey) continue;
    if ((ref.file && t.file === ref.file) || (t.title === ref.title && (t.track || 0) === (ref.track || 0))) return t;
  }
  return null;
}
export async function relink() {
  const refs = Object.entries(lib.pending).filter(([k]) => k.startsWith('ref:'));
  if (!refs.length) return 0;
  let linked = 0, cdrsTouched = false;
  for (const [k, ref] of refs) {
    const oldId = k.slice(4);
    if (lib.tracks.has(oldId)) { delete lib.pending[k]; continue; }
    const t = findByRef(ref);
    if (!t) continue;
    for (const c of lib.cdrs) c.tracks = c.tracks.map(id => { if (id === oldId) { cdrsTouched = true; return t.id; } return id; });
    const text = lib.pending['lyrics:' + oldId];
    if (text != null) { t.lyrics = text; t.customLyrics = true; await db.put('tracks', t.id, t); delete lib.pending['lyrics:' + oldId]; }
    delete lib.pending[k];
    linked++;
  }
  if (cdrsTouched) { lib.cdrs.forEach(c => { c.v = (c.v || 0) + 1; }); await saveCdrs(); }
  await savePending();
  return linked;
}

// ---------------------------------------------------------------- multi-disc albums

export const discOf = t => t.disc || 1;
export function discCount(album) {
  return new Set(albumTracks(album).map(discOf)).size;
}
// The picture for disc n of an album, if it has one (disc 2 can have its own, like cd2.jpg).
export function discArt(album, n) {
  if (n > 1 && album && album.discs && album.discs[n]) return album.discs[n];
  return art(album, 'disc');
}
