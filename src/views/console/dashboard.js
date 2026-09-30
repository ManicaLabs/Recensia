// Onglet « Tableau de bord » de la console (#/admin/<id>/tableau) — CDC §8.1.
// Indicateurs, usages prioritaires, répartitions (graphiques SVG de src/ui/charts.js), plan
// d'actions et échéances réglementaires lues dans data/regulatory-calendar.json (aucune date en dur).
// En mode anonyme, tout effectif inférieur à min_group_size est masqué (« < k »).
// Les fonctions *Items / *Summary sont pures (testées sous Node).

import { h, mount, loadCss } from '../../ui/dom.js';
import { icon, levelBadge, disclaimer, callout } from '../../ui/components.js';
import { barChart, stackedBar, donut, chartStyles, formatShare } from '../../ui/charts.js';
import { formatDate, formatNumber } from '../../i18n.js';
import { AI_ACT_ORDER, DATA_LEVELS } from '../../engine/levels.js';
import { maskCount } from '../../engine/stats.js';
import { priorityGroups, aiActDisplay, dataDisplay, countDisplay, isToQualify, openQuestions, minGroupSize } from './registry/filters.js';
import { requestRegistryDetail, requestRegistryFilters } from './registry/focus.js';

const CSS = 'src/styles/dashboard.css';
export const TOP_TOOLS_LIMIT = 8;
export const PRIORITY_LIMIT = 8;
export const ACTION_STATUSES = Object.freeze(['todo', 'in_progress', 'done', 'rejected']);
const DEADLINE_STATUS_KEYS = new Set(['to_confirm', 'to_verify', 'postponed', 'proposed']);

// ---------------------------------------------------------------------------------------------
// Calculs d'affichage (purs)
// ---------------------------------------------------------------------------------------------

function maskOf(stats) {
  const k = Number.isInteger(stats?.mask?.k) && stats.mask.k > 0 ? stats.mask.k : 5;
  return { k, mode: stats?.mask?.active ? 'anonymous' : 'open' };
}

/** Barres « usages par niveau AI Act » (ordre de gravité). */
export function aiActItems(stats, t) {
  return AI_ACT_ORDER.map((level) => ({
    label: t(`common.levels.ai_act.${level}`),
    value: stats?.by_ai_act?.[level] ?? 0,
    className: `bar-aia-${level}`,
  }));
}

/** Barres « usages par exposition des données » (du plus faible au plus critique). */
export function dataItems(stats, t) {
  return DATA_LEVELS.map((n) => ({
    label: `${n} — ${t(`common.levels.data.${n}`)}`,
    value: stats?.by_data?.[n] ?? 0,
    className: `bar-data-${n}`,
  }));
}

/**
 * Élément de barre pour un effectif éventuellement masqué : un effectif masqué est dessiné en
 * pointillés jusqu'à la borne k (jamais à sa valeur réelle) et affiché « < k ».
 */
export function maskedItem(label, { count, display, masked }, k) {
  return masked
    ? { label, value: k, display, masked: true }
    : { label, value: count ?? 0, display: display ?? String(count ?? 0) };
}

/**
 * Outils les plus déclarés (nombre de déclarations). Au-delà de `limit`, les suivants sont
 * regroupés dans « Autres outils » (effectif lui-même masqué s'il est faible).
 */
export function toolItems(stats, t, { limit = TOP_TOOLS_LIMIT } = {}) {
  const { k, mode } = maskOf(stats);
  const list = stats?.top_tools ?? [];
  const head = list.slice(0, limit).map((tool) => maskedItem(tool.label, tool, k));
  const rest = list.slice(limit);
  if (rest.length > 0) {
    const count = rest.reduce((sum, tool) => sum + (tool.count ?? 0), 0);
    const display = maskCount(count, k, mode);
    head.push({ ...maskedItem(t('dashboard.charts.other_tools', { count: rest.length }), { count, display, masked: display !== String(count) }, k), className: 'bar-muted' });
  }
  return head;
}

