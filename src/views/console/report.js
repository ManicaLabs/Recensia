// Onglet « Rapport » de la console : rapport de synthèse imprimable (CDC §8.1) et exports
// (impression / PDF, Excel et CSV du registre ; la sauvegarde JSON est dans « Paramètres »).
// Les fonctions exportées en tête de fichier sont pures (testées sous Node).
// SheetJS (≈ 1 Mo) n'est chargé qu'au clic sur « Exporter en Excel (.xlsx) ».
// Libellés et messages d'export identiques à ceux de l'onglet Registre.

import { h, mount, loadCss } from '../../ui/dom.js';
import { button, icon, toast, disclaimer } from '../../ui/components.js';
import { barChart, stackedBar, chartStyles } from '../../ui/charts.js';
import { downloadBlob, downloadText } from '../../ui/download.js';
import { AI_ACT_ORDER, DATA_LEVELS, isDataLevel } from '../../engine/levels.js';
import { maskCount } from '../../engine/stats.js';
import { optionLabel } from '../../engine/labels.js';
import { registryColumns, commentsExportable, registryRows, exportFilename, applicableDeadline } from '../../export/registry.js';
import { toCSV } from '../../export/csv.js';
import { formatDate, formatNumber, LOCALE } from '../../i18n.js';
import { sortActions, isOverdue, axisBadges } from './actions.js';
// Typographie française à l'affichage des textes venus de data/ (règles, calendrier, actions).
import { frenchSpacing as fr } from '../../ui/questionnaire.js';
// Représentation des effectifs masqués commune au tableau de bord et au rapport.
import { maskedItem } from './dashboard.js';

// ---------------------------------------------------------------------------------------------
// Logique pure
// ---------------------------------------------------------------------------------------------

/** Niveaux AI Act qui rendent un usage prioritaire. */
export const PRIORITY_AI_LEVELS = Object.freeze(['prohibited_suspected', 'high', 'to_qualify']);
/** Outils affichés individuellement (les suivants sont regroupés, comme au tableau de bord). */
export const TOP_TOOLS = 8;

/** Origine des déclarations prises en compte (hors exclues) : { code, manual, demo }. */
export function entrySources(entries) {
  const out = { code: 0, manual: 0, demo: 0 };
  for (const e of entries ?? []) {
    if (!e || e.excluded === true) continue;
    if (Object.hasOwn(out, e.source)) out[e.source] += 1;
  }
  return out;
}

/**
 * Usages prioritaires : interdit suspecté, haut risque, à qualifier (AI Act) ou exposition
 * critique des données. Ordre du registre (gravité décroissante). → [{ group, reasons[] }]
 */
export function priorityUsages(groups) {
  const out = [];
  for (const g of groups ?? []) {
    const reasons = [];
    const ai = g?.effective?.ai_act_level;
    if (PRIORITY_AI_LEVELS.includes(ai)) reasons.push(ai);
    if (g?.effective?.data_level === 3) reasons.push('data_critical');
    if (g?.computed?.data_to_qualify === true && !isDataLevel(g?.assessment?.override_data_level) && !reasons.includes('to_qualify')) {
      reasons.push('data_to_qualify');
    }
    if (reasons.length) out.push({ group: g, reasons });
  }
  return out;
}

/**
 * Déclencheurs à citer dans le rapport : sans les règles transverses (littératie, gouvernance),
 * ni la règle par défaut « risque minimal », ni le niveau « aucune donnée ».
 */
export function keyTriggers(group) {
  return (group?.computed?.triggers ?? []).filter((trig) => trig
    && trig.kind !== 'transverse'
    && !(trig.axis === 'ai_act' && trig.level === 'minimal')
    && !(trig.axis === 'data' && trig.kind === 'level' && trig.level === 0));
}

function signalCount(groups, id) {
  return (groups ?? []).filter((g) => (g?.computed?.signals ?? []).some((s) => s.id === id)).length;
}

/**
 * Principaux risques, du plus grave au moins grave, avec leur nombre d'usages (lignes du
 * registre). Seuls les risques présents (n > 0) sont renvoyés. → [{ id, count }]
 */
