// Mesure d'audience GoatCounter (CDC §11) : chemins fixes en liste blanche, aucune donnée.
// Aucun envoi automatique de l'URL : seules les valeurs ci-dessous peuvent être transmises.
// Le compte GoatCounter (« manica ») est commun aux outils Manica (Check-up IA…) : tout ce que Recensia
// envoie est préfixé « recensia » (chemin) et « Recensia · » (titre), pour filtrer ses pages et événements.

import { analyticsOptOut, setAnalyticsOptOut } from './ui/safe-storage.js';

/** Chemins de pages comptés (liste blanche). */
export const ALLOWED_PATHS = Object.freeze([
  '/home', '/new', '/form', '/admin/registre', '/admin/actions', '/admin/rapport', '/demo', '/privacy',
]);

/** Événements comptés (chemins fictifs, sans donnée). */
export const ALLOWED_EVENTS = Object.freeze([
  'event/campaign_created', 'event/code_generated', 'event/share_link', 'event/share_code',
  'event/import_link', 'event/export_xlsx', 'event/export_csv', 'event/export_print',
]);

// Version figée + empreinte SRI (même fichier que Check-up IA) : le navigateur refuse tout script modifié.
// Changer de version : télécharger count.vX.js, `openssl dgst -sha384 -binary count.vX.js | openssl base64 -A`.
const SCRIPT_URL = 'https://gc.zgo.at/count.v5.js';
const SCRIPT_INTEGRITY = 'sha384-atnOLvQb9t+jTSipvd75X2yginT4PjVbqDdlJAmxMm+wYElFmeR6EmLP5bYeoRVQ';
/** Préfixe de tous les chemins envoyés (vues : « /recensia/home » ; événements : « recensia/event/… »). */
export const SITE_PREFIX = 'recensia';
const CODE_RE = /^[a-z0-9-]{1,63}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0', '']);
const TITLE = 'Recensia';
// Titres lisibles dans le tableau de bord GoatCounter (colonne « titre »).
const TITLES = Object.freeze({
  '/home': 'Accueil', '/new': 'Nouvelle campagne', '/form': 'Formulaire répondant',
  '/admin/registre': 'Console : registre', '/admin/actions': "Console : plan d'actions", '/admin/rapport': 'Console : rapport',
  '/demo': 'Démo', '/privacy': 'Confidentialité',
  'event/campaign_created': 'Campagne créée', 'event/code_generated': 'Code de réponse généré',
  'event/share_link': 'Lien de collecte partagé', 'event/share_code': 'Code de réponse envoyé',
  'event/import_link': "Import par lien", 'event/export_xlsx': 'Export XLSX', 'event/export_csv': 'Export CSV',
  'event/export_print': 'Impression / PDF',
});
const MAX_QUEUE = 20;

// Route (src/router.js) ⇒ chemin fixe. Console : seuls ces trois onglets sont comptés.
const ROUTE_PATHS = Object.freeze({
  home: '/home', new: '/new', form: '/form', demo: '/demo', privacy: '/privacy',
});
const CONSOLE_TAB_PATHS = Object.freeze({
  registre: '/admin/registre', actions: '/admin/actions', rapport: '/admin/rapport',
});

let state = freshState();

function freshState() {
  return { enabled: false, ready: false, queue: [], win: null };
}

/** Code GoatCounter syntaxiquement valide (sous-domaine de goatcounter.com). */
export function isValidCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

/** Hôte local : la mesure y est toujours désactivée. */
export function isLocalHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
}

/** Le script de mesure doit-il être chargé ? (code valide, HTTPS, hôte non local) */
export function shouldLoad(config, location) {
  if (!config || !isValidCode(config.goatcounterCode)) return false;
  if (!location || location.protocol !== 'https:') return false;
  return !isLocalHost(location.hostname);
}

/** Chemin fixe associé à une route, ou null si la route n'est pas comptée. */
export function pathForRoute(route) {
  if (!route || typeof route.name !== 'string') return null;
  if (route.name === 'console') {
    const tab = route.params?.tab;
    return typeof tab === 'string' && Object.hasOwn(CONSOLE_TAB_PATHS, tab) ? CONSOLE_TAB_PATHS[tab] : null;
  }
  return Object.hasOwn(ROUTE_PATHS, route.name) ? ROUTE_PATHS[route.name] : null;
}