/** Déclarations par service (ordre de la campagne ; « Non renseigné » pour les réponses sans service). */
export function departmentItems(stats, t) {
  const { k } = maskOf(stats);
  return (stats?.by_department ?? []).map((d) => maskedItem(d.department ?? t('dashboard.charts.no_department'), d, k));
}

/** Segments « plan d'actions » par statut. */
export function actionItems(stats, t) {
  return ACTION_STATUSES.map((status) => ({
    label: t(`common.action_status.${status}`),
    value: stats?.actions_progress?.[status] ?? 0,
    className: `bar-status-${status}`,
  }));
}

/** Avancement du plan : actions faites sur les actions retenues (hors rejetées). */
export function actionsSummary(stats) {
  const p = stats?.actions_progress ?? {};
  const total = p.total ?? 0;
  const done = p.done ?? 0;
  const retained = Math.max(0, total - (p.rejected ?? 0));
  return {
    total,
    done,
    retained,
    pending: p.pending_suggestions ?? 0,
    share: retained > 0 ? done / retained : 0,
  };
}

/** Part des usages signalés « IA fantôme » (comptes personnels ou non maîtrisés). */
export function shadowSummary(stats) {
  const total = stats?.usages ?? 0;
  const count = Math.min(stats?.shadow_ai?.count ?? 0, total);
  return { count, total, share: total > 0 ? count / total : 0 };
}

/** Segments de l'anneau « IA fantôme » / autres usages. */
export function shadowItems(stats, t) {
  const { count, total } = shadowSummary(stats);
  return [
    { label: t('dashboard.shadow.shadow'), value: count, className: 'bar-data-2' },
    { label: t('dashboard.shadow.others'), value: total - count, className: 'bar-muted' },
  ];
}

/**
 * Raison principale pour laquelle un usage est prioritaire (clé de texte de dashboard.priority).
 */
export function priorityReason(group) {
  const level = group?.effective?.ai_act_level;
  if (level === 'prohibited_suspected') return 'prohibited';
  if (level === 'high') return 'high';
  if (level === 'to_qualify') return 'to_qualify';
  return isToQualify(group) ? 'data_to_qualify' : 'other';
}

/** Libellé de la source de vérification du calendrier (clé de dashboard.deadlines.source). */
export function verificationSourceKey(calendar) {
  const source = calendar?.verification_source;
  return source === 'primary' || source === 'secondary' ? source : null;
}

// ---------------------------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------------------------

