// Liens de partage et d'envoi. Chaque URL est ouverte par une navigation déclenchée
// par l'utilisateur : l'application n'émet aucune requête vers ces services.
// Les URL des services tiers sont décrites (avec leur date de vérification) dans
// data/channels.json → services ; un test vérifie que ce module les respecte.
// À revérifier à chaque version.

import { sanitizeText, isValidEmail, normalizePhone, isSafeUrl, isResponseCode } from './channels.js';
import { renderMessage } from './messages.js';

export { sanitizeText, isValidEmail, normalizePhone, isSafeUrl, isResponseCode };

export const MAILTO_MAX = 1800;
export const SUBJECT_MAX = 250;

export const SERVICE_URLS = Object.freeze({
  whatsapp: 'https://wa.me/',
  teams: 'https://teams.microsoft.com/share',
  gmail: 'https://mail.google.com/mail/',
  outlook_web: 'https://outlook.office.com/mail/deeplink/compose',
});

export class UrlError extends TypeError {
  constructor(code, detail = '') {
    super(detail ? `${code} : ${detail}` : code);
    this.name = 'UrlError';
    this.code = code;
  }
}

const enc = encodeURIComponent;

function cleanSubject(subject) {
  return sanitizeText(subject, SUBJECT_MAX);
}

function cleanBody(body) {
  return sanitizeText(body, Infinity, { multiline: true });
}

function checkedEmail(to, { required = false } = {}) {
  const addr = to === undefined || to === null ? '' : String(to).trim();
  if (!addr) {
    if (required) throw new UrlError('invalid_email', 'adresse requise');
    return '';
  }
  if (!isValidEmail(addr)) throw new UrlError('invalid_email');
  return addr;
}

/**
 * Lien mailto: avec objet et corps encodés (encodeURIComponent, sauts de ligne en %0D%0A).
 * L'adresse, facultative, est validée strictement : aucune injection d'en-tête possible
 * (?, &, retour à la ligne… sont refusés dans l'adresse et encodés dans l'objet et le corps).
 */
export function mailtoUrl({ to, subject, body } = {}) {
  const addr = checkedEmail(to);
  const params = [];
  const s = cleanSubject(subject);
  const b = cleanBody(body);
  if (s) params.push(`subject=${enc(s)}`);
  if (b) params.push(`body=${enc(b).replace(/%0A/g, '%0D%0A')}`);
  // « @ » reste lisible : l'adresse validée ne contient aucun autre caractère réservé.
  const path = enc(addr).replace(/%40/g, '@');
  return `mailto:${path}${params.length ? `?${params.join('&')}` : ''}`;
}

/** Partage WhatsApp : https://wa.me/?text=… ou https://wa.me/<numéro>?text=… */
export function whatsappUrl(text, phone) {
  let digits = '';
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
    digits = normalizePhone(String(phone));
    if (!digits) throw new UrlError('invalid_phone');
  }
  return `${SERVICE_URLS.whatsapp}${digits}?text=${enc(cleanBody(text))}`;
}

/** Partage Teams : https://teams.microsoft.com/share?href=…&msgText=… */
export function teamsShareUrl(url, text) {
  if (!isSafeUrl(url)) throw new UrlError('invalid_url');
  return `${SERVICE_URLS.teams}?href=${enc(url)}&msgText=${enc(cleanBody(text))}`;
}

/** Composition Gmail (web). */
export function gmailComposeUrl({ to, subject, body } = {}) {
  const addr = checkedEmail(to);
  return `${SERVICE_URLS.gmail}?view=cm&fs=1&to=${enc(addr)}&su=${enc(cleanSubject(subject))}&body=${enc(cleanBody(body))}`;
}

/** Composition Outlook sur le web. */
export function outlookComposeUrl({ to, subject, body } = {}) {
  const addr = checkedEmail(to);
  return `${SERVICE_URLS.outlook_web}?to=${enc(addr)}&subject=${enc(cleanSubject(subject))}&body=${enc(cleanBody(body))}`;
}

function codeList(codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  if (!list.length || !list.every(isResponseCode)) throw new UrlError('invalid_code');
  return list;
}

/** Lien d'import cliquable : `${baseUrl}#/i/<code>~<code>…` (le fragment n'est jamais envoyé au serveur). */
export function importLink(baseUrl, codes) {
  const list = codeList(codes);
  const base = String(baseUrl ?? '').split('#')[0];
  if (!isSafeUrl(base)) throw new UrlError('invalid_url', 'baseUrl');
  return `${base}#/i/${list.join('~')}`;
}

/**
 * Prépare l'envoi des codes par e-mail (gabarit code_email).
 * → liste de messages { url, codes, subject, body, compact } :
 *   un seul si tout tient dans `max` caractères, sinon un par code ;
 *   pour un code seul trop long, repli sur le corps compact (lien d'import sans code brut),
 *   puis { tooLong: true, fallback: 'file', codes: [code] }.
 * `channelsData` (data/channels.json) est obligatoire, comme pour renderMessage.
 */
export function planMailto({ to, subject, codes, baseUrl, templates, ctx = {}, channelsData, max = MAILTO_MAX } = {}) {
  const addr = checkedEmail(to, { required: true });
  const list = codeList(codes);
  const build = (group, compact) => {
    const link = importLink(baseUrl, group);
    const msg = renderMessage('code_email', { ...ctx, codes: group, import_link: link }, templates, channelsData, { compact });
    const subj = subject ? cleanSubject(subject) : msg.subject;
    return { url: mailtoUrl({ to: addr, subject: subj, body: msg.body }), codes: group, subject: subj, body: msg.body, compact };
  };
  const whole = build(list, false);
  if (whole.url.length <= max) return [whole];
  return list.map((code) => {
    const full = list.length === 1 ? whole : build([code], false);
    if (full.url.length <= max) return full;
    const compact = build([code], true);
    if (compact.url.length <= max && compact.body !== full.body) return compact;
    return { tooLong: true, fallback: 'file', codes: [code] };
  });
}
