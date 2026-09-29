// Suggestions d'actions à partir des lignes du registre et de data/actions.json (CDC §9).
// Les actions sont seulement suggérées : jamais de responsable affecté automatiquement.
// Module pur : modèles et actions enregistrées sont passés en paramètre.

import { fnv1a32 } from './consolidate.js';

const PRIORITY_ORDER = ['high', 'medium', 'low'];

function templatesOf(actionTemplates) {
  if (Array.isArray(actionTemplates)) return actionTemplates;
  return Array.isArray(actionTemplates?.templates) ? actionTemplates.templates : [];
}

function pairKey(templateId, usageKey) {
  return `${templateId}\u0000${usageKey ?? ''}`;
}

function priorityRank(p) {
  const i = PRIORITY_ORDER.indexOf(p);
  return i === -1 ? PRIORITY_ORDER.length : i;
}

function suggestionFrom(template, group, ruleIds) {
  return {
    template_id: template.id,
    usage_key: group ? group.usage_key : null,
    group_id: group ? group.id : null,
    title: template.title,
    description: template.description ?? '',
    priority: template.default_priority ?? 'medium',
    effort: template.effort ?? null,
    suggested_role: template.suggested_role ?? null,
    horizon: template.horizon ?? null,
    rule_ids: ruleIds,
  };
}

function triggeredRuleIds(template, groups) {
  const fired = new Set(groups.flatMap((g) => (g.computed?.triggers ?? []).map((t) => t.rule_id)));
  return (template.rule_ids ?? []).filter((id) => fired.has(id));
}

/**
 * Suggestions non encore présentes dans storedActions (même template_id + usage_key,
 * quel que soit leur statut : une action rejetée ne revient pas).
 * Les modèles de portée « campaign » donnent au plus une suggestion (usage_key null) ;
 * les autres, une suggestion par ligne du registre qui les appelle.
 * Ordre : actions de campagne (ordre de la bibliothèque), puis par ligne (ordre des groupes),
 * par priorité puis ordre de la bibliothèque.
 */
export function suggestActions(groups, actionTemplates, storedActions) {
  const templates = templatesOf(actionTemplates);
  const byId = new Map(templates.map((t, i) => [t.id, { template: t, index: i }]));
  const existing = new Set((storedActions ?? []).filter((a) => a && a.template_id).map((a) => pairKey(a.template_id, a.usage_key ?? null)));
  const list = Array.isArray(groups) ? groups : [];

  const campaign = [];
  const campaignGroups = new Map();
  const perGroup = [];

  for (const group of list) {
    const own = [];
    for (const id of group.computed?.action_ids ?? []) {
      const found = byId.get(id);
      if (!found) continue;
      const { template, index } = found;
      if (template.scope === 'campaign') {
        if (!campaignGroups.has(id)) {
          campaignGroups.set(id, []);
          campaign.push({ template, index });
        }
        campaignGroups.get(id).push(group);
        continue;
      }
      if (existing.has(pairKey(id, group.usage_key))) continue;
      if (own.some((o) => o.template.id === id)) continue;
      own.push({ template, index });
    }
    own.sort((a, b) => priorityRank(a.template.default_priority) - priorityRank(b.template.default_priority) || a.index - b.index);
    for (const { template } of own) perGroup.push(suggestionFrom(template, group, triggeredRuleIds(template, [group])));
  }

  const campaignSuggestions = campaign
    .sort((a, b) => a.index - b.index)
    .filter(({ template }) => !existing.has(pairKey(template.id, null)))
    .map(({ template }) => suggestionFrom(template, null, triggeredRuleIds(template, campaignGroups.get(template.id))));

  return [...campaignSuggestions, ...perGroup];
}

/** Identifiant déterministe d'une action issue d'une suggestion (unique par campagne, modèle et usage). */
export function suggestionActionId(campaignId, templateId, usageKey) {
  const s = `${campaignId}|${templateId}|${usageKey ?? ''}`;
  const a = fnv1a32(s).toString(16).padStart(8, '0');
  const b = fnv1a32(`${s}#`).toString(16).padStart(8, '0');
  return `S-${a}${b}`;
}

/** Transforme une suggestion en action (§3.5), marquée suggested = true, sans responsable. */
export function actionFromSuggestion(suggestion, campaignId, { status = 'todo', now = new Date() } = {}) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    id: suggestionActionId(campaignId, suggestion.template_id, suggestion.usage_key),
    campaign_id: campaignId,
    usage_key: suggestion.usage_key ?? null,
    template_id: suggestion.template_id ?? null,
    title: suggestion.title,
    description: suggestion.description ?? '',
    owner: '',
    due_date: null,
    priority: suggestion.priority ?? 'medium',
    status,
    suggested: true,
    suggested_role: suggestion.suggested_role ?? null,
    created_at: at,
    updated_at: at,
  };
}
