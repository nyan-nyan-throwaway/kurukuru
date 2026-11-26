// Booklets, obi designs and pictures from the PC, through a Plex Photos library over the Music folder.
//  • Scans sitting in album folders (booklet01.jpg, back.jpg, cd2.jpg, a Scans/ folder…) are matched by folder.
//  • Things added in the desktop app are in "Kurukuru Extras", described by kurukuru-index.png (its PNG text
//    holds the obi designs and which picture belongs to which album).
import { photos } from './plex.js';
import { lib, saveAlbums, FRONT, BACK, DISC, BOOKLET, BOOKLET_DIRS, DISC_DIR, natural } from './library.js';

const INDEX = 'kurukuru-index.png';
const base = path => path.slice(path.lastIndexOf('/') + 1);
const dirOf = path => path.slice(0, path.lastIndexOf('/'));
const stem = name => name.replace(/\.[^.]+$/, '');
const IMAGE = /\.(jpe?g|png|webp|gif|bmp)$/i;

// The text a PNG carries under a keyword (tEXt, zTXt or iTXt).
export async function pngText(bytes, keyword) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin = new TextDecoder('latin1'), utf8 = new TextDecoder('utf-8');
  const inflate = async data => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  for (let p = 8; p + 8 <= bytes.length;) {
    const len = view.getUint32(p), type = latin.decode(bytes.subarray(p + 4, p + 8)), data = bytes.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) { if (type === 'IEND') break; continue; }
    const z = data.indexOf(0);
    if (latin.decode(data.subarray(0, z)) !== keyword) continue;
    if (type === 'tEXt') return latin.decode(data.subarray(z + 1));
    if (type === 'zTXt') return latin.decode(await inflate(data.subarray(z + 2)));
    const compressed = data[z + 1];
    let q = data.indexOf(0, z + 3); q = data.indexOf(0, q + 1);
    const body = data.subarray(q + 1);
    return utf8.decode(compressed ? await inflate(body) : body);
  }
  return null;
}

const idOf = photo => 'plexphoto:' + photo.thumb;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns { photos, albums (changed), index (found?) }.
export async function syncArt() {
  const sections = await photos.sections();
  if (!sections.length) return { photos: 0, albums: 0, index: false, noLibrary: true };
  const all = [];
  for (const sec of sections) all.push(...await photos.all(sec.key));
  const byDir = new Map();
  for (const p of all) {
    if (!IMAGE.test(p.file)) continue;
    const d = dirOf(p.file).toLowerCase();
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p);
  }
  // The desktop app's index of obi designs and added pictures.
  let index = null, extras = new Map();
  const idx = all.find(p => base(p.file) === INDEX);
  if (idx) {
    try {
      index = JSON.parse(await pngText(await photos.original(idx.part), 'kurukuru'));
      extras = new Map((byDir.get(dirOf(idx.file).toLowerCase()) || []).map(p => [base(p.file), p]));
    } catch (e) { console.warn('Kurukuru index unreadable', e); }
  }
  const entries = (index && index.albums) || [];
  const changed = [];
  for (const album of lib.albums.values()) {
    if (album.source !== 'plex' || !album.folder) continue;
    const folder = album.folder.toLowerCase();
    const pc = { booklet: [], discs: {} };
    // Scans in the album's folder, and in CD2/ or Scans/-style folders inside it.
    const places = [[folder, null]];
    for (const d of byDir.keys()) {
      if (dirOf(d) !== folder) continue;
      const name = base(d), disc = name.match(DISC_DIR);
      if (disc) places.push([d, +disc[1]]);
      else if (BOOKLET_DIRS.has(name)) places.push([d, 'booklet']);
    }
    for (const [d, kind] of places) {
      for (const p of (byDir.get(d) || []).slice().sort((a, b) => natural(a.file, b.file))) {
        const name = stem(base(p.file));
        if (base(p.file) === INDEX) continue;
        if (kind === 'booklet' || BOOKLET.test(name)) pc.booklet.push(idOf(p));
        else if (BACK.test(name)) pc.back = pc.back || idOf(p);
        else if (DISC.test(name)) {
          const n = +((name.match(DISC) || [])[1] || (typeof kind === 'number' ? kind : 1));
          if (n <= 1) pc.disc = pc.disc || idOf(p); else pc.discs[n] = pc.discs[n] || idOf(p);
        } else if (FRONT.test(name) && !pc.folderCover) pc.folderCover = idOf(p);
      }
    }
    // What you set up in the desktop app.
    const title = (album.album || '').toLowerCase();
    const entry = entries.find(e => (e.folder || '').toLowerCase() === folder && (e.album || '').toLowerCase() === title)
               || entries.find(e => base(e.folder || '').toLowerCase() === base(folder) && (e.album || '').toLowerCase() === title);
    if (entry) {
      const pic = name => (name && extras.get(name) ? idOf(extras.get(name)) : null);
      if (pic(entry.front)) pc.cover = pic(entry.front);
      if (pic(entry.back)) pc.back = pic(entry.back);
      if (pic(entry.disc)) pc.disc = pic(entry.disc);
      pc.booklet.push(...(entry.booklet || []).map(pic).filter(Boolean));
      if (entry.obi || entry.obiScan) {
        pc.obi = { ...(entry.obi || {}) };
        if (pic(entry.obiScan)) pc.obi.image = pic(entry.obiScan);
      }
    }
    if (!pc.booklet.length) delete pc.booklet;
    if (!Object.keys(pc.discs).length) delete pc.discs;
    const next = Object.keys(pc).length ? pc : undefined;
    if (!same(next, album.pc)) {
      if (next) album.pc = next; else delete album.pc;
      changed.push(album);
    }
  }
  if (changed.length) await saveAlbums(changed);
  return { photos: all.length, albums: changed.length, index: !!index, matched: [...lib.albums.values()].filter(a => a.pc).length };
}
