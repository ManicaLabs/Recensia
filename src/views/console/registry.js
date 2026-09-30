// Onglet « Registre » de la console (#/admin/<id>/registre) : une ligne par usage consolidé,
// filtres et tri gardés en mémoire de la vue (le hash est réservé au routeur), tableau sur grand
// écran et cartes sur mobile, détail d'un usage dans une boîte de dialogue, exports CSV et XLSX.
// Contrat : ARCHITECTURE §5.3 ; CDC §5.3, §6.1, §7.4, §8.2, §8.3.

import { h, mount, loadCss } from '../../ui/dom.js';
import { icon, button, field, levelBadge, disclaimer } from '../../ui/components.js';
import { downloadBlob } from '../../ui/download.js';
import { groupId } from '../../engine/consolidate.js';
import { AI_ACT_ORDER, DATA_LEVELS } from '../../engine/levels.js';
import { registryRows, registryColumns, commentsExportable, exportFilename } from '../../export/registry.js';
import { toCSV } from '../../export/csv.js';
import {
  defaultFilters, sanitizeFilters, applyFilters, filterOptions, activeFilterCount, isFiltering,
  countDisplay, isCountMasked, toolLabel, excludedEntries, excludedForGroup,
  splitKey, usedGroupKeys, reconcileFilters, minGroupSize, campaignMode, NO_DEPARTMENT, SORTS, VALIDATION_STATUSES,
} from './registry/filters.js';
import { updateAssessment, revertOverrides } from './registry/assessment.js';
import { createDetailDialog, detailContent, excludedCard, confirmDelete, confirmMerge, confirmRevert } from './registry/detail.js';
import { takeRegistryDetail, takeRegistryFilters } from './registry/focus.js';
import { levelCell, alertSlot, setAlert } from './registry/cells.js';

const CSS = 'src/styles/registry.css';
const SEARCH_DELAY_MS = 200;
const DESKTOP_QUERY = '(min-width: 60rem)';

// Mémoire de la vue (par campagne) : survit aux rafraîchissements et aux changements d'onglet.
const filterMemory = new Map();
const uiMemory = new Map();

// Détail ouvert : conservé d'un rafraîchissement à l'autre (keep) pour être mis à jour sur place.
const detail = { campaignId: null, usageKey: null, controller: null, keep: false, focusKey: null, status: null, silent: false };
let pageNotice = null;

function closeDetail({ silent = false } = {}) {
  const controller = detail.controller;
  if (!controller) return;
  detail.silent = silent;
  controller.close();
  detail.silent = false;
}

function isVisible(el) {
  return Boolean(el && el.isConnected && (el.offsetParent !== null || el.getClientRects().length > 0));
}

function findOpener(usageKey) {
  return Array.from(globalThis.document.querySelectorAll('[data-open-usage]')).find((el) => el.dataset.openUsage === usageKey && isVisible(el)) ?? null;
}

function focusTabTitle() {
  const title = globalThis.document.getElementById('console-tab-title');
  if (!title) return;
  if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
  title.focus();
}

