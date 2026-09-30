// Console d'une campagne (#/admin/<id>/<onglet>) : en-tête, bandeaux d'alerte, onglets.
// Chaque onglet est un module src/views/console/<fichier>.js chargé à la demande, qui reçoit
// { campaign, model, ctx, refresh } (ARCHITECTURE §5.3).

import { h, mount, loadCss } from '../ui/dom.js';
import { icon, button } from '../ui/components.js';
import { formatFingerprint } from '../crypto/keys.js';
import { formatDate } from '../i18n.js';
import { buildCampaignModel, daysSince } from '../services/model.js';

// Onglet (segment d'URL) ⇒ module et espace de noms i18n.
const TABS = [
  { id: 'tableau', ns: 'dashboard', load: () => import('./console/dashboard.js') },
  { id: 'registre', ns: 'registry', load: () => import('./console/registry.js') },
  { id: 'actions', ns: 'actions', load: () => import('./console/actions.js') },
  { id: 'import', ns: 'import', load: () => import('./console/import.js') },
  { id: 'saisir', ns: 'add', load: () => import('./console/add.js') },
  { id: 'diffuser', ns: 'share', load: () => import('./console/share.js') },
  { id: 'rapport', ns: 'report', load: () => import('./console/report.js') },
  { id: 'parametres', ns: 'settings', load: () => import('./console/settings.js') },
];
const DEFAULT_TAB = 'tableau';
const BACKUP_REMINDER_DAYS = 7;

function isMissingModule(err) {
  return err instanceof TypeError
    && /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(String(err.message));
}

function emptyState(t, { iconName, title, text, actions = [] }) {
  return h('div', { class: 'page page-narrow' },
    h('div', { class: 'empty-state' },
      h('span', { class: 'empty-state-icon' }, icon(iconName)),
      h('h1', null, title),
      text ? h('p', { class: 'lead' }, text) : null,
      actions.length ? h('div', { class: 'cluster cluster-center' }, actions) : null));
}

function banner(kind, text, action) {
  return h('div', { class: ['banner', kind ? `banner-${kind}` : null], role: 'status' },
    icon(kind === 'danger' ? 'danger' : kind === 'warn' ? 'alert' : 'info', { className: 'banner-icon' }),
    h('p', { class: 'banner-text' }, text),
    action ?? null);
}

function banners(campaign, model, t) {
  const out = [];
  const settingsLink = (label) => h('a', { class: 'btn btn-secondary btn-sm', href: `#/admin/${campaign.id}/parametres` }, label);
  if (campaign.demo) out.push(banner(null, t('console.banners.demo'), h('a', { class: 'btn btn-secondary btn-sm', href: '#/demo' }, t('console.banners.demo_action'))));
  if (!campaign.private_key_jwk) {
    out.push(banner('danger', t('console.banners.no_key'), h('a', { class: 'btn btn-secondary btn-sm', href: '#/admin' }, t('console.banners.no_key_action'))));
  } else if (!campaign.demo && !campaign.recovery_saved_at) {
    out.push(banner('warn', t('console.banners.recovery'), settingsLink(t('console.banners.recovery_action'))));
  }
  if (!campaign.demo && model.entries.length > 0) {
    const days = daysSince(campaign.last_backup_at);
    if (days === null) out.push(banner('warn', t('console.banners.backup_never'), settingsLink(t('console.banners.backup_action'))));
    else if (days >= BACKUP_REMINDER_DAYS) out.push(banner('warn', t('console.banners.backup_old', { count: days }), settingsLink(t('console.banners.backup_action'))));
  }
  return out;
}

function header(campaign, t) {
  const fp = campaign.fingerprint ? formatFingerprint(campaign.fingerprint) : null;
  return h('header', { class: 'page-header console-header' },
    h('div', null,
      h('p', { class: 'eyebrow' }, campaign.org_name || t('console.no_org')),
      h('h1', null, campaign.title),
      h('p', { class: 'cluster console-meta' },
        h('span', { class: 'badge badge-neutral' }, icon(campaign.mode === 'open' ? 'users' : 'shield'), t(`console.mode.${campaign.mode}`)),
        fp ? h('span', { class: 'muted' }, t('console.fingerprint', { fp })) : null,
        campaign.settings?.closes_on ? h('span', { class: 'muted' }, t('console.closes_on', { date: formatDate(campaign.settings.closes_on) })) : null)),
    h('div', { class: 'page-header-actions' },
      h('a', { class: 'btn btn-ghost btn-sm', href: '#/admin' }, icon('arrow-left'), h('span', null, t('console.back')))));
}

function tabCount(tabId, model) {
  if (tabId === 'registre') return model.groups.length;
  if (tabId === 'actions') return model.suggestions.length || null;
  return null;
}