export function mainRisks(stats, groups) {
  const byAi = stats?.by_ai_act ?? {};
  const byData = stats?.by_data ?? {};
  const candidates = [
    ['prohibited_suspected', byAi.prohibited_suspected ?? 0],
    ['high', byAi.high ?? 0],
    ['credentials', signalCount(groups, 'credentials')],
    ['data_critical', byData[3] ?? 0],
    ['to_qualify', stats?.to_qualify ?? 0],
    ['sensitive_data', signalCount(groups, 'sensitive_data')],
    ['shadow_ai', stats?.shadow_ai?.count ?? 0],
    ['no_review_external', signalCount(groups, 'no_review_external')],
    ['limited', byAi.limited ?? 0],
  ];
  return candidates.filter(([, count]) => count > 0).map(([id, count]) => ({ id, count }));
}

/**
 * Barres d'un graphique d'effectifs masquables (mode anonyme), avec la représentation du tableau
 * de bord (maskedItem) : un effectif masqué est dessiné en pointillés jusqu'à la borne k (jamais
 * à sa valeur réelle) et affiché « < k ».
 * order 'count' : effectifs visibles par ordre décroissant, puis effectifs masqués par ordre
 * alphabétique (leur ordre ne révèle pas leurs valeurs relatives) ; order 'given' : ordre d'origine.
 * Au-delà des `limit` premières barres, les suivantes sont soit omises, soit (avec `other`,
 * comme le tableau de bord) regroupées dans une barre `other.label` dont l'effectif (somme) est
 * lui-même masqué s'il est inférieur à k.
 * list = [{ label, count, display, masked }] → [{ label, value, display, masked?, className }]
 */
export function maskedBarItems(list, { order = 'count', className = 'bar-data-1', limit = Infinity, k = 5, mode = 'anonymous', other = null } = {}) {
  const rows = (list ?? []).filter(Boolean).map((x) => ({
    label: String(x.label ?? ''),
    count: Number(x.count) || 0,
    display: x.display === undefined || x.display === null ? undefined : String(x.display),
    masked: x.masked === true,
  }));
  const byLabel = (a, b) => a.label.localeCompare(b.label, 'fr');
  const ordered = order === 'given'
    ? rows
    : [...rows.filter((x) => !x.masked).sort((a, b) => b.count - a.count || byLabel(a, b)), ...rows.filter((x) => x.masked).sort(byLabel)];
  const toItem = (x) => ({ ...maskedItem(x.label, x, k), className });
  // Un seul élément en trop : il est affiché plutôt que regroupé sous « Autre outil (1) ».
  if (!(ordered.length > limit) || (other && ordered.length === limit + 1)) return ordered.map(toItem);
  const head = ordered.slice(0, limit).map(toItem);
  if (!other) return head;
  const rest = ordered.slice(limit);
  const count = rest.reduce((sum, x) => sum + x.count, 0);
  const display = maskCount(count, k, mode);
  const label = typeof other.label === 'function' ? other.label(rest.length) : String(other.label ?? '');
  head.push({ ...maskedItem(label, { count, display, masked: display !== String(count) }, k), className: other.className ?? 'bar-muted' });
  return head;
}

/** Questions à confirmer regroupées par usage (ordre d'apparition). → [{ group_id, name, questions[] }] */
export function questionsByUsage(questions) {
  const map = new Map();
  for (const q of questions ?? []) {
    if (!q) continue;
    const key = q.group_id ?? q.usage_key ?? q.name;
    if (!map.has(key)) map.set(key, { group_id: q.group_id ?? null, name: q.name ?? '', questions: [] });
    const bucket = map.get(key);
    if (!bucket.questions.includes(q.question)) bucket.questions.push(q.question);
  }
  return [...map.values()];
}

/** Actions retenues au plan (toutes sauf rejetées), par priorité puis échéance. */
export function planActions(actions) {
  return sortActions((actions ?? []).filter((a) => a && a.status !== 'rejected'), 'priority');
}

