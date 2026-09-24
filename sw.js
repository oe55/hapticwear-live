/**
 * HapticWear Live service worker: the site keeps working when the exhibition wifi does not.
 *
 *  - App shell: every file the page needs is cached on the first visit, as one atomic set per
 *    BUILD. A new deploy installs in the background and the page picks it up at the next idle
 *    reset, between visitors.
 *  - Music: cached the first time each track is fetched. On the show computer (?kiosk) the page
 *    also asks for the whole built-in library in the background, so it all plays offline.
 *
 * BUILD is stamped by tools/stamp.mjs from the content of the files below. Run it before every
 * push (the README's publish steps do).
 */

const BUILD = '9336e17b75';
const SHELL_CACHE = `hw-shell-${BUILD}`;
const MUSIC_CACHE = 'hw-music-v1';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/tokens.css',
  'css/app.css',
  'js/main.js',
  'js/core/config.js',
  'js/core/stage.js',
  'js/core/kiosk.js',
  'js/core/diagnostics.js',
  'js/audio/engine.js',
  'js/audio/analysis.js',
  'js/audio/library.js',
  'js/three/vest.js',
  'js/ble/vest-ble.js',
  'js/ui/dashboard.js',
  'js/ui/drawer.js',
  'js/ui/notices.js',
  'vendor/three/three.bundle.js',
  'assets/fonts/jost-var.woff2',
  'assets/fonts/jetbrains-mono-400.woff2',
  'assets/fonts/jetbrains-mono-700.woff2',
  'assets/fonts/inter-600.woff2',
  'assets/model/vest.glb',
  'assets/music/catalog.json',
  'assets/img/icon.svg',
  'assets/img/icon-192.png',
  'assets/img/icon-512.png',
  'assets/img/icon-maskable.png',
  'assets/img/vest-still.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hw-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('/assets/music/') && !url.pathname.endsWith('.json')) {
    event.respondWith(fromMusicCache(req));
    return;
  }
  // Shell: cache first; anything not in the shell falls through to the network.
  event.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate', cacheName: SHELL_CACHE })
      .then((hit) => hit || fetch(req)),
  );
});

async function fromMusicCache(req) {
  const cache = await caches.open(MUSIC_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req.url);
  if (res.ok && res.status === 200) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

/** The page sends the built-in track list once it has settled; fetch any not cached yet, one at a time. */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(MUSIC_CACHE);
    const keep = new Set(data.urls);
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
    for (const url of data.urls) {
      if (await cache.match(url)) continue;
      try {
        const res = await fetch(url);
        if (res.ok && res.status === 200) await cache.put(url, res);
      } catch { return; /* offline: try again on the next visit */ }
    }
  })());
});