export async function render(root, { campaign, model, ctx, refresh }) {
  const { t, store } = ctx;
  await loadCss(CSS);

  const requestedFilters = takeRegistryFilters(campaign.id);
  const remembered = sanitizeFilters(filterMemory.get(campaign.id) ?? defaultFilters());
  const ui = uiMemory.get(campaign.id) ?? { moreOpen: null, excludedOpen: false };
  uiMemory.set(campaign.id, ui);
  const byDepartment = campaign.settings?.group_by_department === true;
  const groups = model.groups ?? [];
  const excludedAll = excludedEntries(model.entries);
  const options = filterOptions(groups, { campaign, questionnaire: model.questionnaire });
  // Un service ou un outil mémorisé qui n'existe plus (déclarations écartées, supprimées) est oublié.
  const filters = reconcileFilters(requestedFilters
    ? { ...defaultFilters(), ...requestedFilters, sort: remembered.sort }
    : remembered, options);
  const k = minGroupSize(campaign);
  const anonymous = campaignMode(campaign) === 'anonymous';
  let disposed = false;
  let searchTimer = null;
  let busy = false;
  // Erreur d'enregistrement hors du détail (déclarations écartées) : encart persistant en haut de
  // l'onglet. Dans le détail, l'encart est celui de la boîte de dialogue (une notification resterait
  // sous la fenêtre modale).
  const pageAlert = alertSlot('registry-alert');

  // -------------------------------------------------------------------------------------------
  // Écritures dans le store (toujours relues avant modification), puis rafraîchissement.
  // -------------------------------------------------------------------------------------------

  function clearError() {
    setAlert(pageAlert, null);
    detail.controller?.setError(null);
  }

  function reportError(err) {
    console.error('[Recensia] Modification du registre impossible.', err);
    const message = t('registry.errors.save');
    if (detail.controller?.isOpen()) {
      detail.controller.setError(message);
      return;
    }
    if (setAlert(pageAlert, message) && pageAlert.isConnected) pageAlert.scrollIntoView?.({ block: 'nearest' });
    else ctx.toast(message, 'danger');
  }

  async function guard(fn) {
    if (busy) return null;
    busy = true;
    clearError();
    try {
      return await fn();
    } catch (err) {
      reportError(err);
      return null;
    } finally {
      busy = false;
    }
  }

  async function commitDetail({ usageKey, focusKey = null, message = null } = {}) {
    detail.keep = true;
    if (usageKey) detail.usageKey = usageKey;
    detail.focusKey = focusKey;
    detail.status = message;
    await refresh();
    if (detail.keep) {
      // L'onglet n'a pas été réaffiché (navigation ou erreur) : le détail serait périmé.
      detail.keep = false;
      closeDetail({ silent: true });
      if (message) ctx.toast(message, 'success');
    }
  }

  async function commitPage({ focusKey = null, message = null } = {}) {
    pageNotice = { campaignId: campaign.id, focusKey, message };
    await refresh();
  }

  async function commit(group, options) {
    if (group && detail.controller) return commitDetail(options);
    return commitPage(options);
  }

  async function readEntry(entry) {
    const fresh = await store.getEntry(campaign.id, entry.entry_id);
    if (!fresh) throw new Error(`Déclaration introuvable : ${entry.entry_id}`);
    return fresh;
  }

  async function readAssessment(usageKey) {
    return (await store.listAssessments(campaign.id)).find((a) => a && a.usage_key === usageKey) ?? null;
  }

  const ops = {
    saveAssessment: (group, input) => guard(async () => {
      const previous = await readAssessment(group.usage_key);
      const result = updateAssessment(previous, input, { campaignId: campaign.id, usageKey: group.usage_key, now: new Date().toISOString() });
      if (!result.ok) return result;
      if (!result.changed) {
        detail.controller?.setStatus(t('registry.assessment.no_change'));
        return result;
      }
      await store.putAssessment(result.value);
      await commitDetail({ focusKey: 'assessment-save', message: t('registry.assessment.saved') });
      return result;
    }),

    revert: async (group) => {
      if (busy || !(await confirmRevert(t))) return null;
      return guard(async () => {
        const previous = await readAssessment(group.usage_key);
        const result = revertOverrides(previous, {
          campaignId: campaign.id, usageKey: group.usage_key, justification: t('registry.assessment.revert_reason'), now: new Date().toISOString(),
        });
        if (!result.ok || !result.changed) return result;
        await store.putAssessment(result.value);
        await commitDetail({ focusKey: 'assessment-save', message: t('registry.assessment.reverted') });
        return result;
      });
    },

    merge: async (group, target) => {
      if (busy || !(await confirmMerge(group, target, t, campaign))) return null;
      return guard(async () => {
        const now = new Date().toISOString();
        // Les déclarations écartées de la ligne la suivent aussi : réintégrées plus tard, elles ne
        // recréeraient pas l'usage fusionné.
        const sources = [...(group.members ?? []), ...excludedForGroup(model.entries, group.usage_key, { byDepartment })];
        const fresh = await Promise.all(sources.map((m) => store.getEntry(campaign.id, m.entry_id)));
        const moved = fresh.filter(Boolean).map((e) => ({ ...e, group_override: target.usage_key }));
        if (moved.length) await store.putEntries(moved);
        // Les actions rattachées à l'usage fusionné suivent la ligne cible.
        const linked = (await store.listActions(campaign.id)).filter((a) => a && a.usage_key === group.usage_key);
        if (linked.length) await store.putActions(linked.map((a) => ({ ...a, usage_key: target.usage_key, updated_at: now })));
        await commitDetail({ usageKey: target.usage_key, focusKey: 'section-members', message: t('registry.grouping.merged', { target: target.name || target.id }) });
        return true;
      });
    },

    split: (entry, group) => guard(async () => {
      const fresh = await readEntry(entry);
      const key = splitKey(fresh.entry_id, usedGroupKeys(model.entries, { byDepartment }));
      await store.putEntry({ ...fresh, group_override: key });
      await commit(group, { focusKey: 'section-members', message: t('registry.members.split_done', { id: groupId(key) }) });
      return true;
    }),

    ungroup: (entry, group) => guard(async () => {
      const fresh = await readEntry(entry);
      await store.putEntry({ ...fresh, group_override: null });
      await commit(group, { focusKey: 'section-members', message: t('registry.members.ungroup_done') });
      return true;
    }),

    exclude: (entry, group) => guard(async () => {
      const fresh = await readEntry(entry);
      await store.putEntry({ ...fresh, excluded: true });
      await commit(group, { focusKey: 'section-members', message: t('registry.members.exclude_done') });
      return true;
    }),

    restore: (entry, group) => guard(async () => {
      const fresh = await readEntry(entry);
      await store.putEntry({ ...fresh, excluded: false });
      await commit(group, { focusKey: group ? 'section-members' : 'excluded', message: t('registry.members.restore_done') });
      return true;
    }),

    remove: async (entry, group) => {
      if (busy || !(await confirmDelete(entry, t))) return null;
      return guard(async () => {
        await store.deleteEntry(campaign.id, entry.entry_id);
        await commit(group, { focusKey: group ? 'section-members' : 'excluded', message: t('registry.members.delete_done') });
        return true;
      });
    },
  };

  // -------------------------------------------------------------------------------------------
  // Détail
  // -------------------------------------------------------------------------------------------

  function fillDetail(controller, group, { revealMasked = false } = {}) {
    const excluded = excludedForGroup(model.entries, group.usage_key, { byDepartment });
    controller.setContent(detailContent({
      group, model, campaign, t, ops, excluded, revealMasked,
      onJump: (key) => controller.focus(`section-${key}`),
    }));
  }

  function openDetail(group) {
    closeDetail({ silent: true });
    const openerKey = group.usage_key;
    const controller = createDetailDialog({
      t,
      onClose: () => {
        if (detail.controller !== controller) return;
        const silent = detail.silent;
        const currentKey = detail.usageKey;
        detail.controller = null;
        detail.usageKey = null;
        detail.keep = false;
        if (silent) return;
        const opener = findOpener(currentKey) ?? findOpener(openerKey);
        if (opener) opener.focus();
        else focusTabTitle();
      },
    });
    Object.assign(detail, { campaignId: campaign.id, usageKey: group.usage_key, controller, keep: false, focusKey: null, status: null });
    fillDetail(controller, group);
    controller.open();
    controller.scrollTop();
    controller.focus(null);
  }

  // -------------------------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------------------------

  function setBusy(btn, on, busyLabel) {
    const label = btn.querySelector('.btn-label');
    if (on) {
      btn.dataset.label = label?.textContent ?? '';
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-busy', 'true');
      if (label) label.textContent = busyLabel;
    } else {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-busy');
      if (label) label.textContent = btn.dataset.label ?? label.textContent;
    }
  }

  function exportArgs() {
    return {
      campaign, groups, actions: model.actions, stats: model.stats, rules: model.rules,
      calendar: model.calendar, questionnaire: model.questionnaire, t, today: model.today,
    };
  }

  async function exportCsv() {
    try {
      const rows = registryRows(groups, exportArgs());
      downloadBlob(new Blob([toCSV(rows, registryColumns(campaign))], { type: 'text/csv;charset=utf-8' }), exportFilename('registre', campaign, model.today, 'csv'));
      ctx.track.event('event/export_csv');
      ctx.toast(t('registry.export.done_csv'), 'success');
    } catch (err) {
      console.error('[Recensia] Export CSV impossible.', err);
      ctx.toast(t('registry.export.failed'), 'danger');
    }
  }

  async function exportXlsx(event) {
    const btn = event.currentTarget;
    if (btn.getAttribute('aria-disabled') === 'true') return;
    setBusy(btn, true, t('registry.export.preparing'));
    try {
      // SheetJS (≈ 1 Mo) : chargé seulement à la demande.
      const { buildWorkbook, workbookBlob } = await import('../../export/xlsx.js');
      const wb = buildWorkbook(exportArgs());
      downloadBlob(workbookBlob(wb), exportFilename('registre', campaign, model.today, 'xlsx'));
      ctx.track.event('event/export_xlsx');
      ctx.toast(t('registry.export.done_xlsx'), 'success');
    } catch (err) {
      console.error('[Recensia] Export XLSX impossible.', err);
      ctx.toast(t('registry.export.failed'), 'danger');
    } finally {
      if (btn.isConnected) setBusy(btn, false);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Affichage des lignes
  // -------------------------------------------------------------------------------------------

  function openButton(group) {
    return h('button', {
      type: 'button',
      class: 'registry-open',
      'data-open-usage': group.usage_key,
      onClick: () => openDetail(group),
    }, group.name || group.id);
  }

  function variants(group) {
    const extra = (group.names ?? []).length - 1;
    return extra > 0 ? h('span', { class: 'registry-variants muted' }, t('registry.table.variants', { count: extra })) : null;
  }

  function validationCell(group) {
    const status = VALIDATION_STATUSES.includes(group.validation_status) ? group.validation_status : 'to_review';
    return h('span', { class: ['tag', 'registry-validation', `is-${status}`] }, t(`common.validation.${status}`));
  }

  function departmentsText(group) {
    return (group.departments ?? []).length ? group.departments.join(', ') : t('registry.table.no_department');
  }

  function countCell(group) {
    const text = countDisplay(group, campaign);
    return isCountMasked(group, campaign)
      ? h('span', { class: 'registry-masked', title: t('registry.table.masked_title', { k }) }, text)
      : text;
  }

  function tableView(list) {
    const cols = [
      ['id', t('registry.table.id')], ['usage', t('registry.table.usage')], ['departments', t('registry.table.departments')],
      ['tool', t('registry.table.tool')], ['ai_act', t('registry.table.ai_act')], ['data', t('registry.table.data')],
      ['count', t('registry.table.count')], ['validation', t('registry.table.validation')],
    ];
    return h('div', { class: 'table-wrap registry-table-wrap', role: 'region', 'aria-label': t('registry.table.caption'), tabindex: '0' },
      h('table', { class: 'table registry-table' },
        h('caption', { class: 'visually-hidden' }, t('registry.table.caption_count', { count: list.length })),
        h('thead', null, h('tr', null, cols.map(([key, label]) => h('th', { scope: 'col', class: `col-${key}` }, label)))),
        h('tbody', null, list.map((g) => h('tr', null,
          h('td', { class: 'col-id' }, h('span', { class: 'registry-id' }, g.id)),
          h('th', { scope: 'row', class: 'col-usage' }, openButton(g), variants(g)),
          h('td', { class: 'col-departments' }, departmentsText(g)),
          h('td', { class: 'col-tool' }, toolLabel(g, model.questionnaire)),
          // Axe nommé par l'en-tête de colonne (annoncé avec la cellule).
          h('td', { class: 'col-ai_act' }, levelCell('ai_act', g, t, { axisLabel: 'none' })),
          h('td', { class: 'col-data' }, levelCell('data', g, t, { axisLabel: 'none' })),
          h('td', { class: 'col-count num' }, countCell(g)),
          h('td', { class: 'col-validation' }, validationCell(g)))))));
  }

  function cardsView(list) {
    return h('ul', { class: 'registry-cards', role: 'list', 'aria-label': t('registry.table.caption') }, list.map((g) => h('li', { class: 'registry-card' },
      h('div', { class: 'registry-card-head' },
        h('h3', { class: 'registry-card-title' }, openButton(g)),
        h('span', { class: 'registry-id' }, g.id)),
      variants(g),
      // Pas d'en-tête sur une carte : l'axe est écrit (« AI Act : », « Exposition des données : »).
      h('div', { class: 'registry-card-levels' },
        levelCell('ai_act', g, t, { axisLabel: 'visible' }),
        levelCell('data', g, t, { axisLabel: 'visible' })),
      h('dl', { class: 'registry-card-meta' },
        h('dt', null, t('registry.table.departments')), h('dd', null, departmentsText(g)),
        h('dt', null, t('registry.table.tool')), h('dd', null, toolLabel(g, model.questionnaire)),
        h('dt', null, t('registry.table.count')), h('dd', null, countCell(g)),
        h('dt', null, t('registry.table.validation')), h('dd', null, validationCell(g))))));
  }

  // -------------------------------------------------------------------------------------------
  // Filtres
  // -------------------------------------------------------------------------------------------

  const results = h('div', { class: 'registry-results' });
  const countLine = h('p', { class: 'registry-count', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const moreSummaryText = h('span', null);
  const resetButton = button(t('registry.filters.reset'), () => resetFilters(), { variant: 'ghost', size: 'sm', icon: 'refresh' });

  function countText(shown) {
    if (!isFiltering(filters)) return t('registry.filters.count_all', { count: groups.length });
    return t('registry.filters.count', { count: shown, total: groups.length });
  }

  function noResult() {
    return h('div', { class: 'registry-no-result card card-flat' },
      h('p', null, h('strong', null, t('registry.filters.no_result'))),
      h('p', { class: 'muted' }, t('registry.filters.no_result_hint')),
      button(t('registry.filters.reset'), () => resetFilters(), { size: 'sm', icon: 'refresh' }));
  }

  function update() {
    if (disposed) return;
    filterMemory.set(campaign.id, { ...filters, ai_act: [...filters.ai_act] });
    const list = applyFilters(groups, filters, { questionnaire: model.questionnaire, campaign });
    mount(results, list.length ? [tableView(list), cardsView(list)] : noResult());
    countLine.textContent = countText(list.length);
    const active = activeFilterCount(filters);
    moreSummaryText.textContent = active ? t('registry.filters.more_active', { count: active }) : t('registry.filters.more');
    resetButton.hidden = !isFiltering(filters);
  }

  const controls = {};

  function select(id, label, value, entries, onChange) {
    const control = h('select', { onChange: (event) => onChange(event.currentTarget.value) },
      entries.map(([v, text]) => h('option', { value: v }, text)));
    control.value = value;
    controls[id] = control;
    return field({ id, label, control });
  }

  function resetFilters() {
    const sort = filters.sort;
    Object.assign(filters, defaultFilters(), { sort });
    controls['reg-q'].value = '';
    controls['reg-data'].value = '';
    controls['reg-department'].value = '';
    controls['reg-tool'].value = '';
    controls['reg-validation'].value = '';
    controls['reg-to-qualify'].checked = false;
    controls['reg-priority'].checked = false;
    for (const box of controls.aiBoxes) box.checked = false;
    update();
    controls['reg-q'].focus();
  }

  function filtersForm() {
    const search = h('input', {
      type: 'search',
      value: filters.q,
      placeholder: t('registry.filters.search_placeholder'),
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '100',
      onInput: (event) => {
        const value = event.currentTarget.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          filters.q = value;
          update();
        }, SEARCH_DELAY_MS);
      },
    });
    controls['reg-q'] = search;

    const aiBoxes = AI_ACT_ORDER.map((level) => h('input', {
      type: 'checkbox',
      value: level,
      checked: filters.ai_act.includes(level),
      onChange: () => {
        filters.ai_act = aiBoxes.filter((box) => box.checked).map((box) => box.value);
        update();
      },
    }));
    controls.aiBoxes = aiBoxes;

    const toQualify = h('input', {
      type: 'checkbox',
      id: 'reg-to-qualify',
      checked: filters.to_qualify,
      onChange: (event) => {
        filters.to_qualify = event.currentTarget.checked;
        update();
      },
    });
    controls['reg-to-qualify'] = toQualify;

    const priority = h('input', {
      type: 'checkbox',
      id: 'reg-priority',
      checked: filters.priority,
      onChange: (event) => {
        filters.priority = event.currentTarget.checked;
        update();
      },
    });
    controls['reg-priority'] = priority;

    const departmentEntries = [['', t('registry.filters.all')], ...options.departments.map((d) => [d.value, d.label])];
    if (options.hasNoDepartment) departmentEntries.push([NO_DEPARTMENT, t('registry.filters.no_department')]);

    const more = h('details', {
      class: 'registry-more',
      open: ui.moreOpen ?? Boolean(globalThis.matchMedia?.(DESKTOP_QUERY).matches),
    },
    h('summary', { class: 'registry-more-summary' }, icon('list'), moreSummaryText),
    h('div', { class: 'registry-more-body' },
      field({
        id: 'reg-ai-act',
        label: t('registry.filters.ai_act'),
        group: true,
        control: h('ul', { class: 'registry-chips', role: 'list' }, AI_ACT_ORDER.map((level, i) => h('li', null,
          h('label', { class: 'registry-chip' }, aiBoxes[i], levelBadge('ai_act', level, t, { axisLabel: 'none' }))))),
      }),
      h('div', { class: 'registry-selects' },
        select('reg-data', t('registry.filters.data'), filters.data,
          [['', t('registry.filters.all_levels')], ...DATA_LEVELS.map((n) => [String(n), `${n} — ${t(`common.levels.data.${n}`)}`])],
          (v) => { filters.data = v; update(); }),
        select('reg-department', t('registry.filters.department'), filters.department, departmentEntries,
          (v) => { filters.department = v; update(); }),
        select('reg-tool', t('registry.filters.tool'), filters.tool,
          [['', t('registry.filters.all')], ...options.tools.map((o) => [o.value, o.label])],
          (v) => { filters.tool = v; update(); }),
        select('reg-validation', t('registry.filters.validation'), filters.validation,
          [['', t('registry.filters.all')], ...VALIDATION_STATUSES.map((s) => [s, t(`common.validation.${s}`)])],
          (v) => { filters.validation = v; update(); })),
      h('div', { class: 'registry-more-foot' },
        h('div', { class: 'registry-checks' },
          h('label', { class: 'registry-check', for: 'reg-to-qualify' }, toQualify, h('span', null, t('registry.filters.to_qualify'))),
          h('label', { class: 'registry-check', for: 'reg-priority' }, priority, h('span', null, t('registry.filters.priority')))),
        resetButton)));
    more.addEventListener('toggle', () => { ui.moreOpen = more.open; });

    return h('form', {
      class: 'registry-filters card card-compact',
      role: 'search',
      'aria-label': t('registry.filters.label'),
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        clearTimeout(searchTimer);
        filters.q = search.value;
        update();
      },
    },
    h('div', { class: 'registry-filters-main' },
      field({ id: 'reg-q', label: t('registry.filters.search'), help: t('registry.filters.search_help'), control: search }),
      select('reg-sort', t('registry.filters.sort'), filters.sort, SORTS.map((s) => [s, t(`registry.filters.sort_${s}`)]),
        (v) => { filters.sort = v; update(); })),
    more);
  }

  // -------------------------------------------------------------------------------------------
  // Déclarations écartées
  // -------------------------------------------------------------------------------------------

  function excludedSection() {
    if (!excludedAll.length) return null;
    const block = h('details', { class: 'registry-excluded card card-compact', open: ui.excludedOpen || null },
      h('summary', { 'data-focus': 'excluded' }, h('span', null, t('registry.excluded.title', { count: excludedAll.length }))),
      h('p', { class: 'muted small' }, t('registry.excluded.help')),
      h('ul', { class: 'registry-members', role: 'list' }, excludedAll.map((entry) => excludedCard(entry, model, campaign, t, ops))));
    block.addEventListener('toggle', () => { ui.excludedOpen = block.open; });
    return block;
  }

  // -------------------------------------------------------------------------------------------
  // Assemblage
  // -------------------------------------------------------------------------------------------

  const base = `#/admin/${campaign.id}`;
  const headerNode = h('header', { class: 'registry-header' },
    h('div', { class: 'registry-heading' },
      h('h2', { id: 'console-tab-title' }, t('registry.title')),
      h('p', { class: 'muted registry-lead' }, t('registry.lead'))),
    groups.length ? h('div', { class: 'registry-exports', role: 'group', 'aria-label': t('registry.export.label') },
      // Mêmes libellés et même ordre que la barre d'outils du Rapport.
      button(t('registry.export.xlsx'), (event) => exportXlsx(event), { icon: 'download', size: 'sm', attrs: { 'aria-describedby': 'registry-export-note' } }),
      button(t('registry.export.csv'), () => exportCsv(), { icon: 'download', size: 'sm', attrs: { 'aria-describedby': 'registry-export-note' } }),
      h('p', { class: 'registry-export-note muted', id: 'registry-export-note' }, t(`registry.export.${anonymous ? 'note_anonymous' : 'note_open'}${commentsExportable(campaign) ? '_comments' : ''}`, { k }))) : null);

  // Liste initiale calculée avant l'insertion : la région « status » n'annonce pas l'état initial.
  if (groups.length > 0) update();

  if (groups.length === 0) {
    mount(root, h('div', { class: 'registry stack' },
      headerNode,
      pageAlert,
      h('div', { class: 'empty-state card registry-empty' },
        h('span', { class: 'empty-state-icon' }, icon('list')),
        h('h3', null, t('registry.empty.title')),
        h('p', { class: 'lead' }, t(excludedAll.length ? 'registry.empty.excluded_text' : 'registry.empty.text')),
        h('div', { class: 'cluster cluster-center' },
          h('a', { class: 'btn btn-primary', href: `${base}/diffuser` }, icon('share'), h('span', null, t('registry.empty.share'))),
          h('a', { class: 'btn btn-secondary', href: `${base}/import` }, icon('upload'), h('span', null, t('registry.empty.import'))),
          h('a', { class: 'btn btn-secondary', href: `${base}/saisir` }, icon('plus'), h('span', null, t('registry.empty.add'))))),
      excludedSection()));
  } else {
    mount(root, h('div', { class: 'registry stack' },
      headerNode,
      pageAlert,
      disclaimer(t),
      filtersForm(),
      countLine,
      results,
      anonymous && groups.some((g) => isCountMasked(g, campaign)) ? h('p', { class: 'muted small registry-mask-note' }, t('registry.table.masked_note', { k })) : null,
      excludedSection()));
  }

  // Détail conservé pendant un rafraîchissement, ou demandé depuis un autre onglet.
  if (detail.keep && detail.campaignId === campaign.id && detail.controller?.isOpen()) {
    detail.keep = false;
    const group = groups.find((g) => g.usage_key === detail.usageKey);
    const { focusKey, status } = detail;
    if (group) {
      // Liste d'un effectif masqué dépliée par l'admin : elle le reste après la modification.
      const revealMasked = detail.controller.dialog.querySelector('.registry-members-masked')?.open === true;
      fillDetail(detail.controller, group, { revealMasked });
      detail.controller.setStatus(status);
      detail.controller.focus(focusKey);
    } else {
      closeDetail({ silent: true });
      focusTabTitle();
      if (status) ctx.toast(status, 'success');
    }
  } else {
    detail.keep = false;
    const requested = takeRegistryDetail(campaign.id);
    const group = requested ? groups.find((g) => g.usage_key === requested) : null;
    if (group) openDetail(group);
  }

  if (pageNotice && pageNotice.campaignId === campaign.id) {
    const notice = pageNotice;
    pageNotice = null;
    const target = notice.focusKey ? root.querySelector(`[data-focus="${notice.focusKey}"]`) : null;
    if (target) target.focus();
    else focusTabTitle();
    if (notice.message) ctx.toast(notice.message, 'success');
  }

  return () => {
    disposed = true;
    clearTimeout(searchTimer);
    if (!detail.keep) closeDetail({ silent: true });
  };
}
