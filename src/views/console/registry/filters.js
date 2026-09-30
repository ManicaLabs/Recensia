// Registre : filtres, tri et calculs d'affichage (module pur, sans DOM).
// Partagé par l'onglet Registre, son panneau de détail et le tableau de bord.

import { compareGroups, normalizeToolOther, usageKey } from '../../../engine/consolidate.js';
import { AI_ACT_ORDER, isAiActLevel, isDataLevel } from '../../../engine/levels.js';
import { optionLabel } from '../../../engine/labels.js';
import { maskCount } from '../../../engine/stats.js';

export const SORTS = Object.freeze(['severity', 'name', 'count']);
export const VALIDATION_STATUSES = Object.freeze(['to_review', 'validated', 'to_revise']);
export const DATA_FILTERS = Object.freeze(['0', '1', '2', '3']);
/** Valeur du filtre « service » pour les usages sans service renseigné. */
export const NO_DEPARTMENT = '__none__';
export const DEFAULT_K = 5;
export const SEARCH_MAX = 100;

/** Filtres par défaut : tout afficher, tri par gravité. */
export function defaultFilters() {
  return { q: '', ai_act: [], data: '', department: '', tool: '', validation: '', to_qualify: false, priority: false, sort: 'severity' };
}

/** Normalise un objet de filtres (valeurs inconnues retirées). */
export function sanitizeFilters(input) {
  const base = defaultFilters();
  if (!input || typeof input !== 'object') return base;
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    q: str(input.q).slice(0, SEARCH_MAX),
    ai_act: AI_ACT_ORDER.filter((level) => Array.isArray(input.ai_act) && input.ai_act.includes(level)),
    data: DATA_FILTERS.includes(String(input.data ?? '')) ? String(input.data) : '',
    department: str(input.department),
    tool: str(input.tool),
    validation: VALIDATION_STATUSES.includes(input.validation) ? input.validation : '',
    to_qualify: input.to_qualify === true,
    priority: input.priority === true,
    sort: SORTS.includes(input.sort) ? input.sort : base.sort,
  };
}

/** Nombre de filtres actifs (hors recherche et tri). */
export function activeFilterCount(filters) {
  const f = sanitizeFilters(filters);
  return [f.ai_act.length > 0, f.data !== '', f.department !== '', f.tool !== '', f.validation !== '', f.to_qualify, f.priority].filter(Boolean).length;
}

/** Des filtres ou une recherche restreignent-ils la liste ? */
export function isFiltering(filters) {
  const f = sanitizeFilters(filters);
  return activeFilterCount(f) > 0 || normalizeSearch(f.q) !== '';
}

