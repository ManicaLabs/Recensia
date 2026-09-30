// Onglet « Plan d'actions » de la console (CDC §9) : suggestions à accepter ou rejeter,
// puis pilotage des actions (responsable, échéance, priorité, statut).
// Jamais de responsable affecté automatiquement : le rôle suggéré n'est qu'une indication.
// Les fonctions exportées en tête de fichier sont pures (testées sous Node).

import { h, mount, loadCss } from '../../ui/dom.js';
import {
  button, icon, field, setFieldError, levelBadge, modal, confirmDialog, toast, disclaimer, callout,
} from '../../ui/components.js';
import { actionFromSuggestion } from '../../engine/actions.js';
import { cleanLine, cleanMultiline } from '../../engine/validate.js';
import { randomId } from '../../crypto/random.js';
import { formatDate, formatDateTime } from '../../i18n.js';
// Typographie française à l'affichage des textes venus de data/ (actions, règles) et des saisies :
// les valeurs enregistrées ne sont jamais modifiées.
import { frenchSpacing as fr } from '../../ui/questionnaire.js';

// ---------------------------------------------------------------------------------------------
// Logique pure
// ---------------------------------------------------------------------------------------------

export const ACTION_STATUSES = Object.freeze(['todo', 'in_progress', 'done', 'rejected']);
export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
/** Filtres de statut : « active » = toutes sauf rejetées ; « open » = à faire + en cours. */
export const STATUS_FILTERS = Object.freeze(['active', 'open', 'todo', 'in_progress', 'done', 'rejected', 'all']);
export const PRIORITY_FILTERS = Object.freeze(['all', ...PRIORITIES]);
export const SORTS = Object.freeze(['priority', 'due_date', 'status', 'updated', 'title']);
export const USAGE_ALL = 'all';
export const USAGE_CAMPAIGN = 'campaign';
export const LIMITS = Object.freeze({ title: 200, description: 2000, owner: 120 });
export const DEFAULT_VIEW = Object.freeze({ status: 'active', priority: 'all', usage: USAGE_ALL, sort: 'priority' });

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function rank(list, value) {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
}

function compareText(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'fr', { sensitivity: 'base' });
}

