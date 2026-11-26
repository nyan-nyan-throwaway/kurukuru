// Plex: sign in with a code, find your server, list its music, stream it.
// Everything here talks to plex.tv and to your own Plex Media Server; nothing goes anywhere else.

const STORE = 'kurukuru-plex';
let PLEX_TV = 'https://plex.tv';
try { PLEX_TV = localStorage.getItem('kurukuru-plex-tv') || PLEX_TV; } catch (e) { /* default */ }

let cfg = {};
try { cfg = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { cfg = {}; }
if (!cfg.clientId) cfg.clientId = 'kurukuru-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };
save();

const headers = token => {
  const h = { Accept: 'application/json', 'X-Plex-Product': 'Kurukuru CD', 'X-Plex-Version': '1.1',
              'X-Plex-Client-Identifier': cfg.clientId, 'X-Plex-Platform': 'Web', 'X-Plex-Device-Name': 'Kurukuru CD (iPhone)' };
  if (token) h['X-Plex-Token'] = token;
  return h;
};

async function request(url, { method = 'GET', token, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers: headers(token), signal: ctrl.signal });
    if (res.status === 401) throw new Error('Plex said no: please connect to Plex again in Settings.');
    if (!res.ok) throw new Error(`Plex answered ${res.status}`);
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  } finally { clearTimeout(timer); }
}

export const plex = {
  get connected() { return !!(cfg.token && cfg.server); },
  get serverName() { return cfg.server ? cfg.server.name : ''; },
  get userToken() { return cfg.token; },
};

// ---------------------------------------------------------------- signing in

// Returns { code, wait() } — show the code, the person types it at plex.tv/link, wait() resolves when done.
export async function startLink() {
  const pin = await request(`${PLEX_TV}/api/v2/pins?strong=false`, { method: 'POST' });
  let cancelled = false;
  return {
    code: pin.code,
    cancel() { cancelled = true; },
    async wait() {
      const until = Date.now() + 15 * 60000;
      while (!cancelled && Date.now() < until) {
        await new Promise(r => setTimeout(r, 2000));
        const p = await request(`${PLEX_TV}/api/v2/pins/${pin.id}`).catch(() => null);
        if (p && p.authToken) {
          cfg.token = p.authToken; save();
          await findServer();
          return true;
        }
      }
      return false;
    },
  };
}

export function disconnect() {
  delete cfg.token; delete cfg.server; save();
}

// Picks your Plex server and the connection to it that works from here (home Wi-Fi first, then remote).
export async function findServer() {
  const list = await request(`${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1`, { token: cfg.token });
  const servers = (Array.isArray(list) ? list : []).filter(r => (r.provides || '').includes('server'))
    .sort((a, b) => (b.owned ? 1 : 0) - (a.owned ? 1 : 0));
  if (!servers.length) throw new Error('No Plex server found on this account. Is Plex Media Server running and signed in?');
  for (const s of servers) {
    const conns = (s.connections || []).filter(c => c.protocol === 'https' && c.uri)
      .sort((a, b) => rank(a) - rank(b));
    const token = s.accessToken || cfg.token;
    // Try them all at once and take the best one that answers.
    const tries = conns.map(c => request(`${c.uri}/identity`, { token, timeout: 6000 }).then(() => c).catch(() => null));
    const ok = (await Promise.all(tries)).filter(Boolean).sort((a, b) => rank(a) - rank(b));
    if (ok.length) {
      cfg.server = { name: s.name, id: s.clientIdentifier, uri: ok[0].uri, token, local: !!ok[0].local, relay: !!ok[0].relay,
                     all: conns.map(c => c.uri) };
      save();
      return cfg.server;
    }
  }
  throw new Error('Found your Plex server but couldn’t reach it. Is the computer on, and is the phone on the same Wi-Fi?');
}
const rank = c => (c.relay ? 2 : c.local ? 0 : 1);

// Call before a sync / when a request fails: re-checks the connection (e.g. you left home).
export async function reconnect() {
  try { await request(`${cfg.server.uri}/identity`, { token: cfg.server.token, timeout: 4000 }); return cfg.server; }
  catch (e) { return findServer(); }
}

// ---------------------------------------------------------------- library

