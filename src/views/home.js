// Accueil : proposition de valeur, trois étapes, fonctionnement sans serveur.

import { h, mount } from '../ui/dom.js';
import { icon, levelBadge, disclaimer, callout } from '../ui/components.js';

const PREVIEW_ROWS = [
  { key: 'cv', aiAct: 'high', data: 2 },
  { key: 'chatbot', aiAct: 'limited', data: 2 },
  { key: 'visuals', aiAct: 'limited', data: 0 },
  { key: 'minutes', aiAct: 'minimal', data: 1 },
];

function hero(t) {
  return h('section', { class: 'hero', 'aria-labelledby': 'home-title' },
    h('div', { class: 'hero-text stack' },
      h('p', { class: 'eyebrow' }, t('home.hero.eyebrow')),
      h('h1', { id: 'home-title' }, t('home.hero.title')),
      h('p', { class: 'lead' }, t('home.hero.lead')),
      h('div', { class: 'cluster hero-actions' },
        h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), h('span', null, t('home.hero.cta_new'))),
        h('a', { class: 'btn btn-secondary', href: '#/demo' }, t('home.hero.cta_demo')),
        h('a', { class: 'btn btn-ghost', href: '#/admin' }, t('home.hero.cta_admin'), icon('arrow-right'))),
      h('p', { class: 'hero-note muted' }, icon('offline'), h('span', null, t('home.hero.note')))),
    preview(t));
}

function preview(t) {
  return h('figure', { class: 'hero-preview card' },
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table table-compact' },
        h('caption', null, t('home.preview.caption')),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, t('home.preview.col_usage')),
          h('th', { scope: 'col' }, t('home.preview.col_ai_act')),
          h('th', { scope: 'col' }, t('home.preview.col_data')))),
        h('tbody', null, PREVIEW_ROWS.map((row) => h('tr', null,
          h('th', { scope: 'row' },
            h('span', { class: 'preview-name' }, t(`home.preview.rows.${row.key}.name`)),
            h('span', { class: 'preview-meta muted' }, t(`home.preview.rows.${row.key}.meta`))),
          h('td', null, levelBadge('ai_act', row.aiAct, t)),
          h('td', null, levelBadge('data', row.data, t))))))),
    h('figcaption', { class: 'muted' }, t('home.preview.note')));
}

function steps(t) {
  const items = [
    { key: 'create', icon: 'key' },
    { key: 'share', icon: 'share' },
    { key: 'consolidate', icon: 'list' },
  ];
  return h('section', { class: 'section', 'aria-labelledby': 'home-steps' },
    h('div', { class: 'section-header' },
      h('h2', { id: 'home-steps' }, t('home.steps.title')),
      h('p', { class: 'muted' }, t('home.steps.lead'))),
    h('ol', { class: 'stepper stepper-cards' }, items.map((item) => h('li', { class: 'stepper-item' },
      h('span', { class: 'stepper-icon' }, icon(item.icon)),
      h('h3', { class: 'stepper-title' }, t(`home.steps.${item.key}.title`)),
      h('p', null, t(`home.steps.${item.key}.text`))))));
}

function serverless(t) {
  const flow = [
    { key: 'link', icon: 'lock' },
    { key: 'respondent', icon: 'shield' },
    { key: 'owner', icon: 'key' },
  ];
  return h('section', { class: 'section card card-accent', 'aria-labelledby': 'home-serverless' },
    h('h2', { id: 'home-serverless' }, t('home.serverless.title')),
    h('p', null, t('home.serverless.intro')),
    h('ol', { class: 'flow', 'aria-label': t('home.serverless.flow_label') }, flow.map((step) => h('li', { class: 'flow-step' },
      h('span', { class: 'flow-icon' }, icon(step.icon)),
      h('p', null,
        h('strong', null, t(`home.serverless.flow.${step.key}.title`)), ' ',
        t(`home.serverless.flow.${step.key}.text`))))),
    callout('warn', h('p', null, t('home.serverless.key_warning'))),
    h('p', { class: 'muted' }, t('home.serverless.anonymity')),
    h('p', null, h('a', { href: '#/privacy' }, t('home.serverless.privacy_link'))));
}

function features(t) {
  const items = [
    { key: 'registry', icon: 'list' },
    { key: 'axes', icon: 'shield' },
    { key: 'actions', icon: 'check' },
    { key: 'exports', icon: 'download' },
  ];
  return h('section', { class: 'section', 'aria-labelledby': 'home-features' },
    h('h2', { id: 'home-features' }, t('home.features.title')),
    h('ul', { class: 'grid feature-grid', role: 'list' }, items.map((item) => h('li', { class: 'card feature' },
      h('span', { class: 'feature-icon' }, icon(item.icon)),
      h('h3', null, t(`home.features.${item.key}.title`)),
      h('p', { class: 'muted' }, t(`home.features.${item.key}.text`))))));
}

export async function render(root, { ctx }) {
  const { t } = ctx;
  ctx.setTitle(t('home.meta.title'));
  mount(root, h('div', { class: 'page home' },
    hero(t),
    steps(t),
    serverless(t),
    features(t),
    h('div', { class: 'home-disclaimer stack-sm' },
      disclaimer(t),
      h('p', { class: 'muted' }, t('home.disclaimer_extra')))));
}
