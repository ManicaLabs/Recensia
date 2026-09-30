/* Service worker de Recensia : précache du shell, fonctionnement hors ligne, mise à jour à la demande.
 * La liste des fichiers, leur empreinte SHA-256, leurs types et la version viennent de sw-precache.js
 * (généré par tools/precache.mjs). Seules les requêtes GET de même origine, dans la portée de
 * l'application et portant sur un fichier précaché sont servies : les requêtes tierces (mesure
 * d'audience GoatCounter comprise) et les autres fichiers ne sont jamais interceptés ni mis en cache.
 *
 * Intégrité : CacheStorage est commun à toute l'origine (https://<compte>.github.io), pas au chemin
 * /Recensia/. Un autre site publié sous la même origine peut donc y écrire. Une copie du cache n'est
 * servie que si son empreinte est celle de sw-precache.js (que le navigateur conserve avec sw.js, hors
 * de CacheStorage) ; sinon elle est supprimée et le fichier est relu sur le réseau. Les en-têtes du
 * cache ne sont jamais repris : une copie vérifiée est servie avec le seul type MIME de son extension. */

importScripts('./sw-precache.js');

const PRECACHE = self.__RECENSIA_PRECACHE || { version: 'dev', files: [], integrity: {}, types: {} };
const CACHE_PREFIX = 'recensia-';
const CACHE_NAME = CACHE_PREFIX + PRECACHE.version;
const SCOPE_URL = new URL('./', self.location.href);
const INDEX_URL = new URL('./index.html', SCOPE_URL).href;
const CONFIG_URL = new URL('./config.js', SCOPE_URL).href;
const NETWORK_TIMEOUT_MS = 4000;

// Adresse absolue d'un fichier précaché ⇒ { file, integrity, type }. Sans empreinte, pas de cache.
const EXPECTED = new Map();
for (const file of PRECACHE.files) {
  const integrity = PRECACHE.integrity && PRECACHE.integrity[file];
  if (typeof integrity !== 'string' || !integrity.startsWith('sha256-')) continue;
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : '';
  const type = (PRECACHE.types && PRECACHE.types[extension]) || 'application/octet-stream';
  EXPECTED.set(new URL(file, SCOPE_URL).href, { file, integrity, type });
}

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
  // Fichier hors précache (ou demandé avec une query string) : le navigateur le charge normalement.
  if (!EXPECTED.has(url.href)) return;
  event.respondWith(cacheFirst(request, url.href));
});

function toBase64(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function integrityOf(buffer) {
  return `sha256-${toBase64(await crypto.subtle.digest('SHA-256', buffer))}`;
}

/** Réponse servie pour un contenu vérifié : statut 200 et type MIME de l'extension, rien d'autre. */
function verifiedResponse(expected, body) {
  return new Response(body, { status: 200, headers: { 'content-type': expected.type } });
}

/** Contenu du réseau s'il correspond à l'empreinte attendue, sinon null. Erreur réseau : exception. */
async function fetchVerified(url, expected, init) {
  const response = await fetch(new Request(url, init));
  if (!response.ok) throw new Error(`Précache impossible : ${expected.file} (HTTP ${response.status})`);
  const body = await response.arrayBuffer();
  return (await integrityOf(body)) === expected.integrity ? body : null;
}

async function precache() {
  try {
    await fillPrecache();
  } catch (err) {
    // Installation abandonnée : pas de cache partiel orphelin (la version active garde le sien).
    await caches.delete(CACHE_NAME).catch(() => {});
    throw err;
  }
}

async function fillPrecache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all([...EXPECTED].map(async ([url, expected]) => {
    // cache: 'reload' contourne le cache HTTP (GitHub Pages sert avec max-age=600). Juste après un
    // déploiement, le CDN peut encore servir l'ancien fichier : un second essai avec une query string
    // propre à la version le contourne. Contenu toujours différent : l'installation échoue, l'ancienne
    // version reste en place et le navigateur réessaiera.
    const init = { cache: 'reload', credentials: 'same-origin' };
    const body = (await fetchVerified(url, expected, init))
      ?? (await fetchVerified(`${url}?v=${encodeURIComponent(PRECACHE.version)}`, expected, init));
    if (!body) throw new Error(`Précache impossible : ${expected.file} (contenu différent de son empreinte)`);
    await cache.put(url, verifiedResponse(expected, body));
  }));
}

/** Copie vérifiée du cache, ou null (absente, illisible ou altérée ; une copie altérée est supprimée). */
async function fromCache(url) {
  const expected = EXPECTED.get(url);
  if (!expected) return null;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (!cached) return null;
  let body = null;
  try {
    body = await cached.arrayBuffer();
  } catch {
    body = null;
  }
  if (body && (await integrityOf(body)) === expected.integrity) return verifiedResponse(expected, body);
  await cache.delete(url).catch(() => {});
  return null;
}

/** Réponse du réseau, telle quelle ; remise en cache seulement si son contenu est celui attendu. */
async function fromNetwork(request, url) {
  const response = await fetch(request);
  const expected = EXPECTED.get(url);
  if (expected && response.ok && response.type === 'basic') {
    try {
      const body = await response.clone().arrayBuffer();
      if ((await integrityOf(body)) === expected.integrity) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(url, verifiedResponse(expected, body)).catch(() => {});
      }
    } catch {
      // Mise en cache impossible (quota, corps illisible) : la réponse est servie quand même.
    }
  }
  return response;
}

function withoutQuery(url) {
  return url.origin + url.pathname;
}

function isAppShell(url) {
  return url.pathname === SCOPE_URL.pathname || url.pathname === new URL(INDEX_URL).pathname;
}

async function serveShell(request) {
  const cached = await fromCache(INDEX_URL);
  if (cached) return cached;
  try {
    return await fromNetwork(request, INDEX_URL);
  } catch {
    return new Response('Recensia est hors ligne et n’a pas encore été mis en cache.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function cacheFirst(request, url) {
  const cached = await fromCache(url);
  if (cached) return cached;
  return fromNetwork(request, url);
}

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Délai réseau dépassé')), ms);
  });
}

// config.js : réseau d'abord (réglages publiés sans attendre la bannière de mise à jour), copie vérifiée
// du précache hors ligne. La réponse du réseau n'est pas mise en cache : elle ne correspond à
// l'empreinte que si elle est identique à la copie précachée.
async function networkFirst(request, key) {
  try {
    const response = await Promise.race([
      fetch(new Request(request, { cache: 'no-cache' })),
      timeout(NETWORK_TIMEOUT_MS),
    ]);
    if (response.ok) return response;
    return (await fromCache(key)) || response;
  } catch (err) {
    const cached = await fromCache(key);
    if (cached) return cached;
    throw err;
  }
}