/**
 * Initialise la mesure d'audience. Sans code valide, en local ou hors HTTPS : rien n'est chargé.
 * @param {{ goatcounterCode: string }} config
 * @param {Location} location
 * @param {{ document?: Document, window?: object }} env injection pour les tests
 * @returns {{ enabled: boolean, view: typeof trackView, event: typeof trackEvent }}
 */
export function initAnalytics(config, location = globalThis.location, env = {}) {
  state = freshState();
  const doc = env.document ?? globalThis.document;
  const win = env.window ?? globalThis;
  if (!doc || !shouldLoad(config, location) || analyticsOptOut() === true) return api();

  state.enabled = true;
  state.win = win;
  try {
    if (!win.goatcounter) win.goatcounter = { no_onload: true };
    const script = doc.createElement('script');
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.integrity = SCRIPT_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-goatcounter', `https://${config.goatcounterCode}.goatcounter.com/count`);
    script.setAttribute('data-goatcounter-settings', '{"no_onload": true}');
    const current = state;
    script.addEventListener('load', () => onScriptLoad(current));
    script.addEventListener('error', () => disable(current));
    script.src = SCRIPT_URL;
    (doc.head ?? doc.body ?? doc.documentElement).appendChild(script);
  } catch {
    disable(state);
  }
  return api();
}

function api() {
  return { enabled: state.enabled, view: trackView, event: trackEvent };
}

function onScriptLoad(target) {
  if (target !== state || !target.enabled) return;
  target.ready = true;
  const pending = target.queue.splice(0);
  for (const payload of pending) dispatch(payload);
}

// Échec silencieux (bloqueur, hors ligne) : l'application continue normalement.
function disable(target) {
  target.enabled = false;
  target.ready = false;
  target.queue.length = 0;
}

function dispatch(payload) {
  try {
    const counter = state.win?.goatcounter;
    if (counter && typeof counter.count === 'function') counter.count({ ...payload });
  } catch {
    // silencieux
  }
}

/** Chemin réellement envoyé à GoatCounter pour une vue ('/home') ou un événement ('event/…'). */
export function publicPath(name) {
  return name.startsWith('/') ? `/${SITE_PREFIX}${name}` : `${SITE_PREFIX}/${name}`;
}

/** Titre envoyé : « Recensia · Accueil ». */
export function publicTitle(name) {
  return Object.hasOwn(TITLES, name) ? `${TITLE} · ${TITLES[name]}` : TITLE;
}

function send(name, event) {
  if (!state.enabled) return false;
  const payload = { path: publicPath(name), title: publicTitle(name), referrer: '', event };
  if (state.ready) dispatch(payload);
  else if (state.queue.length < MAX_QUEUE) state.queue.push(payload);
  return true;
}

/** Compte une vue. Tout chemin hors liste blanche est ignoré (renvoie false). */
export function trackView(path) {
  if (!ALLOWED_PATHS.includes(path)) return false;
  return send(path, false);
}

/** Compte un événement. Tout nom hors liste blanche est ignoré (renvoie false). */
export function trackEvent(name) {
  if (!ALLOWED_EVENTS.includes(name)) return false;
  return send(name, true);
}

/** Compte la vue associée à une route (chemin fixe de la liste blanche uniquement). */
export function trackRoute(route) {
  const path = pathForRoute(route);
  return path !== null && ALLOWED_PATHS.includes(path) ? send(path, false) : false;
}

/** La mesure d'audience est-elle active sur cette page ? */
export function isAnalyticsEnabled() {
  return state.enabled;
}

/** Refus de la mesure mémorisé dans ce navigateur : true, false, ou null si le stockage est indisponible. */
export function isOptedOut() {
  return analyticsOptOut();
}

/**
 * Enregistre (ou retire) le refus de la mesure. Effet immédiat : plus aucun envoi pendant la visite.
 * @returns {boolean} true si le choix a pu être mémorisé.
 */
export function setOptOut(refused) {
  const saved = setAnalyticsOptOut(refused === true);
  if (refused === true) disable(state);
  return saved;
}