/** Jour AAAA-MM-JJ réel (pas de 31 février). */
export function isValidDay(value) {
  if (typeof value !== 'string') return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function isoOf(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  return date.toISOString();
}

/** Clé d'une suggestion (modèle + usage), identique à la déduplication du moteur. */
export function suggestionKey(suggestion) {
  return `${suggestion?.template_id ?? ''}\u0000${suggestion?.usage_key ?? ''}`;
}

/**
 * Regroupe les suggestions par portée : actions transverses de campagne d'abord, puis une
 * rubrique par ligne du registre, dans l'ordre des groupes (gravité décroissante).
 * → [{ id, usage_key, group, items }] ; id = 'campaign' ou usage_key.
 */
export function groupSuggestions(suggestions, groups) {
  const byKey = new Map((groups ?? []).map((g) => [g.usage_key, g]));
  const campaign = { id: USAGE_CAMPAIGN, usage_key: null, group: null, items: [] };
  const buckets = new Map();
  for (const s of suggestions ?? []) {
    if (!s) continue;
    if (s.usage_key === null || s.usage_key === undefined) {
      campaign.items.push(s);
      continue;
    }
    if (!buckets.has(s.usage_key)) buckets.set(s.usage_key, { id: s.usage_key, usage_key: s.usage_key, group: byKey.get(s.usage_key) ?? null, items: [] });
    buckets.get(s.usage_key).items.push(s);
  }
  const order = new Map((groups ?? []).map((g, i) => [g.usage_key, i]));
  const perUsage = [...buckets.values()].sort((a, b) => (order.get(a.usage_key) ?? Infinity) - (order.get(b.usage_key) ?? Infinity));
  return [...(campaign.items.length ? [campaign] : []), ...perUsage];
}

/** Clé de la suggestion à mettre au point après le retrait de `key` (suivante, sinon précédente). */
export function nextSuggestionKey(buckets, key) {
  const keys = (buckets ?? []).flatMap((b) => b.items.map(suggestionKey));
  const i = keys.indexOf(key);
  if (i === -1) return keys[0] ?? null;
  return keys[i + 1] ?? keys[i - 1] ?? null;
}

/** Rubrique (id) qui contient la suggestion de clé `key` ; null si absente. */
export function bucketIdOf(buckets, key) {
  return (buckets ?? []).find((b) => b.items.some((s) => suggestionKey(s) === key))?.id ?? null;
}

/**
 * Rubriques dépliées au premier affichage : toutes s'il y a peu de suggestions, sinon la
 * première seulement (la page reste courte ; les autres se déplient à la demande).
 */
export function initialOpenBuckets(buckets, { threshold = 6 } = {}) {
  const list = buckets ?? [];
  const total = list.reduce((n, b) => n + b.items.length, 0);
  return new Set(total <= threshold ? list.map((b) => b.id) : list.slice(0, 1).map((b) => b.id));
}

/** Action en retard : échéance passée et action ni faite ni rejetée. */
export function isOverdue(action, today) {
  return Boolean(action && isValidDay(action.due_date) && typeof today === 'string'
    && action.due_date < today && (action.status === 'todo' || action.status === 'in_progress'));
}

/** Compteurs d'avancement ; le pourcentage porte sur les actions non rejetées. */
export function progressOf(actions, today) {
  const counts = Object.fromEntries(ACTION_STATUSES.map((s) => [s, 0]));
  let overdue = 0;
  for (const a of actions ?? []) {
    if (a && Object.hasOwn(counts, a.status)) counts[a.status] += 1;
    if (isOverdue(a, today)) overdue += 1;
  }
  const total = (actions ?? []).filter((a) => a && Object.hasOwn(counts, a.status)).length;
  const active = total - counts.rejected;
  return { ...counts, overdue, total, active, percent: active > 0 ? Math.round((counts.done / active) * 100) : 0 };
}

function statusMatches(status, filter) {
  switch (filter) {
    case 'all': return true;
    case 'active': return status !== 'rejected';
    case 'open': return status === 'todo' || status === 'in_progress';
    default: return status === filter;
  }
}

/** Filtre les actions (statut, priorité, usage : 'all', 'campaign' ou une clé d'usage). */
export function filterActions(actions, { status = 'active', priority = 'all', usage = USAGE_ALL } = {}) {
  return (actions ?? []).filter((a) => {
    if (!a) return false;
    if (!statusMatches(a.status, status)) return false;
    if (priority !== 'all' && a.priority !== priority) return false;
    if (usage === USAGE_CAMPAIGN) return a.usage_key === null || a.usage_key === undefined;
    if (usage !== USAGE_ALL && a.usage_key !== usage) return false;
    return true;
  });
}

function byDue(a, b) {
  const da = isValidDay(a.due_date) ? a.due_date : null;
  const db = isValidDay(b.due_date) ? b.due_date : null;
  if (da === db) return 0;
  if (da === null) return 1; // sans échéance en dernier
  if (db === null) return -1;
  return da < db ? -1 : 1;
}

function byUpdated(a, b) {
  return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
}

/**
 * Trie une copie des actions. priority : priorité, puis échéance ; due_date : échéance la plus
 * proche (sans échéance à la fin) ; status : à faire, en cours, fait, rejeté ; updated : plus
 * récente d'abord ; title : ordre alphabétique. Départage stable : titre puis identifiant.
 */
export function sortActions(actions, sort = 'priority') {
  const tie = (a, b) => compareText(a.title, b.title) || String(a.id).localeCompare(String(b.id));
  const comparators = {
    priority: (a, b) => rank(PRIORITIES, a.priority) - rank(PRIORITIES, b.priority) || byDue(a, b) || tie(a, b),
    due_date: (a, b) => byDue(a, b) || rank(PRIORITIES, a.priority) - rank(PRIORITIES, b.priority) || tie(a, b),
    status: (a, b) => rank(ACTION_STATUSES, a.status) - rank(ACTION_STATUSES, b.status) || rank(PRIORITIES, a.priority) - rank(PRIORITIES, b.priority) || tie(a, b),
    updated: (a, b) => byUpdated(a, b) || tie(a, b),
    title: tie,
  };
  const cmp = comparators[sort] ?? comparators.priority;
  return [...(actions ?? [])].filter(Boolean).sort(cmp);
}

/**
 * Actions affichées : celles qui correspondent aux filtres, plus celles de `keep` (identifiants
 * des actions que l'on vient de modifier) même si elles n'y correspondent plus. Une action dont
 * on change le statut ne disparaît donc pas sous le focus : elle reste affichée, signalée, jusqu'au
 * prochain changement de filtre. → [{ action, matches }] dans l'ordre du tri de la vue.
 */
export function visibleActions(actions, view = DEFAULT_VIEW, keep = new Set()) {
  const list = (actions ?? []).filter(Boolean);
  const matching = new Set(filterActions(list, view));
  const kept = keep instanceof Set ? keep : new Set(keep ?? []);
  const shown = list.filter((a) => matching.has(a) || kept.has(a.id));
  return sortActions(shown, view?.sort).map((a) => ({ action: a, matches: matching.has(a) }));
}

/**
 * Mention du dialogue d'édition pour une action issue d'une suggestion, dont l'usage est figé :
 * action transverse (usage_key nul, toute la campagne) ou rattachée à une ligne du registre.
 */
export function usageLockedKey(action) {
  return action?.usage_key === null || action?.usage_key === undefined
    ? 'actions.form.usage_locked_transverse'
    : 'actions.form.usage_locked';
}

/** Options du filtre et du champ « usage concerné » : une par ligne du registre. */
export function usageOptions(groups) {
  return (groups ?? []).map((g) => ({ value: g.usage_key, label: g.name || g.id, id: g.id }));
}

/** Filtre de vue normalisé (valeurs inconnues ⇒ valeurs par défaut ; usage disparu ⇒ tous). */
export function normalizeView(view, usageKeys = []) {
  const v = { ...DEFAULT_VIEW, ...(view ?? {}) };
  if (!STATUS_FILTERS.includes(v.status)) v.status = DEFAULT_VIEW.status;
  if (!PRIORITY_FILTERS.includes(v.priority)) v.priority = DEFAULT_VIEW.priority;
  if (!SORTS.includes(v.sort)) v.sort = DEFAULT_VIEW.sort;
  if (v.usage !== USAGE_ALL && v.usage !== USAGE_CAMPAIGN && !usageKeys.includes(v.usage)) v.usage = USAGE_ALL;
  return v;
}

/**
 * Valide et normalise la saisie d'une action.
 * input = { title, description, owner, due_date, priority, status, usage_key }
 * → { ok, errors: [{ field, code }], value } ; codes : required, too_long, invalid_date, enum, unknown_usage.
 * usageKeys (facultatif) : clés d'usage autorisées pour usage_key.
 */
export function normalizeActionInput(input, { usageKeys } = {}) {
  const errors = [];
  const err = (fieldName, code) => errors.push({ field: fieldName, code });
  const src = input ?? {};

  const title = cleanLine(src.title ?? '');
  if (title === '') err('title', 'required');
  else if (title.length > LIMITS.title) err('title', 'too_long');

  const description = cleanMultiline(src.description ?? '');
  if (description.length > LIMITS.description) err('description', 'too_long');

  const owner = cleanLine(src.owner ?? '');
  if (owner.length > LIMITS.owner) err('owner', 'too_long');

  const rawDue = typeof src.due_date === 'string' ? src.due_date.trim() : src.due_date;
  let dueDate = null;
  if (rawDue !== null && rawDue !== undefined && rawDue !== '') {
    if (isValidDay(rawDue)) dueDate = rawDue;
    else err('due_date', 'invalid_date');
  }

  const priority = src.priority ?? 'medium';
  if (!PRIORITIES.includes(priority)) err('priority', 'enum');
  const status = src.status ?? 'todo';
  if (!ACTION_STATUSES.includes(status)) err('status', 'enum');

  let usageKey = src.usage_key === '' || src.usage_key === undefined ? null : src.usage_key;
  if (usageKey !== null && (typeof usageKey !== 'string' || (Array.isArray(usageKeys) && !usageKeys.includes(usageKey)))) {
    err('usage_key', 'unknown_usage');
    usageKey = null;
  }

  return {
    ok: errors.length === 0,
    errors,
    value: { title, description, owner, due_date: dueDate, priority, status, usage_key: usageKey },
  };
}

/**
 * Applique une modification à une action existante (copie ; updated_at renouvelé).
 * Une action issue d'un modèle garde son usage : le changer ferait réapparaître la suggestion.
 */
export function applyActionChanges(action, input, { now = new Date(), usageKeys } = {}) {
  const check = normalizeActionInput({ usage_key: action?.usage_key ?? null, ...input }, { usageKeys: action?.template_id ? undefined : usageKeys });
  if (!check.ok) return { ok: false, errors: check.errors, value: null };
  const v = check.value;
  return {
    ok: true,
    errors: [],
    value: {
      ...action,
      title: v.title,
      description: v.description,
      owner: v.owner,
      due_date: v.due_date,
      priority: v.priority,
      status: v.status,
      usage_key: action?.template_id ? (action.usage_key ?? null) : v.usage_key,
      updated_at: isoOf(now),
    },
  };
}

/** Nouvelle action saisie à la main (suggested: false, sans modèle, usage facultatif). */
export function createManualAction(input, campaignId, { now = new Date(), id = `M-${randomId(9)}`, usageKeys } = {}) {
  const check = normalizeActionInput(input, { usageKeys });
  if (!check.ok) return { ok: false, errors: check.errors, value: null };
  const at = isoOf(now);
  const v = check.value;
  return {
    ok: true,
    errors: [],
    value: {
      id,
      campaign_id: campaignId,
      usage_key: v.usage_key,
      template_id: null,
      title: v.title,
      description: v.description,
      owner: v.owner,
      due_date: v.due_date,
      priority: v.priority,
      status: v.status,
      suggested: false,
      suggested_role: null,
      created_at: at,
      updated_at: at,
    },
  };
}

/**
 * Change le statut d'une action (toute transition est permise, y compris la restauration d'une
 * action rejetée). → { changed, value } ; statut inconnu ⇒ TypeError.
 */
export function transitionStatus(action, status, now = new Date()) {
  if (!ACTION_STATUSES.includes(status)) throw new TypeError(`Statut d'action inconnu : ${status}`);
  if (action.status === status) return { changed: false, value: action };
  return { changed: true, value: { ...action, status, updated_at: isoOf(now) } };
}

/** Suggestion acceptée ⇒ action « à faire » (identifiant déterministe, sans responsable). */
export function acceptSuggestion(suggestion, campaignId, now = new Date()) {
  return actionFromSuggestion(suggestion, campaignId, { now });
}

/** Suggestion rejetée ⇒ action enregistrée « rejetée » : elle n'est plus proposée. */
export function rejectSuggestion(suggestion, campaignId, now = new Date()) {
  return actionFromSuggestion(suggestion, campaignId, { status: 'rejected', now });
}

/** Toutes les suggestions acceptées d'un coup (identifiants uniques). */
export function acceptAllSuggestions(suggestions, campaignId, now = new Date()) {
  const seen = new Set();
  const out = [];
  for (const s of suggestions ?? []) {
    const action = acceptSuggestion(s, campaignId, now);
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    out.push(action);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------------------------

// État d'affichage conservé entre deux rafraîchissements (filtres, tri, focus à restaurer,
// actions modifiées gardées à l'écran jusqu'au prochain changement de filtre).
const views = new Map();
const openBuckets = new Map();
const keptActions = new Map();
let pendingFocus = null;

function viewFor(campaignId, usageKeys) {
  const v = normalizeView(views.get(campaignId), usageKeys);
  views.set(campaignId, v);
  return v;
}

function keptFor(campaignId) {
  if (!keptActions.has(campaignId)) keptActions.set(campaignId, new Set());
  return keptActions.get(campaignId);
}

function selectControl(options, value, attrs = {}) {
  return h('select', { ...attrs, value }, options.map((o) => h('option', { value: o.value }, o.label)));
}

/**
 * Sélecteur de statut d'une action suivi d'un bouton « Appliquer » (WCAG 3.2.2) : parcourir les
 * options (souris ou flèches du clavier, qui déclenchent « change » sous Windows et Linux)
 * n'enregistre rien et ne modifie pas la page. Le statut choisi n'est enregistré que par le
 * bouton « Appliquer » (affiché seulement quand ce statut diffère du statut enregistré) ou par la
 * touche Entrée sur le sélecteur. reset() revient au statut enregistré et, si « Appliquer » avait
 * le focus, le rend au sélecteur. Construit des éléments DOM (testé sous Node avec un faux DOM).
 * → { select, apply, sync, reset }
 */
export function statusControl(action, t, { id, onApply } = {}) {
  const select = selectControl(ACTION_STATUSES.map((s) => ({ value: s, label: t(`common.action_status.${s}`) })), action.status, {
    id,
    class: 'action-status-select',
  });
  const pending = () => ACTION_STATUSES.includes(select.value) && select.value !== action.status;
  const commit = () => {
    if (pending() && typeof onApply === 'function') onApply(select.value);
  };
  const apply = button(t('actions.item.apply'), commit, {
    variant: 'primary', size: 'sm', icon: 'check', attrs: { class: 'action-status-apply' },
  });
  const sync = () => {
    const dirty = pending();
    apply.hidden = !dirty;
    if (dirty) {
      apply.setAttribute('aria-label', t('actions.item.apply_label', { status: t(`common.action_status.${select.value}`), title: action.title }));
    } else {
      apply.removeAttribute('aria-label');
    }
  };
  // Retour au statut enregistré (échec d'enregistrement, statut inchangé) : « Appliquer » est
  // masqué ; s'il avait le focus, celui-ci passe au sélecteur au lieu de retomber sur la page.
  const reset = () => {
    const hadFocus = globalThis.document?.activeElement === apply;
    select.value = action.status;
    sync();
    if (hadFocus && apply.hidden && typeof select.focus === 'function') select.focus();
  };
  select.addEventListener('change', sync);
  select.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !pending()) return;
    event.preventDefault();
    commit();
  });
  sync();
  return { select, apply, sync, reset };
}

