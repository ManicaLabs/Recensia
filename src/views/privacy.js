// Confidentialité (CDC §11) : mesure d'audience, données de campagne, anonymat, conservation, hébergeur.

import { h, mount } from '../ui/dom.js';
import { callout, icon } from '../ui/components.js';
import { ALLOWED_PATHS, ALLOWED_EVENTS, isAnalyticsEnabled } from '../analytics.js';

const SECTIONS = ['audience', 'campaign', 'anonymity', 'retention', 'hosting', 'publisher'];

function section(key, t, ...content) {
  return h('section', { class: 'prose-section', id: `privacy-${key}`, 'aria-labelledby': `privacy-${key}-title` },
    h('h2', { id: `privacy-${key}-title` }, t(`privacy.${key}.title`)),
    content);
}

function codeList(values) {
  return h('ul', { class: 'code-list', role: 'list' }, values.map((value) => h('li', null, h('code', null, value))));
}

export async function render(root, { ctx }) {
  const { t } = ctx;
  ctx.setTitle(t('privacy.meta.title'));
  const active = isAnalyticsEnabled();

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
        h('li', null, icon('server'), h('span', null, t('privacy.summary.hosting'))))),

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
      h('p', null, t('privacy.audience.paths')),
      codeList(ALLOWED_PATHS),
      h('p', null, t('privacy.audience.events')),
      codeList(ALLOWED_EVENTS),
      h('p', null, t('privacy.audience.never')),
      h('p', null, t('privacy.audience.technical')),
      h('p', null, t('privacy.audience.local')),
      h('p', null, t('privacy.audience.blocker'))),

    section('campaign', t,
      h('p', null, t('privacy.campaign.link')),
      h('p', null, t('privacy.campaign.encryption')),
      h('p', null, t('privacy.campaign.storage')),
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
      h('p', null, t('privacy.hosting.no_third_party'))),

    section('publisher', t,
      h('p', null, t('privacy.publisher.text'))),

    h('p', { class: 'muted small' }, t('privacy.updated'))));

  // Titres ciblés par la table des matières : focalisables sans entrer dans l'ordre de tabulation.
  root.querySelectorAll('.prose-section > h2').forEach((heading) => heading.setAttribute('tabindex', '-1'));
}