const srv = (path, params = {}) => {
  const u = new URL(cfg.server.uri + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('X-Plex-Token', cfg.server.token);
  return u.toString();
};

async function getAll(path, params) {
  const out = [];
  for (let start = 0; ; start += 1000) {
    const page = await request(srv(path, { ...params, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': 1000 }),
                               { timeout: 60000 });
    const mc = page.MediaContainer || {};
    const items = mc.Metadata || [];
    out.push(...items);
    const total = mc.totalSize ?? mc.size ?? items.length;
    if (!items.length || out.length >= total) break;
  }
  return out;
}

// Returns { albums: [...], tracks: [...] } shaped like Kurukuru's own library records.
export async function fetchLibrary(progress = () => {}) {
  await reconnect();
  progress({ stage: 'Finding music on ' + cfg.server.name });
  const sections = ((await request(srv('/library/sections'))).MediaContainer.Directory || []).filter(d => d.type === 'artist');
  if (!sections.length) throw new Error('Your Plex server has no Music library yet.');
  const albums = [], tracks = [];
  for (const sec of sections) {
    progress({ stage: `Reading “${sec.title}” albums` });
    const albumItems = await getAll(`/library/sections/${sec.key}/all`, { type: 9 });
    progress({ stage: `Reading “${sec.title}” songs` });
    const trackItems = await getAll(`/library/sections/${sec.key}/all`, { type: 10 });
    const byAlbum = new Map();
    for (const a of albumItems) {
      const rec = { key: 'plex:' + a.ratingKey, source: 'plex', plexKey: a.ratingKey, album: a.title || 'Unknown album',
                    artist: a.parentTitle || 'Unknown artist', year: a.year ? String(a.year) : '',
                    cover: a.thumb ? 'plexart:' + a.thumb : null, back: null, disc: null, booklet: [], trackIds: [],
                    added: (a.addedAt || 0) * 1000 };
      byAlbum.set(String(a.ratingKey), rec);
      albums.push(rec);
    }
    for (const t of trackItems) {
      const album = byAlbum.get(String(t.parentRatingKey));
      if (!album) continue;
      const part = t.Media && t.Media[0] && t.Media[0].Part && t.Media[0].Part[0];
      if (!part) continue;
      const id = 'plex-' + t.ratingKey;
      tracks.push({ id, source: 'plex', plexKey: t.ratingKey, part: part.key, size: part.size || 0,
                    container: (t.Media[0].container || '').toLowerCase(), albumKey: album.key,
                    title: t.title || 'Untitled', artist: t.originalTitle || t.grandparentTitle || album.artist, album: album.album,
                    track: t.index || 0, disc: t.parentIndex || 0, year: album.year, duration: (t.duration || 0) / 1000,
                    lyrics: null, file: (part.file || '').split('/').pop(), path: part.file || '', added: (t.addedAt || 0) * 1000 });
      album.trackIds.push(id);
      if (!album.folder && part.file) album.folder = albumFolder(part.file);
    }
  }
  return { albums: albums.filter(a => a.trackIds.length), tracks };
}

export function streamUrl(track) { return srv(track.part); }

// The album's own folder for a song file: its folder, or the one above a CD1/Disc 2-style folder.
export function albumFolder(file) {
  const dir = file.slice(0, file.lastIndexOf('/'));
  const name = dir.slice(dir.lastIndexOf('/') + 1);
  return /^(?:cd|disc|disk)\s*[-_.]?\s*\d{1,2}\b/i.test(name) ? dir.slice(0, dir.lastIndexOf('/')) : dir;
}

export async function fetchArt(thumb, size = 600) {
  const url = srv('/photo/:/transcode', { width: size, height: size, minSize: 1, upscale: 1, url: thumb });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('art ' + res.status);
    return await res.blob();
  } finally { clearTimeout(timer); }
}

// Lyrics Plex found for a song (sidecar .lrc/.txt or embedded), as text, or null.
export async function fetchLyrics(track) {
  try {
    const meta = await request(srv(`/library/metadata/${track.plexKey}`, { includeLyrics: 1 }));
    const item = (meta.MediaContainer.Metadata || [])[0];
    const streams = (((item && item.Media || [])[0] || {}).Part || []).flatMap(p => p.Stream || []);
    const lyric = streams.find(s => s.streamType === 4 && s.key);
    if (!lyric) return null;
    const res = await fetch(srv(lyric.key));
    if (!res.ok) return null;
    const text = await res.text();
    // Plex can hand back its own XML/JSON wrapper for some lyric types; keep plain text only.
    if (/^\s*[<{]/.test(text)) {
      try {
        const j = JSON.parse(text);
        const lines = (((j.MediaContainer || {}).Lyrics || [])[0] || {}).Line || [];
        if (lines.length) return lines.map(l => (l.startOffset != null ? lrcTime(l.startOffset) : '') + (l.Span || []).map(s => s.text).join('')).join('\n');
      } catch (e) { /* not JSON */ }
      return null;
    }
    return text;
  } catch (e) { return null; }
}
const lrcTime = ms => `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(2).padStart(5, '0')}]`;

// The whole song file (for keeping it on the phone, or measuring loudness for the level meter).
export async function fetchSong(track, onProgress) {
  const res = await fetch(streamUrl(track));
  if (!res.ok) throw new Error(`Couldn’t download “${track.title}” (${res.status})`);
  if (!res.body || !onProgress) return res.blob();
  const total = +res.headers.get('content-length') || track.size || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(total ? got / total : 0);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || 'audio/mpeg' });
}

// ---------------------------------------------------------------- playlists (for CD-R sync)

let machine = null;
async function machineId() {
  if (!machine || machine.uri !== cfg.server.uri) {
    const ident = await request(srv('/identity'));
    machine = { uri: cfg.server.uri, id: (ident.MediaContainer || {}).machineIdentifier || cfg.server.id };
  }
  return machine.id;
}
const call = (method, path, params = {}) => request(srv(path, params), { method, timeout: 30000 });
const listUri = async keys => `server://${await machineId()}/com.plexapp.plugins.library/library/metadata/${keys.join(',')}`;

export const playlists = {
  async list() {
    const mc = (await call('GET', '/playlists', { playlistType: 'audio' })).MediaContainer || {};
    return (mc.Metadata || []).filter(p => !p.smart);
  },
  async keys(key) {
    const mc = (await call('GET', `/playlists/${key}/items`)).MediaContainer || {};
    return (mc.Metadata || []).map(t => String(t.ratingKey));
  },
  async create(title, keys, summary) {
    const mc = (await call('POST', '/playlists', { type: 'audio', smart: 0, title, uri: await listUri(keys) })).MediaContainer || {};
    const key = String(((mc.Metadata || [])[0] || {}).ratingKey || '');
    if (!key) throw new Error('Plex didn’t make the playlist.');
    await call('PUT', `/playlists/${key}`, { title, summary });
    return key;
  },
  async update(key, title, summary, keys) {
    await call('PUT', `/playlists/${key}`, { title, summary });
    await call('DELETE', `/playlists/${key}/items`);
    if (keys.length) await call('PUT', `/playlists/${key}/items`, { uri: await listUri(keys) });
  },
  async setSummary(key, title, summary) { await call('PUT', `/playlists/${key}`, { title, summary }); },
  async remove(key) { await call('DELETE', `/playlists/${key}`); },
};

// ---------------------------------------------------------------- photos (booklets, obi designs and pictures from the PC)

export const photos = {
  async sections() {
    const dirs = ((await request(srv('/library/sections'))).MediaContainer || {}).Directory || [];
    return dirs.filter(d => d.type === 'photo');
  },
  // Every photo in a Photos library: { thumb, part, file, updated }.
  async all(sectionKey) {
    const shape = p => {
      const part = (((p.Media || [])[0] || {}).Part || [])[0] || {};
      return part.file ? { thumb: p.thumb || `/library/metadata/${p.ratingKey}/thumb/${p.updatedAt || 0}`, part: part.key, file: part.file, updated: p.updatedAt || 0 } : null;
    };
    let items = await getAll(`/library/sections/${sectionKey}/all`, { type: 13 });
    if (items.some(shape)) return items.map(shape).filter(Boolean);
    // Older servers list folders (photo albums) instead: walk them.
    const out = [], queue = [`/library/sections/${sectionKey}/all`];
    while (queue.length && out.length < 50000) {
      for (const it of await getAll(queue.shift(), {})) {
        if (it.key && it.key.endsWith('/children')) queue.push(it.key);
        else { const p = shape(it); if (p) out.push(p); }
      }
    }
    return out;
  },
  async original(partKey) {
    const res = await fetch(srv(partKey));
    if (!res.ok) throw new Error('photo ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  },
};
