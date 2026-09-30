// Plan d'envoi des codes par le répondant (CDC §7.3, §7.7) : boutons selon les canaux du lien,
// avertissement d'anonymat propre à chaque canal, regroupement des codes pour les URL de partage,
// nom et contenu du fichier .rcn. Module pur (l'environnement du navigateur est passé en paramètre).

import { channelInfo, anonymityWarning, isChannelAvailable } from '../../share/channels.js';
import { planMailto, mailtoUrl } from '../../share/urls.js';
import { slugify } from '../../export/registry.js';

/** Canaux par défaut quand le lien n'en déclare aucun : copier et fichier. */
export const DEFAULT_CHANNELS = Object.freeze([Object.freeze({ type: 'copy' }), Object.freeze({ type: 'file' })]);
/** Longueur maximale visée pour une URL de partage (Teams, WhatsApp) avant de découper par code. */
export const SERVICE_URL_MAX = 4000;

/** Canaux effectifs : ceux du lien (types connus, sans doublon), sinon copier + fichier. */
export function effectiveChannels(channels, channelsData) {
  const out = [];
  const seen = new Set();
  for (const channel of Array.isArray(channels) ? channels : []) {
    const type = channel && typeof channel === 'object' ? channel.type : undefined;
    if (!channelInfo(type, channelsData) || seen.has(type)) continue;
    seen.add(type);
    const target = typeof channel.target === 'string' && channel.target !== '' ? channel.target : null;
    out.push({ type, target });
  }
  return out.length ? out : DEFAULT_CHANNELS.map((c) => ({ type: c.type, target: null }));
}

/**
 * Actions d'envoi proposées au répondant.
 * env : { navigator } (détection de Web Share). Un canal indisponible (partage natif absent) est
 * conservé avec available = false ; si plus aucun canal n'est utilisable, « Copier » est ajouté en repli.
 * → [{ type, target, label, button_label, identifies_sender, warning, available, fallback }]
 *   (warning : null pour un canal indisponible)
 */
export function sendPlan({ channels, mode, channelsData, env = globalThis }) {
  const items = effectiveChannels(channels, channelsData).map(({ type, target }) => describe(type, target, mode, channelsData, env, false));
  if (!items.some((item) => item.available)) items.push(describe('copy', null, mode, channelsData, env, true));
  return items;
}

function describe(type, target, mode, channelsData, env, fallback) {
  const info = channelInfo(type, channelsData);
  const available = fallback ? true : isChannelAvailable(type, channelsData, env);
  return {
    type,
    target,
    label: info?.label ?? type,
    button_label: info?.button_label ?? type,
    identifies_sender: info?.identifies_sender ?? 'yes',
    // Un canal inutilisable ici (partage natif absent) n'a pas d'avertissement à afficher.
    warning: available ? anonymityWarning(mode, type, channelsData) : null,
    available,
    fallback,
  };
}

/**
 * Avertissement commun : si tous les canaux utilisables portent le même avertissement (mode
 * ouvert, notamment), il est affiché une seule fois ; sinon null (un avertissement par canal).
 */
export function sharedWarning(items) {
  const usable = items.filter((item) => item.available);
  if (!usable.length) return null;
  const first = usable[0].warning;
  return first && usable.every((item) => item.warning === first) ? first : null;
}

/** Avertissements d'anonymat distincts des canaux (notice du formulaire). */
export function distinctWarnings(items) {
  return [...new Set(items.filter((item) => item.available && item.warning).map((item) => item.warning))];
}

/**
 * Carte « E-mail » du répondant (CDC §7.7, §17). Les messages préremplis (lien d'import et code)
 * sont gardés tant qu'ils tiennent dans la limite mailto ; au-delà, chaque code trop long passe
 * en repli : fichier .rcn ou code copié, avec un e-mail court (destinataire, objet, corps sans
 * code) pour que l'envoi reste en deux clics.
 * Lève l'erreur de planMailto (adresse ou code invalide) : l'appelant propose alors le fichier.
 * @param {{ to: string, codes: string[], baseUrl: string, templates: object, ctx: object,
 *   channelsData: object, fallback: { subject: string, body: string } }} options
 * @returns {{ items: ({ kind: 'prefilled', url: string, codes: string[] }
 *   | { kind: 'fallback', url: string, codes: string[] })[], openable: number,
 *   help: 'mail_help' | 'mail_fallback_help' }}
 */
export function mailPlan({ to, codes, baseUrl, templates, ctx, channelsData, fallback }) {
  const messages = planMailto({ to, codes, baseUrl, templates, ctx, channelsData });
  let shortUrl = null;
  const items = messages.map((message) => {
    if (!message.tooLong) return { kind: 'prefilled', url: message.url, codes: message.codes };
    shortUrl ??= mailtoUrl({ to, subject: fallback?.subject ?? '', body: fallback?.body ?? '' });
    return { kind: 'fallback', url: shortUrl, codes: message.codes };
  });
  const openable = items.filter((item) => item.kind === 'prefilled').length;
  return { items, openable, help: openable > 0 ? 'mail_help' : 'mail_fallback_help' };
}

/**
 * Regroupe des codes pour des URL de longueur bornée : groupes consécutifs dont l'URL construite
 * par buildUrl(groupe) reste ≤ max ; un code seul trop long forme son propre groupe.
 * @param {string[]} codes
 * @param {(group: string[]) => string} buildUrl
 * @param {number} [max]
 * @returns {string[][]}
 */
export function groupCodes(codes, buildUrl, max = SERVICE_URL_MAX) {
  const groups = [];
  let current = [];
  for (const code of codes) {
    const candidate = [...current, code];
    if (current.length && buildUrl(candidate).length > max) {
      groups.push(current);
      current = [code];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Nom du fichier de codes : recensia-<slug du titre>-codes.rcn */
export function rcnFilename(title) {
  return `recensia-${slugify(title, 'campagne')}-codes.rcn`;
}

/** Contenu du fichier .rcn : un code par ligne. */
export function rcnContent(codes) {
  return `${codes.join('\n')}\n`;
}
