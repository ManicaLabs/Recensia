// Classification d'un usage selon data/rules.json : niveau AI Act et exposition des données.
// Le code ne contient que l'algorithme générique ; seuils et conditions vivent dans les règles.
// Module pur : règles et calendrier sont passés en paramètre.

import { evaluateCondition } from './evaluate.js';
import { isAiActLevel, isDataLevel, maxAiAct } from './levels.js';

const DEFAULT_ROLE = 'deployer';

function toTrigger(rule) {
  const trigger = {
    rule_id: rule.id,
    axis: rule.axis,
    kind: rule.kind,
    level: rule.level ?? null,
    label: rule.label ?? rule.id,
    legal_ref: rule.legal_ref ?? '',
    explanation: rule.explanation ?? '',
  };
  if (rule.kind === 'modifier') trigger.delta = rule.delta ?? 0;
  return trigger;
}

function signalLabel(rules, id, rule) {
  const entry = rules?.signals?.[id];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.label === 'string') return entry.label;
  return rule.label ?? id;
}

/** Échéances résolues depuis le calendrier, sans doublon, triées par date puis identifiant. */
export function resolveDeadlines(ids, calendar) {
  const byId = new Map((calendar?.deadlines ?? []).map((d) => [d.id, d]));
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const d = byId.get(id);
    out.push({
      id: d.id,
      date: d.date ?? null,
      label: d.label ?? d.id,
      status: d.status ?? null,
      source_url: d.source_url ?? null,
      last_verified: d.last_verified ?? calendar?.last_verified ?? null,
    });
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id));
}

function clampData(n) {
  return Math.max(0, Math.min(3, n));
}

/**
 * Classe un usage (objet §3.1 validé).
 * Algorithme :
 * 1. chaque règle dont la condition est vraie est retenue (les règles « fallback » sont mises de côté) ;
 * 2. AI Act : niveau le plus grave parmi les règles retenues de l'axe ai_act portant un niveau ;
 *    si aucune ne porte de niveau, les règles « fallback » de l'axe s'appliquent ;
 * 3. données : base = maximum du barème data_base sur les catégories envoyées (et des règles
 *    « level » de l'axe data), puis modificateurs (delta, plafond cap, seulement si base ≥ min_base) ;
 *    une règle « question » de l'axe data rend l'exposition « à qualifier » ;
 * 4. rôle, échéances, actions, questions et signaux : union des règles retenues.
 */
export function classifyUsage(usage, rules, calendar) {
  const list = Array.isArray(rules?.rules) ? rules.rules : [];
  const matched = [];
  const fallbacks = [];

  list.forEach((rule, index) => {
    if (rule.fallback === true) fallbacks.push({ rule, index });
    else if (evaluateCondition(rule.condition, usage)) matched.push({ rule, index });
  });

  // Axe AI Act
  const aiLevels = matched
    .filter(({ rule }) => rule.axis === 'ai_act' && isAiActLevel(rule.level))
    .map(({ rule }) => rule.level);
  const dataHasLevel = matched.some(({ rule }) => rule.axis === 'data' && isDataLevel(rule.level));
  for (const item of fallbacks) {
    const axisHasLevel = item.rule.axis === 'ai_act' ? aiLevels.length > 0 : dataHasLevel;
    if (axisHasLevel || !evaluateCondition(item.rule.condition, usage)) continue;
    matched.push(item);
    if (item.rule.axis === 'ai_act' && isAiActLevel(item.rule.level)) aiLevels.push(item.rule.level);
  }
  matched.sort((a, b) => a.index - b.index);
  const ai_act_level = maxAiAct(aiLevels);

  // Axe données
  const dataBase = rules?.data_base ?? {};
  const dataTypes = Array.isArray(usage?.data_types) ? usage.data_types : [];
  let base = 0;
  for (const type of dataTypes) {
    const score = dataBase[type];
    if (isDataLevel(score) && score > base) base = score;
  }
  for (const { rule } of matched) {
    if (rule.axis === 'data' && rule.kind === 'level' && isDataLevel(rule.level) && rule.level > base) base = rule.level;
  }
  let data_level = base;
  const retained = [];
  for (const item of matched) {
    const { rule } = item;
    if (rule.axis === 'data' && rule.kind === 'modifier') {
      if (base < (rule.min_base ?? 0)) continue; // modificateur sans objet : non retenu
      const delta = Number.isInteger(rule.delta) ? rule.delta : 0;
      const cap = isDataLevel(rule.cap) ? rule.cap : 3;
      const next = delta > 0 ? Math.min(data_level + delta, Math.max(cap, data_level)) : data_level + delta;
      data_level = clampData(next);
    }
    retained.push(rule);
  }
  const data_to_qualify = retained.some((r) => r.axis === 'data' && r.kind === 'question');

  // Rôle, échéances, actions, questions, signaux
  const defaultRole = rules?.default_role ?? DEFAULT_ROLE;
  const roleRule = retained.find((r) => typeof r.role === 'string' && r.role !== defaultRole);
  const role = roleRule ? roleRule.role : defaultRole;

  const action_ids = [];
  const deadlineIds = [];
  const questions_to_confirm = [];
  const signals = [];
  for (const rule of retained) {
    for (const id of rule.action_ids ?? []) if (!action_ids.includes(id)) action_ids.push(id);
    for (const id of rule.deadline_ids ?? []) if (!deadlineIds.includes(id)) deadlineIds.push(id);
    if (typeof rule.question === 'string' && rule.question !== '') {
      questions_to_confirm.push({ rule_id: rule.id, question: rule.question });
    }
    if (typeof rule.signal === 'string' && !signals.some((s) => s.id === rule.signal)) {
      signals.push({ id: rule.signal, label: signalLabel(rules, rule.signal, rule) });
    }
  }

  return {
    ai_act_level,
    data_level,
    data_to_qualify,
    role,
    triggers: retained.map(toTrigger),
    deadlines: resolveDeadlines(deadlineIds, calendar),
    action_ids,
    questions_to_confirm,
    signals,
  };
}
