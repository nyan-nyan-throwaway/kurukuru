// Backups: your CD-Rs, obi designs, added pictures and lyrics, settings (and, if you like, imported songs) in one .zip.
import * as db from './db.js';
import { lib, savePending, saveCdrs, songRef, relink, saveStats } from './library.js';
import { listZip, extract, makeZip } from './zip.js';

const customImages = c => [c.cover, c.back, c.disc, ...(c.booklet || []), c.obi && c.obi.image].filter(Boolean);
const albumImages = a => [a.cover, a.back, a.disc, ...(a.booklet || [])].filter(id => id && !id.startsWith('plexart:'));

export async function makeBackup({ songs = false } = {}, progress = () => {}) {
  const custom = {}, lyrics = {};
  for (const a of lib.albums.values()) if (a.custom && Object.keys(a.custom).length) custom[a.key] = a.custom;
  for (const [k, v] of Object.entries(lib.pending)) if (!k.startsWith('lyrics:')) custom[k] = custom[k] || v;
  for (const t of lib.tracks.values()) if (t.customLyrics && t.lyrics != null) lyrics[t.id] = t.lyrics;
  for (const [k, v] of Object.entries(lib.pending)) if (k.startsWith('lyrics:')) lyrics[k.slice(7)] = lyrics[k.slice(7)] ?? v;
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem('kurukuru-settings') || '{}'); } catch (e) { /* none */ }
  const images = new Set(Object.values(custom).flatMap(customImages));
  for (const c of lib.cdrs) if (c.photo) images.add(c.photo);          // CD-R photos
  const files = [];
  let tracks = [], albums = [];
  if (songs) {
    albums = [...lib.albums.values()].filter(a => a.source !== 'plex');
    tracks = albums.flatMap(a => a.trackIds.map(id => lib.tracks.get(id)).filter(Boolean));
    albums.forEach(a => albumImages(a).forEach(id => images.add(id)));
    const bytes = tracks.reduce((n, t) => n + (t.size || 0), 0);
    if (bytes > 1.5e9) throw new Error('Your imported songs are too big for one backup file on a phone. Keep the original files instead, and back up without songs.');
  }
  const refs = {};
  for (const id of new Set([...lib.cdrs.flatMap(c => c.tracks), ...Object.keys(lyrics)])) {
    const t = lib.tracks.get(id);
    if (t) refs[id] = songRef(t);
    else if (lib.pending['ref:' + id]) refs[id] = lib.pending['ref:' + id];
  }
  for (const id of Object.keys(lib.stats.tracks)) { const t = lib.tracks.get(id); if (t && !refs[id]) refs[id] = songRef(t); }
  const manifest = { format: 'kurukuru-backup', version: 1, created: new Date().toISOString(), settings, cdrs: lib.cdrs, custom, lyrics, refs, stats: lib.stats,
                     songs: songs ? { albums: albums.map(a => ({ ...a, custom: undefined })), tracks } : null };
  files.push({ name: 'kurukuru-backup.json', data: JSON.stringify(manifest, null, 1) });
  for (const id of images) {
    const blob = await db.get('images', id);
    if (blob) files.push({ name: `images/${id}`, data: blob });
  }
  if (songs) {
    for (const t of tracks) {
      progress({ stage: 'Gathering songs', done: files.length, total: files.length + tracks.length, name: t.title });
      const blob = await db.get('audio', t.id);
      if (blob) files.push({ name: `audio/${t.id}`, data: blob });
    }
  }
  return makeZip(files, (i, n, name) => progress({ stage: 'Writing the backup', done: i, total: n, name: name.split('/').pop() }));
}

export async function restoreBackup(file, progress = () => {}) {
  const entries = await listZip(file);
  const byName = new Map(entries.map(e => [e.name, e]));
  const head = byName.get('kurukuru-backup.json');
  if (!head) throw new Error('That isn’t a Kurukuru backup file.');
  const manifest = JSON.parse(await (await extract(file, head)).text());
  if (manifest.format !== 'kurukuru-backup') throw new Error('That isn’t a Kurukuru backup file.');
  const summary = { cdrs: 0, albums: 0, lyrics: 0, songs: 0, waiting: 0 };
  const rest = entries.filter(e => e.name !== 'kurukuru-backup.json');
  let i = 0;
  for (const e of rest) {
    progress({ stage: 'Restoring', done: i++, total: rest.length, name: e.base });
    const [dir, id] = e.name.split('/');
    if (dir === 'images') await db.put('images', id, await extract(file, e, ''));
    else if (dir === 'audio' && !(await db.get('tracks', id))) await db.put('audio', id, await extract(file, e, ''));
  }
  if (manifest.songs) {
    for (const t of manifest.songs.tracks) {
      if (lib.tracks.has(t.id)) continue;
      await db.put('tracks', t.id, t); lib.tracks.set(t.id, t); summary.songs++;
    }
    for (const a of manifest.songs.albums) {
      const have = lib.albums.get(a.key);
      const rec = have ? { ...have, trackIds: [...new Set([...have.trackIds, ...a.trackIds])] } : { ...a };
      await db.put('albums', rec.key, rec); lib.albums.set(rec.key, rec);
    }
  }
  for (const [key, c] of Object.entries(manifest.custom || {})) {
    const album = lib.albums.get(key);
    if (album) { album.custom = c; await db.put('albums', key, album); summary.albums++; }
    else { lib.pending[key] = c; summary.waiting++; }
  }
  for (const [id, text] of Object.entries(manifest.lyrics || {})) {
    const t = lib.tracks.get(id);
    if (t) { t.lyrics = text; t.customLyrics = true; await db.put('tracks', id, t); summary.lyrics++; }
    else { lib.pending['lyrics:' + id] = text; summary.waiting++; }
  }
  for (const c of manifest.cdrs || []) {
    const i2 = lib.cdrs.findIndex(x => x.id === c.id);
    if (i2 >= 0) lib.cdrs[i2] = c; else lib.cdrs.push(c);
    summary.cdrs++;
  }
  for (const [id, ref] of Object.entries(manifest.refs || {})) if (!lib.tracks.has(id)) lib.pending['ref:' + id] = ref;
  if (manifest.stats) {   // play counts: keep the higher count for each song
    for (const [id, v] of Object.entries(manifest.stats.tracks || {})) {
      const have = lib.stats.tracks[id];
      if (!have || have.plays < v.plays) lib.stats.tracks[id] = v;
    }
    for (const [id, v] of Object.entries(manifest.stats.cdrs || {})) if (!lib.stats.cdrs[id] || lib.stats.cdrs[id].plays < v.plays) lib.stats.cdrs[id] = v;
    lib.stats.ms = Math.max(lib.stats.ms || 0, manifest.stats.ms || 0);
    lib.stats.since = Math.min(lib.stats.since || Date.now(), manifest.stats.since || Date.now());
    await saveStats(true);
  }
  await saveCdrs();
  await savePending();
  await relink();
  if (manifest.settings) { try { localStorage.setItem('kurukuru-settings', JSON.stringify(manifest.settings)); } catch (e) { /* ignore */ } }
  return summary;
}