/**
 * Badges des deux niveaux d'une ligne du registre, axe affiché (« AI Act : Haut risque »,
 * « Exposition des données : Critique ») et libellé complet (jamais le libellé court) : pour les
 * résumés où rien d'autre ne nomme l'axe de chaque badge (rubriques de suggestions du plan
 * d'actions, fiches des usages prioritaires du rapport). → [badge AI Act, badge données]
 */
export function axisBadges(effective, t) {
  return [
    levelBadge('ai_act', effective?.ai_act_level, t, { axisLabel: 'visible' }),
    levelBadge('data', effective?.data_level, t, { axisLabel: 'visible' }),
  ];
}

/**
 * Emplacement d'un encart d'erreur d'enregistrement (masqué tant qu'il est vide, par la feuille de
 * style). live : true pour un emplacement placé dans un dialogue (role="alert") : la notification,
 * hors du dialogue modal, n'y est ni visible ni annoncée.
 */
export function saveErrorSlot({ live = false } = {}) {
  return h('div', { class: 'actions-save-error', role: live ? 'alert' : null });
}

/**
 * Encart d'erreur d'enregistrement, affiché en plus de la notification (actions.toast.save_error) :
 * un seul à la fois, dans l'emplacement de l'élément concerné (sinon `fallback`), jusqu'au prochain
 * affichage de l'onglet (enregistrement réussi), à une nouvelle tentative (clear) ou à une autre
 * erreur, qui le déplace. Construit des éléments DOM (testé sous Node avec un faux DOM).
 * → { show(slot) → emplacement utilisé ou null, clear(), current() }
 */
