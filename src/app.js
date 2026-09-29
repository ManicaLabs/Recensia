// Démarrage de Recensia : textes, stockage, audience, routeur, service worker.

import { config } from '../config.js';
import { startRouter, navigate, baseUrlFrom } from './router.js';
import { i18n, t } from './i18n.js';
import { data } from './data.js';
import { initAnalytics, trackView, trackEvent, trackRoute } from './analytics.js';
import { h, mount, announce } from './ui/dom.js';
import { toast, icon, button } from './ui/components.js';

// Route ⇒ module de vue (chargé à la demande). L'espace de noms i18n porte le nom de la route.
const VIEW_LOADERS = {
  home: () => import('./views/home.js'),
  new: () => import('./views/new.js'),
  form: () => import('./views/form.js'),
  admin: () => import('./views/admin.js'),
  console: () => import('./views/console.js'),
  import_link: () => import('./views/import-link.js'),
  demo: () => import('./views/demo.js'),
  privacy: () => import('./views/privacy.js'),
  not_found: () => import('./views/not-found.js'),
};

// Lien de navigation signalé comme actif (aria-current) pour chaque route.
const NAV_FOR_ROUTE = {
  home: 'home', admin: 'admin', console: 'admin', import_link: 'admin', demo: 'demo', privacy: 'privacy',
};

const DEFAULT_TITLE = 'Recensia — registre des usages IA';
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

let navigationToken = 0;
let activeCleanup = null;
let firstRender = true;
let titleSet = false;

function setTitle(title) {
  titleSet = true;
  const text = typeof title === 'string' ? title.trim() : '';
  document.title = text ? `${text} — Recensia` : DEFAULT_TITLE;
}

// Module absent (pas encore livré, ou hors ligne sans cache) : message d'erreur du chargeur.
function isMissingModule(err) {
  return err instanceof TypeError
    && /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(String(err.message));
}

function comingSoonView(root, { ctx }) {
  ctx.setTitle(t('common.coming_soon.title'));
  mount(root, h('div', { class: 'page page-narrow' },
    h('div', { class: 'empty-state' },
      h('span', { class: 'empty-state-icon' }, icon('info')),
      h('h1', null, t('common.coming_soon.title')),
      h('p', { class: 'lead' }, t('common.coming_soon.text')),
      h('p', null, h('a', { class: 'btn btn-primary', href: '#/' }, t('common.actions.back_home'))))));
}

function errorView(root, { ctx }) {
  ctx.setTitle(t('common.errors.view_title'));
  mount(root, h('div', { class: 'page page-narrow' },
    h('div', { class: 'empty-state' },
      h('span', { class: 'empty-state-icon empty-state-danger' }, icon('danger')),
      h('h1', null, t('common.errors.view_title')),
      h('p', { class: 'lead' }, t('common.errors.view_text')),
      h('div', { class: 'cluster cluster-center' },
        button(t('common.actions.reload'), () => globalThis.location.reload(), { variant: 'primary', icon: 'refresh' }),
        h('a', { class: 'btn btn-secondary', href: '#/' }, t('common.actions.back_home'))))));
}

async function loadView(name) {
  const loader = Object.hasOwn(VIEW_LOADERS, name) ? VIEW_LOADERS[name] : VIEW_LOADERS.not_found;
  try {
    const mod = await loader();
    if (typeof mod.render !== 'function') throw new TypeError(`La vue « ${name} » n'exporte pas render().`);
    return { render: mod.render, namespace: name };
  } catch (err) {
    if (isMissingModule(err)) {
      console.info(`[Recensia] Vue « ${name} » indisponible pour le moment.`, err);
      return { render: comingSoonView, namespace: null };
    }
    console.error(`[Recensia] Impossible de charger la vue « ${name} ».`, err);
    return { render: errorView, namespace: null };
  }
}

function runCleanup() {
  const cleanup = activeCleanup;
  activeCleanup = null;
  if (typeof cleanup !== 'function') return;
  try {
    cleanup();
  } catch (err) {
    console.error('[Recensia] Erreur lors du nettoyage de la vue précédente.', err);
  }
}

