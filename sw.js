/* Service worker de Recensia : précache du shell, fonctionnement hors ligne, mise à jour à la demande.
 * La liste des fichiers et la version viennent de sw-precache.js (généré par tools/precache.mjs).
 * Seules les requêtes GET de même origine et dans la portée de l'application sont servies :
 * les requêtes tierces (mesure d'audience GoatCounter comprise) ne sont jamais interceptées ni mises en cache. */

importScripts('./sw-precache.js');

const PRECACHE = self.__RECENSIA_PRECACHE || { version: 'dev', files: [] };
const CACHE_PREFIX = 'recensia-';
const CACHE_NAME = CACHE_PREFIX + PRECACHE.version;
const SCOPE_URL = new URL('./', self.location.href);
const INDEX_URL = new URL('./index.html', SCOPE_URL).href;
const CONFIG_URL = new URL('./config.js', SCOPE_URL).href;
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  // Pas de skipWaiting automatique : l'utilisateur déclenche la mise à jour depuis la bannière.
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(SCOPE_URL.href)) return;

  if (request.mode === 'navigate') {
    if (isAppShell(url)) event.respondWith(serveShell(request));
    return;
  }
  if (withoutQuery(url) === CONFIG_URL) {
    event.respondWith(networkFirst(request, CONFIG_URL));
    return;
  }
  event.respondWith(cacheFirst(request));
});

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(PRECACHE.files.map(async (file) => {
    const url = new URL(file, SCOPE_URL).href;
    // cache: 'reload' contourne le cache HTTP (GitHub Pages sert avec max-age=600).
    const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
    if (!response.ok) throw new Error(`Précache impossible : ${file} (HTTP ${response.status})`);
    await cache.put(url, response);
  }));
}

function withoutQuery(url) {
  return url.origin + url.pathname;
}

function isAppShell(url) {
  return url.pathname === SCOPE_URL.pathname || url.pathname === new URL(INDEX_URL).pathname;
}

async function serveShell(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(INDEX_URL);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return new Response('Recensia est hors ligne et n’a pas encore été mis en cache.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Délai réseau dépassé')), ms);
  });
}

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await Promise.race([
      fetch(new Request(request, { cache: 'no-cache' })),
      timeout(NETWORK_TIMEOUT_MS),
    ]);
    if (response.ok) {
      // Un échec d'écriture (quota) ne doit pas faire servir l'ancienne configuration.
      cache.put(key, response.clone()).catch(() => {});
      return response;
    }
    return (await cache.match(key)) || response;
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}
