// "Burn me a mix": picks songs for a new CD-R from a starting point and a length.
// The desktop app follows the same rules (in main.py: make_mix).
export const MIX_KINDS = {
  like:    { label: 'Like what\'s playing', note: 'same artist, and albums with similar colors', titles: ['More like {album}', '{artist} & Friends', 'In the Mood', 'Same Wavelength'], inks: ['pink', 'sky', 'purple'], doodles: ['note', 'notes', 'star', 'sparkle'] },
  unheard: { label: 'Haven\'t heard in a while', note: 'songs you\'ve played least lately', titles: ['Rediscovered', 'Dusty Shelf', 'Lost & Found', 'Hidden Gems'], inks: ['teal', 'lime', 'orange'], doodles: ['swirl', 'notes', 'sparkle', 'cloud'] },
  top:     { label: 'My most-played', note: 'your favorites, all on one disc', titles: ['Greatest Hits', 'On Repeat', 'Favorites!!', 'Best Of Me'], inks: ['rainbow', 'pink'], doodles: ['star', 'heart', 'sparkle', 'smile'] },
  warm:    { label: 'Warm colors', note: 'albums with red, pink, orange and gold covers', titles: ['Sunset Mix', 'Strawberry Days', 'Warm Fuzzy', 'Peach Soda'], inks: ['pink', 'orange', 'red'], doodles: ['heart', 'flower', 'star', 'smile'] },
  cool:    { label: 'Cool colors', note: 'albums with blue, green and purple covers', titles: ['Blue Hour', 'Rainy Window', 'Midnight Swim', 'Mint Breeze'], inks: ['sky', 'teal', 'purple'], doodles: ['moon', 'cloud', 'sparkle', 'swirl'] },
  surprise:{ label: 'Surprise me', note: 'anything goes', titles: ['Mystery Mix', 'Shuffle Party', 'Pick-n-Mix', 'Who Knows?!'], inks: ['rainbow', 'lime', 'orange', 'sky'], doodles: ['bolt', 'cat', 'smile', 'swirl', 'star'] },
};
export const MIX_LENGTHS = [[20, 'Short', '20 minutes'], [40, 'Half a disc', '40 minutes'], [80, 'A full CD-R', '80 minutes']];

const pick = (list, r = Math.random) => list[Math.floor(r() * list.length)];
function shuffle(list) { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; }

// hue of an RGB color (0-360) and how colorful it is (0-1)
export function hueOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return [-1, 0];
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, d / max];
}
export const isWarm = h => h >= 0 && (h >= 330 || h < 65);
export const isCool = h => h >= 150 && h < 300;

// tracks: [{ id, album key, artist, duration, plays, last, hue }], minutes: target length.
export function makeMix(kind, tracks, minutes, seedAlbum) {
  let pool = tracks.filter(t => t.duration > 20);
  let maxPerAlbum = 2;
  if (kind === 'like' && seedAlbum) {
    const near = t => t.hue >= 0 && seedAlbum.hue >= 0 && Math.min(Math.abs(t.hue - seedAlbum.hue), 360 - Math.abs(t.hue - seedAlbum.hue)) < 35;
    pool = shuffle(pool.filter(t => t.albumKey !== seedAlbum.key && (t.artist === seedAlbum.artist || near(t))));
    const own = shuffle(tracks.filter(t => t.albumKey === seedAlbum.key)).slice(0, 2);
    pool = [...own, ...pool];
  } else if (kind === 'unheard') {
    pool = shuffle(pool).sort((a, b) => (a.last || 0) - (b.last || 0));
    pool = shuffle(pool.slice(0, Math.max(30, Math.ceil(pool.length * .35))));
  } else if (kind === 'top') {
    pool = pool.filter(t => t.plays > 0).sort((a, b) => b.plays - a.plays);
    if (pool.length < 6) pool = [...pool, ...shuffle(tracks.filter(t => !t.plays))];
    maxPerAlbum = 3;
  } else if (kind === 'warm') pool = shuffle(pool.filter(t => isWarm(t.hue)));
  else if (kind === 'cool') pool = shuffle(pool.filter(t => isCool(t.hue)));
  else pool = shuffle(pool);
  const target = minutes * 60, chosen = [], perAlbum = {};
  let total = 0;
  for (const t of pool) {
    if (total >= target - 60) break;
    if ((perAlbum[t.albumKey] || 0) >= maxPerAlbum || total + t.duration > target + 90) continue;
    chosen.push(t); perAlbum[t.albumKey] = (perAlbum[t.albumKey] || 0) + 1; total += t.duration;
  }
  // keep songs from the same album apart
  for (let i = 1; i < chosen.length; i++) {
    if (chosen[i].albumKey === chosen[i - 1].albumKey) {
      const j = chosen.findIndex((t, k) => k > i && t.albumKey !== chosen[i - 1].albumKey);
      if (j > 0) [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    }
  }
  return chosen;
}

export function mixLook(kind, seedAlbum) {
  const k = MIX_KINDS[kind];
  const title = pick(k.titles).replace('{album}', seedAlbum ? seedAlbum.album : 'This').replace('{artist}', seedAlbum ? seedAlbum.artist : 'Friends');
  const doodles = shuffle([...k.doodles]).slice(0, 2 + Math.floor(Math.random() * 2));
  return { title, dye: 'blank', marker: pick(k.inks), doodles, case: pick(['black', 'clear', 'pink', 'blue', 'mint', 'lilac']) };
}
