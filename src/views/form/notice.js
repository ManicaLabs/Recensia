// Notice du formulaire répondant (CDC §4, §7.4, §15) : limites de l'anonymat, toujours affichées
// (jamais repliées) pour ne pas présenter l'anonymat comme plus fort qu'il n'est.
// Module pur : `t` et les données sont passés en paramètre (testé sous Node).

import { channelInfo } from '../../share/channels.js';

const SENDER_GROUPS = ['yes', 'depends'];

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase('fr-FR') + text.slice(1) : text;
}

/** « a », « a ou b », « a, b ou c ». */
export function joinOr(list, t) {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} ${t('form.mode.or')} ${list.at(-1)}`;
}

/**
 * Avertissements d'anonymat des canaux, fusionnés en une liste courte (mode anonyme) :
 * une phrase pour les canaux qui identifient l'expéditeur, une pour ceux dont l'anonymat
 * dépend du lieu de dépôt. Un canal sans formule « via » garde son avertissement d'origine.
 * @param {object[]} plan  sendPlan(…) : { type, available, warning, identifies_sender }
 * @returns {string[]}
 */
export function channelLimits(plan, channelsData, t) {
  const groups = { yes: [], depends: [] };
  const others = [];
  for (const item of Array.isArray(plan) ? plan : []) {
    if (!item?.available || !item.warning) continue;
    const via = channelInfo(item.type, channelsData)?.via ?? '';
    if (SENDER_GROUPS.includes(item.identifies_sender) && via) {
      if (!groups[item.identifies_sender].includes(via)) groups[item.identifies_sender].push(via);
    } else if (!others.includes(item.warning)) {
      others.push(item.warning);
    }
  }
  const out = [];
  if (groups.yes.length) out.push(t('form.mode.channel_identifies', { via: capitalize(joinOr(groups.yes, t)) }));
  if (groups.depends.length) out.push(t('form.mode.channel_depends', { via: capitalize(joinOr(groups.depends, t)) }));
  return [...out, ...others];
}

/**
 * Limites de la réponse anonyme affichées dans la notice, dans l'ordre : canaux d'envoi,
 * service (visible dans le registre à côté de chaque usage, CDC §17), champs libres.
 * Mode ouvert : aucune (la réponse est nominative, la notice le dit déjà).
 * @param {{ mode: string, depts?: string[], dreq?: boolean, plan: object[], channelsData: object, t: Function }} options
 * @returns {{ id: string, text: string }[]}
 */
export function anonymousLimits({ mode, depts, dreq, plan, channelsData, t }) {
  if (mode !== 'anonymous') return [];
  const limits = channelLimits(plan, channelsData, t).map((text, index) => ({ id: `channel_${index}`, text }));
  if (Array.isArray(depts) && depts.length > 0) {
    limits.push({
      id: 'department',
      text: dreq === true
        ? t('form.mode.anonymous_department')
        : t('form.mode.anonymous_department_optional', { option: t('questionnaire.department_unspecified') }),
    });
  }
  limits.push({ id: 'free_text', text: t('form.mode.anonymous_free_text') });
  return limits;
}
