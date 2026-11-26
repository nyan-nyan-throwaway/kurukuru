// The music library: importing songs (one by one or as .zip album folders), albums, images.
import * as db from './db.js';
import { readTags, probeDuration } from './tags.js';
import { listZip, extract } from './zip.js';

export const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
                       ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff' };
const IMAGE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const FRONT = /^(cover|folder|front|album|albumart|artwork)\b/i;
const BACK = /^(back|back cover|cover_back|backcover|tray|inlay|rear)\b/i;
const DISC = /^(cd|disc|disk|media)\s*\d*$/i;
const BOOKLET = /^(booklet|book|page|scan|inside|insert|liner|leaflet|lyrics)[\s_\-]*\d*/i;
const BOOKLET_DIRS = new Set(['scans', 'scan', 'booklet', 'artwork', 'art', 'covers', 'images']);

export const lib = { tracks: new Map(), albums: new Map() };

const ext = name => (name.split('.').pop() || '').toLowerCase();
const stem = name => name.split('/').pop().replace(/\.[^.]+$/, '');
const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export async function loadLibrary() {
  lib.tracks = new Map(await db.all('tracks'));
  lib.albums = new Map(await db.all('albums'));
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
    const blob = await db.get('images', id);
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

export async function imageBlob(id) { return id ? db.get('images', id) : null; }

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
  let n = 0, added = 0;
  const failures = [];
  for (const item of audio) {
    n++;
    progress({ stage: `Adding songs`, done: n - 1, total: audio.length, name: stem(item.path) });
    try {
    const blob = await item.get();
    const tags = await readTags(blob);
    if (!tags.duration) tags.duration = await probeDuration(blob);
    const folder = dirOf(item.path);
    const folderName = folder.split('/').pop();
    const title = tags.title || stem(item.path).replace(/^\d+[\s.\-_]+/, '');
    const artist = tags.artist || tags.albumArtist || 'Unknown artist';
    const album = tags.album || folderName || 'Unknown album';
    const albumArtist = tags.albumArtist || artist;
    const key = (folder ? folder.toLowerCase() : albumArtist.toLowerCase()) + '\n' + album.toLowerCase();
    let rec = touched.get(key) || lib.albums.get(key);
    if (!rec) rec = { key, album, artist: albumArtist, year: tags.year || '', cover: null, back: null, disc: null, booklet: [], trackIds: [], added: Date.now() };
    touched.set(key, rec);
    if (folder) folderAlbums.set(folder, rec);
    // Skip songs that are already in the library.
    const dupe = rec.trackIds.map(id => lib.tracks.get(id)).find(t => t && t.title === title && t.track === tags.track
                 && Math.abs((t.duration || 0) - (tags.duration || 0)) < 1.5);
    if (dupe) continue;
    if (!rec.cover && tags.picture) rec.cover = await storeImage(new Blob([tags.picture.data], { type: tags.picture.mime }));
    if (!rec.year && tags.year) rec.year = tags.year;
    const id = 'trk-' + db.uid();
    const lyric = lyricText.get((folder + '/' + stem(item.path)).toLowerCase());
    const track = { id, albumKey: key, title, artist, album, track: tags.track || 0, disc: tags.disc || 0, year: tags.year || '',
                    duration: tags.duration || 0, lyrics: lyric || tags.lyrics || null, file: item.path.split('/').pop(),
                    type: blob.type || AUDIO[ext(item.path)], added: Date.now() };
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
    else if (kind === 'disc') { if (!rec.disc) rec.disc = id; }
  }
  for (const rec of touched.values()) {
    if (!rec.trackIds.length) continue;
    await db.put('albums', rec.key, rec);
    lib.albums.set(rec.key, rec);
  }
  progress({ stage: 'Done', done: audio.length, total: audio.length });
  return { albums: [...touched.values()].filter(a => a.trackIds.length), songs: added, failures };
}

function decodeText(bytes) {
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
  for (const id of [rec.cover, rec.back, rec.disc, ...(rec.booklet || [])]) if (id) { await db.del('images', id); bitmaps.delete(id); }
  await db.del('albums', key);
  lib.albums.delete(key);
}

export async function audioBlob(id) { return db.get('audio', id); }

export async function cachedLevels(id) { return db.get('extras', 'levels:' + id); }
export async function saveLevels(id, levels) { return db.put('extras', 'levels:' + id, levels); }