/** Texte comparable : minuscules, sans accents, apostrophes et espaces normalisés. */
export function normalizeSearch(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clé de filtre d'un outil : l'outil, ou « other:<précision> » pour un outil « autre ». */
export function toolFilterKey(group) {
  if (group?.tool === 'other') return `other:${normalizeToolOther(group.tool_other)}`;
  return String(group?.tool ?? '');
}

/** Libellé de l'outil d'une ligne (précision entre parenthèses pour « Autre »). */
export function toolLabel(group, questionnaire) {
  const label = optionLabel(questionnaire, 'tool', group?.tool);
  if (group?.tool === 'other' && group.tool_other) return `${label} (${group.tool_other})`;
  return label;
}

/** Texte de recherche d'une ligne : identifiant, noms déclarés, outil, services. */
export function searchTextOf(group, questionnaire) {
  return normalizeSearch([
    group?.id,
    ...(group?.names ?? [group?.name]),
    optionLabel(questionnaire, 'tool', group?.tool),
    group?.tool_other,
    ...(group?.departments ?? []),
  ].filter((v) => typeof v === 'string' && v !== '').join(' \u0001 '));
}

/** Surcharge valide de l'axe AI Act (même critère que consolidate). */
export function aiOverridden(group) {
  return isAiActLevel(group?.assessment?.override_ai_act_level);
}

/** Surcharge valide de l'axe données. */
export function dataOverridden(group) {
  return isDataLevel(group?.assessment?.override_data_level);
}

/** Ligne « à qualifier » : niveau AI Act à qualifier ou exposition à qualifier non tranchée. */
export function isToQualify(group) {
  return group?.effective?.ai_act_level === 'to_qualify' || (group?.computed?.data_to_qualify === true && !dataOverridden(group));
}

/**
 * Questions à confirmer d'une ligne, avec leur état : celles d'un axe surchargé sont réputées
 * tranchées (comme dans computeStats).
 * → [{ rule_id, question, resolved }]
 */
export function questionsOf(group) {
  const axisOf = new Map((group?.computed?.triggers ?? []).map((t) => [t.rule_id, t.axis]));
  return (group?.computed?.questions_to_confirm ?? []).map((q) => {
    const axis = axisOf.get(q.rule_id);
    const resolved = (axis === 'ai_act' && aiOverridden(group)) || (axis === 'data' && dataOverridden(group));
    return { rule_id: q.rule_id, question: q.question, resolved };
  });
}

/** Questions encore ouvertes. */
export function openQuestions(group) {
  return questionsOf(group).filter((q) => !q.resolved);
}

/** Taille minimale d'un groupe affichable en mode anonyme. */
export function minGroupSize(campaign) {
  const k = campaign?.settings?.min_group_size;
  return Number.isInteger(k) && k > 0 ? k : DEFAULT_K;
}

/** Mode de la campagne ; sans campagne, le plus prudent (anonyme). */
export function campaignMode(campaign) {
  return campaign?.mode === 'open' ? 'open' : 'anonymous';
}

function groupCount(group) {
  return Number.isInteger(group?.count) ? group.count : (group?.members ?? []).length;
}

/** Nombre de déclarations affichable : « < k » en mode anonyme si 0 < n < k. */
export function countDisplay(group, campaign) {
  return maskCount(groupCount(group), minGroupSize(campaign), campaignMode(campaign));
}

/** L'effectif d'une ligne est-il masqué ? */
export function isCountMasked(group, campaign) {
  return countDisplay(group, campaign) !== String(groupCount(group));
}

/** Niveau AI Act affiché : { level, computed, overridden }. */
export function aiActDisplay(group) {
  const computed = group?.computed?.ai_act_level ?? 'minimal';
  const overridden = aiOverridden(group);
  return { level: overridden ? group.assessment.override_ai_act_level : (group?.effective?.ai_act_level ?? computed), computed, overridden };
}

/** Exposition affichée : { level, computed, overridden, toQualify }. */
export function dataDisplay(group) {
  const computed = Number.isInteger(group?.computed?.data_level) ? group.computed.data_level : 0;
  const overridden = dataOverridden(group);
  return {
    level: overridden ? group.assessment.override_data_level : (group?.effective?.data_level ?? computed),
    computed,
    overridden,
    toQualify: group?.computed?.data_to_qualify === true && !overridden,
  };
}

/** Une ligne correspond-elle aux filtres ? */
export function matchesFilters(group, filters, { questionnaire } = {}) {
  const f = sanitizeFilters(filters);
  const q = normalizeSearch(f.q);
  if (q !== '' && !q.split(' ').every((word) => searchTextOf(group, questionnaire).includes(word))) return false;
  if (f.ai_act.length > 0 && !f.ai_act.includes(group?.effective?.ai_act_level)) return false;
  if (f.data !== '' && String(group?.effective?.data_level) !== f.data) return false;
  if (f.department !== '') {
    const departments = group?.departments ?? [];
    if (f.department === NO_DEPARTMENT ? departments.length > 0 : !departments.includes(f.department)) return false;
  }
  if (f.tool !== '' && toolFilterKey(group) !== f.tool) return false;
  if (f.validation !== '' && (group?.validation_status ?? 'to_review') !== f.validation) return false;
  if (f.to_qualify && !isToQualify(group)) return false;
  if (f.priority && !isPriority(group)) return false;
  return true;
}

function compareNames(a, b) {
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'fr', { sensitivity: 'base' });
}

/**
 * Trie une copie des lignes. severity : gravité AI Act, exposition puis nom (ordre du registre) ;
 * name : ordre alphabétique ; count : nombre de déclarations décroissant. En mode anonyme, les
 * effectifs masqués sont traités comme égaux pour que l'ordre ne trahisse pas leur valeur.
 */
export function sortGroups(groups, sort = 'severity', { campaign } = {}) {
  const list = [...(groups ?? [])];
  if (sort === 'name') return list.sort((a, b) => compareNames(a, b) || compareGroups(a, b));
  if (sort === 'count') {
    const k = minGroupSize(campaign);
    const masked = campaignMode(campaign) === 'anonymous';
    const weight = (g) => {
      const n = groupCount(g);
      return masked && n < k ? 0 : n;
    };
    return list.sort((a, b) => weight(b) - weight(a) || compareGroups(a, b));
  }
  return list.sort(compareGroups);
}

/** Lignes filtrées et triées. */
export function applyFilters(groups, filters, { questionnaire, campaign } = {}) {
  const f = sanitizeFilters(filters);
  return sortGroups((groups ?? []).filter((g) => matchesFilters(g, f, { questionnaire })), f.sort, { campaign });
}

/**
 * Valeurs proposées par les filtres « service » et « outil » : services de la campagne puis
 * services présents dans les lignes ; outils présents dans les lignes.
 * → { departments: [{ value, label? }], hasNoDepartment, tools: [{ value, label }] }
 */