/** Clic ordinaire (pas d'ouverture dans un nouvel onglet) : seul cas où la demande sert. */
function plainClick(event) {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

function registryLink(campaign, group, content, className) {
  return h('a', {
    href: `#/admin/${campaign.id}/registre`,
    class: className,
    onClick: (event) => { if (plainClick(event)) requestRegistryDetail(campaign.id, group.usage_key); },
  }, content);
}

function kpi({ label, value, detail, tone, link }) {
  return h('li', { class: ['kpi', tone ? `kpi-${tone}` : null] },
    h('span', { class: 'kpi-label' }, label),
    h('span', { class: 'kpi-value' }, value),
    detail ? h('span', { class: 'kpi-detail' }, detail) : null,
    link ?? null);
}

function kpis(campaign, model, t) {
  const { stats } = model;
  const excluded = (model.entries ?? []).filter((e) => e && e.excluded === true).length;
  const shadow = shadowSummary(stats);
  const plan = actionsSummary(stats);
  const questions = (stats.questions ?? []).length;
  const toRegistry = (filtersToApply, label) => h('a', {
    class: 'kpi-link',
    href: `#/admin/${campaign.id}/registre`,
    onClick: (event) => { if (plainClick(event)) requestRegistryFilters(campaign.id, filtersToApply); },
  }, label);

  const items = [
    { label: t('dashboard.kpi.usages'), value: formatNumber(stats.usages), detail: t('dashboard.kpi.usages_detail') },
    {
      label: t('dashboard.kpi.responses'),
      value: formatNumber(stats.responses),
      detail: excluded ? t('dashboard.kpi.responses_excluded', { count: excluded }) : t(campaign.mode === 'open' ? 'dashboard.kpi.responses_open' : 'dashboard.kpi.responses_anonymous'),
    },
    campaign.mode === 'open' && stats.respondents !== null
      ? { label: t('dashboard.kpi.respondents'), value: formatNumber(stats.respondents), detail: t('dashboard.kpi.respondents_detail') }
      : null,
    {
      label: t('dashboard.kpi.shadow'),
      value: formatShare(shadow.share),
      detail: t('dashboard.kpi.shadow_detail', { count: shadow.count, total: shadow.total }),
      tone: shadow.count > 0 ? 'warn' : null,
    },
    {
      label: t('dashboard.kpi.to_qualify'),
      value: formatNumber(stats.to_qualify),
      detail: stats.to_qualify ? null : t('dashboard.kpi.to_qualify_none'),
      tone: stats.to_qualify > 0 ? 'warn' : null,
      link: stats.to_qualify > 0 ? toRegistry({ to_qualify: true }, t('dashboard.kpi.to_qualify_link')) : null,
    },
    {
      label: t('dashboard.kpi.questions'),
      value: formatNumber(questions),
      detail: questions ? t('dashboard.kpi.questions_detail') : t('dashboard.kpi.questions_none'),
      tone: questions > 0 ? 'warn' : null,
    },
    {
      label: t('dashboard.kpi.actions'),
      value: plan.retained ? formatShare(plan.share) : '—',
      detail: plan.retained
        ? t('dashboard.kpi.actions_detail', { count: plan.done, total: plan.retained })
        : t(plan.total ? 'dashboard.kpi.actions_all_rejected' : 'dashboard.kpi.actions_none', { count: plan.pending }),
      tone: plan.retained && plan.done === plan.retained ? 'success' : null,
    },
  ].filter(Boolean);

  return h('section', { class: 'dashboard-section', 'aria-labelledby': 'dash-kpi-title' },
    h('h3', { id: 'dash-kpi-title', class: 'visually-hidden' }, t('dashboard.kpi.title')),
    h('ul', { class: 'kpi-grid dashboard-kpis', role: 'list' }, items.map(kpi)));
}

function priorities(campaign, model, t) {
  const all = priorityGroups(model.groups);
  const list = all.slice(0, PRIORITY_LIMIT);
  const body = list.length === 0
    ? callout('success', h('p', null, t('dashboard.priority.none')))
    : h('ol', { class: 'dashboard-priorities', role: 'list' }, list.map((group) => {
      const ai = aiActDisplay(group);
      const data = dataDisplay(group);
      const reason = priorityReason(group);
      const open = openQuestions(group).length;
      return h('li', { class: 'dashboard-priority' },
        h('div', { class: 'dashboard-priority-main' },
          registryLink(campaign, group, group.name || group.id, 'dashboard-priority-name'),
          h('span', { class: 'dashboard-priority-meta muted' },
            h('span', { class: 'dashboard-id' }, group.id), ' · ',
            t('dashboard.priority.count', { display: countDisplay(group, campaign) }),
            open ? ` · ${t('dashboard.priority.questions', { count: open })}` : '')),
        h('div', { class: 'dashboard-priority-levels' },
          levelBadge('ai_act', ai.level, t),
          levelBadge('data', data.level, t),
          ai.overridden || data.overridden ? h('span', { class: 'dashboard-flag' }, t('dashboard.priority.overridden')) : null),
        h('p', { class: 'dashboard-priority-reason' }, t(`dashboard.priority.reason.${reason}`)));
    }));
  return h('section', { class: 'card dashboard-section dashboard-priority-card', 'aria-labelledby': 'dash-priority-title' },
    h('div', { class: 'dashboard-card-head' },
      h('h3', { id: 'dash-priority-title' }, t('dashboard.priority.title')),
      all.length ? h('span', { class: 'tab-count' }, String(all.length)) : null),
    h('p', { class: 'muted small' }, t('dashboard.priority.lead')),
    body,
    all.length > list.length
      ? h('p', null, h('a', {
        href: `#/admin/${campaign.id}/registre`,
        onClick: (event) => { if (plainClick(event)) requestRegistryFilters(campaign.id, { priority: true }); },
      }, t('dashboard.priority.more', { count: all.length - list.length, total: all.length })))
      : null);
}

function chartCard(id, title, note, chart) {
  return h('section', { class: 'card dashboard-chart-card', 'aria-labelledby': id },
    h('h4', { id, class: 'dashboard-card-title' }, title),
    note ? h('p', { class: 'muted small dashboard-chart-note' }, note) : null,
    chart);
}

function headers(t, valueKey = 'dashboard.charts.col_usages') {
  return { label: t('dashboard.charts.col_label'), value: t(valueKey), share: t('dashboard.charts.col_share') };
}

function distribution(model, t) {
  const { stats } = model;
  return h('div', { class: 'grid grid-2 dashboard-grid' },
    chartCard('dash-aia-title', t('dashboard.charts.ai_act'), t('dashboard.charts.ai_act_note'),
      barChart(aiActItems(stats, t), { title: t('dashboard.charts.ai_act'), caption: false, headers: headers(t) })),
    chartCard('dash-data-title', t('dashboard.charts.data'), t('dashboard.charts.data_note'),
      barChart(dataItems(stats, t), { title: t('dashboard.charts.data'), caption: false, headers: headers(t) })));
}

function toolsAndDepartments(campaign, model, t) {
  const { stats } = model;
  const { k } = maskOf(stats);
  const maskNote = stats.mask?.active ? t('dashboard.charts.mask_note', { k }) : null;
  const departments = departmentItems(stats, t);
  return h('div', { class: 'grid grid-2 dashboard-grid' },
    chartCard('dash-tools-title', t('dashboard.charts.tools'), maskNote,
      barChart(toolItems(stats, t), {
        title: t('dashboard.charts.tools'), caption: false, className: 'bar-primary',
        headers: headers(t, 'dashboard.charts.col_declarations'), emptyText: t('dashboard.charts.empty'),
      })),
    chartCard('dash-dept-title', t('dashboard.charts.departments'), maskNote,
      departments.length
        ? barChart(departments, { title: t('dashboard.charts.departments'), caption: false, className: 'bar-primary', headers: headers(t, 'dashboard.charts.col_declarations') })
        : h('p', { class: 'muted' }, t('dashboard.charts.no_departments'))));
}

function steering(campaign, model, t) {
  const { stats } = model;
  const plan = actionsSummary(stats);
  const shadow = shadowSummary(stats);
  const actionsHref = `#/admin/${campaign.id}/actions`;
  return h('div', { class: 'grid grid-2 dashboard-grid' },
    h('section', { class: 'card dashboard-chart-card', 'aria-labelledby': 'dash-actions-title' },
      h('h4', { id: 'dash-actions-title', class: 'dashboard-card-title' }, t('dashboard.actions.title')),
      plan.retained
        ? h('p', { class: 'dashboard-big' }, t('dashboard.actions.progress', { count: plan.done, total: plan.retained }))
        : h('p', { class: 'muted' }, t(plan.total ? 'dashboard.actions.all_rejected' : 'dashboard.actions.none')),
      plan.total ? stackedBar(actionItems(stats, t), { title: t('dashboard.actions.chart'), caption: false, headers: headers(t, 'dashboard.charts.col_actions') }) : null,
      plan.pending ? callout('info', h('p', null, t('dashboard.actions.pending', { count: plan.pending }))) : null,
      h('p', null, h('a', { class: 'btn btn-secondary btn-sm', href: actionsHref }, h('span', null, t('dashboard.actions.open')), icon('arrow-right')))),
    h('section', { class: 'card dashboard-chart-card', 'aria-labelledby': 'dash-shadow-title' },
      h('h4', { id: 'dash-shadow-title', class: 'dashboard-card-title' }, t('dashboard.shadow.title')),
      h('p', { class: 'muted small dashboard-chart-note' }, t('dashboard.shadow.note')),
      donut(shadowItems(stats, t), {
        title: t('dashboard.shadow.title'),
        caption: false,
        centerLabel: [formatShare(shadow.share), t('dashboard.shadow.center')],
        headers: headers(t),
      })));
}

function deadlineItem(d, t, { past }) {
  const days = Number.isInteger(d.days) ? d.days : null;
  let relative = null;
  if (!past && days !== null) relative = days === 0 ? t('dashboard.deadlines.today') : t('dashboard.deadlines.in_days', { count: days });
  const status = DEADLINE_STATUS_KEYS.has(d.status) ? h('span', { class: 'tag dashboard-tag-warn' }, t(`dashboard.deadlines.status.${d.status}`)) : null;
  const source = typeof d.source_url === 'string' && /^https:\/\//.test(d.source_url)
    ? h('a', { href: d.source_url, target: '_blank', rel: 'noopener noreferrer', class: 'dashboard-source' },
      h('span', null, t('dashboard.deadlines.source_link')),
      h('span', { class: 'visually-hidden' }, ` ${t('dashboard.deadlines.source_for', { label: d.label })}`),
      icon('external'))
    : null;
  return h('li', { class: ['dashboard-deadline', past ? 'is-past' : 'is-upcoming'] },
    h('time', { class: 'dashboard-deadline-date', datetime: d.date }, formatDate(d.date)),
    h('div', { class: 'dashboard-deadline-body' },
      h('p', { class: 'dashboard-deadline-label' }, d.label),
      h('p', { class: 'dashboard-deadline-meta cluster' },
        past ? h('span', { class: 'tag' }, t('dashboard.deadlines.in_force')) : (relative ? h('span', { class: 'tag dashboard-tag-info' }, relative) : null),
        status,
        h('span', { class: 'muted' }, d.usages_count ? t('dashboard.deadlines.usages', { count: d.usages_count }) : t('dashboard.deadlines.no_usage')),
        source),
      d.note ? h('details', { class: 'dashboard-deadline-note' },
        h('summary', null, t('dashboard.deadlines.note')),
        h('p', { class: 'small' }, d.note)) : null));
}

function deadlines(model, t) {
  const { stats, calendar } = model;
  const upcoming = stats.upcoming_deadlines ?? [];
  const past = stats.past_deadlines ?? [];
  const sourceKey = verificationSourceKey(calendar);
  const verified = calendar?.last_verified
    ? t(sourceKey ? 'dashboard.deadlines.verified_source' : 'dashboard.deadlines.verified', {
      date: formatDate(calendar.last_verified),
      source: sourceKey ? t(`dashboard.deadlines.source.${sourceKey}`) : '',
    })
    : t('dashboard.deadlines.unverified');
  return h('section', { class: 'card dashboard-section dashboard-deadlines', 'aria-labelledby': 'dash-deadlines-title' },
    h('h3', { id: 'dash-deadlines-title' }, t('dashboard.deadlines.title')),
    h('p', { class: 'dashboard-verified' }, icon('shield'), h('span', null, verified)),
    calendar?.reference_text ? h('p', { class: 'muted small' }, t('dashboard.deadlines.reference', { text: calendar.reference_text })) : null,
    h('div', { class: 'dashboard-deadline-columns' },
      h('div', null,
        h('h4', null, t('dashboard.deadlines.upcoming')),
        upcoming.length ? h('ol', { class: 'dashboard-deadline-list', role: 'list' }, upcoming.map((d) => deadlineItem(d, t, { past: false })))
          : h('p', { class: 'muted' }, t('dashboard.deadlines.none_upcoming'))),
      h('div', null,
        h('h4', null, t('dashboard.deadlines.past')),
        past.length ? h('ol', { class: 'dashboard-deadline-list', role: 'list' }, [...past].reverse().map((d) => deadlineItem(d, t, { past: true })))
          : h('p', { class: 'muted' }, t('dashboard.deadlines.none_past')))),
    h('p', { class: 'muted small' }, t('dashboard.deadlines.legal')));
}

function emptyState(campaign, model, t) {
  const base = `#/admin/${campaign.id}`;
  const excluded = (model.entries ?? []).some((e) => e && e.excluded === true);
  return h('section', { class: 'card dashboard-empty', 'aria-labelledby': 'dash-empty-title' },
    h('div', { class: 'empty-state' },
      h('span', { class: 'empty-state-icon' }, icon('list')),
      h('h3', { id: 'dash-empty-title' }, t('dashboard.empty.title')),
      h('p', { class: 'lead' }, t(excluded ? 'dashboard.empty.excluded' : 'dashboard.empty.text')),
      h('ol', { class: 'dashboard-empty-steps', role: 'list' },
        h('li', null, h('a', { class: 'btn btn-primary', href: `${base}/diffuser` }, icon('share'), h('span', null, t('dashboard.empty.share'))),
          h('span', { class: 'muted small' }, t('dashboard.empty.share_help'))),
        h('li', null, h('a', { class: 'btn btn-secondary', href: `${base}/import` }, icon('upload'), h('span', null, t('dashboard.empty.import'))),
          h('span', { class: 'muted small' }, t('dashboard.empty.import_help'))),
        h('li', null, h('a', { class: 'btn btn-secondary', href: `${base}/saisir` }, icon('plus'), h('span', null, t('dashboard.empty.add'))),
          h('span', { class: 'muted small' }, t('dashboard.empty.add_help'))))));
}

export async function render(root, { campaign, model, ctx }) {
  const { t } = ctx;
  await Promise.all([loadCss(CSS), chartStyles()]);
  const empty = (model.groups ?? []).length === 0;
  const k = minGroupSize(campaign);

  mount(root, h('div', { class: 'dashboard stack-lg' },
    h('header', { class: 'dashboard-header' },
      h('h2', { id: 'console-tab-title' }, t('dashboard.title')),
      h('p', { class: 'muted' }, t('dashboard.lead', { date: formatDate(model.today) })),
      campaign.mode === 'anonymous' ? h('p', { class: 'muted small' }, t('dashboard.mask', { k })) : null),
    disclaimer(t),
    empty ? emptyState(campaign, model, t) : [
      kpis(campaign, model, t),
      priorities(campaign, model, t),
      h('section', { class: 'dashboard-section', 'aria-labelledby': 'dash-dist-title' },
        h('h3', { id: 'dash-dist-title', class: 'dashboard-section-title' }, t('dashboard.sections.distribution')),
        distribution(model, t)),
      h('section', { class: 'dashboard-section', 'aria-labelledby': 'dash-tools-section' },
        h('h3', { id: 'dash-tools-section', class: 'dashboard-section-title' }, t('dashboard.sections.tools')),
        toolsAndDepartments(campaign, model, t)),
      h('section', { class: 'dashboard-section', 'aria-labelledby': 'dash-steer-title' },
        h('h3', { id: 'dash-steer-title', class: 'dashboard-section-title' }, t('dashboard.sections.steering')),
        steering(campaign, model, t)),
    ],
    deadlines(model, t),
    empty ? null : disclaimer(t)));
}