export function saveErrorPresenter(t, fallback = null) {
  let current = null;
  const clear = () => {
    if (current) mount(current);
    current = null;
  };
  const show = (slot) => {
    const target = slot ?? fallback;
    clear();
    if (!target) return null;
    mount(target, callout('danger', h('p', null, t('actions.toast.save_error'))));
    current = target;
    return target;
  };
  return { show, clear, current: () => current };
}

function statusBadge(status, t) {
  return h('span', { class: ['badge', 'action-status', `action-status-${status}`] }, t(`common.action_status.${status}`));
}

function priorityTag(priority, t) {
  return h('span', { class: ['tag', 'action-priority', `action-priority-${priority}`] }, t('actions.priority_tag', { priority: t(`common.priority.${priority}`) }));
}

function ruleLabel(rules, id) {
  const rule = (rules?.rules ?? []).find((r) => r.id === id);
  return rule?.label ? `${fr(rule.label)} (${id})` : id;
}

function groupLabel(group, t) {
  return group ? (group.name || group.id) : t('actions.usage_unknown');
}

function usageText(action, groupsByKey, t) {
  if (action.usage_key === null || action.usage_key === undefined) return t('actions.usage_campaign');
  const g = groupsByKey.get(action.usage_key);
  return g ? `${g.name || g.id} (${g.id})` : t('actions.usage_gone');
}

function errorMessage(t, code, fieldName) {
  const max = LIMITS[fieldName];
  return t(`actions.errors.${code}`, { max });
}