export function filterOptions(groups, { campaign, questionnaire } = {}) {
  const list = groups ?? [];
  const seen = new Set();
  const departments = [];
  const add = (d) => {
    if (typeof d !== 'string' || d === '' || seen.has(d)) return;
    seen.add(d);
    departments.push({ value: d, label: d });
  };
  (campaign?.departments ?? []).forEach(add);
  const extra = [...new Set(list.flatMap((g) => g.departments ?? []))].filter((d) => !seen.has(d)).sort((a, b) => a.localeCompare(b, 'fr'));
  extra.forEach(add);
  const tools = new Map();
  for (const g of list) {
    const key = toolFilterKey(g);
    if (key === '' || tools.has(key)) continue;
    tools.set(key, { value: key, label: toolLabel(g, questionnaire) });
  }
  return {
    departments,
    hasNoDepartment: list.some((g) => (g.departments ?? []).length === 0),
    tools: [...tools.values()].sort((a, b) => a.label.localeCompare(b.label, 'fr')),
  };
}

/** Clé de regroupement d'une entrée (comme consolidate). */
export function entryGroupKey(entry, { byDepartment = false } = {}) {
  const override = typeof entry?.group_override === 'string' && entry.group_override !== '' ? entry.group_override : null;
  return override ?? usageKey(entry?.usage, { byDepartment });
}

/** Entrées écartées (excluded = true), les plus récentes d'abord. */
export function excludedEntries(entries) {
  return (entries ?? []).filter((e) => e && e.excluded === true).sort(compareEntries);
}

/** Entrées écartées qui appartiendraient à la ligne `key`. */
export function excludedForGroup(entries, key, { byDepartment = false } = {}) {
  return excludedEntries(entries).filter((e) => entryGroupKey(e, { byDepartment }) === key);
}

/** Ordre d'affichage des déclarations : jour décroissant, puis identifiant. */
export function compareEntries(a, b) {
  return String(b?.submitted_day ?? '').localeCompare(String(a?.submitted_day ?? '')) || String(a?.entry_id ?? '').localeCompare(String(b?.entry_id ?? ''));
}

/**
 * Clé stable d'un nouveau groupe issu d'une scission : « manual:<entry_id> », suffixée (~2, ~3…)
 * si cette clé est déjà prise (déclaration déjà scindée puis rejointe par une fusion : la même clé
 * la laisserait dans son groupe actuel).
 */
export function splitKey(entryId, usedKeys = []) {
  const used = new Set(usedKeys);
  const base = `manual:${entryId}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const key = `${base}~${n}`;
    if (!used.has(key)) return key;
  }
}

/** Clés de regroupement de toutes les entrées, écartées comprises (clés déjà « prises »). */
export function usedGroupKeys(entries, { byDepartment = false } = {}) {
  return (entries ?? []).filter(Boolean).map((e) => entryGroupKey(e, { byDepartment }));
}

/**
 * Filtres encore applicables : un service ou un outil mémorisé qui n'est plus proposé (plus aucune
 * ligne ne le porte) est retiré, sinon la liste serait vide alors que le menu afficherait « Tous ».
 */
export function reconcileFilters(filters, options) {
  const f = sanitizeFilters(filters);
  const departments = new Set((options?.departments ?? []).map((d) => d.value));
  if (options?.hasNoDepartment) departments.add(NO_DEPARTMENT);
  const tools = new Set((options?.tools ?? []).map((o) => o.value));
  return {
    ...f,
    department: departments.has(f.department) ? f.department : '',
    tool: tools.has(f.tool) ? f.tool : '',
  };
}

/** Lignes vers lesquelles fusionner `sourceKey` (toutes les autres, par ordre alphabétique). */
export function mergeTargets(groups, sourceKey) {
  return (groups ?? []).filter((g) => g.usage_key !== sourceKey).sort((a, b) => compareNames(a, b) || String(a.id).localeCompare(String(b.id)));
}

const PRIORITY_LEVELS = new Set(['prohibited_suspected', 'high', 'to_qualify']);

/** Usage prioritaire : interdit suspecté, haut risque, ou à qualifier (AI Act ou exposition). */
export function isPriority(group) {
  return PRIORITY_LEVELS.has(group?.effective?.ai_act_level) || isToQualify(group);
}

/** Usages prioritaires : interdits suspectés, haut risque, à qualifier (ordre de gravité). */
export function priorityGroups(groups, { limit } = {}) {
  const list = (groups ?? []).filter(isPriority).sort(compareGroups);
  return Number.isInteger(limit) && limit >= 0 ? list.slice(0, limit) : list;
}
