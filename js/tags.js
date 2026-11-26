// Reads song details, cover art and lyrics from MP3 (ID3), FLAC, M4A/MP4 and Ogg/Opus files.
// Returns { title, artist, albumArtist, album, track, disc, year, duration, picture, lyrics }.

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

async function bytes(blob, start, length) {
  const end = Math.min(blob.size, start + length);
  if (start >= end) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const ascii = (b, s, n) => String.fromCharCode(...b.subarray(s, s + n));
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u24 = (b, o) => (b[o] << 16) + (b[o + 1] << 8) + b[o + 2];
const u32le = (b, o) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);
const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

function emptyInfo() {
  return { title: '', artist: '', albumArtist: '', album: '', track: 0, disc: 0, year: '', duration: 0,
           picture: null, lyrics: null };
}

export async function readTags(file) {
  const info = emptyInfo();
  try {
    const head = await bytes(file, 0, 12);
    const magic = ascii(head, 0, 4);
    if (ascii(head, 0, 3) === 'ID3') await readID3(file, info);
    else if (magic === 'fLaC') await readFLAC(file, info, 0);
    else if (magic === 'OggS') await readOgg(file, info);
    else if (ascii(head, 4, 4) === 'ftyp') await readMP4(file, info);
    // An ID3 tag can also sit in front of a FLAC stream.
  } catch (e) {
    console.warn('Could not read tags of', file.name, e);
  }
  return info;
}

// ---------------------------------------------------------------- ID3v2 (MP3)

function decodeText(b, enc) {
  if (!b.length) return '';
  let text;
  if (enc === 1) {
    if (b[0] === 0xFF && b[1] === 0xFE) text = utf16le.decode(b.subarray(2));
    else if (b[0] === 0xFE && b[1] === 0xFF) text = utf16be.decode(b.subarray(2));
    else text = utf16le.decode(b);
  } else if (enc === 2) text = utf16be.decode(b);
  else if (enc === 3) text = utf8.decode(b);
  else text = latin1.decode(b);
  return text.replace(/\u0000+$/, '');
}

// Index just past the end of a terminated string in the given encoding.
function termEnd(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, start);
  return i < 0 ? b.length : i;
}

function unsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xFF && b[i + 1] === 0x00) i++;
  }
  return new Uint8Array(out);
}