function updateNav(route) {
  const active = NAV_FOR_ROUTE[route.name] ?? null;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === active) {
      link.setAttribute('aria-current', 'page');
      revealInList(link);
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

// Menu défilant (écrans très étroits) : le lien actif est ramené dans la zone visible.
function revealInList(link) {
  const list = link.closest('ul');
  if (!list || list.scrollWidth <= list.clientWidth) return;
  const offset = link.getBoundingClientRect().left - list.getBoundingClientRect().left;
  list.scrollLeft += offset - (list.clientWidth - link.offsetWidth) / 2;
}

function focusHeading(container, root) {
  const target = container.querySelector('h1') ?? root;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  globalThis.scrollTo(0, 0);
}

async function renderRoute(route, ctx, root) {
  const token = ++navigationToken;
  runCleanup();
  updateNav(route);
  root.setAttribute('aria-busy', 'true');

  const view = await loadView(route.name);
  if (token !== navigationToken) return;
  if (view.namespace) {
    try {
      await i18n.load(view.namespace);
    } catch (err) {
      console.info(`[Recensia] Textes « ${view.namespace} » indisponibles.`, err);
    }
    if (token !== navigationToken) return;
  }

  // Conteneur neuf à chaque navigation : une vue abandonnée écrit dans un nœud détaché.
  const container = h('div', { class: 'view', 'data-view': route.name });
  mount(root, container);
  titleSet = false;
  let cleanup = null;
  try {
    const result = await view.render(container, { params: route.params, ctx });
    cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    console.error(`[Recensia] Erreur d'affichage de la vue « ${route.name} ».`, err);
    if (token === navigationToken) errorView(container, { ctx });
  }
  if (token !== navigationToken) {
    if (cleanup) {
      try { cleanup(); } catch (err) { console.error(err); }
    }
    return;
  }

  activeCleanup = cleanup;
  root.removeAttribute('aria-busy');
  if (!titleSet) setTitle(container.querySelector('h1')?.textContent ?? '');
  if (!firstRender) focusHeading(container, root);
  firstRender = false;
  trackRoute(route);
}

async function openStoreSafely() {
  try {
    const mod = await import('./storage/store.js');
    if (typeof mod.openStore !== 'function') throw new TypeError('openStore() introuvable.');
    return await mod.openStore({ appVersion: config.appVersion });
  } catch (err) {
    if (isMissingModule(err)) console.info('[Recensia] Module de stockage indisponible.', err);
    else console.warn('[Recensia] Ouverture du stockage impossible.', err);
    return null;
  }
}

function showStorageBanner(store) {
  if (store && store.kind !== 'memory') return;
  const banners = document.getElementById('app-banners');
  if (!banners) return;
  const message = store ? t('common.storage.memory') : t('common.storage.unavailable');
  banners.appendChild(h('div', { class: 'banner banner-warn', role: 'status' },
    icon('alert', { className: 'banner-icon' }),
    h('p', { class: 'banner-text' }, message)));
}

// Textes statiques d'index.html : data-i18n (contenu) et data-i18n-aria-label (étiquette).
// Sans catalogue chargé, le texte français d'origine reste en place.
function applyChromeTexts() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (i18n.has(key)) el.textContent = t(key);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
    const key = el.getAttribute('data-i18n-aria-label');
    if (i18n.has(key)) el.setAttribute('aria-label', t(key));
  }
}

function setupChrome() {
  const main = document.getElementById('app');
  document.querySelector('.skip-link')?.addEventListener('click', (event) => {
    // Le hash est réservé au routeur : on déplace le focus sans modifier l'URL.
    event.preventDefault();
    main?.focus();
    main?.scrollIntoView();
  });
  applyChromeTexts();
  const version = document.getElementById('app-version');
  if (version) version.textContent = t('common.app.version', { version: config.appVersion });
}

// Mise à jour : la bannière s'affiche quand un nouveau service worker attend ; rien n'est
// rechargé sans action de l'utilisateur.
function setupServiceWorker() {
  const container = globalThis.navigator?.serviceWorker;
  if (!container) return;
  const banner = document.getElementById('update-banner');
  const reloadButton = document.getElementById('update-reload');
  let waitingWorker = null;
  let reloadRequested = false;

  const showUpdate = (worker) => {
    waitingWorker = worker;
    if (banner && banner.hidden) {
      banner.hidden = false;
      announce(t('common.update.announce'));
    }
  };

  reloadButton?.addEventListener('click', () => {
    if (!waitingWorker) return;
    reloadButton.disabled = true;
    reloadButton.textContent = t('common.update.reloading');
    // Déjà activée depuis un autre onglet : controllerchange a eu lieu, il suffit de recharger.
    if (waitingWorker.state === 'activated' || container.controller === waitingWorker) {
      globalThis.location.reload();
      return;
    }
    reloadRequested = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });

  container.addEventListener('controllerchange', () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    globalThis.location.reload();
  });

  container.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((registration) => {
    if (registration.waiting && registration.active) showUpdate(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && registration.active && registration.active !== worker) showUpdate(worker);
      });
    });
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
      lastCheck = Date.now();
      registration.update().catch(() => {});
    });
  }).catch((err) => {
    console.info('[Recensia] Service worker non enregistré.', err);
  });
}

// Aucune donnée ne voyage dans la query string. Elle est retirée de l'adresse dès le démarrage :
// le script GoatCounter la transmet sinon avec chaque comptage (paramètre « q »).
function dropQueryString() {
  const { location, history } = globalThis;
  if (!location.search) return;
  try {
    history.replaceState(history.state ?? null, '', `${location.pathname}${location.hash}`);
  } catch (err) {
    console.info('[Recensia] Adresse non nettoyée.', err);
  }
}

async function boot() {
  dropQueryString();
  const root = document.getElementById('app');
  const [store] = await Promise.all([
    openStoreSafely(),
    i18n.load('common').catch((err) => console.warn('[Recensia] Textes communs indisponibles.', err)),
  ]);

  setupChrome();
  initAnalytics(config, globalThis.location);

  const ctx = {
    store,
    data,
    t,
    i18n,
    navigate,
    config,
    track: Object.freeze({ view: trackView, event: trackEvent }),
    toast,
    baseUrl: baseUrlFrom(globalThis.location.href),
    setTitle,
  };

  showStorageBanner(store);
  setupServiceWorker();
  startRouter((route) => {
    renderRoute(route, ctx, root).catch((err) => console.error('[Recensia] Erreur de navigation.', err));
  });
}

boot().catch((err) => console.error('[Recensia] Échec du démarrage.', err));
