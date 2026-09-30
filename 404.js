// Page 404 de GitHub Pages (404.html) : répare les liens dont le « # » a été encodé en « %23 ».
// Une messagerie ou une passerelle de sécurité qui encode le fragment transforme
// …/Recensia/#/c/<config> en …/Recensia/%23/c/<config> : un chemin inconnu du serveur. Ce module
// renvoie alors vers …/Recensia/#/c/<config> (location.replace), sinon il affiche la consigne de 404.html.
// Le chemin a déjà été vu par le serveur : rien n'est journalisé, mesuré ni envoyé ailleurs.
// La racine de l'application est déduite de l'adresse de ce fichier, que 404.html charge par un chemin
// absolu limité au projet (/Recensia/404.js) : un chemin relatif pourrait remonter au-dessus de /Recensia/
// et exécuter le script d'un autre site de la même origine. Aucun accès au document à l'import : testable sous Node.

// Liens de collecte et d'import : quelques kilo-octets au plus (un lien d'import peut porter plusieurs codes).
export const MAX_REPAIRED_LENGTH = 32768;

// Fragment reconstitué : caractères imprimables d'une URL, sans espace, guillemet ni chevron.
// Le routeur de l'application valide ensuite strictement chaque route.
const FRAGMENT_RE = /^\/[\x21\x23-\x3b\x3d\x3f-\x5b\x5d-\x7e]*$/;
// « # » encodé une fois (%23) ou deux fois (%2523), éventuellement après « index.html ».
const ENCODED_HASH_RE = /^(?:index\.html)?(%23|%2523)/i;
// Lien dont le « # » a disparu : …/Recensia/c/<config> ou …/Recensia/i/<codes>.
const MISSING_HASH_RE = /^([ci]\/[A-Za-z0-9\-_~.%]+)$/;

/**
 * Fragment « #/… » à ouvrir pour un chemin abîmé, ou null s'il n'y a rien à réparer.
 * @param {string} pathname chemin demandé (location.pathname), ex. « /Recensia/%23/c/abc »
 * @param {string} basePath racine de l'application, ex. « /Recensia/ »
 * @returns {string|null} ex. « #/c/abc »
 */
export function repairedHash(pathname, basePath) {
  if (typeof pathname !== 'string' || typeof basePath !== 'string' || !basePath.endsWith('/')) return null;
  if (!pathname.startsWith(basePath)) return null;
  const rest = pathname.slice(basePath.length);
  if (rest === '' || rest.length > MAX_REPAIRED_LENGTH) return null;

  let fragment = null;
  const encoded = ENCODED_HASH_RE.exec(rest);
  if (encoded) {
    fragment = rest.slice(encoded[0].length);
    // Double encodage : les autres séquences %XX l'ont été aussi (%257E ⇒ %7E).
    if (encoded[1].toLowerCase() === '%2523') fragment = fragment.replace(/%25/gi, '%');
    fragment = fragment.replace(/%2F/gi, '/');
    if (!fragment.startsWith('/')) fragment = `/${fragment}`;
  } else {
    const missing = MISSING_HASH_RE.exec(rest);
    if (missing) fragment = `/${missing[1]}`;
  }
  if (fragment === null || !FRAGMENT_RE.test(fragment)) return null;
  return `#${fragment}`;
}

/** Le chemin porte-t-il un « # » encodé (lien abîmé, même irréparable) ? */
export function looksLikeBrokenLink(pathname) {
  return typeof pathname === 'string' && /%(?:25)?23/i.test(pathname);
}

function show(doc, id, visible) {
  const node = doc.getElementById(id);
  if (node) node.hidden = !visible;
}

function main(doc, loc, moduleUrl) {
  const base = new URL('./', moduleUrl);
  const home = `${base.origin}${base.pathname}`;
  for (const id of ['nf-home', 'nf-brand']) doc.getElementById(id)?.setAttribute('href', home);

  const fragment = repairedHash(loc.pathname, base.pathname);
  if (fragment) {
    const target = `${home}${fragment}`;
    doc.getElementById('nf-repaired')?.setAttribute('href', target);
    show(doc, 'nf-generic', false);
    show(doc, 'nf-broken', false);
    show(doc, 'nf-redirect', true);
    loc.replace(target);
    return;
  }

  const broken = looksLikeBrokenLink(loc.pathname);
  show(doc, 'nf-generic', !broken);
  show(doc, 'nf-broken', broken);
  show(doc, 'nf-redirect', false);
}

if (globalThis.document && globalThis.location && typeof globalThis.location.replace === 'function') {
  main(globalThis.document, globalThis.location, import.meta.url);
}
