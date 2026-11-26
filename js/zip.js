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
