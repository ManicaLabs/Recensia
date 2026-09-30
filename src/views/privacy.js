// Confidentialité (CDC §11) : mesure d'audience, données de campagne, anonymat, conservation, hébergeur.
// Origine partagée : les navigateurs cloisonnent IndexedDB, le stockage local et le cache par origine
// (https://<compte>.github.io), pas par chemin. Publié sous un chemin (/Recensia/), Recensia partage ce
// compartiment avec tout autre site de la même origine : la page le dit, d'après l'adresse réelle.

import { h, mount } from '../ui/dom.js';
import { button, callout, icon } from '../ui/components.js';
import {
  ALLOWED_PATHS, ALLOWED_EVENTS, isAnalyticsEnabled, isOptedOut, publicPath, setOptOut,
} from '../analytics.js';

const SECTIONS = ['audience', 'campaign', 'anonymity', 'retention', 'hosting', 'publisher'];

/**
 * Origine de l'application et partage éventuel avec d'autres sites.
 * @param {string} baseUrl racine de l'application (ctx.baseUrl), ex. « https://manicalabs.github.io/Recensia/ »
 * @returns {{ origin: string, url: string, shared: boolean }} shared : l'application n'est pas à la racine de
 *   son origine (d'autres sites peuvent y être publiés) ; adresse illisible ⇒ partagée, par prudence.
 */
export function originScope(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new TypeError('protocole');
    return { origin: url.origin, url: `${url.origin}${url.pathname}`, shared: url.pathname !== '/' };
  } catch {
    return { origin: String(globalThis.location?.origin ?? ''), url: String(baseUrl ?? ''), shared: true };
  }
}

function section(key, t, ...content) {
  return h('section', { class: 'prose-section', id: `privacy-${key}`, 'aria-labelledby': `privacy-${key}-title` },
    h('h2', { id: `privacy-${key}-title` }, t(`privacy.${key}.title`)),
    content);
}

/** Refus de la mesure (clé « skipgc », commune aux outils Manica publiés sur la même origine). */
function optOutControl(t) {
  const status = h('p', { class: 'status-line', role: 'status' });
  const host = h('div', { id: 'privacy-opt-out', class: 'stack' }, h('p', null, t('privacy.audience.opt_out_text')), status);
  const refused = isOptedOut();
  if (refused === null) {
    status.textContent = t('privacy.audience.opt_out_unavailable');
    return host;
  }
  let current = refused;
  const btn = button('', () => {
    const next = !current;
    if (!setOptOut(next)) {
      status.textContent = t('privacy.audience.opt_out_failed');
      return;
    }
    current = next;
    draw(true);
  }, { variant: 'secondary', attrs: { 'aria-pressed': 'false' } });
  const label = btn.querySelector('.btn-label');
  function draw(changed) {
    label.textContent = current ? t('privacy.audience.opt_out_undo') : t('privacy.audience.opt_out_do');
    btn.setAttribute('aria-pressed', current ? 'true' : 'false');
    status.textContent = current
      ? t(changed ? 'privacy.audience.opt_out_saved' : 'privacy.audience.opt_out_on')
      : t(changed ? 'privacy.audience.opt_out_removed' : 'privacy.audience.opt_out_off');
  }
  draw(false);
  host.append(h('div', { class: 'cluster' }, btn));
  return host;
}

function codeList(values) {
  return h('ul', { class: 'code-list', role: 'list' }, values.map((value) => h('li', null, h('code', null, value))));
}

