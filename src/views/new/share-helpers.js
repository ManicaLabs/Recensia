// Diffusion (onglet « Diffuser » de la console) : logique pure, sans DOM, testée par tests/new.test.js.
//
// - publicCampaign : copie de la campagne réduite à ses champs publics (jamais la clé privée).
// - textToRichHtml : fragment HTML échappé reconstruit depuis le texte ÉDITÉ par le responsable,
//   liens http(s) et adresses e-mail valides rendus cliquables (copie en texte riche).
// - restoreLockedBlock : remet en place la phrase verrouillée « mode, anonymat, canal » (CDC §7.7).
// - lockedStatusChange : changement de présence de cette phrase à annoncer pendant la saisie.
// - mailtoPlan : lien « Ouvrir dans ma messagerie » et dépassement de la limite MAILTO_MAX.
// - planMessageMailto : message complet, sinon version courte générée, sinon « Copier ».

import { escapeHtml, hasLockedBlock, renderMessage } from '../../share/messages.js';
import { isSafeUrl, isValidEmail, mailtoUrl, MAILTO_MAX } from '../../share/urls.js';

const PUBLIC_FIELDS = ['id', 'title', 'org_name', 'mode', 'departments', 'public_key', 'fingerprint', 'created_at', 'demo'];
const PUBLIC_SETTINGS = ['min_group_size', 'department_required', 'comments_exportable', 'closes_on', 'group_by_department'];

/** Campagne réduite à ses champs publics : utilisée par l'onglet Diffuser, qui n'a jamais besoin de la clé privée. */
export function publicCampaign(campaign) {
  const c = campaign && typeof campaign === 'object' ? campaign : {};
  const out = {};
  for (const key of PUBLIC_FIELDS) if (Object.hasOwn(c, key)) out[key] = c[key];
  if (Array.isArray(c.departments)) out.departments = [...c.departments];
  const s = c.settings && typeof c.settings === 'object' ? c.settings : {};
  out.settings = {};
  for (const key of PUBLIC_SETTINGS) if (Object.hasOwn(s, key)) out.settings[key] = s[key];
  out.settings.channels = Array.isArray(s.channels)
    ? s.channels.map((ch) => {
      const copy = { type: ch?.type };
      if (ch?.target != null && ch.target !== '') copy.target = ch.target;
      return copy;
    })
    : [];
  return out;
}

// URL http(s) ou adresse e-mail dans une ligne de texte libre.
const TOKEN_RE = /https?:\/\/[^\s<>"]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// Ponctuation finale qui n'appartient pas au lien (« …/Recensia/. » en fin de phrase).
const TRAILING_RE = /[.,;:!?)\]}»'’…]+$/;

function linkifyLine(line) {
  let html = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(line))) {
    let token = match[0];
    const trailing = TRAILING_RE.exec(token);
    if (trailing) token = token.slice(0, trailing.index);
    const start = match.index;
    const end = start + token.length;
    let anchor = null;
    if (/^https?:\/\//.test(token)) {
      if (isSafeUrl(token)) anchor = `<a href="${escapeHtml(token)}">${escapeHtml(token)}</a>`;
    } else if (isValidEmail(token)) {
      anchor = `<a href="mailto:${escapeHtml(token)}">${escapeHtml(token)}</a>`;
    }
    if (!anchor) continue;
    html += escapeHtml(line.slice(last, start)) + anchor;
    last = end;
    TOKEN_RE.lastIndex = end;
  }
  return html + escapeHtml(line.slice(last));
}

/**
 * Texte brut (éventuellement modifié) → fragment HTML sûr : tout est échappé, paragraphes séparés
 * par une ligne vide, sauts de ligne en <br>, seuls les liens http(s) valides et les adresses e-mail
 * valides deviennent cliquables.
 */
export function textToRichHtml(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  return normalized.split(/\n[ \t]*\n+/).map((paragraph) => {
    const lines = paragraph.split('\n').map((line) => linkifyLine(line.trimEnd()));
    return `<p>${lines.join('<br>')}</p>`;
  }).join('\n');
}

