// Modèle d'une campagne pour la console : données du store + calculs du moteur.
// Rien de calculé n'est persisté (CDC §5.2) : niveaux, groupes, suggestions et statistiques
// sont recalculés à chaque lecture avec la version courante des règles.

import { consolidate } from '../engine/consolidate.js';
import { suggestActions } from '../engine/actions.js';
import { computeStats } from '../engine/stats.js';

/** Jour local au format AAAA-MM-JJ (le fuseau du navigateur fait foi, comme pour les répondants). */
export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Nombre de jours entiers écoulés depuis un horodatage ISO (null si absent ou invalide). */
export function daysSince(iso, now = new Date()) {
  if (typeof iso !== 'string' || iso === '') return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86400000));
}

/**
 * Construit le modèle d'une campagne.
 * @param {object} ctx contexte de l'application (store, data)
 * @param {object} campaign campagne relue depuis le store
 * @param {{ today?: string }} [options]
 */
export async function buildCampaignModel(ctx, campaign, { today = localDay() } = {}) {
  const { store, data } = ctx;
  const [rules, calendar, actionsData, questionnaire, channels] = await Promise.all([
    data.get('rules'),
    data.get('regulatory-calendar'),
    data.get('actions'),
    data.get('questionnaire'),
    data.get('channels'),
  ]);
  const [entries, assessments, actions] = await Promise.all([
    store.listEntries(campaign.id),
    store.listAssessments(campaign.id),
    store.listActions(campaign.id),
  ]);

  const groups = consolidate(entries, rules, calendar, {
    byDepartment: campaign.settings?.group_by_department === true,
    assessments,
  });
  const actionTemplates = actionsData.templates;
  const suggestions = suggestActions(groups, actionTemplates, actions);
  const stats = computeStats({ campaign, entries, groups, actions, suggestions, calendar, today, questionnaire });

  return {
    campaign, entries, assessments, actions, groups, suggestions, stats,
    rules, calendar, actionTemplates, questionnaire, channels, today,
  };
}