export async function render(root, { ctx }) {
  const { t } = ctx;
  ctx.setTitle(t('privacy.meta.title'));
  const active = isAnalyticsEnabled();
  const scope = originScope(ctx.baseUrl ?? globalThis.location?.href);
  const vars = { origin: scope.origin, url: scope.url };

  mount(root, h('div', { class: 'page page-narrow prose' },
    h('header', { class: 'page-header' },
      h('h1', null, t('privacy.title')),
      h('p', { class: 'lead' }, t('privacy.lead'))),

    callout('warn', h('p', null, h('strong', null, t('privacy.draft.title')), ' — ', t('privacy.draft.text'))),

    h('section', { class: 'card summary-card', 'aria-labelledby': 'privacy-summary-title' },
      h('h2', { id: 'privacy-summary-title' }, t('privacy.summary.title')),
      h('ul', { class: 'check-list', role: 'list' },
        h('li', null, icon('lock'), h('span', null, t('privacy.summary.no_server'))),
        h('li', null, icon('shield'), h('span', null, t('privacy.summary.audience'))),
        h('li', null, icon('server'), h('span', null, t('privacy.summary.hosting'))),
        scope.shared ? h('li', null, icon('alert'), h('span', null, t('privacy.summary.shared_origin', vars))) : null)),

    h('nav', { class: 'toc', 'aria-label': t('privacy.toc_label') },
      h('ul', { role: 'list' }, SECTIONS.map((key) => h('li', null,
        h('a', {
          href: `#privacy-${key}`,
          onClick: (event) => {
            // Ancre interne : défilement sans modifier le hash (réservé au routeur).
            event.preventDefault();
            const target = root.querySelector(`#privacy-${key}`);
            target?.scrollIntoView({ block: 'start' });
            target?.querySelector('h2')?.focus({ preventScroll: true });
          },
        }, t(`privacy.${key}.title`)))))),

    section('audience', t,
      h('p', null, t('privacy.audience.intro')),
      h('p', { class: ['status-line', active ? 'is-active' : 'is-inactive'] },
        icon(active ? 'info' : 'check'),
        h('span', null, active ? t('privacy.audience.status_active') : t('privacy.audience.status_inactive'))),
      h('p', null, t('privacy.audience.account')),
      h('p', null, t('privacy.audience.paths')),
      codeList(ALLOWED_PATHS.map(publicPath)),
      h('p', null, t('privacy.audience.events')),
      codeList(ALLOWED_EVENTS.map(publicPath)),
      h('p', null, t('privacy.audience.never')),
      h('p', null, t('privacy.audience.technical')),
      h('p', null, t('privacy.audience.local')),
      h('p', null, t('privacy.audience.blocker')),
      optOutControl(t)),

    section('campaign', t,
      h('p', null, t('privacy.campaign.link')),
      h('p', null, t('privacy.campaign.encryption')),
      h('p', null, t('privacy.campaign.storage')),
      h('p', null, t('privacy.campaign.respondent_draft')),
      h('p', null, t('privacy.campaign.admin_session')),
      h('p', null, t('privacy.campaign.private_key')),
      h('p', null, t('privacy.campaign.share'))),

    section('anonymity', t,
      h('p', null, t('privacy.anonymity.guarantees')),
      h('p', null, t('privacy.anonymity.channel_intro')),
      h('ul', null,
        h('li', null, t('privacy.anonymity.channel_email')),
        h('li', null, t('privacy.anonymity.channel_messaging')),
        h('li', null, t('privacy.anonymity.channel_shared'))),
      h('p', null, t('privacy.anonymity.free_text')),
      h('p', null, t('privacy.anonymity.open_mode'))),

    section('retention', t,
      h('p', null, t('privacy.retention.company')),
      h('p', null, t('privacy.retention.browser')),
      h('p', null, t('privacy.retention.rights'))),

    section('hosting', t,
      h('p', null, t('privacy.hosting.provider')),
      h('p', null, t('privacy.hosting.logs')),
      h('p', null, t('privacy.hosting.no_third_party')),
      scope.shared
        ? callout('warn',
          h('p', { id: 'privacy-shared-origin' }, h('strong', null, t('privacy.hosting.origin_shared_title')), ' ', t('privacy.hosting.origin_shared', vars)),
          h('p', null, t('privacy.hosting.origin_shared_risk')),
          h('p', null, t('privacy.hosting.origin_shared_advice', vars)))
        : h('p', null, t('privacy.hosting.origin_own', vars)),
      h('p', null, t('privacy.hosting.integrity'))),

    section('publisher', t,
      h('p', null, t('privacy.publisher.text'))),

    h('p', { class: 'muted small' }, t('privacy.updated'))));

  // Titres ciblés par la table des matières : focalisables sans entrer dans l'ordre de tabulation.
  root.querySelectorAll('.prose-section > h2').forEach((heading) => heading.setAttribute('tabindex', '-1'));
}