// ---------------------------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------------------------

function percent(share) {
  return new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 }).format(share || 0);
}

function section(id, title, { breakBefore = false, keep = false } = {}, ...children) {
  return h('section', {
    class: ['report-section', breakBefore ? 'report-break' : null, keep ? 'report-keep' : null],
    'aria-labelledby': `report-${id}-title`,
  },
    h('h3', { id: `report-${id}-title` }, title),
    children);
}

// Le conteneur défile horizontalement sur mobile : il est focalisable (et nommé) pour que le
// défilement reste possible au clavier même quand le tableau ne contient aucun lien (WCAG 2.1.1).
function table(caption, headers, rows, { className, label } = {}) {
  return h('div', { class: 'table-wrap report-table-wrap', tabindex: '0', role: 'region', 'aria-label': label ?? caption },
    h('table', { class: ['table', 'report-table', className] },
      h('caption', { class: 'visually-hidden' }, caption),
      h('thead', null, h('tr', null, headers.map((label) => h('th', { scope: 'col' }, label)))),
      h('tbody', null, rows)));
}

function toolText(group, questionnaire) {
  const label = optionLabel(questionnaire, 'tool', group.tool);
  return group.tool === 'other' && group.tool_other ? `${label} (${group.tool_other})` : label;
}

export async function render(root, { campaign, model, ctx }) {
  const { t } = ctx;
  await Promise.all([chartStyles(), loadCss('src/styles/report.css')]);
  const { stats, groups, rules, calendar, questionnaire } = model;
  const today = model.today;
  const mode = campaign.mode === 'open' ? 'open' : 'anonymous';
  const k = stats.mask?.k ?? campaign.settings?.min_group_size ?? 5;
  const statusLine = h('p', { class: 'muted report-export-status', role: 'status', 'aria-live': 'polite' });

  // --- Exports -----------------------------------------------------------------------------

  const printReport = () => {
    ctx.track.event('event/export_print');
    globalThis.print();
  };

  const exportXlsx = async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    statusLine.textContent = t('report.export.xlsx_preparing');
    try {
      const mod = await import('../../export/xlsx.js');
      const wb = mod.buildWorkbook({
        campaign, groups, actions: model.actions, stats, rules, calendar, questionnaire, t, today,
      });
      downloadBlob(mod.workbookBlob(wb), exportFilename('registre', campaign, today, 'xlsx'));
      ctx.track.event('event/export_xlsx');
      statusLine.textContent = t('report.export.xlsx_done');
    } catch (err) {
      console.error('[Recensia] Export XLSX impossible.', err);
      statusLine.textContent = '';
      toast(t('report.export.xlsx_error'), 'danger');
    } finally {
      btn.disabled = false;
    }
  };

  const exportCsv = () => {
    try {
      const rows = registryRows(groups, { campaign, actions: model.actions, questionnaire, rules, calendar, t, today });
      downloadText(toCSV(rows, registryColumns(campaign)), exportFilename('registre', campaign, today, 'csv'), 'text/csv;charset=utf-8');
      ctx.track.event('event/export_csv');
      statusLine.textContent = t('report.export.csv_done');
    } catch (err) {
      console.error('[Recensia] Export CSV impossible.', err);
      toast(t('report.export.csv_error'), 'danger');
    }
  };

  const toolbar = h('div', { class: 'report-toolbar card no-print' },
    h('p', { class: 'report-toolbar-text' }, t('report.toolbar.text')),
    h('div', { class: 'cluster report-toolbar-actions' },
      button(t('report.toolbar.print'), printReport, { variant: 'primary', icon: 'print' }),
      button(t('report.toolbar.xlsx'), exportXlsx, { icon: 'download' }),
      button(t('report.toolbar.csv'), exportCsv, { icon: 'download' }),
      h('a', { class: 'btn btn-ghost', href: `#/admin/${campaign.id}/parametres` }, icon('lock'), h('span', null, t('report.toolbar.json')))),
    h('p', { class: 'muted report-toolbar-note' }, t(commentsExportable(campaign) ? 'report.toolbar.note_comments' : 'report.toolbar.note')),
    statusLine);

  // --- En-tête -----------------------------------------------------------------------------

  const metaRows = [
    [t('report.header.org'), campaign.org_name || '—'],
    [t('report.header.campaign'), campaign.title],
    [t('report.header.date'), formatDate(today)],
    [t('report.header.mode'), t(`common.mode.${mode}`)],
    [t('report.header.responses'), formatNumber(stats.responses)],
    [t('report.header.usages'), formatNumber(stats.usages)],
    mode === 'open' && stats.respondents !== null ? [t('report.header.respondents'), formatNumber(stats.respondents)] : null,
    campaign.settings?.closes_on ? [t('report.header.closes_on'), formatDate(campaign.settings.closes_on)] : null,
    [t('report.header.rules_version'), rules?.version ?? '—'],
    [t('report.header.calendar_verified'), calendar?.last_verified ? formatDate(calendar.last_verified) : '—'],
  ].filter(Boolean);

  const header = h('header', { class: 'report-header' },
    h('p', { class: 'eyebrow' }, campaign.org_name || t('report.header.eyebrow')),
    h('h2', { id: 'console-tab-title', class: 'report-title' }, t('report.title')),
    h('p', { class: 'report-subtitle' }, campaign.title),
    h('dl', { class: 'meta-list report-meta' }, metaRows.map(([dt, dd]) => [h('dt', null, dt), h('dd', null, dd)])),
    campaign.demo ? h('p', { class: 'report-demo-note' }, icon('info'), h('span', null, t('report.header.demo'))) : null,
    disclaimer(t));

  // --- Synthèse ----------------------------------------------------------------------------

  const risks = mainRisks(stats, groups);
  const retained = stats.actions_progress.total - stats.actions_progress.rejected;
  // count : nombre qui accorde le libellé (« 1 interdit suspecté », « 2 interdits suspectés »).
  const counted = (key, n, cls) => ({ key, value: formatNumber(n), count: n, cls: n ? cls : null });
  const kpis = [
    counted('usages', stats.usages),
    counted('responses', stats.responses),
    counted('prohibited', stats.by_ai_act.prohibited_suspected ?? 0, 'kpi-danger'),
    counted('high', stats.by_ai_act.high ?? 0, 'kpi-danger'),
    counted('to_qualify', stats.to_qualify ?? 0, 'kpi-warn'),
    counted('data_critical', stats.by_data[3] ?? 0, 'kpi-warn'),
    { key: 'shadow', value: percent(stats.shadow_ai.share), cls: stats.shadow_ai.count ? 'kpi-warn' : null, detail: stats.usages ? t('report.kpi.shadow_detail', { count: stats.shadow_ai.count, total: stats.usages }) : null },
    { key: 'actions', value: `${formatNumber(stats.actions_progress.done)}/${formatNumber(retained)}`, count: retained, detail: t('report.kpi.actions_detail', { count: stats.actions_progress.pending_suggestions }) },
  ];
  const summary = section('summary', t('report.summary.title'), {},
    stats.usages === 0 ? h('p', { class: 'callout callout-info report-empty' }, t('report.summary.empty')) : null,
    h('ul', { class: 'kpi-grid report-kpis', role: 'list' }, kpis.map((x) => h('li', { class: ['kpi', x.cls] },
      h('span', { class: 'kpi-value' }, x.value),
      h('span', { class: 'kpi-label' }, x.count === undefined ? t(`report.kpi.${x.key}`) : t(`report.kpi.${x.key}`, { count: x.count })),
      x.detail ? h('span', { class: 'kpi-detail' }, x.detail) : null))),
    h('h4', null, t('report.summary.risks_title')),
    risks.length
      ? h('ul', { class: 'report-risks', role: 'list' }, risks.map((r) => h('li', { class: ['report-risk', `report-risk-${r.id}`] },
        h('span', { class: 'report-risk-count' }, formatNumber(r.count)),
        h('span', { class: 'report-risk-text' }, t(`report.risks.${r.id}`, { count: r.count })))))
      : h('p', null, t('report.summary.no_risk')));

  // --- Répartition des risques -------------------------------------------------------------

  const aiItems = AI_ACT_ORDER.map((level) => ({
    label: t(`common.levels.ai_act.${level}`), value: stats.by_ai_act[level] ?? 0, className: `bar-aia-${level}`,
  }));
  const dataItems = [...DATA_LEVELS].reverse().map((level) => ({
    label: t(`common.levels.data.${level}`), value: stats.by_data[level] ?? 0, className: `bar-data-${level}`,
  }));
  const shadowItems = [
    { label: t('report.charts.shadow_yes'), value: stats.shadow_ai.count, className: 'bar-data-3' },
    { label: t('report.charts.shadow_no'), value: Math.max(0, stats.usages - stats.shadow_ai.count), className: 'bar-data-0' },
  ];
  const chartHeaders = { label: t('report.charts.col_label'), value: t('report.charts.col_value'), share: t('report.charts.col_share') };
  const distribution = section('distribution', t('report.distribution.title'), {},
    h('p', { class: 'muted' }, t('report.distribution.lead')),
    h('div', { class: 'report-charts' },
      barChart(aiItems, { title: t('report.charts.ai_act'), className: 'report-chart', headers: chartHeaders }),
      barChart(dataItems, { title: t('report.charts.data'), className: 'report-chart', headers: chartHeaders })),
    h('h4', null, t('report.distribution.shadow_title')),
    h('p', null, t('report.distribution.shadow_text', { count: stats.shadow_ai.count, total: stats.usages, percent: percent(stats.shadow_ai.share) })),
    stats.usages ? stackedBar(shadowItems, { title: t('report.charts.shadow'), headers: chartHeaders }) : null);

  // --- Outils et services ------------------------------------------------------------------

  const toolItems = maskedBarItems(stats.top_tools, {
    order: 'count', className: 'bar-data-1', limit: TOP_TOOLS, k, mode,
    other: { label: (count) => t('report.charts.other_tools', { count }), className: 'bar-muted' },
  });
  const deptItems = maskedBarItems(stats.by_department.map((d) => ({
    ...d, label: d.department === null ? t('report.charts.no_department') : d.department,
  })), { order: 'given', className: 'bar-data-1', k, mode });
  const anyMasked = [...toolItems, ...deptItems].some((x) => x.masked);
  const tools = section('tools', t('report.tools.title'), { keep: true },
    h('p', { class: 'muted' }, t('report.tools.lead')),
    h('div', { class: 'report-charts' },
      toolItems.length
        ? barChart(toolItems, { title: t('report.charts.tools'), className: 'report-chart', headers: chartHeaders })
        : h('p', null, t('report.tools.no_tools')),
      deptItems.length
        ? barChart(deptItems, { title: t('report.charts.departments'), className: 'report-chart', headers: chartHeaders })
        : h('p', null, t('report.tools.no_departments'))),
    mode === 'anonymous' ? h('p', { class: 'report-note' }, icon('shield'), h('span', null,
      anyMasked ? t('report.tools.masked', { k }) : t('report.tools.mask_rule', { k }))) : null);

  // --- Usages prioritaires -----------------------------------------------------------------

  const priority = priorityUsages(groups);
  const triggerList = (list) => h('ul', { class: 'report-triggers', role: 'list' }, list.map((x) => h('li', null,
    h('span', { class: 'report-trigger-label' }, fr(x.label)),
    x.legal_ref && x.legal_ref !== '—' ? h('span', { class: 'report-trigger-ref muted' }, ` — ${fr(x.legal_ref)}`) : null)));
  const priorityCards = priority.map(({ group: g }) => {
    const trig = keyTriggers(g);
    const aiTrig = trig.filter((x) => x.axis === 'ai_act');
    const dataTrig = trig.filter((x) => x.axis !== 'ai_act');
    const deadline = applicableDeadline(g.computed?.deadlines, today, calendar);
    const meta = [g.id, toolText(g, questionnaire), (g.departments ?? []).join(', '),
      t('report.priority.count', { count: maskCount(g.count, k, mode) })].filter(Boolean).join(' · ');
    return h('li', { class: ['report-usage', `report-usage-${g.effective.ai_act_level}`] },
      h('div', { class: 'report-usage-head' },
        h('h4', { class: 'report-usage-name' }, g.name || g.id),
        h('p', { class: 'report-usage-meta muted' }, meta),
        // Axe affiché : la fiche (et sa version imprimée) nomme chacun des deux axes.
        h('p', { class: 'cluster report-usage-levels' },
          axisBadges(g.effective, t),
          g.effective.overridden ? h('span', { class: 'tag' }, t('report.priority.overridden')) : null,
          g.computed?.data_to_qualify ? h('span', { class: 'tag' }, t('report.priority.data_to_qualify')) : null)),
      h('dl', { class: 'meta-list report-usage-details' },
        aiTrig.length ? [h('dt', null, t('report.priority.triggers_ai')), h('dd', null, triggerList(aiTrig))] : null,
        dataTrig.length ? [h('dt', null, t('report.priority.triggers_data')), h('dd', null, triggerList(dataTrig))] : null,
        h('dt', null, t('report.priority.deadline')),
        h('dd', null, deadline
          ? [h('strong', null, formatDate(deadline.deadline.date)), ` — ${fr(deadline.deadline.label)}`,
            deadline.in_force ? [' ', h('span', { class: 'tag' }, t('report.priority.in_force'))] : null]
          : t('report.priority.no_deadline'))));
  });
  const prioritySection = section('priority', t('report.priority.title'), { breakBefore: true },
    h('p', { class: 'muted' }, t('report.priority.lead')),
    priority.length
      ? h('ul', { class: 'report-usages', role: 'list' }, priorityCards)
      : h('p', { class: 'report-ok' }, icon('success'), h('span', null, t('report.priority.none'))),
    disclaimer(t));

  // --- Questions à confirmer ---------------------------------------------------------------

  const questions = questionsByUsage(stats.questions);
  const questionsSection = section('questions', t('report.questions.title'), {},
    questions.length
      ? h('ul', { class: 'report-questions', role: 'list' }, questions.map((q) => h('li', null,
        h('p', { class: 'report-question-usage' }, q.name || q.group_id, q.group_id ? h('span', { class: 'muted' }, ` (${q.group_id})`) : null),
        h('ul', null, q.questions.map((text) => h('li', null, fr(text)))))))
      : h('p', { class: 'report-ok' }, icon('success'), h('span', null, t('report.questions.none'))));

  // --- Plan d'actions ----------------------------------------------------------------------

  const groupsByKey = new Map(groups.map((g) => [g.usage_key, g]));
  const plan = planActions(model.actions);
  const progress = stats.actions_progress;
  const planRows = plan.map((a) => {
    const g = a.usage_key ? groupsByKey.get(a.usage_key) : null;
    const overdue = isOverdue(a, today);
    return h('tr', null,
      h('th', { scope: 'row' }, fr(a.title)),
      h('td', null, a.usage_key ? (g ? g.name || g.id : t('report.plan.usage_gone')) : t('report.plan.usage_campaign')),
      h('td', null, t(`common.priority.${a.priority}`)),
      h('td', null, t(`common.action_status.${a.status}`), overdue ? h('span', { class: 'tag report-overdue' }, t('report.plan.overdue')) : null),
      h('td', null, a.owner ? a.owner : h('span', { class: 'muted' }, t('report.plan.no_owner'))),
      h('td', null, a.due_date ? formatDate(a.due_date) : '—'));
  });
  const planSection = section('plan', t('report.plan.title'), { breakBefore: true },
    h('p', null, t('report.plan.summary', {
      count: plan.length, done: progress.done, in_progress: progress.in_progress, todo: progress.todo,
    })),
    progress.pending_suggestions
      ? h('p', { class: 'report-note' }, icon('info'), h('span', null, t('report.plan.pending', { count: progress.pending_suggestions })),
        h('a', { class: 'no-print', href: `#/admin/${campaign.id}/actions` }, t('report.plan.pending_link')))
      : null,
    plan.length
      ? table(t('report.plan.title'), [
        t('report.plan.col_action'), t('report.plan.col_usage'), t('report.plan.col_priority'),
        t('report.plan.col_status'), t('report.plan.col_owner'), t('report.plan.col_due'),
      ], planRows, { className: 'report-plan-table', label: t('report.plan.table_label') })
      : null);

  // --- Échéances ---------------------------------------------------------------------------

  const upcoming = stats.upcoming_deadlines ?? [];
  const past = stats.past_deadlines ?? [];
  const deadlineRows = upcoming.map((d) => h('tr', null,
    h('td', { class: 'nowrap' }, formatDate(d.date)),
    h('th', { scope: 'row' }, fr(d.label),
      d.source_url ? h('span', { class: 'report-source-wrap' }, ' ',
        h('a', { class: 'report-source', href: d.source_url, target: '_blank', rel: 'noopener noreferrer' }, t('report.deadlines.source'))) : null),
    h('td', { class: 'num' }, formatNumber(d.usages_count)),
    h('td', null, t('report.deadlines.in_days', { count: d.days })),
    h('td', null, d.last_verified ? formatDate(d.last_verified) : '—')));
  const deadlinesSection = section('deadlines', t('report.deadlines.title'), {},
    h('p', { class: 'muted' }, t('report.deadlines.lead', { date: calendar?.last_verified ? formatDate(calendar.last_verified) : '—' })),
    upcoming.length
      ? table(t('report.deadlines.title'), [
        t('report.deadlines.col_date'), t('report.deadlines.col_label'), t('report.deadlines.col_usages'),
        t('report.deadlines.col_in'), t('report.deadlines.col_verified'),
      ], deadlineRows, { className: 'report-deadlines-table', label: t('report.deadlines.table_label') })
      : h('p', null, t('report.deadlines.none')),
    past.length
      ? h('div', { class: 'report-in-force' },
        h('h4', null, t('report.deadlines.in_force_title')),
        h('ul', null, past.map((d) => h('li', null, `${fr(d.label)} (${formatDate(d.date)})`,
          d.usages_count ? h('span', { class: 'muted' }, ` — ${t('report.deadlines.usages', { count: d.usages_count })}`) : null))))
      : null);

  // --- Méthode et limites ------------------------------------------------------------------

  const overridden = groups.filter((g) => g.effective?.overridden).length;
  const sources = entrySources(model.entries);
  const methodSection = section('method', t('report.method.title'), { breakBefore: true },
    h('ul', { class: 'report-method' },
      h('li', null, t('report.method.collect')),
      sources.manual ? h('li', null, t('report.method.manual', { count: sources.manual })) : null,
      sources.demo ? h('li', null, t('report.method.demo', { count: sources.demo })) : null,
      h('li', null, t('report.method.consolidation')),
      h('li', null, t('report.method.engine', { version: rules?.version ?? '—' })),
      overridden ? h('li', null, t('report.method.overrides', { count: overridden })) : null,
      h('li', null, h('strong', null, t('report.method.indicative'))),
      h('li', null, t(rules?.reviewed === true ? 'report.method.lawyer_reviewed' : 'report.method.lawyer')),
      h('li', null, t('report.method.calendar', { date: calendar?.last_verified ? formatDate(calendar.last_verified) : '—' })),
      h('li', null, mode === 'anonymous' ? t('report.method.anonymous', { k }) : t('report.method.open')),
      h('li', null, t('report.method.declarative'))));

  const footer = h('footer', { class: 'report-footer' },
    h('p', null, t('report.footer', { date: formatDate(today), version: rules?.version ?? '—' })),
    disclaimer(t));

  mount(root, h('div', { class: 'report-view stack' },
    toolbar,
    h('article', { class: 'report', 'aria-labelledby': 'console-tab-title' },
      header,
      summary,
      distribution,
      tools,
      prioritySection,
      questionsSection,
      planSection,
      deadlinesSection,
      methodSection,
      footer)));
}