function focusLater(target) {
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

export async function render(root, { campaign, model, ctx, refresh }) {
  const { t, store } = ctx;
  await loadCss('src/styles/actions.css');

  const groups = model.groups ?? [];
  const groupsByKey = new Map(groups.map((g) => [g.usage_key, g]));
  const usageKeys = groups.map((g) => g.usage_key);
  const view = viewFor(campaign.id, usageKeys);
  const today = model.today;
  const buckets = groupSuggestions(model.suggestions, groups);
  if (!openBuckets.has(campaign.id)) openBuckets.set(campaign.id, initialOpenBuckets(buckets));
  const openSet = openBuckets.get(campaign.id);
  const progress = progressOf(model.actions, today);
  const focusTargets = new Map();
  // Actions gardées à l'écran : seulement pendant un rafraîchissement demandé par cet onglet
  // (focus à restaurer) ; un nouvel affichage de l'onglet repart des seuls filtres.
  const kept = keptFor(campaign.id);
  if (!(pendingFocus && pendingFocus.campaignId === campaign.id)) kept.clear();
  let busy = false;

  const guard = async (fn) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };

  // Erreur d'enregistrement : notification et encart persistant près de l'élément concerné
  // (slot) ; l'encart disparaît au prochain affichage de l'onglet, après un enregistrement réussi.
  const pageErrorSlot = saveErrorSlot();
  const saveErrors = saveErrorPresenter(t, pageErrorSlot);
  const reportError = (err, slot) => {
    console.error('[Recensia] Plan d’actions : enregistrement impossible.', err);
    toast(t('actions.toast.save_error'), 'danger');
    saveErrors.show(slot);
  };

  // --- Suggestions -------------------------------------------------------------------------

  // Suggestion suivante (sa rubrique est dépliée pour qu'elle puisse recevoir le focus).
  const focusAfterSuggestion = (suggestion, fallback) => {
    const next = nextSuggestionKey(buckets, suggestionKey(suggestion));
    if (!next) return { campaignId: campaign.id, kind: 'heading', key: fallback };
    const bucket = bucketIdOf(buckets, next);
    if (bucket) openSet.add(bucket);
    return { campaignId: campaign.id, kind: 'suggestion', key: next };
  };

  async function accept(suggestion, slot) {
    await guard(async () => {
      try {
        await store.putAction(acceptSuggestion(suggestion, campaign.id));
      } catch (err) {
        reportError(err, slot);
        return;
      }
      toast(t('actions.toast.accepted', { title: fr(suggestion.title) }), 'success');
      pendingFocus = focusAfterSuggestion(suggestion, 'list');
      await refresh();
    });
  }

  async function reject(suggestion, slot) {
    await guard(async () => {
      try {
        await store.putAction(rejectSuggestion(suggestion, campaign.id));
      } catch (err) {
        reportError(err, slot);
        return;
      }
      toast(t('actions.toast.rejected', { title: fr(suggestion.title) }), 'info');
      pendingFocus = focusAfterSuggestion(suggestion, 'suggestions');
      await refresh();
    });
  }

  async function acceptAll() {
    const count = model.suggestions.length;
    if (!count) return;
    const ok = await confirmDialog({
      title: t('actions.accept_all.title'),
      message: t('actions.accept_all.message', { count }),
      confirmLabel: t('actions.accept_all.confirm', { count }),
    });
    if (!ok) return;
    await guard(async () => {
      try {
        await store.putActions(acceptAllSuggestions(model.suggestions, campaign.id));
      } catch (err) {
        reportError(err, suggestionsErrorSlot);
        return;
      }
      toast(t('actions.toast.accepted_all', { count }), 'success');
      pendingFocus = { campaignId: campaign.id, kind: 'heading', key: 'list' };
      await refresh();
    });
  }

  function suggestionItem(s) {
    const key = suggestionKey(s);
    const errorSlot = saveErrorSlot();
    const acceptBtn = button(t('actions.suggestion.accept'), () => accept(s, errorSlot), {
      variant: 'primary', size: 'sm', icon: 'check',
      attrs: { 'aria-label': t('actions.suggestion.accept_label', { title: s.title }) },
    });
    focusTargets.set(`suggestion:${key}`, acceptBtn);
    return h('li', { class: 'sugg-item' },
      h('div', { class: 'sugg-head' },
        h('p', { class: 'sugg-title' }, fr(s.title)),
        h('div', { class: 'cluster sugg-tags' },
          priorityTag(s.priority, t),
          s.effort ? h('span', { class: 'tag' }, t('actions.suggestion.effort', { effort: t(`actions.effort.${s.effort}`) })) : null,
          s.horizon ? h('span', { class: 'tag' }, t('actions.suggestion.horizon', { horizon: fr(s.horizon) })) : null)),
      s.description ? h('p', { class: 'sugg-desc' }, fr(s.description)) : null,
      h('dl', { class: 'meta-list sugg-meta' },
        h('dt', null, t('actions.suggestion.role')),
        h('dd', null, s.suggested_role ? fr(s.suggested_role) : t('actions.suggestion.no_role'), ' ',
          h('span', { class: 'muted' }, t('actions.suggestion.role_note'))),
        s.rule_ids?.length ? [
          h('dt', null, t('actions.suggestion.rules')),
          h('dd', null, s.rule_ids.map((id) => ruleLabel(model.rules, id)).join('\u00a0; ')),
        ] : null),
      h('div', { class: 'cluster sugg-buttons' },
        acceptBtn,
        button(t('actions.suggestion.reject'), () => reject(s, errorSlot), {
          size: 'sm', icon: 'close',
          attrs: { 'aria-label': t('actions.suggestion.reject_label', { title: s.title }) },
        })),
      errorSlot);
  }

  function suggestionBucket(bucket) {
    const g = bucket.group;
    const title = bucket.id === USAGE_CAMPAIGN ? t('actions.suggestions.campaign') : groupLabel(g, t);
    return h('details', {
      class: 'sugg-group',
      open: openSet.has(bucket.id),
      onToggle: (event) => {
        if (event.currentTarget.open) openSet.add(bucket.id);
        else openSet.delete(bucket.id);
      },
    },
      h('summary', { class: 'sugg-summary' },
        h('span', { class: 'sugg-summary-title' }, title),
        // Axe affiché et libellé complet : rien d'autre ne nomme l'axe des badges du résumé.
        g ? h('span', { class: 'cluster sugg-summary-badges' }, axisBadges(g.effective, t)) : null,
        h('span', { class: 'tag' }, t('actions.suggestions.count', { count: bucket.items.length }))),
      bucket.id === USAGE_CAMPAIGN ? h('p', { class: 'muted sugg-scope' }, t('actions.suggestions.campaign_help')) : null,
      h('ul', { class: 'sugg-list', role: 'list' }, bucket.items.map(suggestionItem)));
  }

  const suggestionsHeading = h('h3', { id: 'actions-suggestions-title', tabindex: '-1' },
    t('actions.suggestions.title', { count: model.suggestions.length }));
  focusTargets.set('heading:suggestions', suggestionsHeading);

  const suggestionsErrorSlot = saveErrorSlot();
  const suggestionsSection = h('section', { class: 'actions-section', 'aria-labelledby': 'actions-suggestions-title' },
    h('div', { class: 'cluster cluster-between actions-section-head' },
      suggestionsHeading,
      model.suggestions.length > 1
        ? button(t('actions.accept_all.button', { count: model.suggestions.length }), acceptAll, { icon: 'check' })
        : null),
    suggestionsErrorSlot,
    h('p', { class: 'muted' }, t('actions.suggestions.help')),
    model.suggestions.length
      ? h('div', { class: 'stack sugg-groups' }, buckets.map(suggestionBucket))
      : h('p', { class: ['empty-note', groups.length ? 'is-success' : null] }, icon(groups.length ? 'success' : 'info'),
        h('span', null, groups.length ? t('actions.suggestions.empty') : t('actions.suggestions.empty_no_usage'))));

  // --- Édition -----------------------------------------------------------------------------

  async function openEditor(existing) {
    const isNew = !existing;
    const fromTemplate = Boolean(existing?.template_id);
    const base = existing ?? { title: '', description: '', owner: '', due_date: null, priority: 'medium', status: 'todo', usage_key: null };
    const prefix = isNew ? 'action-new' : 'action-edit';

    // autofocus : à l'ouverture du dialogue, le focus va sur l'intitulé (et non sur « Fermer »).
    const titleInput = h('input', { type: 'text', maxlength: String(LIMITS.title), autocomplete: 'off', autofocus: true, value: base.title ?? '' });
    const descInput = h('textarea', { rows: '4', maxlength: String(LIMITS.description), value: base.description ?? '' });
    const role = existing?.suggested_role ?? null;
    const ownerInput = h('input', {
      type: 'text', maxlength: String(LIMITS.owner), autocomplete: 'off', value: base.owner ?? '',
      placeholder: role ? t('actions.form.owner_placeholder_role', { role }) : t('actions.form.owner_placeholder'),
    });
    const dueInput = h('input', { type: 'date', value: isValidDay(base.due_date) ? base.due_date : '' });
    const priorityInput = selectControl(PRIORITIES.map((p) => ({ value: p, label: t(`common.priority.${p}`) })), base.priority ?? 'medium');
    const statusInput = selectControl(ACTION_STATUSES.map((s) => ({ value: s, label: t(`common.action_status.${s}`) })), base.status ?? 'todo');
    // Usage qui ne figure plus dans le registre (entrées exclues, regroupement modifié…) :
    // proposé tel quel pour que l'enregistrement ne détache pas l'action à l'insu de l'utilisateur.
    const orphanKey = !fromTemplate && typeof base.usage_key === 'string' && base.usage_key !== '' && !groupsByKey.has(base.usage_key)
      ? base.usage_key
      : null;
    const allowedKeys = orphanKey ? [...usageKeys, orphanKey] : usageKeys;
    const usageInput = fromTemplate ? null : selectControl([
      { value: '', label: t('actions.form.usage_none') },
      ...(orphanKey ? [{ value: orphanKey, label: t('actions.usage_gone') }] : []),
      ...usageOptions(groups).map((o) => ({ value: o.value, label: `${o.label} (${o.id})` })),
    ], base.usage_key && (groupsByKey.has(base.usage_key) || orphanKey) ? base.usage_key : '');

    const fields = {
      title: field({ id: `${prefix}-title`, label: t('actions.form.title'), required: true, control: titleInput }),
      description: field({ id: `${prefix}-description`, label: t('actions.form.description'), control: descInput }),
      usage_key: fromTemplate
        ? h('div', { class: 'field' },
          h('p', { class: 'field-label' }, t('actions.form.usage')),
          h('p', null, usageText(existing, groupsByKey, t)),
          h('p', { class: 'field-help' }, t(usageLockedKey(existing))))
        : field({ id: `${prefix}-usage`, label: t('actions.form.usage'), help: t('actions.form.usage_help'), control: usageInput }),
      owner: field({
        id: `${prefix}-owner`,
        label: t('actions.form.owner'),
        help: role ? t('actions.form.owner_help_role', { role }) : t('actions.form.owner_help'),
        control: ownerInput,
      }),
      due_date: field({ id: `${prefix}-due`, label: t('actions.form.due_date'), help: t('actions.form.due_help'), control: dueInput }),
      priority: field({ id: `${prefix}-priority`, label: t('actions.form.priority'), control: priorityInput }),
      status: field({ id: `${prefix}-status`, label: t('actions.form.status'), control: statusInput }),
    };
    const controls = { title: titleInput, description: descInput, owner: ownerInput, due_date: dueInput, priority: priorityInput, status: statusInput, usage_key: usageInput };
    // Erreur d'enregistrement affichée dans le dialogue, juste au-dessus de ses boutons.
    const formErrorSlot = saveErrorSlot({ live: true });

    const form = h('form', {
      class: 'action-form',
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        form.closest('dialog')?.querySelector('.modal-actions .btn-primary')?.click();
      },
    },
    h('p', { class: 'field-help' }, t('common.field.required_legend')),
    fields.title,
    fields.description,
    fields.usage_key,
    h('div', { class: 'action-form-grid' }, fields.owner, fields.due_date, fields.priority, fields.status),
    formErrorSlot,
    // Bouton invisible : la touche Entrée d'un champ déclenche l'enregistrement.
    h('button', { type: 'submit', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }, t('common.actions.save')));

    const save = async () => {
      saveErrors.clear();
      const input = {
        title: titleInput.value,
        description: descInput.value,
        owner: ownerInput.value,
        due_date: dueInput.value,
        priority: priorityInput.value,
        status: statusInput.value,
      };
      if (usageInput) input.usage_key = usageInput.value;
      for (const node of Object.values(fields)) if (node.classList.contains('field') && node.querySelector('.field-error')) setFieldError(node, null);

      let result;
      if (isNew) {
        result = createManualAction(input, campaign.id, { usageKeys: allowedKeys });
      } else {
        // Relecture depuis le store : aucune modification concurrente n'est écrasée à l'aveugle.
        let current = existing;
        try {
          current = (await store.listActions(campaign.id)).find((a) => a.id === existing.id) ?? existing;
        } catch (err) {
          console.warn('[Recensia] Relecture de l’action impossible.', err);
        }
        result = applyActionChanges(current, input, { usageKeys: allowedKeys });
      }
      if (!result.ok) {
        for (const e of result.errors) {
          const node = fields[e.field];
          if (node && node.querySelector('.field-error')) setFieldError(node, errorMessage(t, e.code, e.field));
        }
        const first = result.errors.map((e) => controls[e.field]).find(Boolean);
        first?.focus();
        return undefined;
      }
      try {
        await store.putAction(result.value);
      } catch (err) {
        reportError(err, formErrorSlot);
        return undefined;
      }
      return result.value;
    };

    const saved = await modal({
      title: isNew ? t('actions.form.new_title') : t('actions.form.edit_title'),
      content: form,
      size: 'lg',
      actions: [
        { label: t('common.actions.cancel'), value: null },
        { label: isNew ? t('actions.form.create') : t('common.actions.save'), value: save, variant: 'primary' },
      ],
    });
    if (!saved) return;
    toast(isNew ? t('actions.toast.created', { title: fr(saved.title) }) : t('actions.toast.updated', { title: fr(saved.title) }), 'success');
    pendingFocus = { campaignId: campaign.id, kind: 'edit', key: saved.id };
    if (isNew) {
      // L'action créée doit rester visible : filtres élargis si besoin.
      const shown = filterActions([saved], view).length > 0;
      if (!shown) views.set(campaign.id, { ...view, status: 'all', priority: 'all', usage: USAGE_ALL });
    } else {
      // Action modifiée : elle reste affichée (et son bouton « Modifier » garde le focus) même si
      // elle ne correspond plus aux filtres.
      kept.add(saved.id);
    }
    await refresh();
  }

  async function removeAction(action, slot) {
    const ok = await confirmDialog({
      title: t('actions.delete.title'),
      message: h('div', { class: 'stack-sm' },
        h('p', null, t('actions.delete.message', { title: fr(action.title) })),
        action.template_id ? h('p', { class: 'muted' }, t('actions.delete.suggested_note')) : null),
      confirmLabel: t('common.actions.delete'),
      danger: true,
    });
    if (!ok) return;
    await guard(async () => {
      try {
        await store.deleteAction(action.id);
      } catch (err) {
        reportError(err, slot);
        return;
      }
      toast(t('actions.toast.deleted', { title: fr(action.title) }), 'info');
      pendingFocus = { campaignId: campaign.id, kind: 'heading', key: 'list' };
      await refresh();
    });
  }

  // Appelé par « Appliquer » (ou Entrée) uniquement, jamais au simple changement d'option.
  async function changeStatus(action, status, control, slot) {
    await guard(async () => {
      let current = action;
      try {
        current = (await store.listActions(campaign.id)).find((a) => a.id === action.id) ?? action;
        const { changed, value } = transitionStatus(current, status);
        if (!changed) {
          control.reset();
          return;
        }
        await store.putAction(value);
      } catch (err) {
        reportError(err, slot);
        control.reset();
        return;
      }
      toast(t('actions.toast.status', { title: fr(action.title), status: t(`common.action_status.${status}`) }), 'success');
      // L'action reste affichée même si son nouveau statut ne correspond plus au filtre.
      kept.add(action.id);
      pendingFocus = { campaignId: campaign.id, kind: 'status', key: action.id };
      await refresh();
    });
  }

  // --- Liste des actions -------------------------------------------------------------------

  function actionItem({ action, matches }) {
    const overdue = isOverdue(action, today);
    const statusId = `action-status-${action.id}`;
    const errorSlot = saveErrorSlot();
    const status = statusControl(action, t, {
      id: statusId,
      onApply: (value) => changeStatus(action, value, status, errorSlot),
    });
    const editBtn = button(t('common.actions.edit'), () => openEditor(action), {
      size: 'sm', icon: 'edit', attrs: { 'aria-label': t('actions.item.edit_label', { title: action.title }) },
    });
    focusTargets.set(`status:${action.id}`, status.select);
    focusTargets.set(`edit:${action.id}`, editBtn);
    const role = action.suggested_role;

    return h('li', { class: ['action-item', `is-${action.status}`, overdue ? 'is-overdue' : null, matches ? null : 'is-filtered-out'] },
      h('div', { class: 'action-item-head' },
        h('h4', { class: 'action-title' }, fr(action.title)),
        h('div', { class: 'cluster action-badges' },
          statusBadge(action.status, t),
          priorityTag(action.priority, t),
          overdue ? h('span', { class: 'badge badge-overdue' }, icon('alert'), t('actions.item.overdue')) : null,
          // « Suggérée » est réservé aux suggestions en attente : une action du plan issue d'une
          // suggestion acceptée porte une mention distincte.
          h('span', { class: 'tag' }, action.suggested ? t('actions.item.from_suggestion') : t('actions.item.manual')))),
      matches ? null : h('p', { class: 'action-filter-note' }, icon('info'), h('span', null, t('actions.item.filtered_out'))),
      action.description ? h('p', { class: 'action-desc' }, fr(action.description)) : null,
      h('dl', { class: 'meta-list action-meta' },
        h('dt', null, t('actions.item.usage')),
        h('dd', null, usageText(action, groupsByKey, t)),
        h('dt', null, t('actions.item.owner')),
        h('dd', null, action.owner
          ? action.owner
          : h('span', { class: 'muted' }, role ? t('actions.item.no_owner_role', { role }) : t('actions.item.no_owner'))),
        h('dt', null, t('actions.item.due_date')),
        h('dd', null, isValidDay(action.due_date) ? formatDate(action.due_date) : h('span', { class: 'muted' }, t('actions.item.no_due'))),
        action.updated_at ? [h('dt', null, t('actions.item.updated')), h('dd', null, formatDateTime(action.updated_at))] : null),
      h('div', { class: 'action-controls' },
        h('div', { class: 'action-status-field' },
          h('label', { class: 'field-label', for: statusId }, t('actions.item.status_label'),
            h('span', { class: 'visually-hidden' }, ` — ${action.title}`)),
          h('div', { class: 'action-status-row' }, status.select, status.apply)),
        h('div', { class: 'cluster action-buttons' },
          editBtn,
          button(t('common.actions.delete'), () => removeAction(action, errorSlot), {
            variant: 'ghost', size: 'sm', icon: 'trash',
            attrs: { class: 'btn-ghost-danger', 'aria-label': t('actions.item.delete_label', { title: action.title }) },
          }))),
      errorSlot);
  }

  const listHeading = h('h3', { id: 'actions-list-title', tabindex: '-1' }, t('actions.list.title', { count: model.actions.length }));
  focusTargets.set('heading:list', listHeading);
  const listContainer = h('div', { class: 'actions-list-body' });
  const countLine = h('p', { class: 'muted actions-count', 'aria-live': 'polite', 'aria-atomic': 'true' });

  function drawList() {
    const current = views.get(campaign.id) ?? view;
    const filtered = visibleActions(model.actions, current, kept);
    countLine.textContent = t('actions.list.shown', { count: filtered.length, total: model.actions.length });
    if (!model.actions.length) {
      mount(listContainer, h('div', { class: 'empty-state actions-empty' },
        h('span', { class: 'empty-state-icon' }, icon('list')),
        h('p', { class: 'lead' }, t('actions.list.empty')),
        h('div', { class: 'cluster cluster-center' },
          button(t('actions.add'), () => openEditor(null), { variant: 'primary', icon: 'plus' }))));
      return;
    }
    if (!filtered.length) {
      mount(listContainer, h('p', { class: 'empty-note' }, icon('info'), h('span', null, t('actions.list.none_filtered')),
        button(t('actions.filters.reset'), () => {
          views.set(campaign.id, { ...DEFAULT_VIEW, status: 'all' });
          kept.clear();
          syncFilters();
          drawList();
        }, { variant: 'ghost', size: 'sm' })));
      return;
    }
    mount(listContainer, h('ul', { class: 'action-list', role: 'list' }, filtered.map(actionItem)));
  }

  const filterDefs = [
    {
      key: 'status', id: 'actions-filter-status', label: t('actions.filters.status'),
      options: STATUS_FILTERS.map((s) => ({ value: s, label: t(`actions.filters.status_options.${s}`) })),
    },
    {
      key: 'priority', id: 'actions-filter-priority', label: t('actions.filters.priority'),
      options: PRIORITY_FILTERS.map((p) => ({ value: p, label: p === 'all' ? t('actions.filters.all_priorities') : t(`common.priority.${p}`) })),
    },
    {
      key: 'usage', id: 'actions-filter-usage', label: t('actions.filters.usage'),
      options: [
        { value: USAGE_ALL, label: t('actions.filters.all_usages') },
        { value: USAGE_CAMPAIGN, label: t('actions.filters.campaign_usages') },
        ...usageOptions(groups).map((o) => ({ value: o.value, label: o.label })),
      ],
    },
    {
      key: 'sort', id: 'actions-sort', label: t('actions.filters.sort'),
      options: SORTS.map((s) => ({ value: s, label: t(`actions.filters.sort_options.${s}`) })),
    },
  ];
  const filterSelects = new Map();
  const filtersNode = h('div', { class: 'actions-filters', role: 'group', 'aria-label': t('actions.filters.label') },
    filterDefs.map((def) => {
      const control = selectControl(def.options, view[def.key], {
        onChange: (event) => {
          views.set(campaign.id, { ...(views.get(campaign.id) ?? view), [def.key]: event.target.value });
          // Changement de filtre : les actions gardées à l'écran suivent de nouveau les filtres.
          kept.clear();
          drawList();
        },
      });
      filterSelects.set(def.key, control);
      return field({ id: def.id, label: def.label, control });
    }));
  function syncFilters() {
    const current = views.get(campaign.id) ?? view;
    for (const [key, control] of filterSelects) control.value = current[key];
  }

  const listSection = h('section', { class: 'actions-section', 'aria-labelledby': 'actions-list-title' },
    h('div', { class: 'cluster cluster-between actions-section-head' },
      listHeading,
      button(t('actions.add'), () => openEditor(null), { variant: 'primary', icon: 'plus' })),
    model.actions.length ? filtersNode : null,
    model.actions.length ? countLine : null,
    listContainer);

  // --- Avancement --------------------------------------------------------------------------

  const bar = h('div', { class: 'progress-bar' });
  bar.style.setProperty('width', `${progress.percent}%`);
  const kpis = [
    { key: 'todo', value: progress.todo },
    { key: 'in_progress', value: progress.in_progress },
    { key: 'done', value: progress.done, cls: 'kpi-success' },
    { key: 'overdue', value: progress.overdue, cls: progress.overdue ? 'kpi-warn' : null },
    { key: 'pending', value: model.suggestions.length, cls: model.suggestions.length ? 'kpi-warn' : null },
    { key: 'rejected', value: progress.rejected },
  ];
  const progressSection = h('section', { class: 'actions-section card actions-progress', 'aria-labelledby': 'actions-progress-title' },
    h('h3', { id: 'actions-progress-title' }, t('actions.progress.title')),
    h('p', { class: 'actions-progress-summary' }, progress.active
      ? t('actions.progress.summary', { count: progress.done, total: progress.active, percent: progress.percent })
      : t('actions.progress.none')),
    h('div', { class: 'progress', 'aria-hidden': 'true' }, bar),
    h('ul', { class: 'kpi-grid kpi-grid-compact actions-kpis', role: 'list' }, kpis.map((k) => h('li', { class: ['kpi', k.cls] },
      h('span', { class: 'kpi-value' }, String(k.value)),
      h('span', { class: 'kpi-label' }, t(`actions.progress.kpi.${k.key}`, { count: k.value }))))));

  mount(root, h('div', { class: 'actions-tab stack-lg' },
    h('header', { class: 'actions-header' },
      h('h2', { id: 'console-tab-title' }, t('actions.title')),
      h('p', { class: 'lead' }, t('actions.lead')),
      h('p', { class: 'muted actions-owner-note' }, icon('info'), h('span', null, t('actions.owner_note')))),
    pageErrorSlot,
    progressSection,
    suggestionsSection,
    listSection,
    disclaimer(t)));
  drawList();

  // Focus restauré après un rafraîchissement (suggestion suivante, sélecteur de statut…).
  if (pendingFocus && pendingFocus.campaignId === campaign.id) {
    const { kind, key } = pendingFocus;
    pendingFocus = null;
    focusLater(focusTargets.get(`${kind}:${key}`) ?? (kind === 'suggestion' ? suggestionsHeading : listHeading));
  }
}
