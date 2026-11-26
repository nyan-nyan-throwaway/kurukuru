// Keeps the app itself available offline. (Your music is in IndexedDB, not here.)
const CACHE = 'kurukuru-v1.7';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/apple-touch-icon.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'js/app.js', 'js/theme.js', 'js/paint.js', 'js/disc.js', 'js/lcd.js',
  'js/library.js', 'js/db.js', 'js/tags.js', 'js/zip.js', 'js/audiofx.js', 'js/plex.js', 'js/backup.js', 'js/cdrsync.js', 'js/artsync.js', 'js/doodles.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first (so updates show up), falling back to the saved copy when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request.url, { cache: 'no-cache' }).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
