// Reads .zip files (like the ones iPhone's Files app makes with "Compress"), one entry at a time,
// so a whole album folder can be imported in one go without unpacking it first.

const utf8 = new TextDecoder('utf-8');

async function read(blob, start, length) {
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24;

export async function listZip(blob) {
  // Find the "end of central directory" record near the end of the file.
  const tailLen = Math.min(blob.size, 65557);
  const tail = await read(blob, blob.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This doesn’t look like a zip file.');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) {
    // Zip64: the real numbers are in the zip64 end record.
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const recOffset = u32(tail, loc + 8) + u32(tail, loc + 12) * 2 ** 32;
      const rec = await read(blob, recOffset, 56);
      count = u32(rec, 32);
      cdSize = u32(rec, 40);
      cdOffset = u32(rec, 48) + u32(rec, 52) * 2 ** 32;
    }
  }
  const cd = await read(blob, cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // Zip64 sizes and offset live in the extra field.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const big = () => { const v = u32(cd, q) + u32(cd, q + 4) * 2 ** 32; q += 8; return v; };
        if (size === 0xFFFFFFFF) size = big();
        if (compSize === 0xFFFFFFFF) compSize = big();
        if (offset === 0xFFFFFFFF) offset = big();
      }
      e += 4 + len;
    }
    p = eEnd + commentLen;
    const base = name.split('/').pop();
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || base.startsWith('._') || base === '.DS_Store') continue;
    entries.push({ name, base, method, compSize, size, offset });
  }
  return entries;
}

export async function extract(blob, entry, type = '') {
  const h = await read(blob, entry.offset, 30);
  const start = entry.offset + 30 + u16(h, 26) + u16(h, 28);
  const data = blob.slice(start, start + entry.compSize);
  if (entry.method === 0) return new Blob([data], { type });
  if (entry.method !== 8) throw new Error(`${entry.base} uses a compression method this app can't open.`);
  const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Blob([await new Response(stream).arrayBuffer()], { type });
}

// ---------------------------------------------------------------- writing (stored, no compression: music doesn't shrink)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crcBytes(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data: Blob | string }] → a .zip Blob.
export async function makeZip(files, progress = () => {}) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    progress(i, files.length, f.name);
    const blob = typeof f.data === 'string' ? new Blob([f.data]) : f.data;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crcBytes(bytes), size = bytes.length;
    const name = enc.encode(f.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
    local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(local.buffer, name, bytes);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
    if (offset > 0xFFFFFFFF) throw new Error('This backup would be bigger than 4 GB. Try it without the imported songs.');
  }
  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