function tabsNav(campaign, current, model, t) {
  return h('nav', { class: 'console-tabs', 'aria-label': t('console.tabs.label') },
    h('ul', { class: 'tabs' }, TABS.map((tab) => {
      const count = tabCount(tab.id, model);
      return h('li', null, h('a', {
        href: `#/admin/${campaign.id}/${tab.id}`,
        'aria-current': tab.id === current ? 'page' : null,
      }, t(`console.tabs.${tab.id}`), count ? h('span', { class: 'tab-count' }, String(count)) : null));
    })));
}

export async function render(root, { params, ctx }) {
  const { t, store } = ctx;
  if (!store) {
    mount(root, emptyState(t, { iconName: 'alert', title: t('console.no_store.title'), text: t('console.no_store.text') }));
    return undefined;
  }

  loadCss('src/styles/console.css');
  const tabId = params.tab ?? DEFAULT_TAB;
  const tab = TABS.find((x) => x.id === tabId) ?? TABS[0];
  let disposed = false;
  let tabCleanup = null;

  const runTabCleanup = () => {
    const fn = tabCleanup;
    tabCleanup = null;
    if (typeof fn === 'function') {
      try { fn(); } catch (err) { console.error('[Recensia] Nettoyage de l’onglet impossible.', err); }
    }
  };

  // Chargement parallèle : module de l'onglet, textes, campagne.
  const modulePromise = tab.load().then((mod) => ({ mod }), (err) => ({ err }));
  const nsPromise = ctx.i18n.load(tab.ns).catch((err) => console.info(`[Recensia] Textes « ${tab.ns} » indisponibles.`, err));

  async function draw({ keepScroll = false } = {}) {
    const scrollY = keepScroll ? globalThis.scrollY : 0;
    const campaign = await store.getCampaign(params.id);
    if (disposed) return;
    if (!campaign) {
      mount(root, emptyState(t, {
        iconName: 'info',
        title: t('console.not_found.title'),
        text: t('console.not_found.text'),
        actions: [h('a', { class: 'btn btn-primary', href: '#/admin' }, t('console.not_found.action'))],
      }));
      return;
    }
    ctx.setTitle(`${t(`console.tabs.${tab.id}`)} · ${campaign.title}`);

    let model;
    try {
      model = await buildCampaignModel(ctx, campaign);
    } catch (err) {
      console.error('[Recensia] Modèle de campagne indisponible.', err);
      mount(root, emptyState(t, {
        iconName: 'danger',
        title: t('console.load_error.title'),
        text: t('console.load_error.text'),
        actions: [button(t('common.actions.retry'), () => draw(), { variant: 'primary', icon: 'refresh' })],
      }));
      return;
    }
    const [{ mod, err }] = await Promise.all([modulePromise, nsPromise]);
    if (disposed) return;

    const content = h('section', { class: 'console-content', 'aria-labelledby': 'console-tab-title' });
    runTabCleanup();
    mount(root, h('div', { class: 'page page-wide console' },
      header(campaign, t),
      h('div', { class: 'stack console-banners' }, banners(campaign, model, t)),
      tabsNav(campaign, tab.id, model, t),
      content));

    if (err || typeof mod?.render !== 'function') {
      if (err && !isMissingModule(err)) console.error(`[Recensia] Onglet « ${tab.id} » indisponible.`, err);
      mount(content,
        h('h2', { id: 'console-tab-title', class: 'visually-hidden' }, t(`console.tabs.${tab.id}`)),
        emptyState(t, { iconName: 'info', title: t('common.coming_soon.title'), text: t('common.coming_soon.text') }));
      return;
    }

    try {
      const result = await mod.render(content, {
        campaign,
        model,
        ctx,
        refresh: (opts) => draw({ keepScroll: true, ...opts }),
      });
      if (disposed) {
        if (typeof result === 'function') result();
        return;
      }
      tabCleanup = typeof result === 'function' ? result : null;
    } catch (renderErr) {
      console.error(`[Recensia] Erreur d’affichage de l’onglet « ${tab.id} ».`, renderErr);
      mount(content, emptyState(t, {
        iconName: 'danger',
        title: t('common.errors.view_title'),
        text: t('common.errors.view_text'),
        actions: [button(t('common.actions.retry'), () => draw(), { variant: 'primary', icon: 'refresh' })],
      }));
    }
    // L'onglet a déplacé le focus dans son contenu (résultat, confirmation) : on le laisse faire.
    const focusedInside = content.contains(globalThis.document?.activeElement);
    if (keepScroll && !focusedInside) globalThis.scrollTo(0, scrollY);
  }

  await draw();
  return () => {
    disposed = true;
    runTabCleanup();
  };
}
