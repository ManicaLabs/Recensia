// Indicateurs du tableau de bord et du rapport (CDC §8.1).
// En mode anonyme, tout effectif strictement compris entre 0 et k (min_group_size) est masqué.
// Module pur : toutes les données, dont la date du jour, sont passées en paramètre.

import { AI_ACT_ORDER, DATA_LEVELS, isAiActLevel, isDataLevel } from './levels.js';
import { optionLabel } from './labels.js';
import { normalizeToolOther } from './consolidate.js';

const DEFAULT_K = 5;
const ACTION_STATUSES = ['todo', 'in_progress', 'done', 'rejected'];
const DAY_MS = 86400000;

/** Effectif affichable : '< k' en mode anonyme si 0 < n < k, sinon le nombre. */
export function maskCount(n, k, mode) {
  if (mode === 'anonymous' && n > 0 && n < k) return `< ${k}`;
  return String(n);
}

function isMasked(n, k, mode) {
  return mode === 'anonymous' && n > 0 && n < k;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Date du jour au format YYYY-MM-DD (date locale si un objet Date est fourni). */
export function toDay(today) {
  if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)) return today;
  const d = today instanceof Date ? today : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayDiff(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function withMask(count, k, mode) {
  return { count, display: maskCount(count, k, mode), masked: isMasked(count, k, mode) };
}

/** Incrémente un compteur existant (jamais une propriété héritée comme « constructor »). */
function bump(counters, key) {
  if (Object.hasOwn(counters, key)) counters[key] += 1;
}

// Un axe surchargé par l'admin (niveau valide) est considéré comme qualifié.
const aiOverridden = (g) => isAiActLevel(g.assessment?.override_ai_act_level);
const dataOverridden = (g) => isDataLevel(g.assessment?.override_data_level);

function isToQualify(g) {
  return g.effective?.ai_act_level === 'to_qualify' || (g.computed?.data_to_qualify === true && !dataOverridden(g));
}

/** Questions encore ouvertes d'une ligne : celles d'un axe surchargé sont réputées tranchées. */
function openQuestions(g) {
  const axisOf = new Map((g.computed?.triggers ?? []).map((t) => [t.rule_id, t.axis]));
  return (g.computed?.questions_to_confirm ?? []).filter((q) => {
    const axis = axisOf.get(q.rule_id);
    return !(axis === 'ai_act' && aiOverridden(g)) && !(axis === 'data' && dataOverridden(g));
  });
}

function respondentKey(r) {
  return [r.first_name, r.last_name, r.email ?? ''].map((s) => String(s ?? '').trim().toLowerCase()).join('\u0000');
}

/**
 * Calcule les indicateurs d'une campagne.
 * @param {object} p
 * @param {object} p.campaign campagne (§3.2) : mode et settings.min_group_size
 * @param {object[]} p.entries entrées (§3.3) ; les exclues ne comptent pas
 * @param {object[]} p.groups lignes produites par consolidate()
 * @param {object[]} p.actions actions enregistrées (§3.5)
 * @param {object[]} p.suggestions suggestions en attente (suggestActions)
 * @param {object} p.calendar data/regulatory-calendar.json
 * @param {string|Date} p.today date du jour (YYYY-MM-DD ou Date)
 * @param {object} [p.questionnaire] data/questionnaire.json, pour les libellés d'outils
 */
export function computeStats({ campaign, entries, groups, actions, suggestions, calendar, today, questionnaire } = {}) {
  const mode = campaign?.mode ?? 'anonymous';
  const k = Number.isInteger(campaign?.settings?.min_group_size) && campaign.settings.min_group_size > 0
    ? campaign.settings.min_group_size
    : DEFAULT_K;
  const active = (entries ?? []).filter((e) => e && e.excluded !== true);
  const list = groups ?? [];
  const day = toDay(today);

  const by_ai_act = Object.fromEntries(AI_ACT_ORDER.map((l) => [l, 0]));
  const by_data = Object.fromEntries(DATA_LEVELS.map((l) => [l, 0]));
  for (const g of list) {
    bump(by_ai_act, g.effective?.ai_act_level);
    bump(by_data, g.effective?.data_level);
  }

  const shadowCount = list.filter((g) => (g.computed?.signals ?? []).some((s) => s.id === 'shadow_ai')).length;

  // Outils : nombre de déclarations par outil (une précision « autre » = un outil).
  const tools = new Map();
  for (const g of list) {
    const other = g.tool === 'other';
    const key = other ? `other:${normalizeToolOther(g.tool_other)}` : g.tool;
    const label = other && g.tool_other ? g.tool_other : optionLabel(questionnaire, 'tool', g.tool);
    const item = tools.get(key) ?? { tool: g.tool, label, count: 0 };
    item.count += g.count ?? 0;
    tools.set(key, item);
  }
  const top_tools = [...tools.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fr'))
    .map((t) => ({ ...t, ...withMask(t.count, k, mode) }));

  // Services : nombre de déclarations, dans l'ordre de la campagne, puis les autres valeurs.
  const deptCounts = new Map((campaign?.departments ?? []).map((d) => [d, 0]));
  for (const e of active) {
    const d = e.usage?.department ?? null;
    deptCounts.set(d, (deptCounts.get(d) ?? 0) + 1);
  }
  const by_department = [...deptCounts.entries()].map(([department, count]) => ({ department, ...withMask(count, k, mode) }));

  const deadlines = (calendar?.deadlines ?? []).filter((d) => d && typeof d.date === 'string').map((d) => ({
    id: d.id,
    date: d.date,
    label: d.label,
    status: d.status ?? null,
    source_url: d.source_url ?? null,
    last_verified: d.last_verified ?? calendar?.last_verified ?? null,
    note: d.note ?? null,
    // Rôles visés (null : tous). Le décompte ci-dessous suit computed.deadlines, déjà filtré par rôle.
    applies_to_roles: Array.isArray(d.applies_to_roles) && d.applies_to_roles.length ? [...d.applies_to_roles] : null,
    days: dayDiff(day, d.date),
    usages_count: list.filter((g) => (g.computed?.deadlines ?? []).some((x) => x.id === d.id)).length,
  }));
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
  const upcoming_deadlines = deadlines.filter((d) => d.date >= day).sort(byDate);
  const past_deadlines = deadlines.filter((d) => d.date < day).sort(byDate);

  const actions_progress = Object.fromEntries(ACTION_STATUSES.map((s) => [s, 0]));
  for (const a of actions ?? []) bump(actions_progress, a?.status);
  actions_progress.pending_suggestions = (suggestions ?? []).length;
  actions_progress.total = (actions ?? []).length;

  const questions = list.flatMap((g) =>
    openQuestions(g).map((q) => ({ group_id: g.id, usage_key: g.usage_key, name: g.name, rule_id: q.rule_id, question: q.question })),
  );

  return {
    mask: { k, active: mode === 'anonymous' },
    usages: list.length,
    responses: active.length,
    respondents: mode === 'open'
      ? new Set(active.filter((e) => e.respondent).map((e) => respondentKey(e.respondent))).size
      : null,
    by_ai_act,
    by_data,
    shadow_ai: { count: shadowCount, share: list.length ? shadowCount / list.length : 0 },
    top_tools,
    by_department,
    upcoming_deadlines,
    past_deadlines,
    actions_progress,
    to_qualify: list.filter(isToQualify).length,
    questions,
  };
}
