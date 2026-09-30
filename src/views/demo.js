// Démo (#/demo, CDC §4 « Parcours démo », annexe A) : PME fictive chargée dans ce navigateur,
// sans compte ni réseau. La démo est chargée automatiquement si elle n'existe pas encore ;
// aucune redirection : l'utilisateur choisit où aller (tableau de bord, formulaire…).

import { h, mount, loadCss } from '../ui/dom.js';
import { button, icon, callout, confirmDialog, toast, disclaimer, copyButton } from '../ui/components.js';
import { buildCollectUrl } from '../crypto/link.js';
import { formatFingerprint } from '../crypto/keys.js';
import { buildCampaignModel } from '../services/model.js';
import { loadDemo, DEMO_ID } from '../services/demo.js';
import { formatNumber } from '../i18n.js';

const TOUR = [
  { key: 'dashboard', icon: 'list', tab: 'tableau' },
  { key: 'registry', icon: 'shield', tab: 'registre' },
  { key: 'actions', icon: 'check', tab: 'actions' },
  { key: 'report', icon: 'print', tab: 'rapport' },
];

function consoleHref(tab) {
  return `#/admin/${DEMO_ID}/${tab}`;
}

function emptyState(t, { iconName, title, text, actions = [] }) {
  return h('div', { class: 'page page-narrow' },
    h('div', { class: 'empty-state' },
      h('span', { class: 'empty-state-icon' }, icon(iconName)),
      h('h1', null, title),
      text ? h('p', { class: 'lead' }, text) : null,
      actions.length ? h('div', { class: 'cluster cluster-center' }, actions) : null));
}

function pageHeader(t) {
  return h('header', { class: 'page-header' },
    h('div', null,
      h('p', { class: 'eyebrow' }, t('demo.eyebrow')),
      h('h1', null, t('demo.title')),
      h('p', { class: 'lead' }, t('demo.lead'))));
}

function collectLink(ctx, campaign) {
  if (!campaign?.public_key) return null;
  try {
    return buildCollectUrl(ctx.baseUrl, campaign);
  } catch (err) {
    console.warn('[Recensia] Lien de collecte de la démo indisponible.', err);
    return null;
  }
}

function companyCard(t, company, stats) {
  const headcount = company?.departments_headcount ?? {};
  return h('section', { class: 'card stack', 'aria-labelledby': 'demo-company-title' },
    h('div', null,
      h('h2', { id: 'demo-company-title' }, company?.name ?? ''),
      h('p', { class: 'muted' }, t('demo.company.subtitle', { sector: company?.sector ?? '', count: company?.headcount ?? 0 }))),
    h('p', null, t('demo.company.text', { entries: stats.responses, usages: stats.usages })),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table table-compact' },
        h('caption', null, t('demo.company.headcount_caption')),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, t('demo.company.col_department')),
          h('th', { scope: 'col', class: 'num' }, t('demo.company.col_headcount')))),
        h('tbody', null, Object.entries(headcount).map(([dept, n]) => h('tr', null,
          h('th', { scope: 'row' }, dept),
          h('td', { class: 'num' }, formatNumber(n))))))),
    callout('info', h('p', null, t('demo.company.fictitious'))));
}

function contentCard(t, model) {
  const { stats } = model;
  const engaged = model.actions.filter((a) => a.status !== 'rejected').length;
  const kpis = [
    { key: 'usages', value: stats.usages },
    { key: 'responses', value: stats.responses },
    { key: 'prohibited', value: stats.by_ai_act.prohibited_suspected ?? 0, cls: 'kpi-danger' },
    { key: 'high', value: stats.by_ai_act.high ?? 0, cls: 'kpi-danger' },
    { key: 'actions', value: engaged, cls: 'kpi-success' },
    { key: 'suggestions', value: model.suggestions.length, cls: 'kpi-warn' },
  ];
  return h('section', { class: 'card stack', 'aria-labelledby': 'demo-content-title' },
    h('h2', { id: 'demo-content-title' }, t('demo.content.title')),
    h('ul', { class: 'kpi-grid kpi-grid-compact', role: 'list' }, kpis.map((k) => h('li', { class: ['kpi', k.value ? k.cls : null] },
      h('span', { class: 'kpi-value' }, formatNumber(k.value)),
      h('span', { class: 'kpi-label' }, t(`demo.content.kpi.${k.key}`, { count: k.value }))))),
    disclaimer(t),
    h('div', { class: 'cluster' },
      h('a', { class: 'btn btn-primary', href: consoleHref('tableau') }, h('span', null, t('demo.content.open_dashboard')), icon('arrow-right'))),
    h('nav', { 'aria-label': t('demo.content.links_nav') },
      h('p', { class: 'cluster' },
        h('span', { class: 'muted' }, t('demo.content.links_label')),
        h('a', { href: consoleHref('registre') }, t('demo.content.link_registry')),
        h('a', { href: consoleHref('actions') }, t('demo.content.link_actions')),
        h('a', { href: consoleHref('rapport') }, t('demo.content.link_report')))));
}

