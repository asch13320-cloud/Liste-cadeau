const CACHE = 'noel-2026-v4';
const ASSETS = [
  './',
  './index.html',
  './local.html',
  './style.css',
  './v2.css',
  './js/config.js',
  './js/api.js',
  './js/ui.js',
  './vendor/supabase-js-2.118.0.min.js',
  './manifest.json',
  './favicon-sapin-arrondi.ico',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  // Mise en cache tolérante : un fichier manquant ne doit jamais empêcher l'installation.
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((a) => cache.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Réseau d'abord (la dernière version de l'app arrive tout de suite) ; le cache sert hors-ligne.
  e.respondWith(
    fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(req, { cache: 'no-cache' }))
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