async function readID3(file, info) {
  const h = await bytes(file, 0, 10);
  const major = h[3];
  const flags = h[5];
  const size = syncsafe(h, 6);
  let b = await bytes(file, 10, size);
  if (flags & 0x80 && major < 4) b = unsync(b);
  let pos = 0;
  if (flags & 0x40) pos += major === 4 ? syncsafe(b, 0) : u32(b, 0) + 4;  // extended header
  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;
  const map2 = { TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER',
                 PIC: 'APIC', ULT: 'USLT', SLT: 'SYLT' };
  let sylt = null;
  while (pos + hdrLen <= b.length) {
    let id = ascii(b, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fsize = major === 2 ? u24(b, pos + 3) : (major === 4 ? syncsafe(b, pos + 4) : u32(b, pos + 4));
    const fflags = major === 2 ? 0 : b[pos + 9];
    let data = b.subarray(pos + hdrLen, pos + hdrLen + fsize);
    pos += hdrLen + fsize;
    if (major === 2) id = map2[id] || id;
    if (major === 4 && fflags & 0x02) data = unsync(data);
    if (major === 4 && fflags & 0x01) data = data.subarray(4);  // data length indicator
    if (!data.length) continue;
    const enc = data[0];
    if (id[0] === 'T' && id !== 'TXXX') {
      const text = decodeText(data.subarray(1), enc).split('\u0000')[0].trim();
      if (id === 'TIT2') info.title = text;
      else if (id === 'TPE1') info.artist = text;
      else if (id === 'TPE2') info.albumArtist = text;
      else if (id === 'TALB') info.album = text;
      else if (id === 'TRCK') info.track = parseInt(text, 10) || 0;
      else if (id === 'TPOS') info.disc = parseInt(text, 10) || 0;
      else if ((id === 'TDRC' || id === 'TYER' || id === 'TDOR') && !info.year) info.year = text.slice(0, 4);
      else if (id === 'TLEN' && !info.duration) info.duration = (parseInt(text, 10) || 0) / 1000;
    } else if (id === 'APIC' && !info.picture) {
      let p = 1, mime;
      if (major === 2) { mime = 'image/' + ascii(data, 1, 3).toLowerCase().replace('jpg', 'jpeg'); p = 4; }
      else { const e = data.indexOf(0, 1); mime = latin1.decode(data.subarray(1, e)); p = e + 1; }
      p += 1;  // picture type
      p = termEnd(data, p, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      info.picture = { mime: mime.includes('/') ? mime : 'image/jpeg', data: data.slice(p) };
    } else if (id === 'USLT' && !info.lyrics) {
      let p = 4;
      p = termEnd(data, p, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      const text = decodeText(data.subarray(p), enc);
      if (text.trim()) info.lyrics = text;
    } else if (id === 'SYLT' && !sylt) {
      // Synced lyrics: [text, terminator, 4-byte time]... with time format 2 = milliseconds.
      if (data[4] !== 2) continue;
      let p = termEnd(data, 6, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      const lines = [];
      while (p < data.length) {
        const e = termEnd(data, p, enc);
        const text = decodeText(data.subarray(p, e), enc);
        p = e + (enc === 1 || enc === 2 ? 2 : 1);
        if (p + 4 > data.length) break;
        lines.push([u32(data, p), text.replace(/^\n/, '')]);
        p += 4;
      }
      if (lines.length) sylt = lines;
    }
  }
  if (sylt) info.lyrics = sylt.map(([ms, t]) => `[${lrcStamp(ms)}]${t}`).join('\n');
  // FLAC with an ID3 tag stuck on the front
  const after = await bytes(file, 10 + size, 4);
  if (ascii(after, 0, 4) === 'fLaC') await readFLAC(file, info, 10 + size);
}

function lrcStamp(ms) {
  const cs = Math.round(ms / 10);
  const m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Vorbis comments (FLAC, Ogg)

function applyComments(b, pos, info) {
  const vlen = u32le(b, pos); pos += 4 + vlen;
  const count = u32le(b, pos); pos += 4;
  for (let i = 0; i < count && pos + 4 <= b.length; i++) {
    const len = u32le(b, pos); pos += 4;
    const entry = utf8.decode(b.subarray(pos, pos + len)); pos += len;
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1);
    if (key === 'TITLE' && !info.title) info.title = value;
    else if (key === 'ARTIST' && !info.artist) info.artist = value;
    else if (key === 'ALBUMARTIST' || key === 'ALBUM ARTIST') info.albumArtist = info.albumArtist || value;
    else if (key === 'ALBUM' && !info.album) info.album = value;
    else if (key === 'TRACKNUMBER') info.track = info.track || parseInt(value, 10) || 0;
    else if (key === 'DISCNUMBER') info.disc = info.disc || parseInt(value, 10) || 0;
    else if ((key === 'DATE' || key === 'YEAR' || key === 'ORIGINALDATE') && !info.year) info.year = value.slice(0, 4);
    else if ((key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'SYNCEDLYRICS') && !info.lyrics) info.lyrics = value;
    else if (key === 'METADATA_BLOCK_PICTURE' && !info.picture) {
      try {
        const raw = Uint8Array.from(atob(value.replace(/\s+/g, '')), c => c.charCodeAt(0));
        readPictureBlock(raw, info);
      } catch (e) { /* bad base64 */ }
    }
  }
}

function readPictureBlock(b, info) {
  let p = 4;
  const mlen = u32(b, p); p += 4;
  const mime = latin1.decode(b.subarray(p, p + mlen)); p += mlen;
  const dlen = u32(b, p); p += 4 + dlen + 16;
  const len = u32(b, p); p += 4;
  info.picture = { mime: mime || 'image/jpeg', data: b.slice(p, p + len) };
}

// ---------------------------------------------------------------- FLAC

async function readFLAC(file, info, start) {
  let pos = start + 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = await bytes(file, pos, 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7F, len = u24(h, 1);
    pos += 4;
    if (type === 0) {
      const b = await bytes(file, pos, len);
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const total = (b[13] & 0x0F) * 2 ** 32 + u32(b, 14);
      if (rate) info.duration = total / rate;
    } else if (type === 4) {
      applyComments(await bytes(file, pos, len), 0, info);
    } else if (type === 6 && !info.picture) {
      readPictureBlock(await bytes(file, pos, len), info);
    }
    pos += len;
    if (last) break;
  }
}

// ---------------------------------------------------------------- Ogg (Vorbis / Opus)

async function readOgg(file, info) {
  // Gather the first few packets from the pages at the start of the file.
  const packets = [];
  let current = [];
  let pos = 0;
  let rate = 48000, opus = false, preSkip = 0;
  for (let pages = 0; packets.length < 2 && pos < file.size && pages < 512; pages++) {
    const h = await bytes(file, pos, 27 + 255);
    if (ascii(h, 0, 4) !== 'OggS') break;
    const segs = h[26];
    const table = h.subarray(27, 27 + segs);
    let bodyLen = 0;
    for (const s of table) bodyLen += s;
    const body = await bytes(file, pos + 27 + segs, bodyLen);
    let off = 0;
    for (const s of table) {
      current.push(body.subarray(off, off + s));
      off += s;
      if (s < 255) {
        const total = current.reduce((n, c) => n + c.length, 0);
        const packet = new Uint8Array(total);
        let o = 0;
        for (const c of current) { packet.set(c, o); o += c.length; }
        packets.push(packet);
        current = [];
        if (packets.length >= 2) break;
      }
    }
    pos += 27 + segs + bodyLen;
  }
  if (!packets.length) return;
  const idp = packets[0];
  if (ascii(idp, 0, 8) === 'OpusHead') { opus = true; preSkip = idp[10] | (idp[11] << 8); }
  else if (ascii(idp, 1, 6) === 'vorbis') rate = u32le(idp, 12);
  const cp = packets[1];
  if (cp) {
    if (opus && ascii(cp, 0, 8) === 'OpusTags') applyComments(cp, 8, info);
    else if (ascii(cp, 1, 6) === 'vorbis') applyComments(cp, 7, info);
  }
  // Duration from the granule position of the last page.
  const tailSize = Math.min(file.size, 65536);
  const tail = await bytes(file, file.size - tailSize, tailSize);
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] === 0x4F && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
      const g = u32le(tail, i + 6) + u32le(tail, i + 10) * 2 ** 32;
      if (g > 0) info.duration = (g - (opus ? preSkip : 0)) / (opus ? 48000 : rate);
      break;
    }
  }
}

// ---------------------------------------------------------------- MP4 / M4A

async function readMP4(file, info) {
  async function children(start, end, visit) {
    let pos = start;
    while (pos + 8 <= end) {
      const h = await bytes(file, pos, 16);
      let size = u32(h, 0);
      const type = ascii(h, 4, 4);
      let header = 8;
      if (size === 1) { size = u32(h, 8) * 2 ** 32 + u32(h, 12); header = 16; }
      else if (size === 0) size = end - pos;
      if (size < header) break;
      await visit(type, pos + header, pos + size);
      pos += size;
    }
  }
  await children(0, file.size, async (type, s, e) => {
    if (type !== 'moov') return;
    await children(s, e, async (t2, s2, e2) => {
      if (t2 === 'mvhd') {
        const b = await bytes(file, s2, 32);
        if (b[0] === 1) info.duration = (u32(b, 24) * 2 ** 32 + u32(b, 28)) / u32(b, 20);
        else info.duration = u32(b, 16) / u32(b, 12);
      }
      if (t2 !== 'udta') return;
      await children(s2, e2, async (t3, s3, e3) => {
        if (t3 !== 'meta') return;
        await children(s3 + 4, e3, async (t4, s4, e4) => {
          if (t4 !== 'ilst') return;
          const b = await bytes(file, s4, e4 - s4);
          let p = 0;
          while (p + 8 <= b.length) {
            const size = u32(b, p);
            if (size < 8) break;
            const key = latin1.decode(b.subarray(p + 4, p + 8));
            let q = p + 8;
            while (q + 16 <= p + size) {
              const dsize = u32(b, q);
              if (dsize < 16) break;
              if (ascii(b, q + 4, 4) === 'data') {
                const payload = b.subarray(q + 16, q + dsize);
                const text = () => utf8.decode(payload);
                if (key === '©nam') info.title = text();
                else if (key === '©ART') info.artist = text();
                else if (key === 'aART') info.albumArtist = text();
                else if (key === '©alb') info.album = text();
                else if (key === '©day') info.year = text().slice(0, 4);
                else if (key === '©lyr') info.lyrics = text();
                else if (key === 'trkn' && payload.length >= 4) info.track = (payload[2] << 8) | payload[3];
                else if (key === 'disk' && payload.length >= 4) info.disc = (payload[2] << 8) | payload[3];
                else if (key === 'covr' && !info.picture) {
                  const kind = u32(b, q + 8) & 0xFFFFFF;
                  info.picture = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: payload.slice() };
                }
                break;
              }
              q += dsize;
            }
            p += size;
          }
        });
      });
    });
  });
}

// ---------------------------------------------------------------- duration fallback

export function probeDuration(blob) {
  return new Promise(resolve => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);
    const finish = value => { URL.revokeObjectURL(url); audio.src = ''; resolve(value); };
    const timer = setTimeout(() => finish(0), 8000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => { clearTimeout(timer); finish(isFinite(audio.duration) ? audio.duration : 0); };
    audio.onerror = () => { clearTimeout(timer); finish(0); };
    audio.src = url;
  });
}
