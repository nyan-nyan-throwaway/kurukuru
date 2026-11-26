// CD-Rs ⇄ Plex playlists: the same rules as the desktop app (plexsync.py), so both always agree.
// Each CD-R is a Plex playlist whose description ends with  kurukuru:{"id","dye","marker","date","updated"}.
// Whichever side changed a CD-R last wins; one thrown away on one side is thrown away on the other.
import { playlists } from './plex.js';

const TAG = /kurukuru:(\{[\s\S]*\})/;

export function summaryFor(cdr) {
  const meta = { id: cdr.id, dye: cdr.dye, marker: cdr.marker, date: cdr.date, updated: cdr.updated, doodles: cdr.doodles, case: cdr.case,
                 created: cdr.created || undefined, photo: cdr.photoHash || null };
  return 'A CD-R burned in Kurukuru CD 💿\nkurukuru:' + JSON.stringify(meta);
}

export function parseSummary(text) {
  const m = TAG.exec(text || '');
  if (!m) return null;
  try { const meta = JSON.parse(m[1]); return meta && meta.id ? meta : null; } catch (e) { return null; }
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// toKeys(cdr) → Plex keys of its songs; fromKeys(oldTracks|null, keys) → this side's track list.
// photo = { blob(cdr) → Blob|null, store(cdr, blob, hash), drop(cdr) }: moves CD-R photos as playlist posters.
export async function syncCdrs(cdrs, tombstones, toKeys, fromKeys, now = Date.now(), photo = null) {
  const pushPhoto = async (c, key, theirs) => {
    if (!photo || !c.photoHash || c.photoHash === theirs) return;
    try { const b = await photo.blob(c); if (b) await playlists.setPoster(key, b); } catch (e) { /* tries again next sync */ }
  };
  const pullPhoto = async (c, key, theirs) => {
    if (!photo) return;
    if (!theirs) { if (c.photo) await photo.drop(c); return; }
    if (theirs === c.photoHash) return;
    try { const b = await playlists.poster(key); if (b) await photo.store(c, b, theirs); } catch (e) { /* next time */ }
  };
  const remote = new Map();
  for (const pl of await playlists.list()) {
    const meta = parseSummary(pl.summary);
    if (meta) remote.set(meta.id, { key: String(pl.ratingKey), title: pl.title || '', meta });
  }
  for (const t of tombstones) {
    const r = remote.get(t.id);
    if (r) { await playlists.remove(r.key); remote.delete(t.id); }
  }
  const out = [];
  for (const cdr of cdrs) {
    const c = { ...cdr, tracks: [...(cdr.tracks || [])] };
    const updated = c.updated || 0;
    const r = remote.get(c.id);
    remote.delete(c.id);
    if (!r) {
      if (c.plexKey && updated <= (c.syncedAt || 0)) continue;   // thrown away on the other side
      const keys = toKeys(c);
      if (keys.length) { c.plexKey = await playlists.create(c.title, keys, summaryFor(c)); c.syncedAt = updated; await pushPhoto(c, c.plexKey, null); }
      else delete c.plexKey;                                     // nothing Plex knows yet: stays here for now
      out.push(c);
      continue;
    }
    const rUpdated = r.meta.updated || 0;
    if (updated > rUpdated) { await playlists.update(r.key, c.title, summaryFor(c), toKeys(c)); await pushPhoto(c, r.key, r.meta.photo); }
    else {
      const remoteKeys = await playlists.keys(r.key);
      if (rUpdated > updated) {
        Object.assign(c, { title: r.title || c.title, dye: r.meta.dye || c.dye, marker: r.meta.marker || c.marker,
                           date: r.meta.date ?? c.date, updated: rUpdated, tracks: fromKeys(c.tracks, remoteKeys),
                           ...(Array.isArray(r.meta.doodles) ? { doodles: r.meta.doodles } : {}), ...(r.meta.case ? { case: r.meta.case } : {}),
                           ...(r.meta.created ? { created: r.meta.created } : {}) });
        await pullPhoto(c, r.key, r.meta.photo);
      } else if (!same(remoteKeys, toKeys(c)) || (r.title && r.title !== c.title)) {
        // Edited in Plex itself (Plexamp, Plex Web): take that, and mark it so the other side follows.
        Object.assign(c, { title: r.title || c.title, tracks: fromKeys(c.tracks, remoteKeys), updated: now });
        await playlists.setSummary(r.key, c.title, summaryFor(c));
      }
    }
    c.plexKey = r.key;
    c.syncedAt = c.updated || 0;
    out.push(c);
  }
  for (const [id, r] of remote) {                                // new from the other side
    const m = r.meta;
    const c = { id, title: r.title || 'Mix', dye: m.dye || 'gold', marker: m.marker || 'black', date: m.date || '',
                updated: m.updated || 0, tracks: fromKeys(null, await playlists.keys(r.key)), plexKey: r.key, created: m.created || Date.now(),
                ...(Array.isArray(m.doodles) ? { doodles: m.doodles } : {}), case: m.case || 'black' };
    await pullPhoto(c, r.key, m.photo);
    c.syncedAt = c.updated;
    out.push(c);
  }
  return out;
}