function tourSection(t, formLink) {
  const steps = [
    ...TOUR.map((step) => ({ ...step, href: consoleHref(step.tab) })),
    { key: 'form', icon: 'users', href: formLink, external: true },
    { key: 'import', icon: 'upload', href: consoleHref('import') },
  ];
  return h('section', { class: 'section', 'aria-labelledby': 'demo-tour-title' },
    h('div', { class: 'section-header' },
      h('h2', { id: 'demo-tour-title' }, t('demo.tour.title')),
      h('p', { class: 'muted' }, t('demo.tour.lead'))),
    h('ol', { class: 'stepper stepper-cards' }, steps.map((step) => h('li', { class: 'stepper-item' },
      h('span', { class: 'stepper-icon' }, icon(step.icon)),
      h('h3', { class: 'stepper-title' }, step.href
        ? h('a', step.external ? { href: step.href, target: '_blank', rel: 'noopener' } : { href: step.href },
          t(`demo.tour.${step.key}.title`),
          step.external ? h('span', { class: 'visually-hidden' }, ` ${t('demo.form.new_tab')}`) : null)
        : t(`demo.tour.${step.key}.title`)),
      h('p', null, t(`demo.tour.${step.key}.text`))))));
}

function formSection(t, campaign, link) {
  const mail = (campaign?.settings?.channels ?? []).find((c) => c?.type === 'mailto')?.target ?? null;
  const steps = ['open', 'describe', 'copy', 'import'];
  return h('section', { class: 'card stack', 'aria-labelledby': 'demo-form-title' },
    h('h2', { id: 'demo-form-title' }, t('demo.form.title')),
    h('p', null, t('demo.form.text')),
    h('ol', { class: 'stack-sm' }, steps.map((key) => h('li', null, t(`demo.form.steps.${key}`)))),
    mail ? h('p', { class: 'muted' }, t('demo.form.mail_note', { email: mail })) : null,
    link
      ? [
        campaign.fingerprint ? h('p', null, t('demo.form.fingerprint'), ' ', h('strong', { class: 'fingerprint' }, formatFingerprint(campaign.fingerprint))) : null,
        h('div', { class: 'cluster' },
          h('a', { class: 'btn btn-primary', href: link, target: '_blank', rel: 'noopener' },
            h('span', null, t('demo.form.open')), icon('external'),
            h('span', { class: 'visually-hidden' }, ` ${t('demo.form.new_tab')}`)),
          copyButton(() => link, { label: t('demo.form.copy_link') }),
          h('a', { class: 'btn btn-secondary', href: consoleHref('import') }, icon('upload'), h('span', null, t('demo.form.import')))),
      ]
      : callout('warn', h('p', null, t('demo.form.no_key'))));
}

export async function render(root, { ctx }) {
  const { t, store } = ctx;
  ctx.setTitle(t('demo.meta.title'));
  // Grille d'indicateurs compacte partagée avec le plan d'actions.
  loadCss('src/styles/actions.css');

  if (!store) {
    mount(root, emptyState(t, { iconName: 'alert', title: t('demo.no_store.title'), text: t('demo.no_store.text') }));
    return undefined;
  }

  let disposed = false;
  let company = null;

  async function resetDemo() {
    const ok = await confirmDialog({
      title: t('demo.reset.confirm_title'),
      message: t('demo.reset.confirm_message'),
      confirmLabel: t('demo.reset.confirm'),
      danger: true,
    });
    if (!ok || disposed) return;
    try {
      await loadDemo(store, ctx.data, { reset: true });
    } catch (err) {
      console.error('[Recensia] Réinitialisation de la démo impossible.', err);
      toast(t('demo.reset.error'), 'danger');
      return;
    }
    toast(t('demo.status.reset_done'), 'success');
    try {
      await draw({ notice: 'reset_done', focusNotice: true });
    } catch (err) {
      console.error('[Recensia] Affichage de la démo impossible.', err);
      globalThis.location.reload();
    }
  }

  async function draw({ notice = null, focusNotice = false } = {}) {
    const campaign = await store.getCampaign(DEMO_ID);
    if (disposed) return;
    if (!campaign) throw new Error('Démo absente après chargement.');
    const model = await buildCampaignModel(ctx, campaign);
    if (disposed) return;
    const link = collectLink(ctx, campaign);

    const noticeNode = notice
      ? h('div', { class: 'demo-notice', role: 'status', tabindex: '-1' }, callout('success', h('p', null, t(`demo.status.${notice}`))))
      : null;

    mount(root, h('div', { class: 'page demo' },
      pageHeader(t),
      noticeNode,
      h('div', { class: 'grid grid-2' },
        companyCard(t, company, model.stats),
        contentCard(t, model)),
      tourSection(t, link),
      h('div', { class: 'grid grid-2' },
        formSection(t, campaign, link),
        h('section', { class: 'card stack', 'aria-labelledby': 'demo-reset-title' },
          h('h2', { id: 'demo-reset-title' }, t('demo.reset.title')),
          h('p', null, t('demo.reset.text')),
          h('div', { class: 'cluster' },
            button(t('demo.reset.button'), resetDemo, { icon: 'refresh' })))),
      h('div', { class: 'section' }, disclaimer(t))));
    if (focusNotice && noticeNode) noticeNode.focus({ preventScroll: false });
  }

  mount(root, h('div', { class: 'page demo' },
    pageHeader(t),
    h('p', { class: 'muted', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', t('demo.status.loading'))));

  try {
    company = (await ctx.data.get('demo-company'))?.company ?? null;
    const result = await loadDemo(store, ctx.data);
    if (disposed) return undefined;
    await draw({ notice: result.loaded ? 'loaded' : null });
  } catch (err) {
    console.error('[Recensia] Démo indisponible.', err);
    if (!disposed) {
      mount(root, emptyState(t, {
        iconName: 'danger',
        title: t('demo.status.error_title'),
        text: t('demo.status.error_text'),
        actions: [button(t('common.actions.retry'), () => globalThis.location.reload(), { variant: 'primary', icon: 'refresh' })],
      }));
    }
  }

  return () => {
    disposed = true;
  };
}