function words(s) {
  return String(s ?? '').toLocaleLowerCase('fr-FR').normalize('NFC')
    .replace(/[‘’ʼ]/g, "'")
    .split(/[^\p{L}\p{Nd}']+/u)
    .filter((w) => w.length > 1);
}

/** Part des mots de la phrase verrouillée présents dans une ligne (0..1). */
function coverage(line, lockedWords) {
  if (!lockedWords.length) return 0;
  const set = new Set(words(line));
  return lockedWords.filter((w) => set.has(w)).length / lockedWords.length;
}

/**
 * Remet la phrase verrouillée dans un message modifié.
 * 1. Déjà présente : texte inchangé.
 * 2. Une ligne en est une version retouchée (≥ 60 % de ses mots, longueur comparable) : elle est remplacée.
 * 3. Sinon, elle est réinsérée à sa place d'origine (après la ligne qui la précédait dans le message
 *    généré, ou avant celle qui la suivait), et à défaut ajoutée à la fin.
 * @param {string} edited texte modifié
 * @param {string} original texte généré
 * @param {string} locked phrase verrouillée
 * @returns {string}
 */
export function restoreLockedBlock(edited, original, locked) {
  const current = String(edited ?? '').replace(/\r\n?/g, '\n');
  const block = String(locked ?? '').trim();
  if (!block || hasLockedBlock(current, block)) return current;
  const lines = current.split('\n');
  const lockedWords = words(block);

  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const score = coverage(line, lockedWords);
    const size = words(line).length;
    if (score >= 0.6 && size <= lockedWords.length * 1.6 && score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  if (best >= 0) {
    lines[best] = block;
    return lines.join('\n');
  }

  const origLines = String(original ?? '').replace(/\r\n?/g, '\n').split('\n');
  const at = origLines.findIndex((line) => line.includes(block));
  if (at >= 0) {
    const blankBefore = at > 0 && origLines[at - 1].trim() === '';
    const blankAfter = at < origLines.length - 1 && origLines[at + 1].trim() === '';
    let prev = at - 1;
    while (prev >= 0 && origLines[prev].trim() === '') prev -= 1;
    let next = at + 1;
    while (next < origLines.length && origLines[next].trim() === '') next += 1;
    if (prev >= 0) {
      const anchor = lines.lastIndexOf(origLines[prev]);
      if (anchor >= 0) {
        const insert = blankBefore ? ['', block] : [block];
        const after = lines[anchor + 1];
        if (blankBefore && after !== undefined && after.trim() !== '') insert.push('');
        lines.splice(anchor + 1, 0, ...insert);
        return lines.join('\n');
      }
    }
    if (next < origLines.length) {
      const anchor = lines.indexOf(origLines[next]);
      if (anchor >= 0) {
        lines.splice(anchor, 0, ...(blankAfter ? [block, ''] : [block]));
        return lines.join('\n');
      }
    }
  }
  const trimmed = current.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/**
 * Changement de présence de la phrase verrouillée à annoncer aux lecteurs d'écran (WCAG 4.1.3) :
 * 'missing' quand elle disparaît du message, 'present' quand elle y revient, null sinon. Les frappes
 * qui ne changent pas l'état, et le premier affichage (état précédent inconnu), n'annoncent rien.
 * @param {boolean|null|undefined} previous présence lors de la mise à jour précédente
 * @param {boolean} present présence actuelle
 * @returns {'missing'|'present'|null}
 */
export function lockedStatusChange(previous, present) {
  if (typeof previous !== 'boolean') return null;
  const now = Boolean(present);
  if (now === previous) return null;
  return now ? 'present' : 'missing';
}

/**
 * Lien « Ouvrir dans ma messagerie » (sans destinataire).
 * → { url, length, max, tooLong } ; tooLong : l'URL dépasse MAILTO_MAX (utiliser « Copier »).
 */
export function mailtoPlan({ subject, body } = {}, max = MAILTO_MAX) {
  const url = mailtoUrl({ subject, body });
  return { url, length: url.length, max, tooLong: url.length > max };
}

/**
 * Gabarit dont le corps sert de version courte quand l'e-mail complet dépasse MAILTO_MAX
 * (l'invitation e-mail dépasse presque toujours la limite : 2 200 à 2 500 caractères encodés).
 */
export const SHORT_MAILTO_FALLBACK = Object.freeze({ invitation_email: 'invitation_short' });

function shortVersion(templateId, subject, context, templates, channelsData) {
  const all = templates && typeof templates.templates === 'object' ? templates.templates : {};
  const fallbackId = Object.hasOwn(SHORT_MAILTO_FALLBACK, templateId) ? SHORT_MAILTO_FALLBACK[templateId] : null;
  let msg = null;
  try {
    if (fallbackId && Object.hasOwn(all, fallbackId)) {
      msg = renderMessage(fallbackId, context, templates, channelsData);
    } else if (Object.hasOwn(all, templateId) && typeof all[templateId].body_compact === 'string') {
      msg = renderMessage(templateId, context, templates, channelsData, { compact: true });
    }
  } catch {
    return null;
  }
  // Version générée : la phrase verrouillée y figure toujours (sinon, pas de version courte).
  if (!msg || !msg.body || !hasLockedBlock(msg.body, msg.locked_block)) return null;
  return { subject: String(subject ?? ''), body: msg.body, locked_block: msg.locked_block };
}

/**
 * « Ouvrir dans ma messagerie » pour le message affiché (éventuellement modifié) :
 * - kind 'full'     : le message tel quel tient dans MAILTO_MAX ;
 * - kind 'short'    : trop long, mais une version courte tient : objet saisi + corps de l'invitation
 *                     courte (invitation e-mail), ou corps compact du gabarit s'il en a un. Elle est
 *                     regénérée depuis les gabarits (lien seul sur sa ligne, phrase verrouillée,
 *                     empreinte) : les modifications du corps n'y figurent pas ;
 * - kind 'too_long' : aucune version ne tient : utiliser « Copier ».
 * @returns {{ kind: 'full'|'short'|'too_long', url: string|null, max: number,
 *             full: { url, length, tooLong }, short: { url, length, subject, body, locked_block }|null }}
 */
export function planMessageMailto({ templateId, subject, body, context, templates, channelsData, max = MAILTO_MAX } = {}) {
  const full = mailtoPlan({ subject, body }, max);
  if (!full.tooLong) return { kind: 'full', url: full.url, max, full, short: null };
  const version = shortVersion(templateId, subject, context, templates, channelsData);
  if (version) {
    const plan = mailtoPlan({ subject: version.subject, body: version.body }, max);
    const short = { ...version, url: plan.url, length: plan.length };
    if (!plan.tooLong) return { kind: 'short', url: plan.url, max, full, short };
    return { kind: 'too_long', url: null, max, full, short };
  }
  return { kind: 'too_long', url: null, max, full, short: null };
}
