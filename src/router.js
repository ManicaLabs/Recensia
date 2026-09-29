// Routage par hash (#/...) : analyse pure des routes et navigation.
// Le fragment n'est jamais envoyé au serveur : configuration de campagne et codes y voyagent.

/** Onglets de la console d'une campagne (#/admin/<id>/<onglet>). */
export const CONSOLE_TABS = Object.freeze([
  'tableau', 'registre', 'actions', 'import', 'saisir', 'diffuser', 'rapport', 'parametres',
]);

/** Noms de toutes les routes produites par parseHash(). */
export const ROUTE_NAMES = Object.freeze([
  'home', 'new', 'form', 'admin', 'console', 'import_link', 'demo', 'privacy', 'not_found',
]);

// Charges utiles (#/c/…, #/i/…) : base64url, séparateur « ~ », points des codes « RCN1. »
// et séquences %XX laissées par certaines messageries. Test linéaire, sans retour arrière.
const PAYLOAD_RE = /^[A-Za-z0-9\-_~.%]+$/;
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function route(name, params = {}) {
  return { name, params };
}

function notFound() {
  return route('not_found');
}

function safeDecode(value) {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Analyse un fragment d'URL et renvoie la route correspondante.
 * @param {string} hash ex. « #/admin/k3J9xQ2mP0aZ/registre »
 * @returns {{ name: string, params: object }}
 */
export function parseHash(hash) {
  let path = typeof hash === 'string' ? hash : '';
  if (path.startsWith('#')) path = path.slice(1);
  if (path === '' || path === '/') return route('home');
  if (!path.startsWith('/')) return notFound();
  // Un seul « / » final toléré (#/admin/ ⇒ #/admin).
  if (path.endsWith('/')) path = path.slice(0, -1);

  const slash = path.indexOf('/', 1);
  const head = slash === -1 ? path.slice(1) : path.slice(1, slash);
  const rest = slash === -1 ? '' : path.slice(slash + 1);

  switch (head) {
    case 'new':
    case 'demo':
    case 'privacy':
      return rest === '' ? route(head) : notFound();

    case 'c':
      if (!PAYLOAD_RE.test(rest)) return notFound();
      return route('form', { payload: safeDecode(rest) });

    case 'i': {
      if (!PAYLOAD_RE.test(rest)) return notFound();
      const payload = safeDecode(rest);
      const codes = payload.split('~').filter((code) => code !== '');
      return codes.length > 0 ? route('import_link', { payload, codes }) : notFound();
    }

    case 'admin': {
      if (rest === '') return route('admin');
      const parts = rest.split('/');
      if (parts.length > 2 || !CAMPAIGN_ID_RE.test(parts[0])) return notFound();
      const tab = parts.length === 2 ? parts[1] : null;
      if (tab !== null && !CONSOLE_TABS.includes(tab)) return notFound();
      return route('console', { id: parts[0], tab });
    }

    default:
      return notFound();
  }
}

/** Route correspondant à l'URL courante. */
export function currentRoute() {
  return parseHash(globalThis.location?.hash ?? '');
}

/**
 * URL absolue de la racine de l'application, sans hash ni query.
 * ex. https://manicalabs.github.io/Recensia/index.html?x#/c/… ⇒ https://manicalabs.github.io/Recensia/
 */
export function baseUrlFrom(href) {
  const url = new URL(href);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/[^/]*$/, '');
  return url.href;
}

let listener = null;

function emit() {
  if (listener) listener(currentRoute());
}

function toHash(path) {
  let value = String(path ?? '/');
  if (value.startsWith('#')) value = value.slice(1);
  if (!value.startsWith('/')) value = `/${value}`;
  return `#${value}`;
}

/**
 * Navigue vers un chemin de l'application (« /admin/abc/registre »).
 * replace : remplace l'entrée d'historique courante (aucune entrée ajoutée).
 */
export function navigate(path, { replace = false } = {}) {
  const hash = toHash(path);
  const { location, history } = globalThis;
  if (replace) {
    history.replaceState(history.state ?? null, '', hash);
    emit();
    return;
  }
  if (location.hash === hash) {
    emit();
    return;
  }
  location.hash = hash; // déclenche hashchange
}

/**
 * Démarre l'écoute des changements de hash et appelle onRoute(route) immédiatement.
 * Les ancres internes qui ne commencent pas par « #/ » sont ignorées.
 * @returns {() => void} fonction d'arrêt
 */
export function startRouter(onRoute) {
  listener = onRoute;
  const onHashChange = () => {
    const hash = globalThis.location?.hash ?? '';
    if (hash !== '' && hash !== '#' && !hash.startsWith('#/')) return;
    emit();
  };
  globalThis.addEventListener('hashchange', onHashChange);
  emit();
  return () => {
    globalThis.removeEventListener('hashchange', onHashChange);
    if (listener === onRoute) listener = null;
  };
}
